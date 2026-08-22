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
 * GET a JSON body, optionally appending the session id as a query parameter.
 *
 * @param url - Base URL of the server under test.
 * @param path - Request path, including the leading slash.
 * @param sessionId - Appended as `?sessionId=` when present.
 */
async function getJson(url: string, path: string, sessionId?: string): Promise<{ status: number; body: any; }> {
  const pathname = sessionId
    ? `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`
    : path;
  const response = await fetch(`${url}${pathname}`);
  return { status: response.status, body: await readJson(response) };
}

export {
  captureConsoleLog,
  getJson,
  listenOnRandomPort,
  postJson,
  readJson,
};
