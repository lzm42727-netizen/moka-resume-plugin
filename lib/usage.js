/**
 * 本轮筛选的 LLM 用量与费用估算（content / background / popup / Node 测试共用）
 *
 * 说明：
 * - 只有「真实发往模型的请求」计入 calls/in/out；命中评分缓存不调模型，单独计入 cacheHits。
 * - 金额仅用于估算。价目表会随厂商调整，内置值可能过期；
 *   设置页可填「自定义单价（元/百万 tokens）」覆盖内置表。
 * - 内置表中 USD 定价按固定汇率 7.2 折算为元（仅估算，汇率波动不追）。
 */
(function (root) {
  const CNY_USD_RATE = 7.2;

  // 前缀匹配（更长更具体的排前面，避免 gpt-4o 抢先吃掉 gpt-4o-mini）
  // 单位：元 / 百万 tokens（输入、输出）。USD 定价 ×7.2 折算。
  const PRICE_TABLE = [
    { prefix: 'minimax-m2.7-highspeed', inputPerM: 4.2, outputPerM: 16.8 }, // 官方：输入 4.2 / 输出 16.8
    { prefix: 'minimax-m2.7', inputPerM: 2.1, outputPerM: 8.4 },           // 官方：输入 2.1 / 输出 8.4（含 -MT 变体）
    { prefix: 'minimax-m2.5', inputPerM: 2.1, outputPerM: 8.4 },
    { prefix: 'minimax-m2.1', inputPerM: 2.1, outputPerM: 8.4 },
    { prefix: 'minimax-m2', inputPerM: 2.1, outputPerM: 8.4 },
    { prefix: 'claude-3-7-sonnet', inputPerM: 3 * CNY_USD_RATE, outputPerM: 15 * CNY_USD_RATE },
    { prefix: 'claude-3-5-sonnet', inputPerM: 3 * CNY_USD_RATE, outputPerM: 15 * CNY_USD_RATE },
    { prefix: 'claude-sonnet-4', inputPerM: 3 * CNY_USD_RATE, outputPerM: 15 * CNY_USD_RATE },
    { prefix: 'gpt-4o-mini', inputPerM: 0.15 * CNY_USD_RATE, outputPerM: 0.6 * CNY_USD_RATE },
    { prefix: 'gpt-4o', inputPerM: 2.5 * CNY_USD_RATE, outputPerM: 10 * CNY_USD_RATE },
    { prefix: 'gpt-4.1-mini', inputPerM: 0.4 * CNY_USD_RATE, outputPerM: 1.6 * CNY_USD_RATE },
    { prefix: 'gpt-4.1', inputPerM: 2 * CNY_USD_RATE, outputPerM: 8 * CNY_USD_RATE },
    { prefix: 'deepseek-chat', inputPerM: 2, outputPerM: 3 },
    { prefix: 'deepseek-reasoner', inputPerM: 4, outputPerM: 16 }
  ];

  /** 按模型名前缀查内置单价；未收录返回 null */
  function lookupPrice(model) {
    const name = String(model || '').trim().toLowerCase();
    if (!name) return null;
    for (let i = 0; i < PRICE_TABLE.length; i++) {
      const entry = PRICE_TABLE[i];
      if (name.indexOf(entry.prefix) === 0) {
        return { inputPerM: entry.inputPerM, outputPerM: entry.outputPerM };
      }
    }
    return null;
  }

  /** 解析设置里可选的自定义单价（元/百万 tokens）；空/非法返回 null */
  function parseCustomPrice(value) {
    if (value == null || String(value).trim() === '') return null;
    const n = Number(String(value).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * 最终生效单价：设置自定义价 > 内置表 > null（未收录）
   * @returns {{inputPerM:number, outputPerM:number}|null}
   */
  function resolvePrice(modelName, customInput, customOutput) {
    const inCustom = parseCustomPrice(customInput);
    const outCustom = parseCustomPrice(customOutput);
    if (inCustom != null || outCustom != null) {
      const builtin = lookupPrice(modelName) || {};
      return {
        inputPerM: inCustom != null ? inCustom : builtin.inputPerM != null ? builtin.inputPerM : 0,
        outputPerM: outCustom != null ? outCustom : builtin.outputPerM != null ? builtin.outputPerM : 0
      };
    }
    return lookupPrice(modelName);
  }

  function emptyUsage() {
    return { calls: 0, inTok: 0, outTok: 0, cacheHits: 0, model: '', price: null };
  }

  function nonNegInt(n) {
    return Number.isFinite(Number(n)) && Number(n) >= 0 ? Math.round(Number(n)) : 0;
  }

  function normalizeUsage(raw) {
    const u = (raw && typeof raw === 'object') ? raw : {};
    const price = (u.price && typeof u.price === 'object') ? u.price : null;
    return {
      calls: nonNegInt(u.calls),
      inTok: nonNegInt(u.inTok),
      outTok: nonNegInt(u.outTok),
      cacheHits: nonNegInt(u.cacheHits),
      model: String(u.model || '').trim(),
      price: price
        ? {
            inputPerM: Number(price.inputPerM) > 0 ? Number(price.inputPerM) : null,
            outputPerM: Number(price.outputPerM) > 0 ? Number(price.outputPerM) : null,
            priced: !!price.priced
          }
        : null
    };
  }

  /** 记一次真实模型调用（含输入/输出 token；模型名以最后一次为准） */
  function addUsage(u, meta) {
    const usage = normalizeUsage(u);
    // meta.calls > 1：一次得分内部发生了多次真实调用（如截断后加倍重试），按实际次数计入
    const calls = nonNegInt(meta && meta.calls);
    usage.calls += calls > 0 ? calls : 1;
    usage.inTok += nonNegInt(meta && meta.inTok);
    usage.outTok += nonNegInt(meta && meta.outTok);
    const model = String((meta && meta.model) || '').trim();
    if (model) usage.model = model;
    return usage;
  }

  function addCacheHit(u) {
    const usage = normalizeUsage(u);
    usage.cacheHits += 1;
    return usage;
  }

  /** 把 src 的计数并入 dst（跨候选人/跨重试聚合时用），返回新对象 */
  function mergeUsage(dst, src) {
    const a = normalizeUsage(dst);
    const b = normalizeUsage(src);
    a.calls += b.calls;
    a.inTok += b.inTok;
    a.outTok += b.outTok;
    a.cacheHits += b.cacheHits;
    if (b.model) a.model = b.model;
    return a;
  }

  /**
   * 汇总估算金额。
   * @returns {{cost: number|null, priced: boolean}} priced=false 表示该模型未收录单价也未填自定义价
   */
  function sumCost(u) {
    const usage = normalizeUsage(u);
    const price = usage.price;
    const inPerM = price && Number(price.inputPerM) > 0 ? Number(price.inputPerM) : null;
    const outPerM = price && Number(price.outputPerM) > 0 ? Number(price.outputPerM) : null;
    if (inPerM == null && outPerM == null) return { cost: null, priced: false };
    const cost = ((inPerM || 0) * usage.inTok + (outPerM || 0) * usage.outTok) / 1e6;
    return { cost, priced: true };
  }

  /** 金额显示：小到三位小数仍为 0 时显示 <0.001 */
  function formatCost(cost) {
    if (cost == null || !Number.isFinite(Number(cost))) return '';
    const v = Number(cost);
    if (v > 0 && v < 0.001) return '¥<0.001';
    return '¥' + v.toFixed(3);
  }

  /**
   * 结果页首行用：只出「预估花费 ¥x.xxx」；发生过真实调用才计，未收录单价返回 ''
   * （调用次数/token 只进运行日志与进度行，不再上结果页）
   */
  function costOnlyText(rawUsage) {
    const u = normalizeUsage(rawUsage);
    if (!u.calls) return '';
    const { cost, priced } = sumCost(u);
    if (!priced) return '';
    return '预估花费 ' + formatCost(cost);
  }

  /** 进度/结果页展示用一行摘要；无任何调用时返回空串 */
  function summaryText(rawUsage) {
    const u = normalizeUsage(rawUsage);
    if (!u.calls && !u.cacheHits) return '';
    const parts = [];
    parts.push('LLM 调用 ' + u.calls + ' 次');
    if (u.inTok || u.outTok) {
      parts.push('输入 ' + u.inTok.toLocaleString('en-US') + ' / 输出 ' + u.outTok.toLocaleString('en-US') + ' tokens');
    }
    if (u.cacheHits) parts.push('缓存命中 ' + u.cacheHits + ' 人（未调模型）');
    const { cost, priced } = sumCost(u);
    if (priced) {
      parts.push('约 ' + formatCost(cost));
    } else if (u.calls) {
      parts.push('模型未收录单价，未估费');
    }
    return parts.join(' · ');
  }

  const api = {
    PRICE_TABLE,
    CNY_USD_RATE,
    lookupPrice,
    parseCustomPrice,
    resolvePrice,
    emptyUsage,
    normalizeUsage,
    addUsage,
    addCacheHit,
    mergeUsage,
    sumCost,
    formatCost,
    costOnlyText,
    summaryText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaUsage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
