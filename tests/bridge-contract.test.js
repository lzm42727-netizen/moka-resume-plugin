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
  // v3.4.0 拆分后按「原 popup.js 线性顺序」拼接，保住跨窗口的 \s\S 锚点语义
  const bundles = {
    'popup/popup.js': ['popup/popup.js', 'popup/popup-results.js', 'popup/popup-batch.js']
  };
  const files = bundles[rel] || [rel];
  return files.map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
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

  it('v3.0.1 备用 URL 执行链路已整体删除：卡片只走回调，content 不得保留 URL 动作通道', () => {
    const content = source('content.js');
    assert.doesNotMatch(content, /urlActionSnapshot|checkUrlBatchActions|moka_action/, 'content 侧 URL 动作通道已删');
    const feishuLib = source('lib/feishu.js');
    assert.doesNotMatch(feishuLib, /buildBatchActionUrl|moka_action/, 'lib 不得再有备用链接构造');
    assert.doesNotMatch(feishuLib, /备用：新页面执行/, '备用按钮不得回潮');
  });

  it('v3.0.4 飞书批量推进成功后必须联动面板记入「已决策」，不能留在待处理', () => {
    const content = source('content.js');
    assert.match(content, /action: 'feishuBatchRecommended'/, 'content 成功后通知面板');
    assert.match(content, /appIds,\s*\n\s*names/, '消息携带推进的候选人 id 与姓名');
    const popup = source('popup/popup.js');
    assert.match(popup, /request\.action === 'feishuBatchRecommended'/, '面板监听该消息');
    assert.match(popup, /saveCandidateFeedback\(v\.id, 'recommend', v, \{ mokaSynced: true, syncFailed: false \}\)/, '与面板批量推进同款标记口径');
    assert.match(popup, /renderResults\(\);/, '标记后重渲染列表');
  });

  it('v3.0.5 卡片回执只发一份：回复原会话成功后不得再私聊重发', () => {
    const server = source('feishu-bridge/server.js');
    assert.match(server, /let replied = false;/, '回执发送状态标记');
    assert.match(server, /if \(!replied && senderOpenId && replyCard\)/, '私聊副本只作回复失败的兜底');
    assert.doesNotMatch(server, /if \(senderOpenId && replyCard\) \{\s*\n\s*await larkClient\.im\.message\.create/, '不得无条件双发');
  });

  it('v3.0.6 半开死链双向加固：插件 alarms 自愈 + Bridge 死链探测', () => {
    const bg = source('background.js');
    assert.match(bg, /FEISHU_BRIDGE_KEEPALIVE_ALARM = 'feishuBridgeKeepalive'/, 'SW 保活 alarm 存在');
    assert.match(bg, /chrome\.alarms\.create\(FEISHU_BRIDGE_KEEPALIVE_ALARM, \{ periodInMinutes: 0\.5 \}\)/, 'alarm 半分钟一跳，挂起也会被唤醒');
    assert.match(bg, /if \(msg\.action === 'feishuBridgePing'\)/, '插件应答 Bridge 的死链探测 ping');
    const server = source('feishu-bridge/server.js');
    assert.match(server, /lastPluginPongAt/, 'Bridge 记录插件最近 pong 时间');
    assert.match(server, /70000/, '70 秒无 pong 判定死链');
    assert.match(server, /action: 'feishuBridgePing', ts: Date\.now\(\)/, 'Bridge 主动 ping 插件');
    assert.match(server, /插件未在期限内响应/, '下发超时必须落日志可诊断');
  });

  it('v3.0.7 bridge.log 时间戳与链路埋点、LaunchAgent 开机自启脚本就位', () => {
    const server = source('feishu-bridge/server.js');
    assert.match(server, /BRIDGE_LOG_TIME/, '日志时间戳包装器存在');
    assert.match(server, /插件已响应: \$\{JSON\.stringify/, '下发响应必须落日志');
    assert.match(server, /回执已回复原卡片所在会话/, '回执去向落日志');
    assert.match(server, /回执已私聊发送给点击者/, '私聊兜底成功也要落日志');
    const install = source('安装开机自启.command');
    assert.match(install, /com\.meitu\.moka-feishu-bridge/, 'LaunchAgent label');
    assert.match(install, /<key>KeepAlive<\/key><true\/>/, '崩溃自动拉起');
    assert.match(install, /<key>RunAtLoad<\/key><true\/>/, '开机自启');
    assert.match(install, /npm install/, '首次安装自动补装 SDK 依赖');
    const uninstall = source('取消开机自启.command');
    assert.match(uninstall, /launchctl bootout/, '卸载走 bootout');
    assert.match(uninstall, /rm -f "\$PLIST"/, '删除 plist 配置');
  });

  it('v3.0.0 单链路推送：只发绑定的机器人私聊，目标库/Webhook 分流已删且不得回潮', () => {
    const bg = source('background.js');
    assert.match(bg, /async function dispatchFeishuCard\(/, '集中单链路发送');
    assert.match(bg, /sendFeishuAppCard\(\{ appId, appSecret, receiver \}/, '唯一通道：自建应用私聊');
    assert.match(bg, /未配置飞书自建应用（App ID \/ App Secret），无法推送/, '缺凭据明确报错');
    assert.match(bg, /未填写接收人（企业邮箱 \/ Open ID）/, '缺接收人明确报错');
    assert.match(bg, /📨 飞书汇总已推送：机器人私聊（本人）/, '成功日志写明去向');
    assert.match(bg, /addPluginLog\(\{ cat: 'err', text: `飞书汇总推送未完成/, '推送失败必须落运行日志');
    // 多目标 / Webhook 分流不得回潮
    assert.doesNotMatch(bg, /dispatchFeishuCardByTarget|feishuTargets|feishuWebhook|describeFeishuTarget/);
    const lib = source('lib/feishu.js');
    assert.doesNotMatch(lib, /sendFeishuWebhook|resolveFeishuTarget|normalizeFeishuTarget/, 'lib 层 Webhook/目标解析函数已删');
  });

  it('v2.2.0 飞书批量推进复用已打开页面：按卡片职位选标签页 + 执行后刷新 + 回执带对象姓名', () => {
    const bg = source('background.js');
    // 按卡片带回的职位 URL 匹配已打开标签页，匹配不到再退回活动/首个
    // v3.3.0：职位身份优先按 URL query 的 pipelineId 精确匹配（path 匹配降为兜底）
    assert.match(bg, /const hintPath = String\(msg\.mokaUrl \|\| ''\)\.split\('#'\)\[0\]\.split\('\?'\)\[0\]/);
    assert.match(bg, /const pidOf = \(u\) =>/);
    assert.match(bg, /const hintPipeline = pidOf\(String\(msg\.mokaUrl \|\| ''\)\)/);
    assert.match(bg, /const matched = hintPipeline/);
    assert.match(bg, /const matchedByPath = !matched && hintPath/);
    assert.match(bg, /const mokaTab = matched \|\| matchedByPath \|\| \(tabs && tabs\.find\(\(t\) => t\.active\)\) \|\| \(tabs && tabs\[0\]\)/);
    // 聚焦而不是新开页面
    assert.match(bg, /chrome\.tabs\.update\(mokaTab\.id, \{ active: true \}\)/);
    assert.doesNotMatch(bg, /chrome\.tabs\.create\(\{[^}]*app\.mokahr\.com/, '不得新开 Moka 网页');
    // 执行成功后延迟刷新执行页
    assert.match(bg, /setTimeout\(\(\) => \{\s*\n\s*chrome\.tabs\.reload\(execTabId/);
    assert.match(bg, /refreshed = true;/);
    // 回执回传推荐对象姓名
    assert.match(bg, /（页面已刷新）/, '成功日志写明去向与刷新');

    const content = source('content.js');
    assert.match(content, /assignees: resolveAssigneeNamesForDisplay\(\)/, 'content 回传推荐对象姓名');

    const server = source('feishu-bridge/server.js');
    assert.match(server, /mokaUrl: actionVal\.mokaUrl \|\| ''/, 'Bridge 把职位地址透传给插件');
    assert.match(server, /data\.context\.open_message_id/, '优先在原卡片会话里回复结果');
    assert.match(server, /replyCard\.card \|\| replyCard/, 'content 只能取内层 card（外层包壳会被飞书判为非法）');
    assert.match(server, /页面已刷新/, 'toast 反馈刷新状态');
  });
});

describe('Bridge 可测性与安全加固（v3.3.1）', () => {
  it('server.js 可被 require：启动收进 startBridge + require.main 门卫 + 导出内部', () => {
    const server = source('feishu-bridge/server.js');
    assert.match(server, /if \(require\.main === module\) \{\s*\n\s*startBridge\(\);\s*\n\s*\}/,
      '直接运行才启动，require 不再自动监听端口/连飞书/抢 stdin');
    assert.match(server, /function startBridge\(\) \{[\s\S]*?startDeadLinkProbe\(\);[\s\S]*?createWsServer\(/);
    assert.match(server, /module\.exports = \{[\s\S]*?config,/,
      '导出 config/createWsServer/sendToPlugin 等供测试复用');
    // 死链探测定时器收进函数——import 时不挂住测试进程事件循环
    assert.doesNotMatch(server, /^setInterval\(/m, '顶层不得直接 setInterval（收进 startDeadLinkProbe）');
    assert.match(server, /function startDeadLinkProbe\(\) \{[\s\S]*?setInterval\(/);
  });

  it('Origin 精确校验 + bridgeHello 握手：配置 allowedExtensionId 后双重核对', () => {
    const server = source('feishu-bridge/server.js');
    // 未配置时保持旧行为（前缀校验），配置后升级为精确匹配
    assert.match(server, /const expectedExt = String\(config\.allowedExtensionId \|\| ''\)\.trim\(\);/);
    assert.match(server, /if \(expectedExt\) \{[\s\S]*?origin !== 'chrome-extension:\/\/' \+ expectedExt/,
      '配置后 Origin 必须精确等于 chrome-extension://<allowedExtensionId>');
    assert.match(server, /\} else if \(origin && !origin\.startsWith\('chrome-extension:\/\/'\)\) \{/,
      '未配置时保留非插件来源拒绝');
    // 握手：插件上报扩展 ID，不符即断
    assert.match(server, /msg\.action === 'bridgeHello'/);
    assert.match(server, /if \(expectedExt && extId && extId !== expectedExt\) \{[\s\S]*?socket\.destroy\(\)/);
    assert.match(server, /握手扩展 ID 与来源不符/);
    // 示例配置带 allowedExtensionId 字段
    const example = JSON.parse(source('feishu-bridge/config.example.json'));
    assert.ok('allowedExtensionId' in example, 'config.example.json 应带 allowedExtensionId 示例字段');
    // 插件侧：连接成功先握手
    const bg = source('background.js');
    assert.match(bg, /action: 'bridgeHello', extensionId: chrome\.runtime\.id/);
  });

  it('config.json 含 App Secret，落盘权限 0600（启动收紧 + 写入后收紧）', () => {
    const server = source('feishu-bridge/server.js');
    assert.match(server, /if \(\(st\.mode & 0o777\) !== 0o600\) \{[\s\S]*?fs\.chmodSync\(configPath, 0o600\)/,
      '启动时发现权限过松自动收紧');
    assert.match(server, /fs\.writeFileSync\(configPath, JSON\.stringify\(config, null, 2\), 'utf8'\);\s*\n\s*try \{ fs\.chmodSync\(configPath, 0o600\); \} catch \(e\) \{ \/\* ignore \*\/ \}/,
      '凭据持久化写入后必须 chmod 0600');
    // 本地真实配置文件如果存在，权限必须已经是 0600
    const realConfig = path.join(__dirname, '..', 'feishu-bridge', 'config.json');
    if (fs.existsSync(realConfig)) {
      const mode = fs.statSync(realConfig).mode & 0o777;
      assert.equal(mode, 0o600, '本地 config.json 权限必须是 0600（当前 ' + mode.toString(8) + '）');
    }
  });

  it('回执两条路都失败时重试一次私聊（防飞书限流导致推进成功但无通知）', () => {
    const server = source('feishu-bridge/server.js');
    assert.match(server, /const sendPrivateReceipt = \(\) => larkClient\.im\.message\.create\(/);
    assert.match(server, /回执私聊兜底失败，3 秒后重试一次/);
    assert.match(server, /重试后回执已私聊发送给点击者/);
    assert.match(server, /回执私聊兜底重试仍失败/);
  });

  it('bridge.log 轮转：启动与自启安装脚本都做 2MB 归档（launchd 持有 FD，只能脚本轮转）', () => {
    const start = source('启动飞书机器人.command');
    const install = source('安装开机自启.command');
    const rotate = /-gt 2097152 \]; then\s*\n\s*mv -f "\$LOG_FILE" "\$LOG_FILE\.1"/;
    assert.match(start, rotate, '手动启动脚本超 2MB 归档');
    assert.match(install, rotate, '自启安装脚本超 2MB 归档');
  });
});
