import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  activeSessionsFromHealth,
  backupNodeModules,
  buildDirtyStatus,
  busyDecision,
  choosePullRemote,
  classifyIPv4,
  cleanupNodeModulesPrev,
  deployDecision,
  deployPorts,
  discardStaging,
  isLanIPv4,
  lanAddress,
  needsInstall,
  proxyChildEnv,
  proxyPlan,
  parseEnvFile,
  readDeployStamp,
  redactUrl,
  renderConfigYaml,
  repoRootFromServerScript,
  restoreNodeModules,
  restoreNodeModulesWhenBackedUp,
  rollbackDist,
  samePath,
  stagingProblems,
  stripAnsi,
  swapDist,
  validateProjectsIndent,
  writeDeployStamp,
} from "./deploy-lib.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qubius-deploy-lib-"));
}

test("parseEnvFile 支持注释、引号、$HOME 与 %VAR%", () => {
  const env = { HOME: "/home/me", APPDATA: "C:\\Users\\me\\AppData\\Roaming" };
  const values = parseEnvFile([
    "# 注释",
    "QUBIUS_PRIMARY_PORT=9123",
    "export QUBIUS_SECONDARY_PORT='9124'",
    'QUBIUS_PUBLIC_HOST="code.example.com" # 行尾注释',
    "QUBIUS_PRIMARY_DIR=$HOME/qubius",
    "QUBIUS_SECONDARY_DIR=${HOME}/co-qubius",
    "QUBIUS_ARCHIVE_DIR=%APPDATA%\\archive",
    "EMPTY=",
    "",
  ].join("\r\n"), env);
  assert.equal(values.QUBIUS_PRIMARY_PORT, "9123");
  assert.equal(values.QUBIUS_SECONDARY_PORT, "9124");
  assert.equal(values.QUBIUS_PUBLIC_HOST, "code.example.com");
  assert.equal(values.QUBIUS_PRIMARY_DIR, "/home/me/qubius");
  assert.equal(values.QUBIUS_SECONDARY_DIR, "/home/me/co-qubius");
  assert.equal(values.QUBIUS_ARCHIVE_DIR, "C:\\Users\\me\\AppData\\Roaming\\archive");
  assert.equal(values.EMPTY, "");
});

test("renderConfigYaml 主实例可被 yaml 解析，projects 与 archive 正确", () => {
  const text = renderConfigYaml({
    role: "primary",
    dataDir: "C:\\Users\\me\\AppData\\Local\\qubius",
    port: 8787,
    publicHost: "code.example.com",
    maxConcurrent: 6,
    archiveDir: "D:\\archive\\qubius",
    archiveRetentionDays: 60,
    peerId: "co-qubius",
    peerName: "co-qubius",
    peerPath: "C:\\Users\\me\\co-qubius",
    projectsText: [
      "  - id: 'demo'",
      "    name: '示例'",
      "    path: 'D:\\src\\demo'",
      "    permission: plan",
      "",
    ].join("\n"),
  });
  const doc = parseYaml(text);
  assert.equal(doc.role, "primary");
  assert.equal(doc.listen, "127.0.0.1:8787");
  assert.equal(doc.dataDir, "C:\\Users\\me\\AppData\\Local\\qubius");
  assert.deepEqual(doc.allowedHosts, ["127.0.0.1", "localhost", "[::1]", "code.example.com"]);
  assert.equal(doc.maxConcurrent, 6);
  assert.equal(doc.archive.dir, "D:\\archive\\qubius");
  assert.equal(doc.archive.retentionDays, 60);
  assert.equal(doc.archive.instance, "main");
  assert.deepEqual(doc.projects.map((item) => item.id), ["co-qubius", "demo"]);
  assert.equal(doc.projects[1].path, "D:\\src\\demo");
});

