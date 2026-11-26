#!/bin/bash
# 副实例维护：sync 从主实例拉取已验收的 main 并重新部署；rollback 回到上一次同步前的版本。
# 由副实例的 /api/secondary/sync 和 /api/secondary/rollback 调用，也可以手动运行：
#   QUBIUS_REPO_DIR=... QUBIUS_DATA_DIR=... QUBIUS_PORT=... \
#   QUBIUS_PRIMARY_DIR=... QUBIUS_RESTART=... ./secondary.sh sync
#
# Linux 依赖 flock/setsid/ss；在 Windows（Git Bash/MSYS）上它们通常不存在，脚本会降级：
# 不加锁、用 nohup 启动、用 netstat + taskkill 找和停进程。降级只保证单机手工/页面
# 操作能跑通，不提供 Linux 上用 flock 保证的并发互斥。
#
# 兼容旧部署：server 同时传 QUBIUS_* 和新旧两套变量，这里优先 QUBIUS_*，RC_* 回退。
set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# 先保存调用者显式传入的 QUBIUS_*，qubius_load 之后再用它们覆盖派生的默认值。
RAW_QUBIUS_REPO_DIR=${QUBIUS_REPO_DIR:-}
RAW_QUBIUS_DATA_DIR=${QUBIUS_DATA_DIR:-}
RAW_QUBIUS_PORT=${QUBIUS_PORT:-}
RAW_QUBIUS_PEER_DIR=${QUBIUS_PEER_DIR:-}
RAW_QUBIUS_PRIMARY_DIR=${QUBIUS_PRIMARY_DIR:-}
RAW_QUBIUS_PRIMARY_REF=${QUBIUS_PRIMARY_REF:-}
RAW_QUBIUS_RESTART=${QUBIUS_RESTART:-}
RAW_QUBIUS_STATUS_FILE=${QUBIUS_STATUS_FILE:-}
RAW_QUBIUS_SECONDARY_LOG=${QUBIUS_SECONDARY_LOG:-}
RAW_QUBIUS_SERVER_LOG=${QUBIUS_SERVER_LOG:-}
RAW_QUBIUS_DEPLOY_LOCK=${QUBIUS_DEPLOY_LOCK:-}
RAW_QUBIUS_SERVICE=${QUBIUS_SERVICE:-}

# 本脚本只维护副实例；未显式指定角色时按副实例处理。
export QUBIUS_SECONDARY=${QUBIUS_SECONDARY:-1}
qubius_load
# qubius_load 已把 false/off/no/0 归一成 0，这里用归一化后的值拒绝，避免按主实例路径操作。
if [[ $QUBIUS_SECONDARY != 1 ]]; then
  echo "secondary.sh 只用于副实例；请设置 QUBIUS_SECONDARY=1" >&2
  exit 1
fi
# secondary.sh 自己处理失败并写状态，不能被 lib 的 -e 提前终止。
set +e

GIT_TERMINAL_PROMPT=0
export GIT_TERMINAL_PROMPT

NODE_BIN=$(qubius_resolve_node) || exit 1
export PATH="$(dirname "$NODE_BIN"):$PATH"

ACTION=${1:-}
case "$ACTION" in
  sync|rollback) ;;
  *) echo "用法：$0 sync|rollback" >&2; exit 2 ;;
esac

REPO=${RAW_QUBIUS_REPO_DIR:-${RC_REPO:-$QUBIUS_REPO_DIR}}
DATA=${RAW_QUBIUS_DATA_DIR:-${RC_DATA:-$QUBIUS_DATA_DIR}}
PORT=${RAW_QUBIUS_PORT:-${RC_PORT:-$QUBIUS_PORT}}
PRIMARY_REPO=${RAW_QUBIUS_PEER_DIR:-${RAW_QUBIUS_PRIMARY_DIR:-${RC_PRIMARY_REPO:-$QUBIUS_PEER_DIR}}}
PRIMARY_REF=${RAW_QUBIUS_PRIMARY_REF:-${RC_PRIMARY_REF:-$QUBIUS_PRIMARY_REF}}
# server 可能传入 config 里默认的 <configDir>/run.sh（新安装不再把脚本装到配置目录），
# 不可执行时退回仓库内的 run.sh，避免停掉副实例后拉不起来。
RESTART=${RAW_QUBIUS_RESTART:-${RC_RESTART:-$REPO/deploy/run.sh}}
[[ -x $RESTART ]] || RESTART=$REPO/deploy/run.sh
# 状态和日志以生效的数据目录 $DATA 为基准，显式 QUBIUS_*/RC_* 仍然优先。
STATUS=${RAW_QUBIUS_STATUS_FILE:-${RC_STATUS:-$DATA/secondary.json}}
LOG=${RAW_QUBIUS_SECONDARY_LOG:-${RC_LOG:-$DATA/secondary.log}}
SERVER_LOG=${RAW_QUBIUS_SERVER_LOG:-${RC_SERVER_LOG:-$DATA/qubius.log}}
# 部署锁默认仍放在主实例数据目录（与 install/start-all 共用），也可用 QUBIUS_DEPLOY_LOCK/RC_DEPLOY_LOCK 覆盖。
DEPLOY_LOCK=${RAW_QUBIUS_DEPLOY_LOCK:-${RC_DEPLOY_LOCK:-$QUBIUS_DEPLOY_LOCK}}
SERVICE=${RAW_QUBIUS_SERVICE:-$QUBIUS_SERVICE}
ROLE_FLAG=${QUBIUS_SECONDARY}
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user

