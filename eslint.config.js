const js = require('@eslint/js');
const globals = require('globals');

// lib/tests/scripts 共用 globals（Node 测试与浏览器库并存的既有环境）
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
  MokaUsage: 'readonly',
  MokaMokaSource: 'readonly',
  MokaCandidateProfile: 'readonly',
  MokaResultSession: 'readonly',
  MokaScreeningRunner: 'readonly'
};

// lib/*.js 在 content 的 ISOLATED world / SW 里按加载顺序互相暴露的命名空间。
// content/inject/popup 运行在页面环境，background 运行在 service worker。
// 注：inject.js（MAIN world）不加载 lib，实际不引用任何 Moka*，声明仅作统一白名单。
const mokaNamespaceGlobals = {
  MokaScore: 'readonly',
  MokaCapture: 'readonly',
  MokaPersist: 'readonly',
  MokaFeedback: 'readonly',
  MokaScreeningJob: 'readonly',
  MokaActions: 'readonly',
  MokaMatch: 'readonly',
  MokaCalibrate: 'readonly',
  MokaContracts: 'readonly',
  MokaUsage: 'readonly',
  MokaMokaSource: 'readonly',
  MokaCandidateProfile: 'readonly',
  MokaResultSession: 'readonly',
  MokaScreeningRunner: 'readonly',
  MokaBatch: 'readonly',
  MokaPluginLog: 'readonly'
};

// 入口脚本规则：no-undef 锁死「引用未声明标识符」（1.6.17 死调用即此类漏网）；
// no-unused-vars 的 argsIgnorePattern/caughtErrors 吸收 catch(e){} 与 _ 前缀等惯用法
const entryRules = {
  ...js.configs.recommended.rules,
  'no-undef': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }]
};

// content/inject/popup：浏览器页面环境 + chrome API + Moka 命名空间
// module 仅 content.js 底部「测试 require 守卫」使用（typeof module 先行判断）
const entryPageEnv = {
  ...globals.browser,
  chrome: 'readonly',
  module: 'readonly',
  ...mokaNamespaceGlobals
};

// background：service worker 环境 + chrome API + Moka 命名空间
const entryWorkerEnv = {
  ...globals.serviceworker,
  chrome: 'readonly',
  ...mokaNamespaceGlobals
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
  },
  {
    files: ['content.js', 'inject.js', 'popup/popup.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: entryPageEnv
    },
    rules: entryRules
  },
  {
    files: ['background.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: entryWorkerEnv
    },
    rules: entryRules
  }
];
