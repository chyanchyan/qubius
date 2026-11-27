# qubius 参考手册

配置字段、会话行为、页面功能和 HTTP 接口的完整说明。入门请先看 [README](../README.md)。

## 配置

### config.yaml

- `listen` 只能是 `127.0.0.1` 或 `localhost`。
- `allowedHosts` 未配置时默认只允许 `127.0.0.1`、`localhost`、`[::1]`，防止 DNS rebinding；显式空数组会启动失败。只校验 `/api` 请求（静态资源不受限）。通过局域网、反向代理或公网域名访问时必须显式列出实际主机名，并保留 `127.0.0.1`（部署脚本的健康检查用）。部署页的「公网域名」由模板直接写进 `config.yaml`；「额外允许的访问域名」写进 env 的 `QUBIUS_ALLOWED_HOSTS`，启动时和这里的列表合并（配置文件里的显式列表保留，env 只追加），所以重新部署不会把额外域名冲掉。lan-proxy 会把 Host 改写成 `127.0.0.1:<port>`，edgectl 转发原域名。升级后如果公网入口突然 403，先在部署页「当前环境」看实际生效的列表。
- API 访问令牌可选：配置文件写 `auth: true`（或环境变量 `QUBIUS_AUTH=1`）后，未显式配置令牌时会在 `dataDir/auth-token` 生成一个；也可以直接设 `authToken` / `QUBIUS_AUTH_TOKEN`（16 到 512 个字符）。显式 `auth: false` 会关闭认证，即使环境里还留着令牌。所有 `/api` 请求要带 `X-Qubius-Token: <token>`、`Authorization: Bearer <token>` 或 `qubius_token` cookie，`/api/health` 豁免。令牌主要用于同机多用户或 Host 配置失误时的兜底；同一个系统用户下的进程本来就能读 `dataDir`。
- `terminal`：浏览器「命令行」页的开关，默认开启。写 `terminal: false`（或环境变量 `QUBIUS_TERMINAL=0`）后不创建 PTY，顶栏不显示入口，`/api/terminal` 返回 404；配置文件里的值优先于环境变量。
- `dataDir` 放会话、worktree、普通对话目录和密钥。默认是 `<configDir>/data`，即 `<checkout>/.qubius/data`（副实例在它自己的 checkout 里）；quickstart 和部署向导会把实际路径写进 env，重新部署不会再切到别的目录。部署时如果新数据目录与当前 `config.yaml` 不同、旧目录里还有会话，服务端会返回 409 要求显式确认，避免“重新部署后会话全没了”。
- `projects` 是白名单，可省略，页面不能提交别的路径。每个项目可写 `permission`：`default`（改动和命令需确认）、`acceptEdits`（工作区内自动通过，默认）、`plan`（只规划）、`auto`（模型判断不了时再确认）、`bypassPermissions`（全部允许）。**`acceptEdits` 只是降低误操作的启发式规则，不是沙箱**：工作区内的 `npm` / `make` / `curl` / `git -c ...` 等命令会直接执行，agent 也能先改 `package.json`、`Makefile` 再执行；对不可信仓库请改成 `default`，或用专用系统用户 / 容器运行。页面改过的级别存在 `dataDir/project-permissions.json`，优先于配置文件。非 git 目录可写 `isolated: true`，每个对话使用 `<path>/<对话 id>` 独立子目录，不建 worktree，可并行。
- `projects[].worktree`：git 项目的 worktree 准备。`include` 把主检出里存在且被 `.gitignore` 忽略的文件/目录复制到新 worktree（tracked、不存在或未忽略的跳过并记 warning）；仓库根的 `.worktreeinclude` 每行一个相对路径，空行和 `#` 注释忽略，会和 `include` 合并。`sharedDirectories` 为已存在且被忽略的目录在 worktree 同路径建立符号链接（Windows 用 junction），不复制大目录。`setup` 在 worktree 目录里用 shell 执行，默认超时 300 秒（`setupTimeoutSeconds`，范围 1–3600）；非 0 退出或超时会让对话创建失败并清理 worktree。所有路径必须是仓库内的相对路径，绝对路径和 `..` 会被拒绝。`.worktreeinclude` 由仓库内容控制，可能把主检出的 gitignored 文件复制进 agent 工作区；只对可信仓库使用。新建、分叉以及归档恢复时真正新建的 git worktree 都会执行准备；已经存在的目录不会重复执行。
- 主页的「管理项目」可以在运行期添加或删除本机已有的 git 仓库：服务端校验目录后写入额外项目文件（`QUBIUS_PROJECTS_FILE`，未配置时是 `<configDir>/projects.yaml`），项目列表立即更新；之后手工修改该文件也会热加载，都不需要重启实例。也可以「新建仓库」：填仓库名称和母目录（不含仓库名），服务端在 `<母目录>/<仓库名称>` 建目录、`git init -b main` 并提交一个空初始提交（保证能直接建会话 worktree），再写入项目文件。仓库名称可按规则压成项目 id（小写字母、数字、连字符），压不出时（例如纯中文）生成 `repo-<8 位十六进制>` 兜底 id。母目录必须已存在，目标目录不能已存在。额外文件里的同 id 项目覆盖 `config.yaml` 里的定义；`config.yaml` 自带的项目和内置「普通对话」只能在配置文件里改，不能在这里删除。
- 「普通对话」是内置项目 `chat`，始终排在项目列表第一位，目录为 `<dataDir>/chat`，每个对话在 `<dataDir>/chat/<对话 id>` 下运行，归档时只删该子目录。自己定义 `id: chat` 会覆盖内置入口。
- `maxConcurrent`：同时进行的对话数，默认 4，超出排队。这里只作为设置文件的初始默认值；之后在页面「设置」里改「并发上限」，保存后立即生效，不需要重启或重新部署。
- `limits`：`transcriptBytes`（单会话序列化总字节，默认 8388608）、`transcriptMessages`（消息条数，5000）、`messageText`（单条正文，200000）、`requestBodyBytes`（JSON 请求体，28000000）、`historyPage`（详情首帧/历史翻页条数，200）。可用 `QUBIUS_LIMIT_TRANSCRIPT_BYTES`、`QUBIUS_LIMIT_TRANSCRIPT_MESSAGES`、`QUBIUS_LIMIT_MESSAGE_TEXT`、`QUBIUS_LIMIT_REQUEST_BODY`、`QUBIUS_HISTORY_PAGE` 覆盖；超出范围或非正整数时启动报错。这里只作为设置文件的初始默认值；之后在页面「设置 → 高级限制」修改，保存后立即生效，不需要重新部署。
- `approvalTimeoutMinutes`：等待确认（提问/授权）的超时，默认 10 分钟，范围 0–1440，超时自动拒绝。户外使用可调大；设为 0 表示一直等待，不自动拒绝，界面上也不显示倒计时。部署向导会写进 `QUBIUS_APPROVAL_TIMEOUT_MINUTES`，配置文件没写时也生效。这里只作为初始默认值；之后在页面「设置」修改，保存后对新的确认立即生效。
- 局域网入口：部署页的「启用局域网入口」写 `QUBIUS_START_LAN` / `QUBIUS_LAN_USER`，凭据写到 `<configDir>/lan-proxy.credentials`（一行 `user:password`，`0600`）。密码只在部署响应的 `oneTime.lan` 里返回一次；`GET /api/deploy` 只返回用户名和 `lanAuthPasswordSet`。命令行 `make deploy-lan` 缺凭据时会自动生成并在终端打印一次。
- `role`：`primary`（默认）或 `secondary`。副实例需要 `secondary.primaryRepo`；`secondary.primaryRef` 默认 `main`。
- `archive`：`dir` 是归档根目录，`retentionDays` 是会话列表的保留天数（作用于本机 SSD 副本），默认 30，到期后会话归档到这里（冷存储）并永久保留；`archive.instance` 默认主实例 `main`、副实例 `bak`。不配置则不归档、不自动删除旧会话。`retentionDays` 只作为初始默认值，之后可在页面「设置」修改；归档目录本身仍由部署配置决定。

