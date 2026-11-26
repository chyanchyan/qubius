import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  DeployValidationError,
  applyDeploy,
  deployBusy,
  deployEnvValues,
  deployJobSpec,
  deployLogFile,
  deriveDeployForm,
  detectRepoUrl,
  readDeployState,
  mergeEnvText,
  readDeployJob,
  renderProjectsYaml,
  startDeployJob,
  validateDeployForm,
  writeDeployEnv,
  writeDeployJob,
  writeProjectsFile,
  type DeployForm,
  type DeployProject,
} from "./deploy.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qubius-deploy-"));
}

/** detached 部署脚本是异步的：轮询等待它写出的记录文件。 */
async function waitForFile(file: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待文件超时：${file}`);
}

/**
 * 同时写出 POSIX 和 Windows 两套部署入口，让同一组测试在两种平台上都能跑：
 * Linux 用 deploy-job.sh，Windows 用 deploy-job.mjs。
 */
function writeJob(dir: string, bashBody: string, mjsBody: string): void {
  fs.mkdirSync(path.join(dir, "deploy"), { recursive: true });
  const bash = path.join(dir, "deploy", "deploy-job.sh");
  fs.writeFileSync(bash, bashBody);
  fs.chmodSync(bash, 0o755);
  fs.writeFileSync(path.join(dir, "deploy", "deploy-job.mjs"), mjsBody);
}

function makeRepo(dir: string): void {
  for (const name of ["install.sh", "start-all.sh", "build.sh"]) {
    fs.mkdirSync(path.join(dir, "deploy"), { recursive: true });
    const file = path.join(dir, "deploy", name);
    fs.writeFileSync(file, "#!/bin/bash\nexit 0\n");
    fs.chmodSync(file, 0o755);
  }
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "deploy", "deploy-lib.mjs"), "export {};\n");
  writeJob(dir, "#!/bin/bash\nexit 0\n", "process.exit(0);\n");
}

function validForm(base: string): DeployForm {
  const primary = path.join(base, "primary");
  const secondary = path.join(base, "secondary");
  makeRepo(primary);
  makeRepo(secondary);
  return {
    startPrimary: true,
    startSecondary: false,
    clonePeer: false,
    pullLatest: false,
    primaryPort: 8787,
    secondaryPort: 8788,
    publicHost: "code.example.com",
    publicHostSecondary: "",
    lanHost: "",
    configDir: path.join(base, "config"),
    primaryDir: primary,
    secondaryDir: secondary,
    dataPrimary: path.join(base, "data-primary"),
    dataSecondary: path.join(base, "data-secondary"),
    primaryRepoUrl: "http://example.com/example/qubius.git",
    secondaryRepoUrl: "http://example.com/example/co-qubius.git",
    primaryRef: "main",
    archiveDir: "",
    archiveRetentionDays: 30,
    nodeBin: "",
    projects: [],
  };
}

function withSecondary(form: DeployForm): DeployForm {
  return {
    ...form,
    startSecondary: true,
    publicHostSecondary: "code-bak.example.com",
  };
}

test("默认值来自 $HOME，端口和仓库地址符合部署约定", () => {
  const home = tmp();
  const { configDir, envFile, form } = deriveDeployForm({ HOME: home });
  assert.equal(configDir, path.join(home, ".config", "qubius"));
  assert.equal(envFile, path.join(configDir, "env"));
  assert.equal(form.startPrimary, true);
  assert.equal(form.startSecondary, false);
  assert.equal(form.clonePeer, false);
  assert.equal(form.pullLatest, false);
  assert.equal(form.primaryPort, 8787);
  assert.equal(form.secondaryPort, 8788);
  assert.equal(form.publicHost, "");
  assert.equal(form.publicHostSecondary, "");
  assert.equal(form.lanHost, "");
  assert.equal(form.configDir, configDir);
  assert.equal(form.primaryDir, path.join(home, "qubius"));
  assert.equal(form.secondaryDir, path.join(home, "co-qubius"));
  assert.equal(form.dataPrimary, path.join(home, ".local", "share", "qubius"));
  assert.equal(form.dataSecondary, path.join(home, ".local", "share", "co-qubius"));
  assert.equal(form.primaryRepoUrl, "http://gitea.example.com/example/qubius.git");
  assert.equal(form.secondaryRepoUrl, "http://gitea.example.com/example/qubius.git");
  assert.equal(form.primaryRef, "main");
  assert.equal(form.archiveDir, "");
  assert.equal(form.archiveRetentionDays, 30);
  assert.equal(form.nodeBin, "");
  assert.deepEqual(form.projects, []);
});

test("副仓库地址未设置时跟随主仓库的 env 覆盖值", () => {
  const home = tmp();
  const { form } = deriveDeployForm({
    HOME: home,
    QUBIUS_PRIMARY_REPO_URL: "https://git.example.com/team/qubius.git",
  });
  assert.equal(form.primaryRepoUrl, "https://git.example.com/team/qubius.git");
  assert.equal(form.secondaryRepoUrl, "https://git.example.com/team/qubius.git");
});

test("冷启动默认值跟随角色：副实例默认只启动自己", () => {
  const home = tmp();
  const primary = deriveDeployForm({ HOME: home }).form;
  assert.equal(primary.startPrimary, true);
  assert.equal(primary.startSecondary, false);
  const secondary = deriveDeployForm({ HOME: home }, "secondary").form;
  assert.equal(secondary.startPrimary, false);
  assert.equal(secondary.startSecondary, true);
  // env 里显式配置仍然优先。
  const configDir = path.join(home, "cfg");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "env"), "QUBIUS_START_PRIMARY=1\nQUBIUS_START_SECONDARY=0\n");
  const explicit = deriveDeployForm({ HOME: home, QUBIUS_CONFIG_DIR: configDir }, "secondary").form;
  assert.equal(explicit.startPrimary, true);
  assert.equal(explicit.startSecondary, false);
});

test("从 env 文件读取表单，支持引号、$HOME 和外部 projects 文件", () => {
  const home = tmp();
  const configDir = path.join(home, "cfg");
  fs.mkdirSync(configDir, { recursive: true });
  const projectsFile = path.join(home, "projects.yaml");
  const projectPath = path.join(home, "srv", "demo");
  const archiveDir = path.join(home, "archive", "qubius");
  fs.writeFileSync(projectsFile, [
    "- id: demo",
    "  name: 示例",
    `  path: ${projectPath}`,
    "  permission: plan",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(configDir, "env"), [
    "# 用户注释",
    "QUBIUS_PRIMARY_PORT=9123",
    "QUBIUS_SECONDARY_PORT='9124'",
    "QUBIUS_START_SECONDARY=1",
    "QUBIUS_PUBLIC_HOST=code.example.com",
    'QUBIUS_PUBLIC_HOST_SECONDARY="code-bak.example.com"',
    "QUBIUS_PRIMARY_DIR=$HOME/repo",
    `QUBIUS_ARCHIVE_DIR=${archiveDir}`,
    "QUBIUS_MAX_CONCURRENT=8",
    "QUBIUS_PRIMARY_REF=dev",
    "QUBIUS_NODE_BIN=/usr/bin/node",
    "QUBIUS_PROJECTS_FILE=$HOME/projects.yaml",
    "QUBIUS_GITEA_TOKEN=should-not-matter",
    "",
  ].join("\n"));

  const { form } = deriveDeployForm({ HOME: home, QUBIUS_CONFIG_DIR: configDir });
  assert.equal(form.primaryPort, 9123);
  assert.equal(form.secondaryPort, 9124);
  assert.equal(form.startSecondary, true);
  assert.equal(form.publicHost, "code.example.com");
  assert.equal(form.publicHostSecondary, "code-bak.example.com");
  assert.equal(form.primaryDir, path.join(home, "repo"));
  assert.equal(form.archiveDir, archiveDir);
  assert.equal(form.primaryRef, "dev");
  assert.equal(form.nodeBin, "/usr/bin/node");
  assert.deepEqual(form.projects, [{
    id: "demo",
    name: "示例",
    path: projectPath,
    permission: "plan",
    isolated: false,
  }]);
});

test("XDG 目录与 deploy/lib.sh 保持一致", () => {
  const home = tmp();
  const { configDir, form } = deriveDeployForm({
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
  });
  assert.equal(configDir, path.join(home, "xdg-config", "qubius"));
  assert.equal(form.dataPrimary, path.join(home, "xdg-data", "qubius"));
  assert.equal(form.dataSecondary, path.join(home, "xdg-data", "co-qubius"));
});

test("Windows 默认目录使用 %APPDATA% 和 %LOCALAPPDATA%", () => {
  const profile = tmp();
  const appData = path.join(profile, "AppData", "Roaming");
  const localAppData = path.join(profile, "AppData", "Local");
  const { configDir, envFile, form } = deriveDeployForm(
    { USERPROFILE: profile, APPDATA: appData, LOCALAPPDATA: localAppData },
    "primary",
    undefined,
    "win32",
  );
  assert.equal(configDir, path.join(appData, "qubius"));
  assert.equal(envFile, path.join(configDir, "env"));
  assert.equal(form.dataPrimary, path.join(localAppData, "qubius"));
  assert.equal(form.dataSecondary, path.join(localAppData, "co-qubius"));
  // 真实 Windows 环境默认 localhost，本机部署不用先想域名。
  assert.equal(form.publicHost, "localhost");
  // HOME 存在时仍然优先 APPDATA（Windows 的机器级配置习惯）。
  const withHome = deriveDeployForm(
    { HOME: path.join(profile, "home"), APPDATA: appData, LOCALAPPDATA: localAppData },
    "primary",
    undefined,
    "win32",
  );
  assert.equal(withHome.configDir, path.join(appData, "qubius"));
  // 显式 QUBIUS_CONFIG_DIR 永远优先。
  const explicit = deriveDeployForm(
    { USERPROFILE: profile, APPDATA: appData, QUBIUS_CONFIG_DIR: path.join(profile, "cfg") },
    "primary",
    undefined,
    "win32",
  );
  assert.equal(explicit.configDir, path.join(profile, "cfg"));
});

test("只有 Windows 默认把 repoRoot 当作主实例目录", () => {
  const home = tmp();
  const repoRoot = path.join(home, "some-clone");
  const linux = deriveDeployForm({ HOME: home }, "primary", repoRoot, "linux");
  assert.equal(linux.form.primaryDir, path.join(home, "qubius"));
  // 副实例在 Windows 上也不跟随 repoRoot。
  const secondary = deriveDeployForm(
    { USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming") },
    "secondary",
    repoRoot,
    "win32",
  );
  assert.equal(secondary.form.primaryDir, path.join(home, "qubius"));
  const win = deriveDeployForm(
    { USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming") },
    "primary",
    repoRoot,
    "win32",
  );
  assert.equal(win.form.primaryDir, repoRoot);
});

test("Windows / macOS 表单校验要求 deploy-job.mjs，但不要求 bash 脚本可执行", () => {
  const base = tmp();
  const form = validForm(base);
  // 删掉 Node 部署入口后，win32 / darwin 分支都应当拒绝。
  const job = path.join(form.primaryDir, "deploy", "deploy-job.mjs");
  fs.rmSync(job);
  assert.throws(() => validateDeployForm(form, "win32"), /deploy-job\.mjs/);
  assert.throws(() => validateDeployForm(form, "darwin"), /deploy-job\.mjs/);

  fs.writeFileSync(job, "process.exit(0)\n");
  assert.doesNotThrow(() => validateDeployForm(form, "win32"));
  assert.doesNotThrow(() => validateDeployForm(form, "darwin"));
  // Linux 仍然需要可执行的 install.sh 等脚本。
  assert.doesNotThrow(() => validateDeployForm(form, "linux"));
});

test("部署任务按平台选择 deploy-job：Windows / macOS 用 node + mjs", () => {
  const repo = tmp();
  const win = deployJobSpec({ repoRoot: repo, platform: "win32", execPath: "C:\\node\\node.exe" });
  assert.equal(win.command, "C:\\node\\node.exe");
  assert.deepEqual(win.args, [path.join(repo, "deploy", "deploy-job.mjs")]);
  assert.equal(win.script, path.join(repo, "deploy", "deploy-job.mjs"));
  assert.equal(win.windowsHide, true);

  const custom = deployJobSpec({
    repoRoot: repo,
    platform: "win32",
    nodeBin: "C:\\nvm\\node.exe",
    execPath: "C:\\node\\node.exe",
  });
  assert.equal(custom.command, "C:\\nvm\\node.exe");

  const mac = deployJobSpec({ repoRoot: repo, platform: "darwin", execPath: "/usr/local/bin/node" });
  assert.equal(mac.command, "/usr/local/bin/node");
  assert.deepEqual(mac.args, [path.join(repo, "deploy", "deploy-job.mjs")]);
  assert.equal(mac.script, path.join(repo, "deploy", "deploy-job.mjs"));

  const linux = deployJobSpec({ repoRoot: repo, platform: "linux" });
  assert.equal(linux.command, "bash");
  assert.deepEqual(linux.args, [path.join(repo, "deploy", "deploy-job.sh")]);
  assert.equal(linux.windowsHide, false);
});

test("合法表单通过校验", () => {
  const base = tmp();
  const parsed = validateDeployForm(validForm(base));
  assert.equal(parsed.primaryPort, 8787);
});

test("端口校验：范围、两个实例不能同端口", () => {
  const base = tmp();
  const form = validForm(base);
  assert.throws(() => validateDeployForm({ ...form, primaryPort: 0 }), /端口/);
  assert.throws(() => validateDeployForm({ ...form, primaryPort: 70000 }), /端口/);
  assert.throws(
    () => validateDeployForm({ ...withSecondary(form), secondaryPort: form.primaryPort }),
    /同一个端口/,
  );
});

test("公网域名校验：留空用默认值、格式、两个实例不能相同", () => {
  const base = tmp();
  const form = validForm(base);
  const primaryDefault = validateDeployForm({ ...form, publicHost: "" });
  assert.equal(primaryDefault.publicHost, "code.example.com");
  assert.equal(primaryDefault.publicHostSecondary, "");
  assert.throws(() => validateDeployForm({ ...form, publicHost: "Code.Example.com" }), /公网域名/);
  assert.throws(() => validateDeployForm({ ...form, publicHost: "bad_host" }), /公网域名/);
  const both = withSecondary(form);
  const secondaryDefault = validateDeployForm({ ...both, publicHostSecondary: "" });
  assert.equal(secondaryDefault.publicHostSecondary, "code-bak.example.com");
  assert.throws(
    () => validateDeployForm({ ...both, publicHostSecondary: both.publicHost }),
    /同一个公网域名/,
  );
  assert.throws(
    () => validateDeployForm({
      ...both,
      publicHost: "code-bak.example.com",
      publicHostSecondary: "",
    }),
    /同一个公网域名/,
  );
});

test("路径校验：目录必须是绝对路径，启用的实例要有 install.sh", () => {
  const base = tmp();
  const form = validForm(base);
  assert.throws(() => validateDeployForm({ ...form, primaryDir: "relative/path" }), /绝对路径/);
  assert.throws(() => validateDeployForm({ ...form, archiveDir: "hdd" }), /绝对路径/);

  const noScript = path.join(base, "empty");
  fs.mkdirSync(noScript, { recursive: true });
  assert.throws(
    () => validateDeployForm({ ...form, primaryDir: noScript }),
    process.platform === "win32" ? /deploy-job\.mjs/ : /install\.sh/,
  );
  const missing = path.join(base, "missing");
  assert.throws(() => validateDeployForm({ ...form, primaryDir: missing }), /不存在/);

  // 启用的 checkout 必须能真正跑起来：
  // POSIX 要求 install/start-all/build 可执行；Windows 要求 deploy-job.mjs。
  if (process.platform === "win32") {
    fs.rmSync(path.join(form.primaryDir, "deploy", "deploy-job.mjs"));
    assert.throws(() => validateDeployForm(form), /deploy-job\.mjs/);
  } else {
    fs.chmodSync(path.join(form.primaryDir, "deploy", "start-all.sh"), 0o644);
    assert.throws(() => validateDeployForm(form), /start-all\.sh/);
  }
});

test("clonePeer 允许副实例目录尚不存在，未勾选时仍要求含可执行 install.sh", () => {
  const base = tmp();
  const form = withSecondary(validForm(base));
  const missing = path.join(base, "new-secondary");
  assert.doesNotThrow(() => validateDeployForm({ ...form, clonePeer: true, secondaryDir: missing }));
  assert.throws(
    () => validateDeployForm({ ...form, clonePeer: false, secondaryDir: missing }),
    /不存在/,
  );
  // 父目录是普通文件时无法 clone。
  const fileParent = path.join(base, "not-a-dir");
  fs.writeFileSync(fileParent, "x");
  assert.throws(
    () => validateDeployForm({
      ...form,
      clonePeer: true,
      secondaryDir: path.join(fileParent, "co-qubius"),
    }),
    /父目录/,
  );
});

test("字符串字段拒绝换行和控制字符", () => {
  const base = tmp();
  const form = validForm(base);
  assert.throws(() => validateDeployForm({ ...form, lanHost: "a\nb" }), /控制字符/);
  assert.throws(() => validateDeployForm({ ...form, archiveDir: "/tmp/hdd\u0001" }), /控制字符/);
  assert.throws(() => validateDeployForm({ ...form, primaryDir: `${form.primaryDir}\n` }), /控制字符/);
  assert.throws(
    () => validateDeployForm({
      ...form,
      projects: [{
        id: "demo",
        name: "坏\n名字",
        path: path.join(base, "demo"),
        permission: "auto",
      }],
    }),
    /控制字符/,
  );
});

test("实例开关、仓库地址、分支和数值范围", () => {
  const base = tmp();
  const form = validForm(base);
  assert.throws(
    () => validateDeployForm({ ...form, startPrimary: false, startSecondary: false }),
    /至少需要启用一个实例/,
  );
  assert.throws(() => validateDeployForm({ ...form, primaryRepoUrl: "ftp://x/y.git" }), /http/);
  assert.throws(() => validateDeployForm({ ...form, primaryRef: "" }), /分支/);
  assert.throws(() => validateDeployForm({ ...form, primaryRef: "bad ref" }), /分支/);
  assert.throws(() => validateDeployForm({ ...form, primaryRef: "-option" }), /以 - 开头/);
  assert.throws(() => validateDeployForm({ ...form, primaryRef: "a..b" }), /\.\./);
  assert.throws(() => validateDeployForm({ ...form, lanHost: "bad_host!" }), /内网入口地址/);
  assert.throws(() => validateDeployForm({ ...form, lanHost: "999.999.999.999" }), /内网入口地址/);
  assert.throws(() => validateDeployForm({ ...form, lanHost: "192.168.0" }), /内网入口地址/);
  assert.equal(validateDeployForm({ ...form, lanHost: "192.168.0.8" }).lanHost, "192.168.0.8");
  assert.equal(validateDeployForm({ ...form, lanHost: "fd00::1" }).lanHost, "fd00::1");
  assert.equal(validateDeployForm({ ...form, lanHost: "lan.example" }).lanHost, "lan.example");
  // clonePeer 只对副实例生效，未启用副实例时归一化为 false。
  assert.equal(validateDeployForm({ ...form, clonePeer: true }).clonePeer, false);
  assert.equal(validateDeployForm(withSecondary({ ...form, clonePeer: true })).clonePeer, true);

  assert.throws(() => validateDeployForm({ ...form, archiveRetentionDays: 0 }), /列表保留天数/);
  assert.throws(
    () => validateDeployForm({ ...form, nodeBin: path.join(base, "no-node") }),
    /Node 路径/,
  );
});

test("两个实例不能共用目录或数据目录", () => {
  const base = tmp();
  const form = withSecondary(validForm(base));
  assert.throws(
    () => validateDeployForm({ ...form, secondaryDir: form.primaryDir }),
    /同一个目录/,
  );
  assert.throws(
    () => validateDeployForm({ ...form, dataSecondary: form.dataPrimary }),
    /同一个数据目录/,
  );
});

test("项目校验：id 格式、重复、保留 id、绝对路径和 permission", () => {
  const base = tmp();
  const form = validForm(base);
  const ok = {
    ...form,
    projects: [{ id: "demo-1", name: "示例", path: path.join(base, "demo"), permission: "auto" }],
  };
  assert.equal(validateDeployForm(ok).projects.length, 1);

  const bad = (patch: Record<string, unknown>) =>
    assert.throws(() => validateDeployForm({ ...form, projects: [patch] }) as unknown, DeployValidationError);
  bad({ id: "Demo", name: "x", path: path.join(base, "x"), permission: "auto" });
  bad({ id: "qubius", name: "x", path: path.join(base, "x"), permission: "auto" });
  bad({ id: "co-qubius", name: "x", path: path.join(base, "x"), permission: "auto" });
  bad({ id: "ok", name: "", path: path.join(base, "x"), permission: "auto" });
  bad({ id: "ok", name: "x", path: "relative", permission: "auto" });
  bad({ id: "ok", name: "x", path: path.join(base, "x"), permission: "yolo" });

  assert.throws(
    () => validateDeployForm({
      ...form,
      projects: [
        { id: "dup", name: "a", path: path.join(base, "a"), permission: "auto" },
        { id: "dup", name: "b", path: path.join(base, "b"), permission: "auto" },
      ],
    }),
    /重复/,
  );
});

test("env 合并保留未知变量和注释，只替换受管的 QUBIUS_* 键", () => {
  const base = tmp();
  const form = validForm(base);
  const existing = [
    "# 用户自己的注释",
    "QUBIUS_GITEA_TOKEN=secret-token",
    "QUBIUS_PRIMARY_PORT=1111",
    "QUBIUS_MAX_CONCURRENT=6",
    "OTHER_FLAG=1",
    "",
  ].join("\n");
  const merged = mergeEnvText(existing, deployEnvValues(form, "/tmp/projects.yaml"));
  assert.match(merged, /# 用户自己的注释/);
  assert.match(merged, /QUBIUS_GITEA_TOKEN=secret-token/);
  assert.match(merged, /OTHER_FLAG=1/);
  assert.match(merged, /^QUBIUS_PRIMARY_PORT=8787$/m);
  assert.equal((merged.match(/QUBIUS_PRIMARY_PORT=/g) ?? []).length, 1);
  assert.match(merged, /^QUBIUS_START_PRIMARY=1$/m);
  // 并发上限已移到设置页，部署页不再管理该变量；已有的 env 行保持原样。
  assert.match(merged, /^QUBIUS_MAX_CONCURRENT=6$/m);
});

test("pullLatest 写入 env、从 env 读回；旧表单缺字段按 false 处理", () => {
  const base = tmp();
  const form = validForm(base);
  assert.equal(deployEnvValues(form, "").QUBIUS_PULL_LATEST, "0");
  assert.equal(deployEnvValues({ ...form, pullLatest: true }, "").QUBIUS_PULL_LATEST, "1");

  const configDir = path.join(base, "cfg");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "env"), "QUBIUS_PULL_LATEST=1\n");
  assert.equal(
    deriveDeployForm({ HOME: base, QUBIUS_CONFIG_DIR: configDir }).form.pullLatest,
    true,
  );

  // 旧页面不提交这个字段：按 false 接受，不能因为升级服务端就 400。
  const legacy: Record<string, unknown> = { ...form };
  delete legacy.pullLatest;
  assert.equal(validateDeployForm(legacy).pullLatest, false);
  assert.throws(() => validateDeployForm({ ...form, pullLatest: "1" }), /pullLatest/);
});

test("已配置的 projects 文件损坏时 GET 暴露错误、apply 拒绝覆盖", () => {
  const base = tmp();
  const configDir = path.join(base, "cfg");
  fs.mkdirSync(configDir, { recursive: true });
  const projectsFile = path.join(base, "broken.yaml");
  fs.writeFileSync(projectsFile, "- id: [\n");
  fs.writeFileSync(path.join(configDir, "env"), `QUBIUS_PROJECTS_FILE=${projectsFile}\n`);

  const derived = deriveDeployForm({ HOME: base, QUBIUS_CONFIG_DIR: configDir });
  assert.match(derived.projectsError ?? "", /YAML/);
  assert.deepEqual(derived.form.projects, []);

  const form = validForm(base);
  writeJob(base, "#!/bin/bash\nexit 0\n", "process.exit(0);\n");
  assert.throws(
    () => applyDeploy({
      body: {
        ...form,
        configDir,
        projects: [{
          id: "ok",
          name: "需要保留",
          path: path.join(base, "ok"),
          permission: "auto",
        }],
      },
      repoRoot: base,
      env: { HOME: base, QUBIUS_CONFIG_DIR: configDir },
    }),
    /projects 文件无法读取/,
  );
  // 损坏的文件没有被覆盖。
  assert.equal(fs.readFileSync(projectsFile, "utf8"), "- id: [\n");

  // 清空项目列表是自愈入口：备份后删除损坏文件，不再 400。
  const healed = applyDeploy({
    body: { ...form, configDir, projects: [] },
    repoRoot: base,
    env: { HOME: base, QUBIUS_CONFIG_DIR: configDir },
  });
  assert.ok("jobId" in healed, `期望启动部署任务，实际：${JSON.stringify(healed)}`);
  assert.equal(fs.existsSync(projectsFile), false);
  const backups = fs.readdirSync(base).filter((name) => name.startsWith("broken.yaml.bak."));
  assert.equal(backups.length, 1);
});

test("projects 文件为空、纯空白或纯注释时视为空列表", () => {
  const base = tmp();
  const configDir = path.join(base, "cfg");
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(base, "projects.yaml");
  for (const content of ["", "   \n\n", "# 由 qubius 部署页生成\n# 当前没有额外项目\n"]) {
    fs.writeFileSync(file, content);
    fs.writeFileSync(path.join(configDir, "env"), `QUBIUS_PROJECTS_FILE=${file}\n`);
    const derived = deriveDeployForm({ HOME: base, QUBIUS_CONFIG_DIR: configDir });
    assert.deepEqual(derived.form.projects, [], `内容：${JSON.stringify(content)}`);
    assert.equal(derived.projectsError, undefined);
  }
});

test("未建模字段限制数量和总大小", () => {
  const base = tmp();
  const form = validForm(base);
  const many = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`k${index}`, "v"]),
  );
  assert.throws(
    () => validateDeployForm({
      ...form,
      projects: [{
        id: "p",
        name: "n",
        path: path.join(base, "p"),
        permission: "auto",
        ...many,
      }],
    }),
    /未建模字段/,
  );
  assert.throws(
    () => validateDeployForm({
      ...form,
      projects: [{
        id: "p",
        name: "n",
        path: path.join(base, "p"),
        permission: "auto",
        blob: "x".repeat(9000),
      }],
    }),
    /未建模字段/,
  );
});

test("写 env 会备份旧文件并设置 0600 权限", () => {
  const dir = tmp();
  const envFile = path.join(dir, "env");
  fs.writeFileSync(envFile, "QUBIUS_GITEA_TOKEN=keep-me\nQUBIUS_PRIMARY_PORT=1\n");
  const result = writeDeployEnv(envFile, validForm(tmp()), path.join(dir, "projects.yaml"));
  assert.ok(result.backup);
  assert.ok(fs.existsSync(result.backup!));
  // POSIX 上权限必须是 0600；Windows 不实现 chmod，只能校验内容。
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    // env 可能含 token，备份也必须 0600。
    assert.equal(fs.statSync(result.backup!).mode & 0o777, 0o600);
  }
  const content = fs.readFileSync(envFile, "utf8");
  assert.match(content, /QUBIUS_GITEA_TOKEN=keep-me/);
  assert.match(content, /^QUBIUS_PRIMARY_PORT=8787$/m);
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith("env.bak."));
  assert.equal(backups.length, 1);
});

test("projects YAML 使用两空格缩进并能被 install.sh 的校验规则接受", () => {
  const base = tmp();
  const projects: DeployProject[] = [
    {
      id: "demo",
      name: "示例 项目",
      path: path.join(base, "demo"),
      permission: "acceptEdits",
      isolated: true,
      extras: { owner: "alice", enabled: true },
    },
    { id: "two", name: "第二个", path: path.join(base, "two"), permission: "bypassPermissions", isolated: false },
  ];
  const text = renderProjectsYaml(projects);
  for (const line of text.split("\n")) {
    if (!line) continue;
    assert.ok(!line.includes("\t"), "不允许制表符");
    assert.ok(/^  - /.test(line) || /^    [^ ]/.test(line), `缩进不合法：${line}`);
  }
  // 模拟 install.sh：内容挂在 projects: 下，内置对端条目在前。
  const doc = parseYaml([
    "projects:",
    "  - id: 'peer'",
    "    name: '对端'",
    "    path: '/srv/peer'",
    "    permission: acceptEdits",
    text.trimEnd(),
    "",
  ].join("\n")) as { projects: Array<Record<string, unknown>> };
  assert.deepEqual(doc.projects.map((item) => item.id), ["peer", "demo", "two"]);
  assert.equal(doc.projects[1]?.name, "示例 项目");
  assert.equal(doc.projects[1]?.path, path.join(base, "demo"));
  // isolated 和未建模的标量字段都要完整往返。
  assert.equal(doc.projects[1]?.isolated, true);
  assert.equal(doc.projects[1]?.owner, "alice");
  assert.equal(doc.projects[1]?.enabled, true);
  assert.equal(doc.projects[2]?.isolated, undefined);

  const dir = tmp();
  const file = path.join(dir, "projects.yaml");
  fs.writeFileSync(file, text);
  const round = deriveDeployForm({
    HOME: dir,
    QUBIUS_CONFIG_DIR: path.join(dir, "cfg"),
  });
  assert.deepEqual(round.form.projects, []);
  // 用私有入口验证读取结果：把文件配进 env 后重新推导。
  fs.mkdirSync(path.join(dir, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cfg", "env"), `QUBIUS_PROJECTS_FILE=${file}\n`);
  const read = deriveDeployForm({ HOME: dir, QUBIUS_CONFIG_DIR: path.join(dir, "cfg") }).form.projects;
  assert.equal(read[0]?.isolated, true);
  assert.deepEqual(read[0]?.extras, { owner: "alice", enabled: true });
  assert.equal(read[1]?.isolated, false);
});

test("写 projects 文件会备份旧文件", () => {
  const dir = tmp();
  const file = path.join(dir, "projects.yaml");
  fs.writeFileSync(file, "  - id: old\n");
  const result = writeProjectsFile(file, [{
    id: "new",
    name: "新",
    path: path.join(dir, "new"),
    permission: "auto",
    isolated: false,
  }]);
  assert.ok(result.backup);
  assert.ok(fs.existsSync(result.backup!));
  assert.match(fs.readFileSync(file, "utf8"), /id: 'new'/);
});

test("部署状态读写、忙碌判断和日志尾部", () => {
  const dir = tmp();
  const job = {
    jobId: "job-1",
    state: "running" as const,
    step: "prepare",
    message: "部署任务已启动",
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
  };
  writeDeployJob(dir, job);
  const read = readDeployJob(dir);
  assert.equal(read?.jobId, "job-1");
  assert.equal(read?.state, "running");
  assert.equal(read?.pid, process.pid);
  assert.equal(read?.finishedAt, null);
  assert.equal(deployBusy(dir), true);

  const lines = Array.from({ length: 70 }, (_, index) => `line-${index + 1}`);
  fs.appendFileSync(deployLogFile(dir), `${lines.join("\n")}\n`);
  const withTail = readDeployJob(dir);
  const tail = withTail?.logTail?.split("\n") ?? [];
  assert.equal(tail.length, 60);
  assert.equal(tail[0], "line-11");
  assert.equal(tail[tail.length - 1], "line-70");

  // 日志追加后 (size, mtimeMs) 变化，尾部缓存必须失效并读到新内容。
  fs.appendFileSync(deployLogFile(dir), "line-71\n");
  const afterAppend = readDeployJob(dir);
  const appended = afterAppend?.logTail?.split("\n") ?? [];
  assert.equal(appended[appended.length - 1], "line-71");

  writeDeployJob(dir, { ...job, state: "success", finishedAt: "2026-01-01T00:01:00.000Z", pid: null });
  assert.equal(deployBusy(dir), false);
  assert.equal(readDeployJob(dir)?.state, "success");
});

test("状态解析缓存下 running + pid 已死仍归一化为 failed", () => {
  const dir = tmp();
  writeDeployJob(dir, {
    jobId: "dead-pid",
    state: "running",
    step: "apply",
    message: "部署任务已启动",
    pid: 2_000_000_000,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
  });
  const first = readDeployJob(dir);
  assert.equal(first?.state, "failed");
  assert.equal(first?.message, "部署任务已中断");
  // 第二次命中 deploy.json 解析缓存，仍必须按当前存活状态重新归一化。
  const second = readDeployJob(dir);
  assert.equal(second?.state, "failed");
  assert.equal(second?.pid, 2_000_000_000);
});

test("已有任务在跑时 startDeployJob 返回 busy，不会启动脚本", () => {
  const dir = tmp();
  writeDeployJob(dir, {
    jobId: "running",
    state: "running",
    step: "prepare",
    message: "",
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
  });
  const result = startDeployJob({
    configDir: dir,
    repoRoot: path.join(dir, "missing-repo"),
    values: {},
    token: "tok",
  });
  assert.equal(result, "busy");
});

test("config-dir env 缺失时读取 repo/deploy/env 并标记来源", () => {
  const base = tmp();
  const configDir = path.join(base, "cfg");
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "deploy", "env"), [
    "QUBIUS_PRIMARY_PORT=9444",
    "QUBIUS_PUBLIC_HOST=repo.example.com",
    "",
  ].join("\n"));

  const derived = deriveDeployForm(
    { HOME: base, QUBIUS_CONFIG_DIR: configDir },
    "primary",
    repoRoot,
  );
  assert.equal(derived.envSource, "repo");
  assert.equal(derived.envFile, path.join(repoRoot, "deploy", "env"));
  assert.equal(derived.form.primaryPort, 9444);
  assert.equal(derived.form.publicHost, "repo.example.com");

  // 未传 repoRoot 时保持旧行为：只读 <configDir>/env。
  const legacy = deriveDeployForm({ HOME: base, QUBIUS_CONFIG_DIR: configDir }, "primary");
  assert.equal(legacy.envSource, "default");
  assert.equal(legacy.form.primaryPort, 8787);
});

test("QUBIUS_ENV 优先于 config-dir 与 repo env", () => {
  const base = tmp();
  const configDir = path.join(base, "cfg");
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "env"), "QUBIUS_PRIMARY_PORT=9111\n");
  fs.writeFileSync(path.join(repoRoot, "deploy", "env"), "QUBIUS_PRIMARY_PORT=9222\n");
  const explicit = path.join(base, "explicit.env");
  fs.writeFileSync(explicit, "QUBIUS_PRIMARY_PORT=9333\n");

  const derived = deriveDeployForm(
    { HOME: base, QUBIUS_CONFIG_DIR: configDir, QUBIUS_ENV: explicit },
    "primary",
    repoRoot,
  );
  assert.equal(derived.envSource, "QUBIUS_ENV");
  assert.equal(derived.envFile, explicit);
  assert.equal(derived.form.primaryPort, 9333);
});

test("applyDeploy 写入解析出的 repo/deploy/env，而不是 config-dir/env", async () => {
  const base = tmp();
  const configDir = path.join(base, "config");
  fs.mkdirSync(configDir, { recursive: true });
  makeRepo(base);
  const recorded = path.join(base, "recorded-env.txt");
  writeJob(
    base,
    `#!/bin/bash\nprintf '%s' "$QUBIUS_ENV" > ${JSON.stringify(recorded)}\n`,
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(recorded)}, process.env.QUBIUS_ENV ?? "");\n`,
  );
  fs.writeFileSync(path.join(base, "deploy", "env"), [
    "QUBIUS_GITEA_TOKEN=keep-me",
    "QUBIUS_PRIMARY_PORT=1111",
    "",
  ].join("\n"));

  const result = applyDeploy({
    body: { ...validForm(base), configDir },
    repoRoot: base,
    env: { HOME: base, QUBIUS_CONFIG_DIR: configDir },
  });
  assert.ok("jobId" in result, `期望启动部署任务，实际：${JSON.stringify(result)}`);

  const repoEnv = path.join(base, "deploy", "env");
  const content = fs.readFileSync(repoEnv, "utf8");
  assert.match(content, /^QUBIUS_PRIMARY_PORT=8787$/m);
  assert.match(content, /^QUBIUS_GITEA_TOKEN=keep-me$/m);
  // config-dir 下没有被凭空创建一份 env。
  assert.equal(fs.existsSync(path.join(configDir, "env")), false);
  // 子进程拿到的 QUBIUS_ENV 必须就是实际写入的那份。
  assert.equal(await waitForFile(recorded), repoEnv);
});

test("applyDeploy 在 macOS 上走 Node 任务，不使用 flock ops lock", async () => {
  const base = tmp();
  const configDir = path.join(base, "config");
  fs.mkdirSync(configDir, { recursive: true });
  makeRepo(base);
  const recorded = path.join(base, "recorded-macos.json");
  writeJob(
    base,
    "#!/bin/bash\nexit 1\n",
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(recorded)}, JSON.stringify({\n`
      + "  configDir: process.env.QUBIUS_CONFIG_DIR ?? \"\",\n"
      + "  env: process.env.QUBIUS_ENV ?? \"\",\n"
      + "  opsRoot: process.env.QUBIUS_OPS_ROOT ?? \"\",\n"
      + "}));\n",
  );

  const result = applyDeploy({
    body: { ...validForm(base), configDir },
    repoRoot: base,
    env: { HOME: base, QUBIUS_CONFIG_DIR: configDir },
    platform: "darwin",
  });
  assert.ok("jobId" in result, `期望启动部署任务，实际：${JSON.stringify(result)}`);

  const job = JSON.parse(await waitForFile(recorded)) as {
    configDir: string;
    env: string;
    opsRoot: string;
  };
  assert.equal(job.configDir, configDir);
  assert.equal(job.env, path.join(configDir, "env"));
  // macOS 没有 flock：不应该拿到 shell ops lock 的标记，也不应创建锁文件。
  assert.equal(job.opsRoot, "");
  assert.equal(fs.existsSync(path.join(configDir, "ops.lock")), false);
  assert.equal(fs.existsSync(path.join(configDir, "ops.meta")), false);
});

