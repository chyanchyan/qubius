#!/bin/bash
# deploy/install.sh 冒烟测试：只在临时目录安装，不碰真实配置、crontab 和服务。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file() {
  [[ -f $1 ]] || fail "缺少文件：$1"
}

assert_grep() {
  local pattern=$1 file=$2
  grep -qE "$pattern" "$file" || fail "文件 $file 缺少匹配：$pattern"
}

assert_not_grep() {
  local pattern=$1 file=$2
  if grep -qE "$pattern" "$file"; then fail "文件 $file 不应匹配：$pattern"; fi
}

# 清掉外部 QUBIUS_*；若仓库里已有 deploy/env，用空 env 文件隔离，避免真实配置影响断言。
UNSET_QUBIUS=()
while IFS= read -r name; do UNSET_QUBIUS+=(-u "$name"); done \
  < <(compgen -e | grep '^QUBIUS_' || true)
ENV_OVERRIDE=()
REPO_HAS_ENV=0
if [[ -f $ROOT/deploy/env ]]; then
  REPO_HAS_ENV=1
  : >"$TMP/empty.env"
  ENV_OVERRIDE=(QUBIUS_ENV="$TMP/empty.env")
fi
# 不让外部环境改动日志路径；日志始终落在各角色临时目录里。
unset INSTALL_LOG

# 可选额外参数：
#   --xxx            传给 install.sh（例如 --force-config）
#   NAME=value       追加为 env 赋值（例如 QUBIUS_PUBLIC_HOST=other.test），可覆盖上面的默认值
install_role() {
  local role=$1 dir=$2
  shift 2
  local -a env_extra=() install_extra=()
  local arg
  for arg in "$@"; do
    if [[ $arg == --* ]]; then
      install_extra+=("$arg")
    else
      env_extra+=("$arg")
    fi
  done
  local log=${INSTALL_LOG:-$dir/install.log}
  mkdir -p "$dir/home"
  # 首次安装截断日志，后续同一目录的安装追加，便于断言各次输出且不残留旧内容。
  if [[ -e $log ]]; then
    exec 8>>"$log"
  else
    exec 8>"$log"
  fi
  if ! env "${UNSET_QUBIUS[@]}" "${ENV_OVERRIDE[@]}" \
    HOME="$dir/home" \
    XDG_CONFIG_HOME="$dir/home/.config" \
    XDG_DATA_HOME="$dir/home/.local/share" \
    QUBIUS_HOME="$dir/home" \
    QUBIUS_CONFIG_DIR="$dir/config" \
    QUBIUS_PRIMARY_DIR="$dir/qubius" \
    QUBIUS_SECONDARY_DIR="$dir/co-qubius" \
    QUBIUS_DATA_PRIMARY="$dir/data-q" \
    QUBIUS_DATA_SECONDARY="$dir/data-co" \
    QUBIUS_PRIMARY_PORT=18787 \
    QUBIUS_SECONDARY_PORT=18788 \
    QUBIUS_PUBLIC_HOST=code.test \
    QUBIUS_PUBLIC_HOST_SECONDARY=code-bak.test \
    QUBIUS_PRIMARY_REPO_URL="$ORIGIN" \
    QUBIUS_SECONDARY_REPO_URL="$ORIGIN" \
    QUBIUS_SECONDARY="$role" \
    QUBIUS_SKIP_CRONTAB=1 \
    OPS_LOCK_PROC_ROOT="$TMP/proc-empty" \
    ${env_extra[@]+"${env_extra[@]}"} \
    bash "$HERE/install.sh" --no-build --no-restart \
    ${install_extra[@]+"${install_extra[@]}"} >&8 2>&8; then
    exec 8>&-
    cat "$log" >&2
    fail "install.sh 安装角色 $role 失败"
  fi
  exec 8>&-
  # install.sh 手工执行时会 claim ops lock，退出时必须已释放（ops.meta 不残留）。
  [[ ! -e $dir/config/ops.meta ]] \
    || fail "install 结束后 ops.meta 未释放：$dir/config/ops.meta"
}

mkdir -p "$TMP" "$TMP/proc-empty"
ORIGIN=$(git -C "$ROOT" remote get-url origin 2>/dev/null || printf '%s' "$ROOT")
export ORIGIN

# ── 主实例 ────────────────────────────────────────────────────────────────
P=$TMP/primary
install_role 0 "$P"
CFG=$P/config/config.yaml
assert_file "$CFG"
assert_grep '^role: primary$' "$CFG"
assert_grep '^listen: 127\.0\.0\.1:18787$' "$CFG"
assert_grep "^dataDir: '$P/data-q'$" "$CFG"
assert_grep 'allowedHosts: \[127\.0\.0\.1, localhost, "\[::1\]", .code\.test.\]' "$CFG"
assert_grep '^  - id: co-qubius$' "$CFG"
assert_grep "^    path: '$P/co-qubius'$" "$CFG"
assert_not_grep '^secondary:' "$CFG"
assert_file "$P/config/systemd/qubius.service"
assert_file "$P/config/systemd/qubius-proxy.service"
assert_grep "^WorkingDirectory=$ROOT$" "$P/config/systemd/qubius.service"
assert_grep '^KillMode=mixed$' "$P/config/systemd/qubius.service"
assert_grep '^KillMode=mixed$' "$P/config/systemd/qubius-proxy.service"
assert_grep "QUBIUS_SECONDARY=0" "$P/config/systemd/qubius.service"
assert_grep "QUBIUS_CONFIG_DIR=$P/config" "$P/config/systemd/qubius.service"
assert_file "$P/config/logrotate.d/qubius"
assert_grep "$P/data-q/\*\.log" "$P/config/logrotate.d/qubius"
if (( ! REPO_HAS_ENV )); then
  [[ $(stat -c %a "$P/config/env") == 600 ]] || fail "env 权限不是 600"
  assert_grep '^QUBIUS_PRIMARY_REPO_URL=' "$P/config/env"
