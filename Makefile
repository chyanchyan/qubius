# 本地开发与部署快捷入口。需要 Node.js 22+；首次启动用 make quickstart 安装依赖。

.PHONY: run quickstart deploy deploy-lan deploy-wan

# 同时启动服务端（127.0.0.1:8787）和前端 Vite（127.0.0.1:5173，/api 代理到服务端）。
# 两条命令各放进独立进程组，Ctrl-C 或任一进程退出时整组停掉，避免 npm 的子进程残留。
# 进程管理写在 tools/dev.mjs 里，不依赖 bash，Windows（cmd.exe）和 POSIX 都能用。
run:
	node tools/dev.mjs

# 克隆后的首次启动：选择 npm 源和配置目录，执行 npm ci、npm run build、npm start。
# 同样不依赖 bash，Windows 和 POSIX 都能用。
quickstart:
	node deploy/quickstart.mjs

# ── 部署（Linux，复用 deploy/lib.sh 的 env 配置和两个实例）──────────────────
# 三个 target 按入口层级递进，细节见 deploy/deploy.sh 和 docs/deployment.md。
# 自动检测 systemd：unit 已接管时用 systemctl --user restart，否则走 start-all.sh。
deploy:
	bash deploy/deploy.sh local

# 本地部署 + 启动/重启局域网入口（lan-proxy）。
deploy-lan:
	bash deploy/deploy.sh lan

# 局域网部署 + 应用公网入口（edgectl）。交互确认；非交互环境加 QUBIUS_EDGE_YES=1。
deploy-wan:
	bash deploy/deploy.sh wan
