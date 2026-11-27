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

版本号的唯一来源是仓库根 `package.json` 的 `version` 字段（semver）。构建时 `deploy/build.sh`（Windows 是部署任务）和 `npm run build`（quickstart、`make build`、手工构建）都会把它和提交 sha、构建时间一起写进 `server/dist/build.json`；运行中的服务通过 `/api/health` 和 `/api/instance` 报告这些值。用 quickstart 重新构建会刷新这个文件，不会沿用上一次部署留下的旧版本号。

- 发版时改 `version`：先把开发分支合入 main，再在最新 main 上直接编辑根 `package.json`，或在仓库根执行 `npm version patch|minor|major --no-git-tag-version --workspaces=false`，然后正常构建部署。不要在开发分支里改版本号，分支落后 main 时会拿到过期版本。
- 版本号和更新说明只在收尾工作流（`tt` / `ttb` / `ttbm`）触发时更新，且发生在合入 main 之后、推送 main 之前；普通开发不提前递增，也不在 `CHANGELOG.md` 里写未发布条目。每个版本在 `CHANGELOG.md` 记录一句摘要和改动列表。
- `qubius-land.sh` 的 `*-finish` 步骤会校验本地版本严格高于 `origin/main`，多会话同时收尾时漏递增版本会直接失败。
- 页面位置：顶栏品牌名下方用很小的字显示版本号（手机上同样显示）；部署页的「当前环境」展示当前版本与 GitHub 镜像版本的对照，每个实例卡片也显示各自版本和 HEAD，便于确认主/副实例是否一致。
- GitHub 对照读取镜像仓库 `main` 分支的 `package.json`。镜像仓库优先用 `QUBIUS_GITHUB_REPO`（接受 `owner/repo` 或完整 GitHub URL），其次名为 `github` 的 remote，最后扫描所有 remote（优先 `origin`）里的第一个 github.com 地址。部署页「GitHub 仓库」可以直接修改这个值，保存后立即生效、不触发重新部署；一键「更新并部署」在找不到 github 远端时也会用它作为拉取地址。拉取失败只在部署页显示原因，不影响部署。
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
| `QUBIUS_MAX_CONCURRENT` / `QUBIUS_APPROVAL_TIMEOUT_MINUTES` | 并发上限和确认超时的首次启动默认值（分钟，0 表示不自动拒绝）；之后以页面「设置」为准 | `4` / `10` |
| `QUBIUS_LIMIT_*` / `QUBIUS_HISTORY_PAGE` | 会话/请求上限的首次启动默认值；之后在页面「设置 → 高级限制」修改 | 见 `docs/reference.md#配置` |
| `QUBIUS_LAN_HOST` | 内网入口绑定地址（也接受 `LAN_PROXY_HOST`，后者优先）；留空时自动选择私有/链路本地/CGNAT IPv4，不会选公网或回环地址 | 空 |
| `QUBIUS_ARCHIVE_DIR` / `QUBIUS_ARCHIVE_RETENTION_DAYS` | 归档根目录和列表保留天数的首次启动默认值（到期后会话归档到冷存储并永久保留）；目录留空不归档，保留天数之后在页面「设置」修改 | 空 / `30` |
| `QUBIUS_PROJECTS_FILE` | 额外项目白名单 YAML；内置会加入另一实例的 checkout。主页的「管理项目」添加或删除仓库时写这里，文件变化会热加载 | 空 |
| `QUBIUS_NODE_BIN` | Node.js 22+ 可执行文件；留空依次找 PATH 和 `~/.nvm` | 空 |
| `QUBIUS_CLONE_PEER` | `install.sh` 是否自动克隆另一实例的 checkout（等同 `--clone-peer`） | `0` |
| `QUBIUS_GITHUB_REPO` | GitHub 镜像（`owner/repo` 或完整地址），用于版本对照和一键更新的拉取回落；部署页「GitHub 仓库」可直接修改 | 空（自动识别） |
| `QUBIUS_PULL_LATEST` | 部署任务构建前是否从各 checkout 的远端快进拉取当前分支（对应部署页「部署前从远端拉取最新代码」；一键「更新并部署」只在本次任务强制打开） | `0` |
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
- lan-proxy 的绑定地址按以下顺序确定：`LAN_PROXY_HOST`（或 `QUBIUS_LAN_HOST`）显式指定 > 自动选择私有/链路本地/CGNAT IPv4（`10/8`、`172.16/12`、`192.168/16`、`100.64/10`、`169.254/16`，优先级依次为 private > CGNAT > 链路本地）。回环、`0.0.0.0`、组播、保留段和公网地址都不会被自动选中；找不到可用地址时启动失败并提示显式设置。显式值必须是合法 IP 或主机名，公网地址会被接受但会打印告警。端口探活和子进程监听使用同一个解析结果，`LAN_PROXY_HOST` 与 `QUBIUS_LAN_HOST` 并存时以 `LAN_PROXY_HOST` 为准。部署页的一次性局域网地址和「重置局域网密码」返回的地址也使用同一套解析；进程环境里没有 `LAN_PROXY_HOST` 时会从部署 env 文件（`QUBIUS_ENV` > `<configDir>/env` > `<repo>/deploy/env`）读取，因此页面/重置/代理三方看到的是同一个地址。
- lan-proxy 会把原始 `Host` 写入 `X-Forwarded-Host` 再改写成上游回环地址。服务端在请求缺少 `Sec-Fetch-Site` 时回退检查 `Origin`（没有则 `Referer`）：`Origin` 主机在 `allowedHosts` 里，或来源是回环且 `Origin` 主机等于 `X-Forwarded-Host`（即局域网入口改写前的 Host）时放行；`Origin` 为 `null` 或无法解析时拒绝。带有 `Sec-Fetch-Site` 的请求仍只按原有的跨站判断，不会再按 `Origin` 二次校验，避免局域网入口被误杀。
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
- 缺 `node_modules`/构建产物或代码变化时执行 `<checkout>/deploy/build.sh`（默认先 staging 构建再原子切换，见下面的「构建 staging、原子切换与回滚」；`--no-build` 跳过；实例在跑且没加 `--restart` 时也跳过，避免前后端版本错配）。
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