IS_WINDOWS=0
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
esac
have_cmd() { command -v "$1" >/dev/null 2>&1; }

[[ -n $REPO ]] || { echo "缺少副实例仓库目录（QUBIUS_REPO_DIR / RC_REPO）" >&2; exit 1; }
[[ -n $DATA ]] || { echo "缺少副实例数据目录（QUBIUS_DATA_DIR / RC_DATA）" >&2; exit 1; }
[[ -n $PORT ]] || { echo "缺少副实例端口（QUBIUS_PORT / RC_PORT）" >&2; exit 1; }

mkdir -p "$DATA" "$(dirname "$LOG")" "$(dirname "$STATUS")" "$(dirname "$SERVER_LOG")" \
  "$(dirname "$DEPLOY_LOCK")"
exec >> "$LOG" 2>&1

for cmd in git curl node; do
  have_cmd "$cmd" || { echo "缺少命令：$cmd"; exit 1; }
done
if [[ $IS_WINDOWS == 1 ]]; then
  # Windows 用 netstat 定位监听进程；没有它就没法安全地停旧进程。
  have_cmd netstat || { echo "缺少命令：netstat（无法定位副实例进程）"; exit 1; }
else
  have_cmd ss || { echo "缺少命令：ss（无法定位副实例进程）"; exit 1; }
fi
if ! have_cmd flock; then
  echo "警告：找不到 flock，跳过部署锁和维护锁（并发操作可能互相踩踏）"
fi
if ! have_cmd setsid && ! have_cmd nohup; then
  echo "警告：找不到 setsid/nohup，重启时直接后台启动子进程"
fi

# 必须先 claim ops lock 再拿 deploy.lock：build.sh 会 claim ops lock，
# 反序会让「部署作业先持 ops 等 deploy」与「secondary 持 deploy 等 ops」
# 形成 ABBA 死锁。claim 后 token 会导出给 build/start-all 子进程自动跳过。
qubius_ops_claim deploy

exec 8>"$DEPLOY_LOCK"
if have_cmd flock && ! flock -n 8; then
  echo "部署任务正在进行，稍后重试"
  RC_STATUS="$STATUS" node -e '
    const fs = require("fs");
    const file = process.env.RC_STATUS;
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
    try {
      fs.writeFileSync(file, JSON.stringify({
        ...prev,
        state: "failed",
        action: process.argv[1],
        jobId: String(Date.now()),
        message: "部署任务正在进行，请稍后重试",
        finishedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      }, null, 2));
    } catch {}
  ' "$ACTION" 2>/dev/null || true
  exit 1
fi

FROM_SHORT=""
TO_SHORT=""
echo
echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) $ACTION ====="

exec 9>"$DATA/secondary.lock"
if have_cmd flock && ! flock -n 9; then
  echo "已有维护任务在运行"
  exit 1
fi

JOB=$(date +%s%N)
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 上一次同步前的版本，回滚时用。
PREV=$(RC_STATUS="$STATUS" node -e '
  const fs = require("fs");
  try { const j = JSON.parse(fs.readFileSync(process.env.RC_STATUS, "utf8")); process.stdout.write(j.previousHead || ""); } catch {}
' 2>/dev/null || true)

# 状态/时间契约见 server/src/job-state.ts：状态只用 idle/running/success/failed，
# 时间戳为秒精度 UTC（date -u +%Y-%m-%dT%H:%M:%SZ）。
write_status() {
  local state=$1 action=$2 from=$3 to=$4 message=$5 pid=$6 prev=$7
  ST_STATE="$state" ST_ACTION="$action" ST_FROM="$from" ST_TO="$to" ST_MESSAGE="$message" \
  ST_PID="$pid" ST_PREV="$prev" ST_JOB="$JOB" ST_STARTED="$STARTED" \
  ST_FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  RC_STATUS="$STATUS" node -e '
    const fs = require("fs");
    const file = process.env.RC_STATUS;
    const data = {
      jobId: process.env.ST_JOB,
      state: process.env.ST_STATE,
      action: process.env.ST_ACTION,
      from: process.env.ST_FROM || null,
      to: process.env.ST_TO || null,
      previousHead: process.env.ST_PREV || null,
      message: process.env.ST_MESSAGE,
      pid: process.env.ST_PID ? Number(process.env.ST_PID) : null,
      startedAt: process.env.ST_STARTED,
      finishedAt: process.env.ST_STATE === "running" ? null : process.env.ST_FINISHED,
    };
    fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2));
    fs.renameSync(file + ".tmp", file);
  ' 2>/dev/null
}

