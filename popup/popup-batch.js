/**
 * 批量推进与简历推荐对象面板（v3.4.0 自 popup.js 拆出）
 *
 * 职责：批量推进勾选/面板/执行、简历推荐对象状态行与确认流程、
 * 单人重评与门槛豁免入口、候选人卡操作按钮构建。
 * 与 popup.js 共享全局作用域（经典脚本按序加载），
 * 声明顺序：本文件先于 popup.js 加载，运行期才互调，无加载期依赖。
 */

/* 以下符号声明在本文件、主要消费在 popup.js / popup-results.js（经典脚本共享作用域） */
/* exported requestWaiveMustHave requestRescore buildFeedbackButtons */

/* ---------------- 批量推进（批量分配接口重放） ---------------- */

let lastAdoptNote = ''; // 最近一次「确认本岗简历推荐对象」未采纳的原因（面板常驻显示；v3.4.0 自 popup.js 移入）
const batchSelected = new Set();

function selectedBatchViews() {
  const alive = new Set(resultState.items.map((v) => String(v.id)));
  return Array.from(batchSelected)
    .filter((id) => alive.has(id))
    .map((id) => resultState.items.find((v) => String(v.id) === id))
    .filter(Boolean);
}

function updateBatchButton() {
  const btn = document.getElementById('batch-advance');
  if (!btn) return;
  const n = selectedBatchViews().length;
  btn.textContent = n ? `批量推进 (${n})` : '批量推进';
  btn.classList.toggle('on', n > 0);
}

function pickAdvanceable() {
  resultState.items.forEach((v) => {
    if (MokaMatch.hasAnyDecisionFeedback(v)) return; // 已决策的不再重复勾选
    if (v.score && (v.score.level === '可推进' || v.score.level === '优先推进')) {
      batchSelected.add(String(v.id));
    }
  });
  renderResults();
  refreshBatchPanelIfOpen();
}

function clearBatchSelection() {
  batchSelected.clear();
  renderResults();
  refreshBatchPanelIfOpen();
}

/** 批量推进面板开着时同步刷新勾选摘要与简历推荐对象状态，避免面板内容停留在旧状态 */
function refreshBatchPanelIfOpen() {
  const panel = document.getElementById('batch-panel');
  if (panel && !panel.classList.contains('hidden')) openBatchPanel();
}

function closeBatchPanel() {
  const panel = document.getElementById('batch-panel');
  const result = document.getElementById('batch-result');
  if (panel) panel.classList.add('hidden');
  if (result) {
    result.classList.add('hidden');
    result.textContent = '';
  }
}

/** 时间戳 → 「M-D HH:mm」；无效值返回空串 */
function formatAssigneeTime(ts) {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 读取本岗存档里的简历推荐对象确认时间 */
function readAssigneeConfirmedAt(jobId) {
  if (!jobId || !window.MokaPersist) return Promise.resolve(0);
  const key = MokaPersist.JOB_PRESET_STORAGE_KEY;
  return chrome.storage.local.get(key).then((res) => {
    const record = res[key] || {};
    const preset = MokaPersist.getJobPreset(record, jobId);
    return (preset && Number(preset.assigneeConfirmedAt)) || 0;
  }).catch(() => 0);
}

/** 把简历推荐对象渲染成「（N 人：姓名、姓名）」；姓名凑不齐时退回「（N 人）」 */
function formatAssigneeWho(count, names) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  if (count > 0 && list.length === count) return '（' + count + ' 人：' + list.join('、') + '）';
  return '（' + count + ' 人）';
}

/** 当前选中职位的展示名（下拉框选项文案）——简历推荐对象按职位名锚定 */
function currentJobLabel() {
  const jobSelect = document.getElementById('job-select');
  if (jobSelect && jobSelect.selectedIndex >= 0 && jobSelect.options[jobSelect.selectedIndex]) {
    return jobSelect.options[jobSelect.selectedIndex].textContent || '';
  }
  return activePresetJobLabel || '';
}

