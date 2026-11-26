#!/usr/bin/env bash
#
# ops-lock.sh — qubius 部署/运维串行锁协议（D2 调用侧契约）
#
# 设计（已评审）：
#   * <root>/ops.lock 只作 flock 载体：O_CREAT、0600，永不写入、永不 unlink。
#     删除锁文件会破坏 flock 语义（新 inode 上锁，旧持有者仍持旧 inode）。
#   * 元数据在 <root>/ops.meta：0600，temp + rename 原子写。记录 state /
#     kind / jobId / token / pid / root / claimedAt / updatedAt。
#   * 状态机：
#       双缺失            -> 锁内复核 running/token 后写 pending
#       meta 在 / lock 无 -> 加锁后重读再决定
#       lock 在 / meta 缺失或损坏 -> 锁内按 jobId 扫残留；无残留则自动初始化
#       meta 完整 + 空闲  -> 终态（先扫残留）/ pending 宽限 / running 扫 token
#       任何存活残留      -> 409 语义（busy 或 residual）+ remainingPids
#   * ROOT 注入和比较都用 realpath 规范化。同一物理 configDir 必须用同一
#     路径写法；运行中改 configDir 会让旧残留 ROOT 与新配置不一致，需要
#     force-reclaim。
#
# 子命令与退出码：
#   claim --root R --kind K --job-id ID --token T [--grace S]
#       成功: 0, {"ok":true,"state":"pending",...}
#       锁被活跃 job 持有: 3, {"ok":false,"code":"busy",...}
#       锁空闲但有残留:   4, {"ok":false,"code":"residual","kind":"unknown",...}
#       参数错误:         2
#   status --root R                         始终 0（信息性）
#   cleanup --root R [--token T] [--job-id ID]... [--timeout S] [--until S]
#       --timeout 是 TERM→KILL 的总超时秒数；--until 是它的废弃别名，
#       两者同时给时以 --timeout 为准。成功: 0；锁被持有: 3
#   clear --root R [--token T]              成功 0；token 不匹配 5；锁被持有 3
#   force-reclaim --root R --phrase RECLAIM [--timeout S]
#       先清理残留（按 meta 的 token/jobId；无 meta 时按 root），确认无残留
#       后才清 meta 并写 edge.json 审计。仍有残留: exit 4 + remainingPids。
#       短语错误 5；锁被持有 3。
#   mark --root R --state running|success|failed --kind K --job-id J --token T
#        [--pid P] [--pgid G]
#       原子写 ops.meta（temp+rename，0600），保留未建模字段。假定调用方
#       已持有 flock，本命令自身不取锁。成功 0，参数错误 2。
#
# ── job 侧用法（D2 在 deploy-job.sh / edge-job 里实现）──────────────────
#   exec 7<>"$ROOT/ops.lock"
#   flock -n 7 || { echo "ops lock busy" >&2; exit 3; }
#   # 持锁时写 running meta（本命令不取锁，可直接调用；child 记得 7>&-）
#   bash ops-lock.sh mark --root "$ROOT" --state running --kind apply \
#        --job-id "$JOB" --token "$TOKEN" --pid $$ 7>&-
#   # ... 执行部署；所有 child 都必须关闭 fd 7：`command 7>&-`
#   trap 'stop_children; exec 7>&-' EXIT INT TERM
#   bash ops-lock.sh mark --root "$ROOT" --state success|failed --kind apply \
#        --job-id "$JOB" --token "$TOKEN" 7>&-
#   exit   # fd 关闭即释放锁；不要 rm 锁文件。
#
# 启动 daemon（server/start-all 拉起的长期进程）时用
#   env -u QUBIUS_OPS_ROOT -u QUBIUS_OPS_TOKEN -u QUBIUS_OPS_JOB -u QUBIUS_OPS_SERVER ...
# 去掉标记，否则它们会被当成残留；QUBIUS_OPS_SERVER=1 只用于显式豁免 server。
# 被 `env -i`/沙箱清空 env 的子进程无法通过 /proc/*/environ 识别，本协议
# 不保证能清理。
#
# 测试可通过 OPS_LOCK_PROC_ROOT 指向伪造的 proc 目录（每个 PID 一个子目录，
# 内含 NUL 分隔的 environ；<pid>/dead 存在表示已死）。