fail() {
  local message=$1
  echo "失败：$message"
  write_status failed "$ACTION" "${FROM_SHORT:-}" "${TO_SHORT:-}" "$message" "" "$PREV"
  exit 1
}

listener_pid() {
  if [[ $IS_WINDOWS == 1 ]]; then
    # netstat -ano 最后一列是 PID；本地地址 127.0.0.1:PORT、外部 0.0.0.0:0 是监听项。
    netstat -ano 2>/dev/null | awk -v port=":$PORT" '
      $1 == "TCP" && $2 == "127.0.0.1" port && $3 == "0.0.0.0:0" { print $5; exit }'
    return 0
  fi
  ss -ltnp "sport = :$PORT" 2>/dev/null \
    | grep -F "127.0.0.1:$PORT" \
    | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
}

pid_alive() {
  local pid=$1
  if [[ $IS_WINDOWS == 1 ]]; then
    # tasklist 的 CSV 第二列是 PID；找不到任务时会打印本地化提示，靠列匹配忽略。
    tasklist //NH //FO CSV //FI "PID eq $pid" 2>/dev/null \
      | awk -F'","' -v p="$pid" '$2 == p { found = 1 } END { exit !found }'
  else
    kill -0 "$pid" 2>/dev/null
  fi
}

terminate_pid() {
  local pid=$1
  if [[ $IS_WINDOWS == 1 ]]; then
    # 不能加 /T：维护脚本本身是副实例 server 的子进程，杀进程树会把自己带走。
    taskkill //F //PID "$pid" >/dev/null 2>&1 || true
  else
    kill "$pid" 2>/dev/null || true
  fi
}

