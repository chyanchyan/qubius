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
BUILD_LOG=$TMP/build.log
SYSTEMCTL_LOG=$TMP/systemctl.log
: >"$BUILD_LOG"
: >"$SYSTEMCTL_LOG"

# 假的 checkout：只有 build.sh，verify 走假的 curl，不需要真实产物。
make_repo() {
  local repo=$1
  mkdir -p "$repo/deploy"
  cat >"$repo/deploy/build.sh" <<EOF
#!/bin/sh
echo "build \$1" >>"$BUILD_LOG"
EOF
  chmod +x "$repo/deploy/build.sh"
}
make_repo "$TMP/primary-repo"
make_repo "$TMP/secondary-repo"

# fake systemctl：is-enabled 返回 0（表示 unit 已接管），restart 记录调用。
cat >"$TMP/fakebin/systemctl" <<EOF
#!/bin/sh
echo "\$*" >>"$SYSTEMCTL_LOG"
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

# fake curl：健康检查返回 200 和空 JSON（没有 head 时跳过 git 校验）。
cat >"$TMP/fakebin/curl" <<'EOF'
#!/bin/sh
for arg in "$@"; do
  case $arg in
    *'%{http_code}'*) printf '200'; exit 0 ;;
  esac
done
printf '{}'
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
    PATH="$TMP/fakebin:$PATH" \
    ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
    bash "$HERE/deploy.sh" "$@"
}

capture() {
  OUT=""
  if OUT=$("$@" 2>&1); then
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
assert_contains "systemd local builds" "build $TMP/primary-repo" "$(cat "$BUILD_LOG")"
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

echo "deploy/deploy.sh 安全路径测试通过"
