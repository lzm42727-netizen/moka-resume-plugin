/**
 * Moka 智能简历筛选 - Content Script
 * 负责识别页面元素和显示评分
 */

let isScreening = false;
let screeningConfig = {};

// 页面加载完成后执行初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

function init() {
    console.log('[Moka 筛选] Content script 已加载');
    setupMessageListener();
}

// 设置消息监听
function setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log('[Moka 筛选] 收到消息:', request.action);
        
        if (request.action === 'getJobs') {
            const jobs = extractJobsFromPage();
            sendResponse({ jobs });
        } else if (request.action === 'startScreening') {
            isScreening = true;
            screeningConfig = request;
            performScreening(request);
        } else if (request.action === 'stopScreening') {
            isScreening = false;
            removeAllScores();
        }
    });
}

/**
 * 从页面提取职位列表
 */
function extractJobsFromPage() {
    const jobs = [];
    
    // 根据实际 Moka 页面结构调整这些选择器
    const jobElements = document.querySelectorAll('[class*="job"], [class*="position"]');
    
    // 如果在职位管理页面
    const pageTitle = document.title;
    if (pageTitle.includes('职位管理')) {
        const jobRows = document.querySelectorAll('tr[data-job-id], [class*="job-row"]');
        jobRows.forEach((row, index) => {
            const jobNameElem = row.querySelector('[class*="job-name"], td:first-child');
            if (jobNameElem) {
                jobs.push({
                    id: `job_${index}`,
                    name: jobNameElem.textContent.trim()
                });
            }
        });
    }
    
    return jobs.length > 0 ? jobs : getDefaultJobs();
}

/**
 * 获取默认职位列表（备选方案）
 */
function getDefaultJobs() {
    return [
        { id: 'job_1', name: '产品经理' },
        { id: 'job_2', name: '前端开发' },
        { id: 'job_3', name: '后端开发' },
        { id: 'job_4', name: '数据分析' }
    ];
}

/**
 * 执行筛选
 */
async function performScreening(config) {
    console.log('[Moka 筛选] 开始筛选，配置:', config);
    
    try {
        // 获取所有候选人卡片
        const candidates = extractCandidates();
        console.log('[Moka 筛选] 找到候选人:', candidates.length);
        
        if (candidates.length === 0) {
            alert('❌ 未找到候选人卡片，请确保在候选人管理页面');
            return;
        }
        
        // 获取职位 JD
        const jobJD = getJobJDFromPage(config.jobId);
        console.log('[Moka 筛选] 职位 JD:', jobJD);
        
        // 遍历每个候选人进行评分
        for (let i = 0; i < candidates.length; i++) {
            if (!isScreening) break;
            
            const candidate = candidates[i];
            console.log(`[Moka 筛选] 处理候选人 ${i + 1}/${candidates.length}:`, candidate.name);
            
            // 更新进度
            chrome.runtime.sendMessage({
                action: 'updateProgress',
                current: i + 1,
                total: candidates.length,
                percentage: Math.round((i + 1) / candidates.length * 100),
                message: `处理中: ${candidate.name}...`
            });
            
            // 调用 AI 评分
            const score = await getAIScore(candidate, jobJD, config);
            
            // 在页面显示评分
            displayScore(candidate.element, score);
            
            // 延迟避免 API 限流
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log('[Moka 筛选] 筛选完成');
        chrome.runtime.sendMessage({
            action: 'updateProgress',
            current: candidates.length,
            total: candidates.length,
            percentage: 100,
            message: '筛选完成！'
        });
        
    } catch (error) {
        console.error('[Moka 筛选] 错误:', error);
        alert('❌ 筛选出错: ' + error.message);
    }
}

/**
 * 从页面提取候选人信息
 */
function extractCandidates() {
    const candidates = [];
    
    // 根据实际 Moka 页面结构调整这些选择器
    // 这些是常见的候选人卡片选择器，需要根据实际情况修改
    const selectors = [
        '[class*="candidate-card"]',
        '[class*="resume-item"]',
        '[class*="candidate-item"]',
        'div[class*="card"]',
        'li[class*="item"]'
    ];
    
    let candidateElements = [];
    for (const selector of selectors) {
        candidateElements = document.querySelectorAll(selector);
        if (candidateElements.length > 0) {
            console.log(`[Moka 筛选] 找到候选人容器: ${selector}`);
            break;
        }
    }
    
    candidateElements.forEach((element, index) => {
        const candidate = {
            id: `candidate_${index}`,
            element: element,
            name: extractText(element, '[class*="name"], .candidate-name, strong'),
            position: extractText(element, '[class*="position"], .candidate-position'),
            education: extractText(element, '[class*="education"], .education-level'),
            experience: extractText(element, '[class*="experience"], .work-years'),
            skills: extractText(element, '[class*="skills"], .skill-tags')
        };
        
        if (candidate.name) {
            candidates.push(candidate);
        }
    });
    
    return candidates;
}

/**
 * 辅助函数：从元素中提取文本
 */
function extractText(element, selectors) {
    if (typeof selectors === 'string') {
        selectors = [selectors];
    }
    
    for (const selector of selectors) {
        const elem = element.querySelector(selector);
        if (elem) {
            return elem.textContent.trim().substring(0, 100);
        }
    }
    
    return '';
}

/**
 * 从页面获取职位 JD
 */
function getJobJDFromPage(jobId) {
    // 这是一个简化的实现
    // 在实际应用中，需要从 Moka 的职位详情页获取
    
    const jdMap = {
        'job_1': '职位要求: 5年以上产品管理经验，熟悉 SaaS 产品开发',
        'job_2': '职位要求: 3年以上前端开发经验，精通 React/Vue，了解 TypeScript',
        'job_3': '职位要求: 3年以上后端开发经验，熟悉 Python/Java/Go 中的一种',
        'job_4': '职位要求: 2年以上数据分析经验，熟悉 SQL 和数据可视化工具'
    };
    
    return jdMap[jobId] || '产品要求与职位匹配';
}

/**
 * 调用 AI 获取评分
 */
async function getAIScore(candidate, jobJD, config) {
    try {
        // 获取保存的 API 设置
        const settings = await chrome.storage.local.get('mokaSettings');
        const apiSettings = settings.mokaSettings;
        
        if (!apiSettings || !apiSettings.apiKey) {
            return {
                score: 50,
                level: '中等',
                suggestions: ['❌ 未配置 API Key，无法评分']
            };
        }
        
        // 构建提示词
        const prompt = buildPrompt(candidate, jobJD, config);
        
        // 调用 API
        const response = await fetch(apiSettings.apiEndpoint || 'https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiSettings.apiKey}`
            },
            body: JSON.stringify({
                model: apiSettings.modelName || 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: '你是一个专业的招聘顾问，擅长分析候选人与职位的匹配度。请提供客观、专业的评分和建议。'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 500
            })
        });
        
        if (!response.ok) {
            throw new Error(`API 错误: ${response.status}`);
        }
        
        const data = await response.json();
        const result = parseAIResponse(data.choices[0].message.content);
        
        return result;
    } catch (error) {
        console.error('[Moka 筛选] AI 评分错误:', error);
        return {
            score: 0,
            level: '错误',
            suggestions: ['⚠️ 评分失败: ' + error.message]
        };
    }
}

