/**
 * Centralised, validated application configuration for the mobile client.
 *
 * Build-time environment variables (inlined by
 * `babel-plugin-transform-inline-environment-variables`) are read in one place
 * with documented defaults and light validation, instead of scattering
 * `process.env` lookups and silent `localhost` fallbacks across the app.
 */

const DEFAULTS = Object.freeze({
  signalingUrl: 'http://localhost:4173',
  roomId: 'room-1',
});

function readEnv(name) {
  const env = globalThis?.process?.env;
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate a signaling server URL. Only http(s)/ws(s) URLs are accepted.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidSignalingUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  try {
    const { protocol } = new URL(value.trim());
    return ['http:', 'https:', 'ws:', 'wss:'].includes(protocol);
  } catch {
    return false;
  }
}

/**
 * Whether the resolved signaling URL points at a local/loopback host. Useful
 * for surfacing a "you're still pointing at localhost" warning in release
 * builds where that is almost certainly a misconfiguration.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isLoopbackUrl(value) {
  try {
    const { hostname } = new URL(value);
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the validated application configuration.
 *
 * Falls back to the documented defaults when an environment value is missing or
 * invalid, and reports any issues via `warnings` so the UI/logs can surface
 * misconfiguration without crashing the app.
 *
 * @returns {{ signalingUrl: string, roomId: string, warnings: string[] }}
 */
export function getAppConfig() {
  const warnings = [];

  let signalingUrl = readEnv('SIGNALING_URL') || DEFAULTS.signalingUrl;
  if (!isValidSignalingUrl(signalingUrl)) {
    warnings.push(`Invalid SIGNALING_URL "${signalingUrl}"; falling back to ${DEFAULTS.signalingUrl}`);
    signalingUrl = DEFAULTS.signalingUrl;
  }
  if (isLoopbackUrl(signalingUrl)) {
    warnings.push('SIGNALING_URL points at a loopback host; remote devices will not connect.');
  }

  const roomId = readEnv('ROOM_ID') || DEFAULTS.roomId;

  return { signalingUrl, roomId, warnings };
}

export const APP_CONFIG_DEFAULTS = DEFAULTS;
