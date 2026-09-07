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
  // 批量分配（本 org 的推进动作）：捕获模板后由 content 按候选人清单重放
  const MATCH_ASSIGNMENT = '/ats-pipeline/assignment/update/v2';

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

  function harvestScene(url) {
    if (!url || String(url).indexOf('scene=') === -1) return;
    try {
      const u = new URL(url, location.origin);
      const s = u.searchParams.get('scene');
      if (s) post('scene-token', { scene: s });
    } catch (e) { /* ignore */ }
  }

  function findSceneOnPage() {
    try {
      const u = new URL(location.href);
      const s = u.searchParams.get('scene');
      if (s) return s;
    } catch (e) { /* ignore */ }
    try {
      const h = String(location.hash || '');
      const m = h.match(/[?&]scene=([^&]+)/);
      if (m) {
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function isDetailUrl(url) {
    if (!url) return false;
    if (url.indexOf(MATCH_SEARCH) !== -1) return false; // 排除列表接口
    return DETAIL_RE.test(url);
  }

  // 接口观测：把页面发出的 POST 请求记成流水（只记不拦），用于发现批量操作等
  // 插件尚未识别的接口。条数上限由 content 侧截断。
  const LOG_BODY_LIMIT = 400;
  function logPostRequest(url, method, body, names) {
    if (String(method || 'GET').toUpperCase() !== 'POST') return;
    let preview = '';
    try { preview = String(body == null ? '' : body).slice(0, LOG_BODY_LIMIT); } catch (e) { preview = ''; }
    const entry = { url: String(url || ''), body: preview, at: Date.now() };
    // 分配请求附带弹窗刮到的姓名（诊断用：空数组 = 没刮到，可从流水直接看出原因）
    if (Array.isArray(names)) entry.names = names;
    post('request-log', entry);
  }

  // 成员姓名收割：把「非候选人」接口的 JSON 响应推给 content，用于建立
  // 分配对象 id → 姓名 的映射（配置页/批量推进确认时显示名字）。
  // 候选人列表与详情接口排除在外，防止把候选人姓名错记成成员姓名。
  const MEMBER_HARVEST_LIMIT = 60; // 每次页面加载最多收割 60 个响应，防刷屏
  let memberHarvestCount = 0;
  // 成员列表接口响应可能很大（全组织成员），上限放宽到 600KB
  const MEMBER_TEXT_LIMIT = 600000;
  function shouldHarvestMembers(url) {
    const u = String(url || '');
    if (!u) return false;
    if (u.indexOf('search-candidate') !== -1) return false;
    if (/\/api\/applications\/\d+/.test(u)) return false;
    if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico)([?#]|$)/.test(u)) return false;
    return true;
  }
  function harvestMemberResponse(url, text) {
    if (memberHarvestCount >= MEMBER_HARVEST_LIMIT) return;
    if (!text || typeof text !== 'string' || text.length > MEMBER_TEXT_LIMIT) return;
    const head = text.charAt(text.search(/\S/) === -1 ? 0 : text.search(/\S/));
    if (head !== '{' && head !== '[') return;
    memberHarvestCount++;
    post('member-data', { url: String(url), text });
  }
  /** XHR 响应文本统一取值：responseType='json' 时 response 是对象，需 stringify，
   *  否则 String(对象) 得到 '[object Object]'，成员收割会整体失效 */
  function xhrResponseText(xhr) {
    try {
      if (xhr.responseType === '' || xhr.responseType === 'text') return xhr.responseText;
      if (xhr.responseType === 'json') {
        return xhr.response && typeof xhr.response === 'object'
          ? JSON.stringify(xhr.response)
          : '';
      }
      return typeof xhr.response === 'string' ? xhr.response : '';
    } catch (e) {
      return '';
    }
  }

  /** 「推荐给用人部门」弹窗芯片刮取（与 content.js 的实时刮取同思路，两处需同步维护）。
   *  名字与 id 的对应关系不做绑定（顺序不可靠），只取整个名字集合，
   *  由 content 校验「名字数 == assigneeIds 数」后才采信。
   *  芯片的「×」有两种形态：文本字符（"张三 ×"）或 SVG/图标类
   *  （ant-design 等组件库，textContent 里根本没有 ×）。两种都要识别。
   *  两遍扫描：先沿「推荐到」标签邻域找（最准），找不到再全页兜底（数量校验把关）。 */
  const CHIP_NAME_RE = /^([\u4e00-\u9fa5A-Za-z0-9·]{1,12})$/;
  const CHIP_NAME_X_RE = /^([\u4e00-\u9fa5A-Za-z0-9·]{1,12})\s*[×✕⨯✖xX]$/;
  const CLOSE_HINT_RE = /close|cross|del|remove|clear|closable/i;
  const CHIP_HINT_RE = /tag|chip|closable|selected[-_]?item|member[-_]?item|assign/i;
  function classOf(el) {
    try { return String((el && el.getAttribute && el.getAttribute('class')) || ''); }
    catch (e) { return ''; }
  }
  /** 名字形态二（纯文本无 ×）的采信条件：芯片本身或紧邻兄弟带关闭图标/
   *  关闭类名，或芯片类名像 tag/chip 组件。防止把「确定」等普通按钮误当姓名。 */
  function chipLike(el) {
    const sib = el && el.nextElementSibling;
    if (CLOSE_HINT_RE.test(classOf(el)) || CLOSE_HINT_RE.test(classOf(sib))) return true;
    try {
      if (el.querySelector('[class*="close"],[class*="cross"],[class*="del"],[class*="remove"],[class*="clear"]')) return true;
    } catch (e) { /* ignore */ }
    if (CHIP_HINT_RE.test(classOf(el))) return true;
    return false;
  }
  function collectChipNamesFrom(el, out, seen) {
    try {
      if (el.children.length > 3) return false; // 芯片最多：名字+图标(+内层)
      const t = String(el.textContent || '').trim();
      let m = t.match(CHIP_NAME_X_RE); // 形态一：文本 ×
      if (!m) {
        m = t.match(CHIP_NAME_RE);     // 形态二：× 是图标，textContent 只有名字
        if (m && !chipLike(el)) m = null;
      }
      if (m && !seen[m[1]]) {
        seen[m[1]] = 1;
        out.push(m[1]);
        return true;
      }
      return false;
    } catch (e) { return false; }
  }
  function findChipLabels() {
    const labels = [];
    try {
      document.querySelectorAll('span,div,label,p,dt').forEach((el) => {
        if (labels.length >= 4) return;
        const t = String(el.textContent || '').trim().replace(/^\*/, '').replace(/[:：]\s*$/, '');
        if (t === '推荐到' || t === '分配给' || t === '分配对象') labels.push(el);
      });
    } catch (e) { /* ignore */ }
    return labels;
  }
  function chipNamesByLabelWalk() {
    const labels = findChipLabels();
    const out = [];
    const els = [];
    const seen = {};
    const isLabel = (el) => labels.indexOf(el) !== -1;
    labels.forEach((lb) => {
      let node = lb;
      for (let i = 0; i < 6 && node && node !== document.body; i++) {
        node = node.parentElement;
        if (!node) break;
        node.querySelectorAll('span,div,li,em,p').forEach((el) => {
          if (!isLabel(el) && collectChipNamesFrom(el, out, seen)) els.push(el);
        });
        if (out.length) break; // 找到芯片层就停，别爬到弹窗外把别处的 × 芯片误收进来
      }
    });
    return { names: out, els };
  }
  function chipNamesPageWide() {
    const out = [];
    const seen = {};
    try {
      const all = document.querySelectorAll('span,div,li,em,p');
      for (let i = 0; i < all.length && out.length < 30; i++) {
        collectChipNamesFrom(all[i], out, seen);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /** React fiber 提取：Moka 是 React 应用，芯片/下拉组件的 props 里带着
   *  选中成员对象（{id/userId, name/userName/label…}）。从芯片元素沿
   *  fiber.return 向上走，抓「数字 id + 芯片姓名」成对数据——这是姓名→id
   *  最可靠的来源，不依赖任何接口响应收割。 */
  function reactFiberOf(el) {
    try {
      const keys = Object.keys(el || {});
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
          return el[k];
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  function pairScanObj(obj, names, pairs, seenPair) {
    try {
      if (!obj || typeof obj !== 'object') return;
      let id = null;
      let name = '';
      for (const k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        const v = obj[k];
        if (id === null && (k === 'id' || k === 'userId' || k === 'uid')
          && Number.isInteger(v) && v > 0) id = v;
        if (!name && typeof v === 'string' && names.indexOf(v) !== -1) name = v;
      }
      if (id && name && !seenPair[id + '|' + name]) {
        seenPair[id + '|' + name] = 1;
        pairs.push({ id, name });
      }
    } catch (e) { /* ignore */ }
  }
  function collectIdNamePairsFromChipEls(els, names) {
    const pairs = [];
    const seenPair = {};
    const seenFiber = new Set();
    (els || []).forEach((el) => {
      let fiber = reactFiberOf(el);
      for (let i = 0; fiber && i < 20; i++) {
        try {
          const props = fiber.memoizedProps;
          if (props && typeof props === 'object') {
            pairScanObj(props, names, pairs, seenPair);
            // props 里的数组/一层嵌套对象（如 value:[{id,label}]、user:{...}）
            for (const k in props) {
              if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
              const v = props[k];
              if (Array.isArray(v)) {
                v.slice(0, 20).forEach((item) => pairScanObj(item, names, pairs, seenPair));
              } else if (v && typeof v === 'object') {
                pairScanObj(v, names, pairs, seenPair);
              }
            }
          }
        } catch (e) { /* ignore */ }
        fiber = fiber.return;
      }
    });
    return pairs.slice(0, 10);
  }
  function scrapeRecommendChipNames() {
    try {
      const walk = chipNamesByLabelWalk();
      const pairs = collectIdNamePairsFromChipEls(walk.els, walk.names);
      return { anchored: walk.names, pageWide: chipNamesPageWide(), pairs };
    } catch (e) {
      return { anchored: [], pageWide: [], pairs: [] };
    }
  }

  // 请求侧：按 URL 精确分类捕获
  function captureRequest(url, method, headers, body) {
    const isAssignment = !!url && url.indexOf(MATCH_ASSIGNMENT) !== -1;
    const chipNames = isAssignment ? scrapeRecommendChipNames() : null;
    logPostRequest(url, method, body, chipNames ? chipNames.anchored : undefined);
    harvestScene(url);
    if (!url) return;
    if (url.indexOf(MATCH_SEARCH) !== -1) {
      if (typeof body === 'string') {
        lastSearch = { url, method: method || 'POST', headers, body };
        post('search-request', lastSearch);
      }
    } else if (isAssignment) {
      if (typeof body === 'string') {
        post('assignment-request', {
          url,
          method: (method || 'POST').toUpperCase(),
          headers: headers || {},
          body,
          scrapedNames: (chipNames && chipNames.anchored) || [],
          pageWideNames: (chipNames && chipNames.pageWide) || [],
          pairs: (chipNames && chipNames.pairs) || []
        });
      }
    } else if (typeof body === 'string' && body.indexOf('"assigneeIds"') !== -1) {
      // 其它带分配对象的请求（如单点「推荐给用人部门」走不同接口时）：
      // 不动重放模板，只把弹窗里刮到的人名带给 content 供展示
      const names = scrapeRecommendChipNames();
      post('assignee-names', {
        url: String(url),
        body,
        scrapedNames: names.anchored,
        pageWideNames: names.pageWide,
        pairs: names.pairs
      });
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
            } else if (resp && shouldHarvestMembers(url)) {
              resp.clone().text().then((t) => harvestMemberResponse(url, t)).catch(() => {});
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
          const rt = xhrResponseText(this);
          if (m.url && isDetailUrl(m.url)) {
            cacheDetailResponse(m.url, rt);
          } else if (m.url && shouldHarvestMembers(m.url)) {
            harvestMemberResponse(m.url, rt);
          }
        } catch (e) { /* ignore */ }
      });

      return send.apply(this, arguments);
    };
  }

  // 3) content script 晚加载时，可主动索要最近一次捕获
  // 4) 批量推进：content 无法确定页面 CSP/CORS 是否放行写接口，改由 MAIN world
  //    用页面原生 fetch 代发——与用户在页面上点按钮发出的请求完全同源同权。
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'moka-content') return;
    if (data.type === 'get-search-request' && lastSearch) {
      post('search-request', lastSearch);
    } else if (data.type === 'get-detail-request') {
      if (detailTemplate) post('detail-request', detailTemplate);
      const scene = findSceneOnPage();
      if (scene) post('scene-token', { scene });
    } else if (data.type === 'do-assignment') {
      runAssignment(data.payload);
    } else if (data.type === 'scrape-assignee-pairs') {
      // content 按需索要：弹窗当前人选的姓名 + React fiber 里的 id（采纳用）
      const reqId = data.payload && data.payload.reqId;
      const chip = scrapeRecommendChipNames();
      post('assignee-pairs', {
        reqId,
        names: chip.anchored,
        pairs: chip.pairs
      });
    }
  });

  /** 用页面原生 fetch 发批量分配请求，结果按 reqId 回传给 content */
  function runAssignment(payload) {
    const reqId = payload && payload.reqId;
    const reply = (resp) => post('assignment-response', Object.assign({ reqId }, resp));
    if (!payload || !payload.url) {
      reply({ status: 0, text: '', error: '缺少请求地址' });
      return;
    }
    const send = typeof origFetch === 'function' ? origFetch : window.fetch;
    let p;
    try {
      p = send.call(window, payload.url, {
        method: 'POST',
        headers: payload.headers || {},
        body: payload.body,
        credentials: 'include'
      });
    } catch (e) {
      reply({ status: 0, text: '', error: (e && e.message) || '请求发送失败' });
      return;
    }
    p.then((resp) => {
      resp.text().then((text) => reply({ status: resp.status, text })).catch(() => reply({ status: resp.status, text: '' }));
    }).catch((e) => {
      reply({ status: 0, text: '', error: (e && e.message) || '网络错误' });
    });
  }
})();
