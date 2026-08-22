# TypeScript migration

The migration is **complete**: every source and test file in `mobile/`,
`server/` and `shared/` is real TypeScript (`.ts`, or `.tsx` where the file
contains JSX). There is no JavaScript left apart from the mobile tooling
configs (`metro.config.js`, `babel.config.js`, `jest.config.js`,
`.eslintrc.js`, `.prettierrc.js`).

It happened in two steps:

1. Every `.js` file was annotated with JSDoc types and checked by `tsc` in
   `allowJs`/`checkJs` mode, one file at a time, with CI enforcing the result.
2. Once every file was typed, the files were renamed to `.ts`/`.tsx` and the
   JSDoc annotations were converted to TypeScript syntax (issue #121).

## How it works

- `mobile/tsconfig.json` and `server/tsconfig.json` run with `strict: true` and
  `noEmit: true`. There is still **no build step**: `tsc` is a type checker
  only.
- `mobile/` is bundled by Metro, which resolves `.ts`/`.tsx` natively. The
  entry point is `index.tsx`; because the React Native Gradle plugin and
  `react-native-xcode.sh` both default to `index.js`, the entry file is set
  explicitly in `android/app/build.gradle` (`entryFile`) and in the Xcode
  "Bundle React Native code and images" phase (`ENTRY_FILE`).
- `server/` runs its `.ts` sources directly on Node's built-in type stripping
  (Node >= 22.18), so `npm start` is `node src/index.ts` and the tests run with
  `node --test "test/**/*.test.ts"`. Type stripping cannot execute TypeScript
  that emits code, so the server is plain ESM: no `enum`, no parameter
  properties, no `import x = require(...)`.
- Because Node runs the sources as ESM, **relative imports carry the real file
  extension** (`import { x } from './lib/state.ts'`), which is why both
  tsconfigs set `allowImportingTsExtensions`.
- `shared/` is an ESM TypeScript package (`"type": "module"`) consumed by both
  projects and type-checked from both.
- `npm run typecheck` (in `mobile/` and in `server/`) runs the check locally;
  both CI workflows run the same command and fail on any type error.

## Adding a file

1. Create it as `.ts`, or `.tsx` if it contains JSX.
2. Import it with its extension from other server/shared modules
   (`./thing.ts`); mobile files may rely on Metro's resolution.
3. Run `npm run typecheck` in the owning project. Prefer describing the real
   shape over `any`; use `value as T` casts only where a third-party type is
   wrong.

## Conventions

- **One source of truth per contract.** Types live in TypeScript syntax only:
  JSDoc keeps the prose (`@param name what it means`) but never repeats a type
  in braces, because the annotation next to it is what `tsc` actually checks.
- **Named prop/param types.** A component takes `XProps` and a hook takes
  `UseXParams`, both exported next to the function, instead of an inline
  object type in the parameter list. Callers and tests can then refer to the
  contract by name.
- **Real imports for types.** Use `import type { X } from 'mod'` at the top of
  the file rather than an inline `import('mod').X` reference.
- **Reuse before redeclaring.** Cross-screen shapes live in one module —
  presence and directory rows in `mobile/src/types/directory.ts`, wire
  contracts in `shared/` — and are re-exported (`export type { X };`) from the
  modules that used to declare their own copy.
