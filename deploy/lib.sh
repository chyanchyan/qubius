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

# 默认把配置、env、数据都收敛到 checkout 内的 .qubius/（已 gitignore），
# 不再依赖 ~/.config、~/.local/share 或 %APPDATA%。
qubius_default_config_dir() {
  printf '%s\n' "$(qubius_repo_root)/.qubius"
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
  # 默认全部落在代码目录：当前 checkout 是主实例，数据在 <checkout>/.qubius/data。
  # 副实例默认是 $HOME/co-qubius 这份 checkout，数据同样放在它自己的 .qubius/data。
  QUBIUS_REPO_DIR=$(qubius_repo_root)
  QUBIUS_CONFIG_DIR=${QUBIUS_CONFIG_DIR:-$(qubius_default_config_dir)}
  QUBIUS_PRIMARY_DIR=${QUBIUS_PRIMARY_DIR:-$QUBIUS_REPO_DIR}
  QUBIUS_SECONDARY_DIR=${QUBIUS_SECONDARY_DIR:-$QUBIUS_HOME/co-qubius}
  QUBIUS_DATA_PRIMARY=${QUBIUS_DATA_PRIMARY:-$QUBIUS_PRIMARY_DIR/.qubius/data}
  QUBIUS_DATA_SECONDARY=${QUBIUS_DATA_SECONDARY:-$QUBIUS_SECONDARY_DIR/.qubius/data}
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
  QUBIUS_LAN_USER=${QUBIUS_LAN_USER:-qubius}
  QUBIUS_ARCHIVE_DIR=${QUBIUS_ARCHIVE_DIR:-}
  QUBIUS_ARCHIVE_RETENTION_DAYS=${QUBIUS_ARCHIVE_RETENTION_DAYS:-30}
  QUBIUS_MAX_CONCURRENT=${QUBIUS_MAX_CONCURRENT:-4}
  QUBIUS_APPROVAL_TIMEOUT_MINUTES=${QUBIUS_APPROVAL_TIMEOUT_MINUTES:-10}
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
  # GitHub 镜像（owner/repo 或完整地址）；部署页可改，空表示自动从 remote 识别。
  QUBIUS_GITHUB_REPO=${QUBIUS_GITHUB_REPO:-}

  [[ $QUBIUS_ARCHIVE_RETENTION_DAYS =~ ^[0-9]+$ ]] \
    || qubius_die "QUBIUS_ARCHIVE_RETENTION_DAYS 必须是整数"
  [[ $QUBIUS_MAX_CONCURRENT =~ ^[0-9]+$ ]] \
    || qubius_die "QUBIUS_MAX_CONCURRENT 必须是整数"
  [[ $QUBIUS_APPROVAL_TIMEOUT_MINUTES =~ ^[0-9]+$ ]] \
    || qubius_die "QUBIUS_APPROVAL_TIMEOUT_MINUTES 必须是整数"
  (( QUBIUS_APPROVAL_TIMEOUT_MINUTES <= 1440 )) \
    || qubius_die "QUBIUS_APPROVAL_TIMEOUT_MINUTES 必须在 0 到 1440 之间"

  local name
  for name in QUBIUS_USER QUBIUS_HOME QUBIUS_CONFIG_DIR QUBIUS_PRIMARY_DIR QUBIUS_SECONDARY_DIR \
    QUBIUS_DATA_PRIMARY QUBIUS_DATA_SECONDARY QUBIUS_PRIMARY_PORT QUBIUS_SECONDARY_PORT \
    QUBIUS_PRIMARY_REF QUBIUS_PUBLIC_HOST QUBIUS_PUBLIC_HOST_SECONDARY \
    QUBIUS_PRIMARY_REPO_URL QUBIUS_SECONDARY_REPO_URL QUBIUS_SECONDARY QUBIUS_REPO_DIR \
    QUBIUS_LAN_HOST QUBIUS_LAN_USER QUBIUS_ARCHIVE_DIR QUBIUS_ARCHIVE_RETENTION_DAYS QUBIUS_MAX_CONCURRENT \
    QUBIUS_APPROVAL_TIMEOUT_MINUTES \
    QUBIUS_PROJECTS_FILE QUBIUS_START_PRIMARY QUBIUS_START_SECONDARY QUBIUS_START_LAN QUBIUS_CLONE_PEER \
    QUBIUS_GITEA_URL QUBIUS_GITEA_OWNER QUBIUS_GITEA_TOKEN QUBIUS_NODE_BIN \
    QUBIUS_GITHUB_REPO QUBIUS_AUTH QUBIUS_AUTH_TOKEN QUBIUS_VAPID_SUBJECT; do
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

# ── 健康检查与部署决策 ──────────────────────────────────────────────────────
# 部署/重启前检查 /api/health 的 activeSessions（排队/运行/等待确认的会话数），
# 并据此决定是否跳过“无变化”的重启。这些 helper 供 deploy.sh、start-all.sh、
# deploy-job.sh 共用；页面部署的 Node 版本在 deploy-lib.mjs 里有等价实现。

qubius_health_code() {
  local port=${1:-}
  curl -sS -m 2 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$port/api/health" 2>/dev/null || true
}

# 打印进行中的会话数；服务不可达/字段缺失时打印 0。
qubius_health_active() {
  local port=${1:-} node active
  command -v curl >/dev/null 2>&1 || { printf '0\n'; return 0; }
  node=$(qubius_resolve_node 2>/dev/null) || { printf '0\n'; return 0; }
  active=$(curl -fsS -m 2 "http://127.0.0.1:$port/api/health" 2>/dev/null | "$node" -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        const n = j && j.activeSessions;
        if (Number.isInteger(n) && n > 0) process.stdout.write(String(n));
      } catch {}
    });
  ' 2>/dev/null || true)
  if [[ $active =~ ^[0-9]+$ ]]; then printf '%s\n' "$active"; else printf '0\n'; fi
}

