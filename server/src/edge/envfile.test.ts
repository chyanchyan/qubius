import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseEdgeEnv, readEdgeEnvFile, resolveEdgeEnv } from "./envfile.js";
import { EdgeError } from "./types.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `edge-env-${prefix}-`));
}

function executable(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
}

test("parseEdgeEnv 支持 export、引号和行尾注释", () => {
  const values = parseEdgeEnv(
    [
      "# comment",
      "QUBIUS_EDGECTL_CONFIG=/opt/edgectl/edgectl.yaml",
      "export EDGECTL_CONFIG='/opt/with space/edgectl.yaml'",
      'DOUBLE="value # not comment"',
      "PLAIN=value # trailing",
      "EMPTY=",
      "",
    ].join("\n"),
  );
  assert.equal(values.QUBIUS_EDGECTL_CONFIG, "/opt/edgectl/edgectl.yaml");
  assert.equal(values.EDGECTL_CONFIG, "/opt/with space/edgectl.yaml");
  assert.equal(values.DOUBLE, "value # not comment");
  assert.equal(values.PLAIN, "value");
  assert.equal(values.EMPTY, "");
});

test("parseEdgeEnv 遇到 ${ 报错", () => {
  assert.throws(() => parseEdgeEnv("QUBIUS_EDGECTL_CONFIG=${HOME}/edgectl.yaml\n"), EdgeError);
  assert.throws(() => parseEdgeEnv('X="${HOME}/x"\n'), EdgeError);
  // 行尾注释里的 ${ 不影响（未加引号时只检查值部分）。
  assert.equal(parseEdgeEnv("X=value # ${HOME}\n").X, "value");
});

test("readEdgeEnvFile 缺失返回空对象", () => {
  assert.deepEqual(readEdgeEnvFile(path.join(tempDir("missing"), "env")), {});
});

test("resolveEdgeEnv：env 文件优先于进程 env", () => {
  const dir = tempDir("priority");
  const registry = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registry, "version: 1\n");
  fs.writeFileSync(path.join(dir, "env"), `QUBIUS_EDGECTL_CONFIG=${registry}\n`);
  const env = {
    HOME: dir,
    PATH: "/nonexistent",
    QUBIUS_CONFIG_DIR: dir,
    EDGECTL_CONFIG: "/elsewhere/edgectl.yaml",
  };
  const paths = resolveEdgeEnv(env);
  assert.equal(paths.configPath, registry);
  assert.equal(paths.configSource, "envfile-qubius");
  assert.equal(paths.disabled, false);
  assert.equal(paths.provider, "auto");
});

test("resolveEdgeEnv：没有 env 文件时进程 env 兜底", () => {
  const dir = tempDir("process");
  const registry = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registry, "version: 1\n");
  const paths = resolveEdgeEnv({
    HOME: dir,
    PATH: "/nonexistent",
    QUBIUS_CONFIG_DIR: path.join(dir, "cfg"),
    EDGECTL_CONFIG: registry,
  });
  assert.equal(paths.configPath, registry);
  assert.equal(paths.configSource, "process-edgectl");
  assert.equal(paths.disabled, false);
});

test("resolveEdgeEnv：都没配置时 edge 禁用，不自动读 $HOME/edgectl", () => {
  const dir = tempDir("disabled");
  executable(path.join(dir, "edgectl", ".venv", "bin", "edgectl"));
  const paths = resolveEdgeEnv({
    HOME: dir,
    PATH: "/nonexistent",
    QUBIUS_CONFIG_DIR: path.join(dir, "cfg"),
  });
  assert.equal(paths.configPath, null);
  assert.equal(paths.disabled, true);
  assert.deepEqual(paths.errors, []);
});

test("resolveEdgeEnv：相对配置路径返回中文错误", () => {
  const dir = tempDir("relative");
  const paths = resolveEdgeEnv({
    HOME: dir,
    PATH: "/nonexistent",
    QUBIUS_CONFIG_DIR: path.join(dir, "cfg"),
    QUBIUS_EDGECTL_CONFIG: "relative/edgectl.yaml",
  });
  assert.equal(paths.disabled, true);
  assert.match(paths.errors.join("\n"), /必须是绝对路径/);
});

