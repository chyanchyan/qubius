#!/bin/bash
# 启动、重启或停止主实例（qubius）和副实例（co-qubius）及其内网入口。
# 只在手动调用或 @reboot 时执行一次，不是看门狗。
#
# 行为：
# - `--stop` 只停止实例和局域网入口，不构建、不启动。
# - 角色由 QUBIUS_START_PRIMARY / QUBIUS_START_SECONDARY 决定（默认都启动）。
# - QUBIUS_START_LAN=0 时不管理局域网入口（只做本机部署；已在运行的代理不停止）。
# - flock 串行化（QUBIUS_DEPLOY_LOCK），与安装脚本共用同一把锁。
# - 按 server/dist/build.json 的 head 与当前 git HEAD 决定是否调用 deploy/build.sh。
# - 用各实例数据目录下的 qubius.pid 停止；pidfile 缺失/陈旧时退回 ss 查找监听进程。
#   停止后端口仍被占用则拒绝启动新版本。
# - 启动后校验：监听 PID == pidfile、/api/health 为 200、
#   如果 health 带 head 字段则必须等于当前 git HEAD。
# - 每个实例的内网入口分别判断、分别启动，并分别检查 LAN 端口。
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
qubius_load

NODE_BIN=$(qubius_resolve_node)
export PATH="$(dirname "$NODE_BIN"):$PATH"

RESTART=0
STOP=0
for arg in "$@"; do
  case $arg in
    --restart) RESTART=1 ;;
    --stop) STOP=1 ;;
    -h|--help) echo "用法：$0 [--restart|--stop]"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done
if (( STOP && RESTART )); then
  echo "--stop 和 --restart 不能同时使用" >&2
  exit 2
fi

for cmd in curl ss git flock pgrep sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || qubius_die "缺少命令：$cmd"
done

UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user

# ── 角色信息：目录/数据目录/端口/开关都来自 lib 的默认值 ─────────────────────
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
  if [[ -d ${ROLE_REPO[$role]} ]]; then
    # 用物理路径，才能和 /proc/<pid>/cwd（readlink 已解析符号链接）直接比较。
    ROLE_REPO[$role]=$(cd "${ROLE_REPO[$role]}" && pwd -P)
  fi
done

role_enabled() {
  case $1 in
    primary) [[ $QUBIUS_START_PRIMARY == 1 ]] ;;
    secondary) [[ $QUBIUS_START_SECONDARY == 1 ]] ;;
    *) return 1 ;;
  esac
}

# 当前角色用 lib 派生的 unit 名，另一个角色用固定名。
role_service() {
  if [[ $1 == "$QUBIUS_ROLE" ]]; then
    printf '%s\n' "$QUBIUS_SERVICE"
  elif [[ $1 == primary ]]; then
    printf '%s\n' qubius.service
  else
    printf '%s\n' co-qubius.service
  fi
}

role_proxy_service() {
  if [[ $1 == "$QUBIUS_ROLE" ]]; then
    printf '%s\n' "$QUBIUS_PROXY_SERVICE"
  elif [[ $1 == primary ]]; then
    printf '%s\n' qubius-proxy.service
  else
    printf '%s\n' co-qubius-proxy.service
  fi
}

