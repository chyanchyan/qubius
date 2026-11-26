import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bootstrapConfig, DEFAULT_ALLOWED_HOSTS, DEFAULT_LIMITS, loadConfig, parseListen } from "./config.js";

// 开发 shell 可能带着部署用的 QUBIUS_PROJECTS_FILE；测试只读临时目录。
delete process.env.QUBIUS_PROJECTS_FILE;
delete process.env.REMOTE_CODER_PROJECTS_FILE;

test("只接受本机回环地址", () => {
  assert.deepEqual(parseListen("localhost:8787"), { host: "127.0.0.1", port: 8787 });
  assert.throws(() => parseListen("0.0.0.0:8787"), /127\.0\.0\.1/);
  assert.throws(() => parseListen("192.168.0.8:8787"), /127\.0\.0\.1/);
});

test("相对 dataDir 和项目路径相对配置文件解析", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  const project = path.join(dir, "repo");
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    [
      "listen: 127.0.0.1:8787",
      "dataDir: ./data",
      "projects:",
      "  - id: sample",
      "    name: Sample",
      "    path: ./repo",
      "",
    ].join("\n"),
  );
  const config = loadConfig(path.join(dir, "config.yaml"));
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.dataDir, path.join(dir, "data"));
  assert.equal(config.projects[0]?.path, project);
  assert.equal(config.projects[0]?.permission, "acceptEdits");
  assert.equal(config.maxConcurrent, 4);
  assert.equal(config.approvalTimeoutMinutes, 10);
});

test("approvalTimeoutMinutes 可配置，0 表示不自动拒绝，非法值会被拒绝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, ["listen: 127.0.0.1:8787", "dataDir: ./data", "approvalTimeoutMinutes: 60", ""].join("\n"));
  assert.equal(loadConfig(file).approvalTimeoutMinutes, 60);
  fs.writeFileSync(file, ["listen: 127.0.0.1:8787", "dataDir: ./data", "approvalTimeoutMinutes: 0", ""].join("\n"));
  assert.equal(loadConfig(file).approvalTimeoutMinutes, 0);
  for (const invalid of ["1441", "1.5", '"10"']) {
    fs.writeFileSync(file, ["listen: 127.0.0.1:8787", "dataDir: ./data", `approvalTimeoutMinutes: ${invalid}`, ""].join("\n"));
    assert.throws(() => loadConfig(file), /approvalTimeoutMinutes/);
  }
});

test("项目可以指定授权级别，未知值会被拒绝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    [
      "listen: 127.0.0.1:8787",
      "projects:",
      "  - id: sample",
      "    name: Sample",
      "    path: .",
      "    permission: bypassPermissions",
      "",
    ].join("\n"),
  );
  const config = loadConfig(path.join(dir, "config.yaml"));
  assert.equal(config.projects[0]?.permission, "bypassPermissions");
  fs.writeFileSync(
    path.join(dir, "bad.yaml"),
    [
      "listen: 127.0.0.1:8787",
      "projects:",
      "  - id: sample",
      "    name: Sample",
      "    path: .",
      "    permission: yolo",
      "",
    ].join("\n"),
  );
  assert.throws(() => loadConfig(path.join(dir, "bad.yaml")), /permission/);
});

test("项目可以标记 isolated，默认 false，非布尔值会被拒绝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    [
      "listen: 127.0.0.1:8787",
      "projects:",
      "  - id: chat",
      "    name: 普通对话",
      "    path: .",
      "    isolated: true",
      "  - id: sample",
      "    name: Sample",
      "    path: .",
      "",
    ].join("\n"),
  );
  const config = loadConfig(path.join(dir, "config.yaml"));
  assert.equal(config.projects[0]?.isolated, true);
  assert.equal(config.projects[1]?.isolated, false);

  fs.writeFileSync(
    path.join(dir, "bad.yaml"),
    [
      "listen: 127.0.0.1:8787",
      "projects:",
      "  - id: chat",
      "    name: 普通对话",
      "    path: .",
      "    isolated: \"true\"",
      "",
    ].join("\n"),
  );
  assert.throws(() => loadConfig(path.join(dir, "bad.yaml")), /isolated/);
});

