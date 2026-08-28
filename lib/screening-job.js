/**
 * 进行中的筛选任务快照（content / background / popup / Node 测试共用）
 */
(function (root) {
  const SCREENING_JOB_KEY = 'mokaScreeningJob';
  const KEEP_ALIVE_ALARM = 'mokaScreeningKeepalive';
  const VALID_STATUS = new Set([
    'running',
    'awaiting_resume',
    'paused_mismatch',
    'done',
    'stopped'
  ]);

  function jobKey(jobId) {
    return String(jobId == null ? '' : jobId).trim();
  }

  function sanitizeScreeningJob(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const status = String(raw.status || '').trim();
    if (!VALID_STATUS.has(status)) return null;
    const jobId = jobKey(raw.jobId);
    if (!jobId || jobId === 'current') return null;
    return {
      status,
      pipelineId: String(raw.pipelineId || ''),
      jobId,
      jobName: String(raw.jobName || ''),
      listUrl: String(raw.listUrl || ''),
      maxCount: Number(raw.maxCount) > 0 ? Number(raw.maxCount) : 0,
      jobType: raw.jobType === 'intern' ? 'intern' : 'full-time',
      hardConditions: raw.hardConditions && typeof raw.hardConditions === 'object'
        ? raw.hardConditions
        : null,
      weights: raw.weights && typeof raw.weights === 'object' ? raw.weights : null,
      keywords: Array.isArray(raw.keywords)
        ? raw.keywords.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 6)
        : [],
      jobSpec: raw.jobSpec && typeof raw.jobSpec === 'object' ? raw.jobSpec : null,
      total: Number.isFinite(Number(raw.total)) ? Math.max(0, Number(raw.total)) : 0,
      completed: Number.isFinite(Number(raw.completed)) ? Math.max(0, Number(raw.completed)) : 0,
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now(),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
    };
  }

  function isResumableJob(job) {
    const j = sanitizeScreeningJob(job);
    if (!j) return false;
    if (j.status !== 'running' && j.status !== 'awaiting_resume' && j.status !== 'paused_mismatch') {
      return false;
    }
    return j.total > 0 && j.completed < j.total;
  }

  function matchesPageJob(job, pageJobId) {
    const j = sanitizeScreeningJob(job);
    const page = jobKey(pageJobId);
    if (!j || !page) return false;
    return j.jobId === page;
  }

  function withStatus(job, status, patch) {
    const base = sanitizeScreeningJob(job);
    if (!base) return null;
    return sanitizeScreeningJob(Object.assign({}, base, patch || {}, {
      status,
      updatedAt: Date.now()
    }));
  }

  const api = {
    SCREENING_JOB_KEY,
    KEEP_ALIVE_ALARM,
    VALID_STATUS,
    jobKey,
    sanitizeScreeningJob,
    isResumableJob,
    matchesPageJob,
    withStatus
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaScreeningJob = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
