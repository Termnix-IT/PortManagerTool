const js = require('@eslint/js');
const globals = require('globals');

const sharedRules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'prefer-const': 'error',
  'no-var': 'error',
  eqeqeq: ['error', 'always'],
  // UI文言は日本語のため、全角スペース等の混入を検出する
  'no-irregular-whitespace': ['error', { skipStrings: false, skipTemplates: false }],
};

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'out/**'],
  },
  js.configs.recommended,
  {
    // main / preload / src / test: Node.js (CommonJS)
    files: ['**/*.js'],
    ignores: ['renderer/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: sharedRules,
  },
  {
    // renderer: ブラウザ (ESモジュール)。Node API は使えない
    files: ['renderer/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      ...sharedRules,
      'no-restricted-globals': ['error', { name: 'require', message: 'rendererではNode APIを使わず window.portManager 経由でmainと通信する' }],
    },
  },
];
