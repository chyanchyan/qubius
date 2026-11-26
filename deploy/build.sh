#!/bin/bash
# 构建一个 checkout，并把产物原子地切换为 live：
#   server/dist、web/dist 是服务实际读取的目录；构建先写到同级的 .next，
#   成功后再用同文件系统的 rename 切换，旧产物留在 .prev 供回滚。
# 这样构建期间不会清空/覆盖 live，失败时旧产物仍然可用。
#
# 用法：
#   build.sh [仓库目录]             按需安装依赖、staging 构建并切换（默认行为）
#   build.sh --deps <仓库目录>      只按 package-lock 哈希决定是否 npm ci
#   build.sh --stage <仓库目录>     只构建到 *.next，live 完全不动
#   build.sh --swap <仓库目录>      把 *.next 切换为 live，旧 live 备份为 *.prev
#   build.sh --rollback <仓库目录>  删除失败的 live，用 *.prev 恢复
#
# <仓库目录> 缺省为 QUBIUS_REPO_DIR；安装到配置目录后必须显式传入。
# 目录切换依赖同一文件系统内的 mv/rename；Windows 不使用本脚本。
# 任何一步失败都返回非零；staging 失败会清掉本次产生的 .next，live 不受影响。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/lib.sh"
qubius_load

usage() {
  cat >&2 <<'EOF'
用法：
  build.sh [仓库目录]             安装依赖（按需）、staging 构建并原子切换到 live
  build.sh --deps <仓库目录>      只按 package-lock 哈希决定是否安装依赖，不构建
  build.sh --stage <仓库目录>     只构建到 server/dist.next、web/dist.next，不动 live
  build.sh --swap <仓库目录>      把 .next 切换为 live，旧 live 留作 .prev
  build.sh --rollback <仓库目录>  删除失败的 live，用 .prev 恢复
  build.sh --help                 显示本帮助（exit 2）

说明：
  <仓库目录> 缺省为 QUBIUS_REPO_DIR；安装到配置目录后必须显式传入。
  目录切换依靠同一文件系统内的 rename，Windows 不使用本脚本。
EOF
}

MODE=build
case ${1:-} in
  --deps) MODE=deps; shift ;;
  --stage) MODE=stage; shift ;;
  --swap) MODE=swap; shift ;;
  --rollback) MODE=rollback; shift ;;
  --) shift ;;
  --help | -h) usage; exit 2 ;;
  -*) echo "未知参数：$1" >&2; usage; exit 2 ;;
esac

