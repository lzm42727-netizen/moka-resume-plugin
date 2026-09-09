/**
 * 跨世界消息契约（popup / content / background / Node 测试共用）
 */
(function (root) {
  const ACTIONS = Object.freeze({
    ping: 'ping',
    getJobs: 'getJobs',
    getJobContext: 'getJobContext',
    getJobSpec: 'getJobSpec',
    startScreening: 'startScreening',
    resumeScreening: 'resumeScreening',
    discardScreeningJob: 'discardScreeningJob',
    getScreeningJob: 'getScreeningJob',
    stopScreening: 'stopScreening',
    screeningKeepalivePing: 'screeningKeepalivePing',
    // 以下 4 个为 content 侧兼容动作：popup 已不再发送，content 保留处理作数据源/旧版兼容
    hasLastResults: 'hasLastResults',
    showLastResults: 'showLastResults',
    getResults: 'getResults',
    getRequestLog: 'getRequestLog',
    getBatchAssignContext: 'getBatchAssignContext',
    getAssigneeForJob: 'getAssigneeForJob',
    getAssigneeDiagnostics: 'getAssigneeDiagnostics',
    scrapeAssigneeNames: 'scrapeAssigneeNames',
    adoptScrapedAssignees: 'adoptScrapedAssignees',
    batchAssign: 'batchAssign',
    openCandidate: 'openCandidate',
    exportCsv: 'exportCsv',
    rescore: 'rescore',
    waiveMustHave: 'waiveMustHave',
    mokaAction: 'mokaAction',
    resumeMokaAction: 'resumeMokaAction',
    analyzeJob: 'analyzeJob',
    scoreCandidate: 'scoreCandidate',
    modelPriceInfo: 'modelPriceInfo',
    fetchResume: 'fetchResume',
    testApi: 'testApi',
    updateProgress: 'updateProgress',
    resultsUpdated: 'resultsUpdated',
    mokaActionComplete: 'mokaActionComplete',
    mokaContentReady: 'mokaContentReady',
    pageJobChanged: 'pageJobChanged',
    setPendingMokaAction: 'setPendingMokaAction',
    getPendingMokaAction: 'getPendingMokaAction',
    clearPendingMokaAction: 'clearPendingMokaAction',
    notifyScreeningDone: 'notifyScreeningDone',
    screeningKeepaliveStart: 'screeningKeepaliveStart',
    screeningKeepaliveStop: 'screeningKeepaliveStop',
    screeningResumeAvailable: 'screeningResumeAvailable',
    screeningPausedMismatch: 'screeningPausedMismatch',
    screeningCompleteToast: 'screeningCompleteToast',
    pluginLog: 'pluginLog',
    pluginLogEntry: 'pluginLogEntry',
    getPluginLog: 'getPluginLog',
    clearPluginLog: 'clearPluginLog',
    flushPluginLog: 'flushPluginLog'
  });

  const ACTION_SET = new Set(Object.values(ACTIONS));

  function isKnownAction(action) {
    return ACTION_SET.has(String(action || ''));
  }

  /**
   * window.postMessage 桥接类型契约（content ↔ inject）。
   * inject.js 运行在 MAIN world、未加载本文件，仍使用字符串字面量；
   * 此处是权威登记表，供 content 侧与测试对称校验，防止两侧拼写漂移。
   */
  const BRIDGE_UP = Object.freeze({
    // inject(MAIN) → content(ISOLATED)：页面捕获结果上行
    searchRequest: 'search-request',
    detailRequest: 'detail-request',
    detailData: 'detail-data',
    sceneToken: 'scene-token',
    requestLog: 'request-log',
    assignmentRequest: 'assignment-request',
    memberData: 'member-data',
    assigneeNames: 'assignee-names',
    assigneePairs: 'assignee-pairs',
    assignmentResponse: 'assignment-response',
    bridgeReady: 'bridge-ready'
  });

  const BRIDGE_DOWN = Object.freeze({
    // content(ISOLATED) → inject(MAIN)：按需索要 / 指令下行
    getSearchRequest: 'get-search-request',
    getDetailRequest: 'get-detail-request',
    doAssignment: 'do-assignment',
    scrapeAssigneePairs: 'scrape-assignee-pairs',
    bridgeInit: 'bridge-init'
  });

  const BRIDGE_SOURCE_INJECT = 'moka-inject';
  const BRIDGE_SOURCE_CONTENT = 'moka-content';

  function ok(extra) {
    return Object.assign({ ok: true }, extra || {});
  }

  function fail(error, extra) {
    return Object.assign({ ok: false, error: String(error || '未知错误') }, extra || {});
  }

  function unknownActionResponse(action) {
    return fail('未知消息：' + String(action || ''));
  }

  const api = {
    ACTIONS,
    isKnownAction,
    BRIDGE_UP,
    BRIDGE_DOWN,
    BRIDGE_SOURCE_INJECT,
    BRIDGE_SOURCE_CONTENT,
    ok,
    fail,
    unknownActionResponse
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaContracts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
