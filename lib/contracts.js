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
    hasLastResults: 'hasLastResults',
    showLastResults: 'showLastResults',
    getResults: 'getResults',
    getRequestLog: 'getRequestLog',
    getBatchAssignContext: 'getBatchAssignContext',
    getAssigneeForJob: 'getAssigneeForJob',
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
    screeningCompleteToast: 'screeningCompleteToast'
  });

  const ACTION_SET = new Set(Object.values(ACTIONS));

  function isKnownAction(action) {
    return ACTION_SET.has(String(action || ''));
  }

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
    ok,
    fail,
    unknownActionResponse
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaContracts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
