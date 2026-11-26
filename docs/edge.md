# 公网入口（edge）

部署页（`/deploy`）的「公网入口」区块用于查看和修改 qubius / co-qubius 两个站点的 edgectl 配置。它只移植 qubius 需要的必要能力：读取现有 `edgectl.yaml`、生成可直接审阅的变更计划、在用户确认公网域名后应用，并把整个作业的状态和日志落到配置目录。

命令行可以用 `make deploy-wan`（或 `deploy/deploy.sh wan`）走完全相同的 plan → 确认 → apply 流程；也可以单独运行 `node deploy/edge-deploy.mjs --port <端口> --yes`。非交互环境必须显式加 `--yes`，否则命令会拒绝应用。

## 目标与范围

- qubius 部署页可以配置公网入口，不必手工编辑远端 `edgectl.yaml`。
- 部署机上存在可用的 `edgectl` 时，可以切换为外部 CLI 执行；没有时使用内置 native 实现（native apply 已接线）。
- qubius 只负责注册表里自己的两个站点条目，不接管 edgectl 的其它用途。

不在范围内：

- 不执行本地网关的 `apply-local` / 提权操作，只在页面展示需要执行的命令。
- 不迁移 compose、systemd unit 等无关配置。
- 不自动管理 DNS。域名的 A 记录仍需手工配置。

## 唯一事实来源：`edgectl.yaml`

服务端只认一个 `edgectl.yaml`，它是公网入口配置的唯一事实来源。

- 解析分两类：`EDGECTL_*`、provider 等 edge 自身变量只从 `<deployConfigDir>/env`（优先）和启动 qubius 进程的环境变量（兜底）读取；`QUBIUS_ENV` 和 `<checkout>/deploy/env` 不会单独被 edge 读取，它们只有在启动前已经导出到进程环境时才影响 edge。部署表单派生出的端口、公网域名和启动开关（desired / upstream）则跟随部署配置的同一来源（`QUBIUS_ENV` > `<deployConfigDir>/env` > `<checkout>/deploy/env`），与 `/deploy` 页面一致。因此只写在仓库级 `deploy/env` 里的 `QUBIUS_EDGECTL_CONFIG` 不会被页面读取或展示（写回时原样保留），对 edge 自身也不可见；请把它写进 `<deployConfigDir>/env` 或在启动进程环境里导出。
- 来源优先级：env 文件 > 进程 env。同一个来源内再按 `QUBIUS_EDGECTL_CONFIG` > `EDGECTL_CONFIG` 解析。因此 `<configDir>/env` 里的 `EDGECTL_CONFIG` 会压过进程 env 里的 `QUBIUS_EDGECTL_CONFIG`；不要把变量名前缀误当成跨来源的全局优先级。
- env 文件里 edge 键的值如果包含未展开的 `${...}`，按 parse 级错误处理：该键被忽略、记录错误，然后尝试进程 env 兜底。这与“显式 `QUBIUS_EDGECTL_BIN` 不可用就禁用 provider”不是同一语义：parse 级回退会继续寻找其它来源，而显式坏 BIN 会直接禁用。
- 两个变量值都必须是绝对路径。
- 浏览器不能提交、覆盖或探测配置路径；API 不使用请求里的路径参数。
- 解析后路径为空时，「公网入口」返回不可用状态，页面只显示配置提示。

所有权边界：

- qubius 只**编辑**注册表里 `qubius` / `co-qubius` 两个条目；其它站点（例如 `example`、`remote-coder`）在注册表中只读，qubius 不会修改它们的字段。
- 但 provider 不是逐条应用：外部 `edgectl apply-vps` 会用**整份注册表**重渲染整个托管块，所以 plan 的 `remoteDiff` 覆盖整个托管块，而不只是 owned site。
- 因此不能承诺“只改 owned site 的托管块”。如果 plan 发现非 owned 站点在远端 diff 中发生变化，会返回可确认的 blocking warning（`requiresConfirmExisting`）；这是“需要确认后才能继续”，apply 带 `confirmExisting` 即可继续，不是永久禁止。
- 不要给 `apply-vps` 传只含 owned site 的临时配置：那会按临时注册表重渲染，从而删除其它站点。
- 托管块之外的注释和无关区块不由 qubius 主动改写；但整块重渲染仍可能改变托管块内的排版，plan 必须如实展示。