test("默认是主实例，副实例解析 primaryRepo 和维护脚本", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  fs.writeFileSync(
    path.join(dir, "primary.yaml"),
    [
      "listen: 127.0.0.1:8787",
      "projects:",
      "  - id: sample",
      "    name: Sample",
      "    path: .",
      "",
    ].join("\n"),
  );
  const primary = loadConfig(path.join(dir, "primary.yaml"));
  assert.equal(primary.role, "primary");
  assert.equal(primary.secondary, undefined);

  fs.writeFileSync(
    path.join(dir, "secondary.yaml"),
    [
      "role: secondary",
      "secondary:",
      "  primaryRepo: ./primary",
      "listen: 127.0.0.1:8788",
      "projects:",
      "  - id: sample",
      "    name: Sample",
      "    path: .",
      "",
    ].join("\n"),
  );
  const secondary = loadConfig(path.join(dir, "secondary.yaml"));
  assert.equal(secondary.role, "secondary");
  assert.equal(secondary.secondary?.primaryRepo, path.join(dir, "primary"));
  assert.equal(secondary.secondary?.primaryRef, "main");
  assert.equal(secondary.secondary?.script, path.join(dir, "secondary.sh"));
  assert.equal(secondary.secondary?.restart, path.join(dir, "run.sh"));
});

test("始终内置普通对话项目，projects 可以为空", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  fs.writeFileSync(
    path.join(dir, "chat.yaml"),
    ["listen: 127.0.0.1:8787", "dataDir: ./data", ""].join("\n"),
  );
  const config = loadConfig(path.join(dir, "chat.yaml"));
  assert.deepEqual(config.projects, [
    {
      id: "chat",
      name: "普通对话",
      path: path.join(dir, "data", "chat"),
      permission: "acceptEdits",
      isolated: true,
      builtin: true,
    },
  ]);
});

test("自己配置 chat 项目时不重复添加内置项目", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  fs.writeFileSync(
    path.join(dir, "chat.yaml"),
    [
      "listen: 127.0.0.1:8787",
      "projects:",
      "  - id: chat",
      "    name: 我的对话",
      "    path: ./mine",
      "",
    ].join("\n"),
  );
  const config = loadConfig(path.join(dir, "chat.yaml"));
  assert.equal(config.projects.length, 1);
  assert.equal(config.projects[0]?.name, "我的对话");
  assert.equal(config.projects[0]?.builtin, undefined);
});

test("归档默认按主/副实例分目录，相对路径相对配置文件解析", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  fs.writeFileSync(
    path.join(dir, "primary.yaml"),
    [
      "listen: 127.0.0.1:8787",
      "archive:",
      "  dir: ./hdd",
      "",
    ].join("\n"),
  );
  const primary = loadConfig(path.join(dir, "primary.yaml"));
  assert.deepEqual(primary.archive, {
    dir: path.join(dir, "hdd"),
    retentionDays: 30,
    instance: "main",
  });

  fs.writeFileSync(
    path.join(dir, "secondary.yaml"),
    [
      "role: secondary",
      "secondary:",
      "  primaryRepo: ./primary",
      "listen: 127.0.0.1:8788",
      "archive:",
      "  dir: /archive/remote-coder",
      "  retentionDays: 7",
      "  instance: bak",
      "",
    ].join("\n"),
  );
  const secondary = loadConfig(path.join(dir, "secondary.yaml"));
  assert.deepEqual(secondary.archive, {
    dir: "/archive/remote-coder",
    retentionDays: 7,
    instance: "bak",
  });

  // 副实例省略 instance 时默认 bak，主实例默认 main。
  fs.writeFileSync(
    path.join(dir, "secondary-default.yaml"),
    [
      "role: secondary",
      "secondary:",
      "  primaryRepo: ./primary",
      "archive:",
      "  dir: ./hdd",
      "",
    ].join("\n"),
  );
  assert.equal(loadConfig(path.join(dir, "secondary-default.yaml")).archive?.instance, "bak");
  assert.equal(loadConfig(path.join(dir, "primary.yaml")).archive?.instance, "main");
});

