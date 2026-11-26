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

# make help 在 Windows 上也要能跑：帮助文本放在 cli.mjs 里，Makefile 的命令行
# 只能是 ASCII。Windows 的 make/cmd 按本地代码页解码命令行，内联中文会乱码，
# 混进引号时还会把 node -e 的脚本拆成语法错误。
QUBIUS_CONFIG_DIR="$TMP/config" node "$HERE/cli.mjs" help >"$TMP/help.txt" \
  || fail "cli.mjs help 应成功"
grep -q 'deploy-wan' "$TMP/help.txt" || fail "cli.mjs help 缺少部署目标"
grep -q 'node deploy/cli.mjs help' "$HERE/../Makefile" || fail "make help 应调用 cli.mjs help"

node - "$HERE/../Makefile" <<'NODE' || fail "Makefile 的命令行里有非 ASCII 字符，Windows 上会乱码或语法错误"
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/);
const bad = lines
  .map((line, index) => ({ line, index }))
  .filter(({ line }) => line.startsWith("\t") && /[^\x00-\x7F]/.test(line));
for (const { line, index } of bad) console.error(`${index + 1}: ${line}`);
if (bad.length) process.exit(1);
NODE

if command -v make >/dev/null 2>&1; then
  QUBIUS_CONFIG_DIR="$TMP/config" make -C "$HERE/.." help >/dev/null 2>&1 \
    || fail "make help 失败"
fi

echo "deploy/cli.mjs 退出码透传测试通过"
