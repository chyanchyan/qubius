#!/bin/bash
# qubius 部署任务（由 server 以 detached 方式启动）。
#
# 只读取环境变量，不把任何用户输入拼进脚本本体，避免命令注入。
# 部署会注销当前 server（start-all.sh 会停掉它），所以本脚本必须脱离
# server 进程运行；status/log 通过 QUBIUS_DEPLOY_STATUS / QUBIUS_DEPLOY_LOG 指定。
set -uo pipefail

STATUS=${QUBIUS_DEPLOY_STATUS:?缺少 QUBIUS_DEPLOY_STATUS}
LOG=${QUBIUS_DEPLOY_LOG:?缺少 QUBIUS_DEPLOY_LOG}
JOB_ID=${QUBIUS_DEPLOY_JOB_ID:-}
STARTED_AT=${QUBIUS_DEPLOY_STARTED_AT:-}
PARENT_PID=${QUBIUS_DEPLOY_PARENT_PID:-}
PRIMARY_DIR=${QUBIUS_PRIMARY_DIR:-}
SECONDARY_DIR=${QUBIUS_SECONDARY_DIR:-}
SECONDARY_REPO_URL=${QUBIUS_SECONDARY_REPO_URL:-}
DEPLOY_REPO_ROOT=${QUBIUS_DEPLOY_REPO_ROOT:-$(cd -- "$(dirname -- "$0")/.." && pwd -P)}
START_PRIMARY=${QUBIUS_START_PRIMARY:-0}
START_SECONDARY=${QUBIUS_START_SECONDARY:-0}
CLONE_PEER=${QUBIUS_CLONE_PEER:-0}
PULL_LATEST=${QUBIUS_PULL_LATEST:-0}
ENV_FILE=${QUBIUS_ENV:-}
OPS_ROOT=${QUBIUS_OPS_ROOT:-}
OPS_TOKEN=${QUBIUS_OPS_TOKEN:-}
OPS_JOB=${QUBIUS_OPS_JOB:-$JOB_ID}
OPS_SCRIPT=${QUBIUS_OPS_LOCK_SCRIPT:-$DEPLOY_REPO_ROOT/deploy/ops-lock.sh}
PULL_SCRIPT=${QUBIUS_DEPLOY_PULL_SCRIPT:-$DEPLOY_REPO_ROOT/deploy/pull-latest.sh}
# 部署必须走 ops lock；没有标记时拒绝启动，避免无锁并发。
: "${OPS_ROOT:?缺少 QUBIUS_OPS_ROOT（部署必须走 ops lock）}"
: "${OPS_TOKEN:?缺少 QUBIUS_OPS_TOKEN}"

# ── 自我复制：拉取代码可能重写正在执行的脚本 ────────────────────────────────
# deploy/ 属于被部署的 checkout。Bash 边执行边读脚本文件，拉取后直接覆盖
# deploy-job.sh 可能读到半截内容；开启拉取时先 exec 临时目录里的副本。
if [[ $PULL_LATEST == 1 && ${QUBIUS_DEPLOY_REEXEC:-0} != 1 ]]; then
  SELF_DIR=$(mktemp -d "${TMPDIR:-/tmp}/qubius-deploy.XXXXXX") || {
    printf 'qubius: 无法创建临时目录，无法安全拉取代码\n' >&2
    exit 1
  }
  if ! cp -- "$0" "$SELF_DIR/deploy-job.sh"; then
    rm -rf -- "$SELF_DIR"
    exit 1
  fi
  export QUBIUS_DEPLOY_REEXEC=1 QUBIUS_DEPLOY_SELF_DIR=$SELF_DIR
  export QUBIUS_DEPLOY_REPO_ROOT=$DEPLOY_REPO_ROOT
  exec bash "$SELF_DIR/deploy-job.sh" "$@"
fi
# 副本在任务结束时删除；finalize 里还会再删一次。
if [[ -n ${QUBIUS_DEPLOY_SELF_DIR:-} ]]; then
  trap 'rm -rf -- "$QUBIUS_DEPLOY_SELF_DIR"' EXIT
fi

mkdir -p "$(dirname "$STATUS")" "$(dirname "$LOG")" 7>&- || exit 1

