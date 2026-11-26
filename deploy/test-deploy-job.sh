#!/bin/bash
# deploy/deploy-job.sh 的安全路径测试：
# 验证“无变化时不停父进程、变化时才停”、忙碌保护（exit 3）、旧端口检查、
# 副角色，以及 start-all 返回 3 时的透传。不构建真实 checkout、不启动真实服务、
# 不触碰真实 ops lock（由测试提供 QUBIUS_OPS_ROOT）。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
PARENT_PID=""
START_LOG=$TMP/start.log
ACTIVE_FILE=$TMP/active
JOB_PARENT_PORT=19789
: >"$START_LOG"
: >"$ACTIVE_FILE"

cleanup() {
  [[ -n $PARENT_PID ]] && kill "$PARENT_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local name=$1 needle=$2 haystack=$3
  [[ $haystack == *"$needle"* ]] || fail "$name：缺少 [$needle]，实际 [$haystack]"
}

assert_not_contains() {
  local name=$1 needle=$2 haystack=$3
  [[ $haystack != *"$needle"* ]] || fail "$name：不应包含 [$needle]，实际 [$haystack]"
}

assert_rc() {
  local name=$1 expected=$2 actual=$3
  [[ $actual -eq $expected ]] || fail "$name：exit $actual != $expected"
}

UNSET_QUBIUS=()
while IFS= read -r name; do UNSET_QUBIUS+=(-u "$name"); done \
  < <(compgen -e | grep '^QUBIUS_' || true)

mkdir -p "$TMP/home" "$TMP/config" "$TMP/data" "$TMP/fakebin"
EMPTY_ENV=$TMP/empty.env
: >"$EMPTY_ENV"
REPO=$TMP/repo
STATUS=$TMP/config/deploy.json
LOG=$TMP/config/deploy.log

# fake systemctl：所有 unit 都未接管。
printf '#!/bin/sh\nexit 1\n' >"$TMP/fakebin/systemctl"
chmod +x "$TMP/fakebin/systemctl"

# fake curl：默认健康、无会话；ACTIVE_FILE 用 "PORT=N" 行按端口覆盖，
# 值为 down 表示该端口不可达（模拟端口刚改、新端口还没起来）。
cat >"$TMP/fakebin/curl" <<'EOF'
#!/bin/sh
port=0
for arg in "$@"; do
  case $arg in
    *'127.0.0.1:'*) port=${arg##*127.0.0.1:}; port=${port%%/*} ;;
  esac
done
mapped=""
if [ -f "${ACTIVE_FILE:-}" ]; then
  mapped=$(awk -F= -v p="$port" '$1 == p { print $2; exit }' "$ACTIVE_FILE" 2>/dev/null || true)
fi
if [ "$mapped" = "down" ]; then
  for arg in "$@"; do
    case $arg in
      *'%{http_code}'*) printf '000'; exit 0 ;;
    esac
  done
  exit 22
fi
active=0
[ -n "$mapped" ] && active=$mapped
for arg in "$@"; do
  case $arg in
    *'%{http_code}'*) printf '200'; exit 0 ;;
  esac
done
printf '{"ok":true,"activeSessions":%s}\n' "$active"
EOF
chmod +x "$TMP/fakebin/curl"

# 看起来“已构建完成”的 checkout。
mkdir -p "$REPO/deploy" "$REPO/server/dist" "$REPO/web/dist" "$REPO/node_modules"
printf 'node_modules/\nserver/dist/\nweb/dist/\n' >"$REPO/.gitignore"
printf '{"name":"fake","version":"0.0.0"}\n' >"$REPO/package.json"
printf '{}\n' >"$REPO/package-lock.json"
git -C "$REPO" init -q
git -C "$REPO" add .gitignore package.json package-lock.json
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm init
HEAD=$(git -C "$REPO" rev-parse HEAD)
: >"$REPO/server/dist/index.js"
: >"$REPO/web/dist/index.html"
sha256sum "$REPO/package-lock.json" | awk '{print $1}' >"$REPO/node_modules/.qubius-lock-hash"
printf '{"head":"%s","version":"0.0.0","builtAt":"2026-01-01T00:00:00Z","dirty":false}\n' \
  "$HEAD" >"$REPO/server/dist/build.json"

# 假的安装脚本和 start-all：部署任务只需要它们可执行并返回成功。
printf '#!/bin/sh\nexit 0\n' >"$REPO/deploy/install.sh"
printf '#!/bin/sh\necho "start-all $*" >>"%s"\nexit 0\n' "$START_LOG" >"$REPO/deploy/start-all.sh"
chmod +x "$REPO/deploy/install.sh" "$REPO/deploy/start-all.sh"

