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
  local role=$1 skip_head=${2:-0} name=${ROLE_LABEL[$1]} port=${ROLE_PORT[$1]} repo=${ROLE_REPO[$1]} i head cur
  for ((i = 0; i < 120; i++)); do
    [[ $(health_code "$port") == 200 ]] && break
    sleep 0.5
  done
  if [[ $(health_code "$port") != 200 ]]; then
    qubius_die "$name：重启后 /api/health 未就绪（HTTP $(health_code "$port")），查看 ${ROLE_DATA[$role]}/qubius.log"
  fi
  # 回滚后启动的是旧产物，health 的 head 是旧 HEAD，不能再和当前 git HEAD 比较。
  if (( skip_head == 0 )); then
    head=$(health_head "$port")
    if [[ -n $head ]]; then
      cur=$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)
      [[ -n $cur ]] || qubius_die "$name：无法读取 $repo 的 git HEAD"
      [[ $head == "$cur" ]] || qubius_die "$name：health 的 head=$head 与当前 git HEAD=$cur 不一致（构建后未重启？）"
    fi
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

# 显式调用 build.sh 的模式；不再使用会 stage+swap 的默认模式。
build_mode() {
  local mode=$1 role=$2 repo=${ROLE_REPO[$2]} flag=${ROLE_FLAG[$2]}
  QUBIUS_SECONDARY=$flag QUBIUS_REPO_DIR=$repo "$repo/deploy/build.sh" "$mode" "$repo" 6>&- 9>&-
}

# 把安装依赖前备份的 node_modules 恢复回来；没有备份时是 no-op。
restore_node_modules_backup() {
  local repo=$1
  [[ -d $repo/node_modules.prev ]] || return 0
  rm -rf "$repo/node_modules"
  mv "$repo/node_modules.prev" "$repo/node_modules" 2>/dev/null || true
}

# 丢弃未切换的 staging，避免下次 swap 把旧 .next 提升为 live。
discard_staging_dirs() {
  rm -rf "$1/server/dist.next" "$1/web/dist.next"
}

# 中止部署时丢弃所有需要构建角色的 staging。
discard_all_staging() {
  local r
  for r in "${MANAGED[@]}"; do
    (( ${ROLE_BUILD[$r]:-0} )) && discard_staging_dirs "${ROLE_REPO[$r]}"
  done
  return 0
}

# 回滚/中止时按旧 live 拉起旧版本（health-only，不校验 HEAD）。
start_old_role() {
  local role=$1 repo=${ROLE_REPO[$1]}
  [[ -f $repo/server/dist/index.js ]] || return 1
  systemctl --user restart "$(role_service "$role")" \
    || { echo "${ROLE_LABEL[$role]}：旧版本启动失败" >&2; return 1; }
  wait_health "$role" 1
}