# 仓库 URL 可能带 user:pass，日志里统一脱敏。
redact_url() {
  printf '%s\n' "$1" | sed -E 's#(://)[^/@[:space:]]+@#\1***@#' 7>&-
}

say() {
  printf '%s\n' "$(redact_url "$*")" >>"$LOG" 2>/dev/null || true
}

# 执行命令并把输出脱敏后追加到日志（git 报错可能回显带凭据的 URL）。
run_redacted() {
  local tmp rc
  tmp=$(mktemp 7>&-) || {
    say "无法创建临时文件，跳过命令输出记录"
    return 1
  }
  "$@" >"$tmp" 2>&1 7>&-
  rc=$?
  sed -E 's#(://)[^/@[:space:]]+@#\1***@#' "$tmp" 7>&- >>"$LOG"
  rm -f "$tmp" 7>&-
  return "$rc"
}

install_checkout() {
  local dir=$1 role=$2
  # 克隆只由本任务负责；明确关掉，避免 install.sh 再去克隆对端。
  ( cd "$dir" && QUBIUS_SECONDARY=$role QUBIUS_CLONE_PEER=0 QUBIUS_REPO_DIR="$dir" \
    ./deploy/install.sh --force-config 7>&- )
}

start_all_at() {
  ( cd "$1" && ./deploy/start-all.sh --restart 7>&- )
}

# 构建前从 origin 快进拉取当前分支；pull-latest.sh 只快进，不覆盖本地改动。
pull_checkout() {
  local dir=$1 role=$2 label=$3
  say "拉取${label}最新代码：$dir"
  write_status running "pull-$role" "正在拉取${label}最新代码"
  if ! run_redacted bash "$PULL_SCRIPT" "$dir"; then
    fail "pull-$role" "${label}拉取最新代码失败（工作区有改动、无法快进或远端不可用，详见部署日志）"
  fi
}

# 状态/时间契约见 server/src/job-state.ts：状态只用 running/success/failed，
# 时间戳为秒精度 UTC（date -u +%Y-%m-%dT%H:%M:%SZ）。
# 固定中文文案，不含引号/反斜杠，printf 生成合法 JSON；tmp+mv 原子写。
write_status() {
  local state=$1 step=$2 message=$3 finished='null' tmp
  if [[ $state != running ]]; then
    finished="\"$(date -u +%Y-%m-%dT%H:%M:%SZ 7>&-)\""
  fi
  tmp="${STATUS}.tmp.$$"
  printf '{"jobId":"%s","state":"%s","step":"%s","message":"%s","pid":%s,"startedAt":"%s","finishedAt":%s}\n' \
    "$JOB_ID" "$state" "$step" "$message" "$$" "$STARTED_AT" "$finished" >"$tmp" \
    && mv -f "$tmp" "$STATUS" 7>&-
}

fail() {
  local step=$1 message=$2
  say "失败：$message"
  write_status failed "$step" "$message"
  exit 1
}

# ── ops lock：跨 job 权威锁 ──────────────────────────────────────────────────
# 由 server 先 claim 出 pending；脚本持 flock 后 mark running，独占运行。
# 所有子进程都必须 7>&-，避免 install/start-all/git clone 意外持锁。
OPS_LOCKED=0

ops_mark() {
  local state=$1
  [[ -n $OPS_ROOT && -f $OPS_SCRIPT ]] || return 0
  bash "$OPS_SCRIPT" mark --root "$OPS_ROOT" --state "$state" --kind deploy \
    --job-id "$OPS_JOB" --token "$OPS_TOKEN" 7>&- >/dev/null 2>&1 || true
}

stop_children() {
  command -v pkill >/dev/null 2>&1 || return 0
  pkill -TERM -P "$$" 2>/dev/null 7>&- || true
  local i
  for i in {1..10}; do
    command -v pgrep >/dev/null 2>&1 || break
    pgrep -P "$$" >/dev/null 2>&1 7>&- || break
    sleep 0.1 2>/dev/null 7>&- || true
  done
  pkill -KILL -P "$$" 2>/dev/null 7>&- || true
}

finalize() {
  local rc=$?
  trap - EXIT INT TERM
  # 先停掉仍在运行的子进程（install/start-all 等），再 mark 终态并关 fd。
  stop_children
  if [[ $OPS_LOCKED -eq 1 ]]; then
    if [[ $rc -eq 0 ]]; then ops_mark success; else ops_mark failed; fi
  fi
  [[ -n ${QUBIUS_DEPLOY_SELF_DIR:-} ]] && rm -rf -- "$QUBIUS_DEPLOY_SELF_DIR" 2>/dev/null
  exec 7>&- 2>/dev/null || true
  exit "$rc"
}