test("归档配置会拒绝非法天数和实例名", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  const write = (name: string, lines: string[]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, ["listen: 127.0.0.1:8787", ...lines, ""].join("\n"));
    return file;
  };
  assert.throws(
    () => loadConfig(write("no-dir.yaml", ["archive:", "  retentionDays: 30"])),
    /archive\.dir/,
  );
  assert.throws(
    () => loadConfig(write("bad-days.yaml", ["archive:", "  dir: ./hdd", "  retentionDays: 0"])),
    /retentionDays/,
  );
  assert.throws(
    () => loadConfig(write("big-days.yaml", ["archive:", "  dir: ./hdd", "  retentionDays: 3651"])),
    /retentionDays/,
  );
  assert.throws(
    () => loadConfig(write("float-days.yaml", ["archive:", "  dir: ./hdd", "  retentionDays: 1.5"])),
    /retentionDays/,
  );
  assert.throws(
    () => loadConfig(write("bad-instance.yaml", ["archive:", "  dir: ./hdd", "  instance: ../x"])),
    /instance/,
  );
  assert.throws(
    () => loadConfig(write("not-object.yaml", ["archive: hello"])),
    /archive/,
  );
  // 边界值本身是合法的。
  assert.equal(
    loadConfig(write("min-days.yaml", ["archive:", "  dir: ./hdd", "  retentionDays: 1"]))
      .archive?.retentionDays,
    1,
  );
  assert.equal(
    loadConfig(write("max-days.yaml", ["archive:", "  dir: ./hdd", "  retentionDays: 3650"]))
      .archive?.retentionDays,
    3650,
  );
  fs.writeFileSync(
    path.join(dir, "no-archive.yaml"),
    ["listen: 127.0.0.1:8787", ""].join("\n"),
  );
  assert.equal(loadConfig(path.join(dir, "no-archive.yaml")).archive, undefined);
});

test("冷启动 bootstrap：文件不存在也能得到可用配置和内置普通对话", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-bootstrap-"));
  const file = path.join(home, "cfg", "config.yaml");
  const repoRoot = path.join(home, "repo");
  const config = bootstrapConfig(file, repoRoot, { HOME: home });
  assert.equal(config.role, "primary");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.configDir, path.dirname(file));
  assert.equal(config.dataDir, path.join(home, ".local", "share", "qubius"));
  assert.equal(config.maxConcurrent, 4);
  assert.equal(config.archive, undefined);
  assert.deepEqual(config.allowedHosts, [...DEFAULT_ALLOWED_HOSTS]);
  assert.deepEqual(config.projects, [{
    id: "chat",
    name: "普通对话",
    path: path.join(config.dataDir, "chat"),
    permission: "acceptEdits",
    isolated: true,
    builtin: true,
  }]);
});

test("冷启动 bootstrap：副实例读取端口、数据目录和 primaryRepo", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-bootstrap-"));
  const file = path.join(home, "cfg", "config-secondary.yaml");
  const repoRoot = path.join(home, "repo");
  const primaryDir = path.join(home, "primary-checkout");
  const config = bootstrapConfig(file, repoRoot, {
    HOME: home,
    QUBIUS_SECONDARY: "1",
    QUBIUS_SECONDARY_PORT: "9123",
    QUBIUS_PRIMARY_PORT: "9999",
    QUBIUS_DATA_SECONDARY: path.join(home, "data-bak"),
    QUBIUS_PRIMARY_DIR: primaryDir,
    QUBIUS_PRIMARY_REF: "release",
    QUBIUS_MAX_CONCURRENT: "7",
  });
  assert.equal(config.role, "secondary");
  assert.equal(config.port, 9123);
  assert.equal(config.configDir, path.dirname(file));
  assert.equal(config.dataDir, path.join(home, "data-bak"));
  assert.equal(config.maxConcurrent, 7);
  assert.deepEqual(config.secondary, {
    primaryRepo: primaryDir,
    primaryRef: "release",
    script: path.join(repoRoot, "deploy", "secondary.sh"),
    restart: path.join(repoRoot, "deploy", "run.sh"),
  });
  assert.equal(config.projects[0]?.id, "chat");
  assert.equal(config.projects[0]?.path, path.join(home, "data-bak", "chat"));
});

test("冷启动 bootstrap：主实例端口和数据目录可覆盖，非法值回退默认", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-bootstrap-"));
  const file = path.join(home, "config.yaml");
  const config = bootstrapConfig(file, home, {
    HOME: home,
    QUBIUS_PRIMARY_PORT: "70000",
    QUBIUS_DATA_PRIMARY: path.join(home, "custom-data"),
    QUBIUS_MAX_CONCURRENT: "300",
  });
  assert.equal(config.port, 8787);
  assert.equal(config.dataDir, path.join(home, "custom-data"));
  assert.equal(config.maxConcurrent, 4);
  assert.equal(config.projects[0]?.path, path.join(home, "custom-data", "chat"));
  // 兼容旧变量名。
  const legacy = bootstrapConfig(file, home, {
    HOME: home,
    REMOTE_CODER_SECONDARY: "1",
    REMOTE_CODER_SECONDARY_PORT: "9000",
  });
  assert.equal(legacy.role, "secondary");
  assert.equal(legacy.port, 9000);
});

