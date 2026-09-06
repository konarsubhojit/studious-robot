#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

const CLIENT_EVENTS = Object.freeze({ MESSAGE_SEND: 'message.send' });
const SERVER_EVENTS = Object.freeze({
  MESSAGE_RECEIVED: 'message.received',
  SERVER_DRAINING: 'server.draining',
  SESSION_INVALID: 'session.invalid',
  SIGNALING_ERROR: 'signaling.error',
});
const SIGNALING_VERSION = 1;
const REPORT_INTERVAL_MS = 15_000;
const SWEEP_INTERVAL_MS = 5_000;
const DEFAULTS = Object.freeze({
  USERS: 1000,
  USER_OFFSET: 0,
  MSG_PER_MIN: 20,
  HOLD_SECS: 300,
  RAMP_SECS: 120,
  BODY_BYTES: 120,
  DELIVERY_TIMEOUT_MS: 30_000,
});

class ConfigError extends Error {}

function parseInteger(env, name, fallback, { min = 0 } = {}) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${name} must be an integer >= ${min}; got ${JSON.stringify(raw)}`);
  }
  return value;
}

function defaultOutputPath(now = new Date()) {
  return `run-${now.toISOString().replace(/[:.]/g, '-')}.jsonl`;
}

function loadConfig(env = process.env, now = new Date()) {
  const target = env.TARGET?.trim();
  if (!target) {
    throw new ConfigError('TARGET is required; set it to the base URL of the server under test.');
  }

  const users = parseInteger(env, 'USERS', DEFAULTS.USERS, { min: 2 });
  if (users % 2 !== 0) {
    throw new ConfigError(`USERS must be even so users can be paired; got ${users}.`);
  }

  const userOffset = parseInteger(env, 'USER_OFFSET', DEFAULTS.USER_OFFSET, { min: 0 });
  const msgPerMin = parseInteger(env, 'MSG_PER_MIN', DEFAULTS.MSG_PER_MIN, { min: 0 });
  const holdSecs = parseInteger(env, 'HOLD_SECS', DEFAULTS.HOLD_SECS, { min: 0 });
  const rampSecs = parseInteger(env, 'RAMP_SECS', DEFAULTS.RAMP_SECS, { min: 1 });
  const bodyBytes = parseInteger(env, 'BODY_BYTES', DEFAULTS.BODY_BYTES, { min: 1 });
  const deliveryTimeoutMs = parseInteger(env, 'DELIVERY_TIMEOUT_MS', DEFAULTS.DELIVERY_TIMEOUT_MS, { min: 1 });
  const minRampBatch = Math.max(1, Math.ceil(users / rampSecs));
  const rampBatch = env.RAMP_BATCH === undefined
    ? minRampBatch
    : parseInteger(env, 'RAMP_BATCH', minRampBatch, { min: 1 });

  if (rampBatch < minRampBatch) {
    throw new ConfigError(
      `RAMP_BATCH=${rampBatch} is too small to connect ${users} users in ${rampSecs}s; ` +
        `minimum required value is ${minRampBatch}.`
    );
  }

  return {
    target: target.replace(/\/+$/, ''),
    users,
    userOffset,
    msgPerMin,
    holdSecs,
    rampSecs,
    rampBatch,
    bodyBytes,
    deliveryTimeoutMs,
    out: env.OUT || defaultOutputPath(now),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function summarize(values) {
  if (values.length === 0) {
    return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

function increment(errors, reason) {
  const key = reason || 'unknown';
  errors[key] = (errors[key] ?? 0) + 1;
}

function phaseFor(startedAt, rampSecs) {
  return Date.now() - startedAt < rampSecs * 1000 ? 'ramp' : 'steady';
}

function makeBody(bytes) {
  return 'x'.repeat(bytes);
}

function userIdAt(config, index) {
  return `lt-${config.userOffset + index}`;
}

function peerIndex(index) {
  return index % 2 === 0 ? index + 1 : index - 1;
}

function messageId(userId, sequence) {
  return `${userId}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function extractErrorReason(payload, fallback) {
  if (payload?.error?.code) return String(payload.error.code);
  if (payload?.code) return String(payload.code);
  if (payload?.message) return String(payload.message);
  return fallback;
}

