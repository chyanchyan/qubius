#!/bin/bash
# deploy/lib.sh 的 ops lock 包装冒烟测试。
# 只在临时 HOME/XDG/QUBIUS_CONFIG_DIR 下运行；用 OPS_LOCK_PROC_ROOT 指向伪造 proc，
# 不扫描/不杀任何真实进程。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  [[ $1 == "$2" ]] || fail "期望 [$2]，实际 [$1]${3:+（$3）}"
}

assert_contains() {
  local name=$1 needle=$2 haystack=$3
  [[ $haystack == *"$needle"* ]] || fail "$name：缺少 [$needle]，实际 [$haystack]"
}

assert_no_contains() {
  local name=$1 needle=$2 haystack=$3
  [[ $haystack != *"$needle"* ]] || fail "$name：不应包含 [$needle]，实际 [$haystack]"
}

assert_rc() {
  local name=$1 expected=$2 actual=$3
  [[ $actual -eq $expected ]] || fail "$name：exit $actual != $expected"
}

# 清掉外部 QUBIUS_*；临时目录隔离 HOME/XDG/配置。
UNSET_QUBIUS=()
while IFS= read -r name; do UNSET_QUBIUS+=(-u "$name"); done \
  < <(compgen -e | grep '^QUBIUS_' || true)

mkdir -p "$TMP/home" "$TMP/proc"
EMPTY_ENV=$TMP/empty.env
: >"$EMPTY_ENV"
META_COPY=""
EXTRA_ENV=()
OUT=""
RC=0

# 在隔离环境中 source lib、qubius_load，再执行 action。
DRIVER=$TMP/driver.sh
cat >"$DRIVER" <<'DRIVER_EOF'
#!/bin/bash
set -euo pipefail
source "$1"
shift
if [[ ${1:-} == env-file ]]; then
  QUBIUS_ENV=${2:-}
  printf 'ENV_FILE=%s\n' "$(qubius_env_file)"
  exit 0
fi
qubius_load
action=$1
kind=${2:-deploy}
echo "ENV_FILE=${QUBIUS_ENV_FILE:-}"
case $action in
  claim)
    qubius_ops_claim "$kind"
    echo "CLAIMED=${QUBIUS_OPS_CLAIMED:-0}"
    echo "ROOT=${QUBIUS_OPS_ROOT:-}"
    echo "JOB=${QUBIUS_OPS_JOB:-}"
    if [[ -n ${QUBIUS_OPS_TOKEN:-} ]]; then echo "TOKEN=yes"; else echo "TOKEN=no"; fi
    if [[ -f $QUBIUS_CONFIG_DIR/ops.meta ]]; then
      echo "META=yes"
      if [[ -n ${META_COPY:-} ]]; then cp -p "$QUBIUS_CONFIG_DIR/ops.meta" "$META_COPY"; fi
    else
      echo "META=no"
    fi
    ;;
  claim-release)
    qubius_ops_claim "$kind"
    qubius_ops_release
    qubius_ops_release # 幂等：第二次不应报错或改变结果
    if [[ -f $QUBIUS_CONFIG_DIR/ops.meta ]]; then
      echo "META_AFTER_RELEASE=yes"
    else
      echo "META_AFTER_RELEASE=no"
    fi
    ;;
  skip)
    qubius_ops_claim "$kind"
    echo "CLAIMED=${QUBIUS_OPS_CLAIMED:-0}"
    echo "TOKEN_INPUT=${QUBIUS_OPS_TOKEN:-<none>}"
    ;;
  hold)
    # claim 后保持进程存活，直到测试创建 STOP_FILE，用于验证持有期间互斥。
    qubius_ops_claim "$kind"
    echo "READY"
    while [[ ! -e ${STOP_FILE:?} ]]; do sleep 0.05; done
    ;;
  *)
    echo "unknown action: $action" >&2
    exit 64
    ;;
esac
DRIVER_EOF
chmod +x "$DRIVER"

run_driver() {
  local cfg=$1
  shift
  env "${UNSET_QUBIUS[@]}" \
    HOME="$TMP/home" \
    XDG_CONFIG_HOME="$TMP/home/.config" \
    XDG_DATA_HOME="$TMP/home/.local/share" \
    QUBIUS_CONFIG_DIR="$cfg" \
    QUBIUS_ENV="$EMPTY_ENV" \
    OPS_LOCK_PROC_ROOT="$TMP/proc" \
    META_COPY="${META_COPY:-}" \
    STOP_FILE="${STOP_FILE:-}" \
    ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
    bash "$DRIVER" "$HERE/lib.sh" "$@"
}