/**
 * 按选中职位读取简历推荐对象上下文；名字缺失且 Moka 页面正处于该职位时，
 * 直接从页面 DOM 实时刮「推荐到」芯片补齐。返回 { ctx, liveNames, scrapeDebug, stale }。
 * - 跟职位走：按「职位名」查该职位自己的存档（与页面 URL title 同源锚定），
 *   而不是 Moka 页面当前职位的——下拉框换职位后显示/确认都不会串岗；
 * - isPageJob=false：页面在别的职位上，此时不做实时刮取（页面弹窗属于别的职位）；
 * - liveNames=true：姓名来自本次实时刮取（已由 content 采信落库）
 * - stale=true：内容脚本不认识新 action，说明扩展没重载
 */
async function fetchAssigneeContextWithLiveScrape(jobId) {
  const jobLabel = currentJobLabel();
  let ctx = await sendToMoka({ action: 'getAssigneeForJob', jobId, jobLabel });
  if (!ctx || !ctx.ok) return { ctx, liveNames: false, stale: false };
  if (!ctx.isPageJob) return { ctx, liveNames: false, stale: false };
  // v3.1.4：本岗尚未记录时也要响应「重新读取」——弹窗开着就把看到的人名带回展示。
  // 此前 ready=false 走到下面 known.length===count(0===0) 直接 early-return，
  // 指引却让用户「回这里点重新读取识别姓名」——新岗永远识别不到，承诺了走不通的路
  if (!ctx.ready) {
    const cmp = await sendToMoka({ action: 'scrapeAssigneeNames', readOnly: true });
    const seen = (cmp && cmp.ok && Array.isArray(cmp.seenNames)) ? cmp.seenNames.filter(Boolean) : [];
    if (seen.length) return { ctx, liveNames: false, stale: false, popupNames: seen };
    return { ctx, liveNames: false, stale: false };
  }
  // 已有完整姓名时也做只读比对：发现「弹窗当前人选 ≠ 已存记录」立即提示，
  // 绝不静默沿用旧记录（旧记录可能已被跨职位操作污染）
  if (ctx.ready) {
    const known = Array.isArray(ctx.assigneeNames) ? ctx.assigneeNames.filter(Boolean) : [];
    if (known.length === ctx.assigneeCount) {
      const cmp = await sendToMoka({ action: 'scrapeAssigneeNames', readOnly: true, count: ctx.assigneeCount });
      const gated = (cmp && cmp.ok && Array.isArray(cmp.names)) ? cmp.names.filter(Boolean) : [];
      if (gated.length === ctx.assigneeCount) {
        return { ctx, liveNames: false, stale: false, popupNames: gated };
      }
      // v3.0.9：数量不一致（如已记录 1 人、弹窗选 4 人）也要把「弹窗当前看到的」带回去——
      // 旧逻辑整组拒掉后只会误报「未检测到打开的弹窗」，用户对人数不一致毫无感知
      const seen = (cmp && cmp.ok && Array.isArray(cmp.seenNames)) ? cmp.seenNames.filter(Boolean) : [];
      return { ctx, liveNames: false, stale: false, popupNames: seen };
    }
  }
  const known = Array.isArray(ctx.assigneeNames) ? ctx.assigneeNames.filter(Boolean) : [];
  if (known.length === ctx.assigneeCount) return { ctx, liveNames: false, stale: false };
  const scrape = await sendToMoka({ action: 'scrapeAssigneeNames' });
  if (!scrape || !scrape.ok) {
    return { ctx, liveNames: false, stale: true };
  }
  if (Array.isArray(scrape.names) && scrape.names.filter(Boolean).length === ctx.assigneeCount) {
    ctx.assigneeNames = scrape.names;
    return { ctx, liveNames: true, stale: false };
  }
  return {
    ctx,
    liveNames: false,
    stale: false,
    scrapeDebug: (scrape.debug && typeof scrape.debug === 'object') ? scrape.debug : null
  };
}

/** 把实时刮取的诊断压缩成一句可读文案（仅用于「有标签但没读到人名」的少见情况） */
function summarizeScrapeDebug(debug) {
  if (!debug) return '';
  const anchor = Array.isArray(debug.anchored) ? debug.anchored : [];
  const labels = Number(debug.labels) || 0;
  if (labels > 0 && !anchor.length) return '页面上有「推荐到」标签但没读到人名芯片';
  return '';
}

