#!/usr/bin/env bash
#
# Shell smoke tests for deploy/ops-lock.sh (no Node/Python needed).
# Uses OPS_LOCK_PROC_ROOT to inject fake /proc entries so no real process is
# killed. Run: bash deploy/ops-lock.test.sh

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT="$HERE/ops-lock.sh"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }

expect_contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then ok "$name"; else bad "$name（缺少 $needle）"; fi
}

expect_rc() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" -eq "$actual" ]; then ok "$name"; else bad "$name（exit $actual != $expected）"; fi
}

new_root() { mktemp -d "$TMP/root.XXXXXX"; }

# ── fresh claim → pending ───────────────────────────────────────────────────
ROOT1="$(new_root)"
OUT="$(bash "$SCRIPT" claim --root "$ROOT1" --kind deploy --job-id job1 --token tok1)"; RC=$?
expect_rc "fresh claim exit 0" 0 "$RC"
expect_contains "fresh claim pending" '"state":"pending"' "$OUT"
[ -f "$ROOT1/ops.lock" ] && ok "lock carrier created" || bad "lock carrier created"
[ -f "$ROOT1/ops.meta" ] && ok "meta created" || bad "meta created"

OUT="$(bash "$SCRIPT" status --root "$ROOT1")"; RC=$?
expect_rc "status exit 0" 0 "$RC"
expect_contains "status sees pending" '"metaState":"pending"' "$OUT"

# ── pending 宽限期内 busy ───────────────────────────────────────────────────
OUT="$(bash "$SCRIPT" claim --root "$ROOT1" --kind deploy --job-id job2 --token tok2)"; RC=$?
expect_rc "second claim busy exit 3" 3 "$RC"
expect_contains "second claim busy code" '"code":"busy"' "$OUT"

# ── residual 阻塞（fake /proc）──────────────────────────────────────────────
ROOT2="$(new_root)"
FAKE="$(mktemp -d "$TMP/proc.XXXXXX")"
mkdir -p "$FAKE/900001"
printf 'QUBIUS_OPS_ROOT=%s\0QUBIUS_OPS_TOKEN=x\0QUBIUS_OPS_JOB=old\0' "$ROOT2" > "$FAKE/900001/environ"
OUT="$(OPS_LOCK_PROC_ROOT="$FAKE" bash "$SCRIPT" claim --root "$ROOT2" --kind deploy --job-id j --token t)"; RC=$?
expect_rc "residual claim exit 4" 4 "$RC"
expect_contains "residual code" '"code":"residual"' "$OUT"
expect_contains "residual pids" '"remainingPids":[900001]' "$OUT"

# 只有 ROOT 的 daemon 不算残留（换一个 root，避开上面的残留）。
ROOT_DAEMON="$(new_root)"
mkdir -p "$FAKE/900002"
printf 'QUBIUS_OPS_ROOT=%s\0' "$ROOT_DAEMON" > "$FAKE/900002/environ"
OUT="$(OPS_LOCK_PROC_ROOT="$FAKE" bash "$SCRIPT" claim --root "$ROOT_DAEMON" --kind deploy --job-id j --token t)"; RC=$?
expect_rc "daemon without token ignored" 0 "$RC"

# ── clear ───────────────────────────────────────────────────────────────────
OUT="$(bash "$SCRIPT" clear --root "$ROOT1" --token wrong)"; RC=$?
expect_rc "clear wrong token exit 5" 5 "$RC"
expect_contains "clear wrong token code" '"code":"token-mismatch"' "$OUT"
OUT="$(bash "$SCRIPT" clear --root "$ROOT1" --token tok1)"; RC=$?
expect_rc "clear right token exit 0" 0 "$RC"
OUT="$(bash "$SCRIPT" status --root "$ROOT1")"
expect_contains "meta cleared" '"metaState":"missing"' "$OUT"

# ── force-reclaim + audit（短语固定 RECLAIM）────────────────────────────────
ROOT3="$(new_root)"
bash "$SCRIPT" claim --root "$ROOT3" --kind deploy --job-id job3 --token tok3 >/dev/null
OUT="$(bash "$SCRIPT" force-reclaim --root "$ROOT3" --phrase force-reclaim)"; RC=$?
expect_rc "old force-reclaim phrase rejected" 5 "$RC"
OUT="$(bash "$SCRIPT" force-reclaim --root "$ROOT3" --phrase RECLAIM)"; RC=$?
expect_rc "force RECLAIM exit 0" 0 "$RC"
expect_contains "audit written" '"forceReclaims"' "$(cat "$ROOT3/edge.json" 2>/dev/null)"
expect_contains "audit has root" "$ROOT3" "$(cat "$ROOT3/edge.json" 2>/dev/null)"
OUT="$(bash "$SCRIPT" status --root "$ROOT3")"
expect_contains "force cleared meta" '"metaState":"missing"' "$OUT"