set -uo pipefail
umask 077

EXIT_OK=0
EXIT_USAGE=2
EXIT_BUSY=3
EXIT_RESIDUAL=4
EXIT_CONFLICT=5

MANAGED_LOCK_NAME="ops.lock"
MANAGED_META_NAME="ops.meta"
AUDIT_NAME="edge.json"
PROC_ROOT="${OPS_LOCK_PROC_ROOT:-/proc}"
DEFAULT_GRACE="${OPS_LOCK_GRACE:-120}"
DEFAULT_CLEANUP_TIMEOUT="${OPS_LOCK_CLEANUP_TIMEOUT:-20}"
FORCE_PHRASE="${OPS_FORCE_PHRASE:-RECLAIM}"

ROOT_RAW=""
ROOT=""
LOCK=""
META=""
AUDIT=""
LOCKFD=""
META_TEXT=""
META_STATUS="missing"

# flock 是锁协议的硬依赖。macOS 默认没有 flock；缺失时必须明确报错，
# 否则命令不存在会被后面的 `if ! flock -n` 当成“锁被占用”，把部署误判成 busy。
if ! command -v flock >/dev/null 2>&1; then
  printf '{"ok":false,"code":"unsupported","reason":"flock","hint":"当前系统没有 flock，无法使用 ops lock；Windows/macOS 页面部署请走 deploy/deploy-job.mjs。"}\n'
  exit "$EXIT_USAGE"
fi

# ── 基础工具 ────────────────────────────────────────────────────────────────

now_epoch() { date +%s; }

