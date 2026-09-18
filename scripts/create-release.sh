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
node scripts/release-notes.js "$VERSION" > "$NOTES"
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
TOKEN="${GITLAB_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$DIR/.env.local" ]; then
  TOKEN="$(grep -E '^GITLAB_TOKEN=' "$DIR/.env.local" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
fi
if [ -z "$TOKEN" ]; then
  echo "⏭  跳过 GitLab（未设置 GITLAB_TOKEN）"
  echo "   内网发布所需：GitLab → 头像 → 偏好设置 → 访问令牌（Access Tokens）→ 勾选 api 权限 → 生成；"
  echo "   然后 export GITLAB_TOKEN=xxx 再跑一次本脚本（已存在会走更新分支，不会重复建）。"
else
  HOST="https://git.meitu.com"
  PROJECT="meituhr%2Fmoka-resume-plugin"   # URL 编码的 namespace/project
  API="$HOST/api/v4"
  echo "⬆️  上传附件到 GitLab…"
  # GitLab 的 Release 不能直接挂二进制，必须先把文件上传到项目再挂 asset link
  export HOST
  upload() {
    curl -sS --header "PRIVATE-TOKEN: $TOKEN" --form "file=@$1" "$API/projects/$PROJECT/uploads" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.full_path){console.error("上传失败:",s);process.exit(1)}process.stdout.write(process.env.HOST+j.full_path)})'
  }
  FULL_URL="$(upload "$FULL")" || { echo "❌ 完整包上传失败"; exit 1; }
  SLIM_URL="$(upload "$SLIM")" || { echo "❌ 精简包上传失败"; exit 1; }

  DESC="$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");process.stdout.write(s.slice(0,100000))' "$NOTES")"
  PAYLOAD="$(node -e '
    const [name, desc, fullUrl, slimUrl] = process.argv.slice(1);
    console.log(JSON.stringify({
      name,
      tag_name: name,
      description: desc,
      assets: { links: [
        { name: "完整包（推荐，含本地 Bridge）", url: fullUrl, link_type: "package" },
        { name: "精简包（只要插件）", url: slimUrl, link_type: "package" }
      ] }
    }));
  ' "$TAG" "$DESC" "$FULL_URL" "$SLIM_URL")"

  CODE="$(curl -sS -o /tmp/gitlab-release-resp.json -w '%{http_code}' \
    --request POST --header "PRIVATE-TOKEN: $TOKEN" --header 'Content-Type: application/json' \
    --data "$PAYLOAD" "$API/projects/$PROJECT/releases")"
  if [ "$CODE" = "201" ]; then
    echo "✅ GitLab Release 已创建：$HOST/meituhr/moka-resume-plugin/-/releases/$TAG"
  elif [ "$CODE" = "409" ]; then
    echo "ℹ️  GitLab 上已存在该 Release（409），改为更新"
    curl -sS -o /tmp/gitlab-release-resp.json --request PUT \
      --header "PRIVATE-TOKEN: $TOKEN" --header 'Content-Type: application/json' \
      --data "$PAYLOAD" "$API/projects/$PROJECT/releases/$TAG" >/dev/null
    echo "✅ GitLab Release 已更新：$HOST/meituhr/moka-resume-plugin/-/releases/$TAG"
  else
    echo "❌ GitLab 创建失败（HTTP $CODE）：$(cat /tmp/gitlab-release-resp.json)"
    exit 1
  fi
fi

rm -rf "$ALIAS_DIR"
echo "完成。"
