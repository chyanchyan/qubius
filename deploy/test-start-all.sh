#!/bin/bash
# deploy/start-all.sh 的安全路径冒烟测试：
# 只测试 --help、未知参数、两个角色都关闭、systemd 接管检测（fake systemctl）。
# 绝不启动真实 server、不写真实 crontab/systemd、不监听真实端口。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
HOLDER_PID=""
BUILT_DATA=""
cleanup() {
  if [[ -n $BUILT_DATA && -f $BUILT_DATA/qubius.pid ]]; then
    local pid
    pid=$(head -n 1 "$BUILT_DATA/qubius.pid" 2>/dev/null | tr -dc '0-9' || true)
    [[ -n $pid ]] && kill "$pid" 2>/dev/null || true
  fi
  [[ -n $HOLDER_PID ]] && kill "$HOLDER_PID" 2>/dev/null || true
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

mkdir -p "$TMP/home" "$TMP/config" "$TMP/data-q" "$TMP/data-co"
EMPTY_ENV=$TMP/empty.env
: >"$EMPTY_ENV"
EXTRA_ENV=()
OUT=""
RC=0

run_start_all() {
  env "${UNSET_QUBIUS[@]}" \
    HOME="$TMP/home" \
    XDG_CONFIG_HOME="$TMP/home/.config" \
    XDG_DATA_HOME="$TMP/home/.local/share" \
    QUBIUS_HOME="$TMP/home" \
    QUBIUS_CONFIG_DIR="$TMP/config" \
    QUBIUS_ENV="$EMPTY_ENV" \
    QUBIUS_DATA_PRIMARY="$TMP/data-q" \
    QUBIUS_DATA_SECONDARY="$TMP/data-co" \
    QUBIUS_PRIMARY_DIR="$TMP/primary-repo" \
    QUBIUS_SECONDARY_DIR="$TMP/secondary-repo" \
    QUBIUS_PRIMARY_PORT=19787 \
    QUBIUS_SECONDARY_PORT=19788 \
    ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
    bash "$HERE/start-all.sh" "$@"
}

capture() {
  OUT=""
  # 部署脚本靠 stdin 是否为 TTY 决定交互/非交互；测试统一按非交互处理。
  if OUT=$("$@" 2>&1 </dev/null); then
    RC=0
  else
    RC=$?
  fi
}

# ── 1. --help ───────────────────────────────────────────────────────────────
capture run_start_all --help
assert_rc "--help exit 0" 0 "$RC"
assert_contains "--help prints usage" "用法：" "$OUT"

# ── 2. 未知参数 exit 2 ──────────────────────────────────────────────────────
capture run_start_all --bogus
assert_rc "unknown arg exit 2" 2 "$RC"
assert_contains "unknown arg message" "未知参数" "$OUT"

# ── 3. 两个角色都关闭：不启动进程、退出 0 ───────────────────────────────────
# 同样注入返回非零的 fake systemctl，避免误用真实 systemctl（本机启用了 unit 时会误报）。
FAKEBIN_NONE=$TMP/fakebin-none
mkdir -p "$FAKEBIN_NONE"
printf '#!/bin/sh\nexit 1\n' >"$FAKEBIN_NONE/systemctl"
chmod +x "$FAKEBIN_NONE/systemctl"
EXTRA_ENV=(QUBIUS_START_PRIMARY=0 QUBIUS_START_SECONDARY=0 PATH="$FAKEBIN_NONE:$PATH")
capture run_start_all
EXTRA_ENV=()
assert_rc "both roles disabled exit 0" 0 "$RC"
assert_contains "both roles disabled message" "没有启动任何实例" "$OUT"
[[ ! -e $TMP/data-q/qubius.pid ]] || fail "两个角色关闭时不应写 qubius.pid"
[[ ! -e $TMP/data-co/qubius.pid ]] || fail "两个角色关闭时不应写 co-qubius.pid"
# 组件都跳过，不应产生实例日志。
[[ ! -e $TMP/data-q/qubius.log && ! -e $TMP/data-co/qubius.log ]] \
  || fail "两个角色关闭时不应启动实例日志"
# 两个角色都关闭属于 no-op：不 claim ops lock，因此也不应留下 ops.meta。
[[ ! -e $TMP/config/ops.meta ]] || fail "两角色关闭跑完后不应有 ops.meta"

# ── 3b. 两角色关闭 + ops lock 被占用：no-op 不应 claim，也不应失败 ───────────
NOW=$(date +%s)
printf '{"version":1,"state":"pending","kind":"deploy","jobId":"page-job","token":"page-token","root":"%s","claimedAt":%s,"updatedAt":%s}\n' \
  "$TMP/config" "$NOW" "$NOW" >"$TMP/config/ops.meta"
EXTRA_ENV=(QUBIUS_START_PRIMARY=0 QUBIUS_START_SECONDARY=0 PATH="$FAKEBIN_NONE:$PATH")
capture run_start_all
EXTRA_ENV=()
assert_rc "no-op with busy ops lock exit 0" 0 "$RC"
assert_contains "no-op with busy ops lock message" "没有启动任何实例" "$OUT"
assert_contains "no-op keeps other job's meta" '"jobId":"page-job"' "$(cat "$TMP/config/ops.meta")"
rm -f "$TMP/config/ops.meta"

# ── 4. systemd 接管检测：PATH 里的 fake systemctl，不触碰真实 systemd ────────
FAKEBIN=$TMP/fakebin
mkdir -p "$FAKEBIN"
cat >"$FAKEBIN/systemctl" <<'EOF'
#!/bin/sh
for arg in "$@"; do
  case $arg in
    is-enabled|is-active) exit 0 ;;
  esac
