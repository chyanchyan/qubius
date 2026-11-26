# 双实例部署与运维

这里记录作者自己的生产部署方式：同一台 Linux 开发机上运行主实例 qubius 和副实例 co-qubius，用 edgectl（VPS 上的 Caddy + SSH 反向隧道）提供公网入口，用 lan-proxy 提供局域网入口。只想单机使用时不需要读这一篇，见 [README](../README.md) 的「快速开始」和「远程访问」。


## 两个实例，共用一个仓库

产品需要两个 checkout（两个实例）互相修复，但**不需要两个独立的 git 仓库**：

| 实例 | 默认 checkout | 角色开关 | 默认入口 | 默认端口 | 默认数据目录 |
|---|---|---|---|---|---|
| qubius | 当前 checkout（`QUBIUS_PRIMARY_DIR`） | `QUBIUS_SECONDARY=0` | code.example.com | 8787 | `<checkout>/.qubius/data`（`QUBIUS_DATA_PRIMARY`） |
| co-qubius | `~/co-qubius`（`QUBIUS_SECONDARY_DIR`） | `QUBIUS_SECONDARY=1` | code-bak.example.com | 8788 | `<副 checkout>/.qubius/data`（`QUBIUS_DATA_SECONDARY`） |

- 两个 checkout 互相把对方加进 `projects`，可以在一边改另一边的代码；两边都不把自己放进去。
- 真正需要的是两份能独立构建、重启的 checkout：主实例的页面或服务改坏时，用副实例的页面去修，反之亦然；修完在对应 checkout 构建并重启。
- **不需要第二个仓库。** 副实例「同步主功能」是从**主实例的本地 checkout** fetch `main`（只允许 fast-forward），构建并重启后只是把结果 `push` 回自己的 `origin` 做镜像；整个过程不读取副实例 origin 的内容。
- 因此默认只建一个仓库，让两个 checkout 的 `origin` 都指向它；`QUBIUS_SECONDARY_REPO_URL` 不设置时自动跟随 `QUBIUS_PRIMARY_REPO_URL`。之后副实例同步的 `push` 是 fast-forward 或无操作；`install.sh` 对 origin 与期望 URL 不一致只告警，不阻止。
- 只有在想给副实例单独做镜像时才显式设置 `QUBIUS_SECONDARY_REPO_URL`。
- 项目权限不要用 `bypassPermissions`，它会让 agent 完全绕过确认。`acceptEdits` 也不是安全边界：工作区内命令自动执行，适合自己信任的仓库；处理外部内容或多人共用机器时改成 `default`，或用专用系统用户 / 容器隔离。
- 没有 release 目录和看门狗。回滚用 git：`git reset --hard <好提交>` 后重新构建。

## 版本号

版本号的唯一来源是仓库根 `package.json` 的 `version` 字段（semver）。构建时 `deploy/build.sh`（Windows 是部署任务）把它和提交 sha、构建时间一起写进 `server/dist/build.json`；运行中的服务通过 `/api/health` 和 `/api/instance` 报告这些值。

- 发版时改 `version`：先把开发分支合入 main，再在最新 main 上直接编辑根 `package.json`，或在仓库根执行 `npm version patch|minor|major --no-git-tag-version --workspaces=false`，然后正常构建部署。不要在开发分支里改版本号，分支落后 main 时会拿到过期版本。
- 版本号和更新说明只在收尾工作流（`tt` / `ttb` / `ttbm`）触发时更新，且发生在合入 main 之后、推送 main 之前；普通开发不提前递增，也不在 `CHANGELOG.md` 里写未发布条目。每个版本在 `CHANGELOG.md` 记录一句摘要和改动列表。
- `qubius-land.sh` 的 `*-finish` 步骤会校验本地版本严格高于 `origin/main`，多会话同时收尾时漏递增版本会直接失败。
- 页面位置：顶栏品牌名下方用很小的字显示版本号（手机上同样显示）；部署页的「当前环境」展示当前版本与 GitHub 镜像版本的对照，每个实例卡片也显示各自版本和 HEAD，便于确认主/副实例是否一致。
- GitHub 对照读取镜像仓库 `main` 分支的 `package.json`。镜像仓库优先用 `QUBIUS_GITHUB_REPO`（接受 `owner/repo` 或完整 GitHub URL），其次名为 `github` 的 remote，最后扫描所有 remote（优先 `origin`）里的第一个 github.com 地址。拉取失败只在部署页显示原因，不影响部署。
- 同一版本号可能对应多次提交，用提交短 sha 区分具体构建。开发环境（tsx 直接跑 `server/src`）没有 `build.json`，版本号回退到当前 checkout 的 `package.json`。

## 配置模型

部署脚本都 `source deploy/lib.sh` 并调用 `qubius_load`。变量优先级从高到低：

1. 调用者显式导出的环境变量，例如 `QUBIUS_SECONDARY=1 ./deploy/install.sh`；
2. env 文件：`$QUBIUS_ENV`、`$QUBIUS_CONFIG_DIR/env`（默认 `<checkout>/.qubius/env`）、`<checkout>/deploy/env`，取第一个存在的；
3. `deploy/lib.sh` 里的默认值。