# 每 2 秒轮询一次，直到空闲或超时；空闲返回 0，超时返回 1。
qubius_wait_idle() {
  local label=$1 port=$2 limit=$3 count start now
  count=$(qubius_health_active "$port")
  start=$(date +%s)
  while (( count > 0 )); do
    now=$(date +%s)
    (( now - start >= limit )) && break
    qubius_info "$label：还有 $count 个会话进行中，等待空闲（已等 $((now - start)) 秒 / 最多 $limit 秒）"
    sleep 2
    count=$(qubius_health_active "$port")
  done
  (( count <= 0 ))
}

# 与 Node 版 envBool 一致：1/true/yes/on 都算开启。
qubius_deploy_on() {
  case ${1:-} in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

# 即将停止/重启一个健康实例前调用：有进行中的会话时等待、强制或中止。
# 会话数 <=0、或服务不健康（连不上）时直接放行。
qubius_guard_busy() {
  local label=$1 port=$2 count answer wait_value=0 force=${QUBIUS_DEPLOY_FORCE:-0}
  # 交互选择“强制”后，同一次部署里对同一端口不再重复询问（构建后还会复检一次）。
  case ${QUBIUS_GUARD_FORCED_PORTS:-" "} in
    *" $port "*) return 0 ;;
  esac
  count=$(qubius_health_active "$port")
  (( count > 0 )) || return 0

  if qubius_deploy_on "${force,,}"; then
    qubius_warn "$label：有 $count 个进行中的会话，QUBIUS_DEPLOY_FORCE 已强制继续（这些会话会被中断）"
    return 0
  fi

  if [[ -n ${QUBIUS_DEPLOY_WAIT:-} ]]; then
    if [[ ! ${QUBIUS_DEPLOY_WAIT} =~ ^[0-9]+$ ]]; then
      qubius_warn "$label：QUBIUS_DEPLOY_WAIT 必须是整数秒，当前为 [${QUBIUS_DEPLOY_WAIT}]，已中止部署。"
      qubius_warn "  - 改成 QUBIUS_DEPLOY_WAIT=<秒>，或设 QUBIUS_DEPLOY_FORCE=1 强制重启"
      exit 3
    fi
    wait_value=${QUBIUS_DEPLOY_WAIT}
    if qubius_wait_idle "$label" "$port" "$wait_value"; then
      qubius_info "$label：已空闲，继续"
      return 0
    fi
    count=$(qubius_health_active "$port")
    qubius_warn "$label：等待 ${wait_value} 秒后仍有 $count 个会话进行中，已中止部署。"
    qubius_warn "  - 设 QUBIUS_DEPLOY_FORCE=1 强制重启（会中断这些会话）"
    qubius_warn "  - 或先停止这些会话后重试"
    exit 3
  fi

  if [[ -t 0 ]]; then
    while true; do
      printf '%s：有 %s 个会话进行中。 [w]等待 / [f]强制 / [c]取消（默认取消）：' \
        "$label" "$count" >&2
      read -r answer || answer=""
      case ${answer,,} in
        w | wait)
          # 设置了 QUBIUS_DEPLOY_WAIT 时上面已处理；走到这里说明没设置。
          wait_value=600
          if qubius_wait_idle "$label" "$port" "$wait_value"; then
            qubius_info "$label：已空闲，继续"
            return 0
          fi
          count=$(qubius_health_active "$port")
          (( count <= 0 )) && return 0
          qubius_warn "$label：等待后仍有 $count 个会话进行中，已中止部署。"
          exit 3
          ;;
        f | force)
          QUBIUS_GUARD_FORCED_PORTS="${QUBIUS_GUARD_FORCED_PORTS:- }$port "
          qubius_warn "$label：已选择强制重启（这些会话会被中断）"
          return 0
          ;;
        *)
          qubius_warn "$label：已取消部署"
          exit 3
          ;;
      esac
    done
  fi

  qubius_warn "$label：有 $count 个会话进行中，非交互环境已中止部署。"
  qubius_warn "  - 设 QUBIUS_DEPLOY_FORCE=1 强制重启（会中断这些会话）"
  qubius_warn "  - 设 QUBIUS_DEPLOY_WAIT=<秒> 等待空闲后再重启"
  exit 3
}