capture() {
  OUT=""
  if OUT=$("$@" 2>&1); then
    RC=0
  else
    RC=$?
  fi
}

# ── 1. 手工 claim：写 ops.meta，退出时 EXIT trap 自动释放 ──────────────────────
CFG1=$TMP/config1
META_COPY=$TMP/meta1.json
EXTRA_ENV=()
capture run_driver "$CFG1" claim deploy
assert_rc "manual claim exit 0" 0 "$RC"
assert_contains "manual claim marks claimed" "CLAIMED=1" "$OUT"
assert_contains "manual claim exports root" "ROOT=$CFG1" "$OUT"
assert_contains "manual claim exports job id" "JOB=manual-deploy-" "$OUT"
assert_contains "manual claim exports token" "TOKEN=yes" "$OUT"
assert_contains "QUBIUS_ENV_FILE exported" "ENV_FILE=$EMPTY_ENV" "$OUT"
[[ -f $META_COPY ]] || fail "claim 后应写出 ops.meta"
META_TEXT=$(cat "$META_COPY")
# claim 成功后会 mark running 记录真实进程，所以这里看到的是 running。
assert_contains "meta state running" '"state":"running"' "$META_TEXT"
assert_contains "meta kind deploy" '"kind":"deploy"' "$META_TEXT"
assert_contains "meta job id manual" '"jobId":"manual-deploy-' "$META_TEXT"
assert_contains "meta token manual" '"token":"manual-deploy-' "$META_TEXT"
[[ -f $CFG1/ops.lock ]] || fail "claim 后应创建 ops.lock 载体"
[[ ! -e $CFG1/ops.meta ]] || fail "脚本退出后 EXIT trap 应释放 ops.meta"

# ── 2. release 清空 ops.meta（幂等）──────────────────────────────────────────
CFG2=$TMP/config2
META_COPY=""
capture run_driver "$CFG2" claim-release deploy
assert_rc "claim+release exit 0" 0 "$RC"
assert_contains "release clears meta" "META_AFTER_RELEASE=no" "$OUT"
[[ ! -e $CFG2/ops.meta ]] || fail "release 后 ops.meta 应被清空"

# ── 3. 已有 QUBIUS_OPS_TOKEN：claim 跳过，不新建 ops.meta/ops.lock ────────────
CFG3=$TMP/config3
mkdir -p "$CFG3"
EXTRA_ENV=(QUBIUS_OPS_TOKEN=already-in-job QUBIUS_OPS_ROOT="$CFG3" QUBIUS_OPS_JOB=job-x)
capture run_driver "$CFG3" skip deploy
EXTRA_ENV=()
assert_rc "nested claim exit 0" 0 "$RC"
assert_contains "nested claim skips" "CLAIMED=0" "$OUT"
assert_contains "nested claim keeps token" "TOKEN_INPUT=already-in-job" "$OUT"
[[ ! -e $CFG3/ops.meta ]] || fail "已有 QUBIUS_OPS_TOKEN 时不应新建 ops.meta"
[[ ! -e $CFG3/ops.lock ]] || fail "已有 QUBIUS_OPS_TOKEN 时不应创建 ops.lock"

# ── 3b. PATH 中没有 flock：告警并返回 0（不 claim）──────────────────────────
CFG3B=$TMP/config3b
NOFLOCK=$TMP/noflock-bin
mkdir -p "$NOFLOCK"
for cmd in bash id date cp; do
  real=$(command -v "$cmd") || fail "测试需要命令：$cmd"
  ln -sf "$real" "$NOFLOCK/$cmd"
done
EXTRA_ENV=(PATH="$NOFLOCK")
capture run_driver "$CFG3B" skip deploy
EXTRA_ENV=()
assert_rc "missing flock exit 0" 0 "$RC"
assert_contains "missing flock warns" "找不到 flock" "$OUT"
assert_contains "missing flock skips claim" "CLAIMED=0" "$OUT"
[[ ! -e $CFG3B/ops.meta ]] || fail "没有 flock 时不应创建 ops.meta"

