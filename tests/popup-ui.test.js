const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../popup/popup.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');

describe('screening configuration UI', () => {
  it('shows handwritten hard gates and removes the legacy must row', () => {
    assert.match(html, /硬性门槛/);
    assert.match(html, /id="lang-chips"/);
    assert.match(html, /id="gate-chips"/);
    assert.doesNotMatch(html, /id="must-chips"/);
    assert.doesNotMatch(html, /id="must-input"/);
  });

  it('labels focus and bonus keywords without arithmetic hints', () => {
    assert.match(html, /筛选关键词/);
    assert.match(html, />重点看</);
    assert.match(html, />加分看</);
    assert.doesNotMatch(html, /未满足\s*[−-]\s*[35]/);
    assert.doesNotMatch(html, /具备\s*\+\s*5/);
  });

  it('allows up to five bonus keywords and explains the three-point rule', () => {
    assert.match(html, /加分看[\s\S]{0,500}最多 5 项/);
    assert.match(html, /每项\s*\+3/);
    assert.match(js, /niceEditor[\s\S]{0,100}max:\s*5/);
  });

  it('does not expose legacy scoring weight controls', () => {
    assert.doesNotMatch(html, /评分权重/);
    assert.doesNotMatch(html, /class="weight-slider"/);
    assert.doesNotMatch(js, /type === 'weight'/);
    assert.match(js, /buildCalibrationReport\([\s\S]{0,120}focusKeywords/);
    assert.doesNotMatch(js, /buildCalibrationReport\([\s\S]{0,200}weights:\s*readWeights\(\)/);
  });

  it('applies calibration suggestions to gates, focus keywords, and bonus keywords', () => {
    assert.match(js, /type === 'addGate'/);
    assert.match(js, /type === 'addFocus'/);
    assert.match(js, /type === 'dropBonus'/);
    assert.match(js, /importantEditor/);
    assert.match(js, /niceEditor/);
    assert.match(js, /switchTab\('screening'\)/);
    assert.match(js, /自行新增重点看/);
  });

  it('shows why scoring failed on error cards', () => {
    assert.match(js, /mp-error-reason/);
    assert.match(js, /scoreFailureMessage/);
  });

  it('shows experience match only through the gate-specific display helper', () => {
    assert.match(js, /matchScoreDisplayText/);
    assert.doesNotMatch(js, /formatPenaltyHint/);
  });

  it('renders bonus score details and marks bonus-based promotion separately', () => {
    assert.match(js, /bonusScoreDisplay/);
    assert.match(js, /加分晋级/);
    assert.match(js, /bonusPromoted/);
  });

  it('stores bonus explanation fields in feedback snapshots', () => {
    assert.match(js, /bonusKeywordResults:\s*s\.bonusKeywordResults/);
    assert.match(js, /bonusApplied:\s*s\.bonusApplied/);
    assert.match(js, /bonusMetCount:\s*s\.bonusMetCount/);
  });

  it('decides preset reload from the job the form holds, not the last active job', () => {
    assert.match(js, /presetFormJobId/);
    assert.match(js, /needsPresetReload\(targetJobId, presetFormJobId\)/);
    assert.doesNotMatch(js, /String\(targetJobId\) === String\(activePresetJobId \|\| ''\)/);
  });

  it('never treats an unusable JD analysis as a successful refresh', () => {
    // 空壳 spec 曾导致：理解区空白但显示绿色「已生成」，且清单被整表覆盖成空并落盘
    assert.match(js, /MokaPersist\.jobSpecIsUsable\(spec\)/);
    assert.match(js, /jobSpecIsUsable\(spec\)[\s\S]{0,400}resolve\(false\)/);
    assert.match(js, /hasJobUnderstandingContent\(\)[\s\S]{0,300}resolve\(false\)/);
    // 守卫必须在覆盖芯片之前
    assert.ok(
      js.indexOf('MokaPersist.jobSpecIsUsable(spec)') <
        js.indexOf('languageEditor.set(split.languages'),
      '可用性守卫必须早于 languageEditor.set，否则失败的解读仍会清空门槛'
    );
  });

  it('reloads the whole side panel from 点击刷新 instead of a silent soft refresh', () => {
    // 软刷新在表单已装着同一岗位时几乎不做事，也没有任何反馈，用户看起来就是「失效」
    assert.match(js, /reload-panel'\)[\s\S]{0,200}reloadSidePanel\(\)/);
    assert.match(js, /function reloadSidePanel[\s\S]{0,600}location\.reload\(\)/);
    // 重载前先尽力落盘本岗配置，避免未保存的门槛/关键词被刷掉
    assert.match(js, /function reloadSidePanel[\s\S]{0,600}saveJobPresetFor\(/);
    assert.doesNotMatch(js, /reload-panel'\)[\s\S]{0,120}refreshMokaConnection\(\)/);
  });

  it('binds every JD read to the job selected in the side panel', () => {
    // 不带岗位 ID 时，content 端只能抓页面上「当前那一批」候选人的 JD，
    // 岗位切走后拿回来的就是上一个岗的理解
    const calls = js.match(/action: 'getJobSpec'[^}]*}/g) || [];
    // 硬性门槛随「按 JD 刷新」联动后，独立的预填调用点已并入主刷新流程
    assert.ok(calls.length >= 2, '所有 getJobSpec 调用点都应存在');
    calls.forEach((call) => assert.match(call, /jobId/));
    assert.match(js, /action: 'getJobContext'[^}]*jobId/);
    // 联动：按 JD 刷新后硬性门槛同源预设（无独立按钮）
    assert.match(js, /function prefillHardFromJD/);
    assert.match(js, /prefillHardFromJD\(\)\.then\(\(bits\) =>/);
    assert.doesNotMatch(js, /id="autofill-hard"|autofill-hard'\)/);
    assert.doesNotMatch(html, /autofill-hard|按 JD 预填硬性/);
    // 设置页分配对象排查快照按钮
    assert.match(html, /id="copy-assignee-snapshot"/);
    // Moka 页面切岗后分配对象跟随页面职位：快路径（表单已装该岗）也强制重渲染
    assert.match(js, /const pageJobBefore = lastKnownPageJobId/);
    assert.match(js, /pageJobId !== pageJobBefore && formHoldsTargetJob\) renderAssigneeStatus\(\)/);  });

  it('drops a model reply that came back after the user switched jobs', () => {
    assert.match(js, /const targetJobId = currentJobId\(\) \|\| effectiveJobId\(\)/);
    assert.match(js, /targetJobId[\s\S]{0,300}resolve\(false\)/);
    assert.match(js, /saveJobPresetFor\(targetJobId\)/);
  });

  it('keeps a job-keyed preset intact even when its understanding stamp differs', () => {
    // 存档键 = 职位身份：同一键下的门槛/关键词是招聘官为本岗手配的。
    // 岗位理解戳来自别的职位只降级为「按 JD 刷新」提示，绝不整表清空，
    // 否则会出现「已点保存、下次进入又变回初始阶段」。
    assert.doesNotMatch(js, /已清空，将按本岗 JD 重新解读/);
    assert.match(js, /理解不对请点「按 JD 刷新」/);
    assert.match(js, /applyJobPreset\(preset\);/);
    // 精确键缺失时按同名职位找回一份，防 jobId 跨入口漂移导致存档「找不到」
    assert.match(js, /已按同名职位恢复本岗配置/);
    // 老存档验不了来源，提示可重解读
    assert.match(js, /sourceJobId[\s\S]{0,200}按 JD 刷新/);
  });

  it('freezes understanding once a preset exists: entry never silently re-interprets', () => {
    // 冻结规则：进岗自动重解读只允许发生在「本岗从未保存过配置」的首次进入。
    // 只要本岗存过档（哪怕理解区为空），理解/清单都不再被进岗逻辑静默重写。
    assert.match(js, /async function ensureJobUnderstandingOnEnter\(hadSavedPreset\)/);
    // 两个入口（切换岗位、详情页空列表分支）都必须把 restore 结果传进去
    assert.doesNotMatch(js, /ensureJobUnderstandingOnEnter\(\)/);
    const fnBody = js.slice(
      js.indexOf('async function ensureJobUnderstandingOnEnter'),
      js.indexOf('function maybeFillEmptyRequirementsFromJd')
    );
    // 冻结分支必须先于自动调 AI；AI 调用只允许落在「首次进入」分支里
    const freezeAt = fnBody.indexOf('if (hadSavedPreset)');
    const aiCallAt = fnBody.indexOf('refreshUnderstandingAndRequirements({');
    assert.ok(freezeAt !== -1 && aiCallAt !== -1 && freezeAt < aiCallAt, '有存档必须先走冻结分支');
    assert.match(fnBody, /本岗已保存过配置但没有岗位理解[\s\S]{0,120}按 JD 刷新/);
    assert.match(fnBody, /真·首次进入/);
  });

  it('renders intern graduation risk away from evidence columns', () => {
    assert.match(js, /mp-grad-risk/);
    assert.match(js, /view\.graduationRisk/);
    assert.match(js, /实习岗档期风险，不影响分数/);
    assert.doesNotMatch(js, /buildEvidenceSplit[\s\S]{0,200}graduationRisk/);
  });

  it('renders the actual unmet gate list on result cards', () => {
    assert.match(js, /mp-gate-list/);
    assert.match(js, /s\.unmet/);
  });

  it('renders an empty 具备 hint and a collapsible 经历证据 section', () => {
    // 「具备」列只在有与岗位直接相关的亮点时填内容；无亮点给空态提示
    assert.match(js, /AI 未找到与岗位直接相关的亮点/);
    assert.match(js, /title\.textContent = '具备'/);
    // 经历证据从「具备」列拆出为独立折叠区（默认收起，带条数）
    assert.match(js, /经历证据（' \+ evidenceList\.length \+ '）/);
    assert.match(js, /mp-evidence-body hidden/);
    assert.match(js, /evidenceList\.forEach/);
    // 折叠按钮必须阻断冒泡：否则点击会触发结果行 openCandidate 跳详情页
    assert.match(js, /toggle\.addEventListener\('click', \(e\) => \{[\s\S]{0,160}stopPropagation/);
    // 「具备」列内容只来自 highlights：不给证据混入左列留任何入口
    assert.doesNotMatch(js, /cols\.left[\s\S]{0,60}experienceEvidence/);
  });
});

describe('about tab copy', () => {
  it('does not claim resume data stays local or is never uploaded', () => {
    assert.doesNotMatch(html, /所有数据只在本地处理和保存/);
    assert.doesNotMatch(html, /不会上传个人信息到第三方服务器/);
  });

  it('says the candidate profile is sent to the user-configured LLM', () => {
    assert.match(html, /API Key 只保存在浏览器本地存储/);
    assert.match(html, /候选人画像会发送到你配置的/);
    assert.match(html, /LLM/);
    assert.match(html, /自定义 Endpoint[\s\S]{0,80}域名/);
  });

  it('does not advertise scoring weights that the UI no longer has', () => {
    assert.doesNotMatch(html, /权重自定义/);
    assert.doesNotMatch(html, /选择职位和权重/);
  });
});