# 中止时恢复所有已停角色：恢复 node_modules、回滚已切换的 .prev、拉起旧版本。
# 可选参数是已单独处理过的角色，跳过它。
restore_stopped_roles() {
  local skip=${1:-} stopped repo
  for stopped in ${STOPPED_ROLES[@]+"${STOPPED_ROLES[@]}"}; do
    [[ $stopped == "$skip" ]] && continue
    # 已经成功启动新版本的角色保持新版本（stamp 已写入）。
    (( ${ROLE_STARTED[$stopped]:-0} )) && continue
    repo=${ROLE_REPO[$stopped]}
    # 只恢复本次真正备份过的依赖，避免陈旧 .prev 覆盖当前 node_modules。
    if (( ${ROLE_BACKUP[$stopped]:-0} )); then
      restore_node_modules_backup "$repo"
      ROLE_BACKUP[$stopped]=0
    fi
    if (( ${ROLE_SWAPPED[$stopped]:-0} )); then
      build_mode --rollback "$stopped" \
        || echo "${ROLE_LABEL[$stopped]}：回滚失败（缺少 .prev？）" >&2
    fi
    discard_staging_dirs "$repo"
    # 在子 shell 里启动：health 失败不应阻止恢复其余角色。
    ( start_old_role "$stopped" ) \
      || echo "${ROLE_LABEL[$stopped]}：旧版本未能拉起" >&2
  done
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

  # 先逐角色判断是否需要重启：构建产物、HEAD、config/env 指纹都没变化、
  # 且服务健康时跳过构建和 systemctl restart，避免无谓打断正在工作的会话。
  declare -A ROLE_CONFIG ROLE_RESTART ROLE_BUILD ROLE_REASON
  for role in "${MANAGED[@]}"; do
    repo=${ROLE_REPO[$role]}
    data=${ROLE_DATA[$role]}
    port=${ROLE_PORT[$role]}
    config=$(qubius_config_file_for_role "$role")
    healthy=0
    if [[ $(health_code "$port") == 200 ]]; then healthy=1; fi
    build_needed=0
    if qubius_needs_build "$repo"; then build_needed=1; fi
    ROLE_CONFIG[$role]=$config
    if qubius_deploy_should_restart "$repo" "$data" "$config" "$healthy" "$build_needed"; then
      ROLE_RESTART[$role]=1
      ROLE_BUILD[$role]=$build_needed
    else
      ROLE_RESTART[$role]=0
      ROLE_BUILD[$role]=0
    fi
    ROLE_REASON[$role]=$QUBIUS_DEPLOY_REASON
  done

  # 先对所有需要重启的角色统一做忙碌检查：任一角色忙时，在停止任何进程之前退出。
  # 同时检查新端口和上次部署实际用过的端口（stamp.port），覆盖改端口的情况。
  for role in "${MANAGED[@]}"; do
    (( ROLE_RESTART[$role] )) || continue
    qubius_guard_busy_ports "${ROLE_LABEL[$role]}" "${ROLE_PORT[$role]}" \
      "$(qubius_deploy_stamp_port "${ROLE_DATA[$role]}/.deploy-stamp")"
  done

  # 依赖变化时 npm ci 会删除 node_modules：先停旧进程，把 node_modules 备份为
  # .prev，再安装依赖。普通构建（依赖没变）不再停服务，只写 staging。
  declare -A ROLE_INSTALL ROLE_BACKUP ROLE_SWAPPED ROLE_STARTED
  STOPPED_ROLES=()
  for role in "${MANAGED[@]}"; do
    (( ROLE_RESTART[$role] )) || continue
    if (( ROLE_BUILD[$role] )) && needs_install "${ROLE_REPO[$role]}"; then
      echo "依赖有变化，先停止 ${ROLE_LABEL[$role]} 再安装"
      if ! systemctl --user stop "$(role_service "$role")"; then
        echo "${ROLE_LABEL[$role]}：停止失败，恢复已停角色" >&2
        restore_stopped_roles
        discard_all_staging
        qubius_die "${ROLE_LABEL[$role]}：停止失败"
      fi
      STOPPED_ROLES+=("$role")
      ROLE_INSTALL[$role]=1
      repo=${ROLE_REPO[$role]}
      if [[ -d $repo/node_modules ]]; then
        # 只有确实要备份时才清理旧 .prev；node_modules 缺失时保留旧备份以便恢复。
        rm -rf "$repo/node_modules.prev"
        mv "$repo/node_modules" "$repo/node_modules.prev" \
          || { ( start_old_role "$role" ) || true; qubius_die "${ROLE_LABEL[$role]}：备份 node_modules 失败"; }
        ROLE_BACKUP[$role]=1
      fi
      echo "安装 ${ROLE_LABEL[$role]} 依赖（package-lock.json 有变化）"
      if ! build_mode --deps "$role"; then
        echo "${ROLE_LABEL[$role]}：安装依赖失败，恢复所有已停角色" >&2
        restore_stopped_roles
        qubius_die "${ROLE_LABEL[$role]}：安装依赖失败"
      fi
    fi
  done

  # staging 构建：依赖没变时旧服务继续跑，live 完全不动。
  for role in "${MANAGED[@]}"; do
    (( ROLE_RESTART[$role] )) || continue
    if (( ROLE_BUILD[$role] )); then
      echo "构建 ${ROLE_LABEL[$role]}（staging，live 不动）"
      if ! build_mode --stage "$role"; then
        echo "${ROLE_LABEL[$role]}：构建失败，恢复所有已停角色" >&2
        restore_stopped_roles
        qubius_die "${ROLE_LABEL[$role]}：构建失败，live 保持旧版本"
      fi
    else
      echo "跳过构建 ${ROLE_LABEL[$role]}（无构建输入变化）"
    fi
  done

  # 构建可能耗时，停止前再读一次 activeSessions；任一角色忙时仍在改进程前退出。
  # 若因 npm ci 已经停过角色，先恢复 node_modules、丢弃 staging，再拉起旧版本。
  for role in "${MANAGED[@]}"; do
    (( ROLE_RESTART[$role] )) || continue
    guard_rc=0
    (
      qubius_guard_busy_ports "${ROLE_LABEL[$role]}" "${ROLE_PORT[$role]}" \
        "$(qubius_deploy_stamp_port "${ROLE_DATA[$role]}/.deploy-stamp")"
    ) || guard_rc=$?
    if (( guard_rc != 0 )); then
      for stopped in ${STOPPED_ROLES[@]+"${STOPPED_ROLES[@]}"}; do
        echo "复检发现会话，先重新拉起 ${ROLE_LABEL[$stopped]}（使用旧构建产物）" >&2
        if (( ${ROLE_BACKUP[$stopped]:-0} )); then
          restore_node_modules_backup "${ROLE_REPO[$stopped]}"
          ROLE_BACKUP[$stopped]=0
        fi
        discard_staging_dirs "${ROLE_REPO[$stopped]}"
        if ( start_old_role "$stopped" ); then
          qubius_write_role_stamp "${ROLE_REPO[$stopped]}" "${ROLE_DATA[$stopped]}" \
            "${ROLE_CONFIG[$stopped]}" "${ROLE_PORT[$stopped]}"
        else
          echo "${ROLE_LABEL[$stopped]}：旧版本重新拉起失败" >&2
        fi
      done
      # 未停止过的角色也要丢弃 staging，避免下次 swap 提升旧产物。
      for role in "${MANAGED[@]}"; do
        (( ROLE_BUILD[$role] )) && discard_staging_dirs "${ROLE_REPO[$role]}"
      done
      exit "$guard_rc"
    fi
  done

  for role in "${MANAGED[@]}"; do
    (( ROLE_RESTART[$role] )) || continue
    repo=${ROLE_REPO[$role]}
    # 需要切换产物时先停实例；没有构建输入变化的角色直接 restart。
    if (( ROLE_BUILD[$role] )) && (( ! ${ROLE_INSTALL[$role]:-0} )); then
      echo "停止 ${ROLE_LABEL[$role]}（$(role_service "$role")）"
      if ! systemctl --user stop "$(role_service "$role")"; then
        echo "${ROLE_LABEL[$role]}：停止失败，恢复已停角色" >&2
        restore_stopped_roles
        discard_all_staging
        qubius_die "${ROLE_LABEL[$role]}：停止失败"
      fi
      STOPPED_ROLES+=("$role")
    fi
    if (( ROLE_BUILD[$role] )); then
      if ! build_mode --swap "$role"; then
        echo "${ROLE_LABEL[$role]}：切换新产物失败，live 保持旧版本" >&2
        if (( ${ROLE_BACKUP[$role]:-0} )); then
          restore_node_modules_backup "$repo"
          ROLE_BACKUP[$role]=0
        fi
        discard_staging_dirs "$repo"
        ( start_old_role "$role" ) || true
        restore_stopped_roles "$role"
        qubius_die "${ROLE_LABEL[$role]}：切换失败，已恢复旧版本"
      fi
      ROLE_SWAPPED[$role]=1
    fi
    echo "重启 ${ROLE_LABEL[$role]}（$(role_service "$role")）"
    # 新版本失败（restart 失败或 health/HEAD 校验失败）时停止、回滚 .prev、
    # 恢复 node_modules，再按旧版本启动。
    if ! systemctl --user restart "$(role_service "$role")" || ! ( wait_health "$role" ); then
      echo "${ROLE_LABEL[$role]}：新版本启动失败，正在回滚" >&2
      systemctl --user stop "$(role_service "$role")" || true
      rollback_ok=1
      if (( ${ROLE_SWAPPED[$role]:-0} )); then
        if ! build_mode --rollback "$role"; then
          rollback_ok=0
          echo "${ROLE_LABEL[$role]}：回滚失败（首次部署没有 .prev？）" >&2
        fi
      fi
      if (( ${ROLE_BACKUP[$role]:-0} )); then
        restore_node_modules_backup "$repo"
        ROLE_BACKUP[$role]=0
      fi
      if (( rollback_ok == 0 )); then
        # 首次部署没有旧产物：live 仍是启动失败的新版本，不能再拉起它冒充“已回滚”。
        restore_stopped_roles "$role"
        qubius_die "${ROLE_LABEL[$role]}：新版本启动失败，且无旧版本可回滚"
      fi
      if ( start_old_role "$role" ); then
        restore_stopped_roles "$role"
        qubius_die "${ROLE_LABEL[$role]}：新版本启动失败，已回滚到旧版本"
      else
        restore_stopped_roles "$role"
        qubius_die "${ROLE_LABEL[$role]}：旧版本也未能启动"
      fi
    fi
    qubius_write_role_stamp "$repo" "${ROLE_DATA[$role]}" \
      "${ROLE_CONFIG[$role]}" "${ROLE_PORT[$role]}"
    ROLE_STARTED[$role]=1
    # 本次没有安装依赖时，旧的 node_modules.prev 已过期，成功部署后清掉。
    if (( ! ${ROLE_INSTALL[$role]:-0} )); then
      rm -rf "$repo/node_modules.prev"
    fi
  done
  for role in "${MANAGED[@]}"; do
    if (( ! ROLE_RESTART[$role] )); then
      echo "${ROLE_LABEL[$role]}：无变化，跳过重启（${ROLE_REASON[$role]}）"
      wait_health "$role"
    fi
  done

  if [[ $MODE != local ]]; then
    for role in "${MANAGED[@]}"; do
      # 无变化且代理仍在运行时不要主动重启局域网入口。
      if (( ROLE_RESTART[$role] )) || ! unit_active "$(role_proxy_service "$role")"; then
        echo "重启 ${ROLE_LABEL[$role]} 局域网入口（$(role_proxy_service "$role")）"
        systemctl --user restart "$(role_proxy_service "$role")" \
          || qubius_die "${ROLE_LABEL[$role]}：局域网入口重启失败"
      else
        echo "${ROLE_LABEL[$role]} 局域网入口无需重启（$(role_proxy_service "$role") 运行中）"
      fi
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
