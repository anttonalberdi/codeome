const crypto = require('node:crypto');

const PAIRING_TTL_MS = 5 * 60 * 1000;
const LAST_SEEN_INTERVAL_MS = 60 * 1000;

function digest(value) { return crypto.createHash('sha256').update(value).digest(); }
function publicDevice(device) {
  return { id: device.id, label: device.label, createdAt: device.createdAt,
    lastSeen: device.lastSeen, lastIp: device.lastIp };
}

function createAuth({ store, now = Date.now, random = crypto.randomBytes }) {
  let pairing = null;

  function createPairingCode() {
    const code = random(16).toString('hex');
    const expiresAt = now() + PAIRING_TTL_MS;
    pairing = { hash: digest(code), expiresAt };
    return { code, expiresAt };
  }
  function pairingActive() { return !!pairing && now() < pairing.expiresAt; }

  function redeem(code, label, meta = {}) {
    if (!pairing || typeof code !== 'string' || now() >= pairing.expiresAt ||
        !crypto.timingSafeEqual(digest(code), pairing.hash) ||
        typeof label !== 'string' || !label.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()) return { ok: false };
    pairing = null;
    const token = random(32).toString('base64url');
    const deviceId = random(16).toString('hex');
    const at = now();
    const device = { id: deviceId, label: label.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 64), hash: digest(token).toString('hex'),
      createdAt: at, lastSeen: at, lastIp: meta && typeof meta.ip === 'string' ? meta.ip : '' };
    store.set([...store.get(), device]);
    return { ok: true, token, deviceId };
  }

  function verify(token) {
    if (typeof token !== 'string' || !token) return { ok: false };
    const hash = digest(token);
    const devices = store.get();
    let index = -1;
    for (let i = 0; i < devices.length; i++) {
      const saved = devices[i].hash;
      if (typeof saved === 'string' && /^[0-9a-f]{64}$/.test(saved) &&
          crypto.timingSafeEqual(hash, Buffer.from(saved, 'hex'))) index = i;
    }
    if (index < 0) return { ok: false };
    const device = devices[index];
    if (now() - device.lastSeen >= LAST_SEEN_INTERVAL_MS) {
      const updated = { ...device, lastSeen: now() };
      store.set(devices.map((entry, i) => i === index ? updated : entry));
      return { ok: true, device: publicDevice(updated) };
    }
    return { ok: true, device: publicDevice(device) };
  }

  function listDevices() { return store.get().map(publicDevice); }

  function rename(id, label) {
    if (typeof label !== 'string' || !label.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()) return false;
    const devices = store.get();
    if (!devices.some((device) => device.id === id)) return false;
    store.set(devices.map((device) => device.id === id ? { ...device, label: label.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 64) } : device));
    return true;
  }

  function revoke(id) {
    const devices = store.get();
    const remaining = devices.filter((device) => device.id !== id);
    if (remaining.length === devices.length) return false;
    store.set(remaining);
    return true;
  }

  function revokeAll() { store.set([]); }

  return { createPairingCode, pairingActive, redeem, verify, listDevices, rename, revoke, revokeAll };
}

function createLimiter({ now = Date.now, maxFailures = 5, windowMs = 60 * 1000,
  baseLockMs = 30 * 1000, maxLockMs = 15 * 60 * 1000, maxKeys = 1000 } = {}) {
  const keys = new Map();
  const idleMs = Math.max(24 * 60 * 60 * 1000, windowMs * 10, maxLockMs * 10);
  let lastPrune = 0;

  function prune(at) {
    if (at - lastPrune < Math.max(1000, windowMs)) return;
    lastPrune = at;
    for (const [key, state] of keys)
      if (at - state.lastTouched >= idleMs && at >= state.lockedUntil) keys.delete(key);
  }

  function check(key) {
    prune(now());
    const state = keys.get(key);
    if (state) { keys.delete(key); keys.set(key, state); }
    const retryAfterMs = state ? Math.max(0, state.lockedUntil - now()) : 0;
    return { allowed: retryAfterMs === 0, retryAfterMs };
  }

  function fail(key) {
    if (!check(key).allowed) return;
    const at = now();
    let state = keys.get(key);
    if (!state) state = { windowStart: at, failures: 0, locks: 0, lockedUntil: 0, lastTouched: at };
    if (at - state.windowStart >= windowMs) { state.windowStart = at; state.failures = 0; }
    state.lastTouched = at;
    state.failures++;
    if (state.failures >= maxFailures) {
      state.lockedUntil = at + Math.min(maxLockMs, baseLockMs * 2 ** state.locks);
      state.failures = maxFailures - 1;
      state.locks++;
    }
    keys.delete(key);
    keys.set(key, state);
    while (keys.size > maxKeys) keys.delete(keys.keys().next().value);
  }

  function success(key) { keys.delete(key); }

  return { check, fail, success };
}

module.exports = { createAuth, createLimiter };
