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
  refreshMokaConnection();
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
    ageRanges
  };
}

function createChipEditor(listId, inputId) {
  const listEl = document.getElementById(listId);
  const inputEl = document.getElementById(inputId);
  let items = [];

  function render() {
    listEl.innerHTML = '';
    items.forEach((text, idx) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.appendChild(document.createTextNode(text));
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chip-x';
      x.textContent = '×';
      x.title = '删除';
      x.addEventListener('click', () => {
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

  function addFromString(str) {
    const parsed = (window.MokaMatch ? MokaMatch.parseChipList(str) : String(str || '').split(/[,，、;；\n]+/).map((s) => s.trim()).filter(Boolean));
    const before = items.length;
    parsed.forEach((t) => {
      const CHIP_MAX = (window.MokaMatch && MokaMatch.CHIP_LIMIT) || 6;
      if (items.length >= CHIP_MAX) return;
      if (!items.some((x) => x.toLowerCase() === t.toLowerCase())) items.push(t);
    });
    render();
    if (items.length !== before) notifyChipChange();
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
    onChange: (fn) => { onChange = fn; }
  };
}

const keywordEditor = createChipEditor('keyword-chips', 'keyword-input');
const mustHaveEditor = createChipEditor('must-chips', 'must-input');

// ---- 评分维度权重 ----
const WEIGHT_KEYS = ['experience', 'skill', 'education', 'potential'];
const DEFAULT_WEIGHTS = { experience: 40, skill: 30, education: 20, potential: 10 };
let lastJobSpec = null; // 缓存最近一次 JD 解读结果

function readWeights() {
  const w = {};
  WEIGHT_KEYS.forEach((k) => { w[k] = parseInt(document.getElementById('w-' + k).value, 10) || 0; });
  return w;
}

function updateWeightLabels() {
  const w = readWeights();
  const sum = WEIGHT_KEYS.reduce((a, k) => a + w[k], 0) || 1;
  WEIGHT_KEYS.forEach((k) => {
    document.getElementById('w-' + k + '-val').textContent = Math.round((w[k] / sum) * 100) + '%';
  });
}

function setWeights(w) {
  const src = w || DEFAULT_WEIGHTS;
  WEIGHT_KEYS.forEach((k) => {
    if (typeof src[k] === 'number') document.getElementById('w-' + k).value = src[k];
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
    ageRangeValues: []
  });
  mustHaveEditor.set([]);
  keywordEditor.set([]);
  setWeights(DEFAULT_WEIGHTS);
  lastJobSpec = null;
  const box = document.getElementById('jd-understanding');
  if (box) {
    box.classList.add('hidden');
    box.innerHTML = '';
  }
  applyingPreset = false;
}

function resolveTargetJobFromResponse(response, jobs) {
  const pageJob = jobs[0];
  const pageJobId = response.pageJobId
    || (pageJob && pageJob.id !== 'current' ? String(pageJob.id) : '');
  const memoryJobId = response.jobId ? String(response.jobId) : '';
  const targetJobId = pageJobId || memoryJobId || activePresetJobId || '';
  let label = activePresetJobLabel;
  if (pageJob && pageJobId && String(pageJob.id) === pageJobId) label = pageJob.name || label;
  else if (pageJob && targetJobId && String(pageJob.id) === targetJobId) label = pageJob.name || label;
  if (!label && response.jobName) label = response.jobName;
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
  if (prevJobId && targetJobId && prevJobId !== targetJobId) {
    await saveJobPresetFor(prevJobId);
    resultState.items = [];
    resultState.status = '';
    resultState.banner = null;
  }
  if (targetJobId) {
    syncActiveJobFromSnapshot(targetJobId, label);
    lastKnownPageJobId = targetJobId;
  }
  const restored = await restoreCurrentJobPreset();
  const fixedType = reconcileJobTypeWithLabel(label || activePresetJobLabel);
  if (!restored && jobTypeSuggestedByLabel(label || activePresetJobLabel) === 'intern') {
    // 无缓存时 reconcile 已设实习生；确保可见性
    applyJobTypeVisibility();
  }
  if (fixedType && restored) {
    // 纠正了错误类型后写回本岗配置，避免下次再恢复成正式员工
    scheduleSaveJobPreset();
  }
  if (prevJobId && targetJobId && prevJobId !== targetJobId) {
    await pullResults();
  }
  return restored;
}

WEIGHT_KEYS.forEach((k) => {
  document.getElementById('w-' + k).addEventListener('input', () => {
    updateWeightLabels();
    scheduleSaveJobPreset();
  });
});

let applyingPreset = false;
let savePresetTimer = null;
let jobSelectBound = false;
let activePresetJobId = '';
let activePresetJobLabel = '';
let lastKnownPageJobId = '';
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
  return MokaPersist.sanitizeJobPreset({
    jobType: document.querySelector('input[name="job-type"]:checked').value,
    hard: Object.assign({}, hard, { ageRangeValues }),
    weights: readWeights(),
    mustHaves: mustHaveEditor.get(),
    keywords: keywordEditor.get(),
    jobSpec: lastJobSpec
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
}

function applyJobPreset(preset) {
  if (!preset) return false;
  applyingPreset = true;
  const type = document.querySelector('input[name="job-type"][value="' + preset.jobType + '"]');
  if (type) type.checked = true;
  applyJobTypeVisibility();
  writeHardConditions(preset.hard);
  mustHaveEditor.set(MokaMatch.dedupeMustHavesAgainstHard(preset.mustHaves || [], preset.hard || {}));
  keywordEditor.set(preset.keywords);
  setWeights(preset.weights);
  if (preset.jobSpec) lastJobSpec = preset.jobSpec;
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

async function saveJobPresetFromButton() {
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
      setPresetNote('已保存当前筛选条件，下次进入本岗将自动填充', '#52c41a');
      showDockToast('保存成功，下次进入本岗将自动填充', 'ok');
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
    if (!preset) {
      resetJobPresetForm({ internSuggested: /实习/.test(activePresetJobLabel || '') });
      setPresetNote('本岗尚未保存配置。设好后会自动记住，不用每次再点预填。', '#8c8c8c');
      return false;
    }
    applyJobPreset(preset);
    setPresetNote('已自动填充本岗配置', '#52c41a');
    return true;
  });
}

function scheduleSaveJobPreset() {
  if (applyingPreset) return;
  clearTimeout(savePresetTimer);
  savePresetTimer = setTimeout(() => { saveCurrentJobPreset(); }, 400);
}

keywordEditor.onChange(scheduleSaveJobPreset);
mustHaveEditor.onChange(scheduleSaveJobPreset);

// 读取当前 JD → 生成岗位画像 + 建议权重，预填滑块
async function loadJobSpec() {
  const note = document.getElementById('weight-note');
  const box = document.getElementById('jd-understanding');
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

  chrome.tabs.sendMessage(tab.id, { action: 'getJobSpec', jobType: document.querySelector('input[name="job-type"]:checked').value }, (response) => {
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
    saveCurrentJobPreset();

    if (spec.summary) {
      box.classList.remove('hidden');
      box.innerHTML = '';
      const s = document.createElement('div');
      s.className = 'jd-summary';
      s.textContent = '岗位理解：' + spec.summary;
      box.appendChild(s);
    }
    note.textContent = '（已按 JD 生成建议权重，可再手动调整）';
    note.style.color = '#52c41a';
  });
}

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

async function refreshResultsAndJobContext() {
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
  const jobSelect = document.getElementById('job-select');
  const tab = await getMokaTab();

  if (!isMokaTab(tab)) {
    jobSelect.innerHTML = '<option value="">请先打开 Moka 页面</option>';
    return;
  }

  jobSelect.innerHTML = '<option value="">正在连接 Moka 页面…</option>';
  const response = await sendToMoka({ action: 'getJobs' }, { retries: 15, delayMs: 300 });
  if (!response) {
    jobSelect.innerHTML = '<option value="">无法连接页面，请刷新 Moka 后重试</option>';
    return;
  }
  const jobs = response.jobs || [];
  if (jobs.length === 0) {
    if (activePresetJobId) {
      ensureJobSelectOption(activePresetJobId, activePresetJobLabel);
      jobSelect.value = activePresetJobId;
      await restoreCurrentJobPreset();
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
  const prevJobId = activePresetJobId || currentJobId() || '';
  const { targetJobId, label, pageJobId } = resolveTargetJobFromResponse(response, jobs);
  if (pageJobId) lastKnownPageJobId = pageJobId;
  await switchJobPreset(prevJobId, targetJobId, label);
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
  if (Array.isArray(af.resumeKeywords) && af.resumeKeywords.length) {
    keywordEditor.set(af.resumeKeywords);
    bits.push('关键词 ' + af.resumeKeywords.length + ' 个');
  }
  const localMust = Array.isArray(af.majors) ? af.majors : [];
  if (localMust.length && (fromButton || mustHaveEditor.get().length === 0)) {
    mustHaveEditor.set(MokaMatch.dedupeMustHavesAgainstHard(localMust, readHardConditions()));
    if (mustHaveEditor.get().length) bits.push('其他必备');
  }
  return bits;
}

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
    chrome.tabs.sendMessage(tab.id, { action: 'getJobSpec', jobType }, (response) => {
      if (chrome.runtime.lastError) {
        onDone(false);
        return;
      }
      const spec = response && response.spec;
      if (!spec) {
        onDone(false);
        return;
      }
      lastJobSpec = spec;
      if (Array.isArray(spec.mustHaves)) {
        mustHaveEditor.set(MokaMatch.dedupeMustHavesAgainstHard(spec.mustHaves, readHardConditions()));
      }
      if (Array.isArray(spec.resumeKeywords) && spec.resumeKeywords.length) {
        keywordEditor.set(spec.resumeKeywords);
      }
      onDone(mustHaveEditor.get().length > 0);
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

  chrome.tabs.sendMessage(tab.id, { action: 'getJobContext' }, (response) => {
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

    const bits = applyHardAutofill(af, { fromButton });
    const finish = (mustFromAi) => {
      if (btn) btn.disabled = false;
      if (mustFromAi && bits.indexOf('其他必备') === -1) bits.push('其他必备');
      if (bits.length) {
        note.textContent = '已识别：' + bits.join(' · ') + '，可再改';
        note.style.color = '#52c41a';
      } else {
        note.textContent = '该 JD 未写明硬性条件，请手动设置';
        note.style.color = '#fa8c16';
      }
      saveCurrentJobPreset();
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
  const selectedJob = document.getElementById('job-select').value;
  const jobSelect = document.getElementById('job-select');
  const selectedLabel = jobSelect.options[jobSelect.selectedIndex]
    ? jobSelect.options[jobSelect.selectedIndex].textContent
    : '';
  if (!selectedJob) {
    alert('❌ 请选择职位');
    return;
  }

  const tab = await getMokaTab();
  if (!isMokaTab(tab)) {
    alert('❌ 请在 Moka 候选人管理页面使用');
    return;
  }

  const hardConditions = readHardConditions();
  const weights = readWeights();
  const jobType = document.querySelector('input[name="job-type"]:checked').value;
  const maxCount = Number(document.getElementById('max-count')?.value || 0);
  const keywords = keywordEditor.get();
  const mustHaves = MokaMatch.dedupeMustHavesAgainstHard(mustHaveEditor.get(), hardConditions);
  mustHaveEditor.set(mustHaves);
  const jobSpec = lastJobSpec
    ? { ...lastJobSpec, mustHaves }
    : (mustHaves.length ? { mustHaves } : null);

  saveCurrentJobPreset();

  chrome.tabs.sendMessage(
    tab.id,
    { action: 'startScreening', jobId: selectedJob, jobName: selectedLabel, jobType, hardConditions, weights, maxCount, jobSpec, keywords },
    () => {
      if (chrome.runtime.lastError) {
        alert('❌ 无法连接页面，请刷新 Moka 后重试');
        return;
      }
      syncActiveJobFromSnapshot(selectedJob, selectedLabel);
      setScreeningUi(true);
      hideResumeBanner();
      setResultHint('筛选已开始', { tip: true, tone: 'info' });
      switchTab('results');
    }
  );
});

function setScreeningUi(active) {
  document.getElementById('start-screening').disabled = !!active;
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
    scheduleMokaRefresh();
    pollScreeningJobOffer();
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

document.getElementById('suggest-weights').addEventListener('click', () => {
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
  if (sug.type === 'mustHave' || options.isAdd) {
    field = document.createElement('textarea');
    field.className = 'mp-cal-item-field';
    field.rows = 2;
    field.placeholder = '必备项文案，可修改后再保存';
    field.value = sug.editableValue || '';
    item.appendChild(field);
  }

  if (sug.type === 'weight' || sug.type === 'mustHave' || options.isAdd) {
    const actions = document.createElement('div');
    actions.className = 'mp-cal-item-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = '采纳并保存';
    btn.addEventListener('click', () => {
      if (sug.type === 'mustHave' || options.isAdd) {
        const value = field ? field.value.trim() : '';
        if (!value) {
          showDockToast('请先填写必备项文案', 'warn');
          if (field) field.focus();
          return;
        }
        applyCalibrationSuggestion({
          type: 'mustHave',
          apply: { mustHave: value }
        });
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
    weights: readWeights()
  });

  appendCalMetric(metricsEl, report.total, '已决策');
  appendCalMetric(metricsEl, report.recommend, '已推荐');
  appendCalMetric(metricsEl, report.eliminate, '已淘汰');
  appendCalMetric(metricsEl, report.agree, '与 AI 一致', 'ok');
  appendCalMetric(metricsEl, report.overRecommend, 'AI 推你却淘汰', report.overRecommend ? 'warn' : '');
  appendCalMetric(metricsEl, report.underRecommend, '你推 AI 未推', report.underRecommend ? 'warn' : '');

  const signals = (report.topConcerns || []).slice(0, 3);
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

  const actionable = (report.suggestions || []).filter((s) => s.type === 'weight' || s.type === 'mustHave');
  const infos = (report.suggestions || []).filter((s) => s.type === 'info');
  actionable.forEach((sug) => listEl.appendChild(buildSuggestionCard(sug)));
  infos.forEach((sug) => listEl.appendChild(buildSuggestionCard(sug)));
  listEl.appendChild(buildSuggestionCard({
    type: 'mustHave',
    title: '自行新增必备项',
    detail: '不依赖系统建议，直接写入本岗必备项。',
    editableValue: ''
  }, { isAdd: true }));

  panel.classList.remove('hidden');
  const tab = document.getElementById('results-tab');
  if (tab) tab.classList.add('cal-open');
  switchTab('results');
}

async function applyCalibrationSuggestion(sug) {
  if (!sug || !sug.apply) return;
  if (sug.type === 'weight' && sug.apply.weights) {
    setWeights(sug.apply.weights);
    updateWeightLabels();
  } else if (sug.type === 'mustHave' && sug.apply.mustHave) {
    const cur = mustHaveEditor.get();
    let item = String(sug.apply.mustHave).trim();
    if (window.MokaCalibrate && MokaCalibrate.normalizeMustHaveLabel) {
      item = MokaCalibrate.normalizeMustHaveLabel(item) || item;
    }
    if (!item) {
      showDockToast('必备项文案无效', 'warn');
      return;
    }
    if (!cur.includes(item)) mustHaveEditor.set(cur.concat([item]));
  } else {
    return;
  }
  const ok = await saveJobPresetFor(effectiveJobId());
  if (ok) {
    showDockToast('保存成功，下次进入本岗将自动填充', 'ok');
    setPresetNote('已按校准建议更新本岗配置，下次进入将自动填充', '#52c41a');
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
    scheduleSaveJobPreset();
  });
});

['cond-degree', 'cond-exp', 'cond-gender', 'cond-internship'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', scheduleSaveJobPreset);
});
document.querySelectorAll('#cond-school input, #cond-age input').forEach((el) => {
  el.addEventListener('change', scheduleSaveJobPreset);
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
    penalty: s.penalty,
    level: s.level,
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

  const current = MokaFeedback.getFeedbackVerdict(feedbackRecord, jobId, appId);
  if (current === verdict) {
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
    if (resp && resp.ok === false && !resp.pending) {
      completePromise.cancel();
      markFeedbackSyncState(appId, 'failed');
      markRescoreError(resp.error || 'Moka 操作失败');
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
    resultState.screening = !!snap.screening;
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
    + (view.structuredHardPassed === false ? ' failed' : '')
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

  if (view.hardMissing && view.hardMissing.length) {
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

  const kw = view.keywords;
  if (kw && (kw.hit.length || kw.miss.length)) {
    const wrap = document.createElement('div');
    wrap.className = 'mp-tags';
    kw.miss.forEach((k) => {
      const tag = document.createElement('span');
      tag.className = 'mp-tag-warn';
      tag.textContent = '未提及 ' + k;
      wrap.appendChild(tag);
    });
    kw.hit.slice(0, 4).forEach((k) => {
      const tag = document.createElement('span');
      tag.className = 'mp-tag-hit';
      tag.textContent = k;
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
    const penaltyHint = MokaScore.formatPenaltyHint(s);
    if (penaltyHint) {
      const cut = document.createElement('span');
      cut.className = 'mp-penalty';
      cut.textContent = penaltyHint;
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
      title: '在 Moka 中推荐给用人部门并自动确认（再点取消本地记录）'
    },
    {
      verdict: 'eliminate',
      label: '淘汰',
      busyLabel: '淘汰中…',
      title: '在 Moka 中淘汰（再点取消本地记录）'
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
