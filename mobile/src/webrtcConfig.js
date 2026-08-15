const GOOGLE_STUN_URL = 'stun:stun.l.google.com:19302';

/** Default video sender max bitrate in bits/second (1.5 Mbps). */
const VIDEO_MAX_BITRATE_BPS = 1_500_000;
/** Default audio sender max bitrate in bits/second (64 kbps). */
const AUDIO_MAX_BITRATE_BPS = 64_000;

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
          params.encodings = [{}];
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