### 构建 staging、原子切换与回滚

`deploy/build.sh` 不再直接覆盖正在使用的 `server/dist`、`web/dist`。构建先写到同级的 `dist.next`，成功后再用同一文件系统内的 `mv`/rename 原子切换；旧产物留在 `dist.prev` 供回滚。构建期间旧服务继续读取旧的 live 目录，页面不会因为 `dist` 被清空而 404，构建失败也不会丢失旧产物。

显式模式（调用方不应再依赖默认模式做部署）：

- `build.sh --deps <repo>`：只按 `package-lock.json` 哈希决定是否 `npm ci`，不构建。
- `build.sh --stage <repo>`：把 server/web 构建到 `server/dist.next`、`web/dist.next` 并写 staging 的 `build.json`；live 完全不动，失败时清理 `.next`。
- `build.sh --swap <repo>`：校验 staging 的 `index.js`、`build.json`、`index.html` 后，把两侧 `.next` 切换为 live，旧 live 移入 `.prev`；两侧要么都成功，要么恢复原状。
- `build.sh --rollback <repo>`：删除失败的 live，用两侧 `.prev` 恢复，并清掉残留 `.next`。
- 默认 `build.sh <repo>` 仍是“按需安装依赖 + `--stage` + `--swap`”，保留给 `install.sh` 和手工构建。

`start-all.sh` / `deploy.sh`（systemd）的部署顺序：

1. 忙碌预检通过后，需要 `npm ci` 时先停实例，把 `node_modules` 改名为 `node_modules.prev`（旧 .prev 先删），再执行 `--deps` 和 `--stage`；任一步失败都恢复 `node_modules.prev`、丢弃 staging，并按旧 live 拉起旧版本。
2. 不需要 `npm ci` 时直接在旧服务运行期间 `--stage`；失败只丢弃 staging，旧服务不受影响。
3. 停止前无条件再复检一次会话（新端口 + `.deploy-stamp` 里的旧端口）。构建期间新来会话时中止部署；如果之前因安装依赖停过实例，会先恢复依赖、丢弃 staging 并拉起旧版本，再以退出码 3 结束。
4. 停实例 → `--swap` → 启动 → 校验 `/api/health` 和 health 里的 `head`。启动失败时停止新进程 → `--rollback` → 恢复 `node_modules.prev`（如有）→ 按旧 live 启动 → 只做健康校验；旧版本也起不来会明确报错。
5. 成功后才写 `.deploy-stamp`。

