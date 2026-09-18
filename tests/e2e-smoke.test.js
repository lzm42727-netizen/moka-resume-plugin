/**
 * E2E 冒烟链（v3.4.0）：用真实 lib 函数 + 最小 DOM stub 串一条端到端行为链。
 *
 * 背景：既有测试以「正则锚源码」契约为主，核心时序/DOM 逻辑零行为测试（评估报告测试结构失衡）。
 * 本文件补第一条行为链：推荐弹窗 DOM → 芯片刮取 → 采信门 → 模板合成 → 批量重放体 →
 * 响应判定 → 飞书回执卡片。链上任何一环断裂，这里会先红。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const DomAdapter = require('../lib/moka-dom-adapter.js');
const BatchLib = require('../lib/batch.js');
const FeishuLib = require('../lib/feishu.js');

// ---- 最小 DOM stub：支持 moka-dom-adapter 用到的查询面 ----
function makeEl(tag, text, opts = {}) {
  return {
    tagName: String(tag).toUpperCase(),
    textContent: text,
    children: opts.children || [],
    parentElement: null,
    nextElementSibling: null,
    getAttribute: (a) => (a === 'class' ? (opts.class || '') : null),
    querySelector: () => null, // chipLikeNameElement 的关闭图标类名探测
    querySelectorAll: () => opts.q || []
  };
}

/** 搭一个「推荐给用人部门」弹窗：标签 + 4 个芯片（3 个文本 ×、1 个名字+关闭图标） */
function buildPopupDoc({ withLabel = true } = {}) {
  const icon = makeEl('i', '', { class: 'anticon-close' });
  const c1 = makeEl('span', '陈晓庆×');
  const c2 = makeEl('span', '万树 ×');
  const c3 = makeEl('span', '吴彦霖×');
  const c4 = makeEl('span', '李琼');
  c4.nextElementSibling = icon;
  const inner = withLabel ? [c1, c2, c3, c4, icon] : [c1, c2, c3, c4, icon];
  const container = makeEl('div', '', {
    children: inner.slice(),
    // 注意：querySelectorAll 闭包引用 opts.q，必须在创建时传入（事后赋值无效）
    q: inner.slice()
  });
  const label = makeEl('label', '推荐到');
  label.parentElement = container;
  container.parentElement = null;
  const body = makeEl('body', '', { children: [container] });
  container.parentElement = body;
  const all = withLabel ? [label, container, c1, c2, c3, c4, icon] : [container, c1, c2, c3, c4, icon];
  return { doc: { body, querySelectorAll: () => all }, names: ['陈晓庆', '万树', '吴彦霖', '李琼'] };
}

