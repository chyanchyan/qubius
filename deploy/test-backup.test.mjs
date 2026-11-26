// deploy/backup.mjs / deploy/restore.mjs 的端到端测试。
// 全部使用 mktemp 目录和注入的端口，不接触真实配置、真实数据或运行中的服务。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSettings } from "./backup.mjs";
import { applyRestore, readManifest, verifyBackupFiles } from "./restore.mjs";

const DEPLOY_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_SCRIPT = path.join(DEPLOY_DIR, "backup.mjs");
const RESTORE_SCRIPT = path.join(DEPLOY_DIR, "restore.mjs");

const tempDirs = new Set();

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readFile(file) {
  return fs.readFileSync(file, "utf8");
}

/** 去掉继承来的 QUBIUS_*，避免开发机上真实部署变量干扰测试。 */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("QUBIUS_")) env[key] = value;
  }
  return { ...env, ...extra };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startHealthServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end('{"status":"ok"}');
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * 构造一个临时“仓库”：配置目录、数据目录、归档目录都在 mktemp 下。
 * 包含 secrets / auth-token / sessions / push / skills / images，以及应被排除的
 * worktrees、运行期文件、*.log、node_modules、dist、.git。
 */
async function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-backup-test-"));
  tempDirs.add(base);
  const repo = path.join(base, "repo");
  const configDir = path.join(repo, ".qubius");
  const dataDir = path.join(configDir, "data");
  const archiveDir = path.join(configDir, "archive-store");
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });

  writeFile(
    path.join(configDir, "config.yaml"),
    [
      "role: primary",
      "listen: 127.0.0.1:8787",
      "dataDir: ./data",
      "archive:",
      "  dir: ./archive-store",
      "  retentionDays: 30",
      "",
    ].join("\n"),
  );
  writeFile(path.join(configDir, "config-secondary.yaml"), "role: secondary\n");
  writeFile(path.join(configDir, "env"), "QUBIUS_MAX_CONCURRENT=4\nQUBIUS_TEST_MARKER=1\n");
  writeFile(path.join(configDir, "projects.yaml"), "projects: []\n");
  writeFile(path.join(configDir, "lan-proxy.credentials"), "qubius:plain-password\n");

  const files = {
    session: path.join(dataDir, "sessions", "s1.json"),
    sessionMeta: path.join(dataDir, "sessions", "s1.meta.json"),
    secret: path.join(dataDir, "secrets", "api.key"),
    authToken: path.join(dataDir, "auth-token"),
    push: path.join(dataDir, "push", "subscriptions.json"),
    skill: path.join(dataDir, "skills", "demo", "SKILL.md"),
    image: path.join(dataDir, "images", "s1", "pic.png"),
    settings: path.join(dataDir, "settings.json"),
    worktree: path.join(dataDir, "worktrees", "wt-1", "file.txt"),
    log: path.join(dataDir, "qubius.log"),
    pid: path.join(dataDir, "qubius.pid"),
    proxyPid: path.join(dataDir, "lan-proxy.pid"),
    shutdownToken: path.join(dataDir, "shutdown-token"),
    nodeModules: path.join(dataDir, "node_modules", "pkg", "index.js"),
    dist: path.join(dataDir, "dist", "app.js"),
    git: path.join(dataDir, ".git", "config"),
    archiveSession: path.join(archiveDir, "main", "sessions", "old.json"),
    archiveMeta: path.join(archiveDir, "main", "sessions", "old.meta.json"),
    archiveImage: path.join(archiveDir, "main", "images", "old", "pic.png"),
  };

  const contents = {
    session: '{"id":"s1","messages":[]}\n',
    sessionMeta: '{"id":"s1","title":"demo"}\n',
    secret: "sk-test-secret\n",
    authToken: "auth-token-value\n",
    push: '{"subscriptions":[]}\n',
    skill: "# skill\n",
    image: "PNG-BYTES\n",
    settings: '{"maxConcurrent":4}\n',
    worktree: "worktree content\n",
    log: "log line\n",
    pid: "12345\n",
    proxyPid: "12346\n",
    shutdownToken: "token\n",
    nodeModules: "module.exports = {};\n",
    dist: "built\n",
    git: "[core]\n",
    archiveSession: '{"id":"old"}\n',
    archiveMeta: '{"id":"old"}\n',
    archiveImage: "OLD-IMAGE\n",
  };

  for (const [key, file] of Object.entries(files)) writeFile(file, contents[key]);

  const port = await freePort();
  return { base, repo, configDir, dataDir, archiveDir, home, port, files, contents };
}

