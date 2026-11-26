# 备份与恢复

`deploy/backup.mjs` 把 qubius 的配置、env、数据目录和（默认）会话归档复制成一个可校验的**目录快照**；`deploy/restore.mjs` 校验快照后再恢复。两者都只用 Node 内置模块和仓库里的 `yaml` 包，Windows、macOS、Linux 通用。

备份是普通目录而不是 tar，方便直接查看、增量拷贝和用系统工具再打包。

## 快速使用

```bash
# 停止服务后备份（默认输出到 $HOME/qubius-backups/qubius-YYYYmmdd-HHMMSS）
make stop
make backup

# 恢复：先停服务，再指定备份目录
make stop
make restore BACKUP=/path/to/qubius-backup
make start
```

- `make backup` 使用默认目录；要指定输出目录，用 `node deploy/backup.mjs --to /path/to/backup`。
- `make restore BACKUP=<备份目录>` 等价于 `node deploy/restore.mjs <备份目录>`。
- 不加 `BACKUP=` 直接执行 `make restore` 只会打印用法，不会恢复任何内容。

## 备份内容

| 来源 | 内容 |
|---|---|
| 配置目录 | `config.yaml`、`config-secondary.yaml`、`projects.yaml`、`lan-proxy.credentials`（存在才备份） |
| env 文件 | 实际被读取的 env 文件（`<configDir>/env`、旧布局 `<repo>/deploy/env` 或显式 `QUBIUS_ENV`），快照内统一存为 `config/env` |
| 数据目录 | `sessions/`、`secrets/`、`auth-token`、`push/`、`skills/`、`images/`、项目文件和其他运行期数据 |
| 归档目录 | 配置文件的 `archive.dir` 内容（默认包含，`--without-archive` 排除） |

默认排除：

- `data/worktrees/`（工作区可能很大，且可由 git 重建；`--with-worktrees` 可包含）
- 运行期状态文件：`qubius.pid`、`lan-proxy.pid`、`shutdown-token`
- `*.log` 日志文件
- `node_modules/`、`dist/`、`.git/` 目录
- 符号链接（备份时跳过并在终端提示，避免把链接目标或环带进来）

清单按**文件**记录，空目录不会进入 `manifest.json`，恢复后也不会重建这些空目录。需要保留空目录时请放一个占位文件。

如果 `archive.dir` 位于 `dataDir` 内（或 `dataDir` 位于归档目录内），两者会递归重叠；备份会跳过归档并打印警告，避免同一批文件被备份两次。归档放在 `configDir` 下是允许的，因为配置只按固定文件名备份，不会重复。

## 路径来源

进程环境变量优先，其次读取 env 文件（只解析，不执行）。env 文件按以下顺序取第一个存在的：

1. 进程显式设置的 `QUBIUS_ENV`；
2. `<configDir>/env`；
3. `<repo>/deploy/env`（兼容旧布局）。

| 变量 | 默认 |
|---|---|
| `QUBIUS_REPO_DIR` | 脚本所在 `deploy/` 的上一级；可用来指向其他 checkout |
| `QUBIUS_CONFIG_DIR` | `<repo>/.qubius` |
| `QUBIUS_ENV` | 未设置时按上面的顺序找 env 文件 |
| `QUBIUS_SECONDARY` | `0`；设为 `1` 时按副实例处理 |
| `QUBIUS_DATA_PRIMARY` / `QUBIUS_DATA_SECONDARY` | 数据目录显式覆盖（按角色选择） |
| `QUBIUS_ARCHIVE_DIR` | 未设置时读配置文件的 `archive.dir`（相对 configDir 解析） |
| `QUBIUS_PRIMARY_PORT` / `QUBIUS_SECONDARY_PORT` | `8787` / `8788`（健康探测端口） |
| `QUBIUS_BACKUP_DIR` | `$HOME/qubius-backups`（默认备份根目录） |

数据目录优先级：`QUBIUS_DATA_PRIMARY`（副实例为 `QUBIUS_DATA_SECONDARY`）→ 配置文件 `dataDir`（相对 configDir）→ `<configDir>/data`。备份和恢复使用同一套解析，避免备份到 A、恢复到 B。

恢复时优先用快照里的 `config/env` 决定角色、数据目录和归档目录，保证数据落点与即将写回的 env 一致；进程环境变量仍然优先。快照里的 env 会写回当前解析出的 env 路径（旧布局写到 `<repo>/deploy/env`，显式 `QUBIUS_ENV` 写到该路径），当前没有 env 时写到 `<configDir>/env`。因此异机/灾备恢复后 `QUBIUS_DATA_PRIMARY`、端口、令牌等配置不会丢失。

