// Token use of the agent chat's sessions, and the statistics kept about them. Plain Node
// (no Electron) so it is testable.
//
// A Meter reads one session's stream (see chat.js) and says how full its context window
// is and what each turn used. Every finished turn is appended as one line to
// ~/.codeome/stats/turns.jsonl, which stays on this Mac; summary() turns those lines into
// what the Statistics tab shows.
//   context  — what the last request to the model held: its input (cached or not) plus
//              its reply. This is what the next turn starts from.
//   turn     — the difference in the session's running totals (result.modelUsage, which
//              also counts subagents and Claude Code's own side requests). A resumed
//              session carries its totals on, unless another session ran in the project
//              in between; then they start again from zero.
//   costUsd  — Claude Code's figure at API list prices. On a subscription nothing is
//              charged; it weighs cached and fresh tokens the way the limits do.
const fs = require('fs');
const path = require('path');
const usage = require('./usage');

const KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, apiMs: 0 };
const sum = (t) => KEYS.reduce((n, k) => n + (t[k] || 0), 0);
const inputSide = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

// The session's running totals over every model it used.
function totals(modelUsage) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of Object.values(modelUsage || {})) {
    t.input += u.inputTokens || 0; t.output += u.outputTokens || 0;
    t.cacheRead += u.cacheReadInputTokens || 0; t.cacheWrite += u.cacheCreationInputTokens || 0;
  }
  return t;
}

// The context window of the session's own model; subagents may run on another.
function windowOf(modelUsage, model) {
  const names = Object.keys(modelUsage || {});
  const own = names.find((n) => n === model) || names.find((n) => model && (n.startsWith(model) || model.startsWith(n)));
  if (own && modelUsage[own].contextWindow) return modelUsage[own].contextWindow;
  return Math.max(0, ...names.map((n) => modelUsage[n].contextWindow || 0));
}

class Meter {
  // For a resumed conversation: context is what it held when it was last used, run its
  // running totals then (a turn's `run`; null for a conversation from before they were kept).
  constructor({ resumed = false, context = 0, run = null } = {}) {
    this.model = null; this.context = Number(context) || 0; this.window = 0; this.input = 0;
    this.prev = { ...ZERO, ...(run || {}) };
    this.resumed = resumed; this.known = !!run;
    this.begin();
  }

  begin() { this.before = this.context; this.peak = this.context; this.tools = 0; this.subagents = 0; this.compactions = 0; }

  // Every message of the stream goes through here. Returns { context: { used, window } }
  // when the reading moved, { turn } at the end of a turn, otherwise null.
  feed(m) {
    if (m.type === 'system') {
      if (m.subtype === 'init') this.model = m.model || this.model;
      else if (m.subtype === 'compact_boundary') {
        this.compactions++;
        this.peak = Math.max(this.peak, (m.compact_metadata && m.compact_metadata.pre_tokens) || 0);
      }
      return null;
    }
    if (m.type === 'stream_event') {
      if (m.parent_tool_use_id) return null;
      const e = m.event || {};
      return this.read(e.type === 'message_start' ? e.message && e.message.usage : e.type === 'message_delta' ? e.usage : null);
    }
    if (m.type === 'assistant') {
      const msg = m.message || {};
      if (m.parent_tool_use_id) return null;
      for (const b of msg.content || []) if (b.type === 'tool_use') { this.tools++; if (b.name === 'Agent' || b.name === 'Task') this.subagents++; }
      return this.read(msg.usage);
    }
    if (m.type === 'result') return { turn: this.turn(m) };
    return null;
  }

  read(u) {
    if (!u) return null;
    // A message_delta may carry the reply's size alone; the input is then the one it started with.
    if (inputSide(u)) this.input = inputSide(u);
    else if (!u.output_tokens) return null;
    const used = this.input + (u.output_tokens || 0);
    if (used === this.context) return null;
    this.context = used;
    this.peak = Math.max(this.peak, used);
    return { context: { used, window: this.window } };
  }

