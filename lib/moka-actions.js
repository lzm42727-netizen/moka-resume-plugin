/**
 * Moka 主界面操作自动化（content / Node 测试共用 DOM 逻辑）
 */
(function (root) {
  const TEXT = {
    recommendTrigger: ['推荐给用人部门', '推荐到用人部门'],
    // 顺序即优先级：第一条是真正的确认按钮；第二、三条只在旧版页面上兜底，
    // 其中「进入用人部门筛选」是页面上的导航入口（另一个动作），靠打分优先级与弹层作用域共同挡住
    recommendConfirm: ['推荐并进入用人部门筛选', '进入用人部门筛选', '确认推荐'],
    eliminate: ['淘汰'],
    eliminateConfirm: ['确认淘汰', '确定淘汰', '确认', '确定'],
    moreMenu: ['更多', '···', '...']
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').trim();
  }

  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const st = el.ownerDocument && el.ownerDocument.defaultView
      ? el.ownerDocument.defaultView.getComputedStyle(el)
      : null;
    if (!st) return true;
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  }

  function viewportWidth(el) {
    const view = el && el.ownerDocument && el.ownerDocument.defaultView;
    return view ? view.innerWidth : 1200;
  }

  function inActionPanel(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    return rect.left >= viewportWidth(el) * 0.42 && rect.top > 24;
  }

  function clickableSelector() {
    return 'button, a, [role="button"], .ant-btn, span, div, li, label';
  }

  function clickableNodes(root) {
    const doc = root && root.querySelectorAll ? root : null;
    if (!doc) return [];
    return Array.from(doc.querySelectorAll(clickableSelector())).filter(isVisible);
  }

  function matchesTexts(text, patterns, partial) {
    const t = normText(text);
    if (!t) return false;
    return (patterns || []).some((raw) => {
      const p = normText(raw);
      if (!p) return false;
      return partial ? t.indexOf(p) !== -1 : t === p;
    });
  }

  function ownText(el) {
    if (!el || !el.childNodes) return '';
    let text = '';
    el.childNodes.forEach((node) => {
      if (node.nodeType === 3) text += node.textContent || '';
    });
    return normText(text);
  }

  function elementLabel(el) {
    const own = ownText(el);
    if (own) return own;
    return normText(el.textContent);
  }

  function isExactLabel(el, patterns) {
    const own = ownText(el);
    const full = normText(el.textContent);
    return (patterns || []).some((raw) => {
      const p = normText(raw);
      return own === p || full === p;
    });
  }

  /**
   * 弹层（模态框 / 下拉菜单 / 浮层 / 抽屉）范围：确认按钮只应出现在这些容器里。
   * `.ant-drawer` 是为真实事故补的：Moka 部分场景把确认表渲染成抽屉，
   * 旧选择器不认 drawer，三层降级全部超时（白等 16 秒）后报失败。
   */
  const MODAL_SELECTOR = '.ant-modal, .ant-modal-wrap, [role="dialog"], .ant-drawer';
  const POPUP_SELECTOR = MODAL_SELECTOR
    + ', .ant-dropdown, .ant-dropdown-menu, .ant-popover, .ant-select-dropdown, [role="menu"], [role="tooltip"]';

  function closestMatch(el, selector) {
    return !!(el && el.closest && el.closest(selector));
  }

  function isInModal(el) {
    return closestMatch(el, MODAL_SELECTOR);
  }

  function isInPopup(el) {
    return closestMatch(el, POPUP_SELECTOR);
  }

  /**
   * 打分。**模式顺序即优先级**：调用方传的文案数组从具体到宽泛排列，
   * 靠前的模式基础分更高，必须能盖过靠后模式靠「精确匹配」拿到的加成。
   *
   * 这条规则是为一个真实事故加的：确认文案表里同时有 `推荐并进入用人部门筛选`（真确认）
   * 与 `进入用人部门筛选`（页面上的导航入口，另一个动作）。旧打分让后者的「精确匹配 1000 分」
   * 压过了前者的「部分匹配 100 分」，于是点完「推荐」只是跳进了用人部门筛选视图，人没被推荐出去。
   */
  function scoreActionMatch(el, texts, opts) {
    const options = opts || {};
    const partial = options.partial !== false;
    const preferActionPanel = options.actionPanel !== false;
    const patterns = (texts || []).map(normText).filter(Boolean);
    if (!patterns.length) return -1;

    const own = ownText(el);
    const full = normText(el.textContent);

    let rank = -1;
    let exact = false;
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      if (own === p || full === p) {
        rank = i;
        exact = true;
        break;
      }
      if (partial && (own.indexOf(p) !== -1 || full.indexOf(p) !== -1)) {
        rank = i;
        break;
      }
    }
    if (rank < 0) return -1;

    let score = (patterns.length - rank) * 2000;
    if (exact) score += 1000;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'button') score += 250;
    if (el.getAttribute && el.getAttribute('role') === 'button') score += 180;
    if (el.classList && el.classList.contains('ant-btn')) score += 180;
    if (preferActionPanel && inActionPanel(el)) score += 220;
    if (full.length > 40 && !exact) score -= 400;
    score -= Math.min(full.length, 120);
    return score;
  }

  function findByTexts(texts, root, opts) {
    const options = opts || {};
    const modalOnly = !!options.modalOnly;
    const excludeModal = !!options.excludeModal;
    const popupOnly = !!options.popupOnly;
    const excludePopup = !!options.excludePopup;
    const scope = root || (typeof document !== 'undefined' ? document.body : null);
    const nodes = clickableNodes(scope);
    let best = null;
    let bestScore = -1;

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const modal = isInModal(el);
      const popup = modal || isInPopup(el);
      if (modalOnly && !modal) continue;
      if (excludeModal && modal) continue;
      if (popupOnly && !popup) continue;
      if (excludePopup && popup) continue;
      const score = scoreActionMatch(el, texts, options);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  async function waitForTexts(texts, opts, timeoutMs) {
    const timeout = typeof timeoutMs === 'number' ? timeoutMs : 15000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = findByTexts(texts, null, opts);
      if (el) return el;
      await sleep(180);
    }
    throw new Error('未找到操作按钮：' + (texts || []).join(' / '));
  }

  /** 等任意弹层（modal/浮层/抽屉）出现，出现即返回；超时不报错（后续 findRecommendConfirm 自己兜底） */
  async function waitForPopupLayer(timeoutMs) {
    const timeout = typeof timeoutMs === 'number' ? timeoutMs : 4000;
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return false;
    const selectors = POPUP_SELECTOR.split(',').map((s) => s.trim()).filter(Boolean);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (let i = 0; i < selectors.length; i++) {
        const nodes = doc.querySelectorAll(selectors[i]);
        for (let j = 0; j < nodes.length; j++) {
          if (isVisible(nodes[j])) return true;
        }
      }
      await sleep(120);
    }
    return false;
  }

  function resolveClickTarget(el, texts) {
    if (!el) return null;
    const tag = String(el.tagName || '').toLowerCase();
    const selfClickable = tag === 'button' || tag === 'a'
      || (el.getAttribute && el.getAttribute('role') === 'button')
      || (el.classList && el.classList.contains('ant-btn'));
    if (selfClickable) return el;

    // 命中的是容器时，必须点中「自身文案也命中」的那个子按钮；
    // 退化成「取第一个子按钮」会点到同容器里的别的动作（例如页面上的「进入用人部门筛选」）。
    if (texts && texts.length && el.querySelectorAll) {
      const inner = Array.from(el.querySelectorAll(clickableSelector())).filter(isVisible);
      const hit = inner.find((c) => isExactLabel(c, texts))
        || inner.find((c) => matchesTexts(elementLabel(c), texts, true));
      if (hit) return hit;
    }

    const inner = el.querySelector && el.querySelector('button, [role="button"], .ant-btn, a');
    if (inner && isVisible(inner)) return inner;
    const outer = el.closest && el.closest('button, [role="button"], .ant-btn, a');
    if (outer && isVisible(outer)) return outer;
    return el;
  }

  function dispatchClick(el, texts) {
    const target = resolveClickTarget(el, texts);
    if (!target) return false;
    try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { /* ignore */ }
    try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    const view = target.ownerDocument && target.ownerDocument.defaultView;
    if (view && typeof MouseEvent === 'function') {
      const opts = { bubbles: true, cancelable: true, view };
      try {
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
      } catch (e) { /* ignore */ }
    }
    if (typeof target.click === 'function') target.click();
    return true;
  }

  async function openMoreIfNeeded(root) {
    const scope = root || (typeof document !== 'undefined' ? document.body : null);
    if (findByTexts(TEXT.recommendTrigger, scope, { partial: true, actionPanel: true })
      || findByTexts(TEXT.eliminate, scope, { partial: false, actionPanel: true })) {
      return;
    }
    const more = findByTexts(TEXT.moreMenu, scope, { partial: true, actionPanel: true });
    if (more) {
      dispatchClick(more);
      await sleep(500);
    }
  }

  /** 命中元素的可读轨迹，供运行日志排查「点到了什么」 */
  function describeMatch(el) {
    if (!el) return null;
    return {
      text: elementLabel(el).slice(0, 40),
      tag: String(el.tagName || '').toLowerCase(),
      modal: isInModal(el),
      popup: isInPopup(el)
    };
  }

  /**
   * 「推荐给用人部门」的确认按钮。
   *
   * 按「作用域从严到宽」逐级降级，兜底也只认最具体的确认文案 —
   * 绝不允许退化回 `进入用人部门筛选`（页面上的导航入口，那是另一个动作）。
   */
  async function findRecommendConfirm() {
    const attempts = [
      { opts: { partial: true, modalOnly: true, actionPanel: false }, ms: 4000 },
      { opts: { partial: true, popupOnly: true, actionPanel: false }, ms: 2000 },
      { texts: [TEXT.recommendConfirm[0]], opts: { partial: true, actionPanel: false }, ms: 2000 }
    ];
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      const el = await waitForTexts(a.texts || TEXT.recommendConfirm, a.opts, a.ms).catch(() => null);
      if (el) return el;
    }
    throw new Error('未找到「推荐给用人部门」的确认按钮');
  }

  /** 失败诊断：枚举页面上可见弹层的类别、数量与文本开头，随错误信息进运行日志——
   *  再遇到「找不到确认按钮」，日志能直接看出确认层长什么样（1.10.5） */
  function describeVisibleLayers() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.querySelectorAll) return '';
    const selectors = ['.ant-modal', '.ant-drawer', '.ant-popover', '.ant-dropdown', '[role="dialog"]'];
    const parts = [];
    selectors.forEach((sel) => {
      let nodes;
      try { nodes = doc.querySelectorAll(sel); } catch (e) { return; }
      let count = 0;
      let snippet = '';
      for (let i = 0; i < nodes.length; i++) {
        if (!isVisible(nodes[i])) continue;
        count++;
        if (!snippet) snippet = normText(nodes[i].textContent).slice(0, 60);
      }
      if (count) parts.push(sel + '×' + count + '「' + snippet + '」');
    });
    return parts.join(' ； ');
  }

  /** 把诊断信息附加到自动化错误上（无弹层时也注明，避免误以为有弹层没识别） */
  async function findRecommendConfirmOrExplain() {
    try {
      return await findRecommendConfirm();
    } catch (err) {
      const layers = describeVisibleLayers();
      const msg = (err && err.message) || '未找到「推荐给用人部门」的确认按钮';
      throw new Error(msg + (layers ? '（页面可见弹层：' + layers + '）' : '（页面上没有任何可见弹层——确认层可能在新窗口/iframe 里）'));
    }
  }

  async function automateRecommend(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope) throw new Error('当前页面不可用');
    await openMoreIfNeeded(scope);
    const trigger = await waitForTexts(TEXT.recommendTrigger, {
      partial: true,
      excludeModal: true,
      actionPanel: true
    }, 25000);
    dispatchClick(trigger, TEXT.recommendTrigger);
    // 条件等待：确认层一出现就继续，不再死等 800ms（弹窗慢于 800ms 时旧逻辑会空转超时）
    await waitForPopupLayer(4000);
    const confirm = await findRecommendConfirmOrExplain();
    dispatchClick(confirm, TEXT.recommendConfirm);
    await sleep(300);
    return { trigger: describeMatch(trigger), confirm: describeMatch(confirm) };
  }

  async function automateEliminate(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope) throw new Error('当前页面不可用');
    await openMoreIfNeeded(scope);
    let btn = findByTexts(TEXT.eliminate, scope, {
      partial: false,
      excludeModal: true,
      actionPanel: true
    });
    if (!btn) {
      btn = await waitForTexts(TEXT.eliminate, {
        partial: false,
        excludeModal: true,
        actionPanel: true
      }, 12000);
    }
    if (!btn) {
      btn = await waitForTexts(TEXT.eliminate, {
        partial: true,
        excludeModal: true,
        actionPanel: true
      }, 6000);
    }
    dispatchClick(btn, TEXT.eliminate);
    await sleep(500);
    // 多数流程会弹出确认框；没有确认框则直接视为已点淘汰
    let confirm = findByTexts(['确认淘汰', '确定淘汰'], null, {
      partial: true,
      modalOnly: true,
      actionPanel: false
    });
    if (!confirm) {
      confirm = await waitForTexts(TEXT.eliminateConfirm, {
        partial: false,
        modalOnly: true,
        actionPanel: false
      }, 3500).catch(() => null);
    }
    if (!confirm) {
      confirm = findByTexts(['确认', '确定'], null, {
        partial: false,
        modalOnly: true,
        actionPanel: false
      });
    }
    if (confirm) {
      dispatchClick(confirm, ['确认淘汰', '确定淘汰', '确认', '确定']);
      await sleep(500);
    }
    return { trigger: describeMatch(btn), confirm: describeMatch(confirm) };
  }

  // 待办操作跨页面导航执行，超过这个时长仍未收尾就当作残留，不再阻塞新操作
  const PENDING_STALE_MS = 120000;

  function pendingActionState(pending, now, staleMs) {
    if (!pending) return 'none';
    const ts = Number(pending.ts);
    if (!Number.isFinite(ts) || ts <= 0) return 'stale';
    const limit = Number(staleMs) > 0 ? Number(staleMs) : PENDING_STALE_MS;
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return at - ts > limit ? 'stale' : 'active';
  }

  function mokaActionDispatchError(resp) {
    if (resp == null) return '无法连接 Moka 页面，请刷新 Moka 标签页后重试';
    if (resp.ok === false && !resp.pending) return resp.error || 'Moka 操作失败';
    return null;
  }

  const api = {
    TEXT,
    PENDING_STALE_MS,
    pendingActionState,
    mokaActionDispatchError,
    sleep,
    normText,
    matchesTexts,
    ownText,
    scoreActionMatch,
    findByTexts,
    waitForPopupLayer,
    describeVisibleLayers,
    describeMatch,
    automateRecommend,
    automateEliminate
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