# ── 3c. ops-lock.sh 缺少 flock：明确报 unsupported，不能伪装成 busy ──────────
CFG3C=$TMP/config3c
RC=0
OUT=$(PATH="$NOFLOCK" bash "$HERE/ops-lock.sh" claim --root "$CFG3C" \
  --kind deploy --job-id j3c --token t3c 2>/dev/null) || RC=$?
assert_rc "ops-lock missing flock exit 2" 2 "$RC"
assert_contains "ops-lock missing flock code" '"code":"unsupported"' "$OUT"
assert_no_contains "ops-lock missing flock not busy" '"code":"busy"' "$OUT"

# ── 4. 锁被占用（pending 宽限期内）：claim 失败且不泄漏 token ─────────────────
CFG4=$TMP/config4
mkdir -p "$CFG4"
NOW=$(date +%s)
NORM4=$(realpath -m "$CFG4")
printf '{"version":1,"state":"pending","kind":"deploy","jobId":"page-job","token":"page-token","root":"%s","claimedAt":%s,"updatedAt":%s}\n' \
  "$NORM4" "$NOW" "$NOW" >"$CFG4/ops.meta"
chmod 600 "$CFG4/ops.meta"
META_COPY=""
capture run_driver "$CFG4" claim deploy
assert_rc "occupied claim fails" 1 "$RC"
assert_contains "occupied claim hint" "等待部署页作业结束" "$OUT"
assert_contains "occupied claim hints reclaim" "回收残留锁" "$OUT"
assert_no_contains "occupied claim must not leak json" '"ok":' "$OUT"
assert_no_contains "occupied claim must not leak token" '"token":' "$OUT"
META4=$(cat "$CFG4/ops.meta")
assert_contains "occupied claim keeps existing meta" '"jobId":"page-job"' "$META4"
# 失败的 claim 不应把自己的 meta 写进去。
assert_no_contains "occupied claim must not write own meta" '"jobId":"manual-' "$META4"

# ── 5. 锁空闲但有残留进程：claim 失败（伪造 proc，不杀真实进程）─────────────
CFG5=$TMP/config5
mkdir -p "$TMP/proc/900123"
NORM5=$(realpath -m "$CFG5")
printf 'QUBIUS_OPS_ROOT=%s\0QUBIUS_OPS_TOKEN=x\0QUBIUS_OPS_JOB=old\0' "$NORM5" >"$TMP/proc/900123/environ"
capture run_driver "$CFG5" claim deploy
rm -rf "$TMP/proc/900123"
assert_rc "residual claim fails" 1 "$RC"
assert_contains "residual claim hint" "回收残留锁" "$OUT"
# residual 失败发生在写 meta 之前，不应残留/新建 ops.meta。
[[ ! -e $CFG5/ops.meta ]] || fail "residual 失败后不应新建 ops.meta"

# ── 6. claim 持有 flock 期间，第二次 claim 返回 busy ─────────────────────────
CFG6=$TMP/config6
STOP_FILE=$TMP/stop6
rm -f "$STOP_FILE"
run_driver "$CFG6" hold deploy >"$TMP/hold.out" 2>&1 &
HOLD_PID=$!
for _ in $(seq 1 100); do
  if grep -q '^READY$' "$TMP/hold.out" 2>/dev/null; then break; fi
  sleep 0.05
done
if ! grep -q '^READY$' "$TMP/hold.out" 2>/dev/null; then
  kill "$HOLD_PID" 2>/dev/null || true
  cat "$TMP/hold.out" >&2
  fail "hold driver 未就绪"
fi
capture run_driver "$CFG6" claim deploy
assert_rc "claim while held fails" 1 "$RC"
assert_contains "claim while held hint" "无法获取 ops lock" "$OUT"
# 持有者仍持锁时，失败 claim 不应覆盖其 meta。
assert_contains "claim while held keeps holder meta" '"jobId":"manual-deploy-' "$(cat "$CFG6/ops.meta")"
STOP_FILE=$TMP/stop6
touch "$STOP_FILE"
wait "$HOLD_PID" || true
[[ ! -e $CFG6/ops.meta ]] || fail "持有者退出后应释放 ops.meta"

# ── 7. QUBIUS_ENV 相对路径按 repoRoot 解析成绝对路径 ─────────────────────────
REL_ENV=deploy/env.example
capture run_driver "$TMP/config-rel" env-file "$REL_ENV"
assert_rc "relative QUBIUS_ENV exit 0" 0 "$RC"
assert_contains "relative QUBIUS_ENV anchored to repo" \
  "ENV_FILE=$(cd "$HERE/.." && pwd)/$REL_ENV" "$OUT"

