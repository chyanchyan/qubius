import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LIMITS } from "../config.js";
import type { DeployForm } from "../deploy.js";
import { desiredSites } from "./desired.js";

function form(overrides: Partial<DeployForm> = {}): DeployForm {
  return {
    startPrimary: true,
    startSecondary: false,
    clonePeer: false,
    pullLatest: false,
    primaryPort: 8789,
    secondaryPort: 8790,
    publicHost: "qubius.example.com",
    publicHostSecondary: "co-qubius.example.com",
    allowedHostsExtra: "",
    authMode: "auto",
    authToken: "",
    terminal: true,
    maxConcurrent: 4,
    approvalTimeoutMinutes: 10,
    limits: { ...DEFAULT_LIMITS },
    lanEnabled: false,
    lanAuthUser: "qubius",
    lanAuthPassword: "",
    lanHost: "",
    configDir: "/tmp/qubius",
    primaryDir: "/tmp/qubius-run",
    secondaryDir: "/tmp/co-qubius-run",
    dataPrimary: "/tmp/qubius-data",
    dataSecondary: "/tmp/co-qubius-data",
    primaryRepoUrl: "http://gitea.example.com/example/qubius.git",
    secondaryRepoUrl: "http://gitea.example.com/example/co-qubius.git",
    primaryRef: "main",
    archiveDir: "",
    archiveRetentionDays: 30,
    nodeBin: "",
    projects: [],
    ...overrides,
  };
}

test("主/副实例都启用时生成 qubius 与 co-qubius", () => {
  const result = desiredSites(form({ startSecondary: true }));
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.disabledRoles, []);
  assert.deepEqual(result.sites, [
    {
      name: "qubius",
      domains: ["qubius.example.com"],
      env: "dev",
      upstream: "http://127.0.0.1:8789",
      auth: "dev",
      sse: true,
    },
    {
      name: "co-qubius",
      domains: ["co-qubius.example.com"],
      env: "dev",
      upstream: "http://127.0.0.1:8790",
      auth: "dev",
      sse: true,
    },
  ]);
});

test("停用角色不产生 desired，并写入 disabledRoles 与 warning", () => {
  const result = desiredSites(form({ startPrimary: false, startSecondary: true }));
  assert.deepEqual(result.sites.map((site) => site.name), ["co-qubius"]);
  assert.deepEqual(result.disabledRoles, ["primary"]);
  assert.match(result.warnings.join("\n"), /主实例未启用.*旧条目保留/);
});

test("两个角色使用相同公网域名时 warning 并跳过副实例", () => {
  const result = desiredSites(
    form({ startSecondary: true, publicHost: "same.example.com", publicHostSecondary: "SAME.example.com." }),
  );
  assert.deepEqual(result.sites.map((site) => site.name), ["qubius"]);
  assert.match(result.warnings.join("\n"), /相同的公网域名/);
});

test("启用了但没有公网域名时给 warning 并跳过", () => {
  const result = desiredSites(form({ publicHost: "   " }));
  assert.equal(result.sites.length, 0);
  assert.match(result.warnings.join("\n"), /公网域名为空/);
});

test("域名按 edgectl 规则校验：小写、去尾点、拒绝通配/无 TLD", () => {
  const ok = desiredSites(form({ publicHost: "QUBIUS.Example.COM.", startSecondary: false }));
  assert.deepEqual(ok.sites[0]?.domains, ["qubius.example.com"]);

  const wildcard = desiredSites(form({ publicHost: "*.example.com" }));
  assert.equal(wildcard.sites.length, 0);
  assert.match(wildcard.warnings.join("\n"), /通配/);

  const noTld = desiredSites(form({ publicHost: "localhost" }));
  assert.equal(noTld.sites.length, 0);
  assert.match(noTld.warnings.join("\n"), /不是合法域名/);
});

test("role 参数不影响站点集合（只影响默认表单推导）", () => {
  const primary = desiredSites(form({ startSecondary: true }), "primary");
  const secondary = desiredSites(form({ startSecondary: true }), "secondary");
  assert.deepEqual(primary, secondary);
});