## 配置变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `QUBIUS_EDGECTL_CONFIG` | `edgectl.yaml` 绝对路径；同一来源内优先于 `EDGECTL_CONFIG` | 空 |
| `EDGECTL_CONFIG` | 兼容的外部变量；同一来源内 `QUBIUS_EDGECTL_CONFIG` 为空时使用 | 空 |
| `QUBIUS_EDGECTL_BIN` | 外部 `edgectl` 可执行文件路径，必须是绝对路径（相对路径视为不可用）；留空时依次从 `PATH` 和 `$HOME/edgectl/.venv/bin/edgectl` 查找 | 空 |
| `QUBIUS_EDGE_PROVIDER` | `auto` / `cli` / `native` | `auto` |
| `QUBIUS_EDGE_PLAN_TIMEOUT_MS` | plan 子进程预算（毫秒） | `90000`；前端 plan 请求超时为 120s（`120000`） |

provider 选择和失败语义：

- `QUBIUS_EDGECTL_BIN` 必须是绝对路径。解析顺序是 `QUBIUS_EDGECTL_BIN` > `PATH` > `$HOME/edgectl/.venv/bin/edgectl`。相对路径、不存在或不可执行会让 `GET /api/edge` 的 `available=false`；`--version` 握手发生在 plan/apply，不在 GET（GET 的 available 只反映可执行性）。握手失败时直接报错，不会继续尝试 `PATH` / venv，也不会选 native。
- `QUBIUS_EDGE_PROVIDER=cli`：edgectl 不可用或 plan/apply 握手失败时直接报错，不回退 native。
- `auto`（默认）：只有在**未显式设置** `QUBIUS_EDGECTL_BIN` 时，找不到可用 edgectl（含握手失败）才回退 native；一旦显式设置了 BIN，plan/apply 握手失败会报错，绝不回退 native。
- `QUBIUS_EDGE_PROVIDER=native`：native apply 已接线，按内置实现执行候选校验、备份、原地写和 reload。
- edge.json 会记录本次使用的 provider 和 `planHash` 供审计；但 provider 实际是**每次 plan/apply 按当前环境解析**的。`auto` 可能随 edgectl 可用性变化而解析到不同 provider；plan 会显示 resolved provider，provider 与已有计划不同时需要重新 plan。

## 架构

### 注册表（site registry）

注册表描述 qubius 认识并管理的 site：id（`qubius` / `co-qubius`）、期望的公网域名、期望的 upstream、`env: dev`、`auth: dev`、`sse: true`。

- upstream 不写死：它从服务端解析到的 `QUBIUS_PRIMARY_PORT` / `QUBIUS_SECONDARY_PORT`（`<deployConfigDir>/env` 优先，进程 env 兜底）派生为 `http://127.0.0.1:<port>`（scheme 也可以按 edgectl 惯例省略，这里统一写全）。
- `deploy/env.example` 中的 8787 / 8788 只是默认值，不代表任何具体部署；plan 和 apply 以实际 env 为准。
- desired 条目只在该站点的启动开关为真时生成：`QUBIUS_START_PRIMARY` 控制 `qubius`，`QUBIUS_START_SECONDARY` 控制 `co-qubius`。停用的角色不生成新的 desired 条目；注册表里已有的旧条目保留并给出 warning，不会自动删除。
- 计划阶段用注册表和 `edgectl.yaml` 的现状做 diff，并标出缺少、冲突或超出所有权的条目。

### provider

两种 provider 输出相同的 plan 和状态模型，区别只在 apply 的实现。

**cli**

- 使用外部 `edgectl`；每次都显式传 `--config <绝对路径>`，不依赖 edgectl 自己的默认路径。
- plan/apply 时做 `--version` 握手确认二进制可用（GET 不握手）；再执行 `validate --strict` 校验候选配置。
- 应用使用 `apply-vps --yes`。它按整份注册表重渲染托管块，因此 plan 的 `remoteDiff` 覆盖整个托管块。
- `QUBIUS_EDGECTL_BIN` 显式指定路径时只用该路径：路径不可用会直接报错，不回落 `PATH`；未指定时依次从 `PATH` 和 `$HOME/edgectl/.venv/bin/edgectl` 查找。