else
  echo "跳过 env 安装断言（$ROOT/deploy/env 已存在）" >&2
fi

# ── --force-config：用新参数覆盖已存在的配置 ──────────────────────────────
install_role 0 "$P" QUBIUS_PUBLIC_HOST=code-new.test --force-config
assert_grep 'allowedHosts: \[127\.0\.0\.1, localhost, "\[::1\]", .code-new\.test.\]' "$CFG"
assert_not_grep 'code\.test' "$CFG"
[[ $(stat -c %a "$CFG") == 644 ]] || fail "覆盖后配置文件权限不是 644"
compgen -G "$P/config/config.yaml.bak.*" >/dev/null \
  || fail "--force-config 覆盖后缺少 *.bak.* 备份"
# 备份内容应是覆盖前的旧配置。
BAK=$(compgen -G "$P/config/config.yaml.bak.*" | head -n1)
assert_grep 'code\.test' "$BAK"
assert_not_grep 'code-new\.test' "$BAK"
assert_grep '已按 --force-config 覆盖配置' "$P/install.log"

# ── 不带 --force-config：重复安装不覆盖旧配置（回归）──────────────────────
install_role 0 "$P" QUBIUS_PUBLIC_HOST=code-other.test
assert_grep 'allowedHosts: \[127\.0\.0\.1, localhost, "\[::1\]", .code-new\.test.\]' "$CFG"
assert_not_grep 'code-other\.test' "$CFG"
assert_grep '保留现有配置' "$P/install.log"

# ── 无差异 + --force-config：不覆盖、不新增备份 ───────────────────────────
BAK_COUNT_BEFORE=$(compgen -G "$P/config/config.yaml.bak.*" | wc -l)
install_role 0 "$P" QUBIUS_PUBLIC_HOST=code-new.test --force-config
assert_grep '与本次渲染一致' "$P/install.log"
BAK_COUNT_AFTER=$(compgen -G "$P/config/config.yaml.bak.*" | wc -l)
[[ $BAK_COUNT_AFTER == "$BAK_COUNT_BEFORE" ]] \
  || fail "无差异 + --force-config 不应新增备份（$BAK_COUNT_BEFORE -> $BAK_COUNT_AFTER）"

# ── 副实例 ────────────────────────────────────────────────────────────────
S=$TMP/secondary
install_role 1 "$S"
CFG=$S/config/config-secondary.yaml
assert_file "$CFG"
assert_grep '^role: secondary$' "$CFG"
assert_grep '^listen: 127\.0\.0\.1:18788$' "$CFG"
assert_grep "^dataDir: '$S/data-co'$" "$CFG"
assert_grep '^  - id: qubius$' "$CFG"
assert_grep "^    path: '$S/qubius'$" "$CFG"
assert_grep '^secondary:$' "$CFG"
assert_grep "^  script: '$ROOT/deploy/secondary\.sh'$" "$CFG"
assert_grep "^  restart: '$ROOT/deploy/run\.sh'$" "$CFG"
assert_file "$S/config/systemd/co-qubius.service"
assert_file "$S/config/systemd/co-qubius-proxy.service"
assert_grep '^KillMode=process$' "$S/config/systemd/co-qubius.service"
assert_grep '^KillMode=mixed$' "$S/config/systemd/co-qubius-proxy.service"
assert_grep "QUBIUS_SECONDARY=1" "$S/config/systemd/co-qubius.service"

# ── YAML 解析（依赖可用时）───────────────────────────────────────────────
NODE_BIN=$(command -v node 2>/dev/null || true)
if [[ -n $NODE_BIN ]] && (cd "$ROOT" && "$NODE_BIN" -e 'require.resolve("yaml")' >/dev/null 2>&1); then
  (cd "$ROOT" && "$NODE_BIN" -e '
    const fs = require("fs");
    const yaml = require("yaml");
    const [primary, secondary] = process.argv.slice(1);
    const p = yaml.parse(fs.readFileSync(primary, "utf8"));
    const s = yaml.parse(fs.readFileSync(secondary, "utf8"));
    if (p.role !== "primary" || !Array.isArray(p.projects)) throw new Error("主配置 role/projects 异常");
    if (s.role !== "secondary" || !s.secondary || !s.secondary.script) throw new Error("副配置 secondary 异常");
  ' "$P/config/config.yaml" "$S/config/config-secondary.yaml") \
    || fail "生成的 YAML 无法解析或字段异常"
else
  echo "跳过 YAML 解析（node 或 yaml 模块不可用）" >&2
fi

# ── systemd 语法（可用时）─────────────────────────────────────────────────
if command -v systemd-analyze >/dev/null 2>&1; then
  for unit in "$P/config/systemd/qubius.service" "$P/config/systemd/qubius-proxy.service" \
    "$S/config/systemd/co-qubius.service" "$S/config/systemd/co-qubius-proxy.service"; do
    if ! systemd-analyze verify "$unit" >/dev/null 2>"$TMP/systemd.err"; then
      cat "$TMP/systemd.err" >&2
      fail "systemd-analyze verify 失败：$unit"
    fi
  done
fi

echo "deploy/install.sh 冒烟测试通过"