json_escape() {
  local s="${1-}"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

json_pid_array() {
  local out=""
  local p
  for p in "$@"; do
    [ -n "$p" ] || continue
    out+="${out:+,}$p"
  done
  printf '[%s]' "$out"
}

# 规范化绝对路径：解析已有 symlink/..，允许路径不存在。
norm_path() {
  local p="${1-}"
  if command -v realpath >/dev/null 2>&1; then
    realpath -m -- "$p" 2>/dev/null && return 0
  fi
  if command -v readlink >/dev/null 2>&1 && readlink -f -- "$p" >/dev/null 2>&1; then
    readlink -f -- "$p"
    return 0
  fi
  case "$p" in
    /*) printf '%s\n' "$p" ;;
    *) printf '%s/%s\n' "$(pwd -P)" "$p" ;;
  esac
}

usage_error() {
  printf '{"ok":false,"code":"usage","message":"%s"}\n' "$(json_escape "$1")"
  exit "$EXIT_USAGE"
}

setup_paths() {
  [ -n "$ROOT_RAW" ] || usage_error "缺少 --root"
  ROOT="$(norm_path "$ROOT_RAW")"
  LOCK="$ROOT/$MANAGED_LOCK_NAME"
  META="$ROOT/$MANAGED_META_NAME"
  AUDIT="$ROOT/$AUDIT_NAME"
  if ! mkdir -p -- "$ROOT" 2>/dev/null; then
    usage_error "无法创建 root 目录：$ROOT"
  fi
}

# open_lock [soft]
# soft=1 时 chmod 失败只告警（status 是只读诊断，不应因此 exit 2）。
open_lock() {
  local soft="${1:-}"
  exec {LOCKFD}<>"$LOCK" || usage_error "无法打开锁文件：$LOCK"
  # 已存在的锁文件也显式修正权限。
  if ! chmod 0600 -- "$LOCK" 2>/dev/null; then
    case "$soft" in
      1|soft|true)
        printf '警告：无法把锁文件权限设为 0600：%s\n' "$LOCK" >&2
        ;;
      *)
        usage_error "无法把锁文件权限设为 0600：$LOCK"
        ;;
    esac
  fi
}

unlock() {
  if [ -n "${LOCKFD:-}" ]; then
    flock -u "$LOCKFD" 2>/dev/null || true
    exec {LOCKFD}>&-
    LOCKFD=""
  fi
}

# ── meta ────────────────────────────────────────────────────────────────────

read_meta_source() {
  META_TEXT=""
  META_STATUS="missing"
  if [ -e "$META" ]; then
    if META_TEXT="$(cat -- "$META" 2>/dev/null)"; then
      if [[ "$META_TEXT" =~ ^[[:space:]]*\{.*\}[[:space:]]*$ ]]; then
        META_STATUS="complete"
      else
        META_STATUS="corrupt"
      fi
    else
      META_STATUS="corrupt"
    fi
  fi
}

meta_get_str() {
  local key="$1"
  printf '%s' "$META_TEXT" \
    | sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}

meta_get_num() {
  local key="$1"
  printf '%s' "$META_TEXT" \
    | sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
    | head -n 1
}

write_meta() {
  local state="$1" kind="$2" job="$3" token="$4" pid="$5" claimed="$6"
  local updated tmp
  updated="$(now_epoch)"
  tmp="$META.tmp.$$.$RANDOM"
  printf '{"version":1,"state":"%s","kind":"%s","jobId":"%s","token":"%s","pid":%s,"root":"%s","claimedAt":%s,"updatedAt":%s}\n' \
    "$(json_escape "$state")" "$(json_escape "$kind")" "$(json_escape "$job")" \
    "$(json_escape "$token")" "${pid:-0}" "$(json_escape "$ROOT")" \
    "${claimed:-0}" "$updated" > "$tmp"
  chmod 0600 "$tmp" 2>/dev/null || true
  if ! mv -f -- "$tmp" "$META" 2>/dev/null; then
    rm -f -- "$tmp" 2>/dev/null || true
    usage_error "写入 $META 失败"
  fi
}

remove_meta() {
  rm -f -- "$META" 2>/dev/null || true
}

meta_age_seconds() {
  local claimed now
  claimed="$(meta_get_num claimedAt)"
  [ -n "$claimed" ] || claimed=0
  now="$(now_epoch)"
  if [ "$now" -ge "$claimed" ]; then
    printf '%s' "$((now - claimed))"
  else
    printf '0'
  fi
}

# ── 残留进程扫描 ────────────────────────────────────────────────────────────

# trap 用；不依赖外部状态。
is_dead() {
  local dir="$1" pid="$2"
  if [ -n "${OPS_LOCK_PROC_ROOT:-}" ]; then
    [ -e "$dir/dead" ] && return 0
    return 1
  fi
  local stat state
  stat="$(cat -- "$dir/stat" 2>/dev/null)" || return 0
  # comm 可能包含 ) 和空格；取最后一个 ") " 之后的第一列。
  state="${stat##*) }"
  state="${state%% *}"
  [ "$state" = "Z" ] && return 0
  kill -0 "$pid" 2>/dev/null && return 1
  return 0
}

RES_PIDS=()
RES_TOKENS=()
RES_JOBS=()

# scan_residuals ROOT [TOKEN] [JOBID...]
# 匹配条件：QUBIUS_OPS_ROOT 规范化后等于 ROOT，且带 TOKEN 或 JOB 标记。
# 只有 ROOT 的 daemon 不算残留；QUBIUS_OPS_SERVER=1 的 server 排除；
# 自身与父进程排除。给了 TOKEN/JOBID 时只保留匹配项（cleanup 过滤用）。
scan_residuals() {
  local target_root="$1"; shift
  local want_token="${1-}"; [ $# -gt 0 ] && shift
  local want_jobs=("$@")
  RES_PIDS=()
  RES_TOKENS=()
  RES_JOBS=()
  local self="$$" parent="${PPID:-0}"
  local d pid envfile entry rootv tokv jobv serverv norm
  local matched wj
  shopt -s nullglob
  for d in "$PROC_ROOT"/*; do
    [ -d "$d" ] || continue
    pid="${d##*/}"
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [ "$pid" -eq "$self" ] && continue
    [ "$pid" -eq "$parent" ] && continue
    envfile="$d/environ"
    [ -r "$envfile" ] || continue
    is_dead "$d" "$pid" && continue
    rootv=""; tokv=""; jobv=""; serverv=""
    while IFS= read -r -d '' entry; do
      case "$entry" in
        QUBIUS_OPS_ROOT=*) rootv="${entry#QUBIUS_OPS_ROOT=}" ;;
        QUBIUS_OPS_TOKEN=*) tokv="${entry#QUBIUS_OPS_TOKEN=}" ;;
        QUBIUS_OPS_JOB=*) jobv="${entry#QUBIUS_OPS_JOB=}" ;;
        QUBIUS_OPS_SERVER=*) serverv="${entry#QUBIUS_OPS_SERVER=}" ;;
      esac
    done < "$envfile" 2>/dev/null
    [ -n "$rootv" ] || continue
    case "$serverv" in
      1|true|yes|on) continue ;;
    esac
    [ -n "$tokv" ] || [ -n "$jobv" ] || continue
    norm="$(norm_path "$rootv")"
    [ "$norm" = "$target_root" ] || continue
    if [ -n "$want_token" ] || [ "${#want_jobs[@]}" -gt 0 ]; then
      matched=0
      [ -n "$want_token" ] && [ "$tokv" = "$want_token" ] && matched=1
      for wj in "${want_jobs[@]}"; do
        [ -n "$wj" ] && [ "$jobv" = "$wj" ] && matched=1
      done
      [ "$matched" -eq 1 ] || continue
    fi
    RES_PIDS+=("$pid")
    RES_TOKENS+=("$tokv")
    RES_JOBS+=("$jobv")
  done
  shopt -u nullglob
}

