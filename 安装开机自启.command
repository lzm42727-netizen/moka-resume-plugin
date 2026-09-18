#!/bin/bash
# 把飞书机器人 Bridge 注册为 macOS LaunchAgent（开机自启 + 崩溃自动拉起）
# 卸载请双击「取消开机自启.command」
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

LABEL="com.meitu.moka-feishu-bridge"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

echo "========================================================"
echo "🚀 正在安装飞书机器人开机自启 (LaunchAgent)..."
echo "========================================================"

# 检测 node 路径（与 启动.command 同逻辑）
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node ]; then
  NODE_BIN="/usr/local/bin/node"
elif [ -z "$NODE_BIN" ] && [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN="/opt/homebrew/bin/node"
fi
if [ -z "$NODE_BIN" ]; then
  echo "❌ 未检测到 Node.js 环境，请先安装 Node.js"
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi

# 依赖检查：node_modules 缺失会导致长连接不建立（SDK 未安装）
if [ ! -d "$DIR/feishu-bridge/node_modules/@larksuiteoapi" ]; then
  echo "📦 首次安装：正在补装 feishu-bridge 依赖（约半分钟）..."
  (cd "$DIR/feishu-bridge" && npm install --silent) || echo "⚠️ 依赖安装失败，可稍后手动执行: cd feishu-bridge && npm install"
fi

mkdir -p "$HOME/Library/LaunchAgents"

# 若已安装过，先卸载旧实例
launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1

# v3.3.1 日志轮转：bridge.log 超 2MB 归档为 bridge.log.1（只保留一代）
LOG_FILE="$DIR/feishu-bridge/bridge.log"
if [ -f "$LOG_FILE" ] && [ "$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)" -gt 2097152 ]; then
  mv -f "$LOG_FILE" "$LOG_FILE.1"
  echo "🗂 bridge.log 已超 2MB，归档为 bridge.log.1"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${DIR}/feishu-bridge/server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DIR}/feishu-bridge/bridge.log</string>
  <key>StandardErrorPath</key><string>${DIR}/feishu-bridge/bridge.log</string>
  <key>WorkingDirectory</key><string>${DIR}/feishu-bridge</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF

# 停掉手动起的旧进程，避免端口冲突（launchd 随后会拉起托管实例）
PORT_PID=$(lsof -ti :18888 2>/dev/null)
if [ -n "$PORT_PID" ]; then
  kill $PORT_PID 2>/dev/null
  sleep 1
fi

launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null
sleep 2

if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  echo "✅ 安装成功！Bridge 现由 macOS 托管："
  echo "   - 开机自动启动、崩溃/退出自动拉起（KeepAlive）"
  echo "   - 运行日志 : feishu-bridge/bridge.log（每行带时间戳）"
  echo "========================================================"
  echo "💡 说明："
  echo "   - 「停止飞书机器人.command」会自动转为卸载托管（临时停用）"
  echo "   - 「启动飞书机器人.command」会自动转为重新托管拉起"
  echo "   - 彻底移除自启：双击「取消开机自启.command」"
  echo "========================================================"
else
  echo "❌ 安装失败，请检查 $PLIST"
fi

read -n 1 -s -r -p "按任意键退出..."
exit 0
