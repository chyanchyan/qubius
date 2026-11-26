#!/bin/bash
# 按入口层级部署：make deploy / deploy-lan / deploy-wan 的统一入口。
#
#   local  构建并重启本机实例，只保证 127.0.0.1 可访问；不管理局域网/公网入口
#          （已经运行的 lan-proxy 和已有的 edgectl 配置保持不动）。
#   lan    在 local 基础上重启局域网入口（lan-proxy）。
#   wan    在 lan 基础上应用公网入口（走运行中实例的 /api/edge，与部署页同一套作业）。
#
# 自动检测 systemd：当前角色的 unit 已启用或运行中时用 systemctl --user restart，
# 否则交给 deploy/start-all.sh --restart（构建、停止、启动都由它处理）。
#
# 实例、端口、目录都来自 deploy/lib.sh 的 qubius_load；当前目录只是脚本来源，
# 部署的是 QUBIUS_PRIMARY_DIR / QUBIUS_SECONDARY_DIR 指向的 checkout。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/lib.sh"
qubius_load

usage() {
  cat <<'EOF'
用法：deploy.sh <local|lan|wan> [--yes]

  local  本地部署：构建并重启本机实例（http://127.0.0.1:<端口>）。
  lan    局域网部署：在 local 基础上重启局域网入口（lan-proxy）。
  wan    公网部署：在 lan 基础上应用公网入口（edgectl / 部署页同一套作业）。

  --yes  应用公网入口时不再交互确认（也可用 QUBIUS_EDGE_YES=1）。
  -h, --help  显示本帮助。

环境变量：QUBIUS_EDGE_DOMAIN 指定确认域名；QUBIUS_EDGE_WAIT 指定等待公网入口作业的秒数。
EOF
}

MODE=${1:-local}
case $MODE in
  -h | --help) usage; exit 0 ;;
  local | lan | wan) shift || true ;;
  *)
    echo "未知模式：$MODE" >&2
    usage >&2
    exit 2
    ;;
esac

YES=${QUBIUS_EDGE_YES:-0}
while (($#)); do
  case $1 in
    --yes | -y) YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *)
      echo "未知参数：$1" >&2
      exit 2
      ;;
  esac
  shift
done
YES=$(qubius_bool "$YES" 0)

NODE_BIN=$(qubius_resolve_node)
export PATH="$(dirname "$NODE_BIN"):$PATH"

for cmd in curl git; do
  command -v "$cmd" >/dev/null 2>&1 || qubius_die "缺少命令：$cmd"
done
if [[ $MODE != local ]]; then
  command -v ss >/dev/null 2>&1 || qubius_die "缺少命令：ss（局域网入口检查需要）"
  # 没有凭据时自动生成并打印一次，避免 deploy-lan 因为缺文件而启动失败。
  qubius_ensure_lan_credentials
fi

# ── 角色信息：与 start-all.sh 的默认值保持一致 ──────────────────────────────
declare -A ROLE_REPO ROLE_DATA ROLE_PORT ROLE_FLAG ROLE_LABEL
for role in primary secondary; do
  case $role in
    primary)
      ROLE_REPO[$role]=$QUBIUS_PRIMARY_DIR
      ROLE_DATA[$role]=$QUBIUS_DATA_PRIMARY
      ROLE_PORT[$role]=$QUBIUS_PRIMARY_PORT
      ROLE_FLAG[$role]=0
      ROLE_LABEL[$role]="主实例 qubius"
      ;;
    secondary)
      ROLE_REPO[$role]=$QUBIUS_SECONDARY_DIR
      ROLE_DATA[$role]=$QUBIUS_DATA_SECONDARY
      ROLE_PORT[$role]=$QUBIUS_SECONDARY_PORT
      ROLE_FLAG[$role]=1
      ROLE_LABEL[$role]="副实例 co-qubius"
      ;;
  esac
done

role_enabled() {
  case $1 in
    primary) [[ $QUBIUS_START_PRIMARY == 1 ]] ;;
    secondary) [[ $QUBIUS_START_SECONDARY == 1 ]] ;;
    *) return 1 ;;
  esac
}

role_service() {
  if [[ $1 == primary ]]; then
    printf '%s\n' qubius.service
  else
    printf '%s\n' co-qubius.service
  fi
}

role_proxy_service() {
  if [[ $1 == primary ]]; then
    printf '%s\n' qubius-proxy.service
  else
    printf '%s\n' co-qubius-proxy.service
  fi
}

MANAGED=()
for role in primary secondary; do
  if ! role_enabled "$role"; then
    echo "跳过 ${ROLE_LABEL[$role]}（启动开关已关闭）" >&2
    continue
  fi
  repo=${ROLE_REPO[$role]}
  [[ -d $repo ]] || qubius_die "${ROLE_LABEL[$role]}：仓库目录不存在：$repo"
  [[ -x $repo/deploy/build.sh ]] || qubius_die "${ROLE_LABEL[$role]}：缺少或不可执行 $repo/deploy/build.sh"
  MANAGED+=("$role")
