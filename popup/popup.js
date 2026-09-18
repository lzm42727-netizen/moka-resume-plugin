/** 空值守航：取不到元素时 console.warn 一次并返回 null。
 *  顶层 DOM 绑定一律走它——单个 id 缺失只跳过该绑定，不再整段瘫痪（P2-11）。 */
const safeElMissingWarned = new Set();
function safeEl(id) {
  const el = document.getElementById(id);
  if (!el && !safeElMissingWarned.has(id)) {
    safeElMissingWarned.add(id);
    console.warn('[Moka 筛选] popup.html 缺少元素 #' + id + '（HTML 重构可能漏掉了它，相关功能已跳过）');
  }
  return el;
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach((c) => {
    c.classList.toggle('active', c.id === `${tabName}-tab`);
  });
  // 回到配置页时刷新简历推荐对象状态（Moka 里手动分配后可能已有新记录）
  if (tabName === 'screening') renderAssigneeStatus();
  // 打开设置页时同步一次运行日志（漏掉的后台广播在这里补上）
  if (tabName === 'settings') reloadPluginLog();
  // 打开健康检查页即体检一遍（v3.6.0：原独立页并入弹窗标签，态随时可变，每次进来重跑）
  // typeof 守卫：该模块单独缺失时只让本页停在「尚未检查」，不把标签切换一起带崩
  if (tabName === 'health' && typeof renderHealthCheck === 'function') renderHealthCheck();
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

safeEl('reload-panel')?.addEventListener('click', () => {
  reloadSidePanel();
});

/** 解析年龄区间字符串 → { min, max, label }；50+ → max 为 null */
function parseAgeRange(val) {
  if (!val) return null;
  if (val.endsWith('+')) {
    const min = parseInt(val, 10);
    return Number.isFinite(min) ? { min, max: null, label: val } : null;
  }
  if (val.includes('-')) {
    const [a, b] = val.split('-').map((n) => parseInt(n, 10));
    const min = Number.isFinite(a) ? a : null;
    const max = Number.isFinite(b) ? b : null;
    if (min == null && max == null) return null;
    return { min, max, label: val };
  }
  return null;
}

// 读取硬性条件表单
function readHardConditions() {
  const schools = Array.from(document.querySelectorAll('#cond-school input[type="checkbox"]:checked')).map((c) => c.value);
  const ageRanges = ageTierSelection().map((v) => parseAgeRange(v)).filter(Boolean);
  return {
    degree: document.getElementById('cond-degree').value,
    schools,
    exp: document.getElementById('cond-exp').value,
    gender: document.getElementById('cond-gender').value,
    internship: document.getElementById('cond-internship').value,
    ageRanges,
    languages: languageEditor.get(),
    customGates: customGateEditor.get()
  };
}

function createChipEditor(listId, inputId, opts) {
  const listEl = document.getElementById(listId);
  const inputEl = document.getElementById(inputId);
  const options = opts || {};
  const chipMax = typeof options.max === 'number'
    ? options.max
    : ((window.MokaMatch && MokaMatch.CHIP_LIMIT) || 6);
  const tierLabel = options.tierLabel || '';
  let items = [];
  let moveTargets = []; // [{ label, tierLabel, editor }]

  function closeChipMenus() {
    document.querySelectorAll('.chip-menu').forEach((el) => el.remove());
    document.querySelectorAll('.chip.is-menu-open').forEach((el) => el.classList.remove('is-menu-open'));
  }

  function openMoveMenu(chipEl, idx) {
    closeChipMenus();
    if (!moveTargets.length) return;
    chipEl.classList.add('is-menu-open');
    const menu = document.createElement('div');
    menu.className = 'chip-menu';
    const title = document.createElement('div');
    title.className = 'chip-menu-title';
    title.textContent = '移到';
    menu.appendChild(title);
    moveTargets.forEach((t) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-menu-item';
      btn.textContent = t.tierLabel;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeChipMenus();
        moveItemTo(idx, t.editor, t.tierLabel);
      });
      menu.appendChild(btn);
    });
    chipEl.appendChild(menu);
  }

  function render() {
    closeChipMenus();
    listEl.innerHTML = '';
    items.forEach((text, idx) => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (moveTargets.length ? ' chip-movable' : '');
      chip.title = moveTargets.length ? '点击挪到其他栏' : '';
      const label = document.createElement('span');
      label.className = 'chip-text';
      label.textContent = text;
      chip.appendChild(label);

      if (moveTargets.length) {
        chip.addEventListener('click', (e) => {
          if (e.target.closest('.chip-x') || e.target.closest('.chip-menu')) return;
          e.preventDefault();
          e.stopPropagation();
          if (chip.classList.contains('is-menu-open')) closeChipMenus();
          else openMoveMenu(chip, idx);
        });
      }

      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chip-x';
      x.textContent = '×';
      x.title = '删除';
      x.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeChipMenus();
        items.splice(idx, 1);
        render();
        notifyChipChange();
      });
      chip.appendChild(x);
      listEl.appendChild(chip);
    });
  }

  let onChange = null;
  function notifyChipChange() {
    if (typeof onChange === 'function') onChange();
  }

  function tryAddOne(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, reason: 'empty' };
    if (items.length >= chipMax) return { ok: false, reason: 'full' };
    if (items.some((x) => x.toLowerCase() === t.toLowerCase())) return { ok: false, reason: 'dup' };
    items.push(t);
    render();
    notifyChipChange();
    return { ok: true };
  }

  function moveItemTo(idx, targetEditor, targetLabel) {
    if (idx < 0 || idx >= items.length || !targetEditor) return;
    const text = items[idx];
    const added = targetEditor.tryAddOne(text);
    if (!added.ok) {
      if (added.reason === 'full') {
        showDockToast('「' + targetLabel + '」已满，请先删一项再挪', 'warn');
      } else if (added.reason === 'dup') {
        showDockToast('「' + targetLabel + '」里已有相同项', 'warn');
      }
      return;
    }
    items.splice(idx, 1);
    render();
    notifyChipChange();
    showDockToast('已移到「' + targetLabel + '」', 'ok');
  }

  function addFromString(str) {
    const parsed = (window.MokaMatch ? MokaMatch.parseChipList(str) : String(str || '').split(/[,，、;；\n]+/).map((s) => s.trim()).filter(Boolean));
    const before = items.length;
    parsed.forEach((t) => { tryAddOne(t); });
    if (items.length === before) render();
  }

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addFromString(inputEl.value);
      inputEl.value = '';
    }
  });
  inputEl.addEventListener('blur', () => {
    if (!inputEl.value.trim()) return;
    addFromString(inputEl.value);
    inputEl.value = '';
  });

  return {
    get: () => items.slice(),
    set: (arr) => {
      items = [];
      addFromString(Array.isArray(arr) ? arr.join(',') : String(arr || ''));
    },
    onChange: (fn) => { onChange = fn; },
    tryAddOne,
    setMoveTargets: (targets) => {
      moveTargets = Array.isArray(targets) ? targets : [];
      render();
    },
    tierLabel,
    closeChipMenus
  };
}

const languageEditor = createChipEditor('lang-chips', 'lang-input', { max: 6, tierLabel: '语言' });
const customGateEditor = createChipEditor('gate-chips', 'gate-input', { max: 6, tierLabel: '专业及其他' });
const importantEditor = createChipEditor('important-chips', 'important-input', { max: 6, tierLabel: '重点看' });
const niceEditor = createChipEditor('nice-chips', 'nice-input', { max: 5, tierLabel: '加分看' });

importantEditor.setMoveTargets([
  { label: '加分看', tierLabel: '加分看', editor: niceEditor }
]);
niceEditor.setMoveTargets([
  { label: '重点看', tierLabel: '重点看', editor: importantEditor }
]);

document.addEventListener('click', () => {
  languageEditor.closeChipMenus();
  customGateEditor.closeChipMenus();
  importantEditor.closeChipMenus();
  niceEditor.closeChipMenus();
});

// ---- 评分维度权重 ----
const WEIGHT_KEYS = ['experience', 'skill', 'education', 'potential'];
const DEFAULT_WEIGHTS = { experience: 40, skill: 30, education: 20, potential: 10 };
let lastJobSpec = null; // 缓存最近一次 JD 解读结果

function readWeights() {
  const w = {};
  WEIGHT_KEYS.forEach((k) => {
    const el = document.getElementById('w-' + k);
    w[k] = el ? (parseInt(el.value, 10) || 0) : DEFAULT_WEIGHTS[k];
  });
  return w;
}

function updateWeightLabels() {
  const w = readWeights();
  const sum = WEIGHT_KEYS.reduce((a, k) => a + w[k], 0) || 1;
  WEIGHT_KEYS.forEach((k) => {
    const el = document.getElementById('w-' + k + '-val');
    if (el) el.textContent = Math.round((w[k] / sum) * 100) + '%';
  });
}

function setWeights(w) {
  const src = w || DEFAULT_WEIGHTS;
  WEIGHT_KEYS.forEach((k) => {
    const el = document.getElementById('w-' + k);
    if (el && typeof src[k] === 'number') el.value = src[k];
  });
  updateWeightLabels();
}

function resetJobPresetForm(opts) {
  applyingPreset = true;
  try {
    currentAssigneeConfirmedAt = 0;
    const internSuggested = !!(opts && opts.internSuggested);
    const typeVal = internSuggested ? 'intern' : 'full-time';
    const type = document.querySelector('input[name="job-type"][value="' + typeVal + '"]');
    if (type) type.checked = true;
    applyJobTypeVisibility();
    writeHardConditions({
      degree: '',
      schools: [],
      exp: '',
      gender: '',
      internship: '',
      ageRangeValues: [],
      languages: [],
      customGates: []
    });
    languageEditor.set([]);
    customGateEditor.set([]);
    importantEditor.set([]);
    niceEditor.set([]);
    setWeights(DEFAULT_WEIGHTS);
    lastJobSpec = null;
    setJobUnderstandingText('', '进入本岗后将自动生成岗位理解摘要（首次会解读 JD）');
  } finally {
    applyingPreset = false;
  }
}

function resolveTargetJobFromResponse(response, jobs) {
  const pageJob = jobs[0];
  // 优先 URL 上的 pageJobId；其次列表识别到的 jobs[0]；最后才回退上次筛选/侧栏记忆
  const pageJobId = response.pageJobId
    ? String(response.pageJobId)
    : (pageJob && pageJob.id && pageJob.id !== 'current' ? String(pageJob.id) : '');
  const memoryJobId = response.jobId ? String(response.jobId) : '';
  const targetJobId = pageJobId || memoryJobId || activePresetJobId || '';
  let label = '';
  if (pageJob && targetJobId && String(pageJob.id) === String(targetJobId)) {
    label = pageJob.name || '';
  }
  if (!label && response.jobName && targetJobId && (!memoryJobId || memoryJobId === targetJobId)) {
    label = response.jobName;
  }
  if (!label) {
    // v3.0.8：只有「还是同一个职位」时才沿用旧标签。切到新职位却拿不到名字时
    // 绝不继承上一个职位的名字——否则推荐对象按旧名字查档，会把上一个岗位的
    // 面试官当成新岗位的显示/执行（串岗实锤）。宁可先显示占位，等拿到真名再渲染。
    if (targetJobId && activePresetJobId && String(targetJobId) === String(activePresetJobId)) {
      label = activePresetJobLabel;
    }
  }
  return { targetJobId, label, pageJobId, pageJob };
}

function jobTypeSuggestedByLabel(label) {
  const t = String(label || '');
  if (/实习/.test(t)) return 'intern';
  return null;
}

/** 职位名含「实习」时强制对齐为实习生（覆盖错误恢复的正式员工） */
function reconcileJobTypeWithLabel(label) {
  const suggested = jobTypeSuggestedByLabel(label);
  if (!suggested) return false;
  const current = document.querySelector('input[name="job-type"]:checked');
  if (current && current.value === suggested) return false;
  applyingPreset = true;
  try {
    const radio = document.querySelector('input[name="job-type"][value="' + suggested + '"]');
    if (radio) radio.checked = true;
    applyJobTypeVisibility();
  } finally {
    applyingPreset = false;
  }
  return true;
}

/** 切岗互斥队列：switchJobPreset 的「保存旧岗 → 清空表单 → 恢复新岗」必须整段串行。
 *  手动切岗（下拉 change）与 loadJobs（页面 SPA 切岗）会并发触发本函数；若无互斥，
 *  快速 A→B→C 时后一轮的保存可能在上一轮刚清空表单、还没填回 B 内容的窗口期执行，
 *  把空/半成品表单覆盖进 B 的真实存档（历史跨岗串档同源）。
 *  队列吞掉上一轮错误后仍放行后续轮次，但首个调用者照常拿到拒绝（可自行降级）。
 *  prevLabel：离开岗位的名字。保存旧岗存档时必须用它盖锚名——若在函数内读
 *  currentJobLabel()，下拉往往已切到新岗，会把新岗名盖到旧岗 key 上（快照实锤的
 *  A↔B 交叉错位：ba2d225a 存的是 JAVA 名、efaa1e46 存的是 Golang 名）。 */
let switchJobQueue = Promise.resolve();
function switchJobPreset(prevJobId, prevLabel, targetJobId, label) {
  const runSwitch = async () => {
    if (prevJobId && targetJobId && String(prevJobId) !== String(targetJobId)) {
      // 保存离开岗：表单此刻仍装着旧岗内容。空表单（前一轮恢复失败/从未加载出内容）
      // 没有任何可保存价值，跳过以免把空白覆盖进旧岗真实存档。
      const leaving = collectJobPreset();
      if (presetHasUsableContent(leaving)) {
        await saveJobPresetFor(prevJobId, { label: prevLabel });
      }
      resultState.items = [];
      resultState.status = '';
      resultState.banner = null;
      lastJobSpec = null;
      resetJobPresetForm({ internSuggested: /实习/.test(label || '') });
    }
    if (targetJobId) {
      syncActiveJobFromSnapshot(targetJobId, label);
      lastKnownPageJobId = targetJobId;
    }
    const restored = await restoreCurrentJobPreset();
    const fixedType = reconcileJobTypeWithLabel(label || activePresetJobLabel);
    if (!restored && jobTypeSuggestedByLabel(label || activePresetJobLabel) === 'intern') {
      applyJobTypeVisibility();
    }
    if (fixedType && restored) {
      scheduleSaveJobPreset();
    }
    // 进岗稳定规则：理解已就位或本岗已有存档时，绝不自动调 AI 重解读
    // （清单纠错请点「按 JD 刷新」，会整表重写）
    await ensureJobUnderstandingOnEnter(restored);
    renderAssigneeStatus();
    if (prevJobId && targetJobId && String(prevJobId) !== String(targetJobId)) {
      await pullResults();
    }
    return restored;
  };
  const result = switchJobQueue.then(runSwitch);
  switchJobQueue = result.then(() => {}, () => {});
  return result;
}

WEIGHT_KEYS.forEach((k) => {
  document.getElementById('w-' + k)?.addEventListener('input', () => {
    updateWeightLabels();
  });
});

let applyingPreset = false;
let savePresetTimer = null;
let jobSelectBound = false;
let activePresetJobId = '';
let activePresetJobLabel = '';
/** 表单当前装着哪个岗位的配置；仅本次侧栏会话有效，不持久化 */
let presetFormJobId = '';
/** 本岗简历推荐对象的确认时间（随存档持久化；0 = 未确认，批量推进前置确认用） */
let currentAssigneeConfirmedAt = 0;
let lastKnownPageJobId = '';
/** 最近一次「本岗存档恢复」的诊断（目标身份/存档清单/命中方式），进排查快照定位回填问题 */
let lastPresetRestoreDiag = null;
/** 最近一次被跨岗防污染闸门拦截的保存（表单绑定职位 ≠ 目标职位），供保存按钮给出解释 */
let lastPresetSaveBlock = null;
let loadJobsInFlight = null;
let startingScreen = false;
const ACTIVE_JOB_STORAGE_KEY = 'mokaActivePresetJobId';
const ACTIVE_JOB_LABEL_KEY = 'mokaActivePresetJobLabel';