test("renderConfigYaml 副实例包含 secondary 块且没有 archive 时省略", () => {
  const text = renderConfigYaml({
    role: "secondary",
    dataDir: "/srv/co-data",
    port: 8788,
    publicHost: "code-bak.example.com",
    peerId: "qubius",
    peerName: "qubius",
    peerPath: "/srv/qubius",
    secondary: {
      primaryRepo: "/srv/qubius",
      primaryRef: "main",
      script: "/srv/co-qubius/deploy/secondary.sh",
      restart: "/srv/co-qubius/deploy/run.sh",
    },
  });
  const doc = parseYaml(text);
  assert.equal(doc.role, "secondary");
  assert.equal(doc.secondary.primaryRepo, "/srv/qubius");
  assert.equal(doc.secondary.primaryRef, "main");
  assert.equal(doc.secondary.script, "/srv/co-qubius/deploy/secondary.sh");
  assert.equal(doc.secondary.restart, "/srv/co-qubius/deploy/run.sh");
  assert.equal(doc.archive, undefined);
  assert.deepEqual(doc.projects.map((item) => item.id), ["qubius"]);
});

test("没有对端 checkout 时不写空 path，localhost 不重复", () => {
  const text = renderConfigYaml({
    role: "primary",
    dataDir: "/data",
    port: 8787,
    publicHost: "localhost",
    peerId: "co-qubius",
    peerName: "co-qubius",
    peerPath: "",
  });
  const doc = parseYaml(text);
  // peerPath 为空时不能写 path: ''，否则 server 启动时会拒绝配置。
  assert.equal(doc.projects, undefined);
  assert.deepEqual(doc.allowedHosts, ["127.0.0.1", "localhost", "[::1]"]);
  // 没有对端但还有额外项目时要保留 projects: 键。
  const withExtra = parseYaml(renderConfigYaml({
    role: "primary",
    dataDir: "/data",
    port: 8787,
    publicHost: "code.example.com",
    peerId: "co-qubius",
    peerName: "co-qubius",
    peerPath: "",
    projectsText: "  - id: 'demo'\n    name: '演示'\n    path: '/srv/demo'\n",
  }));
  assert.deepEqual(withExtra.projects.map((item) => item.id), ["demo"]);
});

test("renderConfigYaml 拒绝控制字符并保持单行", () => {
  const text = renderConfigYaml({
    role: "primary",
    dataDir: "D:\\data",
    port: 8787,
    publicHost: "code.example.com",
    peerId: "co-qubius",
    peerName: "co-qubius",
    peerPath: "D:\\peer",
  });
  assert.ok(!text.includes("\r"));
  const doc = parseYaml(text);
  assert.equal(doc.projects[0].path, "D:\\peer");
});

test("validateProjectsIndent 接受两空格/四空格，拒绝制表符和错误缩进", () => {
  assert.deepEqual(
    validateProjectsIndent("  - id: 'a'\n    name: 'a'\n\n    permission: plan\n"),
    { ok: true },
  );
  const tab = validateProjectsIndent("  - id: 'a'\n\tname: 'a'\n");
  assert.equal(tab.ok, false);
  assert.equal(tab.line, 2);
  const bad = validateProjectsIndent("  - id: 'a'\n   name: 'a'\n");
  assert.equal(bad.ok, false);
  assert.equal(bad.line, 2);
});

test("needsInstall 按 package-lock 哈希判断", () => {
  const repo = tmp();
  fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
  assert.equal(needsInstall(repo), true);
  const nodeModules = path.join(repo, "node_modules");
  fs.mkdirSync(nodeModules);
  assert.equal(needsInstall(repo), true);
  const hash = crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(repo, "package-lock.json")))
    .digest("hex");
  fs.writeFileSync(path.join(nodeModules, ".qubius-lock-hash"), `${hash}\n`);
  assert.equal(needsInstall(repo), false);
  fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n\n");
  assert.equal(needsInstall(repo), true);
});

