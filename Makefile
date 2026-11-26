# qubius 的统一命令行入口。需要 Node.js 22+；首次启动用 make quickstart 安装依赖。
#
# 所有目标都通过 node/npm 执行，不依赖 bash，Windows（cmd/PowerShell/Git Bash）、
# Linux 和 macOS 都能用。启动/部署在 Linux 上内部转给 deploy/*.sh（systemd、flock），
# Windows/macOS 上由 deploy/cli.mjs 用 Node 完成同样的步骤。
# npm 脚本（npm start / npm run quickstart / npm run dev:all）仍然保留。

.PHONY: help run dev quickstart build install start stop restart status pull \
	deploy deploy-lan deploy-wan test test-deploy

.DEFAULT_GOAL := help

help:
	@node -e "console.log(['用法：make <目标>','','开发：','  run / dev      启动服务端 + Vite 开发服务器','  quickstart     首次启动：选择 npm 源、配置/数据目录和端口','  build          构建 server + web','  test           服务端测试','  test-deploy    部署脚本测试','','运行：','  start          启动启用的实例（缺构建先构建）','  restart        重启启用的实例','  stop           停止实例和局域网入口','  status         显示配置目录、健康状态和局域网凭据文件','  install        Linux：渲染配置/systemd/logrotate 并构建','  pull           从 origin 快进当前 checkout','','部署：','  deploy         本地部署：构建并重启，只保证 127.0.0.1','  deploy-lan     本地部署 + 局域网入口（缺凭据时生成并打印一次）','  deploy-wan     局域网部署 + 公网入口（交互确认）','','npm 等方式仍然可用：npm start / npm run quickstart / npm run dev:all'].join('\n'))"

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
	npm test

test-deploy:
	npm run test:deploy

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
