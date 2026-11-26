#!/bin/bash
# deploy/lib.sh 与 render.mjs 的契约测试。不依赖真实用户目录。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
: >"$TMP/empty.env"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  [[ $1 == "$2" ]] || fail "期望 [$2]，实际 [$1]${3:+（$3）}"
}

# 在隔离的 HOME/XDG 下加载 lib，打印派生变量。
probe() {
  local envfile=${1:-}
  shift || true
  # 清掉外部 QUBIUS_*，并显式指定 env 来源，避免真实 deploy/env 影响默认值断言。
  local unset_args=() name
  while IFS= read -r name; do unset_args+=(-u "$name"); done \
    < <(compgen -e | grep '^QUBIUS_' || true)
  env "${unset_args[@]}" HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/config" XDG_DATA_HOME="$TMP/data" \
    QUBIUS_ENV="${envfile:-$TMP/empty.env}" "$@" \
    bash -c '
      source "$1"
      qubius_load
      printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n" \
        "$QUBIUS_ROLE" "$QUBIUS_INSTANCE" "$QUBIUS_CONFIG_DIR" "$QUBIUS_DATA_DIR" \
        "$QUBIUS_PORT" "$QUBIUS_CONFIG_FILE" "$QUBIUS_SERVICE" "$QUBIUS_PROXY_SERVICE" \
        "$QUBIUS_REPO_DIR" "$QUBIUS_PUBLIC_HOST_ACTIVE"
    ' _ "$HERE/lib.sh"
}

mkdir -p "$TMP/home" "$TMP/config" "$TMP/data"

# 1. 默认值：主实例。
out=$(probe)
IFS='|' read -r role instance cfgdir datadir port cfgfile service proxy repo host <<<"$out"
REPO=$(cd "$HERE/.." && pwd)
assert_eq "$role" primary role
assert_eq "$instance" qubius instance
assert_eq "$cfgdir" "$REPO/.qubius" config-dir
assert_eq "$datadir" "$REPO/.qubius/data" data-dir
assert_eq "$port" 8787 port
assert_eq "$cfgfile" "$REPO/.qubius/config.yaml" config-file
assert_eq "$service" qubius.service service
assert_eq "$proxy" qubius-proxy.service proxy-service
assert_eq "$repo" "$REPO" repo-dir
assert_eq "$host" code.example.com public-host

# 2. 开关：QUBIUS_SECONDARY=1 切到副实例。
out=$(probe '' QUBIUS_SECONDARY=1)
IFS='|' read -r role instance cfgdir datadir port cfgfile service proxy repo host <<<"$out"
assert_eq "$role" secondary role
assert_eq "$instance" co-qubius instance
assert_eq "$datadir" "$TMP/home/co-qubius/.qubius/data" data-dir
assert_eq "$port" 8788 port
assert_eq "$cfgfile" "$REPO/.qubius/config-secondary.yaml" config-file
assert_eq "$service" co-qubius.service service
assert_eq "$proxy" co-qubius-proxy.service proxy-service
assert_eq "$host" code-bak.example.com public-host

# 3. env 文件提供值和路径。
cat >"$TMP/env" <<'EOF'
QUBIUS_PRIMARY_DIR=/srv/qubius
QUBIUS_SECONDARY_DIR=/srv/co-qubius
QUBIUS_DATA_PRIMARY=/var/lib/qubius
QUBIUS_DATA_SECONDARY=/var/lib/co-qubius
QUBIUS_PRIMARY_PORT=9787
QUBIUS_SECONDARY_PORT=9788
QUBIUS_PUBLIC_HOST=example.test
QUBIUS_PUBLIC_HOST_SECONDARY=co.example.test
QUBIUS_SECONDARY=1
EOF
out=$(probe "$TMP/env")
IFS='|' read -r role instance cfgdir datadir port cfgfile service proxy repo host <<<"$out"
assert_eq "$role" secondary role
assert_eq "$datadir" /var/lib/co-qubius data-dir
assert_eq "$port" 9788 port
assert_eq "$host" co.example.test public-host

# 4. 调用者导出的变量优先于 env 文件。
out=$(probe "$TMP/env" QUBIUS_SECONDARY=0)
IFS='|' read -r role instance cfgdir datadir port cfgfile service proxy repo host <<<"$out"
assert_eq "$role" primary role
assert_eq "$port" 9787 port
assert_eq "$datadir" /var/lib/qubius data-dir

# 5. 布尔值兼容 true/false，非法值失败。
out=$(probe '' QUBIUS_SECONDARY=true)
[[ $out == secondary* ]] || fail "QUBIUS_SECONDARY=true 未切到副实例：$out"
if probe '' QUBIUS_SECONDARY=maybe >/dev/null 2>&1; then
  fail "非法布尔值应当失败"
fi

# 6. QUBIUS_ENV 指向不存在的文件时失败。
if probe "$TMP/missing" >/dev/null 2>&1; then
  fail "不存在的 QUBIUS_ENV 应当失败"
fi

# 7. render.mjs：正常替换和缺变量失败。
printf 'port={{QUBIUS_PORT}}\n' >"$TMP/tpl"
QUBIUS_PORT=1234 node "$HERE/render.mjs" "$TMP/tpl" "$TMP/out"
assert_eq "$(cat "$TMP/out")" "port=1234" render
# 调用方进程可能刚好在 qubius 服务环境里（导出了 QUBIUS_PORT），显式清掉再测。
if env -u QUBIUS_PORT node "$HERE/render.mjs" "$TMP/tpl" "$TMP/out2" >/dev/null 2>&1; then
  fail "缺少模板变量时应当失败"
fi

echo "deploy/lib.sh 契约测试通过"