# 文件 sha256；文件为空或不存在时返回 "none"（配置文件缺失也参与决策）。
qubius_hash_file() {
  local file=${1:-}
  if [[ -n $file && -f $file ]]; then
    sha256sum "$file" | awk '{print $1}'
  else
    printf 'none\n'
  fi
}

qubius_config_file_for_role() {
  if [[ ${1:-} == secondary ]]; then
    printf '%s/config-secondary.yaml\n' "$QUBIUS_CONFIG_DIR"
  else
    printf '%s/config.yaml\n' "$QUBIUS_CONFIG_DIR"
  fi
}

# 读取 JSON 文件的字符串/布尔字段；失败时输出空串。
qubius_json_field() {
  local file=$1 field=$2 node
  [[ -f $file ]] || return 0
  node=$(qubius_resolve_node 2>/dev/null) || return 0
  "$node" -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const v = j && j[process.argv[2]];
      if (typeof v === "string") process.stdout.write(v);
      else if (typeof v === "boolean") process.stdout.write(v ? "true" : "false");
    } catch {}
  ' "$file" "$field" 2>/dev/null || true
}

# 需要重新 npm ci 时返回 0（与 start-all.sh 的 needs_install 一致）。
qubius_needs_install() {
  local repo=$1 hash_file hash
  hash_file=$repo/node_modules/.qubius-lock-hash
  [[ -d $repo/node_modules ]] || return 0
  [[ -f $repo/package-lock.json ]] || return 0
  hash=$(sha256sum "$repo/package-lock.json" 2>/dev/null | awk '{print $1}')
  [[ -n $hash ]] || return 0
  if [[ -f $hash_file && $(cat "$hash_file" 2>/dev/null) == "$hash" ]]; then
    return 1
  fi
  return 0
}

