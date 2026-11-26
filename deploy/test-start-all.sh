#!/bin/bash
# deploy/start-all.sh 的安全路径冒烟测试：
# 只测试 --help、未知参数、两个角色都关闭、systemd 接管检测（fake systemctl）。
# 绝不启动真实 server、不写真实 crontab/systemd、不监听真实端口。
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
  if OUT=$("$@" 2>&1); then
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

echo "deploy/start-all.sh 安全路径测试通过"
