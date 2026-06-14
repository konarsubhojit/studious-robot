// Pure diagnostic helpers for media/ICE logging.  Kept free of React/native
// dependencies so they can be unit-tested in isolation.

/**
 * Classify a getUserMedia failure into a stable, greppable category so the
 * exported logs make the root cause obvious.
 *
 * @param {Error|{name?:string,message?:string}} error
 * @returns {'permission-denied'|'camera-in-use'|'overconstrained'|'device-not-found'|'generic'}
 */
export function classifyMediaError(error) {
  const name = `${error?.name || ''}`.toLowerCase();
  const message = `${error?.message || ''}`.toLowerCase();
  const combined = `${name} ${message}`;

  if (
    combined.includes('notallowed') ||
    combined.includes('permission') ||
    combined.includes('securityerror')
  ) {
    return 'permission-denied';
  }

  if (
    combined.includes('notreadable') ||
    combined.includes('trackstart') ||
    combined.includes('in use') ||
    combined.includes('busy') ||
    combined.includes('device in use')
  ) {
    return 'camera-in-use';
  }

  if (combined.includes('overconstrained') || combined.includes('constraint')) {
    return 'overconstrained';
  }

  if (combined.includes('notfound') || combined.includes('not found')) {
    return 'device-not-found';
  }

  return 'generic';
}

function normalizeUrls(urls) {
  if (Array.isArray(urls)) {
    return urls;
  }
  if (typeof urls === 'string') {
    return [urls];
  }
  return [];
}

/**
 * Summarize an ICE server configuration **without** exposing any credentials.
 * Reports the number of servers, whether a TURN server is configured, and the
 * TURN URL scheme/transport summaries present (e.g. `['turn:3478','turns:443?tcp']`).
 *
 * @param {Array<{urls?:string|string[]}>} iceServers
 * @returns {{iceServerCount:number, turnConfigured:boolean, turnSchemes:string[]}}
 */
export function summarizeIceServers(iceServers) {
  const list = Array.isArray(iceServers) ? iceServers : [];
  let turnConfigured = false;
  const turnSchemes = [];

  list.forEach((server) => {
    normalizeUrls(server?.urls).forEach((url) => {
      if (typeof url !== 'string') {
        return;
      }
      const lower = url.toLowerCase();
      if (!lower.startsWith('turn:') && !lower.startsWith('turns:')) {
        return;
      }
      turnConfigured = true;
      const scheme = lower.startsWith('turns:') ? 'turns' : 'turn';
      const portMatch = url.match(/:(\d+)/);
      const port = portMatch?.[1] || '?';
      const isTcp = /transport=tcp/i.test(url);
      const summary = isTcp ? `${scheme}:${port}?tcp` : `${scheme}:${port}`;
      if (!turnSchemes.includes(summary)) {
        turnSchemes.push(summary);
      }
    });
  });

  return { iceServerCount: list.length, turnConfigured, turnSchemes };
}

/**
 * Inspect a WebRTC stats report and summarize the selected (active) candidate
 * pair so it is immediately obvious whether media is flowing directly
 * (`host`/`srflx`) or via a TURN relay (`relay`).
 *
 * @param {{forEach:Function}} report - The value returned by `RTCPeerConnection.getStats()`.
 * @returns {{local:string, remote:string, protocol:string, usesRelay:boolean}|null}
 */
export function summarizeSelectedCandidatePair(report) {
  if (!report || typeof report.forEach !== 'function') {
    return null;
  }

  const statsById = new Map();
  let selectedPair = null;

  report.forEach((stat) => {
    if (!stat) {
      return;
    }
    if (stat.id) {
      statsById.set(stat.id, stat);
    }
    if (
      stat.type === 'candidate-pair' &&
      stat.state === 'succeeded' &&
      (stat.nominated || stat.selected)
    ) {
      selectedPair = stat;
    }
  });

  if (!selectedPair) {
    return null;
  }

  const local = statsById.get(selectedPair.localCandidateId);
  const remote = statsById.get(selectedPair.remoteCandidateId);
  const localType = local?.candidateType || 'unknown';
  const remoteType = remote?.candidateType || 'unknown';
  const protocol = local?.protocol || remote?.protocol || selectedPair.protocol || 'unknown';

  return {
    local: localType,
    remote: remoteType,
    protocol,
    usesRelay: localType === 'relay' || remoteType === 'relay',
  };
}
