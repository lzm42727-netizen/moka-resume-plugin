#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

PID_FILE="$DIR/feishu-bridge/server.pid"
LABEL="com.meitu.moka-feishu-bridge"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

# LaunchAgent 托管中：卸载托管（本次登录内不再自动拉起），再兜底停进程
if [ -f "$PLIST" ]; then
  echo "========================================================"
  echo "🛑 Bridge 由 macOS LaunchAgent 托管，正在卸载托管并停止..."
  echo "========================================================"
  launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1
  sleep 1
  PORT_PID=$(lsof -ti :18888 2>/dev/null)
  if [ -n "$PORT_PID" ]; then
    kill $PORT_PID 2>/dev/null
  fi
  echo "✅ 已卸载托管并停止 Bridge（开机自启配置文件保留：$PLIST）。"
  echo "💡 再次启动：双击「启动飞书机器人.command」（将重新托管拉起）。"
  echo "💡 彻底移除自启：双击「取消开机自启.command」。"
  echo "========================================================"
  sleep 2
  exit 0
fi

echo "========================================================"
echo "🛑 正在停止 Moka 飞书机器人桥接服务..."
echo "========================================================"

STOPPED=0

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if ps -p "$PID" > /dev/null 2>&1; then
    kill "$PID" 2>/dev/null
    STOPPED=1
  fi
  rm -f "$PID_FILE"
fi

PORT_PID=$(lsof -ti :18888 2>/dev/null)
if [ -n "$PORT_PID" ]; then
  kill -9 $PORT_PID 2>/dev/null
  STOPPED=1
fi

if [ $STOPPED -eq 1 ]; then
  echo "✅ 飞书机器人服务已成功停止，18888 端口已释放。"
  echo "💡 Chrome 插件设置页状态将显示为「⚪ 未连接」。"
else
  echo "⚪ 未检测到正在运行的飞书机器人服务 (18888 端口未被占用)。"
fi

echo "========================================================"
sleep 2
exit 0