test("冷启动 bootstrap 的数据目录遵循 XDG_DATA_HOME", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-bootstrap-"));
  const xdg = path.join(home, "xdg-data");
  const config = bootstrapConfig(path.join(home, "config.yaml"), home, {
    HOME: home,
    XDG_DATA_HOME: xdg,
  });
  assert.equal(config.dataDir, path.join(xdg, "qubius"));
  assert.equal(config.projects[0]?.path, path.join(xdg, "qubius", "chat"));
});

test("terminal 默认开启，配置文件优先于 QUBIUS_TERMINAL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, ["listen: 127.0.0.1:8787", ""].join("\n"));
  assert.equal(loadConfig(file, {}).terminal, true);
  assert.equal(loadConfig(file, { QUBIUS_TERMINAL: "0" }).terminal, false);
  assert.equal(loadConfig(file, { QUBIUS_TERMINAL: "1" }).terminal, true);
  assert.throws(() => loadConfig(file, { QUBIUS_TERMINAL: "off" }), /QUBIUS_TERMINAL/);

  fs.writeFileSync(file, ["listen: 127.0.0.1:8787", "terminal: false", ""].join("\n"));
  assert.equal(loadConfig(file, { QUBIUS_TERMINAL: "1" }).terminal, false);
  fs.writeFileSync(file, ["listen: 127.0.0.1:8787", "terminal: true", ""].join("\n"));
  assert.equal(loadConfig(file, { QUBIUS_TERMINAL: "0" }).terminal, true);
  fs.writeFileSync(file, ["listen: 127.0.0.1:8787", "terminal: no-thanks", ""].join("\n"));
  assert.throws(() => loadConfig(file, {}), /terminal 必须是 true 或 false/);
});

test("limits 默认值，可按 config.yaml 段和环境变量覆盖", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, ["listen: 127.0.0.1:8787", ""].join("\n"));
  // 传空 env，避免测试机器的环境变量影响默认值断言。
  assert.deepEqual(loadConfig(file, {}).limits, DEFAULT_LIMITS);

  fs.writeFileSync(
    file,
    [
      "listen: 127.0.0.1:8787",
      "limits:",
      "  transcriptBytes: 1048576",
      "  transcriptMessages: 100",
      "  messageText: 5000",
      "  requestBodyBytes: 2097152",
      "  historyPage: 300",
      "",
    ].join("\n"),
  );
  assert.deepEqual(loadConfig(file, {}).limits, {
    transcriptBytes: 1_048_576,
    transcriptMessages: 100,
    messageText: 5_000,
    requestBodyBytes: 2_097_152,
    historyPage: 300,
  });

  // 环境变量优先于配置文件。
  const fromEnv = loadConfig(file, {
    QUBIUS_LIMIT_TRANSCRIPT_BYTES: "8388608",
    QUBIUS_LIMIT_TRANSCRIPT_MESSAGES: "200",
    QUBIUS_LIMIT_MESSAGE_TEXT: "300000",
    QUBIUS_LIMIT_REQUEST_BODY: "4194304",
    QUBIUS_HISTORY_PAGE: "100",
  });
  assert.deepEqual(fromEnv.limits, {
    transcriptBytes: 8_388_608,
    transcriptMessages: 200,
    messageText: 300_000,
    requestBodyBytes: 4_194_304,
    historyPage: 100,
  });
});

