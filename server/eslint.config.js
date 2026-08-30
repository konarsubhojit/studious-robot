// @ts-check
import tseslint from 'typescript-eslint';

/**
 * Server lint rules.
 *
 * The rule set is deliberately tiny: this is not a style pass. It exists for
 * the correctness rules that need type information and therefore cannot be
 * replicated by a hand-rolled scan — an un-awaited promise in a Socket.IO
 * handler rejects into an unhandled rejection, which by default takes the
 * process (and every in-flight call with it) down.
 *
 * `shared/` is linted from here too: it is type-checked by this package's
 * `tsconfig.json` and is otherwise covered by no linter, since the mobile
 * package only lints its own directory. ESLint refuses to lint files outside
 * the working directory, which is why `npm run lint` runs from the repo root
 * and names both directories explicitly.
 */
export default tseslint.config(
  tseslint.configs.base,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // `node:test` starts and tracks its own subtests: the promise a
          // top-level `test(...)` returns is awaited by the runner, so the
          // hundreds of calls in `test/` are not floating.
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'it', 'describe'] },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      // Type declarations used to be written as single-line object literals
      // hundreds of characters wide, which are unreviewable in a diff and
      // destroy `git blame`. The `ignorePattern` inverts the usual sense of
      // this rule: every line that is *not* a type or interface declaration is
      // exempt, so this constrains declaration formatting only and does not
      // impose a general line-length style on the codebase. Kept identical to
      // the mobile package's rule.
      'max-len': [
        'error',
        { code: 120, ignorePattern: '^(?! *(export )?(type|interface) )' },
      ],
    },
  }
);
