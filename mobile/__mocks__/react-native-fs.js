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

/**
 * One `ReadDirItem`-shaped entry. `isFile`/`isDirectory` are methods on the
 * real item, not booleans, and callers branch on them.
 */
const dirEntry = (name, path, size, isDirectory) => ({
  name,
  path,
  size,
  mtime: new Date(0),
  ctime: new Date(0),
  isFile: () => !isDirectory,
  isDirectory: () => isDirectory,
});

module.exports = {
  DocumentDirectoryPath: '/tmp/wetalk-test-documents',
  CachesDirectoryPath: '/tmp/wetalk-test-caches',
  TemporaryDirectoryPath: '/tmp/wetalk-test-tmp',
  exists: jest.fn(async path => files.has(path)),
  readDir: jest.fn(async directory => {
    const prefix = `${directory}/`;
    const directories = new Set();
    const entries = [];
    for (const [path, contents] of files) {
      if (!path.startsWith(prefix)) continue;
      const relative = path.slice(prefix.length);
      const separator = relative.indexOf('/');
      if (separator === -1) {
        entries.push(dirEntry(relative, path, String(contents ?? '').length, false));
        continue;
      }
      const name = relative.slice(0, separator);
      if (directories.has(name)) continue;
      directories.add(name);
      entries.push(dirEntry(name, `${prefix}${name}`, 0, true));
    }
    return entries;
  }),
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