test("resolveEdgeEnv：配置不存在时报错", () => {
  const dir = tempDir("absent");
  const missing = path.join(dir, "nope.yaml");
  const paths = resolveEdgeEnv({
    HOME: dir,
    PATH: "/nonexistent",
    QUBIUS_CONFIG_DIR: path.join(dir, "cfg"),
    QUBIUS_EDGECTL_CONFIG: missing,
  });
  assert.equal(paths.disabled, true);
  assert.match(paths.errors.join("\n"), /找不到 edgectl 配置/);
});

test("resolveEdgeEnv：edge 键的 ${ 报错，但有意回落到同名进程 env", () => {
  const dir = tempDir("dollar");
  const registry = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registry, "version: 1\n");
  fs.writeFileSync(path.join(dir, "env"), `QUBIUS_EDGECTL_CONFIG=\${HOME}/edgectl.yaml\n`);
  const paths = resolveEdgeEnv({
    HOME: dir,
    PATH: "/nonexistent",
    QUBIUS_CONFIG_DIR: dir,
    QUBIUS_EDGECTL_CONFIG: registry,
  });
  // 报错保留，配置文件坏键被删除，进程 env 继续兜底（不会整份丢弃）。
  assert.ok(paths.errors.some((error) => /变量展开/.test(error)));
  assert.equal(paths.configPath, registry);
  assert.equal(paths.configSource, "process-qubius");
});

test("非 edge 键里的 ${...} 不会丢弃整个 env，edge 配置仍生效", () => {
  const dir = tempDir("dollar-other");
  const registry = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registry, "version: 1\n");
  fs.writeFileSync(
    path.join(dir, "env"),
    ["SOME_UNRELATED=${HOME}/x", `QUBIUS_EDGECTL_CONFIG=${registry}`, ""].join("\n"),
  );
  const paths = resolveEdgeEnv({
    HOME: dir,
    PATH: "/nonexistent",
    QUBIUS_CONFIG_DIR: dir,
  });
  assert.equal(paths.configPath, registry);
  assert.equal(paths.disabled, false);
  assert.deepEqual(paths.errors, []);
});

test("bin：显式绝对路径优先，相对路径报错", () => {
  const dir = tempDir("bin");
  const registry = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registry, "version: 1\n");
  const bin = path.join(dir, "bin", "my-edgectl");
  executable(bin);
  const ok = resolveEdgeEnv({
    HOME: dir,
    PATH: "/nonexistent",
    QUBIUS_CONFIG_DIR: path.join(dir, "cfg"),
    QUBIUS_EDGECTL_CONFIG: registry,
    QUBIUS_EDGECTL_BIN: bin,
  });
  assert.equal(ok.binPath, bin);
  assert.equal(ok.binSource, "env");
  assert.equal(ok.disabled, false);

  const bad = resolveEdgeEnv({
    HOME: dir,
    PATH: "/nonexistent",
    QUBIUS_CONFIG_DIR: path.join(dir, "cfg"),
    QUBIUS_EDGECTL_CONFIG: registry,
    QUBIUS_EDGECTL_BIN: "bin/edgectl",
  });
  assert.equal(bad.binPath, null);
  assert.match(bad.errors.join("\n"), /QUBIUS_EDGECTL_BIN 必须是绝对路径/);
});

test("bin：PATH 与 $HOME/edgectl/.venv 兜底", () => {
  const dir = tempDir("binpath");
  const registry = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registry, "version: 1\n");
  const pathDir = path.join(dir, "pathbin");
  executable(path.join(pathDir, "edgectl"));
  const viaPath = resolveEdgeEnv({
    HOME: dir,
    PATH: pathDir,
    QUBIUS_CONFIG_DIR: path.join(dir, "cfg"),
    QUBIUS_EDGECTL_CONFIG: registry,
  });
  assert.equal(viaPath.binSource, "path");
  assert.equal(viaPath.binPath, path.join(pathDir, "edgectl"));

  const home = path.join(dir, "home");
  executable(path.join(home, "edgectl", ".venv", "bin", "edgectl"));
  const viaHome = resolveEdgeEnv({
    HOME: home,
    PATH: "/nonexistent",
    QUBIUS_CONFIG_DIR: path.join(dir, "cfg"),
    QUBIUS_EDGECTL_CONFIG: registry,
  });
  assert.equal(viaHome.binSource, "home");
  assert.equal(viaHome.binPath, path.join(home, "edgectl", ".venv", "bin", "edgectl"));
});

