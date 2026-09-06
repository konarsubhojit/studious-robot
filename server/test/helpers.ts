/**
 * Shut a test server down: drop keep-alive sockets, close the Socket.IO
 * server, then close the HTTP server.
 *
 * The order matters and was previously copy-pasted into ~25 suites. Socket.IO
 * has to close first because it owns the upgraded WebSocket connections that
 * would otherwise keep `httpServer.close()` waiting until its own timeout, and
 * `closeAllConnections()` has to run first because idle keep-alive HTTP
 * connections keep it waiting for the same reason — a suite that gets either
 * wrong hangs rather than fails. `io.close()` returns a promise as well as
 * taking a callback; the callback is the one being awaited here, so the
 * promise is explicitly discarded to satisfy `no-floating-promises`.
 *
 * @param server - The object returned by `createServer()`.
 */
async function closeTestServer(server: {
  io: { close: (done: () => void) => unknown; };
  httpServer: { close: (done: () => void) => unknown; closeAllConnections?: () => void; };
}): Promise<void> {
  server.httpServer.closeAllConnections?.();
  await new Promise((resolve) => {
    void server.io.close(() => server.httpServer.close(() => resolve(undefined)));
  });
}

/**
 * Capture console.log output for assertions.
 *
 * Tests must call `restore()` in `t.after(...)` or a `finally` block so the
 * process-wide console implementation is always restored before later tests run.
 */
function captureConsoleLog() {
  const original = console.log;
  const lines: string[] = [];
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
 * @returns the port the server is listening on
 */
async function listenOnRandomPort(httpServer: import('http').Server): Promise<number> {
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
 */
function readJson(response: Response): Promise<any> {
  return response.json();
}

/**
 * POST a JSON body, optionally injecting a session id into it.
 *
 * @param url - Base URL of the server under test.
 * @param path - Request path, including the leading slash.
 * @param sessionId - Merged into the body when present.
 */
async function postJson(url: string, path: string, body: Record<string, unknown>, sessionId?: string): Promise<{ status: number; body: any; }> {
  const payload = sessionId ? { ...body, sessionId } : body;
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await readJson(response) };
}

/**
 * GET a JSON body, authenticating with the `Authorization` bearer header.
 *
 * The session id is a bearer token, so it never travels in the query string —
 * `getSessionFromRequest` no longer looks there, and neither does the app.
 *
 * @param url - Base URL of the server under test.
 * @param path - Request path, including the leading slash.
 * @param sessionId - Sent as `Authorization: Bearer <id>` when present.
 */
async function getJson(url: string, path: string, sessionId?: string): Promise<{ status: number; body: any; }> {
  const response = await fetch(`${url}${path}`, {
    headers: sessionId ? { authorization: `Bearer ${sessionId}` } : {},
  });
  return { status: response.status, body: await readJson(response) };
}

/**
 * Assert a test double into the dependency type it stands in for.
 *
 * The injected dependencies are typed against their real implementations — the
 * schema-bound Drizzle handle, the message-store interface and the Socket.IO
 * server — each of which is far wider than the subset any one suite exercises.
 * A double therefore cannot be checked against them structurally, so the
 * assertion is made once, here at the injection point, rather than with an
 * `as any` scattered through every suite (the same reasoning as
 * `src/messageStore/types.ts`'s `MongoClientLike`).  The double's own shape is
 * preserved so suites can still assert against the calls it recorded.
 */
function asDatabase<T>(double: T): T & import('../db/client.ts').Database {
  return double as T & import('../db/client.ts').Database;
}

/**
 * Assert a message-store double into the injected {@link MessageStore}; see
 * {@link asDatabase}.
 */
function asMessageStore<T>(double: T): T & import('../src/messageStore.ts').MessageStore {
  return double as T & import('../src/messageStore.ts').MessageStore;
}

/**
 * Assert a Socket.IO adapter double into the constructor `io.adapter()` takes;
 * see {@link asDatabase}.
 */
function asSocketIoAdapter<T>(double: T): T & Parameters<import('socket.io').Server['adapter']>[0] {
  return double as T & Parameters<import('socket.io').Server['adapter']>[0];
}

/**
 * Assert a Socket.IO server double into the real server type; see
 * {@link asDatabase}.
 */
function asSocketIoServer<T>(double: T): T & import('socket.io').Server {
  return double as T & import('socket.io').Server;
}

export {
  asDatabase,
  asMessageStore,
  asSocketIoAdapter,
  asSocketIoServer,
  captureConsoleLog,
  closeTestServer,
  getJson,
  listenOnRandomPort,
  postJson,
  readJson,
};
