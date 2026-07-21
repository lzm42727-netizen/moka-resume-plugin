/**
 * Moka 智能简历筛选 - 页面注入脚本（MAIN world）
 *
 * 捕获 Moka 页面自己发出的请求，供 content script「原样重放」：
 *  1. search-candidate/v2：候选人列表搜索 → 分页拉取全部候选人。
 *  2. /api/applications/{id}：单个候选人「详情接口」（含 scene 令牌）。
 *     —— 用精确 URL 规则识别（不靠响应内容嗅探，避免把「列表接口」误认成详情，
 *        因为列表返回里每个人的头像也带 OSS 签名链接，会导致数据串号）。
 *     同时把详情响应按其应用 id 缓存，页面已打开过的候选人可直接复用。
 *
 * 通过 window.postMessage 与 content script（ISOLATED world）通信。
 */
(function () {
  const MATCH_SEARCH = 'search-candidate/v2';
  // 单个候选人详情：/api/applications/814701185(?scene=...)，且不能是列表搜索接口
  const DETAIL_RE = /\/api\/applications\/(\d+)(?:[/?#]|$)/;

  let lastSearch = null;
  let detailTemplate = null; // 详情请求模板

  function normalizeHeaders(headers) {
    const out = {};
    if (!headers) return out;
    if (headers instanceof Headers) {
      headers.forEach((v, k) => { out[k] = v; });
    } else if (Array.isArray(headers)) {
      headers.forEach(([k, v]) => { out[k] = v; });
    } else if (typeof headers === 'object') {
      Object.assign(out, headers);
    }
    return out;
  }

  function post(type, payload) {
    try { window.postMessage({ source: 'moka-inject', type, payload }, '*'); } catch (e) { /* ignore */ }
  }

  function isDetailUrl(url) {
    if (!url) return false;
    if (url.indexOf(MATCH_SEARCH) !== -1) return false; // 排除列表接口
    return DETAIL_RE.test(url);
  }

  // 请求侧：按 URL 精确分类捕获
  function captureRequest(url, method, headers, body) {
    if (!url) return;
    if (url.indexOf(MATCH_SEARCH) !== -1) {
      if (typeof body === 'string') {
        lastSearch = { url, method: method || 'POST', headers, body };
        post('search-request', lastSearch);
      }
    } else if (isDetailUrl(url)) {
      detailTemplate = { url, method: (method || 'GET').toUpperCase(), headers: headers || {} };
      post('detail-request', detailTemplate);
    }
  }

  // 响应侧：仅缓存「单个候选人详情」响应，供 content 直接复用（严格按 URL 判定）
  function cacheDetailResponse(url, text) {
    if (!isDetailUrl(url) || !text || typeof text !== 'string') return;
    if (text.length > 600000) return;
    post('detail-data', { url, text });
  }

  // 1) 劫持 fetch
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      let url = '';
      let method = 'GET';
      let headers = {};
      let body = null;
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        method = (init && init.method) || (input && input.method) || 'GET';
        headers = normalizeHeaders((init && init.headers) || (input && input.headers));
        body = (init && init.body) || null;
        captureRequest(url, method, headers, body);
      } catch (e) { /* ignore */ }

      const p = origFetch.apply(this, arguments);
      try {
        p.then((resp) => {
          try {
            if (resp && isDetailUrl(url)) {
              resp.clone().text().then((t) => cacheDetailResponse(url, t)).catch(() => {});
            }
          } catch (e) { /* ignore */ }
        }).catch(() => {});
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  // 2) 劫持 XMLHttpRequest
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      this.__moka = { method, url, headers: {} };
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (k, v) {
      if (this.__moka) this.__moka.headers[k] = v;
      return setHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      try {
        if (this.__moka && this.__moka.url) {
          captureRequest(this.__moka.url, this.__moka.method, this.__moka.headers, typeof body === 'string' ? body : null);
        }
      } catch (e) { /* ignore */ }

      this.addEventListener('load', function () {
        try {
          const m = this.__moka || {};
          if (m.url && isDetailUrl(m.url)) {
            const rt = (this.responseType === '' || this.responseType === 'text') ? this.responseText : String(this.response || '');
            cacheDetailResponse(m.url, rt);
          }
        } catch (e) { /* ignore */ }
      });

      return send.apply(this, arguments);
    };
  }

  // 3) content script 晚加载时，可主动索要最近一次捕获
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'moka-content') return;
    if (data.type === 'get-search-request' && lastSearch) {
      post('search-request', lastSearch);
    } else if (data.type === 'get-detail-request' && detailTemplate) {
      post('detail-request', detailTemplate);
    }
  });
})();
