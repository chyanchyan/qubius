#!/bin/bash
# 构建一个 checkout，并写入 build stamp：server/dist/build.json
# 用法：build.sh [仓库目录]（缺省为脚本所在仓库；安装到配置目录后必须显式传仓库目录）
# 任何一步失败都返回非零，不会写入不完整的 build.json。
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
qubius_load

if [[ -n ${1:-} ]]; then
  REPO=$1
else
  REPO=$QUBIUS_REPO_DIR
  [[ -f $REPO/package.json ]] || { echo "用法：$0 <仓库目录>" >&2; exit 2; }
fi

# node 由 lib 统一解析；npm 通常和 node 同目录，所以把它的 bin 目录加到 PATH。
NODE_BIN=$(qubius_resolve_node)
PATH="$(dirname "$NODE_BIN"):$PATH"
export PATH

command -v npm >/dev/null 2>&1 || { echo "找不到 npm，请检查 PATH 或 QUBIUS_NODE_BIN" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "找不到 git" >&2; exit 1; }

[[ -d $REPO ]] || { echo "仓库不存在：$REPO" >&2; exit 1; }
# 支持普通 checkout（.git 目录）和 linked worktree（.git 文件）。
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "不是 git 仓库：$REPO" >&2; exit 1; }

cd "$REPO"

# 手工执行时参与部署页同一把 ops lock；被 install/start-all/作业调用时已有 token，自动跳过。
# 放在 npm ci 之前，避免依赖安装与页面作业并发。
qubius_ops_claim deploy

# package-lock.json 变化或 node_modules 缺失时先安装依赖。
# 不能用 cmp package-lock.json node_modules/.package-lock.json：npm 的隐藏锁文件
# 结构不同，二者永远不相等，会导致每次构建都重装依赖。
LOCK_HASH_FILE=node_modules/.qubius-lock-hash
LOCK_HASH=$(sha256sum package-lock.json | awk '{print $1}')
if [[ ! -f $LOCK_HASH_FILE ]] || [[ $(cat "$LOCK_HASH_FILE" 2>/dev/null) != "$LOCK_HASH" ]]; then
  echo "安装依赖（package-lock.json 有变化或 node_modules 缺失）"
  npm ci --no-audit --no-fund
  printf '%s\n' "$LOCK_HASH" > "$LOCK_HASH_FILE"
fi

echo "构建 $REPO"
npm run build

HEAD=$(git rev-parse HEAD)
BUILT_AT=$(date -Is)
DIRTY=false
if [[ -n $(git status --porcelain --untracked-files=normal -- \
  server web package.json package-lock.json) ]]; then
  DIRTY=true
fi

# 版本号的唯一来源是仓库根 package.json；只接受 semver 里的安全字符，
# 避免异常值把 build.json 写坏。读不到时退回 0.0.0，不阻断构建。
VERSION=$(node -e '
  const fs = require("fs");
  try {
    const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
    if (/^[0-9A-Za-z.+-]+$/.test(version)) process.stdout.write(version);
  } catch {}
' "$REPO/package.json")
VERSION=${VERSION:-0.0.0}

mkdir -p server/dist
TMP=$(mktemp "$REPO/server/dist/.build.json.XXXXXX")
# 用临时文件 + rename，避免并发读到半截 JSON。dirty 表示构建时工作区有未提交改动，
# 下次 start-all 会因此重新构建，避免“改了源码但 HEAD 没变”时继续跑旧产物。
printf '{"head":"%s","version":"%s","builtAt":"%s","dirty":%s}\n' \
  "$HEAD" "$VERSION" "$BUILT_AT" "$DIRTY" > "$TMP"
mv -f "$TMP" server/dist/build.json

echo "已写入 server/dist/build.json：head=$HEAD version=$VERSION builtAt=$BUILT_AT"