CONFIG=$TMP/config/config.yaml
CONFIG_SECONDARY=$TMP/config/config-secondary.yaml
printf 'role: primary\nlisten: 127.0.0.1:19789\n' >"$CONFIG"
printf 'role: secondary\nlisten: 127.0.0.1:19790\n' >"$CONFIG_SECONDARY"
DATA=$TMP/data

write_stamp() {
  local data=$1 config=$2 head ch eh
  head=$(git -C "$REPO" rev-parse HEAD)
  ch=$(sha256sum "$config" | awk '{print $1}')
  eh=$(sha256sum "$EMPTY_ENV" | awk '{print $1}')
  printf '{"head":"%s","configHash":"%s","envHash":"%s"}\n' "$head" "$ch" "$eh" \
    >"$data/.deploy-stamp"
}

# 模拟正在运行的 server：cmdline 里带 server/dist/index.js，供 IS_SERVER 判定。
spawn_parent() {
  local role=${1:-primary}
  if [[ $role == secondary ]]; then
    env QUBIUS_SECONDARY=1 node -e 'setInterval(() => {}, 1000)' \
      "$REPO/server/dist/index.js" >/dev/null 2>&1 &
  else
    env -u QUBIUS_SECONDARY node -e 'setInterval(() => {}, 1000)' \
      "$REPO/server/dist/index.js" >/dev/null 2>&1 &
  fi
  PARENT_PID=$!
  sleep 0.3
}

run_job() {
  env "${UNSET_QUBIUS[@]}" \
    HOME="$TMP/home" \
    PATH="$TMP/fakebin:$PATH" \
    ACTIVE_FILE="$ACTIVE_FILE" \
    QUBIUS_CONFIG_DIR="$TMP/config" \
    QUBIUS_ENV="$EMPTY_ENV" \
    QUBIUS_PRIMARY_DIR="$REPO" \
    QUBIUS_DATA_PRIMARY="$DATA" \
    QUBIUS_PRIMARY_PORT=19789 \
    QUBIUS_START_PRIMARY=1 \
    QUBIUS_START_SECONDARY=0 \
    QUBIUS_DEPLOY_STATUS="$STATUS" \
    QUBIUS_DEPLOY_LOG="$LOG" \
    QUBIUS_DEPLOY_JOB_ID="test-job" \
    QUBIUS_DEPLOY_STARTED_AT="2026-01-01T00:00:00Z" \
    QUBIUS_DEPLOY_PARENT_PID="$PARENT_PID" \
    QUBIUS_DEPLOY_PARENT_PORT="$JOB_PARENT_PORT" \
    QUBIUS_DEPLOY_REPO_ROOT="$HERE/.." \
    QUBIUS_OPS_ROOT="$TMP/config" \
    QUBIUS_OPS_TOKEN="test-token" \
    ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
    bash "$HERE/deploy-job.sh"
}

capture() {
  OUT=""
  if OUT=$("$@" 2>&1 </dev/null); then
    RC=0
  else
    RC=$?
  fi
}

stop_parent() {
  [[ -n $PARENT_PID ]] || return 0
  kill "$PARENT_PID" 2>/dev/null || true
  wait "$PARENT_PID" 2>/dev/null || true
  PARENT_PID=""
}

EXTRA_ENV=()
OUT=""
RC=0

# ── 1. 无变化：不停父进程，正常结束 ─────────────────────────────────────────
write_stamp "$DATA" "$CONFIG"
: >"$ACTIVE_FILE"
spawn_parent primary
PID_BEFORE=$PARENT_PID
: >"$START_LOG"; : >"$LOG"
capture run_job
assert_rc "no-change job exit 0" 0 "$RC"
assert_contains "no-change skips stop" "无变化，跳过停止当前服务" "$(cat "$LOG")"
kill -0 "$PID_BEFORE" 2>/dev/null || fail "无变化时父进程不应被停止"
assert_contains "no-change still runs start-all" "start-all --restart" "$(cat "$START_LOG")"
assert_contains "no-change status success" '"state":"success"' "$(cat "$STATUS")"
stop_parent

# ── 2. 无 stamp（需要重启）：先停父进程再交给 start-all ─────────────────────
rm -f "$DATA/.deploy-stamp"
spawn_parent primary
PID_BEFORE=$PARENT_PID
: >"$START_LOG"; : >"$LOG"
capture run_job
assert_rc "restart job exit 0" 0 "$RC"
assert_contains "restart stops parent" "停止当前服务进程" "$(cat "$LOG")"
if kill -0 "$PID_BEFORE" 2>/dev/null; then fail "需要重启时父进程应被停止"; fi
wait "$PID_BEFORE" 2>/dev/null || true
PARENT_PID=""
assert_contains "restart status success" '"state":"success"' "$(cat "$STATUS")"
assert_not_contains "restart does not skip" "无变化，跳过停止" "$(cat "$LOG")"