/**
 * 配置页「简历推荐对象」区块：展示本岗记录状态并支持前置确认。
 * - 已记录 + 已确认：绿色状态，开筛后批量推进直接使用，不再处理简历推荐对象；
 * - 已记录 + 未确认：展示「确认本岗简历推荐对象」按钮；
 * - 未记录：引导去本职位的 Moka 列表勾选候选人、点「推荐给用人部门」打开弹窗（插件自动捕获）。
 */
async function renderAssigneeStatusInner(viaButton) {
  const el = document.getElementById('assignee-status');
  const btn = document.getElementById('confirm-assignee');
  if (!el) return;
  const jobId = currentJobId() || effectiveJobId();
  if (!jobId) {
    el.textContent = '请先在上方选择职位';
    el.style.color = '';
    if (btn) btn.classList.add('hidden');
    return;
  }
  el.textContent = '正在读取本岗简历推荐对象…';
  el.style.color = '';
  if (btn) btn.classList.add('hidden');
  const { ctx, liveNames, stale, scrapeDebug, popupNames } = await fetchAssigneeContextWithLiveScrape(jobId);
  // 等待期间职位被切走：丢弃本次结果，下一次渲染会按新职位重查
  if ((currentJobId() || effectiveJobId()) !== jobId) return;
  // 用户主动点「重新读取」却没读到页面当前人选（弹窗没开，或已记录且姓名来自存档）：
  // 必须点破「这次没有和页面比对」，否则点十次都是同一行 ✓，看起来像按钮坏了
  const noLiveRead = !liveNames && !(Array.isArray(popupNames) && popupNames.length);
  const compareMissedHint = viaButton && noLiveRead
    ? ' ⚠️ 本次未检测到打开的「推荐给用人部门」弹窗，没有与页面实时比对——要核对或更换人选，先在列表页点「推荐给用人部门」打开弹窗，再点「重新读取」'
    : '';
  const confirmedAt = currentAssigneeConfirmedAt || await readAssigneeConfirmedAt(jobId);
  if (!ctx) {
    el.textContent = '无法连接 Moka 页面：请打开本职位的 Moka 列表页后点「重新读取」';
    el.style.color = '#fa8c16';
    return;
  }
  if (!ctx.ready) {
    // v3.2.0：免真发——确认时若无真实模板会用默认模板合成记录；
    // 真发一次保留为校准手段（指定简历类型/抄送偏好时覆盖默认模板）
    const seen = Array.isArray(popupNames) ? popupNames.filter(Boolean) : [];
    el.textContent = ctx.isPageJob
      ? (seen.length
          ? '弹窗当前选了 ' + seen.length + ' 人（' + seen.join('、') + '）。'
            + '点下方「确认本岗简历推荐对象」即可采纳并永久记住（无需真发）；'
            + '如需指定简历类型 / 抄送偏好，在弹窗里真发一次即可校准。'
            + '此后改人选：选好人不发，回这里点「重新读取」+「确认」即可更新'
          : '本岗尚未记录简历推荐对象。两步即可：① 在本职位的简历列表页勾选候选人，'
            + '点「推荐给用人部门」打开弹窗——选好人就行，不用真发出去；'
            + '② 回这里点「确认本岗简历推荐对象」即可采纳并永久记住，关掉弹窗也不会丢。'
            + '此后再改人选：选好人不发，回这里点「重新读取」，识别到姓名后点确认即可更新')
      : '该职位尚未记录简历推荐对象：请在 Moka 打开该职位的候选人列表，'
        + '勾选候选人并点「推荐给用人部门」打开弹窗（选好人即可，不用真发出去），再回本页点「确认本岗简历推荐对象」';
    el.style.color = '#fa8c16';
    return;
  }
  const who = formatAssigneeWho(ctx.assigneeCount, ctx.assigneeNames);
  const recorded = '已记录本岗简历推荐对象' + who
    + (ctx.savedAt ? '，记录于 ' + formatAssigneeTime(ctx.savedAt) : '');
  if (stale) {
    el.textContent = recorded + '。⚠️ 内容脚本版本过旧：请到 chrome://extensions 重新加载插件并刷新 Moka 页面，再点「重新读取」';
    el.style.color = '#fa8c16';
    if (btn) btn.classList.remove('hidden');
    return;
  }
  if (ctx.assigneeCount && who.indexOf('：') === -1) {
    const anchor = (scrapeDebug && Array.isArray(scrapeDebug.anchored)) ? scrapeDebug.anchored : [];
    if (anchor.length) {
      // 弹窗当前人选与已记录的不一致：给双方名单 + 对齐方式
      el.textContent = recorded + '。弹窗当前选了 ' + anchor.length + ' 人（'
        + anchor.join('、') + '），与本岗已记录的 ' + ctx.assigneeCount
        + ' 人不一致；若以弹窗当前为准，直接点下方「确认本岗简历推荐对象」即可采纳并永久记住，'
        + '或在该弹窗点「推荐并进入用人部门筛选」完成确认自动同步';
    } else {
      // 弹窗没开：页面上没有芯片可读。不倒诊断杂项，给一句干净的行动指引
      const partial = summarizeScrapeDebug(scrapeDebug);
      el.textContent = recorded + '。'
        + (partial ? '（' + partial + '）' : '推荐弹窗当前未打开，读不到页面上的姓名。')
        + '请打开 Moka 的「推荐给用人部门」弹窗后点「重新读取」，识别到姓名后点「确认本岗简历推荐对象」即可永久记住，关掉弹窗也不会丢';
    }
    el.style.color = '#fa8c16';
    if (btn) btn.classList.remove('hidden');
    return;
  }
  // 弹窗当前人选 vs 已存记录：不一致立即置顶提示（即使已确认也允许改选），
  // 杜绝「记录里是 A、弹窗选的是 B」却毫无感知
  if (Array.isArray(popupNames) && popupNames.length) {
    const storedNames = Array.isArray(ctx.assigneeNames) ? ctx.assigneeNames.filter(Boolean) : [];
    // v3.1.0：按「集合」比对而非按顺序——同一组人只是先后顺序不同（fiber 采信顺序 vs
    // 芯片 DOM 顺序）时，旧逻辑会判成「不一致」，刚确认成功又立刻冒出橙色提示，像没生效
    const sortedStored = storedNames.slice().sort();
    const sortedPopup = popupNames.slice().sort();
    const same = sortedStored.length === sortedPopup.length
      && sortedStored.every((n, i) => n === sortedPopup[i]);
    if (!same) {
      el.textContent = recorded + '。弹窗当前选了 ' + popupNames.length + ' 人（'
        + popupNames.join('、') + '）'
        + (storedNames.length ? '，与已记录的（' + storedNames.join('、') + '）不一致' : '')
        + '；如以弹窗当前为准，点下方「确认本岗简历推荐对象」即可采纳并永久记住';
      el.style.color = '#fa8c16';
      if (btn) btn.classList.remove('hidden');
      return;
    }
  }
  // v3.0.8：近似匹配（职位名包含式命中，非精确同名）必须明示——可能是名字相近的别的岗记录
  const fuzzyHint = ctx.fuzzyMatched
    ? '（⚠️ 此记录按职位名近似匹配而来，可能不是本岗的：如不符，请在本职位打开「推荐给用人部门」弹窗后点「确认本岗简历推荐对象」重认）'
    : '';
  if (confirmedAt) {
    // 已确认：一行干净的状态——姓名 + 记录时间；主动点「重新读取」却没比对到页面时，追加提示
    const nm = Array.isArray(ctx.assigneeNames) && ctx.assigneeNames.length
      ? ctx.assigneeNames.join('、') : '';
    el.textContent = '✓ 已确认本岗简历推荐对象：' + (nm ? nm + '（' + ctx.assigneeCount + ' 人）' : ctx.assigneeCount + ' 人')
      + '，记录于 ' + formatAssigneeTime(confirmedAt) + '，开筛后批量推进按此执行'
      + fuzzyHint + compareMissedHint;
    el.style.color = '#52c41a';
  } else {
    el.textContent = recorded + (liveNames ? '（本次从推荐弹窗实时读取）' : '')
      + '。确认后开筛即可直接批量推进；不同职位各自记录，不会串用'
      + fuzzyHint + compareMissedHint;
    el.style.color = '';
    if (btn) btn.classList.remove('hidden');
  }
}

