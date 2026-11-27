#!/bin/bash
# 从远端快进拉取一个 checkout 的最新代码（部署任务在构建前调用）。
#
# 只做快进合并：工作区有未提交改动、当前分支与远端分叉、或远端不可用时
# 直接失败，绝不 reset --hard，也不动未跟踪/已修改的文件。
#
# 用法：deploy/pull-latest.sh <checkout-dir>
# 环境变量：
#   QUBIUS_PULL_REMOTE         显式指定远端名，默认按下面的规则选
#   QUBIUS_PULL_PREFER_GITHUB  1 时优先从 GitHub 远端拉取（部署页「更新并部署」）
#   QUBIUS_GITHUB_REPO         GitHub 镜像（owner/repo 或完整地址）；没有 github
#                              远端时，优先模式会直接从这个地址 fetch
set -euo pipefail

die() { printf 'pull-latest: %s\n' "$*" >&2; exit 1; }
info() { printf 'pull-latest: %s\n' "$*" >&2; }

DIR=${1:-}
[[ -n $DIR ]] || die "缺少 checkout 目录"
[[ -d $DIR ]] || die "目录不存在：$DIR"
command -v git >/dev/null 2>&1 || die "找不到 git"

# 无人值守时不要卡在用户名/密码提示上；私有仓库请提前配置凭据。
export GIT_TERMINAL_PROMPT=0

git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "不是 git 仓库：$DIR"

# 把 QUBIUS_GITHUB_REPO（owner/repo 或完整地址）转成 fetch 用的 URL。
github_repo_url() {
  local value=${1:-}
  [[ -n $value ]] || return 1
  if [[ $value =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    printf 'https://github.com/%s.git' "$value"
    return 0
  fi
  case $value in
    http://* | https://* | ssh://* | file://* | git@*) printf '%s' "$value"; return 0 ;;
  esac
  return 1
}

# 选择拉取源，输出 "<kind>\t<value>"：remote 表示远端名，url 表示 GitHub 镜像地址。
# 优先级：显式 QUBIUS_PULL_REMOTE > 名为 github 的远端 > origin 指向 github.com
# > 部署页配置的 QUBIUS_GITHUB_REPO > origin（常见于从私有仓库克隆）。
resolve_source() {
  local dir=$1 origin_url prefer=${QUBIUS_PULL_PREFER_GITHUB:-0} url
  if [[ -n ${QUBIUS_PULL_REMOTE:-} ]]; then
    printf 'remote\t%s' "$QUBIUS_PULL_REMOTE"
    return 0
  fi
  prefer=${prefer,,}
  case $prefer in
    1 | true | yes | on) ;;
    *) printf 'remote\torigin'; return 0 ;;
  esac
  if git -C "$dir" remote get-url github >/dev/null 2>&1; then
    printf 'remote\tgithub'
    return 0
  fi
  origin_url=$(git -C "$dir" remote get-url origin 2>/dev/null) || origin_url=""
  case $origin_url in
    *github.com[:/]*) printf 'remote\torigin'; return 0 ;;
  esac
  if url=$(github_repo_url "${QUBIUS_GITHUB_REPO:-}"); then
    printf 'url\t%s' "$url"
    return 0
  fi
  printf 'remote\torigin'
}

IFS=$'\t' read -r SOURCE_KIND SOURCE_VALUE <<<"$(resolve_source "$DIR")"
SOURCE_LABEL=$SOURCE_VALUE
if [[ $SOURCE_KIND == remote ]]; then
  [[ $SOURCE_VALUE =~ ^[A-Za-z0-9._/-]+$ && $SOURCE_VALUE != -* && $SOURCE_VALUE != *..* ]] \
    || die "远端名非法：$SOURCE_VALUE"
  git -C "$DIR" remote get-url "$SOURCE_VALUE" >/dev/null 2>&1 \
    || die "没有 $SOURCE_VALUE 远端，无法拉取：$DIR"
else
  [[ -n $SOURCE_VALUE ]] || die "QUBIUS_GITHUB_REPO 格式不正确"
  # 日志不打印完整 URL，避免带凭据的地址被写进部署日志。
  SOURCE_LABEL="GitHub 镜像"
fi

# 有未提交改动时合并可能产生冲突或半成品，直接中止让用户处理。
DIRTY=$(git -C "$DIR" status --porcelain 2>/dev/null) \
  || die "无法读取工作区状态：$DIR"
[[ -z $DIRTY ]] \
  || die "工作区有未提交改动，已取消拉取；请先提交或清理后重试：$DIR"

BRANCH=$(git -C "$DIR" symbolic-ref --quiet --short HEAD 2>/dev/null) \
  || die "处于 detached HEAD，无法确定要拉取的分支：$DIR"
[[ $BRANCH =~ ^[A-Za-z0-9._/-]+$ ]] \
  || die "当前分支名非法：$BRANCH"
# 前导 - 会被 git 当成选项；.. 可穿越层级。
[[ $BRANCH != -* && $BRANCH != *..* ]] || die "当前分支名非法：$BRANCH"

FROM=$(git -C "$DIR" rev-parse --verify HEAD 2>/dev/null) \
  || die "读不到当前提交：$DIR"

info "拉取 $SOURCE_LABEL/$BRANCH（$DIR）"
if ! git -C "$DIR" fetch --prune "$SOURCE_VALUE" "$BRANCH"; then
  die "拉取 $SOURCE_LABEL/$BRANCH 失败"
fi
TO=$(git -C "$DIR" rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null) \
  || die "读不到 $SOURCE_LABEL/$BRANCH 的最新提交"

if [[ $TO == "$FROM" ]]; then
  info "已经是最新：${FROM:0:8}（$BRANCH）"
  exit 0
fi

if ! git -C "$DIR" merge-base --is-ancestor "$FROM" "$TO"; then
  die "本地 $BRANCH（${FROM:0:8}）与 $SOURCE_LABEL/$BRANCH（${TO:0:8}）已分叉，请先在终端手动合并后再部署：$DIR"
fi

if ! git -C "$DIR" merge --ff-only "$TO"; then
  die "快进合并到 ${TO:0:8} 失败：$DIR"
fi
info "已更新：${FROM:0:8} -> ${TO:0:8}（$BRANCH）"
