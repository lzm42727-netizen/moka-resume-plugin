const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bg = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');

describe('score cache and prompt no longer hash recruiter weights', () => {
  it('does not put weights into the candidate score cache key', () => {
    assert.doesNotMatch(bg, /weights:\s*weightKey/);
    assert.doesNotMatch(bg, /normalizeWeightPercents\(config\.weights/);
  });

  it('does not pass weights into the match scoring prompt', () => {
    assert.match(
      bg,
      /buildDimensionPrompt\(\s*\n?\s*profile, jobSpec, config\.jobType, config\.jobJD, hardText, feedbackContext\s*\)/
    );
    assert.doesNotMatch(bg, /buildDimensionPrompt\([\s\S]{0,120}config\.weights/);
  });
});

describe('JD reading survives an imperfect model reply', () => {
  it('repairs a truncated JD json before giving up', () => {
    // 评分那条链路早就修截断了，JD 这条一直是「一次解析不出就当全空」
    assert.match(bg, /function parseJDAnalysis[\s\S]{0,900}repairTruncatedJson/);
  });

  it('judges a JD reply by the same usability rule the side panel uses', () => {
    // 之前只要模型回了 suggestedWeights 就算解读成功，于是「有 JSON、零岗位内容」的回复
    // 会被当成正常 spec 往上传，侧栏再判一次不可用，用户只看到一句笼统的兜底文案
    assert.match(bg, /function parseJDAnalysis[\s\S]{0,600}MokaPersist\.jobSpecIsUsable/);
    assert.doesNotMatch(bg, /p\.suggestedWeights \|\| p\.summary/);
  });

  it('throws away a cached JD spec that carries no job content', () => {
    // 老版本存进缓存的空壳会让「按 JD 刷新」每次都秒失败，且永远不再请求模型
    assert.match(bg, /jdCache\.has\(cacheKey\)[\s\S]{0,300}jobSpecIsUsable\(cached\)/);
    assert.match(bg, /function forgetJd[\s\S]{0,200}jdCache\.delete/);
  });

  it('retries the JD reading once before telling the user it failed', () => {
    assert.match(bg, /async function handleAnalyzeJob[\s\S]{0,1200}parseError[\s\S]{0,400}callLLM/);
  });

  it('reports why the JD reading failed instead of a bare empty shell', () => {
    assert.match(bg, /function parseJDAnalysis[\s\S]{0,1200}classifyLlmJsonFailure/);
    assert.match(bg, /parseErrorMessage/);
    assert.match(bg, /jdParseFailureMessage/);
  });
});

describe('screening usage tracking contract', () => {
  it('callLLM returns usage and finish_reason alongside content instead of dropping them', () => {
    assert.match(bg, /function readUsage\(provider, data\)/);
    assert.match(bg, /prompt_tokens|input_tokens/);
    assert.match(
      bg,
      /return \{\s*\n\s*content: extractContent\(provider, data\),\s*\n\s*usage: readUsage\(provider, data\),\s*\n\s*finishReason: readFinishReason\(provider, data\)\s*\n\s*\};/
    );
  });

  it('scoreCandidate replies with meta carrying cacheHit or token usage', () => {
    assert.match(bg, /case 'scoreCandidate':[\s\S]{0,120}score: out\.score, meta: out\.meta/);
    assert.match(bg, /meta: \{ cacheHit: true \}/);
    assert.match(bg, /model: settings\.modelName,\s*\n\s*calls: usedCalls\.length,\s*\n\s*inTok:[\s\S]{0,160}outTok:/);
  });

  it('serves a modelPriceInfo action using custom-or-builtin price', () => {
    assert.match(bg, /async function getModelPriceInfo\(\)/);
    assert.match(bg, /MokaUsage\.resolvePrice\(settings\.modelName, settings\.modelInputPrice, settings\.modelOutputPrice\)/);
    assert.match(bg, /case 'modelPriceInfo':/);
  });

  it('keeps optional custom price fields out of the default settings crash path', () => {
    assert.match(bg, /modelInputPrice: ''/);
    assert.match(bg, /modelOutputPrice: ''/);
  });
});

describe('plugin run log (会话级运行日志) contract', () => {
  it('imports the shared log lib and reloads the session-scoped ring on SW start', () => {
    assert.match(bg, /(?:importScripts|safeImportScripts)\('lib\/plugin-log\.js'\)/);
    assert.match(bg, /let pluginLog = \[\];/);
    assert.match(bg, /chrome\.storage\.session\.get\(MokaPluginLog\.LOG_KEY/);
    assert.match(bg, /MokaPluginLog\.trimEntries\(saved, MokaPluginLog\.LOG_LIMIT\)/);
  });

  it('importScripts 逐个容错加载（1.6.20）：safeImportScripts 包裹 + console.error 定位失败文件', () => {
    assert.match(bg, /function safeImportScripts\(scriptPath\)[\s\S]{0,160}importScripts\(scriptPath\)[\s\S]{0,120}console\.error/);
    for (const lib of ['lib/contracts.js', 'lib/score.js', 'lib/persist.js', 'lib/feedback.js',
      'lib/screening-job.js', 'lib/usage.js', 'lib/plugin-log.js']) {
      assert.match(bg, new RegExp(`safeImportScripts\\('${lib.replace(/\//g, '\\/')}'\\)`), `${lib} 经 safeImportScripts 加载`);
    }
  });

  it('addPluginLog accepts a single entry or a batch array and broadcasts live to the panel', () => {
    assert.match(bg, /function addPluginLog\(raw\)[\s\S]{0,200}if \(Array\.isArray\(raw\)\)/);
    assert.match(bg, /\{ action: 'pluginLogEntry', entry \}/);
  });

  it('exposes pluginLog / getPluginLog / clearPluginLog dispatcher cases', () => {
    assert.match(bg, /case 'pluginLog':[\s\S]{0,120}addPluginLog\(request\.entry\)/);
    assert.match(bg, /case 'getPluginLog':[\s\S]{0,120}entries: pluginLog\.slice\(\)/);
    assert.match(bg, /case 'clearPluginLog':[\s\S]{0,120}clearPluginLog\(\)/);
  });

  it('keeps warn/err bookmarks on the retry and failure paths of callLLM', () => {
    assert.match(bg, /addPluginLog\(\{ cat: 'warn', text: `API HTTP/);
    assert.match(bg, /addPluginLog\(\{ cat: 'err', text: 'LLM 请求失败/);
  });

  it('no longer owns a desktop-notification dependency', () => {
    assert.doesNotMatch(bg, /chrome\.notifications/);
    assert.doesNotMatch(bg, /notifyOnComplete/);
  });

  it('P1-10 存储写入 storeSet 封装 + P2-4 alarm 空闲自清（1.7.1）', () => {
    // storeSet：写入失败读 lastError / 捕获异常并 console.error，不再静默丢数据
    assert.match(bg, /function storeSet\(items, context\)/);
    assert.match(bg, /console\.error\('\[Moka 筛选\] 存储写入失败/);
    assert.match(bg, /storeSet\(\{ \[MokaPersist\.LLM_CACHE_STORAGE_KEY\][\s\S]{0,120}'llm-cache'\)/);
    // alarm：SW 重启后 keepaliveTabId 归 null 但周期 alarm 仍在 → 清掉即止
    assert.match(bg, /if \(keepaliveTabId == null\) \{\s*\n\s*try \{ chrome\.alarms\.clear\(MokaScreeningJob\.KEEP_ALIVE_ALARM\)/);
  });

  it('评分重试纠偏（1.7.4）：解析失败重试时 prompt 附加严格只输出 JSON 的指令', () => {
    assert.match(bg, /config\.retryAfterParseError/);
    assert.match(bg, /上一次输出无法解析为 JSON/);
    assert.match(bg, /不要输出任何思考过程、解释文字或 markdown 代码块/);
  });
});

describe('v1.8.5 JSON 模式、截断处置与并发设置', () => {
  it('JSON mode：OpenAI 兼容协议且开关打开（默认开）才带 response_format', () => {
    assert.match(bg, /forceJsonMode: true/);
    assert.match(bg, /&& provider === 'openai'\s*\n\s*&& settings\.forceJsonMode !== false;/);
    assert.match(bg, /if \(jsonMode\) \{\s*\n\s*body\.response_format = \{ type: 'json_object' \}/);
  });

  it('网关拒绝 JSON 模式时自动降级重试一次（不再让所有候选人一起失败）', () => {
    assert.match(bg, /let jsonModeDegraded = false/);
    assert.match(bg, /jsonModeActive && !jsonModeDegraded && isJsonModeRejectionStatus\(response\.status\)/);
    assert.match(bg, /已自动降级重试/);
    assert.match(bg, /buildRequest\(provider, settings, systemPrompt, userPrompt, \{ \.\.\.opts, jsonMode: false \}\)/);
    // 降级只在参数类 4xx 触发；鉴权(401/403)/限流(429)/超时(408) 不算，避免白跑一次请求
    assert.match(bg, /function isJsonModeRejectionStatus\(status\)/);
    assert.match(bg, /return s !== 401 && s !== 403 && s !== 408 && s !== 429;/);
  });

  it('callLLM 回传 finish_reason，供截断识别', () => {
    assert.match(bg, /function readFinishReason\(provider, data\)/);
    assert.match(bg, /data\?\.choices\?\.\[0\]\?\.finish_reason/);
    assert.match(bg, /data\.stop_reason/);
    assert.match(bg, /function isTruncatedFinish\(reason\)/);
    assert.match(bg, /finishReason: readFinishReason\(provider, data\)/);
  });

  it('评分调用 maxTokens 提到 8000，截断时加倍重试并合计两次用量', () => {
    assert.match(bg, /const SCORE_MAX_TOKENS = 8000/);
    assert.match(bg, /maxTokens: SCORE_MAX_TOKENS, temperature: 0/);
    assert.match(bg, /parsed\.parseError && isTruncatedFinish\(llmRes\.finishReason\)/);
    assert.match(bg, /maxTokens: SCORE_MAX_TOKENS \* 2/);
    assert.match(bg, /usedCalls\.push\(llmRes\)/);
    assert.match(bg, /calls: usedCalls\.length/);
  });

  it('评分 meta 带诊断字段：finish_reason / 输出长度 / 是否含思考 / 失败类型', () => {
    assert.match(bg, /finishReason: llmRes\.finishReason \|\| ''/);
    assert.match(bg, /outLen: finalContent\.length/);
    assert.match(bg, /hasThink: \/<think\/i\.test\(finalContent\)/);
    assert.match(bg, /parseFailureKind: raw\.parseFailureKind \|\| ''/);
  });

  it('stripThink 处理未闭合的 think 块（思考阶段被截断时不再把思考当 JSON）', () => {
    assert.match(bg, /text\.replace\(\/<think\[\\s\\S\]\*\$\/i, ''\)/);
  });

  it('并发数：默认 6、边界 1–8，随 modelPriceInfo 下发给 content', () => {
    assert.match(bg, /scoreConcurrency: 6/);
    assert.match(bg, /const SCORE_CONCURRENCY_MIN = 1/);
    assert.match(bg, /const SCORE_CONCURRENCY_MAX = 8/);
    assert.match(bg, /function normalizeScoreConcurrency\(value\)/);
    assert.match(bg, /concurrency: normalizeScoreConcurrency\(settings\.scoreConcurrency\)/);
    assert.match(bg, /sendResponse\(\{ ok: true, model: info\.model, price: info\.price, concurrency: info\.concurrency \}\)/);
  });
});

describe('v1.8.6 超时策略与失败分类', () => {
  it('单次调用超时 150s（思考型模型真实耗时可能 60–150s）', () => {
    assert.match(bg, /const LLM_TIMEOUT_MS = 150000/);
    assert.match(bg, /const TIMEOUT_RETRY_MAX = 1/);
    assert.match(bg, /const TIMEOUT_RETRY_DELAY_MS = 5000/);
  });

  it('超时最多补一次，失败不再 3 连发（防网关过载雪崩）', () => {
    assert.match(bg, /if \(isTimeoutError\(error\)\) \{[\s\S]{0,260}timeoutRetries < TIMEOUT_RETRY_MAX/);
    assert.match(bg, /s 后重试最后一次/);
    assert.match(bg, /已重试 \$\{TIMEOUT_RETRY_MAX\} 次/);
    // 超时不再走通用网络重试分支
    assert.match(bg, /if \(error\.name === 'AbortError' \|\| \/请求超时\/\.test\(msg\)\) return false;/);
  });

  it('classifyLlmError 把失败归成 timeout/overload/network/config/other', () => {
    assert.match(bg, /function classifyLlmError\(error\)/);
    assert.match(bg, /if \(\/未配置\\s\*API\\s\*Key\/i\.test\(msg\)\) return 'config'/);
    assert.match(bg, /if \(isTimeoutError\(error\)\) return 'timeout'/);
    assert.match(bg, /return 'overload'/);
    assert.match(bg, /const OVERLOAD_STATUS_RE = \/API \(\?:错误\|HTTP\) \(429\|50\\d\)\//);
  });

  it('调用层异常也回包（带 failureKind + meta.errorKind），不再整条请求失败', () => {
    assert.match(bg, /const kind = classifyLlmError\(error\)/);
    assert.match(bg, /score: MokaScore\.scoreErrorResult\(msg, kind\)/);
    assert.match(bg, /meta: \{ cacheHit: false, model: settings\.modelName, errorKind: kind, calls: 0 \}/);
  });
});

describe('v1.8.9 接口协议与自由提供商', () => {
  it('默认设置新增 apiProtocol，提供商降级为自由标签', () => {
    assert.match(bg, /apiProtocol: 'openai',/);
    assert.match(bg, /apiProvider: '',/);
    assert.match(bg, /const provider = resolveApiProtocol\(settings\);/);
  });

  it('协议解析优先 apiProtocol，老配置按 apiProvider 迁移', () => {
    assert.match(bg, /function resolveApiProtocol\(settings\)/);
    assert.match(bg, /if \(s\.apiProtocol === 'claude' \|\| s\.apiProtocol === 'openai'\) return s\.apiProtocol;/);
    // 老配置只有 apiProvider：claude → claude，openai/custom/自由文本 → openai 兼容
    assert.match(bg, /return String\(s\.apiProvider \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'claude' \? 'claude' : 'openai';/);
    // provider 不再参与 jsonMode 判定（协议即事实来源）
    assert.doesNotMatch(bg, /provider === 'custom'/);
  });

  it('Claude 协议仍走 /v1/messages + x-api-key，Endpoint 可被任意覆盖', () => {
    assert.match(bg, /url: settings\.apiEndpoint \|\| 'https:\/\/api\.anthropic\.com\/v1\/messages'/);
    assert.match(bg, /'x-api-key': settings\.apiKey,/);
    assert.match(bg, /url: normalizeChatEndpoint\(settings\.apiEndpoint\)/);
  });
});

describe('v1.10.0 本地私有配置：连接四项锁定（含模型名），招聘者只需填 API Key', () => {
  it('协议/提供商/Endpoint/模型名 由本地配置强制覆盖（部署信息不被误改）', () => {
    assert.match(bg, /const LOCAL_LOCKED_KEYS = \['apiProtocol', 'apiProvider', 'apiEndpoint', 'modelName'\]/);
    assert.match(bg, /LOCAL_LOCKED_KEYS\.forEach\(\(k\) => \{[\s\S]{0,80}out\[k\] = local\[k\];/);
    assert.doesNotMatch(bg, /localForcedSettings/);
  });

  it('其余字段只作兜底：调用方给了就优先（默认值合并；单价/并发等仍可改）', () => {
    assert.match(bg, /const out = \{ \.\.\.DEFAULT_SETTINGS, \.\.\.local, \.\.\.\(input \|\| \{\}\) \}/);
    assert.match(bg, /resolve\(withLocalSettings\(result\.mokaSettings\)\)/);
    assert.match(bg, /const settings = withLocalSettings\(inputSettings\);/);
  });
});
