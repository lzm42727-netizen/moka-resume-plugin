#!/bin/bash
# 取消飞书机器人 Bridge 的开机自启（卸载 LaunchAgent 并删除配置）
LABEL="com.meitu.moka-feishu-bridge"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

echo "========================================================"
echo "🧹 正在取消飞书机器人开机自启..."
echo "========================================================"

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1
rm -f "$PLIST"

# 兜底：若进程仍在占用端口（bootout 失败的残留），直接停掉
PORT_PID=$(lsof -ti :18888 2>/dev/null)
if [ -n "$PORT_PID" ]; then
  kill $PORT_PID 2>/dev/null
fi

if [ ! -f "$PLIST" ]; then
  echo "✅ 已取消开机自启，LaunchAgent 配置已移除。"
  echo "💡 之后需要 Bridge 时，双击「启动飞书机器人.command」手动启动即可。"
else
  echo "⚠️ 配置文件未能删除：$PLIST（可手动删除后重试）"
fi

echo "========================================================"
sleep 2
exit 0
