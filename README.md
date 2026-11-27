# qubius

qubius 是一个自托管的 Claude Agent 网页控制台。它运行在你自己的开发机上，你可以在浏览器里（包括手机）同时开多个编码对话，查看每个对话和子 agent 的进度，回答 agent 的提问和授权请求，再把结果提交到 git。

代码、对话记录和 API key 都只留在开发机上。qubius 只监听 `127.0.0.1`，需要远程访问时，由你自己的 SSH 隧道或反向代理负责加密和认证。

> **先读这一句：** qubius 会让 AI agent 以运行服务的系统用户身份读写文件、执行命令，「命令行」页面还能直接打开一个完整的 shell。能访问 qubius 页面的人，就等于能控制这台机器。请先看完 [安全须知](#安全须知) 再部署。

## 功能

- **并行对话**：多个项目、多个对话同时运行，超出并发上限的自动排队。每个对话基于 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)，主 agent 可以把子任务交给并行的子 agent。
- **排队消息**：对话运行中发送的消息排进输入框上方的队列，可以逐条「现在发送」、编辑或删除；`Ctrl+Enter`（macOS 上 `Cmd+Enter`）插话，触摸端长按发送按钮等同插话。
- **每个对话一个 git worktree**：git 项目的每个对话都在独立的 worktree 和分支（`qubius/<对话 id>`）里工作，互不干扰；页面上可以直接查看改动、提交和推送。
- **worktree 自动准备**：git 项目可以配置 setup 命令、共享目录（例如 `node_modules`）和要复制进新 worktree 的 `.env` 等文件；仓库根也可以放 `.worktreeinclude`。新建、分叉和归档恢复时自动准备，失败就清理掉半成品 worktree。
- **行级 Diff 评论**：在「Diff」面板的任意改动行上留评论，标记解决后一次性把未解决意见发给 agent 修改。
- **PR / MR 与检查**：本机已登录 `gh` / `glab` 时，可以直接从 Git 面板创建 GitHub PR 或 GitLab MR，查看检查和合并状态，监视变化，并把失败检查交给 agent 处理。
- **多模型并行对比**：同一个 prompt 可以选多个接口/模型；git 项目各开一个独立 worktree，非 git/isolated 项目各开一个独立目录，对比状态、成本和改动后再决定保留哪个。
- **CLI 与 MCP**：`node tools/qubius.mjs` 可以在脚本里创建对话、发消息、等待结果；`node tools/qubius-mcp.mjs` 把 qubius 作为 MCP server 暴露给其他 agent。
- **消息回滚与分叉**：每条用户消息的「⋯」菜单可以回滚到它之前（可同时按检查点恢复 agent 用编辑工具改过的文件）、编辑后重新发送，或分叉出一个保留这条消息及之前内容的新对话；git 项目分叉时会新建独立 worktree 和分支。
- **状态一目了然**：排队、进行中、等待确认、本轮完成、失败、已停止。「总览」页按状态汇总所有项目的对话，等待确认的问题可以直接在列表里回答。
- **多套模型接口**：在设置页保存多套 Anthropic 兼容或 Gemini 接口，每个对话可以随时切换接口、模型和 effort（`low` 到 `max`）。
- **工作流**：除普通模式外，内置 `prl`（并行开发加评审）、`ser`（串行开发加评审）和 `plan`（只出计划）三种工作流，并显示各单元的进度。
- **后台任务**：agent 在后台运行的下载、安装等耗时命令会显示进度和输出，可以随时停止。
- **附件与语音**：可以粘贴图片、附加文本文件；iPhone Safari 上可以按住麦克风说话输入。
- **定时任务**：按固定间隔自动新建对话执行同一个 prompt。
- **命令行**：在浏览器里打开开发机的交互式 shell（真实 PTY）。
- **技能管理**：查看、编辑、启用或停用磁盘上的 Claude Code 技能。
- **用量与成本**：按接口和对话统计 token；填写单价后可以估算成本。
- **手机推送**：页面是 PWA，对话完成、失败或等待确认时可以给手机发系统通知。
- **归档**：可以把旧对话冷备份到另一块磁盘，校验通过后再从本机删除，之后也能恢复。

## 工作原理

