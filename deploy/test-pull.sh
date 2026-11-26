#!/bin/bash
# deploy/pull-latest.sh 的行为测试：只快进、不动本地历史、异常时明确失败。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# 隔离 git 配置，避免受真实用户设置影响。
export HOME="$TMP/home"
export GIT_CONFIG_NOSYSTEM=1
mkdir -p "$HOME"
git config --global user.email test@example.com
git config --global user.name test
git config --global init.defaultBranch main

PULL="$HERE/pull-latest.sh"
ORIGIN="$TMP/origin.git"
SEED="$TMP/seed"
WORK="$TMP/work"

git init --quiet --bare "$ORIGIN"
git init --quiet "$SEED"
(
  cd "$SEED"
  echo one >file.txt
  git add file.txt
  git commit -qm one
  git remote add origin "$ORIGIN"
  git push -q origin main
)
git clone --quiet "$ORIGIN" "$WORK"

# 1. 已是最新：成功且 HEAD 不变。
"$PULL" "$WORK" >/dev/null 2>&1 || fail "已是最新时应成功"
[[ $(git -C "$WORK" rev-parse HEAD) == "$(git -C "$SEED" rev-parse HEAD)" ]] \
  || fail "已是最新时 HEAD 不应变化"

# 2. 远端有新提交：快进并更新工作区。
(
  cd "$SEED"
  echo two >file.txt
  git commit -qam two
  git push -q origin main
)
"$PULL" "$WORK" >/dev/null 2>&1 || fail "有新提交时应快进成功"
[[ $(git -C "$WORK" rev-parse HEAD) == "$(git -C "$SEED" rev-parse HEAD)" ]] \
  || fail "未快进到远端 HEAD"
[[ $(cat "$WORK/file.txt") == two ]] || fail "工作区内容未更新"

# 3. 工作区有未提交改动：拒绝拉取。
echo dirty >"$WORK/file.txt"
if "$PULL" "$WORK" >/dev/null 2>&1; then fail "工作区有改动时必须失败"; fi
git -C "$WORK" checkout -- file.txt

# 4. 本地与远端分叉：失败且不改动本地 HEAD。
(
  cd "$WORK"
  echo local >local.txt
  git add local.txt
  git commit -qm local
)
LOCAL_HEAD=$(git -C "$WORK" rev-parse HEAD)
(
  cd "$SEED"
  echo three >other.txt
  git add other.txt
  git commit -qm three
  git push -q origin main
)
if "$PULL" "$WORK" >/dev/null 2>&1; then fail "分叉时必须失败"; fi
[[ $(git -C "$WORK" rev-parse HEAD) == "$LOCAL_HEAD" ]] || fail "分叉时不能改动本地 HEAD"

# 5. detached HEAD：无法确定分支，拒绝。
git -C "$WORK" checkout -q --detach
if "$PULL" "$WORK" >/dev/null 2>&1; then fail "detached HEAD 必须失败"; fi
git -C "$WORK" checkout -q main

# 6. 没有 origin 远端：拒绝。
PLAIN="$TMP/plain"
git init --quiet "$PLAIN"
(
  cd "$PLAIN"
  echo x >x.txt
  git add x.txt
  git commit -qm x
)
if "$PULL" "$PLAIN" >/dev/null 2>&1; then fail "没有 origin 时必须失败"; fi

echo "deploy/pull-latest.sh 测试通过"
