const js = require('@eslint/js');
const globals = require('globals');

const sharedGlobals = {
  ...globals.browser,
  ...globals.node,
  chrome: 'readonly',
  MokaScore: 'readonly',
  MokaCapture: 'readonly',
  MokaPersist: 'readonly',
  MokaFeedback: 'readonly',
  MokaScreeningJob: 'readonly',
  MokaActions: 'readonly',
  MokaMatch: 'readonly',
  MokaCalibrate: 'readonly',
  MokaContracts: 'readonly',
  MokaMokaSource: 'readonly',
  MokaCandidateProfile: 'readonly',
  MokaResultSession: 'readonly',
  MokaScreeningRunner: 'readonly'
};

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**']
  },
  {
    files: ['lib/**/*.js', 'tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: sharedGlobals
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  }
];
