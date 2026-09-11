const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normText,
  matchesTexts,
  ownText,
  scoreActionMatch,
  findByTexts,
  waitForPopupLayer,
  describeVisibleLayers,
  describeMatch,
  pendingActionState,
  mokaActionDispatchError,
  PENDING_STALE_MS,
  TEXT
} = require('../lib/moka-actions.js');

/** 构造一个可被 findByTexts / scoreActionMatch 处理的假元素 */
function mockNode(label, opts) {
  const o = opts || {};
  return {
    tagName: o.tagName || 'BUTTON',
    textContent: label,
    childNodes: [{ nodeType: 3, textContent: label }],
    classList: { contains: (c) => c === (o.className || '') },
    getAttribute: (k) => (k === 'role' ? o.role : null),
    getBoundingClientRect: () => ({
      left: o.left == null ? 900 : o.left,
      top: o.top == null ? 200 : o.top,
      width: 80,
      height: 32
    }),
    ownerDocument: {
      defaultView: {
        innerWidth: 1440,
        getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' })
      }
    },
    closest: (sel) => ((o.ancestors || []).some((a) => String(sel).indexOf(a) !== -1) ? {} : null)
  };
}

function mockDoc(nodes) {
  return { querySelectorAll: () => nodes };
}

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
    const resumeScore = scoreActionMatch(resumeHit, TEXT.eliminate, {
      partial: true,
      actionPanel: true
    });
    const btnScore = scoreActionMatch(actionBtn, TEXT.eliminate, {
      partial: false,
      actionPanel: true
    });
    assert.ok(resumeScore >= 0);
    assert.ok(btnScore > resumeScore);
  });

  it('reads direct text nodes via ownText', () => {
    const el = mockNode('淘汰', { tagName: 'BUTTON' });
    assert.equal(ownText(el), '淘汰');
  });

  it('模式顺序即优先级：具体确认文案胜过被精确命中的导航入口', () => {
    // 回归：这两条文案在 Moka 上都存在，后者是「进入用人部门筛选」页面导航入口（另一个动作）。
    // 旧打分让后者的精确匹配（1000）压过前者的部分匹配（100），点「推荐」只会跳转、人没被推荐。
    const navEntry = mockNode('进入用人部门筛选', { left: 300 });
    const realConfirm = mockNode('推荐并进入用人部门筛选');
    const navScore = scoreActionMatch(navEntry, TEXT.recommendConfirm, { partial: true, actionPanel: false });
    const confirmScore = scoreActionMatch(realConfirm, TEXT.recommendConfirm, { partial: true, actionPanel: false });
    assert.ok(confirmScore > navScore);
  });
});

describe('findByTexts 作用域', () => {
  it('弹窗内的确认按钮胜出，页面级导航入口被 modalOnly 排除', () => {
    const navEntry = mockNode('进入用人部门筛选', { left: 300 });
    const modalConfirm = mockNode('推荐并进入用人部门筛选', { ancestors: ['.ant-modal'] });
    const doc = mockDoc([navEntry, modalConfirm]);
    const picked = findByTexts(TEXT.recommendConfirm, doc, {
      partial: true,
      modalOnly: true,
      actionPanel: false
    });
    assert.equal(picked, modalConfirm);
  });

  it('无作用域限制时也不退化：具体文案仍然胜出', () => {
    const navEntry = mockNode('进入用人部门筛选', { left: 300 });
    const modalConfirm = mockNode('推荐并进入用人部门筛选');
    const doc = mockDoc([navEntry, modalConfirm]);
    const picked = findByTexts(TEXT.recommendConfirm, doc, { partial: true, actionPanel: false });
    assert.equal(picked, modalConfirm);
  });

  it('popupOnly 覆盖下拉菜单与浮层，不误伤页面按钮', () => {
    const pageBtn = mockNode('确认推荐', { left: 300 });
    const dropdownItem = mockNode('确认推荐', { ancestors: ['.ant-dropdown'] });
    const doc = mockDoc([pageBtn, dropdownItem]);
    const picked = findByTexts(['确认推荐'], doc, { partial: true, popupOnly: true, actionPanel: false });
    assert.equal(picked, dropdownItem);
  });

  it('确认表渲染成抽屉（.ant-drawer）时 modalOnly 也能命中（1.10.2 回归）', () => {
    // 真实事故：部分场景确认层是抽屉，旧选择器不认，三层降级全部超时后报失败
    const drawerConfirm = mockNode('推荐并进入用人部门筛选', { ancestors: ['.ant-drawer'] });
    const doc = mockDoc([drawerConfirm]);
    const picked = findByTexts(TEXT.recommendConfirm, doc, {
      partial: true,
      modalOnly: true,
      actionPanel: false
    });
    assert.equal(picked, drawerConfirm);
    const m = describeMatch(drawerConfirm);
    assert.equal(m.modal, true);
  });

  it('describeMatch 给出可读轨迹，供运行日志定位误点', () => {
    const m = describeMatch(mockNode('推荐并进入用人部门筛选', { ancestors: ['.ant-modal'] }));
    assert.equal(m.text, '推荐并进入用人部门筛选');
    assert.equal(m.tag, 'button');
    assert.equal(m.modal, true);
    assert.equal(describeMatch(null), null);
  });
});