```text
浏览器（电脑 / 手机）
    │  HTTPS + 认证（由 SSH 隧道或你的反向代理提供）
    ▼
qubius 服务  127.0.0.1:8787
    │
    ▼
Claude Agent SDK ──► 每个对话一个 git worktree（或独立目录）
```

服务端是 Node.js（TypeScript），前端是 React + Vite。对话、密钥和 worktree 都存放在 `dataDir` 目录里。

## 安全须知

- **它不是沙箱。** 默认的项目权限 `acceptEdits` 会自动放行工作区内的编辑和大多数 Bash 命令。是否放行靠的是命令文本的启发式判断：`npm run ...`、`make ...`、`sh script.sh`、`curl -d @.env ...` 这类命令会直接执行，agent 也可以先改 `package.json` 或 `Makefile` 再执行。只要仓库内容、网页或依赖里藏着提示词注入，就可能在当前用户权限下执行任意代码或外传数据。启发式判断有边界：`find -exec sh -c`、`awk 'BEGIN{system()}'`、`tsx`/`npx`、`make -f`/`make -C`、`git -C <other> commit` 等更复杂的写法仍可能被放行；husky、git-lfs 等 hook 也可能让 commit/push 每次都触发确认。
- **处理不可信内容时：** 把项目权限改成 `default`（每条命令都要确认），并用专用的系统用户或容器运行 qubius。不要在这个用户下放 SSH key、云凭据或浏览器 cookie。
- **不要把端口直接暴露到公网。** qubius 只监听回环地址，Host 白名单默认也只允许本机访问。远程访问请通过 SSH 隧道，或者带 HTTPS 和认证的反向代理（见 [远程访问](#远程访问)）。
- **多用户机器或通过代理访问时，开启访问令牌**（`QUBIUS_AUTH=1`，见下文）。它能挡住其他本地用户和配置失误导致的暴露。
- **用不到浏览器命令行就关掉它**（`terminal: false` 或 `QUBIUS_TERMINAL=0`）。
- **API key 不要写进仓库文件。** 在页面「设置」里填写，它会保存在 `dataDir/secrets.json`（权限 `0600`），接口只返回「是否已配置」，不会回显 key。
- **worktree 准备内容来自仓库和你自己的配置。** `.worktreeinclude` 由仓库控制，可能把主检出里被 gitignore 的 `.env` 等文件复制进 agent 的工作区；`worktree.setup` 会在新 worktree 里执行命令。只对可信仓库使用这些配置。

## 快速开始

### 环境要求

- Node.js 22 或更高版本，以及 git。
- `python3`、`make` 和 C++ 编译器（`g++` 或 `clang++`）：`npm install` 需要用它们编译「命令行」功能使用的原生模块 `node-pty`（Windows 上如果没有预编译包，需要 Visual Studio Build Tools）。
- 一个 Anthropic API key、兼容 Anthropic API 的接口地址和 key，或者 Gemini API key。
- 可选：`gh`（GitHub PR）或 `glab`（GitLab MR），并在这台机器上登录。未安装时只影响 PR/MR 面板，其他功能不受影响。

Linux 的部署脚本面向 bash 和 systemd。Windows 不需要 bash/systemd：部署页会用 Node 脚本（`deploy/deploy-job.mjs`）生成配置、构建并重启服务，见 [Windows 图形化部署](#windows-图形化部署)。本地开发用的 `npm run dev:all` 两个平台都能运行。

### 一键启动

克隆仓库后直接运行：

```bash
npm run quickstart
```

它会先让你选择 npm 源（npm 官方源、npmmirror/淘宝、腾讯云、华为云，也可以直接粘贴自定义地址）、可选的配置目录和监听端口，然后依次执行 `npm ci`、`npm run build`、`npm start`。构建完成后打开 `http://127.0.0.1:<端口>`（默认 8787），首次运行会进入部署向导。服务只监听 `127.0.0.1`，对外暴露由反向代理或 SSH 隧道负责。Windows 和 Linux/macOS 都适用。

不想交互时也可以直接指定：

```bash
npm run quickstart -- --registry 2 --config-dir /path/to/qubius-config
npm run quickstart -- --port 8790
npm run quickstart -- --dry-run   # 只打印将要执行的命令
npm run quickstart -- --verbose   # 输出 npm 安装/构建的详细日志，并实时显示依赖安装脚本输出
npm run quickstart -- --loglevel=silly   # 最详细的 npm 日志（silent 则尽量安静）
```

默认情况下 `npm ci` 只显示最终结果（npm 的 `notice` 级别），不会逐条列出下载和安装的包；需要排查安装问题时用 `--verbose`。

默认端口是 8787（副实例 8788）。端口被占用时，quickstart 会在安装依赖前列出占用进程的 PID 和命令，并让你选择：停止占用进程（需二次确认；Windows 上会强制结束）、换一个空闲端口，或退出；也可以用 `--port` 直接指定。已有配置文件时以配置里的 `listen` 为准。

npm 源的选择只影响这次安装；想长期使用某个镜像，可以执行 `npm config set registry <地址>`。

### 安装和启动

以下是手动安装流程（开发或需要自己控制每一步时使用）：

```bash
git clone <仓库地址> qubius
cd qubius
npm install
cp config.example.yaml config.yaml
```

编辑 `config.yaml`，在 `projects` 里列出允许 agent 工作的目录（见 [配置](#配置)）。然后启动开发模式：

```bash
make run          # 或 npm run dev:all（没有 make 时，例如 Windows）
```

浏览器打开 `http://127.0.0.1:5173`，进入「设置」，填写接口地址、API key 和模型名，然后在项目页输入第一条消息。

没有 `config.yaml` 时，页面会进入分步部署向导：先选使用方式（仅本机、远程访问或主副双实例），再确认 checkout、数据目录和端口，最后确认并部署。向导会预填当前运行的 checkout 和检测到的仓库地址；需要完整参数时随时可以切换到「完整部署表单」。

已经有配置时，部署页顶部有「重新部署」按钮，可以从向导第一步重新确认使用方式、目录和端口；当前配置会预填到向导里，确认后才会重新构建并重启。

没有 API key 时，可以用假 agent 先看看界面（不会调用模型）：

```bash
QUBIUS_FAKE_AGENT=1 npm run dev:all
```

### 长期运行

```bash
npm ci
npm run build
npm start         # 服务和页面都在 http://127.0.0.1:8787
```

配置、env、数据和日志默认都在当前 checkout 的 `.qubius/` 里（已 gitignore）；服务读取 `.qubius/config.yaml`，仓库根有旧 `config.yaml` 时优先沿用。也可以用 `--config <路径>` 或环境变量 `QUBIUS_CONFIG` 指定其他位置。如果需要开机自启、日志轮转和双实例互备，参见 [双实例部署与运维](docs/deployment.md)。

### 命令行入口（make，跨平台）

`make` 是统一的启动/部署入口，内部通过 Node 执行：Linux 转给 `deploy/*.sh`（systemd、flock、双实例），Windows/macOS 由 `deploy/cli.mjs` 用 Node 完成同样的启动/停止，部署走 `deploy/deploy-job.mjs`。npm 脚本（`npm start`、`npm run quickstart`、`npm run dev:all`）仍然保留。

Windows/macOS 上 `make start`、`make restart`、`make deploy`、`make deploy-lan` 默认在**当前终端前台**运行服务：日志直接打在窗口里，Ctrl+C 或关闭窗口即停止。确需后台运行时设置 `QUBIUS_BACKGROUND=1`（CI、重定向输出等没有 TTY 的场景会自动使用后台）。`make deploy-wan` 需要在部署任务返回后应用公网入口，仍按后台方式启动；Linux 的 systemd 管理不受影响。

```bash
make              # 列出全部目标
make quickstart   # 首次启动：npm 源、配置/数据目录、端口
make run          # 开发模式：服务端 + Vite
make build        # 构建 server + web
make start        # 启动启用的实例（缺构建先构建；无变化只做健康校验）
make restart      # 强制重启（即使无变化也用新进程替换）
make stop         # 停止实例和局域网入口
make status       # 显示配置路径、健康状态、局域网凭据文件

make deploy       # 本地：构建并重启，只保证 127.0.0.1 可访问
make deploy-lan   # 局域网：再启动/重启 lan-proxy（缺凭据时生成并打印一次）
make deploy-wan   # 公网：再应用 edgectl 公网入口（交互确认）
```

默认部署当前 checkout，配置和数据都在它的 `.qubius/` 里；需要双实例、非默认端口或自定义路径时，在 `/deploy` 页面或 `deploy/env` 里配置。检测到 systemd user unit 已接管时用 `systemctl --user restart`，否则交给 `deploy/start-all.sh --restart`。`make deploy` 不会停止已经运行的局域网/公网入口；非交互环境应用公网入口时加 `QUBIUS_EDGE_YES=1`。

部署不会静默打断正在工作的会话：停止/重启前会检查 `/api/health` 的 `activeSessions`，有会话时 Linux 交互终端会询问等待/强制/取消，页面部署和其它非交互环境直接失败（退出码 3）。部署页在忙碌中止后直接提供「强制重启」按钮，也可以随时点「强制重启」忽略「无变化」判定；只作用于本次部署，不需要修改环境变量。命令行环境下设 `QUBIUS_DEPLOY_FORCE=1` 强制重启，或设 `QUBIUS_DEPLOY_WAIT=<秒>` 等待空闲；构建产物、git HEAD、config 和 env 都没有变化时会跳过构建和重启，需要无变化也重启时设 `QUBIUS_DEPLOY_RESTART=1`。这三个开关也可以写进 env 文件，细节见[部署文档](docs/deployment.md#忙碌保护不静默打断正在工作的会话)。

构建使用 staging + 原子切换：先写到 `server/dist.next`、`web/dist.next`，成功后才切换为 live（旧产物留在 `dist.prev`）。因此构建期间旧服务继续可用，构建或启动失败会回滚到旧产物；安装过依赖时还会保留 `node_modules.prev`。成功部署后磁盘上会同时保留一份旧产物用于回滚，下次成功部署/安装时再清理，细节见[构建 staging、原子切换与回滚](docs/deployment.md#构建-staging原子切换与回滚)。

### Windows 图形化部署

Windows 上没有 bash/systemd 时，`/deploy` 页面由 `deploy/deploy-job.mjs` 完成部署：生成 `config.yaml`、按需 `npm ci` 并 staging 构建、停掉旧进程、原子切换产物、按新配置启动，并用 `/api/health` 校验；启动失败会回滚到旧产物。点「保存并部署」会打开一个新的终端窗口执行任务：是否停止当前实例在页面上确认（手机远程部署也能操作），终端窗口只在端口被其他进程占用时询问是否强制停止；构建完成后服务在该窗口前台运行，关闭窗口或按 Ctrl+C 即停止。需要 Node.js 22+ 和 git 在 PATH 里，也可以在页面「Node 路径」里填 `node.exe` 的绝对路径。

1. 在仓库目录运行 `npm run quickstart`（可选择 npm 源、配置目录和数据目录，默认都在当前 checkout 的 `.qubius/`），或手动运行 `npm ci && npm run build && npm start`。没有 `config.yaml` 时服务也会启动，并进入首次部署模式。
2. 打开 `http://127.0.0.1:8787/deploy`。首次运行会进入部署向导，按步骤确认使用方式、Checkout 路径、数据目录和端口；只在本机使用时访问域名保持 `localhost` 即可。需要完整参数时可以切到「完整部署表单」。
3. 点「保存并部署」。会打开新终端窗口执行部署：停止当前实例前先在页面上确认，端口被其他进程占用时在窗口里询问；成功后服务在该窗口前台运行，页面在切换产物时短暂断开，服务就绪后自动恢复。任务日志同时打到窗口和 `<配置目录>\deploy.log`，实例日志在 `<数据目录>\qubius.log`，pid 写在 `<数据目录>\qubius.pid`。

向导在 Windows 上会使用盘符路径的占位符，并提示不需要 bash/systemd。「主副双实例」可以在同一台机器运行两个 checkout，但副实例的同步/回滚按钮和公网入口仍不可用；开机自启仍要靠「任务计划程序」。

Windows 和 Linux/macOS 的默认目录一致：配置、env、数据和日志都在当前 checkout 的 `.qubius/` 里（`config.yaml`、`env`、`data/`），整个目录已 gitignore；可以用 env 里的 `QUBIUS_CONFIG_DIR`、`QUBIUS_DATA_PRIMARY` 等覆盖。页面部署成功后服务在前台终端窗口里运行；窗口关掉后要重新启动，直接 `npm start` 即可，它会自动读取 `.qubius/` 里生成的配置和 env；副实例要加 `QUBIUS_SECONDARY=1`。

需要局域网 Basic 认证入口时，在部署页勾选「启用局域网入口」，填用户名、密码留空即可自动生成；部署成功后会一次性显示访问地址、用户名、登录密码和 API 访问令牌（关闭后不再显示）。凭据写在配置目录的 `lan-proxy.credentials`（`user:password`，`0600`），部署任务会顺带启动 `deploy/lan-proxy.mjs`。命令行用 `make deploy-lan`：缺少凭据时自动生成并在终端打印一次。

部署页每个字段旁都有问号提示，悬停或聚焦可查看详细说明。局域网密码和访问令牌都支持在页面上重置：密码立即写盘，运行中的局域网入口会在响应后自动重启；令牌立即生效，旧令牌保留 60 秒宽限，不需要重启服务。重置结果会一次性弹出并显示重启/生效说明，提供复制图标。

Windows 上也可以用上面的 make 目标（`make start/stop/restart/status/deploy/deploy-lan`）：Makefile 只调用 Node，`start/stop` 由 `deploy/cli.mjs` 通过 pidfile 管理进程，部署走 `deploy/deploy-job.mjs`。`start` / `restart` / `deploy` / `deploy-lan` 默认在当前终端前台运行服务，关闭窗口或 Ctrl+C 即停止；要后台运行设置 `QUBIUS_BACKGROUND=1`。`npm start` 仍然可用。

Windows 部署**不做**这些事：安装 systemd/logrotate/crontab、公网入口（edge）、副实例的「同步主功能/回滚」、开机自启。需要开机自启时，用「任务计划程序」登记 `node server\dist\index.js`（工作目录设为仓库根目录）。

## 配置

配置只有两个入口：首次运行的 `npm run quickstart`（选择 npm 源、配置目录、数据目录和端口），以及启动后的 `/deploy` 部署向导（访问域名、访问令牌、归档、终端、并发/超时等全部参数）。两者默认都写入当前 checkout 的 `.qubius/`，这个目录已 gitignore；不需要手工同时维护 `config.yaml` 和 env 两份。

`config.yaml` 的常用字段如下，完整说明见 [参考手册](docs/reference.md#配置)：

```yaml
listen: 127.0.0.1:8787        # 只能是 127.0.0.1 或 localhost
dataDir: ./data               # 相对 .qubius/ 解析；会话、worktree、密钥都放在这里
maxConcurrent: 4              # 同时进行的对话数初始值，之后可在设置页修改

# 通过域名或局域网地址访问时，必须在这里列出实际主机名
# allowedHosts: [127.0.0.1, localhost, "[::1]", code.example.com]

projects:
  - id: my-app
    name: My App
    path: /home/me/src/my-app
    permission: default        # default / acceptEdits / plan / auto / bypassPermissions
```

- **`projects`** 是白名单，页面不能提交白名单以外的路径。运行中也可以在主页的「管理项目」里添加或删除跟踪的 git 仓库，或者填仓库名称和母目录直接新建一个 git 仓库，都不需要重启。另外始终有一个内置的「普通对话」项目，目录在 `<dataDir>/chat`。
- **`permission`** 决定 agent 的操作要不要确认：`default` 表示改动和命令都要确认；`acceptEdits`（默认值）表示工作区内自动放行；`plan` 只做规划；`auto` 由模型判断，拿不准时再确认；`bypassPermissions` 全部放行，不建议使用。页面上也可以修改。
- **`allowedHosts`** 不配置时只允许 `127.0.0.1`、`localhost` 和 `[::1]`，用来防御 DNS rebinding 攻击。通过反向代理或局域网访问时，要把实际的主机名加进来；部署页的「公网域名」由模板写进 `config.yaml`，「额外允许的访问域名」写进 env 的 `QUBIUS_ALLOWED_HOSTS`，启动时合并，重新部署不会丢。部署页「当前环境」里能看到实际生效的完整列表。
- **`limits`**、访问令牌、归档、终端开关、并发上限和确认超时都出现在部署页的完整表单里，由向导写入 env；其中并发上限、确认超时、会话/请求上限（「高级限制」折叠区）和归档保留天数只作为首次启动默认值，之后在页面「设置」里修改，保存后立即生效、不需要重新部署。
- 非 git 目录可以设置 `isolated: true`，这样每个对话会在 `<path>/<对话 id>` 子目录里运行。

### 访问令牌

在部署向导里把「访问令牌」设为「自动生成」（或 env 里 `QUBIUS_AUTH=1`）后，首次启动会生成令牌，保存在 `dataDir/auth-token`，默认就是 `.qubius/data/auth-token`：

```bash
cat .qubius/data/auth-token
curl -H "X-Qubius-Token: $(cat .qubius/data/auth-token)" http://127.0.0.1:8787/api/settings
```

浏览器第一次收到 401 时会弹出输入框，并直接显示令牌文件路径；登录后到 `/deploy` 的「当前环境」点「显示当前访问令牌」即可复制。你也可以用 `QUBIUS_AUTH_TOKEN` 直接指定一个令牌（至少 16 个字符）。`/api/health` 不需要令牌。

### 模型接口

在页面「设置」里可以保存多套接口，每套包括名称、类型、地址、API key 和若干模型名。类型有两种：

- **Anthropic 兼容**：地址会作为 `ANTHROPIC_BASE_URL` 传给 Agent SDK，所以兼容 Anthropic API 的代理或网关也能使用。
- **Gemini**：直接填 Gemini API key 和模型名（例如 `gemini-2.5-pro`、`gemini-2.5-flash`）。qubius 在本机把 Anthropic Messages 请求翻译成 Gemini 原生 `generateContent`，不需要额外的兼容网关；地址一般保持默认的 `https://generativelanguage.googleapis.com` 即可，会自动补 `/v1beta`。

qubius 不维护自己的代理设置：服务端和 Agent SDK 子进程都原样继承服务进程的 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 等环境变量。Node 22.21+ 下服务端内置 `fetch` 靠 `NODE_USE_ENV_PROXY` 开关生效，qubius 启动时如果没设置会自动补成 `1`（显式设为 `0` 可让服务端请求忽略代理环境变量）。出站路由完全由机器或部署环境决定——需要按目标域名分流时，由本机/内网的代理路由统一处理，qubius 不参与；没有配置代理时直接连接。Gemini 适配层、「测试」和「查询余额」的服务端请求也遵循同一套环境变量。

每套接口都可以点「测试」验证配置。修改接口类型或地址后必须重新填写 API key，防止旧 key 被发到新地址或另一家服务。

## 远程访问

qubius 自己不提供 HTTPS 和登录，远程访问时由下面任一方式提供这两层保护。

**SSH 隧道（最简单）。** 在你的电脑上运行下面的命令，然后打开 `http://127.0.0.1:8787`：

```bash
ssh -N -L 8787:127.0.0.1:8787 me@devbox
```

**反向代理。** 以 Caddy 为例，它会自动申请 HTTPS 证书，再用 Basic 认证保护整个站点：

```caddyfile
code.example.com {
	basic_auth {
		me <caddy hash-password 生成的哈希>
	}
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
```

使用反向代理时要注意三点：

- 在部署页把「公网域名」填成 `code.example.com`（或写进 env 的 `QUBIUS_PUBLIC_HOST`），否则 `/api` 请求会返回 403。
- 关闭响应缓冲（上面的 `flush_interval -1`），否则页面的实时状态流会卡住。
- 建议同时开启访问令牌。

手机推送和语音输入都要求页面通过 HTTPS 打开。

**局域网入口。** 仓库里的 `deploy/lan-proxy.mjs` 是一个带 Basic 认证和失败锁定的小型代理。它使用明文 HTTP，只适合可信的局域网，用法见 [双实例部署与运维](docs/deployment.md)。

## 使用说明

以下是各个功能的简要说明，详细行为和 HTTP 接口见 [参考手册](docs/reference.md)。

- **对话状态**：「本轮完成」表示主 agent 已经回复，而且没有还在运行或失败的子 agent。「等待确认」表示 agent 在提问，或者想访问工作区以外的路径；默认 10 分钟没人回应就会自动拒绝，可以在页面「设置 → 确认超时」调大（设为 0 则一直等待）。
- **继续对话**：服务重启时还在运行的对话会被标记为失败，再发一条消息就能接着上次的上下文继续。
- **切换模型**：同一个对话可以随时切换接口、模型和 effort，从下一轮开始生效，上下文保留。
- **工作流**：在输入区切换，或者在消息末尾写上 `prl`、`ser`、`plan`。输入框上方会显示各单元的开发和评审进度。
- **Git**：在详情页的「Git」面板查看改动、提交或推送。只能操作对话自己的分支，而且要等这一轮结束。
- **worktree 准备**：在项目配置里写 `worktree.setup`、`worktree.sharedDirectories` 和 `worktree.include`，或者在仓库根放 `.worktreeinclude`；新建 git 对话后会自动执行。路径必须是仓库内的相对路径，只处理被 gitignore 的路径；setup 失败会让创建失败并删除新 worktree。
- **Diff 评论**：展开「Diff」面板后，在改动行上点评论按钮留意见；可以标记解决或删除。点「发送给 agent」会把所有未解决评论拼成一条带文件和行号的 prompt。
- **PR / MR**：在 Git 面板创建 PR/MR 会先推送当前分支（普通 push，不 force），再调用本机 `gh` / `glab`。开启「监视」后页面可见时每 30 秒刷新一次，检查失败时可以把摘要发给 agent。
- **多模型对比**：输入区下方点「多模型」，选 2–4 个接口/模型组合；git 项目每个组合各建一个独立 worktree，非 git/isolated 项目各建一个独立目录。创建完成后可以在对比面板里看状态、成本和改动，记录保存在服务端，跨设备可见。
- **CLI / MCP**：`node tools/qubius.mjs session create --project <id> --prompt "..."` 可从脚本建对话；`QUBIUS_URL` 和 `QUBIUS_TOKEN` 指定服务和令牌。MCP 用 `node tools/qubius-mcp.mjs` 直接启动（不要用 `npm run` 启动，npm 的输出会污染 stdio）。
- **定时任务**：在项目页设置 prompt、模型和间隔（5 分钟到 7 天），每次到点会新建一个普通对话来执行。
- **命令行**：从顶栏进入，每个浏览器连接对应一个独立的 shell，最多同时 4 个。不需要时在 `config.yaml` 里写 `terminal: false`（或设置 `QUBIUS_TERMINAL=0`），入口和接口都会关闭。
- **推送通知**：在「设置 → 推送通知」里开启。iPhone 需要 iOS 16.4 或更高版本，并且要先「添加到主屏幕」，再从主屏幕图标打开。
- **归档**：配置 `archive.dir` 后，「归档」会先冷备份并校验，然后才删除本机副本；会话列表里超过 `retentionDays` 的对话也会自动归档，冷存储里的归档永久保留、不按天数清理。在归档面板里可以恢复或永久删除。

## 开发

```bash
npm test              # 服务端测试
npm run test:deploy   # 部署脚本测试（需要 bash）
npm run test:tools    # CLI / MCP 工具测试
npm run build         # 构建服务端和前端
```

目录结构：

| 目录 | 内容 |
|---|---|
| `server/` | Node.js 服务端：HTTP 接口、会话运行时、权限判断、归档、推送 |
| `web/` | React 前端（Vite） |
| `deploy/` | 安装、构建、启停脚本，systemd 和 logrotate 模板，局域网代理 |
| `docs/` | 参考手册和部署文档 |
| `tools/` | 开发辅助脚本、`qubius` CLI 和 MCP server |

## 文档

- [参考手册](docs/reference.md)：全部配置字段、会话机制、页面功能、归档规则和 HTTP 接口。
- [双实例部署与运维](docs/deployment.md)：主实例和副实例互备、部署脚本、页面部署、systemd、仓库迁移。
- [公网入口（edge）](docs/edge.md)：用 edgectl 管理 VPS 上 Caddy 站点的设计和操作步骤。
- [备份与恢复](docs/backup.md)：用 `make backup` 生成可校验的目录快照，用 `make restore BACKUP=<目录>` 恢复配置、数据与归档。

## License

本项目以 **GNU Affero General Public License v3.0 或更高版本**（AGPL-3.0-or-later）发布，完整条款见 [LICENSE](LICENSE)。

Copyright (C) 2026 chyanchyan

需要留意的两点：

- 部署后如果**通过网络向其他用户提供服务**，AGPL 第 13 条要求你向这些用户提供对应的完整源码，包括你的修改。
- 依赖的 `@anthropic-ai/claude-agent-sdk` 由 Anthropic 提供，它的使用受 Anthropic 自己的许可和条款约束，**不属于**本项目的 AGPL 授权范围。使用前请阅读该 SDK 附带的说明。
