// @ts-check
'use strict';

/**
 * Capture console.log output for assertions.
 *
 * Tests must call `restore()` in `t.after(...)` or a `finally` block so the
 * process-wide console implementation is always restored before later tests run.
 */
function captureConsoleLog() {
  const original = console.log;
  /** @type {string[]} */
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(' '));
    original(...args);
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

/**
 * Bind an HTTP server to an ephemeral loopback port and resolve that port.
 *
 * `Server#address()` is typed as `string | AddressInfo | null` because it also
 * covers pipes and unbound servers; this narrows it once for every test.
 *
 * @param {import('http').Server} httpServer
 * @returns {Promise<number>} the port the server is listening on
 */
async function listenOnRandomPort(httpServer) {
  await new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected the test server to be bound to a TCP port');
  }
  return address.port;
}

/**
 * Read a JSON response body. `Response#json()` resolves to `unknown`, which is
 * deliberately awkward to assert against, so tests opt into `any` here once.
 *
 * @param {Response} response
 * @returns {Promise<any>}
 */
function readJson(response) {
  return response.json();
}

/**
 * POST a JSON body, optionally injecting a session id into it.
 *
 * @param {string} url - Base URL of the server under test.
 * @param {string} path - Request path, including the leading slash.
 * @param {Record<string, unknown>} body
 * @param {string} [sessionId] - Merged into the body when present.
 * @returns {Promise<{ status: number, body: any }>}
 */
async function postJson(url, path, body, sessionId) {
  const payload = sessionId ? { ...body, sessionId } : body;
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await readJson(response) };
}

/**
 * GET a JSON body, optionally appending the session id as a query parameter.
 *
 * @param {string} url - Base URL of the server under test.
 * @param {string} path - Request path, including the leading slash.
 * @param {string} [sessionId] - Appended as `?sessionId=` when present.
 * @returns {Promise<{ status: number, body: any }>}
 */
async function getJson(url, path, sessionId) {
  const pathname = sessionId
    ? `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`
    : path;
  const response = await fetch(`${url}${pathname}`);
  return { status: response.status, body: await readJson(response) };
}

module.exports = {
  captureConsoleLog,
  getJson,
  listenOnRandomPort,
  postJson,
  readJson,
};