done
exit 1
EOF
chmod +x "$FAKEBIN/systemctl"
EXTRA_ENV=(QUBIUS_START_PRIMARY=1 QUBIUS_START_SECONDARY=0 PATH="$FAKEBIN:$PATH")
capture run_start_all
EXTRA_ENV=()
assert_rc "systemd takeover exit 1" 1 "$RC"
assert_contains "systemd takeover message" "检测到 systemd user unit 已启用" "$OUT"
[[ ! -e $TMP/data-q/qubius.pid ]] || fail "systemd 接管时不应启动实例"

# ── 5. --restart 无变化：不停止、不构建 ─────────────────────────────────────
# 用假的 curl/ss/run.sh 模拟一个健康运行的实例；真实进程只在本测试内启动。
BUILD_LOG=$TMP/build.log
: >"$BUILD_LOG"
HEALTH_MARK=$TMP/healthy
ACTIVE_FILE=$TMP/active
: >"$ACTIVE_FILE"
BUILT_REPO=$TMP/built-repo
BUILT_DATA=$TMP/data-built
BUILT_CONFIG=$TMP/config/config.yaml
BUILT_FAKEBIN=$TMP/fakebin-built
mkdir -p "$BUILT_DATA" "$BUILT_FAKEBIN"

# 生成支持 --deps/--stage/--swap/--rollback 的假 build.sh。
write_fake_build() {
  local repo=$1 stage_hook=${2:-}
  cat >"$repo/deploy/build.sh" <<EOF
#!/bin/sh
mode=\$1
repo=\$2
echo "build \$mode \$repo" >>"$BUILD_LOG"
case \$mode in
  --deps)
    if [ -f "\$repo/FAIL_DEPS" ]; then echo "fake deps failure" >&2; exit 1; fi
    ;;
  --stage)
    head=\$(git -C "\$repo" rev-parse HEAD 2>/dev/null || true)
    mkdir -p "\$repo/server/dist.next" "\$repo/web/dist.next"
    printf 'new\n' >"\$repo/server/dist.next/index.js"
    : >"\$repo/web/dist.next/index.html"
    printf '{"head":"%s","version":"0.0.0","builtAt":"2026-01-01T00:00:00Z","dirty":false}\n' "\$head" \
      >"\$repo/server/dist.next/build.json"
    $stage_hook
    ;;
  --swap)
    rm -rf "\$repo/server/dist.prev" "\$repo/web/dist.prev"
    for part in server web; do
      [ -e "\$repo/\$part/dist" ] && mv "\$repo/\$part/dist" "\$repo/\$part/dist.prev"
      mv "\$repo/\$part/dist.next" "\$repo/\$part/dist"
    done
    ;;
  --rollback)
    for part in server web; do
      if [ ! -d "\$repo/\$part/dist.prev" ]; then
        echo "fake rollback: no \$part/dist.prev" >&2
        exit 1
      fi
    done
    for part in server web; do
      rm -rf "\$repo/\$part/dist"
      mv "\$repo/\$part/dist.prev" "\$repo/\$part/dist"
    done
    rm -rf "\$repo/server/dist.next" "\$repo/web/dist.next"
    ;;