test("repoRootFromServerScript 只接受生产 server 的入口", () => {
  const repo = path.join(os.tmpdir(), "qubius-repo");
  assert.equal(
    repoRootFromServerScript(path.join(repo, "server", "dist", "index.js")),
    path.resolve(repo),
  );
  // tsx 开发模式或无关进程不会被当成部署目标。
  assert.equal(repoRootFromServerScript(path.join(repo, "server", "src", "index.ts")), "");
  assert.equal(repoRootFromServerScript(""), "");
  // Windows 盘符大小写不敏感，POSIX 保持严格比较。
  assert.equal(samePath("C:\\Users\\A", "c:\\users\\a", "win32"), true);
  assert.equal(samePath(repo, repo, "linux"), true);
  assert.equal(samePath(repo, `${repo}-other`, "linux"), false);
});

test("stripAnsi 去掉 vite/npm 的颜色码", () => {
  assert.equal(
    stripAnsi("\u001b[36mvite\u001b[39m \u001b[32m✓ built\u001b[39m"),
    "vite ✓ built",
  );
  assert.equal(stripAnsi("plain"), "plain");
});

test("redactUrl 隐藏 URL 里的凭据", () => {
  assert.equal(
    redactUrl("clone http://user:pass@git.example.com/x.git"),
    "clone http://***@git.example.com/x.git",
  );
});

test("activeSessionsFromHealth 安全取数", () => {
  assert.equal(activeSessionsFromHealth({ activeSessions: 3 }), 3);
  assert.equal(activeSessionsFromHealth({ activeSessions: 0 }), 0);
  assert.equal(activeSessionsFromHealth({}), 0);
  assert.equal(activeSessionsFromHealth(null), 0);
  assert.equal(activeSessionsFromHealth({ activeSessions: "2" }), 0);
  assert.equal(activeSessionsFromHealth({ activeSessions: -1 }), 0);
});

test("busyDecision：空闲放行、FORCE 放行、WAIT/非交互语义", () => {
  assert.equal(busyDecision({ activeSessions: 0 }).action, "proceed");
  assert.equal(busyDecision({ activeSessions: 2, force: true }).action, "proceed");
  const wait = busyDecision({ activeSessions: 2, waitSeconds: 30 });
  assert.equal(wait.action, "wait");
  assert.equal(wait.waitSeconds, 30);
  assert.equal(busyDecision({ activeSessions: 2 }).action, "fail");
  // WAIT=0 与非法值都不应静默放行。
  assert.equal(busyDecision({ activeSessions: 2, waitSeconds: 0 }).action, "wait");
  assert.equal(busyDecision({ activeSessions: 2, waitSeconds: Number.NaN }).action, "fail");
  assert.equal(busyDecision({ activeSessions: 2, waitSeconds: -1 }).action, "fail");
});

test("deployDecision：无变化且健康时跳过", () => {
  const stamp = { head: "abc", configHash: "c1", envHash: "e1" };
  const decision = deployDecision({
    buildNeeded: false,
    configHash: "c1",
    envHash: "e1",
    stamp,
    head: "abc",
    healthy: true,
  });
  assert.deepEqual(decision, { restart: false, build: false, reason: "无变化" });
});

test("deployDecision：需要构建时构建并重启", () => {
  const decision = deployDecision({
    buildNeeded: true,
    configHash: "c1",
    envHash: "e1",
    stamp: { head: "abc", configHash: "c1", envHash: "e1" },
    head: "abc",
    healthy: true,
  });
  assert.equal(decision.restart, true);
  assert.equal(decision.build, true);
});

test("deployDecision：config / env / HEAD 变化都重启（但不重建）", () => {
  const base = {
    buildNeeded: false,
    configHash: "c1",
    envHash: "e1",
    stamp: { head: "abc", configHash: "c1", envHash: "e1" },
    head: "abc",
    healthy: true,
  };
  const configChanged = deployDecision({ ...base, configHash: "c2" });
  assert.equal(configChanged.restart, true);
  assert.equal(configChanged.build, false);
  const envChanged = deployDecision({ ...base, envHash: "e2" });
  assert.equal(envChanged.restart, true);
  const headChanged = deployDecision({ ...base, head: "def" });
  assert.equal(headChanged.restart, true);
});

