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
  location.reload();
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
  if (!w) return;
  WEIGHT_KEYS.forEach((k) => {
    if (typeof w[k] === 'number') document.getElementById('w-' + k).value = w[k];
  });
  updateWeightLabels();
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

function currentJobId() {
  return document.getElementById('job-select').value;
}

function setPresetNote(text, color) {
  const note = document.getElementById('preset-note');
  if (!note) return;
  note.textContent = text;
  if (color) note.style.color = color;
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
  mustHaveEditor.set(preset.mustHaves);
  keywordEditor.set(preset.keywords);
  setWeights(preset.weights);
  if (preset.jobSpec) lastJobSpec = preset.jobSpec;
  applyingPreset = false;
  return true;
}

function saveJobPresetFor(jobId) {
  if (applyingPreset || !window.MokaPersist) return Promise.resolve();
  const id = MokaPersist.jobPresetKey(jobId);
  if (!id) return Promise.resolve();
  const key = MokaPersist.JOB_PRESET_STORAGE_KEY;
  return chrome.storage.local.get(key).then((res) => {
    const next = MokaPersist.putJobPreset(res[key] || {}, id, collectJobPreset(), Date.now());
    return chrome.storage.local.set({ [key]: next });
  }).then(() => {
    setPresetNote('已保存本岗配置，下次打开会自动恢复', '#52c41a');
  });
}

function saveCurrentJobPreset() {
  return saveJobPresetFor(currentJobId());
}