模板是 `deploy/env.example`。日常不需要手工维护它：首次运行用 `npm run quickstart` 选择 npm 源、配置目录、数据目录和端口，其余参数（访问域名、访问令牌、归档、终端、并发/超时、项目）在 `/deploy` 部署向导里填写，两者都会落到当前 checkout 的 `.qubius/`。整个 `.qubius/` 已 gitignore，不再使用 `~/.config/qubius`、`~/.local/share` 或 `%APPDATA%`。`QUBIUS_ENV` 和 `<checkout>/deploy/env` 仍然兼容旧布局；页面的「当前环境」会显示实际读写的 env 文件、数据目录、allowedHosts 和令牌来源。

部署页 `/deploy` 使用同一优先级，读取并写回实际生效的 env 文件，并通过 `QUBIUS_ENV` 传给部署任务；`start-all.sh` 启动 server 时也导出该文件，所以页面、脚本和运行中的 server 看到同一份配置。`QUBIUS_ENV` 指向不存在的文件时页面拒绝部署。仓库级 `deploy/env` 的备份 `deploy/env.bak.*` 已被忽略。

关键变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `QUBIUS_SECONDARY` | 唯一角色开关：`0` 主实例 qubius，`1` 副实例 co-qubius | `0` |
| `QUBIUS_PRIMARY_REPO_URL` / `QUBIUS_SECONDARY_REPO_URL` | 两个 checkout 的仓库地址；副仓库默认跟随主仓库 | `example/qubius.git` / 同主仓库 |
| `QUBIUS_PRIMARY_REF` | 副实例同步主实例使用的分支 | `main` |
| `QUBIUS_PRIMARY_DIR` / `QUBIUS_SECONDARY_DIR` | 两个 checkout 路径 | 当前 checkout / `~/co-qubius` |
| `QUBIUS_CONFIG_DIR` | 配置、env，及生成的 systemd / logrotate 目录 | `<checkout>/.qubius` |
| `QUBIUS_DATA_PRIMARY` / `QUBIUS_DATA_SECONDARY` | 两个实例的 `dataDir` | `<checkout>/.qubius/data` / `<副 checkout>/.qubius/data` |
| `QUBIUS_PRIMARY_PORT` / `QUBIUS_SECONDARY_PORT` | 监听端口（只绑 `127.0.0.1`） | `8787` / `8788` |
| `QUBIUS_PUBLIC_HOST` / `QUBIUS_PUBLIC_HOST_SECONDARY` | 公网域名，用于 `allowedHosts` 和 edgectl 片段 | `code.example.com` / `code-bak.example.com` |
| `QUBIUS_ALLOWED_HOSTS` | 额外允许的 Host（逗号或空白分隔），启动时追加到 `allowedHosts`；公网域名由模板直接写进 config.yaml | 空 |
| `QUBIUS_MAX_CONCURRENT` / `QUBIUS_APPROVAL_TIMEOUT_MINUTES` | 并发上限和确认超时（分钟，0 表示不自动拒绝） | `4` / `10` |
| `QUBIUS_LIMIT_*` / `QUBIUS_HISTORY_PAGE` | 会话/请求上限；完整表单的「高级限制」折叠区也可以改 | 见 `docs/reference.md#配置` |
| `QUBIUS_LAN_HOST` | 内网入口绑定地址；留空取第一个非回环 IPv4 | 空 |
| `QUBIUS_ARCHIVE_DIR` / `QUBIUS_ARCHIVE_RETENTION_DAYS` | 归档根目录和列表保留天数（到期后会话归档到冷存储并永久保留）；目录留空不归档 | 空 / `30` |
| `QUBIUS_PROJECTS_FILE` | 额外项目白名单 YAML；内置会加入另一实例的 checkout。主页的「管理项目」添加或删除仓库时写这里，文件变化会热加载 | 空 |
| `QUBIUS_NODE_BIN` | Node.js 22+ 可执行文件；留空依次找 PATH 和 `~/.nvm` | 空 |
| `QUBIUS_CLONE_PEER` | `install.sh` 是否自动克隆另一实例的 checkout（等同 `--clone-peer`） | `0` |
| `QUBIUS_PULL_LATEST` | 部署任务构建前是否从各 checkout 的 `origin` 快进拉取当前分支（对应部署页「部署前从远端拉取最新代码」） | `0` |
| `QUBIUS_START_PRIMARY` / `QUBIUS_START_SECONDARY` | `start-all.sh` 是否启动对应实例 | `1` |
| `QUBIUS_START_LAN` | `start-all.sh` 是否启动/重启局域网入口；`0` 只做本机部署（不停止已在运行的代理） | `1` |
| `QUBIUS_GITEA_URL` / `QUBIUS_GITEA_OWNER` / `QUBIUS_GITEA_TOKEN` | `create-repos.sh` 的 Gitea 地址、所属用户或组织、token | `http://gitea.example.com` / `example` / 空 |
| `QUBIUS_AUTH` / `QUBIUS_AUTH_TOKEN` | 启用 API 访问令牌；令牌至少 16 个字符，留空且 `QUBIUS_AUTH=1` 时自动生成到 `dataDir/auth-token` | 空 |
| `QUBIUS_TERMINAL` | 浏览器命令行页，`0` 关闭；`config.yaml` 里的 `terminal` 优先 | `1` |
| `QUBIUS_VAPID_SUBJECT` | Web Push 的 VAPID 联系地址，`mailto:` 或 `https://` | `mailto:admin@example.com` |

`QUBIUS_EDGECTL_CONFIG` / `QUBIUS_EDGECTL_BIN` / `QUBIUS_EDGE_PROVIDER` / `QUBIUS_EDGE_PLAN_TIMEOUT_MS` 不参与 `install.sh` 渲染，只影响部署页的「公网入口」，见下文。

