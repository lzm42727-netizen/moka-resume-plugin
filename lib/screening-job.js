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

  // 本轮筛选的 LLM 用量（断点续筛跨刷新保留；格式与 lib/usage.js normalizeUsage 对齐）
  function sanitizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
    const price = (raw.price && typeof raw.price === 'object') ? raw.price : null;
    return {
      calls: num(raw.calls),
      inTok: num(raw.inTok),
      outTok: num(raw.outTok),
      cacheHits: num(raw.cacheHits),
      model: String(raw.model || '').trim(),
      price: price
        ? {
            inputPerM: Number(price.inputPerM) > 0 ? Number(price.inputPerM) : null,
            outputPerM: Number(price.outputPerM) > 0 ? Number(price.outputPerM) : null,
            priced: !!price.priced
          }
        : null
    };
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
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
      usage: sanitizeUsage(raw.usage)
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

  // 超过该时长没有任何筛选活动，视为任务已死（后台被回收、页面被冻结等）
  const SCREENING_STALE_MS = 90 * 1000;

  /**
   * 判断「筛选是否真的还活着」。
   * 标志位为真但长时间无心跳时返回 false，避免侧栏按钮被永久禁用而无法重新开筛。
   */
  function screeningLooksActive(isScreening, heartbeatAt, now, staleMs) {
    if (!isScreening) return false;
    const beat = Number(heartbeatAt);
    if (!Number.isFinite(beat) || beat <= 0) return true; // 刚启动、还没来得及打心跳
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const limit = Number(staleMs) > 0 ? Number(staleMs) : SCREENING_STALE_MS;
    return (at - beat) < limit;
  }

  function withStatus(job, status, patch) {
    const base = sanitizeScreeningJob(job);
    if (!base) return null;
    return sanitizeScreeningJob(Object.assign({}, base, patch || {}, {
      status,
      updatedAt: Date.now()
    }));
  }

  function formatScreeningProgress(opts) {
    const o = opts || {};
    const name = String(o.name || '').trim();
    const current = Number(o.current) || 0;
    const total = Number(o.total) || 0;
    const startedAt = Number(o.startedAt) || 0;
    const now = Number(o.now) || Date.now();
    const elapsedMin = startedAt ? Math.max(0, Math.round((now - startedAt) / 60000)) : 0;
    const time = elapsedMin <= 0 ? '刚开始' : ('已用约 ' + elapsedMin + ' 分钟');
    const count = current + '/' + total;
    if (name) return '正在评 ' + name + '（' + count + '）· ' + time;
    return '已评分 ' + count + ' · ' + time;
  }

  const api = {
    SCREENING_JOB_KEY,
    KEEP_ALIVE_ALARM,
    VALID_STATUS,
    SCREENING_STALE_MS,
    jobKey,
    sanitizeScreeningJob,
    isResumableJob,
    matchesPageJob,
    screeningLooksActive,
    withStatus,
    formatScreeningProgress
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaScreeningJob = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
