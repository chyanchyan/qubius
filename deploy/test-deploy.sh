#!/bin/bash
# deploy/deploy.sh 的安全路径冒烟测试：
# 只测试参数解析、角色开关和 systemd 接管路径（fake systemctl/curl/ss）。
# 绝不构建真实 checkout、重启真实 unit、监听真实端口。
#
# 设置 QUBIUS_OPS_TOKEN 让 qubius_ops_claim 直接跳过，避免测试依赖 ops lock 状态。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

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

mkdir -p "$TMP/home" "$TMP/config" "$TMP/data-q" "$TMP/data-co" "$TMP/fakebin"
EMPTY_ENV=$TMP/empty.env
: >"$EMPTY_ENV"
ACTIVE_FILE=$TMP/active
: >"$ACTIVE_FILE"
BUILD_LOG=$TMP/build.log
SYSTEMCTL_LOG=$TMP/systemctl.log
: >"$BUILD_LOG"
: >"$SYSTEMCTL_LOG"

# 生成支持 --deps/--stage/--swap/--rollback 的假 build.sh。
# 第二个参数是 --stage 成功后执行的 shell 片段（模拟构建期间新来会话）。
write_fake_build() {
  local repo=$1 stage_hook=${2:-}
  cat >"$repo/deploy/build.sh" <<EOF
#!/bin/sh
mode=\$1
repo=\$2
echo "build \$mode \$repo" >>"$BUILD_LOG"
case \$mode in
  --stage)
    head=\$(git -C "\$repo" rev-parse HEAD 2>/dev/null || true)
    mkdir -p "\$repo/server/dist.next" "\$repo/web/dist.next"
    : >"\$repo/server/dist.next/index.js"
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

# 假的 checkout：只有 build.sh，verify 走假的 curl，不需要真实产物。
make_repo() {
  local repo=$1
  mkdir -p "$repo/deploy"
  write_fake_build "$repo"
}
make_repo "$TMP/primary-repo"
make_repo "$TMP/secondary-repo"

# 看起来“已构建完成”的 checkout：有产物、依赖标记和干净的 git 工作区，
# 用来验证“无变化跳过重启”的决策。
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
}

# 写入与当前状态一致的部署 stamp。
write_stamp() {
  local data=$1 repo=$2 config=$3 head ch eh
  head=$(git -C "$repo" rev-parse HEAD)
  ch=$(sha256sum "$config" | awk '{print $1}')
  eh=$(sha256sum "$EMPTY_ENV" | awk '{print $1}')
  printf '{"head":"%s","configHash":"%s","envHash":"%s"}\n' "$head" "$ch" "$eh" \
    >"$data/.deploy-stamp"
}

# fake systemctl：is-enabled 返回 0（表示 unit 已接管），restart 记录调用。
cat >"$TMP/fakebin/systemctl" <<EOF
#!/bin/sh
echo "\$*" >>"$SYSTEMCTL_LOG"
if [ -n "\${FAKE_STOP_FAIL_UNIT:-}" ]; then
  case "\$*" in *" stop \$FAKE_STOP_FAIL_UNIT"*) exit 1 ;; esac
fi
for arg in "\$@"; do
  case \$arg in
    is-enabled) exit 0 ;;
    show) printf 'loaded\n'; exit 0 ;;
    is-active) exit 1 ;;
  esac
done
exit 0
EOF
chmod +x "$TMP/fakebin/systemctl"