function restoreCurrentJobPreset() {
  if (!window.MokaPersist) return Promise.resolve(false);
  const jobId = currentJobId();
  if (!jobId) return Promise.resolve(false);
  const key = MokaPersist.JOB_PRESET_STORAGE_KEY;
  return chrome.storage.local.get(key).then((res) => {
    const preset = MokaPersist.getJobPreset(res[key], jobId);
    if (!preset) {
      setPresetNote('本岗尚未保存配置。设好后会自动记住，不用每次再点预填。', '#8c8c8c');
      return false;
    }
    applyJobPreset(preset);
    setPresetNote('已恢复本岗上次配置，无需再点预填或生成权重', '#52c41a');
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
      note.textContent = '（未能解读 JD，可手动调整权重）';
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

function sendToMoka(message) {
  return getMokaTab().then((tab) => {
    if (!isMokaTab(tab)) return null;
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
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

  chrome.tabs.sendMessage(tab.id, { action: 'getJobs' }, (response) => {
    if (chrome.runtime.lastError) {
      jobSelect.innerHTML = '<option value="">无法连接页面，请刷新 Moka 后重试</option>';
      return;
    }
    const jobs = (response && response.jobs) || [];
    if (jobs.length === 0) {
      jobSelect.innerHTML = '<option value="">请打开候选人列表页（含 pipelineId）</option>';
      return;
    }
    jobSelect.innerHTML = '';
    jobs.forEach(job => {
      const option = document.createElement('option');
      option.value = job.id;
      option.textContent = job.name;
      jobSelect.appendChild(option);
    });
    // 当前页面通常只对应一个职位，自动选中，免去手动选择
    jobSelect.value = jobs[0].id;
    activePresetJobId = jobs[0].id;
    restoreCurrentJobPreset().then((restored) => {
      if (!restored && /实习/.test(jobs[0].name || '')) {
        const internRadio = document.querySelector('input[name="job-type"][value="intern"]');
        if (internRadio) internRadio.checked = true;
      }
      applyJobTypeVisibility();
    });
    refreshLastResultsButton();
  });

  if (!jobSelectBound) {
    jobSelectBound = true;
    jobSelect.addEventListener('change', () => {
      const nextId = currentJobId();
      const prevId = activePresetJobId;
      saveJobPresetFor(prevId).then(() => {
        activePresetJobId = nextId;
        return restoreCurrentJobPreset();
      });
      refreshLastResultsButton();
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
      note.textContent = '未能读取 JD，请手动设置';
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
    { action: 'startScreening', jobId: selectedJob, jobType, hardConditions, weights, maxCount, jobSpec, keywords },
    () => {
      if (chrome.runtime.lastError) {
        alert('❌ 无法连接页面，请刷新 Moka 后重试');
        return;
      }
      document.getElementById('progress-container').classList.remove('hidden');
      document.getElementById('start-screening').disabled = true;
      document.getElementById('stop-screening').disabled = false;
      switchTab('results');
    }
  );
});

// 停止筛选
document.getElementById('stop-screening').addEventListener('click', async () => {
  const tab = await getMokaTab();
  if (isMokaTab(tab)) {
    chrome.tabs.sendMessage(tab.id, { action: 'stopScreening' }, () => void chrome.runtime.lastError);
  }
  document.getElementById('progress-container').classList.add('hidden');
  document.getElementById('start-screening').disabled = false;
  document.getElementById('stop-screening').disabled = true;
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
  }
});

document.getElementById('suggest-weights').addEventListener('click', () => {
  loadJobSpec();
});

async function refreshLastResultsButton() {
  const btn = document.getElementById('show-last-results');
  const tab = await getMokaTab();
  if (!isMokaTab(tab)) {
    btn.disabled = true;
    return;
  }
  chrome.tabs.sendMessage(tab.id, { action: 'hasLastResults' }, (response) => {
    if (chrome.runtime.lastError || !response || !response.has) {
      btn.disabled = true;
      btn.title = '当前职位还没有保存过筛选结果';
      return;
    }
    btn.disabled = false;
    btn.title = response.savedAt ? `上次保存：${new Date(response.savedAt).toLocaleString()}` : '查看上次筛选结果';
  });
}

document.getElementById('show-last-results').addEventListener('click', async () => {
  const tab = await getMokaTab();
  if (!isMokaTab(tab)) return;
  chrome.tabs.sendMessage(tab.id, { action: 'showLastResults' }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      alert('❌ 没有可回看的上次结果，请先完成一轮筛选');
      return;
    }
    switchTab('results');
    pullResults();
  });
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

window.addEventListener('load', async () => {
  await loadSettings();
  loadJobs();
  applyJobTypeVisibility();
  updateWeightLabels();
  bindResultFilters();
  pullResults();
});

const DIM_LABEL = { experience: '经验', skill: '技能', education: '教育', potential: '潜力' };
const ROW_STAGE = { enrich: '① 补全经历…', score: '② AI 评分中…' };

const resultState = { items: [], status: '', banner: null, screening: false };
const resultFilter = { tab: 'all', query: '' };

function pullResults() {
  sendToMoka({ action: 'getResults' }).then((snap) => {
    if (snap && Array.isArray(snap.items)) applySnapshot(snap);
  });
}

function applySnapshot(snap) {
  if (!snap) return;
  resultState.items = Array.isArray(snap.items) ? snap.items : [];
  resultState.status = snap.status || '';
  resultState.banner = snap.banner || null;
  resultState.screening = !!snap.screening;
  document.getElementById('start-screening').disabled = resultState.screening;
  document.getElementById('stop-screening').disabled = !resultState.screening;
  document.getElementById('export-results').disabled = resultState.items.length === 0;
  if (resultState.screening) {
    document.getElementById('progress-container').classList.remove('hidden');
  }
  renderResults();
}

function bindResultFilters() {
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
    sendToMoka({ action: 'exportCsv' });
  });
}

function renderResults() {
  const banner = document.getElementById('result-banner');
  const status = document.getElementById('result-status');
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
  }

  const sum = MokaMatch.summarizeResultViews(resultState.items);
  const extra = resultState.status ? resultState.status : '尚未开始筛选。配好条件后点下方「开始筛选」。';
  status.textContent = sum.total
    ? `评分 ${sum.scored}/${sum.total} · 推荐 ${sum.recommend} · ${extra}`
    : extra;

  list.innerHTML = '';
  const visible = resultState.items.filter((v) => MokaMatch.viewMatchesFilter(v, resultFilter));
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'mp-empty';
    empty.textContent = sum.total ? '没有符合当前过滤的候选人' : '结果会出现在这里，左边 Moka 名单保持完整可见';
    list.appendChild(empty);
    return;
  }
  visible.forEach((view) => list.appendChild(createResultRow(view)));
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
          sendToMoka({
            action: 'waiveMustHave',
            appId,
            item: r.item,
            waived: r.action === 'ignore'
          });
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
    + (view.stage ? ' scoring' : '');

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

  const name = document.createElement('div');
  name.className = 'mp-name';
  name.textContent = view.name;
  info.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'mp-meta';
  meta.textContent = view.meta || '';
  info.appendChild(meta);

  if (view.stage && ROW_STAGE[view.stage]) {
    const stage = document.createElement('div');
    stage.className = 'mp-stage';
    stage.textContent = ROW_STAGE[view.stage];
    info.appendChild(stage);
    const bar = document.createElement('div');
    bar.className = 'mp-bar';
    const fill = document.createElement('i');
    fill.className = 'mp-bar-fill';
    fill.style.width = view.stage === 'score' ? '80%' : '45%';
    bar.appendChild(fill);
    row.appendChild(bar);
  }

  if (view.hardMissing.length) {
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
    if (s.penalty > 0 && s.baseScore != null) {
      const cut = document.createElement('span');
      cut.className = 'mp-penalty';
      cut.textContent = '（四维 ' + s.baseScore + ' − 硬性 ' + s.penalty + '）';
      level.appendChild(cut);
    }
    if (s.level === '错误') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'mp-retry';
      retry.textContent = '重评';
      retry.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        sendToMoka({ action: 'rescore', appId: view.id });
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