function loadActivePresetJobId() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([ACTIVE_JOB_STORAGE_KEY, ACTIVE_JOB_LABEL_KEY], (res) => {
        const id = res && res[ACTIVE_JOB_STORAGE_KEY];
        const label = res && res[ACTIVE_JOB_LABEL_KEY];
        if (id) activePresetJobId = String(id);
        if (label) activePresetJobLabel = String(label);
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

function persistActivePresetJobId() {
  if (!activePresetJobId && !activePresetJobLabel) return;
  try {
    const store = {};
    if (activePresetJobId) store[ACTIVE_JOB_STORAGE_KEY] = activePresetJobId;
    if (activePresetJobLabel) store[ACTIVE_JOB_LABEL_KEY] = activePresetJobLabel;
    chrome.storage.local.set(store);
  } catch (e) { /* ignore */ }
}

function currentJobId() {
  return document.getElementById('job-select').value;
}

/** 详情页 URL 无 pipelineId 时，下拉框会被清空，反馈/决策仍用上次筛选职位 */
function effectiveJobId() {
  const sel = currentJobId();
  if (sel) return sel;
  return activePresetJobId || '';
}

function jobLabelFallback(id) {
  const key = String(id || '');
  return key ? ('职位 ' + key.slice(0, 8)) : '';
}

function ensureJobSelectOption(id, label) {
  const jobSelect = document.getElementById('job-select');
  if (!jobSelect || !id) return;
  const key = String(id);
  // v3.0.8：label 为空时用中性占位（职位 xxx），绝不继承 activePresetJobLabel——
  // 那可能是上一个职位的名字，盖到新职位的 option 上会直接导致推荐对象串岗
  const text = label || jobLabelFallback(key);
  const existing = Array.from(jobSelect.options).find((o) => o.value === key);
  if (existing) {
    if (label && existing.textContent !== label) existing.textContent = label;
    return;
  }
  const option = document.createElement('option');
  option.value = key;
  option.textContent = text;
  jobSelect.appendChild(option);
}

function syncActiveJobFromSnapshot(jobId, label) {
  if (!jobId) return;
  // v3.0.8：同名兜底只允许「同一个职位」使用——切到新职位且名字未知时，
  // 用中性占位，绝不把上一个职位的名字安到新职位头上
  const sameJob = String(jobId) === String(activePresetJobId);
  const safeLabel = label || (sameJob ? activePresetJobLabel : '');
  activePresetJobId = String(jobId);
  if (label) activePresetJobLabel = String(label);
  ensureJobSelectOption(activePresetJobId, safeLabel);
  const jobSelect = document.getElementById('job-select');
  if (jobSelect) jobSelect.value = activePresetJobId;
  persistActivePresetJobId();
}

function setPresetNote(text, color) {
  const note = document.getElementById('preset-note');
  if (!note) return;
  note.textContent = text;
  if (color) note.style.color = color;
}

let dockToastTimer = null;
function showDockToast(text, tone) {
  const el = document.getElementById('dock-toast');
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('hidden', 'is-ok', 'is-warn');
  if (tone === 'warn') el.classList.add('is-warn');
  else el.classList.add('is-ok');
  if (dockToastTimer) clearTimeout(dockToastTimer);
  dockToastTimer = setTimeout(() => {
    el.classList.add('hidden');
    el.textContent = '';
  }, 3500);
}

function collectJobPreset() {
  const hard = readHardConditions();
  const ageRangeValues = ageTierSelection();
  const requirements = {
    must: [],
    important: importantEditor.get(),
    nice: niceEditor.get()
  };
  const jobUnderstanding = readJobUnderstandingText();
  const specFields = MokaPersist.requirementsToJobSpecFields(requirements, hard);
  const jobSpec = lastJobSpec
    ? Object.assign({}, lastJobSpec, specFields)
    : Object.assign({}, specFields);
  // 招聘官编辑后的理解全文进入评分上下文
  if (jobUnderstanding) jobSpec.summary = jobUnderstanding;
  return MokaPersist.sanitizeJobPreset({
    jobType: document.querySelector('input[name="job-type"]:checked').value,
    assigneeConfirmedAt: currentAssigneeConfirmedAt,
    hard: Object.assign({}, hard, { ageRangeValues }),
    weights: readWeights(),
    requirements,
    focusKeywords: requirements.important,
    bonusKeywords: requirements.nice,
    jobUnderstanding,
    keywords: [],
    jobSpec
  });
}

function writeHardConditions(hard) {
  if (!hard) return;
  document.getElementById('cond-degree').value = hard.degree || '';
  document.getElementById('cond-exp').value = hard.exp || '';
  document.getElementById('cond-gender').value = hard.gender || '';
  document.getElementById('cond-internship').value = hard.internship || '';
  setCheckboxGroup('cond-school', hard.schools);
  // 年龄是 details 下拉壳 + 胶囊勾选（原生 select multiple 会渲染成常开列表框），
  // 必须用 setAgeTierOptions 复位勾选与按钮文案；setMultiSelectOptions 已随迁移删除，
  // 若沿用旧调用会在写入门槛后抛 ReferenceError，导致重点看/岗位理解整段恢复被中断。
  setAgeTierOptions(hard.ageRangeValues || []);
  languageEditor.set(hard.languages || []);
  customGateEditor.set(hard.customGates || []);
}

function readJobUnderstandingText() {
  const box = document.getElementById('jd-understanding');
  if (!box || box.classList.contains('hidden')) return '';
  const dutyEl = box.querySelector('.jd-summary');
  const skillEl = box.querySelector('.jd-skills');
  const duty = dutyEl
    ? String(dutyEl.textContent || '').replace(/^岗位理解[：:]\s*/, '').trim()
    : '';
  const skills = skillEl
    ? String(skillEl.textContent || '').trim()
    : '';
  if (window.MokaPersist && MokaPersist.composeJobUnderstandingText) {
    return MokaPersist.composeJobUnderstandingText({ duty, skill: skills });
  }
  return duty + (skills ? (duty && !/[。！？]$/.test(duty) ? '。' : '') + skills : '');
}

function setJobUnderstandingParts(duty, skills, noteText) {
  const box = document.getElementById('jd-understanding');
  const note = document.getElementById('understanding-note');
  let d = String(duty || '').trim().replace(/^岗位理解[：:]\s*/, '');
  let sk = String(skills || '').trim();
  if (!sk && /(?:需要|要求|须)具备/.test(d) && window.MokaPersist && MokaPersist.parseJobUnderstandingText) {
    const p = MokaPersist.parseJobUnderstandingText(d);
    d = p.duty || d;
    sk = p.skill || '';
  }
  if (!box) return;
  if (!d && !sk) {
    box.classList.add('hidden');
    box.innerHTML = '';
  } else {
    box.classList.remove('hidden');
    box.innerHTML = '';
    if (d) {
      const s = document.createElement('div');
      s.className = 'jd-summary';
      s.textContent = '岗位理解：' + d;
      box.appendChild(s);
    }
    if (sk) {
      const k = document.createElement('div');
      k.className = 'jd-skills';
      k.textContent = sk.indexOf('需要具备') === 0 || sk.indexOf('要求具备') === 0
        ? sk
        : ('需要具备：' + sk.replace(/^需要具备[：:]?\s*/, ''));
      box.appendChild(k);
    }
  }
  if (note && noteText != null) {
    note.textContent = noteText;
    note.style.color = '#8c8c8c';
  }
}

function setJobUnderstandingText(text, noteText) {
  if (window.MokaPersist && MokaPersist.parseJobUnderstandingText) {
    const p = MokaPersist.parseJobUnderstandingText(text);
    setJobUnderstandingParts(p.duty, p.skill, noteText);
    return;
  }
  setJobUnderstandingParts(text, '', noteText);
}

function hasJobUnderstandingContent() {
  return !!readJobUnderstandingText();
}

/** 用 JD 画像刷新理解区：职责摘要 + 由清单拼出的「需要具备」 */
function applyJobUnderstandingFromSpec(spec, noteText) {
  if (window.MokaPersist && MokaPersist.formatJobUnderstandingParts) {
    const parts = MokaPersist.formatJobUnderstandingParts(spec);
    setJobUnderstandingParts(parts.duty, parts.skills, noteText);
    return;
  }
  setJobUnderstandingText(String((spec && spec.summary) || ''), noteText);
}

function applyRequirementsToEditors(requirements) {
  const req = MokaPersist.normalizeRequirements({ requirements: requirements || {} });
  importantEditor.set(req.important || []);
  niceEditor.set(req.nice || []);
}

function applyJobPreset(preset) {
  if (!preset) return false;
  applyingPreset = true;
  try {
    const type = document.querySelector('input[name="job-type"][value="' + preset.jobType + '"]');
    if (type) type.checked = true;
    applyJobTypeVisibility();
    writeHardConditions(preset.hard);
    // 只认本岗存档的 jobSpec，绝不用上一岗残留的 lastJobSpec
    lastJobSpec = preset.jobSpec || null;
    currentAssigneeConfirmedAt = Number(preset.assigneeConfirmedAt) || 0;
    let req = preset.requirements || { must: preset.mustHaves || [], important: [], nice: [] };
    if ((!req.important || !req.important.length || !req.nice || !req.nice.length) && preset.jobSpec) {
      req = MokaPersist.fillRequirementsFromJobSpec(req, preset.jobSpec);
    }
    applyRequirementsToEditors(req);
    setWeights(preset.weights);
    if (preset.jobSpec && window.MokaPersist && MokaPersist.formatJobUnderstandingParts) {
      applyJobUnderstandingFromSpec(preset.jobSpec, '已恢复本岗理解');
    } else {
      setJobUnderstandingText(String(preset.jobUnderstanding || '').trim(), '已恢复本岗理解');
    }
  } finally {
    // 无论恢复过程是否抛错都要解锁：卡在 true 会让之后的保存/自动保存全部被拒
    applyingPreset = false;
  }
  // 职位名含「实习」等强信号时以名字校正职位类型：串档/旧档可能把实习生的存档
  // 带上「正式员工」，恢复后必须拉回实习生，否则经验/实习行显示与筛选口径全错
  if (reconcileJobTypeWithLabel(activePresetJobLabel)) scheduleSaveJobPreset();
  return true;
}

// v3.3.0：JOB_PRESET_STORAGE_KEY 统一写入口（串行队列）——「保存筛选条件/自动保存」
// 与「确认推荐对象盖章」此前各自 get→改→set，并发时确认章或整份存档可被对方覆盖。
// 所有对该 key 的写入一律走这里，mutator 拿到最新整包记录、返回下一份整包记录
let jobPresetWriteQueue = Promise.resolve();
function writeJobPresetRecord(mutator) {
  const run = jobPresetWriteQueue.then(() => {
    const key = MokaPersist.JOB_PRESET_STORAGE_KEY;
    return chrome.storage.local.get(key).then((res) => {
      const next = mutator(res[key] || {});
      return chrome.storage.local.set({ [key]: next }).then(() => next);
    });
  });
  jobPresetWriteQueue = run.catch(() => {});
  return run;
}

function saveJobPresetFor(jobId, opts) {
  if (applyingPreset || !window.MokaPersist) return Promise.resolve(false);
  const id = MokaPersist.jobPresetKey(jobId);
  if (!id) return Promise.resolve(false);
  // 跨岗防污染：只允许把「当前装在表单里的这份配置」存回它自己对应的职位。
  // 表单没绑定职位（本会话从未加载过存档，存下去会用空表单覆盖真存档）
  // 或绑定的是别的职位（快速切岗时把 A 岗内容写进 B 岗）时，一律拒绝落盘。
  if (!presetFormJobId || String(presetFormJobId) !== id) {
    lastPresetSaveBlock = { at: Date.now(), wanted: id, formHolds: String(presetFormJobId || '') };
    return Promise.resolve(false);
  }
  return writeJobPresetRecord((record) => {
    // 盖上「当前职位」身份锚点：jobId 是存档 key，职位名是刷新后 jobId 漂移时的兜底索引。
    // 不依赖「按 JD 刷新」产物——纯手配门槛/关键词的存档也要能按名找回。
    const raw = collectJobPreset();
    raw.jobIdAnchor = id;
    // 职位名锚默认取下拉当前项；但切岗「保存离开岗」时必须由调用方显式传旧岗名
    // （opts.label）——否则此刻下拉已切到新岗，会把新岗名盖到旧岗存档的 key 上，
    // 造成 A↔B 交叉错位、恢复按名兜底时串岗/命中空壳。
    const label = (opts && opts.label) || currentJobLabel() || activePresetJobLabel || '';
    if (label) raw.jobNameAnchor = String(label).trim();
    return MokaPersist.putJobPreset(record, id, raw, Date.now());
  }).then(() => {
    setPresetNote('已保存本岗配置，下次打开会自动填充', '#52c41a');
    return true;
  });
}

function saveCurrentJobPreset() {
  return saveJobPresetFor(currentJobId() || effectiveJobId());
}

async function saveJobPresetFromButton(opts) {
  const options = opts || {};
  const jobId = currentJobId() || effectiveJobId();
  if (!jobId) {
    setPresetNote('请先选择职位后再保存筛选条件', '#fa8c16');
    showDockToast('请先选择职位后再保存', 'warn');
    return;
  }
  const btn = document.getElementById('save-job-preset');
  if (btn) btn.disabled = true;
  try {
    const ok = await saveJobPresetFor(jobId);
    if (ok) {
      const okNote = options.okNote || '已保存当前筛选条件，下次进入本岗将自动填充';
      const okToast = options.okToast || '保存成功，下次进入本岗将自动填充';
      setPresetNote(okNote, '#52c41a');
      showDockToast(okToast, 'ok');
    } else {
      const blk = lastPresetSaveBlock && (Date.now() - lastPresetSaveBlock.at < 3000) ? lastPresetSaveBlock : null;
      if (blk) {
        setPresetNote('已拦截一次跨岗保存：表单当前装的是「' + (blk.formHolds || '未绑定职位') + '」的配置，'
          + '拒绝覆盖目标职位的存档；请确认职位下拉与表单内容一致后再保存', '#fa8c16');
        showDockToast('已拦截跨岗保存（表单与目标职位不一致）', 'warn');
      } else {
        setPresetNote('保存失败，请稍后重试', '#fa8c16');
        showDockToast('保存失败，请稍后重试', 'warn');
      }
    }
  } catch (e) {
    setPresetNote('保存失败，请稍后重试', '#fa8c16');
    showDockToast('保存失败，请稍后重试', 'warn');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function presetHasUsableContent(p) {
  if (!p || typeof p !== 'object') return false;
  const h = p.hard || {};
  if (h.degree || (h.schools && h.schools.length) || h.exp || h.gender || h.internship
    || (h.ageRangeValues && h.ageRangeValues.length)
    || (h.languages && h.languages.length) || (h.customGates && h.customGates.length)) return true;
  const r = p.requirements || {};
  if ((r.must && r.must.length) || (r.important && r.important.length) || (r.nice && r.nice.length)) return true;
  if (Array.isArray(p.focusKeywords) && p.focusKeywords.length) return true;
  if (String(p.jobUnderstanding || '').trim()) return true;
  if (p.jobSpec && window.MokaPersist && MokaPersist.jobSpecIsUsable) {
    return !!MokaPersist.jobSpecIsUsable(p.jobSpec);
  }
  return false;
}

function restoreCurrentJobPreset() {
  if (!window.MokaPersist) return Promise.resolve(false);
  const jobId = currentJobId();
  if (!jobId) {
    // 没识别到职位身份就谈不上去查存档：留诊断 + 状态行提示，别让「没恢复」看起来像「没保存」
    lastPresetRestoreDiag = { at: Date.now(), hit: 'no-job', targetJobId: '', label: String(activePresetJobLabel || ''), rows: [] };
    window.__mokaPresetRestoreDiag = lastPresetRestoreDiag;
    setPresetNote('未识别到当前职位（jobId 为空），本次未尝试恢复存档；请回到该职位的候选人列表页', '#fa8c16');
    return Promise.resolve(false);
  }
  const key = MokaPersist.JOB_PRESET_STORAGE_KEY;
  return chrome.storage.local.get(key).then((res) => {
    const record = res[key] || {};
    let preset = MokaPersist.getJobPreset(record, jobId);
    presetFormJobId = String(jobId);
    // 恢复诊断：目标身份 + 全部存档行（key/锚点名/时间），未命中时状态行直接给摘要
    const diag = {
      at: Date.now(),
      hit: 'none',
      targetJobId: String(jobId),
      label: String(activePresetJobLabel || ''),
      rows: []
    };
    Object.keys(record || {}).forEach((rowKey) => {
      const row = record[rowKey] || {};
      const clean = MokaPersist.sanitizeJobPreset(row.value);
      diag.rows.push({
        key: String(rowKey),
        savedAt: Number(row.savedAt) || 0,
        name: (clean && (clean.jobNameAnchor || (clean.jobSpec && clean.jobSpec.sourceJobName))) || '',
        hasSpec: !!(clean && clean.jobSpec)
      });
    });
    // 串档防线：键对得上但身份锚是别的职位（快速切岗期间被污染的存档），
    // 绝不能自动填进当前岗——落到同名兜底或未保存提示，等用户重新配置保存覆盖。
    let mismatchName = '';
    if (preset) {
      const anchorName = String(preset.jobNameAnchor
        || (preset.jobSpec && preset.jobSpec.sourceJobName) || '').trim();
      const wanted = String(activePresetJobLabel || '').trim();
      if (anchorName && wanted && anchorName !== wanted) {
        mismatchName = anchorName;
        preset = null;
      }
    }
    // 同职位的存档找不到时，兜底按「职位名」找回一份：
    // 同一职位在不同入口/管道下 jobId 可能不同（存档仍在，只是键对不上），
    // 同名存档可能有多份（旧 id 与当前 id 各存过），优先取「有可用内容」的
    // 最新一份；全为空壳才退回最新空档（交给下方空壳防线统一处理），
    // 避免「已保存却变回初始」。
    let byName = false;
    let bestUsable = null;
    let bestAny = null;
    if (!preset && activePresetJobLabel) {
      const wantedName = String(activePresetJobLabel).trim();
      diag.rows.forEach((rowDiag) => {
        if (!rowDiag.name || rowDiag.name.trim() !== wantedName) return;
        const cand = MokaPersist.getJobPreset(record, rowDiag.key);
        if (!cand) return;
        if (presetHasUsableContent(cand)) {
          if (!bestUsable || rowDiag.savedAt > bestUsable.rowDiag.savedAt) bestUsable = { rowDiag, cand };
        } else if (!bestAny || rowDiag.savedAt > bestAny.rowDiag.savedAt) {
          bestAny = { rowDiag, cand };
        }
      });
      const pick = bestUsable || bestAny;
      if (pick) {
        preset = pick.cand;
        byName = true;
      }
    }
    // 空壳存档防线：命中的存档若是纯空档（没有门槛/关键词/理解，jobSpec 也不可用），
    // 恢复它只会显示一张空表单，还会挡住「首次进入自动生成理解」——历史事故中
    // 交叉盖错锚名/被空表单覆盖的存档正是这种空壳。命中空壳一律视为「未恢复」，
    // 让 ensureJobUnderstandingOnEnter 走首次进入路径重新生成并保存。
    let emptyHit = false;
    let emptyPresetAssigneeAt = 0;
    if (preset && !presetHasUsableContent(preset)) {
      emptyHit = true;
      emptyPresetAssigneeAt = Number(preset.assigneeConfirmedAt) || 0;
      preset = null;
    }
    diag.hit = preset ? (byName ? 'name' : 'exact')
      : (mismatchName ? 'anchor-mismatch' : (emptyHit ? 'empty' : 'none'));
    if (mismatchName) diag.mismatchName = mismatchName;
    if (emptyHit) diag.emptyHit = true;
    lastPresetRestoreDiag = diag;
    window.__mokaPresetRestoreDiag = diag;
    if (!preset) {
      resetJobPresetForm({ internSuggested: /实习/.test(activePresetJobLabel || '') });
      // 空壳命中不算「未保存」：保留原确认章，后续自动生成落盘不会丢
      if (emptyHit && emptyPresetAssigneeAt) currentAssigneeConfirmedAt = emptyPresetAssigneeAt;
      const wantedName = String(activePresetJobLabel || '').trim();
      const sameName = diag.rows.filter((r) => r.name && r.name.trim() === wantedName).length;
      const emptyTip = emptyHit
        ? '；检测到本岗存档是空档（没有门槛/关键词/理解），将按首次进入自动重新生成并保存'
        : '';
      const mismatchTip = mismatchName
        ? '；发现一条键匹配但身份不符（锚名「' + mismatchName + '」）的存档，已拒绝填充——请重新配置本岗后点「保存当前筛选条件」覆盖它'
        : '';
      setPresetNote('本岗尚未保存可用配置。首次会自动生成理解并保存。'
        + '（诊断：存档 ' + diag.rows.length + ' 条，目标「' + (diag.label || diag.targetJobId || '?') + '」'
        + '/id 尾 ' + String(diag.targetJobId).slice(-6) + '，同名命中 ' + sameName + '）'
        + emptyTip + mismatchTip, '#fa8c16');
      return false;
    }
    // 岗位理解盖章来自其它职位 ≠ 这份存档不是本岗的：存档键就是职位身份。
    // 门槛/关键词是招聘官按本岗手配的，绝不能因为理解戳对不上就整表清空。
    const crossJob = byName ? false : (MokaPersist.jobSpecMatchesJob
      && !MokaPersist.jobSpecMatchesJob(preset.jobSpec, jobId));
    try {
      applyJobPreset(preset);
    } catch (e) {
      // 恢复渲染中途抛错（如字段渲染异常）不能静默中断链路：
      // 记录诊断并把结果降级为「未恢复」，让 ensureJobUnderstandingOnEnter 兜底提示
      diag.applyError = String((e && e.message) || e);
      lastPresetRestoreDiag = diag;
      window.__mokaPresetRestoreDiag = diag;
      resetJobPresetForm({ internSuggested: /实习/.test(activePresetJobLabel || '') });
      setPresetNote('自动填充本岗配置时出错（' + diag.applyError + '），已重置表单；请重新配置后点「保存当前筛选条件」', '#fa8c16');
      return false;
    }
    if (byName) {
      setPresetNote('已按同名职位恢复本岗配置（存档职位与当前职位 id 不同，条件已带出）', '#52c41a');
    } else if (crossJob) {
      // 只提示，不抹数据：理解若确属别的岗位，点「按 JD 刷新」会按本岗重解读并落盘
      setPresetNote('已自动填充本岗配置；其中的岗位理解来自其它职位，若理解不对请点「按 JD 刷新」', '#fa8c16');
    } else {
      // 老存档没记来源职位，验不了是不是本岗的，得让用户知道可以一键重解读
      const unstamped = !!preset.jobSpec && !preset.jobSpec.sourceJobId;
      setPresetNote(
        unstamped
          ? '已自动填充本岗配置（旧存档，理解若不是本岗请点「按 JD 刷新」）'
          : '已自动填充本岗配置',
        '#52c41a'
      );
    }
    // 空栏补全已在 applyJobPreset 内仅用本岗 preset.jobSpec 完成，此处不再用全局 lastJobSpec
    if (hasJobUnderstandingContent()) {
      setJobUnderstandingText(
        readJobUnderstandingText(),
        '已恢复本岗理解'
      );
    }
    return true;
  });
}

/**
 * 进入本岗的稳定性规则（岗位理解一经确认，不再每次进入都重新解读）：
 * - 理解区已有内容 → 直接保留，什么都不做；
 * - 本岗已保存过配置（hadSavedPreset=true，含只手配过门槛/关键词、从未生成理解的职位）
 *   → 绝不自动重解读：能渲染就渲染存档摘要，否则只提示可手动点「按 JD 刷新」；
 * - 只有「真·首次进入」（本岗从未保存过任何配置）才解读 JD 并落盘（下次直接恢复）。
 * 冻结依据：本岗一经保存过配置即视为已确认，进岗不再静默调模型，防止每次进来都
 * 重新理解一遍、或用新解读整表覆盖招聘官手配的重点看/加分看清单。
 */
async function ensureJobUnderstandingOnEnter(hadSavedPreset) {
  if (!currentJobId() && !effectiveJobId()) return false;
  if (hasJobUnderstandingContent()) return false;
  const jobId = currentJobId() || effectiveJobId();
  if (hadSavedPreset) {
    // 存档里已有可渲染字段时先补渲染摘要（不打 AI）
    if (lastJobSpec && (lastJobSpec.summary || lastJobSpec.responsibilities || lastJobSpec.importantHaves)) {
      applyingPreset = true;
      try {
        applyJobUnderstandingFromSpec(lastJobSpec, '已从本岗存档恢复岗位理解');
        const built = MokaPersist.buildRequirementsFromJobSpec
          ? MokaPersist.buildRequirementsFromJobSpec(lastJobSpec)
          : MokaPersist.fillRequirementsFromJobSpec({ must: [], important: [], nice: [] }, lastJobSpec);
        applyRequirementsToEditors(built, readHardConditions());
      } finally {
        applyingPreset = false;
      }
    }
    if (hasJobUnderstandingContent()) {
      await saveJobPresetFor(jobId);
      return true;
    }
    const note = document.getElementById('understanding-note');
    if (note) {
      note.textContent = '本岗已保存过配置但没有岗位理解；如确需按 JD 解读请点「按 JD 刷新」，不会再自动重解读';
      note.style.color = '#8c8c8c';
    }
    return false;
  }
  // 真·首次进入（本岗从未保存过任何配置）：解读一次并自动落盘，之后进岗直接恢复
  const ok = await refreshUnderstandingAndRequirements({
    silentNote: '正在生成本岗理解…',
    doneNote: '已自动生成本岗理解并保存，下次进入直接恢复',
    autoSave: true,
    replaceRequirements: true
  });
  return !!ok;
}

function scheduleSaveJobPreset() {
  if (applyingPreset) return;
  clearTimeout(savePresetTimer);
  savePresetTimer = setTimeout(() => { saveCurrentJobPreset(); }, 400);
}

// 方案 D：表单改动不自动落盘，只认「保存当前筛选条件」与开筛前落盘

// 仅生成建议权重（岗位理解已上移到「岗位理解」区）
async function loadJobSpec() {
  const note = document.getElementById('weight-note');
  const btn = document.getElementById('suggest-weights');
  const apiKey = document.getElementById('api-key').value;
  if (!apiKey) {
    note.textContent = '（配置 API 后可点击按 JD 生成建议权重）';
    note.style.color = '#fa8c16';
    return;
  }

  const tab = await getMokaTab();
  if (!isMokaTab(tab)) return;

  note.textContent = '（正在解读 JD 生成建议权重…）';
  note.style.color = '#1890ff';
  if (btn) btn.disabled = true;

  const specJobId = currentJobId() || effectiveJobId();
  chrome.tabs.sendMessage(tab.id, {
    action: 'getJobSpec',
    jobType: document.querySelector('input[name="job-type"]:checked').value,
    jobId: specJobId
  }, (response) => {
    if (btn) btn.disabled = false;
    if (chrome.runtime.lastError) {
      note.textContent = '（未能解读 JD，可手动调整权重）';
      note.style.color = '#fa8c16';
      return;
    }
    const spec = response && response.spec;
    if (!spec) {
      note.textContent = '（未能解读 JD：'
        + ((response && response.error) || '请回到候选人列表页后重试，或先跑一轮筛选')
        + '）';
      note.style.color = '#fa8c16';
      return;
    }
    lastJobSpec = spec;
    setWeights(spec.suggestedWeights);
    if (!readJobUnderstandingText()) applyJobUnderstandingFromSpec(spec);
    note.textContent = '（已按 JD 生成建议权重，可再手动调整；未点保存则开筛时会自动保存）';
    note.style.color = '#52c41a';
  });
}

/**
 * 界面上摆着的理解若能证明来自别的职位，就整表清掉。
 * 判不出来源（老存档没盖章）时什么都不做，别误清招聘官手配的条件。
 */
function clearCrossJobUnderstanding(jobId) {
  if (!window.MokaPersist || !MokaPersist.jobSpecMatchesJob) return false;
  if (MokaPersist.jobSpecMatchesJob(lastJobSpec, jobId)) return false;
  resetJobPresetForm({ internSuggested: /实习/.test(activePresetJobLabel || '') });
  return true;
}

/** 刷新岗位理解 + 预填必须/重要/加分；opts.autoSave 时落盘以便下次免刷新 */
function refreshUnderstandingAndRequirements(opts) {
  const options = opts || {};
  const note = document.getElementById('understanding-note');
  const btn = document.getElementById('refresh-job-understanding');
  const apiKey = document.getElementById('api-key').value;
  if (!apiKey) {
    if (note) {
      note.textContent = '请先在设置里配置 API Key';
      note.style.color = '#fa8c16';
    }
    return Promise.resolve(false);
  }
  return getMokaTab().then((tab) => {
    if (!isMokaTab(tab)) {
      if (note) {
        note.textContent = '请在 Moka 候选人列表页操作';
        note.style.color = '#fa8c16';
      }
      return false;
    }
    if (note) {
      note.textContent = options.silentNote || '正在解读 JD…';
      note.style.color = '#1890ff';
    }
    if (btn) btn.disabled = true;
    const jobType = document.querySelector('input[name="job-type"]:checked').value;
    const targetJobId = currentJobId() || effectiveJobId();
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'getJobSpec', jobType, jobId: targetJobId }, (response) => {
        if (btn) btn.disabled = false;
        // 等模型回话这段时间里岗位被切走了：这份理解属于上一个岗，丢掉
        if ((currentJobId() || effectiveJobId()) !== targetJobId) {
          resolve(false);
          return;
        }
        if (chrome.runtime.lastError || !response || !response.spec) {
          const cleared = clearCrossJobUnderstanding(targetJobId);
          if (note) {
            note.textContent = '未能解读 JD：'
              + ((response && response.error) || chrome.runtime.lastError && chrome.runtime.lastError.message || '请重试')
              + (cleared ? '；已清掉界面上其它职位的理解' : '');
            note.style.color = '#fa8c16';
          }
          resolve(false);
          return;
        }
        const spec = response.spec;
        // 空壳 spec 会把语言/门槛/重点看/加分看整表覆盖成空并落盘，这里必须先拦住
        if (window.MokaPersist && !MokaPersist.jobSpecIsUsable(spec)) {
          const cleared = clearCrossJobUnderstanding(targetJobId);
          if (note) {
            note.textContent = cleared
              ? '未能解读 JD：模型这次没返回岗位信息；界面上其它职位的理解已清掉，请稍后重试'
              : '未能解读 JD：模型这次没返回岗位信息，请稍后重试；原有配置未改动';
            note.style.color = '#fa8c16';
          }
          resolve(false);
          return;
        }
        lastJobSpec = spec;
        const hard = readHardConditions();
        applyingPreset = true;
        try {
          const replace = options.replaceRequirements !== false;
          if (replace && Array.isArray(spec.mustHaves)) {
            const split = MokaMatch.splitMustHavesForHard(spec.mustHaves, hard);
            languageEditor.set(split.languages || []);
            customGateEditor.set(split.customGates || []);
          }
          const built = replace && MokaPersist.buildRequirementsFromJobSpec
            ? MokaPersist.buildRequirementsFromJobSpec(spec)
            : MokaPersist.fillRequirementsFromJobSpec(
              {
                must: [],
                important: importantEditor.get(),
                nice: niceEditor.get()
              },
              spec
            );
          applyRequirementsToEditors(built, hard);
        } finally {
          applyingPreset = false;
        }
        applyJobUnderstandingFromSpec(
          spec,
          options.doneNote || (options.replaceRequirements === false
            ? '已写入岗位理解并预填空栏要求'
            : '已按 JD 更新岗位理解与要求清单')
        );
        // 兜底：理解区没渲染出内容时不能报「已生成」，否则用户只看到一句绿字
        if (!hasJobUnderstandingContent()) {
          if (note) {
            note.textContent = '已解读 JD，但没能生成岗位理解摘要，请点「按 JD 刷新」重试';
            note.style.color = '#fa8c16';
          }
          resolve(false);
          return;
        }
        // 联动：硬性门槛（学历/院校/经验/性别/实习/语言等）也按 JD 识别预设，
        // 与岗位理解同源——一次刷新，理解、硬性门槛、筛选关键词全部就位
        prefillHardFromJD().then((bits) => {
          const baseNote = options.doneNote || (options.replaceRequirements === false
            ? '已写入岗位理解并预填空栏要求'
            : '已按 JD 更新岗位理解与要求清单');
          if (note) {
            note.textContent = baseNote
              + (bits && bits.length ? '；已联动预填硬性门槛：' + bits.join('、') : '');
            note.style.color = '#52c41a';
          }
          const afNote = document.getElementById('autofill-note');
          if (afNote) {
            afNote.textContent = bits && bits.length
              ? '已随「按 JD 刷新」联动预填：' + bits.join('、') + '，可再改'
              : '该 JD 未写明硬性条件，可手动设置';
            afNote.style.color = bits && bits.length ? '#52c41a' : '#fa8c16';
          }
          const finish = () => resolve(true);
          if (options.autoSave) {
            saveJobPresetFor(targetJobId).then(finish).catch(finish);
          } else {
            finish();
          }
        });
      });
    });
  });
}

