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
  rules: {
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