done

if (( ${#MANAGED[@]} == 0 )); then
  echo "没有启用的实例（检查 QUBIUS_START_PRIMARY / QUBIUS_START_SECONDARY）" >&2
  exit 0
fi

# 与部署页、install/start-all 共用同一把 ops lock；子脚本继承 token 后自动跳过。
qubius_ops_claim deploy

# ── systemd 检测（与 start-all.sh 的判定保持一致）───────────────────────────
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
unit_enabled() {
  local unit=$1 link
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user is-enabled "$unit" >/dev/null 2>&1 && return 0
    systemctl --user is-active "$unit" >/dev/null 2>&1 && return 0
  fi
  if [[ -L $UNIT_DIR/$unit && $(readlink "$UNIT_DIR/$unit") == /dev/null ]]; then
    return 1
  fi
  for link in "$UNIT_DIR"/*.wants/"$unit"; do
    [[ -e $link ]] && return 0
  done
  return 1
}

unit_active() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$1" >/dev/null 2>&1
}

unit_managed() {
  unit_enabled "$1" || unit_active "$1"
}

unit_loaded() {
  systemctl --user show -p LoadState --value "$1" 2>/dev/null | grep -qx loaded
}

USE_SYSTEMD=0
for role in "${MANAGED[@]}"; do
  if unit_managed "$(role_service "$role")" || unit_managed "$(role_proxy_service "$role")"; then
    USE_SYSTEMD=1
    break
  fi
done

# ── 健康检查与局域网监听检查 ────────────────────────────────────────────────
health_code() {
  curl -sS -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/api/health" 2>/dev/null || true
}

health_head() {
  curl -fsS -m 2 "http://127.0.0.1:$1/api/health" 2>/dev/null | "$NODE_BIN" -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        if (typeof j.head === "string" && j.head) process.stdout.write(j.head);
      } catch {}
    });
  ' 2>/dev/null || true
}

wait_health() {
  local role=$1 name=${ROLE_LABEL[$1]} port=${ROLE_PORT[$1]} repo=${ROLE_REPO[$1]} i head cur
  for ((i = 0; i < 120; i++)); do
    [[ $(health_code "$port") == 200 ]] && break
    sleep 0.5
  done
  if [[ $(health_code "$port") != 200 ]]; then
    qubius_die "$name：重启后 /api/health 未就绪（HTTP $(health_code "$port")），查看 ${ROLE_DATA[$role]}/qubius.log"
  fi
  head=$(health_head "$port")
  if [[ -n $head ]]; then
    cur=$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)
    [[ -n $cur ]] || qubius_die "$name：无法读取 $repo 的 git HEAD"
    [[ $head == "$cur" ]] || qubius_die "$name：health 的 head=$head 与当前 git HEAD=$cur 不一致（构建后未重启？）"
  fi
  echo "$name 已就绪：http://127.0.0.1:$port"
}

lan_listening() {
  local port=$1
  ss -H -ltn "sport = :$port" 2>/dev/null \
    | awk -v p=":$port" '$4 ~ p && $4 !~ /^(127\.|\[::1\]:|\[::ffff:127\.)/ { found = 1 } END { exit found ? 0 : 1 }'
}

wait_lan() {
  local role=$1 name=${ROLE_LABEL[$1]} port=${ROLE_PORT[$1]} i
  for ((i = 0; i < 120; i++)); do
    lan_listening "$port" && break
    sleep 0.5
  done
  lan_listening "$port" || qubius_die "$name：局域网入口端口 $port 未监听，查看 ${ROLE_DATA[$role]}/lan-proxy.log"
  echo "$name 局域网入口已就绪（端口 $port）"
}

# ── 构建 ────────────────────────────────────────────────────────────────────
needs_install() {
  local repo=$1
  local hash_file=$repo/node_modules/.qubius-lock-hash hash
  [[ -d $repo/node_modules ]] || return 0
  hash=$(sha256sum "$repo/package-lock.json" | awk '{print $1}')
  if [[ -f $hash_file && $(cat "$hash_file" 2>/dev/null) == "$hash" ]]; then
    return 1
  fi
  return 0
}

build_role() {
  local role=$1 repo=${ROLE_REPO[$1]} flag=${ROLE_FLAG[$1]}
  echo "构建 ${ROLE_LABEL[$role]}（$repo）"
  QUBIUS_SECONDARY=$flag QUBIUS_REPO_DIR=$repo "$repo/deploy/build.sh" "$repo" 6>&- 9>&-
}

# ── 部署本体 ────────────────────────────────────────────────────────────────
if (( USE_SYSTEMD )); then
  command -v systemctl >/dev/null 2>&1 || qubius_die "检测到 systemd unit，但找不到 systemctl"
  command -v sha256sum >/dev/null 2>&1 || qubius_die "缺少命令：sha256sum"
  for role in "${MANAGED[@]}"; do
    unit_managed "$(role_service "$role")" \
      || qubius_die "${ROLE_LABEL[$role]}：systemd unit $(role_service "$role") 未安装或未启用；先运行对应 checkout 的 deploy/install.sh 并安装 unit"
  done
  if [[ $MODE != local ]]; then
    for role in "${MANAGED[@]}"; do
      unit_loaded "$(role_proxy_service "$role")" \
        || qubius_die "${ROLE_LABEL[$role]}：systemd unit $(role_proxy_service "$role") 未安装；先运行 deploy/install.sh 并安装 unit"
    done
  fi

  for role in "${MANAGED[@]}"; do
    # npm ci 会删除 node_modules，必须先停旧进程；普通构建不影响运行中的服务。
    if needs_install "${ROLE_REPO[$role]}"; then
      echo "依赖有变化，先停止 ${ROLE_LABEL[$role]} 再安装"
      systemctl --user stop "$(role_service "$role")" || qubius_die "${ROLE_LABEL[$role]}：停止失败"
    fi
    build_role "$role"
  done

  for role in "${MANAGED[@]}"; do
    echo "重启 ${ROLE_LABEL[$role]}（$(role_service "$role")）"
    systemctl --user restart "$(role_service "$role")" \
      || qubius_die "${ROLE_LABEL[$role]}：systemctl restart 失败"
  done
  for role in "${MANAGED[@]}"; do
    wait_health "$role"
  done

  if [[ $MODE != local ]]; then
    for role in "${MANAGED[@]}"; do
      echo "重启 ${ROLE_LABEL[$role]} 局域网入口（$(role_proxy_service "$role")）"
      systemctl --user restart "$(role_proxy_service "$role")" \
        || qubius_die "${ROLE_LABEL[$role]}：局域网入口重启失败"
    done
    for role in "${MANAGED[@]}"; do
      wait_lan "$role"
    done
  fi
else
  # 没有 systemd 接管：build、停止、启动和局域网入口都交给 start-all。
  if [[ $MODE == local ]]; then
    export QUBIUS_START_LAN=0
  else
    export QUBIUS_START_LAN=1
  fi
  "$HERE/start-all.sh" --restart
fi

# ── 公网入口 ────────────────────────────────────────────────────────────────
if [[ $MODE == wan ]]; then
  # 公网入口作业要在服务端自己 claim 同一把 ops lock；这里必须先释放，
  # 否则 apply 会以 busy 失败。构建和重启已经完成，释放后不影响前面的步骤。
  qubius_ops_release
  # 选一个正在运行的实例调用 /api/edge：优先主实例。
  if [[ $QUBIUS_START_PRIMARY == 1 ]]; then
    API_ROLE=primary
  else
    API_ROLE=secondary
  fi
  API_PORT=${ROLE_PORT[$API_ROLE]}
  API_DATA=${ROLE_DATA[$API_ROLE]}
  EDGE_ARGS=(--port "$API_PORT")
  if [[ -n ${QUBIUS_AUTH_TOKEN:-} ]]; then
    EDGE_ARGS+=(--token "$QUBIUS_AUTH_TOKEN")
  elif [[ -f $API_DATA/auth-token ]]; then
    EDGE_ARGS+=(--token-file "$API_DATA/auth-token")
  fi
  if [[ -n ${QUBIUS_EDGE_DOMAIN:-} ]]; then
    EDGE_ARGS+=(--domain "$QUBIUS_EDGE_DOMAIN")
  fi
  if [[ -n ${QUBIUS_EDGE_WAIT:-} ]]; then
    EDGE_ARGS+=(--wait "$QUBIUS_EDGE_WAIT")
  fi
  if (( YES )); then
    EDGE_ARGS+=(--yes)
  fi

  echo "应用公网入口（127.0.0.1:$API_PORT）"
  "$NODE_BIN" "$HERE/edge-deploy.mjs" "${EDGE_ARGS[@]}"
fi

# 局域网/公网部署后把自动生成的访问令牌打印一次，方便直接填进浏览器。
if [[ $MODE != local ]]; then
  for role in primary secondary; do
    if [[ $role == primary && $QUBIUS_START_PRIMARY != 1 ]] \
      || [[ $role == secondary && $QUBIUS_START_SECONDARY != 1 ]]; then
      continue
    fi
    token_file=${ROLE_DATA[$role]}/auth-token
    if [[ -f $token_file ]]; then
      qubius_info "${ROLE_LABEL[$role]} API 访问令牌（只显示这一次）：$(<"$token_file")"
    fi
  done
fi

echo "部署完成：$MODE"