# ── 审计 ────────────────────────────────────────────────────────────────────

write_audit() {
  local entry="$1"
  if command -v node >/dev/null 2>&1; then
    EDGE_AUDIT_ENTRY="$entry" EDGE_AUDIT_FILE="$AUDIT" node -e '
      const fs = require("fs");
      const file = process.env.EDGE_AUDIT_FILE;
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
      const list = Array.isArray(data.forceReclaims) ? data.forceReclaims : [];
      list.push(JSON.parse(process.env.EDGE_AUDIT_ENTRY));
      data.forceReclaims = list;
      const tmp = file + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch {}
      fs.renameSync(tmp, file);
    ' >/dev/null 2>&1 && return 0
  fi
  # node 不可用时退化为 JSONL 追加（仍是 0600）。
  printf '%s\n' "$entry" >> "$AUDIT" 2>/dev/null || true
  chmod 0600 "$AUDIT" 2>/dev/null || true
}

# ── 子命令 ──────────────────────────────────────────────────────────────────

parse_root_arg() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --root) ROOT_RAW="${2-}"; shift 2 ;;
      *) return 1 ;;
    esac
  done
  return 0
}

cmd_claim() {
  local kind="" jobid="" token="" grace="$DEFAULT_GRACE"
  while [ $# -gt 0 ]; do
    case "$1" in
      --root) ROOT_RAW="${2-}"; shift 2 ;;
      --kind) kind="${2-}"; shift 2 ;;
      --job-id) jobid="${2-}"; shift 2 ;;
      --token) token="${2-}"; shift 2 ;;
      --grace) grace="${2-}"; shift 2 ;;
      *) usage_error "claim 未知参数：$1" ;;
    esac
  done
  [ -n "$kind" ] || usage_error "claim 缺少 --kind"
  [ -n "$jobid" ] || usage_error "claim 缺少 --job-id"
  [ -n "$token" ] || usage_error "claim 缺少 --token"
  [[ "$grace" =~ ^[0-9]+$ ]] || usage_error "--grace 必须是非负整数"
  setup_paths
  open_lock

  if ! flock -n "$LOCKFD"; then
    # busy：锁被活跃 job 持有。kind/jobId 取 meta 里的持有者信息。
    read_meta_source
    local bkind="unknown" bjob=""
    if [ "$META_STATUS" = "complete" ]; then
      bkind="$(meta_get_str kind)"
      bjob="$(meta_get_str jobId)"
    fi
    [ -n "$bkind" ] || bkind="unknown"
    scan_residuals "$ROOT" ""
    printf '{"ok":false,"code":"busy","reason":"lock","root":"%s","kind":"%s","jobId":"%s","remainingPids":%s,"hint":"有活跃 job 持有 ops lock；等待其结束，或确认后 force-reclaim。"}\n' \
      "$(json_escape "$ROOT")" "$(json_escape "$bkind")" "$(json_escape "$bjob")" \
      "$(json_pid_array "${RES_PIDS[@]}")"
    unlock
    exit "$EXIT_BUSY"
  fi

  read_meta_source
  # 锁内先扫完整 root：任何存活残留都阻塞（区分 busy/residual 由锁状态决定）。
  scan_residuals "$ROOT" ""
  if [ "${#RES_PIDS[@]}" -gt 0 ]; then
    # 残留进程只暴露 token/job，不暴露任务 kind；统一标 unknown，
    # 由 D2 用 remainingPids/token 决定 cleanup 还是 force-reclaim。
    printf '{"ok":false,"code":"residual","kind":"unknown","root":"%s","remainingPids":%s,"hint":"锁空闲但仍有残留进程。先运行 cleanup --root %s，再重试；确认无关时用 force-reclaim。"}\n' \
      "$(json_escape "$ROOT")" \
      "$(json_pid_array "${RES_PIDS[@]}")" "$(json_escape "$ROOT")"
    unlock
    exit "$EXIT_RESIDUAL"
  fi

  if [ "$META_STATUS" = "complete" ]; then
    local state age
    state="$(meta_get_str state)"
    case "$state" in
      pending)
        age="$(meta_age_seconds)"
        if [ "$age" -lt "$grace" ]; then
          printf '{"ok":false,"code":"busy","reason":"pending","state":"pending","root":"%s","jobId":"%s","ageSeconds":%s,"graceSeconds":%s,"remainingPids":[],"hint":"已有 pending claim 在宽限期内；等待其进入 running 或过期。"}\n' \
            "$(json_escape "$ROOT")" "$(json_escape "$(meta_get_str jobId)")" \
            "$age" "$grace"
          unlock
          exit "$EXIT_BUSY"
        fi
        ;;
      running)
        # 能拿到锁说明持有者已退出；没有残留 => 归一化为可回收。
        ;;
      final)
        ;;
      *)
        ;;
    esac
  fi

  local claimed
  claimed="$(now_epoch)"
  write_meta "pending" "$kind" "$jobid" "$token" "$$" "$claimed"
  unlock
  printf '{"ok":true,"code":"ok","state":"pending","root":"%s","kind":"%s","jobId":"%s","token":"%s","pid":%s,"claimedAt":%s}\n' \
    "$(json_escape "$ROOT")" "$(json_escape "$kind")" "$(json_escape "$jobid")" \
    "$(json_escape "$token")" "$$" "$claimed"
  exit "$EXIT_OK"
}

