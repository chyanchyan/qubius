import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readAccessEntries } from "./access-entries.js";
import type { AppConfig } from "./config.js";
import type { EdgePaths } from "./edge/types.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qubius-access-"));
}

interface Fixture {
  configDir: string;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}

/** 隔离的配置目录 + 仓库根；env 文件只在传入内容时创建。 */
function setup(envBody = ""): Fixture {
  const base = tmp();
  const configDir = path.join(base, "config");
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  if (envBody) fs.writeFileSync(path.join(configDir, "env"), envBody);
  const env: NodeJS.ProcessEnv = {
    QUBIUS_CONFIG_DIR: configDir,
    HOME: path.join(base, "home"),
  };
  return { configDir, repoRoot, env };
}

const disabledEdge: EdgePaths = {
  provider: null,
  resolvedProvider: null,
  configPath: null,
  configSource: null,
  binPath: null,
  binSource: null,
  disabled: true,
  errors: [],
};

const enabledEdge: EdgePaths = {
  ...disabledEdge,
  provider: "native",
  resolvedProvider: "native",
  disabled: false,
};

function read(fixture: Fixture, edge: EdgePaths = disabledEdge): { lan: boolean; public: boolean } {
  return readAccessEntries({
    config: { role: "primary" } as AppConfig,
    repoRoot: fixture.repoRoot,
    env: fixture.env,
    // 注入路径，避免测试去探测宿主机的 edgectl 配置。
    edge: { configDir: fixture.configDir, paths: edge },
  });
}

test("默认只启用本机入口，不上报局域网和公网", () => {
  assert.deepEqual(read(setup()), { lan: false, public: false });
});

test("部署 env 里 QUBIUS_START_LAN=1 时局域网入口已启用", () => {
  assert.deepEqual(read(setup("QUBIUS_START_LAN=1\n")), { lan: true, public: false });
});

test("QUBIUS_START_LAN=0 显式关闭时即使有凭据文件也不算启用", () => {
  const fixture = setup("QUBIUS_START_LAN=0\n");
  fs.writeFileSync(path.join(fixture.configDir, "lan-proxy.credentials"), "qubius:secret\n");
  assert.deepEqual(read(fixture), { lan: false, public: false });
});

test("没有显式开关时凭据文件存在即视为启用局域网入口", () => {
  const fixture = setup();
  fs.writeFileSync(path.join(fixture.configDir, "lan-proxy.credentials"), "qubius:secret\n");
  assert.deepEqual(read(fixture), { lan: true, public: false });
});

test("公网入口可用时上报 public", () => {
  assert.deepEqual(read(setup(), enabledEdge), { lan: false, public: true });
});

test("两个入口都启用时一起上报", () => {
  assert.deepEqual(read(setup("QUBIUS_START_LAN=1\n"), enabledEdge), { lan: true, public: true });
});