### 访问令牌（可选）

适合多用户主机，或作为 Host 白名单配置失误时的兜底。注意同一个系统用户下的进程本来就能读 `dataDir`，令牌不能防住它；它防的是其他本地用户、浏览器里的 DNS rebinding 和误暴露的代理入口。

在 `$QUBIUS_CONFIG_DIR/env` 里启用（推荐，`0600`，不进仓库）：

```bash
QUBIUS_AUTH=1
# 或者显式指定；至少 16 个字符
# QUBIUS_AUTH_TOKEN=<openssl rand -hex 32 的输出>
```

只写 `QUBIUS_AUTH=1` 时，首次启动会在 `dataDir/auth-token`（默认 `.qubius/data/auth-token`）生成令牌：

```bash
cat .qubius/data/auth-token
curl -H "X-Qubius-Token: $(cat .qubius/data/auth-token)" http://127.0.0.1:8787/api/settings
```

浏览器页面遇到 401 会弹出「需要访问令牌」输入框，并显示令牌文件路径；保存后写入 `localStorage` 和同源 cookie。登录后到 `/deploy` 的「当前环境」点「显示当前访问令牌」，或在「设置 → 访问令牌」里修改/清除。`GET /api/config/token` 只在令牌启用时可调用（调用方本身已通过令牌校验），返回当前令牌、来源和文件路径；`/api/health` 始终免令牌，只返回 `authRequired` 和 `authTokenFile`（路径，不含令牌）。lan-proxy 会剥离 `Authorization`，所以浏览器请求用 `X-Qubius-Token` 或 cookie，不用 Bearer。

### 模型接口与设置

页面「设置」里可保存多套接口，每套有名称、类型、地址、API key 和该地址上的多个模型名。开对话时选择一套接口、一个模型，再选 effort（`low` / `medium` / `high` / `xhigh` / `max`）。密钥写入 `dataDir/secrets.json`（权限尽量 `0600`），读取接口会返回保存的密钥明文，设置页的输入框默认以圆点隐藏，点眼睛按钮可以查看原文。

接口类型有两种。**Anthropic 兼容**（默认）：地址作为 `ANTHROPIC_BASE_URL` 传给 Agent SDK。**Gemini**：只填 Gemini API key 和模型名；服务端在本机回环地址起一个适配服务，把 Anthropic Messages 请求翻译成 Gemini 原生 `generateContent`（含流式响应、工具调用、图片和 token 用量），再把结果翻译回 Anthropic 格式。Gemini 地址会自动补 `/v1beta`，一般保持默认的 `https://generativelanguage.googleapis.com`。修改接口类型或地址时，留空的密钥会沿用原来的值，不需要重新填写。

qubius 不维护自己的代理设置：服务端和 Agent SDK 子进程都原样继承服务进程的 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 等环境变量。Node 22.21+ 下服务端内置 `fetch` 靠 `NODE_USE_ENV_PROXY` 开关生效，qubius 启动时如果没设置会自动补成 `1`（显式设为 `0` 可让服务端请求忽略代理环境变量）。出站路由完全由机器或部署环境决定，需要按目标域名分流时由本机/内网的代理路由统一处理；没有配置代理时直接连接。Gemini 适配层、「测试」和「查询余额」的服务端请求也遵循同一套环境变量。旧设置文件里的 `proxy` 字段和每套接口的 `systemProxy` 字段会被忽略，下次保存设置时清除。

每套接口可填四个可选价格（输入、输出、缓存读、缓存写，美元/百万 token）；填了之后「总览」按 token 估算成本，留空只显示 token。每套接口的「测试」按钮会发一条最小请求验证地址、密钥和模型名，不回显密钥。

