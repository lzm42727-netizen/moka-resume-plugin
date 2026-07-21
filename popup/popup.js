// 标签页切换
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;
        
        // 移除所有 active 类
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        
        // 添加 active 类
        btn.classList.add('active');
        document.getElementById(`${tabName}-tab`).classList.add('active');
    });
});

// 权重滑块联动
const weightInputs = {
    education: document.getElementById('education-weight'),
    experience: document.getElementById('experience-weight'),
    skill: document.getElementById('skill-weight')
};

function updateWeightTotal() {
    const total = parseInt(weightInputs.education.value) + 
                  parseInt(weightInputs.experience.value) + 
                  parseInt(weightInputs.skill.value);
    
    document.getElementById('education-weight-value').textContent = weightInputs.education.value + '%';
    document.getElementById('experience-weight-value').textContent = weightInputs.experience.value + '%';
    document.getElementById('skill-weight-value').textContent = weightInputs.skill.value + '%';
    document.getElementById('weight-total').textContent = total;
    
    // 如果总和不是 100，改变颜色提示
    const totalElement = document.querySelector('.weight-total');
    if (total === 100) {
        totalElement.style.background = '#e6f7ff';
        totalElement.style.color = '#1890ff';
    } else {
        totalElement.style.background = '#fff7e6';
        totalElement.style.color = '#fa8c16';
    }
}

Object.values(weightInputs).forEach(input => {
    input.addEventListener('input', updateWeightTotal);
});

// API Key 显示/隐藏切换
document.getElementById('toggle-api-key').addEventListener('click', function() {
    const apiKeyInput = document.getElementById('api-key');
    if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        this.textContent = '🙈';
    } else {
        apiKeyInput.type = 'password';
        this.textContent = '👁️';
    }
});

// 保存设置
document.getElementById('save-settings').addEventListener('click', async () => {
    const settings = {
        apiProvider: document.getElementById('api-provider').value,
        apiEndpoint: document.getElementById('api-endpoint').value,
        apiKey: document.getElementById('api-key').value,
        modelName: document.getElementById('model-name').value,
        autoSaveScores: document.getElementById('auto-save-scores').checked
    };
    
    if (!settings.apiKey) {
        alert('❌ 请输入 API Key');
        return;
    }
    
    try {
        await chrome.storage.local.set({ mokaSettings: settings });
        showTestResult('✅ 设置已保存', 'success');
    } catch (error) {
        showTestResult('❌ 保存失败: ' + error.message, 'error');
    }
});

// 测试 API
document.getElementById('test-api').addEventListener('click', async () => {
    const apiKey = document.getElementById('api-key').value;
    const apiEndpoint = document.getElementById('api-endpoint').value;
    const modelName = document.getElementById('model-name').value;
    
    if (!apiKey) {
        showTestResult('❌ 请输入 API Key', 'error');
        return;
    }
    
    showTestResult('⏳ 测试中...', 'info');
    
    try {
        const response = await fetch(apiEndpoint || 'https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName || 'gpt-4o',
                messages: [
                    { role: 'user', content: '测试' }
                ],
                max_tokens: 10
            })
        });
        
        if (response.ok) {
            showTestResult('✅ API 连接成功！', 'success');
        } else {
            showTestResult(`❌ API 错误: ${response.status} ${response.statusText}`, 'error');
        }
    } catch (error) {
        showTestResult('❌ 连接失败: ' + error.message, 'error');
    }
});

// 显示测试结果
function showTestResult(message, type) {
    const resultDiv = document.getElementById('test-result');
    resultDiv.textContent = message;
    resultDiv.className = `test-result ${type}`;
    resultDiv.classList.remove('hidden');
    
    if (type === 'success') {
        setTimeout(() => {
            resultDiv.classList.add('hidden');
        }, 3000);
    }
}

// 页面加载时获取保存的设置
window.addEventListener('load', async () => {
    try {
        const result = await chrome.storage.local.get('mokaSettings');
        if (result.mokaSettings) {
            const settings = result.mokaSettings;
            document.getElementById('api-provider').value = settings.apiProvider || 'openai';
            document.getElementById('api-endpoint').value = settings.apiEndpoint || 'https://api.openai.com/v1/chat/completions';
            document.getElementById('api-key').value = settings.apiKey || '';
            document.getElementById('model-name').value = settings.modelName || 'gpt-4o';
            document.getElementById('auto-save-scores').checked = settings.autoSaveScores || false;
        }
    } catch (error) {
        console.error('加载设置失败:', error);
    }
});

// 开始筛选按钮
document.getElementById('start-screening').addEventListener('click', async () => {
    const jobSelect = document.getElementById('job-select');
    const selectedJob = jobSelect.value;
    
    if (!selectedJob) {
        alert('❌ 请选择职位');
        return;
    }
    
    // 获取当前标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // 获取权重配置
    const weights = {
        education: parseInt(document.getElementById('education-weight').value),
        experience: parseInt(document.getElementById('experience-weight').value),
        skill: parseInt(document.getElementById('skill-weight').value)
    };
    
    const jobType = document.querySelector('input[name="job-type"]:checked').value;
    
    // 发送消息给 content script
    chrome.tabs.sendMessage(tab.id, {
        action: 'startScreening',
        jobId: selectedJob,
        jobType: jobType,
        weights: weights
    });
    
    // 显示进度条
    document.getElementById('progress-container').classList.remove('hidden');
    document.getElementById('start-screening').disabled = true;
    document.getElementById('stop-screening').disabled = false;
});

// 停止筛选按钮
document.getElementById('stop-screening').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    chrome.tabs.sendMessage(tab.id, {
        action: 'stopScreening'
    });
    
    document.getElementById('progress-container').classList.add('hidden');
    document.getElementById('start-screening').disabled = false;
    document.getElementById('stop-screening').disabled = true;
});

// 接收 content script 的进度更新
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'updateProgress') {
        document.getElementById('progress-text').textContent = request.message;
        document.getElementById('progress-count').textContent = `${request.current}/${request.total}`;
        document.getElementById('progress-fill').style.width = `${request.percentage}%`;
    }
});

// 页面加载时获取职位列表
window.addEventListener('load', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // 从 content script 获取职位列表
    chrome.tabs.sendMessage(tab.id, { action: 'getJobs' }, (response) => {
        if (response && response.jobs) {
            const jobSelect = document.getElementById('job-select');
            jobSelect.innerHTML = '<option value="">-- 选择职位 --</option>';
            
            response.jobs.forEach(job => {
                const option = document.createElement('option');
                option.value = job.id;
                option.textContent = job.name;
                jobSelect.appendChild(option);
            });
        }
    });
});
