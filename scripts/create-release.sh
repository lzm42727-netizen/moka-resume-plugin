#!/bin/bash
# 把一个已发布的版本做成「可下载的 Release」：说明从 CHANGELOG 抽，附件上传两套命名——
#   moka-resume-plugin-vX.Y.Z[-full].zip   ← 带版本号，存档用
#   moka-resume-plugin-latest[-full].zip   ← 固定名，让 releases/latest/download/... 链接永久有效
#
# 用法: bash scripts/create-release.sh 3.6.3
# 前置: ① 已 npm run pack && npm run pack:full
#       ② tag vX.Y.Z 已推到远端（本脚本不推代码）
# GitLab: 设了 GITLAB_TOKEN（需 api 权限）才执行；可放环境变量，或写进 .env.local（已在 .gitignore）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "用法: bash scripts/create-release.sh <版本号>   例: bash scripts/create-release.sh 3.6.3"
  exit 1
fi
TAG="v$VERSION"
SLIM="dist/moka-resume-plugin-$TAG.zip"
FULL="dist/moka-resume-plugin-$TAG-full.zip"

# ---------- 前置校验：宁可早失败，也不要发出半截 Release ----------
MANIFEST_VERSION="$(node -p "require('./manifest.json').version")"
if [ "$MANIFEST_VERSION" != "$VERSION" ]; then
  echo "❌ manifest.json 是 $MANIFEST_VERSION，与要发布的 $VERSION 不一致"
  exit 1
fi
for f in "$SLIM" "$FULL"; do
  if [ ! -f "$f" ]; then
    echo "❌ 缺 $f —— 先跑 npm run pack && npm run pack:full"
    exit 1
  fi
done
if ! git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "❌ 本地没有 tag $TAG"
  exit 1
fi

# 工作区里的 zip 必须与已提交内容一致：发布物来自脏工作区是排查噩梦
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  工作区有未提交改动，确认这些 zip 就是你要发的（继续…）"
fi

# ---------- 生成说明 ----------
NOTES="$(mktemp -t moka-release-notes-XXXXXX).md"
GH_BASE="$(git remote get-url origin 2>/dev/null | sed -E 's#^git@([^:]+):#https://\1/#; s#\.git$##')"
GL_BASE="$(git remote get-url gitlab 2>/dev/null | sed -E 's#^git@([^:]+):#https://\1/#; s#\.git$##')"
node scripts/release-notes.js "$VERSION" "$GH_BASE" "$GL_BASE" > "$NOTES"
echo "📝 Release 说明已生成（$(wc -c < "$NOTES" | tr -d ' ') 字符）"

# ---------- 固定名副本 ----------
ALIAS_DIR="$(mktemp -d)"
cp "$FULL" "$ALIAS_DIR/moka-resume-plugin-latest-full.zip"
cp "$SLIM" "$ALIAS_DIR/moka-resume-plugin-latest.zip"

# ---------- GitHub ----------
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "ℹ️  GitHub 上 $TAG 的 Release 已存在，改为更新说明并补传附件"
    gh release edit "$TAG" --notes-file "$NOTES"
    gh release upload "$TAG" "$SLIM" "$FULL" \
      "$ALIAS_DIR/moka-resume-plugin-latest-full.zip" \
      "$ALIAS_DIR/moka-resume-plugin-latest.zip" --clobber
  else
    gh release create "$TAG" \
      --title "$TAG" \
      --notes-file "$NOTES" \
      "$SLIM" "$FULL" \
      "$ALIAS_DIR/moka-resume-plugin-latest-full.zip" \
      "$ALIAS_DIR/moka-resume-plugin-latest.zip"
  fi
  echo "✅ GitHub Release: $(gh release view "$TAG" --json url --jq .url)"
else
  echo "⏭  跳过 GitHub（未安装 gh 或未登录）"
fi

# ---------- GitLab（内网）----------
# 上传 + 挂附件 + 固定链接（permalink）都归 scripts/gitlab-release.js；
# 无 GITLAB_TOKEN 时它自己打印「跳过」并以 0 退出，不会让本脚本失败。
node scripts/gitlab-release.js "$VERSION" --notes "$NOTES"

rm -rf "$ALIAS_DIR"
echo "完成。"