设置里可配「并发 / agent 上限」（1–256，默认取 `config.yaml` / `QUBIUS_MAX_CONCURRENT`，未配置时为 4）。同一个值控制两件事：同时进行的对话数，超出的对话排队；顶栏左上角「运行中 / 上限」里的 agent 上限。保存后立即生效，调高后排队中的对话马上开始，调低不会打断正在运行的对话。除了设置页，顶栏的这组数字本身也可以直接点击：点击后原地展开输入框，填 1–256 的整数，回车或「保存」立即生效，Esc 或「取消」收起；不需要进入设置页，也不会弹出对话框。

设置里还可以修改以下运行参数，保存后都不需要重启或重新部署；`config.yaml` / 部署环境里的同名配置只作为首次启动的默认值：

- 「确认超时」：等待提问/授权多久自动拒绝（0–1440 分钟，0 表示一直等待），对保存后新出现的确认生效，已经挂起的确认保留原时限。
- 「归档保留天数」：会话在本机保留多少天后归档到冷存储（1–3650 天）；未配置归档目录时不生效，保存后下一轮整理（最多 1 小时）按新天数判断。
- 「高级限制」：单会话总字节、单会话消息条数、单条消息字符数、请求体字节数、历史分页条数。新请求按新的请求体上限处理，旧会话在下次加载或保存时按新的条数/字节上限收敛。

顶栏左上角显示所有对话里正在运行的 agent 总数/上限：运行中的主 agent 各算一个，运行中的子 agent 也各算一个；等待确认或只剩后台子 agent 的主 agent 不计入。超限用警告色提示（只用于显示，不阻止 agent 启动）。计数右侧显示所有 agent 当前输出速度的合计（tokens/s，按流式增量估算的最近 2 秒平均值），没有输出时隐藏。主 agent 按流式增量累加；SDK 不下发子 agent 的流式增量，子 agent 的正文、思考和工具输入只能整块到达，服务端按字符估算后摊到这一块生成的时间里再计入窗口，因此显示的是它这一块的平均速度。速度只在服务端估算，不扫描历史正文。

## 会话机制

git 项目每次新建对话会执行 `git worktree add`，目录固定为 `<dataDir>/worktrees/<项目 id>/<对话 id>`（不能放进仓库，git 不允许 worktree 嵌套）。分支名是 `qubius/<对话 id>`；旧会话仍沿用 `qoder/<对话 id>` 或 `remote-coder/<对话 id>`，提交、推送、恢复和删除继续兼容。SDK 的 `cwd` 指向 worktree，`projectConfigRoot` 指向项目主检出，主目录的 `.claude/` 和 MCP 仍生效。

非 git 目录同时只能有一个进行中、排队或等待确认的对话；`isolated: true` 的项目不受限。

每个对话是一条 Claude Agent SDK 会话，主代理可把互不依赖的子任务交给并行子 agent。页面根据 `task_started`、`task_progress`、`task_notification` 显示子任务并计算状态：

- **排队**：等待并发槽位。
- **进行中**：当前轮还在跑，或还有未结束的子 agent。
- **本轮完成**：主结果成功，且没有失败或仍在跑的子 agent。
- **已停止**：用户在轮次中主动停止，不算失败；已完成的对话不会被关闭空闲进程改写成停止（旧版本遗留的错误状态会在启动读取时恢复）。
- **失败**：主结果错误，或子 agent 失败且主回合已结束。
- **等待确认**：工具碰到工作区外路径，或模型提问。

对话页的子任务列表默认收起，标题显示完成数/总数。展开后每一行显示状态、最近工具、累计 token 和运行时间（运行中每秒续算）；再点开某一行会显示它的完整记录：提示、思考、工具调用和结果。记录来自 SDK 落盘的 sidechain transcript，运行中每 2 秒刷新，服务端只返回尾部最近一部分；进程刚启动、旧记录已被清理或服务重启后读不到时显示占位文案。子 agent 的正文、思考和工具输入同样计入顶栏的总输出速度：SDK 只下发完整消息，服务端按块估算并均摊到它生成的时间里。

输入区可切换工作流：普通、`prl`（并行开发 + 一对一评审）、`ser`（串行开发 + 一对一评审）、`plan`（只出计划和独立评审，不改代码）。工作流在 prompt 真正执行时生效，不因排队提前切换。详情页输入框上方有进度条，折叠显示阶段/当前子任务/用时，展开显示各单元的开发、评审状态和修复轮次；子任务 description 用 `[wf:prl:1/4:dev]` 这类标签关联单元。也可在消息末尾直接写 `prl` / `ser` / `plan`。

权限默认 `acceptEdits`：工作区内的读、改、搜索和 Bash 自动通过，工作区外需要允许或拒绝。Bash 是否放行靠 `server/src/permissions.ts` 里的命令文本启发式判断（检查字面路径是否越界），**不是操作系统级沙箱**：`sh script.sh`、`npm run ...`、`make ...`、`curl -d @.env ...` 这类命令会直接执行，脚本内容和 Makefile 不会被检查。只要仓库内容、网页或依赖里藏着提示词注入，就可能在当前用户权限下执行任意代码、外传数据。处理不可信内容时请把项目权限改成 `default`（每条 Bash 都确认），并建议用专用系统用户或容器运行，不要在该用户下放 SSH key、云凭据和浏览器 cookie。已开始的一轮要等下一条消息才换级别；提问在任何级别下都会等待回答。授权框的「本对话内允许这个工具」会在当前进程内记住该工具，重启或归档后失效，提问不套用。