esac
EOF
  chmod +x "$repo/deploy/build.sh"
}

make_built_repo() {
  local repo=$1 head
  mkdir -p "$repo/deploy" "$repo/server/dist" "$repo/web/dist" "$repo/node_modules"
  printf 'node_modules/\nserver/dist/\nweb/dist/\n' >"$repo/.gitignore"
  printf '{"name":"fake","version":"0.0.0"}\n' >"$repo/package.json"
  printf '{}\n' >"$repo/package-lock.json"
  git -C "$repo" init -q
  git -C "$repo" add .gitignore package.json package-lock.json
  git -C "$repo" -c user.email=t@t -c user.name=t commit -qm init
  head=$(git -C "$repo" rev-parse HEAD)
  : >"$repo/server/dist/index.js"
  : >"$repo/web/dist/index.html"
  sha256sum "$repo/package-lock.json" | awk '{print $1}' >"$repo/node_modules/.qubius-lock-hash"
  printf '{"head":"%s","version":"0.0.0","builtAt":"2026-01-01T00:00:00Z","dirty":false}\n' \
    "$head" >"$repo/server/dist/build.json"
  write_fake_build "$repo"
  # run.sh 只写 pidfile + 健康标记后长睡；被 SIGTERM 时清掉健康标记。
  cat >"$repo/deploy/run.sh" <<EOF
#!/bin/sh
echo \$\$ >"\${QUBIUS_DATA_PRIMARY}/qubius.pid"
: >"$HEALTH_MARK"
trap 'rm -f "$HEALTH_MARK"; exit 0' TERM
while :; do sleep 1; done
EOF
  chmod +x "$repo/deploy/run.sh"
}

write_stamp() {
  local data=$1 repo=$2 config=$3 port=${4:-} head ch eh
  head=$(git -C "$repo" rev-parse HEAD)
  ch=$(sha256sum "$config" | awk '{print $1}')
  eh=$(sha256sum "$EMPTY_ENV" | awk '{print $1}')
  printf '{"head":"%s","configHash":"%s","envHash":"%s","port":"%s"}\n' \
    "$head" "$ch" "$eh" "$port" >"$data/.deploy-stamp"
}

# fake curl：有健康标记时返回 200；没有时返回 000（服务未就绪）。
# activeSessions 从 ACTIVE_FILE 读取（纯数字或 "PORT=N" 行）。
cat >"$BUILT_FAKEBIN/curl" <<EOF
#!/bin/sh
port=0
for arg in "\$@"; do
  case \$arg in
    *'127.0.0.1:'*) port=\${arg##*127.0.0.1:}; port=\${port%%/*} ;;
  esac
done
active=0
mapped=""
if [ -f "$ACTIVE_FILE" ]; then
  mapped=\$(awk -F= -v p="\$port" '\$1 == p { print \$2; exit }' "$ACTIVE_FILE" 2>/dev/null || true)
  if [ -n "\$mapped" ]; then active=\$mapped; else active=\$(cat "$ACTIVE_FILE" 2>/dev/null || echo 0); fi
fi
if [ "\$mapped" = "down" ]; then
  for arg in "\$@"; do
    case \$arg in
      *'%{http_code}'*) printf '000'; exit 0 ;;
    esac
  done
  exit 22