# 有残留且清理不掉时：exit 4，不宣称成功，meta 保留。
ROOT4="$(new_root)"
bash "$SCRIPT" claim --root "$ROOT4" --kind deploy --job-id job4 --token tok4 >/dev/null
FAKE4="$(mktemp -d "$TMP/proc4.XXXXXX")"
mkdir -p "$FAKE4/900010"
printf 'QUBIUS_OPS_ROOT=%s\0QUBIUS_OPS_TOKEN=tok4\0QUBIUS_OPS_JOB=job4\0' "$ROOT4" > "$FAKE4/900010/environ"
OUT="$(OPS_LOCK_PROC_ROOT="$FAKE4" bash "$SCRIPT" force-reclaim --root "$ROOT4" --phrase RECLAIM --timeout 0)"; RC=$?
expect_rc "force with residual exit 4" 4 "$RC"
expect_contains "force residual pids" '"remainingPids":[900010]' "$OUT"
if [[ "$OUT" == *'"forceReclaimed":true'* ]]; then bad "force residual must not claim success"; else ok "force residual not success"; fi
OUT="$(bash "$SCRIPT" status --root "$ROOT4")"
expect_contains "force residual keeps meta" '"metaState":"pending"' "$OUT"
# 移除残留后可正常回收。
rm -rf "$FAKE4/900010"
OUT="$(OPS_LOCK_PROC_ROOT="$FAKE4" bash "$SCRIPT" force-reclaim --root "$ROOT4" --phrase RECLAIM --timeout 0)"; RC=$?
expect_rc "force after residual gone exit 0" 0 "$RC"
expect_contains "force after residual success" '"forceReclaimed":true' "$OUT"

# ── status 路径 chmod 失败只告警 ────────────────────────────────────────────
ROOT5="$(new_root)"
FAKEBIN="$(mktemp -d "$TMP/fakebin.XXXXXX")"
printf '#!/bin/sh\nexit 1\n' > "$FAKEBIN/chmod"
chmod +x "$FAKEBIN/chmod"
ERRF="$TMP/chmod.err"
OUT="$(PATH="$FAKEBIN:$PATH" bash "$SCRIPT" status --root "$ROOT5" 2>"$ERRF")"; RC=$?
expect_rc "status chmod failure still exit 0" 0 "$RC"
expect_contains "status chmod failure warns" "警告" "$(cat "$ERRF" 2>/dev/null)"
expect_contains "status chmod failure still emits json" '"ok":true' "$OUT"

# ── mark：持锁语义外的原子写（调用方负责持锁）──────────────────────────────
ROOT6="$(new_root)"
mkdir -p "$ROOT6"
printf '{"version":1,"state":"pending","kind":"deploy","jobId":"old","token":"old","root":"%s","custom":"keep","claimedAt":111}\n' "$ROOT6" > "$ROOT6/ops.meta"
chmod 600 "$ROOT6/ops.meta"
OUT="$(bash "$SCRIPT" mark --root "$ROOT6" --state running --kind apply --job-id job --token tok --pid 123 --pgid 456)"; RC=$?
expect_rc "mark running exit 0" 0 "$RC"
expect_contains "mark running state" '"state":"running"' "$OUT"
META_JSON="$(cat "$ROOT6/ops.meta")"
expect_contains "mark preserves extras" '"custom":"keep"' "$META_JSON"
expect_contains "mark preserves claimedAt" '"claimedAt":111' "$META_JSON"
expect_contains "mark writes pgid" '"pgid":456' "$META_JSON"
if [[ "$META_JSON" == *'"finishedAt"'* ]]; then bad "mark running must not set finishedAt"; else ok "mark running has no finishedAt"; fi
[ "$(stat -c %a "$ROOT6/ops.meta")" = "600" ] && ok "mark meta mode 0600" || bad "mark meta mode 0600"
[ ! -e "$ROOT6/ops.lock" ] && ok "mark does not create/acquire lock" || bad "mark must not touch ops.lock"
OUT="$(bash "$SCRIPT" mark --root "$ROOT6" --state success --kind apply --job-id job --token tok)"; RC=$?
expect_rc "mark success exit 0" 0 "$RC"
META_JSON="$(cat "$ROOT6/ops.meta")"
expect_contains "mark success finishedAt" '"finishedAt"' "$META_JSON"
expect_contains "mark success keeps token" '"token":"tok"' "$META_JSON"
OUT="$(bash "$SCRIPT" status --root "$ROOT6")"
expect_contains "status sees marked success" '"metaState":"success"' "$OUT"
OUT="$(bash "$SCRIPT" mark --root "$ROOT6" --state nope --kind k --job-id j --token t)"; RC=$?
expect_rc "mark invalid state exit 2" 2 "$RC"

# ── 参数错误 ────────────────────────────────────────────────────────────────
OUT="$(bash "$SCRIPT" claim --root "$ROOT3" --kind deploy --job-id x)"; RC=$?
expect_rc "missing token usage exit 2" 2 "$RC"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