副实例（`QUBIUS_SECONDARY=1`）使用 `config-secondary.yaml`、`QUBIUS_DATA_SECONDARY`，默认探测端口 `8788`。

备份目标是 `${QUBIUS_BACKUP_DIR}/qubius-YYYYmmdd-HHMMSS`，可用 `--to DIR` 覆盖。备份目录本身及其 `config/`、`data/`、`archive/` 子目录权限都会收紧到 `0700`（不支持 POSIX 权限的平台忽略）。

## 备份布局与校验

```text
qubius-20261127-101500/
├── config/config.yaml
├── config/env
├── data/sessions/…
├── data/secrets/…
├── data/auth-token
├── archive/…
├── manifest.json
└── manifest.sha256
```

`manifest.json` 记录格式版本、创建时间、角色、是否在线备份、是否包含 worktrees/归档、源路径（含数据目录来源），以及每个文件在快照内的相对路径、大小和 SHA-256。`manifest.sha256` 是 `manifest.json` 本身的 SHA-256。

备份过程会先复制、再重新计算每个文件的哈希并与源文件比对；任何一步失败都会删掉半成品目录并以非零状态退出。

## 在线备份的限制

默认会探测 `http://127.0.0.1:${QUBIUS_PRIMARY_PORT}/api/health`（副实例用 `QUBIUS_SECONDARY_PORT`）：

- 服务未运行：正常备份。
- 服务正在运行：拒绝备份，提示先 `make stop`，或加 `--online`。
- `--online`：允许运行中备份，但终端会明确提示**数据可能处于变更中**。这适合临时快照，不适合作为一致性备份；需要可靠备份时请先停服。

## 恢复语义

```bash
node deploy/restore.mjs <backup-dir> [--force]
# 或
make restore BACKUP=<backup-dir>
```

1. 校验 `manifest.sha256` 与 `manifest.json` 一致，再逐个校验文件大小和 SHA-256；任何不一致都拒绝恢复，当前数据不会被触碰。
2. 拒绝绝对路径、盘符、`..` 和空路径段，只允许 `config/`、`data/`、`archive/` 三个前缀；备份里的符号链接和越界路径会被拒绝。
3. 默认要求服务未运行（同一健康探测）。服务在运行时拒绝恢复；`--force` 可强制继续。
4. 把将被替换的 `configDir` / `dataDir` / `archiveDir` 改名成 `<path>.pre-restore.<时间戳>`，**不删除**任何旧数据；嵌套目录只随父目录保存一次。
5. 把快照内容复制回去并再次校验哈希；复制或校验失败时自动回滚（删除新写入内容、把 `.pre-restore.*` 改回原名，不残留新目录）。敏感文件（`env`、`auth-token`、`lan-proxy.credentials`、`secrets/` 以及配置目录下的文件）恢复后权限收紧到 `0600`，不依赖 umask。
6. 如果备份包含归档而当前没有配置 `archive.dir` / `QUBIUS_ARCHIVE_DIR`，恢复会拒绝执行，避免把归档内容写到意外位置。

恢复完成后会打印旧数据位置。确认无误后再自行清理这些目录：

```text
旧数据位置（未删除，确认无误后可自行清理）：
  /home/me/qubius/.qubius.pre-restore.20261127-101500
```

本工具**不会**自动启动或重启服务，恢复后请手工执行 `make start` 或 `make restart`。

## 风险与注意事项

- **明文密钥**：备份里的 `env`、`auth-token`、`lan-proxy.credentials`、`secrets/` 都是明文。请把备份放在受控目录、限制访问权限，必要时加密后再转移。
- **磁盘空间**：目录快照会完整复制数据目录和归档。归档可能占用大量空间，恢复时 `.pre-restore.*` 还会再占一份旧数据。操作前确认磁盘余量；不需要归档时用 `--without-archive`。
- **在线一致性**：`--online` / `--force` 只解决“能不能做”，不保证数据一致。运行中的会话写入、worktree 变更都可能让快照处于中间状态；可靠的备份和恢复都应先停服。
- **不影响构建产物**：备份不含 `dist/`、`node_modules/`，恢复后如果代码或依赖有变化，按平常流程 `make build` 即可。