多角色部署中，已经成功启动新版本的角色保持新版本（stamp 已写入）；失败角色和尚未启动的角色恢复旧版本。这样每个角色的 `.deploy-stamp` 始终与它实际运行的版本一致，不会出现“stamp 记新版本、进程跑旧版本”。只有本次部署确实备份过 `node_modules`（`npm ci` 路径）时才会恢复 `.prev`；上一次部署遗留的 `node_modules.prev` 不会在未安装依赖的失败部署里覆盖当前依赖。

磁盘占用：成功部署后保留一份 `server/dist.prev`、`web/dist.prev`；安装过依赖时还保留 `node_modules.prev`。因此部署后磁盘上大约有两份构建产物（以及两份 `node_modules`，后者通常远大于产物）。旧 `.prev` 在下次成功 `--swap` 时清理；`node_modules.prev` 在下次安装依赖前覆盖、或在下一次没有安装依赖的成功部署后清理。部署/构建失败时保留的 `.prev` 也可以手工用 `build.sh --rollback <repo>` 恢复。

Windows/macOS 的 Node 部署任务（`deploy/deploy-job.mjs`）使用 `deploy/deploy-lib.mjs` 里同一套 `swapDist` / `rollbackDist` / `node_modules.prev` 逻辑，行为与 shell 一致。Windows 上运行中的 node 进程可能锁住原生模块或文件，因此 Node 路径在安装依赖、重命名 `node_modules`、切换 `dist` 之前都会先停止实例；不要在服务运行时手工替换这些目录。

### make 快捷部署

`make` 是统一的启动/部署入口，所有目标都通过 Node 执行，Windows、Linux 和 macOS 都能用。Linux 上内部调用 `deploy/*.sh`（保留 systemd、flock、双实例逻辑），Windows/macOS 由 `deploy/cli.mjs` 用 Node 启动/停止，部署走 `deploy/deploy-job.mjs`。npm 脚本仍然保留。

Windows/macOS 上，`make start`、`make restart`、`make deploy`、`make deploy-lan` 默认把服务放在**当前终端前台**运行：stdout/stderr 同时打到窗口和 `<dataDir>/qubius.log`，Ctrl+C 或关闭窗口即停止；`make stop` 仍按 pidfile 从其它终端停止。输出不是 TTY（CI、重定向）或设置 `QUBIUS_BACKGROUND=1` 时退回后台 detached 启动。`make deploy-wan` 因为要在部署任务返回后应用公网入口，仍使用后台启动；Linux 的 systemd 管理路径不变。

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
- `make restart` 是显式重启：即使构建产物、HEAD、config/env 都没有变化，也会停旧进程并重新启动（Linux 会向 `start-all.sh --restart` 注入 `QUBIUS_DEPLOY_RESTART=1`），可用于恢复卡住进程或仅 shell env 变化后的状态；`make start` 则保持“无变化只做健康校验、不重启”。`start-all.sh --restart` 单独使用时同样受 `QUBIUS_DEPLOY_RESTART` 控制。
- 自动检测 systemd user unit：`qubius.service` 等已启用或运行中时用 `systemctl --user restart`，否则交给 `start-all.sh --restart`（本机模式会传 `QUBIUS_START_LAN=0`）。依赖变化（`node_modules` 缺失或 `package-lock.json` 变化）时会先停 unit 再 `npm ci`。
- 部署后检查 `/api/health`，存在构建 stamp 时校验 `head` 与 checkout 的 git HEAD；`deploy-lan` / `deploy-wan` 还会等待局域网端口监听。
- `deploy-lan` / `deploy-wan` 在结尾会把自动生成的 `<dataDir>/auth-token` 打印一次；页面部署则一次性显示在 `/deploy` 上。
- `deploy-wan` 需要 env 里已配置 `QUBIUS_EDGECTL_CONFIG`；计划里的差异和警告会先打印，确认后才应用。`QUBIUS_EDGE_YES=1`（或 `--yes`）跳过交互确认，`QUBIUS_EDGE_DOMAIN` 指定确认域名，`QUBIUS_EDGE_WAIT` 指定等待作业的秒数。启用访问令牌时从 `QUBIUS_AUTH_TOKEN` 或 `<dataDir>/auth-token` 读取。
- 手工执行时参与和部署页相同的 ops lock；部署页任务或公网入口作业进行中时会等待/失败。