test("deployDecision：不健康、无 stamp、强制重启都重启", () => {
  const healthy = {
    buildNeeded: false,
    configHash: "c1",
    envHash: "e1",
    stamp: { head: "abc", configHash: "c1", envHash: "e1" },
    head: "abc",
    healthy: true,
  };
  assert.equal(deployDecision({ ...healthy, healthy: false }).restart, true);
  assert.equal(deployDecision({ ...healthy, stamp: null }).restart, true);
  assert.equal(deployDecision({ ...healthy, head: "" }).restart, true);
  assert.equal(deployDecision({ ...healthy, forceRestart: true }).restart, true);
});

test("deploy stamp 原子写入后可读回（含端口）", () => {
  const dir = tmp();
  const file = path.join(dir, ".deploy-stamp");
  assert.equal(readDeployStamp(file), null);
  writeDeployStamp(file, { head: "abc", configHash: "c1", envHash: "e1", port: 19789 });
  assert.deepEqual(readDeployStamp(file), {
    head: "abc",
    configHash: "c1",
    envHash: "e1",
    port: "19789",
  });
  fs.writeFileSync(file, "{broken");
  assert.equal(readDeployStamp(file), null);
});

test("deployPorts 同时包含新端口、stamp 旧端口和父进程端口并去重", () => {
  assert.deepEqual(deployPorts({ port: 8787 }), [8787]);
  assert.deepEqual(deployPorts({ port: 8787, stampPort: "8788" }), [8787, 8788]);
  assert.deepEqual(
    deployPorts({ port: 8787, stampPort: 8787, parentPort: 8788, isParent: true }),
    [8787, 8788],
  );
  // 非父角色不采用 parentPort；非法端口忽略。
  assert.deepEqual(deployPorts({ port: 8787, parentPort: 8788, isParent: false }), [8787]);
  assert.deepEqual(deployPorts({ port: 8787, stampPort: "bad", parentPort: 70000, isParent: true }), [8787]);
});

test("proxyPlan：重启 / 存活 / 启动", () => {
  assert.equal(proxyPlan({ restart: true, pidAlive: true }), "restart");
  assert.equal(proxyPlan({ pidAlive: true }), "keep");
  assert.equal(proxyPlan({ listening: true }), "keep");
  assert.equal(proxyPlan({}), "start");
});

// ── 局域网地址分类 ──────────────────────────────────────────────────────────
test("classifyIPv4：私有段边界", () => {
  assert.equal(classifyIPv4("10.0.0.0"), "private");
  assert.equal(classifyIPv4("10.255.255.255"), "private");
  assert.equal(classifyIPv4("9.255.255.255"), "public");
  assert.equal(classifyIPv4("11.0.0.0"), "public");

  assert.equal(classifyIPv4("172.16.0.0"), "private");
  assert.equal(classifyIPv4("172.31.255.255"), "private");
  assert.equal(classifyIPv4("172.15.255.255"), "public");
  assert.equal(classifyIPv4("172.32.0.0"), "public");

  assert.equal(classifyIPv4("192.168.0.0"), "private");
  assert.equal(classifyIPv4("192.168.255.255"), "private");
  assert.equal(classifyIPv4("192.167.255.255"), "public");
  assert.equal(classifyIPv4("192.169.0.0"), "public");
});