# fake curl：健康检查返回 200；activeSessions 从 FAKE_ACTIVE_FILE 读取。
# 文件可以是纯数字（所有端口相同），也可以是 "PORT=N" 行（按端口区分）。
cat >"$TMP/fakebin/curl" <<'EOF'
#!/bin/sh
port=0
for arg in "$@"; do
  case $arg in
    *'127.0.0.1:'*)
      port=${arg##*127.0.0.1:}
      port=${port%%/*}
      ;;
  esac
done
active=0
if [ -n "${FAKE_ACTIVE_FILE:-}" ] && [ -f "$FAKE_ACTIVE_FILE" ]; then
  mapped=$(awk -F= -v p="$port" '$1 == p { print $2; exit }' "$FAKE_ACTIVE_FILE" 2>/dev/null || true)
  if [ -n "$mapped" ]; then
    active=$mapped
  else
    active=$(cat "$FAKE_ACTIVE_FILE" 2>/dev/null || echo 0)
  fi
fi
for arg in "$@"; do
  case $arg in
    *'%{http_code}'*) printf '200'; exit 0 ;;
  esac
done
head=""
if [ -n "${FAKE_HEAD_FILE:-}" ] && [ -f "$FAKE_HEAD_FILE" ]; then head=$(cat "$FAKE_HEAD_FILE"); fi
printf '{"ok":true,"activeSessions":%s,"head":"%s"}\n' "$active" "$head"
EOF
chmod +x "$TMP/fakebin/curl"

# fake ss：按查询端口模拟局域网地址上已有监听。
cat >"$TMP/fakebin/ss" <<'EOF'
#!/bin/sh
port=
for arg in "$@"; do
  case $arg in
    "sport = :"*) port=${arg##*:} ;;
  esac
done
printf 'LISTEN 0 511 192.168.1.2:%s 0.0.0.0:*\n' "$port"
EOF
chmod +x "$TMP/fakebin/ss"

EXTRA_ENV=()
OUT=""
RC=0

run_deploy() {
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
    QUBIUS_OPS_TOKEN=test-token \
    FAKE_ACTIVE_FILE="$ACTIVE_FILE" \
    PATH="$TMP/fakebin:$PATH" \
    ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
    bash "$HERE/deploy.sh" "$@"
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
capture run_deploy --help
assert_rc "--help exit 0" 0 "$RC"
assert_contains "--help prints usage" "用法：" "$OUT"

# ── 2. 未知模式 exit 2 ──────────────────────────────────────────────────────
capture run_deploy bogus
assert_rc "unknown mode exit 2" 2 "$RC"
assert_contains "unknown mode message" "未知模式" "$OUT"

# ── 3. 两个角色都关闭：不构建、不重启 ───────────────────────────────────────
EXTRA_ENV=(QUBIUS_START_PRIMARY=0 QUBIUS_START_SECONDARY=0)
capture run_deploy local
EXTRA_ENV=()
assert_rc "both roles disabled exit 0" 0 "$RC"
assert_contains "both roles disabled message" "没有启用的实例" "$OUT"
[[ ! -s $BUILD_LOG ]] || fail "两个角色关闭时不应构建"
[[ ! -s $SYSTEMCTL_LOG ]] || fail "两个角色关闭时不应调用 systemctl"

# ── 4. systemd local：只重启实例 unit，不动局域网入口 ───────────────────────
EXTRA_ENV=(QUBIUS_START_PRIMARY=1 QUBIUS_START_SECONDARY=0)
capture run_deploy local
EXTRA_ENV=()
assert_rc "systemd local exit 0" 0 "$RC"
assert_contains "systemd local health" "已就绪：http://127.0.0.1:19787" "$OUT"
assert_contains "systemd local builds" "build --stage $TMP/primary-repo" "$(cat "$BUILD_LOG")"
assert_contains "systemd local restarts service" "restart qubius.service" "$(cat "$SYSTEMCTL_LOG")"
assert_not_contains "systemd local leaves proxy" "qubius-proxy.service" "$(cat "$SYSTEMCTL_LOG")"

# ── 5. systemd lan：实例和局域网入口都重启，并检查 LAN 监听 ─────────────────
: >"$SYSTEMCTL_LOG"
EXTRA_ENV=(QUBIUS_START_PRIMARY=1 QUBIUS_START_SECONDARY=0)
capture run_deploy lan
EXTRA_ENV=()
assert_rc "systemd lan exit 0" 0 "$RC"
assert_contains "systemd lan restarts service" "restart qubius.service" "$(cat "$SYSTEMCTL_LOG")"
assert_contains "systemd lan restarts proxy" "restart qubius-proxy.service" "$(cat "$SYSTEMCTL_LOG")"
assert_contains "systemd lan waits proxy" "局域网入口已就绪（端口 19787）" "$OUT"

# ── 6. 缺仓库目录时报错 ─────────────────────────────────────────────────────
EXTRA_ENV=(QUBIUS_START_PRIMARY=1 QUBIUS_START_SECONDARY=0 QUBIUS_PRIMARY_DIR="$TMP/missing")
capture run_deploy local
EXTRA_ENV=()
assert_rc "missing repo exit 1" 1 "$RC"
assert_contains "missing repo message" "仓库目录不存在" "$OUT"

# ── 7. 忙碌保护：非 TTY + 有会话 → exit 3，不构建、不重启 ───────────────────
BUILT_REPO=$TMP/built-repo
BUILT_DATA=$TMP/data-built
BUILT_CONFIG=$TMP/config/config.yaml
mkdir -p "$BUILT_DATA"
make_built_repo "$BUILT_REPO"
printf 'role: primary\nlisten: 127.0.0.1:19789\n' >"$BUILT_CONFIG"

BUILT_ENV=(
  QUBIUS_START_PRIMARY=1
  QUBIUS_START_SECONDARY=0
  QUBIUS_PRIMARY_DIR="$BUILT_REPO"
  QUBIUS_DATA_PRIMARY="$BUILT_DATA"
  QUBIUS_PRIMARY_PORT=19789
)

: >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"; echo 2 >"$ACTIVE_FILE"
EXTRA_ENV=("${BUILT_ENV[@]}")
capture run_deploy local
EXTRA_ENV=()
assert_rc "busy non-tty exit 3" 3 "$RC"
assert_contains "busy non-tty message" "非交互环境已中止部署" "$OUT"
! grep -q ' restart ' "$SYSTEMCTL_LOG" || fail "忙碌中止时不应调用 systemctl restart"
[[ ! -s $BUILD_LOG ]] || fail "忙碌中止时不应构建"

# ── 8. FORCE=1：跳过忙碌保护继续重启 ───────────────────────────────────────
: >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"; echo 2 >"$ACTIVE_FILE"
EXTRA_ENV=("${BUILT_ENV[@]}" QUBIUS_DEPLOY_FORCE=1)
capture run_deploy local
EXTRA_ENV=()
assert_rc "force busy exit 0" 0 "$RC"
assert_contains "force busy message" "强制继续" "$OUT"
assert_contains "force busy restarts" "restart qubius.service" "$(cat "$SYSTEMCTL_LOG")"

# ── 9. WAIT 超时：仍有会话 → exit 3，不重启 ─────────────────────────────────
: >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"; echo 2 >"$ACTIVE_FILE"
EXTRA_ENV=("${BUILT_ENV[@]}" QUBIUS_DEPLOY_RESTART=1 QUBIUS_DEPLOY_WAIT=1)
capture run_deploy local
EXTRA_ENV=()
assert_rc "wait timeout exit 3" 3 "$RC"
assert_contains "wait timeout message" "等待 1 秒后仍有" "$OUT"
! grep -q ' restart ' "$SYSTEMCTL_LOG" || fail "等待超时后不应调用 systemctl restart"

# ── 10. 无变化（stamp 匹配、健康）→ 不构建、不重启 ─────────────────────────
: >"$ACTIVE_FILE"
write_stamp "$BUILT_DATA" "$BUILT_REPO" "$BUILT_CONFIG"
: >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"
EXTRA_ENV=("${BUILT_ENV[@]}")
capture run_deploy local
EXTRA_ENV=()
assert_rc "no-change exit 0" 0 "$RC"
assert_contains "no-change message" "无变化，跳过重启" "$OUT"
! grep -q ' restart ' "$SYSTEMCTL_LOG" || fail "无变化时不应调用 systemctl restart"
[[ ! -s $BUILD_LOG ]] || fail "无变化时不应构建"

# ── 11. config 变化 → 重启但不重建 ──────────────────────────────────────────
printf '# changed\n' >>"$BUILT_CONFIG"
: >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"
EXTRA_ENV=("${BUILT_ENV[@]}")
capture run_deploy local
EXTRA_ENV=()
assert_rc "config-change exit 0" 0 "$RC"
assert_contains "config-change restarts" "restart qubius.service" "$(cat "$SYSTEMCTL_LOG")"
[[ ! -s $BUILD_LOG ]] || fail "config 变化只需重启，不应重新构建"

# ── 12. QUBIUS_DEPLOY_RESTART=1 → 无变化也重启 ──────────────────────────────
: >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"
EXTRA_ENV=("${BUILT_ENV[@]}" QUBIUS_DEPLOY_RESTART=1)
capture run_deploy local
EXTRA_ENV=()
assert_rc "force restart exit 0" 0 "$RC"
assert_contains "force restart restarts" "restart qubius.service" "$(cat "$SYSTEMCTL_LOG")"
[[ ! -s $BUILD_LOG ]] || fail "强制重启且无需构建时不应重新构建"

# ── 13. 双角色：后一个角色忙时，前一个角色在停进程之前就中止 ───────────────
# 复现“前一个角色因 npm ci 已被停、后一个角色遇忙 exit 3 导致前一个不再重启”。
PAIR_PRIMARY=$TMP/pair-primary
PAIR_SECONDARY=$TMP/pair-secondary
PAIR_DATA_P=$TMP/data-pair-p
PAIR_DATA_S=$TMP/data-pair-s
mkdir -p "$PAIR_DATA_P" "$PAIR_DATA_S"
make_built_repo "$PAIR_PRIMARY"
make_built_repo "$PAIR_SECONDARY"
# 主角色缺少 node_modules：需要先停 unit 再 npm ci。
rm -rf "$PAIR_PRIMARY/node_modules"
# 副角色没有 stamp：需要重启，且该端口上有进行中的会话。
printf '19790=0\n19791=2\n' >"$ACTIVE_FILE"
: >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"
EXTRA_ENV=(
  QUBIUS_START_PRIMARY=1
  QUBIUS_START_SECONDARY=1
  QUBIUS_PRIMARY_DIR="$PAIR_PRIMARY"
  QUBIUS_SECONDARY_DIR="$PAIR_SECONDARY"
  QUBIUS_DATA_PRIMARY="$PAIR_DATA_P"
  QUBIUS_DATA_SECONDARY="$PAIR_DATA_S"
  QUBIUS_PRIMARY_PORT=19790
  QUBIUS_SECONDARY_PORT=19791
)
capture run_deploy local
EXTRA_ENV=()
assert_rc "pair busy exit 3" 3 "$RC"
assert_contains "pair busy message" "非交互环境已中止部署" "$OUT"
! grep -Eq ' (stop|restart) ' "$SYSTEMCTL_LOG" \
  || fail "后一个角色忙时，前一个角色不应已被停止或重启"
[[ ! -s $BUILD_LOG ]] || fail "后一个角色忙时不应构建任何角色"

# ── 14. 构建期间新出现的会话：重启前复检并 exit 3 ─────────────────────────
RECHECK_REPO=$TMP/recheck-repo
RECHECK_DATA=$TMP/data-recheck
mkdir -p "$RECHECK_DATA"
make_built_repo "$RECHECK_REPO"
# 只让源码变脏（不需要 npm ci）；构建脚本模拟“构建期间新来了 2 个会话”。
printf 'pending\n' >"$RECHECK_REPO/server/pending.js"
write_fake_build "$RECHECK_REPO" "echo 2 >\"$ACTIVE_FILE\""
echo 0 >"$ACTIVE_FILE"
: >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"
EXTRA_ENV=(
  QUBIUS_START_PRIMARY=1
  QUBIUS_START_SECONDARY=0
  QUBIUS_PRIMARY_DIR="$RECHECK_REPO"
  QUBIUS_DATA_PRIMARY="$RECHECK_DATA"
  QUBIUS_PRIMARY_PORT=19792
)
capture run_deploy local
EXTRA_ENV=()
assert_rc "post-build busy exit 3" 3 "$RC"
assert_contains "post-build busy message" "非交互环境已中止部署" "$OUT"
[[ -s $BUILD_LOG ]] || fail "应完成构建后再复检会话"
! grep -Eq ' (stop|restart) ' "$SYSTEMCTL_LOG" \
  || fail "构建后复检发现会话时不应重启"

# ── 15. 构建后另一角色变忙：中止前把已停角色按当前产物重新拉起 ─────────────
REC_PRIMARY=$TMP/recover-primary
REC_SECONDARY=$TMP/recover-secondary
REC_DATA_P=$TMP/data-recover-p
REC_DATA_S=$TMP/data-recover-s
mkdir -p "$REC_DATA_P" "$REC_DATA_S"
make_built_repo "$REC_PRIMARY"
make_built_repo "$REC_SECONDARY"
# 主角色需要 npm ci：会被先停掉。
rm -rf "$REC_PRIMARY/node_modules"
# 副角色构建脚本模拟“构建期间新来 2 个会话”。
printf 'pending\n' >"$REC_SECONDARY/server/pending.js"
write_fake_build "$REC_SECONDARY" "printf '19793=0\n19794=2\n' >\"$ACTIVE_FILE\""
printf '19793=0\n19794=0\n' >"$ACTIVE_FILE"
: >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"
EXTRA_ENV=(
  QUBIUS_START_PRIMARY=1
  QUBIUS_START_SECONDARY=1
  QUBIUS_PRIMARY_DIR="$REC_PRIMARY"
  QUBIUS_SECONDARY_DIR="$REC_SECONDARY"
  QUBIUS_DATA_PRIMARY="$REC_DATA_P"
  QUBIUS_DATA_SECONDARY="$REC_DATA_S"
  QUBIUS_PRIMARY_PORT=19793
  QUBIUS_SECONDARY_PORT=19794
)
capture run_deploy local
EXTRA_ENV=()
assert_rc "recover stopped role exit 3" 3 "$RC"
assert_contains "recover stopped role message" "先重新拉起 主实例" "$OUT"
assert_contains "recover restarts primary" "restart qubius.service" "$(cat "$SYSTEMCTL_LOG")"
! grep -q 'restart co-qubius.service' "$SYSTEMCTL_LOG" \
  || fail "忙碌的副实例不应被重启"
assert_contains "recover built primary" "build --stage $REC_PRIMARY" "$(cat "$BUILD_LOG")"

# ── 16. 新版本启动失败：回滚 .prev、旧版起来，且不恢复陈旧 node_modules.prev ─
RB_REPO=$TMP/rollback-repo
RB_DATA=$TMP/data-rollback
mkdir -p "$RB_DATA"
make_built_repo "$RB_REPO"
printf 'old\n' >"$RB_REPO/server/dist/index.js"
mkdir -p "$RB_REPO/node_modules.prev"
printf 'stale\n' >"$RB_REPO/node_modules.prev/stale.txt"
mkdir -p "$RB_REPO/node_modules"
printf 'keep\n' >"$RB_REPO/node_modules/keep.txt"
printf 'dirty\n' >"$RB_REPO/server/dirty-rollback.txt"
HEAD_FILE=$TMP/head-bad
printf 'badhead\n' >"$HEAD_FILE"
echo 0 >"$ACTIVE_FILE"; : >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"
EXTRA_ENV=(
  QUBIUS_START_PRIMARY=1
  QUBIUS_START_SECONDARY=0
  QUBIUS_PRIMARY_DIR="$RB_REPO"
  QUBIUS_DATA_PRIMARY="$RB_DATA"
  QUBIUS_PRIMARY_PORT=19795
  FAKE_HEAD_FILE="$HEAD_FILE"
)
capture run_deploy local
EXTRA_ENV=()
assert_rc "systemd rollback exit 1" 1 "$RC"
assert_contains "systemd rollback message" "已回滚到旧版本" "$OUT"
assert_contains "systemd rollback restarts" "restart qubius.service" "$(cat "$SYSTEMCTL_LOG")"
[[ $(cat "$RB_REPO/server/dist/index.js") == old ]] || fail "systemd 回滚后 live 应为旧产物"
[[ ! -e $RB_REPO/server/dist.prev ]] || fail "systemd 回滚后不应残留 .prev"
[[ $(cat "$RB_REPO/node_modules/keep.txt") == keep ]] \
  || fail "systemd 回滚不应恢复陈旧 node_modules.prev"
[[ $(cat "$RB_REPO/node_modules.prev/stale.txt") == stale ]] \
  || fail "陈旧 node_modules.prev 不应被消费"
rm -f "$HEAD_FILE" "$RB_REPO/server/dirty-rollback.txt"

# ── 17. 停止失败：恢复此前已停角色（依赖备份 + 旧版本）再退出 ───────────────
SF_P=$TMP/stopfail-primary
SF_S=$TMP/stopfail-secondary
SF_DP=$TMP/data-stopfail-p
SF_DS=$TMP/data-stopfail-s
mkdir -p "$SF_DP" "$SF_DS"
make_built_repo "$SF_P"
make_built_repo "$SF_S"
# 两个角色都需要 npm ci（哈希过期），主角色会被先停并备份 node_modules。
printf 'stale\n' >"$SF_P/node_modules/.qubius-lock-hash"
printf 'stale\n' >"$SF_S/node_modules/.qubius-lock-hash"
printf 'keep\n' >"$SF_P/node_modules/keep.txt"
echo 0 >"$ACTIVE_FILE"; : >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"
EXTRA_ENV=(
  QUBIUS_START_PRIMARY=1
  QUBIUS_START_SECONDARY=1
  QUBIUS_PRIMARY_DIR="$SF_P"
  QUBIUS_SECONDARY_DIR="$SF_S"
  QUBIUS_DATA_PRIMARY="$SF_DP"
  QUBIUS_DATA_SECONDARY="$SF_DS"
  QUBIUS_PRIMARY_PORT=19796
  QUBIUS_SECONDARY_PORT=19797
  FAKE_STOP_FAIL_UNIT=co-qubius.service
)
capture run_deploy local
EXTRA_ENV=()
assert_rc "stop failure exit 1" 1 "$RC"
assert_contains "stop failure message" "停止失败，恢复已停角色" "$OUT"
assert_contains "stop failure restarts stopped role" "restart qubius.service" "$(cat "$SYSTEMCTL_LOG")"
[[ -f $SF_P/node_modules/keep.txt ]] || fail "停止失败后应恢复已停角色的 node_modules"
[[ ! -e $SF_P/node_modules.prev ]] || fail "已恢复角色的 node_modules.prev 应被消费"
[[ ! -e $SF_S/node_modules.prev ]] || fail "未备份的角色不应产生 node_modules.prev"
[[ -d $SF_S/node_modules ]] || fail "副角色 node_modules 不应被删除"

# ── 17b. 主循环停止失败：恢复此前因 npm ci 停掉、尚未启动的角色 ──────────────
SF2_P=$TMP/stopfail2-primary
SF2_S=$TMP/stopfail2-secondary
SF2_DP=$TMP/data-stopfail2-p
SF2_DS=$TMP/data-stopfail2-s
mkdir -p "$SF2_DP" "$SF2_DS"
make_built_repo "$SF2_P"
make_built_repo "$SF2_S"
printf 'dirty\n' >"$SF2_P/server/dirty.txt"          # 主：只需构建
printf 'stale\n' >"$SF2_S/node_modules/.qubius-lock-hash"  # 副：需要 npm ci
printf 'keep-s\n' >"$SF2_S/node_modules/keep.txt"
echo 0 >"$ACTIVE_FILE"; : >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"
EXTRA_ENV=(
  QUBIUS_START_PRIMARY=1
  QUBIUS_START_SECONDARY=1
  QUBIUS_PRIMARY_DIR="$SF2_P"
  QUBIUS_SECONDARY_DIR="$SF2_S"
  QUBIUS_DATA_PRIMARY="$SF2_DP"
  QUBIUS_DATA_SECONDARY="$SF2_DS"
  QUBIUS_PRIMARY_PORT=19799
  QUBIUS_SECONDARY_PORT=19800
  FAKE_STOP_FAIL_UNIT=qubius.service
)
capture run_deploy local
EXTRA_ENV=()
assert_rc "main stop failure exit 1" 1 "$RC"
assert_contains "main stop failure message" "停止失败，恢复已停角色" "$OUT"
assert_contains "main stop failure restores secondary" "restart co-qubius.service" "$(cat "$SYSTEMCTL_LOG")"
[[ $(cat "$SF2_S/node_modules/keep.txt") == keep-s ]] || fail "停止失败后应恢复副角色 node_modules"
[[ ! -e $SF2_S/node_modules.prev ]] || fail "恢复后不应残留副角色 node_modules.prev"
[[ ! -e $SF2_P/node_modules.prev ]] || fail "未安装依赖的主角色不应产生 node_modules.prev"

# ── 18. 首次部署没有 .prev：启动失败时明确“无旧版本可回滚”，不重启新产物 ─────
FD_REPO=$TMP/first-deploy-repo
FD_DATA=$TMP/data-first-deploy
mkdir -p "$FD_DATA"
make_built_repo "$FD_REPO"
rm -rf "$FD_REPO/server/dist" "$FD_REPO/web/dist"   # 没有旧 live
HEAD_FILE=$TMP/head-first-bad
printf 'badhead\n' >"$HEAD_FILE"
echo 0 >"$ACTIVE_FILE"; : >"$BUILD_LOG"; : >"$SYSTEMCTL_LOG"
EXTRA_ENV=(
  QUBIUS_START_PRIMARY=1
  QUBIUS_START_SECONDARY=0
  QUBIUS_PRIMARY_DIR="$FD_REPO"
  QUBIUS_DATA_PRIMARY="$FD_DATA"
  QUBIUS_PRIMARY_PORT=19798
  FAKE_HEAD_FILE="$HEAD_FILE"
)
capture run_deploy local
EXTRA_ENV=()
assert_rc "first deploy no-prev exit 1" 1 "$RC"
assert_contains "first deploy no-prev message" "无旧版本可回滚" "$OUT"
assert_not_contains "first deploy does not fake rollback" "已回滚到旧版本" "$OUT"
[[ ! -e $FD_REPO/server/dist.prev ]] || fail "首次部署不应产生 .prev"
rm -f "$HEAD_FILE"

echo "deploy/deploy.sh 安全路径测试通过"
