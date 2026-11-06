const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const CHAT_ID = /^[A-Za-z0-9_-]+$/;
const MESSAGE_ID = /^[0-9]+-[0-9a-f]{8}$/;
const TTL = 3600;

function createInboxWire({ inbox, chats, touched, send, now = () => Date.now() }) {
  const snapshots = new Map();
  const approvedInbox = new Map();
  const injected = new Map();
  const busy = new Set();
  const expired = new Map();
  const replyTimes = new Map();
  const conflicts = new Map();
  const conflictTimes = new Map();
  const key = (project, chatId, id) => `${project}\0${chatId}\0${id}`;
  const valid = (value, pattern) => typeof value === 'string' && pattern.test(value);
  function trim(map, timestamp) {
    for (const [k, value] of map) if (now() - timestamp(value) > 3600000) map.delete(k);
    while (map.size > 500) map.delete(map.keys().next().value);
  }
  function trimState() {
    trim(snapshots, (row) => row.ts * 1000);
    trim(approvedInbox, (row) => (row.approved_ts || row.ts) * 1000);
    trim(expired, (at) => at);
    trim(conflicts, (at) => at);
    trim(replyTimes, (times) => times.at(-1) || 0);
    trim(conflictTimes, (times) => times.at(-1) || 0);
    for (const id of busy) if (!chats.has(id)) busy.delete(id);
    while (busy.size > 500) busy.delete(busy.values().next().value);
    for (const [id, pending] of injected) {
      if (!chats.has(id)) { injected.delete(id); continue; }
      trim(pending, (item) => item.at);
      if (!pending.size) injected.delete(id);
    }
    while (injected.size > 500) injected.delete(injected.keys().next().value);
  }

  function live(chatId, project) {
    if (!valid(chatId, CHAT_ID)) return null;
    const session = chats.get(chatId);
    if (!session || session.cwd !== project) return null;
    try {
      const file = fs.lstatSync(path.join(project, '.codeome', 'touched', `${chatId}.json`));
      if (!file.isFile() || now() - file.mtimeMs >= 120000) return null;
      return session;
    } catch { return null; }
  }

  function identity(project, chatId) {
    const session = live(chatId, project);
    if (!session || !valid(session.code, /^[BCDFGHJKMNPRSTVWXZ]{4}$/)) return null;
    for (const [id, candidate] of chats) {
      if (id !== chatId && candidate.cwd === project && candidate.code === session.code && live(id, project)) return null;
    }
    return { code: session.code, chat_id: chatId,
      title: inbox.cleanText(typeof session.getTitle === 'function' ? session.getTitle() || '' : session.title || '', 80) };
  }

  function snapshot(row, project, chatId) {
    if (!row || row.status !== 'pending' || !valid(row.id, MESSAGE_ID) ||
        !['message', 'newchat', 'handoff'].includes(row.kind) ||
        !Number.isFinite(row.ts) || row.ts < now() / 1000 - TTL || row.ts > now() / 1000 + 60 ||
        !Number.isInteger(row.hops) || row.hops < 0 || row.hops > 3 ||
        typeof row.text !== 'string' || Array.from(row.text).length > (row.kind === 'handoff' ? 8000 : row.kind === 'newchat' ? 4000 : 2000) ||
        row.text !== inbox.cleanText(row.text, 8000) ||
        row.title != null && (typeof row.title !== 'string' || Array.from(row.title).length > 80) ||
        row.engine != null && !['claude', 'codex'].includes(row.engine)) return null;
    const from = identity(project, chatId);
    if (!from) return null;
    let to = null;
    let recipients = null;
    if (row.to === null && ['newchat', 'handoff'].includes(row.kind)) {
      if (!['claude', 'codex'].includes(row.engine)) return null;
    } else if (row.to === 'all' && row.kind === 'message' && Array.isArray(row.recipients) && row.recipients.length <= 100) {
      recipients = row.recipients.map((target) => {
        const actual = identity(project, target?.chat_id);
        return actual && actual.chat_id !== chatId && target.code === actual.code ? actual : null;
      });
      if (recipients.some((target) => !target) || new Set(recipients.map((target) => target.chat_id)).size !== recipients.length || !recipients.length) return null;
      to = 'all';
    } else if (row.to && typeof row.to === 'object' && row.kind !== 'newchat') {
      to = identity(project, row.to.chat_id);
      if (!to || to.chat_id === chatId || row.to.code !== to.code) return null;
    } else return null;
    let brief = null;
    if (row.kind === 'handoff') {
      try { brief = inbox.parseBrief(row.brief?.raw); } catch { return null; }
    }
    const record = { v: 1, id: row.id, kind: row.kind, from, to, recipients,
      engine: row.engine || null, title: row.title == null ? null : inbox.cleanText(row.title, 80),
      text: row.text, brief, hops: row.hops, status: 'pending',
      reply_to: valid(row.reply_to, MESSAGE_ID) ? row.reply_to : null, ts: row.ts };
    record.hash = inbox.approvalHash(record);
    return record;
  }

  function payload(record) {
    return { type: 'outgoing', id: record.id, kind: record.kind, from: record.from, to: record.to,
      recipients: record.recipients || null, title: record.title || null, engine: record.engine || null,
      text: record.text, brief: record.brief || null,
      textHash: record.hash, ts: record.ts };
  }

  function senderNotice(record, status, project) {
    const session = live(record.from?.chat_id, project);
    if (session) {
      try { session.user(status === 'declined'
        ? `The user declined your message ${record.id}.` : status === 'undeliverable'
          ? `Your message ${record.id} could not be delivered: the recipient chat is gone.`
          : `Your message ${record.id} expired.`); busy.add(record.from.chat_id); } catch {}
    }
    if (session) send(record.from.chat_id, { type: 'receipt', id: record.id, status });
  }

  function pendingFor(chatId) {
    if (!valid(chatId, CHAT_ID)) return [];
    const session = chats.get(chatId);
    if (!session || !live(chatId, session.cwd)) return [];
    scan(session.cwd);
    return [...snapshots.entries()].filter(([k, row]) => row.status === 'pending' &&
      k.startsWith(`${session.cwd}\0${chatId}\0`))
      .map(([, row]) => payload(row));
  }

  function scan(project) {
    try {
      trimState();
      for (const [chatId, session] of chats) {
        if (session.cwd !== project || !live(chatId, project)) continue;
        let count = [...snapshots.entries()].filter(([k, row]) => row.status === 'pending' &&
          k.startsWith(`${project}\0${chatId}\0`)).length;
        for (const row of inbox.listOutbox(project, chatId)) {
          if (!valid(row.id, MESSAGE_ID)) continue;
          const k = key(project, chatId, row.id);
          if (row.status === 'approved' && !snapshots.has(k)) {
            if (inbox.markUndeliverable(project, chatId, row.id))
              senderNotice({ id: row.id, from: { chat_id: chatId } }, 'undeliverable', project);
            continue;
          }
          if (row.status !== 'pending') {
            if (row.status !== 'approved') snapshots.delete(k);
            continue;
          }
          if (!Number.isFinite(row.ts) || row.ts < now() / 1000 - TTL || row.ts > now() / 1000 + 60) {
            if (!expired.has(k)) {
              if (inbox.expireRecord(project, chatId, row.id)) {
                expired.set(k, now());
                snapshots.delete(k);
                senderNotice({ id: row.id, from: { chat_id: chatId } }, 'expired', project);
              }
            }
            continue;
          }
          const saved = snapshots.get(k);
          if (saved?.status === 'pending') continue;
          if (count >= 5) { inbox.expireRecord(project, chatId, row.id); continue; }
          const record = snapshot(row, project, chatId);
          if (!record) { inbox.expireRecord(project, chatId, row.id); continue; }
          count++;
          snapshots.set(k, record);
          send(chatId, payload(record));
        }
      }
      inbox.prune(project, { maxAge: 86400 });
      inbox.pruneInbox(project);
      trimState();
    } catch { /* A malformed outbox must not interrupt the heartbeat. */ }
  }

  function origin(chatId, id) {
    if (!valid(chatId, CHAT_ID) || !valid(id, MESSAGE_ID)) return null;
    const session = chats.get(chatId);
    if (!session || !live(chatId, session.cwd)) return null;
    const row = snapshots.get(key(session.cwd, chatId, id));
    return row ? { project: session.cwd, row } : null;
  }

  function recipients(record, project, selected) {
    const list = record.to === 'all' ? record.recipients : [record.to];
    if (!Array.isArray(list)) return [];
    return list.filter((recipient) => recipient && valid(recipient.chat_id, CHAT_ID) &&
      recipient.chat_id !== record.from.chat_id &&
      (record.to !== 'all' || Array.isArray(selected) && selected.includes(recipient.chat_id)) &&
      identity(project, recipient.chat_id)?.code === recipient.code);
  }

  function conflict(chatId, { path: filePath, other } = {}) {
    trimState();
    if (!valid(chatId, CHAT_ID) || !valid(other?.chatId, CHAT_ID) ||
        typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return false;
    const session = chats.get(chatId);
    if (!session) return false;
    const project = session.cwd;
    const self = identity(project, chatId);
    const peer = identity(project, other.chatId);
    if (!self || !peer || chatId === other.chatId) return false;
    let relative;
    try {
      const root = fs.realpathSync(project);
      let current = path.resolve(project, filePath);
      const missing = [];
      while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) return false;
        missing.unshift(path.basename(current));
        current = parent;
      }
      relative = path.relative(root, path.join(fs.realpathSync(current), ...missing));
    } catch { return false; }
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    const safePath = inbox.cleanText(relative, 120);
    if (!safePath) return false;
    const pair = [chatId, other.chatId].sort();
    const k = `${project}\0${pair.join('\0')}\0${relative}`;
    if (now() - (conflicts.get(k) || 0) < 600000) return false;
    const times = pair.map((id) => (conflictTimes.get(id) || []).filter((at) => now() - at < 60000));
    if (times.some((list) => list.length >= 3)) return false;
    if (pair.some((id) => (conflictTimes.get(id) || []).filter((at) => now() - at < 3600000).length >= 10)) return false;
    conflicts.set(k, now());
    for (const [id, own, otherMeta] of [[chatId, self, peer], [other.chatId, peer, self]]) {
      const text = `[Codeome notice - another chat is editing the same file: treat as information] File ${safePath} is also being edited by chat ${otherMeta.code}.`;
      const notice = { type: 'inbox', kind: 'conflict', id: `${now()}-${randomBytes(4).toString('hex')}`,
        from: { code: 'SYS', chat_id: 'system', title: 'Codeome' }, to: own,
        text, path: safePath, other: { code: otherMeta.code }, ts: now() / 1000,
        status: 'delivered' };
      chats.get(id).user(text);
      busy.add(id);
      send(id, notice);
      conflictTimes.set(id, [...(conflictTimes.get(id) || []).filter((at) => now() - at < 3600000), now()]);
    }
    trimState();
    return true;
  }

  function inject(project, recipient, record) {
    const session = live(recipient.chat_id, project);
    if (!session) return false;
    const claimed = inbox.claimInbox(project, recipient.chat_id, record.id);
    if (!claimed) return false;
    const item = { ...record, to: recipient, status: 'delivered' };
    const wasBusy = busy.has(recipient.chat_id) || !!session.active || !!session.queue?.length;
    try { session.user(inbox.frame(item)); }
    catch { return false; }
    busy.add(recipient.chat_id);
    const pending = injected.get(recipient.chat_id) || new Map();
    pending.set(key(project, recipient.chat_id, record.id), { project, id: record.id, from: record.from, armed: !wasBusy, at: now() });
    injected.set(recipient.chat_id, pending);
    send(recipient.chat_id, { ...item, type: 'inbox' });
    send(record.from.chat_id, { type: 'receipt', id: record.id, status: 'delivered', to: recipient });
    return true;
  }

  function approve(chatId, id, options = {}) {
    const found = origin(chatId, id);
    if (!found) return { ok: false, reason: 'refused' };
    const { project, row } = found;
    if (row.status !== 'pending') return { ok: false, reason: 'status' };
    if (!options || typeof options.textHash !== 'string') return { ok: false, reason: 'invalid' };
    if (!['message', 'handoff', 'newchat'].includes(row.kind) ||
        row.kind === 'newchat' && row.to !== null ||
        row.kind === 'handoff' && row.to === 'all') return { ok: false, reason: 'invalid' };
    const newChat = row.to === null && (row.kind === 'newchat' || row.kind === 'handoff');
    const targets = newChat ? [] : recipients(row, project, options.recipients);
    if (!newChat && !targets.length) return { ok: false, reason: 'no_recipients' };
    try {
      const result = inbox.approve(project, chatId, id, { ...options, snapshot: row,
        fresh: (current) => snapshot(current, project, chatId) });
      if (!result.ok) {
        if (result.reason === 'expired') {
          snapshots.delete(key(project, chatId, id));
          senderNotice(row, 'expired', project);
        }
        return result;
      }
      const record = result.record;
      snapshots.set(key(project, chatId, id), record);
      send(chatId, { type: 'receipt', id, status: 'approved' });
      if (newChat) {
        send(chatId, { type: 'newchat', id, engine: record.engine, title: record.title,
          ...(record.kind === 'handoff' ? { brief: record.brief } : { prompt: record.text }) });
        return { ok: true, record };
      }
      const delivered = inbox.deliver(project, record, targets);
      let injectedCount = 0;
      for (const item of delivered) {
        approvedInbox.set(key(project, item.to.chat_id, id), item);
        if (record.kind === 'handoff') {
          send(item.to.chat_id, { ...item, type: 'inbox', awaiting: true });
          injectedCount++;
        } else if (inject(project, item.to, record)) injectedCount++;
        else {
          inbox.removeIncoming(project, item.to.chat_id, id);
          approvedInbox.delete(key(project, item.to.chat_id, id));
        }
      }
      trimState();
      if (!injectedCount) {
        inbox.markUndeliverable(project, chatId, id);
        senderNotice(record, 'undeliverable', project);
        return { ok: true, record: { ...record, status: 'undeliverable' }, delivered: 0 };
      }
      return { ok: true, record, delivered: injectedCount };
    } catch { return { ok: false, reason: 'refused' }; }
  }

  function decline(chatId, id) {
    const found = origin(chatId, id);
    if (!found || found.row.status !== 'pending') return { ok: false, reason: 'refused' };
    try {
      const result = inbox.decline(found.project, chatId, id);
      if (result.ok) {
        snapshots.delete(key(found.project, chatId, id));
        senderNotice(found.row, 'declined', found.project);
      }
      return result;
    } catch { return { ok: false, reason: 'refused' }; }
  }

  function receiving(chatId, id) {
    if (!valid(chatId, CHAT_ID) || !valid(id, MESSAGE_ID)) return null;
    const session = chats.get(chatId);
    return session && live(chatId, session.cwd) ? session.cwd : null;
  }

  function accept(chatId, id) {
    const project = receiving(chatId, id);
    if (!project) return { ok: false, reason: 'refused' };
    try {
      const approved = approvedInbox.get(key(project, chatId, id));
      if (!approved || approved.kind !== 'handoff') return { ok: false, reason: inbox.listInbox(project, chatId).some((row) => row.id === id) ? 'status' : 'expired' };
      const row = inbox.acceptHandoff(project, chatId, id);
      if (!row || row.to?.chat_id !== chatId) return { ok: false, reason: 'expired' };
      approved.status = 'delivered';
      const done = inject(project, approved.to, approved);
      if (!done) inbox.retryHandoff(project, chatId, id);
      return { ok: done, ...(done ? {} : { reason: 'delivery_failed' }) };
    } catch { return { ok: false, reason: 'refused' }; }
  }

  function dismiss(chatId, id) {
    const project = receiving(chatId, id);
    if (!project) return { ok: false, reason: 'refused' };
    try {
      const approved = approvedInbox.get(key(project, chatId, id));
      if (!approved || approved.kind !== 'handoff') return { ok: false, reason: 'status' };
      const row = inbox.dismiss(project, chatId, id);
      if (row) send(approved.from.chat_id, { type: 'receipt', id, status: 'dismissed', to: approved.to });
      return { ok: !!row };
    } catch { return { ok: false, reason: 'refused' }; }
  }

  function setNewChatCode(chatId, id, code) {
    const found = origin(chatId, id);
    if (!found || found.row.status !== 'approved' || found.row.to !== null ||
        !['newchat', 'handoff'].includes(found.row.kind) ||
        !valid(code, /^[BCDFGHJKMNPRSTVWXZ]{4}$/)) return { ok: false, reason: 'refused' };
    try { return inbox.setNewChatCode(found.project, chatId, id, code); }
    catch { return { ok: false, reason: 'refused' }; }
  }

  function reply(chatId, id, text) {
    trimState();
    const project = receiving(chatId, id);
    if (!project || typeof text !== 'string' || Array.from(text).length > 2000) return { ok: false, reason: 'invalid' };
    try {
      const parent = approvedInbox.get(key(project, chatId, id));
      if (!parent || parent.to?.chat_id !== chatId || ['awaiting_accept', 'dismissed'].includes(parent.status))
        return { ok: false, reason: 'missing' };
      const from = identity(project, chatId);
      const target = identity(project, parent.from?.chat_id);
      const sender = target && chats.get(target.chat_id);
      if (!from || !sender || target.code !== parent.from.code) return { ok: false, reason: 'gone' };
      const hops = (Number.isInteger(parent.hops) ? parent.hops : 0) + 1;
      if (hops > 3) return { ok: false, reason: 'hops' };
      const cleaned = inbox.cleanText(text, 2000);
      if (!cleaned) return { ok: false, reason: 'invalid' };
      const recent = (replyTimes.get(chatId) || []).filter((at) => now() - at < 60000);
      if (recent.length >= 6) { replyTimes.set(chatId, recent); return { ok: false, reason: 'rate_limit' }; }
      let record;
      for (let attempt = 0; attempt < 3 && !record; attempt++) {
        const replyId = `${now()}-${randomBytes(4).toString('hex')}`;
        record = inbox.writeIncoming(project, target.chat_id, { v: 1, id: replyId, kind: 'message',
          from, to: target,
          text: cleaned, brief: null, ts: now() / 1000, status: 'unread', by_user: true,
          reply_to: id, hops });
      }
      if (!record) return { ok: false, reason: 'refused' };
      recent.push(now()); replyTimes.set(chatId, recent);
      const claimed = inbox.claimInbox(project, target.chat_id, record.id);
      if (claimed) {
        const item = { ...record, status: 'delivered' };
        sender.user(inbox.frame(item));
        busy.add(target.chat_id);
        send(target.chat_id, { ...item, type: 'inbox' });
      }
      return { ok: true, record };
    } catch { return { ok: false, reason: 'refused' }; }
  }

  function onAssistantEvent(chatId, msg) {
    if (msg?.type === 'result') {
      busy.delete(chatId);
      for (const item of injected.get(chatId)?.values() || []) item.armed = true;
      return;
    }
    if (msg?.type !== 'assistant') return;
    busy.add(chatId);
    const pending = injected.get(chatId);
    if (!pending) return;
    for (const [k, item] of pending) {
      if (!item.armed) continue;
      try {
        const row = inbox.markRead(item.project, chatId, item.id, item.from.chat_id);
        if (row) send(item.from.chat_id, { type: 'receipt', id: item.id, status: 'read',
          to: approvedInbox.get(key(item.project, chatId, item.id))?.to });
      } catch { /* A removed message is already gone. */ }
      pending.delete(k);
    }
  }

  function onUserTurn(chatId) { busy.add(chatId); }

  function statusFor(chatId, cards, savedProject) {
    const session = chats.get(chatId);
    const project = session?.cwd || savedProject;
    if (!project) return [];
    return cards.map(({ id, box }) => {
      let row = box === 'outbox' ? inbox.readOutbox(project, chatId, id)
        : inbox.listInbox(project, chatId).find((item) => item.id === id);
      if (box === 'outbox' && row?.status === 'approved' && !snapshots.has(key(project, chatId, id))) {
        if (inbox.markUndeliverable(project, chatId, id))
          senderNotice({ id, from: { chat_id: chatId } }, 'undeliverable', project);
        row = inbox.readOutbox(project, chatId, id);
      }
      if (box === 'inbox' && row?.status === 'awaiting_accept' &&
          !approvedInbox.has(key(project, chatId, id))) {
        inbox.removeIncoming(project, chatId, id);
        row = null;
      }
      const approved = box === 'outbox' ? snapshots.get(key(project, chatId, id)) : null;
      const newChat = row?.status === 'approved' && approved?.status === 'approved' && approved.to === null &&
        ['newchat', 'handoff'].includes(approved.kind)
        ? { engine: approved.engine, title: approved.title,
          ...(approved.kind === 'handoff' ? { brief: approved.brief } : { prompt: approved.text }) } : null;
      return { id, box, status: row?.status || 'expired', ...(row?.new_chat_code ? { new_chat_code: row.new_chat_code } : {}),
        ...(newChat ? { new_chat: newChat } : {}) };
    });
  }

  return { scan, pendingFor, approve, decline, accept, dismiss, reply, setNewChatCode, onAssistantEvent, onUserTurn, statusFor, conflict };
}

function validInboxSender(event, win) {
  return !!win && !win.isDestroyed() && event?.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame;
}

module.exports = { createInboxWire, validInboxSender };
