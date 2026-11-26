#!/bin/bash
# deploy/build.sh staging / swap / rollback 的安全路径测试。
# 只用 mktemp 里的假仓库和假 tsc/vite，绝不构建或改动真实 checkout。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUILD=$HERE/build.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_rc() {
  local name=$1 expected=$2
  [[ $RC -eq $expected ]] || fail "$name：exit $RC != $expected（输出：$OUT）"
}

assert_file() { [[ -f $1 ]] || fail "缺少文件：$1"; }
assert_no_entry() { [[ ! -e $1 ]] || fail "不应存在：$1"; }

assert_content() {
  local file=$1 expected=$2
  assert_file "$file"
  [[ $(cat "$file") == "$expected" ]] \
    || fail "$file 内容 [$(cat "$file")] != [$expected]"
}

assert_contains() {
  local name=$1 needle=$2
  [[ $OUT == *"$needle"* ]] || fail "$name：输出缺少 [$needle]；实际：$OUT"
}

assert_not_contains() {
  local name=$1 needle=$2
  [[ $OUT != *"$needle"* ]] || fail "$name：输出不应含 [$needle]；实际：$OUT"
}

assert_grep() {
  local name=$1 pattern=$2 file=$3
  assert_file "$file"
  grep -Eq "$pattern" "$file" || fail "$name：$file 不匹配 /$pattern/（内容：$(cat "$file")）"
}

# ── 隔离的运行环境 ──────────────────────────────────────────────────────────
UNSET_QUBIUS=()
while IFS= read -r name; do UNSET_QUBIUS+=(-u "$name"); done \
  < <(compgen -e | grep '^QUBIUS_' || true)

mkdir -p "$TMP/home/.config" "$TMP/home/.local/share" "$TMP/config"
: >"$TMP/empty.env"

REPO=$TMP/repo
OUT=""
RC=0

run_build() {
  local extra=("${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}")
  # QUBIUS_OPS_TOKEN 模拟部署作业已在持锁：跳过 claim，测试不写真实 ops.meta。
  if OUT=$(env "${UNSET_QUBIUS[@]+"${UNSET_QUBIUS[@]}"}" \
      HOME="$TMP/home" \
      XDG_CONFIG_HOME="$TMP/home/.config" \
      XDG_DATA_HOME="$TMP/home/.local/share" \
      QUBIUS_ENV="$TMP/empty.env" \
      QUBIUS_CONFIG_DIR="$TMP/config" \
      QUBIUS_REPO_DIR="$REPO" \
      QUBIUS_OPS_TOKEN=test-token \
      ${extra[@]+"${extra[@]}"} \
      bash "$BUILD" "$@" </dev/null 2>&1); then
    RC=0
  else
    RC=$?
  fi
}

# ── 假仓库：git init + 假 tsc/vite ──────────────────────────────────────────
mkdir -p "$REPO/server" "$REPO/web" "$REPO/node_modules/.bin"
printf '{"name":"fake","private":true,"version":"9.8.7"}\n' >"$REPO/package.json"
printf '{"name":"fake","lockfileVersion":3,"packages":{}}\n' >"$REPO/package-lock.json"
# 与真实仓库一致：只忽略 live 的 dist/，故意不忽略 dist.next/dist.prev，
# 用来验证 build.json 的 dirty 计算会排除构建自身产生的目录。
printf 'node_modules/\nserver/dist/\nweb/dist/\n' >"$REPO/.gitignore"
printf 'server source\n' >"$REPO/server/src.txt"
printf 'web source\n' >"$REPO/web/src.txt"

git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.name=test -c user.email=test@example.com commit -qm init

cat >"$REPO/node_modules/.bin/tsc" <<'SH'
#!/bin/sh
# 假 tsc：--noEmit 直接成功；否则在 --outDir 写 index.js。
out=""
noemit=0
while [ $# -gt 0 ]; do
  case $1 in
    --outDir) out=$2; shift 2 ;;
    --outDir=*) out=${1#*=}; shift ;;
    --noEmit) noemit=1; shift ;;
    *) shift ;;
  esac
done
if [ "${FAKE_TSC_FAIL:-0}" = 1 ]; then
  echo "fake tsc: forced failure" >&2
  exit 1
fi
[ "$noemit" = 1 ] && exit 0
[ -n "$out" ] || { echo "fake tsc: missing --outDir" >&2; exit 1; }
mkdir -p "$out"
printf '%s\n' "${FAKE_BUILD_MARKER:-server-default}" >"$out/index.js"
SH

