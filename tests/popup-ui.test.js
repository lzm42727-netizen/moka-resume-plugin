const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../popup/popup.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../popup/popup.css'), 'utf8');

describe('screening configuration UI', () => {
  it('shows handwritten hard gates and removes the legacy must row', () => {
    assert.match(html, /硬性门槛/);
    assert.match(html, /id="lang-chips"/);
    assert.match(html, /id="gate-chips"/);
    assert.doesNotMatch(html, /id="must-chips"/);
    assert.doesNotMatch(html, /id="must-input"/);
  });

  it('renames 分配对象 to 简历推荐对象 across the config/batch/log copy', () => {
    // 配置页面板标题与确认按钮
    assert.match(html, />简历推荐对象</);
    assert.match(html, /id="confirm-assignee"[^>]*>确认本岗简历推荐对象</);
    // 批量推进面板分区标题
    assert.match(html, /mp-cal-section-label">简历推荐对象</);
    // 运行日志「推荐」分类按钮与排查快照说明
    assert.match(html, /data-cat="adopt"[^>]*title="[^"]*简历推荐对象[^"]*">推荐</);
    assert.match(html, /已记录的简历推荐对象摘要/);
    assert.doesNotMatch(html, /分配对象/);
    // popup.js 文案同步：确认/采纳/状态行/批量面板/引导全部换新词
    assert.doesNotMatch(js, /分配对象/);
    assert.match(js, /确认本岗简历推荐对象/);
    assert.match(js, /将推进给本岗已确认的简历推荐对象/);
  });

  it('offers age tiers as a click-to-open multi-select dropdown in the gate grid gap', () => {
    // 位置：紧跟实习经验之后（学历|性别 / 经验|实习 / 年龄填右侧空位），先于整行的院校区
    const iIntern = html.indexOf('id="row-internship"');
    const iAge = html.indexOf('id="cond-age"');
    const iSchool = html.indexOf('院校要求');
    assert.ok(iIntern > -1 && iAge > iIntern && iSchool > iAge, '年龄下拉应在实习经验之后、院校区之前');
    // 唯一一个 #cond-age，且是下拉式多选（details 壳：收起显示已选档位，点开胶囊勾选，4 档）
    assert.equal(html.split('id="cond-age"').length - 1, 1);
    assert.match(html, /<details class="cond-dd" id="cond-age">/);
    assert.match(html, /<summary class="cond-dd-summary"/);
    assert.match(html, /<span class="cond-dd-text">不限<\/span>/);
    assert.match(html, /<label class="choice-pill"><input type="checkbox" value="20-25"> 20-25<\/label>/);
    assert.match(html, /<label class="choice-pill"><input type="checkbox" value="25-30"> 25-30<\/label>/);
    assert.match(html, /<label class="choice-pill"><input type="checkbox" value="30-35"> 30-35<\/label>/);
    assert.match(html, /<label class="choice-pill"><input type="checkbox" value="35\+"> 35 岁以上<\/label>/);
    // 原生 listbox（select multiple）形态已废弃；旧全行 6 档 checkbox（含 35-40/40-50/50+）也已移除
    assert.doesNotMatch(html, /<select multiple/);
    assert.doesNotMatch(html, /value="35-40"/);
    assert.doesNotMatch(html, /value="50\+"/);
    // JS：读写走 #cond-age 内的 checkbox；旧档回填经 AGE_TIER_MIN 归一并入 35+；按钮文案随勾选刷新
    assert.match(js, /function ageTierSelection[\s\S]{0,200}#cond-age input\[type="checkbox"\]:checked/);
    assert.match(js, /function setAgeTierOptions[\s\S]{0,120}setCheckboxGroup\('cond-age', normalizeAgeTierValues\(values\)\)[\s\S]{0,80}refreshAgeDdLabel\(\)/);
    assert.match(js, /AGE_TIER_MIN = \{ '20-25': 20, '25-30': 25, '30-35': 30, '35\+': 35 \}/);
    assert.match(js, /r\.min >= 35 && !out\.includes\('35\+'\)/);
    assert.match(js, /function refreshAgeDdLabel[\s\S]{0,200}cond-dd-text/);
    assert.match(js, /details\.cond-dd\[open\]/);
    // CSS：下拉壳与单行下拉同外观（含箭头），展开面板悬浮于网格之上
    assert.match(css, /#screening-tab \.cond-dd-summary \{[\s\S]{0,400}background-image: url\(/);
    assert.match(css, /#screening-tab \.cond-dd-menu \{[\s\S]{0,300}position: absolute;[\s\S]{0,200}z-index: 30;/);
  });

  it('resets the age dropdown through the checkbox helper that still exists', () => {
    // 回归：v1.6.12 迁移为 details 下拉壳后，writeHardConditions 曾残留对已删除的
    // setMultiSelectOptions 的调用——运行时在写入「学历」后抛 ReferenceError，
    // 导致 applyJobPreset 中重点看/加分看/岗位理解整段恢复被中断（只回填出学历）。
    assert.doesNotMatch(js, /setMultiSelectOptions\(/);
    assert.doesNotMatch(js, /readMultiSelectValues\(/);
    // 写入门槛的入口必须走现存的下拉复位 helper：先复位 checkbox 勾选，再刷新按钮文案
    assert.match(js, /function writeHardConditions[\s\S]{0,700}setAgeTierOptions\(hard\.ageRangeValues/);
    assert.match(js, /function setAgeTierOptions[\s\S]{0,180}setCheckboxGroup\('cond-age', normalizeAgeTierValues\(values\)\)[\s\S]{0,120}refreshAgeDdLabel\(\)/);
    // 恢复/重置即使中途抛错也必须在 finally 中解锁 applyingPreset，否则后续保存全部被拒
    assert.match(js, /function applyJobPreset[\s\S]{0,1400}finally \{[\s\S]{0,200}applyingPreset = false;/);
    assert.match(js, /function resetJobPresetForm[\s\S]{0,1200}finally \{[\s\S]{0,200}applyingPreset = false;/);
    assert.match(js, /function applyJobPreset[\s\S]{0,1600}reconcileJobTypeWithLabel\(activePresetJobLabel\)/);
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

  it('recovers same-name presets by newest savedAt when the job id drifted', () => {
    // 存档 key = Moka 页面 jobId，页面刷新/换入口后 id 可能漂移 → 按 id 找回失败时，
    // 兜底按「职位名」恢复：同名多份（旧 id + 新 id 各存过）优先取有可用内容的最新，
    // 全为空壳才退回空档交给空壳防线；不允许退回「同名必须唯一」的旧逻辑。
    assert.match(js, /同职位的存档找不到时[\s\S]{0,300}优先取「有可用内容」的/);
    assert.match(js, /全为空壳才退回最新空档/);
    assert.doesNotMatch(js, /matches\.length === 1/);
    assert.match(js, /bestUsable \|\| bestAny/);
    assert.match(js, /bestUsable = \{ rowDiag, cand \};/);
  });

  it('stamps a top-level job anchor on save and reads it first on restore', () => {
    // 保存：每次落盘都盖「当前职位」的 id + 名锚点，不依赖「按 JD 刷新」产物，
    // 纯手配门槛/关键词的存档（无 jobSpec）也能在 jobId 漂移时按名找回；
    // 切岗保存旧岗时调用方显式传 opts.label（旧岗名），不再读已切到新岗的下拉
    assert.match(js, /const raw = collectJobPreset\(\);[\s\S]{0,80}raw\.jobIdAnchor = id;[\s\S]{0,260}raw\.jobNameAnchor = String\(label\)\.trim\(\)/);
    assert.match(js, /盖上「当前职位」身份锚点/);
    // 恢复：同名匹配优先读顶层 jobNameAnchor，再回退老存档 jobSpec.sourceJobName
    assert.match(js, /clean\.jobNameAnchor \|\| \(clean\.jobSpec && clean\.jobSpec\.sourceJobName\)/);
  });

  it('records a restore diagnosis and ships it in the snapshot for回填 issues', () => {
    // 每次恢复尝试都落诊断（no-job/exact/name/none/empty/anchor-mismatch），
    // 排查快照带 presetRestore + 存档锚点清单，「保存了却不自动回填」凭快照即可定位
    assert.match(js, /let lastPresetRestoreDiag = null;/);
    assert.match(js, /hit: 'no-job'[\s\S]{0,200}未识别到当前职位（jobId 为空）/);
    assert.match(js, /diag\.hit = preset \? \(byName \? 'name' : 'exact'\)[\s\S]{0,160}anchor-mismatch' : \(emptyHit \? 'empty' : 'none'\)\);/);
    assert.match(js, /（诊断：存档 [\s\S]{0,200}同名命中 /);
    assert.match(js, /presetRestore: lastPresetRestoreDiag/);
    assert.match(js, /presets: presetRows/);
    assert.match(js, /anchorName: \(clean && clean\.jobNameAnchor\) \|\| ''/);
  });

  it('blocks cross-job preset saves and refuses anchor-mismatched archives on restore', () => {
    // 真实事故：快速切岗期间，防抖/切岗保存把「系统研发工程师」的表单内容写进了
    // 「商务运营实习生」的 key，此后每次精确命中都回填出错误内容。
    // 保存闸门（表单绑定职位 ≠ 目标职位 → 拒绝落盘）+ 恢复拒收（锚名不符 → 不填充）双保险。
    assert.match(js, /跨岗防污染：只允许把「当前装在表单里的这份配置」存回它自己对应的职位/);
    assert.match(js, /if \(!presetFormJobId \|\| String\(presetFormJobId\) !== id\) \{[\s\S]{0,120}lastPresetSaveBlock/);
    // 确认章只盖章：不再用 collectJobPreset 兜底覆盖存档（表单可能装着别的职位）
    assert.doesNotMatch(js, /getJobPreset\(record, jobId\) \|\| collectJobPreset\(\)/);
    assert.match(js, /只盖确认章：绝不用当前表单内容兜底覆盖存档/);
    // 恢复：键命中但锚名与当前职位不符 → 拒绝填充（anchor-mismatch），等用户重存覆盖
    assert.match(js, /anchor-mismatch/);
    assert.match(js, /已拒绝填充——请重新配置本岗后点「保存当前筛选条件」覆盖它/);
    // 职位类型随职位名校正：实习生的存档不允许以「正式员工」形态恢复
    assert.match(js, /function applyJobPreset[\s\S]{0,1600}reconcileJobTypeWithLabel\(activePresetJobLabel\)/);
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
      js.indexOf('function scheduleSaveJobPreset')
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

  it('states the gate count on the level line instead of a duplicated tag row', () => {
    // 门槛明细只在「差距」列出现一次（带「门槛」徽章）；卡面档位行只说明条数
    assert.match(js, /mp-level-note/);
    assert.match(js, /'· 未过门槛 ' \+ \(\(Array\.isArray\(s\.unmet\) && s\.unmet\.length\) \|\| 0\) \+ ' 项（见差距）'/);
    assert.match(js, /mark\.className = 'mp-mark gate'/);
    // 旧的门槛标签行（遍历 s.unmet 逐条平铺红标签）已删除，防止再长回来
    // 用 (gate) 锚定旧的门槛循环，避免撞上 niceTags.unmet.forEach
    assert.doesNotMatch(js, /s\.unmet\.forEach\(\(gate\)/);
    // 右列名称为「差距」（v1.8.4 起，原「未体现」）；「亮点」空态与右列并存
    assert.match(js, /title\.textContent = '差距';/);
    assert.doesNotMatch(js, /title\.textContent = '未体现';/);
  });

  it('keeps the unknown (待确认) tag row for items the resume never mentions', () => {
    assert.match(js, /mp-tag-warn/);
    assert.match(js, /'待确认 · ' \+ item/);
  });

  it('explains the score chain inside 评分明细 instead of scattering numbers on the card face', () => {
    assert.match(js, /FIT_WEIGHT_PCT/);
    assert.match(js, /'匹配分 ' \+ detail\.matchScore \+ ' ＝ '/);
    assert.match(js, /' ＝ 49 − 7 × ' \+ unmetCount \+ ' 条未过门槛'/);
    assert.match(js, /mp-detail-line/);
  });

  it('renders a 亮点 column title (was 具备) and a collapsible 经历证据 section', () => {
    // 「亮点」列（1.8.3 由「具备」改名，与空态文案对齐）只在有与岗位直接相关的亮点时填内容
    assert.match(js, /AI 未找到与岗位直接相关的亮点/);
    assert.match(js, /title\.textContent = '亮点'/);
    assert.doesNotMatch(js, /title\.textContent = '具备'/);
    // 经历证据从「亮点」列拆出为独立折叠区（默认收起，带条数）
    assert.match(js, /经历证据（' \+ evidenceList\.length \+ '）/);
    assert.match(js, /'mp-evidence-body' \+ \(evidenceOpen \? '' : ' hidden'\)/);
    assert.match(js, /evidenceList\.forEach/);
    // 折叠按钮必须阻断冒泡：否则点击会触发结果行 openCandidate 跳详情页
    assert.match(js, /toggle\.addEventListener\('click', \(e\) => \{[\s\S]{0,160}stopPropagation/);
    // 「亮点」列内容只来自 highlights：不给证据混入左列留任何入口
    assert.doesNotMatch(js, /cols\.left[\s\S]{0,60}experienceEvidence/);
  });

  it('keeps result-card collapsibles open across re-renders', () => {
    // 回归：renderResults 整表重建（list.innerHTML = ''），展开状态只存 DOM 会被频繁冲掉，
    // 筛选中每推一次快照 / 每次重评都会重建，导致刚点开的「经历证据」「评分明细」自动缩回。
    assert.match(js, /const resultExpandState = new Map\(\)/);
    assert.match(js, /function isResultSectionOpen\(appId, section\)/);
    assert.match(js, /function setResultSectionOpen\(appId, section, open\)/);
    // 建卡时按外置状态回填（默认收起）
    assert.match(js, /isResultSectionOpen\(appId, 'evidence'\)/);
    assert.match(js, /isResultSectionOpen\(appId, 'detail'\)/);
    // 点击时写回外置状态，而不是只改 DOM
    assert.match(js, /setResultSectionOpen\(appId, 'evidence', !nowHidden\)/);
    assert.match(js, /setResultSectionOpen\(appId, 'detail', !nowHidden\)/);
    // 换职位后旧 appId 的状态必须失效，避免串岗沿用展开态
    assert.match(js, /function syncResultExpandScope\(jobId\)/);
    assert.match(js, /resultExpandState\.clear\(\)/);
    assert.match(js, /syncResultExpandScope\(jobId\)/);
    // 只记本次会话：不落任何 storage
    assert.doesNotMatch(js, /resultExpandState[\s\S]{0,80}chrome\.storage/);
  });

  it('plays a one-shot arrive animation only when a candidate first gets scored', () => {
    // mp-arrive 由筛选进行中首次出分时挂上（arrivedScoreRows 去重，新一轮筛选清空）
    assert.match(js, /arrivedScoreRows/);
    assert.match(js, /arrivedScoreRows\.clear\(\)/);
    assert.match(js, /view\.score && resultState\.screening && !arrivedScoreRows\.has\(view\.id\)/);
    assert.match(css, /\.mp-row\.mp-arrive \.mp-info \{[\s\S]{0,80}animation: mpArriveInfo/);
    // 动效包在 prefers-reduced-motion 守卫里，系统减弱动态时整体禁用
    assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]{0,200}mpArriveInfo/);
    // 进度条运行态流光
    assert.match(css, /#progress-container:not\(\.hidden\) \.progress-fill::after \{[\s\S]{0,240}animation: mpSweep/);
  });

  it('replaces action-button emoji with monoline SVG icons', () => {
    // 👁️🙈⏸🗑️📋⬇️ 全部换 SVG；Key 眼睛用 class 切换睁/闭
    assert.doesNotMatch(html, /👁️|🙈|⏸|🗑️|⬇️/);
    assert.match(html, /id="toggle-api-key" class="btn-icon"[\s\S]{0,120}icon-eye"/);
    assert.match(css, /\.btn-icon\.is-visible \.icon-eye \{[\s\S]{0,40}display: none/);
    assert.match(js, /classList\.add\('is-visible'\)/);
  });

  it('renders a usage line fed by snapshots and optional custom prices in settings', () => {
    // 结果头部用量行：来自 content 快照 usageText，渲染函数名与元素都在
    assert.match(html, /id="usage-line"/);
    assert.match(js, /function renderUsageLine/);
    assert.match(js, /snap\.usageText/);
    assert.match(js, /setResultUsageLine/);
    // 1.8.8 起这行内容 = 用时 + 预估花费，popup 不再加「用量：」前缀
    assert.doesNotMatch(js, /'用量：'/);
    // 设置页自定义单价（元/百万 tokens，留空走内置表）
    assert.match(html, /id="model-input-price"/);
    assert.match(html, /id="model-output-price"/);
    assert.match(js, /modelInputPrice/);
    assert.match(js, /modelOutputPrice/);
    assert.match(html, /留空用内置|内置价目表/);
  });
});

describe('screening tab flat sections and gate two-column grid', () => {
  it('renders config panels as flat sections with per-zone classes kept', () => {
    assert.match(html, /<section class="panel sec-job">/);
    assert.match(html, /<section class="panel sec-assignee">/);
    assert.match(html, /<section class="panel sec-understand">/);
    assert.match(html, /<section class="panel sec-gate">/);
    assert.match(html, /<section class="panel sec-keyword panel-last">/);
    // 1.8.2 去卡片壳：分区靠「图标 + 标题 + 细分割线」表达层级，卡片质感只留给 dock 与结果卡
    assert.match(css, /#screening-tab \.panel \{[\s\S]{0,220}border-bottom: 1px solid var\(--border\)/);
    assert.match(css, /#screening-tab \.panel \{[\s\S]{0,220}border-radius: 0/);
    assert.match(css, /#screening-tab \.panel \{[\s\S]{0,220}background: transparent/);
    // 彩色圆底图标与卡片投影一并移除，防止旧样式回潮
    assert.doesNotMatch(css, /panel-icon \{ background: #/);
  });

  it('replaces emoji section icons with monoline SVG icons', () => {
    const iconCount = (html.match(/<span class="panel-icon"><svg/g) || []).length;
    assert.equal(iconCount, 8, '8 个分区标题都应使用单色线性 SVG 图标');
    assert.doesNotMatch(html, /panel-icon">[^<]/, 'panel-icon 里不应再残留 emoji 文本');
  });

  it('pairs the four dropdown gates in a 2-column grid and keeps multi-select rows full width', () => {
    // 学历|性别、经验|实习 进 cond-grid；院校/年龄/语言/专业 仍是整行
    const gridStart = html.indexOf('class="cond-grid"');
    assert.ok(gridStart !== -1, '硬性门槛应有两列网格');
    const gridBlock = html.slice(gridStart, gridStart + 1600);
    ['cond-degree', 'cond-gender', 'row-exp', 'row-internship'].forEach((id) => {
      assert.ok(gridBlock.includes('id="' + id + '"'), id + ' 应位于两列网格内');
    });
    assert.ok(gridStart < html.indexOf('id="cond-school"'), '院校要求应在网格之后整行展示');
    assert.match(css, /#screening-tab \.cond-grid \{[\s\S]{0,200}repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it('titles the gate section with 空项不参与筛选 and trims long helper copy', () => {
    assert.match(html, /硬性门槛[\s\S]{0,80}空项不参与筛选/);
    // 旧长文案收进 title / 精简，不再整段摊在面板里
    assert.doesNotMatch(html, /改完点「保存当前筛选条件」，或开筛时自动保存/);
    assert.match(html, /条件会随开筛\/保存自动存，下次进入本岗自动回填/);
    assert.doesNotMatch(html, /重点看定义经历匹配；加分看有证据时每项 \+3/);
    assert.match(html, /重点看=经历硬匹配；加分看=有证据每项 \+3（最多 \+15）/);
  });
});

describe('settings 运行日志 panel', () => {
  it('rebrands the API card to 连接与模型 and replaces 接口观测 with 运行日志', () => {
    assert.match(html, /连接与模型/);
    assert.doesNotMatch(html, /API 配置/);
    assert.doesNotMatch(html, /接口观测（排查用）/);
    assert.match(html, /运行日志/);
  });

  it('keeps a single snapshot button inside the collapsed 排查工具 details', () => {
    // 流水 ⊂ 快照：独立的「复制接口流水」按钮已移除，只留一键排查快照
    assert.match(html, /<details class="log-diag">[\s\S]{0,200}<summary>排查工具（一键复制排查快照）<\/summary>/);
    assert.doesNotMatch(html, /id="copy-request-log"/);
    assert.doesNotMatch(html, /复制接口流水/);
    assert.match(html, /id="copy-assignee-snapshot"/);
  });

  it('exposes the log toolbar, list, footer, and empty state', () => {
    assert.match(html, /id="log-filters"[\s\S]{0,700}data-cat="all"[\s\S]{0,700}data-cat="err"/);
    assert.match(html, /id="log-pause"/);
    assert.match(html, /id="log-clear"/);
    assert.match(html, /id="log-copy"/);
    assert.match(html, /id="log-export"/);
    assert.match(html, /id="log-list"/);
    assert.match(html, /id="log-empty"/);
    assert.match(html, /id="log-count"/);
  });

  it('maps every badge label and treats 错误 as warn+err in the filter', () => {
    assert.match(js, /req: \{ label: '请求'/);
    assert.match(js, /adopt: \{ label: '推荐'/);
    assert.match(js, /screen: \{ label: '筛选'/);
    assert.match(js, /score: \{ label: '评分'/);
    assert.match(js, /err: \{ label: '错误'/);
    assert.match(js, /err: \['warn', 'err'\]/);
  });

  it('loads, renders, appends live, clears, copies, and exports the log', () => {
    assert.match(js, /function renderPluginLog/);
    assert.match(js, /function appendPluginLogEntry/);
    assert.match(js, /function reloadPluginLog[\s\S]{0,200}action: 'getPluginLog'/);
    assert.match(js, /function clearPluginLogPanel[\s\S]{0,120}action: 'clearPluginLog'/);
    assert.match(js, /async function copyCurrentLog[\s\S]{0,200}navigator\.clipboard\.writeText/);
    assert.match(js, /function exportCurrentLog[\s\S]{0,900}\.txt/);
    // 后台广播实时追加 + 进设置页补拉一次
    assert.match(js, /request\.action === 'pluginLogEntry'[\s\S]{0,120}appendPluginLogEntry\(request\.entry, request\.replaceTail === true\)/);
    // 直连重放后延迟刷新 Moka 标签页（1.10.6）：与批量推进共用 reloadMokaTabSoon
    assert.match(js, /function reloadMokaTabSoon\(\)[\s\S]{0,300}chrome\.tabs\.reload\(tab\.id\)/);
    assert.match(js, /if \(resp\.replayed\) reloadMokaTabSoon\(\);/);
    assert.match(js, /reloadMokaTabSoon\(\);\n {4}closeBatchPanel\(\);/);
    // 折叠更新（1.10.4）：replaceTail 原地改写末行（×N 递增），不追加新行
    assert.match(js, /function collapseBaseText\(text\)/);
    assert.match(js, /if \(replaceTail && tail && tail\.cat === normalized\.cat\n {4}&& collapseBaseText\(tail\.text\) === collapseBaseText\(normalized\.text\)\)/);
    assert.match(js, /list\.replaceChild\(buildLogRow\(tail\), list\.lastElementChild\)/);
    assert.match(js, /if \(tabName === 'settings'\) reloadPluginLog\(\);/);
    // 清空/查看前先把 content 本地队列冲给 background，防止旧日志清完后复活
    assert.match(js, /function flushContentLogQueues[\s\S]{0,500}action: 'flushPluginLog'/);
    assert.match(js, /clearPluginLogPanel[\s\S]{0,200}await flushContentLogQueues\(\);/);
    assert.match(js, /reloadPluginLog[\s\S]{0,200}await flushContentLogQueues\(\);/);
  });

  it('styles the log list as a monospace scrolling terminal with level colors', () => {
    assert.match(css, /\.log-list \{[\s\S]{0,300}font-family: ui-monospace/);
    assert.match(css, /\.log-list \{[\s\S]{0,400}overflow-y: auto/);
    assert.match(css, /\.log-row\.cat-err \.log-text/);
    assert.match(css, /\.log-badge\.cat-adopt/);
    assert.match(css, /\.log-empty\.hidden/);
  });
});

describe('settings UI de-clutter (endpoint visibility / advanced fold / save-and-test / icon toolbar)', () => {
  it('1.8.9 起 Endpoint 常显可编辑，「接口协议 + 自由提供商」取代三选一', () => {
    // Endpoint 组不再按提供商隐藏（旧 applyProviderVisibility 已删）
    assert.match(html, /<div class="form-group" id="endpoint-group">/);
    assert.doesNotMatch(html, /id="endpoint-group" hidden/);
    assert.doesNotMatch(js, /applyProviderVisibility/);
    // 协议是唯一硬约束，只有 openai / claude 两个值
    assert.match(html, /<select id="api-protocol">[\s\S]{0,200}<option value="openai">/);
    assert.match(html, /<option value="claude">/);
    // 提供商改为自由文本 + datalist 预设，不再是三选一 select
    assert.match(html, /<input type="text" id="api-provider" list="api-provider-presets"/);
    assert.doesNotMatch(html, /<select id="api-provider">/);
    assert.match(js, /const API_PRESETS = \[/);
    assert.match(js, /function fillProviderPresets\(\)/);
    assert.match(js, /function applyApiPreset\(name\)/);
    assert.match(js, /api-provider'\)\?\.addEventListener\('input', \(e\) => applyApiPreset\(e\.target\.value\)\)/);
    // 协议切换联动 Endpoint 占位/默认值
    assert.match(js, /api-protocol'\)\?\.addEventListener\('change', syncEndpointPlaceholder\)/);
    assert.match(js, /fillProviderPresets\(\);[\s\S]{0,120}syncEndpointPlaceholder\(\);/);
  });

  it('1.10.0 本地私有配置：四项部署信息锁定，面板收成「摘要 + API Key」', () => {
    // 本地配置先当默认值参与合并；锁定的四项随后被覆盖
    assert.match(js, /const LOCAL_DEFAULTS = \(typeof window !== 'undefined' && window\.MOKA_LOCAL_SETTINGS\)/);
    assert.match(js, /const s = \{ \.\.\.LOCAL_DEFAULTS, \.\.\.\(result\.mokaSettings \|\| \{\}\) \}/);
    // 四项锁回去（置灰 + 提示改文件），模型名也在名单里
    assert.match(js, /function lockLocalConnection\(\)/);
    assert.match(js, /const LOCAL_LOCK_MAP = \{ apiProtocol: 'api-protocol', apiProvider: 'api-provider', apiEndpoint: 'api-endpoint', modelName: 'model-name' \}/);
    assert.match(js, /已由本地私有配置锁定，如需修改请编辑 config\.local\.js/);
    // 部署模式：隐藏四个输入框，改用只读摘要条展示部署信息
    assert.match(html, /id="local-deploy-summary" class="deploy-strip" hidden/);
    assert.match(html, /id="conn-manual-fields"/);
    assert.match(js, /function applyDeploySummaryView\(\)/);
    assert.match(js, /if \(manual\) manual\.hidden = true;/);
    assert.match(js, /strip\.hidden = false;/);
    // 四项齐全才算部署模式；缺项时退回完整表单，不做半截隐藏
    assert.match(js, /function localSettingsComplete\(\)/);
    // 锁定项一律取本地部署值（部署模式下输入框是隐藏的，也能读对）
    assert.match(js, /function lockedOr\(key, formValue\)/);
    assert.match(js, /modelName: lockedOr\('modelName', document\.getElementById\('model-name'\)\.value\.trim\(\)\)/);
    assert.match(js, /lockLocalConnection\(\);[\s\S]{0,120}fillProviderPresets\(\);/);
  });

  it('1.10.0 部署模式：四项不齐时不隐藏任何字段（回退完整表单，不做半截隐藏）', () => {
    // 判定依据是「四项齐全」，而不是「有没有配置文件」
    assert.match(js, /return Object\.keys\(LOCAL_LOCK_MAP\)\.every\(\(k\) => LOCAL_DEFAULTS\[k\] != null && String\(LOCAL_DEFAULTS\[k\]\)\.trim\(\) !== ''\)/);
    assert.match(js, /if \(!strip \|\| !localSettingsComplete\(\)\) return;/);
    // 摘要条自带 hidden，只有确认进入部署模式后才移除
    assert.match(html, /id="local-deploy-summary" class="deploy-strip" hidden/);
    // 样式兜底：两个容器被 hidden 属性藏起来时确实不占位
    assert.match(css, /\.deploy-strip\[hidden\],\s*#conn-manual-fields\[hidden\] \{\s*display: none;/);
  });

  it('老配置自动迁移：只有 apiProvider 时也能还原出协议与提供商名', () => {
    assert.match(js, /function providerLabelFromLegacy\(value\)/);
    assert.match(js, /openai: 'OpenAI', claude: 'Anthropic Claude', custom: '自建 \/ 中转网关'/);
    assert.match(js, /const legacyClaude = !s\.apiProtocol && s\.apiProvider === 'claude'/);
    assert.match(js, /protocolEl\.value = \(s\.apiProtocol === 'claude' \|\| legacyClaude\) \? 'claude' : 'openai'/);
    assert.match(js, /apiProtocol: lockedOr\('apiProtocol', document\.getElementById\('api-protocol'\)\?\.value === 'claude' \? 'claude' : 'openai'\)/);
  });

  it('folds 并发 / 强制 JSON / 单价 into one 高级 details (collapsed by default)', () => {
    assert.match(html, /<details class="adv-group" id="conn-adv-group">[\s\S]{0,140}<summary>高级 · 测评参数与费用单价（可选）<\/summary>/);
    assert.match(html, /id="model-input-price"/);
    assert.match(html, /id="model-output-price"/);
    assert.match(html, /留空用内置|内置价目表/);
    // 三项都在同一个折叠区里，且默认收起
    assert.match(html, /id="score-concurrency"[\s\S]{0,900}id="force-json-mode"[\s\S]{0,900}id="model-input-price"/);
    assert.doesNotMatch(html, /<details class="adv-group" id="conn-adv-group" open/);
    // 自己存过非默认的高级参数（并发≠6 / 关掉 JSON / 填过单价）时自动展开，避免设置被藏住；
    // 依据「存储里的设置」而非合并值，否则 config.local.js 预置的默认单价会让它永远展开
    assert.match(js, /advGroup\.open = /);
    assert.match(js, /stored\.forceJsonMode === false/);
    assert.doesNotMatch(js, /advGroup\.open = \(Number\(s\.scoreConcurrency\)/);
  });

  it('merges 保存 and 测试 into one save-and-test action', () => {
    assert.doesNotMatch(html, /id="test-api"/);
    assert.match(html, /id="save-settings"[\s\S]{0,120}保存并测试/);
    // 保存成功后自动测一次连接，而不是只提示「已保存」
    assert.match(js, /chrome\.storage\.local\.set\(\{ mokaSettings: settings \}\)[\s\S]{0,400}action: 'testApi', settings/);
    assert.doesNotMatch(js, /getElementById\('test-api'\)/);
  });

  it('turns the log toolbar actions into icon buttons with a toggle pause', () => {
    // 1.8.3 起 ⏸ 为单色 SVG，暂停态由 .on class + aria-pressed 表达
    assert.match(html, /id="log-pause" class="log-icon-btn"[\s\S]{0,200}aria-pressed="false"><svg/);
    assert.match(html, /id="log-clear" class="log-icon-btn"/);
    assert.match(html, /id="log-copy" class="log-icon-btn"/);
    assert.match(html, /id="log-export" class="log-icon-btn"/);
    assert.match(js, /pluginLogState\.paused = !pluginLogState\.paused/);
    assert.match(js, /setAttribute\('aria-pressed'/);
    assert.doesNotMatch(js, /log-pause'\)\?\.addEventListener\('change'/);
    assert.match(css, /\.log-icon-btn \{[^}]*\}/);
    assert.match(css, /\.log-icon-btn\.on/);
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

describe('切岗/恢复稳健性（1.6.18/1.6.19）', () => {
  it('switchJobPreset 整段串行：快速 A→B→C 切岗不得用空表单覆盖存档', () => {
    // 防的正是「保存旧岗 → 清空 → 恢复新岗」被并发切岗打散：B→C 的保存
    // 在表单已被清空、B 内容未填回的窗口期执行会把空表单覆盖进 B 的存档。
    assert.match(js, /let switchJobQueue = Promise\.resolve\(\);/);
    assert.match(js, /function switchJobPreset\(prevJobId, prevLabel, targetJobId, label\) \{[\s\S]{0,2600}switchJobQueue\.then\(runSwitch\)/);
    assert.match(js, /switchJobQueue = result\.then\(\(\) => \{\}, \(\) => \{\}\);/);
    // 手动切岗调用方补失败兜底，不再产生未处理 rejection
    assert.match(js, /switchJobPreset\(prevId, prevLabel, nextId, nextLabel\)\.then\([\s\S]{0,200}\.catch\(\(e\) => \{/);
  });

  it('保存离开岗时用 prevLabel 盖锚名，禁止把新岗名写到旧岗 key 上', () => {
    // 快照实锤的交叉错位：ba2d225a(Golang key) 锚名=JAVA、efaa1e46(JAVA key) 锚名=Golang。
    // 根因：change 触发后下拉已切到新岗，函数内读 currentJobLabel() 盖到旧岗存档上。
    assert.match(js, /saveJobPresetFor\(prevJobId, \{ label: prevLabel \}\)/);
    assert.match(js, /function saveJobPresetFor\(jobId, opts\)/);
    assert.match(js, /const label = \(opts && opts\.label\) \|\| currentJobLabel\(\) \|\| activePresetJobLabel \|\| '';/);
    assert.match(js, /switchJobPreset\(prevJobId, activePresetJobLabel, targetJobId, label\)/);
    // 空表单离开岗时不保存（无可保存内容直接跳过，防空白覆盖真存档）
    assert.match(js, /const leaving = collectJobPreset\(\);[\s\S]{0,160}presetHasUsableContent\(leaving\)[\s\S]{0,80}saveJobPresetFor\(prevJobId/);
  });

  it('空壳存档防线：纯空档视为未恢复，按首次进入重新生成并保留确认章', () => {
    // 空壳（无门槛/关键词/理解，jobSpec 不可用）恢复后只会显示空表单，还会挡住
    // 「首次进入自动生成理解」；命中空壳应走 emptyHit 分支触发重新生成。
    assert.match(js, /function presetHasUsableContent\(p\)/);
    assert.match(js, /preset && !presetHasUsableContent\(preset\)/);
    assert.match(js, /emptyPresetAssigneeAt = Number\(preset\.assigneeConfirmedAt\) \|\| 0;/);
    assert.match(js, /if \(emptyHit && emptyPresetAssigneeAt\) currentAssigneeConfirmedAt = emptyPresetAssigneeAt;/);
    assert.match(js, /已拒绝填充——请重新配置本岗后点「保存当前筛选条件」覆盖它/);
    assert.match(js, /检测到本岗存档是空档（没有门槛\/关键词\/理解），将按首次进入自动重新生成并保存/);
    // 同名多份时优先选有可用内容的最新档
    assert.match(js, /presetHasUsableContent\(cand\)[\s\S]{0,200}bestUsable = \{ rowDiag, cand \}/);
  });

  it('window load 初始化分步容错：任一步失败也要保证结果区交互绑定执行', () => {
    // 防的是一次 storage 读取 reject 让 bindResultFilters 永不绑定 → 搜索/导出失绑
    assert.match(js, /const bootSteps = \[[\s\S]{0,400}刷新页面职位上下文', refreshResultsAndJobContext\]/);
    assert.match(js, /for \(const \[name, fn\] of bootSteps\) \{[\s\S]{0,120}await fn\(\);[\s\S]{0,80}catch \(e\) \{/);
    assert.match(js, /try \{ bindResultFilters\(\); \} catch \(e\) \{ console\.warn\('\[初始化\] 结果区交互绑定失败', e\);/);
  });

  it('顶层 DOM 绑定空值守航（P2-11）：safeEl 封装 + 关键 id 不再裸 .addEventListener', () => {
    assert.match(js, /function safeEl\(id\)[\s\S]{0,200}console\.warn\('\[Moka 筛选\] popup\.html 缺少元素/);
    // 关键绑定（缺元素会导致整段 JS 中断或结果区功能全失）必须走 safeEl/可选链
    for (const id of ['reload-panel', 'api-provider', 'toggle-api-key', 'save-settings',
      'start-screening', 'stop-screening', 'save-job-preset', 'export-results', 'result-search']) {
      assert.doesNotMatch(
        js,
        new RegExp(`getElementById\\('${id}'\\)\\.addEventListener`),
        `${id} 不得裸调用 .addEventListener`
      );
      assert.ok(js.includes(`safeEl('${id}')`), `${id} 应经 safeEl 绑定`);
    }
  });
});

describe('v1.8.5 设置页新增并发数 / JSON 模式', () => {
  it('连接与模型卡片提供「评分并发数」与「强制 JSON 输出」', () => {
    assert.match(html, /<input type="number" id="score-concurrency" min="1" max="8" step="1"/);
    assert.match(html, /<input type="checkbox" id="force-json-mode"> 强制 JSON 输出（推荐）/);
    // 控件位置：仍在「连接与模型」卡片内；并发 / JSON 自 1.10.0 起收进「高级」折叠区
    assert.match(html, /id="model-name"[\s\S]{0,2200}id="score-concurrency"[\s\S]{0,600}id="force-json-mode"/);
  });

  it('readSettingsForm 落库 forceJsonMode / scoreConcurrency 并做边界夹取', () => {
    assert.match(js, /forceJsonMode: document\.getElementById\('force-json-mode'\)\?\.checked !== false/);
    assert.match(js, /scoreConcurrency: concurrency/);
    assert.match(js, /const concurrency = Number\.isFinite\(rawConcurrency\) && rawConcurrency > 0\s*\n\s*\? Math\.min\(8, Math\.max\(1, Math\.round\(rawConcurrency\)\)\)/);
  });

  it('loadSettings 回填两个新字段；老配置/首次使用都有默认值', () => {
    assert.match(js, /jsonModeEl\.checked = s\.forceJsonMode !== false/);
    assert.match(js, /concurrencyEl\.value = Number\.isFinite\(c\) && c > 0 \? String\(Math\.min\(8, Math\.max\(1, Math\.round\(c\)\)\)\) : '6'/);
    // 首次使用（无 mokaSettings）没有独立分支：合并默认值即可覆盖，JSON 模式开、并发 6
    assert.match(js, /const s = \{ \.\.\.LOCAL_DEFAULTS, \.\.\.\(result\.mokaSettings \|\| \{\}\) \}/);
    assert.doesNotMatch(js, /\} else \{[\s\S]{0,200}jsonModeEl\.checked = true/);
  });
});
