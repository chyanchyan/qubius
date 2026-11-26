#!/bin/bash
# deploy/cli.mjs 的退出码透传测试：
# 用 fake bash 让 Linux 的 deploy/*.sh 返回指定退出码，验证 make 入口
# （node deploy/cli.mjs deploy）原样透传，尤其是忙碌保护的 3。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

node -e 'process.exit(process.platform === "linux" ? 0 : 1)' \
  || { echo "跳过：cli 的 shell 部署路径只在 Linux 上生效"; exit 0; }

mkdir -p "$TMP/fakebin" "$TMP/config"
printf '#!/bin/sh\nexit 3\n' >"$TMP/fakebin/bash"
chmod +x "$TMP/fakebin/bash"

status=0
PATH="$TMP/fakebin:$PATH" \
  QUBIUS_CONFIG_DIR="$TMP/config" \
  node "$HERE/cli.mjs" deploy >/dev/null 2>&1 || status=$?
[[ $status -eq 3 ]] || fail "部署子进程 exit 3 未透传，实际 $status"

printf '#!/bin/sh\nexit 7\n' >"$TMP/fakebin/bash"
chmod +x "$TMP/fakebin/bash"
status=0
PATH="$TMP/fakebin:$PATH" \
  QUBIUS_CONFIG_DIR="$TMP/config" \
  node "$HERE/cli.mjs" deploy-lan >/dev/null 2>&1 || status=$?
[[ $status -eq 7 ]] || fail "部署子进程 exit 7 未透传，实际 $status"

# restart 必须注入 QUBIUS_DEPLOY_RESTART=1，否则无变化时会被 start-all 跳过。
RESTART_LOG=$TMP/restart.log
cat >"$TMP/fakebin/bash" <<EOF
#!/bin/sh
printf 'args=%s\n' "\$*" >"$RESTART_LOG"
printf 'restart=%s\n' "\${QUBIUS_DEPLOY_RESTART:-unset}" >>"$RESTART_LOG"
exit 0
EOF
chmod +x "$TMP/fakebin/bash"
status=0
PATH="$TMP/fakebin:$PATH" \
  QUBIUS_CONFIG_DIR="$TMP/config" \
  node "$HERE/cli.mjs" restart >/dev/null 2>&1 || status=$?
[[ $status -eq 0 ]] || fail "restart 应成功，实际 $status"
grep -q 'args=.*--restart' "$RESTART_LOG" || fail "restart 应调用 start-all --restart：$(cat "$RESTART_LOG")"
grep -q '^restart=1$' "$RESTART_LOG" || fail "restart 应注入 QUBIUS_DEPLOY_RESTART=1：$(cat "$RESTART_LOG")"

echo "deploy/cli.mjs 退出码透传测试通过"
