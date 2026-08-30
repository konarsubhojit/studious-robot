module.exports = {
  root: true,
  extends: '@react-native',
  env: {
    es2021: true,
    jest: true,
  },
  globals: {
    globalThis: 'readonly',
  },
  plugins: ['sonarjs'],
  rules: {
    // Cognitive complexity, not cyclomatic: it penalises nesting and gives
    // flat early-return code a pass, which is much closer to what makes a
    // function hard to read. `warn` rather than `error` because the codebase
    // has a large pre-existing backlog (catalogued in
    // `docs/complexity-baseline.md`); the level is raised to `error` once the
    // decomposition phases have cleared it, and no new violation should be
    // added in the meantime.
    'sonarjs/cognitive-complexity': ['warn', 15],
    'import/first': 'off',
    'no-void': 'off',
    // Context and props types used to be written as single-line object
    // literals hundreds of characters wide, which are unreviewable in a diff
    // and destroy `git blame`. The `ignorePattern` inverts the usual sense of
    // this rule: every line that is *not* a type or interface declaration is
    // exempt, so this constrains declaration formatting only and does not
    // impose a general line-length style on the codebase.
    'max-len': [
      'error',
      { code: 120, ignorePattern: '^(?! *(export )?(type|interface) )' },
    ],
  },
};
