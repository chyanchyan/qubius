#!/bin/bash
# 把 qubius（主实例）和 co-qubius（副实例）克隆到各自的 checkout 目录。
# 默认 dry-run；--apply 才执行 git clone。只克隆缺失目录，绝不覆盖已有目录，也不 push。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
  cat <<'EOF'
用法：deploy/clone-repos.sh [--apply]

把 qubius（主实例）和 co-qubius（副实例）克隆到
QUBIUS_PRIMARY_DIR / QUBIUS_SECONDARY_DIR。默认 dry-run，只打印计划；
--apply 才执行 git clone。目标目录已存在时跳过，绝不覆盖，也不 push。

选项：
  --apply       克隆缺失的 checkout
  -h, --help    显示本帮助

仓库地址（两个实例共用同一个仓库）：
  QUBIUS_PRIMARY_REPO_URL     默认 http://gitea.example.com/example/qubius.git
  QUBIUS_SECONDARY_REPO_URL   默认跟随 QUBIUS_PRIMARY_REPO_URL

私有仓库请先让 git 能认证（credential helper 或 SSH key）。不要把 token
拼进 URL，也不要提交任何凭据。
EOF
}

APPLY=0
for arg in "$@"; do
  case $arg in
    --apply) APPLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) qubius_die "未知参数：$arg（用 --help 查看用法）" ;;
  esac
done

qubius_load

LABELS=(qubius co-qubius)
DIRS=("$QUBIUS_PRIMARY_DIR" "$QUBIUS_SECONDARY_DIR")
URLS=("$QUBIUS_PRIMARY_REPO_URL" "$QUBIUS_SECONDARY_REPO_URL")

for i in "${!LABELS[@]}"; do
  [[ -n ${DIRS[$i]} ]] || qubius_die "${LABELS[$i]}：目标目录为空"
  [[ -n ${URLS[$i]} ]] || qubius_die "${LABELS[$i]}：仓库地址为空"
done

# 打印 URL 时抹掉可能存在的 user:password@ 部分。
qubius_redact_url() {
  local url=$1
  if [[ $url =~ ^(https?://)[^/@]+@(.+)$ ]]; then
    printf '%s***@%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  else
    printf '%s' "$url"
  fi
}

if ((APPLY == 0)); then
  qubius_info "clone-repos：dry-run，不会 clone"
  for i in "${!LABELS[@]}"; do
    label=${LABELS[$i]}
    dir=${DIRS[$i]}
    url=${URLS[$i]}
    if [[ -e $dir ]]; then
      qubius_info "$label：已存在 $dir，将跳过"
    else
      qubius_info "$label：将克隆 $(qubius_redact_url "$url") -> $dir"
    fi
  done
  qubius_info "加 --apply 执行克隆。脚本不会 push，也不会覆盖已有目录。"
  exit 0
fi

qubius_require_cmd git
# 无人值守时不要卡在用户名/密码提示上；私有仓库请提前配置 credential helper。
export GIT_TERMINAL_PROMPT=0

for i in "${!LABELS[@]}"; do
  label=${LABELS[$i]}
  dir=${DIRS[$i]}
  url=${URLS[$i]}
  if [[ -e $dir ]]; then
    qubius_info "$label：已存在 $dir，跳过（不覆盖）"
    continue
  fi

  parent=$(dirname "$dir")
  [[ -d $parent ]] || mkdir -p "$parent"

  qubius_info "$label：克隆 $(qubius_redact_url "$url") -> $dir"
  out=$(mktemp)
  rc=0
  clone_cmd=(git clone -- "$url" "$dir")
  if command -v timeout >/dev/null 2>&1; then
    clone_cmd=(timeout 900 "${clone_cmd[@]}")
  fi
  "${clone_cmd[@]}" >"$out" 2>&1 || rc=$?
  if ((rc != 0)); then
    msg=$(sed -E 's#(https?://)[^/@[:space:]]+@#\1***@#g' "$out" 2>/dev/null || true)
    rm -f "$out"
    qubius_die "$label：克隆失败。git 输出：
$msg
请检查网络、仓库地址和 git 凭据；不要把 token 写进 URL。若失败留下半成品目录，请手动检查后删除再重试。"
  fi
  rm -f "$out"
  qubius_info "$label：完成 $dir"
done

qubius_info "完成。脚本没有 push。后续：写 env、配置凭据，然后在每个 checkout 运行 ./deploy/install.sh。"
qubius_info "副实例安装时加环境变量：QUBIUS_SECONDARY=1 ./deploy/install.sh"