test("applyDeploy 写入 QUBIUS_ENV 指定的文件", () => {
  const base = tmp();
  const configDir = path.join(base, "config");
  fs.mkdirSync(configDir, { recursive: true });
  makeRepo(base);
  const explicit = path.join(base, "custom.env");
  fs.writeFileSync(explicit, "QUBIUS_GITEA_TOKEN=keep-me\n");

  const result = applyDeploy({
    body: { ...validForm(base), configDir },
    repoRoot: base,
    env: { HOME: base, QUBIUS_CONFIG_DIR: configDir, QUBIUS_ENV: explicit },
  });
  assert.ok("jobId" in result, `期望启动部署任务，实际：${JSON.stringify(result)}`);

  const content = fs.readFileSync(explicit, "utf8");
  assert.match(content, /^QUBIUS_PRIMARY_PORT=8787$/m);
  assert.match(content, /^QUBIUS_GITEA_TOKEN=keep-me$/m);
  assert.equal(fs.existsSync(path.join(configDir, "env")), false);
});

test("detectRepoUrl 只返回 http(s) origin", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "http://git.example.com/me/qubius.git"]);
  assert.equal(detectRepoUrl(dir), "http://git.example.com/me/qubius.git");

  // 地址里带凭据时不能原样回传给浏览器。
  execFileSync("git", ["-C", dir, "remote", "set-url", "origin", "http://user:secret@git.example.com/me/qubius.git"]);
  assert.equal(detectRepoUrl(dir), undefined);

  // SSH 形式的地址不能直接当部署表单的仓库 URL。
  execFileSync("git", ["-C", dir, "remote", "set-url", "origin", "git@git.example.com:me/qubius.git"]);
  assert.equal(detectRepoUrl(dir), undefined);
  assert.equal(detectRepoUrl(path.join(dir, "missing")), undefined);
});

