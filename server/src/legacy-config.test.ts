import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  LegacyMigrationError,
  findLegacyConfig,
  ignoredLegacyConfigs,
  migrateLegacyConfig,
  scanLegacyConfigs,
  setLegacyConfigIgnored,
} from "./legacy-config.js";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-legacy-"));
}

function envFor(home: string): NodeJS.ProcessEnv {
  return { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
}

function scan(home: string, current: string) {
  return scanLegacyConfigs({
    currentConfigDir: current,
    env: envFor(home),
    platform: "linux",
  });
}

function writeLegacy(legacy: string, files: Record<string, string>): void {
  fs.mkdirSync(legacy, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(legacy, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

test("扫描 XDG 旧配置目录，排除当前配置目录", () => {
  const home = tempHome();
  const qubiusLegacy = path.join(home, ".config", "qubius");
  const qoderLegacy = path.join(home, ".config", "qoder");
  writeLegacy(qubiusLegacy, {
    "config.yaml": "role: primary\n",
    "env": "QUBIUS_AUTH=1\n",
    "lan-proxy.credentials": "u:p\n",
    "data/sessions/x.json": "{}\n",
  });
  writeLegacy(qoderLegacy, { "env": "QODER_AUTH=1\n" });

  const current = path.join(home, "checkout", ".qubius");
  const found = scan(home, current);
  assert.deepEqual(found.map((item) => item.path), [qubiusLegacy, qoderLegacy]);
  assert.equal(found[0]?.origin, "XDG 配置目录");
  assert.equal(found[0]?.hasConfig, true);
  assert.deepEqual(found[0]?.files.map((file) => file.name), [
    "config.yaml",
    "env",
    "lan-proxy.credentials",
  ]);
  assert.equal(found[0]?.conflicts.length, 0);
  assert.equal(found[1]?.hasConfig, false);

  // 当前配置目录本身不会被当成迁移来源（兄弟目录仍然会列出）。
  assert.deepEqual(scan(home, qubiusLegacy).map((item) => item.path), [qoderLegacy]);
  // 当前配置目录的父 / 子目录也不会。
  assert.deepEqual(scan(home, home), []);
});

test("Windows 下扫描 %APPDATA% 里的旧目录", () => {
  const base = tempHome();
  const appData = path.join(base, "AppData", "Roaming");
  const legacy = path.join(appData, "qubius");
  writeLegacy(legacy, { "env": "QUBIUS_AUTH=1\n" });
  const found = scanLegacyConfigs({
    currentConfigDir: path.join(base, "checkout", ".qubius"),
    env: { APPDATA: appData },
    platform: "win32",
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.path, legacy);
  assert.equal(found[0]?.origin, "Windows APPDATA");
});

test("忽略后不再提示，重新显示后仍可迁移", () => {
  const home = tempHome();
  const legacy = path.join(home, ".config", "qubius");
  writeLegacy(legacy, { "config.yaml": "role: primary\n" });
  const target = path.join(home, "checkout", ".qubius");

  setLegacyConfigIgnored(target, legacy, true);
  assert.deepEqual(ignoredLegacyConfigs(target), [legacy]);
  assert.deepEqual(scan(home, target), []);
  // 迁移入口不受忽略影响：拿到的路径仍能解析成候选。
  assert.equal(
    findLegacyConfig(legacy, { currentConfigDir: target, env: envFor(home), platform: "linux" })?.path,
    legacy,
  );

  setLegacyConfigIgnored(target, legacy, false);
  assert.deepEqual(ignoredLegacyConfigs(target), []);
  assert.equal(scan(home, target).length, 1);
});

test("迁移配置、改写相对路径并清理旧目录里的迁移文件", () => {
  const home = tempHome();
  const legacy = path.join(home, ".config", "qubius");
  writeLegacy(legacy, {
    "config.yaml": [
      "role: primary",
      "listen: 127.0.0.1:8787",
      "dataDir: ./data",
      "archive:",
      "  dir: ./archive",
      "projects:",
      "  - id: p1",
      "    name: 项目",
      "    path: ./repos/p1",
      "",
    ].join("\n"),
    "env": [
      `QUBIUS_CONFIG_DIR='${legacy}'`,
      "QODER_PRIMARY_PORT=8787",
      "QUBIUS_AUTH=1",
      "",
    ].join("\n"),
    "data/sessions/keep.json": "{}\n",
  });
  const target = path.join(home, "checkout", ".qubius");

  const result = migrateLegacyConfig({
    requestedPath: legacy,
    currentConfigDir: target,
    env: envFor(home),
    platform: "linux",
  });
  assert.deepEqual(result.copied.sort(), ["config.yaml", "env"]);
  assert.deepEqual(result.deleted.sort(), ["config.yaml", "env"]);
  // data/ 不在迁移范围内，旧目录保留。
  assert.equal(result.removedDir, false);
  assert.deepEqual(result.leftovers, ["data"]);

  const config = parseYaml(fs.readFileSync(path.join(target, "config.yaml"), "utf8")) as {
    dataDir: string;
    archive: { dir: string };
    projects: { path: string }[];
  };
  assert.equal(config.dataDir, path.join(legacy, "data"));
  assert.equal(config.archive.dir, path.join(legacy, "archive"));
  assert.equal(config.projects[0]?.path, path.join(legacy, "repos", "p1"));

  const envText = fs.readFileSync(path.join(target, "env"), "utf8");
  assert.ok(envText.includes(`QUBIUS_CONFIG_DIR='${target}'`));
  assert.match(envText, /^QUBIUS_PRIMARY_PORT=8787$/m);
  assert.doesNotMatch(envText, /QODER_/);
  assert.match(envText, /^QUBIUS_AUTH=1$/m);

  // 迁移过的文件已从旧目录删除，数据文件保留。
  assert.equal(fs.existsSync(path.join(legacy, "config.yaml")), false);
  assert.equal(fs.existsSync(path.join(legacy, "env")), false);
  assert.ok(fs.existsSync(path.join(legacy, "data", "sessions", "keep.json")));

  // 再迁移一次：旧目录里只剩 data/，没有可迁移文件。
  assert.throws(
    () => migrateLegacyConfig({ requestedPath: legacy, currentConfigDir: target, env: envFor(home) }),
    (error) => error instanceof LegacyMigrationError && error.status === 404,
  );
});

test("配置里没写 dataDir 时补上旧目录的绝对路径，避免换基准后丢会话", () => {
  const home = tempHome();
  const legacy = path.join(home, ".config", "qubius");
  writeLegacy(legacy, { "config.yaml": "role: primary\n" });
  const target = path.join(home, "checkout", ".qubius");
  migrateLegacyConfig({ requestedPath: legacy, currentConfigDir: target, env: envFor(home) });
  const config = parseYaml(fs.readFileSync(path.join(target, "config.yaml"), "utf8")) as {
    dataDir: string;
  };
  assert.equal(config.dataDir, path.join(legacy, "data"));
  assert.equal(fs.existsSync(legacy), false);
});

test("目标已有不同内容时拒绝迁移，旧目录保持不变", () => {
  const home = tempHome();
  const legacy = path.join(home, ".config", "qubius");
  writeLegacy(legacy, { "config.yaml": "role: primary\n" });
  const target = path.join(home, "checkout", ".qubius");
  writeLegacy(target, { "config.yaml": "role: secondary\n" });

  assert.throws(
    () => migrateLegacyConfig({ requestedPath: legacy, currentConfigDir: target, env: envFor(home) }),
    (error) => error instanceof LegacyMigrationError && error.status === 409,
  );
  assert.ok(fs.existsSync(path.join(legacy, "config.yaml")));
  assert.equal(fs.readFileSync(path.join(target, "config.yaml"), "utf8"), "role: secondary\n");
});

test("确认覆盖时替换同名文件，覆盖前把当前内容备份为 *.bak.<时间戳>", () => {
  const home = tempHome();
  const legacy = path.join(home, ".config", "qubius");
  writeLegacy(legacy, {
    "config.yaml": "role: primary\n",
    "env": "QUBIUS_AUTH=1\n",
  });
  const target = path.join(home, "checkout", ".qubius");
  // 新部署自动生成的配置和 env，内容与旧目录不同。
  writeLegacy(target, {
    "config.yaml": "role: secondary\n",
    "env": "QUBIUS_PRIMARY_PORT=8787\n",
  });

  const result = migrateLegacyConfig({
    requestedPath: legacy,
    currentConfigDir: target,
    env: envFor(home),
    overwrite: true,
  });
  assert.deepEqual(result.overwritten.sort(), ["config.yaml", "env"]);
  assert.equal(result.copied.length, 0);
  assert.equal(result.backups.length, 2);
  assert.equal(result.removedDir, true);

  // 旧目录里的文件清理掉了，数据目录仍然保留（这里没有 data/）。
  assert.equal(fs.existsSync(path.join(legacy, "config.yaml")), false);
  assert.equal(fs.existsSync(path.join(legacy, "env")), false);

  // 当前文件已替换为迁移后的旧配置。
  const config = parseYaml(fs.readFileSync(path.join(target, "config.yaml"), "utf8")) as {
    dataDir: string;
  };
  assert.equal(config.dataDir, path.join(legacy, "data"));
  assert.match(fs.readFileSync(path.join(target, "env"), "utf8"), /^QUBIUS_AUTH=1$/m);

  // 每个被覆盖的文件都有备份，内容正好是覆盖前的版本。
  for (const backup of result.backups) {
    assert.match(backup, /\.bak\./);
    const original = backup.startsWith("config.yaml")
      ? "role: secondary\n"
      : "QUBIUS_PRIMARY_PORT=8787\n";
    assert.equal(fs.readFileSync(path.join(target, backup), "utf8"), original);
  }
});

test("目标已有相同内容时记为 unchanged，仍然清理旧目录", () => {
  const home = tempHome();
  const legacy = path.join(home, ".config", "qubius");
  writeLegacy(legacy, { "config.yaml": "role: primary\n", "env": "QUBIUS_AUTH=1\n" });
  const target = path.join(home, "checkout", ".qubius");
  const first = migrateLegacyConfig({ requestedPath: legacy, currentConfigDir: target, env: envFor(home) });
  assert.equal(first.removedDir, true);

  // 再放回同内容的旧文件：目标不需要重写，但仍应被清理。
  writeLegacy(legacy, { "config.yaml": "role: primary\n" });
  const second = migrateLegacyConfig({
    requestedPath: legacy,
    currentConfigDir: target,
    env: envFor(home),
  });
  assert.deepEqual(second.unchanged, ["config.yaml"]);
  assert.deepEqual(second.copied, []);
  assert.equal(second.removedDir, true);
  assert.equal(fs.existsSync(legacy), false);
});

test("只认扫描得到的目录，任意路径会被拒绝", () => {
  const home = tempHome();
  const target = path.join(home, "checkout", ".qubius");
  const external = path.join(home, "not-legacy");
  writeLegacy(external, { "config.yaml": "role: primary\n" });
  assert.throws(
    () => migrateLegacyConfig({ requestedPath: external, currentConfigDir: target, env: envFor(home) }),
    (error) => error instanceof LegacyMigrationError && error.status === 404,
  );
  assert.ok(fs.existsSync(path.join(external, "config.yaml")));
});

test("符号链接文件不迁移、也不删除链接", () => {
  const home = tempHome();
  const legacy = path.join(home, ".config", "qubius");
  writeLegacy(legacy, { "env": "QUBIUS_AUTH=1\n" });
  const link = path.join(legacy, "config.yaml");
  fs.symlinkSync(path.join(legacy, "env"), link);
  const target = path.join(home, "checkout", ".qubius");
  const found = scan(home, target);
  assert.deepEqual(found[0]?.files.map((file) => file.name), ["env"]);
  migrateLegacyConfig({ requestedPath: legacy, currentConfigDir: target, env: envFor(home) });  // 链接本身既没被复制，也没被删除。
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});