# 构建输入里是否有未提交改动。显式排除 staging 的 dist.next/dist.prev，
# 不依赖仓库 .gitignore（构建 staging 单元可能还没落地）。
qubius_build_status() {
  local repo=$1
  git -C "$repo" status --porcelain --untracked-files=normal -- \
    server web package.json package-lock.json \
    ':(exclude)server/dist.next' ':(exclude)server/dist.prev' \
    ':(exclude)web/dist.next' ':(exclude)web/dist.prev' \
    ':(exclude)dist.next' ':(exclude)dist.prev' 2>/dev/null
}

# 构建产物不是最新时返回 0（与 start-all.sh 的 needs_build 一致）。
qubius_needs_build() {
  local repo=$1 head stamp
  [[ -f $repo/server/dist/index.js && -f $repo/web/dist/index.html ]] || return 0
  [[ -d $repo/node_modules ]] || return 0
  head=$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)
  [[ -n $head ]] || return 0
  qubius_needs_install "$repo" && return 0
  if [[ -n $(qubius_build_status "$repo") ]]; then
    return 0
  fi
  [[ $(qubius_json_field "$repo/server/dist/build.json" dirty) == true ]] && return 0
  stamp=$(qubius_json_field "$repo/server/dist/build.json" head)
  [[ $stamp == "$head" ]] || return 0
  return 1
}

# 原子写入每个角色的部署 stamp（head / configHash / envHash / port）。
# port 是这次部署实际使用的端口，供以后改端口时也能检查旧端口上的会话。
qubius_write_deploy_stamp() {
  local file=$1 head=$2 config_hash=$3 env_hash=$4 port=${5:-} dir tmp
  dir=$(dirname "$file")
  mkdir -p "$dir"
  tmp="${file}.tmp.$$"
  printf '{"head":"%s","configHash":"%s","envHash":"%s","port":"%s"}\n' \
    "$head" "$config_hash" "$env_hash" "$port" >"$tmp"
  mv -f "$tmp" "$file"
}

qubius_write_role_stamp() {
  local repo=$1 data=$2 config=$3 port=${4:-} head
  head=$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)
  qubius_write_deploy_stamp "$data/.deploy-stamp" "$head" \
    "$(qubius_hash_file "$config")" \
    "$(qubius_hash_file "${QUBIUS_ENV_FILE:-$(qubius_env_file)}")" \
    "$port"
}

# 读取 stamp 里上次部署实际使用的端口；没有或非法时输出空串。
qubius_deploy_stamp_port() {
  local file=$1 port
  port=$(qubius_json_field "$file" port)
  if [[ $port =~ ^[0-9]+$ ]]; then printf '%s\n' "$port"; fi
}

# 依次检查多个端口上的会话（同一端口去重）；任一端口忙就按 guard 的规则等待/中止。
qubius_guard_busy_ports() {
  local label=$1 seen=" " port
  shift
  for port in "$@"; do
    [[ -n $port ]] || continue
    case " $seen " in *" $port "*) continue ;; esac
    seen="$seen$port "
    qubius_guard_busy "$label" "$port"
  done
}

