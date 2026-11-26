import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_REGISTRY,
  REGISTRIES,
  defaultConfigDir,
  expandHome,
  isAbsolutePath,
  listenerPids,
  nextFreePort,
  normalizeConfigDir,
  parseArgs,
  parseLsofPids,
  parseNetstatPids,
  parsePort,
  parsePsInfo,
  parseSsPids,
  parseTasklistInfo,
  portInUse,
  processInfo,
  registryFromInput,
  stopProcess,
  waitPortFree,
} from "./quickstart-lib.mjs";

test("npm 源支持默认、序号、自定义地址和非法输入", () => {
  assert.equal(registryFromInput(""), DEFAULT_REGISTRY);
  assert.equal(registryFromInput("  "), DEFAULT_REGISTRY);
  assert.equal(registryFromInput("1"), REGISTRIES[0].url);
  assert.equal(registryFromInput("2"), REGISTRIES[1].url);
  assert.equal(registryFromInput(String(REGISTRIES.length)), REGISTRIES.at(-1).url);
  assert.equal(registryFromInput("https://mirror.example.com/npm/"), "https://mirror.example.com/npm/");
  assert.equal(registryFromInput("9"), undefined);
  assert.equal(registryFromInput("淘宝"), undefined);
});

test("参数解析支持等号和空格两种写法", () => {
  assert.deepEqual(parseArgs(["--registry", "2", "--config-dir", "/srv/qubius-conf"]), {
    registry: "2",
    configDir: "/srv/qubius-conf",
  });
  assert.deepEqual(parseArgs(["--registry=https://npm.example.com/", "--help"]), {
    registry: "https://npm.example.com/",
    help: true,
  });
  assert.deepEqual(parseArgs(["--bogus"]), { unknown: ["--bogus"] });
  assert.deepEqual(parseArgs(["--dry-run"]), { dryRun: true });
  assert.deepEqual(parseArgs(["--port", "9123"]), { port: "9123" });
  assert.deepEqual(parseArgs(["--port=9123"]), { port: "9123" });
  assert.deepEqual(parseArgs(["--verbose"]), { verbose: true });
  assert.deepEqual(parseArgs(["-v"]), { verbose: true });
  assert.deepEqual(parseArgs(["--loglevel", "silly"]), { loglevel: "silly" });
  assert.deepEqual(parseArgs(["--loglevel=info"]), { loglevel: "info" });
});

test("端口解析只接受 1–65535 的整数", () => {
  assert.equal(parsePort("8787"), 8787);
  assert.equal(parsePort(" 9123 "), 9123);
  assert.equal(parsePort("1"), 1);
  assert.equal(parsePort("65535"), 65535);
  assert.equal(parsePort("0"), undefined);
  assert.equal(parsePort("65536"), undefined);
  assert.equal(parsePort("87a"), undefined);
  assert.equal(parsePort(""), undefined);
});

test("端口检测能区分监听中和空闲端口", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  assert.equal(await portInUse(port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portInUse(port), false);
  assert.equal(await nextFreePort(port - 1), port);
});

test("端口占用解析兼容 lsof、ss、netstat 和 tasklist", () => {
  assert.deepEqual(parseLsofPids("1234\n5678\n1234\n"), [1234, 5678]);
  const ss = [
    "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
    'LISTEN 0 511 127.0.0.1:8787 0.0.0.0:* users:(("node",pid=1234,fd=22))',
    'LISTEN 0 511 [::]:8787 [::]:* users:(("node",pid=1234,fd=23))',
    'LISTEN 0 511 127.0.0.1:9000 0.0.0.0:* users:(("other",pid=999,fd=1))',
  ].join("\n");
  assert.deepEqual(parseSsPids(ss, 8787), [1234]);

  const netstat = [
    "  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       1234",
    "  TCP    127.0.0.1:9000         0.0.0.0:0              LISTENING       999",
    "  TCP    127.0.0.1:8787         127.0.0.1:50000        ESTABLISHED     1234",
  ].join("\r\n");
  assert.deepEqual(parseNetstatPids(netstat, 8787), [1234]);

  assert.deepEqual(parsePsInfo(" 1234 node     /usr/bin/node server/dist/index.js\n", 1234), {
    pid: 1234,
    name: "node",
    command: "/usr/bin/node server/dist/index.js",
  });
  assert.deepEqual(parseTasklistInfo('"node.exe","1234","Console","1","50,000 K"', 1234), {
    pid: 1234,
    name: "node.exe",
    command: "",
  });
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("能找到监听端口并停止对应进程", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows 使用 netstat/taskkill，交由手工验证");
    return;
  }
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["-e", `require("node:net").createServer().listen(${port}, "127.0.0.1")`],
    { stdio: "ignore" },
  );
  try {
    assert.equal(await waitUntil(() => portInUse(port), 5000), true, "监听进程没有启动");
    const { pids } = listenerPids(port);
    assert.ok(pids.includes(child.pid), `没有找到子进程 ${child.pid}：${pids.join(",")}`);

    const info = processInfo(child.pid);
    assert.ok(info);
    assert.match(info.name, /node/i);

    stopProcess(child.pid);
    assert.equal(await waitPortFree(port, 5000), true, "停止后端口没有释放");
  } finally {
    child.kill("SIGKILL");
  }
});

test("默认配置目录与部署脚本一致", () => {
  assert.equal(
    defaultConfigDir({ HOME: "/home/me" }, "linux"),
    path.posix.join("/home/me/.config", "qubius"),
  );
  assert.equal(
    defaultConfigDir({ HOME: "/home/me", XDG_CONFIG_HOME: "/srv/config" }, "linux"),
    path.posix.join("/srv/config", "qubius"),
  );
  assert.equal(
    defaultConfigDir({ APPDATA: String.raw`C:\Users\me\AppData\Roaming` }, "win32"),
    String.raw`C:\Users\me\AppData\Roaming\qubius`,
  );
  assert.equal(
    defaultConfigDir({ USERPROFILE: String.raw`C:\Users\me` }, "win32"),
    String.raw`C:\Users\me\AppData\Roaming\qubius`,
  );
});

test("配置目录支持 Home 展开并拒绝相对路径", () => {
  assert.equal(expandHome("~/qubius", { HOME: "/home/me" }, "linux"), "/home/me/qubius");
  assert.equal(expandHome("~\\qubius", { USERPROFILE: String.raw`C:\Users\me` }, "win32"), String.raw`C:\Users\me\qubius`);
  assert.equal(normalizeConfigDir("~/cfg", { HOME: "/home/me" }, "linux"), "/home/me/cfg");
  assert.equal(normalizeConfigDir(String.raw`C:\Users\me\cfg`, { APPDATA: String.raw`C:\Users\me\AppData\Roaming` }, "win32"), String.raw`C:\Users\me\cfg`);
  assert.throws(() => normalizeConfigDir("relative/cfg", { HOME: "/home/me" }, "linux"), /绝对路径/);
  assert.equal(isAbsolutePath("/srv/cfg", "linux"), true);
  assert.equal(isAbsolutePath(String.raw`C:\cfg`, "win32"), true);
  assert.equal(isAbsolutePath(String.raw`\\server\share`, "win32"), true);
});
