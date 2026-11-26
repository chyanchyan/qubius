#!/usr/bin/env bash
#
# Regenerate edge render golden files with the real edgectl (Python).
#
# This is a manual tool: it needs the edgectl checkout/venv (or uv). Tests do
# NOT run it; they compare the TypeScript renderer against the committed
# golden files byte-for-byte.
#
# Usage:
#   tools/regen-edge-fixtures.sh [--config PATH] [--force]
#
# Only the fixture registry is allowed by default; --config pointing elsewhere
# is refused unless --force is passed (the golden files are test fixtures).
#
# Env:
#   EDGECTL_PROJECT   edgectl checkout (default: $HOME/edgectl)
#   QUBIUS_EDGECTL_PYTHON  python executable to use (default: <project>/.venv/bin/python)
#
# The fixture .env supplies the dev secrets; process EDGECTL_DEV_* variables
# are unset so the render uses the fixture values.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
DEFAULT_CONFIG="$REPO_ROOT/server/src/edge/fixtures/registry/edgectl.yaml"
CONFIG="$DEFAULT_CONFIG"
GOLDEN_DIR="$REPO_ROOT/server/src/edge/fixtures/golden"
PROJECT="${EDGECTL_PROJECT:-$HOME/edgectl}"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[ -f "$CONFIG" ] || { echo "找不到配置：$CONFIG" >&2; exit 1; }

if [ "$FORCE" -eq 1 ]; then
  echo "警告：--force 已启用，将用 $CONFIG 覆盖测试 golden（非常规操作）。" >&2
fi

norm() { realpath -m -- "$1" 2>/dev/null || printf '%s\n' "$1"; }
if [ "$(norm "$CONFIG")" != "$(norm "$DEFAULT_CONFIG")" ] && [ "$FORCE" -ne 1 ]; then
  echo "拒绝用非 fixture 配置覆盖 golden：$CONFIG" >&2
  echo "这是测试夹具；确实要覆盖时加 --force。" >&2
  exit 1
fi

PYTHON="${QUBIUS_EDGECTL_PYTHON:-}"
if [ -z "$PYTHON" ] && [ -x "$PROJECT/.venv/bin/python" ]; then
  PYTHON="$PROJECT/.venv/bin/python"
fi

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

run_edgectl() {
  if [ -n "$PYTHON" ]; then
    env -u EDGECTL_DEV_PASSWORD_HASH -u EDGECTL_DEV_COOKIE_SECRET \
      "$PYTHON" -m edgectl render --config "$CONFIG" --output "$tmp"
    return
  fi
  if command -v uv >/dev/null 2>&1; then
    ( cd "$PROJECT" && env -u EDGECTL_DEV_PASSWORD_HASH -u EDGECTL_DEV_COOKIE_SECRET \
        uv run edgectl render --config "$CONFIG" --output "$tmp" )
    return
  fi
  echo "找不到 edgectl 运行环境：设置 QUBIUS_EDGECTL_PYTHON 或安装 uv（$PROJECT）" >&2
  exit 1
}

run_edgectl
mkdir -p -- "$GOLDEN_DIR"
cp -- "$tmp/vps.managed.Caddyfile" "$GOLDEN_DIR/vps.managed.Caddyfile"
cp -- "$tmp/local.Caddyfile" "$GOLDEN_DIR/local.Caddyfile"
chmod 0644 -- "$GOLDEN_DIR/vps.managed.Caddyfile" "$GOLDEN_DIR/local.Caddyfile"
echo "已更新：$GOLDEN_DIR/vps.managed.Caddyfile"
echo "已更新：$GOLDEN_DIR/local.Caddyfile"
