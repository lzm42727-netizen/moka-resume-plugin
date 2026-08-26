/**
 * 详情 URL 拼装与捕获合并（content / Node 测试共用）
 */
(function (root) {
  const CAPTURE_STORAGE_KEY = 'mokaCapturedRequests';

  function stripSlash(origin) {
    return String(origin || '').replace(/\/+$/, '');
  }

  function looksLikeApplication(o) {
    return !!(o && typeof o === 'object' && !Array.isArray(o)
      && (o.id != null || o.candidateId != null || o.applicationId != null));
  }

  function extractSceneToken() {
    for (let i = 0; i < arguments.length; i++) {
      const part = arguments[i];
      if (part == null || part === '') continue;
      const s = typeof part === 'string' ? part : String(part);
      let m = s.match(/[?&#]scene=([^&#"']+)/i);
      if (m && m[1]) {
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
      }
      m = s.match(/"scene"\s*:\s*"([^"]+)"/);
      if (m && m[1]) return m[1];
    }
    return '';
  }

  function applySceneToUrl(url, scene) {
    if (!url || !scene) return url;
    try {
      const u = new URL(url);
      if (!u.searchParams.get('scene')) u.searchParams.set('scene', scene);
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  function buildDetailUrl(app, capturedDetailRequest, origin, idOverride) {
    const base = stripSlash(origin);
    const id = idOverride != null ? idOverride : (app && app.id);
    const tmpl = capturedDetailRequest && capturedDetailRequest.url;
    if (tmpl && id != null) {
      try {
        const u = new URL(tmpl, base);
        const useCandidate = idOverride == null && /candidate/i.test(u.pathname) && app && app.candidateId != null;
        const val = useCandidate ? app.candidateId : id;
        u.pathname = u.pathname.replace(/(\d{5,})(?=\/|$)/, String(val));
        return u.toString();
      } catch (e) { /* fall through */ }
    }
    if (id == null) return '';
    return `${base}/api/applications/${id}`;
  }

  function unwrapDetailJson(json) {
    if (!json || typeof json !== 'object') return json;
    if (looksLikeApplication(json)) return json;
    const data = json.data;
    if (looksLikeApplication(data)) return data;
    if (data && looksLikeApplication(data.application)) return data.application;
    return json;
  }

  function uniqueDetailUrls(app, capturedDetailRequest, origin, scene) {
    const base = stripSlash(origin);
    const raw = [];
    const seenRaw = new Set();
    const addRaw = (u) => {
      if (!u || seenRaw.has(u)) return;
      seenRaw.add(u);
      raw.push(u);
    };
    if (!app || app.id == null) return [];

    addRaw(buildDetailUrl(app, capturedDetailRequest, base));
    addRaw(`${base}/api/applications/${app.id}`);
    if (app.candidateId != null) {
      addRaw(buildDetailUrl(app, capturedDetailRequest, base, app.candidateId));
      addRaw(`${base}/api/applications/${app.candidateId}`);
    }

    const sceneTok = scene || extractSceneToken(capturedDetailRequest && capturedDetailRequest.url);
    const urls = [];
    const seen = new Set();
    const add = (u) => {
      if (!u || seen.has(u)) return;
      seen.add(u);
      urls.push(u);
    };
    if (sceneTok) {
      raw.forEach((u) => add(applySceneToUrl(u, sceneTok)));
    }
    raw.forEach(add);
    return urls;
  }

  function mergeCapture(live, stored) {
    const L = live || {};
    const S = stored || {};
    return {
      search: L.search || S.search || null,
      detail: L.detail || S.detail || null
    };
  }

  function detailBelongsTo(app, json) {
    if (!json || typeof json !== 'object' || !app) return false;
    const idOk = json.id != null && String(json.id) === String(app.id);
    const candOk = json.candidateId != null && app.candidateId != null
      && String(json.candidateId) === String(app.candidateId);
    const appIdOk = json.applicationId != null && String(json.applicationId) === String(app.id);
    if (json.id == null && json.candidateId == null && json.applicationId == null) return false;
    return idOk || candOk || appIdOk;
  }

  const api = {
    CAPTURE_STORAGE_KEY,
    extractSceneToken,
    applySceneToUrl,
    buildDetailUrl,
    uniqueDetailUrls,
    mergeCapture,
    unwrapDetailJson,
    detailBelongsTo
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
