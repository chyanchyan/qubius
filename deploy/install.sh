#!/bin/bash
# qubius 安装器：从当前 checkout 安装这个实例（主 qubius 或副 co-qubius）。
#
# 安装内容：
#   - $QUBIUS_CONFIG_DIR/env（仅在缺失时从 deploy/env.example 复制，0600）
#   - $QUBIUS_CONFIG_FILE（已存在时不覆盖；内容有差异时备份为 *.bak.<时间戳>；
#     加 --force-config 时用本次渲染结果覆盖，旧文件同样备份）
#   - $QUBIUS_CONFIG_DIR/systemd/ 下两个 unit（只生成，不安装、不启用）
#   - $QUBIUS_CONFIG_DIR/logrotate.d/qubius（只生成，不安装）
#   - 主实例可选维护一条 crontab @reboot 行（systemd 已接管时跳过）
#
# 用法：
#   ./deploy/install.sh                 # 安装当前角色，不重启
#   ./deploy/install.sh --restart       # 安装后重启（无 systemd 时交给 start-all.sh）
#   ./deploy/install.sh --clone-peer    # 另一个 checkout 缺失时 git clone
#   ./deploy/install.sh --no-build      # 不调用 build.sh
#   ./deploy/install.sh --force-config  # 用本次渲染结果覆盖已存在且内容不同的配置
#   QUBIUS_SECONDARY=1 ./deploy/install.sh   # 安装副实例 co-qubius
set -euo pipefail
export GIT_TERMINAL_PROMPT=0

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/.." && pwd)

RESTART=0
BUILD=1
CLONE_PEER=0
FORCE_CONFIG=0

usage() {
  cat <<EOF
用法：$0 [选项]

  --restart      安装完成后重启服务（无 systemd 时调用 <repo>/deploy/start-all.sh --restart）
  --no-restart   安装后不重启（默认）
  --no-build     不调用 <repo>/deploy/build.sh
  --clone-peer   另一个实例的 checkout 不存在时，用对应的仓库 URL git clone
  --force-config 已存在的配置文件内容不同时，用本次渲染结果覆盖（旧文件备份为 *.bak.<时间戳>）
  -h, --help     显示本帮助

角色由 QUBIUS_SECONDARY 控制：0 = 主实例 qubius，1 = 副实例 co-qubius。
env 变量（QUBIUS_*）来自 \${QUBIUS_CONFIG_DIR:-<checkout>/.qubius}/env 或显式导出的环境变量。
测试时可设 QUBIUS_SKIP_CRONTAB=1 避免修改真实 crontab。
EOF
}

for arg in "$@"; do
  case $arg in
    --restart) RESTART=1 ;;
    --no-restart) RESTART=0 ;;
    --no-build) BUILD=0 ;;
    --clone-peer) CLONE_PEER=1 ;;
    --force-config) FORCE_CONFIG=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# shellcheck source=deploy/lib.sh
source "$HERE/lib.sh"

# 从当前 checkout 安装：即使 env 文件里写了 QUBIUS_REPO_DIR，也不用它覆盖当前目录。
export QUBIUS_REPO_DIR=$REPO
qubius_load

# 手工执行时参与部署页同一把 ops lock；被 deploy-job 调用时已有 token，自动跳过。
# 必须在 clone/build/start-all 和 deploy.lock 之前取得，保持 ops.lock -> deploy.lock 的顺序。
qubius_ops_claim deploy

TS=$(date +%Y%m%d-%H%M%S)
ACTIVE_ENV_FILE=''

yaml_quote() {
  local s=$1
  s=${s//\'/\'\'}
  printf "'%s'" "$s"
}

redact_url() {
  printf '%s\n' "$1" | sed -E 's#(://)[^/@]+@#\1***@#'
}

# 用项目依赖的 yaml 模块校验渲染结果；依赖不可用时跳过，不阻塞安装。
validate_config_yaml() {
  local file=$1
  "$NODE_BIN" -e '
    const fs = require("fs");
    let yaml;
    try {
      const { createRequire } = require("node:module");
      yaml = createRequire(process.argv[2] + "/package.json")("yaml");
    } catch {
      console.error("qubius: 跳过 YAML 校验（yaml 模块不可用）");
      process.exit(0);
    }
    try {
      const doc = yaml.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        throw new Error("顶层必须是映射");
      }
    } catch (error) {
      console.error("qubius: 配置不是合法 YAML：" + error.message);
      process.exit(1);
    }
  ' "$file" "$QUBIUS_REPO_DIR"
}

