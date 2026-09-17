/**
 * 飞书机器人长连接与 Moka Chrome 插件本地桥接服务 (Bridge)
 *
 * 核心功能：
 * 1. 建立本地 WebSocket 服务 (ws://127.0.0.1:18888)，与 Chrome 插件双向通信；
 * 2. 借助飞书官方 SDK 长连接（WebSocket Client）模式接收飞书群消息（无需公网 IP / 域名穿透）；
 * 3. 接收「批量推荐 50 分以上候选人」等指令并转发至插件，自动执行推进并向群回复卡片；
 * 4. 支持命令行交互（CLI）直接输入测试指令。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const crypto = require('crypto');

// 引入项目的公共飞书协议解析库
const feishuLibPath = path.resolve(__dirname, '../lib/feishu.js');
let MokaFeishu = null;
if (fs.existsSync(feishuLibPath)) {
  try {
    const code = fs.readFileSync(feishuLibPath, 'utf8');
    const sandbox = { module: { exports: {} }, exports: {}, console };
    const fn = new Function('module', 'exports', 'console', code);
    fn(sandbox.module, sandbox.exports, console);
    MokaFeishu = sandbox.module.exports || sandbox.exports;
  } catch (e) {
    console.warn('[Bridge] 加载 lib/feishu.js 失败:', e.message);
  }
}

// 读取配置
let config = {
  appId: '',
  appSecret: '',
  receiver: '',
  wsPort: 18888,
  defaultMinScore: 50,
  defaultBatchLimit: 30
};
const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config = { ...config, ...loaded };
  } catch (e) {
    console.warn('[Bridge] 解析 config.json 失败，使用默认配置:', e.message);
  }
}

// ----------------- WebSocket 连接管理 -----------------
let activePluginSocket = null;
let lastP2pSenderOpenId = '';
let seqCounter = 0;
const pendingRequests = new Map();

function sendToPlugin(action, data = {}) {
  return new Promise((resolve, reject) => {
    if (!activePluginSocket || activePluginSocket.readyState !== 1 /* OPEN */) {
      return reject(new Error('未检测到已连接的 Moka 插件，请确保浏览器已打开 Moka 候选人页面'));
    }
    const seq = ++seqCounter;
    const timeout = setTimeout(() => {
      pendingRequests.delete(seq);
      reject(new Error('插件响应超时（15 秒）'));
    }, 15000);

    pendingRequests.set(seq, { resolve, reject, timeout });
    const payload = JSON.stringify({ seq, action, ...data });

    if (typeof activePluginSocket.send === 'function') {
      activePluginSocket.send(payload);
    } else {
      reject(new Error('无效的 Socket 连接'));
    }
  });
}

// ----------------- 内置轻量级 WebSocket Server (零依赖) -----------------
function createWsServer(port) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Moka Feishu Bridge is running. Connect via WebSocket.');
  });

  server.on('upgrade', (req, socket, head) => {
    // 鉴权：浏览器发起的 WebSocket 必带 Origin 头（WS 不受 CORS 限制），
    // 恶意网页可直连 127.0.0.1 触发批量推进；只放行本扩展与非浏览器本地客户端（无 Origin）
    const origin = req.headers.origin || '';
    if (origin && !origin.startsWith('chrome-extension://')) {
      console.warn(`[Bridge] ⛔ 已拒绝非插件来源的 WebSocket 连接 (Origin: ${origin})`);
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const ws = {
      readyState: 1,
      send: (str) => {
        if (socket.destroyed) return;
        const payload = Buffer.from(str, 'utf8');
        const len = payload.length;
        let header;
        if (len < 126) {
          header = Buffer.from([0x81, len]);
        } else if (len <= 0xffff) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(len, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt(len), 2);
        }
        socket.write(Buffer.concat([header, payload]));
      },
      close: () => socket.end()
    };

    activePluginSocket = ws;
    console.log('\n[Bridge] 🟢 Moka Chrome 插件已连接！');

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const opcode = firstByte & 0x0f;
        const isMasked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (buffer.length < 4) break;
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) break;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }

        const maskSize = isMasked ? 4 : 0;
        if (buffer.length < offset + maskSize + payloadLen) break;

        const mask = isMasked ? buffer.subarray(offset, offset + 4) : null;
        offset += maskSize;
        const payload = buffer.subarray(offset, offset + payloadLen);
        buffer = buffer.subarray(offset + payloadLen);

        if (opcode === 8) { // CLOSE
          socket.end();
          return;
        }
        if (opcode === 1) { // TEXT
          const data = Buffer.alloc(payload.length);
          if (mask) {
            for (let i = 0; i < payload.length; i++) {
              data[i] = payload[i] ^ mask[i % 4];
            }
          } else {
            payload.copy(data);
          }
          const text = data.toString('utf8');
          try {
            const msg = JSON.parse(text);
            if (msg.action === 'updateFeishuAppCredentials') {
              handleUpdateCredentials(msg, ws);
            } else if (msg.action === 'feishuBridgePing') {
              // 插件保活心跳：回 pong 维持双向活性探测
              ws.send(JSON.stringify({ action: 'feishuBridgePong', seq: msg.seq }));
            } else if (msg.action === 'sendFeishuCardViaBridge') {
              handleSendCardViaBridge(msg, ws);
            } else if (msg.seq && pendingRequests.has(msg.seq)) {
              const reqHandler = pendingRequests.get(msg.seq);
              pendingRequests.delete(msg.seq);
              clearTimeout(reqHandler.timeout);
              reqHandler.resolve(msg);
            }
          } catch (e) { /* ignore parse error */ }
        }
      }
    });

    socket.on('close', () => {
      if (activePluginSocket === ws) {
        activePluginSocket = null;
        console.log('[Bridge] ⚪ Moka Chrome 插件断开连接');
      }
    });

    socket.on('error', () => {
      if (activePluginSocket === ws) activePluginSocket = null;
    });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[Bridge] 本地桥接服务已启动：ws://127.0.0.1:${port}`);
  });

  return server;
}

