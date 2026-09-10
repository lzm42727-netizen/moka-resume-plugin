/**
 * 批量推进（批量分配）请求构造与校验（content / popup / Node 测试共用）
 *
 * Moka 批量分配接口（v1.6.3 观测确认）：
 *   POST /api/outer/ats-pipeline/assignment/update/v2
 *   {"applicationIds":[839908318], "assigneeIds":[6397518],
 *    "resumeType":"all", "carbonCopyUserIds":[], "viewExamUserIds":[]}
 * 插件先在页面捕获一次该请求模板（含分配对象），之后替换 applicationIds 重放。
 */
(function (root) {
  const BATCH_ASSIGN_LIMIT = 30;
  const MAX_ASSIGNEES = 5;

  function parseAssignmentBody(raw) {
    try {
      const obj = JSON.parse(String(raw == null ? '' : raw));
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
    } catch (e) {
      return null;
    }
  }

  /** 从捕获的请求体提取分配对象 id 列表，供下次批量沿用 */
  function extractAssigneeIds(raw) {
    const body = parseAssignmentBody(raw);
    const ids = body && Array.isArray(body.assigneeIds) ? body.assigneeIds : [];
    return ids.map(Number).filter(Number.isFinite).slice(0, MAX_ASSIGNEES);
  }

  /** 去重、去非法值，只保留正整数 id（Moka 的 applicationId / userId 均为整数） */
  function sanitizeIdList(list, max) {
    const seen = new Set();
    const out = [];
    (Array.isArray(list) ? list : []).forEach((id) => {
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0) return;
      const key = String(n);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(n);
    });
    return typeof max === 'number' && max > 0 ? out.slice(0, max) : out;
  }

  /**
   * 用捕获模板构造批量分配请求体：替换 applicationIds，沿用其余字段。
   * 返回 { ok, body } 或 { ok: false, error }。
   */
  function buildBatchAssignmentBody(templateRaw, appIds, assigneeIds) {
    const template = parseAssignmentBody(templateRaw);
    if (!template) {
      return { ok: false, error: '尚未捕获批量分配接口：请先在 Moka 手动批量分配一次' };
    }
    const ids = sanitizeIdList(appIds);
    if (!ids.length) {
      return { ok: false, error: '没有可推进的候选人' };
    }
    if (ids.length > BATCH_ASSIGN_LIMIT) {
      return { ok: false, error: '单次最多推进 ' + BATCH_ASSIGN_LIMIT + ' 人，请分批操作' };
    }
    const assignees = sanitizeIdList(assigneeIds, MAX_ASSIGNEES);
    if (!assignees.length) {
      return { ok: false, error: '未记录简历推荐对象：请先在 Moka 手动批量分配一次' };
    }
    return {
      ok: true,
      body: {
        applicationIds: ids,
        assigneeIds: assignees,
        resumeType: template.resumeType || 'all',
        carbonCopyUserIds: sanitizeIdList(template.carbonCopyUserIds, MAX_ASSIGNEES),
        viewExamUserIds: sanitizeIdList(template.viewExamUserIds, 10)
      }
    };
  }

  /**
   * 清洗捕获到的请求头：去掉会与重放冲突的字段，补齐 Content-Type。
   * content-length 由浏览器按实际 body 重算，照抄旧值会被服务端拒绝。
   */
  function sanitizeCapturedHeaders(headers) {
    const out = {};
    const src = headers && typeof headers === 'object' ? headers : {};
    Object.keys(src).forEach((key) => {
      const lower = String(key).toLowerCase();
      if (lower === 'content-length' || lower === 'host') return;
      out[key] = src[key];
    });
    const hasType = Object.keys(out).some((k) => String(k).toLowerCase() === 'content-type');
    if (!hasType) out['Content-Type'] = 'application/json';
    return out;
  }

  /** 校验重放响应：HTTP 2xx 且业务码通过才算成功 */
  function evaluateAssignmentResponse(status, text) {
    if (!(status >= 200 && status < 300)) {
      return { ok: false, error: 'HTTP ' + status + '：' + String(text || '').slice(0, 200) };
    }
    let json = null;
    try {
      json = JSON.parse(String(text || ''));
    } catch (e) {
      json = null;
    }
    if (!json || typeof json !== 'object') {
      return { ok: false, error: 'Moka 返回不可解析，请稍后到列表页核对结果' };
    }
    const code = json.code;
    const codeOk = code === 0 || code === '0' || code == null;
    if (!codeOk && json.success !== true) {
      return { ok: false, error: String(json.message || json.msg || 'Moka 返回失败') };
    }
    return { ok: true };
  }

  const api = {
    BATCH_ASSIGN_LIMIT,
    extractAssigneeIds,
    sanitizeIdList,
    buildBatchAssignmentBody,
    sanitizeCapturedHeaders,
    evaluateAssignmentResponse
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaBatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