同一对话可随时切换接口、模型和 effort，下一轮生效，上下文保留；只改变之后的模型调用，不改历史。运行时在轮间检测配置变化并重启底层 query（`resume` 接上上下文）。只改同一套 Anthropic 兼容接口的地址或 key 不会重启已有对话，需要新开对话、重启服务，或换到另一套再切回；Gemini 接口由本机适配层在每次请求时读取最新配置，改完立即生效。

归档对话会 `git worktree remove` 并删除分支；`isolated` 项目删自己的子目录。服务重启时仍在跑的对话会标成失败，提示再发消息继续（SDK `resume`）；「继续上次」就是发送一条“继续”。

每条用户消息可以回滚、编辑重发或分叉，前提是对话当前没有在运行、排队或等待确认，也没有正在运行的后台任务：

- **回滚到这条消息之前**：删除这条消息及其后的所有记录，回到发送它之前的状态。气泡旁的内联面板里可以勾选「同时回滚代码改动」：勾选后借助 SDK 文件检查点，把 agent 通过编辑工具改过的文件恢复到这条消息之前；检查点只覆盖编辑工具写的文件，不覆盖 Bash 命令直接改的文件。对话进程存活时勾选项显示为可用，但只有升级后新开、且这条消息有检查点时才能真正回滚代码；否则勾选执行会报错，此时可以只回滚对话。回滚后输入框为空时会自动填回原消息文本，方便修改后重发。
- **编辑并重新发送**：点气泡就地编辑，点「保存并重发」后气泡旁一次给出三个去向：分叉新会话、当前对话重发、回滚代码并重发。分叉时在新对话里重发、原对话不变；后两项回滚这条消息及之后的记录，再用编辑后的文本发送，其中「回滚代码并重发」还会恢复 agent 改过的文件（不可用时按钮禁用并给出原因）。原消息里的图片会保留，不重复上传。
- **分叉新对话**：新建一个独立对话，保留这条消息及之前的全部内容，父对话不受影响。git 项目会从父对话分支的最新提交新建独立 worktree 和分支，父对话未提交的改动不会带过去；非 git 的 `isolated` 项目新建独立子目录。分叉出的对话处于「本轮完成」状态，直接发消息即可继续。

只有升级后发送的消息带 SDK 标记才支持这些操作，更早的消息不显示菜单，服务端也会拒绝。回滚丢弃的消息从会话记录里移除，旧的 SDK transcript 在回滚时立即删除；图片等资源到删除对话时才清理。回滚和分叉用 SDK 的会话分叉复制上下文，不改动父对话；回滚到第一条消息之前时从空白上下文重新开始。

### 后台任务与下载进度

agent 用 Bash 的 `run_in_background` 启动下载、安装等耗时命令后，详情页会出现「后台任务」栏：默认收起，标题行汇总任务总数以及运行中、已完成和失败的数量；点开后逐条显示状态、用时、进度百分比（能从输出解析时）和最新一行输出，单条展开后显示输出尾部和总字节数；运行中的任务可停止。页面可见时每秒轮询一次，隐藏时暂停，切回后补拉。

正在前台运行的 Bash 工具行有「转到后台」按钮（等价 Ctrl+B），转入后由任务栏显示进度。agent 的约定是耗时命令用 `run_in_background` 启动并保留进度输出（如 `curl -#`、`wget` 默认进度），不要在 agent 里反复轮询汇报；后续步骤依赖该命令时，等它结束后检查输出和退出码再继续。

后台 shell 任务不表示会话仍在推进：主轮结束即「本轮完成」，不会因为还有后台命令在跑而显示「进行中」，也不计入顶栏的 agent 并发，不参与 `prl` / `ser` / `plan` 的单元进度。

限制：进度取决于命令是否输出百分比（`curl -sS` 会关掉）；只能读取输出最后 8 KiB（超出时标记截断）；query 进程结束时后台任务随之结束并标为「已停止」（服务重启、切换配置或用户停止都算）；输出按纯文本显示。

会话相关接口：

