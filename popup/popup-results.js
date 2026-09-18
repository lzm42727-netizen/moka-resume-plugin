/**
 * 结果页渲染与反馈状态（v3.4.0 自 popup.js 拆出）
 *
 * 职责：结果快照应用与整表渲染、经历证据拆列、候选人反馈记录/导出、
 * Moka 决策动作状态。与 popup.js 共享全局作用域（经典脚本按序加载），
 * 声明顺序：本文件先于 popup.js 加载，运行期才互调，无加载期依赖。
 */

/* 以下符号声明在本文件、主要消费在 popup.js / popup-batch.js（经典脚本共享作用域） */
/* exported loadFeedbackFromStorage isMokaActionLocked requestMokaDecision pullResults bindResultFilters */

const resultState = { items: [], status: '', banner: null, screening: false, usageText: '' };
// 已播过「评分落卡」动效的候选人 id：每轮筛选开始时清空，保证一张卡只播一次
const arrivedScoreRows = new Set();

// 结果卡折叠区（经历证据 / 评分明细）的展开状态。
// 结果列表是整表重建（renderResults 里 list.innerHTML = ''），DOM 上的 hidden/open 每次都会被冲掉，
// 所以状态必须外置保存、建卡时回填。只记本次会话，切职位时清空。
const resultExpandState = new Map();
let resultExpandJobId = '';

function resultSectionKey(appId, section) {
  return String(appId == null ? '' : appId) + '|' + section;
}

function isResultSectionOpen(appId, section) {
  return resultExpandState.get(resultSectionKey(appId, section)) === true;
}

function setResultSectionOpen(appId, section, open) {
  const key = resultSectionKey(appId, section);
  if (open) resultExpandState.set(key, true);
  else resultExpandState.delete(key);
}

/** 折叠状态只在同一职位内有效：换职位后旧 appId 的状态必须丢掉 */
function syncResultExpandScope(jobId) {
  const id = String(jobId || '');
  if (id === resultExpandJobId) return;
  resultExpandJobId = id;
  resultExpandState.clear();
}

function setResultUsageLine(text) {
  const el = document.getElementById('usage-line');
  if (!el) return;
  const clean = String(text || '').trim();
  if (!clean) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.classList.remove('hidden');
  el.textContent = clean;
  el.title = '本轮筛选总耗时与预估模型费用（估算值）；命中评分缓存不计费';
}

function renderUsageLine() {
  setResultUsageLine(resultState.usageText);
}
const resultFilter = { tab: 'all', query: '' };
let feedbackRecord = {};
let saveFeedbackTimer = null;
let mokaActionInFlight = null;
let scrollListToTopPending = false;

// 声明在本文件、消费在其它 popup 模块（经典脚本共享作用域）
// eslint-disable-next-line no-unused-vars
function loadFeedbackFromStorage() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(MokaFeedback.FEEDBACK_STORAGE_KEY, (res) => {
        feedbackRecord = (res && res[MokaFeedback.FEEDBACK_STORAGE_KEY]) || {};
        resolve();
      });
    } catch (e) {
      feedbackRecord = {};
      resolve();
    }
  });
}

function scheduleSaveFeedback() {
  if (saveFeedbackTimer) return;
  saveFeedbackTimer = setTimeout(() => {
    saveFeedbackTimer = null;
    try {
      chrome.storage.local.set({ [MokaFeedback.FEEDBACK_STORAGE_KEY]: feedbackRecord });
    } catch (e) { /* ignore */ }
  }, 300);
}

function mergeFeedbackIntoViews(items) {
  const jobId = effectiveJobId();
  return (items || []).map((v) => {
    const base = Object.assign({}, v);
    delete base.feedback;
    delete base.feedbackSync;
    const entry = jobId ? MokaFeedback.getFeedbackEntry(feedbackRecord, jobId, String(v.id)) : null;
    base.feedback = entry ? entry.verdict : null;
    base.feedbackSync = MokaFeedback.feedbackSyncState(entry);
    if (jobId && entry) maybeBackfillFeedbackIdentity(jobId, String(v.id), base);
    return base;
  });
}

/** 旧决策缺姓名时，用当前结果行回填，便于「已决策」与 CSV 显示 */
function maybeBackfillFeedbackIdentity(jobId, appId, view) {
  const jk = MokaFeedback.jobKey(jobId);
  const ak = MokaFeedback.appKey(appId);
  if (!jk || !ak || !feedbackRecord[jk] || !feedbackRecord[jk][ak] || !view) return;
  const raw = feedbackRecord[jk][ak];
  if (!raw.snapshot || typeof raw.snapshot !== 'object') raw.snapshot = {};
  const snap = raw.snapshot;
  let dirty = false;
  if (!snap.name && view.name && !/^候选人\s/.test(view.name)) {
    snap.name = String(view.name).slice(0, 64);
    dirty = true;
  }
  if (!snap.meta && view.meta) {
    snap.meta = String(view.meta).slice(0, 160);
    dirty = true;
  }
  const metaParts = String(view.meta || '').split(/\s*·\s*/).map((x) => x.trim()).filter(Boolean);
  if (!snap.highestDegree && (view.highestDegree || metaParts[0])) {
    snap.highestDegree = String(view.highestDegree || metaParts[0]).slice(0, 32);
    dirty = true;
  }
  if (!snap.highestDegreeSchool && (view.highestDegreeSchool || metaParts[1])) {
    snap.highestDegreeSchool = String(view.highestDegreeSchool || metaParts[1]).slice(0, 80);
    dirty = true;
  }
  if (dirty) scheduleSaveFeedback();
}

