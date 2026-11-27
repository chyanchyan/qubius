# qubius 的统一命令行入口。需要 Node.js 22+；首次启动用 make quickstart 安装依赖。
#
# 所有目标都通过 node/npm 执行，不依赖 bash，Windows（cmd/PowerShell/Git Bash）、
# Linux 和 macOS 都能用。启动/部署在 Linux 上内部转给 deploy/*.sh（systemd、flock），
# Windows/macOS 上由 deploy/cli.mjs 用 Node 完成同样的步骤。
# Windows/macOS 的 start/restart/deploy/deploy-lan 默认在当前终端前台运行服务，
# Ctrl+C 或关窗口即停止；需要后台运行时设置 QUBIUS_BACKGROUND=1。
# npm 脚本（npm start / npm run quickstart / npm run dev:all）仍然保留。

.PHONY: help run dev quickstart build install start stop restart status pull \
	deploy deploy-lan deploy-wan test test-deploy backup restore

.DEFAULT_GOAL := help

# 恢复来源目录，用法：make restore BACKUP=<备份目录>
BACKUP ?=

help:
	@node deploy/cli.mjs help

# ── 开发 ────────────────────────────────────────────────────────────────────
# 同时启动服务端（127.0.0.1:8787）和前端 Vite（127.0.0.1:5173，/api 代理到服务端）。
# 进程管理写在 tools/dev.mjs 里，Windows 和 POSIX 都能用。
run:
	node tools/dev.mjs

dev: run

# 克隆后的首次启动：选择 npm 源、配置目录、数据目录和端口，执行 npm ci、npm run build、npm start。
quickstart:
	node deploy/quickstart.mjs

build:
	npm run build

test:
	npm run test:all

test-deploy:
	npm run test:deploy

# 备份/恢复配置与数据目录，脚本实现在 deploy/backup.mjs、deploy/restore.mjs。
backup:
	node deploy/backup.mjs

restore:
	node deploy/restore.mjs "$(BACKUP)"

# ── 运行与部署（跨平台入口）────────────────────────────────────────────────
# deploy/cli.mjs 在 Linux 上调用 deploy/*.sh；Windows/macOS 用 Node 启动/停止，
# 部署走 deploy/deploy-job.mjs。所有路径和开关都读 .qubius/env。
start:
	node deploy/cli.mjs start

restart:
	node deploy/cli.mjs restart

stop:
	node deploy/cli.mjs stop

status:
	node deploy/cli.mjs status

install:
	node deploy/cli.mjs install

pull:
	node deploy/cli.mjs pull

# 三个部署入口按层级递进，细节见 deploy/deploy.sh、deploy/cli.mjs 和 docs/deployment.md。
deploy:
	node deploy/cli.mjs deploy

# 本地部署 + 启动/重启局域网入口（lan-proxy）。缺 lan-proxy.credentials 时
# 自动生成并在终端打印用户名/密码（前端部署页也会一次性展示）。
deploy-lan:
	node deploy/cli.mjs deploy-lan

# 局域网部署 + 应用公网入口。交互确认；非交互环境加 QUBIUS_EDGE_YES=1。
deploy-wan:
	node deploy/cli.mjs deploy-wan