test("classifyIPv4：CGNAT、链路本地、回环、0.0.0.0、组播、保留与公网", () => {
  assert.equal(classifyIPv4("100.64.0.0"), "shared");
  assert.equal(classifyIPv4("100.127.255.255"), "shared");
  assert.equal(classifyIPv4("100.63.255.255"), "public");
  assert.equal(classifyIPv4("100.128.0.0"), "public");

  assert.equal(classifyIPv4("169.254.0.1"), "link-local");
  assert.equal(classifyIPv4("169.254.255.255"), "link-local");
  assert.equal(classifyIPv4("169.253.255.255"), "public");

  assert.equal(classifyIPv4("127.0.0.1"), "loopback");
  assert.equal(classifyIPv4("127.255.255.255"), "loopback");
  assert.equal(classifyIPv4("0.0.0.0"), "unspecified");
  assert.equal(classifyIPv4("224.0.0.1"), "multicast");
  assert.equal(classifyIPv4("240.0.0.1"), "reserved");
  assert.equal(classifyIPv4("255.255.255.255"), "reserved");
  assert.equal(classifyIPv4("192.0.2.1"), "reserved");
  assert.equal(classifyIPv4("198.18.0.1"), "reserved");
  assert.equal(classifyIPv4("198.51.100.1"), "reserved");
  assert.equal(classifyIPv4("203.0.113.10"), "reserved");
  assert.equal(classifyIPv4("8.8.8.8"), "public");

  assert.equal(classifyIPv4("not-an-ip"), "invalid");
  assert.equal(classifyIPv4("999.1.1.1"), "invalid");
  assert.equal(classifyIPv4("1.2.3"), "invalid");
  assert.equal(classifyIPv4("010.0.0.1"), "invalid");
});

test("isLanIPv4 只接受私有 / CGNAT / 链路本地", () => {
  for (const address of ["10.1.2.3", "172.20.0.1", "192.168.1.5", "100.64.1.2", "169.254.9.9"]) {
    assert.equal(isLanIPv4(address), true, address);
  }
  for (const address of ["8.8.8.8", "127.0.0.1", "0.0.0.0", "224.0.0.1", "203.0.113.1"]) {
    assert.equal(isLanIPv4(address), false, address);
  }
});

const quiet = () => {};
const interfacesOf = (entries) => Object.fromEntries(entries.map(([name, address, extra = {}]) => [
  name,
  [{ address, family: "IPv4", internal: false, ...extra }],
]));

test("lanAddress：显式 LAN_PROXY_HOST / QUBIUS_LAN_HOST 优先", () => {
  const interfaces = interfacesOf([["eth0", "192.168.1.5"]]);
  assert.equal(
    lanAddress({ env: { LAN_PROXY_HOST: "10.0.0.9", QUBIUS_LAN_HOST: "192.168.1.5" }, interfaces, warn: quiet }),
    "10.0.0.9",
  );
  assert.equal(
    lanAddress({ env: { QUBIUS_LAN_HOST: "10.1.1.1" }, interfaces, warn: quiet }),
    "10.1.1.1",
  );
  // 空字符串等同于未设置，回退自动选择。
  assert.equal(
    lanAddress({ env: { LAN_PROXY_HOST: "  ", QUBIUS_LAN_HOST: "" }, interfaces, warn: quiet }),
    "192.168.1.5",
  );
});

test("lanAddress：自动跳过公网/回环/docker，按 private > shared > link-local 选择", () => {
  const interfaces = Object.assign(
    interfacesOf([
      ["eth0", "8.8.8.8"],
      ["eth1", "169.254.10.20"],
      ["lo", "127.0.0.1", { internal: true }],
      ["docker0", "10.1.1.1"],
      ["eth2", "100.64.3.4"],
    ]),
    { eth3: [{ address: "::1", family: "IPv6", internal: true }] },
  );
  // CGNAT 优先于链路本地，即使链路本地网卡排在前面。
  assert.equal(lanAddress({ env: {}, interfaces, warn: quiet }), "100.64.3.4");

  // 私有段优先于 CGNAT/链路本地，与网卡顺序无关。
  const mixed = interfacesOf([
    ["eth0", "8.8.8.8"],
    ["eth1", "169.254.10.20"],
    ["eth2", "100.64.3.4"],
    ["eth3", "10.20.30.40"],
  ]);
  assert.equal(lanAddress({ env: {}, interfaces: mixed, warn: quiet }), "10.20.30.40");

  const privateOnly = interfacesOf([
    ["eth0", "8.8.8.8"],
    ["eth1", "192.168.10.20"],
  ]);
  assert.equal(lanAddress({ env: {}, interfaces: privateOnly, warn: quiet }), "192.168.10.20");
});

