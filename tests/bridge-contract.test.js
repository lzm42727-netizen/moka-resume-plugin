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
