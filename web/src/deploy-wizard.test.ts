import assert from "node:assert/strict";
import test from "node:test";
import type { DeployForm } from "./api-deploy";
import {
  browserHostSuggestion,
  initialScenario,
  prepareWizardForm,
  roleKeys,
  scenarioOptions,
  scenarioPatch,
  validateWizardStep,
  wizardCopy,
  wizardPlaceholders,
  wizardSteps,
  wizardSummaryGroups,
} from "./deploy-wizard";

function form(overrides: Partial<DeployForm> = {}): DeployForm {
  return {
    startPrimary: true,
    startSecondary: false,
    clonePeer: false,
    pullLatest: false,
    primaryPort: 8787,
    secondaryPort: 8788,
    publicHost: "",
    publicHostSecondary: "",
    allowedHostsExtra: "",
    lanHost: "",
    configDir: "/home/me/qubius/.qubius",
    primaryDir: "/home/me/qubius",
    secondaryDir: "/home/me/co-qubius",
    dataPrimary: "/home/me/qubius/.qubius/data",
    dataSecondary: "/home/me/co-qubius/.qubius/data",
    primaryRepoUrl: "http://gitea.example.com/example/qubius.git",
    secondaryRepoUrl: "http://gitea.example.com/example/qubius.git",
    primaryRef: "main",
    authMode: "off",
    authToken: "",
    authTokenSet: false,
    terminal: true,
    maxConcurrent: 4,
    approvalTimeoutMinutes: 10,
    limits: {
      transcriptBytes: 8 * 1024 * 1024,
      transcriptMessages: 5000,
      messageText: 200000,
      requestBodyBytes: 28000000,
      historyPage: 200,
    },
    lanEnabled: false,
    lanAuthUser: "qubius",
    lanAuthPassword: "",
    lanAuthPasswordSet: false,
    archiveDir: "",
    archiveRetentionDays: 30,
    nodeBin: "",
    projects: [],
    ...overrides,
  };
}

test("prepareWizardForm 用当前 checkout 和检测到的 origin 预填", () => {
  const prepared = prepareWizardForm(
    { repoDir: "/srv/qubius", role: "primary", detectedRepoUrl: "http://git.local/qubius.git" },
    form(),
  );
  assert.equal(prepared.primaryDir, "/srv/qubius");
  assert.equal(prepared.publicHost, "localhost");
  assert.equal(prepared.primaryRepoUrl, "http://git.local/qubius.git");
  // 副实例目录保持默认值。
  assert.equal(prepared.secondaryDir, "/home/me/co-qubius");
});

test("重新部署向导的文案不再说「第一次运行」", () => {
  const setup = wizardCopy("setup");
  assert.equal(setup.title, "部署向导");
  assert.match(setup.intro, /第一次运行/);
  assert.match(setup.successLead, /首次部署/);
  assert.equal(setup.switchLabel, "使用完整部署表单");

  const redeploy = wizardCopy("redeploy");
  assert.equal(redeploy.title, "重新部署");
  assert.doesNotMatch(redeploy.intro, /第一次运行/);
  assert.match(redeploy.intro, /当前配置已经预填/);
  assert.match(redeploy.successLead, /重新部署/);
  assert.doesNotMatch(redeploy.successLead, /首次/);
  assert.equal(redeploy.switchLabel, "返回完整部署表单");
});

test("通过域名打开时自动预填访问域名，局域网 IP 不预填", () => {
  assert.equal(browserHostSuggestion("code.example.com"), "code.example.com");
  assert.equal(browserHostSuggestion("192.168.0.41"), undefined);
  assert.equal(browserHostSuggestion("[::1]"), undefined);
  assert.equal(browserHostSuggestion("127.0.0.1"), undefined);
  assert.equal(browserHostSuggestion("localhost"), undefined);
  assert.equal(browserHostSuggestion("bad host"), undefined);

  const domain = prepareWizardForm(
    { repoDir: "/srv/qubius", role: "primary", browserHost: "code.example.com" },
    form(),
  );
  assert.equal(domain.publicHost, "code.example.com");
  assert.equal(initialScenario(domain, "primary"), "remote");

  // 通过局域网 IP 打开部署页时不把网卡地址写进访问域名。
  const lan = prepareWizardForm(
    { repoDir: "/srv/qubius", role: "primary", browserHost: "192.168.0.41" },
    form(),
  );
  assert.equal(lan.publicHost, "localhost");

  const loopback = prepareWizardForm(
    { repoDir: "/srv/qubius", role: "primary", browserHost: "127.0.0.1" },
    form(),
  );
  assert.equal(loopback.publicHost, "localhost");
  assert.equal(initialScenario(loopback, "primary"), "local");

  // Windows 的派生根表单默认就是 localhost；通过域名访问时也应换成当前地址。
  const windowsDefault = prepareWizardForm(
    { repoDir: String.raw`C:\qubius`, role: "primary", browserHost: "code.example.com" },
    form({ publicHost: "localhost" }),
  );
  assert.equal(windowsDefault.publicHost, "code.example.com");
  assert.equal(initialScenario(windowsDefault, "primary"), "remote");
});