/** 状态行闪一下（v3.1.0）：读取/确认都很快、文案可能没变化，不给视觉反馈
 *  用户会以为按钮没反应。统一入口，避免多处复制动画代码 */
function flashAssigneeStatusLine() {
  const el = document.getElementById('assignee-status');
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth; // 强制回流，连续点击也能重启动画
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1100);
}

/** 配置页简历推荐对象状态渲染：先跑状态，再把最近一次「确认」的结果说明置顶显示
 *  （成功确认时 lastAdoptNote 清空，绿色状态行本身就是结果，不叠加冗余说明）。
 *  viaButton=true（用户点了「重新读取」）时让状态行闪一下——读取太快且文案没变化时，
 *  不给任何视觉反馈会让人以为按钮没反应 */
async function renderAssigneeStatus(viaButton) {
  await renderAssigneeStatusInner(viaButton);
  const el = document.getElementById('assignee-status');
  if (el && lastAdoptNote) {
    el.textContent = lastAdoptNote + '\n' + el.textContent;
    el.style.whiteSpace = 'pre-line';
  }
  if (viaButton) flashAssigneeStatusLine();
}

/** 把确认时间写进本岗存档（不影响表单其它字段） */
async function stampAssigneeConfirmed(jobId) {
  if (!jobId || !window.MokaPersist) return;
  const id = MokaPersist.jobPresetKey(jobId);
  if (!id) return;
  try {
    currentAssigneeConfirmedAt = Date.now();
    // v3.3.0：走统一写队列——与「保存筛选条件/自动保存」并发时不再互相整包覆盖
    await writeJobPresetRecord((record) => {
      // 只盖确认章：绝不用当前表单内容兜底覆盖存档——表单可能装着别的职位（串档源头之一）。
      // 没有存档时就建一条只含确认章 + 身份锚点的最小档，其余字段等用户真正保存时再写。
      const existing = MokaPersist.getJobPreset(record, jobId);
      const base = existing || {
        jobType: /实习/.test(currentJobLabel() || '') ? 'intern' : 'full-time',
        jobIdAnchor: id,
        jobNameAnchor: String(currentJobLabel() || '').trim()
      };
      const merged = Object.assign({}, base, { assigneeConfirmedAt: currentAssigneeConfirmedAt });
      return MokaPersist.putJobPreset(record, id, merged, Date.now());
    });
  } catch (e) { /* 存储失败不打断 */ }
}