安全约定：

- API key、接口密码、Basic 认证密码、访问令牌、Gitea token 都**不要**写进仓库文件。模型密钥保存在 `dataDir/secrets.json`，在页面「设置」里填；访问令牌优先放 env 文件或环境变量。
- Host 校验默认只允许回环地址。通过局域网、反向代理或公网域名访问时，必须在 `allowedHosts` 里显式列出实际主机名；只开监听端口而不配置 Host 白名单会得到 403。
- `acceptEdits` 不是沙箱：它只根据命令文本里的字面路径做启发式判断，`sh script.sh`、`npm run ...`、`make ...`、`curl -d @.env ...` 都会直接执行，下载的脚本和 Makefile 内容不会被检查。处理不可信仓库、网页或依赖时，把项目权限改成 `default`，并用专用系统用户 / 容器运行；不要在该用户下放 SSH key、云凭据和浏览器 cookie。
- Markdown 里的外部图片默认显示为“点击加载”，不会在页面打开时自动请求；同源、`data:` 和 `blob:` 图片仍直接显示。
- lan-proxy 用明文 HTTP 传 Basic 认证，只适合可信局域网；同网段可嗅探密码。默认同一 IP 认证失败 5 次锁定 5 分钟（`LAN_PROXY_MAX_FAILURES` / `LAN_PROXY_LOCK_MS` 可调），跨不可信网络请用 TLS 或 SSH/VPN 隧道。
- `QUBIUS_GITEA_TOKEN` 只放在本机 env 或调用时导出；`create-repos.sh` 只从环境读取，不打印。
- 私有仓库的 git 凭据用 credential helper 或 SSH key，不要把 token 拼进仓库 URL。

## 安装与启停

新机器克隆仓库后，可以先运行 `npm run quickstart`：它会让用户选择 npm 官方源或国内镜像（npmmirror、腾讯云、华为云）、配置目录（默认 `<checkout>/.qubius`）、数据目录（默认 `<checkout>/.qubius/data`）和监听端口，然后执行 `npm ci`、`npm run build`、`npm start`。启动后打开 `http://127.0.0.1:<端口>`（默认 8787）进入首次部署向导，其余参数（访问域名、访问令牌、归档、终端、并发/超时）都在向导里；服务只绑定 `127.0.0.1`。`npm run quickstart -- --registry 2 --config-dir <绝对路径> --data-dir <绝对路径> --port 8790 --dry-run` 可以非交互地预览将执行的步骤；配置目录只在启动前可选，运行中的服务不能切换。

安装和构建过程默认按 npm 的 `notice` 级别输出，只显示每个步骤的最终结果。排查依赖安装、node-pty 编译等问题时加 `--verbose`（等价于 `--loglevel=verbose` 并打开 `--foreground-scripts`），会输出 npm 的详细日志并实时显示依赖安装脚本的输出；需要最全的日志可以加 `--loglevel=silly`，只想看 quickstart 自己的提示则用 `--loglevel=silent`。

启动前会检查端口：8787（副实例 8788）被占用时会列出占用进程的 PID 和命令，并给出三个选项：停止占用进程（二次确认；Linux/macOS 发送 SIGTERM 优雅停止，Windows 用 `taskkill /F` 强制结束，可能丢失最近约 1 秒未落盘的会话改动）、换一个空闲端口、退出；也可以用 `--port` 直接指定。检测到已有 `config.yaml` / `config-secondary.yaml` 时，端口以配置里的 `listen` 为准，此时仍可选择停止旧实例或退出，改端口需要修改配置。

需要 systemd、副实例或自定义目录布局时，继续用下面的安装脚本。在每个 checkout 里运行自己的安装脚本（默认 `~/qubius` 和 `~/co-qubius`）：

```bash
cd ~/qubius && ./deploy/install.sh
cd ~/co-qubius && QUBIUS_SECONDARY=1 ./deploy/install.sh
```

改过 `QUBIUS_PRIMARY_DIR` / `QUBIUS_SECONDARY_DIR` 时换成实际路径。交互 shell 通常没有 `$QUBIUS_*`，直接替换为实际路径；需要加载 env 时在子 shell 里 `. "<checkout>/.qubius/env"`，避免把 `QUBIUS_GITEA_TOKEN` 等凭据留在当前环境。

`install.sh` 会：

- 检查 Node.js 22+ 和 git（npm 由 `build.sh` 在需要构建时检查）。
- 缺失时从 `deploy/env.example` 复制 `$QUBIUS_CONFIG_DIR/env`（`0600`）。
- 把 `deploy/templates/config.yaml.in` 渲染成当前角色的配置（主 `config.yaml`，副 `config-secondary.yaml`），写到 `QUBIUS_CONFIG_DIR`（默认 `<checkout>/.qubius`）；已存在的不覆盖，有差异时备份 `*.bak.<时间戳>`（`--force-config` 时覆盖）。
- 生成 systemd unit 到 `$QUBIUS_CONFIG_DIR/systemd/`、logrotate 配置到 `$QUBIUS_CONFIG_DIR/logrotate.d/qubius`（只生成，不安装）。
- 主实例维护 `@reboot <主 checkout>/deploy/start-all.sh` crontab（systemd unit 已启用或 `QUBIUS_SKIP_CRONTAB=1` 时跳过）；副实例不维护。
- 缺 `node_modules`/构建产物或代码变化时执行 `<checkout>/deploy/build.sh`（`--no-build` 跳过；实例在跑且没加 `--restart` 时也跳过，避免前后端版本错配）。
- `--clone-peer` 时克隆另一实例的 checkout；`--restart` 时执行 `<checkout>/deploy/start-all.sh --restart`（systemd 接管时只打印手工步骤）。
- 手工运行时占用 `<configDir>/ops.lock`，与部署页触发的部署和公网入口作业互斥；被部署任务调用时（env 里已有 `QUBIUS_OPS_TOKEN`）自动跳过，避免嵌套死锁。副实例的 `sync`/`rollback` 也参与同一把锁，被占用时快速失败并写维护日志。`@reboot` 的 `start-all.sh` 同样参与；开机时锁被占用（如上次被强杀的手工任务仍在宽限期）会启动失败并记录到 `start-all.log`，不自动重试。