cmd_status() {
  local shared=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --root) ROOT_RAW="${2-}"; shift 2 ;;
      *) usage_error "status 未知参数：$1" ;;
    esac
  done
  setup_paths
  open_lock soft
  local lock_free="true"
  if flock -s -n "$LOCKFD"; then
    shared=1
  else
    lock_free="false"
  fi
  read_meta_source
  scan_residuals "$ROOT" ""
  local state kind jobid token pid age
  state="$META_STATUS"; kind=""; jobid=""; token=""; pid=""; age=""
  if [ "$META_STATUS" = "complete" ]; then
    state="$(meta_get_str state)"
    kind="$(meta_get_str kind)"
    jobid="$(meta_get_str jobId)"
    token="$(meta_get_str token)"
    pid="$(meta_get_num pid)"
    age="$(meta_age_seconds)"
  fi
  printf '{"ok":true,"code":"ok","root":"%s","lockFree":%s,"metaStatus":"%s","metaState":"%s","metaKind":"%s","metaJobId":"%s","metaToken":"%s","metaPid":%s,"metaAgeSeconds":%s,"remainingPids":%s}\n' \
    "$(json_escape "$ROOT")" "$lock_free" "$META_STATUS" \
    "$(json_escape "$state")" "$(json_escape "$kind")" "$(json_escape "$jobid")" \
    "$(json_escape "$token")" "${pid:-0}" "${age:-0}" \
    "$(json_pid_array "${RES_PIDS[@]}")"
  [ "$shared" -eq 1 ] && unlock
  exit "$EXIT_OK"
}

