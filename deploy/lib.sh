#!/bin/bash
# qubius 部署共享库。所有部署脚本 source 本文件后调用 qubius_load。
#
# 变量优先级（从高到低）：
#   1. 调用者显式导出的环境变量，例如 `QUBIUS_SECONDARY=1 ./deploy/run.sh`
#   2. env 文件：$QUBIUS_ENV、$QUBIUS_CONFIG_DIR/env、<仓库>/deploy/env（取第一个存在的）
#   3. 本文件里的默认值
#
# 角色开关只有一个：QUBIUS_SECONDARY=0（主实例 qubius）/ 1（副实例 co-qubius）。
set -euo pipefail

qubius_die() { printf 'qubius: %s\n' "$*" >&2; exit 1; }
qubius_warn() { printf 'qubius: %s\n' "$*" >&2; }
qubius_info() { printf '%s\n' "$*" >&2; }

# env 文件里的相对路径不解析，所有路径都应写绝对路径或使用 $HOME。

qubius_repo_root() {
  if [[ -n ${QUBIUS_REPO_DIR:-} ]]; then
    # 目录不存在时保留原路径，让调用方报出具体路径，而不是空串加一串 cd 噪音。
    (cd "$QUBIUS_REPO_DIR" 2>/dev/null && pwd) || printf '%s\n' "$QUBIUS_REPO_DIR"
    return 0
  fi
  # lib.sh 位于 <repo>/deploy/lib.sh。
  (cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" && pwd)
}

qubius_default_config_dir() {
  printf '%s\n' "${XDG_CONFIG_HOME:-${HOME}/.config}/qubius"
}

qubius_env_file() {
  if [[ -n ${QUBIUS_ENV:-} ]]; then
    # 与 server 侧 deploy-env 一致：QUBIUS_ENV 的相对路径按 repoRoot 解析，
    # 保证 QUBIUS_ENV_FILE 始终是绝对路径（@reboot 等不同 cwd 下也不会解析错）。
    if [[ $QUBIUS_ENV == /* ]]; then
      printf '%s\n' "$QUBIUS_ENV"
    else
      printf '%s/%s\n' "$(qubius_repo_root)" "$QUBIUS_ENV"
    fi
    return 0
  fi
  local cfg
  cfg=${QUBIUS_CONFIG_DIR:-$(qubius_default_config_dir)}
  if [[ -f $cfg/env ]]; then
    printf '%s\n' "$cfg/env"
    return 0
  fi
  local root
  root=$(qubius_repo_root)
  if [[ -f $root/deploy/env ]]; then
    printf '%s\n' "$root/deploy/env"
    return 0
  fi
  printf '\n'
}

qubius_bool() {
  local value=${1:-} default=${2:-0}
  if [[ -z $value ]]; then
    printf '%s\n' "$default"
    return 0
  fi
  case ${value,,} in
    1 | true | yes | on) printf '1\n' ;;
    0 | false | no | off) printf '0\n' ;;
    *) qubius_die "布尔值无效：$value（用 0/1）" ;;
  esac
}

qubius_port() {
  local value=${1:-}
  [[ $value =~ ^[0-9]+$ ]] || qubius_die "端口无效：$value"
  (( value >= 1 && value <= 65535 )) || qubius_die "端口越界：$value"
  printf '%s\n' "$value"
}

# 读取 env 文件，但保留调用者已经导出的 QUBIUS_* 变量。
qubius_load_env() {
  local file saved=() name kv
  file=$(qubius_env_file)
  while IFS= read -r name; do
    saved+=("$name=${!name}")
  done < <(compgen -v QUBIUS_ || true)
  if [[ -n $file ]]; then
    [[ -f $file ]] || qubius_die "env 文件不存在：$file"
    # shellcheck disable=SC1090
    source "$file"
  fi
  for kv in "${saved[@]}"; do
    export "$kv"
  done
}

qubius_apply_defaults() {
  QUBIUS_USER=${QUBIUS_USER:-$(id -un)}
  QUBIUS_HOME=${QUBIUS_HOME:-$HOME}
  QUBIUS_CONFIG_DIR=${QUBIUS_CONFIG_DIR:-$(qubius_default_config_dir)}
  QUBIUS_PRIMARY_DIR=${QUBIUS_PRIMARY_DIR:-$QUBIUS_HOME/qubius}
  QUBIUS_SECONDARY_DIR=${QUBIUS_SECONDARY_DIR:-$QUBIUS_HOME/co-qubius}
  QUBIUS_DATA_PRIMARY=${QUBIUS_DATA_PRIMARY:-${XDG_DATA_HOME:-$QUBIUS_HOME/.local/share}/qubius}
  QUBIUS_DATA_SECONDARY=${QUBIUS_DATA_SECONDARY:-${XDG_DATA_HOME:-$QUBIUS_HOME/.local/share}/co-qubius}
  QUBIUS_PRIMARY_PORT=$(qubius_port "${QUBIUS_PRIMARY_PORT:-8787}")
  QUBIUS_SECONDARY_PORT=$(qubius_port "${QUBIUS_SECONDARY_PORT:-8788}")
  QUBIUS_PRIMARY_REF=${QUBIUS_PRIMARY_REF:-main}
  QUBIUS_PUBLIC_HOST=${QUBIUS_PUBLIC_HOST:-code.example.com}
  QUBIUS_PUBLIC_HOST_SECONDARY=${QUBIUS_PUBLIC_HOST_SECONDARY:-code-bak.example.com}
  QUBIUS_PRIMARY_REPO_URL=${QUBIUS_PRIMARY_REPO_URL:-http://gitea.example.com/example/qubius.git}
  # 两个实例共用同一个仓库；副实例只是另一份 checkout。
  QUBIUS_SECONDARY_REPO_URL=${QUBIUS_SECONDARY_REPO_URL:-$QUBIUS_PRIMARY_REPO_URL}
  QUBIUS_SECONDARY=$(qubius_bool "${QUBIUS_SECONDARY:-0}")
  QUBIUS_REPO_DIR=$(qubius_repo_root)

  # 可选项：留空表示不启用。
  QUBIUS_LAN_HOST=${QUBIUS_LAN_HOST:-}
  QUBIUS_ARCHIVE_DIR=${QUBIUS_ARCHIVE_DIR:-}
  QUBIUS_ARCHIVE_RETENTION_DAYS=${QUBIUS_ARCHIVE_RETENTION_DAYS:-30}
  QUBIUS_MAX_CONCURRENT=${QUBIUS_MAX_CONCURRENT:-4}
  QUBIUS_PROJECTS_FILE=${QUBIUS_PROJECTS_FILE:-}
  QUBIUS_START_PRIMARY=$(qubius_bool "${QUBIUS_START_PRIMARY:-1}" 1)
  QUBIUS_START_SECONDARY=$(qubius_bool "${QUBIUS_START_SECONDARY:-1}" 1)
  # start-all 是否启动/重启局域网入口（lan-proxy）；只做本机部署时设为 0。
  QUBIUS_START_LAN=$(qubius_bool "${QUBIUS_START_LAN:-1}" 1)
  QUBIUS_CLONE_PEER=$(qubius_bool "${QUBIUS_CLONE_PEER:-0}")
  QUBIUS_GITEA_URL=${QUBIUS_GITEA_URL:-http://gitea.example.com}
  QUBIUS_GITEA_OWNER=${QUBIUS_GITEA_OWNER:-example}
  QUBIUS_GITEA_TOKEN=${QUBIUS_GITEA_TOKEN:-}
  QUBIUS_NODE_BIN=${QUBIUS_NODE_BIN:-}

  [[ $QUBIUS_ARCHIVE_RETENTION_DAYS =~ ^[0-9]+$ ]] \
    || qubius_die "QUBIUS_ARCHIVE_RETENTION_DAYS 必须是整数"
  [[ $QUBIUS_MAX_CONCURRENT =~ ^[0-9]+$ ]] \
    || qubius_die "QUBIUS_MAX_CONCURRENT 必须是整数"

  local name
  for name in QUBIUS_USER QUBIUS_HOME QUBIUS_CONFIG_DIR QUBIUS_PRIMARY_DIR QUBIUS_SECONDARY_DIR \
    QUBIUS_DATA_PRIMARY QUBIUS_DATA_SECONDARY QUBIUS_PRIMARY_PORT QUBIUS_SECONDARY_PORT \
    QUBIUS_PRIMARY_REF QUBIUS_PUBLIC_HOST QUBIUS_PUBLIC_HOST_SECONDARY \
    QUBIUS_PRIMARY_REPO_URL QUBIUS_SECONDARY_REPO_URL QUBIUS_SECONDARY QUBIUS_REPO_DIR \
    QUBIUS_LAN_HOST QUBIUS_ARCHIVE_DIR QUBIUS_ARCHIVE_RETENTION_DAYS QUBIUS_MAX_CONCURRENT \
    QUBIUS_PROJECTS_FILE QUBIUS_START_PRIMARY QUBIUS_START_SECONDARY QUBIUS_START_LAN QUBIUS_CLONE_PEER \
    QUBIUS_GITEA_URL QUBIUS_GITEA_OWNER QUBIUS_GITEA_TOKEN QUBIUS_NODE_BIN \
    QUBIUS_AUTH QUBIUS_AUTH_TOKEN QUBIUS_VAPID_SUBJECT; do
    export "$name"
  done
}

# 根据唯一的角色开关派生实例相关变量。
qubius_derive() {
  if [[ $QUBIUS_SECONDARY == 1 ]]; then
    QUBIUS_ROLE=secondary
    QUBIUS_INSTANCE=co-qubius
    QUBIUS_DATA_DIR=$QUBIUS_DATA_SECONDARY
    QUBIUS_PORT=$QUBIUS_SECONDARY_PORT
    QUBIUS_PUBLIC_HOST_ACTIVE=$QUBIUS_PUBLIC_HOST_SECONDARY
    QUBIUS_CONFIG_FILE=$QUBIUS_CONFIG_DIR/config-secondary.yaml
    QUBIUS_SERVICE=co-qubius.service
    QUBIUS_PROXY_SERVICE=co-qubius-proxy.service
    QUBIUS_PEER_DIR=$QUBIUS_PRIMARY_DIR
    QUBIUS_PEER_ROLE=primary
  else
    QUBIUS_ROLE=primary
    QUBIUS_INSTANCE=qubius
    QUBIUS_DATA_DIR=$QUBIUS_DATA_PRIMARY
    QUBIUS_PORT=$QUBIUS_PRIMARY_PORT
    QUBIUS_PUBLIC_HOST_ACTIVE=$QUBIUS_PUBLIC_HOST
    QUBIUS_CONFIG_FILE=$QUBIUS_CONFIG_DIR/config.yaml
    QUBIUS_SERVICE=qubius.service
    QUBIUS_PROXY_SERVICE=qubius-proxy.service
    QUBIUS_PEER_DIR=$QUBIUS_SECONDARY_DIR
    QUBIUS_PEER_ROLE=secondary
  fi
  QUBIUS_DEPLOY_LOCK=${QUBIUS_DEPLOY_LOCK:-$QUBIUS_DATA_PRIMARY/deploy.lock}
  QUBIUS_STATUS_FILE=$QUBIUS_DATA_DIR/secondary.json
  QUBIUS_SECONDARY_LOG=$QUBIUS_DATA_DIR/secondary.log
  QUBIUS_SERVER_LOG=$QUBIUS_DATA_DIR/qubius.log

  local name
  for name in QUBIUS_ROLE QUBIUS_INSTANCE QUBIUS_DATA_DIR QUBIUS_PORT QUBIUS_PUBLIC_HOST_ACTIVE \
    QUBIUS_CONFIG_FILE QUBIUS_SERVICE QUBIUS_PROXY_SERVICE QUBIUS_PEER_DIR QUBIUS_PEER_ROLE \
    QUBIUS_DEPLOY_LOCK QUBIUS_STATUS_FILE QUBIUS_SECONDARY_LOG QUBIUS_SERVER_LOG; do
    export "$name"
  done
}

qubius_resolve_node() {
  local cand major
  if [[ -n ${QUBIUS_NODE_BIN:-} ]]; then
    cand=$QUBIUS_NODE_BIN
    [[ -x $cand ]] || qubius_die "QUBIUS_NODE_BIN 不可执行：$cand"
    major=$("$cand" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null) \
      || qubius_die "无法运行 node：$cand"
    [[ $major =~ ^[0-9]+$ ]] && (( major >= 22 )) \
      || qubius_die "QUBIUS_NODE_BIN 需要 Node.js >= 22：$cand"
    printf '%s\n' "$cand"
    return 0
  fi
  for cand in "$(command -v node 2>/dev/null || true)" \
    $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null || true); do
    [[ -n $cand && -x $cand ]] || continue
    major=$("$cand" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null) || continue
    if [[ $major =~ ^[0-9]+$ ]] && (( major >= 22 )); then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  qubius_die "找不到 Node.js >= 22；请设置 QUBIUS_NODE_BIN"
}

# 加载 env、默认值和派生变量。脚本在 source 之后调用一次。
qubius_load() {
  qubius_load_env
  qubius_apply_defaults
  qubius_derive
  # 记录本次实际使用的 env 文件（可能为空），供 start-all 传给 server 进程。
  QUBIUS_ENV_FILE=$(qubius_env_file)
  export QUBIUS_ENV_FILE
}

# ── ops lock：手工执行的 install/build/start-all 也参与部署页同一把锁 ─────────
# 被页面作业调用时环境里已有 QUBIUS_OPS_TOKEN，直接跳过，避免嵌套 claim 死锁。
# 只有本进程真正 claim 成功时才安装 EXIT/INT/TERM trap 负责释放。

# 按 lib.sh 自身目录定位，不依赖可能指向别的 checkout 的 QUBIUS_REPO_DIR。
qubius_ops_script() {
  printf '%s\n' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ops-lock.sh"
}

qubius_ops_claim() {
  local kind=${1:-deploy}
  QUBIUS_OPS_CLAIMED=${QUBIUS_OPS_CLAIMED:-0}

  # 已在作业内：作业自身持有 ops lock，子脚本不能再 claim。
  if [[ -n ${QUBIUS_OPS_TOKEN:-} ]]; then
    return 0
  fi
  if ! command -v flock >/dev/null 2>&1; then
    qubius_warn "找不到 flock，跳过 ops lock（手工执行可能与部署页作业并发）"
    return 0
  fi

  local script root epoch job token
  script=$(qubius_ops_script)
  [[ -f $script ]] || qubius_die "缺少 ops lock 脚本：$script"
  root=${QUBIUS_CONFIG_DIR:-$(qubius_default_config_dir)}
  epoch=$(date +%s)
  job="manual-$kind-$$-$epoch"
  token="manual-$kind-$epoch-$$-$RANDOM-$RANDOM"

  # claim 的 JSON 里带 token，失败时只给出可操作提示，不打印原文。
  if ! bash "$script" claim --root "$root" --kind "$kind" \
    --job-id "$job" --token "$token" >/dev/null 2>&1; then
    qubius_die "无法获取 ops lock（等待部署页作业结束后重试；或在部署页回收残留锁）"
  fi

  # meta 只是记录；真正的互斥由本进程持有的 flock 保证。fd 6 与
  # install/start-all 的 deploy.lock(9)、deploy-job/edge-job 的 fd 7、
  # secondary 的 8/9 错开。
  if ! exec 6<>"$root/ops.lock"; then
    bash "$script" clear --root "$root" --token "$token" >/dev/null 2>&1 || true
    qubius_die "无法打开 ops lock：$root/ops.lock"
  fi
  if ! flock -n 6; then
    bash "$script" clear --root "$root" --token "$token" >/dev/null 2>&1 || true
    exec 6>&- 2>/dev/null || true
    qubius_die "无法持有 ops lock（等待部署页作业结束后重试；或在部署页回收残留锁）"
  fi

  export QUBIUS_OPS_ROOT=$root
  export QUBIUS_OPS_TOKEN=$token
  export QUBIUS_OPS_JOB=$job
  QUBIUS_OPS_CLAIMED=1

  # claim 统一安装 trap；release 幂等，且不能反过来让脚本失败。
  trap qubius_ops_release EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # 记录真实进程；node 不可用等失败不影响互斥，忽略即可。
  bash "$script" mark --root "$root" --state running --kind "$kind" \
    --job-id "$job" --token "$token" --pid "$$" >/dev/null 2>&1 || true
  return 0
}

# 幂等释放：只有本进程 claim 过才 clear；任何失败都忽略。
qubius_ops_release() {
  [[ ${QUBIUS_OPS_CLAIMED:-0} == 1 ]] || return 0
  QUBIUS_OPS_CLAIMED=0
  local script root token
  root=${QUBIUS_OPS_ROOT:-${QUBIUS_CONFIG_DIR:-$(qubius_default_config_dir)}}
  token=${QUBIUS_OPS_TOKEN:-}
  # 必须先关闭自己的 flock，clear 才能拿到锁；关闭失败也不能让脚本失败。
  exec 6>&- 2>/dev/null || true
  [[ -n $token ]] || return 0
  script=$(qubius_ops_script)
  [[ -f $script ]] || return 0
  bash "$script" clear --root "$root" --token "$token" >/dev/null 2>&1 || true
  return 0
}

# 用 {{VAR}} 占位符渲染模板；缺少变量时失败，不写半成品。
qubius_render() {
  local src=$1 dst=$2 node
  node=$(qubius_resolve_node)
  "$node" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/render.mjs" "$src" "$dst"
}

qubius_require_dir() {
  [[ -d ${1:-} ]] || qubius_die "目录不存在：${1:-}"
}

qubius_require_cmd() {
  command -v "$1" >/dev/null 2>&1 || qubius_die "缺少命令：$1"
}
