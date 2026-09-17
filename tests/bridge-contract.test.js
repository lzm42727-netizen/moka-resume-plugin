const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ACTIONS,
  BRIDGE_UP,
  BRIDGE_DOWN,
  BRIDGE_SOURCE_INJECT,
  BRIDGE_SOURCE_CONTENT
} = require('../lib/contracts.js');

function source(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('契约收口（1.6.20）', () => {
  it('flushPluginLog 已登记进 ACTIONS，且 popup 发送 / content 处理成对存在', () => {
    assert.ok(Object.values(ACTIONS).includes('flushPluginLog'), 'ACTIONS 应登记 flushPluginLog');
    const popup = source('popup/popup.js');
    const content = source('content.js');
    assert.match(popup, /action: 'flushPluginLog'/, 'popup 发送 flushPluginLog');
    assert.match(content, /request\.action === 'flushPluginLog'/, 'content 处理 flushPluginLog');
  });

  it('BRIDGE_UP 每个类型：inject 有上行 post，content 有对应消费分支', () => {
    const inject = source('inject.js');
    const content = source('content.js');
    const keys = Object.keys(BRIDGE_UP);
    assert.ok(keys.length >= 8, 'BRIDGE_UP 应登记主要上行类型');
    for (const key of keys) {
      const t = BRIDGE_UP[key];
      assert.match(inject, new RegExp(`post\\('${t}'`), `inject 应上行 ${t}`);
      assert.match(
        content,
        new RegExp(`data\\.type (?:===|!==) '${t}'`),
        `content 应消费 ${t}`
      );
    }
  });

  it('BRIDGE_DOWN 每个类型：content 有下行 post，inject 有对应处理', () => {
    const inject = source('inject.js');
    const content = source('content.js');
    const keys = Object.keys(BRIDGE_DOWN);
    assert.ok(keys.length >= 4, 'BRIDGE_DOWN 应登记主要下行类型');
    for (const key of keys) {
      const t = BRIDGE_DOWN[key];
      assert.match(content, new RegExp(`type: '${t}'`), `content 应下行 ${t}`);
      assert.match(inject, new RegExp(`data\\.type (?:===|!==) '${t}'`), `inject 应处理 ${t}`);
    }
  });

  it('桥接 source 标识两侧对称', () => {
    const inject = source('inject.js');
    const content = source('content.js');
    assert.match(inject, new RegExp(`source: '${BRIDGE_SOURCE_INJECT}'`));
    assert.match(content, new RegExp(`data\\.source !== '${BRIDGE_SOURCE_INJECT}'`));
    assert.match(content, new RegExp(`source: '${BRIDGE_SOURCE_CONTENT}'`));
    assert.match(inject, new RegExp(`data\\.source !== '${BRIDGE_SOURCE_CONTENT}'`));
  });

  it('content 侧 4 个兼容动作仍登记且仍被处理（popup 已不再发送）', () => {
    const content = source('content.js');
    for (const a of ['hasLastResults', 'showLastResults', 'getRequestLog', 'getBatchAssignContext']) {
      assert.ok(Object.values(ACTIONS).includes(a), `${a} 仍在 ACTIONS 内`);
      assert.match(content, new RegExp(`request\\.action === '${a}'`), `content 仍处理 ${a}`);
    }
  });

  it('XHR load 监听具名 + 触发自移除（P2-6）：同实例复用 send 不累积监听', () => {
    const inject = source('inject.js');
    assert.match(inject, /const onLoad = function \(\) \{\s*\n\s*this\.removeEventListener\('load', onLoad\);/);
    assert.match(inject, /this\.addEventListener\('load', onLoad\);/);
  });

  it('P1-9 nonce 握手：inject 回带 nonce，content 确认后只采信带正确 nonce 的消息', () => {
    const inject = source('inject.js');
    const content = source('content.js');
    // inject：记录 nonce，上行 post 统一附带
    assert.match(inject, /let bridgeNonce = ''/);
    assert.match(inject, /if \(bridgeNonce\) msg\.nonce = bridgeNonce;/);
    assert.match(inject, /data\.type === 'bridge-init'[\s\S]{0,200}post\('bridge-ready'/);
    // content：握手下发 + 确认后 gate
    assert.match(content, /type: 'bridge-init', payload: \{ nonce: bridgeNonceValue\(\) \}/);
    assert.match(content, /function bridgeMessageAccepted\(data\)/);
    assert.match(content, /if \(!bridgeMessageAccepted\(data\)\) return;/);
    assert.match(content, /data\.type === 'bridge-ready'[\s\S]{0,160}bridgeNonceConfirmed = true/);
  });
});

describe('飞书 Bridge 加固契约（2.0.1）', () => {
  it('background 心跳：onopen 启动、onclose/断开/重建时停止，20 秒发送 feishuBridgePing', () => {
    const bg = source('background.js');
    assert.match(bg, /const FEISHU_HEARTBEAT_MS = 20000/);
    assert.match(bg, /action: 'feishuBridgePing'/);
    assert.match(bg, /feishuBridgeWs\.onopen[\s\S]{0,200}startFeishuHeartbeat\(\)/, '连接成功应启动心跳保活');
    assert.match(bg, /feishuBridgeWs\.onclose = \(\) => \{[\s\S]{0,200}stopFeishuHeartbeat\(\)/, '断开应停止心跳');
    assert.match(bg, /function disconnectFeishuBridge\(\) \{[\s\S]{0,200}stopFeishuHeartbeat\(\)/, '主动断开应停止心跳');
    assert.match(bg, /if \(feishuBridgeWs\) \{\s*\n\s*stopFeishuHeartbeat\(\);/, '重建连接前应先停旧心跳');
  });

  it('Bridge 侧应答 feishuBridgePong 心跳', () => {
    const server = source('feishu-bridge/server.js');
    assert.match(server, /msg\.action === 'feishuBridgePing'/);
    assert.match(server, /action: 'feishuBridgePong'/);
  });

  it('Bridge WebSocket 握手校验 Origin 白名单（仅 chrome-extension:// 或无 Origin 本地客户端）', () => {
    const server = source('feishu-bridge/server.js');
    assert.match(server, /req\.headers\.origin/);
    assert.match(server, /startsWith\('chrome-extension:\/\/'\)/, 'Origin 白名单只放行插件来源');
    assert.match(server, /socket\.destroy\(\);/, '非白名单来源直接断开');
  });

  it('卡片直推不再兜底 lastP2pSenderOpenId（候选人 PII 防误发）', () => {
    const server = source('feishu-bridge/server.js');
    assert.doesNotMatch(
      server,
      /String\(msg\.receiver \|\| config\.receiver \|\| lastP2pSenderOpenId/,
      '直推接收人不得回退到最近私聊发送者'
    );
  });

  it('一键批量推进双通道触发：document_start 快照 + query/hash 双解析（v2.0.2 SPA hash 竞态回归）', () => {
    const content = source('content.js');
    assert.match(content, /let urlActionSnapshot = \{/, 'document_start 顶层应快照触发参数');
    assert.match(content, /search\.includes\('moka_action=batch_recommend'\)/, 'query 通道必须存在');
    assert.match(content, /hash\.includes\('moka_action=batch_recommend'\)/, 'hash 通道保留兼容');
    assert.match(content, /urlActionSnapshot = null;/, '快照消费后置空防重复触发');
    const feishuLib = source('lib/feishu.js');
    assert.doesNotMatch(feishuLib, /#moka_action=/, '卡片按钮 URL 不得把动作参数放 hash');
    assert.match(feishuLib, /moka_action=batch_recommend&min_score=50/, '动作参数放 query 段');
  });

  it('v2.1.0 推送目标按类型分流：个人走自建应用、群走 Webhook，配置不全明确报错', () => {
    const bg = source('background.js');
    assert.match(bg, /async function dispatchFeishuCardByTarget\(/, '应集中按目标类型分流');
    assert.match(bg, /target\.type === 'user'/, '个人类型目标走自建应用直推');
    assert.match(bg, /本轮未推送（不会改发其他渠道）/, '配置不全时必须明确报错而非静默改道');
    assert.match(bg, /所选推送目标（\$\{targetId\}）已不存在/, '目标被删要提示重新选择');
    assert.match(bg, /addPluginLog\(\{ cat: 'err', text: `飞书汇总推送未完成/, '推送失败必须落运行日志');
    assert.match(bg, /function describeFeishuTarget\(/, '卡片需写明本轮去向');
    // 旧的「有自建应用就一律发单聊」分支不得复活
    assert.doesNotMatch(bg, /hasAppCreds && \(!targetRes \|\| !targetRes\.webhook\)/);
  });
});
