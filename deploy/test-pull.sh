#!/bin/bash
# deploy/pull-latest.sh 的行为测试：只快进、不动本地历史、异常时明确失败。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 宿主环境可能带着真实部署用的 QUBIUS_*；这些用例只测默认/显式行为。
unset QUBIUS_PULL_REMOTE QUBIUS_PULL_PREFER_GITHUB

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

# 7. QUBIUS_PULL_PREFER_GITHUB=1：有 github 远端时优先从它拉取。
ORIGIN2="$TMP/origin2.git"
GITHUB2="$TMP/github2.git"
SEED2="$TMP/seed2"
WORK2="$TMP/work2"
git init --quiet --bare "$ORIGIN2"
git init --quiet --bare "$GITHUB2"
git init --quiet "$SEED2"
(
  cd "$SEED2"
  echo one >file.txt
  git add file.txt
  git commit -qm one
  git remote add origin "$ORIGIN2"
  git remote add github "$GITHUB2"
  git push -q origin main
  git push -q github main
)
git clone --quiet "$ORIGIN2" "$WORK2"
git -C "$WORK2" remote add github "$GITHUB2"
(
  cd "$SEED2"
  echo from-github >gh.txt
  git add gh.txt
  git commit -qm github-only
  git push -q github main
)
QUBIUS_PULL_PREFER_GITHUB=1 "$PULL" "$WORK2" >/dev/null 2>&1 \
  || fail "prefer github 时应从 github 远端快进成功"
[[ $(cat "$WORK2/gh.txt" 2>/dev/null) == from-github ]] || fail "没有从 github 远端拉取"
[[ $(git -C "$ORIGIN2" rev-parse main) != $(git -C "$WORK2" rev-parse HEAD) ]] \
  || fail "prefer github 时不应拉取 origin"

# 8. prefer github 但没有 github 远端：回落到 origin。
ORIGIN3="$TMP/origin3.git"
SEED3="$TMP/seed3"
WORK3="$TMP/work3"
git init --quiet --bare "$ORIGIN3"
git init --quiet "$SEED3"
(
  cd "$SEED3"
  echo one >file.txt
  git add file.txt
  git commit -qm one
  git remote add origin "$ORIGIN3"
  git push -q origin main
)
git clone --quiet "$ORIGIN3" "$WORK3"
(
  cd "$SEED3"
  echo two >file.txt
  git commit -qam two
  git push -q origin main
)
QUBIUS_PULL_PREFER_GITHUB=1 "$PULL" "$WORK3" >/dev/null 2>&1 \
  || fail "没有 github 远端时应回落到 origin"
[[ $(cat "$WORK3/file.txt") == two ]] || fail "回落 origin 后工作区未更新"

# 9. prefer github、没有 github 远端、配置了 QUBIUS_GITHUB_REPO：直接从该地址拉取。
ORIGIN4="$TMP/origin4.git"
MIRROR4="$TMP/mirror4.git"
SEED4="$TMP/seed4"
WORK4="$TMP/work4"
git init --quiet --bare "$ORIGIN4"
git init --quiet --bare "$MIRROR4"
git init --quiet "$SEED4"
(
  cd "$SEED4"
  echo one >file.txt
  git add file.txt
  git commit -qm one
  git remote add origin "$ORIGIN4"
  git remote add mirror "$MIRROR4"
  git push -q origin main
  git push -q mirror main
)
git clone --quiet "$ORIGIN4" "$WORK4"
(
  cd "$SEED4"
  echo from-mirror >mirror.txt
  git add mirror.txt
  git commit -qm mirror-only
  git push -q mirror main
)
QUBIUS_PULL_PREFER_GITHUB=1 QUBIUS_GITHUB_REPO="file://$MIRROR4" \
  "$PULL" "$WORK4" >/dev/null 2>&1 \
  || fail "配置 QUBIUS_GITHUB_REPO 后应从该地址快进成功"
[[ $(cat "$WORK4/mirror.txt" 2>/dev/null) == from-mirror ]] || fail "没有从配置的 GitHub 地址拉取"

# 10. QUBIUS_GITHUB_REPO 无法识别时回落到 origin。
ORIGIN5="$TMP/origin5.git"
SEED5="$TMP/seed5"
WORK5="$TMP/work5"
git init --quiet --bare "$ORIGIN5"
git init --quiet "$SEED5"
(
  cd "$SEED5"
  echo one >file.txt
  git add file.txt
  git commit -qm one
  git remote add origin "$ORIGIN5"
  git push -q origin main
)
git clone --quiet "$ORIGIN5" "$WORK5"
(
  cd "$SEED5"
  echo two >file.txt
  git commit -qam two
  git push -q origin main
)
QUBIUS_PULL_PREFER_GITHUB=1 QUBIUS_GITHUB_REPO="not-a-repo" \
  "$PULL" "$WORK5" >/dev/null 2>&1 \
  || fail "无效的 QUBIUS_GITHUB_REPO 应回落到 origin"
[[ $(cat "$WORK5/file.txt") == two ]] || fail "回落到 origin 后工作区未更新"

echo "deploy/pull-latest.sh 测试通过"