test("lanAddress：没有可用私有地址时报错并提示显式设置", () => {
  const interfaces = interfacesOf([
    ["eth0", "8.8.8.8"],
    ["lo", "127.0.0.1", { internal: true }],
    ["docker0", "10.0.0.1"],
  ]);
  assert.throws(
    () => lanAddress({ env: {}, interfaces, warn: quiet }),
    /LAN_PROXY_HOST|QUBIUS_LAN_HOST/,
  );
});

test("lanAddress：显式公网地址允许但告警，私有地址不告警", () => {
  const warnings = [];
  assert.equal(
    lanAddress({
      env: { LAN_PROXY_HOST: "8.8.8.8" },
      interfaces: interfacesOf([]),
      warn: (text) => warnings.push(text),
    }),
    "8.8.8.8",
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /公网地址/);
  assert.match(warnings[0], /Basic/);

  const quietWarnings = [];
  assert.equal(
    lanAddress({
      env: { LAN_PROXY_HOST: "192.168.1.8" },
      interfaces: interfacesOf([]),
      warn: (text) => quietWarnings.push(text),
    }),
    "192.168.1.8",
  );
  assert.deepEqual(quietWarnings, []);
});

test("lanAddress：显式值校验，非法地址给出明确错误", () => {
  for (const bad of ["bad host", "999.1.1.1", "1.2.3", "010.0.0.1"]) {
    assert.throws(
      () => lanAddress({ env: { LAN_PROXY_HOST: bad }, interfaces: interfacesOf([]), warn: quiet }),
      /不是合法的 IP 或主机名/,
      bad,
    );
  }
  // 合法主机名和 IPv6 可以显式设置。
  assert.equal(
    lanAddress({ env: { LAN_PROXY_HOST: "lan.local" }, interfaces: interfacesOf([]), warn: quiet }),
    "lan.local",
  );
  assert.equal(
    lanAddress({ env: { LAN_PROXY_HOST: "::1" }, interfaces: interfacesOf([]), warn: quiet }),
    "::1",
  );
});

test("proxyChildEnv：两个显式变量并存时子进程环境与探活地址一致", () => {
  const env = { LAN_PROXY_HOST: "10.0.0.9", QUBIUS_LAN_HOST: "192.168.1.5" };
  const host = lanAddress({ env, interfaces: interfacesOf([["eth0", "172.20.0.2"]]), warn: quiet });
  const childEnv = proxyChildEnv({ FOO: "bar", LAN_PROXY_HOST: "192.168.1.5" }, host);
  // 探活和子进程都使用 LAN_PROXY_HOST 的解析结果，而不是 QUBIUS_LAN_HOST。
  assert.equal(host, "10.0.0.9");
  assert.equal(childEnv.LAN_PROXY_HOST, host);
  assert.equal(childEnv.FOO, "bar");
});

// ── staging / 切换 / 回滚 ────────────────────────────────────────────────────
function writeStaging(repo, marker, { server = true, web = true } = {}) {
  if (server) {
    const dir = path.join(repo, "server", "dist.next");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), `${marker}\n`);
    fs.writeFileSync(path.join(dir, "build.json"), `{"head":"${marker}"}\n`);
  }
  if (web) {
    const dir = path.join(repo, "web", "dist.next");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), `${marker}\n`);
  }
}

function liveMarker(repo) {
  try {
    return fs.readFileSync(path.join(repo, "server", "dist", "index.js"), "utf8").trim();
  } catch {
    return "";
  }
}