**native**

- 移植 VPS 托管块、splice、冲突检测和本地 Caddyfile 生成。
- 不移植 compose / systemd unit 相关逻辑。
- native apply 已接线：对候选配置校验、备份远端文件、原地写入，然后 reload。
- `writtenNotActive`（已写入但未生效）会触发 validate live + reload 重试一次。重试仍失败时：只有远端已漂移或读失败（`remoteSha` 不等于 expected）才保存 unknown 快照；若文件仍是 expected 的 live-invalid / reload-failed，不产生 unknown 快照，只保留远端 `.bak` 与本地候选注册表。

### plan

- `GET /api/edge`：读取状态、resolved provider、配置路径是否就绪、owned site 概览，以及上次失败留下的 `lastFailure`（含备份/unknown 文件与 `remoteSha`，用于预填 restore）。
- `POST /api/edge/plan`：生成变更计划，内容包括注册表 diff、远端 diff（脱敏后）、warnings 和 `planHash`。
- `remoteDiff` 覆盖整个托管块，不只 owned site；如果非 owned 站点会发生变化，必须返回 blocking warning。
- 远端 diff 只展示将要变化的字段，敏感值（密码、token、私钥等）在返回前脱敏。
- `planHash` 绑定本次计划的输入和目标；apply 必须回传同一个 `planHash`，防止应用过期的计划。

### apply

- `POST /api/edge/apply`：携带 `planHash` 和用户输入的 `confirmDomain`。
- 服务端校验 `planHash` 与当前计划一致、`confirmDomain` 与目标站点期望的公网域名一致。
- 如果目标 site 已经存在且内容不同（不是单纯补空），或计划里非 owned 站点会发生变化，还需要额外的 `confirmExisting`（`requiresConfirmExisting`）才会继续，避免意外覆盖。
- 应用在 detached edge 作业里执行；请求返回后可以继续轮询状态。
- 状态写入 `<configDir>/edge.json`，日志写入 `<configDir>/edge.log`（`configDir` 即 `deployConfigDir`，通常是 `QUBIUS_CONFIG_DIR`）。edge 作业不写 `deploy.json`，避免和页面部署状态混用。

### restore

- `POST /api/edge/restore` 的 body 是 `{backup, remoteSha, confirmDomain}`。
- `remoteSha` 是**当前远端 Caddyfile 的 sha**，用于确认恢复所基于的现场；它必须与恢复时读到的远端文件一致。
- `backup` 只允许 `edge-backup-*.Caddyfile` 或 `edge-unknown-*.Caddyfile`，不接受任意路径。
- `GET /api/edge` 暴露 `lastFailure`（备份/unknown 文件与 `remoteSha`），页面用它预填 restore。
- native 失败时结果里的 `backupPath` 是远端 `.bak`，不在 restore 接受的 `edge-backup-*` / `edge-unknown-*` 范围内；这种 `.bak` 只能人工恢复，或使用失败时产生的 unknown 快照（若存在）。
- 恢复沿用校验、写入和 reload 流程；reload 失败进入 reload 重试（validate live + reload，最多 1 次）。

### 状态

`edge.json` 记录作业 id、provider、阶段/状态、`planHash`、时间戳和结果摘要；`edge.log` 追加执行细节。页面以这两个文件为准展示进度和错误，日志在展示前同样脱敏。

## 权限与安全

- 配置路径、provider、edgectl 二进制路径都只来自服务端 env 解析（`<deployConfigDir>/env` 优先，进程 env 兜底），客户端无法指定。
- 不执行 `apply-local`；页面只显示用户需要手工执行的命令（本地网关仍需手动/提权）。
- SSH 调用必须使用 `BatchMode`，避免卡在交互式密码或主机指纹提示。
- 错误信息、diff、日志都做脱敏：不显示 Basic 认证密码、token、私钥或完整凭据。
- 注册表层面非 owned 站点只读；但 apply 会整块重渲染，plan/diff 必须覆盖整个托管块，并在非 owned 站点变化时给出 blocking warning，不能假装只影响 owned site。
- CLI 的远端写入顺序是：备份远端文件 → 写入候选内容 → `caddy validate` → 失败时恢复备份 → reload。写入前的前置 `validate --strict` 是对候选配置的校验，不是替换后的验证。
- reload 重试为 validate live + reload，最多 1 次。