### 忙碌保护：不静默打断正在工作的会话

停止或重启一个健康的实例之前，部署会读取 `/api/health` 的 `activeSessions`（排队、运行、等待确认的会话总数）：

- 没有进行中的会话 → 正常继续。
- `QUBIUS_DEPLOY_FORCE=1` → 跳过保护，强制重启（会中断这些会话）。
- `QUBIUS_DEPLOY_WAIT=<秒>` → 每 2 秒轮询，直到空闲或超时；超时以退出码 3 失败。
- Linux 上的交互终端（`make deploy*` 走 `deploy.sh` / `start-all.sh`）→ 询问 `[w]等待 / [f]强制 / [c]取消`，默认取消；选 `w` 时按 `QUBIUS_DEPLOY_WAIT`（未设置则 600 秒）等待。
- 非交互环境（页面部署、cron，以及 Windows/macOS 的 Node 部署任务）→ 直接失败并以退出码 3 结束，消息里写明还有几个会话。部署页会在状态卡里直接给出「强制重启」按钮，选中后带着本次任务的 `QUBIUS_DEPLOY_FORCE=1` 重试，不需要用户去改 env 文件。

修改端口时，检查范围同时包含新端口和上次部署实际使用的端口（记录在 `.deploy-stamp` 的 `port` 字段），避免旧端口上的会话被静默中断。被跳过的“无变化”部署不会触发忙碌保护，因为不会停止任何进程。

### 无变化时跳过重启

部署会为每个角色计算两件事：

- `build_needed`：构建产物是否落后于当前 git HEAD / 工作区（与 `start-all.sh` 的判定一致）。
- config/env 指纹：`${QUBIUS_CONFIG_DIR}/config.yaml`（副实例 `config-secondary.yaml`）和 `QUBIUS_ENV` 文件的 sha256。

每个角色在 `${dataDir}/.deploy-stamp` 原子记录 `head`、`configHash`、`envHash`。服务健康、无需构建、stamp 与当前值一致且未设置 `QUBIUS_DEPLOY_RESTART=1` 时，跳过构建和重启，只做健康校验，并照常应用局域网/公网入口。config 或 env 变化时即使不构建也会重启（监听地址、allowedHosts 等只在启动时读取）。页面部署在无变化时也不会先停掉当前进程，页面不会因此断线。字段说明见 `deploy/env.example`。

### 强制重启

`QUBIUS_DEPLOY_RESTART=1` 忽略“无变化”判定，始终重启；第一次部署或没有 stamp 时也会正常重启。部署页「更新 / 重新部署」按钮旁的「强制重启」会同时带上 `QUBIUS_DEPLOY_RESTART=1` 和 `QUBIUS_DEPLOY_FORCE=1`，忽略无变化并跳过忙碌保护（会中断进行中的会话），这两个开关只作用于本次任务、不写入 env；忙碌中止后的状态卡里也有同样的重试按钮。三个开关也都可以写在 env 文件里，或通过环境变量传给 `make deploy*` / 部署页任务。

## 页面部署与冷启动

配置目录里还没有 `config.yaml` / `config-secondary.yaml` 时，服务进入首次部署模式：打开 `/deploy` 会先进入分步向导，依次选择使用方式（仅本机 / 远程访问 / 主副双实例）、确认当前实例的 checkout、数据目录、端口和访问域名，双实例再补另一个实例的信息，最后确认并部署。向导会把当前运行的 checkout 和 git origin 作为默认值；归档等可选参数放在「高级选项」里，也可以随时切换到完整部署表单。

无论是向导还是完整表单，服务端都会写入实际生效的 env 文件和 `<configDir>/projects.yaml`（`configDir` 默认是当前 checkout 的 `.qubius/`）。Linux 按角色执行一次 `deploy/install.sh --force-config`，最后执行 `deploy/start-all.sh --restart`；Windows 和 macOS 由纯 Node 任务 `deploy/deploy-job.mjs` 完成等价的配置渲染、构建、停旧进程和启动，不依赖 bash/systemd/flock，见下面的平台章节。部署成功后向导会给出「进入 qubius」和「填写模型 API Key」两个下一步。任务日志在 `<configDir>/deploy.log`，状态在 `deploy.json`。