// ----------------- 自建应用凭据热更新与持久化 -----------------
async function handleUpdateCredentials(msg, ws) {
  const appId = String(msg.appId || '').trim();
  const appSecret = String(msg.appSecret || '').trim();
  const receiver = String(msg.receiver || '').trim();

  const changed = config.appId !== appId || config.appSecret !== appSecret;
  config.appId = appId;
  config.appSecret = appSecret;
  if (receiver || msg.receiver === '') {
    config.receiver = receiver;
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[Bridge] 🔑 凭据已持久化至 config.json (App ID: ${appId ? appId.slice(0, 6) + '...' : '(空)'}, 接收者: ${config.receiver || '(未指定)'})`);
  } catch (e) {
    console.warn('[Bridge] 保存 config.json 失败:', e.message);
  }

  if (changed) {
    if (larkWsClient && typeof larkWsClient.close === 'function') {
      try { larkWsClient.close(); } catch (e) { /* ignore */ }
      larkWsClient = null;
    }
    larkClient = null;

    if (appId && appSecret) {
      console.log('[Bridge] 正在热启动飞书官方长连接通道...');
      initFeishuLarkWs().catch((e) => console.warn('[Bridge] 飞书长连接启动失败:', e.message));
    } else {
      console.log('[Bridge] 自建应用凭据已清空，飞书长连接已关闭（已恢复纯 Webhook 模式）');
    }
  }

  if (ws && typeof ws.send === 'function' && msg.seq) {
    ws.send(JSON.stringify({
      seq: msg.seq,
      ok: true,
      appId: appId ? (appId.slice(0, 6) + '...') : ''
    }));
  }
}

// ----------------- 自建应用直接发送卡片到飞书 -----------------
async function handleSendCardViaBridge(msg, ws) {
  const seq = msg.seq;
  try {
    if (!config.appId || !config.appSecret) {
      throw new Error('未配置自建应用 App ID 与 App Secret');
    }
    let lark;
    try {
      lark = require('@larksuiteoapi/node-sdk');
    } catch (e) {
      throw new Error('未安装 @larksuiteoapi/node-sdk');
    }
    if (!larkClient) {
      larkClient = new lark.Client({
        appId: config.appId,
        appSecret: config.appSecret
      });
    }

    // 只用显式配置的接收人；候选人 PII 绝不兜底发给「最近一个私聊机器人的人」
    const target = String(msg.receiver || config.receiver || '').trim();
    if (!target) {
      throw new Error('未配置接收账号，请在插件设置页填入个人企业邮箱 (xxx@meitu.com) 或 Open ID');
    }

    let receive_id_type = 'open_id';
    if (target.includes('@')) {
      receive_id_type = 'email';
    } else if (target.startsWith('oc_')) {
      receive_id_type = 'chat_id';
    } else if (target.startsWith('ou_')) {
      receive_id_type = 'open_id';
    }

    const rawCard = msg.card && (msg.card.card || msg.card);
    const contentStr = typeof rawCard === 'string' ? rawCard : JSON.stringify(rawCard);

    const res = await larkClient.im.message.create({
      params: { receive_id_type },
      data: {
        receive_id: target,
        msg_type: 'interactive',
        content: contentStr
      }
    });

    console.log(`[Bridge] 🚀 卡片已成功直推飞书 (${receive_id_type}: ${target})`);
    if (ws && typeof ws.send === 'function' && seq) {
      ws.send(JSON.stringify({
        seq,
        ok: true,
        messageId: res && res.data && res.data.message_id
      }));
    }
  } catch (err) {
    console.warn('[Bridge] 飞书自建应用推送失败:', err.message);
    if (ws && typeof ws.send === 'function' && seq) {
      ws.send(JSON.stringify({
        seq,
        ok: false,
        error: err.message
      }));
    }
  }
}

// ----------------- 飞书官方 SDK 长连接（免公网穿透） -----------------
let larkClient = null;
let larkWsClient = null;

async function initFeishuLarkWs() {
  if (!config.appId || !config.appSecret || config.appId.includes('xxx')) {
    console.log('[Bridge] ℹ️ 未配置自建应用 appId/appSecret（如需飞书群双向互动，请在设置页填入 App ID 与 Secret）');
    return;
  }

  let lark;
  try {
    lark = require('@larksuiteoapi/node-sdk');
  } catch (e) {
    console.log('[Bridge] ℹ️ 未安装 @larksuiteoapi/node-sdk。若需连接飞书长连接，请在 feishu-bridge 目录下运行 npm install');
    return;
  }

  try {
    larkClient = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret
    });

    larkWsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: lark.LoggerLevel.info
    });

    // 监听消息事件
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const { message } = data;
          if (!message || message.message_type !== 'text') return;
          const contentObj = JSON.parse(message.content);
          const rawText = contentObj.text || '';
          const senderOpenId = (data.sender && data.sender.sender_id && data.sender.sender_id.open_id) || '';
          const isP2p = message.chat_type === 'p2p';
          if (senderOpenId && isP2p) {
            lastP2pSenderOpenId = senderOpenId;
          }

          console.log(`[Bridge] ${isP2p ? '👤 收到个人单聊消息' : '👥 收到群聊消息'}: "${rawText}"`);

          // 使用 parseFeishuCommand 解析指令
          const parsed = MokaFeishu ? MokaFeishu.parseFeishuCommand(rawText) : null;
          if (!parsed || parsed.type === 'unknown') {
            return;
          }

          if (parsed.type === 'recommend_by_score' || parsed.type === 'recommend_by_name') {
            console.log(`[Bridge] 正在下发推荐指令到 Moka 插件 (最低分: ${parsed.minScore}, 姓名: ${parsed.name || '全部'})...`);
            
            let res;
            try {
              res = await sendToPlugin('feishuRecommendByScore', {
                minScore: parsed.minScore,
                name: parsed.name
              });
            } catch (err) {
              res = { ok: false, error: err.message };
            }

            // 组装回执卡片（buildRecommendationResultCard 返回 { msg_type, card } 包壳，
            // 发消息的 content 只能取内层 card，否则飞书会判为非法卡片内容）
            let replyCard;
            if (MokaFeishu) {
              const built = MokaFeishu.buildRecommendationResultCard(res);
              replyCard = (built && built.card) || built;
            }

            // 发回复到飞书
            if (larkClient) {
              await larkClient.im.message.reply({
                path: { message_id: message.message_id },
                data: {
                  content: JSON.stringify(replyCard || {
                    elements: [{ tag: 'div', text: { tag: 'plain_text', content: res.ok ? '推荐已执行' : '推荐失败: ' + res.error } }]
                  }),
                  msg_type: 'interactive'
                }
              });
              console.log('[Bridge] ✅ 推进结果已成功回传飞书！');
            }
          }
        } catch (err) {
          console.error('[Bridge] 处理飞书事件失败:', err);
        }
      },
      'card.action.trigger': async (data) => {
        try {
          const actionVal = (data && data.action && data.action.value) || {};
          console.log('[Bridge] 收到飞书卡片按钮点击事件:', JSON.stringify(actionVal));
          if (actionVal.action === 'feishuRecommendByScore') {
            const minScore = Number(actionVal.minScore) || 50;
            console.log(`[Bridge] 正在向已打开的 Moka 页面下发批量推荐指令 (最低分: ${minScore})...`);
            let res;
            try {
              res = await sendToPlugin('feishuRecommendByScore', {
                minScore,
                mokaUrl: actionVal.mokaUrl || ''
              });
            } catch (err) {
              res = { ok: false, error: err.message };
            }

            if (larkClient) {
              const replyCard = MokaFeishu ? MokaFeishu.buildRecommendationResultCard({
                ...res,
                minScore
              }) : null;
              const senderOpenId = (data && data.operator && data.operator.open_id) || lastP2pSenderOpenId;
              const messageId = (data && data.context && data.context.open_message_id) || '';
              // 回执只发一份：优先回复原卡片所在会话（群里点按钮，结果就落在群里）；
              // 仅当回复失败或拿不到原消息 id 时，才退回私聊点击者（v3.0.5：此前两条路都发，用户会收到重复通知）
              let replied = false;
              if (replyCard && messageId) {
                try {
                  await larkClient.im.message.reply({
                    path: { message_id: messageId },
                    data: { content: JSON.stringify(replyCard.card || replyCard), msg_type: 'interactive' }
                  });
                  replied = true;
                } catch (e) {
                  console.warn('[Bridge] 回执卡回复原会话失败，改发点击者私聊:', e.message);
                }
              }
              if (!replied && senderOpenId && replyCard) {
                await larkClient.im.message.create({
                  params: { receive_id_type: 'open_id' },
                  data: {
                    receive_id: senderOpenId,
                    msg_type: 'interactive',
                    content: JSON.stringify(replyCard.card || replyCard)
                  }
                }).catch(() => {});
              }
            }

            return {
              toast: {
                type: res.ok ? 'success' : 'error',
                content: res.ok
                  ? `已在已打开的 Moka 页面推荐 ${res.count || 0} 位候选人${res.refreshed ? '，页面已刷新' : ''}！`
                  : `推进未完成: ${res.error}`
              }
            };
          }
        } catch (err) {
          console.error('[Bridge] 处理 card.action.trigger 失败:', err);
        }
      }
    });

    await larkWsClient.start({ eventDispatcher });
    console.log('[Bridge] 🚀 飞书官方长连接 (WebSocket) 已建立，已监听群聊指令！');
  } catch (err) {
    console.error('[Bridge] 飞书 SDK 初始化异常:', err.message);
  }
}

// ----------------- 控制台交互 CLI -----------------
function startCli() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('----------------------------------------------------');
  console.log('💡 控制台指令说明：');
  console.log('  输入 "推荐 50 分"   -> 批量推进 50 分及以上候选人');
  console.log('  输入 "推荐 张三"     -> 推进名字包含张三的候选人');
  console.log('  输入 "status"       -> 查看插件连接状态');
  console.log('----------------------------------------------------');

  rl.setPrompt('Moka-Bridge> ');
  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (text === 'status') {
      console.log('插件状态:', activePluginSocket ? '🟢 已连接' : '⚪ 未连接');
      rl.prompt();
      return;
    }

    if (MokaFeishu) {
      const parsed = MokaFeishu.parseFeishuCommand(text);
      if (parsed.type === 'recommend_by_score' || parsed.type === 'recommend_by_name') {
        console.log(`[CLI] 正在下发推荐指令 (最低分: ${parsed.minScore}, 姓名: ${parsed.name || '全部'})...`);
        try {
          const res = await sendToPlugin('feishuRecommendByScore', {
            minScore: parsed.minScore,
            name: parsed.name
          });
          if (res.ok) {
            console.log(`[CLI] ✅ 推荐成功！已推进 ${res.count || 0} 位候选人：${(res.names || []).join('、')}`);
          } else {
            console.log(`[CLI] ❌ 推荐失败: ${res.error}`);
          }
        } catch (e) {
          console.log(`[CLI] ❌ 指令执行失败: ${e.message}`);
        }
      } else {
        console.log('[CLI] 未识别的指令，支持例如："推荐 50 分"、"推荐 张三"');
      }
    }
    rl.prompt();
  });
}

// 启动服务
createWsServer(config.wsPort || 18888);
initFeishuLarkWs();
startCli();