cmd_clear() {
  local token=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --root) ROOT_RAW="${2-}"; shift 2 ;;
      --token) token="${2-}"; shift 2 ;;
      *) usage_error "clear 未知参数：$1" ;;
    esac
  done
  setup_paths
  open_lock
  if ! flock -n "$LOCKFD"; then
    printf '{"ok":false,"code":"busy","reason":"lock","root":"%s","hint":"活跃 job 持锁时不能 clear。"}\n' \
      "$(json_escape "$ROOT")"
    unlock
    exit "$EXIT_BUSY"
  fi
  read_meta_source
  if [ "$META_STATUS" = "complete" ] && [ -n "$token" ]; then
    local current
    current="$(meta_get_str token)"
    if [ -n "$current" ] && [ "$current" != "$token" ]; then
      printf '{"ok":false,"code":"token-mismatch","root":"%s","metaToken":"%s","hint":"token 不匹配；拒绝清除他人的锁记录。"}\n' \
        "$(json_escape "$ROOT")" "$(json_escape "$current")"
      unlock
      exit "$EXIT_CONFLICT"
    fi
  fi
  remove_meta
  unlock
  printf '{"ok":true,"code":"ok","root":"%s","cleared":true}\n' "$(json_escape "$ROOT")"
  exit "$EXIT_OK"
}

CLEANED_PIDS=()

add_cleaned() {
  local p="$1"
  case " ${CLEANED_PIDS[*]-} " in
    *" $p "*) ;;
    *) CLEANED_PIDS+=("$p") ;;
  esac
}

# cleanup_residuals TOKEN TIMEOUT [JOBID...]
# TERM→wait→KILL；每轮重新枚举。结果：CLEANED_PIDS，RES_PIDS 为最后一次扫描。
cleanup_residuals() {
  local token="$1" timeout="$2"; shift 2
  local want_jobs=() j
  for j in "$@"; do [ -n "$j" ] && want_jobs+=("$j"); done
  CLEANED_PIDS=()
  local deadline p
  deadline=$(( $(now_epoch) + timeout ))
  # 阶段 1：TERM，每轮重新枚举。
  while :; do
    scan_residuals "$ROOT" "$token" "${want_jobs[@]}"
    [ "${#RES_PIDS[@]}" -eq 0 ] && break
    for p in "${RES_PIDS[@]}"; do
      kill -TERM "$p" 2>/dev/null || true
      add_cleaned "$p"
    done
    [ "$(now_epoch)" -ge "$deadline" ] && break
    sleep 0.1 2>/dev/null || sleep 1
  done
  # 阶段 2：KILL（最多再等约 2 秒）。
  local kill_deadline
  kill_deadline=$(( $(now_epoch) + 2 ))
  while :; do
    scan_residuals "$ROOT" "$token" "${want_jobs[@]}"
    [ "${#RES_PIDS[@]}" -eq 0 ] && break
    for p in "${RES_PIDS[@]}"; do
      kill -KILL "$p" 2>/dev/null || true
      add_cleaned "$p"
    done
    [ "$(now_epoch)" -ge "$kill_deadline" ] && break
    sleep 0.1 2>/dev/null || sleep 1
  done
  scan_residuals "$ROOT" "$token" "${want_jobs[@]}"
}

