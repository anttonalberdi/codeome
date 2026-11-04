function shouldRecord({ forum, scratch, hasCodeomeDir }) {
  return !forum && hasCodeomeDir;
}

function applyPresence(chats, payload, { touched }) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof payload.id !== 'string' || payload.id.length > 10240 ||
      typeof payload.project !== 'string' || payload.project.length > 10240 ||
      typeof payload.state !== 'string' || !Array.isArray(payload.jobs) ||
      payload.jobs.length > 20 || !payload.jobs.every((job) => typeof job === 'string' && job.length <= 10240) ||
      typeof payload.plan_title !== 'string' || payload.plan_title.length > 10240 ||
      typeof payload.first_request !== 'string' || payload.first_request.length > 10240 ||
      payload.state.length > 10240) return { ok: false };
    const session = chats.get(payload.id);
    if (!session || session.cwd !== payload.project || !touched.readMeta(session.cwd, payload.id)) return { ok: false };
    const status = ['working', 'waiting', 'idle'].includes(payload.state) ? payload.state : 'unknown';
    touched.writeStatus(session.cwd, payload.id, { code: session.code, status, jobs: payload.jobs,
      plan_title: payload.plan_title, first_request: payload.first_request });
    return { ok: true };
  } catch { return { ok: false }; }
}

module.exports = { shouldRecord, applyPresence };
