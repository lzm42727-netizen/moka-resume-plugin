/**
 * Moka 弹窗芯片刮取 DOM 适配层（content / Node 测试共用）。
 *
 * 职责：把「推荐给用人部门」弹窗里「推荐到/分配给/分配对象」芯片的人名刮取
 * 全链路收敛到一个纯 DOM 模块——content.js 只做委托，Node 侧可以用最小 DOM stub
 * 直接跑行为测试（不再只靠正则锚源码）。
 *
 * 与 inject.js 的 scrapeRecommendChipNames 思路保持一致（两处需同步维护）：
 * inject 在 MAIN world 抓请求响应，本模块在 ISOLATED world 直接读 DOM，互为补充。
 */
(function (root) {
  const CHIP_LABEL_SET = ['推荐到', '分配给', '分配对象'];
  const CHIP_NAME_MAX_LEN = 12;
  const PAGE_WIDE_LIMIT = 30;

  function chipLikeNameElement(el) {
    try {
      const CLOSE_HINT_RE = /close|cross|del|remove|clear|closable/i;
      const CHIP_HINT_RE = /tag|chip|closable|selected[-_]?item|member[-_]?item|assign/i;
      const classOf = (node) => {
        try { return String((node && node.getAttribute && node.getAttribute('class')) || ''); }
        catch (e) { return ''; }
      };
      const sib = el && el.nextElementSibling;
      if (CLOSE_HINT_RE.test(classOf(el)) || CLOSE_HINT_RE.test(classOf(sib))) return true;
      if (el.querySelector('[class*="close"],[class*="cross"],[class*="del"],[class*="remove"],[class*="clear"]')) return true;
      return CHIP_HINT_RE.test(classOf(el));
    } catch (e) {
      return false;
    }
  }

  /** 从元素收集芯片姓名（文本 × 形态 + 纯名字+图标佐证形态），返回是否命中 */
  function collectChipNamesFrom(el, out, seen) {
    try {
      const t = String(el.textContent || '').trim();
      let m = t.match(new RegExp('^([\\u4e00-\\u9fa5A-Za-z0-9·]{1,' + CHIP_NAME_MAX_LEN + '})\\s*[×✕⨯✖xX]$')); // 形态一：文本 ×
      if (!m) {
        m = t.match(new RegExp('^([\\u4e00-\\u9fa5A-Za-z0-9·]{1,' + CHIP_NAME_MAX_LEN + '})$')); // 形态二：× 是图标
        if (m && !chipLikeNameElement(el)) m = null;
      }
      if (m && !seen[m[1]]) {
        seen[m[1]] = 1;
        out.push(m[1]);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /** 找「推荐到/分配给/分配对象」标签元素（最多 4 个） */
  function findChipLabels(doc) {
    const labels = [];
    try {
      doc.querySelectorAll('span,div,label,p,dt').forEach((el) => {
        if (labels.length >= 4) return;
        const t = String(el.textContent || '').trim().replace(/^\*/, '').replace(/[:：]\s*$/, '');
        if (CHIP_LABEL_SET.indexOf(t) !== -1) labels.push(el);
      });
    } catch (e) { /* ignore */ }
    return labels;
  }

  /** 第一遍：从标签向上 6 层找芯片层（推荐弹窗内）。返回 { labels, names } */
  function chipNamesByLabelWalk(doc) {
    const labels = findChipLabels(doc);
    const out = [];
    const seen = {};
    labels.forEach((lb) => {
      let node = lb;
      for (let i = 0; i < 6 && node && node !== (doc.body || null); i++) {
        node = node.parentElement;
        if (!node) break;
        node.querySelectorAll('span,div,li,em,p').forEach((el) => {
          if (labels.indexOf(el) !== -1 || el.children.length > 3) return;
          collectChipNamesFrom(el, out, seen);
        });
        if (out.length) break; // 找到芯片层就停，防止收进弹窗外别的 × 芯片
      }
    });
    return { labels: labels.length, names: out };
  }

  /** 第二遍：全页兜底扫「文本 ×」与「名字+关闭图标」芯片（标签结构不同时用），
   *  数量由 merge 侧按本岗分配 id 数校验，多收无害（会整组拒掉）。上限防误伤。 */
  function chipNamesPageWide(doc) {
    const out = [];
    const seen = {};
    try {
      const all = doc.querySelectorAll('span,div,li,em,p');
      for (let i = 0; i < all.length && out.length < PAGE_WIDE_LIMIT; i++) {
        const el = all[i];
        if (!el.children || el.children.length > 3) continue;
        collectChipNamesFrom(el, out, seen);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /** 实时刮取当前打开的「推荐给用人部门」弹窗芯片姓名。
   *  返回 { labels, anchored, pageWide } —— anchored 第一遍标签邻域，pageWide 全页兜底。 */
  function scrapeRecommendChipNamesFromDom(doc) {
    const anchored = chipNamesByLabelWalk(doc);
    const pageWide = chipNamesPageWide(doc);
    // v3.1.0：在刮取出口就去掉拼接串——标签邻域会把「推荐到」芯片的容器整串收进来
    // （如「陈晓庆万树吴彦霖李琼」），下游所有消费方（数量门采信、与已记录比对、面板展示）
    // 都会被它污染：名字多一个、人数对不上，显示永远不一致。出口归一，一处解决。
    return {
      labels: anchored.labels,
      anchored: dedupeSeenChipNames(anchored.names),
      pageWide: dedupeSeenChipNames(pageWide)
    };
  }

  /** 弹窗刮到的名字 → 可采信的姓名集合：去重清洗后数量必须与分配 id 数一致 */
  function validAssigneeNames(scraped, count) {
    if (!Array.isArray(scraped) || !count) return [];
    const clean = [];
    (scraped || []).forEach((n) => {
      const t = String(n || '').trim();
      if (t && t.length <= CHIP_NAME_MAX_LEN && clean.indexOf(t) === -1) clean.push(t);
    });
    return clean.length === count ? clean : [];
  }

  /** 两路刮取结果的采信顺序：先标签邻域（anchored），凑不齐再用全页兜底（pageWide），
   *  数量必须与分配 id 数一致才采信 */
  function pickValidAssigneeNames(anchored, pageWide, count) {
    const first = validAssigneeNames(anchored, count);
    if (first.length) return first;
    return validAssigneeNames(pageWide, count);
  }

  /** 刮取结果归一（v3.1.0）：① 精确重复；② 拼接串——长度 ≥6 且包含其它已见姓名的
   *  判为拼接串丢弃（中文姓名 2~3 字，不会误伤） */
  function dedupeSeenChipNames(list) {
    const arr = [];
    (Array.isArray(list) ? list : []).forEach((n) => {
      const s = String(n || '').trim();
      if (s && arr.indexOf(s) === -1) arr.push(s);
    });
    return arr.filter((x) => !(x.length >= 6 && arr.some((y) => y !== x && x.indexOf(y) !== -1)));
  }

  const api = {
    collectChipNamesFrom,
    findChipLabels,
    chipNamesByLabelWalk,
    chipNamesPageWide,
    scrapeRecommendChipNamesFromDom,
    validAssigneeNames,
    pickValidAssigneeNames,
    dedupeSeenChipNames
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaDomAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