# ── 3. 忙碌保护：有会话 → exit 3，父进程保持运行，状态 failed/busy ──────────
rm -f "$DATA/.deploy-stamp"
printf '19789=2\n' >"$ACTIVE_FILE"
spawn_parent primary
PID_BEFORE=$PARENT_PID
: >"$START_LOG"; : >"$LOG"
capture run_job
assert_rc "busy job exit 3" 3 "$RC"
assert_contains "busy message" "非交互环境已中止部署" "$(cat "$LOG")"
kill -0 "$PID_BEFORE" 2>/dev/null || fail "忙碌中止时父进程不应被停止"
assert_contains "busy status failed" '"state":"failed"' "$(cat "$STATUS")"
assert_contains "busy step" '"step":"busy"' "$(cat "$STATUS")"
stop_parent
: >"$ACTIVE_FILE"

# ── 4. 改端口：旧端口上的会话也要拦住（新端口不可达）──────────────────────
rm -f "$DATA/.deploy-stamp"
printf '19780=2\n19789=down\n' >"$ACTIVE_FILE"
JOB_PARENT_PORT=19780
spawn_parent primary
PID_BEFORE=$PARENT_PID
: >"$START_LOG"; : >"$LOG"
capture run_job
JOB_PARENT_PORT=19789
assert_rc "old-port busy exit 3" 3 "$RC"
assert_contains "old-port busy message" "非交互环境已中止部署" "$(cat "$LOG")"
kill -0 "$PID_BEFORE" 2>/dev/null || fail "旧端口有会话时父进程不应被停止"
stop_parent
: >"$ACTIVE_FILE"

# ── 5. 双实例：非父角色忙时，在停父进程之前就 exit 3 ───────────────────────
# 父角色是副实例（19790），主实例（19789）有会话；不能先停副实例。
rm -f "$DATA/.deploy-stamp"
printf '19789=2\n19790=0\n' >"$ACTIVE_FILE"
spawn_parent secondary
PID_BEFORE=$PARENT_PID
: >"$START_LOG"; : >"$LOG"
EXTRA_ENV=(
  QUBIUS_START_PRIMARY=1
  QUBIUS_START_SECONDARY=1
  QUBIUS_SECONDARY_DIR="$REPO"
  QUBIUS_DATA_SECONDARY="$DATA"
  QUBIUS_SECONDARY_PORT=19790
)
capture run_job
EXTRA_ENV=()
assert_rc "other-role busy exit 3" 3 "$RC"
assert_contains "other-role busy message" "非交互环境已中止部署" "$(cat "$LOG")"
kill -0 "$PID_BEFORE" 2>/dev/null || fail "其他角色忙时父进程不应被停止"
assert_contains "other-role busy status" '"step":"busy"' "$(cat "$STATUS")"
stop_parent
: >"$ACTIVE_FILE"

# ── 6. 副角色：无变化时同样不停父进程 ──────────────────────────────────────
write_stamp "$DATA" "$CONFIG_SECONDARY"
spawn_parent secondary
PID_BEFORE=$PARENT_PID
: >"$START_LOG"; : >"$LOG"
EXTRA_ENV=(
  QUBIUS_START_PRIMARY=0
  QUBIUS_START_SECONDARY=1
  QUBIUS_SECONDARY_DIR="$REPO"
  QUBIUS_DATA_SECONDARY="$DATA"
  QUBIUS_SECONDARY_PORT=19790
)
capture run_job
EXTRA_ENV=()
assert_rc "secondary no-change exit 0" 0 "$RC"
assert_contains "secondary no-change skips stop" "无变化，跳过停止当前服务" "$(cat "$LOG")"
kill -0 "$PID_BEFORE" 2>/dev/null || fail "副角色无变化时父进程不应被停止"
stop_parent
rm -f "$DATA/.deploy-stamp"

# ── 7. start-all 返回 3：保持 failed/busy，退出码透传 ───────────────────────
printf '#!/bin/sh\necho "start-all $*" >>"%s"\nexit 3\n' "$START_LOG" >"$REPO/deploy/start-all.sh"
chmod +x "$REPO/deploy/start-all.sh"
spawn_parent primary
PID_BEFORE=$PARENT_PID
: >"$START_LOG"; : >"$LOG"
capture run_job
assert_rc "start-all rc3 job exit 3" 3 "$RC"
assert_contains "start-all rc3 status failed" '"state":"failed"' "$(cat "$STATUS")"
assert_contains "start-all rc3 step busy" '"step":"busy"' "$(cat "$STATUS")"

echo "deploy/deploy-job.sh 决策路径测试通过"
