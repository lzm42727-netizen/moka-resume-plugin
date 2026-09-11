/**
 * 插件运行日志条目规约（background 留存 / content 上报 / popup 展示共用）
 *
 * 分类（cat）即过滤与着色维度：
 * - req    Moka 页面发出的请求流水
 * - adopt  分配对象采纳/查询/比对
 * - screen 筛选生命周期（开始/停止/续筛/暂停/完成）
 * - score  每个候选人评分摘要
 * - warn   可恢复的异常（如 API 429 重试）
 * - err    失败（解析失败后放弃、请求最终失败等）
 * - info   其他说明
 */
(function (root) {
  const LOG_KEY = 'mokaPluginLog';
  // 500 条：一轮筛选里每个候选人都会产生 score + req 日志，100 条时几十个候选人一轮
  // 就把单次的推荐/淘汰轨迹挤掉了（1.10.3 用户实测「点了个淘汰找不到日志」）
  const LOG_LIMIT = 500;
  const MAX_TEXT = 500;
  const VALID_CATS = new Set(['req', 'adopt', 'screen', 'score', 'warn', 'err', 'info']);

  function normalizeEntry(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const cat = VALID_CATS.has(String(src.cat || '')) ? String(src.cat) : 'info';
    const at = Number.isFinite(Number(src.at)) && Number(src.at) > 0 ? Number(src.at) : Date.now();
    const text = String(src.text || '').trim().slice(0, MAX_TEXT);
    if (!text) return null;
    return { at, cat, text };
  }

  function trimEntries(entries, limit) {
    const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.round(Number(limit)) : LOG_LIMIT;
    const list = Array.isArray(entries) ? entries : [];
    return list.slice(-max);
  }

  const api = {
    LOG_KEY,
    LOG_LIMIT,
    MAX_TEXT,
    VALID_CATS,
    normalizeEntry,
    trimEntries
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaPluginLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