# mark：调用方已持 flock，本命令不取锁；原子写 ops.meta。
cmd_mark() {
  local state="" kind="" jobid="" token="" pid="" pgid=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --root) ROOT_RAW="${2-}"; shift 2 ;;
      --state) state="${2-}"; shift 2 ;;
      --kind) kind="${2-}"; shift 2 ;;
      --job-id) jobid="${2-}"; shift 2 ;;
      --token) token="${2-}"; shift 2 ;;
      --pid) pid="${2-}"; shift 2 ;;
      --pgid) pgid="${2-}"; shift 2 ;;
      *) usage_error "mark 未知参数：$1" ;;
    esac
  done
  [ -n "$state" ] || usage_error "mark 缺少 --state"
  case "$state" in
    running|success|failed) ;;
    *) usage_error "mark --state 只能是 running/success/failed：$state" ;;
  esac
  [ -n "$kind" ] || usage_error "mark 缺少 --kind"
  [ -n "$jobid" ] || usage_error "mark 缺少 --job-id"
  [ -n "$token" ] || usage_error "mark 缺少 --token"
  if [ -n "$pid" ] && ! [[ "$pid" =~ ^[0-9]+$ ]]; then usage_error "mark --pid 必须是整数"; fi
  if [ -n "$pgid" ] && ! [[ "$pgid" =~ ^[0-9]+$ ]]; then usage_error "mark --pgid 必须是整数"; fi
  setup_paths
  if ! command -v node >/dev/null 2>&1; then
    usage_error "mark 需要 node 才能安全合并并原子写 ops.meta"
  fi
  OPS_META_FILE="$META" OPS_ROOT="$ROOT" OPS_STATE="$state" OPS_KIND="$kind" \
    OPS_JOB_ID="$jobid" OPS_TOKEN="$token" OPS_PID="$pid" OPS_PGID="$pgid" \
    node -e '
      const fs = require("fs");
      const file = process.env.OPS_META_FILE;
      let old = {};
      try {
        const text = fs.readFileSync(file, "utf8");
        if (text.trim()) old = JSON.parse(text);
      } catch (error) {
        // 缺失或损坏都按空对象处理；损坏的旧内容由调用方通过审计/日志排查。
        old = {};
      }
      if (!old || typeof old !== "object" || Array.isArray(old)) old = {};
      const now = Math.floor(Date.now() / 1000);
      const state = process.env.OPS_STATE;
      // 先展开 old，保留未建模字段；再覆盖本命令管理的字段。
      const next = {
        ...old,
        version: 1,
        state,
        kind: process.env.OPS_KIND,
        jobId: process.env.OPS_JOB_ID,
        token: process.env.OPS_TOKEN,
        root: process.env.OPS_ROOT,
      };
      if (process.env.OPS_PID) next.pid = Number(process.env.OPS_PID);
      if (process.env.OPS_PGID) next.pgid = Number(process.env.OPS_PGID);
      if (!next.claimedAt) next.claimedAt = old.claimedAt || now;
      next.startedAt = old.startedAt || old.claimedAt || now;
      if (state === "running") delete next.finishedAt;
      else next.finishedAt = now;
      next.updatedAt = now;
      const tmp = file + ".tmp." + process.pid + "." + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch {}
      fs.renameSync(tmp, file);
      process.stdout.write(JSON.stringify({
        ok: true,
        code: "ok",
        state: next.state,
        startedAt: next.startedAt,
        finishedAt: next.finishedAt == null ? null : next.finishedAt,
      }) + "\n");
    ' || usage_error "写入 ops.meta 失败"
  exit "$EXIT_OK"
}

cmd_cleanup() {
  local token="" timeout_arg="" until_arg=""
  local want_jobs=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --root) ROOT_RAW="${2-}"; shift 2 ;;
      --token) token="${2-}"; shift 2 ;;
      --job-id) want_jobs+=("${2-}"); shift 2 ;;
      --until) until_arg="${2-}"; shift 2 ;;
      --timeout) timeout_arg="${2-}"; shift 2 ;;
      *) usage_error "cleanup 未知参数：$1" ;;
    esac
  done
  # 语义统一：--timeout 是总超时；--until 是废弃别名，同时给以 --timeout 为准。
  local timeout="${timeout_arg:-${until_arg:-$DEFAULT_CLEANUP_TIMEOUT}}"
  [[ "$timeout" =~ ^[0-9]+$ ]] || usage_error "--timeout/--until 必须是非负整数秒"
  setup_paths
  open_lock
  if ! flock -n "$LOCKFD"; then
    printf '{"ok":false,"code":"busy","reason":"lock","root":"%s","hint":"活跃 job 持锁时不能 cleanup。"}\n' \
      "$(json_escape "$ROOT")"
    unlock
    exit "$EXIT_BUSY"
  fi

  cleanup_residuals "$token" "$timeout" "${want_jobs[@]}"
  printf '{"ok":true,"code":"ok","root":"%s","cleanedPids":%s,"remainingPids":%s}\n' \
    "$(json_escape "$ROOT")" "$(json_pid_array "${CLEANED_PIDS[@]}")" \
    "$(json_pid_array "${RES_PIDS[@]}")"
  unlock
  exit "$EXIT_OK"
}

