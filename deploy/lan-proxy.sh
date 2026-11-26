#!/bin/bash
# 内网入口：Basic 认证 + 反向代理到只监听回环的服务器进程。
# 角色由 QUBIUS_SECONDARY 决定，监听端口和上游端口都取该角色的 QUBIUS_PORT。
# 默认同一来源 IP 认证失败 5 次锁定 5 分钟，可用 LAN_PROXY_MAX_FAILURES / LAN_PROXY_LOCK_MS 调整。
# Basic 凭据走明文 HTTP，只适合可信局域网；跨不可信网络请改用 TLS 或 SSH/VPN 隧道。
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
qubius_load
# env 文件里的普通赋值不会自动传给子进程，这里显式导出限速配置。
export LAN_PROXY_MAX_FAILURES LAN_PROXY_LOCK_MS

NODE_BIN=$(qubius_resolve_node)
export PATH="$(dirname "$NODE_BIN"):$PATH"

# 显式导出：start-all 也靠 QUBIUS_SECONDARY/QUBIUS_REPO_DIR 区分主/副实例的代理进程。
export QUBIUS_SECONDARY
export LAN_PROXY_PORT=$QUBIUS_PORT
export LAN_PROXY_UPSTREAM_PORT=$QUBIUS_PORT
if [[ -n ${QUBIUS_LAN_HOST:-} ]]; then
  export LAN_PROXY_HOST=$QUBIUS_LAN_HOST
fi
# 凭据文件默认放在配置目录；允许调用者用 LAN_PROXY_CREDENTIALS 覆盖。
export LAN_PROXY_CREDENTIALS=${LAN_PROXY_CREDENTIALS:-$QUBIUS_CONFIG_DIR/lan-proxy.credentials}

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# @reboot 时网络可能还没就绪，失败就重试，最多两分钟。
for _ in $(seq 1 60); do
  "$NODE_BIN" "$DIR/lan-proxy.mjs" && exit 0
  sleep 2
done
exit 1