fi
if [ -f "$HEALTH_MARK" ]; then
  for arg in "\$@"; do
    case \$arg in
      *'%{http_code}'*) printf '200'; exit 0 ;;
    esac
  done
  head_field=""
  if [ -n "\${HEAD_FILE:-}" ] && [ -f "\$HEAD_FILE" ]; then head_field=\$(cat "\$HEAD_FILE"); fi
  printf '{"ok":true,"activeSessions":%s,"head":"%s"}\n' "\$active" "\$head_field"
else
  for arg in "\$@"; do
    case \$arg in
      *'%{http_code}'*) printf '000'; exit 0 ;;
    esac
  done
  exit 22
fi
EOF
chmod +x "$BUILT_FAKEBIN/curl"

# fake ss：健康时按 pidfile 报告回环监听；否则不输出。
cat >"$BUILT_FAKEBIN/ss" <<EOF
#!/bin/sh
port=
for arg in "\$@"; do
  case \$arg in
    "sport = :"*) port=\${arg##*:} ;;
  esac
done
[ -f "$HEALTH_MARK" ] || exit 0
if [ -f "$ACTIVE_FILE" ]; then
  mapped=\$(awk -F= -v p="\$port" '\$1 == p { print \$2; exit }' "$ACTIVE_FILE" 2>/dev/null || true)
  [ "\$mapped" = "down" ] && exit 0
fi
pid=""
[ -f "$BUILT_DATA/qubius.pid" ] && pid=\$(head -n 1 "$BUILT_DATA/qubius.pid" | tr -dc '0-9')
[ -n "\$pid" ] || exit 0
printf 'LISTEN 0 511 127.0.0.1:%s 0.0.0.0:* users:(("node",pid=%s,fd=20))\n' "\$port" "\$pid"
EOF
chmod +x "$BUILT_FAKEBIN/ss"
printf '#!/bin/sh\nexit 1\n' >"$BUILT_FAKEBIN/systemctl"
chmod +x "$BUILT_FAKEBIN/systemctl"

make_built_repo "$BUILT_REPO"
printf 'role: primary\nlisten: 127.0.0.1:19789\n' >"$BUILT_CONFIG"

# 长驻的“旧实例”：健康标记存在、pidfile 指向它。
(
  trap 'rm -f "$HEALTH_MARK"; exit 0' TERM
  : >"$HEALTH_MARK"
  while :; do sleep 1; done
) &
HOLDER_PID=$!
echo "$HOLDER_PID" >"$BUILT_DATA/qubius.pid"
write_stamp "$BUILT_DATA" "$BUILT_REPO" "$BUILT_CONFIG"

RUN_ENV=(
  QUBIUS_START_PRIMARY=1
  QUBIUS_START_SECONDARY=0
  QUBIUS_PRIMARY_DIR="$BUILT_REPO"
  QUBIUS_DATA_PRIMARY="$BUILT_DATA"
  QUBIUS_PRIMARY_PORT=19789
  QUBIUS_START_LAN=0
  QUBIUS_OPS_TOKEN=test-token
  PATH="$BUILT_FAKEBIN:$PATH"
)

: >"$BUILD_LOG"
EXTRA_ENV=("${RUN_ENV[@]}")
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "no-change restart exit 0" 0 "$RC"
assert_contains "no-change restart message" "无变化，跳过重启" "$OUT"
assert_not_contains "no-change restart does not stop" "停止 主实例" "$OUT"
assert_not_contains "no-change restart does not build" "构建 主实例" "$OUT"
[[ ! -s $BUILD_LOG ]] || fail "无变化时不应构建"
[[ -f $HEALTH_MARK ]] || fail "无变化时旧实例应保持运行"

# ── 6. 源码变化：构建并重启 ────────────────────────────────────────────────
printf 'dirty\n' >"$BUILT_REPO/server/dirty.txt"
: >"$BUILD_LOG"
EXTRA_ENV=("${RUN_ENV[@]}")
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "source-change restart exit 0" 0 "$RC"
assert_contains "source-change builds" "构建 主实例" "$OUT"
assert_contains "source-change stops old" "停止 主实例" "$OUT"
assert_contains "source-change build ran" "build --stage $BUILT_REPO" "$(cat "$BUILD_LOG")"

# 回到干净工作区：后面的忙碌保护测试只需要重启，不需要构建。
rm -f "$BUILT_REPO/server/dirty.txt"
: >"$BUILD_LOG"

# ── 7. 忙碌保护：非 TTY + 有会话 → exit 3，不停旧进程、不构建 ───────────────
echo 2 >"$ACTIVE_FILE"
EXTRA_ENV=("${RUN_ENV[@]}" QUBIUS_DEPLOY_RESTART=1)
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "busy restart exit 3" 3 "$RC"
assert_contains "busy restart message" "非交互环境已中止部署" "$OUT"
[[ ! -s $BUILD_LOG ]] || fail "忙碌中止时不应构建"
[[ -f $HEALTH_MARK ]] || fail "忙碌中止时旧实例应保持运行"
assert_not_contains "busy restart does not stop" "停止 主实例" "$OUT"

# ── 8. FORCE=1：跳过忙碌保护继续重启 ───────────────────────────────────────
echo 2 >"$ACTIVE_FILE"
EXTRA_ENV=("${RUN_ENV[@]}" QUBIUS_DEPLOY_RESTART=1 QUBIUS_DEPLOY_FORCE=1)
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "force restart exit 0" 0 "$RC"
assert_contains "force restart message" "强制继续" "$OUT"
assert_contains "force restart stops old" "停止 主实例" "$OUT"

# ── 9. WAIT 超时：仍有会话 → exit 3，不重启 ─────────────────────────────────
echo 2 >"$ACTIVE_FILE"
EXTRA_ENV=("${RUN_ENV[@]}" QUBIUS_DEPLOY_RESTART=1 QUBIUS_DEPLOY_WAIT=1)
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "wait timeout exit 3" 3 "$RC"
assert_contains "wait timeout message" "等待 1 秒后仍有" "$OUT"
assert_not_contains "wait timeout does not stop" "停止 主实例" "$OUT"
[[ ! -s $BUILD_LOG ]] || fail "等待超时后不应构建"

# ── 10. WAIT 非法值：exit 3，提示改成整数秒 ────────────────────────────────
echo 2 >"$ACTIVE_FILE"
EXTRA_ENV=("${RUN_ENV[@]}" QUBIUS_DEPLOY_RESTART=1 QUBIUS_DEPLOY_WAIT=abc)
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "invalid wait exit 3" 3 "$RC"
assert_contains "invalid wait message" "必须是整数秒" "$OUT"
assert_not_contains "invalid wait does not stop" "停止 主实例" "$OUT"

# ── 11. 无变化且 pidfile 缺失：容忍 pidfile，只要健康就成功 ─────────────────
echo 0 >"$ACTIVE_FILE"
rm -f "$BUILT_DATA/qubius.pid"
: >"$BUILD_LOG"
EXTRA_ENV=("${RUN_ENV[@]}")
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "skip with missing pidfile exit 0" 0 "$RC"
assert_contains "skip with missing pidfile message" "无变化，跳过重启" "$OUT"
[[ ! -s $BUILD_LOG ]] || fail "无变化时不应构建"

# ── 12. 改端口：新端口不可达、旧端口有会话 → exit 3，不停旧进程 ─────────────
# 真实状态：旧进程只在 19789，新端口 19792 必然不可达（down）。
write_stamp "$BUILT_DATA" "$BUILT_REPO" "$BUILT_CONFIG" 19789
printf '19789=2\n19792=down\n' >"$ACTIVE_FILE"
EXTRA_ENV=("${RUN_ENV[@]}" QUBIUS_PRIMARY_PORT=19792 QUBIUS_DEPLOY_RESTART=1)
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "old stamp port busy exit 3" 3 "$RC"
assert_contains "old stamp port busy message" "非交互环境已中止部署" "$OUT"
assert_not_contains "old stamp port busy does not stop" "停止 主实例" "$OUT"
[[ -f $HEALTH_MARK ]] || fail "旧端口有会话时旧实例应保持运行"

# ── 12b. 普通 start（无 --restart）无变化：有会话也不停、不检查忙碌 ─────────
# make start 走这条路径；会话数不为 0 也必须保持 no-op。
# 前面的 pidfile 缺失用例不会重建 pidfile，这里先补一个指向当前实例的 pidfile。
if [[ ! -s $BUILT_DATA/qubius.pid ]]; then
  pid=$(pgrep -f "$BUILT_REPO/deploy/run.sh" | head -n 1 || true)
  [[ -n $pid ]] && echo "$pid" >"$BUILT_DATA/qubius.pid"
fi
printf '19789=2\n' >"$ACTIVE_FILE"
: >"$BUILD_LOG"
EXTRA_ENV=("${RUN_ENV[@]}")
capture run_start_all
EXTRA_ENV=()
assert_rc "plain start no-change exit 0" 0 "$RC"
assert_not_contains "plain start does not stop" "停止 主实例" "$OUT"
assert_not_contains "plain start does not check busy" "非交互环境已中止部署" "$OUT"
[[ -f $HEALTH_MARK ]] || fail "普通 start 无变化时旧实例应保持运行"
[[ ! -s $BUILD_LOG ]] || fail "普通 start 无变化时不应构建"

# 复位：清理前面测试可能留下的“pidfile 缺失”实例，起一个 pidfile 完整的旧实例。
pkill -f "$BUILT_REPO/deploy/run.sh" 2>/dev/null || true
sleep 0.3
rm -f "$HEALTH_MARK" "$BUILT_DATA/qubius.pid"
echo 0 >"$ACTIVE_FILE"
EXTRA_ENV=("${RUN_ENV[@]}")
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "reset old instance exit 0" 0 "$RC"
[[ -f $BUILT_DATA/qubius.pid ]] || fail "复位后应有 pidfile"

# ── 12c. --restart + QUBIUS_DEPLOY_RESTART=1：无变化也停/起（make restart）──
echo 0 >"$ACTIVE_FILE"
: >"$BUILD_LOG"
EXTRA_ENV=("${RUN_ENV[@]}" QUBIUS_DEPLOY_RESTART=1)
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "forced restart no-change exit 0" 0 "$RC"
assert_contains "forced restart stops" "停止 主实例" "$OUT"
assert_contains "forced restart starts" "启动 主实例" "$OUT"
[[ -f $HEALTH_MARK ]] || fail "强制重启后实例应重新健康"
[[ ! -s $BUILD_LOG ]] || fail "无变化强制重启不应构建"

# ── 13. staging 期间来会话：停止前复检 exit 3，旧版本继续运行，丢弃 staging ──
echo 0 >"$ACTIVE_FILE"
printf 'dirty\n' >"$BUILT_REPO/server/dirty-install.txt"
write_fake_build "$BUILT_REPO" "echo 2 >\"$ACTIVE_FILE\""
: >"$BUILD_LOG"
EXTRA_ENV=("${RUN_ENV[@]}")
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "stage busy recheck exit 3" 3 "$RC"
assert_contains "stage busy recheck message" "非交互环境已中止部署" "$OUT"
assert_contains "stage busy recheck built" "build --stage $BUILT_REPO" "$(cat "$BUILD_LOG")"
[[ -f $HEALTH_MARK ]] || fail "复检中止后旧版本应保持运行"
[[ -f $BUILT_DATA/qubius.pid ]] || fail "复检中止后旧版本 pidfile 应保留"
[[ ! -e $BUILT_REPO/server/dist.next && ! -e $BUILT_REPO/web/dist.next ]] \
  || fail "复检中止后应丢弃 staging"
write_fake_build "$BUILT_REPO"
rm -f "$BUILT_REPO/server/dirty-install.txt"

# ── 14. 新版本 health/HEAD 校验失败：回滚 .prev 并拉起旧版本 ─────────────────
echo 0 >"$ACTIVE_FILE"
printf 'old\n' >"$BUILT_REPO/server/dist/index.js"
printf 'dirty\n' >"$BUILT_REPO/server/dirty-rollback.txt"
# 上一次安装成功留下的 node_modules.prev 是陈旧依赖；本次不安装依赖，
# 失败回滚时绝不能拿它覆盖当前 node_modules。
mkdir -p "$BUILT_REPO/node_modules.prev"
printf 'stale\n' >"$BUILT_REPO/node_modules.prev/stale.txt"
printf 'keep\n' >"$BUILT_REPO/node_modules/keep.txt"
HEAD_FILE=$TMP/head-wrong
printf 'badhead\n' >"$HEAD_FILE"
: >"$BUILD_LOG"
EXTRA_ENV=("${RUN_ENV[@]}" HEAD_FILE="$HEAD_FILE")
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "rollback exit nonzero" 1 "$RC"
assert_contains "rollback message" "已回滚到旧版本" "$OUT"
[[ -f $HEALTH_MARK ]] || fail "回滚后旧版本应保持运行"
[[ $(cat "$BUILT_REPO/server/dist/index.js") == old ]] || fail "回滚后 live 应为旧产物"
[[ ! -e $BUILT_REPO/server/dist.prev ]] || fail "回滚后不应残留 .prev"
# 本次没有安装依赖，陈旧 node_modules.prev 不应覆盖当前依赖。
[[ $(cat "$BUILT_REPO/node_modules/keep.txt") == keep ]] || fail "陈旧 node_modules.prev 不应被恢复"
[[ $(cat "$BUILT_REPO/node_modules.prev/stale.txt") == stale ]] || fail "陈旧 node_modules.prev 不应被消费"
rm -f "$HEAD_FILE" "$BUILT_REPO/server/dirty-rollback.txt"
rm -rf "$BUILT_REPO/node_modules.prev"

# ── 15. 安装依赖失败：恢复 node_modules 并拉起旧版本 ────────────────────────
mkdir -p "$BUILT_REPO/node_modules"
printf 'keep\n' >"$BUILT_REPO/node_modules/keep.txt"
printf 'stale\n' >"$BUILT_REPO/node_modules/.qubius-lock-hash"
: >"$BUILT_REPO/FAIL_DEPS"
printf 'dirty\n' >"$BUILT_REPO/server/dirty-deps.txt"
: >"$BUILD_LOG"
EXTRA_ENV=("${RUN_ENV[@]}")
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "deps failure exit 1" 1 "$RC"
assert_contains "deps failure message" "安装依赖失败" "$OUT"
[[ -f $BUILT_REPO/node_modules/keep.txt ]] || fail "安装失败后应恢复 node_modules"
[[ ! -e $BUILT_REPO/node_modules.prev ]] || fail "恢复后不应残留 node_modules.prev"
[[ -f $HEALTH_MARK ]] || fail "安装失败后旧版本应保持运行"
rm -f "$BUILT_REPO/FAIL_DEPS" "$BUILT_REPO/server/dirty-deps.txt"

# ── 16. 首次部署没有 .prev：启动失败时明确报告“无旧版本可回滚” ──────────────
echo 0 >"$ACTIVE_FILE"
# 依赖哈希匹配，走“不安装依赖”的 staging 路径；删掉 live 模拟首次部署。
sha256sum "$BUILT_REPO/package-lock.json" | awk '{print $1}' \
  >"$BUILT_REPO/node_modules/.qubius-lock-hash"
rm -rf "$BUILT_REPO/server/dist" "$BUILT_REPO/web/dist" \
  "$BUILT_REPO/server/dist.prev" "$BUILT_REPO/web/dist.prev"
HEAD_FILE=$TMP/head-first
printf 'badhead\n' >"$HEAD_FILE"
: >"$BUILD_LOG"
EXTRA_ENV=("${RUN_ENV[@]}" HEAD_FILE="$HEAD_FILE")
capture run_start_all --restart
EXTRA_ENV=()
assert_rc "first deploy no-prev exit 1" 1 "$RC"
assert_contains "first deploy no-prev message" "无旧版本可回滚" "$OUT"
assert_not_contains "first deploy does not fake rollback" "已回滚到旧版本" "$OUT"
[[ ! -e $BUILT_REPO/server/dist.prev ]] || fail "首次部署不应产生 .prev"
[[ ! -f $HEALTH_MARK ]] || fail "无旧版本可回滚时服务应保持停止"
rm -f "$HEAD_FILE"

echo "deploy/start-all.sh 安全路径测试通过"