test("swapDist 拒绝不完整的 staging，且不动 live", () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, "server", "dist"), { recursive: true });
  fs.mkdirSync(path.join(repo, "web", "dist"), { recursive: true });
  fs.writeFileSync(path.join(repo, "server", "dist", "index.js"), "old\n");
  fs.writeFileSync(path.join(repo, "web", "dist", "index.html"), "old\n");
  writeStaging(repo, "new", { web: false });
  assert.deepEqual(stagingProblems(repo), ["web/dist.next/index.html"]);
  assert.throws(() => swapDist(repo), /staging 不完整/);
  assert.equal(liveMarker(repo), "old");
  assert.equal(fs.existsSync(path.join(repo, "server", "dist.next", "index.js")), true);
});

test("swapDist 首次部署（无旧 live）不产生 .prev", () => {
  const repo = tmp();
  writeStaging(repo, "v1");
  swapDist(repo);
  assert.equal(liveMarker(repo), "v1");
  assert.equal(fs.existsSync(path.join(repo, "server", "dist.next")), false);
  assert.equal(fs.existsSync(path.join(repo, "server", "dist.prev")), false);
  assert.equal(fs.existsSync(path.join(repo, "web", "dist.prev")), false);
});

test("swapDist 保留旧 live 到 .prev，再 rollbackDist 恢复", () => {
  const repo = tmp();
  writeStaging(repo, "v1");
  swapDist(repo);
  writeStaging(repo, "v2");
  swapDist(repo);
  assert.equal(liveMarker(repo), "v2");
  assert.equal(fs.readFileSync(path.join(repo, "server", "dist.prev", "index.js"), "utf8").trim(), "v1");

  rollbackDist(repo);
  assert.equal(liveMarker(repo), "v1");
  assert.equal(fs.existsSync(path.join(repo, "server", "dist.prev")), false);
  assert.equal(fs.existsSync(path.join(repo, "web", "dist.prev")), false);
});

test("rollbackDist 没有 .prev 时抛错且不动 live", () => {
  const repo = tmp();
  writeStaging(repo, "v1");
  swapDist(repo);
  writeStaging(repo, "v2");
  assert.throws(() => rollbackDist(repo), /无法回滚/);
  assert.equal(liveMarker(repo), "v1");
});

test("rollbackDist 清掉残留 .next", () => {
  const repo = tmp();
  writeStaging(repo, "v1");
  swapDist(repo);
  writeStaging(repo, "v2");
  swapDist(repo);
  writeStaging(repo, "stale");
  rollbackDist(repo);
  assert.equal(liveMarker(repo), "v1");
  assert.equal(fs.existsSync(path.join(repo, "server", "dist.next")), false);
  assert.equal(fs.existsSync(path.join(repo, "web", "dist.next")), false);
});

test("新版本启动失败后 rollbackDist 恢复旧版本", () => {
  // 对应用户可见流程：stage v1 -> swap -> stage v2 -> swap -> 启动失败 -> rollback。
  const repo = tmp();
  writeStaging(repo, "v1");
  swapDist(repo);
  writeStaging(repo, "v2");
  swapDist(repo);
  assert.equal(liveMarker(repo), "v2");
  rollbackDist(repo);
  assert.equal(liveMarker(repo), "v1");
  assert.equal(fs.readFileSync(path.join(repo, "web", "dist", "index.html"), "utf8").trim().length > 0, true);
});

test("未备份的部署失败时不恢复陈旧的 node_modules.prev", () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(path.join(repo, "node_modules", "current.txt"), "current\n");
  fs.mkdirSync(path.join(repo, "node_modules.prev"));
  fs.writeFileSync(path.join(repo, "node_modules.prev", "stale.txt"), "stale\n");
  // 本次没有执行 npm ci / 备份：绝不拿旧 .prev 覆盖当前依赖。
  assert.equal(restoreNodeModulesWhenBackedUp(repo, false), false);
  assert.equal(fs.readFileSync(path.join(repo, "node_modules", "current.txt"), "utf8"), "current\n");
  assert.equal(fs.readFileSync(path.join(repo, "node_modules.prev", "stale.txt"), "utf8"), "stale\n");
  // 明确标记本次备份过时才恢复。
  assert.equal(restoreNodeModulesWhenBackedUp(repo, true), true);
  assert.equal(fs.readFileSync(path.join(repo, "node_modules", "stale.txt"), "utf8"), "stale\n");
});