没有配置文件时服务也会启动并进入首次部署模式，在 `/deploy` 填表即可完成首次配置和启动。

`deploy/` 就是脚本来源，不复制到配置目录。手动构建和启停：

```bash
"$QUBIUS_PRIMARY_DIR/deploy/build.sh" "$QUBIUS_PRIMARY_DIR"
"$QUBIUS_SECONDARY_DIR/deploy/build.sh" "$QUBIUS_SECONDARY_DIR"
"$QUBIUS_PRIMARY_DIR/deploy/start-all.sh"
"$QUBIUS_PRIMARY_DIR/deploy/start-all.sh" --restart
```

`start-all.sh` 按 `QUBIUS_START_PRIMARY` / `QUBIUS_START_SECONDARY`（默认都为 `1`）启动两个实例，可从任一 checkout 运行。只跑副实例的机器设 `QUBIUS_START_PRIMARY=0`；只跑主实例设 `QUBIUS_START_SECONDARY=0`，否则缺失的 checkout 会让它以非零退出。`QUBIUS_START_LAN=0` 时只启动实例，不启动/重启局域网入口（已在运行的代理不停止）。`build.sh` 在依赖变化或缺 `node_modules` 时先 `npm ci`，成功后写 `server/dist/build.json`（`head`、`builtAt`、`dirty`）；`start-all.sh` 用它判断是否重建，工作区脏也会触发下次重建。

### make 快捷部署

`make` 是统一的启动/部署入口，所有目标都通过 Node 执行，Windows、Linux 和 macOS 都能用。Linux 上内部调用 `deploy/*.sh`（保留 systemd、flock、双实例逻辑），Windows/macOS 由 `deploy/cli.mjs` 用 Node 启动/停止，部署走 `deploy/deploy-job.mjs`。npm 脚本仍然保留。

| 命令 | 做什么 |
|---|---|
| `make start` / `make restart` / `make stop` | 启动/重启/停止启用的实例和局域网入口（Linux 转给 `start-all.sh`） |
| `make status` | 显示配置目录、env 文件、局域网凭据文件和每个实例的健康状态 |
| `make install` | Linux：渲染配置、生成 systemd/logrotate、构建；macOS/Windows 提示改用部署页 |
| `make pull` | 当前 checkout 从 `origin` 快进拉取 |
| `make deploy` | 构建并重启本机实例，只保证 `127.0.0.1:<端口>` 可访问；不启动局域网/公网入口，也不停止已在运行的入口 |
| `make deploy-lan` | 在 `deploy` 基础上启动/重启局域网入口（`lan-proxy` / `qubius-proxy.service`）；缺少 `lan-proxy.credentials` 时自动生成并在终端打印一次 |
| `make deploy-wan` | 在 `lan` 基础上应用公网入口：走运行中实例的 `/api/edge`（plan → 确认域名 → apply → 轮询状态），与部署页同一套作业 |

- 部署对象是 env 里的 `QUBIUS_PRIMARY_DIR` / `QUBIUS_SECONDARY_DIR`，默认是当前 checkout。
- 自动检测 systemd user unit：`qubius.service` 等已启用或运行中时用 `systemctl --user restart`，否则交给 `start-all.sh --restart`（本机模式会传 `QUBIUS_START_LAN=0`）。依赖变化（`node_modules` 缺失或 `package-lock.json` 变化）时会先停 unit 再 `npm ci`。
- 部署后检查 `/api/health`，存在构建 stamp 时校验 `head` 与 checkout 的 git HEAD；`deploy-lan` / `deploy-wan` 还会等待局域网端口监听。
- `deploy-lan` / `deploy-wan` 在结尾会把自动生成的 `<dataDir>/auth-token` 打印一次；页面部署则一次性显示在 `/deploy` 上。
- `deploy-wan` 需要 env 里已配置 `QUBIUS_EDGECTL_CONFIG`；计划里的差异和警告会先打印，确认后才应用。`QUBIUS_EDGE_YES=1`（或 `--yes`）跳过交互确认，`QUBIUS_EDGE_DOMAIN` 指定确认域名，`QUBIUS_EDGE_WAIT` 指定等待作业的秒数。启用访问令牌时从 `QUBIUS_AUTH_TOKEN` 或 `<dataDir>/auth-token` 读取。
- 手工执行时参与和部署页相同的 ops lock；部署页任务或公网入口作业进行中时会等待/失败。

## 页面部署与冷启动