/**
 * 构建 AI 提示词
 */
function buildPrompt(candidate, jobJD, config) {
    return `请评估以下候选人与职位的匹配度:

【候选人信息】
姓名: ${candidate.name}
申请职位: ${candidate.position}
学历: ${candidate.education}
工作经验: ${candidate.experience}
技能: ${candidate.skills}

【职位要求】
${jobJD}

【评分权重】
- 学历匹配: ${config.weights.education}%
- 经验年限: ${config.weights.experience}%
- 技能匹配: ${config.weights.skill}%

【职位类型】
${config.jobType === 'full-time' ? '正式员工' : '实习生'}

请返回以下格式的 JSON:
{
  "score": 0-100之间的数字,
  "level": "强烈推荐/值得考虑/一般/不推荐",
  "suggestions": ["建议1", "建议2", "建议3", "建议4", "建议5"]
}`;
}

/**
 * 解析 AI 响应
 */
function parseAIResponse(content) {
    try {
        // 尝试从响应中提取 JSON
        const jsonMatch = content.match(/\{[^}]+\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                score: Math.min(100, Math.max(0, parsed.score || 50)),
                level: parsed.level || '中等',
                suggestions: (parsed.suggestions || []).slice(0, 5)
            };
        }
    } catch (error) {
        console.error('[Moka 筛选] 解析 AI 响应错误:', error);
    }
    
    return {
        score: 50,
        level: '中等',
        suggestions: ['无法解析评分']
    };
}

/**
 * 在页面显示评分卡片
 */
function displayScore(element, score) {
    // 检查是否已经添加过评分
    let scoreCard = element.querySelector('.moka-score-card');
    if (scoreCard) {
        scoreCard.remove();
    }
    
    // 创建评分卡片
    scoreCard = document.createElement('div');
    scoreCard.className = 'moka-score-card';
    scoreCard.innerHTML = `
        <div class="score-header">
            <div class="score-value">${score.score}</div>
            <div class="score-level">${score.level}</div>
        </div>
        <div class="score-suggestions">
            ${score.suggestions.map(s => `<div class="suggestion">• ${s}</div>`).join('')}
        </div>
    `;
    
    // 添加样式
    if (!document.getElementById('moka-score-styles')) {
        const style = document.createElement('style');
        style.id = 'moka-score-styles';
        style.textContent = `
            .moka-score-card {
                position: absolute;
                right: 10px;
                top: 10px;
                width: 200px;
                background: white;
                border: 2px solid #1890ff;
                border-radius: 8px;
                padding: 12px;
                box-shadow: 0 2px 8px rgba(24, 144, 255, 0.2);
                z-index: 1000;
                font-size: 12px;
            }
            .score-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
                padding-bottom: 8px;
                border-bottom: 1px solid #e0e0e0;
            }
            .score-value {
                font-size: 24px;
                font-weight: bold;
                color: #1890ff;
            }
            .score-level {
                font-size: 12px;
                padding: 4px 8px;
                background: #e6f7ff;
                border-radius: 4px;
                color: #1890ff;
                font-weight: 500;
            }
            .score-suggestions {
                font-size: 11px;
                line-height: 1.6;
                color: #666;
            }
            .suggestion {
                margin-bottom: 4px;
            }
        `;
        document.head.appendChild(style);
    }
    
    // 插入评分卡片
    element.style.position = 'relative';
    element.appendChild(scoreCard);
}

/**
 * 移除所有评分卡片
 */
function removeAllScores() {
    document.querySelectorAll('.moka-score-card').forEach(card => card.remove());
}

console.log('[Moka 筛选] Content script 初始化完成');