function providerEnv(dir: string, registry: string, extra: Record<string, string> = {}) {
  return {
    HOME: dir,
    PATH: "/nonexistent",
    QUBIUS_CONFIG_DIR: path.join(dir, "cfg"),
    QUBIUS_EDGECTL_CONFIG: registry,
    ...extra,
  };
}

test("provider 默认 auto；无 CLI 时 resolvedProvider=native", () => {
  const dir = tempDir("provider");
  const registry = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registry, "version: 1\n");
  const paths = resolveEdgeEnv(providerEnv(dir, registry, { QUBIUS_EDGE_PROVIDER: "native" }));
  assert.equal(paths.provider, "native");
  assert.equal(paths.resolvedProvider, "native");
  assert.equal(paths.disabled, false);

  const auto = resolveEdgeEnv(providerEnv(dir, registry));
  assert.equal(auto.provider, "auto");
  assert.equal(auto.resolvedProvider, "native");
});

test("provider 大小写规范化；auto 有 CLI 时 resolvedProvider=cli", () => {
  const dir = tempDir("provider-case");
  const registry = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registry, "version: 1\n");
  const bin = path.join(dir, "bin", "edgectl");
  executable(bin);
  const paths = resolveEdgeEnv(
    providerEnv(dir, registry, { QUBIUS_EDGE_PROVIDER: "CLI", QUBIUS_EDGECTL_BIN: bin }),
  );
  assert.equal(paths.provider, "cli");
  assert.equal(paths.resolvedProvider, "cli");
  assert.equal(paths.disabled, false);
});

test("provider=cli 但 CLI 不可用必须报错并禁用（不回退 native）", () => {
  const dir = tempDir("provider-cli-missing");
  const registry = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registry, "version: 1\n");
  const paths = resolveEdgeEnv(providerEnv(dir, registry, { QUBIUS_EDGE_PROVIDER: "cli" }));
  assert.equal(paths.resolvedProvider, null);
  assert.equal(paths.disabled, true);
  assert.match(paths.errors.join("\n"), /不会静默回退/);
});

test("非法 provider 值报错，provider 收窄为 null", () => {
  const dir = tempDir("provider-bad");
  const registry = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registry, "version: 1\n");
  const paths = resolveEdgeEnv(providerEnv(dir, registry, { QUBIUS_EDGE_PROVIDER: "gpu" }));
  assert.equal(paths.disabled, true);
  assert.equal(paths.provider, null);
  assert.equal(paths.resolvedProvider, null);
  assert.match(paths.errors.join("\n"), /只能.*auto.*cli.*native/);
});

test("显式 QUBIUS_EDGECTL_BIN 不可用时 auto/native/cli 都禁用，不选 native", () => {
  const dir = tempDir("provider-explicit-bin");
  const registry = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registry, "version: 1\n");
  const missing = path.join(dir, "missing-edgectl");
  for (const provider of ["auto", "native", "cli"]) {
    const paths = resolveEdgeEnv(
      providerEnv(dir, registry, { QUBIUS_EDGE_PROVIDER: provider, QUBIUS_EDGECTL_BIN: missing }),
    );
    assert.match(paths.errors.join("\n"), /QUBIUS_EDGECTL_BIN 不存在或不可执行/);
    assert.equal(paths.binPath, null);
    assert.equal(paths.disabled, true, `provider=${provider} 应禁用`);
    assert.equal(paths.resolvedProvider, null, `provider=${provider} 不应选 native`);
  }
});