## 失败与恢复

应用阶段会重新读取远端文件并比较 hash，按以下规则处理：

- 远端当前 hash `== old`：说明远端没被别人改动，按计划继续。
- 远端当前 hash `== expected`：说明目标内容已在远端。
  - cli：不再视为纯 no-op；显式执行 validate live + reload，确保文件已是目标但运行配置尚未更新时也能生效。
  - native / restore：执行 validate live + reload。
  - 以上 reload 失败时进入 reload 重试（validate live + reload，最多 1 次）；CLI 在 `== expected` 和写入成功后都适用。
- native apply 的 `writtenNotActive`（已写入但未生效）会自动执行 validate live + reload 重试一次。重试仍失败时只有“远端已漂移/读失败”（`remoteSha` 不等于 expected）才保存 unknown 快照；若文件仍是 expected 的 live-invalid / reload-failed，不产生 unknown 快照，只保留远端 `.bak` 与本地候选注册表。
- 其它情况（远端在计划后发生变化）：**不覆盖**。把远端内容保存为 unknown 文件并停止作业，等待人工确认。

人工恢复步骤：

1. 重新读取远端当前文件的 sha，确认外部改动是否符合预期。
2. 基于新内容重新生成计划；不要直接重放旧 `planHash`。
3. 需要写入时，先把远端文件再备份一次，然后 `validate --strict`。
4. 校验通过后再替换并 reload；reload 失败时进入 reload 重试（validate live + reload，最多 1 次），仍失败则保留现场并停止。

也可以直接用 `GET /api/edge` 的 `lastFailure` 预填 `POST /api/edge/restore`（body `{backup, remoteSha, confirmDomain}`，见「restore」）。

任何情况下都不允许「自动覆盖未知改动」。

## 锁协议概要

- `ops.lock` / `ops.meta` 按 `deployConfigDir` 串行化 edge 作业和应用部署（app-edge 互斥）。
- 使用 `flock` 加锁；`ops.meta` 记录持有者 token、pid、时间等，用于识别残留锁。
- 进程已退出但锁文件残留时，可以识别为 stale；强制回收必须由用户输入固定短语 `RECLAIM`，不能静默抢占。
- 同一个 site 必须使用同一个 `deployConfigDir`，否则无法与 app-edge 正确互斥。

限制：

- NFS 等不支持 `flock` 的文件系统上锁协议不可靠，不要在网络文件系统上跑 edge 作业。
- 外部直接 unlink / replace `ops.lock` 的行为不受支持；请走页面提供的回收流程。
- cleanup 终止 `start-all.sh` 时可能造成短暂的服务空窗。

## Phase A / B / C 范围

- **Phase A**：服务端解析 edge 配置和 provider，提供 `GET /api/edge` 与 `POST /api/edge/plan`；完成托管块的候选渲染和 parity 检查（确认渲染结果与远端受管块可比对），部署页展示现状、计划 diff 和 warnings，不写远端。
- **Phase B**：cli provider 的 `POST /api/edge/apply`，包括 `--config` 显式传递、`--version` 握手、`validate --strict`、`apply-vps --yes`、整份注册表 diff / 非 owned 站点的 blocking warning + `confirmExisting`、作业状态和锁协议；部署页提供完整的「公网入口」交互。
- **Phase C**：native provider 的 apply（已接线）：内置 VPS 托管块 / splice / 冲突检测 / Caddyfile 生成，以及候选校验、备份、原地写、reload、`writtenNotActive` 重试（仅远端漂移时产生 unknown 快照）；compose 与 systemd unit 始终不在移植范围。native apply 本身不提权；这里说的“可选本地提权”仅指页面生成需要用户手工 `sudo` 执行的 `apply-local` 命令或脚本，由用户决定是否运行，服务不会自动提权或静默执行。

## 测试

自动测试：

```bash
npm test                # server 单元/HTTP 测试
npm run test:deploy     # test-lib + test-install + test-locks + test-start-all + ops-lock.test
```

- 服务端测试覆盖 env 解析、路径只来自服务端、provider 显式失败语义、plan/apply/restore 参数校验（`planHash`、`confirmDomain`、`confirmExisting`、`backup`、`remoteSha`）、脱敏和失败语义。
- `test:deploy` 只验证部署脚本、环境模板和 ops lock 语义，不读写真实 edgectl 配置，也不触碰真实 systemd/crontab/服务。

