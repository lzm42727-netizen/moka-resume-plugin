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
      js.indexOf('MokaPersist.jobSpecIsUsable(spec)') < js.indexOf('languageEditor.set(split.languages'),
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
    assert.ok(calls.length >= 3, '所有 getJobSpec 调用点都应存在');
    calls.forEach((call) => assert.match(call, /jobId/));
    assert.match(js, /action: 'getJobContext'[^}]*jobId/);
  });

  it('drops a model reply that came back after the user switched jobs', () => {
    assert.match(js, /const targetJobId = currentJobId\(\) \|\| effectiveJobId\(\)/);
    assert.match(js, /targetJobId[\s\S]{0,300}resolve\(false\)/);
    assert.match(js, /saveJobPresetFor\(targetJobId\)/);
  });

  it('clears a stored understanding that belongs to another job', () => {
    // 存档里若躺着上一个岗的理解/门槛/关键词，恢复时必须清掉并重新解读，
    // 否则侧栏会一直显示「已自动填充本岗配置」+ 别人的岗位理解
    assert.match(js, /jobSpecMatchesJob\(preset\.jobSpec, jobId\)/);
    assert.match(js, /jobSpecMatchesJob\(preset\.jobSpec, jobId\)[\s\S]{0,400}resetJobPresetForm/);
    // 老存档验不了来源，至少要提示可以重解读
    assert.match(js, /sourceJobId[\s\S]{0,200}按 JD 刷新/);
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