cat >"$REPO/node_modules/.bin/vite" <<'SH'
#!/bin/sh
# 假 vite：在 --outDir 写 index.html。
out=""
while [ $# -gt 0 ]; do
  case $1 in
    --outDir) out=$2; shift 2 ;;
    --outDir=*) out=${1#*=}; shift ;;
    *) shift ;;
  esac
done
if [ "${FAKE_VITE_FAIL:-0}" = 1 ]; then
  echo "fake vite: forced failure" >&2
  exit 1
fi
[ -n "$out" ] || { echo "fake vite: missing --outDir" >&2; exit 1; }
mkdir -p "$out"
printf '%s\n' "${FAKE_BUILD_MARKER:-web-default}" >"$out/index.html"
SH
chmod +x "$REPO/node_modules/.bin/tsc" "$REPO/node_modules/.bin/vite"

# 依赖已经就绪：哈希匹配时 --deps/默认模式都不应调用 npm ci。
mkdir -p "$REPO/node_modules"
sha256sum "$REPO/package-lock.json" | awk '{print $1}' >"$REPO/node_modules/.qubius-lock-hash"

SERVER_LIVE=$REPO/server/dist
SERVER_PREV=$REPO/server/dist.prev
SERVER_NEXT=$REPO/server/dist.next
WEB_LIVE=$REPO/web/dist
WEB_PREV=$REPO/web/dist.prev
WEB_NEXT=$REPO/web/dist.next

# ── 1. --help / 未知参数：exit 2 ────────────────────────────────────────────
run_build --help
assert_rc "--help" 2
assert_contains "--help 用法" "用法："

run_build --bogus
assert_rc "未知参数" 2
assert_contains "未知参数提示" "未知参数"

# ── 2. --deps：哈希匹配时跳过 npm ci，也不构建 ──────────────────────────────
run_build --deps "$REPO"
assert_rc "--deps 匹配哈希" 0
assert_not_contains "--deps 不应安装" "安装依赖"
assert_no_entry "$SERVER_NEXT"
assert_no_entry "$WEB_NEXT"
assert_no_entry "$SERVER_LIVE"
assert_no_entry "$WEB_LIVE"

# ── 2b. staging 不完整（缺 web index.html）时拒绝 swap ──────────────────────
export FAKE_BUILD_MARKER=v0
run_build --stage "$REPO"
assert_rc "stage v0" 0
rm -f "$WEB_NEXT/index.html"
run_build --swap "$REPO"
[[ $RC -ne 0 ]] || fail "staging 不完整时 swap 应失败"
assert_contains "staging 不完整提示" "staging 不完整"
assert_no_entry "$SERVER_LIVE"
assert_no_entry "$WEB_LIVE"

# ── 3. --stage：只写 .next，live 不存在也保持不存在 ─────────────────────────
export FAKE_BUILD_MARKER=v1
run_build --stage "$REPO"
assert_rc "stage v1" 0
assert_content "$SERVER_NEXT/index.js" v1
assert_content "$WEB_NEXT/index.html" v1
assert_file "$SERVER_NEXT/build.json"
assert_no_entry "$SERVER_LIVE"
assert_no_entry "$WEB_LIVE"
assert_no_entry "$SERVER_PREV"
assert_no_entry "$WEB_PREV"
# outDir 是相对 server/web 的，不能落到仓库根部。
assert_no_entry "$REPO/dist.next"
assert_grep "build.json head" '"head":"[0-9a-f]{40}"' "$SERVER_NEXT/build.json"
assert_grep "build.json version" '"version":"9\.8\.7"' "$SERVER_NEXT/build.json"
assert_grep "build.json builtAt" '"builtAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$SERVER_NEXT/build.json"
assert_grep "build.json dirty" '"dirty":false' "$SERVER_NEXT/build.json"

# ── 4. --swap：之前没有 live 时不产生 .prev ─────────────────────────────────
run_build --swap "$REPO"
assert_rc "swap 首次（无旧 live）" 0
assert_content "$SERVER_LIVE/index.js" v1
assert_content "$WEB_LIVE/index.html" v1
assert_no_entry "$SERVER_NEXT"
assert_no_entry "$WEB_NEXT"
assert_no_entry "$SERVER_PREV"
assert_no_entry "$WEB_PREV"

