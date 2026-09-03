const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normText,
  matchesTexts,
  ownText,
  scoreActionMatch,
  pendingActionState,
  mokaActionDispatchError,
  PENDING_STALE_MS,
  TEXT
} = require('../lib/moka-actions.js');

describe('moka-actions text helpers', () => {
  it('normalizes whitespace in labels', () => {
    assert.equal(normText('  推荐给用人部门  '), '推荐给用人部门');
  });

  it('matches partial button labels', () => {
    assert.equal(matchesTexts('推荐给用人部门', TEXT.recommendTrigger, true), true);
    assert.equal(matchesTexts('推荐并进入用人部门筛选', TEXT.recommendConfirm, true), true);
    assert.equal(matchesTexts('淘汰', TEXT.eliminate, true), true);
  });
});

describe('scoreActionMatch', () => {
  function mockEl(label, opts) {
    const o = opts || {};
    return {
      tagName: o.tagName || 'DIV',
      classList: { contains: (c) => c === (o.className || '') },
      getAttribute: (k) => (k === 'role' ? o.role : null),
      childNodes: [{ nodeType: 3, textContent: label }],
      textContent: label,
      getBoundingClientRect: () => ({
        left: o.left == null ? 900 : o.left,
        top: o.top == null ? 200 : o.top,
        width: 80,
        height: 32
      }),
      ownerDocument: { defaultView: { innerWidth: 1440 } }
    };
  }

  it('prefers exact 淘汰 on the right-side button over resume text hit', () => {
    const resumeHit = mockEl('曾参与末位淘汰考核', { left: 120, tagName: 'SPAN' });
    const actionBtn = mockEl('淘汰', { tagName: 'BUTTON', left: 980 });
    const resumeScore = scoreActionMatch(resumeHit, TEXT.eliminate, { partial: true, actionPanel: true });
    const btnScore = scoreActionMatch(actionBtn, TEXT.eliminate, { partial: false, actionPanel: true });
    assert.ok(resumeScore >= 0);
    assert.ok(btnScore > resumeScore);
  });

  it('reads direct text nodes via ownText', () => {
    const el = mockEl('淘汰', { tagName: 'BUTTON' });
    assert.equal(ownText(el), '淘汰');
  });
});

describe('pendingActionState', () => {
  const now = 1_700_000_000_000;

  it('没有待办时为 none', () => {
    assert.equal(pendingActionState(null, now), 'none');
    assert.equal(pendingActionState(undefined, now), 'none');
  });

  it('刚发起的待办为 active', () => {
    assert.equal(pendingActionState({ ts: now - 1000 }, now), 'active');
  });

  it('超过过期阈值的待办为 stale，避免永久挡住后续操作', () => {
    assert.equal(pendingActionState({ ts: now - PENDING_STALE_MS - 1 }, now), 'stale');
  });

  it('缺少时间戳的脏数据按 stale 处理', () => {
    assert.equal(pendingActionState({ appId: '1' }, now), 'stale');
    assert.equal(pendingActionState({ ts: 'x' }, now), 'stale');
  });

  it('过期阈值可覆盖', () => {
    assert.equal(pendingActionState({ ts: now - 5000 }, now, 3000), 'stale');
    assert.equal(pendingActionState({ ts: now - 5000 }, now, 9000), 'active');
  });
});

describe('mokaActionDispatchError', () => {
  it('内容脚本无回包时立即给出可执行提示，而不是静默等待', () => {
    assert.equal(
      mokaActionDispatchError(null),
      '无法连接 Moka 页面，请刷新 Moka 标签页后重试'
    );
    assert.equal(
      mokaActionDispatchError(undefined),
      '无法连接 Moka 页面，请刷新 Moka 标签页后重试'
    );
  });

  it('内容脚本明确失败时透传原因', () => {
    assert.equal(mokaActionDispatchError({ ok: false, error: '筛选进行中，请稍后再操作' }), '筛选进行中，请稍后再操作');
    assert.equal(mokaActionDispatchError({ ok: false }), 'Moka 操作失败');
  });

  it('已受理（pending）或成功时不算错误', () => {
    assert.equal(mokaActionDispatchError({ ok: true, pending: true }), null);
    assert.equal(mokaActionDispatchError({ ok: false, pending: true }), null);
    assert.equal(mokaActionDispatchError({ ok: true }), null);
  });
});