# 决定是否需要重启：需要返回 0，无变化返回 1；原因写入 QUBIUS_DEPLOY_REASON。
# QUBIUS_DEPLOY_RESTART=1 强制重启；config/env/HEAD 变化时即使不构建也要重启。
qubius_deploy_should_restart() {
  local repo=$1 data=$2 config=$3 healthy=${4:-0} build_needed=${5:-0}
  local stamp head saved_head saved_config saved_env force=${QUBIUS_DEPLOY_RESTART:-0}
  QUBIUS_DEPLOY_REASON=""

  if qubius_deploy_on "${force,,}"; then
    QUBIUS_DEPLOY_REASON="QUBIUS_DEPLOY_RESTART=1，强制重启"
    return 0
  fi
  (( healthy )) || { QUBIUS_DEPLOY_REASON="服务未运行或不健康"; return 0; }
  (( build_needed )) && { QUBIUS_DEPLOY_REASON="构建产物不是最新"; return 0; }

  stamp="$data/.deploy-stamp"
  [[ -f $stamp ]] || { QUBIUS_DEPLOY_REASON="没有部署 stamp（首次部署？）"; return 0; }
  head=$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)
  [[ -n $head ]] || { QUBIUS_DEPLOY_REASON="无法读取 git HEAD"; return 0; }
  saved_head=$(qubius_json_field "$stamp" head)
  saved_config=$(qubius_json_field "$stamp" configHash)
  saved_env=$(qubius_json_field "$stamp" envHash)
  [[ $saved_head == "$head" ]] || { QUBIUS_DEPLOY_REASON="git HEAD 变化"; return 0; }
  [[ $saved_config == "$(qubius_hash_file "$config")" ]] \
    || { QUBIUS_DEPLOY_REASON="config 文件变化"; return 0; }
  [[ $saved_env == "$(qubius_hash_file "${QUBIUS_ENV_FILE:-$(qubius_env_file)}")" ]] \
    || { QUBIUS_DEPLOY_REASON="env 文件变化"; return 0; }

  QUBIUS_DEPLOY_REASON="无变化"
  return 1
}

# 计算角色当前状态并输出 "<restart|skip>\t<原因>"，供 deploy-job.sh 复用。
qubius_deploy_role_action() {
  local repo=$1 data=$2 config=$3 port=$4 healthy=0 build_needed=0 action
  if [[ $(qubius_health_code "$port") == 200 ]]; then healthy=1; fi
  if qubius_needs_build "$repo"; then build_needed=1; fi
  if qubius_deploy_should_restart "$repo" "$data" "$config" "$healthy" "$build_needed"; then
    action=restart
  else
    action=skip
  fi
  printf '%s\t%s\n' "$action" "$QUBIUS_DEPLOY_REASON"
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

# ── 局域网登录凭据 ──────────────────────────────────────────────────────────
# 默认文件：$QUBIUS_CONFIG_DIR/lan-proxy.credentials，一行 user:password。
qubius_lan_credentials_file() {
  local configured=${LAN_PROXY_CREDENTIALS:-}
  if [[ -n $configured ]]; then
    if [[ $configured == /* ]]; then
      printf '%s\n' "$configured"
    else
      printf '%s/%s\n' "$QUBIUS_CONFIG_DIR" "$configured"
    fi
    return 0
  fi
  printf '%s/lan-proxy.credentials\n' "$QUBIUS_CONFIG_DIR"
}

# 缺失时生成一份并打印一次；已存在则不动（部署页会显示当前用户名和“密码已设置”）。
qubius_ensure_lan_credentials() {
  local file user pass node
  file=$(qubius_lan_credentials_file)
  if [[ -f $file ]]; then
    return 0
  fi
  user=${QUBIUS_LAN_USER:-qubius}
  [[ $user =~ ^[^[:space:]:]{1,64}$ ]] \
    || qubius_die "QUBIUS_LAN_USER 只能包含非空白、非冒号字符（1-64）"
  node=$(qubius_resolve_node)
  pass=$("$node" -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("base64url"))') \
    || qubius_die "无法生成局域网密码"
  mkdir -p "$(dirname "$file")"
  (umask 077; printf '%s:%s\n' "$user" "$pass" >"$file")
  chmod 600 "$file" 2>/dev/null || true
  qubius_info "已生成局域网登录凭据（只显示这一次）："
  qubius_info "  用户名：$user"
  qubius_info "  密码：$pass"
  qubius_info "  文件：$file"
}
