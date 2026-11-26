#!/bin/bash
# 从远端快进拉取一个 checkout 的最新代码（部署任务在构建前调用）。
#
# 只做快进合并：工作区有未提交改动、当前分支与远端分叉、或远端不可用时
# 直接失败，绝不 reset --hard，也不动未跟踪/已修改的文件。
#
# 用法：deploy/pull-latest.sh <checkout-dir>
# 环境变量：
#   QUBIUS_PULL_REMOTE  远端名，默认 origin
set -euo pipefail

die() { printf 'pull-latest: %s\n' "$*" >&2; exit 1; }
info() { printf 'pull-latest: %s\n' "$*" >&2; }

DIR=${1:-}
[[ -n $DIR ]] || die "缺少 checkout 目录"
[[ -d $DIR ]] || die "目录不存在：$DIR"
command -v git >/dev/null 2>&1 || die "找不到 git"

REMOTE=${QUBIUS_PULL_REMOTE:-origin}
[[ $REMOTE =~ ^[A-Za-z0-9._/-]+$ ]] || die "远端名非法：$REMOTE"

# 无人值守时不要卡在用户名/密码提示上；私有仓库请提前配置凭据。
export GIT_TERMINAL_PROMPT=0

git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "不是 git 仓库：$DIR"
git -C "$DIR" remote get-url "$REMOTE" >/dev/null 2>&1 \
  || die "没有 $REMOTE 远端，无法拉取：$DIR"

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

info "拉取 $REMOTE/$BRANCH（$DIR）"
if ! git -C "$DIR" fetch --prune "$REMOTE" "$BRANCH"; then
  die "拉取 $REMOTE/$BRANCH 失败"
fi
TO=$(git -C "$DIR" rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null) \
  || die "读不到 $REMOTE/$BRANCH 的最新提交"

if [[ $TO == "$FROM" ]]; then
  info "已经是最新：${FROM:0:8}（$BRANCH）"
  exit 0
fi

if ! git -C "$DIR" merge-base --is-ancestor "$FROM" "$TO"; then
  die "本地 $BRANCH（${FROM:0:8}）与 $REMOTE/$BRANCH（${TO:0:8}）已分叉，请先在终端手动合并后再部署：$DIR"
fi

if ! git -C "$DIR" merge --ff-only "$TO"; then
  die "快进合并到 ${TO:0:8} 失败：$DIR"
fi
info "已更新：${FROM:0:8} -> ${TO:0:8}（$BRANCH）"