配置目录里还没有 `config.yaml` / `config-secondary.yaml` 时，服务进入首次部署模式：打开 `/deploy` 会先进入分步向导，依次选择使用方式（仅本机 / 远程访问 / 主副双实例）、确认当前实例的 checkout、数据目录、端口和访问域名，双实例再补另一个实例的信息，最后确认并部署。向导会把当前运行的 checkout 和 git origin 作为默认值；归档等可选参数放在「高级选项」里，也可以随时切换到完整部署表单。

无论是向导还是完整表单，服务端都会写入实际生效的 env 文件和 `<configDir>/projects.yaml`（`configDir` 默认是当前 checkout 的 `.qubius/`）。Linux 按角色执行一次 `deploy/install.sh --force-config`，最后执行 `deploy/start-all.sh --restart`；Windows 和 macOS 由纯 Node 任务 `deploy/deploy-job.mjs` 完成等价的配置渲染、构建、停旧进程和启动，不依赖 bash/systemd/flock，见下面的平台章节。部署成功后向导会给出「进入 qubius」和「填写模型 API Key」两个下一步。任务日志在 `<configDir>/deploy.log`，状态在 `deploy.json`。

正常运行后也可回 `/deploy` 改配置并重新部署；部署页顶部的「重新部署」按钮会从向导第一步开始重新确认使用方式、目录和端口，当前配置作为预填值。`--force-config` 仅在内容有差异时用页面生成的内容覆盖已有配置，并备份 `*.bak.<时间戳>`；内容一致时保持原文件。

完整表单的「仓库」区块还有「部署前从远端拉取最新代码」选项（写进 `QUBIUS_PULL_LATEST`）。勾选后，部署任务会在构建前对每个启用的 checkout 执行 `deploy/pull-latest.sh`：从该 checkout 的 `origin` fetch 当前分支并只做 fast-forward 合并。工作区有未提交改动、当前分支与远端分叉、或处于 detached HEAD 时部署会中止并保留本地内容，不会 `reset --hard`；需要手动合并后再重新部署。该选项拉取的是 checkout 配置的 `origin`，不读取表单里的仓库 URL，也不使用其中的凭据。

首次冷启动可先按仓库方式跑起来，再打开 `/deploy`：

```bash
npm ci && npm run build && npm start
```

副实例冷启动用 `QUBIUS_SECONDARY=1 npm start`（或先加载对应 env），页面会按副实例角色进入首次部署模式。

限制：

- systemd user unit 已接管（已启用或运行中）时，部署任务中止，改用 `systemctl --user restart <unit>`。
- edgectl 站点和域名可在部署页「公网入口」配置（需服务端设置 `QUBIUS_EDGECTL_CONFIG`）；本地网关的 `apply-local` 仍需手工或提权。
- 任务结束时会先停当前进程，再按新端口重启。端口不变时页面短暂断开后自动刷新；端口变化时页面提前给出新地址（`127.0.0.1:<port>` 和公网域名）。

## Windows 部署

Windows 没有 bash/systemd/flock，部署页改走 Node 任务 `deploy/deploy-job.mjs`（`server/src/deploy.ts` 按 `process.platform` 选择）。首次部署向导同样可用：会使用 `C:\...` 形式的路径占位符，提示需要 Node.js 22+ 和 git 在 PATH 中，并说明 Windows 不支持副实例同步/回滚和公网入口。它完成和 Linux 脚本等价的工作：

1. 读取 `<configDir>/env` 和 `projects.yaml`，为每个启用的角色渲染 `config.yaml` / `config-secondary.yaml`（旧文件内容不同时备份 `*.bak.<时间戳>`）。
2. 副实例目录缺失且启用了 `clonePeer` 时 `git clone`。
3. 勾选「部署前从远端拉取最新代码」时，从各 checkout 的 `origin` 快进拉取当前分支（与 Linux 的 `deploy/pull-latest.sh` 语义一致）。
4. `package-lock.json` 变化或 `node_modules` 缺失时 `npm ci`，然后按需 `npm run build`，写 `server/dist/build.json`。
5. 停掉旧的服务进程（当前服务根据 server 传入的 PID 和 `process.argv[1]` 判断，其它实例按 `<dataDir>/qubius.pid`）。Windows 上 `process.kill` 是硬杀，所以 server 启动时会在 `<dataDir>/shutdown-token` 写一个随机令牌；部署任务先请求 `POST /api/internal/shutdown` 让它 flush 会话并优雅退出，15 秒未退出才强制结束。等端口释放后启动 `node server/dist/index.js`。
6. 用 `/api/health` 校验端口、pid 和 `head`；`QUBIUS_START_LAN=1` 且配置目录里有 `lan-proxy.credentials` 时顺带重启 `deploy/lan-proxy.mjs`。部署页勾选局域网入口会自动写入凭据，并在部署响应里一次性返回用户名/密码/访问令牌。

默认目录和 Linux 一致：配置、env、数据和日志都在当前 checkout 的 `.qubius/`（整个目录已 gitignore），不再使用 `%APPDATA%` / `%LOCALAPPDATA%`。`QUBIUS_CONFIG_DIR` 等 env 仍然优先。手工 `npm start` 时会自动读取 `.qubius/` 里的配置和 env，不需要额外设置 `QUBIUS_CONFIG`。

Windows 上**不支持**：systemd/logrotate/crontab 安装、公网入口（edge，依赖 edgectl 和 shell ops lock）、副实例的同步/回滚（`deploy/secondary.sh` 是 bash）、开机自启（请用任务计划程序）。部署页在一次部署进行中仍由 `deploy.job.lock` 和 `deploy.json` 串行化；Windows 不使用 shell 的 `ops.lock`。