describe('E2E 冒烟链：弹窗 → 刮取 → 采信 → 模板 → 重放 → 回执', () => {
  it('第一环：真实 DOM stub 上刮到弹窗芯片姓名（标签邻域 + 全页兜底两路）', () => {
    const { doc } = buildPopupDoc();
    const scraped = DomAdapter.scrapeRecommendChipNamesFromDom(doc);
    assert.equal(scraped.labels, 1, '「推荐到」标签在场（弹窗确实开着）');
    assert.deepEqual(scraped.anchored, ['陈晓庆', '万树', '吴彦霖', '李琼'], '标签邻域刮到 4 人');
    assert.deepEqual(scraped.pageWide, ['陈晓庆', '万树', '吴彦霖', '李琼'], '全页兜底同样刮到 4 人');
  });

  it('第二环：刮取出口归一——容器拼接串（陈晓庆万树吴彦霖李琼）被丢弃', () => {
    const merged = DomAdapter.dedupeSeenChipNames([
      '陈晓庆万树吴彦霖李琼', '陈晓庆', '万树', '吴彦霖', '李琼'
    ]);
    assert.deepEqual(merged, ['陈晓庆', '万树', '吴彦霖', '李琼'], '拼接串不入列，v3.1.0 行为保持');
  });

  it('第三环：采信门——数量与分配 id 数一致才采信，多收少收整组拒掉', () => {
    const { doc } = buildPopupDoc();
    const scraped = DomAdapter.scrapeRecommendChipNamesFromDom(doc);
    assert.equal(DomAdapter.pickValidAssigneeNames(scraped.anchored, scraped.pageWide, 4).length, 4);
    assert.deepEqual(DomAdapter.pickValidAssigneeNames(scraped.anchored, scraped.pageWide, 3), [],
      '3 个 id 配 4 个名字 → 整组拒采');
    assert.deepEqual(DomAdapter.pickValidAssigneeNames([], [], 3), [], '两路都空 → 不采信');
  });

  it('第四环：无真实模板时合成默认模板（免真发），端点与岗位无关', () => {
    const ids = [6397518, 6397519, 6397520, 6397521];
    const template = BatchLib.buildDefaultTemplate(ids, 'https://app.mokahr.com/');
    assert.ok(template.url.endsWith(BatchLib.ASSIGN_ENDPOINT_PATH));
    assert.ok(template.url.startsWith('https://app.mokahr.com'), 'origin 尾斜杠被折平');
    const body = JSON.parse(template.body);
    assert.deepEqual(body.assigneeIds, ids);
    assert.equal(body.resumeType, 'all');
    assert.deepEqual(body.carbonCopyUserIds, []);
  });

  it('第五环：重放体组装——替换候选人、沿用分配对象与偏好字段', () => {
    const ids = [6397518, 6397519, 6397520, 6397521];
    const template = BatchLib.buildDefaultTemplate(ids, '');
    const built = BatchLib.buildBatchAssignmentBody(
      template.body,
      [839908318, 839908319, 'abc', 0, 839908318], // 混入非法值与重复值
      BatchLib.extractAssigneeIds(template.body)
    );
    assert.equal(built.ok, true, built.error || '');
    assert.deepEqual(built.body.applicationIds, [839908318, 839908319], '非法/重复 id 被清洗');
    assert.deepEqual(built.body.assigneeIds, ids);
    assert.equal(built.body.resumeType, 'all');
  });

  it('第五环（负例）：没有模板 / 没有分配对象 / 超限时给出可读错误', () => {
    assert.match(BatchLib.buildBatchAssignmentBody(null, [1], [2]).error, /尚未捕获批量分配接口/);
    const t = JSON.stringify({ applicationIds: [], assigneeIds: [2], resumeType: 'all' });
    assert.match(BatchLib.buildBatchAssignmentBody(t, [], [2]).error, /没有可推进的候选人/);
    assert.match(BatchLib.buildBatchAssignmentBody(t, [1], []).error, /未记录简历推荐对象/);
    const many = Array.from({ length: 31 }, (_, i) => i + 1);
    assert.match(BatchLib.buildBatchAssignmentBody(t, many, [2]).error, /单次最多推进 30 人/);
  });

  it('第六环：响应判定——2xx + 业务码通过才算成功', () => {
    assert.deepEqual(BatchLib.evaluateAssignmentResponse(200, '{"code":0}'), { ok: true });
    assert.deepEqual(BatchLib.evaluateAssignmentResponse(200, '{"success":true}'), { ok: true });
    assert.equal(BatchLib.evaluateAssignmentResponse(200, '{"code":500,"msg":"越权"}').ok, false);
    assert.equal(BatchLib.evaluateAssignmentResponse(500, 'oops').ok, false);
  });

  it('第七环：推进成功后回执卡片能构建（绿卡 + 推荐对象 + 姓名列表）', () => {
    const built = FeishuLib.buildRecommendationResultCard({
      ok: true,
      count: 4,
      names: ['陈晓庆', '万树', '吴彦霖', '李琼'],
      assignees: ['陈晓庆', '万树', '吴彦霖', '李琼'],
      minScore: 50,
      refreshed: true
    });
    const card = (built && built.card) || built;
    const text = JSON.stringify(card);
    assert.match(text, /陈晓庆/, '回执带候选人姓名');
    assert.match(text, /推荐对象/, '回执写明推给了谁');
    assert.equal((built && built.msg_type) || 'interactive', 'interactive');
  });
});