# ── 5. stage 新版本时 live 不变；swap 后 .prev 保留旧版本 ────────────────────
export FAKE_BUILD_MARKER=v2
run_build --stage "$REPO"
assert_rc "stage v2" 0
assert_content "$SERVER_LIVE/index.js" v1   # live 仍是旧版本
assert_content "$WEB_LIVE/index.html" v1
assert_content "$SERVER_NEXT/index.js" v2

run_build --swap "$REPO"
assert_rc "swap v2" 0
assert_content "$SERVER_LIVE/index.js" v2
assert_content "$WEB_LIVE/index.html" v2
assert_content "$SERVER_PREV/index.js" v1
assert_content "$WEB_PREV/index.html" v1
assert_no_entry "$SERVER_NEXT"
assert_no_entry "$WEB_NEXT"

# ── 6. --rollback：丢掉失败的 live，恢复 .prev ──────────────────────────────
run_build --rollback "$REPO"
assert_rc "rollback" 0
assert_content "$SERVER_LIVE/index.js" v1
assert_content "$WEB_LIVE/index.html" v1
assert_no_entry "$SERVER_PREV"
assert_no_entry "$WEB_PREV"

# 没有 .prev 时再回滚必须失败且不动 live。
run_build --rollback "$REPO"
[[ $RC -ne 0 ]] || fail "没有 .prev 时 rollback 应失败"
assert_contains "rollback 缺 prev" "无法回滚"
assert_content "$SERVER_LIVE/index.js" v1

# ── 7. stage 失败：live 不受影响，.next 被清理 ───────────────────────────────
export FAKE_BUILD_MARKER=v-fail
export FAKE_VITE_FAIL=1
run_build --stage "$REPO"
[[ $RC -ne 0 ]] || fail "vite 失败时 stage 应返回非零"
assert_contains "vite 失败清理提示" "live 未改动"
unset FAKE_VITE_FAIL
assert_no_entry "$SERVER_NEXT"
assert_no_entry "$WEB_NEXT"
assert_content "$SERVER_LIVE/index.js" v1
assert_no_entry "$SERVER_PREV"

export FAKE_TSC_FAIL=1
run_build --stage "$REPO"
[[ $RC -ne 0 ]] || fail "tsc 失败时 stage 应返回非零"
unset FAKE_TSC_FAIL
assert_no_entry "$SERVER_NEXT"
assert_no_entry "$WEB_NEXT"
assert_content "$SERVER_LIVE/index.js" v1

# ── 8. 没有 .next 时 swap 失败且保留旧 .prev ────────────────────────────────
export FAKE_BUILD_MARKER=v3
run_build --stage "$REPO"
assert_rc "stage v3" 0
run_build --swap "$REPO"
assert_rc "swap v3" 0
assert_content "$SERVER_LIVE/index.js" v3
assert_content "$SERVER_PREV/index.js" v1

# 没有重新 stage 就再次 swap：报错，不能破坏 live/.prev。
run_build --swap "$REPO"
[[ $RC -ne 0 ]] || fail "缺少 .next 时 swap 应失败"
assert_contains "swap 缺 next" "先运行"
assert_content "$SERVER_LIVE/index.js" v3
assert_content "$SERVER_PREV/index.js" v1

run_build --rollback "$REPO"
assert_rc "rollback v3" 0
assert_content "$SERVER_LIVE/index.js" v1
assert_no_entry "$SERVER_PREV"

# ── 9. 默认模式：按需安装依赖 + staging + swap ──────────────────────────────
export FAKE_BUILD_MARKER=v4
run_build "$REPO"
assert_rc "默认模式" 0
assert_not_contains "默认模式哈希匹配不装依赖" "安装依赖"
assert_content "$SERVER_LIVE/index.js" v4
assert_content "$WEB_LIVE/index.html" v4
assert_content "$SERVER_PREV/index.js" v1
assert_no_entry "$SERVER_NEXT"
assert_no_entry "$WEB_NEXT"

# 默认模式下 vite 失败：live 和 .prev 都不动，也没有残留 .next。
export FAKE_BUILD_MARKER=v-bad
export FAKE_VITE_FAIL=1
run_build "$REPO"
[[ $RC -ne 0 ]] || fail "默认模式构建失败应返回非零"
unset FAKE_VITE_FAIL
assert_content "$SERVER_LIVE/index.js" v4
assert_content "$SERVER_PREV/index.js" v1
assert_no_entry "$SERVER_NEXT"
assert_no_entry "$WEB_NEXT"

