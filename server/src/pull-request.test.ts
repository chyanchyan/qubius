import assert from "node:assert/strict";
import test from "node:test";
import type { FeatureContext, FeatureResult } from "./feature-routes.js";
import { withGitAction } from "./git-lock.js";
import {
  createCommandArgs,
  createPullRequestHandler,
  detectProvider,
  normalizeGithubChecks,
  normalizeGitlabPipeline,
  parseRemoteHost,
  type CommandOutput,
  type CommandRunner,
  type PullRequestStatus,
} from "./pull-request.js";
import { tryLockSession, unlockSession } from "./session-lock.js";
import type { SessionCore } from "./types.js";

interface Call {
  command: string;
  args: string[];
  cwd: string;
}

function makeSession(overrides: Partial<SessionCore> = {}): SessionCore {
  return {
    id: "s1",
    projectId: "p1",
    projectPath: "/tmp/project",
    title: "测试会话",
    providerId: "prov",
    providerName: "Provider",
    model: "model-x",
    effort: "high",
    cwd: "/tmp/project",
    git: true,
    summary: "",
    phase: "completed",
    turnActive: false,
    queued: false,
    subagents: [],
    messages: [],
    pending: null,
    seen: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeContext(options: {
  method: string;
  pathname?: string;
  session?: SessionCore | null;
  body?: unknown;
  readJsonError?: Error;
}): FeatureContext {
  const session = options.session === undefined ? makeSession() : options.session;
  const context = {
    req: {} as FeatureContext["req"],
    res: {} as FeatureContext["res"],
    url: new URL(options.pathname ?? "/api/sessions/s1/pull-request", "http://127.0.0.1"),
    method: options.method,
    config: {} as FeatureContext["config"],
    store: {
      get: (id: string) => (session && id === session.id ? session : undefined),
    },
    runtime: {} as FeatureContext["runtime"],
    settings: { current: {} } as FeatureContext["settings"],
    readJson: async () => {
      if (options.readJsonError) throw options.readJsonError;
      return options.body;
    },
    sendJson: () => {},
  };
  return context as unknown as FeatureContext;
}

function fakeRunner(
  handler: (command: string, args: string[]) => CommandOutput | Promise<CommandOutput>,
): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: CommandRunner = {
    async run(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return handler(command, args);
    },
  };
  return { runner, calls };
}

function failure(stderr: string, code = "1"): Error {
  const error = new Error(stderr) as Error & { code?: string; stderr?: string; stdout?: string };
  error.code = code;
  error.stderr = stderr;
  error.stdout = "";
  return error;
}

async function invoke(runner: CommandRunner, ctx: FeatureContext): Promise<FeatureResult> {
  const result = await createPullRequestHandler({ run: runner })(ctx);
  assert.ok(result, "应该匹配 PR 路由");
  return result;
}

function called(calls: Call[]): string[][] {
  return calls.map((call) => [call.command, ...call.args]);
}

function githubRemote(): CommandOutput {
  return { stdout: "git@github.com:owner/repo.git\n", stderr: "" };
}

function branchOutput(branch = "qubius/s1"): CommandOutput {
  return { stdout: `${branch}\n`, stderr: "" };
}

test("解析 ssh/https/scp 远端地址并识别托管平台", () => {
  assert.equal(parseRemoteHost("git@github.com:owner/repo.git"), "github.com");
  assert.equal(parseRemoteHost("https://github.com/owner/repo.git"), "github.com");
  assert.equal(parseRemoteHost("https://user:pass@github.com/owner/repo.git"), "github.com");
  assert.equal(parseRemoteHost("ssh://git@gitlab.example.com:2222/group/repo.git"), "gitlab.example.com");
  assert.equal(parseRemoteHost("http://github.enterprise.local/owner/repo"), "github.enterprise.local");
  assert.equal(parseRemoteHost(" /srv/git/repo.git "), null);
  assert.equal(parseRemoteHost(""), null);

  assert.equal(detectProvider(parseRemoteHost("git@github.com:o/r.git")), "github");
  assert.equal(detectProvider(parseRemoteHost("git@github.example.com:o/r.git")), "github");
  assert.equal(detectProvider(parseRemoteHost("https://gitlab.com/o/r.git")), "gitlab");
  assert.equal(detectProvider(parseRemoteHost("https://gitlab.example.com/o/r.git")), "gitlab");
  assert.equal(detectProvider("bitbucket.org"), null);
  assert.equal(detectProvider(null), null);
});

test("创建命令用 --flag=value，值以 - 开头也不会被当成选项", () => {
  assert.deepEqual(createCommandArgs("github", { title: "-标题", body: "--说明" }), [
    "pr",
    "create",
    "--title=-标题",
    "--body=--说明",
  ]);
  assert.deepEqual(createCommandArgs("gitlab", { title: "-T", body: "--D", base: "-main" }), [
    "mr",
    "create",
    "--title=-T",
    "--description=--D",
    "--yes",
    "--target-branch=-main",
  ]);
});

test("归一化 GitHub statusCheckRollup 的 CheckRun 和 StatusContext", () => {
  const checks = normalizeGithubChecks([
    { name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/1" },
    { name: "test", status: "IN_PROGRESS", conclusion: null },
    { context: "legacy", state: "FAILURE", targetUrl: "https://ci/2" },
    { context: "waiting", state: "PENDING" },
    null,
    { name: "" },
  ]);
  assert.deepEqual(checks, [
    { name: "build", status: "completed", conclusion: "success", url: "https://ci/1" },
    { name: "test", status: "in_progress", conclusion: null },
    { name: "legacy", status: "completed", conclusion: "failure", url: "https://ci/2" },
    { name: "waiting", status: "in_progress", conclusion: null },
  ]);
  assert.deepEqual(normalizeGithubChecks(undefined), []);
});

test("GitHub 检查链接里的远端凭证会被脱敏", () => {
  const checks = normalizeGithubChecks([
    {
      name: "build",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://user:secret@ci.example.com/build/1",
    },
    {
      context: "legacy",
      state: "FAILURE",
      targetUrl: "https://user:secret@ci.example.com/build/2",
    },
  ]);
  assert.equal(checks[0]?.url, "https://***@ci.example.com/build/1");
  assert.equal(checks[1]?.url, "https://***@ci.example.com/build/2");
  for (const check of checks) assert.ok(!(check.url ?? "").includes("secret"));
});

test("GET 返回 GitHub PR、状态和检查", async () => {
  const { runner, calls } = fakeRunner((command, args) => {
    if (command === "git") return githubRemote();
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          state: "OPEN",
          title: "Fix login",
          mergeable: "MERGEABLE",
          statusCheckRollup: [
            { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/42" },
            { context: "legacy", state: "FAILURE" },
          ],
          headRefName: "qubius/s1",
          baseRefName: "main",
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  });

  const result = await invoke(runner, makeContext({ method: "GET" }));
  assert.equal(result.status, 200);
  const body = result.body as PullRequestStatus;
  assert.equal(body.supported, true);
  assert.equal(body.host, "github");
  assert.equal(body.exists, true);
  assert.equal(body.number, 42);
  assert.equal(body.state, "open");
  assert.equal(body.title, "Fix login");
  assert.equal(body.mergeable, "mergeable");
  assert.deepEqual(body.checks, [
    { name: "ci", status: "completed", conclusion: "success", url: "https://ci/42" },
    { name: "legacy", status: "completed", conclusion: "failure" },
  ]);
  assert.deepEqual(called(calls), [
    ["git", "remote", "get-url", "origin"],
    ["gh", "pr", "view", "--json", "number,url,state,title,mergeable,statusCheckRollup,headRefName,baseRefName"],
  ]);
});

test("GET 支持 GitLab MR，字段缺失时容错", async () => {
  const { runner } = fakeRunner((command) => {
    if (command === "git") return { stdout: "https://gitlab.com/group/repo.git\n", stderr: "" };
    if (command === "glab") {
      return {
        stdout: JSON.stringify({ iid: 7, web_url: "https://gitlab.com/group/repo/-/merge_requests/7" }),
        stderr: "",
      };
    }
    throw new Error(`unexpected ${command}`);
  });

  const result = await invoke(runner, makeContext({ method: "GET" }));
  assert.equal(result.status, 200);
  const body = result.body as PullRequestStatus;
  assert.equal(body.supported, true);
  assert.equal(body.host, "gitlab");
  assert.equal(body.exists, true);
  assert.equal(body.number, 7);
  assert.equal(body.url, "https://gitlab.com/group/repo/-/merge_requests/7");
  assert.equal(body.title, undefined);
  assert.equal(body.mergeable, undefined);
  assert.deepEqual(body.checks, []);
});

test("GitLab 从 head_pipeline 归一化 pipeline 检查", async () => {
  const cases: Array<[string, string, string | null]> = [
    ["success", "completed", "success"],
    ["running", "in_progress", null],
    ["failed", "completed", "failure"],
  ];
  for (const [pipelineStatus, status, conclusion] of cases) {
    const { runner } = fakeRunner((command) => {
      if (command === "git") return { stdout: "git@gitlab.com:g/r.git", stderr: "" };
      return {
        stdout: JSON.stringify({
          iid: 7,
          web_url: "https://gitlab.com/g/r/-/merge_requests/7",
          head_pipeline: {
            status: pipelineStatus,
            web_url: "https://gitlab.com/g/r/-/pipelines/9",
          },
        }),
        stderr: "",
      };
    });
    const result = await invoke(runner, makeContext({ method: "GET" }));
    assert.deepEqual(
      (result.body as PullRequestStatus).checks,
      [{ name: "pipeline", status, conclusion, url: "https://gitlab.com/g/r/-/pipelines/9" }],
      pipelineStatus,
    );
  }
});

test("GitLab 兼容 pipeline 键（数组取第一个）", async () => {
  const { runner } = fakeRunner((command) => {
    if (command === "git") return { stdout: "git@gitlab.com:g/r.git", stderr: "" };
    return {
      stdout: JSON.stringify({
        iid: 7,
        pipeline: [{ status: "running" }, { status: "success" }],
      }),
      stderr: "",
    };
  });
  const result = await invoke(runner, makeContext({ method: "GET" }));
  assert.deepEqual((result.body as PullRequestStatus).checks, [
    { name: "pipeline", status: "in_progress", conclusion: null },
  ]);
});

test("GitLab pipeline 归一化兼容数组、终态映射和链接脱敏", () => {
  assert.deepEqual(
    normalizeGitlabPipeline([
      { status: "canceled", web_url: "https://user:secret@gitlab.com/g/r/-/pipelines/1" },
    ]),
    [
      {
        name: "pipeline",
        status: "completed",
        conclusion: "cancelled",
        url: "https://***@gitlab.com/g/r/-/pipelines/1",
      },
    ],
  );
  assert.deepEqual(normalizeGitlabPipeline({ status: "skipped" }), [
    { name: "pipeline", status: "completed", conclusion: "skipped" },
  ]);
  assert.deepEqual(normalizeGitlabPipeline({ status: "manual" }), [
    { name: "pipeline", status: "completed", conclusion: "manual" },
  ]);
  assert.deepEqual(normalizeGitlabPipeline({ status: "waiting_for_resource" }), [
    { name: "pipeline", status: "in_progress", conclusion: null },
  ]);
  assert.deepEqual(normalizeGitlabPipeline({ status: "weird" }), [
    { name: "pipeline", status: "weird", conclusion: null },
  ]);
  assert.deepEqual(normalizeGitlabPipeline(null), []);
  assert.deepEqual(normalizeGitlabPipeline({}), []);
});

test("GitLab 冲突状态映射为 conflicting", async () => {
  const { runner } = fakeRunner((command) => {
    if (command === "git") return { stdout: "git@gitlab.com:g/r.git", stderr: "" };
    return {
      stdout: JSON.stringify({
        iid: 8,
        web_url: "https://gitlab.com/g/r/-/merge_requests/8",
        state: "opened",
        title: "MR",
        merge_status: "cannot_be_merged",
      }),
      stderr: "",
    };
  });
  const result = await invoke(runner, makeContext({ method: "GET" }));
  const body = result.body as PullRequestStatus;
  assert.equal(body.mergeable, "conflicting");
});

test("无 PR 时 exists=false 且不当作错误", async () => {
  const { runner } = fakeRunner((command) => {
    if (command === "git") return githubRemote();
    throw failure('no pull requests found for branch "qubius/s1"');
  });

  const result = await invoke(runner, makeContext({ method: "GET" }));
  assert.equal(result.status, 200);
  const body = result.body as PullRequestStatus;
  assert.equal(body.supported, true);
  assert.equal(body.exists, false);
  assert.equal(body.error, undefined);
  assert.deepEqual(body.checks, []);
});

test("CLI 缺失时 supported=true 并返回说明，不抛 500", async () => {
  const { runner } = fakeRunner((command) => {
    if (command === "git") return githubRemote();
    throw failure("spawn gh ENOENT", "ENOENT");
  });

  const result = await invoke(runner, makeContext({ method: "GET" }));
  assert.equal(result.status, 200);
  const body = result.body as PullRequestStatus;
  assert.equal(body.supported, true);
  assert.equal(body.exists, false);
  assert.match(body.error ?? "", /gh CLI/);
});

test("认证失败映射为登录提示（GitHub 和 GitLab）", async () => {
  const github = fakeRunner((command) => {
    if (command === "git") return githubRemote();
    throw failure("To get started with GitHub CLI, please run: gh auth login");
  });
  const githubBody = (await invoke(github.runner, makeContext({ method: "GET" }))).body as PullRequestStatus;
  assert.match(githubBody.error ?? "", /gh 未登录/);

  const gitlab = fakeRunner((command) => {
    if (command === "git") return { stdout: "git@gitlab.com:g/r.git", stderr: "" };
    throw failure("You are not logged into any GitLab hosts.");
  });
  const gitlabBody = (await invoke(gitlab.runner, makeContext({ method: "GET" }))).body as PullRequestStatus;
  assert.match(gitlabBody.error ?? "", /glab 未登录/);
});

test("不支持的托管平台返回 supported=false，且不调用 gh/glab", async () => {
  const { runner, calls } = fakeRunner((command) => {
    if (command === "git") return { stdout: "https://bitbucket.org/owner/repo.git", stderr: "" };
    throw new Error(`unexpected ${command}`);
  });

  const result = await invoke(runner, makeContext({ method: "GET" }));
  assert.equal(result.status, 200);
  const body = result.body as PullRequestStatus;
  assert.equal(body.supported, false);
  assert.equal(body.host, "bitbucket.org");
  assert.equal(body.exists, false);
  assert.match(body.error ?? "", /不支持/);
  assert.deepEqual(called(calls), [["git", "remote", "get-url", "origin"]]);
});

test("非 git 会话和缺失会话分别返回 supported=false / 404", async () => {
  const { runner, calls } = fakeRunner(() => {
    throw new Error("不该执行命令");
  });
  const plain = await invoke(
    runner,
    makeContext({ method: "GET", session: makeSession({ git: false }) }),
  );
  assert.equal(plain.status, 200);
  assert.match((plain.body as PullRequestStatus).error ?? "", /不是 git 仓库/);
  assert.deepEqual(calls, []);

  const missing = await invoke(runner, makeContext({ method: "GET", session: null }));
  assert.equal(missing.status, 404);
});

test("POST 先 push 再 gh pr create，并返回最新状态和 created=true", async () => {
  const { runner, calls } = fakeRunner((command, args) => {
    if (command === "git" && args[0] === "remote") return githubRemote();
    if (command === "git" && args[0] === "rev-parse") return branchOutput();
    if (command === "git" && args[0] === "push") return { stdout: "", stderr: "" };
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      return { stdout: "https://github.com/owner/repo/pull/9\n", stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          number: 9,
          url: "https://github.com/owner/repo/pull/9",
          state: "OPEN",
          title: "提交标题",
          mergeable: "UNKNOWN",
          statusCheckRollup: [],
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  });

  const result = await invoke(
    runner,
    makeContext({
      method: "POST",
      body: { title: "  提交标题  ", body: "说明正文", base: " main " },
    }),
  );
  assert.equal(result.status, 200);
  const body = result.body as PullRequestStatus;
  assert.equal(body.created, true);
  assert.equal(body.exists, true);
  assert.equal(body.number, 9);
  assert.equal(body.mergeable, "unknown");
  assert.deepEqual(called(calls), [
    ["git", "remote", "get-url", "origin"],
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    ["git", "push", "-u", "origin", "HEAD"],
    ["gh", "pr", "create", "--title=提交标题", "--body=说明正文", "--base=main"],
    ["gh", "pr", "view", "--json", "number,url,state,title,mergeable,statusCheckRollup,headRefName,baseRefName"],
  ]);
});

test("POST 对 GitLab 使用 glab mr create 参数", async () => {
  const { runner, calls } = fakeRunner((command, args) => {
    if (command === "git" && args[0] === "remote") {
      return { stdout: "https://gitlab.com/group/repo.git", stderr: "" };
    }
    if (command === "git" && args[0] === "rev-parse") return branchOutput();
    if (command === "git" && args[0] === "push") return { stdout: "", stderr: "" };
    if (command === "glab" && args[0] === "mr" && args[1] === "create") {
      return { stdout: "https://gitlab.com/group/repo/-/merge_requests/3\n", stderr: "" };
    }
    if (command === "glab" && args[0] === "mr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          iid: 3,
          web_url: "https://gitlab.com/group/repo/-/merge_requests/3",
          state: "opened",
          title: "T",
          merge_status: "can_be_merged",
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  });

  const result = await invoke(
    runner,
    makeContext({ method: "POST", body: { title: "T", body: "D", base: "develop" } }),
  );
  const body = result.body as PullRequestStatus;
  assert.equal(body.created, true);
  assert.equal(body.host, "gitlab");
  assert.equal(body.mergeable, "mergeable");
  assert.deepEqual(called(calls)[3], [
    "glab",
    "mr",
    "create",
    "--title=T",
    "--description=D",
    "--yes",
    "--target-branch=develop",
  ]);
});

test("POST 校验标题和正文，非法输入不执行命令", async () => {
  const { runner, calls } = fakeRunner(() => {
    throw new Error("不该执行命令");
  });
  const cases: Array<{ body: unknown; status: number }> = [
    { body: null, status: 400 },
    { body: {}, status: 400 },
    { body: { title: "   ", body: "" }, status: 400 },
    { body: { title: "x".repeat(201), body: "" }, status: 400 },
    { body: { title: "ok", body: "x".repeat(20_001) }, status: 400 },
    { body: { title: "ok", body: 123 }, status: 400 },
    { body: { title: "ok", body: "", base: 123 }, status: 400 },
  ];
  for (const item of cases) {
    const result = await invoke(runner, makeContext({ method: "POST", body: item.body }));
    assert.equal(result.status, item.status, JSON.stringify(item.body));
  }
  assert.deepEqual(calls, []);
});

test("POST 在会话运行/排队/等确认时返回 409，不执行命令", async () => {
  const { runner, calls } = fakeRunner(() => {
    throw new Error("不该执行命令");
  });
  const cases: Array<Partial<SessionCore>> = [
    { turnActive: true },
    { phase: "running", turnActive: false },
    { phase: "queued", turnActive: false },
    { phase: "needs_input", turnActive: false },
  ];
  for (const overrides of cases) {
    const result = await invoke(
      runner,
      makeContext({ method: "POST", session: makeSession(overrides), body: { title: "T", body: "" } }),
    );
    assert.equal(result.status, 409, JSON.stringify(overrides));
    assert.match((result.body as { error?: string }).error ?? "", /进行中/);
  }
  assert.deepEqual(calls, []);
});

test("POST 在会话归档/清理中返回 409", async () => {
  const { runner, calls } = fakeRunner(() => {
    throw new Error("不该执行命令");
  });
  assert.equal(tryLockSession("s1"), true);
  try {
    const result = await invoke(runner, makeContext({ method: "POST", body: { title: "T", body: "" } }));
    assert.equal(result.status, 409);
    assert.match((result.body as { error?: string }).error ?? "", /归档或清理/);
    assert.deepEqual(calls, []);
  } finally {
    unlockSession("s1");
  }
});

test("POST HEAD 不是会话分支时返回 400 且不 push", async () => {
  const { runner, calls } = fakeRunner((command, args) => {
    if (command === "git" && args[0] === "remote") return githubRemote();
    if (command === "git" && args[0] === "rev-parse") return branchOutput("main");
    throw new Error("不该继续执行");
  });

  const result = await invoke(runner, makeContext({ method: "POST", body: { title: "T", body: "" } }));
  assert.equal(result.status, 400);
  assert.match((result.body as { error?: string }).error ?? "", /会话分支/);
  assert.ok(!called(calls).some((args) => args[0] === "push"));
  assert.ok(!called(calls).some((args) => args[0] === "gh"));
});

test("POST 允许 qoder/ 和 remote-coder/ 旧会话分支", async () => {
  const branches = [
    "qoder/3f2a1b4c-0000-4000-8000-000000000001",
    "remote-coder/3f2a1b4c-0000-4000-8000-000000000002",
  ];
  for (const branch of branches) {
    const { runner, calls } = fakeRunner((command, args) => {
      if (command === "git" && args[0] === "remote") return githubRemote();
      if (command === "git" && args[0] === "rev-parse") return branchOutput(branch);
      if (command === "git" && args[0] === "push") return { stdout: "", stderr: "" };
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        return { stdout: "https://github.com/owner/repo/pull/9\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 9,
            url: "https://github.com/owner/repo/pull/9",
            state: "OPEN",
            title: "T",
            statusCheckRollup: [],
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    });

    const result = await invoke(runner, makeContext({ method: "POST", body: { title: "T", body: "" } }));
    assert.equal(result.status, 200, branch);
    assert.equal((result.body as PullRequestStatus).created, true, branch);
    assert.ok(
      called(calls).some((args) => args[0] === "git" && args[1] === "push"),
      branch,
    );
    assert.ok(
      called(calls).some((args) => args[0] === "gh" && args[1] === "pr" && args[2] === "create"),
      branch,
    );
  }
});

test("POST 创建时 git 锁被占用返回 409", async () => {
  const { runner, calls } = fakeRunner((command, args) => {
    if (command === "git" && args[0] === "remote") return githubRemote();
    throw new Error("不该继续执行");
  });
  let release!: () => void;
  const hold = withGitAction("s1", () => new Promise<void>((resolve) => {
    release = resolve;
  }));
  try {
    const result = await invoke(runner, makeContext({ method: "POST", body: { title: "T", body: "" } }));
    assert.equal(result.status, 409);
    assert.match((result.body as { error?: string }).error ?? "", /已有 git 操作/);
    // 锁在分支检查前就被占用，不会再执行 rev-parse/push。
    assert.deepEqual(called(calls), [["git", "remote", "get-url", "origin"]]);
  } finally {
    release();
    await hold;
  }
});

test("POST 推送失败时返回错误状态并脱敏凭证", async () => {
  const { runner, calls } = fakeRunner((command, args) => {
    if (command === "git" && args[0] === "remote") return githubRemote();
    if (command === "git" && args[0] === "rev-parse") return branchOutput();
    if (command === "git" && args[0] === "push") {
      throw failure("remote: Permission to https://user:secret@github.com/owner/repo.git denied");
    }
    throw new Error("不该创建");
  });

  const result = await invoke(runner, makeContext({ method: "POST", body: { title: "T", body: "" } }));
  assert.equal(result.status, 200);
  const body = result.body as PullRequestStatus;
  assert.equal(body.supported, true);
  assert.equal(body.exists, false);
  assert.match(body.error ?? "", /推送分支失败/);
  assert.ok(!(body.error ?? "").includes("secret"));
  assert.match(body.error ?? "", /\*\*\*@github\.com/);
  assert.ok(!called(calls).some((args) => args[0] === "gh"));
});

test("POST 创建时认证失败映射为 CLI 登录提示", async () => {
  const { runner } = fakeRunner((command, args) => {
    if (command === "git" && args[0] === "remote") return githubRemote();
    if (command === "git" && args[0] === "rev-parse") return branchOutput();
    if (command === "git" && args[0] === "push") return { stdout: "", stderr: "" };
    throw failure("gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.");
  });

  const result = await invoke(runner, makeContext({ method: "POST", body: { title: "T", body: "" } }));
  const body = result.body as PullRequestStatus;
  assert.equal(body.created, undefined);
  assert.match(body.error ?? "", /gh 未登录/);
});

test("PR 状态读取失败的错误文本会脱敏远端凭证", async () => {
  const { runner } = fakeRunner((command) => {
    if (command === "git") return githubRemote();
    throw failure("fatal: unable to access 'https://user:secret@github.com/owner/repo.git': 401");
  });

  const result = await invoke(runner, makeContext({ method: "GET" }));
  const text = (result.body as PullRequestStatus).error ?? "";
  assert.ok(!text.includes("secret"));
  assert.match(text, /\*\*\*@github\.com/);
});

test("remote 读取失败时也脱敏凭证", async () => {
  const { runner } = fakeRunner((command) => {
    if (command === "git") {
      throw failure("fatal: could not read from https://user:secret@github.com/owner/repo.git");
    }
    throw new Error(`unexpected ${command}`);
  });

  const result = await invoke(runner, makeContext({ method: "GET" }));
  const body = result.body as PullRequestStatus;
  assert.equal(body.supported, false);
  assert.ok(!(body.error ?? "").includes("secret"));
  assert.match(body.error ?? "", /\*\*\*@github\.com/);
});

test("创建成功但读取状态失败时，返回的 URL 也脱敏", async () => {
  const { runner } = fakeRunner((command, args) => {
    if (command === "git" && args[0] === "remote") return githubRemote();
    if (command === "git" && args[0] === "rev-parse") return branchOutput();
    if (command === "git" && args[0] === "push") return { stdout: "", stderr: "" };
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      return { stdout: "https://user:secret@github.com/owner/repo/pull/9\n", stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      throw failure("fatal: network error");
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  });

  const result = await invoke(runner, makeContext({ method: "POST", body: { title: "T", body: "" } }));
  const body = result.body as PullRequestStatus;
  assert.equal(body.created, true);
  assert.ok(!(body.url ?? "").includes("secret"));
  assert.match(body.url ?? "", /\*\*\*@github\.com/);
});

test("不匹配的路径返回 null，不支持的方法返回 405", async () => {
  const { runner } = fakeRunner(() => ({ stdout: "", stderr: "" }));
  const handler = createPullRequestHandler({ run: runner });
  const unmatched = await handler(makeContext({ method: "GET", pathname: "/api/sessions/s1/git" }));
  assert.equal(unmatched, null);

  const method = await invoke(runner, makeContext({ method: "DELETE" }));
  assert.equal(method.status, 405);
});
