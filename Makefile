# 本地开发快捷入口。需要 Node.js 22+；首次启动用 make quickstart 安装依赖。

.PHONY: run quickstart

# 同时启动服务端（127.0.0.1:8787）和前端 Vite（127.0.0.1:5173，/api 代理到服务端）。
# 两条命令各放进独立进程组，Ctrl-C 或任一进程退出时整组停掉，避免 npm 的子进程残留。
# 进程管理写在 tools/dev.mjs 里，不依赖 bash，Windows（cmd.exe）和 POSIX 都能用。
run:
	node tools/dev.mjs

# 克隆后的首次启动：选择 npm 源和配置目录，执行 npm ci、npm run build、npm start。
# 同样不依赖 bash，Windows 和 POSIX 都能用。
quickstart:
	node deploy/quickstart.mjs