正常运行后也可回 `/deploy` 改配置并重新部署；部署页顶部的「重新部署」按钮会从向导第一步开始重新确认使用方式、目录和端口，当前配置作为预填值。「从 GitHub 更新并部署」则是不需要逐项确认的一键更新：服务端读取当前已保存的 env/配置，按原样重新部署，并在构建前拉取最新代码（`POST /api/deploy/update`）。拉取优先使用名为 `github` 的远端；没有时如果 `origin` 指向 github.com 就用 `origin`，否则回落到 `origin`。这个强制拉取只作用于本次任务，不会改动 env 里保存的 `QUBIUS_PULL_LATEST`。GitHub 版本比当前新时，按钮会显示目标版本号；进行中的会话会导致更新中止（不会打断会话），工作区有未提交改动或与远端分叉时更新也会失败并保留本地内容。`--force-config` 仅在内容有差异时用页面生成的内容覆盖已有配置，并备份 `*.bak.<时间戳>`；内容一致时保持原文件。

完整表单的「仓库」区块还有「部署前从远端拉取最新代码」选项（写进 `QUBIUS_PULL_LATEST`）。勾选后，部署任务会在构建前对每个启用的 checkout 执行 `deploy/pull-latest.sh`：从该 checkout 的远端 fetch 当前分支并只做 fast-forward 合并。默认远端是 `origin`；设置 `QUBIUS_PULL_PREFER_GITHUB=1`（一键更新会自动带上）时依次尝试：名为 `github` 的远端、指向 github.com 的 `origin`、部署页配置的 `QUBIUS_GITHUB_REPO`（没有则跳过）、最后的 `origin`；也可以用 `QUBIUS_PULL_REMOTE` 显式指定远端名。工作区有未提交改动、当前分支与远端分叉、或处于 detached HEAD 时部署会中止并保留本地内容，不会 `reset --hard`；需要手动合并后再重新部署。该选项拉取的是 checkout 配置的远端，不读取表单里的仓库 URL，也不使用其中的凭据。

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

Windows 没有 bash/systemd/flock，部署页改走 Node 任务 `deploy/deploy-job.mjs`（`server/src/deploy.ts` 按 `process.platform` 选择）。首次部署向导同样可用：会使用 `C:\...` 形式的路径占位符，提示需要 Node.js 22+ 和 git 在 PATH 中，并说明 Windows 不支持副实例同步/回滚和公网入口。

在页面点「保存并部署」时，服务端会打开一个新的终端窗口运行这个任务（`cmd /c start` + 临时 `.cmd` 启动器），不再以无窗口的后台进程执行：

- 窗口里先检查各实例端口：被运行中的 qubius 占用时不再在窗口里追问，部署页在提交前已经确认过是否停止当前实例（手机远程部署也能操作）；被其他进程占用时列出 PID 和命令，询问是否强制停止，拒绝就取消部署。
- 构建日志和 `deploy.log` 同时输出到窗口；构建完成、切换产物后，新服务在这个窗口前台启动，stdout/stderr 同时写入 `<dataDir>/qubius.log`。关闭窗口或按 Ctrl+C 会停止服务。
- 页面本身由旧实例提供，切换产物时会短暂断开；新服务启动后页面恢复，部署状态仍从 `deploy.json` 读取。
- 任务启动器写在系统临时目录（`qubius-deploy-<hash>.cmd`），不往仓库或配置目录里写脚本；非 Windows 平台和 `make deploy` 仍使用原来的后台启动方式。

它完成和 Linux 脚本等价的工作：