/**
 * 配置页点「确认本岗简历推荐对象」：
 * 1) 弹窗开着且有姓名 → 先「采纳」：React fiber 成对姓名优先（自带 id），
 *    刮到的姓名并集走成员映射反查兜底；成功则改写本岗记录的简历推荐对象并盖确认章。
 *    之后关弹窗/换页面都不丢，批量推进重放即按这组人。
 * 2) 有姓名但解析不到 id → 面板常驻提示两条路：弹窗点一次确认 / 点开下拉框让
 *    插件记录成员 id。
 * 3) 无姓名（弹窗没开）→ 常驻提示先开弹窗，不盖章不静默。
 * 4) 其余一切失败（记录缺失/识别异常/未知返回/连不上）→ 常驻 ✗ 状态行（原地显示 + 闪一下），
 *    绝不静默清空、绝不误盖「已确认」章。
 * 5) 所有结果一律写回「简历推荐对象」状态行本身（成功=原地变绿，失败=原地变橙 + ✗），
 *    不再发底部浮动 toast：同一句话出现两处、位置还不是用户看的地方（v3.1.0）。
 */
async function confirmAssigneeForCurrentJob() {
  const jobId = currentJobId() || effectiveJobId();
  if (!jobId) return;
  // 跨职位防护：Moka 页面在别的职位上时，页面弹窗人选属于那个职位，
  // 绝不能采纳进当前选中的职位；此时只对「该职位已记录的简历推荐对象」盖章
  let probe = null;
  try { probe = await sendToMoka({ action: 'getAssigneeForJob', jobId, jobLabel: currentJobLabel() }); } catch (e) { probe = null; }
  if (probe && probe.ok && probe.isPageJob === false) {
    if (probe.ready) {
      await stampAssigneeConfirmed(jobId);
      lastAdoptNote = '';
    } else {
      lastAdoptNote = '✗ 该职位尚未记录简历推荐对象：请在 Moka 打开该职位的候选人列表，'
        + '勾选候选人并点「推荐给用人部门」打开弹窗（选好人即可），回本页点「重新读取」后再点确认';
    }
    // v3.1.0：结果一律写在状态行上（原地变绿/变橙 + 闪一下）。底部浮动 toast 与上方状态行
    // 说的是同一句话，用户看到的是「位置不对」的两条重复信息，且 toast 常在滚动区外看不见
    await renderAssigneeStatus();
    flashAssigneeStatusLine();
    return;
  }
  let adopted = null;
  try {
    adopted = await sendToMoka({ action: 'adoptScrapedAssignees' });
  } catch (e) { adopted = null; }
  if (adopted && adopted.ok && adopted.adopted) {
    await stampAssigneeConfirmed(jobId);
    // 成功后不叠加置顶说明：绿色状态行「✓ 已确认本岗简历推荐对象：姓名，记录于 …」
    // 本身就是结果，避免同一句话重复两遍
    lastAdoptNote = '';
    await renderAssigneeStatus();
    flashAssigneeStatusLine();
    return;
  }
  if (adopted && adopted.ok && Array.isArray(adopted.names) && adopted.names.length
    && (adopted.reason === 'unknown-names' || adopted.reason === 'ambiguous-names')) {
    const detail = adopted.reason === 'ambiguous-names'
      ? '存在同名成员（' + (adopted.ambiguous || []).join('、') + '）'
      : '成员 id 未知（' + (adopted.missing || []).join('、') + '）';
    lastAdoptNote = '✗ 刚刚未采纳（' + detail + '）。两条路任选其一：'
      + '① 在该弹窗点一次「推荐并进入用人部门筛选」完成确认，插件自动记录后回来再点一次本按钮；'
      + '② 在弹窗里点开「推荐到」的选择框展开成员列表（插件会自动记录成员 id），再回来点一次本按钮';
    await renderAssigneeStatus();
    flashAssigneeStatusLine();
    return;
  }
  if (adopted && adopted.ok && adopted.reason === 'no-names') {
    lastAdoptNote = '✗ 刚刚未采纳：没读到弹窗姓名（弹窗未打开或已关闭）。'
      + '请先打开「推荐给用人部门」弹窗，点「重新读取」看到姓名后再点本按钮';
    await renderAssigneeStatus();
    flashAssigneeStatusLine();
    return;
  }
  if (adopted && adopted.ok && adopted.reason === 'no-record') {
    // v3.2.0：no-record 只剩「页面缺 pipelineId、无法落记录」一种情况——
    // 模板缺失已由默认合成模板兜住（免真发）
    lastAdoptNote = '✗ 刚刚未采纳：无法定位当前职位（页面缺少 pipelineId，无法落记录）。'
      + '请刷新 Moka 页面后重新打开「推荐给用人部门」弹窗，再点本按钮';
    await renderAssigneeStatus();
    flashAssigneeStatusLine();
    return;
  }
  if (adopted && adopted.ok && adopted.reason === 'error') {
    lastAdoptNote = '✗ 刚刚未采纳：页面识别异常（' + (adopted.error || '未知')
      + '）。请到 chrome://extensions 重载插件并刷新 Moka 页面后重试';
    await renderAssigneeStatus();
    flashAssigneeStatusLine();
    return;
  }
  if (adopted && adopted.ok && adopted.adopted !== true) {
    // 未知返回兜底：原样展示，绝不静默清空、绝不误盖「已确认」章
    let detail = '';
    try { detail = JSON.stringify(adopted).slice(0, 140); } catch (e) { detail = String(adopted); }
    lastAdoptNote = '✗ 刚刚未采纳（未知返回：' + detail + '）';
    await renderAssigneeStatus();
    flashAssigneeStatusLine();
    return;
  }
  lastAdoptNote = '✗ 刚刚未采纳：无法连接 Moka 页面（内容脚本可能未更新，请重载扩展并刷新 Moka）';
  await renderAssigneeStatus();
  flashAssigneeStatusLine();
}