function envFor(fixture, extra = {}) {
  return cleanEnv({
    HOME: fixture.home,
    QUBIUS_REPO_DIR: fixture.repo,
    QUBIUS_CONFIG_DIR: fixture.configDir,
    QUBIUS_PRIMARY_PORT: String(fixture.port),
    QUBIUS_BACKUP_DIR: path.join(fixture.base, "backups"),
    ...extra,
  });
}

function runSync(script, args, env, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: cwd || os.tmpdir(),
    env,
    encoding: "utf8",
  });
  return { code: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function runAsync(script, args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: cwd || os.tmpdir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
  });
}

function exists(...parts) {
  return fs.existsSync(path.join(...parts));
}

test("backup 生成完整的目录快照、清单和哈希，排除 worktrees/日志/运行期文件/构建产物", async () => {
  const fixture = await makeFixture();
  const dest = path.join(fixture.base, "backup-full");

  const result = runSync(BACKUP_SCRIPT, ["--to", dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);

  for (const rel of [
    "config/config.yaml",
    "config/config-secondary.yaml",
    "config/env",
    "config/projects.yaml",
    "config/lan-proxy.credentials",
    "data/sessions/s1.json",
    "data/sessions/s1.meta.json",
    "data/secrets/api.key",
    "data/auth-token",
    "data/push/subscriptions.json",
    "data/skills/demo/SKILL.md",
    "data/images/s1/pic.png",
    "data/settings.json",
    "archive/main/sessions/old.json",
    "archive/main/sessions/old.meta.json",
    "archive/main/images/old/pic.png",
    "manifest.json",
    "manifest.sha256",
  ]) {
    assert.ok(exists(dest, rel), `备份缺少 ${rel}`);
  }

  for (const rel of [
    "data/worktrees/wt-1/file.txt",
    "data/qubius.log",
    "data/qubius.pid",
    "data/lan-proxy.pid",
    "data/shutdown-token",
    "data/node_modules/pkg/index.js",
    "data/dist/app.js",
    "data/.git/config",
  ]) {
    assert.ok(!exists(dest, rel), `备份不应包含 ${rel}`);
  }

  const manifest = readManifestFile(dest);
  assert.equal(manifest.tool, "qubius-backup");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.role, "primary");
  assert.equal(manifest.includeArchive, true);
  assert.equal(manifest.includeWorktrees, false);
  assert.equal(manifest.online, false);
  assert.equal(manifest.totals.files, manifest.files.length);
  assert.match(manifest.source.dataSource, /dataDir/);

  const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get("data/secrets/api.key").sha256, sha256Text(fixture.contents.secret));
  assert.equal(byPath.get("data/sessions/s1.json").size, Buffer.byteLength(fixture.contents.session));

  const manifestText = readFile(path.join(dest, "manifest.json"));
  const manifestHash = readFile(path.join(dest, "manifest.sha256")).trim().split(/\s+/)[0];
  assert.equal(manifestHash, sha256Text(manifestText));

  for (const entry of manifest.files) {
    const file = path.join(dest, ...entry.path.split("/"));
    assert.equal(sha256File(file), entry.sha256, `哈希不一致：${entry.path}`);
    assert.equal(fs.statSync(file).size, entry.size, `大小不一致：${entry.path}`);
  }

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(dest).mode & 0o777, 0o700, "备份目录权限应为 0700");
    assert.equal(fs.statSync(path.join(dest, "config")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dest, "data")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dest, "archive")).mode & 0o777, 0o700);
  }
});

