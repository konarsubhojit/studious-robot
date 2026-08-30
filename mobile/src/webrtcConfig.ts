import { logError, logInfo, logVerbose, logWarn } from './appLogger';
import type { RTCPeerConnection } from 'react-native-webrtc';
import { describeError } from './errors';

const GOOGLE_STUN_URL = 'stun:stun.l.google.com:19302';

/** Default video sender max bitrate in bits/second (1.5 Mbps). */
const VIDEO_MAX_BITRATE_BPS = 1_500_000;
/** Default audio sender max bitrate in bits/second (64 kbps). */
const AUDIO_MAX_BITRATE_BPS = 64_000;
const CACHE_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_CREDENTIAL_TTL_MS = 55 * 60 * 1000;

export const ICE_TRANSPORT_POLICIES = {
  ALL: 'all',
  RELAY: 'relay',
} as const;

export const ICE_TRANSPORT_POLICY_VALUES = [
  ICE_TRANSPORT_POLICIES.ALL,
  ICE_TRANSPORT_POLICIES.RELAY,
];

export type IceTransportPolicy = (typeof ICE_TRANSPORT_POLICY_VALUES)[number];

export function normalizeIceTransportPolicy(value: unknown): IceTransportPolicy {
  return ICE_TRANSPORT_POLICY_VALUES.includes(value as IceTransportPolicy)
    ? (value as IceTransportPolicy)
    : ICE_TRANSPORT_POLICIES.ALL;
}

export type IceServer = { urls: string[]; username?: string; credential?: string; };

let cachedServerIceServers: IceServer[] | null = null;
let cachedServerIceServersExpiresAt = 0;
let pendingServerIceServers: Promise<IceServer[]> | null = null;

function readEnv(name: string): string | undefined {
  const env = globalThis?.process?.env;
  return env?.[name];
}