test("prepareWizardForm 尊重已显式配置的仓库地址和域名", () => {
  const prepared = prepareWizardForm(
    { repoDir: "/srv/co-qubius", role: "secondary", detectedRepoUrl: "http://git.local/qubius.git" },
    form({ primaryRepoUrl: "https://example.com/mine/qubius.git", publicHostSecondary: "code.example.com" }),
  );
  assert.equal(prepared.secondaryDir, "/srv/co-qubius");
  assert.equal(prepared.primaryRepoUrl, "https://example.com/mine/qubius.git");
  assert.equal(prepared.publicHostSecondary, "code.example.com");
});

test("initialScenario 按现有表单推断", () => {
  assert.equal(initialScenario(form(), "primary"), "local");
  assert.equal(initialScenario(form({ publicHost: "localhost" }), "primary"), "local");
  // 局域网模式的默认访问域名是 127.0.0.1：重新打开向导时仍算局域网模式。
  assert.equal(initialScenario(form({ publicHost: "127.0.0.1" }), "primary"), "remote");
  assert.equal(initialScenario(form({ publicHost: "code.example.com" }), "primary"), "remote");
  assert.equal(initialScenario(form({ startSecondary: true }), "primary"), "dual");
});

test("scenarioPatch 只启用当前角色，本机模式使用 localhost", () => {
  const patch = scenarioPatch(form({ startSecondary: true }), "primary", "local");
  assert.equal(patch.startPrimary, true);
  assert.equal(patch.startSecondary, false);
  assert.equal(patch.clonePeer, false);
  assert.equal(patch.publicHost, "localhost");

  const secondaryOnly = scenarioPatch(form(), "secondary", "local");
  assert.equal(secondaryOnly.startPrimary, false);
  assert.equal(secondaryOnly.startSecondary, true);
  assert.equal(secondaryOnly.publicHostSecondary, "localhost");
});

test("scenarioPatch 远程模式没有可用建议时默认 127.0.0.1", () => {
  // 通过回环地址或局域网 IP 打开页面时拿不到建议域名：默认填 127.0.0.1，
  // 局域网入口经 lan-proxy 转发后的 Host 就是这个地址。
  const patch = scenarioPatch(form({ publicHost: "localhost" }), "primary", "remote");
  assert.equal(patch.publicHost, "127.0.0.1");
  assert.equal(patch.startSecondary, false);

  // 空表单（例如重新部署时旧配置没有域名）同样补 127.0.0.1。
  const empty = scenarioPatch(form(), "primary", "remote");
  assert.equal(empty.publicHost, "127.0.0.1");

  // 通过局域网 IP 打开页面：浏览器建议值已经被忽略，同样落到 127.0.0.1。
  const lan = scenarioPatch(form({ publicHost: "localhost" }), "primary", "remote", undefined);
  assert.equal(lan.publicHost, "127.0.0.1");

  // 旧版本预填进表单的网卡 IP 也换成 127.0.0.1。
  const prefilledIp = scenarioPatch(form({ publicHost: "192.168.0.41" }), "primary", "remote");
  assert.equal(prefilledIp.publicHost, "127.0.0.1");

  // 当前页面就是通过域名打开的：直接补上，不用手写。
  const suggested = scenarioPatch(
    form({ publicHost: "localhost" }),
    "primary",
    "remote",
    "code.example.com",
  );
  assert.equal(suggested.publicHost, "code.example.com");

  // 已经填了真实域名的表单保持原样。
  const custom = scenarioPatch(form({ publicHost: "code.example.com" }), "primary", "remote");
  assert.equal(custom.publicHost, undefined);
});

test("scenarioPatch 双实例会给出可区分的默认域名", () => {
  const patch = scenarioPatch(form(), "primary", "dual");
  assert.equal(patch.startPrimary, true);
  assert.equal(patch.startSecondary, true);
  assert.equal(patch.publicHost, "localhost");
  assert.equal(patch.publicHostSecondary, "127.0.0.1");

  const custom = scenarioPatch(
    form({ publicHost: "code.example.com", publicHostSecondary: "code-bak.example.com" }),
    "primary",
    "dual",
  );
  assert.equal(custom.publicHost, "code.example.com");
  assert.equal(custom.publicHostSecondary, "code-bak.example.com");
});