## macOS 部署

macOS 没有 Linux 部署脚本依赖的 `flock`、`ss`、`setsid`、`sha256sum` 和 `/proc`，所以部署页和 Windows 一样走纯 Node 任务 `deploy/deploy-job.mjs`（`server/src/deploy.ts` 的 `deployJobSpec` 按 `process.platform` 选择）。它不参与依赖 flock 的 shell ops lock，仍由 `deploy.job.lock` 和 `deploy.json` 串行化。

首次部署向导同样可用，完成与 Linux 脚本等价的步骤：渲染 `<configDir>/config.yaml` / `config-secondary.yaml`、按需 `npm ci` / `npm run build`（写 `server/dist/build.json`）、停掉旧进程、启动 `node server/dist/index.js`，并用 `/api/health` 校验端口和 HEAD。默认配置目录是当前 checkout 的 `.qubius/`，数据目录 `.qubius/data`；主、副实例都可以启动。

手工 `npm run quickstart` / `npm start` 启动时，仓库根目录没有 `config.yaml` 会回退读取配置目录里的 `config.yaml`，并补读 `<configDir>/env`，所以部署页生成的配置在重新启动后仍然生效。

macOS 上**不支持**：systemd/logrotate/crontab 安装与开机自启（需要时用 launchd 登记 `node <checkout>/server/dist/index.js`）、公网入口（edge，依赖 shell ops lock 和 flock）、副实例的同步/回滚（`deploy/secondary.sh` 是 bash）。同样没有 `ops.lock`；`deploy/ops-lock.sh` 在缺少 flock 时会明确报 `unsupported`，不再把它误判成锁被占用。

## 公网入口（edge）

部署页「公网入口」可把 qubius / co-qubius 两个站点纳入管理：读取现有配置、生成变更计划、确认公网域名后应用。

- 唯一事实来源是 `edgectl.yaml`。服务端只从 `<deployConfigDir>/env`（优先）和启动进程 env（兜底）解析路径；同一来源内 `QUBIUS_EDGECTL_CONFIG` 优先于 `EDGECTL_CONFIG`（`<configDir>/env` 里的 `EDGECTL_CONFIG` 会压过进程 env 的 `QUBIUS_EDGECTL_CONFIG`）。必须是绝对路径；env 里的 edge 键含未展开 `${...}` 时按 parse 错误处理：忽略该键、记录错误并回退进程 env。
- 只**编辑**注册表里 `qubius` / `co-qubius` 两个条目，其它站点只读。但外部 `edgectl apply-vps` 会重渲染整个托管块，所以 plan 的 `remoteDiff` 覆盖整个托管块；非 owned 站点有变化时返回可确认的 blocking warning（`requiresConfirmExisting`），apply 带 `confirmExisting` 继续。不要给 `apply-vps` 传只含 owned site 的临时配置，否则会删掉其它站点。
- 注册表 upstream 由服务端解析到的端口派生为 `http://127.0.0.1:<port>`；desired 条目只在 `QUBIUS_START_PRIMARY` / `QUBIUS_START_SECONDARY` 为真时生成，停用角色不生成新条目，旧条目保留并 warning。
- `QUBIUS_EDGE_PROVIDER=auto|cli|native`（默认 `auto`）：`QUBIUS_EDGECTL_BIN` 必须是绝对路径；相对路径/不存在/不可执行会让 GET 的 `available=false`，plan/apply 的 `--version` 握手失败直接报错。只有未显式设置 BIN 时，`auto` 才会在 PATH / `~/.edgectl/.venv/bin/edgectl` 找不到可用 edgectl 时回退 native；`cli` 不可用时直接报错。provider 每次 plan/apply 按当前环境解析，`auto` 可能变化；plan 显示 resolved provider，变化后需重新 plan。`edge.json` 记录 provider / `planHash` 供审计。
- 流程：`GET /api/edge` 读状态 → `POST /api/edge/plan` 生成计划（注册表 diff、脱敏远端 diff、warnings、`planHash`）→ 页面输入公网域名确认 → `POST /api/edge/apply`（`planHash`、`confirmDomain`，必要时 `confirmExisting`）→ 后台作业，状态 `edge.json`、日志 `edge.log`（不写 `deploy.json`）。
- 恢复：`POST /api/edge/restore`，body 为 `{backup, remoteSha, confirmDomain}`；`backup` 仅接受 `edge-backup-*.Caddyfile` / `edge-unknown-*.Caddyfile`；`lastFailure` 用于预填。native 失败时 `backupPath` 是远端 `.bak`，不能直接传给 restore。
- 重复应用：远端已是目标状态时仍执行 validate live + reload，确保运行配置生效；reload 失败则 validate + reload 重试一次。
- 安全：页面不执行 `apply-local`，只给命令；SSH 用 `BatchMode`；错误、diff 和日志脱敏。`ops.lock` / `ops.meta` 按 `deployConfigDir` 串行化（flock，识别 token 残留）；强制回收需输入 `RECLAIM`。
- 仍需手工：域名 DNS A 记录；本地网关 `apply-local`；systemd 接管时的应用部署。
- 限制：NFS 不支持 flock；外部直接 unlink/replace `ops.lock` 不受支持；cleanup 终止 `start-all.sh` 时可能短暂空窗；同一 site 必须使用同一个 `deployConfigDir` 才能与 app-edge 互斥。