# systemd 已接管时不要手工 kill + setsid，否则 unit 会变成 inactive/重启循环。
unit_enabled() {
  local unit=$1 link
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user is-enabled "$unit" >/dev/null 2>&1 && return 0
    # 已被 disable 但仍在运行的 unit 也不能手工接管。
    systemctl --user is-active "$unit" >/dev/null 2>&1 && return 0
  fi
  # cron/@reboot 下没有用户总线，用 default.target.wants 等符号链接兜底。
  if [[ -L $UNIT_DIR/$unit && $(readlink "$UNIT_DIR/$unit") == /dev/null ]]; then
    return 1
  fi
  for link in "$UNIT_DIR"/*.wants/"$unit"; do
    [[ -e $link ]] && return 0
  done
  return 1
}

any_unit_enabled() {
  local role
  for role in primary secondary; do
    role_enabled "$role" || continue
    unit_enabled "$(role_service "$role")" && return 0
    unit_enabled "$(role_proxy_service "$role")" && return 0
  done
  return 1
}

if any_unit_enabled; then
  echo "检测到 systemd user unit 已启用（可能只启用了一部分）：" >&2
  echo "请用 systemctl --user stop/restart 管理；构建请显式传仓库目录：" >&2
  echo "  ${ROLE_REPO[primary]}/deploy/build.sh ${ROLE_REPO[primary]}" >&2
  echo "  ${ROLE_REPO[secondary]}/deploy/build.sh ${ROLE_REPO[secondary]}" >&2
  exit 1
fi

health_code() {
  curl -sS -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/api/health" 2>/dev/null || true
}

healthy() {
  [[ $(health_code "$1") == 200 ]]
}

# 监听 127.0.0.1:$port 的进程 PID（node 服务）。
listener_pid() {
  local port=$1
  ss -ltnp "sport = :$port" 2>/dev/null \
    | grep -F "127.0.0.1:$port" \
    | grep -oE 'pid=[0-9]+' \
    | head -n 1 \
    | cut -d= -f2 || true
}

# 端口上是否有回环监听（区别于 lan-proxy 绑定的 LAN 地址）。
loopback_listening() {
  local port=$1
  ss -H -ltn "sport = :$port" 2>/dev/null \
    | awk '{print $4}' \
    | grep -qE '^(127\.|\[::1\]:|\[::ffff:127\.)' || return 1
}

# 端口上是否有非回环监听（lan-proxy 绑定的 LAN 地址）。
lan_listening() {
  local port=$1
  ss -H -ltn "sport = :$port" 2>/dev/null \
    | awk -v p=":$port" '$4 ~ p && $4 !~ /^(127\.|\[::1\]:|\[::ffff:127\.)/ { found = 1 } END { exit found ? 0 : 1 }'
}

lan_listener_pid() {
  local port=$1
  ss -ltnp "sport = :$port" 2>/dev/null \
    | awk -v p=":$port" '$4 ~ p && $4 !~ /^(127\.|\[::1\]:|\[::ffff:127\.)/ { print }' \
    | grep -oE 'pid=[0-9]+' \
    | head -n 1 \
    | cut -d= -f2 || true
}

escape_regex() {
  printf '%s\n' "$1" | sed 's/[][\\.^$*+?(){}|]/\\&/g'
}

# 找属于该实例的 lan-proxy 进程（node 或还在启动的包装脚本）。
# 新进程带 QUBIUS_SECONDARY/QUBIUS_REPO_DIR；旧进程可能只有 LAN_PROXY_PORT。
proxy_pid_for_port() {
  local flag=$1 repo=$2 port=$3 pid pattern envs
  local -a patterns
  patterns=(
    "lan-proxy\\.mjs"
    "lan-proxy\\.sh"
  )
  for pattern in "${patterns[@]}"; do
    while IFS= read -r pid; do
      [[ -n $pid ]] || continue
      envs=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null || true)
      if printf '%s\n' "$envs" | grep -qx "QUBIUS_SECONDARY=$flag" \
        && printf '%s\n' "$envs" | grep -qx "QUBIUS_REPO_DIR=$repo"; then
        printf '%s\n' "$pid"
        return 0
      fi
      if printf '%s\n' "$envs" | grep -qx "LAN_PROXY_PORT=$port"; then
        printf '%s\n' "$pid"
        return 0
      fi
    done < <(pgrep -f "$pattern" 2>/dev/null || true)
  done
  return 0
}

stamp_head() {
  local file=$1
  [[ -f $file ]] || return 0
  "$NODE_BIN" -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (typeof j.head === "string") process.stdout.write(j.head);
    } catch {}
  ' "$file" 2>/dev/null || true
}

# 构建时工作区有未提交改动则返回 0（需要重新构建）。
stamp_dirty() {
  local file=$1
  [[ -f $file ]] || return 1
  "$NODE_BIN" -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(j.dirty === true ? 0 : 1);
    } catch { process.exit(1); }
  ' "$file" 2>/dev/null
}

# 需要重新 npm ci 时返回 0（node_modules 缺失或 package-lock 哈希变化）。
needs_install() {
  local repo=$1
  local hash_file=$repo/node_modules/.qubius-lock-hash
  local hash
  [[ -d $repo/node_modules ]] || return 0
  hash=$(sha256sum "$repo/package-lock.json" | awk '{print $1}')
  if [[ -f $hash_file && $(cat "$hash_file" 2>/dev/null) == "$hash" ]]; then
    return 1
  fi
  return 0
}

# 需要构建时返回 0。
needs_build() {
  local repo=$1 head stamp
  [[ -f $repo/server/dist/index.js && -f $repo/web/dist/index.html ]] || return 0
  [[ -d $repo/node_modules ]] || return 0
  head=$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)
  [[ -n $head ]] || return 0
  # 依赖标记缺失/过期也要通过 build.sh 重新安装。
  if needs_install "$repo"; then return 0; fi
  # 只看源码/构建输入；未跟踪的新文件也要算，文档/部署脚本改动不算。
  if [[ -n $(git -C "$repo" status --porcelain --untracked-files=normal -- \
    server web package.json package-lock.json 2>/dev/null) ]]; then
    return 0
  fi
  # 构建时工作区是脏的，说明产物可能落后于当前源码。
  stamp_dirty "$repo/server/dist/build.json" && return 0
  stamp=$(stamp_head "$repo/server/dist/build.json")
  [[ $stamp == "$head" ]] || return 0
  return 1
}

stop_instance() {
  local name=$1 port=$2 pidfile=$3 repo=$4 pid="" cwd lpid
  if [[ -f $pidfile ]]; then
    pid=$(head -n 1 "$pidfile" 2>/dev/null | tr -dc '0-9' || true)
  fi
  if [[ -n $pid ]]; then
    if ! kill -0 "$pid" 2>/dev/null; then
      pid=""
    elif ! grep -qa 'server/dist/index\.js' "/proc/$pid/cmdline" 2>/dev/null; then
      echo "警告：$name 的 pidfile 指向其他进程（pid=$pid），按陈旧 pidfile 处理" >&2
      pid=""
    else
      # 两个实例的 cmdline 相同；用进程 cwd 和端口监听 PID 共同确认归属。
      cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
      lpid=$(listener_pid "$port")
      if [[ -n $cwd && $cwd != "$repo" ]]; then
        echo "警告：$name 的 pidfile PID=$pid 的 cwd=$cwd 与实例 $repo 不符，按陈旧 pidfile 处理" >&2
        pid=""
      elif [[ -n $lpid && $pid != "$lpid" ]]; then
        echo "警告：$name 的 pidfile PID=$pid 与端口监听 PID=$lpid 不一致，按陈旧 pidfile 处理" >&2
        pid=""
      fi
    fi
  fi
  # pidfile 缺失或不可信时退回监听端口查找。
  if [[ -z $pid ]]; then
    pid=$(listener_pid "$port")
  fi
  if [[ -z $pid ]]; then
    rm -f "$pidfile"
    return 0
  fi

  echo "停止 $name（pid=$pid）"
  kill "$pid" 2>/dev/null || true
  local i
  for ((i = 0; i < 50; i++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pidfile"
      return 0
    fi
    sleep 0.2
  done
  echo "警告：$name 未在 10 秒内退出，强制结束 pid=$pid" >&2
  kill -9 "$pid" 2>/dev/null || true
  # 给内核一点时间真正释放监听 socket。
  for _ in $(seq 1 50); do
    if ! loopback_listening "$port"; then break; fi
    sleep 0.1
  done
  rm -f "$pidfile"
  return 0
}

stop_proxies() {
  local role port pid pattern busy
  (( ${#MANAGED[@]} )) || return 0
  for role in "${MANAGED[@]}"; do
    port=${ROLE_PORT[$role]}
    pattern="$(escape_regex "${ROLE_REPO[$role]}")/deploy/lan-proxy"
    pid=$(lan_listener_pid "$port")
    if [[ -n $pid ]]; then kill "$pid" 2>/dev/null || true; fi
    pkill -f "$pattern" 2>/dev/null || true
  done
  sleep 1
  for role in "${MANAGED[@]}"; do
    port=${ROLE_PORT[$role]}
    pattern="$(escape_regex "${ROLE_REPO[$role]}")/deploy/lan-proxy"
    pid=$(lan_listener_pid "$port")
    if [[ -n $pid ]]; then kill -9 "$pid" 2>/dev/null || true; fi
    pkill -9 -f "$pattern" 2>/dev/null || true
  done
  # SIGKILL 投递后给内核一点时间真正释放监听 socket。
  local _
  for _ in $(seq 1 20); do
    busy=0
    for role in "${MANAGED[@]}"; do
      lan_listening "${ROLE_PORT[$role]}" && busy=1
    done
    if (( busy == 0 )); then break; fi
    sleep 0.1
  done
  return 0
}

verify_pid() {
  local name=$1 port=$2 pidfile=$3 lpid fpid="" i
  lpid=$(listener_pid "$port")
  [[ -n $lpid ]] || { echo "$name：端口 $port 没有监听进程" >&2; return 1; }
  for ((i = 0; i < 20; i++)); do
    [[ -s $pidfile ]] && break
    sleep 0.1
  done
  if [[ ! -s $pidfile ]]; then
    echo "$name：缺少 pidfile $pidfile（可能是旧版本进程，请用 --restart）" >&2
    return 1
  fi
  fpid=$(head -n 1 "$pidfile" | tr -dc '0-9' || true)
  if [[ $fpid != "$lpid" ]]; then
    echo "$name：pidfile=$fpid 与监听 PID=$lpid 不一致" >&2
    return 1
  fi
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

verify_head() {
  local name=$1 port=$2 repo=$3 hh cur
  hh=$(health_head "$port")
  # 旧构建可能没有 head（build.json 不存在）；无法校验时放行。
  [[ -n $hh ]] || return 0
  cur=$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)
  [[ -n $cur ]] || { echo "$name：无法读取 $repo 的 git HEAD" >&2; return 1; }
  if [[ $hh != "$cur" ]]; then
    echo "$name：health 的 head=$hh 与当前 git HEAD=$cur 不一致（构建后未重启？试试 --restart）" >&2
    return 1
  fi
}

start_instance() {
  local name=$1 role=$2 port=$3 repo=$4 script=$5 log=$6 pidfile=$7 i
  if healthy "$port"; then
    echo "$name 已在运行"
  else
    if loopback_listening "$port"; then
      echo "$name：端口 $port 被占用但 /api/health 不通（旧进程可能卡住，请用 --restart）" >&2
      return 1
    fi
    echo "启动 $name"
    # 显式带上角色开关和仓库目录；9>&- 防止长驻进程继承部署锁。
    # 去掉 ops lock 标记避免长驻进程被当成残留；QUBIUS_ENV 让 server 读到实际 env 文件。
    local -a launch_env=(
      QUBIUS_SECONDARY="${ROLE_FLAG[$role]}"
      QUBIUS_REPO_DIR="$repo"
    )
    if [[ -n ${QUBIUS_ENV_FILE:-} ]]; then
      launch_env+=(QUBIUS_ENV="$QUBIUS_ENV_FILE")
    fi
    setsid env -u QUBIUS_OPS_ROOT -u QUBIUS_OPS_TOKEN -u QUBIUS_OPS_JOB \
      "${launch_env[@]}" "$script" >> "$log" 2>&1 < /dev/null 6>&- 9>&- &
  fi

  for ((i = 0; i < 120; i++)); do
    healthy "$port" && break
    sleep 0.5
  done
  if ! healthy "$port"; then
    echo "$name：启动后 /api/health 未就绪（HTTP $(health_code "$port")），查看 $log" >&2
    return 1
  fi
  verify_pid "$name" "$port" "$pidfile" || return 1
  verify_head "$name" "$port" "$repo" || return 1
}

ensure_proxy() {
  local role=$1 name=${ROLE_LABEL[$1]} repo=${ROLE_REPO[$1]} port=${ROLE_PORT[$1]}
  local flag=${ROLE_FLAG[$1]} script=${ROLE_REPO[$1]}/deploy/lan-proxy.sh
  local log=${ROLE_DATA[$1]}/lan-proxy.log pid i
  pid=$(proxy_pid_for_port "$flag" "$repo" "$port")
  if [[ -z $pid ]]; then
    if lan_listening "$port"; then
      echo "$name：LAN 端口 $port 已被其他进程占用（升级旧代理时请用 --restart）" >&2
      return 1
    fi
    echo "启动 $name LAN 入口（LAN 端口 $port）"
    QUBIUS_SECONDARY=$flag QUBIUS_REPO_DIR=$repo \
      setsid env -u QUBIUS_OPS_ROOT -u QUBIUS_OPS_TOKEN -u QUBIUS_OPS_JOB \
      "$script" >> "$log" 2>&1 < /dev/null 6>&- 9>&- &
  else
    echo "$name LAN 入口已在运行（pid=$pid）"
  fi

  # lan-proxy.sh 启动时会在网络未就绪时重试最多 120 秒，这里要等得比它久。
  for ((i = 0; i < 260; i++)); do
    lan_listening "$port" && break
    sleep 0.5
  done
  if ! lan_listening "$port"; then
    echo "$name：LAN 端口 $port 未在监听，查看 $log" >&2
    return 1
  fi
}

# 单实例：按需“停 → 构建 → 启动”。构建失败只影响该实例，不阻塞另一个。
manage_instance() {
  local role=$1 name=${ROLE_LABEL[$1]} repo=${ROLE_REPO[$1]}
  local port=${ROLE_PORT[$1]} data=${ROLE_DATA[$1]}
  local script=$repo/deploy/run.sh build=$repo/deploy/build.sh
  local log=$data/qubius.log pidfile=$data/qubius.pid
  local need=0 stopped=0 built_ok=1
  if needs_build "$repo"; then need=1; fi
  # npm ci 会删除 node_modules，必须等旧进程退出后再安装。
  if (( need )) && needs_install "$repo"; then
    stop_instance "$name" "$port" "$pidfile" "$repo" || true
    stopped=1
  fi
  if (( need )); then
    echo "构建 $name（build stamp 缺失或与当前 HEAD 不一致）"
    if ! QUBIUS_SECONDARY=${ROLE_FLAG[$role]} QUBIUS_REPO_DIR=$repo "$build" "$repo" 9>&-; then
      echo "$name：构建失败" >&2
      FAILED=1
      built_ok=0
    fi
  fi
  if (( built_ok == 0 )); then
    if (( stopped )); then
      echo "$name：已停止，修复构建后重新运行 start-all" >&2
    fi
    return 0
  fi
  if (( stopped == 0 )) && (( RESTART || need )); then
    stop_instance "$name" "$port" "$pidfile" "$repo" || true
    stopped=1
  fi
  if (( stopped )) && loopback_listening "$port"; then
    echo "$name：停止后端口 $port 仍被占用，拒绝启动新版本" >&2
    FAILED=1
    return 0
  fi
  start_instance "$name" "$role" "$port" "$repo" "$script" "$log" "$pidfile" || FAILED=1
}

mkdir -p "$QUBIUS_DATA_PRIMARY" "$QUBIUS_DATA_SECONDARY"
mkdir -p "$(dirname "$QUBIUS_DEPLOY_LOCK")"

# 任一组件失败都继续处理其余组件，最后统一返回非零。
FAILED=0
MANAGED=()

# 先确定要处理的角色；两个角色都关闭的 no-op 不应 claim ops lock / 因锁忙失败。
for role in primary secondary; do
  name=${ROLE_LABEL[$role]}
  if ! role_enabled "$role"; then
    echo "跳过 $name（启动开关已关闭）" >&2
    continue
  fi
  repo=${ROLE_REPO[$role]}
  if [[ ! -d $repo ]]; then
    # 明确要求启动的角色缺失目录不能静默成功（@reboot 会少起实例）。
    qubius_warn "$name：仓库目录不存在，跳过该角色：$repo"
    FAILED=1
    continue
  fi
  missing=0
  required=("$repo/deploy/build.sh" "$repo/deploy/run.sh")
  if (( QUBIUS_START_LAN )); then
    required+=("$repo/deploy/lan-proxy.sh")
  fi
  for f in "${required[@]}"; do
    if [[ ! -x $f ]]; then
      qubius_warn "$name：缺少或不可执行 $f，跳过该角色"
      missing=1
    fi
  done
  if (( missing )); then
    FAILED=1
    continue
  fi
  MANAGED+=("$role")
done

if (( ${#MANAGED[@]} > 0 )); then
  # 手工执行/@reboot 时参与部署页同一把 ops lock；被 deploy-job 调用时已有 token，
  # 自动跳过。必须在构建/停止进程和 deploy.lock 之前取得。
  qubius_ops_claim deploy
fi

# 与安装脚本共用同一把锁，串行化部署/重启。
exec 9>"$QUBIUS_DEPLOY_LOCK"
flock -w 600 9 || { echo "等待部署锁超时：$QUBIUS_DEPLOY_LOCK 被其他任务占用" >&2; exit 1; }

# --stop：只停止，不构建、不启动。和 --restart 共用部署锁/ops lock，
# 避免在部署过程中被另一个进程停掉。
if (( STOP )); then
  if (( ${#MANAGED[@]} == 0 )); then
    echo "没有需要停止的实例（检查 QUBIUS_START_PRIMARY / QUBIUS_START_SECONDARY）" >&2
    exit 0
  fi
  stop_proxies
  for role in "${MANAGED[@]}"; do
    stop_instance "${ROLE_LABEL[$role]}" "${ROLE_PORT[$role]}" \
      "${ROLE_DATA[$role]}/qubius.pid" "${ROLE_REPO[$role]}"
  done
  echo "已停止：${MANAGED[*]}"
  exit 0
fi

for role in "${MANAGED[@]}"; do
  manage_instance "$role"
done

if (( RESTART && QUBIUS_START_LAN )); then
  stop_proxies
  for role in "${MANAGED[@]}"; do
    if lan_listening "${ROLE_PORT[$role]}"; then
      echo "停止后 LAN 端口 ${ROLE_PORT[$role]} 仍被占用，拒绝启动新入口" >&2
      exit 1
    fi
  done
fi

if (( QUBIUS_START_LAN )); then
  for role in "${MANAGED[@]}"; do
    ensure_proxy "$role" || FAILED=1
  done
else
  echo "跳过局域网入口（QUBIUS_START_LAN=0）" >&2
fi

if (( FAILED )); then
  echo "至少一个组件未就绪，请查看各实例数据目录下的日志" >&2
  exit 1
fi

if (( ${#MANAGED[@]} == 0 )); then
  echo "没有启动任何实例（检查 QUBIUS_START_PRIMARY / QUBIUS_START_SECONDARY 和仓库目录）" >&2
else
  summary=""
  for role in "${MANAGED[@]}"; do
    port=${ROLE_PORT[$role]}
    if (( QUBIUS_START_LAN )); then
      summary+="${ROLE_LABEL[$role]} http://127.0.0.1:$port（LAN $port）; "
    else
      summary+="${ROLE_LABEL[$role]} http://127.0.0.1:$port; "
    fi
  done
  echo "已就绪：${summary%; }"
fi