test("实例步骤校验目录、端口和远程域名", () => {
  assert.equal(validateWizardStep("instance", form(), "primary", "local"), null);
  assert.match(
    validateWizardStep("instance", form({ primaryDir: "relative/qubius" }), "primary", "local") ?? "",
    /绝对路径/,
  );
  assert.match(
    validateWizardStep("instance", form({ primaryPort: 0 }), "primary", "local") ?? "",
    /端口/,
  );
  assert.match(
    validateWizardStep("instance", form(), "primary", "remote") ?? "",
    /访问域名不能为空/,
  );
  assert.equal(
    validateWizardStep("instance", form({ publicHost: "code.example.com" }), "primary", "remote"),
    null,
  );
});

test("实例步骤同时校验归档参数和仓库地址", () => {
  assert.match(
    validateWizardStep("instance", form({ archiveDir: "relative/archive" }), "primary", "local") ?? "",
    /归档目录/,
  );
  assert.match(
    validateWizardStep("instance", form({ archiveRetentionDays: 0 }), "primary", "local") ?? "",
    /保留天数/,
  );
  assert.match(
    validateWizardStep(
      "instance",
      form({ startPrimary: true, primaryRepoUrl: "git@example.com:me/qubius.git" }),
      "primary",
      "local",
    ) ?? "",
    /http\(s\)/,
  );
  assert.equal(
    validateWizardStep(
      "instance",
      form({ archiveDir: "/archive/qubius", archiveRetentionDays: 7 }),
      "primary",
      "local",
    ),
    null,
  );
  // 只跑副实例时不要求主实例仓库地址。
  assert.equal(
    validateWizardStep(
      "instance",
      form({ startPrimary: false, startSecondary: true, primaryRepoUrl: "" }),
      "secondary",
      "local",
    ),
    null,
  );
});

test("副实例步骤校验端口、域名冲突和克隆仓库地址", () => {
  const dual = form({
    startSecondary: true,
    publicHost: "localhost",
    publicHostSecondary: "127.0.0.1",
  });
  assert.equal(validateWizardStep("peer", dual, "primary", "dual"), null);

  assert.match(
    validateWizardStep("peer", { ...dual, secondaryPort: 8787 }, "primary", "dual") ?? "",
    /端口不能相同/,
  );
  assert.match(
    validateWizardStep("peer", { ...dual, publicHostSecondary: "localhost" }, "primary", "dual") ?? "",
    /同一个访问域名/,
  );
  assert.match(
    validateWizardStep(
      "peer",
      { ...dual, clonePeer: true, primaryRepoUrl: "git@example.com:me/qubius.git" },
      "primary",
      "dual",
    ) ?? "",
    /http\(s\)/,
  );
});

test("步骤顺序和摘要随场景变化", () => {
  assert.deepEqual(wizardSteps("local"), ["scenario", "instance", "review"]);
  assert.deepEqual(wizardSteps("dual"), ["scenario", "instance", "peer", "review"]);

  const local = wizardSummaryGroups(form({ publicHost: "localhost" }), "primary", "local");
  assert.equal(local.length, 2);
  assert.equal(local[0]?.title, "主实例（当前）");
  assert.equal(local[1]?.rows.find((row) => row.label === "使用方式")?.value, "仅本机使用");

  const dual = wizardSummaryGroups(form({ startSecondary: true }), "primary", "dual");
  assert.deepEqual(dual.map((group) => group.title), ["主实例（当前）", "副实例", "部署"]);
});

test("Windows 使用盘符路径占位符和明确的双实例限制", () => {
  const primary = wizardPlaceholders("win32", "primary");
  assert.match(primary.checkout, /^[A-Za-z]:\\/);
  assert.match(primary.data, /\.qubius\\data$/);
  const secondary = wizardPlaceholders("win32", "secondary");
  assert.match(secondary.checkout, /co-qubius$/);

  const windowsDual = scenarioOptions("win32").find((option) => option.id === "dual");
  assert.match(windowsDual?.title ?? "", /Windows/);
  assert.match(windowsDual?.description ?? "", /同步\/回滚/);
  const linuxDual = scenarioOptions("linux").find((option) => option.id === "dual");
  assert.doesNotMatch(linuxDual?.description ?? "", /Windows/);
});

test("Windows 绝对路径通过实例步骤校验", () => {
  const windowsForm = form({
    primaryDir: String.raw`C:\Users\me\qubius`,
    dataPrimary: String.raw`D:\qubius-data`,
    publicHost: "localhost",
  });
  assert.equal(validateWizardStep("instance", windowsForm, "primary", "local"), null);

  const unc = form({ primaryDir: String.raw`\\server\share\qubius`, dataPrimary: String.raw`D:\data` });
  assert.equal(validateWizardStep("instance", unc, "primary", "local"), null);
});

test("roleKeys 两侧字段一一对应", () => {
  assert.deepEqual(roleKeys("primary"), {
    start: "startPrimary",
    dir: "primaryDir",
    data: "dataPrimary",
    port: "primaryPort",
    host: "publicHost",
  });
  assert.equal(roleKeys("secondary").dir, "secondaryDir");
});
