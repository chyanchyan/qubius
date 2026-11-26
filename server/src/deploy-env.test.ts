import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveDeployEnvFile } from "./deploy-env.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qubius-deploy-env-"));
}

test("QUBIUS_ENV 优先，绝对路径直接使用", () => {
  const base = tmp();
  const configDir = path.join(base, "cfg");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "env"), "QUBIUS_PRIMARY_PORT=1111\n");
  const explicit = path.join(base, "custom.env");
  fs.writeFileSync(explicit, "QUBIUS_PRIMARY_PORT=2222\n");

  const resolved = resolveDeployEnvFile(
    { QUBIUS_ENV: explicit, QUBIUS_CONFIG_DIR: configDir },
    configDir,
    base,
  );
  assert.deepEqual(resolved, { file: explicit, source: "QUBIUS_ENV", exists: true });
});

test("QUBIUS_ENV 相对路径按 repoRoot 解析", () => {
  const base = tmp();
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "my.env"), "QUBIUS_PRIMARY_PORT=2222\n");

  const resolved = resolveDeployEnvFile({ QUBIUS_ENV: "my.env" }, path.join(base, "cfg"), repoRoot);
  assert.equal(resolved.file, path.join(repoRoot, "my.env"));
  assert.equal(resolved.source, "QUBIUS_ENV");
  assert.equal(resolved.exists, true);

  // 缺 repoRoot 时按 path.resolve（相对进程 cwd）。
  const withoutRepo = resolveDeployEnvFile({ QUBIUS_ENV: "my.env" }, path.join(base, "cfg"));
  assert.equal(withoutRepo.file, path.resolve("my.env"));
});

test("QUBIUS_ENV 指向的文件缺失时 exists=false", () => {
  const base = tmp();
  const missing = path.join(base, "nope.env");
  const resolved = resolveDeployEnvFile({ QUBIUS_ENV: missing }, path.join(base, "cfg"));
  assert.equal(resolved.file, missing);
  assert.equal(resolved.source, "QUBIUS_ENV");
  assert.equal(resolved.exists, false);
});

test("没有 QUBIUS_ENV 时优先 <configDir>/env", () => {
  const base = tmp();
  const configDir = path.join(base, "cfg");
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "env"), "QUBIUS_PRIMARY_PORT=1111\n");
  fs.writeFileSync(path.join(repoRoot, "deploy", "env"), "QUBIUS_PRIMARY_PORT=2222\n");

  const resolved = resolveDeployEnvFile({}, configDir, repoRoot);
  assert.deepEqual(resolved, {
    file: path.join(configDir, "env"),
    source: "config-dir",
    exists: true,
  });
});

test("config-dir env 缺失时回落到 repoRoot/deploy/env", () => {
  const base = tmp();
  const configDir = path.join(base, "cfg");
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "deploy", "env"), "QUBIUS_PRIMARY_PORT=2222\n");

  const resolved = resolveDeployEnvFile({}, configDir, repoRoot);
  assert.deepEqual(resolved, {
    file: path.join(repoRoot, "deploy", "env"),
    source: "repo",
    exists: true,
  });
});

test("未传 repoRoot 时不做 repo 兜底，返回 default", () => {
  const base = tmp();
  const configDir = path.join(base, "cfg");
  fs.mkdirSync(configDir, { recursive: true });
  // 即便磁盘上存在 <reporoot>/deploy/env，没有 repoRoot 也不会被选中。
  fs.mkdirSync(path.join(base, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(base, "deploy", "env"), "QUBIUS_PRIMARY_PORT=2222\n");

  const resolved = resolveDeployEnvFile({}, configDir);
  assert.deepEqual(resolved, {
    file: path.join(configDir, "env"),
    source: "default",
    exists: false,
  });
});

test("只有普通文件才算存在：目录不会被当作 env", () => {
  const base = tmp();
  const configDir = path.join(base, "cfg");
  // 故意把 configDir/env 建造成目录，模拟 -f 判定失败。
  fs.mkdirSync(path.join(configDir, "env"), { recursive: true });

  const resolved = resolveDeployEnvFile({}, configDir);
  assert.equal(resolved.source, "default");
  assert.equal(resolved.exists, false);
  assert.equal(resolved.file, path.join(configDir, "env"));
});

test("QUBIUS_ENV 判空与 shell -n 对齐：空串回落，纯空白不 trim", () => {
  const base = tmp();
  const configDir = path.join(base, "cfg");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "env"), "QUBIUS_PRIMARY_PORT=1111\n");

  // 空串等同未设置。
  assert.equal(resolveDeployEnvFile({ QUBIUS_ENV: "" }, configDir).source, "config-dir");

  // 纯空白在 shell 里也是非空值；服务端不 trim，仍按 QUBIUS_ENV 处理。
  const blank = resolveDeployEnvFile({ QUBIUS_ENV: " " }, configDir);
  assert.equal(blank.source, "QUBIUS_ENV");
  assert.equal(blank.exists, false);
});