function buildFeedbackSnapshot(view) {
  const s = (view && view.score) || {};
  const dims = {};
  const dimKeys = ['experience', 'skill', 'education', 'potential'];
  if (s.dims && typeof s.dims === 'object') {
    dimKeys.forEach((k) => {
      const d = s.dims[k];
      if (d && typeof d.score === 'number') dims[k] = d.score;
    });
  }
  const metaParts = String((view && view.meta) || '').split(/\s*·\s*/).map((x) => x.trim()).filter(Boolean);
  return {
    score: s.score,
    baseScore: s.baseScore,
    matchScore: s.matchScore,
    penalty: s.penalty,
    level: s.level,
    advanceReason: s.advanceReason,
    bonusKeywordResults: s.bonusKeywordResults || [],
    bonusApplied: s.bonusApplied || 0,
    bonusMetCount: s.bonusMetCount || 0,
    bonusTotalCount: s.bonusTotalCount || 0,
    bonusPromoted: !!s.bonusPromoted,
    dims,
    name: (view && view.name) || '',
    meta: (view && view.meta) || '',
    highestDegree: (view && view.highestDegree) || metaParts[0] || '',
    highestDegreeSchool: (view && view.highestDegreeSchool) || metaParts[1] || '',
    hardMissing: (view && view.hardMissing) || [],
    waivedMustHaves: (s.waivedUnmet || []).map((r) => r && r.item).filter(Boolean),
    highlights: s.highlights || [],
    concerns: s.concerns || [],
    pluginRecommend: typeof s.level === 'string' && MokaScore.isRecommendLevel(s.level)
  };
}

function feedbackMapForExport() {
  const jobId = currentJobId() || effectiveJobId();
  if (!jobId) return {};
  const bag = MokaFeedback.getFeedbackForJob(feedbackRecord, jobId);
  const out = {};
  Object.entries(bag).forEach(([appId, entry]) => {
    out[appId] = entry.verdict;
  });
  return out;
}