async function openBatchPanel() {
  const panel = document.getElementById('batch-panel');
  if (!panel) return;
  const views = selectedBatchViews();
  const summary = document.getElementById('batch-summary');
  const assignee = document.getElementById('batch-assignee');
  const confirmBtn = document.getElementById('confirm-batch');
  const result = document.getElementById('batch-result');
  if (result) {
    result.classList.add('hidden');
    result.textContent = '';
  }

  if (!views.length) {
    summary.textContent = '尚未勾选候选人：在结果卡片左侧勾选，或点「勾选可推进」快捷全选。';
    assignee.textContent = '';
    confirmBtn.disabled = true;
    panel.classList.remove('hidden');
    return;
  }

  const names = views.slice(0, 5).map((v) => v.name || v.id).join('、');
  const over = views.length > MokaBatch.BATCH_ASSIGN_LIMIT;
  summary.textContent = `已勾选 ${views.length} 人：${names}${views.length > 5 ? ' 等' : ''}`
    + (over ? `（超出单次上限 ${MokaBatch.BATCH_ASSIGN_LIMIT} 人，请减少勾选）` : '');

  assignee.textContent = '读取简历推荐对象…';
  confirmBtn.disabled = true;
  panel.classList.remove('hidden');

  const { ctx } = await fetchAssigneeContextWithLiveScrape(currentJobId() || effectiveJobId());
  if (ctx && ctx.ok && ctx.ready) {
    const who = formatAssigneeWho(ctx.assigneeCount, ctx.assigneeNames);
    const confirmedAt = currentAssigneeConfirmedAt
      || await readAssigneeConfirmedAt(currentJobId() || effectiveJobId());
    const namesKnown = who.indexOf('：') !== -1;
    if (confirmedAt && namesKnown) {
      assignee.textContent = '将全部推进给本岗已确认的简历推荐对象' + who
        + '——与该岗位简历推荐对象一致，确认无误即可执行；如需更换请回「配置」页重新记录';
    } else if (confirmedAt) {
      assignee.textContent = '将推进给本岗已确认的简历推荐对象' + who
        + '（姓名可在「配置」页开着推荐弹窗点「重新读取」带出）；如需更换请回「配置」页重新记录';
    } else {
      assignee.textContent = '已记录本职位的简历推荐对象' + who
        + '——与你在此职位点「推荐给用人部门」时选的人一致，不同职位不会串用；建议先到「配置」页确认';
    }
    confirmBtn.disabled = over;
  } else {
    assignee.textContent = '本职位还没有记录简历推荐对象：请先在本职位的简历列表页勾选候选人、点「推荐给用人部门」打开弹窗（选好人即可，插件自动记录），再回「配置」页点「重新读取」。每个职位的简历推荐对象各自记录。';
  }
}