document.getElementById('refresh-job-understanding')?.addEventListener('click', () => {
  refreshUnderstandingAndRequirements({
    doneNote: '已按 JD 重写理解与要求清单并保存',
    autoSave: true,
    replaceRequirements: true
  });
});

/* ==================== 连接配置：接口协议 + 自由提供商 + 预设 ====================
 * 四项（协议 / 提供商 / Endpoint / Key / 模型）都可自由填写：
 * - 接口协议是唯一硬约束（决定请求体、鉴权头、响应解析），只有 OpenAI 兼容 / Anthropic 两个值；
 * - 提供商仅作标签与预设入口，填什么都行；
 * - Endpoint 常显可编辑；Key 与模型名本就是文本框。
 */
const API_PRESETS = [
  { name: 'OpenAI', protocol: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o' },
  { name: 'Anthropic Claude', protocol: 'claude', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-sonnet-latest' },
  { name: 'DeepSeek', protocol: 'openai', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'MiniMax', protocol: 'openai', endpoint: 'https://api.minimaxi.com/v1', model: 'MiniMax-M2.7' },
  { name: '阿里通义千问', protocol: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '智谱 GLM', protocol: 'openai', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { name: '本地 Ollama', protocol: 'openai', endpoint: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  { name: '自建 / 中转网关', protocol: 'openai', endpoint: '', model: '' }
];

const PROTOCOL_DEFAULT_ENDPOINT = {
  openai: 'https://api.openai.com/v1/chat/completions',
  claude: 'https://api.anthropic.com/v1/messages'
};

/** 协议切换时更新 Endpoint 占位；地址为空则顺手填上该协议的默认地址 */
function syncEndpointPlaceholder() {
  const protocolEl = document.getElementById('api-protocol');
  const endpointEl = document.getElementById('api-endpoint');
  if (!protocolEl || !endpointEl) return;
  const protocol = protocolEl.value === 'claude' ? 'claude' : 'openai';
  const fallback = PROTOCOL_DEFAULT_ENDPOINT[protocol];
  endpointEl.placeholder = fallback;
  if (!endpointEl.value.trim()) endpointEl.value = fallback;
}

/** 预填选项：数据源是 API_PRESETS，HTML 里只留一个空 datalist */
function fillProviderPresets() {
  const list = document.getElementById('api-provider-presets');
  if (!list) return;
  list.textContent = '';
  API_PRESETS.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.name;
    list.appendChild(opt);
  });
}

/** 选中/输入到预设名时，把协议、Endpoint、模型名一并填好（用户之后仍可手改）
 *  预设未提供 Endpoint/模型（如「自建 / 中转网关」）时保持原值不动，避免清空用户已填内容 */
function applyApiPreset(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return;
  const preset = API_PRESETS.find((p) => p.name.toLowerCase() === key);
  if (!preset) return;
  const protocolEl = document.getElementById('api-protocol');
  const endpointEl = document.getElementById('api-endpoint');
  const modelEl = document.getElementById('model-name');
  if (protocolEl) protocolEl.value = preset.protocol;
  if (endpointEl && preset.endpoint) {
    endpointEl.value = preset.endpoint;
    endpointEl.placeholder = preset.endpoint;
  }
  if (modelEl && preset.model) modelEl.value = preset.model;
}

/** 老配置的 provider 值（openai/claude/custom）迁移成显示名；已是自由文本则原样保留 */
function providerLabelFromLegacy(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return '';
  const map = { openai: 'OpenAI', claude: 'Anthropic Claude', custom: '自建 / 中转网关' };
  return map[v.toLowerCase()] || v;
}

safeEl('api-protocol')?.addEventListener('change', syncEndpointPlaceholder);
safeEl('api-provider')?.addEventListener('input', (e) => applyApiPreset(e.target.value));

// API Key 显示/隐藏切换（图标用 CSS 切换睁眼/闭眼，不再操作 emoji 文本）
safeEl('toggle-api-key')?.addEventListener('click', function () {
  const apiKeyInput = document.getElementById('api-key');
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    this.classList.add('is-visible');
  } else {
    apiKeyInput.type = 'password';
    this.classList.remove('is-visible');
  }
});

/* 本地私有配置（config.local.js，已 gitignore）：
 * - 接口协议 / API 提供商 / Endpoint / 模型名四项：锁为本地部署值（置灰不可改，后台也强制覆盖），避免误改；
 * - 其余（单价、并发等）只作默认值兜底：本地没写才用，写过的以设置页为准，随时可改。
 * 排序与后台一致：DEFAULT_SETTINGS < 本地配置 < 存储里的设置。 */
const LOCAL_DEFAULTS = (typeof window !== 'undefined' && window.MOKA_LOCAL_SETTINGS) ? window.MOKA_LOCAL_SETTINGS : {};

const LOCAL_LOCK_MAP = { apiProtocol: 'api-protocol', apiProvider: 'api-provider', apiEndpoint: 'api-endpoint', modelName: 'model-name' };
const PROTOCOL_LABELS = { openai: 'OpenAI 兼容（/chat/completions）', claude: 'Anthropic Claude（/v1/messages）' };

/** 四项部署信息是否齐全：齐全才算「部署模式」，面板收成「摘要条 + API Key」 */
function localSettingsComplete() {
  return Object.keys(LOCAL_LOCK_MAP).every((k) => LOCAL_DEFAULTS[k] != null && String(LOCAL_DEFAULTS[k]).trim() !== '');
}

/** 部署模式：隐藏四个输入框，改用只读摘要条展示部署信息（招聘者只需填 API Key，1.10.0） */
function applyDeploySummaryView() {
  const strip = document.getElementById('local-deploy-summary');
  if (!strip || !localSettingsComplete()) return;
  const manual = document.getElementById('conn-manual-fields');
  if (manual) manual.hidden = true;
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('deploy-model', LOCAL_DEFAULTS.modelName);
  set('deploy-provider', providerLabelFromLegacy(LOCAL_DEFAULTS.apiProvider));
  set('deploy-protocol', PROTOCOL_LABELS[LOCAL_DEFAULTS.apiProtocol] || LOCAL_DEFAULTS.apiProtocol);
  set('deploy-endpoint', LOCAL_DEFAULTS.apiEndpoint);
  strip.hidden = false;
}

/** 锁定本地私有配置里的四项部署信息，并把面板切成极简模式（API Key 仍可自由修改） */
function lockLocalConnection() {
  if (!LOCAL_DEFAULTS || !Object.keys(LOCAL_DEFAULTS).length) return;
  Object.entries(LOCAL_LOCK_MAP).forEach(([k, id]) => {
    if (LOCAL_DEFAULTS[k] == null) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.value = k === 'apiProvider' ? providerLabelFromLegacy(LOCAL_DEFAULTS[k]) : LOCAL_DEFAULTS[k];
    el.disabled = true;
    el.title = '已由本地私有配置锁定，如需修改请编辑 config.local.js';
  });
  applyDeploySummaryView();
}

/** 锁定项一律取本地部署值；未锁定时用表单值（部署模式下输入框是隐藏的，也能读对） */
function lockedOr(key, formValue) {
  return LOCAL_DEFAULTS[key] != null ? LOCAL_DEFAULTS[key] : formValue;
}

function readSettingsForm() {
  const rawConcurrency = Number(document.getElementById('score-concurrency')?.value || 0);
  const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0
    ? Math.min(8, Math.max(1, Math.round(rawConcurrency)))
    : 6;
  return {
    apiProtocol: lockedOr('apiProtocol', document.getElementById('api-protocol')?.value === 'claude' ? 'claude' : 'openai'),
    apiProvider: lockedOr('apiProvider', document.getElementById('api-provider').value.trim()),
    apiEndpoint: lockedOr('apiEndpoint', document.getElementById('api-endpoint').value.trim()),
    apiKey: document.getElementById('api-key').value,
    modelName: lockedOr('modelName', document.getElementById('model-name').value.trim()),
    modelInputPrice: String(document.getElementById('model-input-price')?.value || '').trim(),
    modelOutputPrice: String(document.getElementById('model-output-price')?.value || '').trim(),
    // 默认开：网关不支持时后台自动降级，用户无感
    forceJsonMode: document.getElementById('force-json-mode')?.checked !== false,
    scoreConcurrency: concurrency,
    feishuAppId: String(document.getElementById('feishu-app-id')?.value || '').trim(),
    feishuAppSecret: String(document.getElementById('feishu-app-secret')?.value || '').trim(),
    feishuReceiver: String(document.getElementById('feishu-receiver')?.value || '').trim(),
    feishuSummaryNotify: document.getElementById('feishu-summary-notify')?.checked !== false
  };
}

// 从 endpoint 推导出 host 授权模式，如 https://your-relay.com/*
function originPatternFromUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * 确保后台有权限请求该 endpoint（中转/自建地址需按需授权）。
 * 必须在用户点击（手势）中调用。返回 true 表示已授权。
 */
async function ensureHostPermission(endpoint) {
  if (!endpoint) return true; // 走 openai/claude 默认地址，已在 host_permissions 中
  const pattern = originPatternFromUrl(endpoint);
  if (!pattern) return true;
  try {
    const has = await chrome.permissions.contains({ origins: [pattern] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch (e) {
    console.warn('权限请求失败:', e);
    return false;
  }
}

// 保存并测试：一次完成落盘 + 连接校验（中转地址仍需在弹窗里点「允许」）
safeEl('save-settings')?.addEventListener('click', async () => {
  const settings = readSettingsForm();

  if (!settings.apiKey) {
    showTestResult('❌ 请输入 API Key', 'error');
    return;
  }

  const granted = await ensureHostPermission(settings.apiEndpoint);
  if (!granted) {
    showTestResult('❌ 未授权访问该 API 地址，请在弹窗中点「允许」后重试', 'error');
    return;
  }

  try {
    await chrome.storage.local.set({ mokaSettings: settings });
  } catch (error) {
    showTestResult('❌ 保存失败: ' + error.message, 'error');
    return;
  }

  showTestResult('✅ 已保存 · 正在测试连接…', 'info');
  chrome.runtime.sendMessage({ action: 'testApi', settings }, (response) => {
    if (chrome.runtime.lastError) {
      showTestResult('✅ 已保存；连接测试未通过：' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (response && response.ok) {
      showTestResult('✅ 已保存 · API 连接成功', 'success');
    } else {
      showTestResult('✅ 已保存；连接测试未通过：' + (response?.error || 'API 连接失败'), 'error');
    }
  });
});

// Endpoint 从 1.8.9 起常显可编辑：OpenAI 官方、中转、自建、本地服务都可能是任意地址，
// 不再按提供商隐藏整组（旧的按提供商显隐那套逻辑已删除）。

function showTestResult(message, type) {
  const resultDiv = document.getElementById('test-result');
  resultDiv.textContent = message;
  resultDiv.className = `test-result ${type}`;
  resultDiv.classList.remove('hidden');

  if (type === 'success') {
    setTimeout(() => resultDiv.classList.add('hidden'), 3000);
  }
}

/* ==================== 运行日志面板（设置页） ==================== */
const LOG_CAT_META = {
  req: { label: '请求', cls: 'req' },
  adopt: { label: '推荐', cls: 'adopt' },
  screen: { label: '筛选', cls: 'screen' },
  score: { label: '评分', cls: 'score' },
  warn: { label: '警告', cls: 'warn' },
  err: { label: '错误', cls: 'err' },
  info: { label: '信息', cls: 'info' }
};
// 筛选按钮 → 命中的 cat 集合；「错误」含可恢复的重试警告
const LOG_FILTER_CATS = {
  all: null,
  req: ['req'],
  adopt: ['adopt'],
  screen: ['screen'],
  score: ['score'],
  err: ['warn', 'err']
};
const PLUGIN_LOG_LOCAL_MAX = 600; // background 环留 500（1.10.3），本地防御性多留一点

const pluginLogState = { entries: [], filter: 'all', paused: false, stick: true };
let logFlashTimer = null;

function logListEl() { return document.getElementById('log-list'); }
function logEmptyEl() { return document.getElementById('log-empty'); }
function logCountEl() { return document.getElementById('log-count'); }

function visibleLogEntries() {
  const cats = LOG_FILTER_CATS[pluginLogState.filter] || null;
  if (!cats) return pluginLogState.entries;
  return pluginLogState.entries.filter((e) => cats.indexOf(e.cat) !== -1);
}

function formatLogTime(at) {
  try {
    const d = new Date(Number(at) || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  } catch (e) {
    return '';
  }
}

function buildLogRow(entry) {
  const meta = LOG_CAT_META[entry.cat] || LOG_CAT_META.info;
  const row = document.createElement('div');
  row.className = 'log-row cat-' + meta.cls;
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = formatLogTime(entry.at);
  const badge = document.createElement('span');
  badge.className = 'log-badge cat-' + meta.cls;
  badge.textContent = meta.label;
  const text = document.createElement('span');
  text.className = 'log-text';
  text.textContent = entry.text || '';
  row.appendChild(time);
  row.appendChild(badge);
  row.appendChild(text);
  return row;
}

function updateLogCount() {
  const el = logCountEl();
  if (!el) return;
  const total = pluginLogState.entries.length;
  const visible = visibleLogEntries().length;
  el.textContent = total
    ? (visible === total ? `共 ${total} 条` : `共 ${total} 条 · 筛选后显示 ${visible} 条`)
    : '';
}

function isLogStick() {
  const list = logListEl();
  if (!list || !list.scrollHeight) return true;
  return list.scrollHeight - list.scrollTop - list.clientHeight < 24;
}

function renderPluginLog() {
  const list = logListEl();
  const empty = logEmptyEl();
  if (!list) return;
  list.textContent = '';
  const visible = visibleLogEntries();
  const frag = document.createDocumentFragment();
  visible.forEach((e) => frag.appendChild(buildLogRow(e)));
  list.appendChild(frag);
  if (empty) empty.classList.toggle('hidden', visible.length > 0);
  updateLogCount();
  if (pluginLogState.stick) list.scrollTop = list.scrollHeight;
}

/** 去掉折叠计数后缀（「地址 ×N」→「地址」），用于判定折叠更新作用于同一行 */
function collapseBaseText(text) {
  return String(text || '').replace(/ ×\d+$/, '');
}

function appendPluginLogEntry(entry, replaceTail) {
  if (!entry || !entry.cat || entry.text == null) return;
  const normalized = {
    at: Number(entry.at) || Date.now(),
    cat: String(entry.cat),
    text: String(entry.text).slice(0, 500)
  };
  // 折叠更新：后台把同一地址的重复请求合并进末行（×N 递增），这里原地改写末行，
  // 不追加新行——否则折叠就失去意义，面板照样被刷屏（1.10.4）
  const tail = pluginLogState.entries[pluginLogState.entries.length - 1];
  if (replaceTail && tail && tail.cat === normalized.cat
    && collapseBaseText(tail.text) === collapseBaseText(normalized.text)) {
    tail.text = normalized.text;
    tail.at = normalized.at;
    if (!pluginLogState.paused) {
      const cats = LOG_FILTER_CATS[pluginLogState.filter] || null;
      if (!cats || cats.indexOf(tail.cat) !== -1) {
        const list = logListEl();
        if (list && list.lastElementChild) {
          list.replaceChild(buildLogRow(tail), list.lastElementChild);
          if (pluginLogState.stick) list.scrollTop = list.scrollHeight;
        }
      }
    }
    updateLogCount();
    return;
  }
  pluginLogState.entries.push(normalized);
  while (pluginLogState.entries.length > PLUGIN_LOG_LOCAL_MAX) pluginLogState.entries.shift();
  if (pluginLogState.paused) { updateLogCount(); return; }
  const cats = LOG_FILTER_CATS[pluginLogState.filter] || null;
  if (!cats || cats.indexOf(normalized.cat) !== -1) {
    const list = logListEl();
    if (list) {
      const empty = logEmptyEl();
      if (empty) empty.classList.add('hidden');
      list.appendChild(buildLogRow(pluginLogState.entries[pluginLogState.entries.length - 1]));
      if (pluginLogState.stick) list.scrollTop = list.scrollHeight;
    }
  }
  updateLogCount();
}

function setLogFilter(cat) {
  pluginLogState.filter = cat || 'all';
  document.querySelectorAll('#log-filters .log-filter').forEach((b) => {
    b.classList.toggle('on', b.dataset.cat === pluginLogState.filter);
  });
  pluginLogState.stick = isLogStick();
  renderPluginLog();
}

async function flushContentLogQueues() {
  // 先让所有 Moka 页把 content 本地队列冲给 background，保证下面读取/清空不漏不残留
  try {
    const tabs = await chrome.tabs.query({ url: 'https://app.mokahr.com/*' });
    await Promise.all(tabs.map((t) => sendMessageToTab(t.id, { action: 'flushPluginLog' }).catch(() => null)));
  } catch (e) { /* 没有打开的 Moka 页时忽略 */ }
}

async function reloadPluginLog() {
  await flushContentLogQueues();
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getPluginLog' });
    if (resp && resp.ok && Array.isArray(resp.entries)) {
      pluginLogState.entries = resp.entries.slice(-PLUGIN_LOG_LOCAL_MAX);
    }
  } catch (e) { /* 拿不到就用当前内存 */ }
  pluginLogState.stick = true;
  renderPluginLog();
}

async function clearPluginLogPanel() {
  await flushContentLogQueues();
  try { await chrome.runtime.sendMessage({ action: 'clearPluginLog' }); } catch (e) { /* 忽略 */ }
  pluginLogState.entries = [];
  renderPluginLog();
}

function currentLogText() {
  return visibleLogEntries()
    .map((e) => '[' + formatLogTime(e.at) + '] ['
      + ((LOG_CAT_META[e.cat] || LOG_CAT_META.info).label) + '] ' + (e.text || ''))
    .join('\n');
}

function flashLogCount(message) {
  const el = logCountEl();
  if (!el) return;
  el.textContent = message;
  if (logFlashTimer) clearTimeout(logFlashTimer);
  logFlashTimer = setTimeout(updateLogCount, 2200);
}

async function copyCurrentLog() {
  const text = currentLogText();
  const n = visibleLogEntries().length;
  if (!text) { flashLogCount('暂无可复制的日志'); return; }
  try {
    await navigator.clipboard.writeText(text);
    flashLogCount(`已复制 ${n} 条`);
  } catch (err) {
    flashLogCount('复制失败：' + ((err && err.message) || '未知错误'));
  }
}

function exportCurrentLog() {
  const text = currentLogText();
  const n = visibleLogEntries().length;
  if (!text) { flashLogCount('暂无可导出的日志'); return; }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `moka-运行日志-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  flashLogCount(`已导出 ${n} 条`);
}

document.getElementById('log-filters')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.log-filter');
  if (btn && btn.dataset.cat) setLogFilter(btn.dataset.cat);
});
document.getElementById('log-pause')?.addEventListener('click', () => {
  pluginLogState.paused = !pluginLogState.paused;
  const btn = document.getElementById('log-pause');
  if (btn) {
    btn.classList.toggle('on', pluginLogState.paused);
    btn.setAttribute('aria-pressed', String(pluginLogState.paused));
    btn.title = pluginLogState.paused ? '继续跟读：恢复自动滚动' : '暂停跟读：新日志只入队、不自动滚动';
  }
  if (!pluginLogState.paused) renderPluginLog(); // 恢复后把暂停期间的新日志补绘
});
document.getElementById('log-clear')?.addEventListener('click', () => clearPluginLogPanel());
document.getElementById('log-copy')?.addEventListener('click', () => copyCurrentLog());
document.getElementById('log-export')?.addEventListener('click', () => exportCurrentLog());
logListEl()?.addEventListener('scroll', () => { pluginLogState.stick = isLogStick(); }, { passive: true });

// 排查快照：页面上下文 + 职位名映射 + 各职位分配存档摘要 + 完整请求流水，一键复制。
// （接口流水已并入快照：流水 ⊂ 快照，不再单独设「复制接口流水」按钮）
document.getElementById('copy-assignee-snapshot')?.addEventListener('click', async () => {
  const btn = document.getElementById('copy-assignee-snapshot');
  const resultDiv = document.getElementById('request-log-result');
  const show = (message, type) => {
    resultDiv.textContent = message;
    resultDiv.className = `test-result ${type}`;
    resultDiv.classList.remove('hidden');
    if (type === 'success') setTimeout(() => resultDiv.classList.add('hidden'), 4000);
  };
  const tab = await getMokaTab();
  if (!isMokaTab(tab)) {
    show('❌ 请先打开 Moka 候选人列表页', 'error');
    return;
  }
  if (btn) btn.disabled = true;
  const response = await sendMessageToTab(tab.id, { action: 'getAssigneeDiagnostics' });
  if (btn) btn.disabled = false;
  if (!response || !response.ok) {
    show('❌ 未取到快照：请刷新 Moka 页面后重试', 'error');
    return;
  }
  // 快照追加侧栏侧诊断：最近一次存档恢复的命中情况 + 全部职位存档的身份锚点清单。
  // 「保存了却不自动回填」类问题凭这一段即可定位（目标 id/名 vs 存档 key/锚名）。
  const presetRows = [];
  try {
    const storeKey = (window.MokaPersist && MokaPersist.JOB_PRESET_STORAGE_KEY) || 'mokaJobPresets';
    const storeRes = await chrome.storage.local.get(storeKey);
    const store = storeRes[storeKey] || {};
    Object.keys(store).forEach((rowKey) => {
      const row = store[rowKey] || {};
      const clean = window.MokaPersist ? MokaPersist.sanitizeJobPreset(row.value) : null;
      presetRows.push({
        key: String(rowKey),
        savedAt: Number(row.savedAt) || 0,
        anchorId: (clean && clean.jobIdAnchor) || '',
        anchorName: (clean && clean.jobNameAnchor) || '',
        hasJobSpec: !!(clean && clean.jobSpec),
        hardDegree: (clean && clean.hard && clean.hard.degree) || '',
        focusCount: clean && Array.isArray(clean.focusKeywords) ? clean.focusKeywords.length : 0,
        // 恢复渲染读的是 requirements.important，而非顶层 focusKeywords——两个数都打出来，
        // 避免再出现「focusCount 有值但表单回填空」时无法分辨存档里到底缺哪份
        reqImportant: clean && clean.requirements && Array.isArray(clean.requirements.important)
          ? clean.requirements.important.length : 0,
        hasUnderstanding: !!(clean && (clean.jobUnderstanding || (clean.jobSpec && clean.jobSpec.summary)))
      });
    });
  } catch (e) { /* 诊断失败不阻断快照 */ }
  presetRows.sort((a, b) => b.savedAt - a.savedAt);
  const dump = {
    page: response.page || {},
    map: response.map || {},
    captures: response.captures || [],
    log: Array.isArray(response.log) ? response.log : [],
    presetRestore: lastPresetRestoreDiag,
    presets: presetRows
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(dump, null, 2));
    show(`✅ 已复制排查快照（${dump.captures.length} 份存档 · ${dump.log.length} 条流水）`, 'success');
  } catch (error) {
    show('❌ 复制失败: ' + error.message, 'error');
  }
});

// 加载已保存设置
async function loadSettings() {
  try {
    const result = await chrome.storage.local.get('mokaSettings');
    // 1.9.0：本地私有配置只作默认值兜底——已保存的设置优先，界面全部可编辑
    const s = { ...LOCAL_DEFAULTS, ...(result.mokaSettings || {}) };
    // 1.8.9 迁移：老配置只有 apiProvider（openai/claude/custom），拆成「接口协议 + 提供商标签」
    const protocolEl = document.getElementById('api-protocol');
    if (protocolEl) {
      const legacyClaude = !s.apiProtocol && s.apiProvider === 'claude';
      protocolEl.value = (s.apiProtocol === 'claude' || legacyClaude) ? 'claude' : 'openai';
    }
    document.getElementById('api-provider').value = s.apiProvider ? providerLabelFromLegacy(s.apiProvider) : '';
    document.getElementById('api-endpoint').value = s.apiEndpoint
      || PROTOCOL_DEFAULT_ENDPOINT[(protocolEl && protocolEl.value) === 'claude' ? 'claude' : 'openai'];
    document.getElementById('api-key').value = s.apiKey || '';
    document.getElementById('model-name').value = s.modelName || 'gpt-4o';
    document.getElementById('model-input-price').value = s.modelInputPrice != null ? s.modelInputPrice : '';
    document.getElementById('model-output-price').value = s.modelOutputPrice != null ? s.modelOutputPrice : '';
    // 老配置没有这两个字段：按默认值回填（JSON 输出开、并发 6）
    const concurrencyEl = document.getElementById('score-concurrency');
    if (concurrencyEl) {
      const c = Number(s.scoreConcurrency);
      concurrencyEl.value = Number.isFinite(c) && c > 0 ? String(Math.min(8, Math.max(1, Math.round(c)))) : '6';
    }
    const jsonModeEl = document.getElementById('force-json-mode');
    if (jsonModeEl) jsonModeEl.checked = s.forceJsonMode !== false;
    // 自己存过非默认的高级参数（并发≠6 / 关掉 JSON / 填过单价）时自动展开，避免已改过的设置被折叠藏住。
    // 依据「存储里的设置」而不是合并后的值：否则 config.local.js 预置的默认单价会让高级区永远展开。
    const stored = result.mokaSettings || {};
    const storedConc = Number(stored.scoreConcurrency);
    const advGroup = document.getElementById('conn-adv-group');
    if (advGroup) {
      advGroup.open = (Number.isFinite(storedConc) && storedConc > 0 && storedConc !== 6)
        || stored.forceJsonMode === false
        || String(stored.modelInputPrice || '').trim() !== ''
        || String(stored.modelOutputPrice || '').trim() !== '';
    }
    const appIdEl = document.getElementById('feishu-app-id');
    if (appIdEl) appIdEl.value = s.feishuAppId || '';
    const appSecretEl = document.getElementById('feishu-app-secret');
    if (appSecretEl) appSecretEl.value = s.feishuAppSecret || '';
    const receiverEl = document.getElementById('feishu-receiver');
    if (receiverEl) receiverEl.value = s.feishuReceiver || '';
    const summaryNotifyEl = document.getElementById('feishu-summary-notify');
    if (summaryNotifyEl) summaryNotifyEl.checked = s.feishuSummaryNotify !== false;
    updateFeishuBridgeStatus();
    startFeishuBridgePolling();
  } catch (error) {
    console.error('加载设置失败:', error);
  }
  lockLocalConnection(); // 协议/提供商/Endpoint/模型名 由本地私有配置锁定（API Key 可改）
  fillProviderPresets(); // 提供商输入框的常用服务候选（可自由填写，不限于候选）
  syncEndpointPlaceholder(); // 按协议更新 Endpoint 占位；地址为空时才补默认值
}

let feishuBridgePollingTimer = null;
let isOperatingFeishuBridge = false;
let isBridgeCurrentlyConnected = false;
// 探测失败后的指引窗口：期内状态行显示「未启动 + 怎么办」而不是干巴巴的未运行（v3.0.2）
let bridgeGuidanceUntil = 0;

function updateFeishuBridgeStatus(callback) {
  const statusEl = document.getElementById('feishu-bridge-status');
  const actionBtn = document.getElementById('reconnect-feishu-bridge');
  const barEl = statusEl?.closest('.bridge-status-bar');
  if (!statusEl) return;
  chrome.runtime.sendMessage({ action: 'getFeishuBridgeStatus' }, (res) => {
    isBridgeCurrentlyConnected = !!(res && res.connected);
    if (isBridgeCurrentlyConnected) {
      statusEl.textContent = '🟢 飞书长连接已就绪 (私聊直推与交互就绪)';
      statusEl.style.color = '#16a34a';
      barEl?.classList.add('is-connected');
      if (actionBtn && !isOperatingFeishuBridge) {
        actionBtn.textContent = '🔌 断开连接';
        actionBtn.title = '点击主动断开与本地服务的连接';
        actionBtn.classList.add('btn-action-disconnect');
        actionBtn.disabled = false;
      }
    } else {
      if (!isOperatingFeishuBridge) {
        // 探测失败后的指引窗口期内给出明确的「为什么 + 怎么办」，避免看起来像点了没反应
        const guidanceActive = Date.now() < bridgeGuidanceUntil;
        statusEl.textContent = guidanceActive
          ? '⚠️ 本地服务未启动：在项目文件夹终端执行 bash 安装开机自启.command'
          : '⚪ 本地服务未运行';
        statusEl.style.color = guidanceActive ? '#d97706' : '#64748b';
        barEl?.classList.remove('is-connected');
        if (actionBtn) {
          actionBtn.textContent = guidanceActive ? '未启动 (再试)' : '🔄 立即连接';
          actionBtn.title = '点击尝试连接本地 18888 端口';
          actionBtn.classList.remove('btn-action-disconnect');
          actionBtn.disabled = false;
        }
      }
    }
    if (typeof callback === 'function') callback(isBridgeCurrentlyConnected);
  });
}

function startFeishuBridgePolling() {
  if (feishuBridgePollingTimer) return;
  feishuBridgePollingTimer = setInterval(() => {
    if (!isOperatingFeishuBridge) {
      updateFeishuBridgeStatus();
    }
  }, 2500);
}

safeEl('reconnect-feishu-bridge')?.addEventListener('click', () => {
  const btn = document.getElementById('reconnect-feishu-bridge');
  const statusEl = document.getElementById('feishu-bridge-status');
  // 注意 id 必须与 popup.html 一致（bridge-advanced-details）；v3.0.2 前此处 id 写错导致指引永远不展开
  const detailsEl = document.getElementById('bridge-advanced-details');

  if (isOperatingFeishuBridge) return;
  isOperatingFeishuBridge = true;

  // 1. 若当前已连接，点击触发断开连接
  if (isBridgeCurrentlyConnected) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '断开中...';
    }
    chrome.runtime.sendMessage({ action: 'disconnectFeishuBridge' }, () => {
      setTimeout(() => {
        isOperatingFeishuBridge = false;
        updateFeishuBridgeStatus();
      }, 200);
    });
    return;
  }

  // 2. 若当前未连接，点击触发连接探测
  if (btn) {
    btn.disabled = true;
    btn.textContent = '探测中...';
  }
  if (statusEl) {
    statusEl.textContent = '🟡 探测中...';
    statusEl.style.color = '#f59e0b';
  }

  // 探测失败：状态行给明确指引并展开「本地服务与常见说明」折叠区
  const handleProbeFailure = () => {
    bridgeGuidanceUntil = Date.now() + 8000;
    updateFeishuBridgeStatus((connected) => {
      if (!connected) {
        if (detailsEl) detailsEl.open = true;
        if (btn) {
          btn.textContent = '未启动 (再试)';
          setTimeout(() => {
            if (btn && btn.textContent === '未启动 (再试)') {
              btn.textContent = '🔄 立即连接';
            }
          }, 3000);
        }
      }
    });
  };

  // 1.2 秒硬性超时兜底
  const timeoutGuard = setTimeout(() => {
    if (isOperatingFeishuBridge) {
      isOperatingFeishuBridge = false;
      handleProbeFailure();
    }
  }, 1200);

  chrome.runtime.sendMessage({ action: 'reconnectFeishuBridge' }, () => {
    clearTimeout(timeoutGuard);
    setTimeout(() => {
      if (!isOperatingFeishuBridge) return;
      isOperatingFeishuBridge = false;
      handleProbeFailure();
    }, 400);
  });
});

safeEl('copy-bridge-cmd')?.addEventListener('click', async () => {
  const btn = document.getElementById('copy-bridge-cmd');
  try {
    await navigator.clipboard.writeText('cd ~/Downloads/"Vibe Coding"/moka-resume-plugin && npm run bridge');
    if (btn) {
      const oldText = btn.textContent;
      btn.textContent = '✅ 已复制完整命令';
      setTimeout(() => { btn.textContent = oldText; }, 1800);
    }
  } catch (e) {
    console.warn('复制命令失败:', e);
  }
});

safeEl('test-feishu')?.addEventListener('click', async () => {
  const appId = String(document.getElementById('feishu-app-id')?.value || '').trim();
  const appSecret = String(document.getElementById('feishu-app-secret')?.value || '').trim();
  const receiver = String(document.getElementById('feishu-receiver')?.value || '').trim();
  const resultDiv = document.getElementById('feishu-test-result');

  const hasAppCreds = !!(appId && appSecret);
  if (!hasAppCreds) {
    if (resultDiv) {
      resultDiv.textContent = '❌ 请先填写飞书 App ID & Secret（绑定机器人后直推个人单聊）';
      resultDiv.className = 'test-result error';
      resultDiv.classList.remove('hidden');
    }
    return;
  }

  if (hasAppCreds && !receiver) {
    if (resultDiv) {
      resultDiv.textContent = '💡 提示：请填入个人接收账号（如企业邮箱 xxx@meitu.com 或 Open ID）以便机器人私聊给您';
      resultDiv.className = 'test-result warning';
      resultDiv.classList.remove('hidden');
    }
  }

  // 自动持久化当前设置
  try {
    const res = await chrome.storage.local.get('mokaSettings');
    const current = res.mokaSettings || {};
    await chrome.storage.local.set({
      mokaSettings: {
        ...current,
        feishuAppId: appId,
        feishuAppSecret: appSecret,
        feishuReceiver: receiver,
        feishuSummaryNotify: document.getElementById('feishu-summary-notify')?.checked !== false
      }
    });
  } catch (e) { /* ignore storage error */ }

  const testCard = MokaFeishu.buildCandidateCard(
    { name: '测试候选人', applicationId: 'test_demo', jobTitle: '测试岗位' },
    {
      finalScore: 88,
      decisionTag: '优先推进',
      scoreBreakdown: {
        coreDuty: { score: 90, reason: '核心职责高度对口' },
        business: { score: 85, reason: '业务场景经验丰富' },
        skill: { score: 85, reason: '技能栈匹配' },
        scope: { score: 85, reason: '项目量级匹配' }
      },
      experienceEvidence: '这是一张来自 Moka 助手的飞书协同测试卡片。\n已连通自建应用机器人通道，您可直接在此对话推进简历！',
      concerns: ['无']
    },
    { jobTitle: '测试岗位' }
  );

  if (resultDiv) {
    resultDiv.textContent = hasAppCreds ? '正在通过自建应用直推飞书单聊…' : '正在发送测试卡片…';
    resultDiv.className = 'test-result info';
    resultDiv.classList.remove('hidden');
  }

  chrome.runtime.sendMessage({
    action: 'sendFeishuCard',
    card: testCard,
    receiver
  }, (res) => {
    if (chrome.runtime.lastError) {
      if (resultDiv) {
        resultDiv.textContent = '❌ 发送失败: ' + chrome.runtime.lastError.message;
        resultDiv.className = 'test-result error';
      }
      return;
    }
    if (res && res.ok) {
      if (resultDiv) {
        resultDiv.textContent = hasAppCreds
          ? '✅ 测试卡片已直推至您的飞书单聊！请查收并在单聊直接回复指令测试推进'
          : '✅ 测试卡片已发送成功，请前往飞书查收！';
        resultDiv.className = 'test-result success';
        setTimeout(() => resultDiv.classList.add('hidden'), 5000);
      }
    } else {
      if (resultDiv) {
        resultDiv.textContent = '❌ 发送失败: ' + (res?.error || '网络异常');
        resultDiv.className = 'test-result error';
      }
    }
  });
});

// ========================================================
// 飞书协同 3.0：单链路——绑定的飞书机器人私聊推送本人
// ========================================================

let saveFeishuSettingsTimer = null;
function debouncedSaveFeishuSettings() {
  if (saveFeishuSettingsTimer) clearTimeout(saveFeishuSettingsTimer);
  saveFeishuSettingsTimer = setTimeout(async () => {
    try {
      const res = await chrome.storage.local.get('mokaSettings');
      const current = res.mokaSettings || {};
      const appId = String(document.getElementById('feishu-app-id')?.value || '').trim();
      const appSecret = String(document.getElementById('feishu-app-secret')?.value || '').trim();
      const receiver = String(document.getElementById('feishu-receiver')?.value || '').trim();
      await chrome.storage.local.set({
        mokaSettings: {
          ...current,
          feishuAppId: appId,
          feishuAppSecret: appSecret,
          feishuReceiver: receiver
        }
      });

      // 实时向本地 Bridge 同步凭据并热启动长连接
      try {
        const syncResp = await chrome.runtime.sendMessage({
          action: 'syncFeishuCredentials',
          appId,
          appSecret,
          receiver
        });
        const hintEl = document.getElementById('feishu-app-sync-status');
        if (hintEl) {
          if (syncResp && syncResp.connected) {
            hintEl.textContent = '✨ 凭据与接收账号已同步至本地 Bridge 服务 (常驻运行中)';
            hintEl.style.color = '#16a34a';
          } else {
            hintEl.textContent = '💾 配置已保存至插件设置（启动本地 Bridge 后自动建立私聊长连接）';
            hintEl.style.color = '#475569';
          }
        }
      } catch (err) {
        // ignore
      }
    } catch (e) {
      // ignore
    }
  }, 300);
}

// 自建应用凭据/接收账号输入：防抖保存并实时同步本地 Bridge
['feishu-app-id', 'feishu-app-secret', 'feishu-receiver'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', () => {
      debouncedSaveFeishuSettings();
    });
  }
});

// App Secret 明文显示切换
const toggleSecretBtn = document.getElementById('toggle-feishu-app-secret');
toggleSecretBtn?.addEventListener('click', () => {
  const secretInput = document.getElementById('feishu-app-secret');
  if (!secretInput) return;
  const isPassword = secretInput.type === 'password';
  secretInput.type = isPassword ? 'text' : 'password';
  toggleSecretBtn.title = isPassword ? '隐藏明文' : '显示明文';
});


// 获取当前窗口活动标签；侧栏点操作时活动标签通常仍是 Moka
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

let lastMokaTabId = null;

async function getMokaTab() {
  const active = await getActiveTab();
  if (isMokaTab(active)) {
    lastMokaTabId = active.id;
    return active;
  }
  if (lastMokaTabId != null) {
    try {
      const remembered = await chrome.tabs.get(lastMokaTabId);
      if (isMokaTab(remembered)) return remembered;
    } catch (e) { /* 标签已关 */ }
  }
  const list = await chrome.tabs.query({ url: 'https://app.mokahr.com/*' });
  const tab = list.find((t) => t.active) || list[0];
  if (tab) lastMokaTabId = tab.id;
  return tab || active;
}

function isMokaTab(tab) {
  return tab && tab.url && tab.url.startsWith('https://app.mokahr.com/');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function waitForContentScript(tabId, retries, delayMs) {
  const attempts = retries == null ? 12 : retries;
  const delay = delayMs == null ? 250 : delayMs;
  for (let i = 0; i < attempts; i++) {
    const resp = await sendMessageToTab(tabId, { action: 'ping' });
    if (resp && resp.ok) return true;
    await sleep(delay);
  }
  return false;
}

async function sendToMoka(message, opts) {
  const tab = await getMokaTab();
  if (!isMokaTab(tab)) return null;
  const options = opts || {};
  if (message.action !== 'ping' && !options.skipPing) {
    const ready = await waitForContentScript(tab.id, options.retries, options.delayMs);
    if (!ready) return null;
  }
  return sendMessageToTab(tab.id, message);
}

let mokaRefreshTimer = null;

function scheduleMokaRefresh() {
  clearTimeout(mokaRefreshTimer);
  mokaRefreshTimer = setTimeout(() => {
    mokaRefreshTimer = null;
    refreshMokaConnection();
  }, 400);
}

function refreshMokaConnection() {
  return refreshResultsAndJobContext();
}

/**
 * 「点击刷新」：整页重载侧栏，等价于关掉再打开。
 * 软刷新在表单已装着同一岗位时几乎不做事，页面状态错乱时救不回来。
 * 重载会丢掉未保存的表单改动，所以先尽力落盘本岗配置（无有效岗位时跳过）。
 */
function reloadSidePanel() {
  const btn = document.getElementById('reload-panel');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '刷新中…';
  }
  const done = () => { location.reload(); };
  try {
    const jobId = currentJobId() || effectiveJobId();
    if (!jobId) {
      done();
      return;
    }
    // 落盘卡住时不能把刷新也一起卡死
    Promise.race([saveJobPresetFor(jobId), sleep(800)]).then(done, done);
  } catch (e) {
    done();
  }
}

async function refreshResultsAndJobContext() {
  // 开筛 / 推荐·淘汰进行中：只拉结果，禁止 loadJobs 抢消息或触发换岗同步
  if (resultState.screening || startingScreen || isMokaActionLocked()) {
    await pullResults();
    return;
  }
  await pullResults();
  await loadJobs();
  await refreshCalibrationButton();
}

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab || !isMokaTab(tab)) return;
    lastMokaTabId = tabId;
    scheduleMokaRefresh();
  });
}

if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener((info) => {
    chrome.tabs.get(info.tabId, (tab) => {
      if (chrome.runtime.lastError || !isMokaTab(tab)) return;
      lastMokaTabId = tab.id;
      scheduleMokaRefresh();
    });
  });
}

// 加载职位列表（带非 Moka 页面容错）
async function loadJobs() {
  if (loadJobsInFlight) return loadJobsInFlight;
  loadJobsInFlight = (async () => {
  const jobSelect = document.getElementById('job-select');
  const tab = await getMokaTab();

  if (!isMokaTab(tab)) {
    jobSelect.innerHTML = '<option value="">请先打开 Moka 页面</option>';
    return;
  }

  // 保留当前选中项，避免「正在连接」清空导致开筛读到空职位
  const prevSelected = jobSelect.value || activePresetJobId || '';
  const response = await sendToMoka({ action: 'getJobs' }, { retries: 15, delayMs: 300 });
  if (!response) {
    if (!jobSelect.options.length || (jobSelect.options.length === 1 && !jobSelect.options[0].value)) {
      jobSelect.innerHTML = '<option value="">无法连接页面，请刷新 Moka 后重试</option>';
    }
    return;
  }
  const jobs = response.jobs || [];
  if (jobs.length === 0) {
    if (activePresetJobId) {
      ensureJobSelectOption(activePresetJobId, activePresetJobLabel);
      jobSelect.value = activePresetJobId;
      const hadPreset = await restoreCurrentJobPreset();
      await ensureJobUnderstandingOnEnter(hadPreset);
      renderAssigneeStatus();
      return;
    }
    jobSelect.innerHTML = '<option value="">请打开候选人列表页（含 pipelineId）</option>';
    return;
  }
  jobSelect.innerHTML = '';
  jobs.forEach((job) => {
    const option = document.createElement('option');
    option.value = job.id;
    option.textContent = job.name;
    jobSelect.appendChild(option);
  });
  const prevJobId = activePresetJobId || prevSelected || '';
  const pageJobBefore = lastKnownPageJobId;
  const { targetJobId, label, pageJobId } = resolveTargetJobFromResponse(response, jobs);
  if (pageJobId) lastKnownPageJobId = pageJobId;
  // 表单里已经是这个岗位时只同步下拉，避免刷新风暴反复 restore 覆盖正在编辑的内容；
  // 但表单尚未装过它（例如刚打开侧栏）就必须读存档，否则保存过的条件带不出来
  const formHoldsTargetJob = !!targetJobId && !!window.MokaPersist
    && !MokaPersist.needsPresetReload(targetJobId, presetFormJobId);
  if (formHoldsTargetJob) {
    if (label) activePresetJobLabel = String(label);
    // v3.0.8：label 未知（新职位拿不到名字）时绝不用旧岗名盖章到新岗 option 上，
    // 传空让 ensureJobSelectOption 走中性占位，等真实职位名到位再更新
    ensureJobSelectOption(targetJobId, label || '');
    jobSelect.value = targetJobId;
  } else {
    // prevLabel 取 activePresetJobLabel（此刻仍是「离开岗」的名字，target 的 label
    // 尚未写入），保证保存旧岗存档时盖的是旧岗名而不是新岗名
    await switchJobPreset(prevJobId, activePresetJobLabel, targetJobId, label);
  }
  // Moka 页面切岗（SPA 或整页跳转）后，若表单已装该岗（走了只同步下拉的快路径），
  // 必须补一次简历推荐对象重渲染——让「简历推荐对象」跟随 Moka 当前页面职位；
  // 未装该岗的路径由 switchJobPreset 内部已渲染，无需重复
  if (pageJobId && pageJobId !== pageJobBefore && formHoldsTargetJob) renderAssigneeStatus();
  refreshCalibrationButton();

  if (!jobSelectBound) {
    jobSelectBound = true;
    jobSelect.addEventListener('change', () => {
      const nextId = currentJobId();
      const selected = jobSelect.options[jobSelect.selectedIndex];
      const nextLabel = selected && selected.textContent ? selected.textContent : activePresetJobLabel;
      const prevId = activePresetJobId;
      const prevLabel = activePresetJobLabel; // change 事件触发时 select 已切到新岗，旧岗名只能取全局镜像
      switchJobPreset(prevId, prevLabel, nextId, nextLabel).then(() => {
        refreshCalibrationButton();
        hideCalibrationPanel();
      }).catch((e) => {
        // 切岗失败不静默：状态行提示 + 复位按钮；错误已被队列吞掉不会拖垮后续切岗
        setPresetNote('切换职位时出错（' + String((e && e.message) || e) + '），请重试', '#fa8c16');
        refreshCalibrationButton();
      });
    });
  }
  })().finally(() => {
    loadJobsInFlight = null;
  });
  return loadJobsInFlight;
}

// 根据职位类型显示/隐藏 经验要求 / 实习经验
function applyJobTypeVisibility() {
  const isIntern = document.querySelector('input[name="job-type"]:checked')?.value === 'intern';
  const rowExp = document.getElementById('row-exp');
  const rowIntern = document.getElementById('row-internship');
  if (rowExp) rowExp.style.display = isIntern ? 'none' : '';
  if (rowIntern) rowIntern.style.display = isIntern ? '' : 'none';
}

const EXP_LABEL = { fresh: '在校或应届', '1-3': '1-3 年', '3-5': '3-5 年', '5+': '5 年以上' };

function setCheckboxGroup(rootId, values) {
  const wanted = new Set(values || []);
  document.querySelectorAll('#' + rootId + ' input[type="checkbox"]').forEach((c) => {
    c.checked = wanted.has(c.value);
  });
}

/** 年龄档位下拉（details 壳 + 胶囊勾选）：读取当前勾选档位 value 列表 */
function ageTierSelection() {
  return Array.from(document.querySelectorAll('#cond-age input[type="checkbox"]:checked')).map((c) => c.value);
}

/** 年龄档位归一：4 档下拉，≥35 旧档（35-40/40-50/50+）一律并入「35+」 */
const AGE_TIER_MIN = { '20-25': 20, '25-30': 25, '30-35': 30, '35+': 35 };
const AGE_TIER_LABEL = { '20-25': '20-25', '25-30': '25-30', '30-35': '30-35', '35+': '35 岁以上' };
function normalizeAgeTierValues(values) {
  const out = [];
  (values || []).forEach((v) => {
    const s = String(v);
    if (Object.prototype.hasOwnProperty.call(AGE_TIER_MIN, s)) {
      if (!out.includes(s)) out.push(s);
      return;
    }
    const r = parseAgeRange(s);
    if (r && r.min >= 35 && !out.includes('35+')) out.push('35+');
  });
  return out;
}

/** 下拉按钮文案：已选档位拼接展示，空选显示「不限」 */
function refreshAgeDdLabel() {
  const textEl = document.querySelector('#cond-age .cond-dd-text');
  if (!textEl) return;
  const vals = ageTierSelection();
  textEl.textContent = vals.length ? vals.map((v) => AGE_TIER_LABEL[v] || v).join('、') : '不限';
}

function setAgeTierOptions(values) {
  setCheckboxGroup('cond-age', normalizeAgeTierValues(values));
  refreshAgeDdLabel();
}

// 年龄下拉：勾选即刷新按钮文案；点击面板外自动收起
document.addEventListener('change', (e) => {
  if (e.target && e.target.closest && e.target.closest('#cond-age')) refreshAgeDdLabel();
});
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.cond-dd[open]').forEach((d) => {
    if (!(e.target instanceof Node) || !d.contains(e.target)) d.removeAttribute('open');
  });
});

function applyHardAutofill(af, { fromButton }) {
  const isIntern = document.querySelector('input[name="job-type"]:checked')?.value === 'intern';
  const bits = [];
  if (af.degree) {
    document.getElementById('cond-degree').value = af.degree;
    bits.push(af.degree === '博士' ? '博士' : af.degree + '及以上');
  }
  if (af.exp && !isIntern) {
    document.getElementById('cond-exp').value = af.exp;
    bits.push(EXP_LABEL[af.exp] || af.exp);
  }
  if (af.internship && isIntern) {
    document.getElementById('cond-internship').value = af.internship;
    bits.push('需实习经验');
  }
  if (af.gender) {
    document.getElementById('cond-gender').value = af.gender;
    bits.push('性别' + af.gender);
  }
  if (Array.isArray(af.schools) && af.schools.length) {
    // 只保留表单上存在的院校胶囊（QS500 档已下线，旧 JD 文案提取值不再展示/提示）
    const schools = af.schools.filter((s) => document.querySelector('#cond-school input[type="checkbox"][value="' + s + '"]'));
    if (schools.length) {
      setCheckboxGroup('cond-school', schools);
      bits.push(schools.join('/'));
    }
  }
  if (Array.isArray(af.ageRangeValues) && af.ageRangeValues.length) {
    setAgeTierOptions(af.ageRangeValues);
    bits.push(af.ageRangeValues.join('、'));
  }
  if (Array.isArray(af.languages) && af.languages.length && (fromButton || !languageEditor.get().length)) {
    languageEditor.set(af.languages);
    bits.push('语言 ' + languageEditor.get().length + ' 项');
  }
  if (Array.isArray(af.customGates) && af.customGates.length && (fromButton || !customGateEditor.get().length)) {
    customGateEditor.set(af.customGates);
    bits.push('专业及其他 ' + customGateEditor.get().length + ' 项');
  }
  // 本地抽到的技能词：仅在重点看仍空时并入
  if (Array.isArray(af.resumeKeywords) && af.resumeKeywords.length && !importantEditor.get().length) {
    const next = [];
    af.resumeKeywords.forEach((k) => {
      const t = String(k || '').trim();
      if (t && next.indexOf(t) === -1) next.push(t);
    });
    if (next.length) {
      importantEditor.set(next.slice(0, 6));
      bits.push('重点看 ' + importantEditor.get().length + ' 项');
    }
  }
  return bits;
}

async function prefillHardFromJD() {
  const tab = await getMokaTab();
  if (!isMokaTab(tab)) return [];
  const contextJobId = currentJobId() || effectiveJobId();
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { action: 'getJobContext', jobId: contextJobId }, (response) => {
      if (chrome.runtime.lastError || !response || !response.autofill) { resolve([]); return; }
      let bits;
      applyingPreset = true;
      try {
        bits = applyHardAutofill(response.autofill, { fromButton: true });
      } catch (e) {
        bits = [];
      } finally {
        applyingPreset = false;
      }
      resolve(bits || []);
    });
  });
}

// 开始筛选
safeEl('start-screening')?.addEventListener('click', async () => {
  // 只挡住「正在发送的这一下」；任何异常都会在看门狗里解锁，绝不永久吞掉点击
  if (startingScreen) return;
  const selectedJob = document.getElementById('job-select').value || activePresetJobId || '';
  const jobSelect = document.getElementById('job-select');
  let selectedLabel = '';
  if (jobSelect && jobSelect.selectedIndex >= 0 && jobSelect.options[jobSelect.selectedIndex]) {
    selectedLabel = jobSelect.options[jobSelect.selectedIndex].textContent || '';
  }
  if (!selectedLabel) selectedLabel = activePresetJobLabel || '';
  if (!selectedJob) {
    alert('❌ 请选择职位');
    return;
  }

  let tab = null;
  try {
    tab = await getMokaTab();
  } catch (e) {
    alert('❌ 读取 Moka 标签失败：' + ((e && e.message) || '请重试'));
    return;
  }
  if (!isMokaTab(tab)) {
    alert('❌ 请在 Moka 候选人管理页面使用');
    return;
  }

  beginStartingScreen();
  // 先给反馈，避免「点了没反应」；真正失败再回滚
  resultState.screening = true;
  arrivedScoreRows.clear(); // 新一轮筛选：落卡动效重新可播
  setScreeningUi(true);
  hideResumeBanner();
  setResultHint('正在启动筛选…', { tip: true, tone: 'info' });
  switchTab('results');
  document.getElementById('progress-container')?.classList.remove('hidden');
  const progressText = document.getElementById('progress-text');
  if (progressText) progressText.textContent = '正在启动…';

  try {
    const hardConditions = readHardConditions();
    const weights = readWeights();
    const jobType = document.querySelector('input[name="job-type"]:checked').value;
    const maxCount = Number(document.getElementById('max-count')?.value || 0);
    const requirements = {
      must: [],
      important: importantEditor.get(),
      nice: niceEditor.get()
    };
    const specFields = MokaPersist.requirementsToJobSpecFields(requirements, hardConditions);
    const jobSpec = lastJobSpec
      ? Object.assign({}, lastJobSpec, specFields)
      : Object.assign({}, specFields);

    // 与 v1.6.2 一致：落盘不阻塞开筛消息
    saveJobPresetFor(selectedJob).catch(() => {});

    chrome.tabs.sendMessage(
      tab.id,
      {
        action: 'startScreening',
        jobId: selectedJob,
        jobName: selectedLabel,
        jobType,
        hardConditions,
        weights,
        maxCount,
        jobSpec,
        keywords: [],
        force: true
      },
      (resp) => {
        endStartingScreen();
        if (chrome.runtime.lastError) {
          resultState.screening = false;
          setScreeningUi(false);
          alert('❌ 无法连接页面，请刷新 Moka 后重试\n' + (chrome.runtime.lastError.message || ''));
          return;
        }
        if (resp && resp.ok === false) {
          resultState.screening = false;
          setScreeningUi(false);
          alert('❌ ' + (resp.error || '无法开始筛选，请刷新 Moka 后重试'));
          return;
        }
        syncActiveJobFromSnapshot(selectedJob, selectedLabel);
        setResultHint('筛选已开始', { tip: true, tone: 'info' });
      }
    );
  } catch (e) {
    endStartingScreen();
    resultState.screening = false;
    setScreeningUi(false);
    alert('❌ 开始筛选失败：' + ((e && e.message) || '请重试'));
  }
});

const START_SCREEN_WATCHDOG_MS = 10000;
let startingScreenTimer = null;

function beginStartingScreen() {
  startingScreen = true;
  clearTimeout(startingScreenTimer);
  // content script 未响应时也必须解锁，否则之后每次点击都会被 startingScreen 挡掉
  startingScreenTimer = setTimeout(() => {
    startingScreenTimer = null;
    if (!startingScreen) return;
    startingScreen = false;
    if (!resultState.screening) setScreeningUi(false);
    setResultHint('未收到页面响应，请刷新 Moka 后重试', { tone: 'warn' });
  }, START_SCREEN_WATCHDOG_MS);
}

function endStartingScreen() {
  startingScreen = false;
  clearTimeout(startingScreenTimer);
  startingScreenTimer = null;
}

function setScreeningUi(active) {
  const startBtn = document.getElementById('start-screening');
  if (startBtn) {
    // 只在发送消息的瞬间禁用；已在筛选时按钮改为「重新开始筛选」，保证用户永远有出口
    startBtn.disabled = !!startingScreen;
    startBtn.textContent = active ? '重新开始筛选' : '开始筛选';
  }
  const stopBtn = document.getElementById('stop-screening');
  if (stopBtn) stopBtn.disabled = !active;
  const progress = document.getElementById('progress-container');
  if (progress) {
    if (active) progress.classList.remove('hidden');
    else if (!resultState.screening) progress.classList.add('hidden');
  }
}

// 停止筛选（进度条旁的文字按钮）
safeEl('stop-screening')?.addEventListener('click', async () => {
  const tab = await getMokaTab();
  if (isMokaTab(tab)) {
    chrome.tabs.sendMessage(tab.id, { action: 'stopScreening' }, () => void chrome.runtime.lastError);
  }
  setScreeningUi(false);
  document.getElementById('progress-container').classList.add('hidden');
});

safeEl('save-job-preset')?.addEventListener('click', () => {
  saveJobPresetFromButton();
});

// 接收进度与结果快照
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'updateProgress') {
    document.getElementById('progress-container').classList.remove('hidden');
    document.getElementById('progress-text').textContent = request.message;
    document.getElementById('progress-count').textContent = `${request.current}/${request.total}`;
    document.getElementById('progress-fill').style.width = `${request.percentage}%`;
  } else if (request.action === 'resultsUpdated') {
    applySnapshot(request);
  } else if (request.action === 'screeningResumeAvailable') {
    showResumeBanner(request.job, request.pending, 'resume');
  } else if (request.action === 'screeningPausedMismatch') {
    showResumeBanner(request.job, null, 'mismatch');
  } else if (request.action === 'screeningCompleteToast') {
    showScreeningCompleteToast(request);
  } else if (request.action === 'pluginLogEntry') {
    // 后台新落一条运行日志 → 实时追加到设置页面板（replaceTail=true 表示折叠更新末行）
    appendPluginLogEntry(request.entry, request.replaceTail === true);
  } else if (request.action === 'mokaActionComplete') {
    refreshResultsAndJobContext();
  } else if (request.action === 'feishuBatchRecommended') {
    // 飞书卡片触发的批量推进成功 → 与面板批量推进同款：批量记入「已决策」存档，
    // 自动从「待处理 / 推荐」移出（v3.0.4）。页面刷新后快照恢复时 feedbackRecord 会重新合并，状态不丢
    const ids = Array.isArray(request.appIds) ? request.appIds : [];
    let marked = 0;
    ids.forEach((id) => {
      const v = findResultView(id);
      if (!v) return;
      if (saveCandidateFeedback(v.id, 'recommend', v, { mokaSynced: true, syncFailed: false })) marked++;
    });
    if (marked) {
      renderResults();
      setResultHint(`🤖 飞书指令：${marked} 位候选人已推进并移入「已决策」`, { tone: 'ok' });
    }
  } else if (request.action === 'mokaContentReady') {
    if (!resultState.screening && !isMokaActionLocked()) scheduleMokaRefresh();
    pollScreeningJobOffer();
  } else if (request.action === 'pageJobChanged') {
    if (!resultState.screening && !isMokaActionLocked()) scheduleMokaRefresh();
  }
});

function hideResumeBanner() {
  const el = document.getElementById('resume-banner');
  if (el) el.classList.add('hidden');
}

function showScreeningCompleteToast(payload) {
  const msg = (payload && payload.message) || '筛选完成';
  const isWarn = (payload && payload.tone) === 'warn';
  setResultHint(msg, { tone: isWarn ? 'warn' : 'ok' });
  const banner = document.getElementById('result-banner');
  if (banner) {
    banner.classList.add('show');
    banner.textContent = '';
    const ok = document.createElement('div');
    ok.className = isWarn ? 'mp-banner-warn' : 'mp-banner-ok';
    ok.textContent = (isWarn ? '⚠️ ' : '✓ ') + msg;
    banner.appendChild(ok);
    setTimeout(() => {
      if (banner.querySelector('.mp-banner-ok') || banner.querySelector('.mp-banner-warn')) {
        banner.classList.remove('show');
        banner.textContent = '';
      }
    }, 8000);
  }
  switchTab('results');
  setScreeningUi(false);
  document.getElementById('progress-container').classList.add('hidden');
}

function showResumeBanner(job, pending, mode) {
  const el = document.getElementById('resume-banner');
  const text = document.getElementById('resume-banner-text');
  if (!el || !text) return;
  const name = (job && job.jobName) || '当前职位';
  const done = job && job.completed != null ? job.completed : 0;
  const total = job && job.total != null ? job.total : '?';
  if (mode === 'mismatch') {
    text.textContent = `筛选已暂停：Moka 职位与任务「${name}」不一致（${done}/${total}）。请切回该职位后再点继续。`;
  } else {
    const left = pending != null ? pending : Math.max(0, Number(total) - Number(done));
    text.textContent = `发现未完成的筛选「${name}」（已完成 ${done}/${total}，待评约 ${left} 人）。是否继续？`;
  }
  el.classList.remove('hidden');
  switchTab('results');
}

async function pollScreeningJobOffer() {
  const resp = await sendToMoka({ action: 'getScreeningJob' });
  const job = resp && resp.job;
  if (!job) {
    hideResumeBanner();
    return;
  }
  if (job.status === 'paused_mismatch') {
    showResumeBanner(job, null, 'mismatch');
  } else if (job.status === 'awaiting_resume' || job.status === 'running') {
    // running 但 content 已重载时也会先写成 awaiting_resume；仍展示确认
    if (job.completed < job.total) showResumeBanner(job, job.total - job.completed, 'resume');
  }
}

document.getElementById('resume-screening')?.addEventListener('click', async () => {
  hideResumeBanner();
  setScreeningUi(true);
  setResultHint('正在继续筛选…', { tip: true, tone: 'info' });
  const resp = await sendToMoka({ action: 'resumeScreening' });
  if (!resp || !resp.ok) {
    markRescoreError((resp && resp.error) || '续筛失败');
    setScreeningUi(false);
  }
  await refreshResultsAndJobContext();
});

document.getElementById('discard-screening')?.addEventListener('click', async () => {
  hideResumeBanner();
  await sendToMoka({ action: 'discardScreeningJob' });
  setResultHint('已放弃未完成的筛选任务（已评分结果仍保留，可在「已决策」查看）');
  await refreshResultsAndJobContext();
});

document.getElementById('suggest-weights')?.addEventListener('click', () => {
  loadJobSpec();
});

function refreshCalibrationButton() {
  const btn = document.getElementById('open-calibration');
  if (!btn) return;
  const jobId = effectiveJobId();
  const fb = jobId ? MokaFeedback.summarizeFeedback(feedbackRecord, jobId) : { total: 0 };
  btn.disabled = false;
  btn.title = fb.total
    ? `本岗已有 ${fb.total} 条决策，点击复盘并查看优化建议`
    : '根据本岗历史决策复盘；暂无决策时也可打开查看说明';
}

function hideCalibrationPanel() {
  const panel = document.getElementById('calibration-panel');
  if (panel) panel.classList.add('hidden');
  const tab = document.getElementById('results-tab');
  if (tab) tab.classList.remove('cal-open');
}

function appendCalMetric(parent, num, label, cls) {
  const el = document.createElement('div');
  el.className = 'mp-cal-metric' + (cls ? ' ' + cls : '');
  const n = document.createElement('span');
  n.className = 'mp-cal-metric-num';
  n.textContent = String(num);
  const l = document.createElement('span');
  l.className = 'mp-cal-metric-label';
  l.textContent = label;
  el.appendChild(n);
  el.appendChild(l);
  parent.appendChild(el);
}

const CAL_CONF_LABEL = { high: '可信度高', medium: '可信度中', low: '可信度低' };

function buildCalSubLabel(text) {
  const el = document.createElement('div');
  el.className = 'mp-cal-sublabel';
  el.textContent = text;
  return el;
}

function buildSuggestionCard(sug, opts) {
  const options = opts || {};
  const item = document.createElement('div');
  item.className = 'mp-cal-item' + (options.isAdd ? ' is-add' : '');
  const addKind = options.isAdd || '';
  const editableTypes = { addGate: 1, addFocus: 1, addBonus: 1 };
  const actionTypes = { addGate: 1, addFocus: 1, addBonus: 1, relaxGate: 1, dropBonus: 1 };

  const title = document.createElement('div');
  title.className = 'mp-cal-item-title';
  title.textContent = sug.title || '建议';
  // 置信度「有则展示」：老数据无该字段时完全不渲染
  if (sug.confidence && CAL_CONF_LABEL[sug.confidence]) {
    const conf = document.createElement('span');
    conf.className = 'mp-cal-conf mp-cal-conf-' + sug.confidence;
    conf.textContent = CAL_CONF_LABEL[sug.confidence];
    title.appendChild(conf);
  }
  item.appendChild(title);

  if (sug.detail) {
    const detail = document.createElement('div');
    detail.className = 'mp-cal-item-detail';
    detail.textContent = sug.detail;
    item.appendChild(detail);
  }

  let field = null;
  if (editableTypes[sug.type] || addKind) {
    field = document.createElement('textarea');
    field.className = 'mp-cal-item-field';
    field.rows = 2;
    field.placeholder = addKind === 'focus' || sug.type === 'addFocus'
      ? '重点看文案，可修改后再保存'
      : addKind === 'bonus' || sug.type === 'addBonus'
        ? '加分看文案，可修改后再保存'
        : '门槛文案，可修改后再保存';
    field.value = sug.editableValue || '';
    item.appendChild(field);
  }

  if (actionTypes[sug.type] || addKind) {
    const actions = document.createElement('div');
    actions.className = 'mp-cal-item-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = '采纳并保存';
    btn.addEventListener('click', () => {
      if (editableTypes[sug.type] || addKind) {
        const value = field ? field.value.trim() : '';
        if (!value) {
          showDockToast('请先填写文案', 'warn');
          if (field) field.focus();
          return;
        }
        const type = addKind === 'focus' ? 'addFocus' : addKind === 'gate' ? 'addGate' : sug.type;
        const apply = type === 'addFocus'
          ? { focusKeyword: value }
          : type === 'addBonus'
            ? { bonusKeyword: value }
            : { customGate: value };
        applyCalibrationSuggestion({ type, apply });
        return;
      }
      applyCalibrationSuggestion(sug);
    });
    actions.appendChild(btn);
    item.appendChild(actions);
  }

  return item;
}

function renderCalibrationPanel() {
  const panel = document.getElementById('calibration-panel');
  const metricsEl = document.getElementById('calibration-metrics');
  const signalsWrap = document.getElementById('calibration-signals-wrap');
  const signalsEl = document.getElementById('calibration-signals');
  const listEl = document.getElementById('calibration-suggestions');
  if (!panel || !metricsEl || !signalsEl || !listEl || !window.MokaCalibrate) return;

  const jobId = effectiveJobId();
  metricsEl.textContent = '';
  signalsEl.textContent = '';
  listEl.textContent = '';

  if (!jobId) {
    if (signalsWrap) signalsWrap.classList.add('hidden');
    listEl.appendChild(buildSuggestionCard({
      type: 'info',
      title: '请先选择职位',
      detail: '选择职位后再查看本岗校准。'
    }));
    panel.classList.remove('hidden');
    const tab = document.getElementById('results-tab');
    if (tab) tab.classList.add('cal-open');
    switchTab('results');
    return;
  }

  const report = MokaCalibrate.buildCalibrationReport(feedbackRecord, jobId, {
    focusKeywords: importantEditor.get(),
    bonusKeywords: niceEditor.get()
  });

  appendCalMetric(metricsEl, report.total, '已决策');
  appendCalMetric(metricsEl, report.recommend, '已推荐');
  appendCalMetric(metricsEl, report.eliminate, '已淘汰');
  appendCalMetric(metricsEl, report.agree, '与插件一致', 'ok');
  appendCalMetric(metricsEl, report.overRecommend, '插件推你却淘汰', report.overRecommend ? 'warn' : '');
  appendCalMetric(metricsEl, report.underRecommend, '你推插件未推', report.underRecommend ? 'warn' : '');

  const signals = (report.topSignals || report.topConcerns || []).slice(0, 3);
  if (signals.length) {
    if (signalsWrap) signalsWrap.classList.remove('hidden');
    signals.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'mp-cal-signal';
      row.textContent = s.text;
      const count = document.createElement('span');
      count.className = 'mp-cal-signal-count';
      count.textContent = '×' + s.count;
      row.appendChild(count);
      signalsEl.appendChild(row);
    });
  } else if (signalsWrap) {
    signalsWrap.classList.add('hidden');
  }

  const actionableTypes = { addGate: 1, relaxGate: 1, addFocus: 1, dropBonus: 1, addBonus: 1 };
  const actionable = (report.suggestions || []).filter((s) => actionableTypes[s.type]);
  const infos = (report.suggestions || []).filter((s) => s.type === 'info');

  // 分组：规则调整（可采纳）/ 诊断（只提示）
  listEl.appendChild(buildCalSubLabel('规则调整'));
  actionable.forEach((sug) => listEl.appendChild(buildSuggestionCard(sug)));
  listEl.appendChild(buildSuggestionCard({
    type: 'addGate',
    title: '自行新增专业及其他门槛',
    detail: '不依赖系统建议，直接写入本岗手写门槛。',
    editableValue: ''
  }, { isAdd: 'gate' }));
  listEl.appendChild(buildSuggestionCard({
    type: 'addFocus',
    title: '自行新增重点看',
    detail: '把反复看走眼的经历写进重点看，下次按相邻经历判断，不靠字面命中。',
    editableValue: ''
  }, { isAdd: 'focus' }));
  if (infos.length) {
    listEl.appendChild(buildCalSubLabel('诊断'));
    infos.forEach((sug) => listEl.appendChild(buildSuggestionCard(sug)));
  }

  panel.classList.remove('hidden');
  const tab = document.getElementById('results-tab');
  if (tab) tab.classList.add('cal-open');
  switchTab('results');
}

function normalizeCalLabel(raw) {
  if (window.MokaCalibrate && MokaCalibrate.normalizeMustHaveLabel) {
    return MokaCalibrate.normalizeMustHaveLabel(raw) || String(raw || '').trim();
  }
  return String(raw || '').trim();
}

function addChipUnique(editor, item, max, fullMsg) {
  const cur = editor.get();
  if (cur.includes(item)) return true;
  if (cur.length >= max) {
    showDockToast(fullMsg, 'warn');
    return false;
  }
  editor.set(cur.concat([item]));
  return true;
}

function removeChipByLabel(editor, label) {
  const want = normalizeCalLabel(label);
  editor.set(editor.get().filter((x) => normalizeCalLabel(x) !== want && x !== label));
}

async function applyCalibrationSuggestion(sug) {
  if (!sug || !sug.apply) return;
  const type = sug.type;
  if (type === 'addGate' && sug.apply.customGate) {
    const item = normalizeCalLabel(sug.apply.customGate);
    if (!item) {
      showDockToast('门槛文案无效', 'warn');
      return;
    }
    if (!addChipUnique(customGateEditor, item, 6, '专业及其他已满 6 项')) return;
  } else if (type === 'relaxGate' && sug.apply.removeGate) {
    const item = String(sug.apply.removeGate).trim();
    removeChipByLabel(customGateEditor, item);
    removeChipByLabel(languageEditor, item);
  } else if (type === 'addFocus' && sug.apply.focusKeyword) {
    const item = String(sug.apply.focusKeyword).trim();
    if (!item) {
      showDockToast('重点看文案无效', 'warn');
      return;
    }
    if (!addChipUnique(importantEditor, item, 6, '重点看已满，请先删一条再采纳')) return;
  } else if (type === 'dropBonus' && sug.apply.removeBonus) {
    removeChipByLabel(niceEditor, String(sug.apply.removeBonus).trim());
  } else if (type === 'addBonus' && sug.apply.bonusKeyword) {
    const item = String(sug.apply.bonusKeyword).trim();
    if (!item) {
      showDockToast('加分看文案无效', 'warn');
      return;
    }
    if (!addChipUnique(niceEditor, item, 5, '加分看已满 5 项')) return;
  } else {
    return;
  }
  const ok = await saveJobPresetFor(effectiveJobId());
  if (ok) {
    showDockToast('保存成功，下次进入本岗将自动填充', 'ok');
    setPresetNote('已按校准建议更新本岗配置，下次进入将自动填充', '#52c41a');
    switchTab('screening');
  } else {
    showDockToast('已写入表单，但保存失败，请点底部「保存当前筛选条件」', 'warn');
  }
  renderCalibrationPanel();
}

document.getElementById('open-calibration')?.addEventListener('click', () => {
  renderCalibrationPanel();
});

document.getElementById('close-calibration')?.addEventListener('click', () => {
  hideCalibrationPanel();
});

document.querySelectorAll('input[name="job-type"]').forEach((r) => {
  r.addEventListener('change', () => {
    applyJobTypeVisibility();
  });
});

function syncAboutVersion() {
  const el = document.getElementById('about-version');
  if (!el) return;
  try {
    const v = chrome.runtime.getManifest().version;
    el.textContent = '版本：' + v;
  } catch (e) {
    el.textContent = '版本：未知';
  }
}

window.addEventListener('load', async () => {
  syncAboutVersion();
  // 初始化链分步容错：任一步存储/消息异常都不能拖垮后续步骤。
  // 历史教训：整链无 try/catch 时，一次 storage 读取 reject 会让
  // bindResultFilters（搜索/筛选/导出）永不绑定——功能半残且无提示。
  const bootSteps = [
    ['读取设置', loadSettings],
    ['读取反馈存档', loadFeedbackFromStorage],
    ['读取上次活跃职位', loadActivePresetJobId],
    ['刷新页面职位上下文', refreshResultsAndJobContext],
    ['轮询待续筛任务', pollScreeningJobOffer]
  ];
  for (const [name, fn] of bootSteps) {
    try {
      await fn();
    } catch (e) {
      console.warn('[初始化] ' + name + ' 失败（已跳过，继续后续步骤）', e);
    }
  }
  // 以下为必须执行的纯 UI 绑定/刷新，逐一兜底，绝不因前面任何一步失败而缺失
  try { reloadPluginLog(); } catch (e) { console.warn('[初始化] 预载运行日志失败', e); }
  try { applyJobTypeVisibility(); } catch (e) { console.warn('[初始化] 职位类型显隐失败', e); }
  try { updateWeightLabels(); } catch (e) { console.warn('[初始化] 权重标签刷新失败', e); }
  try { bindResultFilters(); } catch (e) { console.warn('[初始化] 结果区交互绑定失败', e); }
});


const KEEP_TAB_TIP = 'Moka 标签请保持打开（可切去其他浏览器标签）';



function setResultHint(activity, options) {
  const el = document.getElementById('result-hint');
  if (!el) return;
  const opts = options || {};
  const act = String(activity || '').trim();
  const tipText = opts.tip === true
    ? KEEP_TAB_TIP
    : (typeof opts.tip === 'string' ? opts.tip.trim() : '');
  el.classList.remove('is-info', 'is-ok', 'is-warn');
  el.textContent = '';
  if (!act && !tipText) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  if (act) {
    const main = document.createElement('div');
    main.className = 'mp-hint-main';
    main.textContent = act;
    if (opts.color) main.style.color = opts.color;
    el.appendChild(main);
  }
  if (tipText) {
    const tip = document.createElement('div');
    tip.className = 'mp-hint-tip';
    tip.textContent = tipText;
    el.appendChild(tip);
  }
  if (opts.tone) el.classList.add('is-' + opts.tone);
}