# 副实例由 systemd unit 管理时，必须走 systemctl，不能手工 kill + setsid。
unit_managed() {
  local link
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user is-active "$SERVICE" >/dev/null 2>&1 && return 0
    systemctl --user is-enabled "$SERVICE" >/dev/null 2>&1 && return 0
  fi
  # masked unit 不应被当作启用。
  if [[ -L $UNIT_DIR/$SERVICE && $(readlink "$UNIT_DIR/$SERVICE") == /dev/null ]]; then
    return 1
  fi
  for link in "$UNIT_DIR"/*.wants/"$SERVICE"; do
    [[ -e $link ]] && return 0
  done
  return 1
}

# 无法拉起副实例时要在停止旧进程之前失败，避免先停后失败。
if ! unit_managed && [[ ! -x $RESTART ]]; then
  fail "找不到可执行的启动脚本：$RESTART（设置 QUBIUS_RESTART 或确认 $REPO/deploy/run.sh）"
fi

stop_server() {
  local pid
  if unit_managed; then
    if ! systemctl --user stop "$SERVICE" 2>/dev/null; then
      echo "systemd 停止副实例失败" >&2
      return 1
    fi
    echo "已通过 systemd 停止副实例"
    return 0
  fi
  pid=$(listener_pid)
  [[ -n $pid ]] || return 0
  echo "停止副实例 pid=$pid"
  terminate_pid "$pid"
  for _ in $(seq 1 25); do
    pid_alive "$pid" || return 0
    sleep 0.2
  done
  # Windows 的 terminate_pid 已经是强杀，这里再调一次只是兜底。
  terminate_pid "$pid"
}

start_server() {
  if unit_managed; then
    if ! systemctl --user start "$SERVICE" 2>/dev/null; then
      echo "systemd 启动副实例失败" >&2
      return 1
    fi
    echo "已通过 systemd 启动副实例"
    return 0
  fi
  echo "启动副实例 $RESTART"
  # 关闭 flock 的 fd（6=ops lock，8=部署锁，9=维护锁），否则新服务会一直持有锁。
  # 同时剥离 QUBIUS_OPS_* 标记，避免长驻 server 被 ops-lock 当成残留进程。
  # 显式带上角色开关、仓库目录，以及 server 当前配置里的端口/数据目录，
  # 避免 config.yaml 被手工改过时 run.sh 与健康检查使用的端口不一致。
  # Windows/Git Bash 没有 setsid，退回 nohup；两者都没有时直接后台启动。
  local prefix=()
  if have_cmd setsid; then
    prefix=(setsid)
  elif have_cmd nohup; then
    prefix=(nohup)
  fi
  QUBIUS_SECONDARY=$ROLE_FLAG QUBIUS_REPO_DIR=$REPO \
    QUBIUS_SECONDARY_PORT=$PORT QUBIUS_DATA_SECONDARY=$DATA \
    "${prefix[@]}" env -u QUBIUS_OPS_ROOT -u QUBIUS_OPS_TOKEN -u QUBIUS_OPS_JOB \
    "$RESTART" >> "$SERVER_LOG" 2>&1 < /dev/null 6>&- 8>&- 9>&- &
}

wait_health() {
  local i hh cur
  for ((i = 0; i < 120; i++)); do
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
       && curl -fsS -m 5 "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q '<div id="root">'; then
      # 旧进程也可能满足健康检查；用 head 确认跑的是刚构建的版本。
      hh=$(curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | node -e '
        let s = "";
        process.stdin.on("data", (d) => (s += d));
        process.stdin.on("end", () => {
          try {
            const j = JSON.parse(s);
            if (typeof j.head === "string") process.stdout.write(j.head);
          } catch {}
        });
      ' 2>/dev/null || true)
      if [[ -z $hh && -f $REPO/server/dist/build.json ]]; then
        # 首次升级到带 head 的版本时，旧进程可能还没有 head；只告警，不误判回滚。
        echo "警告：health 缺少 head，无法确认运行版本（旧构建或迁移中）" >&2
      fi
      cur=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)
      if [[ -n $hh && -n $cur && $hh != "$cur" ]]; then
        echo "health 的 head=$hh 与当前 HEAD=$cur 不一致" >&2
        return 1
      fi
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# 与 build.sh 使用同一个依赖标记，判断是否需要先停服务再安装。
needs_install() {
  local hash_file=$REPO/node_modules/.qubius-lock-hash
  local hash
  [[ -d $REPO/node_modules ]] || return 0
  hash=$(sha256sum "$REPO/package-lock.json" | awk '{print $1}')
  if [[ -f $hash_file && $(cat "$hash_file" 2>/dev/null) == "$hash" ]]; then
    return 1
  fi
  return 0
}

build() {
  echo "构建"
  local builder
  for builder in "$REPO/deploy/build.sh" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build.sh"; do
    if [[ -x $builder ]]; then
      QUBIUS_SECONDARY=$ROLE_FLAG QUBIUS_REPO_DIR=$REPO "$builder" "$REPO" || return 1
      return 0
    fi
  done
  # 旧安装没有 build.sh 时保持原行为。
  (cd "$REPO" && npm run build) || return 1
}

restart() {
  local old new
  old=$(listener_pid)
  if ! stop_server; then return 1; fi
  if ! start_server; then return 1; fi
  if ! wait_health; then return 1; fi
  new=$(listener_pid)
  if [[ -z $new ]]; then
    echo "重启后没有监听进程" >&2
    return 1
  fi
  # wait_health 已验证 head；再确认监听 PID 确实换过，防止“健康检查通过但仍是旧进程”。
  if [[ -n $old && $new == $old ]]; then
    echo "重启后监听 PID 未变化（$new），可能仍是旧进程" >&2
    return 1
  fi
  return 0
}

auto_rollback() {
  local why=$1
  echo "自动回滚到 $FROM_FULL：$why"
  (cd "$REPO" && git reset --hard "$FROM_FULL") || true
  # 停不下来就别继续构建/安装，避免旧进程句柄干扰 node_modules。
  if needs_install && ! stop_server; then
    fail "$why；无法停止副实例，回滚中止（副实例可能已停止，需要人工处理）"
  fi
  if ! build; then
    write_status failed "$ACTION" "${FROM_SHORT:-}" "${TO_SHORT:-}" "$why；回滚构建失败，需要人工处理" "" "$PREV"
    exit 1
  fi
  if restart; then
    write_status failed "$ACTION" "${FROM_SHORT:-}" "${TO_SHORT:-}" "$why；已回滚到 ${FROM_SHORT:-}" "" "$PREV"
  else
    write_status failed "$ACTION" "${FROM_SHORT:-}" "${TO_SHORT:-}" "$why；回滚后仍不健康，需要人工处理" "" "$PREV"
  fi
  exit 1
}

git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "副实例仓库不存在或不是 git 仓库：$REPO"
cd "$REPO" || fail "无法进入 $REPO"
[[ -z $(git status --porcelain) ]] || fail "副实例工作区不干净，先处理未提交改动"

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
[[ $BRANCH == main ]] || fail "副实例当前不在 main 分支（$BRANCH）"

FROM_FULL=$(git rev-parse HEAD) || fail "读不到当前提交"
FROM_SHORT=${FROM_FULL:0:8}

if [[ $ACTION == sync ]]; then
  [[ -n $PRIMARY_REPO ]] || fail "没有配置主实例仓库"
  git -C "$PRIMARY_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || fail "主实例仓库不存在或不是 git 仓库：$PRIMARY_REPO"
  write_status running sync "$FROM_SHORT" "" "正在从主实例拉取 $PRIMARY_REF" "$$" "$PREV"
  echo "从 $PRIMARY_REPO 拉取 $PRIMARY_REF"
  if ! git fetch "$PRIMARY_REPO" "$PRIMARY_REF"; then
    fail "拉取主实例失败"
  fi
  TO_FULL=$(git rev-parse FETCH_HEAD) || fail "读不到主实例提交"
  TO_SHORT=${TO_FULL:0:8}
  if [[ $FROM_FULL == $TO_FULL ]]; then
    # 代码已是最新，但上次可能在构建前中止；产物落后时继续部署，避免误报“已经是最新”。
    STAMP=$(node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (typeof j.head === "string") process.stdout.write(j.head);
      } catch {}
    ' "$REPO/server/dist/build.json" 2>/dev/null || true)
    DIRTY=$(node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(j.dirty === true ? "1" : "0");
      } catch {}
    ' "$REPO/server/dist/build.json" 2>/dev/null || true)
    if [[ $STAMP == "$TO_FULL" && $DIRTY != "1" ]] && ! needs_install; then
      echo "已经是最新"
      write_status success sync "$FROM_SHORT" "$TO_SHORT" "已经是最新（$FROM_SHORT）" "" "$PREV"
      exit 0
    fi
    echo "代码已是最新但构建产物落后/依赖未就绪，重新构建部署"
    # 这次只是恢复同一提交，回滚目标保持原来的 PREV，不能被当前提交覆盖。
    NEW_PREV=$PREV
  else
    if ! git merge-base --is-ancestor "$FROM_FULL" "$TO_FULL"; then
      fail "副实例有独立提交，需要手动合并"
    fi
    if ! git merge --ff-only "$TO_FULL"; then
      fail "快进到 $TO_SHORT 失败"
    fi
    NEW_PREV=$FROM_FULL
  fi
else
  [[ -n $PREV ]] || fail "没有可回滚的版本"
  write_status running rollback "$FROM_SHORT" "" "正在回滚到 ${PREV:0:8}" "$$" "$PREV"
  TO_FULL=$PREV
  TO_SHORT=${TO_FULL:0:8}
  if ! git cat-file -e "$TO_FULL^{commit}" 2>/dev/null; then
    fail "回滚目标不存在：$TO_SHORT"
  fi
  if ! git reset --hard "$TO_FULL"; then
    fail "回滚到 $TO_SHORT 失败"
  fi
  NEW_PREV=""
fi

if needs_install; then
  # 依赖安装需要先停服务；stop_server 失败时立即终止，绝不带着旧进程继续 build。
  if ! stop_server; then
    # HEAD 已前进但没构建：回退到操作前，避免下次 sync 误判“已经是最新”。
    if ! (cd "$REPO" && git reset --hard "$FROM_FULL"); then
      fail "停止副实例失败，且回退 HEAD 失败（可能仍停在 $TO_SHORT），需要人工处理"
    fi
    fail "停止副实例失败，已中止构建并回退到 $FROM_SHORT（副实例可能已停止，需要人工处理）"
  fi
fi

if ! build; then
  auto_rollback "构建失败"
fi

if ! restart; then
  auto_rollback "新版本健康检查失败"
fi

if [[ $ACTION == sync ]]; then
  echo "推送副实例 origin/main"
  git push origin HEAD:main >> "$LOG" 2>&1 || echo "warning: push 失败" >> "$LOG"
  write_status success sync "$FROM_SHORT" "$TO_SHORT" "已同步到 $TO_SHORT" "" "$NEW_PREV"
else
  write_status success rollback "$FROM_SHORT" "$TO_SHORT" "已回滚到 $TO_SHORT" "" "$NEW_PREV"
fi
echo "完成"
