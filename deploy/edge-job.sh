#!/bin/bash
# qubius 公网入口（edge）作业的持锁入口（由 server detached 启动）。
#
# 约定：
#   * server 先 claim 出 pending，再 spawn 本脚本；
#   * 本脚本 exec 7<> <configDir>/ops.lock 并用 flock -n 持锁（失败 exit 3）；
#   * 持锁后 mark running，然后前台运行 node server/dist/edge-job.js；
#   * node 继承 fd 7，但它派生的 ssh/docker（Node 只传 stdio）不会继承；
#   * node 退出/被中断/启动失败时写 edge.json failed 终态并 mark failed；
#   * 所有 bash 子进程都 7>&-，避免意外持锁。
#
# 只读取环境变量，不把用户输入拼进脚本本体。
set -uo pipefail

ROOT=${QUBIUS_OPS_ROOT:?缺少 QUBIUS_OPS_ROOT}
TOKEN=${QUBIUS_OPS_TOKEN:?缺少 QUBIUS_OPS_TOKEN}
JOB=${QUBIUS_OPS_JOB:?缺少 QUBIUS_OPS_JOB}
KIND=${QUBIUS_EDGE_KIND:-apply}
CONFIG_DIR=${QUBIUS_EDGE_CONFIG_DIR:-${QUBIUS_CONFIG_DIR:-$ROOT}}
REPO_ROOT=${QUBIUS_EDGE_REPO_ROOT:-$(cd -- "$(dirname -- "$0")/.." && pwd -P)}
LOG=${QUBIUS_EDGE_LOG:-$CONFIG_DIR/edge.log}
OPS_SCRIPT=${QUBIUS_OPS_LOCK_SCRIPT:-$REPO_ROOT/deploy/ops-lock.sh}
NODE_BIN=${QUBIUS_NODE_BIN:-node}

mkdir -p "$ROOT" "$(dirname "$LOG")" 7>&- || exit 1

# 状态/时间契约见 server/src/job-state.ts：状态只用 running/success/failed，
# 时间戳为秒精度 UTC（YYYY-MM-DDTHH:MM:SSZ）。
# 写 edge.json failed 终态（保留其它顶层键）。node 不可用时退化为最小 JSON。
write_edge_failed() {
  local msg="$1"
  if command -v "$NODE_BIN" >/dev/null 2>&1; then
    EDGE_CONFIG_DIR="$CONFIG_DIR" EDGE_JOB_ID="$JOB" EDGE_KIND="$KIND" EDGE_MSG="$msg" \
      "$NODE_BIN" -e '
        const fs = require("fs");
        const path = require("path");
        const dir = process.env.EDGE_CONFIG_DIR;
        const file = path.join(dir, "edge.json");
        let data = {};
        try {
          const text = fs.readFileSync(file, "utf8");
          if (text.trim()) data = JSON.parse(text);
        } catch (error) {
          if (error && error.code !== "ENOENT") {
            try { fs.copyFileSync(file, file + ".bak." + Date.now()); } catch {}
          }
          data = {};
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
        const prev = data.job && typeof data.job === "object" ? data.job : {};
        // 保留 node 已写入的详细终态（同一 jobId 的 success/failed）。
        if (
          prev.jobId === process.env.EDGE_JOB_ID &&
          (prev.state === "success" || prev.state === "failed")
        ) {
          process.exit(0);
        }
        const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        data.job = {
          jobId: process.env.EDGE_JOB_ID,
          state: "failed",
          kind: process.env.EDGE_KIND || "apply",
          step: prev.step || "job",
          message: process.env.EDGE_MSG,
          pid: null,
          startedAt: typeof prev.startedAt === "string" ? prev.startedAt : now,
          finishedAt: now,
        };
        const tmp = file + ".tmp." + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
        try { fs.chmodSync(tmp, 0o600); } catch {}
        fs.renameSync(tmp, file);
      ' 7>&- >/dev/null 2>&1 || true
  else
    # 没有 node 可用时退化为最小 JSON；但仍保留同一 jobId 的详细终态。
    if [[ -f "$CONFIG_DIR/edge.json" ]] \
      && grep -q "\"jobId\"[[:space:]]*:[[:space:]]*\"$JOB\"" "$CONFIG_DIR/edge.json" 2>/dev/null 7>&- \
      && grep -Eq '"state"[[:space:]]*:[[:space:]]*"(success|failed)"' "$CONFIG_DIR/edge.json" 2>/dev/null 7>&-; then
      return 0
    fi
    local tmp="$CONFIG_DIR/edge.json.tmp.$$"
    printf '{"job":{"jobId":"%s","state":"failed","kind":"%s","step":"job","message":"任务未启动或已中断","pid":null,"startedAt":"","finishedAt":null}}\n' \
      "$JOB" "$KIND" >"$tmp" 2>/dev/null && mv -f "$tmp" "$CONFIG_DIR/edge.json" 2>/dev/null 7>&- || true
  fi
}

exec 7<>"$ROOT/ops.lock" || exit 1
if ! flock -n 7; then
  printf '%s\n' "ops lock busy，edge 作业退出" >>"$LOG" 2>/dev/null 7>&- || true
  write_edge_failed "ops lock 被占用，任务未启动"
  exit 3
fi

PGID=$(ps -o pgid= -p $$ 2>/dev/null 7>&- | tr -d ' ' 7>&-)
MARK_ARGS=(--root "$ROOT" --state running --kind "$KIND" --job-id "$JOB" --token "$TOKEN" --pid "$$")
[[ -n $PGID ]] && MARK_ARGS+=(--pgid "$PGID")
bash "$OPS_SCRIPT" mark "${MARK_ARGS[@]}" 7>&- >/dev/null 2>&1 || true

CHILD=""
JOB_FINAL=0

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ -n $CHILD ]]; then
    kill -TERM "$CHILD" 2>/dev/null 7>&- || true
    for _ in {1..20}; do
      kill -0 "$CHILD" 2>/dev/null 7>&- || break
      sleep 0.1 2>/dev/null 7>&- || sleep 1 7>&- || true
    done
    kill -KILL "$CHILD" 2>/dev/null 7>&- || true
  fi
  if [[ $rc -ne 0 && $JOB_FINAL -eq 0 ]]; then
    # node 可能来不及写终态（启动失败/被杀）；这里兜底写 failed。
    bash "$OPS_SCRIPT" mark --root "$ROOT" --state failed --kind "$KIND" \
      --job-id "$JOB" --token "$TOKEN" 7>&- >/dev/null 2>&1 || true
    write_edge_failed "任务被中断或未完成"
  fi
  exec 7>&- 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

"$NODE_BIN" "$REPO_ROOT/server/dist/edge-job.js" &
CHILD=$!
wait "$CHILD"
RC=$?
CHILD=""

state=success
[[ $RC -eq 0 ]] || state=failed
bash "$OPS_SCRIPT" mark --root "$ROOT" --state "$state" --kind "$KIND" \
  --job-id "$JOB" --token "$TOKEN" 7>&- >/dev/null 2>&1 || true
if [[ $RC -ne 0 ]]; then
  write_edge_failed "任务失败或未完成"
fi
JOB_FINAL=1

exit "$RC"