cmd_force_reclaim() {
  local phrase="" timeout="$DEFAULT_CLEANUP_TIMEOUT"
  while [ $# -gt 0 ]; do
    case "$1" in
      --root) ROOT_RAW="${2-}"; shift 2 ;;
      --phrase) phrase="${2-}"; shift 2 ;;
      --timeout) timeout="${2-}"; shift 2 ;;
      *) usage_error "force-reclaim 未知参数：$1" ;;
    esac
  done
  [ -n "$phrase" ] || usage_error "force-reclaim 缺少 --phrase"
  [[ "$timeout" =~ ^[0-9]+$ ]] || usage_error "--timeout 必须是非负整数秒"
  setup_paths
  open_lock
  if ! flock -n "$LOCKFD"; then
    printf '{"ok":false,"code":"busy","reason":"lock","root":"%s","hint":"活跃 job 持锁时不能 force-reclaim。"}\n' \
      "$(json_escape "$ROOT")"
    unlock
    exit "$EXIT_BUSY"
  fi
  if [ "$phrase" != "$FORCE_PHRASE" ]; then
    printf '{"ok":false,"code":"phrase-mismatch","root":"%s","hint":"确认短语不匹配；需要精确输入 %s。"}\n' \
      "$(json_escape "$ROOT")" "$(json_escape "$FORCE_PHRASE")"
    unlock
    exit "$EXIT_CONFLICT"
  fi
  read_meta_source
  local mtoken="" mjob=""
  if [ "$META_STATUS" = "complete" ]; then
    mtoken="$(meta_get_str token)"
    mjob="$(meta_get_str jobId)"
  fi
  # 记录回收前的残留，写进审计。
  scan_residuals "$ROOT" ""
  local initial=("${RES_PIDS[@]}")
  # 先按 meta 的 token/jobId 清理；没有 meta 时退化为按 root 清理。
  if [ -n "$mtoken" ] || [ -n "$mjob" ]; then
    cleanup_residuals "$mtoken" "$timeout" "$mjob"
  else
    cleanup_residuals "" "$timeout"
  fi
  # 全量复核：仍有残留就不能宣称回收成功。
  scan_residuals "$ROOT" ""
  if [ "${#RES_PIDS[@]}" -gt 0 ]; then
    printf '{"ok":false,"code":"residual","kind":"unknown","root":"%s","remainingPids":%s,"cleanedPids":%s,"hint":"仍有残留进程无法清理；解决后重试 force-reclaim。"}\n' \
      "$(json_escape "$ROOT")" "$(json_pid_array "${RES_PIDS[@]}")" \
      "$(json_pid_array "${CLEANED_PIDS[@]}")"
    unlock
    exit "$EXIT_RESIDUAL"
  fi
  local at entry
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # 审计里的 remainingPids 记录「回收前」的残留（即 initial），便于事后核对；
  # 成功返回时这些进程都已被清理。
  entry="$(printf '{"root":"%s","token":%s,"jobId":%s,"remainingPids":%s,"phrase":"%s","at":"%s"}' \
    "$(json_escape "$ROOT")" \
    "$([ -n "$mtoken" ] && printf '"%s"' "$(json_escape "$mtoken")" || printf 'null')" \
    "$([ -n "$mjob" ] && printf '"%s"' "$(json_escape "$mjob")" || printf 'null')" \
    "$(json_pid_array "${initial[@]}")" \
    "$(json_escape "$phrase")" "$(json_escape "$at")")"
  write_audit "$entry"
  remove_meta
  unlock
  printf '{"ok":true,"code":"ok","root":"%s","forceReclaimed":true,"cleanedPids":%s,"remainingPids":[],"audit":"%s"}\n' \
    "$(json_escape "$ROOT")" "$(json_pid_array "${CLEANED_PIDS[@]}")" "$(json_escape "$AUDIT")"
  exit "$EXIT_OK"
}

main() {
  [ $# -gt 0 ] || usage_error "缺少子命令（claim/mark/status/cleanup/clear/force-reclaim）"
  local command="$1"; shift
  case "$command" in
    claim) cmd_claim "$@" ;;
    mark) cmd_mark "$@" ;;
    status) cmd_status "$@" ;;
    cleanup) cmd_cleanup "$@" ;;
    clear) cmd_clear "$@" ;;
    force-reclaim) cmd_force_reclaim "$@" ;;
    *) usage_error "未知子命令：$command" ;;
  esac
}

main "$@"