test("limits 非法（含环境变量）时按配置错误风格报错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  const write = (name: string, lines: string[]): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, ["listen: 127.0.0.1:8787", ...lines, ""].join("\n"));
    return file;
  };
  assert.throws(() => loadConfig(write("not-map.yaml", ["limits: hello"]), {}), /limits 必须是映射/);
  assert.throws(
    () => loadConfig(write("small-bytes.yaml", ["limits:", "  transcriptBytes: 1024"]), {}),
    /limits\.transcriptBytes/,
  );
  assert.throws(
    () => loadConfig(write("big-messages.yaml", ["limits:", "  transcriptMessages: 20001"]), {}),
    /limits\.transcriptMessages/,
  );
  assert.throws(
    () => loadConfig(write("string-text.yaml", ["limits:", "  messageText: '5000'"]), {}),
    /limits\.messageText/,
  );
  assert.throws(
    () => loadConfig(write("small-body.yaml", ["limits:", "  requestBodyBytes: 1024"]), {}),
    /limits\.requestBodyBytes/,
  );
  assert.throws(
    () => loadConfig(write("small-page.yaml", ["limits:", "  historyPage: 49"]), {}),
    /limits\.historyPage/,
  );
  const file = write("env.yaml", []);
  assert.throws(
    () => loadConfig(file, { QUBIUS_LIMIT_TRANSCRIPT_MESSAGES: "50000" }),
    /QUBIUS_LIMIT_TRANSCRIPT_MESSAGES/,
  );
  assert.throws(
    () => loadConfig(file, { QUBIUS_HISTORY_PAGE: "abc" }),
    /QUBIUS_HISTORY_PAGE/,
  );
  // 边界值本身合法。
  const min = loadConfig(write("min.yaml", [
    "limits:",
    "  transcriptBytes: 65536",
    "  transcriptMessages: 50",
    "  messageText: 1024",
    "  requestBodyBytes: 1048576",
    "  historyPage: 50",
  ]), {}).limits;
  assert.deepEqual(min, {
    transcriptBytes: 65_536,
    transcriptMessages: 50,
    messageText: 1_024,
    requestBodyBytes: 1_048_576,
    historyPage: 50,
  });
});

test("allowedHosts 未配置时默认只允许回环主机，显式配置仍生效", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, ["listen: 127.0.0.1:8787", ""].join("\n"));
  const config = loadConfig(file, {});
  assert.deepEqual(config.allowedHosts, ["127.0.0.1", "localhost", "[::1]"]);
  // 返回的是副本：修改它不会影响共享的默认常量。
  config.allowedHosts.push("evil.example");
  assert.deepEqual([...DEFAULT_ALLOWED_HOSTS], ["127.0.0.1", "localhost", "[::1]"]);

  fs.writeFileSync(
    file,
    ["listen: 127.0.0.1:8787", "allowedHosts:", "  - Example.COM", "  - '::1'", ""].join("\n"),
  );
  assert.deepEqual(loadConfig(file, {}).allowedHosts, ["example.com", "[::1]"]);

  // 显式空数组仍然报错，避免误以为关闭了校验。
  fs.writeFileSync(file, ["listen: 127.0.0.1:8787", "allowedHosts: []", ""].join("\n"));
  assert.throws(() => loadConfig(file, {}), /allowedHosts 不能为空数组/);
});

test("auth 和 authToken 可从 YAML 与环境变量读取", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  const file = path.join(dir, "config.yaml");
  const base = ["listen: 127.0.0.1:8787", ""];
  fs.writeFileSync(file, [...base, "auth: true", "authToken: 0123456789abcdef", ""].join("\n"));
  const fromYaml = loadConfig(file, {});
  assert.equal(fromYaml.auth, true);
  assert.equal(fromYaml.authToken, "0123456789abcdef");

  fs.writeFileSync(file, base.join("\n"));
  const fromEnv = loadConfig(file, {
    QUBIUS_AUTH: "1",
    QUBIUS_AUTH_TOKEN: "fedcba9876543210",
  });
  assert.equal(fromEnv.auth, true);
  assert.equal(fromEnv.authToken, "fedcba9876543210");

  // YAML 已写 auth 时环境变量不覆盖；未写时环境变量生效。
  fs.writeFileSync(file, [...base, "auth: false", ""].join("\n"));
  const yamlFalse = loadConfig(file, { QUBIUS_AUTH: "1", QUBIUS_AUTH_TOKEN: "fedcba9876543210" });
  assert.equal(yamlFalse.auth, false);
  assert.equal(yamlFalse.authToken, "fedcba9876543210");

  // 非法类型直接报错。
  fs.writeFileSync(file, [...base, 'auth: "true"', ""].join("\n"));
  assert.throws(() => loadConfig(file, {}), /auth 必须是 true 或 false/);
  fs.writeFileSync(file, [...base, "authToken: 123", ""].join("\n"));
  assert.throws(() => loadConfig(file, {}), /authToken 必须是非空字符串/);
  fs.writeFileSync(file, [...base, 'authToken: ""', ""].join("\n"));
  assert.throws(() => loadConfig(file, {}), /authToken 必须是非空字符串/);
});