export function deriveStunUrlsFromTurnUrl(value: unknown): string[] {
  if (typeof value !== 'string') return [];

  const stunUrls = new Set<string>();
  value.split(',').map(url => url.trim()).filter(Boolean).forEach(turnUrl => {
    const match = turnUrl.match(/^turn:(?:\/\/)?(.+)$/i);
    if (!match) return;
    try {
      const parsed = new URL(`http://${match[1]}`);
      if (!parsed.hostname) return;
      stunUrls.add(`stun:${parsed.hostname}:${parsed.port || '3478'}`);
    } catch {
      // Ignore malformed TURN URLs and retain the Google STUN fallback.
    }
  });
  return [...stunUrls];
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
  const iceServers: IceServer[] = [
    { urls: [...deriveStunUrlsFromTurnUrl(turnUrl), GOOGLE_STUN_URL] },
  ];

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
 * The source the ICE server list returned by {@link getIceServersForCall}
 * actually came from. Anything other than `fetched` means the call has, at
 * best, the credentials this build was compiled with.
 */
export type IceServerTier = 'fetched' | 'cache' | 'stale-cache' | 'build-time-config';

/** Why a call fell back to a tier below `fetched`. */
export type IceFallbackReason =
  | 'missing-session-id'
  | 'missing-signaling-url'
  | 'no-fetch-implementation'
  | 'http-error'
  | 'transport-error'
  | 'malformed-response';

/**
 * The `scheme:host` of a single TURN URI, or `null` when it is not one.
 *
 * Parsed by hand rather than with `URL`: React Native's `URL` polyfill only
 * recognises `http(s):` (its `hostname` getter matches `^https?://`), so every
 * `turn:`/`turns:` URI came back host-less and a perfectly good relay list was
 * reported as having no TURN server at all. The optional `//`, the userinfo
 * some providers embed, a bracketed IPv6 host, the port and the
 * `?transport=` suffix are all handled here.
 */
function turnEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value
    .trim()
    .match(/^(turns?):(?:\/\/)?(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i);
  return match ? `${match[1].toLowerCase()}:${match[2]}` : null;
}

/**
 * The TURN endpoints in an ICE server list, as `scheme:host` — never the
 * username or credential that comes with them.
 *
 * `urls` is accepted both as a string and as an array of strings, which is
 * what `RTCPeerConnection` itself accepts, so this summary can never disagree
 * with the list the connection was actually given.
 */
export function getTurnServerEndpoints(iceServers: unknown): string[] {
  if (!Array.isArray(iceServers)) return [];
  const endpoints = new Set<string>();
  iceServers.forEach(server => {
    if (!server || typeof server !== 'object') return;
    const rawUrls = (server as { urls?: unknown }).urls;
    const urls = Array.isArray(rawUrls) ? rawUrls : [rawUrls];
    urls.forEach(value => {
      const endpoint = turnEndpoint(value);
      if (endpoint) endpoints.add(endpoint);
    });
  });
  return [...endpoints];
}

/**
 * The host of `signalingUrl`, so a log line can name the server without
 * carrying a session token or any query string with it.
 */
function signalingHost(signalingUrl: unknown): string {
  if (typeof signalingUrl !== 'string' || !signalingUrl.trim()) return 'unset';
  try {
    const parsed = new URL(signalingUrl.trim());
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return 'unparseable';
  }
}

/**
 * An error carrying why the TURN credential fetch failed, so the single
 * `catch` below can name the branch instead of discarding it.
 */
class IceFetchError extends Error {
  reason: IceFallbackReason;
  status?: number;

  constructor(message: string, reason: IceFallbackReason, status?: number) {
    super(message);
    this.name = 'IceFetchError';
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Log the tier the call ended up on, and — separately — the fact that a call
 * is about to be set up with no relay at all.
 *
 * A TURN-less list is not a warning but an error: such a call cannot traverse
 * symmetric NAT, and until now it looked exactly like a healthy one in the
 * logs. Credentials are never included; only `scheme:host`.
 */
function reportIceServers(iceServers: IceServer[], tier: IceServerTier, metadata: Record<string, unknown> = {}): IceServer[] {
  const turnServers = getTurnServerEndpoints(iceServers);
  if (tier === 'fetched') {
    logInfo('[WebRTC] ICE servers fetched', { tier, turnServers, ...metadata });
  } else if (tier === 'cache') {
    // Every call before the credentials expire takes this path, so it is
    // detail rather than news.
    logVerbose('[WebRTC] ICE servers served from cache', { tier, turnServers, ...metadata });
  } else {
    logWarn('[WebRTC] ICE servers degraded below fetched credentials', {
      tier,
      turnServers,
      ...metadata,
    });
  }

  if (turnServers.length === 0) {
    logError('[WebRTC] ICE server list contains no TURN server', {
      tier,
      ...metadata,
      impact: 'the call cannot traverse symmetric NAT and may fail to connect',
    });
  }
  return iceServers;
}

function missingIceFallbackReason(
  signalingUrl: string | undefined,
  sessionId: string | null | undefined,
  fetchImpl: typeof fetch,
): IceFallbackReason {
  if (!signalingUrl) return 'missing-signaling-url';
  if (!sessionId) return 'missing-session-id';
  return typeof fetchImpl === 'function' ? 'transport-error' : 'no-fetch-implementation';
}

async function fetchServerIceServers(
  signalingUrl: string,
  sessionId: string,
  fetchImpl: typeof fetch,
): Promise<IceServer[]> {
  let response;
  try {
    response = await fetchImpl(`${signalingUrl.trim().replace(/\/+$/, '')}/turn-credentials`, {
      headers: { Authorization: 'Bearer ' + sessionId },
    });
  } catch (error) {
    throw new IceFetchError(
      `TURN credentials request could not be sent: ${describeError(error)}`,
      'transport-error',
    );
  }
  if (!response.ok) {
    throw new IceFetchError(
      `TURN credentials request failed (HTTP ${response.status})`,
      'http-error',
      response.status,
    );
  }
  let iceServers;
  try {
    iceServers = await response.json();
  } catch (error) {
    throw new IceFetchError(
      `TURN credentials response could not be parsed: ${describeError(error)}`,
      'malformed-response',
    );
  }
  if (!Array.isArray(iceServers)) {
    throw new IceFetchError(
      'TURN credentials response was not an ICE server array',
      'malformed-response',
    );
  }
  const expiresAt = Date.parse(response.headers?.get?.('x-turn-credential-expires-at') || '');
  cachedServerIceServers = iceServers;
  cachedServerIceServersExpiresAt =
    Number.isFinite(expiresAt) && expiresAt > Date.now()
      ? expiresAt
      : Date.now() + DEFAULT_CREDENTIAL_TTL_MS;
  return iceServers;
}

function fetchServerIceServersOnce(
  signalingUrl: string,
  sessionId: string,
  fetchImpl: typeof fetch,
): Promise<IceServer[]> {
  if (!pendingServerIceServers) {
    pendingServerIceServers = fetchServerIceServers(signalingUrl, sessionId, fetchImpl).finally(() => {
      pendingServerIceServers = null;
    });
  }
  return pendingServerIceServers;
}

function fallbackIceServersAfterFetchError(error: unknown, now: number, host: string): IceServer[] {
  const reason: IceFallbackReason =
    error instanceof IceFetchError ? error.reason : 'transport-error';
  const status = error instanceof IceFetchError ? error.status : undefined;
  // The message, never the error object: a serialized error can carry the
  // request it was thrown from, and that request carries the session token.
  const message = describeError(error);
  if (cachedServerIceServers && cachedServerIceServersExpiresAt > now) {
    return reportIceServers(cachedServerIceServers, 'stale-cache', {
      host,
      reason,
      status,
      message,
    });
  }
  return reportIceServers(getIceServers(), 'build-time-config', { host, reason, status, message });
}

/**
 * Fetch short-lived ICE servers for an authenticated call. A network failure
 * intentionally falls through to a still-valid cache, build-time fallback,
 * and finally STUN-only so call setup is never blocked by TURN availability.
 *
 * Every one of those degradations is logged with the tier it landed on and the
 * reason it got there: a relay-less call used to be indistinguishable from a
 * healthy one in the logs, which is what made an empty TURN list impossible to
 * diagnose after the fact.
 */
export async function getIceServersForCall({ signalingUrl, sessionId, fetchImpl = fetch }: { signalingUrl?: string; sessionId?: string | null; fetchImpl?: typeof fetch; } = {}): Promise<IceServer[]> {
  const now = Date.now();
  const host = signalingHost(signalingUrl);
  if (cachedServerIceServers && cachedServerIceServersExpiresAt - now > CACHE_REFRESH_MARGIN_MS) {
    return reportIceServers(cachedServerIceServers, 'cache', {
      host,
      expiresInMs: cachedServerIceServersExpiresAt - now,
    });
  }

  if (!signalingUrl || !sessionId || typeof fetchImpl !== 'function') {
    // No fetch is even attempted here — the branch that produced a TURN-less
    // call with no trace of a request in either the client or server logs.
    const reason = missingIceFallbackReason(signalingUrl, sessionId, fetchImpl);
    return reportIceServers(getIceServers(), 'build-time-config', { host, reason });
  }

  try {
    const iceServers = await fetchServerIceServersOnce(signalingUrl, sessionId, fetchImpl);
    return reportIceServers(iceServers, 'fetched', { host });
  } catch (error) {
    return fallbackIceServersAfterFetchError(error, now, host);
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
 */
export function getTurnDiagnostics(): { configured: boolean; provider: 'none' | 'metered' | 'custom'; description: string; } {
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
 */
export async function applyBitrateConstraints(pc: RTCPeerConnection, opts: { videoMaxBps?: number; audioMaxBps?: number; } = {}): Promise<void> {
  const videoMaxBps = opts.videoMaxBps ?? VIDEO_MAX_BITRATE_BPS;
  const audioMaxBps = opts.audioMaxBps ?? AUDIO_MAX_BITRATE_BPS;

  const senders = pc.getSenders?.() ?? [];
  await Promise.all(
    senders.map(async sender => {
      try {
        const params = sender.getParameters?.();
        if (!params) return;
        if (!Array.isArray(params.encodings) || params.encodings.length === 0) {
          params.encodings = [({} as (typeof params.encodings)[number])];
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
