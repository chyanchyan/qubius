#!/usr/bin/env node
// 命令行应用公网入口：走运行中实例的 /api/edge，流程与部署页「公网入口」一致：
//   GET /api/edge → POST /api/edge/plan → 用户确认 → POST /api/edge/apply → 轮询 /api/edge/status
//
// 由 deploy/deploy.sh wan 调用，也可以单独运行：
//   node deploy/edge-deploy.mjs --port 8787 --yes
//
// 只访问 127.0.0.1；不读取 edgectl 配置、不直接调用 edgectl，所有远端操作都在服务端作业里完成。
import fs from "node:fs";
import readline from "node:readline/promises";

const PLAN_TIMEOUT_MS = 120_000;
const APPLY_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_SECONDS = 300;

function usage() {
  return `用法：edge-deploy.mjs --port <端口> [选项]

  --port <n>        运行中实例的端口（只访问 127.0.0.1）
  --domain <域名>   确认的公网域名；默认取计划里第一个 desired 域名
  --token <令牌>    API 访问令牌（QUBIUS_AUTH=1 时需要）
  --token-file <p>  从文件读取令牌（通常是 <dataDir>/auth-token）
  --yes             不再交互确认
  --wait <秒>       等待作业结束的最长时间，默认 ${DEFAULT_WAIT_SECONDS}
  -h, --help        显示本帮助`;
}

class UsageError extends Error {}

function fail(message, code = 1) {
  console.error(`edge: ${message}`);
  process.exit(code);
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new UsageError(`${name} 必须是正整数：${value}`);
  }
  return number;
}

function parseArgs(argv) {
  const args = {
    port: null,
    domain: "",
    token: "",
    tokenFile: "",
    yes: false,
    wait: DEFAULT_WAIT_SECONDS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--port":
        args.port = positiveInt(argv[++i], "--port");
        break;
      case "--domain":
        args.domain = (argv[++i] ?? "").trim();
        break;
      case "--token":
        args.token = (argv[++i] ?? "").trim();
        break;
      case "--token-file":
        args.tokenFile = argv[++i] ?? "";
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--wait":
        args.wait = positiveInt(argv[++i], "--wait");
        break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new UsageError(`未知参数：${arg}`);
    }
  }
  if (args.port === null) throw new UsageError("缺少 --port");
  return args;
}

function readToken(args) {
  if (args.token) return args.token;
  if (!args.tokenFile) return "";
  try {
    return fs.readFileSync(args.tokenFile, "utf8").trim();
  } catch (error) {
    fail(`读取令牌文件失败：${args.tokenFile}（${error.code ?? error.message}）`);
  }
}

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClient(port, token) {
  const base = `http://127.0.0.1:${port}`;
  return async function call(pathname, { method = "GET", body, timeoutMs = STATUS_TIMEOUT_MS } = {}) {
    const headers = {};
    if (token) headers["x-qubius-token"] = token;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetch(base + pathname, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason =
        error?.name === "TimeoutError" || error?.name === "AbortError"
          ? `请求超时（${Math.round(timeoutMs / 1000)}s）`
          : (error?.cause?.code ?? error?.message ?? String(error));
      throw new ApiError(0, `${pathname} 请求失败：${reason}`);
    }
    const text = await response.text();
    let data = {};
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new ApiError(response.status, `${pathname} 返回的不是 JSON`);
      }
    }
    if (!response.ok) {
      const detail = typeof data?.error === "string" && data.error ? data.error : `HTTP ${response.status}`;
      throw new ApiError(response.status, detail, data?.code);
    }
    return data;
  };
}

function describeSites(desired) {
  if (!Array.isArray(desired) || desired.length === 0) return "（无）";
  return desired
    .map((site) => `${site.name} ${(site.domains ?? []).join(", ") || "（无域名）"} → ${site.upstream}`)
    .join("；");
}

function printPlan(plan) {
  console.log(`执行方式：${plan.provider ?? "未知"}`);
  console.log(`目标站点：${describeSites(plan.desired)}`);
  for (const warning of plan.warnings ?? []) {
    console.log(`注意：${warning}`);
  }
  if (plan.registryDiff) {
    console.log("注册表差异：");
    console.log(plan.registryDiff);
  }
  if (plan.remoteDiff) {
    console.log("远端差异：");
    console.log(plan.remoteDiff);
  }
}