完整设计、失败恢复和验收步骤见 [`edge.md`](edge.md)。

## 仓库初始化与迁移

仓库不存在时用脚本创建（默认 dry-run）：

```bash
./deploy/create-repos.sh
./deploy/create-repos.sh --apply
```

`create-repos.sh` 按固定名字确保 `qubius` 仓库存在（默认私有），不 push 代码，仓库名不取自 URL。两个实例共用这一个仓库。`QUBIUS_GITEA_OWNER` 必须真实存在：是用户时 token 必须属于本人，是组织时需要建库权限。

创建后设置 `origin` 并首次推送（两个 checkout 用同一个 URL）：

```bash
git -C "$QUBIUS_PRIMARY_DIR" remote add origin "$QUBIUS_PRIMARY_REPO_URL"
git -C "$QUBIUS_PRIMARY_DIR" push -u origin main
git -C "$QUBIUS_SECONDARY_DIR" remote add origin "$QUBIUS_SECONDARY_REPO_URL"
git -C "$QUBIUS_SECONDARY_DIR" push -u origin main
```

已有 `origin` 时把 `remote add` 换成 `git remote set-url origin <url>`。新机器上可用 `./deploy/clone-repos.sh`（默认 dry-run，`--apply` 执行）；它把同一个仓库克隆到两个 checkout 目录，只在目录不存在时执行，已存在则跳过，不覆盖、不 push。

### 从 qoder 改名升级

- env：把 `QODER_*` 全部改成 `QUBIUS_*`（新代码只兼容更早的 `REMOTE_CODER_*`）。配置目录从 `~/.config/qoder` 复制到当前 checkout 的 `.qubius/`（沿用旧布局时仍可用 `~/.config/qubius`，显式设置 `QUBIUS_CONFIG_DIR` 即可），`lan-proxy.credentials` 一并复制。
- 数据/checkout/归档想原地保留时，在 env 里显式写旧的 `QUBIUS_PRIMARY_DIR`、`QUBIUS_DATA_PRIMARY`、`QUBIUS_ARCHIVE_DIR`；不要只改名而不处理 worktree 里的绝对路径。
- 会话记录的 `projectPath` 会在服务启动和项目列表热加载时按 `projectId` 对齐到当前配置（非 git 会话由项目目录派生的 `cwd` 一起平移），所以改了项目目录不需要手工改会话 JSON。但 `dataDir/worktrees` 下 worktree 的 `.git` 指针仍指向旧路径：目录是真的 `mv` 走时要跑 `git worktree repair`，留软链则不需要。
- systemd：安装新的 `qubius.service`、`qubius-proxy.service`，`systemctl --user disable --now qoder.service qoder-proxy.service` 后再启用新的。直接重启旧 unit 不行：旧 unit 只注入 `QODER_*`，新脚本会落回默认端口和路径。
- 已有会话分支 `qoder/<id>` 和 `remote-coder/<id>` 继续兼容，不需要重命名。
- edgectl 注册表里把 `qoder`/`co-qoder` 站点的 `name` 改成 `qubius`/`co-qubius`（domains、upstream 不变），否则部署页的「公网入口」会因为同名域名冲突无法 apply。

迁移到新机器或分享：

1. 准备仓库：用 `./deploy/create-repos.sh --apply` 创建共用的 `qubius` 仓库；
2. 新机器先 clone 其中一个（或复制一份 checkout）拿到脚本，再 `./deploy/clone-repos.sh --apply` 补齐（一个仓库时两个 checkout 都指向同一 URL）；
3. 复制 `deploy/env.example` 为各 checkout 的 `.qubius/env`（或者直接跑 `npm run quickstart` + 部署向导），按新机器改路径、端口、域名、`QUBIUS_LAN_HOST`、归档目录、projects 文件和 Node 路径；token 只填本机 env；
4. 准备凭据：git credential helper / SSH key、edgectl Basic 认证；局域网凭据可以在部署页勾选「启用局域网入口」自动生成（只显示一次），或运行 `make deploy-lan` 让 CLI 生成并打印一次，文件是 `QUBIUS_CONFIG_DIR/lan-proxy.credentials`（`user:password`，`0600`）；
5. 两个 checkout 分别运行 `./deploy/install.sh`（副实例加 `QUBIUS_SECONDARY=1`）；
6. 用 `"$QUBIUS_PRIMARY_DIR/deploy/start-all.sh" --restart` 或 systemd unit 启动；
7. 在 edgectl 配置两个站点的 `domains`、`upstream`、`sse: true`，或通过部署页「公网入口」完成；
8. 打开页面，在「设置」填模型 API key、接口地址和模型名。

## systemd 与 logrotate

`deploy/templates/systemd.service.in` 只有一个模板，`install.sh` 每次按角色渲染当前实例的两个 unit；两个 checkout 各跑一次得到四个（端口以实际 env 为准）：

- `qubius.service`（主）、`co-qubius.service`（副）
- `qubius-proxy.service`（主内网入口）、`co-qubius-proxy.service`（副内网入口）

`install.sh` 只把当前角色需要的两个 unit 写到 `$QUBIUS_CONFIG_DIR/systemd/`，不安装、不启用。要装齐四个（假定两边同一 `QUBIUS_CONFIG_DIR`）：