mkdir -p "$OPS_ROOT" 7>&- || exit 1
exec 7<>"$OPS_ROOT/ops.lock" || exit 1
if ! flock -n 7; then
  say "ops lock 被占用，退出"
  exit 3
fi
OPS_LOCKED=1
PGID=$(ps -o pgid= -p $$ 2>/dev/null 7>&- | tr -d ' ' 7>&-)
MARK_ARGS=(--root "$OPS_ROOT" --state running --kind deploy --job-id "$OPS_JOB" --token "$OPS_TOKEN" --pid "$$")
[[ -n $PGID ]] && MARK_ARGS+=(--pgid "$PGID")
bash "$OPS_SCRIPT" mark "${MARK_ARGS[@]}" 7>&- >/dev/null 2>&1 || true
trap finalize EXIT
trap 'exit 130' INT TERM

say "部署配置：env=${ENV_FILE:-未指定}"
write_status running prepare "准备部署"

# ── systemd 接管检测：与 start-all.sh 的 any_unit_enabled 一致 ────────────────
# 只检查本次启用的角色；is-enabled/is-active/wants 链接任一成立都说明
# systemd 在管理它，此时不擅自停进程。
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
unit_enabled() {
  local unit=$1 link
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user is-enabled "$unit" >/dev/null 2>&1 7>&- && return 0
    systemctl --user is-active "$unit" >/dev/null 2>&1 7>&- && return 0
  fi
  if [[ -L $UNIT_DIR/$unit && $(readlink "$UNIT_DIR/$unit" 7>&-) == /dev/null ]]; then
    return 1
  fi
  for link in "$UNIT_DIR"/*.wants/"$unit"; do
    [[ -e $link ]] && return 0
  done
  return 1
}
UNITS=()
if [[ $START_PRIMARY == 1 ]]; then
  UNITS+=(qubius.service qubius-proxy.service)
fi
if [[ $START_SECONDARY == 1 ]]; then
  UNITS+=(co-qubius.service co-qubius-proxy.service)
fi
for unit in ${UNITS[@]+"${UNITS[@]}"}; do
  if unit_enabled "$unit"; then
    say "检测到 systemd 已接管（$unit），不停止任何进程"
    write_status failed systemd "检测到 systemd 已接管，请在终端用 systemctl --user restart 应用新配置"
    exit 1
  fi
done

if [[ $PULL_LATEST == 1 && ! -f $PULL_SCRIPT ]]; then
  fail prepare "找不到拉取脚本：$PULL_SCRIPT"
fi

# ── 主实例：拉取最新代码（可选），再用新配置安装 ─────────────────────────────
if [[ $START_PRIMARY == 1 ]]; then
  if [[ $PULL_LATEST == 1 ]]; then
    pull_checkout "$PRIMARY_DIR" primary "主实例"
  fi
  say "安装主实例：$PRIMARY_DIR"
  write_status running install-primary "正在安装主实例"
  if ! run_redacted install_checkout "$PRIMARY_DIR" 0; then
    fail install-primary "主实例安装失败"
  fi
fi

# ── 副实例：目录缺失或没有 install.sh 时按需克隆，然后安装 ───────────────────
if [[ $START_SECONDARY == 1 ]]; then
  if [[ ! -x $SECONDARY_DIR/deploy/install.sh ]]; then
    if [[ $CLONE_PEER == 1 ]]; then
      say "克隆副实例仓库：$SECONDARY_REPO_URL -> $SECONDARY_DIR"
      write_status running clone "正在克隆副实例仓库"
      # git clone 不会自动创建父目录；目录已存在且非空时 clone 会失败并进入失败状态。
      mkdir -p "$(dirname "$SECONDARY_DIR")" 2>/dev/null 7>&- || true
      if ! run_redacted env GIT_TERMINAL_PROMPT=0 git clone -- "$SECONDARY_REPO_URL" "$SECONDARY_DIR"; then
        fail clone "副实例仓库克隆失败"
      fi
    else
      fail clone "副实例目录不存在或缺少 deploy/install.sh，且未启用克隆"
    fi
  fi
  if [[ ! -x $SECONDARY_DIR/deploy/install.sh ]]; then
    fail install-secondary "副实例仓库缺少可执行的 deploy/install.sh"
  fi
  if [[ $PULL_LATEST == 1 ]]; then
    pull_checkout "$SECONDARY_DIR" secondary "副实例"
  fi
  say "安装副实例：$SECONDARY_DIR"
  write_status running install-secondary "正在安装副实例"
  if ! run_redacted install_checkout "$SECONDARY_DIR" 1; then
    fail install-secondary "副实例安装失败"
  fi
fi

# ── 停止当前 server：start-all 会重新拉起新版本 ──────────────────────────────
# 只停真正的 qubius server；如果它属于本次未启用的角色，也不停（否则会关掉
# 一个不会再被拉起的实例）。无法确认身份时宁可不杀。
if [[ -n $PARENT_PID ]] && kill -0 "$PARENT_PID" 2>/dev/null; then
  CMDLINE=$(tr '\0' ' ' <"/proc/$PARENT_PID/cmdline" 2>/dev/null 7>&- || true)
  PARENT_CWD=$(readlink "/proc/$PARENT_PID/cwd" 2>/dev/null 7>&- || true)
  # environ 里没有 QUBIUS_SECONDARY 时按主实例处理（旧版本/手工启动）。
  PARENT_ROLE=primary
  if tr '\0' '\n' <"/proc/$PARENT_PID/environ" 2>/dev/null 7>&- | grep -qx 'QUBIUS_SECONDARY=1' 7>&-; then
    PARENT_ROLE=secondary
  fi
  IS_SERVER=0
  case $CMDLINE in
    *"server/dist/index.js"*) IS_SERVER=1 ;;
    *"dist/index.js"*)
      # npm start -w server 的 cmdline 是 `node dist/index.js`，需用 cwd 确认身份。
      if [[ -n $PARENT_CWD ]]; then
        # 表单目录之外也接受本次 server 的 repoRoot（worktree/bootstrap checkout）。
        for repo in "$PRIMARY_DIR" "$SECONDARY_DIR" "$DEPLOY_REPO_ROOT"; do
          [[ -n $repo ]] || continue
          REPO_PHYS=$(cd "$repo" 2>/dev/null && pwd -P) || REPO_PHYS=$repo
          if [[ $PARENT_CWD == "$repo" || $PARENT_CWD == "$REPO_PHYS" \
            || $PARENT_CWD == "$repo/server" || $PARENT_CWD == "$REPO_PHYS/server" ]]; then
            IS_SERVER=1
            break
          fi
        done
      fi
      ;;
  esac
  if (( ! IS_SERVER )); then
    say "父进程 $PARENT_PID 不是 qubius server，不停止：$CMDLINE（cwd=${PARENT_CWD:-未知}）"
  elif [[ $PARENT_ROLE == primary && $START_PRIMARY != 1 ]] \
    || [[ $PARENT_ROLE == secondary && $START_SECONDARY != 1 ]]; then
    say "父进程属于本次未启用的实例（$PARENT_ROLE），不停止"
  else
    say "停止当前服务进程 $PARENT_PID"
    write_status running stop "正在停止当前服务"
    kill -TERM "$PARENT_PID" 2>/dev/null 7>&- || true
    for _ in {1..20}; do
      kill -0 "$PARENT_PID" 2>/dev/null 7>&- || break
      sleep 0.5 7>&- || true
    done
    if kill -0 "$PARENT_PID" 2>/dev/null 7>&-; then
      say "进程 $PARENT_PID 未在 10 秒内退出，发送 SIGKILL"
      kill -KILL "$PARENT_PID" 2>/dev/null 7>&- || true
    fi
  fi
fi

# ── 重启：主实例优先 ────────────────────────────────────────────────────────
if [[ $START_PRIMARY == 1 ]]; then
  START_DIR=$PRIMARY_DIR
else
  START_DIR=$SECONDARY_DIR
fi
say "重启服务：$START_DIR/deploy/start-all.sh --restart"
write_status running start "正在重启服务"
if ! run_redacted start_all_at "$START_DIR"; then
  fail start "重启服务失败"
fi

write_status success done "部署完成"
say "部署完成"
exit 0
