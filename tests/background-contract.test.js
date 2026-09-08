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
  it('callLLM returns usage alongside content instead of dropping it', () => {
    assert.match(bg, /function readUsage\(provider, data\)/);
    assert.match(bg, /prompt_tokens|input_tokens/);
    assert.match(bg, /return \{ content: extractContent\(provider, data\), usage: readUsage\(provider, data\) \};/);
  });

  it('scoreCandidate replies with meta carrying cacheHit or token usage', () => {
    assert.match(bg, /case 'scoreCandidate':[\s\S]{0,120}score: out\.score, meta: out\.meta/);
    assert.match(bg, /meta: \{ cacheHit: true \}/);
    assert.match(bg, /model: settings\.modelName,\s*\n\s*inTok:[\s\S]{0,120}outTok:/);
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
    assert.match(bg, /importScripts\('lib\/plugin-log\.js'\)/);
    assert.match(bg, /let pluginLog = \[\];/);
    assert.match(bg, /chrome\.storage\.session\.get\(MokaPluginLog\.LOG_KEY/);
    assert.match(bg, /MokaPluginLog\.trimEntries\(saved, MokaPluginLog\.LOG_LIMIT\)/);
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
});
