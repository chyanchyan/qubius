#!/bin/bash
# 启动服务器进程（主实例 qubius / 副实例 co-qubius）。
# 角色由唯一的 QUBIUS_SECONDARY 开关决定；数据目录、端口、配置、pidfile 都由
# deploy/lib.sh 的 qubius_load 派生。调用方负责把 stdout/stderr 重定向到
# $QUBIUS_DATA_DIR/qubius.log。
set -euo pipefail

# lib 的 qubius_repo_root 在目录不存在时会把 QUBIUS_REPO_DIR 解析成空串（cd 失败的
# 输出被吞掉）；先保存调用者传入的原路径，报错时用它，而不是报空路径。
REPO_HINT=${QUBIUS_REPO_DIR:-}

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
qubius_load

NODE_BIN=$(qubius_resolve_node)
export PATH="$(dirname "$NODE_BIN"):$PATH"

REPO=${QUBIUS_REPO_DIR:-$REPO_HINT}
DATA=$QUBIUS_DATA_DIR
PIDFILE=$DATA/qubius.pid

# 手工在仓库里启动（没跑 install、没有 config-secondary.yaml）时，退回仓库根目录的
# config.yaml，与 server/src/index.ts 的默认路径一致；标准安装的两种文件都存在，不受影响。
if [[ ! -f $QUBIUS_CONFIG_FILE && -f $REPO/config.yaml ]]; then
  echo "找不到 $QUBIUS_CONFIG_FILE，改用 $REPO/config.yaml" >&2
  QUBIUS_CONFIG_FILE=$REPO/config.yaml
fi

# server 读取 QUBIUS_CONFIG（旧名 REMOTE_CODER_CONFIG 仍兼容）；角色来自 config.yaml
# 的 role，这里导出 QUBIUS_SECONDARY 只是让子进程/排查时能识别当前开关。
export QUBIUS_CONFIG=$QUBIUS_CONFIG_FILE
export REMOTE_CODER_CONFIG=$QUBIUS_CONFIG_FILE
export QUBIUS_SECONDARY

[[ -n $REPO && -d $REPO ]] || qubius_die "仓库不存在：${REPO_HINT:-$REPO}"
[[ -f $REPO/server/dist/index.js ]] || {
  qubius_die "$REPO/server/dist/index.js 不存在，先运行 $REPO/deploy/build.sh"
}

mkdir -p "$DATA"
# 先写 pidfile 再 exec，exec 后 PID 不变，start-all 用它校验监听进程。
# exec 成功后 shell 被替换，trap 只覆盖 exec 失败；进程异常退出留下的陈旧
# pidfile 由 start-all 的 PID/cwd 校验兜底。
printf '%s\n' "$$" > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

cd "$REPO"
# 服务端用 QUBIUS_REPO_DIR 推导 <checkout>/.qubius 的默认配置/数据目录。
export QUBIUS_REPO_DIR=$REPO
exec "$NODE_BIN" server/dist/index.js
