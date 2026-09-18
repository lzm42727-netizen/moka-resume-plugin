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
  MokaDomAdapter: 'readonly',
  MokaMatch: 'readonly',
  MokaCalibrate: 'readonly',
  MokaContracts: 'readonly',
  MokaUsage: 'readonly',
  MokaMokaSource: 'readonly',
  MokaCandidateProfile: 'readonly',
  MokaResultSession: 'readonly',
  MokaScreeningRunner: 'readonly',
  MokaFeishu: 'readonly',
  LOCAL_DEFAULTS: 'readonly'
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
  MokaDomAdapter: 'readonly',
  MokaMatch: 'readonly',
  MokaCalibrate: 'readonly',
  MokaContracts: 'readonly',
  MokaUsage: 'readonly',
  MokaMokaSource: 'readonly',
  MokaCandidateProfile: 'readonly',
  MokaResultSession: 'readonly',
  MokaScreeningRunner: 'readonly',
  MokaBatch: 'readonly',
  MokaPluginLog: 'readonly',
  MokaFeishu: 'readonly'
};

// popup 三文件（popup.js / popup-results.js / popup-batch.js）在页面里按经典脚本
// 共享全局作用域，eslint 单文件分析看不见跨文件声明——这里显式登记 v3.4.0 拆分后
// 的跨模块符号（新增/移动符号时同步维护）。
const popupSharedGlobals = {
  LOCAL_DEFAULTS: 'writable',
  WEIGHT_KEYS: 'writable',
  activePresetJobLabel: 'writable',
  applySnapshot: 'writable',
  arrivedScoreRows: 'writable',
  batchSelected: 'writable',
  bindResultFilters: 'writable',
  buildFeedbackButtons: 'writable',
  currentAssigneeConfirmedAt: 'writable',
  currentJobId: 'writable',
  currentJobLabel: 'writable',
  effectiveJobId: 'writable',
  feedbackRecord: 'writable',
  findResultView: 'writable',
  getMokaTab: 'writable',
  isMokaActionLocked: 'writable',
  isMokaTab: 'writable',
  lastAdoptNote: 'writable',
  lastKnownPageJobId: 'writable',
  loadFeedbackFromStorage: 'writable',
  markRescoreError: 'writable',
  pullResults: 'writable',
  refreshCalibrationButton: 'writable',
  refreshResultsAndJobContext: 'writable',
  reloadMokaTabSoon: 'writable',
  renderAssigneeStatus: 'writable',
  renderResults: 'writable',
  requestMokaDecision: 'writable',
  requestRescore: 'writable',
  requestWaiveMustHave: 'writable',
  resultState: 'writable',
  safeEl: 'writable',
  saveCandidateFeedback: 'writable',
  sendToMoka: 'writable',
  setPresetNote: 'writable',
  setResultHint: 'writable',
  setScreeningUi: 'writable',
  startingScreen: 'writable',
  syncActiveJobFromSnapshot: 'writable',
  updateBatchButton: 'writable',
  writeJobPresetRecord: 'writable'
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
    files: ['content.js', 'inject.js', 'popup/popup.js', 'popup/popup-results.js', 'popup/popup-batch.js', 'popup/health.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...entryPageEnv, ...popupSharedGlobals }
    },
    rules: {
      ...entryRules,
      // 跨模块符号既登记在 popupSharedGlobals 又在某一文件里真实声明，no-redeclare 会误报；
      // 误报只在「登记名单」与「真实声明」重叠处出现，关闭它不影响 no-undef 对名单外符号的锁死
      'no-redeclare': 'off'
    }
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