/** 延迟整页刷新 Moka 标签页：给接口写库留落定时间，再让候选人从「初筛」列表移出。
 *  批量推进与单个推荐（API 直连重放，1.10.6）共用；DOM 自动化链路本来就跳页面，用不到 */
function reloadMokaTabSoon() {
  setTimeout(async () => {
    try {
      const tab = await getMokaTab();
      if (tab && isMokaTab(tab)) chrome.tabs.reload(tab.id);
    } catch (e) { /* 刷新失败不影响结果提示 */ }
  }, 1200);
}

async function executeBatchAdvance() {
  const views = selectedBatchViews();
  if (!views.length) return;
  const btn = document.getElementById('confirm-batch');
  const result = document.getElementById('batch-result');
  const show = (msg, type) => {
    result.textContent = msg;
    result.className = `test-result ${type}`;
    result.classList.remove('hidden');
  };

  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = '推进中…';
  try {
    const resp = await sendToMoka({
      action: 'batchAssign',
      appIds: views.map((v) => v.id)
    });
    if (!resp) {
      show('❌ 无法连接 Moka 页面，请刷新后重试', 'error');
      return;
    }
    if (!resp.ok) {
      show('❌ ' + (resp.error || '批量推进失败'), 'error');
      return;
    }
    show(`✅ 已推进 ${resp.count} 人，正在移入「已决策」并刷新 Moka…`, 'success');
    // 处理联动：批量推进 = 批量「推荐给用人部门」。成功的候选人记入已决策存档，
    // 自动从「待处理 / 推荐」移出，与单点推荐按钮的处理链路保持一致。
    views.forEach((v) => {
      saveCandidateFeedback(v.id, 'recommend', v, { mokaSynced: true, syncFailed: false });
    });
    batchSelected.clear();
    updateBatchButton();
    renderResults();
    // 让接口写库先落定，再刷新 Moka 页面，避免用户看到旧列表
    reloadMokaTabSoon();
    closeBatchPanel();
    renderResults();
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

document.getElementById('batch-advance')?.addEventListener('click', openBatchPanel);
document.getElementById('close-batch-panel')?.addEventListener('click', closeBatchPanel);
document.getElementById('batch-pick-advance')?.addEventListener('click', pickAdvanceable);
document.getElementById('batch-clear')?.addEventListener('click', clearBatchSelection);
document.getElementById('confirm-batch')?.addEventListener('click', executeBatchAdvance);
document.getElementById('refresh-assignee')?.addEventListener('click', () => renderAssigneeStatus(true));
document.getElementById('confirm-assignee')?.addEventListener('click', confirmAssigneeForCurrentJob);

function setViewRescoring(appId, rescoring) {
  const id = String(appId);
  resultState.items = resultState.items.map((v) => (
    String(v.id) === id ? Object.assign({}, v, { rescoring: !!rescoring, stage: rescoring ? (v.stage || 'score') : v.stage }) : v
  ));
  renderResults();
}

function markRescoreError(message) {
  setResultHint(message, { tone: 'warn', color: '#fa8c16' });
  setTimeout(() => { renderResults(); }, 4000);
}

// 声明在本文件、消费在其它 popup 模块（经典脚本共享作用域）
// eslint-disable-next-line no-unused-vars
async function requestWaiveMustHave(appId, item, waived) {
  try {
    const resp = await sendToMoka({ action: 'waiveMustHave', appId, item, waived });
    if (!resp) {
      markRescoreError('无法连接 Moka 页面，请刷新后重试');
      return;
    }
    await refreshResultsAndJobContext();
    if (!resp.ok) {
      markRescoreError(resp.error || '忽略失败：请刷新 Moka 页面后重试');
    }
  } catch (e) {
    markRescoreError((e && e.message) || '忽略失败');
  }
}

// 声明在本文件、消费在其它 popup 模块（经典脚本共享作用域）
// eslint-disable-next-line no-unused-vars
async function requestRescore(appId) {
  setViewRescoring(appId, true);
  const resp = await sendToMoka({ action: 'rescore', appId });
  await refreshResultsAndJobContext();
  if (!resp || !resp.ok) {
    markRescoreError((resp && resp.error) || '重评失败：请刷新 Moka 页面后重试');
  }
}

// 声明在本文件、消费在其它 popup 模块（经典脚本共享作用域）
// eslint-disable-next-line no-unused-vars
function buildFeedbackButtons(view) {
  const wrap = document.createElement('div');
  wrap.className = 'mp-feedback';

  if (!effectiveJobId()) return wrap;

  const busy = view._mokaActionBusy || isMokaActionLocked();
  [
    {
      verdict: 'recommend',
      label: '推荐给用人部门',
      busyLabel: '推荐中…',
      title: '在 Moka 中推荐给用人部门并自动确认（同步成功后再点撤销，未同步时再点重试）'
    },
    {
      verdict: 'eliminate',
      label: '淘汰',
      busyLabel: '淘汰中…',
      title: '在 Moka 中淘汰（同步成功后再点撤销，未同步时再点重试）'
    }
  ].forEach(({ verdict, label, busyLabel, title }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mp-fb-btn'
      + (view.feedback === verdict ? ' on ' + verdict : '')
      + (busy === verdict ? ' busy' : '');
    btn.textContent = busy === verdict ? busyLabel : label;
    btn.title = title;
    btn.disabled = !!busy;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy || isMokaActionLocked()) return;
      requestMokaDecision(view.id, verdict, view);
    });
    wrap.appendChild(btn);
  });
  return wrap;
}