# ── 10. 已有 .prev 时 dirty 仍为 false（排除 .next/.prev）───────────────────
export FAKE_BUILD_MARKER=v5
run_build --stage "$REPO"
assert_rc "stage v5（已有 .prev）" 0
assert_grep "已有 .prev 时 dirty" '"dirty":false' "$SERVER_NEXT/build.json"
assert_content "$SERVER_LIVE/index.js" v4

# ── 11. 已有 .next 时 dirty=false；真实源码改动时 dirty=true ────────────────
export FAKE_BUILD_MARKER=v5b
run_build --stage "$REPO"   # 这一次开始前 .next（v5）已经存在
assert_rc "stage v5b（已有 .next）" 0
assert_grep "已有 .next 时 dirty" '"dirty":false' "$SERVER_NEXT/build.json"

printf 'changed\n' >"$REPO/server/new-source.txt"
run_build --stage "$REPO"
assert_rc "stage 有源码改动" 0
assert_grep "真实源码改动时 dirty" '"dirty":true' "$SERVER_NEXT/build.json"
rm -f "$REPO/server/new-source.txt"

# ── 12. rollback 会清掉残留 .next，避免被下次 swap 提升为 live ──────────────
assert_file "$SERVER_NEXT/index.js"
run_build --rollback "$REPO"
assert_rc "rollback 清理 .next" 0
assert_content "$SERVER_LIVE/index.js" v1
assert_no_entry "$SERVER_PREV"
assert_no_entry "$WEB_PREV"
assert_no_entry "$SERVER_NEXT"
assert_no_entry "$WEB_NEXT"

# ── 13. 注入 web swap 失败：server 已切换也要回退，不留半切换状态 ────────────
export FAKE_BUILD_MARKER=v6
run_build --stage "$REPO"
assert_rc "stage v6" 0
run_build --swap "$REPO"
assert_rc "swap v6" 0
assert_content "$SERVER_LIVE/index.js" v6
assert_content "$SERVER_PREV/index.js" v1

export FAKE_BUILD_MARKER=v7
run_build --stage "$REPO"
assert_rc "stage v7" 0

# 只让 `mv web/dist.next web/dist` 失败，其余 mv 照常，模拟 web 侧切换失败。
FAKEBIN=$TMP/fakebin-inject
mkdir -p "$FAKEBIN"
ln -sf "$(command -v node)" "$FAKEBIN/node"
cat >"$FAKEBIN/mv" <<'SH'
#!/bin/sh
last=
for a in "$@"; do last=$a; done
case $last in
  */web/dist)
    for a in "$@"; do
      case $a in */web/dist.next)
        echo "fake mv: injected web swap failure" >&2
        exit 1
        ;;
      esac
    done
    ;;
esac
exec "$REAL_MV" "$@"
SH
chmod +x "$FAKEBIN/mv"
REAL_MV=$(command -v mv)
EXTRA_ENV=(PATH="$FAKEBIN:$PATH" REAL_MV="$REAL_MV")
run_build --swap "$REPO"
EXTRA_ENV=()
[[ $RC -ne 0 ]] || fail "web 切换失败时 swap 应返回非零"
assert_contains "web 切换失败回退提示" "已回退 server/dist"
assert_content "$SERVER_LIVE/index.js" v6
assert_content "$WEB_LIVE/index.html" v6
assert_content "$SERVER_NEXT/index.js" v7
assert_content "$WEB_NEXT/index.html" v7
assert_no_entry "$SERVER_PREV"
assert_no_entry "$WEB_PREV"

# 清理注入后的状态，正常完成一次 v7 切换。
run_build --swap "$REPO"
assert_rc "注入后重新 swap v7" 0
assert_content "$SERVER_LIVE/index.js" v7
assert_content "$SERVER_PREV/index.js" v6

# ── 14. `--` 参数分隔符 ─────────────────────────────────────────────────────
export FAKE_BUILD_MARKER=v-dash
run_build -- "$REPO"
assert_rc "参数分隔符 --" 0
assert_content "$SERVER_LIVE/index.js" v-dash
assert_content "$SERVER_PREV/index.js" v7

# ── 15. 仓库 .gitignore 必须忽略 staging/回滚目录（否则 dirty 恒真）─────────
ROOT=$(cd "$HERE/.." && pwd)
for path in server/dist.next server/dist.prev web/dist.next web/dist.prev; do
  git -C "$ROOT" check-ignore -q "$path" || fail "仓库 .gitignore 未忽略 $path"
done

echo "deploy/build.sh staging/swap/rollback 测试通过"
