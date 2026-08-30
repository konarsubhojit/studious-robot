/**
 * How this app addresses a call over HTTP.
 *
 * One place, because the escaping is the point: a callId reaches these builders
 * from a notification payload as well as from the server, and building a URL
 * out of unescaped input is how a path separator becomes a different request.
 * Two copies of that rule would be two places for someone to later "simplify"
 * one of them.
 *
 * No React, no refs, no network — these only produce strings.
 */

import { API_ROUTES } from '../../../shared';

/** The base URL of a single call resource, with the id escaped. */
function callResourceUrl(signalingUrl: string, callId: string): string {
  return `${signalingUrl.trim()}${API_ROUTES.CALLS}/${encodeURIComponent(callId)}`;
}

/**
 * Where to ask the server about a call named by a push.
 *
 * The sessionId is escaped for the same reason as the callId: it travels in the
 * query string, where an unescaped `&` would silently become another parameter.
 */
export function buildCallLookupUrl({
  signalingUrl,
  callId,
  sessionId,
}: {
  signalingUrl: string;
  callId: string;
  sessionId: string;
}): string {
  return `${callResourceUrl(signalingUrl, callId)}?sessionId=${encodeURIComponent(sessionId)}`;
}

/** Where to POST a call action taken by this device. */
export function buildCallActionUrl({
  signalingUrl,
  callId,
  action,
}: {
  signalingUrl: string;
  callId: string;
  action: 'accept' | 'decline';
}): string {
  return `${callResourceUrl(signalingUrl, callId)}/${action}`;
}