function updateExportButton() {
  const btn = document.getElementById('export-results');
  if (!btn) return;
  const jobId = effectiveJobId();
  const fb = jobId ? MokaFeedback.summarizeFeedback(feedbackRecord, jobId) : { total: 0 };
  btn.disabled = fb.total === 0;
  btn.title = fb.total
    ? `导出本岗全部 ${fb.total} 条已决策简历`
    : '暂无已决策可导出（推荐/淘汰后会出现在这里）';
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob(['\uFEFF' + text], { type: mime || 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportDecidedCsv() {
  const jobId = effectiveJobId();
  if (!jobId) {
    setResultHint('请先选择职位后再导出', { tone: 'warn' });
    return;
  }
  const views = MokaFeedback.listDecidedResultViews(resultState.items, feedbackRecord, jobId);
  if (!views.length) {
    setResultHint('暂无已决策记录可导出', { tone: 'warn' });
    return;
  }
  const tab = await getMokaTab();
  let origin = 'https://app.mokahr.com';
  try {
    if (tab && tab.url) origin = new URL(tab.url).origin;
  } catch (e) { /* keep default */ }
  const items = views.map((v) => MokaFeedback.resultViewToCsvItem(v)).filter(Boolean);
  const csv = MokaPersist.screeningToCsv(items, origin, feedbackMapForExport());
  // 文件名带职位名：多个职位分别导出时不会同名覆盖/难找（去掉文件名非法字符）
  const safeLabel = String(currentJobLabel() || '职位').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40) || '职位';
  downloadTextFile(`moka-已决策-${safeLabel}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  setResultHint(`已导出 ${items.length} 条本岗已决策简历`, { tone: 'ok' });
}

function visibleResultViews() {
  if (resultFilter.tab === 'feedback') {
    const jobId = effectiveJobId();
    const decided = jobId
      ? MokaFeedback.listDecidedResultViews(resultState.items, feedbackRecord, jobId)
      : resultState.items.filter((v) => MokaMatch.hasAnyDecisionFeedback(v));
    return decided.filter((v) => MokaMatch.viewMatchesFilter(v, resultFilter));
  }
  return resultState.items.filter((v) => MokaMatch.viewMatchesFilter(v, resultFilter));
}

function saveCandidateFeedback(appId, verdict, view, opts) {
  const jobId = effectiveJobId();
  if (!jobId) return false;
  const snapshot = verdict ? buildFeedbackSnapshot(view) : null;
  const fbOpts = opts && typeof opts === 'object' ? opts : {};
  feedbackRecord = MokaFeedback.putFeedback(
    feedbackRecord, jobId, appId, verdict, snapshot, undefined, fbOpts
  );
  scheduleSaveFeedback();
  resultState.items = mergeFeedbackIntoViews(resultState.items);
  return true;
}

function markFeedbackSyncState(appId, state) {
  const jobId = effectiveJobId();
  if (!jobId) return;
  const entry = MokaFeedback.getFeedbackEntry(feedbackRecord, jobId, String(appId));
  if (!entry) return;
  const opts = { mokaSynced: state === 'synced', syncFailed: state === 'failed' };
  feedbackRecord = MokaFeedback.putFeedback(
    feedbackRecord,
    jobId,
    appId,
    entry.verdict,
    entry.snapshot,
    undefined,
    opts
  );
  scheduleSaveFeedback();
  resultState.items = mergeFeedbackIntoViews(resultState.items);
}

const FILTER_TAB_LABELS = {
  all: '待处理',
  recommend: '推荐',
  error: '评分失败',
  feedback: '已决策'
};

function countViewsForFilter(tab) {
  if (tab === 'feedback') {
    const jobId = effectiveJobId();
    if (!jobId) return 0;
    return MokaFeedback.listDecidedResultViews(resultState.items, feedbackRecord, jobId).length;
  }
  return resultState.items.filter((v) => MokaMatch.viewMatchesFilter(v, { tab, query: '' })).length;
}

function updateFilterTabLabels() {
  document.querySelectorAll('#results-tab .mp-filter').forEach((btn) => {
    const tab = btn.dataset.filter || 'all';
    const label = FILTER_TAB_LABELS[tab] || btn.textContent.replace(/\s*\(\d+\)\s*$/, '');
    const n = countViewsForFilter(tab);
    btn.textContent = `${label} (${n})`;
  });
}

function findResultView(appId) {
  const id = String(appId);
  return resultState.items.find((v) => String(v.id) === id) || null;
}

function setViewMokaActionBusy(appId, busy, verdict) {
  const id = String(appId);
  resultState.items = resultState.items.map((v) => {
    if (String(v.id) !== id) return v;
    const next = Object.assign({}, v);
    if (busy) next._mokaActionBusy = verdict;
    else delete next._mokaActionBusy;
    return next;
  });
  renderResults();
}

function waitForMokaActionComplete(appId, type, timeoutMs) {
  let cleanup = null;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (cleanup) cleanup();
      reject(new Error('Moka 操作超时，请稍候或刷新侧栏'));
    }, timeoutMs || 90000);
    function listener(request) {
      if (request.action !== 'mokaActionComplete') return;
      if (String(request.appId) !== String(appId)) return;
      if (request.type !== type) return;
      if (cleanup) cleanup();
      if (request.ok) resolve(request);
      else reject(new Error(request.error || 'Moka 操作失败'));
    }
    cleanup = () => {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      cleanup = null;
    };
    chrome.runtime.onMessage.addListener(listener);
  });
  promise.cancel = () => {
    if (cleanup) cleanup();
  };
  return promise;
}

// 声明在本文件、消费在其它 popup 模块（经典脚本共享作用域）
// eslint-disable-next-line no-unused-vars
function isMokaActionLocked() {
  return !!mokaActionInFlight;
}

// 声明在本文件、消费在其它 popup 模块（经典脚本共享作用域）
// eslint-disable-next-line no-unused-vars
async function requestMokaDecision(appId, verdict, view) {
  const jobId = effectiveJobId();
  if (!jobId) {
    setPresetNote('请先选择职位后再操作', '#fa8c16');
    return;
  }
  if (mokaActionInFlight) {
    markRescoreError('上一位候选人操作尚未完成，请稍候');
    return;
  }
  const v = view || findResultView(appId);
  if (!v) return;

  const entry = MokaFeedback.getFeedbackEntry(feedbackRecord, jobId, appId);
  if (MokaFeedback.mokaActionIntent(entry, verdict) === 'cancel') {
    saveCandidateFeedback(appId, null, v);
    renderResults();
    return;
  }

  saveCandidateFeedback(appId, verdict, v, { mokaSynced: false, syncFailed: false });
  renderResults();
  setResultHint(
    (verdict === 'recommend' ? '正在推荐…' : '正在淘汰…')
      + ' · 请勿关闭或切换 Moka 标签，稍候即可继续下一位',
    { tone: 'info' }
  );

  mokaActionInFlight = { appId: String(appId), verdict };
  setViewMokaActionBusy(appId, true, verdict);
  const completePromise = waitForMokaActionComplete(appId, verdict);
  try {
    const resp = await sendToMoka({
      action: 'mokaAction',
      appId,
      type: verdict,
    });
    const dispatchError = MokaActions.mokaActionDispatchError(resp);
    if (dispatchError) {
      completePromise.cancel();
      markFeedbackSyncState(appId, 'failed');
      markRescoreError(dispatchError);
      renderResults();
      return;
    }
    await completePromise;
    await refreshResultsAndJobContext();
    const latest = findResultView(appId) || v;
    saveCandidateFeedback(appId, verdict, latest, { mokaSynced: true, syncFailed: false });
    // 直连重放没动页面：与批量推进同款延迟刷新，让候选人从「初筛」列表移出（1.10.6）
    if (resp.replayed) reloadMokaTabSoon();
  } catch (e) {
    markFeedbackSyncState(appId, 'failed');
    markRescoreError(e.message || 'Moka 操作失败');
  } finally {
    mokaActionInFlight = null;
    setViewMokaActionBusy(appId, false);
    renderResults();
  }
}

// 声明在本文件、消费在其它 popup 模块（经典脚本共享作用域）
// eslint-disable-next-line no-unused-vars
function pullResults() {
  return sendToMoka({ action: 'getResults' }).then((snap) => {
    if (snap && Array.isArray(snap.items)) applySnapshot(snap);
    return snap;
  });
}

function applySnapshot(snap, opts) {
  if (!snap) return;
  const incoming = Array.isArray(snap.items) ? snap.items : [];
  const hadItems = resultState.items.length > 0;
  const inMokaAction = /正在 Moka 中/.test(String(snap.status || ''));
  if (hadItems && incoming.length === 0 && inMokaAction) {
    resultState.status = snap.status || resultState.status;
    if (snap.banner !== undefined) resultState.banner = snap.banner;
    if (!startingScreen) {
      resultState.screening = !!snap.screening;
      setScreeningUi(resultState.screening);
    }
    renderResults();
    return;
  }
  const pageJobId = snap.pageJobId || lastKnownPageJobId || '';
  if (pageJobId) lastKnownPageJobId = String(pageJobId);
  const skipJobSync = opts && opts.skipJobSync;
  if (!skipJobSync && snap.jobId && !pageJobId) {
    syncActiveJobFromSnapshot(snap.jobId, snap.jobName);
  }
  resultState.items = mergeFeedbackIntoViews(incoming);
  resultState.status = snap.status || (incoming.length ? resultState.status : '');
  if (snap.resultMismatch && pageJobId) {
    resultState.banner = {
      type: 'job-mismatch',
      pageJobId,
      resultJobId: snap.resultJobId || snap.jobId || ''
    };
  } else if (snap.banner !== undefined) {
    resultState.banner = snap.banner;
  } else if (!incoming.length && pageJobId) {
    resultState.banner = null;
  }
  // 开筛瞬间 content 可能仍回报 screening=false，勿把按钮打回可点
  if (startingScreen && !snap.screening) {
    renderResults();
    return;
  }
  resultState.screening = !!snap.screening;
  if (typeof snap.usageText === 'string') resultState.usageText = snap.usageText;
  setScreeningUi(resultState.screening);
  updateExportButton();
  if (resultState.screening) {
    document.getElementById('progress-container').classList.remove('hidden');
  }
  renderResults();
}

// 声明在本文件、消费在其它 popup 模块（经典脚本共享作用域）
// eslint-disable-next-line no-unused-vars
function bindResultFilters() {
  if (resultFilter.tab === 'hardfail') resultFilter.tab = 'all';
  document.querySelectorAll('#results-tab .mp-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      resultFilter.tab = btn.dataset.filter || 'all';
      document.querySelectorAll('#results-tab .mp-filter').forEach((b) => {
        b.classList.toggle('on', b === btn);
      });
      renderResults();
    });
  });
  const search = safeEl('result-search');
  search?.addEventListener('input', () => {
    resultFilter.query = search.value || '';
    renderResults();
  });
  safeEl('export-results')?.addEventListener('click', () => {
    exportDecidedCsv();
  });
}

function renderResults() {
  const banner = document.getElementById('result-banner');
  const list = document.getElementById('result-list');
  const b = resultState.banner;
  banner.classList.toggle('show', !!(b && b.type));
  banner.textContent = '';
  if (b && b.type === 'need-click') {
    const title = document.createElement('div');
    title.className = 'mp-banner-title';
    title.textContent = '自动识别未成功，请点开一位候选人';
    banner.appendChild(title);
    banner.appendChild(document.createTextNode('为补全实习/项目经历，请在左边 Moka 列表里点击任意一位候选人的姓名打开详情一次。'));
  } else if (b && b.type === 'ready') {
    const ok = document.createElement('div');
    ok.className = 'mp-banner-ok';
    ok.textContent = '已捕获详情接口，正在自动补全完整经历…';
    banner.appendChild(ok);
  } else if (b && b.type === 'job-mismatch') {
    const warn = document.createElement('div');
    warn.className = 'mp-banner-title';
    warn.style.color = '#fa8c16';
    warn.textContent = '当前 Moka 职位与结果列表不一致';
    banner.appendChild(warn);
    banner.appendChild(document.createTextNode('请在本岗位重新筛选，或切回对应职位查看上次结果。'));
  }

  const sum = MokaMatch.summarizeResultViews(resultState.items);
  const jobId = effectiveJobId();
  syncResultExpandScope(jobId);
  const fb = jobId ? MokaFeedback.summarizeFeedback(feedbackRecord, jobId) : { total: 0, recommend: 0, eliminate: 0 };
  const fbText = fb.total ? ` · 已决策 ${fb.total}（已推荐 ${fb.recommend} · 已淘汰 ${fb.eliminate}）` : '';
  if (sum.total) {
    setResultSummary(`评分 ${sum.scored}/${sum.total} · 推荐 ${sum.recommend}${fbText}`);
  } else if (fb.total) {
    setResultSummary(`已决策 ${fb.total}（已推荐 ${fb.recommend} · 已淘汰 ${fb.eliminate}）`);
  } else {
    setResultSummary(resultState.screening ? '准备筛选…' : '尚未开始筛选');
  }
  renderUsageLine();

  const raw = resultState.status || '';
  if (!sum.total && !raw && !fb.total) {
    setResultHint('配好条件后点下方「开始筛选」，进度和名单会出现在这里。');
  } else {
    const parts = splitStatusText(raw);
    const activity = parts.activity
      || (resultState.screening ? '筛选进行中…' : '')
      || (sum.total ? '' : (fb.total ? '可在「已决策」查看本岗历史处理记录' : '配好条件后点下方「开始筛选」，进度和名单会出现在这里。'));
    setResultHint(activity, {
      tip: parts.showTip || !!resultState.screening,
      tone: resultState.screening ? 'info' : undefined
    });
  }

  updateExportButton();
  updateBatchButton();
  updateFilterTabLabels();
  refreshCalibrationButton();

  list.innerHTML = '';
  const visible = visibleResultViews();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'mp-empty';
    if (resultFilter.tab === 'feedback') {
      empty.textContent = fb.total
        ? '没有符合当前搜索的已决策候选人'
        : '本岗暂无已决策记录（推荐/淘汰后会累计保存在这里）';
    } else if (sum.total) {
      empty.textContent = resultFilter.tab === 'all'
        ? '待处理候选人已全部决策，可在「已决策」查看或导出'
        : '没有符合当前过滤的候选人';
    } else {
      empty.textContent = '结果会出现在这里，左边 Moka 名单保持完整可见';
    }
    list.appendChild(empty);
    return;
  }
  visible.forEach((view) => list.appendChild(createResultRow(view)));
  if (scrollListToTopPending) {
    scrollListToTopPending = false;
    const first = list.querySelector('.mp-row');
    if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function buildEvidenceSplit(appId, cols, fitDetail) {
  const split = document.createElement('div');
  const evidenceList = Array.isArray(cols.evidence) ? cols.evidence : [];
  const hasRight = cols.right.length > 0;
  const hasEvidence = evidenceList.length > 0;
  const detail = fitDetail || {};
  const breakdown = detail.breakdown || null;
  // 「亮点」列（原「具备」）没有亮点但存在差距/经历证据时，用空态占位让对比语义完整
  const leftVisible = cols.left.length > 0 || (hasRight || hasEvidence);
  split.className = 'mp-split' + (!(leftVisible && hasRight) ? ' mp-split-single' : '');

  if (cols.left.length) {
    const col = document.createElement('div');
    col.className = 'mp-col hit';
    const title = document.createElement('div');
    title.className = 'mp-col-title';
    title.textContent = '亮点';
    col.appendChild(title);
    cols.left.forEach((text) => {
      const line = document.createElement('div');
      line.className = 'mp-hit';
      const mark = document.createElement('span');
      mark.className = 'mp-mark ok';
      mark.textContent = '✓';
      line.appendChild(mark);
      line.appendChild(document.createTextNode(text));
      col.appendChild(line);
    });
    split.appendChild(col);
  } else if (leftVisible) {
    const col = document.createElement('div');
    col.className = 'mp-col hit empty';
    const title = document.createElement('div');
    title.className = 'mp-col-title';
    title.textContent = '亮点';
    col.appendChild(title);
    const line = document.createElement('div');
    line.className = 'mp-hit-empty';
    line.textContent = 'AI 未找到与岗位直接相关的亮点';
    line.title = 'AI 未提炼出与岗位职责/重点看直接对应的亮点；如需可重评后再看';
    col.appendChild(line);
    split.appendChild(col);
  }

  if (hasRight) {
    const col = document.createElement('div');
    col.className = 'mp-col miss';
    const title = document.createElement('div');
    title.className = 'mp-col-title';
    title.textContent = '差距';
    col.appendChild(title);
    cols.right.forEach((r) => {
      const line = document.createElement('div');
      line.className = 'mp-miss' + (r.kind === 'waived' ? ' waived' : '');
      const body = document.createElement('div');
      body.className = 'mp-miss-text';
      const mark = document.createElement('span');
      if (r.kind === 'unmet') {
        // 门槛条目用「门槛」徽章区分于普通差距项，正文只留「条目：原因」
        mark.className = 'mp-mark gate';
        mark.textContent = '门槛';
      } else {
        mark.className = 'mp-mark no';
        mark.textContent = r.kind === 'waived' ? '○' : '✕';
      }
      body.appendChild(mark);
      body.appendChild(document.createTextNode(r.text));
      line.appendChild(body);
      if (r.action === 'ignore' || r.action === 'restore') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mp-miss-btn' + (r.action === 'restore' ? ' restore' : '');
        btn.textContent = r.action === 'restore' ? '恢复' : '忽略';
        btn.title = r.action === 'restore'
          ? '重新作为硬性门槛并扣回 5 分'
          : '忽略此项，加回 5 分并按新分排序';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          requestWaiveMustHave(appId, r.item, r.action === 'ignore');
        });
        line.appendChild(btn);
      }
      col.appendChild(line);
    });
    split.appendChild(col);
  }

  if (hasEvidence) {
    const box = document.createElement('div');
    box.className = 'mp-evidence';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mp-evidence-toggle';
    const arrow = document.createElement('span');
    arrow.className = 'mp-evidence-arrow';
    arrow.textContent = '▸';
    toggle.appendChild(document.createTextNode('经历证据（' + evidenceList.length + '）'));
    toggle.appendChild(arrow);
    const body = document.createElement('div');
    const evidenceOpen = isResultSectionOpen(appId, 'evidence');
    body.className = 'mp-evidence-body' + (evidenceOpen ? '' : ' hidden');
    evidenceList.forEach((text) => {
      const line = document.createElement('div');
      line.className = 'mp-hit mp-evidence-item';
      const mark = document.createElement('span');
      mark.className = 'mp-mark ev';
      mark.textContent = '•';
      line.appendChild(mark);
      line.appendChild(document.createTextNode(text));
      body.appendChild(line);
    });
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation(); // 不能冒泡到结果行，否则会打开候选人详情页
      const nowHidden = body.classList.toggle('hidden');
      box.classList.toggle('open', !nowHidden);
      arrow.textContent = nowHidden ? '▸' : '▾';
      setResultSectionOpen(appId, 'evidence', !nowHidden);
    });
    box.classList.toggle('open', evidenceOpen);
    arrow.textContent = evidenceOpen ? '▾' : '▸';
    box.appendChild(toggle);
    box.appendChild(body);
    split.appendChild(box);
  }

  // 评分明细：四项分（含理由）与判断把握收进折叠区，卡面只留结论与完整度
  if (breakdown) {
    const detailBox = document.createElement('div');
    detailBox.className = 'mp-evidence';
    const detailToggle = document.createElement('button');
    detailToggle.type = 'button';
    detailToggle.className = 'mp-evidence-toggle';
    const detailArrow = document.createElement('span');
    detailArrow.className = 'mp-evidence-arrow';
    detailArrow.textContent = '▸';
    detailToggle.appendChild(document.createTextNode('评分明细'));
    detailToggle.appendChild(detailArrow);
    const detailBody = document.createElement('div');
    const detailOpen = isResultSectionOpen(appId, 'detail');
    detailBody.className = 'mp-evidence-body' + (detailOpen ? '' : ' hidden');
    const appendDetailLine = (text, strong) => {
      const line = document.createElement('div');
      line.className = 'mp-detail-line' + (strong ? ' strong' : '');
      line.textContent = text;
      detailBody.appendChild(line);
    };
    // 计算链：把卡面唯一保留的决策分是怎么来的讲清楚，避免分数散落各处
    const weightParts = ['coreDuty', 'business', 'skill', 'scope']
      .filter((k) => breakdown[k] && breakdown[k].score != null)
      .map((k) => breakdown[k].score + '×' + (FIT_WEIGHT_PCT[k] || 0) + '%');
    if (weightParts.length === 4 && detail.matchScore != null) {
      appendDetailLine('匹配分 ' + detail.matchScore + ' ＝ ' + weightParts.join(' + '), true);
    }
    const unmetCount = Number(detail.unmetCount) || 0;
    if (unmetCount > 0) {
      appendDetailLine(unmetCount <= 7
        ? '决策分 ' + detail.score + ' ＝ 49 − 7 × ' + unmetCount + ' 条未过门槛'
        : '决策分 ' + detail.score + ' ＝ 未过门槛 ' + unmetCount + ' 条，封顶为 0', true);
    } else if (Number(detail.bonusApplied) > 0) {
      appendDetailLine(
        '决策分 ' + detail.score + ' ＝ 匹配分 ' + detail.matchScore + ' + 加分 ' + detail.bonusApplied,
        true
      );
    }
    ['coreDuty', 'business', 'skill', 'scope'].forEach((k) => {
      const d = breakdown[k];
      if (!d || d.score == null) return;
      const line = document.createElement('div');
      line.className = 'mp-hit mp-evidence-item';
      const mark = document.createElement('span');
      mark.className = 'mp-mark ev';
      mark.textContent = '•';
      line.appendChild(mark);
      line.appendChild(document.createTextNode(
        (FIT_LABEL[k] || k) + ' ' + d.score + (d.reason ? '：' + d.reason : '')
      ));
      detailBody.appendChild(line);
    });
    if (detail.confidence) {
      const line = document.createElement('div');
      line.className = 'mp-hit mp-evidence-item';
      const mark = document.createElement('span');
      mark.className = 'mp-mark ev';
      mark.textContent = '•';
      line.appendChild(mark);
      line.appendChild(document.createTextNode(
        '判断把握：' + (CONFIDENCE_LABEL[detail.confidence] || '中')
          + '（简历信息越完整越可靠，把握低时建议点开简历人工确认）'
      ));
      detailBody.appendChild(line);
    }
    detailToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const nowHidden = detailBody.classList.toggle('hidden');
      detailBox.classList.toggle('open', !nowHidden);
      detailArrow.textContent = nowHidden ? '▸' : '▾';
      setResultSectionOpen(appId, 'detail', !nowHidden);
    });
    detailBox.classList.toggle('open', detailOpen);
    detailArrow.textContent = detailOpen ? '▾' : '▸';
    detailBox.appendChild(detailToggle);
    detailBox.appendChild(detailBody);
    split.appendChild(detailBox);
  }

  return split;
}

function createResultRow(view) {
  const row = document.createElement('div');
  row.className = 'mp-row'
    + (view.hardPassed === false ? ' failed' : '')
    + (view.stage || view.rescoring ? ' scoring' : '');
  // 评分落卡动效：仅筛选进行中、该候选人首次出分时播一次；筛选/搜索重绘不重播
  if (view.score && resultState.screening && !arrivedScoreRows.has(view.id)) {
    arrivedScoreRows.add(view.id);
    row.classList.add('mp-arrive');
  }

  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'mp-row-check';
  chk.checked = batchSelected.has(String(view.id));
  chk.title = '勾选后可通过「批量推进」批量分配';
  chk.addEventListener('click', (e) => e.stopPropagation());
  chk.addEventListener('change', () => {
    if (chk.checked) batchSelected.add(String(view.id));
    else batchSelected.delete(String(view.id));
    updateBatchButton();
  });
  row.appendChild(chk);

  const scoreEl = document.createElement('div');
  if (view.score) {
    scoreEl.className = 'mp-score';
    scoreEl.style.background = MokaMatch.scoreColor(view.score.score);
    scoreEl.textContent = String(view.score.score);
  } else {
    scoreEl.className = 'mp-score pending';
    scoreEl.textContent = '…';
  }

  const info = document.createElement('div');
  info.className = 'mp-info';

  const nameRow = document.createElement('div');
  nameRow.className = 'mp-name-row';

  const name = document.createElement('div');
  name.className = 'mp-name';
  name.textContent = view.name;
  nameRow.appendChild(name);
  if (view.fromHistory) {
    const hist = document.createElement('span');
    hist.className = 'mp-history-tag';
    hist.textContent = '历史';
    hist.title = '来自本岗历史决策，不在当前筛选批次';
    nameRow.appendChild(hist);
  }
  nameRow.appendChild(buildFeedbackButtons(view));
  info.appendChild(nameRow);

  if (view.feedbackSync === 'pending') {
    const sync = document.createElement('div');
    sync.className = 'mp-sync-note pending';
    sync.textContent = 'Moka 同步中…';
    info.appendChild(sync);
  } else if (view.feedbackSync === 'failed') {
    const sync = document.createElement('div');
    sync.className = 'mp-sync-note failed';
    sync.textContent = 'Moka 未同步成功，请手动操作或重试';
    info.appendChild(sync);
  }

  const meta = document.createElement('div');
  meta.className = 'mp-meta';
  meta.textContent = view.meta || '';
  info.appendChild(meta);

  if (view.graduationRisk && view.graduationRisk.text) {
    const risk = document.createElement('div');
    risk.className = 'mp-grad-risk';
    risk.textContent = view.graduationRisk.text;
    risk.title = '实习岗档期风险，不影响分数';
    info.appendChild(risk);
  }

  if ((view.stage && ROW_STAGE[view.stage]) || view.rescoring) {
    const stage = document.createElement('div');
    stage.className = 'mp-stage';
    stage.textContent = (view.stage && ROW_STAGE[view.stage]) || '② AI 评分中…';
    info.appendChild(stage);
    const bar = document.createElement('div');
    bar.className = 'mp-bar';
    const fill = document.createElement('i');
    fill.className = 'mp-bar-fill';
    fill.style.width = view.stage === 'score' ? '80%' : '45%';
    bar.appendChild(fill);
    row.appendChild(bar);
  }

  if (!view.score && view.hardMissing && view.hardMissing.length) {
    const tags = document.createElement('div');
    tags.className = 'mp-tags';
    view.hardMissing.forEach((miss) => {
      if (MokaMatch.itemFromCustomHardLabel(miss)) return;
      const tag = document.createElement('span');
      tag.className = 'mp-tag-fail';
      tag.textContent = miss;
      tags.appendChild(tag);
    });
    if (tags.childNodes.length) info.appendChild(tags);
  }

  // 加分：名字下方强提醒（已具备 / 未体现）
  const niceTags = view.score && MokaMatch.niceBonusTagsFromScore
    ? MokaMatch.niceBonusTagsFromScore(view.score)
    : { met: [], unmet: [] };
  if (niceTags.met.length || niceTags.unmet.length) {
    const wrap = document.createElement('div');
    wrap.className = 'mp-tags';
    niceTags.met.forEach((k) => {
      const tag = document.createElement('span');
      tag.className = 'mp-tag-nice-hit';
      tag.textContent = '加分已具备 ' + k;
      wrap.appendChild(tag);
    });
    niceTags.unmet.forEach((k) => {
      const tag = document.createElement('span');
      tag.className = 'mp-tag-nice-miss';
      tag.textContent = '加分未体现 ' + k;
      wrap.appendChild(tag);
    });
    info.appendChild(wrap);
  }

  const s = view.score;
  if (s) {
    const level = document.createElement('div');
    level.className = 'mp-level';
    level.style.color = MokaMatch.scoreColor(s.score);
    level.appendChild(document.createTextNode(s.level || ''));
    if (s.bonusPromoted) {
      const promoted = document.createElement('span');
      promoted.className = 'mp-bonus-promoted';
      promoted.textContent = '加分晋级';
      promoted.title = '经历匹配原本为可推进，加分后进入优先推进';
      level.appendChild(promoted);
    }
    const bonusScoreText = MokaMatch.bonusScoreDisplay
      ? MokaMatch.bonusScoreDisplay(s)
      : '';
    const scoreDetailText = bonusScoreText || MokaScore.matchScoreDisplayText(s);
    if (scoreDetailText) {
      const cut = document.createElement('span');
      cut.className = 'mp-penalty';
      cut.textContent = scoreDetailText;
      level.appendChild(cut);
    }
    // 档位原因并入同一行；门槛明细只在「差距」列出现一次，不再另起标签行
    if (s.level !== '错误' && (s.advanceReason === 'gate' || s.advanceReason === 'match')) {
      const note = document.createElement('span');
      note.className = 'mp-level-note';
      note.textContent = s.advanceReason === 'gate'
        ? '· 未过门槛 ' + ((Array.isArray(s.unmet) && s.unmet.length) || 0) + ' 项（见差距）'
        : '· 经历/技能匹配不足';
      level.appendChild(note);
    }
    if (s.level === '错误') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'mp-retry';
      retry.textContent = view.rescoring ? '重评中…' : '重评';
      retry.disabled = !!view.rescoring;
      retry.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (view.rescoring) return;
        requestRescore(view.id);
      });
      level.appendChild(retry);
    }
    info.appendChild(level);

    const failMsg = MokaScore.scoreFailureMessage(s);
    if (failMsg) {
      const err = document.createElement('div');
      err.className = 'mp-error-reason';
      err.textContent = failMsg;
      err.title = failMsg;
      info.appendChild(err);
    }

    // 信息不足（unknown）：简历没提及、无法判定，不扣分但要让招聘方知道「这几项要人工核对」
    if (s.level !== '错误' && Array.isArray(s.unknown) && s.unknown.length) {
      const unknownList = document.createElement('div');
      unknownList.className = 'mp-gate-list mp-tags';
      s.unknown.forEach((gate) => {
        const item = String((gate && gate.item) || '').trim();
        if (!item) return;
        const tag = document.createElement('span');
        tag.className = 'mp-tag-warn';
        tag.textContent = '待确认 · ' + item;
        tag.title = (gate.reason || '简历未提及') + '；信息不足，未扣分，建议点开简历人工确认';
        unknownList.appendChild(tag);
      });
      if (unknownList.childNodes.length) info.appendChild(unknownList);
    }

    // 卡面只留信息充分度指标；四项分与理由收进「评分明细」折叠区（见 buildEvidenceSplit）
    const fitBreakdown = s.scoreBreakdown || null;
    const hasCoverage = s.evidenceCoverage != null || (fitBreakdown && s.confidence);
    if (hasCoverage || s.dims) {
      const dimsEl = document.createElement('div');
      dimsEl.className = 'mp-dims';
      if (s.evidenceCoverage != null) {
        const coverage = document.createElement('span');
        coverage.className = 'mp-dim';
        coverage.textContent = `简历信息完整度${s.evidenceCoverage}%`;
        coverage.title = '简历中可核对的信息占岗位关键要求的比例；低不代表不合适，通常说明简历写得简略，建议点开简历人工确认';
        dimsEl.appendChild(coverage);
      }
      if (fitBreakdown && s.confidence) {
        const conf = document.createElement('span');
        conf.className = 'mp-dim';
        conf.textContent = `判断把握${CONFIDENCE_LABEL[s.confidence] || '中'}`;
        conf.title = '模型对自己这次判断的把握程度，受简历信息完整度影响';
        dimsEl.appendChild(conf);
      }
      if (!fitBreakdown && s.dims) {
        WEIGHT_KEYS.forEach((k) => {
          const d = s.dims[k];
          if (!d) return;
          const span = document.createElement('span');
          span.className = 'mp-dim';
          span.textContent = `${DIM_LABEL[k]}${d.score}`;
          if (d.reason) span.title = `${DIM_LABEL[k]}：${d.reason}`;
          dimsEl.appendChild(span);
        });
      }
      if (dimsEl.childNodes.length) info.appendChild(dimsEl);
    }

    if (s.level !== '错误') {
      const cols = MokaMatch.evidenceColumnsFromScore(s);
      const fitDetail = {
        breakdown: s.scoreBreakdown || null,
        confidence: s.confidence || null,
        matchScore: s.matchScore != null ? s.matchScore : null,
        score: s.score != null ? s.score : null,
        unmetCount: Array.isArray(s.unmet) ? s.unmet.length : 0,
        bonusApplied: s.bonusApplied || 0
      };
      const hasCols = cols.left.length || cols.right.length || (cols.evidence && cols.evidence.length);
      if (hasCols || fitDetail.breakdown) {
        info.appendChild(buildEvidenceSplit(view.id, cols, fitDetail));
      }
    }
  }

  row.appendChild(scoreEl);
  row.appendChild(info);
  row.addEventListener('click', () => {
    sendToMoka({ action: 'openCandidate', appId: view.id });
  });
  return row;
}


// ---- v3.4.0 自 popup.js 移入：结果卡标签表 + 状态行文本拆解 ----

const DIM_LABEL = { experience: '经验', skill: '技能', education: '教育', potential: '潜力' };
const FIT_LABEL = { coreDuty: '核心职责', business: '业务场景', skill: '专业技能', scope: '责任范围' };
const FIT_WEIGHT_PCT = { coreDuty: 40, business: 25, skill: 20, scope: 15 };
const CONFIDENCE_LABEL = { high: '高', medium: '中', low: '低' };
const ROW_STAGE = { enrich: '① 补全经历…', score: '② AI 评分中…' };

const STATUS_TIP_RE = /\s*[·•]\s*Moka 标签请?保持打开[^\n]*/g;

const STATUS_SCORE_PREFIX_RE = /^评分\s+\d+\s*\/\s*\d+\s*[·•]\s*/;

function splitStatusText(raw) {
  let text = String(raw || '').trim();
  let showTip = false;
  if (/Moka 标签请?保持打开/.test(text)) {
    showTip = true;
    text = text.replace(STATUS_TIP_RE, '').trim();
  }
  text = text.replace(STATUS_SCORE_PREFIX_RE, '').trim();
  text = text.replace(/[·•]\s*$/, '').trim();
  return { activity: text, showTip };
}

function setResultSummary(text) {
  const el = document.getElementById('result-summary');
  if (el) el.textContent = text || '';
}