describe('waitForPopupLayer（1.10.2 条件等待）', () => {
  const visibleNode = () => ({
    getBoundingClientRect: () => ({ width: 200, height: 120, left: 0, top: 0 }),
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) }
    }
  });

  it('确认层一出现立即返回 true，不再死等固定毫秒', async () => {
    global.document = { querySelectorAll: () => [visibleNode()] };
    try {
      const t0 = Date.now();
      assert.equal(await waitForPopupLayer(4000), true);
      assert.ok(Date.now() - t0 < 1000, '应在出现瞬间返回，而不是等满超时');
    } finally {
      delete global.document;
    }
  });

  it('弹层一直不出现时空转到超时返回 false，不抛错（由后续三级降级兜底）', async () => {
    global.document = { querySelectorAll: () => [] };
    try {
      assert.equal(await waitForPopupLayer(0), false);
    } finally {
      delete global.document;
    }
  });
});

describe('describeVisibleLayers（1.10.5 失败诊断）', () => {
  const node = (text, visible) => ({
    textContent: text,
    getBoundingClientRect: () => ({ width: visible ? 200 : 0, height: visible ? 80 : 0, left: 0, top: 0 }),
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) }
    }
  });

  it('枚举可见弹层的类别、数量与文本开头；不可见的弹层不计入', () => {
    global.document = {
      querySelectorAll: (sel) => {
        if (sel === '.ant-drawer') return [node('推荐并进入用人部门筛选 取消', true)];
        if (sel === '.ant-modal') return [node('隐藏的 modal', false)];
        return [];
      }
    };
    try {
      const out = describeVisibleLayers();
      assert.ok(out.indexOf('.ant-drawer×1') !== -1, out);
      assert.ok(out.indexOf('推荐并进入用人部门筛选') !== -1, out);
      assert.ok(out.indexOf('.ant-modal') === -1, '不可见弹层不应出现：' + out);
    } finally {
      delete global.document;
    }
  });

  it('页面上没有任何可见弹层时返回空串（错误信息会注明可能在新窗口/iframe）', () => {
    global.document = { querySelectorAll: () => [] };
    try {
      assert.equal(describeVisibleLayers(), '');
    } finally {
      delete global.document;
    }
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
    assert.equal(mokaActionDispatchError(null), '无法连接 Moka 页面，请刷新 Moka 标签页后重试');
    assert.equal(
      mokaActionDispatchError(undefined),
      '无法连接 Moka 页面，请刷新 Moka 标签页后重试'
    );
  });

  it('内容脚本明确失败时透传原因', () => {
    assert.equal(
      mokaActionDispatchError({ ok: false, error: '筛选进行中，请稍后再操作' }),
      '筛选进行中，请稍后再操作'
    );
    assert.equal(mokaActionDispatchError({ ok: false }), 'Moka 操作失败');
  });

  it('已受理（pending）或成功时不算错误', () => {
    assert.equal(mokaActionDispatchError({ ok: true, pending: true }), null);
    assert.equal(mokaActionDispatchError({ ok: false, pending: true }), null);
    assert.equal(mokaActionDispatchError({ ok: true }), null);
  });
});
