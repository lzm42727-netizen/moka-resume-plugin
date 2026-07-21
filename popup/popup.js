// 标签页切换
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(`${tabName}-tab`).classList.add('active');
  });
});

// 读取硬性条件表单
function readHardConditions() {
  const schools = Array.from(document.querySelectorAll('#cond-school input[type="checkbox"]:checked')).map((c) => c.value);
  const ageVal = document.querySelector('input[name="cond-age"]:checked')?.value || '';
  let ageMin = null;
  let ageMax = null;
  if (ageVal.endsWith('+')) {
    ageMin = parseInt(ageVal, 10);
  } else if (ageVal.includes('-')) {
    const [a, b] = ageVal.split('-').map((n) => parseInt(n, 10));
    ageMin = Number.isFinite(a) ? a : null;
    ageMax = Number.isFinite(b) ? b : null;
  }
  return {
    degree: document.getElementById('cond-degree').value,
    schools,
    exp: document.getElementById('cond-exp').value,
    gender: document.getElementById('cond-gender').value,
    internship: document.getElementById('cond-internship').value,
    ageMin,
    ageMax
  };
}

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
  document.getElementById('w-' + k).addEventListener('input', updateWeightLabels);
});

// 读取当前 JD → 生成岗位画像 + 建议权重，预填滑块
async function loadJobSpec() {
  const note = document.getElementById('weight-note');
  const box = document.getElementById('jd-understanding');
  const apiKey = document.getElementById('api-key').value;
  if (!apiKey) {
    note.textContent = '（配置 API 后可自动生成建议权重）';
    note.style.color = '#fa8c16';
    return;
  }

  const tab = await getActiveTab();
  if (!isMokaTab(tab)) return;

  const jobType = document.querySelector('input[name="job-type"]:checked').value;
  note.textContent = '（正在解读 JD 生成建议权重...）';
  note.style.color = '#1890ff';

  chrome.tabs.sendMessage(tab.id, { action: 'getJobSpec', jobType }, (response) => {
    if (chrome.runtime.lastError) {
      note.textContent = '（未能解读 JD，用默认权重，可手动调整）';
      note.style.color = '#fa8c16';
      return;
    }
    const spec = response && response.spec;
    if (!spec) {
      note.textContent = '（未能解读 JD，用默认权重，可手动调整）';
      note.style.color = '#fa8c16';
      return;
    }
    lastJobSpec = spec;
    setWeights(spec.suggestedWeights);

    if (spec.summary || (spec.mustHaves && spec.mustHaves.length)) {
      box.classList.remove('hidden');
      box.innerHTML = '';
      if (spec.summary) {
        const s = document.createElement('div');
        s.className = 'jd-summary';
        s.textContent = '岗位理解：' + spec.summary;
        box.appendChild(s);
      }
      if (spec.mustHaves && spec.mustHaves.length) {
        const m = document.createElement('div');
        m.className = 'jd-musts';
        m.textContent = '必备项：' + spec.mustHaves.join('、');
        box.appendChild(m);
      }
    }
    note.textContent = '（已按 JD 生成建议权重，可自行调整）';
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

function readSettingsForm() {
  return {
    apiProvider: document.getElementById('api-provider').value,
    apiEndpoint: document.getElementById('api-endpoint').value.trim(),
    apiKey: document.getElementById('api-key').value,
    modelName: document.getElementById('model-name').value.trim(),
    autoSaveScores: document.getElementById('auto-save-scores').checked
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
      document.getElementById('auto-save-scores').checked = s.autoSaveScores || false;
    }
  } catch (error) {
    console.error('加载设置失败:', error);
  }
}

// 获取当前活动标签页
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isMokaTab(tab) {
  return tab && tab.url && tab.url.startsWith('https://app.mokahr.com/');
}

// 加载职位列表（带非 Moka 页面容错）
async function loadJobs() {
  const jobSelect = document.getElementById('job-select');
  const tab = await getActiveTab();

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
    // 职位名含「实习」时自动切到实习生类型
    if (/实习/.test(jobs[0].name || '')) {
      const internRadio = document.querySelector('input[name="job-type"][value="intern"]');
      if (internRadio) internRadio.checked = true;
    }
    applyJobTypeVisibility();
    // 职位已就绪：预填硬性条件 + 解读 JD 生成建议权重
    loadJobContext();
    loadJobSpec();
  });

  // 手动切换职位后重新预填
  jobSelect.addEventListener('change', () => { loadJobContext(); loadJobSpec(); });
}