1. 读取 `<configDir>/env` 和 `projects.yaml`，为每个启用的角色渲染 `config.yaml` / `config-secondary.yaml`（旧文件内容不同时备份 `*.bak.<时间戳>`）。
2. 副实例目录缺失且启用了 `clonePeer` 时 `git clone`。
3. 勾选「部署前从远端拉取最新代码」或走一键「更新并部署」时，从各 checkout 的远端快进拉取当前分支：默认 `origin`，一键更新优先 GitHub 远端，没有时使用部署页配置的 GitHub 仓库（与 Linux 的 `deploy/pull-latest.sh` 语义一致）。
4. 与 Linux 一样用 staging 构建：需要安装依赖时先停旧进程并把 `node_modules` 备份为 `node_modules.prev`，再 `npm ci`；随后 server 用 `tsc --outDir dist.next`、web 先 `tsc --noEmit` 再 `vite build --outDir dist.next`，写 `server/dist.next/build.json`。不需要安装依赖时旧服务继续运行，live 完全不动。
5. 停止前再检查一次会话；停掉旧的服务进程（当前服务根据 server 传入的 PID 和 `process.argv[1]` 判断，其它实例按 `<dataDir>/qubius.pid`）。Windows 上 `process.kill` 是硬杀，所以 server 启动时会在 `<dataDir>/shutdown-token` 写一个随机令牌；部署任务先请求 `POST /api/internal/shutdown` 让它 flush 会话并优雅退出，15 秒未退出才强制结束。等端口释放后把 `dist.next` 原子切换为 live（旧产物留作 `.prev`），再启动 `node server/dist/index.js`。
6. 用 `/api/health` 校验端口、pid 和 `head`；失败时停止新进程、用 `.prev` 回滚、恢复 `node_modules.prev`，再启动旧版本。只有成功后才写部署 stamp。`QUBIUS_START_LAN=1` 且配置目录里有 `lan-proxy.credentials` 时顺带重启 `deploy/lan-proxy.mjs`。部署页勾选局域网入口会自动写入凭据，并在部署响应里一次性返回用户名/密码/访问令牌。
7. 终端模式（页面部署）下，成功后任务不退出，而是等前台的服务进程结束；窗口里能看到服务日志，关闭窗口即停止服务。回滚时旧版本也在该窗口前台拉起，失败信息会留在窗口里。

默认目录和 Linux 一致：配置、env、数据和日志都在当前 checkout 的 `.qubius/`（整个目录已 gitignore），不再使用 `%APPDATA%` / `%LOCALAPPDATA%`。`QUBIUS_CONFIG_DIR` 等 env 仍然优先。手工 `npm start` 时会自动读取 `.qubius/` 里的配置和 env，不需要额外设置 `QUBIUS_CONFIG`。

Windows 上**不支持**：systemd/logrotate/crontab 安装、公网入口（edge，依赖 edgectl 和 shell ops lock）、副实例的同步/回滚（`deploy/secondary.sh` 是 bash）、开机自启（请用任务计划程序）。部署页在一次部署进行中仍由 `deploy.job.lock` 和 `deploy.json` 串行化；Windows 不使用 shell 的 `ops.lock`。

### node-pty 补丁（关闭终端时的 AttachConsole 报错）

node-pty 1.1.0（当前 npm 正式版）在 Windows 上关闭终端时，`WindowsPtyAgent.kill()` 会 fork
`lib/conpty_console_list_agent.js` 去枚举控制台进程。shell 已经退出、或宿主进程没有控制台
（服务、计划任务、session 0）时，原生 `AttachConsole` 失败，agent 没有 try/catch，会以未捕获
异常退出并打印一整段栈。终端功能本身不受影响，只是日志噪音，外加一个要等 5 秒超时回收的子进程。

`tools/patch-node-pty.mjs` 在 `npm ci` 的 postinstall 阶段给已安装的
`node_modules/node-pty/lib/conpty_console_list_agent.js`（以及 `server/node_modules` 下的副本）
加上 `shellPid > 0` 判断和 `try/catch`，与上游 microsoft/node-pty 的修复一致。补丁是幂等的、
只改安装产物，不改依赖声明，也不需要重启服务；打补丁后源码会先通过语法校验再写入。

- 覆盖版本：1.1.0。`node-pty@1.2.0-beta.18` 已包含上游修复；升级到包含修复的正式版后，
  删除 `tools/patch-node-pty.mjs`、`tools/patch-node-pty.test.mjs` 和根 `package.json` 里的
  `postinstall` 即可。
- 文件内容无法识别（node-pty 升级导致实现变化）时只告警并跳过，不会让安装失败。如果日志里
  再次出现 `AttachConsole failed`，按新的 agent 内容更新匹配规则和测试。
- 手工补打：在仓库根执行 `node tools/patch-node-pty.mjs`。`--ignore-scripts` 会跳过补丁，但
  node-pty 自身也要靠安装脚本编译原生模块，所以本项目的安装本来就不支持 `--ignore-scripts`。
- `node_modules.prev` 回滚恢复的是上一次安装的依赖树。从更早版本升级后第一次部署如果回滚，
  旧树可能还没打过补丁；下次 `npm ci` 或手工执行上面的命令即可，不影响终端功能。

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
