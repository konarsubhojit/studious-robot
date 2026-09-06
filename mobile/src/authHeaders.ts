/**
 * The one way this app presents its session to the server.
 *
 * A session id is a bearer token. Put it in a query string and it is written
 * to the reverse proxy's access log, kept in any intermediary's request
 * history, and attached to a `Referer` — none of which the caller controls or
 * can clear. The `Authorization` header is the transport designed for it: it
 * is not logged by default and is not part of the URL.
 *
 * One helper rather than a repeated object literal so there is a single place
 * that knows the scheme, and so a call site cannot half-migrate by putting the
 * token in both places.
 *
 * No React, no network — this only produces a headers object.
 */

/**
 * Build the `Authorization` header for an authenticated request.
 *
 * @param sessionId - the session id returned by `POST /session`.
 * @param extra - additional headers to merge (e.g. `Content-Type`); the
 *   `Authorization` entry always wins so a caller cannot accidentally drop it.
 */
export function bearerAuthHeaders(
  sessionId: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return { ...extra, Authorization: `Bearer ${sessionId}` };
}