if (( $# > 1 )); then
  echo "参数过多：$*" >&2
  usage
  exit 2
fi

if [[ -n ${1:-} ]]; then
  REPO=$1
else
  REPO=$QUBIUS_REPO_DIR
  [[ -f $REPO/package.json ]] \
    || { echo "用法：$0 [--deps|--stage|--swap|--rollback] <仓库目录>" >&2; exit 2; }
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
install_deps() {
  local hash_file=node_modules/.qubius-lock-hash hash
  hash=$(sha256sum package-lock.json | awk '{print $1}')
  if [[ ! -f $hash_file ]] || [[ $(cat "$hash_file" 2>/dev/null) != "$hash" ]]; then
    echo "安装依赖（package-lock.json 有变化或 node_modules 缺失）"
    npm ci --no-audit --no-fund
    printf '%s\n' "$hash" > "$hash_file"
  fi
}

# 只写 staging 目录，不碰 live。失败时由子 shell 的 EXIT trap 清掉 .next。
stage_build() {
  local server_next=$REPO/server/dist.next
  local web_next=$REPO/web/dist.next
  local tsc=$REPO/node_modules/.bin/tsc
  local vite=$REPO/node_modules/.bin/vite

  [[ -x $tsc ]] || { qubius_warn "缺少 $tsc；先运行 $0 --deps $REPO 安装依赖"; return 1; }
  [[ -x $vite ]] || { qubius_warn "缺少 $vite；先运行 $0 --deps $REPO 安装依赖"; return 1; }

  # dirty 表示构建时工作区有未提交改动，下次 start-all 会因此重新构建，
  # 避免“改了源码但 HEAD 没变”时继续跑旧产物。.next/.prev 是构建自身产生的
  # 目录（仓库 .gitignore 只忽略 dist/），必须从状态里排除，否则每次构建都会
  # 把 dirty 标成 true，导致反复重建。
  local head built_at dirty version
  head=$(git -C "$REPO" rev-parse HEAD)
  built_at=$(date -Is)
  dirty=false
  if [[ -n $(git -C "$REPO" status --porcelain --untracked-files=normal -- \
    server web package.json package-lock.json \
    ':(exclude)server/dist.next' ':(exclude)server/dist.prev' \
    ':(exclude)web/dist.next' ':(exclude)web/dist.prev') ]]; then
    dirty=true
  fi

  # 版本号的唯一来源是仓库根 package.json；只接受 semver 里的安全字符，
  # 避免异常值把 build.json 写坏。读不到时退回 0.0.0，不阻断构建。
  version=$(node -e '
    const fs = require("fs");
    try {
      const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
      if (/^[0-9A-Za-z.+-]+$/.test(version)) process.stdout.write(version);
    } catch {}
  ' "$REPO/package.json")
  version=${version:-0.0.0}

  echo "构建 $REPO（staging）"
  (
    stage_ok=0
    trap 'if [[ ${stage_ok:-0} != 1 ]]; then rm -rf -- "$server_next" "$web_next"; echo "构建失败：已清理未完成的 .next（live 未改动）" >&2; fi' EXIT

    rm -rf -- "$server_next" "$web_next"

    cd "$REPO/server"
    "$tsc" --outDir dist.next

    cd "$REPO/web"
    "$tsc" --noEmit
    "$vite" build --outDir dist.next

    # 用临时文件 + rename，避免并发读到半截 JSON。
    mkdir -p "$server_next"
    tmp=$(mktemp "$server_next/.build.json.XXXXXX")
    printf '{"head":"%s","version":"%s","builtAt":"%s","dirty":%s}\n' \
      "$head" "$version" "$built_at" "$dirty" > "$tmp"
    mv -f "$tmp" "$server_next/build.json"

    stage_ok=1
    echo "已暂存 server/dist.next/build.json：head=$head version=$version builtAt=$built_at dirty=$dirty"
  )
}

# 单个目录的切换：旧 live -> .prev，.next -> live。失败时尽量把自己恢复原状。
# 调用前 swap_dirs 已清掉旧 .prev，这里不再重复删除。
swap_component() {
  local live=$1 prev=$2 next=$3
  [[ -d $next ]] || { qubius_warn "缺少 $next"; return 1; }
  if [[ -e $live ]]; then
    mv -- "$live" "$prev" || return 1
  fi
  if ! mv -- "$next" "$live"; then
    [[ -e $prev ]] && mv -- "$prev" "$live" 2>/dev/null || true
    return 1
  fi
  return 0
}

# 撤销一次已完成的 swap_component，用于 server/web 两头保证“要么都切换，要么都不切”。
undo_component() {
  local live=$1 prev=$2 next=$3
  [[ -e $live ]] && mv -- "$live" "$next" 2>/dev/null || true
  [[ -e $prev ]] && mv -- "$prev" "$live" 2>/dev/null || true
  return 0
}

swap_dirs() {
  local srv_live=$REPO/server/dist srv_prev=$REPO/server/dist.prev srv_next=$REPO/server/dist.next
  local web_live=$REPO/web/dist web_prev=$REPO/web/dist.prev web_next=$REPO/web/dist.next

  # 先确认两边的 staging 都完整，避免半成品被提升为 live。
  [[ -d $srv_next ]] || { qubius_warn "缺少 $srv_next：先运行 $0 --stage $REPO"; return 1; }
  [[ -d $web_next ]] || { qubius_warn "缺少 $web_next：先运行 $0 --stage $REPO"; return 1; }
  [[ -f $srv_next/index.js ]] \
    || { qubius_warn "staging 不完整，缺少 $srv_next/index.js"; return 1; }
  [[ -f $srv_next/build.json ]] \
    || { qubius_warn "staging 不完整，缺少 $srv_next/build.json"; return 1; }
  [[ -f $web_next/index.html ]] \
    || { qubius_warn "staging 不完整，缺少 $web_next/index.html"; return 1; }

  # 旧备份先删；live/next 此时还没动，删失败只损失上一次的 .prev。
  rm -rf -- "$srv_prev" "$web_prev" \
    || { qubius_warn "删除旧 .prev 失败；未做任何切换"; return 1; }

  if ! swap_component "$srv_live" "$srv_prev" "$srv_next"; then
    qubius_warn "切换 server/dist 失败，live 保持原状"
    return 1
  fi
  if ! swap_component "$web_live" "$web_prev" "$web_next"; then
    undo_component "$srv_live" "$srv_prev" "$srv_next"
    qubius_warn "切换 web/dist 失败，已回退 server/dist"
    return 1
  fi
  echo "已切换 server/dist、web/dist（旧产物在 *.prev）"
}

# 回滚：把失败的 live 暂存为临时名，恢复 .prev 成功后再删临时目录；
# 任一步失败就还原，避免出现“两边 live 都缺失”。要求两边都有 .prev。
rollback_dirs() {
  local srv_live=$REPO/server/dist srv_prev=$REPO/server/dist.prev srv_next=$REPO/server/dist.next
  local web_live=$REPO/web/dist web_prev=$REPO/web/dist.prev web_next=$REPO/web/dist.next
  local srv_tmp=$REPO/server/dist.rollback.$$ web_tmp=$REPO/web/dist.rollback.$$

  [[ -d $srv_prev ]] || { qubius_warn "没有 $srv_prev，无法回滚（未找到上一次的构建）"; return 1; }
  [[ -d $web_prev ]] || { qubius_warn "没有 $web_prev，无法回滚（未找到上一次的构建）"; return 1; }

  rm -rf -- "$srv_tmp" "$web_tmp" || { qubius_warn "清理回滚临时目录失败"; return 1; }

  local srv_had_live=0 web_had_live=0
  if [[ -e $srv_live ]]; then
    mv -- "$srv_live" "$srv_tmp" || { qubius_warn "暂存失败的 server/dist 失败，未回滚"; return 1; }
    srv_had_live=1
  fi
  if [[ -e $web_live ]]; then
    if ! mv -- "$web_live" "$web_tmp"; then
      [[ $srv_had_live -eq 1 ]] && mv -- "$srv_tmp" "$srv_live" 2>/dev/null || true
      qubius_warn "暂存失败的 web/dist 失败，未回滚"
      return 1
    fi
    web_had_live=1
  fi

  if ! mv -- "$srv_prev" "$srv_live"; then
    [[ $srv_had_live -eq 1 ]] && mv -- "$srv_tmp" "$srv_live" 2>/dev/null || true
    [[ $web_had_live -eq 1 ]] && mv -- "$web_tmp" "$web_live" 2>/dev/null || true
    qubius_warn "恢复 server/dist 失败，已还原"
    return 1
  fi
  if ! mv -- "$web_prev" "$web_live"; then
    mv -- "$srv_live" "$srv_prev" 2>/dev/null || true
    [[ $srv_had_live -eq 1 ]] && mv -- "$srv_tmp" "$srv_live" 2>/dev/null || true
    [[ $web_had_live -eq 1 ]] && mv -- "$web_tmp" "$web_live" 2>/dev/null || true
    qubius_warn "恢复 web/dist 失败，已回到回滚前状态"
    return 1
  fi

  rm -rf -- "$srv_tmp" "$web_tmp"
  # 清掉残留 staging，避免下次 swap 把旧 .next 提升为 live。
  rm -rf -- "$srv_next" "$web_next"
  echo "已回滚 server/dist、web/dist（来自 *.prev）"
}

case $MODE in
  build)
    install_deps
    stage_build
    swap_dirs
    echo "构建完成：$REPO/server/dist/build.json"
    ;;
  deps) install_deps ;;
  stage) stage_build ;;
  swap) swap_dirs ;;
  rollback) rollback_dirs ;;
esac
