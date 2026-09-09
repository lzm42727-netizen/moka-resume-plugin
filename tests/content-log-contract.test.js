/**
 * content.js 运行日志接入点契约测试（源码级）。
 *
 * 背景：设置页的「运行日志」由 background 统一留存（会话级最近 100 条），
 * content 只负责把本地事件推过去。防的是这类事故：接入点改了但没人发现
 * （例如 logAdoptTrace 只写旧 requestLog、筛选完成不落日志），或者把整个
 * 日志总线拆掉后旧面板文案还留着。这里不做行为仿真，只锁接入点存在。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');

describe('content.js 运行日志接入点', () => {
  it('定义队列化转发助手 pushPluginLog（按批发 background，旧 requestLog 仍保留）', () => {
    assert.match(js, /function flushPluginLog\(\)[\s\S]{0,200}action: 'pluginLog', entry: batch/);
    assert.match(js, /function pushPluginLog\(raw\)/);
    assert.match(js, /const REQUEST_LOG_LIMIT = 80;\nconst requestLog = \[\];/);
    assert.match(js, /request\.action === 'getRequestLog'[\s\S]{0,80}requestLog\.slice\(\)/);
  });

  it('logCapturedRequest 把请求流水同步进运行日志（只记地址与分配对象名，不记 body）', () => {
    assert.match(js, /requestLog\.push\(item\);[\s\S]{0,600}pushPluginLog\(\{ cat: 'req', text, at: item\.at \}\)/);
  });

  it('logAdoptTrace 的采纳/查询/异常都进运行日志', () => {
    assert.match(js, /function logAdoptTrace\(outcome, detail\)[\s\S]{0,300}cat: 'adopt',/);
  });

  it('finishScreeningJob 是生命周期日志的收口：终止/暂停/完成都从这里落一条 screen', () => {
    assert.match(js, /SCREEN_STATUS_LABEL = \{[\s\S]{0,200}done: '筛选完成'/);
    assert.match(js, /async function finishScreeningJob\(status, extra\)[\s\S]{0,900}cat: 'screen',/);
  });

  it('开筛 / 续筛 / 丢弃三个主动动作各落一条 screen 日志', () => {
    assert.match(js, /开始筛选：共 \$\{total\} 位候选人/);
    // 注意：句末是全角括号，正则里不能写成 ASCII 转义 \)
    assert.match(js, /恢复筛选：继续评分（已完成 \$\{countProcessedResults\(\)\}\/\$\{results\.length\}）/);
    assert.match(js, /已丢弃未完成筛选任务/);
  });

  it('每个候选人评分后落一条 score 摘要（含档位、分数与命中缓存/模型调用），失败落 err', () => {
    assert.match(js, /cat: 'score',[\s\S]{0,260}评分 \$\{\(item\.app && item\.app\.name\)/);
    assert.match(js, /cat: 'err',[\s\S]{0,200}候选人处理失败：/);
  });

  it('顶层异常路径（启动失败/筛选异常/performScreening 异常）不静默', () => {
    assert.match(js, /启动筛选失败：/);
    assert.match(js, /筛选异常：/);
    assert.match(js, /performScreening 异常：/);
  });

  it('暴露 flushPluginLog 动作：清空前先冲队列，防止清完旧日志复活', () => {
    assert.match(js, /request\.action === 'flushPluginLog'[\s\S]{0,160}flushPluginLog\(\);/);
  });
});

describe('content.js 任务状态守卫（1.6.18 第一批）', () => {
  it('停止/暂停后，在途 worker 的进度心跳不得把终态写回 running', () => {
    // 防的正是：用户点「停止」瞬间仍有 worker 卡在评分 await（最长 120s），
    // 返回后 patchScreeningJob({status:'running'}) 把 stopped/awaiting_resume 覆盖回 running。
    assert.match(js, /function patchScreeningJob\(patch\)[\s\S]{0,1200}patch && patch\.status === 'running' && !isScreening/);
    assert.match(js, /停止\/暂停守卫：会话已结束（isScreening=false）后，在途 worker 的进度心跳/);
    assert.match(js, /delete merged\.status;/);
    assert.match(js, /merged\.status = 'awaiting_resume';/);
    // 续筛/开筛写入 running 前都会先置 isScreening=true，不受此守卫影响
    assert.match(js, /isScreening = true;[\s\S]{0,300}status: 'running',/);
  });
});

describe('content.js 筛选自动补评（1.7.4）', () => {
  it('主轮结束仍有失败项时自动补评一轮（不递归、断点续筛不嵌套）', () => {
    assert.match(js, /if \(!onlyPending && alive\(\)\) \{[\s\S]{0,400}results\.filter\(hasPendingScore\)\.length/);
    assert.match(js, /自动补评：\$\{failedCount\} 位评分失败，再试一轮/);
    // 补评复用同一批次函数、只跑失败项、保持同一 epoch 守卫
    assert.match(js, /scoreResultsBatch\(scoreConfig, weights, hc, keywords, \{ onlyPending: true, epoch \}\)/);
    // 重试纠偏：解析类失败的重试附加 retryAfterParseError
    assert.match(js, /attempt > 0 && last && last\.parseError[\s\S]{0,80}retryAfterParseError: true/);
    assert.match(js, /retryAfterParseError: !!config\.retryAfterParseError/);
  });
});
