function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach((c) => {
    c.classList.toggle('active', c.id === `${tabName}-tab`);
  });
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('reload-panel').addEventListener('click', () => {
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
  const ageRanges = Array.from(document.querySelectorAll('#cond-age input[type="checkbox"]:checked'))
    .map((c) => parseAgeRange(c.value))
    .filter(Boolean);
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
  applyingPreset = false;
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
  if (!label) label = activePresetJobLabel;
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
  const radio = document.querySelector('input[name="job-type"][value="' + suggested + '"]');
  if (radio) radio.checked = true;
  applyingPreset = false;
  applyJobTypeVisibility();
  return true;
}

async function switchJobPreset(prevJobId, targetJobId, label) {
  if (prevJobId && targetJobId && String(prevJobId) !== String(targetJobId)) {
    await saveJobPresetFor(prevJobId);
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
  // 与 v1.6.2 一致：进岗只在无理解时补一次，绝不在 loadJobs 路径上阻塞打 JD
  // （清单纠错请点「按 JD 刷新」，会整表重写）
  await ensureJobUnderstandingOnEnter();
  if (prevJobId && targetJobId && String(prevJobId) !== String(targetJobId)) {
    await pullResults();
  }
  return restored;
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
let lastKnownPageJobId = '';
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
  const text = label || activePresetJobLabel || jobLabelFallback(key);
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
  activePresetJobId = String(jobId);
  if (label) activePresetJobLabel = String(label);
  ensureJobSelectOption(activePresetJobId, label || activePresetJobLabel);
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
  const ageRangeValues = Array.from(document.querySelectorAll('#cond-age input[type="checkbox"]:checked')).map((c) => c.value);
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
  setCheckboxGroup('cond-age', hard.ageRangeValues || []);
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

function applyRequirementsToEditors(requirements, hard) {
  const req = MokaPersist.normalizeRequirements({ requirements: requirements || {} });
  importantEditor.set(req.important || []);
  niceEditor.set(req.nice || []);
}

function applyJobPreset(preset) {
  if (!preset) return false;
  applyingPreset = true;
  const type = document.querySelector('input[name="job-type"][value="' + preset.jobType + '"]');
  if (type) type.checked = true;
  applyJobTypeVisibility();
  writeHardConditions(preset.hard);
  // 只认本岗存档的 jobSpec，绝不用上一岗残留的 lastJobSpec
  lastJobSpec = preset.jobSpec || null;
  let req = preset.requirements || { must: preset.mustHaves || [], important: [], nice: [] };
  if ((!req.important || !req.important.length || !req.nice || !req.nice.length) && preset.jobSpec) {
    req = MokaPersist.fillRequirementsFromJobSpec(req, preset.jobSpec);
  }
  applyRequirementsToEditors(req, preset.hard);
  setWeights(preset.weights);
  if (preset.jobSpec && window.MokaPersist && MokaPersist.formatJobUnderstandingParts) {
    applyJobUnderstandingFromSpec(preset.jobSpec, '已恢复本岗理解');
  } else {
    setJobUnderstandingText(String(preset.jobUnderstanding || '').trim(), '已恢复本岗理解');
  }
  applyingPreset = false;
  return true;
}

function saveJobPresetFor(jobId) {
  if (applyingPreset || !window.MokaPersist) return Promise.resolve(false);
  const id = MokaPersist.jobPresetKey(jobId);
  if (!id) return Promise.resolve(false);
  const key = MokaPersist.JOB_PRESET_STORAGE_KEY;
  return chrome.storage.local.get(key).then((res) => {
    const next = MokaPersist.putJobPreset(res[key] || {}, id, collectJobPreset(), Date.now());
    return chrome.storage.local.set({ [key]: next });
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
      setPresetNote('保存失败，请稍后重试', '#fa8c16');
      showDockToast('保存失败，请稍后重试', 'warn');
    }
  } catch (e) {
    setPresetNote('保存失败，请稍后重试', '#fa8c16');
    showDockToast('保存失败，请稍后重试', 'warn');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function restoreCurrentJobPreset() {
  if (!window.MokaPersist) return Promise.resolve(false);
  const jobId = currentJobId();
  if (!jobId) return Promise.resolve(false);
  const key = MokaPersist.JOB_PRESET_STORAGE_KEY;
  return chrome.storage.local.get(key).then((res) => {
    const preset = MokaPersist.getJobPreset(res[key], jobId);
    presetFormJobId = String(jobId);
    // 存档里的理解若来自别的职位，连同它带出的门槛/关键词一起作废，重新按本岗 JD 解读
    const crossJob = !!preset && MokaPersist.jobSpecMatchesJob
      && !MokaPersist.jobSpecMatchesJob(preset.jobSpec, jobId);
    if (!preset || crossJob) {
      resetJobPresetForm({ internSuggested: /实习/.test(activePresetJobLabel || '') });
      setPresetNote(
        crossJob
          ? '存档里的理解来自其它职位，已清空，将按本岗 JD 重新解读'
          : '本岗尚未保存配置。首次会自动生成理解并保存。',
        crossJob ? '#fa8c16' : '#8c8c8c'
      );
      return false;
    }
    applyJobPreset(preset);
    // 老存档没记来源职位，验不了是不是本岗的，得让用户知道可以一键重解读
    const unstamped = !!preset.jobSpec && !preset.jobSpec.sourceJobId;
    setPresetNote(
      unstamped
        ? '已自动填充本岗配置（旧存档，理解若不是本岗请点「按 JD 刷新」）'
        : '已自动填充本岗配置',
      '#52c41a'
    );
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
 * 进入本岗：已有理解则不动；否则解读 JD 写入摘要 + 空栏要求，并自动落盘（下次免刷新）
 */
async function ensureJobUnderstandingOnEnter() {
  if (!currentJobId() && !effectiveJobId()) return false;
  if (hasJobUnderstandingContent()) return false;
  // 存档里已有 jobSpec.summary 时，先渲染摘要，仍不必打 AI
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
    if (hasJobUnderstandingContent()) {
      await saveJobPresetFor(currentJobId() || effectiveJobId());
      return true;
    }
  }
  const ok = await refreshUnderstandingAndRequirements({
    silentNote: '正在生成本岗理解…',
    doneNote: '已自动生成本岗理解并保存，下次进入直接恢复',
    autoSave: true,
    replaceRequirements: true
  });
  return !!ok;
}

/** 迁移场景：重要/加分空且无理解时，由 ensureJobUnderstandingOnEnter 统一处理 */
function maybeFillEmptyRequirementsFromJd() {
  // 保留空实现以免旧调用报错；逻辑已并入 ensureJobUnderstandingOnEnter
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
        if (note) note.style.color = '#52c41a';
        const finish = () => resolve(true);
        if (options.autoSave) {
          saveJobPresetFor(targetJobId).then(finish).catch(finish);
        } else {
          finish();
        }
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

// API 提供商切换时联动默认 Endpoint 占位
document.getElementById('api-provider').addEventListener('change', (e) => {
  const endpoint = document.getElementById('api-endpoint');
  const map = {
    openai: 'https://api.openai.com/v1/chat/completions',
    claude: 'https://api.anthropic.com/v1/messages',
    custom: '请填写你的自定义 API Endpoint'
  };
  endpoint.placeholder = map[e.target.value] || map.openai;
});

// API Key 显示/隐藏切换
document.getElementById('toggle-api-key').addEventListener('click', function () {
  const apiKeyInput = document.getElementById('api-key');
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    this.textContent = '🙈';
  } else {
    apiKeyInput.type = 'password';
    this.textContent = '👁️';
  }
});

// 本地私有配置（config.local.js，已 gitignore）：如存在则强制/锁定这三项
const LOCAL_FORCED = (typeof window !== 'undefined' && window.MOKA_LOCAL_SETTINGS) ? window.MOKA_LOCAL_SETTINGS : {};

function applyLocalForced() {
  if (!LOCAL_FORCED || !Object.keys(LOCAL_FORCED).length) return;
  const map = { apiProvider: 'api-provider', apiEndpoint: 'api-endpoint', modelName: 'model-name' };
  Object.entries(map).forEach(([k, id]) => {
    if (LOCAL_FORCED[k] == null) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.value = LOCAL_FORCED[k];
    el.disabled = true;
    el.title = '已由本地私有配置锁定';
  });
}

function readSettingsForm() {
  return {
    apiProvider: document.getElementById('api-provider').value,
    apiEndpoint: document.getElementById('api-endpoint').value.trim(),
    apiKey: document.getElementById('api-key').value,
    modelName: document.getElementById('model-name').value.trim(),
    notifyOnComplete: !!document.getElementById('notify-on-complete')?.checked,
    ...LOCAL_FORCED // 强制覆盖 provider/endpoint/model
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

// 保存设置
document.getElementById('save-settings').addEventListener('click', async () => {
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
    showTestResult('✅ 设置已保存', 'success');
  } catch (error) {
    showTestResult('❌ 保存失败: ' + error.message, 'error');
  }
});

// 测试 API（通过 background 统一调用，正确适配各 provider）
document.getElementById('test-api').addEventListener('click', async () => {
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

  showTestResult('⏳ 测试中...', 'info');

  chrome.runtime.sendMessage({ action: 'testApi', settings }, (response) => {
    if (chrome.runtime.lastError) {
      showTestResult('❌ 连接失败: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (response && response.ok) {
      showTestResult('✅ API 连接成功！', 'success');
    } else {
      showTestResult('❌ ' + (response?.error || 'API 连接失败'), 'error');
    }
  });
});

function showTestResult(message, type) {
  const resultDiv = document.getElementById('test-result');
  resultDiv.textContent = message;
  resultDiv.className = `test-result ${type}`;
  resultDiv.classList.remove('hidden');

  if (type === 'success') {
    setTimeout(() => resultDiv.classList.add('hidden'), 3000);
  }
}

// 加载已保存设置
async function loadSettings() {
  try {
    const result = await chrome.storage.local.get('mokaSettings');
    if (result.mokaSettings) {
      const s = result.mokaSettings;
      document.getElementById('api-provider').value = s.apiProvider || 'openai';
      document.getElementById('api-endpoint').value = s.apiEndpoint || 'https://api.openai.com/v1/chat/completions';
      document.getElementById('api-key').value = s.apiKey || '';
      document.getElementById('model-name').value = s.modelName || 'gpt-4o';
      const notifyEl = document.getElementById('notify-on-complete');
      if (notifyEl) notifyEl.checked = s.notifyOnComplete !== false;
    }
  } catch (error) {
    console.error('加载设置失败:', error);
  }
  applyLocalForced(); // 本地私有配置：覆盖并锁定 provider/endpoint/model
}

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
      await restoreCurrentJobPreset();
      await ensureJobUnderstandingOnEnter();
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
  const { targetJobId, label, pageJobId } = resolveTargetJobFromResponse(response, jobs);
  if (pageJobId) lastKnownPageJobId = pageJobId;
  // 表单里已经是这个岗位时只同步下拉，避免刷新风暴反复 restore 覆盖正在编辑的内容；
  // 但表单尚未装过它（例如刚打开侧栏）就必须读存档，否则保存过的条件带不出来
  const formHoldsTargetJob = !!targetJobId && !!window.MokaPersist
    && !MokaPersist.needsPresetReload(targetJobId, presetFormJobId);
  if (formHoldsTargetJob) {
    if (label) activePresetJobLabel = String(label);
    ensureJobSelectOption(targetJobId, label || activePresetJobLabel);
    jobSelect.value = targetJobId;
  } else {
    await switchJobPreset(prevJobId, targetJobId, label);
  }
  refreshCalibrationButton();

  if (!jobSelectBound) {
    jobSelectBound = true;
    jobSelect.addEventListener('change', () => {
      const nextId = currentJobId();
      const selected = jobSelect.options[jobSelect.selectedIndex];
      const nextLabel = selected && selected.textContent ? selected.textContent : activePresetJobLabel;
      const prevId = activePresetJobId;
      switchJobPreset(prevId, nextId, nextLabel).then(() => {
        refreshCalibrationButton();
        hideCalibrationPanel();
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
    setCheckboxGroup('cond-school', af.schools);
    bits.push(af.schools.join('/'));
  }
  if (Array.isArray(af.ageRangeValues) && af.ageRangeValues.length) {
    setCheckboxGroup('cond-age', af.ageRangeValues);
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

/** 硬性「按 JD 预填」顺带补模型识别到的手写门槛。 */
function fillMustHavesFromJobSpec(onDone) {
  const apiKey = document.getElementById('api-key').value;
  if (!apiKey) {
    onDone(false);
    return;
  }
  getMokaTab().then((tab) => {
    if (!isMokaTab(tab)) {
      onDone(false);
      return;
    }
    const jobType = document.querySelector('input[name="job-type"]:checked').value;
    const targetJobId = currentJobId() || effectiveJobId();
    chrome.tabs.sendMessage(tab.id, { action: 'getJobSpec', jobType, jobId: targetJobId }, (response) => {
      if (chrome.runtime.lastError) {
        onDone(false);
        return;
      }
      const spec = response && response.spec;
      if (!spec || (currentJobId() || effectiveJobId()) !== targetJobId) {
        onDone(false);
        return;
      }
      lastJobSpec = spec;
      applyingPreset = true;
      try {
        if (Array.isArray(spec.mustHaves)) {
          const split = MokaMatch.splitMustHavesForHard(spec.mustHaves, readHardConditions());
          if (split.languages && split.languages.length) {
            languageEditor.set(languageEditor.get().concat(split.languages).slice(0, 6));
          }
          if (split.customGates && split.customGates.length) {
            customGateEditor.set(customGateEditor.get().concat(split.customGates).slice(0, 6));
          }
        }
        if (!importantEditor.get().length || !niceEditor.get().length) {
          const filled = MokaPersist.fillRequirementsFromJobSpec({
            must: [],
            important: importantEditor.get(),
            nice: niceEditor.get()
          }, spec);
          applyRequirementsToEditors(filled, readHardConditions());
        }
        if (!readJobUnderstandingText()) {
          applyJobUnderstandingFromSpec(spec, '硬性已预填；理解/重要/加分可再点上方刷新或手改');
        } else {
          const note = document.getElementById('understanding-note');
          if (note) {
            note.textContent = '硬性已预填；重要/加分空栏已尽量从 JD 补，可再改后保存';
            note.style.color = '#8c8c8c';
          }
        }
      } finally {
        applyingPreset = false;
      }
      onDone(languageEditor.get().length > 0 || customGateEditor.get().length > 0);
    });
  });
}

async function loadJobContext(opts) {
  const fromButton = !!(opts && opts.fromButton);
  const note = document.getElementById('autofill-note');
  const btn = document.getElementById('autofill-hard');
  const tab = await getMokaTab();
  if (!isMokaTab(tab)) {
    note.textContent = '请先打开 Moka 候选人列表页';
    note.style.color = '#fa8c16';
    return;
  }

  note.textContent = '正在读取 JD…';
  note.style.color = '#1890ff';
  if (btn) btn.disabled = true;

  const contextJobId = currentJobId() || effectiveJobId();
  chrome.tabs.sendMessage(tab.id, { action: 'getJobContext', jobId: contextJobId }, (response) => {
    if (chrome.runtime.lastError) {
      if (btn) btn.disabled = false;
      note.textContent = '未能读取 JD，请刷新 Moka 后重试';
      note.style.color = '#fa8c16';
      return;
    }
    const af = response && response.autofill;
    if (!af) {
      if (btn) btn.disabled = false;
      note.textContent = (response && response.error)
        || '未能读取 JD：请回到候选人列表页后重试（详情页需先在列表打开过）';
      note.style.color = '#fa8c16';
      return;
    }

    applyingPreset = true;
    let bits;
    try {
      bits = applyHardAutofill(af, { fromButton });
    } finally {
      applyingPreset = false;
    }
    const finish = (mustFromAi) => {
      if (btn) btn.disabled = false;
      if (mustFromAi && bits.indexOf('必须') === -1) bits.push('必须');
      if (bits.length) {
        note.textContent = '已识别：' + bits.join(' · ') + '，可再改（未点保存则开筛时会自动保存）';
        note.style.color = '#52c41a';
      } else {
        note.textContent = '该 JD 未写明硬性条件，请手动设置';
        note.style.color = '#fa8c16';
      }
      // 预填不自动落盘（与方案 D §4 一致）；开筛前会落盘
    };

    if (fromButton) fillMustHavesFromJobSpec(finish);
    else finish(false);
  });
}

document.getElementById('autofill-hard').addEventListener('click', () => {
  loadJobContext({ fromButton: true });
});

// 开始筛选
document.getElementById('start-screening').addEventListener('click', async () => {
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
document.getElementById('stop-screening').addEventListener('click', async () => {
  const tab = await getMokaTab();
  if (isMokaTab(tab)) {
    chrome.tabs.sendMessage(tab.id, { action: 'stopScreening' }, () => void chrome.runtime.lastError);
  }
  setScreeningUi(false);
  document.getElementById('progress-container').classList.add('hidden');
});

document.getElementById('save-job-preset').addEventListener('click', () => {
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
  } else if (request.action === 'mokaActionComplete') {
    refreshResultsAndJobContext();
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
  const desktopHint = (payload && payload.desktop === false)
    ? '桌面通知未弹出（请检查系统通知权限，或到设置确认已开启）'
    : '';
  setResultHint(desktopHint ? `${msg} · ${desktopHint}` : msg, { tone: 'ok' });
  const banner = document.getElementById('result-banner');
  if (banner) {
    banner.classList.add('show');
    banner.textContent = '';
    const ok = document.createElement('div');
    ok.className = 'mp-banner-ok';
    ok.textContent = '✓ ' + msg;
    banner.appendChild(ok);
    if (payload && payload.desktop === false) {
      banner.appendChild(document.createTextNode('若未看到系统通知：打开 macOS「系统设置 → 通知 → Google Chrome」并允许通知。'));
    }
    setTimeout(() => {
      if (banner.querySelector('.mp-banner-ok')) {
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
  actionable.forEach((sug) => listEl.appendChild(buildSuggestionCard(sug)));
  infos.forEach((sug) => listEl.appendChild(buildSuggestionCard(sug)));
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
  await loadSettings();
  await loadFeedbackFromStorage();
  await loadActivePresetJobId();
  await refreshResultsAndJobContext();
  await pollScreeningJobOffer();
  applyJobTypeVisibility();
  updateWeightLabels();
  bindResultFilters();
});

const DIM_LABEL = { experience: '经验', skill: '技能', education: '教育', potential: '潜力' };
const ROW_STAGE = { enrich: '① 补全经历…', score: '② AI 评分中…' };

const KEEP_TAB_TIP = 'Moka 标签请保持打开（可切去其他浏览器标签）';
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

const resultState = { items: [], status: '', banner: null, screening: false };
const resultFilter = { tab: 'all', query: '' };
let feedbackRecord = {};
let saveFeedbackTimer = null;
let mokaActionInFlight = null;
let scrollListToTopPending = false;

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
  downloadTextFile(`moka-已决策-${new Date().toISOString().slice(0, 10)}.csv`, csv);
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

function switchResultTab(tab) {
  const next = tab === 'hardfail' ? 'all' : (tab || 'all');
  resultFilter.tab = next;
  document.querySelectorAll('#results-tab .mp-filter').forEach((b) => {
    b.classList.toggle('on', (b.dataset.filter || 'all') === resultFilter.tab);
  });
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

function setCandidateFeedback(appId, verdict, view) {
  const jobId = effectiveJobId();
  if (!jobId) {
    setPresetNote('请先选择职位后再标注反馈', '#fa8c16');
    return;
  }
  const current = MokaFeedback.getFeedbackVerdict(feedbackRecord, jobId, appId);
  const nextVerdict = current === verdict ? null : verdict;
  saveCandidateFeedback(appId, nextVerdict, view);
  renderResults();
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

function isMokaActionLocked() {
  return !!mokaActionInFlight;
}

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
  } catch (e) {
    markFeedbackSyncState(appId, 'failed');
    markRescoreError(e.message || 'Moka 操作失败');
  } finally {
    mokaActionInFlight = null;
    setViewMokaActionBusy(appId, false);
    renderResults();
  }
}

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
  setScreeningUi(resultState.screening);
  updateExportButton();
  if (resultState.screening) {
    document.getElementById('progress-container').classList.remove('hidden');
  }
  renderResults();
}

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
  const search = document.getElementById('result-search');
  search.addEventListener('input', () => {
    resultFilter.query = search.value || '';
    renderResults();
  });
  document.getElementById('export-results').addEventListener('click', () => {
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
  const fb = jobId ? MokaFeedback.summarizeFeedback(feedbackRecord, jobId) : { total: 0, recommend: 0, eliminate: 0 };
  const fbText = fb.total ? ` · 已决策 ${fb.total}（已推荐 ${fb.recommend} · 已淘汰 ${fb.eliminate}）` : '';
  if (sum.total) {
    setResultSummary(`评分 ${sum.scored}/${sum.total} · 推荐 ${sum.recommend}${fbText}`);
  } else if (fb.total) {
    setResultSummary(`已决策 ${fb.total}（已推荐 ${fb.recommend} · 已淘汰 ${fb.eliminate}）`);
  } else {
    setResultSummary(resultState.screening ? '准备筛选…' : '尚未开始筛选');
  }

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

function buildEvidenceSplit(appId, cols) {
  const split = document.createElement('div');
  split.className = 'mp-split' + (!cols.left.length || !cols.right.length ? ' mp-split-single' : '');

  if (cols.left.length) {
    const col = document.createElement('div');
    col.className = 'mp-col hit';
    const title = document.createElement('div');
    title.className = 'mp-col-title';
    title.textContent = '具备';
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
  }

  if (cols.right.length) {
    const col = document.createElement('div');
    col.className = 'mp-col miss';
    const title = document.createElement('div');
    title.className = 'mp-col-title';
    title.textContent = '未体现';
    col.appendChild(title);
    cols.right.forEach((r) => {
      const line = document.createElement('div');
      line.className = 'mp-miss' + (r.kind === 'waived' ? ' waived' : '');
      const body = document.createElement('div');
      body.className = 'mp-miss-text';
      const mark = document.createElement('span');
      mark.className = 'mp-mark no';
      mark.textContent = r.kind === 'waived' ? '○' : '✕';
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

  return split;
}

function createResultRow(view) {
  const row = document.createElement('div');
  row.className = 'mp-row'
    + (view.hardPassed === false ? ' failed' : '')
    + (view.stage || view.rescoring ? ' scoring' : '');

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

    if (s.level !== '错误' && (s.advanceReason === 'gate' || s.advanceReason === 'match')) {
      const reason = document.createElement('div');
      reason.className = 'mp-advance-reason';
      reason.textContent = s.advanceReason === 'gate'
        ? '未过门槛'
        : '经历/技能匹配不足';
      info.appendChild(reason);
      if (s.advanceReason === 'gate' && Array.isArray(s.unmet) && s.unmet.length) {
        const gateList = document.createElement('div');
        gateList.className = 'mp-gate-list mp-tags';
        s.unmet.forEach((gate) => {
          const item = String((gate && gate.item) || '').trim();
          if (!item) return;
          const tag = document.createElement('span');
          tag.className = 'mp-tag-fail';
          tag.textContent = item;
          if (gate.reason) tag.title = gate.reason;
          gateList.appendChild(tag);
        });
        if (gateList.childNodes.length) info.appendChild(gateList);
      }
    }

    if (s.dims) {
      const dimsEl = document.createElement('div');
      dimsEl.className = 'mp-dims';
      WEIGHT_KEYS.forEach((k) => {
        const d = s.dims[k];
        if (!d) return;
        const span = document.createElement('span');
        span.className = 'mp-dim';
        span.textContent = `${DIM_LABEL[k]}${d.score}`;
        if (d.reason) span.title = `${DIM_LABEL[k]}：${d.reason}`;
        dimsEl.appendChild(span);
      });
      info.appendChild(dimsEl);
    }

    if (s.level !== '错误') {
      const cols = MokaMatch.evidenceColumnsFromScore(s);
      if (cols.left.length || cols.right.length) {
        info.appendChild(buildEvidenceSplit(view.id, cols));
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

async function requestRescore(appId) {
  setViewRescoring(appId, true);
  const resp = await sendToMoka({ action: 'rescore', appId });
  await refreshResultsAndJobContext();
  if (!resp || !resp.ok) {
    markRescoreError((resp && resp.error) || '重评失败：请刷新 Moka 页面后重试');
  }
}

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