```bash
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
mkdir -p "$UNIT_DIR"
for u in qubius.service qubius-proxy.service co-qubius.service co-qubius-proxy.service; do
  install -m 644 "$QUBIUS_CONFIG_DIR/systemd/$u" "$UNIT_DIR/"
done
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now qubius.service qubius-proxy.service
systemctl --user enable --now co-qubius.service co-qubius-proxy.service
```

- 实例脚本只绑 `127.0.0.1`；只有两个 LAN 入口脚本自带网络重试。用户 unit 下 `network-online.target` 通常不会真正等网络就绪，`After` / `Wants` 只用于尽量延后。
- 任一 unit 启用后，`start-all.sh` 拒绝手工 kill + setsid，改用 `systemctl --user`；构建请显式传仓库目录给该 checkout 的 `deploy/build.sh`。全部启用才完整接管，只启用一部分时未接管的实例不会自启。
- 副实例 unit 用 `KillMode=process`：`systemctl stop` 只停 node，不杀正在执行的 sync/rollback；代价是 node 派生的其它长生命周期子进程也不会被清理。
- 首次安装或 `--no-build` 且 `node_modules/yaml` 不存在时，YAML 兜底校验会跳过；`QUBIUS_PROJECTS_FILE` 的缩进预检仍执行。
- 不执行 `loginctl enable-linger` 时，注销或重启后 unit 不自启。
- 启用 systemd 后实例 stdout 进 journald：`journalctl --user -u <unit>`。

日志轮转模板是 `deploy/templates/logrotate.in`，`install.sh` 渲染到 `$QUBIUS_CONFIG_DIR/logrotate.d/qubius`，但不安装：

```bash
sudo install -m 644 "$QUBIUS_CONFIG_DIR/logrotate.d/qubius" /etc/logrotate.d/qubius
sudo logrotate -d /etc/logrotate.d/qubius
sudo logrotate -f /etc/logrotate.d/qubius
```

配置覆盖两个 `dataDir` 下的 `*.log`；启用 systemd 后只处理 shell 重定向写出的日志。日志目录属于运行用户，root 运行 logrotate 时需 `su <user> <user>`，否则会因父目录权限跳过。

## 副实例维护

副实例首页顶部有「同步主功能」和「回滚」：

- 同步：从主实例本地 checkout 拉取 `main`（只允许 fast-forward），构建后重启副实例，成功后把结果推回自己的 `origin`（一个仓库时是 no-op）。
- 回滚：回到上一次成功同步前的提交，构建后重启。
- 任一步失败都会尝试回到操作前的提交；日志在 `$QUBIUS_DATA_DIR/secondary.log`，状态在 `secondary.json`。
- 前提：副实例工作区干净、在 `main`，且没有独立提交需手动合并。
- 按钮只在 `role: secondary` 出现；主实例的 `/api/secondary/*` 返回 404。
- Windows（Git Bash/MSYS）没有 `flock`/`setsid`/`ss` 时脚本会降级：跳过部署锁和维护锁、用 `nohup` 启动、用 `netstat` + `taskkill` 停进程。单机能跑通，但不具备 Linux 上 `flock` 提供的并发互斥。手工在仓库里启动、没有 install 生成的 `config-secondary.yaml` 时，`run.sh` 会退回仓库根目录的 `config.yaml`。

## edgectl 与健康检查

edgectl 的两个 dev 站点指向同一个网关，公网保护用现有的 Basic 认证和 Cookie：

```yaml
- name: qubius
  domains: [code.example.com]
  env: dev
  upstream: http://127.0.0.1:8787
  auth: dev
  sse: true

- name: co-qubius
  domains: [code-bak.example.com]
  env: dev
  upstream: http://127.0.0.1:8788
  auth: dev
  sse: true
```

`sse: true` 必须保留，否则对话状态流会被 Caddy 缓冲。两个站点共用同一套 Basic 密码；内网入口共用 `lan-proxy.credentials`，8787→8787、8788→8788。上面的 YAML 和端口、域名都是模板/legacy 示例，实际值以 env（`QUBIUS_PRIMARY_PORT` / `QUBIUS_SECONDARY_PORT`、`QUBIUS_PUBLIC_HOST*`）和 `QUBIUS_EDGECTL_CONFIG` 指向的注册表为准，也可在部署页「公网入口」查看和修改。

本机确认：

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s http://127.0.0.1:8788/api/health
```

`/api/health` 返回 `ok`、`role`、`pid`、`uptime`、`dataDirWritable`、`webDist`；存在 `server/dist/build.json` 时还带 `head`。`start-all.sh` 用 `head` 与当前 git HEAD 比对，PID 用 pidfile 与监听端口比对；`pid` / `webDist` 主要供排查。启用 API 访问令牌后，`/api/health` 仍然免令牌（部署脚本探活用），其它 `/api` 接口需要带令牌。公网应先返回 401，通过 edgectl 的开发账号后才能打开。

## legacy

旧的 `remote-code` / `remote-code-bak` 实例、`remote-coder` 名称的配置和数据目录已停用，不再由当前脚本维护。历史 checkout、`~/.config/remote-coder/`、`~/.local/share/remote-coder{,-bak}/` 和旧 systemd unit 不会被自动删除；确认新实例正常后可手工清理。旧会话若需保留，停服务后把旧 `dataDir` 复制到新的 `QUBIUS_DATA_PRIMARY` / `QUBIUS_DATA_SECONDARY`，并检查 `secrets.json`、`push/vapid.json` 和 worktree 路径。