# QUBIUS_PROJECTS_FILE 直接挂在 projects: 下。只接受：空白行、注释行、
# 恰好 "  - " 开头的顶层条目、恰好 4 空格后接非空格的续行；出错时打印行号。
validate_projects_file() {
  local file=$1
  awk -v file="$file" '
    {
      line = $0
      if (index(line, "\t") > 0) {
        printf "qubius: %s 第 %d 行包含制表符；只允许空格缩进：%s\n", file, NR, line > "/dev/stderr"
        bad = 1
        next
      }
      if (line ~ /^[[:space:]]*$/) next
      if (line ~ /^[[:space:]]*#/) next
      if (line ~ /^  - /) next
      if (line ~ /^    [^ ]/) next
      printf "qubius: %s 第 %d 行缩进不合法（只允许空行、注释、两个空格加短横的顶层条目、四空格续行）：%s\n", file, NR, line > "/dev/stderr"
      bad = 1
    }
    END { exit bad ? 1 : 0 }
  ' "$file"
}

# ── 写操作前的校验 ──────────────────────────────────────────────────────────
[[ -d $QUBIUS_REPO_DIR ]] || qubius_die "仓库目录不存在：$QUBIUS_REPO_DIR"
git -C "$QUBIUS_REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || qubius_die "请在 qubius 的 git checkout 里运行：$QUBIUS_REPO_DIR 不是 git 仓库"
qubius_require_cmd git
NODE_BIN=$(qubius_resolve_node)
export PATH="$(dirname "$NODE_BIN"):$PATH"

[[ -f $HERE/env.example ]] || qubius_die "缺少 env 模板：$HERE/env.example"
[[ -f $HERE/templates/config.yaml.in ]] || qubius_die "缺少配置模板：$HERE/templates/config.yaml.in"
[[ -f $HERE/templates/systemd.service.in ]] || qubius_die "缺少 systemd 模板：$HERE/templates/systemd.service.in"
[[ -f $HERE/templates/logrotate.in ]] || qubius_die "缺少 logrotate 模板：$HERE/templates/logrotate.in"

if [[ -n ${QUBIUS_PROJECTS_FILE:-} ]]; then
  [[ -f $QUBIUS_PROJECTS_FILE ]] \
    || qubius_die "QUBIUS_PROJECTS_FILE 不存在：$QUBIUS_PROJECTS_FILE"
  # 内容直接挂在 projects: 下，必须与内置条目一致：顶层 "- id:" 恰好两空格缩进，
  # name/path 等续行恰好四空格。这里只做缩进预检；字段和 schema 由 YAML 兜底
  # 校验与 server 启动校验负责（首次安装且 yaml 模块不可用时兜底校验会跳过）。
  if ! validate_projects_file "$QUBIUS_PROJECTS_FILE"; then
    qubius_die "QUBIUS_PROJECTS_FILE 校验失败：$QUBIUS_PROJECTS_FILE"
  fi
fi

# 与 server/src/config.ts 的范围校验保持一致，避免渲染出服务拒绝的配置。
[[ $QUBIUS_MAX_CONCURRENT =~ ^[0-9]+$ ]] \
  || qubius_die "QUBIUS_MAX_CONCURRENT 必须是整数：$QUBIUS_MAX_CONCURRENT"
(( QUBIUS_MAX_CONCURRENT >= 1 && QUBIUS_MAX_CONCURRENT <= 256 )) \
  || qubius_die "QUBIUS_MAX_CONCURRENT 必须在 1 到 256 之间：$QUBIUS_MAX_CONCURRENT"
[[ $QUBIUS_ARCHIVE_RETENTION_DAYS =~ ^[0-9]+$ ]] \
  || qubius_die "QUBIUS_ARCHIVE_RETENTION_DAYS 必须是整数：$QUBIUS_ARCHIVE_RETENTION_DAYS"
(( QUBIUS_ARCHIVE_RETENTION_DAYS >= 1 && QUBIUS_ARCHIVE_RETENTION_DAYS <= 3650 )) \
  || qubius_die "QUBIUS_ARCHIVE_RETENTION_DAYS 必须在 1 到 3650 之间：$QUBIUS_ARCHIVE_RETENTION_DAYS"

# 当前角色的期望 origin 和另一个实例的 clone URL。
if [[ $QUBIUS_SECONDARY == 1 ]]; then
  EXPECTED_REPO_URL=$QUBIUS_SECONDARY_REPO_URL
  PEER_REPO_URL=$QUBIUS_PRIMARY_REPO_URL
else
  EXPECTED_REPO_URL=$QUBIUS_PRIMARY_REPO_URL
  PEER_REPO_URL=$QUBIUS_SECONDARY_REPO_URL
fi

# legacy 迁移提示：旧版 remote-code/remote-coder 的配置目录不再读取。
LEGACY_CONFIG_DIR=${XDG_CONFIG_HOME:-${QUBIUS_HOME:-$HOME}/.config}/remote-coder
if [[ -d $LEGACY_CONFIG_DIR ]]; then
  qubius_warn "检测到 legacy 配置目录 $LEGACY_CONFIG_DIR（旧版 remote-coder 命名）；qubius 不再读取，请按需手动迁移。"
fi

# ── 目录 ────────────────────────────────────────────────────────────────────
for dir in "$QUBIUS_CONFIG_DIR" "$QUBIUS_DATA_PRIMARY" "$QUBIUS_DATA_SECONDARY" \
  "$QUBIUS_CONFIG_DIR/systemd" "$QUBIUS_CONFIG_DIR/logrotate.d"; do
  mkdir -p "$dir" || qubius_die "无法创建目录：$dir"
done

# 与 start-all.sh 共用同一把锁。clone 和 build 都会改 checkout，必须和
# start-all.sh 串行化；只有真正调用 start-all.sh --restart 前才释放。
HAVE_FLOCK=0
if command -v flock >/dev/null 2>&1; then
  HAVE_FLOCK=1
  exec 9>"$QUBIUS_DEPLOY_LOCK" || qubius_die "无法写入部署锁：$QUBIUS_DEPLOY_LOCK"
  flock -w 600 9 \
    || qubius_die "等待部署锁超时：$QUBIUS_DEPLOY_LOCK 被其他任务占用"
fi

release_lock() {
  if (( HAVE_FLOCK )); then
    flock -u 9 2>/dev/null || true
    exec 9>&- || true
  fi
}

# ── 可选：克隆另一个实例的 checkout（在部署锁内）───────────────────────────
if (( CLONE_PEER )) || [[ ${QUBIUS_CLONE_PEER:-0} == 1 ]]; then
  if [[ ! -e $QUBIUS_PEER_DIR ]]; then
    [[ -n $PEER_REPO_URL ]] \
      || qubius_die "对端仓库 URL 为空，无法克隆 $QUBIUS_PEER_ROLE；请设置对应的 QUBIUS_*_REPO_URL"
    mkdir -p "$(dirname "$QUBIUS_PEER_DIR")" \
      || qubius_die "无法创建父目录：$(dirname "$QUBIUS_PEER_DIR")"
    qubius_info "克隆 $QUBIUS_PEER_ROLE 仓库：$PEER_REPO_URL -> $QUBIUS_PEER_DIR"
    git clone "$PEER_REPO_URL" "$QUBIUS_PEER_DIR" \
      || qubius_die "克隆失败：$PEER_REPO_URL"
  else
    qubius_info "对端 checkout 已存在，跳过克隆：$QUBIUS_PEER_DIR"
  fi
fi

# ── env 文件 ────────────────────────────────────────────────────────────────
# 用 lib 的优先级判断是否已有 env 来源（QUBIUS_ENV → config/env → repo deploy/env），
# 避免再生成机器级 env 遮蔽仓库级配置。
ACTIVE_ENV_FILE=$(qubius_env_file)
if [[ -n $ACTIVE_ENV_FILE ]]; then
  qubius_info "使用现有 env：$ACTIVE_ENV_FILE，跳过 env 安装"
else
  install -m 600 "$HERE/env.example" "$QUBIUS_CONFIG_DIR/env" \
    || qubius_die "无法安装 env 文件：$QUBIUS_CONFIG_DIR/env"
  ACTIVE_ENV_FILE=$QUBIUS_CONFIG_DIR/env
  qubius_info "已安装 env：$ACTIVE_ENV_FILE（请按需编辑，脚本不会覆盖已有文件）"
fi

# ── origin 校验（只警告，不自动修改）─────────────────────────────────────────
ACTUAL_REPO_URL=$(git -C "$QUBIUS_REPO_DIR" remote get-url origin 2>/dev/null || true)
if [[ -z $ACTUAL_REPO_URL ]]; then
  qubius_warn "当前 checkout 没有 origin remote；$QUBIUS_ROLE 实例期望 $EXPECTED_REPO_URL"
elif [[ $ACTUAL_REPO_URL != "$EXPECTED_REPO_URL" ]]; then
  qubius_warn "origin 与 $QUBIUS_ROLE 实例期望的仓库 URL 不一致："
  qubius_warn "  实际：$(redact_url "$ACTUAL_REPO_URL")"
  qubius_warn "  期望：$(redact_url "$EXPECTED_REPO_URL")"
  qubius_warn "  如需修正，请按 env 里的 QUBIUS_*_REPO_URL 执行 git remote set-url origin <URL>"
fi

# ── 生成 config.yaml ────────────────────────────────────────────────────────
# 条件块用 bash 构造，再交给 qubius_render 做 {{VAR}} 替换（不依赖 envsubst）。
if [[ $QUBIUS_SECONDARY == 1 ]]; then
  PEER_PROJECT_ID=qubius
  PEER_PROJECT_NAME=qubius
  PEER_ENABLED=$QUBIUS_START_PRIMARY
  ARCHIVE_INSTANCE=bak
else
  PEER_PROJECT_ID=co-qubius
  PEER_PROJECT_NAME=co-qubius
  PEER_ENABLED=$QUBIUS_START_SECONDARY
  ARCHIVE_INSTANCE=main
fi

QUBIUS_CFG_DATA_DIR=$(yaml_quote "$QUBIUS_DATA_DIR")
QUBIUS_CFG_PUBLIC_HOST=$(yaml_quote "$QUBIUS_PUBLIC_HOST_ACTIVE")
export QUBIUS_CFG_DATA_DIR QUBIUS_CFG_PUBLIC_HOST

if [[ $QUBIUS_SECONDARY == 1 ]]; then
  QUBIUS_CFG_SECONDARY_BLOCK=$(printf 'secondary:\n  primaryRepo: %s\n  primaryRef: %s\n  script: %s\n  restart: %s\n' \
    "$(yaml_quote "$QUBIUS_PRIMARY_DIR")" \
    "$(yaml_quote "$QUBIUS_PRIMARY_REF")" \
    "$(yaml_quote "$QUBIUS_REPO_DIR/deploy/secondary.sh")" \
    "$(yaml_quote "$QUBIUS_REPO_DIR/deploy/run.sh")")
else
  QUBIUS_CFG_SECONDARY_BLOCK=''
fi
export QUBIUS_CFG_SECONDARY_BLOCK

if [[ -n ${QUBIUS_ARCHIVE_DIR:-} ]]; then
  QUBIUS_CFG_ARCHIVE_BLOCK=$(printf 'archive:\n  dir: %s\n  retentionDays: %s\n  instance: %s\n' \
    "$(yaml_quote "$QUBIUS_ARCHIVE_DIR")" "$QUBIUS_ARCHIVE_RETENTION_DAYS" "$ARCHIVE_INSTANCE")
else
  QUBIUS_CFG_ARCHIVE_BLOCK=''
fi
export QUBIUS_CFG_ARCHIVE_BLOCK

# 对端实例未启用（QUBIUS_START_* 为 0）时不把它的项目写进配置，
# 否则项目列表里会出现一个根本不会运行的实例。
QUBIUS_CFG_PROJECTS_BLOCK=$(
  if [[ $PEER_ENABLED == 1 ]]; then
    printf '  - id: %s\n' "$PEER_PROJECT_ID"
    printf '    name: %s\n' "$PEER_PROJECT_NAME"
    printf '    path: %s\n' "$(yaml_quote "$QUBIUS_PEER_DIR")"
  fi
  if [[ -n ${QUBIUS_PROJECTS_FILE:-} ]]; then
    cat "$QUBIUS_PROJECTS_FILE"
  fi
)
if [[ -n $QUBIUS_CFG_PROJECTS_BLOCK ]]; then
  QUBIUS_CFG_PROJECTS_SECTION=$(printf 'projects:\n%s' "$QUBIUS_CFG_PROJECTS_BLOCK")
else
  QUBIUS_CFG_PROJECTS_SECTION=''
fi
export QUBIUS_CFG_PROJECTS_SECTION

TMP_CONFIG=$(mktemp "$QUBIUS_CONFIG_DIR/.config.XXXXXX") \
  || qubius_die "无法创建临时文件：$QUBIUS_CONFIG_DIR"
if ! qubius_render "$HERE/templates/config.yaml.in" "$TMP_CONFIG"; then
  rm -f "$TMP_CONFIG"
  qubius_die "渲染配置失败：$HERE/templates/config.yaml.in"
fi
if ! validate_config_yaml "$TMP_CONFIG"; then
  rm -f "$TMP_CONFIG"
  qubius_die "生成的配置不是合法 YAML；未写入配置（如有旧配置则保持不变）：$QUBIUS_CONFIG_FILE"
fi

if [[ -e $QUBIUS_CONFIG_FILE ]]; then
  if cmp -s "$TMP_CONFIG" "$QUBIUS_CONFIG_FILE"; then
    qubius_info "保留现有配置 $QUBIUS_CONFIG_FILE（与本次渲染一致）"
  else
    CONFIG_BAK="$QUBIUS_CONFIG_FILE.bak.$TS"
    # 同一秒内多次覆盖时避免复用（覆盖）更早的备份。
    if [[ -e $CONFIG_BAK ]]; then
      n=1
      while [[ -e "$QUBIUS_CONFIG_FILE.bak.$TS-$n" ]]; do
        n=$((n + 1))
      done
      CONFIG_BAK="$QUBIUS_CONFIG_FILE.bak.$TS-$n"
    fi
    cp -p "$QUBIUS_CONFIG_FILE" "$CONFIG_BAK" \
      || qubius_die "无法备份配置：$CONFIG_BAK"
    if (( FORCE_CONFIG )); then
      install -m 644 "$TMP_CONFIG" "$QUBIUS_CONFIG_FILE" \
        || qubius_die "无法写入配置：$QUBIUS_CONFIG_FILE"
      qubius_info "已按 --force-config 覆盖配置（旧文件备份到 $CONFIG_BAK）：$QUBIUS_CONFIG_FILE"
    else
      qubius_info "保留现有配置 $QUBIUS_CONFIG_FILE；差异已备份到 $CONFIG_BAK"
    fi
  fi
  rm -f "$TMP_CONFIG"
else
  install -m 644 "$TMP_CONFIG" "$QUBIUS_CONFIG_FILE" \
    || qubius_die "无法写入配置：$QUBIUS_CONFIG_FILE"
  rm -f "$TMP_CONFIG"
  qubius_info "写入配置 $QUBIUS_CONFIG_FILE"
fi

# ── systemd unit（只生成，不安装）───────────────────────────────────────────
# systemd 会对 unit 文件里的 % 做 specifier 展开（%z 甚至会让 unit 加载失败）；
# 路径等原样插入的值先转成 %%，生成的文件里才是字面量 %。
systemd_escape() {
  local s=$1
  printf '%s' "${s//%/%%}"
}

export QUBIUS_UNIT_WORKDIR=$(systemd_escape "$QUBIUS_REPO_DIR")
export QUBIUS_UNIT_CONFIG_DIR=$(systemd_escape "$QUBIUS_CONFIG_DIR")
if [[ $QUBIUS_SECONDARY == 1 ]]; then
  INSTANCE_DESCRIPTION="co-qubius 副实例（127.0.0.1:$QUBIUS_PORT）"
  PROXY_DESCRIPTION="co-qubius LAN 入口"
  # 副实例维护脚本由服务器 spawn；KillMode=process 避免 stop 时 SIGKILL sync/rollback。
  INSTANCE_KILLMODE=process
else
  INSTANCE_DESCRIPTION="qubius 主实例（127.0.0.1:$QUBIUS_PORT）"
  PROXY_DESCRIPTION="qubius LAN 入口"
  INSTANCE_KILLMODE=mixed
fi
PROXY_KILLMODE=mixed

QUBIUS_UNIT_DESCRIPTION=$(systemd_escape "$INSTANCE_DESCRIPTION")
QUBIUS_UNIT_EXEC=$(systemd_escape "$QUBIUS_REPO_DIR/deploy/run.sh")
QUBIUS_UNIT_KILLMODE=$INSTANCE_KILLMODE
export QUBIUS_UNIT_DESCRIPTION QUBIUS_UNIT_EXEC QUBIUS_UNIT_KILLMODE
qubius_render "$HERE/templates/systemd.service.in" "$QUBIUS_CONFIG_DIR/systemd/$QUBIUS_SERVICE" \
  || qubius_die "渲染 systemd unit 失败：$QUBIUS_SERVICE"

QUBIUS_UNIT_DESCRIPTION=$(systemd_escape "$PROXY_DESCRIPTION")
QUBIUS_UNIT_EXEC=$(systemd_escape "$QUBIUS_REPO_DIR/deploy/lan-proxy.sh")
QUBIUS_UNIT_KILLMODE=$PROXY_KILLMODE
export QUBIUS_UNIT_DESCRIPTION QUBIUS_UNIT_EXEC QUBIUS_UNIT_KILLMODE
qubius_render "$HERE/templates/systemd.service.in" "$QUBIUS_CONFIG_DIR/systemd/$QUBIUS_PROXY_SERVICE" \
  || qubius_die "渲染 systemd unit 失败：$QUBIUS_PROXY_SERVICE"

# ── logrotate（只生成，不安装）──────────────────────────────────────────────
qubius_render "$HERE/templates/logrotate.in" "$QUBIUS_CONFIG_DIR/logrotate.d/qubius" \
  || qubius_die "渲染 logrotate 配置失败"

# ── systemd 接管检测 ────────────────────────────────────────────────────────
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
unit_enabled() {
  local unit=$1 link
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user is-enabled "$unit" >/dev/null 2>&1 && return 0
  fi
  # 没有用户总线时（例如 @reboot）用符号链接兜底；指向 /dev/null 表示 masked。
  if [[ -L $UNIT_DIR/$unit && $(readlink "$UNIT_DIR/$unit") == /dev/null ]]; then
    return 1
  fi
  for link in "$UNIT_DIR"/*.wants/"$unit"; do
    [[ -e $link ]] && return 0
  done
  return 1
}

unit_active() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$1" >/dev/null 2>&1
}

unit_managed() {
  unit_enabled "$1" || unit_active "$1"
}

any_unit_enabled() {
  local unit
  for unit in qubius.service co-qubius.service qubius-proxy.service co-qubius-proxy.service; do
    unit_managed "$unit" && return 0
  done
  return 1
}

# 与 start-all.sh 一致：检查全部四个 unit。当前角色只启用一个、或其它角色
# 的 unit 已接管时都要明确提示，否则 crontab 会被静默跳过。
warn_if_partial_units() {
  local unit current=0 other=()
  for unit in qubius.service co-qubius.service qubius-proxy.service co-qubius-proxy.service; do
    unit_managed "$unit" || continue
    case $unit in
      "$QUBIUS_SERVICE" | "$QUBIUS_PROXY_SERVICE") current=$((current + 1)) ;;
      *) other+=("$unit") ;;
    esac
  done
  if (( current == 1 )); then
    qubius_warn "只启用了当前角色的一个 systemd unit；请同时启用 $QUBIUS_SERVICE 和 $QUBIUS_PROXY_SERVICE，避免只启动实例或只启动 LAN 入口。"
  fi
  # 这条只和主实例的 crontab 有关；副实例或显式跳过 crontab 时不要误导。
  if [[ $QUBIUS_ROLE == primary && ${QUBIUS_SKIP_CRONTAB:-0} != 1 ]] \
    && (( current < 2 && ${#other[@]} > 0 )); then
    qubius_warn "检测到其它角色的 systemd unit 已启用/运行中（${other[*]}）；crontab 由 systemd 管理，本次不写 @reboot。"
  fi
}

warn_if_partial_units

# ── crontab（仅主实例维护；systemd 已接管时不写）─────────────────────────────
manage_crontab() {
  if [[ ${QUBIUS_SKIP_CRONTAB:-0} == 1 ]]; then
    qubius_info "跳过 crontab（QUBIUS_SKIP_CRONTAB=1）"
    return 0
  fi
  if [[ $QUBIUS_ROLE != primary ]]; then
    qubius_info "副实例不维护 crontab；@reboot 由主实例负责"
    return 0
  fi
  if ! command -v crontab >/dev/null 2>&1; then
    qubius_warn "找不到 crontab，跳过 @reboot 安装"
    return 0
  fi

  local raw tmp err
  raw=$(mktemp) || qubius_die "无法创建临时文件用于 crontab"
  tmp=$(mktemp) || {
    rm -f "$raw"
    qubius_die "无法创建临时文件用于 crontab"
  }
  err=$(mktemp) || {
    rm -f "$raw" "$tmp"
    qubius_die "无法创建临时文件用于 crontab"
  }

  # 只有明确的 "no crontab" 才当作空；其他读取失败必须中止，避免用空内容覆盖用户 crontab。
  if crontab -l >"$raw" 2>"$err"; then
    :
  elif grep -qi 'no crontab' "$err"; then
    : >"$raw"
  else
    qubius_warn "读取 crontab 失败，未修改现有 crontab："
    cat "$err" >&2 || true
    rm -f "$raw" "$tmp" "$err"
    qubius_die "中止安装：无法读取 crontab"
  fi

  if ! awk -v main="$QUBIUS_PRIMARY_DIR" '
    {
      line = $0
      # legacy 迁移：只删除锚定旧配置目录/旧 checkout 的 deploy 脚本行，避免误伤用户其他 cron。
      if (line ~ /@reboot/ && (line ~ /\/\.config\/remote-coder\// || line ~ /\/remote-code(-bak)?\/deploy\//)) next
      if (line ~ /\/\.config\/remote-coder\/(run|lan-proxy|watchdog|start-all|build)/) next
      # 删除本项目重复的 start-all.sh 行，稍后只写一条。
      if (index(line, main "/deploy/start-all.sh") > 0) next
      print line
    }' "$raw" >"$tmp"; then
    rm -f "$raw" "$tmp" "$err"
    qubius_die "过滤 crontab 失败，未修改现有 crontab"
  fi

  if any_unit_enabled; then
    qubius_info "检测到 systemd unit 已启用或运行中：不写 crontab，旧 @reboot 行已清理"
  else
    printf '@reboot %s/deploy/start-all.sh >> %s/start-all.log 2>&1\n' \
      "$QUBIUS_PRIMARY_DIR" "$QUBIUS_DATA_PRIMARY" >>"$tmp"
    qubius_info "crontab：保留用户其他行，写入一条 @reboot start-all.sh"
  fi

  crontab "$tmp" || {
    rm -f "$raw" "$tmp" "$err"
    qubius_die "写入 crontab 失败，现有 crontab 未被替换"
  }
  rm -f "$raw" "$tmp" "$err"
}

manage_crontab

# ── 构建（仍在部署锁内）─────────────────────────────────────────────────────
listening() {
  local port=$1
  command -v ss >/dev/null 2>&1 || return 1
  ss -H -ltn "sport = :$port" 2>/dev/null | grep -q "127.0.0.1:$port"
}

health_ok() {
  local port=$1
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/api/health" 2>/dev/null
}

any_running() {
  # 只看当前角色：安装副实例时不应因为主实例在跑而跳过自己的构建。
  health_ok "$QUBIUS_PORT" || listening "$QUBIUS_PORT"
}

if (( ! BUILD )); then
  qubius_info "跳过构建（--no-build）"
elif (( RESTART )); then
  # 依赖安装和构建由 start-all.sh 统一处理（需要重装依赖时会先停实例）。
  qubius_info "构建/安装交给 start-all（--restart）"
elif any_running; then
  qubius_info "检测到实例正在运行且未指定 --restart：跳过构建（避免前后端版本错配）"
  qubius_info "需要应用代码改动请运行：$0 --restart"
else
  [[ -x "$QUBIUS_REPO_DIR/deploy/build.sh" ]] \
    || qubius_die "缺少构建脚本：$QUBIUS_REPO_DIR/deploy/build.sh"
  qubius_info "构建：$QUBIUS_REPO_DIR"
  "$QUBIUS_REPO_DIR/deploy/build.sh" "$QUBIUS_REPO_DIR"
fi

# clone 和 build 都已完成；调用 start-all.sh --restart 前必须释放锁。
release_lock

# ── systemd 手工步骤 ────────────────────────────────────────────────────────
print_systemd_steps() {
  local unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
  echo "systemd unit 已生成（未自动安装）："
  echo "  $QUBIUS_CONFIG_DIR/systemd/$QUBIUS_SERVICE"
  echo "  $QUBIUS_CONFIG_DIR/systemd/$QUBIUS_PROXY_SERVICE"
  echo "安装或更新："
  echo "  mkdir -p $unit_dir"
  echo "  install -m 644 $QUBIUS_CONFIG_DIR/systemd/$QUBIUS_SERVICE $unit_dir/"
  echo "  install -m 644 $QUBIUS_CONFIG_DIR/systemd/$QUBIUS_PROXY_SERVICE $unit_dir/"
  echo "  loginctl enable-linger $QUBIUS_USER"
  echo "  $QUBIUS_REPO_DIR/deploy/build.sh $QUBIUS_REPO_DIR"
  echo "  systemctl --user daemon-reload"
  if any_unit_enabled; then
    echo "  systemctl --user restart $QUBIUS_SERVICE $QUBIUS_PROXY_SERVICE"
  else
    echo "  systemctl --user enable --now $QUBIUS_SERVICE $QUBIUS_PROXY_SERVICE"
  fi
}

if (( RESTART )); then
  if any_unit_enabled; then
    echo "检测到 systemd 已接管，不调用 start-all.sh；请手工应用：" >&2
    print_systemd_steps
  else
    [[ -x "$QUBIUS_REPO_DIR/deploy/start-all.sh" ]] \
      || qubius_die "缺少启动脚本：$QUBIUS_REPO_DIR/deploy/start-all.sh"
    qubius_info "执行 $QUBIUS_REPO_DIR/deploy/start-all.sh --restart"
    "$QUBIUS_REPO_DIR/deploy/start-all.sh" --restart
  fi
else
  qubius_info "安装完成：默认不重启服务。"
  if any_unit_enabled; then
    print_systemd_steps
  else
    qubius_info "需要应用新配置时运行：$QUBIUS_REPO_DIR/deploy/start-all.sh --restart"
  fi
fi

# ── 结果摘要 ────────────────────────────────────────────────────────────────
HEALTH_URL="http://127.0.0.1:$QUBIUS_PORT/api/health"
cat <<EOF

实例：$QUBIUS_INSTANCE（$QUBIUS_ROLE）
配置文件：$QUBIUS_CONFIG_FILE
数据目录：$QUBIUS_DATA_DIR
env 文件：$ACTIVE_ENV_FILE

systemd unit（未自动安装）：
  $QUBIUS_CONFIG_DIR/systemd/$QUBIUS_SERVICE
  $QUBIUS_CONFIG_DIR/systemd/$QUBIUS_PROXY_SERVICE
  mkdir -p ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
  install -m 644 $QUBIUS_CONFIG_DIR/systemd/$QUBIUS_SERVICE ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/
  install -m 644 $QUBIUS_CONFIG_DIR/systemd/$QUBIUS_PROXY_SERVICE ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now $QUBIUS_SERVICE $QUBIUS_PROXY_SERVICE

logrotate（未自动安装）：
  sudo install -m 644 $QUBIUS_CONFIG_DIR/logrotate.d/qubius /etc/logrotate.d/qubius
  sudo logrotate -d /etc/logrotate.d/qubius

公网 edgectl 片段：
- name: $QUBIUS_INSTANCE
  domains: [$QUBIUS_PUBLIC_HOST_ACTIVE]
  upstream: http://127.0.0.1:$QUBIUS_PORT
  auth: dev
  sse: true

也可以打开部署页的「公网入口」由页面生成并应用（依赖 QUBIUS_EDGECTL_CONFIG 或 EDGECTL_CONFIG、需可用 edgectl（或 Phase C native））。

健康检查：$HEALTH_URL
EOF

if command -v curl >/dev/null 2>&1; then
  if health_body=$(curl -fsS -m 3 "$HEALTH_URL" 2>/dev/null); then
    echo "健康检查结果：$health_body"
  else
    echo "健康检查结果：未响应（服务未启动，或安装时未加 --restart）"
  fi
else
  echo "健康检查结果：未安装 curl，无法探测"
fi
