const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BATCH_ASSIGN_LIMIT,
  ASSIGN_ENDPOINT_PATH,
  extractAssigneeIds,
  sanitizeIdList,
  buildBatchAssignmentBody,
  buildDefaultTemplate,
  sanitizeCapturedHeaders,
  evaluateAssignmentResponse
} = require('../lib/batch.js');

function source(rel) {
  // v3.4.0 拆分后按「原 popup.js 线性顺序」拼接，保住跨窗口的 \s\S 锚点语义
  const bundles = {
    'popup/popup.js': ['popup/popup.js', 'popup/popup-results.js', 'popup/popup-batch.js']
  };
  const files = bundles[rel] || [rel];
  return files.map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
}

const css = source('popup/popup.css');

const TEMPLATE = JSON.stringify({
  applicationIds: [839908318, 839909893],
  assigneeIds: [6397518, 8981545],
  resumeType: 'all',
  carbonCopyUserIds: [],
  viewExamUserIds: []
});

describe('extractAssigneeIds', () => {
  it('reads assignee ids from a captured assignment body', () => {
    assert.deepEqual(extractAssigneeIds(TEMPLATE), [6397518, 8981545]);
  });

  it('returns an empty list for unparsable or empty bodies', () => {
    assert.deepEqual(extractAssigneeIds('not json'), []);
    assert.deepEqual(extractAssigneeIds(''), []);
    assert.deepEqual(extractAssigneeIds('{"assigneeIds":"x"}'), []);
  });
});

describe('buildDefaultTemplate（v3.2.0 免真发）', () => {
  it('synthesizes a replayable template: default fields + given assignee ids', () => {
    const tpl = buildDefaultTemplate([6397518, 8981545, 'x', -1], 'https://app.mokahr.com');
    assert.equal(tpl.url, 'https://app.mokahr.com' + ASSIGN_ENDPOINT_PATH);
    assert.equal(tpl.headers['Content-Type'], 'application/json');
    const body = JSON.parse(tpl.body);
    assert.deepEqual(body, {
      applicationIds: [],
      assigneeIds: [6397518, 8981545],
      resumeType: 'all',
      carbonCopyUserIds: [],
      viewExamUserIds: []
    });
  });

  it('output works as a replay template via buildBatchAssignmentBody', () => {
    const tpl = buildDefaultTemplate([6397518]);
    const built = buildBatchAssignmentBody(tpl.body, [839908318], [6397518]);
    assert.equal(built.ok, true);
    assert.deepEqual(built.body.applicationIds, [839908318]);
    assert.deepEqual(built.body.assigneeIds, [6397518]);
    assert.equal(built.body.resumeType, 'all');
  });

  it('falls back to a relative endpoint when origin is empty', () => {
    const tpl = buildDefaultTemplate([1]);
    assert.equal(tpl.url, ASSIGN_ENDPOINT_PATH);
  });
});

describe('sanitizeIdList', () => {
  it('keeps finite positive ids, dedupes, and drops the rest', () => {
    assert.deepEqual(sanitizeIdList([1, '2', 2.5, 0, -3, NaN, 'abc', 1]), [1, 2]);
  });

  it('honours an explicit max', () => {
    assert.deepEqual(sanitizeIdList([1, 2, 3, 4], 2), [1, 2]);
  });
});

describe('buildBatchAssignmentBody', () => {
  it('replaces applicationIds and keeps the rest of the template', () => {
    const built = buildBatchAssignmentBody(TEMPLATE, [840268067, '840239235'], [6397518]);
    assert.equal(built.ok, true);
    assert.deepEqual(built.body, {
      applicationIds: [840268067, 840239235],
      assigneeIds: [6397518],
      resumeType: 'all',
      carbonCopyUserIds: [],
      viewExamUserIds: []
    });
  });

  it('refuses without a captured template or recorded assignees', () => {
    assert.equal(buildBatchAssignmentBody(null, [1], [1]).ok, false);
    assert.equal(buildBatchAssignmentBody(TEMPLATE, [1], []).ok, false);
  });

  it('refuses empty selections and over-limit batches', () => {
    assert.equal(buildBatchAssignmentBody(TEMPLATE, [], [1]).ok, false);
    const ids = Array.from({ length: BATCH_ASSIGN_LIMIT + 1 }, (_, i) => i + 1);
    const built = buildBatchAssignmentBody(TEMPLATE, ids, [1]);
    assert.equal(built.ok, false);
    assert.match(built.error, /单次最多/);
  });
});