  turn(m) {
    const mu = m.modelUsage;
    const u = m.usage || {};
    // Without running totals, the turn's own usage is all there is.
    const now = mu
      ? { ...totals(mu), costUsd: m.total_cost_usd || 0, apiMs: m.duration_api_ms || 0 }
      : { input: this.prev.input + (u.input_tokens || 0), output: this.prev.output + (u.output_tokens || 0), cacheRead: this.prev.cacheRead + (u.cache_read_input_tokens || 0),
        cacheWrite: this.prev.cacheWrite + (u.cache_creation_input_tokens || 0), costUsd: m.total_cost_usd || this.prev.costUsd, apiMs: m.duration_api_ms || this.prev.apiMs };
    // The first turn after resuming: totals that do not cover this turn's own usage on top
    // of the earlier ones have started again from zero. Without earlier totals to compare
    // with, the turn's own usage is counted and nothing else.
    if (this.resumed && mu) {
      if (!this.known) this.prev = { input: now.input - (u.input_tokens || 0), output: now.output - (u.output_tokens || 0), cacheRead: now.cacheRead - (u.cache_read_input_tokens || 0),
        cacheWrite: now.cacheWrite - (u.cache_creation_input_tokens || 0), costUsd: now.costUsd, apiMs: now.apiMs };
      else if (sum(now) - sum(this.prev) < inputSide(u) + (u.output_tokens || 0)) this.prev = { ...ZERO };
    }
    this.resumed = false;
    const d = (k) => Math.max(0, now[k] - this.prev[k]);
    this.window = windowOf(mu, this.model) || this.window;
    const t = {
      model: this.model, input: d('input'), output: d('output'), cacheRead: d('cacheRead'), cacheWrite: d('cacheWrite'),
      costUsd: Math.round(d('costUsd') * 1e6) / 1e6, ms: m.duration_ms || 0, apiMs: d('apiMs'),
      before: this.before, context: this.context, peak: this.peak, window: this.window,
      tools: this.tools, subagents: this.subagents, compactions: this.compactions,
      error: !!((m.subtype && m.subtype !== 'success') || m.is_error), run: now
    };
    this.prev = now;
    this.begin();
    return t;
  }
}

// ---------- the log ----------
const file = () => path.join(usage.home(), 'stats', 'turns.jsonl');

// entry: a turn with { at, session, project, account }; its running totals are left out.
function record({ run, ...entry }) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.appendFileSync(file(), JSON.stringify(entry) + '\n');
}

function read() {
  let text; try { text = fs.readFileSync(file(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const t = JSON.parse(line); if (t && t.session && t.at) out.push(t); } catch {} // a line cut short by a crash
  }
  return out;
}

// ---------- the summary ----------
const FILL = [[0, 25], [25, 50], [50, 75], [75, Infinity]];
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function blank() { return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, costUsd: 0, ms: 0 }; }
function add(a, t) {
  a.turns++;
  for (const k of KEYS) a[k] += t[k] || 0;
  a.tokens += sum(t);
  a.costUsd += t.costUsd || 0; a.ms += t.ms || 0;
  return a;
}

// The turns of the last `days` days: in total, per day, per project, per session, and by
// how full the context was when the turn started.
function summary(turns, { days = 30, now = Date.now() } = {}) {
  const since = now - days * 86400000;
  const total = blank(), byDay = {}, byProject = {}, bySession = {};
  const fill = FILL.map(([from, to]) => ({ from, to: to === Infinity ? 100 : to, ...blank() }));
  for (const t of turns) {
    if (t.at < since || t.at > now) continue;
    add(total, t);
    add(byDay[dayOf(t.at)] || (byDay[dayOf(t.at)] = { day: dayOf(t.at), ...blank() }), t);
    const p = byProject[t.project] || (byProject[t.project] = { project: t.project, sessions: new Set(), ...blank() });
    add(p, t); p.sessions.add(t.session);
    const s = bySession[t.session] || (bySession[t.session] = { session: t.session, project: t.project, account: t.account, engine: t.engine || 'claude', first: t.at, peakPct: null, compactions: 0, ...blank() });
    add(s, t);
    s.last = t.at; s.model = t.model || s.model; s.compactions += t.compactions || 0;
    if (t.window) {
      s.peakPct = Math.max(s.peakPct || 0, Math.round((t.peak || t.context || 0) / t.window * 100));
      const pct = (t.before || 0) / t.window * 100;
      add(fill.find((f, i) => pct >= FILL[i][0] && pct < FILL[i][1]), t);
    }
  }
  const sessions = Object.values(bySession).sort((a, b) => b.last - a.last);
  return {
    days, since, total: { ...total, sessions: sessions.length, compacted: sessions.filter((s) => s.compactions).length },
    byDay: Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1)),
    byProject: Object.values(byProject).map((p) => ({ ...p, sessions: p.sessions.size })).sort((a, b) => b.costUsd - a.costUsd),
    sessions, fill
  };
}

module.exports = { Meter, totals, windowOf, record, read, summary, file };
