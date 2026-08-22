// @ts-check
const GOOGLE_STUN_URL = 'stun:stun.l.google.com:19302';

/** Default video sender max bitrate in bits/second (1.5 Mbps). */
const VIDEO_MAX_BITRATE_BPS = 1_500_000;
/** Default audio sender max bitrate in bits/second (64 kbps). */
const AUDIO_MAX_BITRATE_BPS = 64_000;
const CACHE_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_CREDENTIAL_TTL_MS = 55 * 60 * 1000;

/**
 * @typedef {object} IceServer
 * @property {string[]} urls
 * @property {string} [username]
 * @property {string} [credential]
 */

/** @type {IceServer[] | null} */
let cachedServerIceServers = null;
let cachedServerIceServersExpiresAt = 0;
/** @type {Promise<IceServer[]> | null} */
let pendingServerIceServers = null;

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function readEnv(name) {
  const env = globalThis?.process?.env;
  return env?.[name];
}

/**
 * Build the ICE server list from environment variables.
 *
 * TURN relay is supported in two flavours:
 *   1. **Self-hosted TURN** — set `TURN_URL` (comma-separated TURN URIs,
 *      e.g. `turn:relay.example.com:3478,turns:relay.example.com:5349`)
 *      together with `TURN_USERNAME` and `TURN_CREDENTIAL`.
 *   2. **Metered.ca hosted TURN** — set only `TURN_USERNAME` and
 *      `TURN_CREDENTIAL` (no `TURN_URL`); the metered.ca relay endpoints are
 *      used automatically.
 *
 * When neither is configured only the Google STUN server is included, which
 * works for peers on the same LAN but will fail across symmetric NAT (most
 * corporate firewalls).  Call `getTurnDiagnostics()` to check.
 */
export function getIceServers() {
  const turnUsername = readEnv('TURN_USERNAME');
  const turnCredential = readEnv('TURN_CREDENTIAL');
  const turnUrl = readEnv('TURN_URL');
  /** @type {IceServer[]} */
  const iceServers = [{ urls: [GOOGLE_STUN_URL] }];

  if (turnUsername && turnCredential) {
    let turnUrls;
    if (turnUrl) {
      // Self-hosted TURN: comma-separated URIs from the env var.
      turnUrls = turnUrl
        .split(',')
        .map(u => u.trim())
        .filter(Boolean);
    } else {
      // Metered.ca hosted TURN (default when no custom URL is set).
      turnUrls = [
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80?transport=tcp',
        'turn:global.relay.metered.ca:443',
        'turns:global.relay.metered.ca:443?transport=tcp',
      ];
    }

    iceServers.push({ urls: turnUrls, username: turnUsername, credential: turnCredential });
  }

  return iceServers;
}

/**
 * Fetch short-lived ICE servers for an authenticated call. A network failure
 * intentionally falls through to a still-valid cache, build-time fallback,
 * and finally STUN-only so call setup is never blocked by TURN availability.
 */
/**
 * @param {{ signalingUrl?: string, sessionId?: string | null, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<IceServer[]>}
 */
export async function getIceServersForCall({ signalingUrl, sessionId, fetchImpl = fetch } = {}) {
  const now = Date.now();
  if (cachedServerIceServers && cachedServerIceServersExpiresAt - now > CACHE_REFRESH_MARGIN_MS) {
    return cachedServerIceServers;
  }

  if (!signalingUrl || !sessionId || typeof fetchImpl !== 'function') {
    return getIceServers();
  }

  if (!pendingServerIceServers) {
    pendingServerIceServers = (async () => {
      const response = await fetchImpl(`${signalingUrl.trim().replace(/\/+$/, '')}/turn-credentials`, {
        headers: { Authorization: 'Bearer ' + sessionId },
      });
      if (!response.ok) {
        throw new Error(`TURN credentials request failed (HTTP ${response.status})`);
      }
      const iceServers = await response.json();
      if (!Array.isArray(iceServers)) {
        throw new Error('TURN credentials response was not an ICE server array');
      }
      const expiresAt = Date.parse(response.headers?.get?.('x-turn-credential-expires-at') || '');
      cachedServerIceServers = iceServers;
      cachedServerIceServersExpiresAt =
        Number.isFinite(expiresAt) && expiresAt > Date.now()
          ? expiresAt
          : Date.now() + DEFAULT_CREDENTIAL_TTL_MS;
      return iceServers;
    })().finally(() => {
      pendingServerIceServers = null;
    });
  }

  try {
    return await pendingServerIceServers;
  } catch {
    if (cachedServerIceServers && cachedServerIceServersExpiresAt > now) {
      return cachedServerIceServers;
    }
    return getIceServers();
  }
}

export function resetIceServersForCallCache() {
  cachedServerIceServers = null;
  cachedServerIceServersExpiresAt = 0;
  pendingServerIceServers = null;
}

/**
 * Return a diagnostic snapshot of the active TURN configuration, logging a
 * console warning when no credentials are present.  Useful at app start-up to
 * surface mis-configuration before the first call attempt.
 *
 * @returns {{ configured: boolean, provider: 'none'|'metered'|'custom', description: string }}
 */
export function getTurnDiagnostics() {
  const turnUsername = readEnv('TURN_USERNAME');
  const turnCredential = readEnv('TURN_CREDENTIAL');
  const turnUrl = readEnv('TURN_URL');

  if (!turnUsername || !turnCredential) {
    console.warn(
      '[WebRTC] No TURN credentials configured (TURN_USERNAME / TURN_CREDENTIAL). ' +
        'Calls across symmetric NAT will likely fail. ' +
        'Set TURN_URL + TURN_USERNAME + TURN_CREDENTIAL for self-hosted relay, ' +
        'or TURN_USERNAME + TURN_CREDENTIAL for the metered.ca default.',
    );
    return { configured: false, provider: 'none', description: 'STUN only (no TURN relay)' };
  }

  if (turnUrl) {
    return { configured: true, provider: 'custom', description: `Self-hosted TURN: ${turnUrl}` };
  }

  return { configured: true, provider: 'metered', description: 'Metered.ca hosted TURN' };
}

/**
 * Apply per-sender maximum bitrate caps to all RTP senders on `pc` using
 * `RTCRtpSender.setParameters()`.  Capping video at ~1.5 Mbps and audio at
 * 64 kbps reduces data-plan consumption and stabilises quality on congested
 * links.
 *
 * This is a best-effort operation: senders that do not expose
 * `getParameters` / `setParameters` (e.g. older react-native-webrtc builds)
 * are silently skipped.  The function never throws.
 *
 * @param {import('react-native-webrtc').RTCPeerConnection} pc
 * @param {{ videoMaxBps?: number, audioMaxBps?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function applyBitrateConstraints(pc, opts = {}) {
  const videoMaxBps = opts.videoMaxBps ?? VIDEO_MAX_BITRATE_BPS;
  const audioMaxBps = opts.audioMaxBps ?? AUDIO_MAX_BITRATE_BPS;

  const senders = pc.getSenders?.() ?? [];
  await Promise.all(
    senders.map(async sender => {
      try {
        const params = sender.getParameters?.();
        if (!params) return;
        if (!Array.isArray(params.encodings) || params.encodings.length === 0) {
          params.encodings = [/** @type {(typeof params.encodings)[number]} */ ({})];
        }
        const maxBitrate = sender.track?.kind === 'audio' ? audioMaxBps : videoMaxBps;
        params.encodings[0] = { ...params.encodings[0], maxBitrate };
        await sender.setParameters(params);
      } catch {
        // setParameters is best-effort; silently skip unsupported senders.
      }
    }),
  );
}
