module.exports = {
  root: true,
  extends: '@react-native',
  plugins: ['import'],
  env: {
    es2021: true,
    jest: true,
  },
  globals: {
    globalThis: 'readonly',
  },
  rules: {
    'import/first': 'error',
    'no-void': 'off',
  },
};