describe('sanitizeCapturedHeaders', () => {
  it('drops content-length and host, adds content-type when missing', () => {
    const out = sanitizeCapturedHeaders({
      'Content-Length': '128',
      Host: 'app.mokahr.com',
      'X-Requested-With': 'XMLHttpRequest'
    });
    assert.deepEqual(out, { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' });
  });

  it('keeps an existing content-type as-is', () => {
    const out = sanitizeCapturedHeaders({ 'content-type': 'application/json;charset=UTF-8' });
    assert.equal(out['content-type'], 'application/json;charset=UTF-8');
    assert.equal(Object.keys(out).length, 1);
  });
});

describe('evaluateAssignmentResponse', () => {
  it('accepts an HTTP 200 reply with a passing business code', () => {
    assert.equal(evaluateAssignmentResponse(200, '{"code":0,"data":true}').ok, true);
    assert.equal(evaluateAssignmentResponse(200, '{"success":true}').ok, true);
  });

  it('surfaces HTTP and business failures with a readable reason', () => {
    const http = evaluateAssignmentResponse(403, 'forbidden');
    assert.equal(http.ok, false);
    assert.match(http.error, /403/);
    const biz = evaluateAssignmentResponse(200, '{"code":500,"message":"没有权限"}');
    assert.equal(biz.ok, false);
    assert.match(biz.error, /没有权限/);
    assert.equal(evaluateAssignmentResponse(200, '<html>').ok, false);
  });
});

describe('batch wiring', () => {
  it('registers both batch actions in the shared contract', () => {
    const { ACTIONS } = require('../lib/contracts.js');
    assert.ok(Object.values(ACTIONS).includes('batchAssign'));
    assert.ok(Object.values(ACTIONS).includes('getBatchAssignContext'));
  });

  it('is loaded by content script, popup and captured by inject', () => {
    const manifest = source('manifest.json');
    const popupHtml = source('popup/popup.html');
    const inject = source('inject.js');
    assert.match(manifest, /lib\/batch\.js/);
    assert.match(popupHtml, /lib\/batch\.js/);
    assert.match(inject, /assignment-request/);
  });

  it('sends the batch write request from the MAIN world via page-native fetch', () => {
    const inject = source('inject.js');
    const content = source('content.js');
    // inject: 接收 do-assignment 指令，用页面原生 fetch 代发并按 reqId 回传
    assert.match(inject, /do-assignment/);
    assert.match(inject, /runAssignment/);
    assert.match(inject, /origFetch/);
    assert.match(inject, /assignment-response/);
    // content: 不再直接 fetch 写接口，改为 postMessage 往返
    assert.match(content, /requestMainWorldAssignment/);
    assert.match(content, /assignment-response/);
    assert.doesNotMatch(content, /fetchWithTimeout\(capturedAssignment\.url/);
    // popup: 成功后自动刷新 Moka 列表页
    const popup = source('popup/popup.js');
    assert.match(popup, /chrome\.tabs\.reload/);
  });

  it('exposes the batch UI and confirm flow in the side panel', () => {
    const html = source('popup/popup.html');
    const js = source('popup/popup.js');
    assert.match(html, /id="batch-advance"/);
    assert.match(html, /id="confirm-batch"/);
    assert.match(js, /executeBatchAdvance/);
    // 分配对象跟职位走：配置页/批量面板按选中 jobId 查存档（getAssigneeForJob），
    // 旧的页面级 getBatchAssignContext 只保留在 content 侧兼容
    assert.match(js, /getAssigneeForJob/);
    assert.match(js, /batchAssign/);
  });

  it('archives batch-advanced candidates as decided recommend feedback', () => {
    const js = source('popup/popup.js');
    // 批量推进成功后逐人记为「推荐给用人部门」（已同步），联动移入已决策
    assert.match(js, /saveCandidateFeedback\(v\.id, 'recommend', v, \{ mokaSynced: true/);
    // 快捷全选不再勾选已决策候选人
    assert.match(js, /hasAnyDecisionFeedback\(v\)\) return/);
  });

  it('scopes captured assignees per pipeline to avoid cross-job misuse', () => {
    const content = source('content.js');
    // 捕获时打上职位标记，存储按 pipelineId 分桶（而非全局一份）
    assert.match(content, /pipelineId: String\(pipelineId\)/);
    assert.match(content, /\[ASSIGNMENT_CAPTURE_KEY\]: \{ captures \}/);
    // 读取/执行前校验当前职位的模板，职位不匹配则回存储取对应那份
    // v3.5.0：查档统一口径 pickAssignmentEntry——「内存命中即返回」的快速路径必须移除
    //（同 pipeline 挂多职位时，内存里可能是别岗/页面操作留下的模板，只比 pipelineId 会拿错名单），
    // 改为每次全表扫描同名记录、确认章优先
    assert.match(content, /function loadAssignmentForCurrentPipeline/);
    assert.match(content, /function pickAssignmentEntry\(captures, pipelineId, pageName\)/);
    assert.match(content, /const picked = pickAssignmentEntry\(captures, pipelineId, pageName\)/);
    assert.doesNotMatch(
      content,
      /capturedAssignmentPipelineId === pipelineId && capturedAssignment/,
      '内存快速路径不得回潮：实锤「确认 4 人却推进给罗耀钏」的一条根因路径'
    );
    // handleBatchAssign 明确拒绝未记录分配对象的职位
    assert.match(content, /本职位尚未记录简历推荐对象/);
  });

  it('reports the capture time so the config tab can show it', () => {
    const content = source('content.js');
    // 内存命中与存储回读两条路径都要带上 savedAt
    assert.match(content, /capturedAssignmentSavedAt = entry\.savedAt;/);
    assert.match(content, /capturedAssignmentSavedAt = Number\(entry\.savedAt\) \|\| 0;/);
    assert.match(content, /savedAt: capturedAssignmentSavedAt/);
  });

  it('lets the assignee be confirmed up front in the config tab', () => {
    const html = source('popup/popup.html');
    const js = source('popup/popup.js');
    const content = source('content.js');
    // 配置页分配对象区块：状态行 + 重新读取 + 确认按钮
    assert.match(html, /id="assignee-status"/);
    assert.match(html, /id="refresh-assignee"/);
    assert.match(html, /id="confirm-assignee"/);
    assert.match(js, /async function renderAssigneeStatus\(viaButton\)/);
    assert.match(js, /function confirmAssigneeForCurrentJob/);
    // 点「重新读取」必须有视觉反馈（读取很快、文案没变化时会像没反应），且与自动刷新区分开
    assert.match(css, /#assignee-status\.flash/);
    assert.match(js, /refresh-assignee'\)\?\.addEventListener\('click', \(\) => renderAssigneeStatus\(true\)\)/);
    assert.match(js, /if \(viaButton\) flashAssigneeStatusLine\(\);/);
    // 未记录时的指引（v3.2.0 免真发）：选好人→点确认即可（确认时无模板会合成默认模板），
    // 真发一次保留为校准简历类型/抄送偏好的手段；此前指引承诺了走不通的路（新岗重新读取永远识别不到）
    assert.match(js, /点下方「确认本岗简历推荐对象」即可采纳并永久记住（无需真发）/);
    assert.match(js, /选好人就行，不用真发出去/);
    assert.match(js, /如需指定简历类型 \/ 抄送偏好，在弹窗里真发一次即可校准/);
    // v3.1.4：本岗未记录时「重新读取」也要把弹窗姓名带回展示（新岗死路修复）
    assert.match(js, /const cmp = await sendToMoka\(\{ action: 'scrapeAssigneeNames', readOnly: true \}\);/);
    assert.match(js, /弹窗当前选了 ' \+ seen\.length \+ ' 人（' \+ seen\.join\('、'\) \+ '）。/);
    // 主动点「重新读取」却没比对到页面（弹窗没开）时必须点破，否则像按钮坏了
    assert.match(js, /renderAssigneeStatusInner\(viaButton\)/);
    assert.match(js, /本次未检测到打开的「推荐给用人部门」弹窗/);
    assert.match(js, /const compareMissedHint = viaButton && noLiveRead/);
    // 只读比对也走「anchored 优先、pageWide 兜底 + 数量门」：只回 anchored 会把标签识别失败
    // 误判成「弹窗没开」，已记录的旧人选就永远没人质疑
    assert.match(js, /readOnly: true, count: ctx\.assigneeCount/);
    assert.match(content, /pickValidAssigneeNames\(scraped\.anchored, scraped\.pageWide, count\)/);
    // 确认流程：采纳弹窗人选（adoptScrapedAssignees）→ stampAssigneeConfirmed 落确认章
    assert.match(js, /confirmAssigneeForCurrentJob[\s\S]{0,1000}adoptScrapedAssignees/);
    assert.match(js, /function stampAssigneeConfirmed[\s\S]{0,800}putJobPreset/);
    // 确认动作经 stampAssigneeConfirmed 把时间戳写进本岗存档；收集表单时随存档持久化
    assert.match(js, /stampAssigneeConfirmed\(jobId\)/);
    assert.match(js, /assigneeConfirmedAt: currentAssigneeConfirmedAt/);
    // 切到配置页 / 进岗时刷新状态
    assert.match(js, /if \(tabName === 'screening'\) renderAssigneeStatus\(\)/);
    // 批量面板文案区分「已确认 / 未确认」
    assert.match(js, /将推进给本岗已确认的简历推荐对象/);
    assert.match(js, /建议先到「配置」页确认/);
    // 勾选变化时面板同步刷新（修复分配对象区域空白/滞留旧状态）
    assert.match(js, /function refreshBatchPanelIfOpen[\s\S]{0,200}openBatchPanel\(\)/);
    assert.match(js, /function clearBatchSelection[\s\S]{0,300}refreshBatchPanelIfOpen\(\)/);
  });

  it('shows assignee names instead of a bare count when they are known', () => {
    const inject = source('inject.js');
    const content = source('content.js');
    const js = source('popup/popup.js');
    const contracts = source('lib/contracts.js');
    // inject：把非候选人接口的响应推给 content 收割姓名
    assert.match(inject, /member-data/);
    assert.match(inject, /shouldHarvestMembers/);
    // inject：推荐弹窗确认瞬间刮取「推荐到」人名芯片（含单点推荐走其它接口的情形）
    assert.match(inject, /scrapeRecommendChipNames/);
    assert.match(inject, /assignee-names/);
    // inject：芯片「×」两种形态都要识别——文本 × 和 SVG/图标类（textContent 无 ×），
    // 否则 ant-design 风格的芯片只刮到 0 个名字、配置页永远显示「N 人」
    assert.match(inject, /CHIP_NAME_X_RE/); // 形态一：名字+文本 ×
    assert.match(inject, /CHIP_NAME_RE/);   // 形态二：纯名字（需图标/类名佐证）
    assert.match(inject, /function chipLike/);
    assert.match(inject, /CLOSE_HINT_RE/);
    // inject：标签允许「推荐到：」等冒号后缀；标签自身不当作姓名收集
    assert.match(inject, /\[:：\]\\s\*\$\//);
    assert.match(inject, /isLabel\(el\)/);

    // inject+content：分配请求把刮到的姓名写进接口观测流水，复制流水即可
    // 直接看出「names: [] = 没刮到」还是「names: [张三] = 校验没过」
    assert.match(inject, /function logPostRequest\(url, method, body, names\)/);
    assert.match(inject, /entry\.names = names/);
    assert.match(content, /if \(Array\.isArray\(entry\.names\)\) item\.names = entry\.names/);

    // content：实时刮取通道——推荐弹窗开着时配置页「重新读取」即可直接带出姓名，
    // 不必等点确认发请求那一刻（content 与页面共享 DOM）
    assert.match(content, /function scrapeRecommendChipNamesFromDom/);
    assert.match(content, /function mergeLiveScrapedAssigneeNames/);
    assert.match(content, /scrapeAssigneeNames/);
    assert.match(contracts, /scrapeAssigneeNames: 'scrapeAssigneeNames'/);
    // content：实时刮取两遍扫描（标签邻域优先 + 全页兜底），并带诊断快照回给配置页
    // v3.4.0：刮取实现移入 lib/moka-dom-adapter.js（Node 可跑行为测试），content 只留委托
    const domAdapter = source('lib/moka-dom-adapter.js');
    assert.match(content, /function chipNamesByLabelWalk/);
    assert.match(domAdapter, /function chipNamesByLabelWalk\(doc\)/);
    assert.match(domAdapter, /function chipNamesPageWide\(doc\)/);
    assert.match(domAdapter, /function collectChipNamesFrom\(el, out, seen\)/);
    assert.match(content, /function pickValidAssigneeNames/);
    assert.match(domAdapter, /function pickValidAssigneeNames\(anchored, pageWide, count\)/);
    assert.match(content, /debug: \{[\s\S]{0,80}labels[\s\S]{0,80}anchored[\s\S]{0,80}pageWide/);
    // inject：请求时刻同样两遍扫描（anchored + pageWideNames），确认瞬间弹窗可能
    // 已在关闭，全页兜底保证姓名能跟上记录更新
    assert.match(inject, /function chipNamesPageWide/);
    assert.match(inject, /pageWideNames/);
    // popup：弹窗人选与已记录不一致时，给出双方名单和两种对齐方式
    assert.match(js, /与本岗已记录的 ' \+ ctx\.assigneeCount/);
    assert.match(js, /直接点下方「确认本岗简历推荐对象」即可采纳并永久记住/);

    // 采纳链路：确认本岗分配对象 = 把弹窗当前人选写进本岗记录（姓名→id 反查），
    // 批量推进重放的 assigneeIds 随之与确认的姓名严格一致
    assert.match(contracts, /adoptScrapedAssignees: 'adoptScrapedAssignees'/);
    assert.match(content, /function resolveIdsForNames/);
    assert.match(content, /function adoptScrapedAssignees/);
    assert.match(content, /function bindSingleAssigneeName/);
    assert.match(content, /action === 'adoptScrapedAssignees'/);
    assert.match(js, /action: 'adoptScrapedAssignees'/);
    // v3.1.0：确认结果一律回写状态行本身（原地变绿/变橙 + 闪一下），不再发底部浮动 toast——
    // 「已更新并确认为：…」出现在面板底部，与上方状态行说的是同一句话，用户看到的是位置不对的重复信息
    assert.match(js, /function flashAssigneeStatusLine\(\)/);
    assert.match(js, /flashAssigneeStatusLine\(\);/);
    assert.ok(!/本岗简历推荐对象已更新并确认为：/.test(js));
    assert.ok(!/showDockToast\('已确认本岗简历推荐对象/.test(js));
    // 采纳结果常驻面板置顶（toast 只有 3 秒，用户会以为「点了没反应」）
    assert.match(js, /let lastAdoptNote/);
    assert.match(js, /el\.textContent = lastAdoptNote \+ '\\n' \+ el\.textContent/);
    // 成功确认走绿色状态行，不叠加置顶说明（避免同一句重复两遍）
    assert.match(js, /✓ 已确认本岗简历推荐对象：/);
    assert.match(js, /开筛后批量推进按此执行/);
    assert.ok(!/✓ 刚刚已采纳弹窗人选/.test(js));
    // 状态行不带 build 标记（用户要求：成功状态只留姓名+时间）
    assert.ok(!/POPUP_BUILD/.test(js));
    assert.ok(!/〔build /.test(js));
    assert.match(js, /✗ 刚刚未采纳（/);
    // 批量推进面板：已确认且姓名已知 → 明示「与该岗位分配对象一致，可执行」
    assert.match(js, /与该岗位简历推荐对象一致，确认无误即可执行/);
    // popup：重新读取时名字缺失 → 走实时刮取兜底；仍缺失时显示诊断原因
    //（标签数/两遍扫描结果），并识别「内容脚本未更新」提醒重载扩展
    assert.match(js, /function fetchAssigneeContextWithLiveScrape\(jobId\)/);
    assert.match(js, /action: 'scrapeAssigneeNames'/);
    // 分配对象跟职位走：按下拉框选中的 jobId 查该职位自己的存档，
    // 不再读 Moka 页面当前职位的（换职位不串岗）
    assert.match(js, /action: 'getAssigneeForJob', jobId/);
    assert.match(content, /function getAssigneeForJob/);
    assert.match(content, /function getAssigneeDiagnostics/);
    assert.match(content, /function rememberJobPipeline/);
    assert.match(content, /function readJobPipelineMap/);
    assert.match(content, /function persistAssignmentEntry/);
    // v3.1.3→v3.2.2：名章冲突不再拒写（拒写会把污染期脏记录永久卡死干净页面，
    // 实锤「确认不变绿」）——旧记录移到「pid#名章」别名键保留（按职位名的查档
    // 扫描与键无关），新记录以当前页面为准占本位
    assert.match(content, /分配对象记录按当前页面覆盖：pipelineId/);
    assert.match(content, /const aliasKey = entry\.pipelineId \+ '#' \+ normalizeJobName\(existing\.jobName\);/);
    assert.match(content, /captures\[aliasKey\] = existing;/);
    assert.match(content, /!jobNameMatches\(entry\.jobName, existing\.jobName\)/);
    // v3.2.0 免真发：无真实模板时合成默认模板建记录（真发捕获同名覆盖为真实偏好）
    assert.match(content, /const templateRaw = template \|\| MokaBatch\.buildDefaultTemplate\(ids, location\.origin\);/);
    assert.match(content, /if \(synthesized\) entry\.synthesizedTemplate = true;/);
    // v3.2.1：落库结果通过 done(ok, detail) 如实回传调用方（adopt 据此决定成败）
    assert.match(content, /persistAssignmentEntry\(entry, \(written\) =>/);
    // v3.3.0：写入成功语义 = set 回调无 lastError；v3.5.0：detail 区分 written / kept-confirmed
    assert.match(content, /if \(typeof done === 'function'\) done\(!failed, 'written'\);/);
    // v3.3.0 第一批加固：存档写队列串行 + 写失败如实上报 + 模板名章校验/按职位名回退
    assert.match(content, /let assigneeStoreQueue = Promise\.resolve\(\);/);
    assert.match(content, /function enqueueAssigneeStoreWrite\(task\)/);
    assert.match(content, /const failed = !!\(chrome\.runtime && chrome\.runtime\.lastError\);/);
    assert.match(content, /分配模板按职位名改道：pipelineId/);
    assert.match(content, /分配模板拒绝使用：pipelineId/);
    assert.match(js, /let jobPresetWriteQueue = Promise\.resolve\(\);/);
    assert.match(js, /function writeJobPresetRecord\(mutator\)/);
    assert.match(js, /await writeJobPresetRecord\(\(record\) =>/);
    // 分配对象以「职位名」为锚点（URL title 与下拉框文案同源），
    // 彻底绕开 jobId/pipelineId 两套 id 空间的桥接错配
    assert.match(content, /function jobNameMatches/);
    assert.match(content, /function normalizeJobName/);
    assert.match(content, /function pageJobName/);
    assert.match(content, /JOB_PIPELINE_MAP_KEY = 'mokaPipelineNameMapV3'/);
    // 映射只信「同源成对」：页面 URL 的 pipelineId+title；搜索请求体 + 当前页面名
    assert.match(content, /rememberJobPipeline\(String\(ctx\.pipelineId\), ctx\.title/);
    assert.match(content, /rememberJobPipeline\(String\(sbody\.pipelineId\), pageJobName\(\)\)/);
    // 存档盖职位名章 + 按职位名匹配优先（错配直接暴露为「未记录」，绝不串岗）
    assert.match(content, /jobNameMatches\(label, e\.jobName\)/);
    assert.match(content, /jobName: normalizeJobName\(pageJobName\(\)\)/);
    // v3.0.8 两遍制：精确同名优先，包含式近似只作兜底且回包标 fuzzyMatched——
    // 切岗后绝不静默把名字相近的别的岗记录当成自己本岗的
    assert.match(content, /let entry = exact \|\| fuzzy;/);
    assert.match(content, /const fuzzyMatched = !exact && !!fuzzy;/);
    assert.match(content, /fuzzyMatched,/);
    // v3.1.3：id 兜底只认「无名章」或「名章与查询职位一致」的记录——名章写着别的职位的
    // （id 复用/SPA 局部刷新）绝不能当本岗的返回（实锤：查「广告投放运营实习生」捞回了
    // 「海外SEO运营实习生」的已确认记录）
    assert.match(content, /const candName = cand \? normalizeJobName\(cand\.jobName\) : '';/);
    assert.match(content, /if \(cand && \(!candName \|\| candName === ln \|\| jobNameMatches\(label, cand\.jobName\)\)\) entry = cand;/);
    // v3.1.3：实时刮取回写同样要过名章比对（弹窗属于页面当前职位）
    assert.match(content, /const sameJob = !entryName \|\| !pageName \|\| jobNameMatches\(entryName, pageName\);/);
    // v3.0.8 popup：跨岗不继承旧职位名（label 未知时宁可占位，不拿旧岗名查档）
    assert.match(js, /const safeLabel = label \|\| \(sameJob \? activePresetJobLabel : ''\)/);
    assert.match(js, /const text = label \|\| jobLabelFallback\(key\)/);
    // 旧记录自愈：查询命中页面自身 pipeline 下缺职位名章的存档时当场补章（同源才写）
    assert.match(content, /self-heal|自愈/);
    assert.match(content, /entry\.jobName = normalizeJobName\(pageName\)/);
    assert.match(content, /request\.action === 'getAssigneeDiagnostics'/);
    assert.ok(Object.values(require('../lib/contracts.js').ACTIONS).includes('getAssigneeDiagnostics'));
    // 一键排查快照：popup 按钮处理（按钮本体在 popup-ui 套件里断言）
    assert.match(js, /action: 'getAssigneeDiagnostics'/);
    assert.match(js, /已复制排查快照/);
    assert.match(content, /request\.action === 'getAssigneeForJob'/);
    assert.ok(Object.values(require('../lib/contracts.js').ACTIONS).includes('getAssigneeForJob'));
    // popup 查询时带上选中职位的展示名
    assert.match(js, /action: 'getAssigneeForJob', jobId, jobLabel: currentJobLabel\(\)/);
    // 跨职位防护：页面在别的职位时绝不采纳页面弹窗人选
    assert.match(js, /probe\.isPageJob === false/);
    assert.match(js, /✗ 该职位尚未记录简历推荐对象/);
    // 重新读取必须永远比对「弹窗当前 vs 已存记录」：已有姓名也只读比对，
    // 不一致立即提示并可采纳（旧记录可能被跨职位操作污染，绝不静默沿用）
    assert.match(content, /request\.readOnly/);
    assert.match(js, /action: 'scrapeAssigneeNames', readOnly: true/);
    assert.match(js, /popupNames/);
    assert.match(js, /与已记录的（' \+ storedNames\.join\('、'\) \+ '）不一致/);
    // v3.1.0：同一组人只是顺序不同（fiber 顺序 vs 芯片 DOM 顺序）不得判成「不一致」——
    // 否则刚确认成功就又冒橙色提示，像没生效
    assert.match(js, /const sortedStored = storedNames\.slice\(\)\.sort\(\)/);
    assert.match(js, /const sortedPopup = popupNames\.slice\(\)\.sort\(\)/);
    // v3.0.9 只读比对不受「数量门」拒报：人数不一致（记录 1 人/弹窗 4 人）时，
    // 必须把实刮到的 seenNames 带回显示不一致，而不是误报「未检测到打开的弹窗」
    assert.match(content, /seenNames: seenRaw\.slice\(0, 10\)/);
    assert.match(content, /countMatched: !!count && gated\.length === count/);
    assert.match(js, /cmp\.seenNames/);
    // v3.1.2：seenNames 只在「推荐到」标签在场（弹窗确实开着）时才回——弹窗没开时
    // pageWide 是全页扫「文本 ×」，会把列表页筛选条件芯片（本科 ×、硕士 ×）与导航文本
    // （总览、专家模式）一起收进来，面板据此误报「弹窗当前选了 10 人（总览…）」
    assert.match(content, /const popupOpen = Number\(scraped\.labels\) > 0;/);
    assert.match(content, /const seenRaw = !popupOpen/);
    // v3.1.0 刮取出口归一：标签邻域会把「推荐到」芯片容器整串收进来（「陈晓庆万树吴彦霖李琼」），
    // 拼接串必须在出口去掉，否则人数虚高、面板把 4 个人显示成一坨、比对永远不一致
    // v3.4.0：dedupeSeenChipNames 实现移入 lib/moka-dom-adapter.js
    if (!domAdapter) throw new Error('domAdapter 未加载');
    assert.match(domAdapter, /function dedupeSeenChipNames\(list\)/);
    assert.match(domAdapter, /anchored: dedupeSeenChipNames\(anchored\.names\)/);
    assert.match(domAdapter, /pageWide: dedupeSeenChipNames\(pageWide\)/);
    // popup：弹窗没开时不倒诊断杂项，一句干净指引 + 强调「确认后关弹窗也不丢」
    assert.match(js, /function summarizeScrapeDebug\(debug\)/);
    assert.match(js, /推荐弹窗当前未打开，读不到页面上的姓名/);
    assert.match(js, /② 回这里点「确认本岗简历推荐对象」即可采纳并永久记住，关掉弹窗也不会丢/);
    assert.match(js, /内容脚本版本过旧：请到 chrome:\/\/extensions 重新加载插件/);
    // content：收割 id→姓名 并随 getBatchAssignContext 一并返回
    assert.match(content, /function harvestMemberNames/);
    assert.match(content, /MEMBER_NAME_SKIP_RE\.test\(u\)/);
    assert.match(content, /assigneeNames: resolveAssigneeNamesForDisplay\(\)/);
    // 收割增强：responseType='json' 的 XHR 响应（对象）要 stringify，否则 String(对象)
    // 得到 '[object Object]'、收割整体失效；大响应上限放宽；姓名字段放宽；
    // 收割结果写入流水可诊断
    assert.match(inject, /function xhrResponseText/);
    assert.match(inject, /JSON\.stringify\(xhr\.response\)/);
    assert.match(inject, /MEMBER_TEXT_LIMIT = 600000/);
    assert.match(content, /chineseName/);
    assert.match(content, /\[member-harvest\]/);
    // content：单点推荐人名只在数量与已记录分配 id 完全对上时落库
    assert.match(content, /function storeRecommendNames/);
    // inject：React fiber 直采 id+姓名 对——Moka 是 React 应用，芯片组件的
    // props 里带选中成员对象，这是姓名→id 最可靠来源（不依赖接口收割）
    assert.match(inject, /function reactFiberOf/);
    assert.match(inject, /function collectIdNamePairsFromChipEls/);
    assert.match(inject, /__reactFiber\$/);
    assert.match(inject, /pairs: names\.pairs/);
    assert.match(inject, /scrape-assignee-pairs/);
    assert.match(inject, /assignee-pairs/);
    // content：按需向 MAIN world 索要 pairs；捕获/采纳时把 pairs 种进成员映射
    assert.match(content, /function requestAssigneePairs/);
    assert.match(content, /function seedMemberNamesFromPairs/);
    assert.match(content, /seedMemberNamesFromPairs\(payload\.pairs\)/);
    assert.match(content, /seedMemberNamesFromPairs\(live\.pairs\)/);
    // content：采纳采信顺序——fiber 成对姓名优先（自带 id、伪姓名混不进来），
    // 刮到的姓名并集只作兜底；chipNamesByLabelWalk() 返回对象，必须取 .names
    //（旧代码对对象调 forEach 会抛 TypeError，被 catch 吞成静默失败）
    assert.match(content, /const pairNames = Object\.keys\(byName\)\.filter/);
    assert.match(content, /const local = chipNamesByLabelWalk\(\)/);
    assert.match(content, /Array\.isArray\(local\.names\) \? local\.names : \[\]/);
    // content：采纳全程留痕——点「确认本岗分配对象」后流水里必有一行 [adopt]
    assert.match(content, /function logAdoptTrace/);
    assert.match(content, /'\[adopt\] ' \+ outcome/);
    assert.match(content, /logAdoptTrace\('已采纳'/);
    assert.match(content, /logAdoptTrace\('未采纳'/);
    assert.match(content, /logAdoptTrace\('异常'/);
    // content：采纳异常要带出 error 信息（弹窗侧绝不静默）
    assert.match(content, /reason: 'error',\s*\n\s*error: \(err && err\.message\)/);
    // popup：失败分支逐一显式提示，绝不静默清空 lastAdoptNote、绝不误盖「已确认」章
    assert.match(js, /adopted\.reason === 'no-record'/);
    assert.match(js, /adopted\.reason === 'error'/);
    // v3.2.0：no-record 只剩「页面缺 pipelineId」一种（模板缺失已由默认合成模板兜住，免真发）
    assert.match(js, /✗ 刚刚未采纳：无法定位当前职位（页面缺少 pipelineId，无法落记录）/);
    assert.match(js, /✗ 刚刚未采纳：页面识别异常/);
    assert.match(js, /✗ 刚刚未采纳（未知返回：/);
    assert.ok(!/已确认本岗简历推荐对象，开筛后批量推进将直接使用/.test(js));

    // popup：姓名凑得齐就显示名字，否则退回「N 人」
    assert.match(js, /function formatAssigneeWho/);
  });
});

describe('确认章贯穿全链路（v3.5.0 确认过的名单绝不被静默替换）', () => {
  const readContent = () => source('content.js');

  it('确认时落章：confirmedAt/confirmedIds/confirmedNames 写进分配存档', () => {
    const content = readContent();
    assert.match(content, /entry\.confirmedAt = entry\.savedAt;/);
    assert.match(content, /entry\.confirmedIds = ids\.slice\(\);/);
    assert.match(content, /entry\.confirmedNames = capped\.slice\(\);/);
  });

  it('查档命中确认章记录时，执行名单直接取确认章快照', () => {
    const content = readContent();
    assert.match(content, /const useConfirmed = \(Number\(entry\.confirmedAt\) \|\| 0\) > 0/);
    assert.match(content, /useConfirmed \? entry\.confirmedIds : entry\.assigneeIds/);
  });

  it('页面操作捕获走确认章保护：不同名单不得覆盖主位，只能写别名键留档', () => {
    const content = readContent();
    assert.match(content, /persistAssignmentEntry\(entry, \(ok, detail\) => \{/);
    assert.match(content, /\{ protectConfirmed: true \}/);
    assert.match(content, /已拦截对本岗确认名单的覆盖/);
    assert.match(content, /detail === 'kept-confirmed'/, '保护触发时内存必须回到确认记录');
  });

  it('批量推进执行前守卫 + 名单来源可见（日志与飞书回执都写明确认状态）', () => {
    const content = readContent();
    assert.match(content, /批量推进已拦截：本次名单/);
    assert.match(content, /为防止推进给错误的人已拦截/);
    assert.match(content, /批量推进名单：/);
    assert.match(content, /assigneeConfirmedAt: lastLoadedAssignmentEntry/);
  });

  it('飞书指令带职位身份：卡片 → Bridge → background → content 四段透传并核验', () => {
    const content = readContent();
    const lib = source('lib/feishu.js');
    const bg = source('background.js');
    const server = source('feishu-bridge/server.js');
    assert.match(lib, /jobTitle: String\(jobTitle \|\| ''\)/, '卡片按钮 value 带职位名');
    assert.match(server, /jobTitle: actionVal\.jobTitle \|\| ''/, 'Bridge 透传职位名');
    assert.match(bg, /jobTitle: msg\.jobTitle \|\| ''/, 'background 下发时带上职位名');
    assert.match(content, /handleFeishuRecommend\(request\.minScore, request\.name, request\.jobTitle\)/);
    assert.match(content, /为防止推进错岗位已拦截/, '页面职位与卡片职位不符时拒绝执行');
  });

  it('回执标注名单来源：确认章时间 / 未补章提示', () => {
    const lib = source('lib/feishu.js');
    assert.match(lib, /function assigneeSourceText\(confirmedAt\)/);
    assert.match(lib, /确认于 \$\{d\.getMonth\(\) \+ 1\}-\$\{d\.getDate\(\)\}/);
    assert.match(lib, /未确认章 · 建议回插件「配置」页点「确认本岗简历推荐对象」补章/);
  });
});
