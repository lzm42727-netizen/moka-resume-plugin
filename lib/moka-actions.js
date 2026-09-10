/**
 * Moka 主界面操作自动化（content / Node 测试共用 DOM 逻辑）
 */
(function (root) {
  const TEXT = {
    recommendTrigger: ['推荐给用人部门', '推荐到用人部门'],
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

  function scoreActionMatch(el, texts, opts) {
    const options = opts || {};
    const partial = options.partial !== false;
    const preferActionPanel = options.actionPanel !== false;
    const label = elementLabel(el);
    const full = normText(el.textContent);
    const exact = isExactLabel(el, texts);

    let matched = exact;
    if (!matched && partial) {
      matched = matchesTexts(label, texts, true) || matchesTexts(full, texts, true);
    }
    if (!matched) return -1;

    let score = exact ? 1000 : 100;
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
    const scope = root || (typeof document !== 'undefined' ? document.body : null);
    const nodes = clickableNodes(scope);
    let best = null;
    let bestScore = -1;

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const inModal = !!(el.closest && el.closest('.ant-modal, .ant-modal-wrap, [role="dialog"]'));
      if (modalOnly && !inModal) continue;
      if (excludeModal && inModal) continue;
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

  function resolveClickTarget(el) {
    if (!el) return null;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'a' || (el.getAttribute && el.getAttribute('role') === 'button')) {
      return el;
    }
    if (el.classList && el.classList.contains('ant-btn')) return el;
    const inner = el.querySelector && el.querySelector('button, [role="button"], .ant-btn, a');
    if (inner && isVisible(inner)) return inner;
    const outer = el.closest && el.closest('button, [role="button"], .ant-btn, a');
    if (outer && isVisible(outer)) return outer;
    return el;
  }

  function dispatchClick(el) {
    const target = resolveClickTarget(el);
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

  async function automateRecommend(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope) throw new Error('当前页面不可用');
    await openMoreIfNeeded(scope);
    const trigger = await waitForTexts(TEXT.recommendTrigger, {
      partial: true,
      excludeModal: true,
      actionPanel: true
    }, 25000);
    dispatchClick(trigger);
    await sleep(800);
    const confirm = await waitForTexts(TEXT.recommendConfirm, {
      partial: true,
      modalOnly: false,
      actionPanel: false
    }, 20000);
    dispatchClick(confirm);
    await sleep(500);
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
    dispatchClick(btn);
    await sleep(500);
    // 多数流程会弹出确认框；没有确认框则直接视为已点淘汰
    let confirm = findByTexts(['确认淘汰', '确定淘汰'], null, {
      partial: true,
      modalOnly: true,
      actionPanel: false
    });
    if (!confirm) {
      confirm = await waitForTexts(['确认淘汰', '确定淘汰', '确认', '确定'], {
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
      dispatchClick(confirm);
      await sleep(500);
    }
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
    automateRecommend,
    automateEliminate
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