test("冷启动 bootstrap 也读取 auth 环境变量", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-bootstrap-"));
  const config = bootstrapConfig(path.join(home, "config.yaml"), home, {
    HOME: home,
    QUBIUS_AUTH: "1",
    QUBIUS_AUTH_TOKEN: "0123456789abcdef",
  });
  assert.equal(config.auth, true);
  assert.equal(config.authToken, "0123456789abcdef");
  assert.deepEqual(config.allowedHosts, [...DEFAULT_ALLOWED_HOSTS]);
});

test("冷启动 bootstrap 也读取 limits 环境变量", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-bootstrap-"));
  const config = bootstrapConfig(path.join(home, "config.yaml"), home, {
    HOME: home,
    QUBIUS_LIMIT_TRANSCRIPT_MESSAGES: "120",
    QUBIUS_HISTORY_PAGE: "80",
  });
  assert.deepEqual(config.limits, { ...DEFAULT_LIMITS, transcriptMessages: 120, historyPage: 80 });
});

test("副实例必须配置 primaryRepo，role 只能是 primary 或 secondary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  fs.writeFileSync(
    path.join(dir, "missing.yaml"),
    [
      "role: secondary",
      "listen: 127.0.0.1:8788",
      "projects:",
      "  - id: sample",
      "    name: Sample",
      "    path: .",
      "",
    ].join("\n"),
  );
  assert.throws(() => loadConfig(path.join(dir, "missing.yaml")), /primaryRepo/);
  fs.writeFileSync(
    path.join(dir, "bad-role.yaml"),
    [
      "role: backup",
      "listen: 127.0.0.1:8788",
      "projects:",
      "  - id: sample",
      "    name: Sample",
      "    path: .",
      "",
    ].join("\n"),
  );
  assert.throws(() => loadConfig(path.join(dir, "bad-role.yaml")), /role/);
});

test("额外项目文件合并进项目列表，同 id 覆盖 config.yaml", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(
    file,
    [
      "listen: 127.0.0.1:8787",
      "projects:",
      "  - id: sample",
      "    name: Sample",
      "    path: ./repo",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "projects.yaml"),
    [
      "  - id: extra",
      "    name: Extra",
      "    path: ./extra",
      "    permission: plan",
      "  - id: sample",
      "    name: Sample 2",
      "    path: ./other",
      "",
    ].join("\n"),
  );
  const config = loadConfig(file, {});
  assert.equal(config.projectsFile, path.join(dir, "projects.yaml"));
  const byId = new Map(config.projects.map((project) => [project.id, project]));
  assert.equal(byId.get("extra")?.path, path.join(dir, "extra"));
  assert.equal(byId.get("extra")?.permission, "plan");
  assert.equal(byId.get("sample")?.name, "Sample 2");
  assert.equal(byId.get("sample")?.path, path.join(dir, "other"));
  assert.ok(byId.has("chat"));
  // 热加载以 config.yaml 自带的项目为底稿，额外文件只覆盖同 id 项。
  assert.equal(config.projectsBase?.find((project) => project.id === "sample")?.path, path.join(dir, "repo"));
});

test("QUBIUS_PROJECTS_FILE 相对配置目录解析", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, ["listen: 127.0.0.1:8787", ""].join("\n"));
  fs.writeFileSync(
    path.join(dir, "custom-projects.yaml"),
    ["  - id: extra", "    name: Extra", "    path: ./extra", ""].join("\n"),
  );
  const config = loadConfig(file, { QUBIUS_PROJECTS_FILE: "custom-projects.yaml" });
  assert.equal(config.projectsFile, path.join(dir, "custom-projects.yaml"));
  assert.ok(config.projects.some((project) => project.id === "extra"));
});

test("额外项目文件损坏时保留 config.yaml 项目", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-config-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(
    file,
    [
      "listen: 127.0.0.1:8787",
      "projects:",
      "  - id: sample",
      "    name: Sample",
      "    path: ./repo",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "projects.yaml"), "projects: nope\n");
  const config = loadConfig(file, {});
  assert.deepEqual(config.projects.map((project) => project.id), ["sample", "chat"]);
});

test("冷启动 bootstrap 也合并额外项目文件", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-bootstrap-"));
  const configDir = path.join(home, "cfg");
  fs.mkdirSync(configDir);
  fs.writeFileSync(
    path.join(configDir, "projects.yaml"),
    ["  - id: extra", "    name: Extra", "    path: ./extra", ""].join("\n"),
  );
  const config = bootstrapConfig(path.join(configDir, "config.yaml"), home, { HOME: home });
  assert.ok(config.projects.some((project) => project.id === "extra"));
  assert.ok(config.projects.some((project) => project.id === "chat"));
});