## 手工验收

1. 准备一份包含非 owned 站点和注释的测试用 `edgectl.yaml`。把 `QUBIUS_EDGECTL_CONFIG` 和 `QUBIUS_PRIMARY_PORT` / `QUBIUS_SECONDARY_PORT`（非默认值，例如本机的 8789 / 8790）写进 `<deployConfigDir>/env`，或在启动 qubius 的进程 env 里导出。确认 plan 里的 upstream 是 `http://127.0.0.1:8789` / `http://127.0.0.1:8790`，而不是默认的 8787 / 8788。
2. 来源优先级：在 `<deployConfigDir>/env` 里写 `EDGECTL_CONFIG`，同时在进程 env 里导出指向另一文件的 `QUBIUS_EDGECTL_CONFIG`；应使用 env 文件里的 `EDGECTL_CONFIG`。再从 env 文件删掉该变量并重启，进程 env 里的 `QUBIUS_EDGECTL_CONFIG` 才会生效。
3. bin 解析：不设 `QUBIUS_EDGECTL_BIN` 时确认能从 `PATH` 或 `$HOME/edgectl/.venv/bin/edgectl` 找到；显式设置但指向不可用文件时应直接报错。
4. provider 显式失败演练：`QUBIUS_EDGE_PROVIDER=cli` 且 edgectl 不可用时应直接报错；`QUBIUS_EDGECTL_BIN` 指向不存在/不可执行的文件时应报错；`auto` + 无效的显式 `QUBIUS_EDGECTL_BIN` 也应报错。
5. 启动 qubius，打开 `/deploy` →「公网入口」，确认能读到配置路径和两个 owned site；清空 env 后应显示不可用提示。停用 `QUBIUS_START_SECONDARY` 后确认 `co-qubius` 不生成新的 desired 条目，注册表里的旧条目保留并给出 warning。
6. 生成计划：确认 `remoteDiff` 覆盖整个托管块，非 owned 站点变化时有 blocking warning，warnings 合理，返回值里有 `planHash`。
7. 用错误的域名或旧 `planHash` 调 apply，应被拒绝；已有不同条目或非 owned 站点变化但未传 `confirmExisting` 时也应被拒绝。
8. `== expected` 演练：在远端内容已是目标、但运行配置尚未刷新时再次 apply，确认 CLI 显式执行 validate live + reload；reload 失败时最多重试 1 次。
9. 用正确域名、`planHash` 和必要的 `confirmExisting` 应用，观察 `<configDir>/edge.json` 与 `edge.log`；应用前后确认其它站点和注释保持不变，diff 只出现在预期位置。edge 不应写 `deploy.json`。
10. 失败演练：在 apply 前手工改动远端文件，模拟 `unknown` 分支，确认作业停止且不覆盖；按「失败与恢复」流程重新读取 sha、备份、validate、reload。
11. restore 演练：制造失败后从 `GET /api/edge` 的 `lastFailure` 取预填值，调用 `POST /api/edge/restore` 传 `{backup, remoteSha, confirmDomain}`；确认只接受 `edge-backup-*.Caddyfile` / `edge-unknown-*.Caddyfile`，`remoteSha` 与当前远端 Caddyfile 的 sha 不一致时拒绝。
12. native 演练：`QUBIUS_EDGE_PROVIDER=native` 时确认 apply 执行候选校验、备份、原地写和 reload；模拟 `writtenNotActive` 确认 validate live + reload 重试一次。重试失败时验证：只有远端漂移/读失败才产生 unknown 快照；live-invalid / reload-failed 只保留远端 `.bak` 与本地候选注册表，不产生 unknown。
13. 锁演练：并发触发两个作业，确认按 `deployConfigDir` 串行；伪造残留 `ops.lock`，确认只有输入 `RECLAIM` 才能回收。
14. provider 演练：分别用 `auto` / `cli` / `native` 观察 plan 显示的 resolved provider；改变 edgectl 可用性后 `auto` 的解析结果会变化，旧 `planHash` 不能继续 apply，需要重新 plan。`edge.json` 记录 provider / `planHash` 供审计。