async function createSession(config, userId) {
  const response = await fetch(`${config.target}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, deviceId: `d-${userId}`, idToken: userId }),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON errors are still counted by status below.
  }

  if (response.status === 401) return { ok: false, reason: 'session_401' };
  if (!response.ok) return { ok: false, reason: `session_${response.status}` };
  if (!body?.sessionId) return { ok: false, reason: 'session_invalid' };
  return { ok: true, sessionId: body.sessionId };
}

function connectSocket(io, config, sessionId, userId, onEventError) {
  const socket = io(config.target, {
    auth: { sessionId },
    forceNew: true,
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelayMax: 10_000,
  });

  socket.on(SERVER_EVENTS.SERVER_DRAINING, () => onEventError('server_draining'));
  socket.on(SERVER_EVENTS.SESSION_INVALID, () => onEventError('session_invalid'));
  socket.on(SERVER_EVENTS.SIGNALING_ERROR, (payload) => {
    onEventError(extractErrorReason(payload, 'signaling_error'));
  });
  socket.on('connect_error', (error) => {
    onEventError(error?.message ? `connect_error:${error.message}` : 'connect_error');
  });
  socket.on('disconnect', (reason) => {
    if (reason !== 'io client disconnect') onEventError(`disconnect:${reason}`);
  });
  socket.data = { userId };
  return socket;
}

async function waitForConnect(socket) {
  if (socket.connected) return true;
  return new Promise((resolve) => {
    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
    };
    const onConnect = () => {
      cleanup();
      resolve(true);
    };
    const onConnectError = () => {
      cleanup();
      resolve(false);
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onConnectError);
  });
}

async function openUser(io, config, index, state, startedAt) {
  const userId = userIdAt(config, index);
  const session = await createSession(config, userId);
  if (!session.ok) {
    state.connectFail += 1;
    increment(state.errors, session.reason);
    return null;
  }

  const socket = connectSocket(io, config, session.sessionId, userId, (reason) => {
    increment(state.errors, reason);
  });

  if (!(await waitForConnect(socket))) {
    state.connectFail += 1;
    increment(state.errors, 'connect_failed');
    socket.disconnect();
    return null;
  }

  state.connected += 1;
  socket.on(SERVER_EVENTS.MESSAGE_RECEIVED, (payload) => {
    const deliveredId = payload?.message?.messageId;
    const pending = state.inFlight.get(deliveredId);
    if (!pending) return;
    state.inFlight.delete(deliveredId);
    const latency = Date.now() - pending.t0;
    const bucket = pending.phase === 'steady' ? state.deliverySteady : state.deliveryRamp;
    bucket.push(latency);
  });

  const user = { index, userId, socket, sendSequence: 0, timer: null };
  startSender(config, state, user, startedAt);
  return user;
}

function startSender(config, state, user, startedAt) {
  if (config.msgPerMin === 0) return;

  const intervalMs = 60_000 / config.msgPerMin;
  const sendOnce = () => sendMessage(config, state, user, startedAt);
  const firstDelay = Math.floor(Math.random() * intervalMs);
  const timeout = setTimeout(() => {
    sendOnce();
    user.timer = setInterval(sendOnce, intervalMs);
  }, firstDelay);
  user.timer = timeout;
}

function sendMessage(config, state, user, startedAt) {
  if (!user.socket.connected) return;

  const id = messageId(user.userId, user.sendSequence++);
  const currentPhase = phaseFor(startedAt, config.rampSecs);
  const payload = {
    version: SIGNALING_VERSION,
    recipientId: userIdAt(config, peerIndex(user.index)),
    body: state.body,
    type: 'text',
    messageId: id,
  };
  const t0 = Date.now();
  state.inFlight.set(id, { t0, phase: currentPhase });

  user.socket.emit(CLIENT_EVENTS.MESSAGE_SEND, payload, (ack) => {
    if (!ack?.ok) {
      state.inFlight.delete(id);
      increment(state.errors, extractErrorReason(ack, 'ack_error'));
      return;
    }
    state.sent += 1;
    const latency = Date.now() - t0;
    const bucket = currentPhase === 'steady' ? state.ackSteady : state.ackRamp;
    bucket.push(latency);
  });
}

function sweepDeliveryTimeouts(inFlight, now, timeoutMs, errors) {
  let removed = 0;
  for (const [id, entry] of inFlight) {
    if (now - entry.t0 <= timeoutMs) continue;
    inFlight.delete(id);
    removed += 1;
  }
  if (removed > 0) errors.delivery_timeout = (errors.delivery_timeout ?? 0) + removed;
  return removed;
}

function snapshot(tag, config, state, startedAt) {
  const phase = phaseFor(startedAt, config.rampSecs);
  return {
    tag,
    ts: new Date().toISOString(),
    phase,
    connected: state.connected,
    connectFail: state.connectFail,
    sent: state.sent,
    pending: state.inFlight.size,
    ack: summarize(state.ackSteady),
    delivery: summarize(state.deliverySteady),
    ackRamp: summarize(state.ackRamp),
    deliveryRamp: summarize(state.deliveryRamp),
    errors: { ...state.errors },
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

function emitLine(stream, line) {
  const text = `${JSON.stringify(line)}\n`;
  process.stdout.write(text);
  stream.write(text);
}

async function rampUsers(io, config, state, startedAt) {
  const users = [];
  for (let next = 0; next < config.users;) {
    const batch = [];
    for (let count = 0; count < config.rampBatch && next < config.users; count += 1, next += 1) {
      batch.push(openUser(io, config, next, state, startedAt));
    }
    users.push(...(await Promise.all(batch)).filter(Boolean));
    if (next < config.users) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return users;
}

async function closeStream(stream) {
  stream.end();
  await once(stream, 'finish');
}

async function run(config) {
  const { io } = await import('socket.io-client');
  const startedAt = Date.now();
  const stream = createWriteStream(config.out, { flags: 'a' });
  const state = {
    connected: 0,
    connectFail: 0,
    sent: 0,
    body: makeBody(config.bodyBytes),
    inFlight: new Map(),
    ackSteady: [],
    deliverySteady: [],
    ackRamp: [],
    deliveryRamp: [],
    errors: {},
  };
  const users = [];
  let finalized = false;

  // Undelivered messages must age out so `pending` remains current queue depth
  // and a lossy run cannot grow memory forever.
  const sweeper = setInterval(() => {
    sweepDeliveryTimeouts(state.inFlight, Date.now(), config.deliveryTimeoutMs, state.errors);
  }, SWEEP_INTERVAL_MS);
  const reporter = setInterval(() => {
    emitLine(stream, snapshot('hold', config, state, startedAt));
  }, REPORT_INTERVAL_MS);

  async function finalize(exitCode) {
    if (finalized) return;
    finalized = true;
    clearInterval(reporter);
    clearInterval(sweeper);
    sweepDeliveryTimeouts(state.inFlight, Date.now(), config.deliveryTimeoutMs, state.errors);
    for (const user of users) {
      if (user.timer) clearTimeout(user.timer);
      user.socket.disconnect();
    }
    emitLine(stream, snapshot('final', config, state, startedAt));
    await closeStream(stream);
    process.exitCode = exitCode;
  }

  process.once('SIGINT', () => {
    void finalize(0).then(() => process.exit(0));
  });

  // The default batch is derived from USERS/RAMP_SECS so the ramp completes
  // before the steady hold window begins, instead of silently measuring connect churn.
  users.push(...await rampUsers(io, config, state, startedAt));
  const elapsed = Date.now() - startedAt;
  const holdUntil = config.rampSecs * 1000 + config.holdSecs * 1000;
  if (elapsed < holdUntil) {
    await new Promise((resolve) => setTimeout(resolve, holdUntil - elapsed));
  }
  const failed = state.connectFail > 0 || Object.keys(state.errors).length > 0;
  await finalize(failed ? 1 : 0);
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  run(config).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { ConfigError, defaultOutputPath, loadConfig, summarize, sweepDeliveryTimeouts };