function domainOf(plan) {
  const domains = [];
  for (const site of plan.desired ?? []) {
    for (const domain of site.domains ?? []) {
      if (typeof domain === "string" && domain) domains.push(domain);
    }
  }
  return domains;
}

async function confirmApply(args, plan, domain) {
  const extra = plan.requiresConfirmExisting ? "，会改动已有站点或非 qubius 管理的站点" : "";
  const question = `将应用公网入口（确认域名 ${domain}${extra}）。继续？[y/N] `;
  if (args.yes) return;
  if (!process.stdin.isTTY) {
    fail("非交互环境需要 --yes（或 QUBIUS_EDGE_YES=1）确认应用公网入口", 2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    if (!/^y(es)?$/i.test(answer.trim())) fail("已取消", 2);
  } finally {
    rl.close();
  }
}

async function waitForJob(call, jobId, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastLine = "";
  while (Date.now() < deadline) {
    const { job } = await call("/api/edge/status");
    if (job && job.jobId === jobId) {
      const line = `${job.step}: ${job.message}`;
      if (line !== lastLine) {
        console.log(line);
        lastLine = line;
      }
      if (job.state === "success") {
        console.log("公网入口已应用。");
        return 0;
      }
      if (job.state === "failed") {
        console.error(`公网入口应用失败：${job.message}`);
        if (job.logTail) console.error(job.logTail);
        return 1;
      }
    }
    await sleep(1000);
  }
  fail(`等待公网入口作业超时（${waitSeconds}s），任务可能仍在后台运行；可在部署页查看状态`, 1);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`edge: ${error.message}\n\n${usage()}`);
      process.exit(2);
    }
    throw error;
  }

  const call = makeClient(args.port, readToken(args));

  let view;
  try {
    view = await call("/api/edge", { timeoutMs: APPLY_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      fail("需要访问令牌：设置 QUBIUS_AUTH_TOKEN，或用 --token-file 指向 <dataDir>/auth-token");
    }
    throw error;
  }
  if (view.appBusy === "deploy") fail("部署任务正在进行，请等部署结束后重试");
  if (view.appBusy === "edge") fail("已有公网入口任务在运行，请等它结束后重试（或到部署页回收）");
  if (!view.enabled) {
    fail(`公网入口未启用：${view.hint ?? "请在 env 里配置 QUBIUS_EDGECTL_CONFIG"}`);
  }

  let plan;
  try {
    plan = await call("/api/edge/plan", { method: "POST", body: {}, timeoutMs: PLAN_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      fail("需要访问令牌：设置 QUBIUS_AUTH_TOKEN，或用 --token-file 指向 <dataDir>/auth-token");
    }
    throw error;
  }
  printPlan(plan);

  if (plan.requiresForceReclaim) {
    fail("公网入口有残留进程占用锁，请先到部署页的「公网入口」回收后再试");
  }
  if (plan.appliable !== true) {
    fail(`计划不可应用${plan.remoteUnavailable ? `：${plan.remoteUnavailable}` : ""}`);
  }

  const domains = domainOf(plan);
  if (domains.length === 0) {
    fail("没有可确认的公网域名，检查 QUBIUS_PUBLIC_HOST / QUBIUS_PUBLIC_HOST_SECONDARY");
  }
  // 显式指定的域名交给服务端校验（服务端还接受未生成 desired 的另一个实例域名）。
  const domain = args.domain || domains[0];

  await confirmApply(args, plan, domain);

  let jobId;
  try {
    ({ jobId } = await call("/api/edge/apply", {
      method: "POST",
      body: {
        planHash: plan.planHash,
        confirmDomain: domain,
        ...(plan.requiresConfirmExisting ? { confirmExisting: true } : {}),
      },
      timeoutMs: APPLY_TIMEOUT_MS,
    }));
  } catch (error) {
    if (error instanceof ApiError) fail(`启动公网入口作业失败：${error.message}`);
    throw error;
  }
  if (!jobId) fail("服务端没有返回作业 id");
  console.log(`公网入口作业已启动：${jobId}`);

  const code = await waitForJob(call, jobId, args.wait);
  process.exit(code);
}

main().catch((error) => {
  if (error instanceof ApiError) fail(error.message);
  fail(error?.stack ?? String(error));
});