- `GET /api/sessions?q=<关键词>`：全部项目的会话；搜索标题、摘要和正文。
- `PATCH /api/sessions/<id>`：改名、置顶，或改 `providerId` / `model` / `effort`。
- `POST /api/sessions/<id>/messages`：body `{ prompt, images?, workflow?, interject? }`。`interject: true` 是插话，立即交给正在跑的 agent；缺省是排队，当前轮结束后再执行。
- `GET /api/sessions/<id>/queue/<promptId>`：读取未被取走的排队消息完整正文，用于编辑。
- `PATCH /api/sessions/<id>/queue/<promptId>`：body `{ text }`，改写排队消息正文（消息还没写进对话记录）。
- `POST /api/sessions/<id>/queue/<promptId>/send`：现在发送，提前放行这条排队消息。
- `DELETE /api/sessions/<id>/queue/<promptId>`：删除未被取走的排队消息（只从队列移除，对话记录里本来就没有它）。
- `GET /api/sessions/<id>/git`、`POST /api/sessions/<id>/git`（`commit` / `commit-push` / `push`）。
- `GET|POST /api/sessions/<id>/diff-comments`：读取或新建 diff 行级评论；`PATCH|DELETE /api/sessions/<id>/diff-comments/<commentId>` 修改/删除单条，`DELETE /api/sessions/<id>/diff-comments` 清空。评论存在 `<dataDir>/diff-comments/<对话 id>.json`。
- `GET|POST /api/sessions/<id>/pull-request`：读取或创建当前分支的 GitHub PR / GitLab MR。依赖本机已登录的 `gh` / `glab`；创建前会校验会话分支并 `git push -u origin HEAD`（不 force），body `{ title, body, base? }`。
- `GET|POST /api/projects/<id>/multi-model-groups`：读取或保存多模型对比分组；`DELETE /api/projects/<id>/multi-model-groups/<groupId>` 删除一组。分组存在 `<dataDir>/multi-model-groups.json`，每个项目最多 20 组。
- `GET /api/sessions/<id>/tasks/<taskId>/output`：后台任务输出尾部，返回 `output` / `totalBytes` / `truncated`；会话没有活跃进程时 409。
- `POST /api/sessions/<id>/tasks/background`：body `{ toolUseId }`，把正在前台运行的 Bash 转到后台，返回 `{ ok, backgrounded }`。
- `POST /api/sessions/<id>/tasks/<taskId>/stop`：停止后台任务，返回 `{ ok }`。
- `GET /api/sessions/<id>/subagents/<taskId>`：子任务的 sidechain transcript，返回 `entries`（提示、正文、思考、工具调用与结果）和 `truncated`；记录不存在时 404。
- `POST /api/projects`：body `{ id, name, path, permission? }`，加入本机已有的 git 仓库；立即生效并写入额外项目文件，不需要重启。
- `POST /api/projects/new`：body `{ name, parent, permission? }`，在母目录 `parent` 下新建 `<parent>/<name>` 目录，`git init -b main` 并提交空初始提交后加入项目列表；母目录不存在、目标目录已存在或项目 id 冲突时返回 4xx。
- `GET /api/deploy`：部署表单、实际配置文件/env 路径，以及 `current`（当前生效的 `dataDir`、`allowedHosts`、令牌来源/文件、归档、终端开关、局域网入口状态）。表单里的 `lanAuthPassword` 永远为空，只用 `lanAuthPasswordSet` 表示已设置。`POST /api/deploy/apply` 成功时返回 `{jobId, oneTime}`：`oneTime.lan` 含局域网用户名、密码和访问地址，`oneTime.authToken` 是部署后生效的令牌，只在这次响应里出现一次。
- `POST /api/deploy/update`：不需要 body。按当前已保存的 env/配置重新部署，只在本次任务强制构建前拉取最新代码（依次尝试 github 远端、配置的 GitHub 仓库、`origin`），不会把强制开关写回 env。成功返回 `{jobId, oneTime?}`，busy/residual 与 `apply` 相同的结构化 409；还没有部署配置时返回 400。
- `POST /api/deploy/github-repo`：body `{ repo }`，把 GitHub 镜像地址（`owner/repo` 或完整 GitHub URL，空串表示自动识别）写入实际生效的 env 文件，只改这一个键，不重启服务；保存后版本对照立即使用新值。返回 `{ ok, repo }`（归一化后的 `owner/repo` 或空串）；格式不正确返回 400，部署任务运行中返回 409。
- `POST /api/deploy/lan-credentials/reset`：body `{ user? }`，立即生成新密码并写 `<configDir>/lan-proxy.credentials`；如果当前实例的局域网入口在运行，响应发出后会自动重启它（systemd unit 或 pidfile 进程）。返回 `{ ok, lan: { user, password, urls, restart: "scheduled"|"none", restartMethod, restartNote } }`，`restartNote` 会说明是否已重启、是否需要重新登录。
- `POST /api/deploy/auth-token/reset`：立即生成 64 位十六进制令牌并切换到运行中的服务端；旧令牌保留 60 秒宽限，避免在途请求 401。新令牌持久化到 env（`QUBIUS_AUTH=1`、`QUBIUS_AUTH_TOKEN`），当前来源是 auth-token 文件或 config.yaml 时同步更新；返回 `{ ok, token, source, file?, restartNeeded: false, note }`，`note` 明确写“无需重启”。
- `GET /api/config/token`：当前访问令牌，未启用时 404；启用时调用方本身已通过令牌校验。`GET /api/health` 额外返回 `authRequired` 和 `authTokenFile`（只含路径）。
- `POST /api/settings/test`：测试接口配置；`POST /api/settings/balance`：查询一套已保存配置的剩余余额（目前支持 DeepSeek；Gemini 等没有余额接口时返回 `supported: false` 和说明）；`GET /api/usage`：用量与成本。

会话变更防抖写入 `dataDir`；单条正文最多 200k 字符，每会话保留最多 5000 条、序列化后 8MB，超限先丢最旧的非用户消息。SIGTERM 时把未落盘的会话 flush 到磁盘（有界重试）。

## 页面功能

### 项目页与总览

项目页（`/projects/<id>`）列出该项目的对话，底部输入框可直接发起新对话：

- 提交后停留在项目页，新对话立即出现在列表；点列表项才进详情。本轮完成显示绿色对勾，其余状态是彩色圆点。
- 新建对话立即用用户首条消息的原文做标题（取第一行、折叠空白、最多 40 字，只发图片时显示「新对话」）；首个成功轮次结束后，服务端让 agent 根据用户请求和助手最终回复总结一个更贴合结果的标题，自动替换它。用户在这之前手动改过名则以手动标题为准；总结失败不改变会话状态，下一次成功轮次会再试。
- 有对话等待提问或授权时，回答表单直接展开在该行下方，不用进详情。
- 每行右侧显示最近一轮的运行信息：运行中显示已运行时长（每秒刷新，主轮结束但子 agent 收尾时继续计时），结束后显示结束时间（当天只显示时分）。
- 首页（`/`）每个项目左侧的灯表示是否有对话正在进行：排队/进行中/等待确认时闪烁绿点，无则灰点；项目目录不可用时红点（优先）。实时更新。

「总览」把所有项目的对话放在一页：

- 按「等待确认 / 进行中与排队 / 失败与已停止 / 最近完成」分组，置顶在最前。
- 搜索标题、摘要和正文（服务端搜索，没打开的对话也能搜到）。
- 每行可直接改名、置顶/取消置顶或进入详情；等待确认的对话在行下方直接展开回答表单。
- 底部是按接口分组的 token 和成本汇总，再列出最耗用的对话。