// 根据职位类型显示/隐藏 经验要求 / 实习经验
function applyJobTypeVisibility() {
  const isIntern = document.querySelector('input[name="job-type"]:checked')?.value === 'intern';
  const rowExp = document.getElementById('row-exp');
  const rowIntern = document.getElementById('row-internship');
  if (rowExp) rowExp.style.display = isIntern ? 'none' : '';
  if (rowIntern) rowIntern.style.display = isIntern ? '' : 'none';
}

// 根据当前 JD 自动预填硬性条件
async function loadJobContext() {
  const note = document.getElementById('autofill-note');
  const tab = await getActiveTab();
  if (!isMokaTab(tab)) {
    note.textContent = '（请先打开 Moka 候选人列表页）';
    note.style.color = '#fa8c16';
    return;
  }

  note.textContent = '（正在读取 JD...）';
  note.style.color = '#1890ff';

  chrome.tabs.sendMessage(tab.id, { action: 'getJobContext' }, (response) => {
    if (chrome.runtime.lastError) {
      note.textContent = '（未能读取 JD，请刷新 Moka 后重试）';
      note.style.color = '#fa8c16';
      return;
    }
    const af = response && response.autofill;
    if (!af) {
      note.textContent = '（未能读取 JD，请手动设置）';
      note.style.color = '#fa8c16';
      return;
    }

    let filled = 0;
    if (af.degree) {
      document.getElementById('cond-degree').value = af.degree;
      filled++;
    }
    if (Array.isArray(af.schools) && af.schools.length) {
      document.querySelectorAll('#cond-school input[type="checkbox"]').forEach((c) => {
        if (af.schools.includes(c.value)) c.checked = true;
      });
      filled++;
    }

    if (filled > 0) {
      note.textContent = '（已根据当前 JD 预填，可修改）';
      note.style.color = '#52c41a';
    } else {
      note.textContent = '（该 JD 无结构化硬性要求，请手动设置）';
      note.style.color = '#fa8c16';
    }
  });
}

// 开始筛选
document.getElementById('start-screening').addEventListener('click', async () => {
  const selectedJob = document.getElementById('job-select').value;
  if (!selectedJob) {
    alert('❌ 请选择职位');
    return;
  }

  const tab = await getActiveTab();
  if (!isMokaTab(tab)) {
    alert('❌ 请在 Moka 候选人管理页面使用');
    return;
  }

  const hardConditions = readHardConditions();
  const weights = readWeights();
  const jobType = document.querySelector('input[name="job-type"]:checked').value;
  const maxCount = Number(document.getElementById('max-count')?.value || 0);

  chrome.tabs.sendMessage(
    tab.id,
    { action: 'startScreening', jobId: selectedJob, jobType, hardConditions, weights, maxCount, jobSpec: lastJobSpec },
    () => {
      if (chrome.runtime.lastError) {
        alert('❌ 无法连接页面，请刷新 Moka 后重试');
        return;
      }
      document.getElementById('progress-container').classList.remove('hidden');
      document.getElementById('start-screening').disabled = true;
      document.getElementById('stop-screening').disabled = false;
    }
  );
});

// 停止筛选
document.getElementById('stop-screening').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (isMokaTab(tab)) {
    chrome.tabs.sendMessage(tab.id, { action: 'stopScreening' }, () => void chrome.runtime.lastError);
  }
  document.getElementById('progress-container').classList.add('hidden');
  document.getElementById('start-screening').disabled = false;
  document.getElementById('stop-screening').disabled = true;
});

// 接收进度更新
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'updateProgress') {
    document.getElementById('progress-text').textContent = request.message;
    document.getElementById('progress-count').textContent = `${request.current}/${request.total}`;
    document.getElementById('progress-fill').style.width = `${request.percentage}%`;
  }
});

document.querySelectorAll('input[name="job-type"]').forEach((r) => {
  r.addEventListener('change', () => {
    applyJobTypeVisibility();
    loadJobSpec(); // 职位类型影响 JD 解读与建议权重，重新生成
  });
});

window.addEventListener('load', async () => {
  await loadSettings(); // 先读到 API Key，loadJobSpec 才能触发解读
  loadJobs();
  applyJobTypeVisibility();
  updateWeightLabels();
});