test("默认备份目录是 $QUBIUS_BACKUP_DIR/qubius-YYYYmmdd-HHMMSS；未设置时用 $HOME/qubius-backups", async () => {
  const fixture = await makeFixture();

  let result = runSync(BACKUP_SCRIPT, [], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);
  const entries = fs.readdirSync(path.join(fixture.base, "backups"));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^qubius-\d{8}-\d{6}$/);

  const env = envFor(fixture);
  delete env.QUBIUS_BACKUP_DIR;
  result = runSync(BACKUP_SCRIPT, [], env, fixture.base);
  assert.equal(result.code, 0, result.stderr);
  const homeEntries = fs.readdirSync(path.join(fixture.home, "qubius-backups"));
  assert.equal(homeEntries.length, 1);
  assert.match(homeEntries[0], /^qubius-\d{8}-\d{6}$/);
});

test("--with-worktrees 包含 worktrees，--without-archive 排除归档", async () => {
  const fixture = await makeFixture();

  const withWorktrees = path.join(fixture.base, "backup-worktrees");
  let result = runSync(
    BACKUP_SCRIPT,
    ["--to", withWorktrees, "--with-worktrees"],
    envFor(fixture),
    fixture.base,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.ok(exists(withWorktrees, "data/worktrees/wt-1/file.txt"));
  assert.equal(readManifestFile(withWorktrees).includeWorktrees, true);

  const withoutArchive = path.join(fixture.base, "backup-no-archive");
  result = runSync(
    BACKUP_SCRIPT,
    ["--to", withoutArchive, "--without-archive"],
    envFor(fixture),
    fixture.base,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!exists(withoutArchive, "archive"));
  assert.equal(readManifestFile(withoutArchive).includeArchive, false);
});

test("config.yaml 的 dataDir 会作为数据目录来源，并用于恢复", async () => {
  const fixture = await makeFixture();
  const customData = path.join(fixture.configDir, "custom-data");
  writeFile(path.join(customData, "sessions", "custom.json"), '{"id":"custom"}\n');
  writeFile(
    path.join(fixture.configDir, "config.yaml"),
    ["role: primary", "dataDir: ./custom-data", "archive:", "  dir: ./archive-store", ""].join("\n"),
  );

  const dest = path.join(fixture.base, "backup-custom-data");
  let result = runSync(BACKUP_SCRIPT, ["--to", dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);

  assert.ok(exists(dest, "data/sessions/custom.json"));
  assert.ok(!exists(dest, "data/sessions/s1.json"), "不应备份默认 dataDir");
  const manifest = readManifestFile(dest);
  assert.equal(manifest.source.dataDir, customData);
  assert.match(manifest.source.dataSource, /dataDir/);

  writeFile(path.join(customData, "sessions", "custom.json"), "changed\n");
  result = runSync(RESTORE_SCRIPT, [dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFile(path.join(customData, "sessions", "custom.json")), '{"id":"custom"}\n');
});

test("缺少 <configDir>/env 时回退到 <repo>/deploy/env，env 会被备份并写回", async () => {
  const fixture = await makeFixture();
  fs.rmSync(path.join(fixture.configDir, "env"));
  const legacyData = path.join(fixture.base, "legacy-data");
  writeFile(path.join(legacyData, "sessions", "legacy.json"), '{"id":"legacy"}\n');
  const legacyEnvFile = path.join(fixture.repo, "deploy", "env");
  const envContent = `QUBIUS_DATA_PRIMARY=${legacyData}\nQUBIUS_MAX_CONCURRENT=6\n`;
  writeFile(legacyEnvFile, envContent);

  const dest = path.join(fixture.base, "backup-deploy-env");
  let result = runSync(BACKUP_SCRIPT, ["--to", dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);

  assert.ok(exists(dest, "data/sessions/legacy.json"));
  assert.ok(!exists(dest, "data/sessions/s1.json"));
  assert.ok(exists(dest, "config/env"), "实际使用的 deploy/env 应进入快照");
  assert.equal(readFile(path.join(dest, "config", "env")), envContent);
  const manifest = readManifestFile(dest);
  assert.equal(manifest.source.envFile, legacyEnvFile);
  assert.equal(manifest.source.dataDir, legacyData);
  assert.equal(manifest.source.dataSource, "QUBIUS_DATA_PRIMARY");

  // 1. 当前 env 存在（被改脏）时，恢复应写回原路径并还原内容。
  writeFile(legacyEnvFile, "QUBIUS_DATA_PRIMARY=/wrong\n");
  writeFile(path.join(legacyData, "sessions", "legacy.json"), "changed\n");
  result = runSync(RESTORE_SCRIPT, [dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFile(legacyEnvFile), envContent);
  assert.equal(readFile(path.join(legacyData, "sessions", "legacy.json")), '{"id":"legacy"}\n');
  assert.ok(
    fs.readdirSync(path.join(fixture.repo, "deploy")).some((name) => name.startsWith("env.pre-restore.")),
    "旧 env 应改名保留",
  );

  // 2. 灾备场景：env 丢失，恢复后应写到 <configDir>/env，数据仍按备份 env 的路径还原。
  fs.rmSync(legacyEnvFile);
  assert.ok(!exists(fixture.configDir, "env"));
  writeFile(path.join(legacyData, "sessions", "legacy.json"), "changed-again\n");
  result = runSync(RESTORE_SCRIPT, [dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFile(path.join(fixture.configDir, "env")), envContent);
  assert.equal(readFile(path.join(legacyData, "sessions", "legacy.json")), '{"id":"legacy"}\n');
});

test("副实例使用 config-secondary.yaml、QUBIUS_DATA_SECONDARY 和默认端口 8788", async () => {
  const fixture = await makeFixture();
  const secondaryData = path.join(fixture.configDir, "secondary-data");
  writeFile(path.join(secondaryData, "sessions", "sec.json"), '{"id":"sec"}\n');
  writeFile(
    path.join(fixture.configDir, "config-secondary.yaml"),
    [
      "role: secondary",
      "dataDir: ./secondary-data",
      "archive:",
      "  dir: ./secondary-archive",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(fixture.configDir, "env"),
    "QUBIUS_MAX_CONCURRENT=4\nQUBIUS_SECONDARY=1\n",
  );

  // 默认端口、配置文件和 dataDir 直接通过 resolveSettings 验证。
  const settings = await resolveSettings(
    cleanEnv({
      HOME: fixture.home,
      QUBIUS_REPO_DIR: fixture.repo,
      QUBIUS_CONFIG_DIR: fixture.configDir,
    }),
  );
  assert.equal(settings.role, "secondary");
  assert.equal(settings.port, 8788);
  assert.equal(settings.configFile, path.join(fixture.configDir, "config-secondary.yaml"));
  assert.equal(settings.dataDir, secondaryData);
  assert.equal(settings.archiveDir, path.join(fixture.configDir, "secondary-archive"));

  const dest = path.join(fixture.base, "backup-secondary");
  const env = envFor(fixture, { QUBIUS_SECONDARY_PORT: String(fixture.port) });
  const result = runSync(BACKUP_SCRIPT, ["--to", dest], env, fixture.base);
  assert.equal(result.code, 0, result.stderr);

  assert.ok(exists(dest, "data/sessions/sec.json"));
  assert.ok(exists(dest, "config/config-secondary.yaml"));
  assert.ok(!exists(dest, "data/sessions/s1.json"));
  assert.equal(readManifestFile(dest).role, "secondary");
});

test("文件被篡改或 manifest.json 被改动时 restore 拒绝执行且不覆盖现有数据", async () => {
  const fixture = await makeFixture();

  const tamperedFile = path.join(fixture.base, "backup-tampered-file");
  let result = runSync(BACKUP_SCRIPT, ["--to", tamperedFile], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);
  fs.writeFileSync(path.join(tamperedFile, "data", "sessions", "s1.json"), "tampered\n");

  writeFile(fixture.files.session, "current-live-data\n");
  result = runSync(RESTORE_SCRIPT, [tamperedFile], envFor(fixture), fixture.base);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /大小不一致|哈希不一致|篡改|损坏/);
  assert.equal(readFile(fixture.files.session), "current-live-data\n");
  assert.equal(
    fs.readdirSync(fixture.repo).filter((name) => name.includes(".pre-restore.")).length,
    0,
  );

  const tamperedManifest = path.join(fixture.base, "backup-tampered-manifest");
  result = runSync(BACKUP_SCRIPT, ["--to", tamperedManifest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);
  fs.appendFileSync(path.join(tamperedManifest, "manifest.json"), " ");

  result = runSync(RESTORE_SCRIPT, [tamperedManifest], envFor(fixture), fixture.base);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /manifest\.sha256/);
  assert.equal(readFile(fixture.files.session), "current-live-data\n");
});

test("restore 拒绝路径穿越，不会在目标目录之外写文件", async () => {
  const fixture = await makeFixture();
  const dest = path.join(fixture.base, "backup-traversal");
  let result = runSync(BACKUP_SCRIPT, ["--to", dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);

  const manifestPath = path.join(dest, "manifest.json");
  const manifest = JSON.parse(readFile(manifestPath));
  manifest.files[0].path = "data/../../evil.txt";
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, text);
  fs.writeFileSync(path.join(dest, "manifest.sha256"), `${sha256Text(text)}  manifest.json\n`);

  result = runSync(RESTORE_SCRIPT, [dest], envFor(fixture), fixture.base);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /非法|越界|绝对路径|前缀/);
  assert.ok(!exists(fixture.base, "evil.txt"));
  assert.ok(!exists(fixture.repo, "evil.txt"));
});

test("restore 拒绝备份里的符号链接", async () => {
  if (process.platform === "win32") return;
  const fixture = await makeFixture();
  const dest = path.join(fixture.base, "backup-symlink");
  let result = runSync(BACKUP_SCRIPT, ["--to", dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);

  const link = path.join(dest, "data", "sessions", "s1.json");
  fs.rmSync(link);
  fs.symlinkSync(path.join(dest, "data", "secrets", "api.key"), link);

  writeFile(fixture.files.session, "live-before-symlink-test\n");
  result = runSync(RESTORE_SCRIPT, [dest], envFor(fixture), fixture.base);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /不是普通文件/);
  assert.equal(readFile(fixture.files.session), "live-before-symlink-test\n");
});

test("备份含归档但当前未配置归档目录时 restore 拒绝执行", async () => {
  const fixture = await makeFixture();
  const dest = path.join(fixture.base, "backup-archive");
  let result = runSync(BACKUP_SCRIPT, ["--to", dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);

  writeFile(
    path.join(fixture.configDir, "config.yaml"),
    ["role: primary", "dataDir: ./data", ""].join("\n"),
  );
  writeFile(fixture.files.session, "live-before-archive-test\n");

  result = runSync(RESTORE_SCRIPT, [dest], envFor(fixture), fixture.base);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /未配置 archive\.dir/);
  assert.equal(readFile(fixture.files.session), "live-before-archive-test\n");
});

test("restore 成功后数据回到备份状态，旧数据保存在 .pre-restore.*", async () => {
  const fixture = await makeFixture();
  const dest = path.join(fixture.base, "backup-restore");
  let result = runSync(BACKUP_SCRIPT, ["--to", dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);

  writeFile(fixture.files.session, "changed-after-backup\n");
  const marker = path.join(fixture.dataDir, "marker.txt");
  writeFile(marker, "old-marker\n");

  result = runSync(RESTORE_SCRIPT, [dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /恢复完成/);
  assert.match(result.stdout, /make restart/);

  assert.equal(readFile(fixture.files.session), fixture.contents.session);
  assert.ok(!exists(fixture.dataDir, "marker.txt"), "旧数据不应留在原位置");
  assert.equal(readFile(path.join(fixture.dataDir, "secrets", "api.key")), fixture.contents.secret);
  assert.equal(readFile(path.join(fixture.configDir, "env")), "QUBIUS_MAX_CONCURRENT=4\nQUBIUS_TEST_MARKER=1\n");
  assert.equal(readFile(fixture.files.archiveSession), fixture.contents.archiveSession);

  const preRestore = fs
    .readdirSync(fixture.repo)
    .filter((name) => name.startsWith(".qubius.pre-restore."));
  assert.equal(preRestore.length, 1, "应保留一个 .pre-restore.* 目录");
  const oldMarker = path.join(fixture.repo, preRestore[0], "data", "marker.txt");
  assert.equal(readFile(oldMarker), "old-marker\n");

  if (process.platform !== "win32") {
    for (const file of [
      path.join(fixture.configDir, "env"),
      path.join(fixture.configDir, "config.yaml"),
      path.join(fixture.configDir, "lan-proxy.credentials"),
      path.join(fixture.dataDir, "auth-token"),
      path.join(fixture.dataDir, "secrets", "api.key"),
    ]) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${file} 应收紧到 0600`);
    }
  }

  result = runSync(RESTORE_SCRIPT, [dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    fs.readdirSync(fixture.repo).filter((name) => name.startsWith(".qubius.pre-restore.")).length,
    2,
  );
});

test("applyRestore 复制失败时回滚，原数据改回且无残留新目录/.pre-restore", async () => {
  const fixture = await makeFixture();
  const dest = path.join(fixture.base, "backup-rollback");
  let result = runSync(BACKUP_SCRIPT, ["--to", dest], envFor(fixture), fixture.base);
  assert.equal(result.code, 0, result.stderr);

  const liveConfig = "role: primary\n# live\n";
  writeFile(path.join(fixture.configDir, "config.yaml"), liveConfig);
  writeFile(fixture.files.session, "live-session\n");
  const liveMarker = path.join(fixture.dataDir, "live-marker.txt");
  writeFile(liveMarker, "live-marker\n");

  const manifest = readManifest(dest);
  const files = await verifyBackupFiles(dest, manifest);
  const settings = await resolveSettings(envFor(fixture));
  const targets = { config: settings.configDir, data: settings.dataDir };

  let copies = 0;
  const copyFile = (source, destination, options) => {
    copies += 1;
    if (copies >= 2) throw new Error("injected copy failure");
    fs.cpSync(source, destination, options);
  };

  await assert.rejects(
    () => applyRestore({ files, targets, copyFile, ts: "rollback-test" }),
    /injected copy failure/,
  );

  // 原数据已经改回原位置，复制了一半的新内容被清理。
  assert.equal(readFile(path.join(fixture.configDir, "config.yaml")), liveConfig);
  assert.equal(readFile(fixture.files.session), "live-session\n");
  assert.equal(readFile(liveMarker), "live-marker\n");
  assert.equal(
    fs.readdirSync(fixture.repo).filter((name) => name.includes(".pre-restore.")).length,
    0,
    "回滚后不应残留 .pre-restore 目录",
  );
  assert.ok(!exists(fixture.configDir, "config"), "不应残留部分恢复的 config/ 子目录");
});

test("健康探测：无服务时直接通过；服务运行中需要 --online / --force", async () => {
  const fixture = await makeFixture();
  const { server, port } = await startHealthServer();
  try {
    const env = envFor(fixture, { QUBIUS_PRIMARY_PORT: String(port) });
    const dest = path.join(fixture.base, "backup-online");

    let result = await runAsync(BACKUP_SCRIPT, ["--to", dest], env, fixture.base);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--online/);
    assert.ok(!fs.existsSync(dest), "探测到服务运行时应清理半成品目录");

    result = await runAsync(BACKUP_SCRIPT, ["--to", dest, "--online"], env, fixture.base);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readManifestFile(dest).online, true);

    result = await runAsync(RESTORE_SCRIPT, [dest], env, fixture.base);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--force/);

    result = await runAsync(RESTORE_SCRIPT, [dest, "--force"], env, fixture.base);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await closeServer(server);
  }
});

test("restore 收到空字符串参数时按缺少备份目录处理，不把 cwd 当备份目录", async () => {
  const fixture = await makeFixture();
  const result = runSync(RESTORE_SCRIPT, [""], envFor(fixture), fixture.base);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /需要一个备份目录|用法/);
  assert.match(result.stderr, /用法：node deploy\/restore\.mjs/);
});

test("--help 在缺少 node_modules 时也能运行（yaml 懒加载）", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-backup-nodeps-"));
  tempDirs.add(base);
  const deployDir = path.join(base, "deploy");
  fs.mkdirSync(deployDir, { recursive: true });
  for (const name of ["backup.mjs", "restore.mjs", "deploy-lib.mjs"]) {
    fs.copyFileSync(path.join(DEPLOY_DIR, name), path.join(deployDir, name));
  }
  const env = cleanEnv({ HOME: base });
  let result = runSync(path.join(deployDir, "backup.mjs"), ["--help"], env, base);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--with-worktrees/);
  result = runSync(path.join(deployDir, "restore.mjs"), ["--help"], env, base);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--force/);
});

function readManifestFile(backupDir) {
  return JSON.parse(readFile(path.join(backupDir, "manifest.json")));
}
