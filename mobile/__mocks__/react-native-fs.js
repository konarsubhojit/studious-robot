/**
 * Automatic mock for `react-native-fs`.
 *
 * The real package ships untranspiled Flow syntax, so any module that reaches
 * it — `settingsStorage`, `appLogger`, `diagnostics` — fails to parse under
 * Jest. Individual suites used to work around that by declaring their own
 * `jest.mock('react-native-fs', …)` factory; this file makes the mock apply
 * automatically (Jest picks up `__mocks__` adjacent to `node_modules` for node
 * modules without an explicit `jest.mock` call), so a hook can import from
 * `settingsStorage` without every one of its suites needing to know.
 *
 * Suites that assert on file contents still declare their own factory, which
 * takes precedence over this one.
 *
 * Backed by an in-memory map so reads observe writes within a test.
 */
const files = new Map();

module.exports = {
  DocumentDirectoryPath: '/tmp/wetalk-test-documents',
  CachesDirectoryPath: '/tmp/wetalk-test-caches',
  TemporaryDirectoryPath: '/tmp/wetalk-test-tmp',
  exists: jest.fn(async path => files.has(path)),
  readFile: jest.fn(async path => {
    if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
    return files.get(path);
  }),
  writeFile: jest.fn(async (path, contents) => {
    files.set(path, contents);
  }),
  appendFile: jest.fn(async (path, contents) => {
    files.set(path, (files.get(path) ?? '') + contents);
  }),
  unlink: jest.fn(async path => {
    files.delete(path);
  }),
  mkdir: jest.fn(async () => {}),
  stat: jest.fn(async path => ({ size: (files.get(path) ?? '').length })),
  copyFile: jest.fn(async (from, to) => {
    files.set(to, files.get(from) ?? '');
  }),
  moveFile: jest.fn(async (from, to) => {
    files.set(to, files.get(from) ?? '');
    files.delete(from);
  }),
  downloadFile: jest.fn(() => ({ promise: Promise.resolve({ statusCode: 200 }) })),
  /** Test-only helper: drop every file written so far. */
  __reset: () => files.clear(),
};
