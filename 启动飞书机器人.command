#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

PID_FILE="$DIR/feishu-bridge/server.pid"
LOG_FILE="$DIR/feishu-bridge/bridge.log"

# 检测 node 路径
NODE_BIN="$(which node)"
if [ -z "$NODE_BIN" ]; then
  if [ -f "/usr/local/bin/node" ]; then
    NODE_BIN="/usr/local/bin/node"
  elif [ -f "/opt/homebrew/bin/node" ]; then
    NODE_BIN="/opt/homebrew/bin/node"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "❌ 未检测到 Node.js 环境，请先安装 Node.js"
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi

# 检查是否已在运行
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if ps -p "$OLD_PID" > /dev/null 2>&1; then
    echo "========================================================"
    echo "🟢 飞书机器人桥接服务已在后台运行中 (PID: $OLD_PID, 端口: 18888)"
    echo "========================================================"
    echo "💡 提示：该服务已在后台静默常驻，此终端窗口可直接安全关闭。"
    echo "🛑 如需停止，请双击运行「停止飞书机器人.command」"
    echo "========================================================"
    sleep 2
    exit 0
  fi
fi

# 检查 18888 端口是否已被占用
PORT_PID=$(lsof -ti :18888 2>/dev/null)
if [ -n "$PORT_PID" ]; then
  echo "========================================================"
  echo "🟢 端口 18888 已有进程在运行 (PID: $PORT_PID)"
  echo "========================================================"
  echo "$PORT_PID" > "$PID_FILE"
  echo "💡 提示：服务已在后台静默常驻，此终端窗口可直接安全关闭。"
  echo "🛑 如需停止，请双击运行「停止飞书机器人.command」"
  echo "========================================================"
  sleep 2
  exit 0
fi

echo "========================================================"
echo "🚀 正在启动 Moka 飞书机器人桥接服务 (后台静默常驻模式)..."
echo "========================================================"

nohup "$NODE_BIN" "$DIR/feishu-bridge/server.js" > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 1

if ps -p "$NEW_PID" > /dev/null 2>&1; then
  echo "✅ 服务已成功转入 Mac 系统后台运行！"
  echo "   - 进程 PID : $NEW_PID"
  echo "   - 监听端口 : ws://127.0.0.1:18888"
  echo "   - 运行日志 : feishu-bridge/bridge.log"
  echo "========================================================"
  echo "🎉 Chrome 插件现已自动连接！"
  echo "💡 【重要】你现在可以随时【关闭此终端窗口】，服务将持续在后台运行。"
  echo "🛑 若后续需要彻底停止，双击「停止飞书机器人.command」即可。"
  echo "========================================================"
else
  echo "❌ 启动失败，请检查运行日志：$LOG_FILE"
fi

sleep 2
exit 0