# ── 8. 已有 token（secondary/作业场景）：build.sh 跳过 claim，即使 ops 忙 ────
CFG8=$TMP/config8
mkdir -p "$CFG8"
NOW=$(date +%s)
NORM8=$(realpath -m "$CFG8")
printf '{"version":1,"state":"pending","kind":"deploy","jobId":"page-job","token":"page-token","root":"%s","claimedAt":%s,"updatedAt":%s}\n' \
  "$NORM8" "$NOW" "$NOW" >"$CFG8/ops.meta"
FREPO=$TMP/fake-repo
git init -q "$FREPO"
capture env "${UNSET_QUBIUS[@]}" \
  HOME="$TMP/home" \
  XDG_CONFIG_HOME="$TMP/home/.config" \
  XDG_DATA_HOME="$TMP/home/.local/share" \
  QUBIUS_CONFIG_DIR="$CFG8" \
  QUBIUS_ENV="$EMPTY_ENV" \
  QUBIUS_OPS_ROOT="$CFG8" \
  QUBIUS_OPS_TOKEN=holder-token \
  QUBIUS_OPS_JOB=holder-job \
  OPS_LOCK_PROC_ROOT="$TMP/proc" \
  bash "$HERE/build.sh" "$FREPO"
# build.sh 会在 claim 之后的 sha256sum 处失败（fake repo 没有 package-lock），
# 关键是它没有因为 ops busy 提前退出。
[[ $RC -ne 0 ]] || fail "fake repo 的 build.sh 应失败"
assert_no_contains "build.sh with token skips claim" "无法获取 ops lock" "$OUT"
assert_contains "build.sh did not overwrite meta" '"jobId":"page-job"' "$(cat "$CFG8/ops.meta")"
[[ ! -e $CFG8/ops.lock ]] || fail "build.sh 跳过 claim 时不应创建 ops.lock"

# ── 9. 静态结构：所有入口保持 ops.lock -> deploy.lock 顺序 ──────────────────
line_of() {
  grep -nF -- "$2" "$1" 2>/dev/null | head -n1 | cut -d: -f1 || true
}
SEC=$HERE/secondary.sh
sec_claim=$(line_of "$SEC" 'qubius_ops_claim deploy')
sec_deploy=$(line_of "$SEC" 'exec 8>"$DEPLOY_LOCK"')
[[ -n $sec_claim && -n $sec_deploy ]] || fail "secondary.sh 缺少 claim 或 deploy.lock 行"
(( sec_claim < sec_deploy )) || fail "secondary.sh 必须先 claim ops lock 再拿 deploy.lock"

b_claim=$(line_of "$HERE/build.sh" 'qubius_ops_claim deploy')
b_npm=$(line_of "$HERE/build.sh" 'npm ci --no-audit')
[[ -n $b_claim && -n $b_npm ]] || fail "build.sh 缺少 claim 或 npm ci 行"
(( b_claim < b_npm )) || fail "build.sh 必须在 npm ci 之前 claim"

SA=$HERE/start-all.sh
sa_managed=$(line_of "$SA" 'MANAGED+=("$role")')
sa_claim=$(line_of "$SA" 'qubius_ops_claim deploy')
sa_deploy=$(line_of "$SA" 'exec 9>"$QUBIUS_DEPLOY_LOCK"')
[[ -n $sa_managed && -n $sa_claim && -n $sa_deploy ]] || fail "start-all.sh 结构行缺失"
(( sa_managed < sa_claim )) || fail "start-all.sh 应在确定角色后再 claim"
(( sa_claim < sa_deploy )) || fail "start-all.sh 必须先 claim 再拿 deploy.lock"

# 长驻进程必须关闭 ops fd 6，否则退出后仍持有 flock。
grep -qF '6>&-' "$SEC" || fail "secondary.sh 启动进程未关闭 ops fd 6"
grep -qF -- '-u QUBIUS_OPS_TOKEN' "$SEC" \
  || fail "secondary.sh 启动进程未剥离 QUBIUS_OPS_* 标记"
(( $(grep -cF '6>&-' "$SA") >= 2 )) || fail "start-all.sh 实例/代理启动未关闭 ops fd 6"

echo "deploy ops lock 包装测试通过"
