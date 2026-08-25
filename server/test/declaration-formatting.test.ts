/**
 * Formatting guard for type declarations.
 *
 * Context, store, and props types were written as single-line object literals
 * hundreds of characters wide. They are unreviewable in a diff — a one-field
 * change shows as a whole-line rewrite — and they collapse `git blame` for
 * every field onto whichever commit last touched any of them.
 *
 * The mobile package enforces this with an `eslint` `max-len` rule scoped to
 * declarations. The server has no linter, so the same guard runs here instead
 * of introducing one; both are gated by CI either way.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const MAX_DECLARATION_LINE_LENGTH = 120;
const DECLARATION = /^ *(export )?(type|interface) /;

/**
 * List the server and shared TypeScript sources tracked by git, so generated
 * and ignored files are never scanned.
 */
function trackedSources(): string[] {
  const output = execFileSync(
    'git',
    // `**` does not match a bare filename, so the top-level pattern is
    // listed separately: without it the largest files in each package —
    // `server/src/config.ts`, `shared/schema.ts` — would go unchecked.
    [
      'ls-files',
      'server/src/*.ts',
      'server/src/**/*.ts',
      'shared/*.ts',
      'shared/**/*.ts',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  return output.split('\n').filter(Boolean);
}

test('type declarations are wrapped rather than written as one wide line', () => {
  const offenders: string[] = [];

  for (const file of trackedSources()) {
    const lines = readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.length > MAX_DECLARATION_LINE_LENGTH && DECLARATION.test(line)) {
        offenders.push(`${file}:${index + 1} (${line.length} chars)`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Wrap these declarations across multiple lines so diffs and blame stay readable:\n${offenders.join('\n')}`
  );
});