test("discardStaging 只清 .next，不动 live/.prev", () => {
  const repo = tmp();
  writeStaging(repo, "v1");
  swapDist(repo);
  writeStaging(repo, "v2");
  discardStaging(repo);
  assert.equal(liveMarker(repo), "v1");
  assert.equal(fs.existsSync(path.join(repo, "server", "dist.next")), false);
});

test("backupNodeModules / restoreNodeModules / cleanup", () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(path.join(repo, "node_modules", "old.txt"), "old\n");
  assert.equal(backupNodeModules(repo), true);
  assert.equal(fs.existsSync(path.join(repo, "node_modules")), false);
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(path.join(repo, "node_modules", "new.txt"), "new\n");
  assert.equal(restoreNodeModules(repo), true);
  assert.equal(fs.readFileSync(path.join(repo, "node_modules", "old.txt"), "utf8"), "old\n");
  assert.equal(fs.existsSync(path.join(repo, "node_modules.prev")), false);
  // 没有备份时返回 false。
  assert.equal(restoreNodeModules(repo), false);
  // 备份时先删旧 .prev。
  backupNodeModules(repo);
  fs.mkdirSync(path.join(repo, "node_modules.prev.tmp"));
  cleanupNodeModulesPrev(repo);
  assert.equal(fs.existsSync(path.join(repo, "node_modules.prev")), false);

  // node_modules 缺失时不应删掉可能还可用的旧 .prev。
  const repo2 = tmp();
  fs.mkdirSync(path.join(repo2, "node_modules.prev"));
  fs.writeFileSync(path.join(repo2, "node_modules.prev", "keep.txt"), "keep\n");
  assert.equal(backupNodeModules(repo2), false);
  assert.equal(fs.readFileSync(path.join(repo2, "node_modules.prev", "keep.txt"), "utf8"), "keep\n");
});

test("choosePullRemote：显式 > github 远端 > github.com 的 origin > origin", () => {
  // 显式远端优先，即使开了 GitHub 偏好。
  assert.equal(
    choosePullRemote({ override: "upstream", preferGithub: true, hasGithub: true }),
    "upstream",
  );
  // 有名为 github 的远端时直接用它。
  assert.equal(
    choosePullRemote({ preferGithub: true, hasGithub: true, originUrl: "https://gitlab.example/x.git" }),
    "github",
  );
  // 没有 github 远端，但 origin 就是 GitHub：用 origin。
  assert.equal(
    choosePullRemote({ preferGithub: true, hasGithub: false, originUrl: "git@github.com:owner/repo.git" }),
    "origin",
  );
  // 没有 GitHub 远端：回落到 origin（即使它指向私有仓库）。
  assert.equal(
    choosePullRemote({ preferGithub: true, hasGithub: false, originUrl: "https://gitlab.example/x.git" }),
    "origin",
  );
  // 没开偏好时始终 origin。
  assert.equal(choosePullRemote({ hasGithub: true }), "origin");
});

test("buildDirtyStatus 排除构建 staging 的 dist.next/dist.prev", () => {
  const repo = tmp();
  const gitRun = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  gitRun(["init", "-q"]);
  fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
  gitRun(["add", "package.json"]);
  gitRun(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  fs.mkdirSync(path.join(repo, "server", "dist.next"), { recursive: true });
  fs.writeFileSync(path.join(repo, "server", "dist.next", "index.js"), "x");
  fs.mkdirSync(path.join(repo, "web", "dist.prev"), { recursive: true });
  fs.writeFileSync(path.join(repo, "web", "dist.prev", "index.html"), "x");
  assert.equal((buildDirtyStatus(repo).stdout ?? "").trim(), "");
  // 真正的源码改动仍然算脏。
  fs.writeFileSync(path.join(repo, "server", "new.js"), "x");
  assert.match(buildDirtyStatus(repo).stdout ?? "", /server\//);
});