test("readDeployState 只在首次部署时附带 detectedRepoUrl", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "http://git.example.com/me/qubius.git"]);
  const env = { HOME: dir, QUBIUS_CONFIG_DIR: path.join(dir, "config") };

  const first = await readDeployState({
    role: "primary",
    repoRoot: dir,
    port: 8787,
    setupRequired: true,
    env,
  });
  assert.equal(first.detectedRepoUrl, "http://git.example.com/me/qubius.git");

  const normal = await readDeployState({
    role: "primary",
    repoRoot: dir,
    port: 8787,
    setupRequired: false,
    env,
  });
  assert.equal(normal.detectedRepoUrl, undefined);
});

test("applyDeploy 在 QUBIUS_ENV 缺失时抛 DeployValidationError", () => {
  const base = tmp();
  const configDir = path.join(base, "config");
  fs.mkdirSync(configDir, { recursive: true });
  makeRepo(base);
  const missing = path.join(base, "missing.env");

  assert.throws(
    () => applyDeploy({
      body: { ...validForm(base), configDir },
      repoRoot: base,
      env: { HOME: base, QUBIUS_CONFIG_DIR: configDir, QUBIUS_ENV: missing },
    }),
    (error: unknown) =>
      error instanceof DeployValidationError &&
      /QUBIUS_ENV/.test(error.message) &&
      /不存在/.test(error.message),
  );

  // 报错发生在取锁/写文件之前：不留下任何副作用。
  assert.deepEqual(fs.readdirSync(configDir), []);
  assert.equal(fs.existsSync(path.join(configDir, "env")), false);
  assert.equal(fs.existsSync(path.join(configDir, "deploy.json")), false);
  assert.equal(fs.existsSync(path.join(configDir, "deploy.job.lock")), false);
  assert.equal(fs.existsSync(path.join(base, "projects.yaml")), false);
  assert.equal(
    fs.readdirSync(path.join(base, "deploy")).some((name) => name.startsWith("env.bak.")),
    false,
  );
});