详情页工具条可改名、置顶、导出和「继续上次」。输入框上方自上而下依次是工作流/子任务进度条、当前改动（Diff）和排队消息面板：对话正在跑时 Enter 默认排队，当前轮结束后依次执行；`Ctrl+Enter`（macOS 上 `Cmd+Enter`）插话，立即交给正在跑的 agent。每条排队消息可以「现在发送」、编辑或删除（触摸端长按发送按钮等同插话，队列条目上的按钮常驻）。排队消息只显示在输入框上方的排队面板里，不占据对话记录的位置；轮末被 agent 真正取走时才写进消息记录，并接着显示它自己的回复。删除只从队列里移除；排队消息全部处理完后不会继续停在“排队”。发送时先在本地渲染并标「发送中」，服务端确认后换成正式条目，失败则撤回并把内容放回输入框。「导出 Markdown」保存用户、助手、工具、thinking 和图片链接。

对话空闲时，可回滚的每条用户消息点气泡即可编辑，下方同时显示「⋯」菜单，提供回滚到这条消息之前、编辑并重新发送和分叉新对话（行为见[会话机制](#会话机制)）。回滚/分叉/重发前的选择在气泡旁的内联面板里完成，不弹阻塞式对话框，点面板外或按 Escape 收起；点编辑框外的区域会直接取消编辑。当前对话回滚重发时面板里有「同时回滚代码改动」勾选项；回滚后输入框为空时会自动填回原消息文本。旧版本发送的消息没有 SDK 标记，不显示这些操作；对话运行中、排队、等待确认或有后台任务正在运行时也会隐藏。

### 附件、语音、定时任务

输入框支持图片和文本附件：

- 可点附件按钮或直接粘贴图片，一条消息最多 4 张。支持 JPEG、PNG、GIF、WebP；长边先缩到 1568px，GIF 原样发送（≤5MB）。
- 图片存在 `<dataDir>/images/<对话 id>/`，会话 JSON 只留引用，归档时一起删除；图片接口只允许当前会话记录过的 id。
- 可只发图片；摘要显示 `[图片 ×N]`。没有文字时标题先占位成「新对话」，首个成功轮次结束后由 agent 根据对话内容总结。
- 文本附件最多 3 个，单文件 100KB、合计 150k 字符，支持常见文本和代码扩展名；发送前内联进消息，不单独存盘。
- 模型是否接受图片取决于接口和模型；不支持时接口错误照常显示在对话里。

麦克风按钮使用 iPhone Safari 自带语音识别（Web Speech API，iOS 14.5+），不需要密钥：按住说话，松开后把结果接在输入框内容后面。页面必须是 HTTPS；需在系统设置里打开「Siri 与听写」，识别联网走 Apple 服务。从主屏幕以「独立网页」打开时不支持，请在 Safari 标签页使用；不支持的浏览器（如桌面 Firefox）按钮禁用。

项目页的「定时任务」按固定间隔自动新建对话，每个任务保存 prompt、接口、模型、effort 和间隔（5 分钟–7 天）：

- 到点像手动开对话一样创建独立 worktree/目录，跑完就是普通对话，可继续、改名或归档。
- 任务存在 `<dataDir>/schedules.json`，随 `dataDir` 备份；服务重启后继续计时。
- 每轮失败写入 `lastError`，下次运行时间照常后推，避免每 30 秒重试。「立即运行」只在启用时可用，运行中不能重复触发。
- 项目或接口配置被删除后，任务在下一次运行时记录错误，需要到页面停用或删除。
- 接口：`GET|POST /api/projects/<id>/schedules`，`PATCH|DELETE /api/projects/<id>/schedules/<sid>`，`POST .../<sid>/run`。

### 命令行

「命令行」页（`/terminal`）在浏览器里打开开发机的交互式 shell：

- 顶栏「命令行」进入。新连接默认在运行服务的用户主目录启动 `$SHELL`（不可用时退回 `/bin/bash`）；在项目的会话列表页点「命令行」时，shell 改在该项目配置的仓库路径（`projects[].path`）下启动，页面 meta 会显示实际目录。是真实 PTY：`vim`、`top`、`Ctrl-C`、彩色输出和窗口尺寸自适应都正常。
- 每个浏览器连接对应一个独立 PTY；离开页面、刷新或点「重连」会结束旧 shell 并新开一个（不保留上次的目录和历史）。同时最多 4 个命令行，超出的连接提示后关闭。
- 传输用普通 HTTP：`GET /api/terminal/<id>/stream` 是 SSE 输出，输入和尺寸用 POST。没走 WebSocket，是因为公网和局域网入口都套了 HTTP Basic 认证，而 Safari 在 WebSocket 握手时不带缓存的 Basic 凭据；改成普通请求后 iPhone 上也能用，lan-proxy 也不需要额外转发 Upgrade。
- 鉴权与 `/api` 完全一致：Host 白名单、跨站拦截、访问令牌（cookie `qubius_token` 或 `X-Qubius-Token`）都照常校验，创建、输入和输出流都要通过；失败时页面提示连接中断。
- **命令行就是运行服务那个系统用户的完整 shell**，能读 `dataDir` 里的 API key 和整台机器。只通过可信入口（Caddy Basic 认证、SSH 隧道，或启用了访问令牌的局域网）暴露；不要把未加认证的端口直接放到公网。不需要时用 `terminal: false` 或 `QUBIUS_TERMINAL=0` 关闭。
- shell 继承服务进程的环境变量，但会按名字脱敏凭据：只处理 `QUBIUS_`、`REMOTE_CODER_`、`EDGECTL_` 前缀的变量（不区分大小写），前缀之后的名字只要包含 `TOKEN`、`SECRET`、`PASSWORD`、`PASSWD`、`API_KEY`、`CREDENTIALS`、`COOKIE` 任一片段就剔除，避免一条 `env` 就把凭据显示在屏幕上；其它前缀或无前缀的变量（如 `GITEA_TOKEN`、`ANTHROPIC_API_KEY`）照常保留。脱敏只避免 `env` 输出被误显示，不改变命令行能直接读 `<configDir>/env`、`dataDir` 里令牌和密钥这一事实。
- 输出带背压：浏览器读得慢（手机网络差、标签页被节流）时，服务端发送缓冲超过 1 MB 就暂停读取 PTY，排空后再继续，`yes` 或 `cat` 大文件不会撑爆服务端内存。
- `node-pty` 没编译成功时只有这个页面不可用，会显示「终端不可用」，其它功能不受影响。

### 技能页

「技能」页（`/skills`）按来源域管理磁盘上的 Claude Code 技能：

- 用户级：`<CLAUDE_CONFIG_DIR>/skills`（默认 `~/.claude/skills`）。
- 项目级：每个项目主检出的 `.claude/skills`；worktree 和隔离目录的会话也从这里读，和 `.claude/` 其他配置一致。
- 插件：`<CLAUDE_CONFIG_DIR>/plugins` 下插件自带的技能，只读。

可以查看 SKILL.md、启用/停用、编辑已有技能，或在用户级/项目级新建技能（写入 `<域>/<名字>/SKILL.md`，frontmatter 必须有 `name` 和 `description`）。停用不删除文件，只把技能从 SDK 的 `skills` 过滤列表里去掉；开关存在 `<dataDir>/skills.json`，对下一轮或新对话生效（进行中的 query 会在下一条消息前重启）。插件技能只能切换可见性，不改插件文件。

只列出磁盘上的技能，Claude Code 内置技能不在这个页面里。接口：`GET /api/skills`、`GET|PUT|PATCH /api/skills/<域>/<名字>`、`POST /api/skills`。

### Git、用量、推送

git 项目的每个对话是独立分支（新会话 `qubius/<对话 id>`，旧会话 `qoder/<对话 id>` 或 `remote-coder/<对话 id>`）。详情页「Git」可查看分支、是否干净和改动文件，填信息后提交，或「提交并推送」（`git push -u origin HEAD`），也可只推送已有提交。只允许在会话自己的分支操作，且要等本轮结束；agent 在跑时返回 409。没有 `origin` 只能提交；推送失败的输出会抹掉 URL 里的用户名密码。

会话列表和详情页把分支名放在标题左侧、与标题同一行，不额外占一行高度（缩写成 `qubius/<uuid 前 8 位>`，完整名字在悬停提示里）；总览页在标题下方的副行里显示分支名。

`GET /api/usage` 汇总所有对话的 token：

- 总调用次数，以及输入、输出、缓存读、缓存写 token。
- 按接口分组；填了价格时同时给出估算成本（美元）。
- 按对话列出 token 和成本，总览页展示前十条。
- 归属按会话**当前**的接口计算；中途换过接口时，之前的 token 也归到新接口和新价格。

价格只是按所填单价的算术，不含订阅额度、折扣或汇率。

设置页每套配置的「查询余额」会用已保存的密钥调用服务商的余额接口：DeepSeek 调用 `GET https://api.deepseek.com/user/balance`，显示总余额、充值和赠送金额；Gemini 和 Anthropic 官方接口没有余额查询，按钮只提示到各自控制台查看。查询不需要重启，结果只在页面里显示，不落盘。

页面是 PWA，对话每轮结束（完成或失败）以及停下来「等待确认」时可给手机发系统推送；用户主动停止不推送。推送只跟「本轮结束」走，后台子 agent 稍后完成不会再单独推送。等待确认的标题是「项目名 · 等待确认」，正文是问题首行或需要授权的工具名和路径；默认 10 分钟不回会自动拒绝（可在「设置 → 确认超时」调大，设为 0 则不自动拒绝、不显示倒计时）。

- 「设置 → 推送通知」里开启并允许权限；订阅存在 `dataDir/push/subscriptions.json`，最多 20 台设备。
- VAPID 密钥在首次打开设置页或首次推送时生成到 `dataDir/push/vapid.json`，备份 `dataDir` 时要一起备份；删掉后每台设备需重新开启。
- 推送正文端到端加密后交给浏览器厂商的推送服务，服务端不依赖第三方账号。
- 点击通知打开对应对话；「发送测试通知」验证整条链路，返回 `sent` / `failed`。
- 页面必须 HTTPS。iPhone 需 iOS 16.4+，先在 Safari「添加到主屏幕」，再从主屏幕图标打开；Safari 标签页收不到。权限被拒后需到 iOS 设置里重新允许。
- 从主屏幕「独立网页」打开时语音输入不可用，两边的推送订阅互不影响。
- 同一对话的推送用 `tag` 互相替换，等待确认和完成/失败共用一个 tag，后到的替换前一条。
- 接口：`GET /api/push`、`POST /api/push/subscriptions`、`DELETE /api/push/subscriptions`（`{ endpoint }`）、`POST /api/push/test`。浏览器返回 404/410 的失效订阅自动删除。

### Diff 评论、PR/MR 与多模型对比

- **Diff 评论**：详情页「Diff」面板按文件/行留言，可以标记解决、编辑或删除；每个会话最多 200 条，正文最多 2000 字。点「发送给 agent」会把所有未解决评论拼成一条带文件和行号的 prompt 发给当前对话，不会自动把评论标记为已解决。评论存在 `<dataDir>/diff-comments/<对话 id>.json`；删除会话或归档清理本地副本时会一并删除。
- **PR/MR**：Git 面板使用本机已登录的 `gh`（GitHub）或 `glab`（GitLab），qubius 不保存托管平台 token。创建前会先校验 HEAD 是会话分支（`qubius/`、`qoder/` 或 `remote-coder/`），再普通推送（不 force）；面板显示 state、mergeable 和 checks。GitHub 返回检查明细；GitLab 从 `head_pipeline`/`pipeline` 读取 pipeline 状态，没有 pipeline 时 checks 为空。开启「监视」后，页面可见时每 30 秒刷新一次，状态或检查变化时提示；失败检查可以一键把摘要发给 agent。CLI 未安装/未登录时只影响这个面板。
- **多模型对比**：输入区下方「多模型」可以选 2–4 个接口/模型/effort 组合；git 项目每个组合创建一个普通对话（各自独立 worktree），非 git/isolated 项目各自独立目录。只有全部创建成功才清空草稿。对比记录存在服务端 `<dataDir>/multi-model-groups.json`，每个项目最多 20 组，跨设备可见；对比面板里的状态和成本通过 `GET /api/projects/<id>/sessions` 和 `GET /api/usage` 读取。

### CLI 与 MCP

- CLI：`node tools/qubius.mjs`。支持 `project list`、`session list/show/create/send/wait/stop`、`schedule list/run`；`--json` 输出 JSON，`--prompt -` 或文本参数 `-` 从 stdin 读。服务地址和令牌用 `QUBIUS_URL` / `QUBIUS_TOKEN`（也支持 `QUBIUS_AUTH_TOKEN`、`QUBIUS_TOKEN_FILE`）。
- `session wait` 每 2 秒轮询一次，默认 600 秒超时；`completed` 退出 0，`needs_input` 退出 2，超时退出 3，失败/停止/其它错误退出 1。
- MCP：`node tools/qubius-mcp.mjs` 是 stdio MCP server，提供 `qubius_project_list`、`qubius_session_list/create/send/wait/show` 工具。请直接用 `node` 启动；通过 `npm run qubius:mcp` 启动时，npm 的条幅会写到 stdout，可能污染 MCP 协议流。

## 归档和保留期

配置 `archive` 后，会话列表不会无限保留。归档根目录必须对运行服务的用户可写：

```bash
sudo mkdir -p /archive/qubius
sudo chown "$(id -un):$(id -gn)" /archive/qubius
```

- 到期前 7 天先做快照（只复制、不删除），最晚不晚于第 23 天：SDK 默认 30 天清理 transcript，`retentionDays` 很长时也不能等到临近到期才快照。`retentionDays <= 7` 时最多提前 1 天（`= 1` 时快照与删除同一步）。
- 快照时点按 Claude Code 默认 `cleanupPeriodDays = 30` 计算；改小它需相应提前快照。
- `retentionDays` 只作用于会话列表（本机 SSD 副本）：超过这个天数后，先确认归档完整（meta 里每个文件 sha256 校验通过），再删除会话 JSON、图片、worktree/独立目录和 transcript。
- 冷存储（`archive.dir`）里的归档不按天数清理，只有手动永久删除才会消失。
- 布局：`<archive.dir>/<instance>/` 下 `sessions/<id>.json`、`sessions/<id>.meta.json`、`images/<id>/`、`sdk/projects/...`、`sdk/session-env/<id>/`。
- 快照只在 HDD，不出现在项目页归档列表；SSD 会话到期后才显示。手动归档后也会出现在归档列表。
- 手动归档（界面「归档」；API 仍是 `DELETE /api/sessions/<id>`）会先冷备份（已配置 `archive` 时），校验通过再删除 SSD 副本；归档副本保留，直到在归档面板永久删除。冷备份或删除失败时中止并保留会话，可修复后重试。未配置 `archive` 时「归档」是真删。
- 冷备份完成但本机副本没删掉时（常见原因：worktree/目录被会话里的终端或后台进程占用），归档 meta 会标记为待清理：会话仍留在列表里，归档面板显示「待清理」和「重试清理」按钮。重试只补做没完成的步骤，不会重新复制整份归档。`git worktree remove` 删一半（注册项已消失、目录还在）时按已注销处理，直接递归删目录。
- git 项目的会话列表里，分支标签用绿色底色表示该分支已经合入 main（没有 main 时依次退回 master、`origin/main`、`origin/master`）：分支 tip 是基准分支的祖先即算合入，ttb / ttbm 收尾后都成立。分支创建后从未提交过代码时显示蓝色底色（tip 仍等于分支 reflog 里的创建提交），表示它停在基准分支上、没有可归档的改动，归档不会丢掉任何代码。状态来自 `GET /api/projects/<id>/merge-status`（`base` / `merged` / `untouched`），页面每 20 秒刷新一次。
- 「全部归档」确认弹窗里有「仅归档已合入 main 的会话」勾选项，默认勾选，只归档分支已合入基准的会话，包括从未改过代码的（蓝灯）分支；未合入的会话保留。取消勾选会归档其余所有可归档的会话（包括未合入的）。运行中（排队 / 进行中 / 等待确认）的会话始终保留，不参与「全部归档」。勾选项只对能找到基准分支的 git 项目显示；找不到 main 时弹窗会明确提示将归档全部可归档的会话，非 git 项目同样只跳过运行中的会话。
- 归档面板可查看、恢复和永久删除。恢复先校验所有文件，再把会话、图片和 transcript 写回 SSD。
- 恢复时重建 cwd：git 会话重建 worktree/分支（分支不在时从当前 HEAD 新建），隔离会话重建 `<项目目录>/<对话 id>`。路径只从当前配置推导，不使用归档 JSON 里的旧 cwd；之前的未提交改动不会恢复。
- 同名会话还在、项目已从配置移除、项目目录不存在、或正在归档/清理时返回 409。
- 未配置 `archive` 时 `status` / `sessions` 返回 `enabled: false`，详情、恢复、删除归档和整理返回 503。
- 接口：`GET /api/archive/status`、`GET /api/archive/sessions?projectId=<id>`、`GET /api/archive/sessions/<id>`、`POST /api/archive/sessions/<id>/restore`、`DELETE /api/archive/sessions/<id>`、`POST /api/archive/sweep`（202，用 status 的 `sweeping` 判断结束）。
