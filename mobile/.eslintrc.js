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
  },
};
