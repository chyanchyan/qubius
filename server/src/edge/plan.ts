import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { deployConfigDir, deriveDeployForm } from "../deploy.js";
import { canonicalJson, canonicalSha256, sha256Hex } from "./canonical.js";
import { redactText, type CommandRunner } from "./cli.js";
import { desiredSites } from "./desired.js";
import { resolveEdgeEnv } from "./envfile.js";
import {
  NATIVE_RENDER_VERSION,
  resolveProvider,
  type EdgeProvider,
  type EdgeProviderPlanInput,
  type EdgeLogFn,
  type ProviderKind,
} from "./provider.js";
import { parseRegistryText, upsertManagedSites } from "./registry.js";
import { secretValues } from "./render.js";
import { loadEdgeSecrets } from "./secrets.js";
import {
  EdgeError,
  type EdgePlanInput,
  type EdgePaths,
  type EdgeRegistry,
  type EdgeRole,
  type EdgeSecrets,
  type EdgeSite,
} from "./types.js";

/**
 * 计划（plan）的组装、持久化和过期校验。
 *
 * 一个 plan 固定住一次 apply 所需的全部输入指纹：注册表当前/候选 sha、远端
 * 原始 sha、期望内容 sha、desired 站点、edge 相关 env 快照、edgectl 版本、
 * native 渲染版本、secrets sha。planHash 由这些字段 + planId/createdAt 做
 * canonicalJson sha256；apply 必须回传同一 planHash。
 *
 * 落盘的 `<deployConfigDir>/edge-plan.json` 以 0600 原子写入，并再次做脱敏，
 * 确保没有明文 secrets。期望的远端内容只保存脱敏预览；apply（D4）需要时用
 * `candidateBytes` + 当前 secrets 重新渲染即可。
 */

export const EDGE_PLAN_FILE = "edge-plan.json";

export function edgePlanFile(configDir: string): string {
  return path.join(configDir, EDGE_PLAN_FILE);
}

export interface StoredEdgePlan {
  planId: string;
  planHash: string;
  /** ISO 时间。 */
  createdAt: string;
  role: EdgeRole;
  provider: ProviderKind;
  registryPath: string;
  /** 当前注册表原始文本 sha256。 */
  registrySha: string;
  /** 候选注册表文本 sha256。 */
  candidateSha: string;
  /** 候选注册表文本（不含 secrets，可安全落盘/重新渲染）。 */
  candidateBytes: string;
  desired: EdgeSite[];
  disabledRoles: EdgeRole[];
  remoteRawSha: string | null;
  expectedRemoteSha: string;
  /** 期望远端内容的脱敏预览（不用于写入）。 */
  expectedRemoteContent: string;
  dryRunStdoutSha: string | null;
  /** 本次计划使用的远端 Caddy 版本；未探测/无 dev 站点时为 null。 */
  caddyVersion: string | null;
  /** CLI dry-run 的脱敏输出。 */
  dryRunStdout?: string;
  /** 已脱敏。 */
  registryDiff: string;
  /** 已脱敏，头部为通用标签。 */
  remoteDiff: string;
  warnings: string[];
  errors: string[];
  /** 机器可读阻断码。 */
  blocking: string[];
  requiresConfirmExisting: boolean;
  remoteUnavailable?: string;
  envSnapshot: Record<string, string>;
  edgectl: {
    bin: string | null;
    version: string | null;
    source: string | null;
  };
  nativeRenderVersion: string;
  secretsSha: string;
  appliable: boolean;
}

export interface PlanStaleReason {
  code: string;
  message: string;
}

export interface PlanVerification {
  ok: boolean;
  stale: PlanStaleReason[];
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new EdgeError(
      `读取 edgectl 配置失败：${file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeAtomic(file: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能没创建成功。
    }
    throw error;
  }
}

/**
 * edge 相关键的有效值快照。与 `deriveDeployForm` 同源（env 文件优先、进程
 * env 兜底、默认值）。
 */
export function edgeEnvSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  role: EdgeRole = "primary",
  repoRoot?: string,
): Record<string, string> {
  const { form } = deriveDeployForm(env, role, repoRoot);
  const paths = resolveEdgeEnv(env);
  return {
    deployConfigDir: form.configDir,
    configDir: form.configDir,
    publicHost: form.publicHost,
    publicHostSecondary: form.publicHostSecondary,
    primaryPort: String(form.primaryPort),
    secondaryPort: String(form.secondaryPort),
    startPrimary: form.startPrimary ? "1" : "0",
    startSecondary: form.startSecondary ? "1" : "0",
    edgectlConfig: paths.configPath ?? "",
    edgectlBin: paths.binPath ?? "",
    edgeProvider: paths.provider ?? "",
    resolvedProvider: paths.resolvedProvider ?? "",
    role,
  };
}

interface PlanHashFields {
  provider: ProviderKind;
  registryPath: string;
  registrySha: string;
  candidateSha: string;
  desired: EdgeSite[];
  remoteRawSha: string | null;
  expectedRemoteSha: string;
  dryRunStdoutSha: string | null;
  caddyVersion: string | null;
  envSnapshot: Record<string, string>;
  edgectl: StoredEdgePlan["edgectl"];
  nativeRenderVersion: string;
  secretsSha: string;
  createdAt: string;
  planId: string;
}

function planHashFields(plan: {
  provider: ProviderKind;
  registryPath: string;
  registrySha: string;
  candidateSha: string;
  desired: EdgeSite[];
  remoteRawSha: string | null;
  expectedRemoteSha: string;
  dryRunStdoutSha: string | null;
  caddyVersion: string | null;
  envSnapshot: Record<string, string>;
  edgectl: StoredEdgePlan["edgectl"];
  nativeRenderVersion: string;
  secretsSha: string;
  createdAt: string;
  planId: string;
}): PlanHashFields {
  return {
    provider: plan.provider,
    registryPath: plan.registryPath,
    registrySha: plan.registrySha,
    candidateSha: plan.candidateSha,
    desired: plan.desired,
    remoteRawSha: plan.remoteRawSha,
    expectedRemoteSha: plan.expectedRemoteSha,
    dryRunStdoutSha: plan.dryRunStdoutSha,
    caddyVersion: plan.caddyVersion,
    envSnapshot: plan.envSnapshot,
    edgectl: plan.edgectl,
    nativeRenderVersion: plan.nativeRenderVersion,
    secretsSha: plan.secretsSha,
    createdAt: plan.createdAt,
    planId: plan.planId,
  };
}

export function computePlanHash(plan: Parameters<typeof planHashFields>[0]): string {
  return canonicalSha256(planHashFields(plan));
}

function redactPlan(plan: StoredEdgePlan, secrets?: EdgeSecrets | string[] | null): StoredEdgePlan {
  return {
    ...plan,
    expectedRemoteContent: redactText(plan.expectedRemoteContent, secrets),
    registryDiff: redactText(plan.registryDiff, secrets),
    remoteDiff: redactText(plan.remoteDiff, secrets),
    dryRunStdout:
      plan.dryRunStdout === undefined ? undefined : redactText(plan.dryRunStdout, secrets),
    warnings: plan.warnings.map((value) => redactText(value, secrets)),
    errors: plan.errors.map((value) => redactText(value, secrets)),
    ...(plan.remoteUnavailable === undefined
      ? {}
      : { remoteUnavailable: redactText(plan.remoteUnavailable, secrets) }),
  };
}

export interface BuildPlanOptions {
  env?: NodeJS.ProcessEnv;
  paths?: EdgePaths;
  registry?: EdgeRegistry;
  registryText?: string;
  secrets?: EdgeSecrets;
  /** 注入 provider（测试）；省略时按 paths.resolvedProvider 选择并握手。 */
  provider?: EdgeProvider;
  runner?: CommandRunner;
  jobId?: string;
  planId?: string;
  now?: Date;
  configDir?: string;
  /** 仓库根目录；用于把 <repo>/deploy/env 纳入 env 解析（与部署页一致）。 */
  repoRoot?: string;
  /** 是否写 `<configDir>/edge-plan.json`，默认 true。 */
  persist?: boolean;
  caddyVersion?: string;
  /** 是否让 provider 探测远端 Caddy 版本；默认 true。 */
  probeCaddyVersion?: boolean;
  /** 预先读取的远端内容（测试用；省略时 provider 通过 ssh 读取）。 */
  remoteContent?: string;
  log?: EdgeLogFn;
  timeoutMs?: number;
}

/** 可由用户 confirmExisting 后继续的阻断码，不直接判为不可应用。 */
const CONFIRMABLE_BLOCKING = new Set(["non-owned-changed"]);

/**
 * 生成计划：desired → 候选 upsert（不落真文件）→ provider plan（远端/dry-run）
 * → 指纹。默认原子写 `<configDir>/edge-plan.json`（0600、已脱敏）。
 */
export async function buildPlan(
  input: EdgePlanInput = { role: "primary" },
  options: BuildPlanOptions = {},
): Promise<StoredEdgePlan> {
  const env = options.env ?? process.env;
  const role = input.role;
  const paths = options.paths ?? resolveEdgeEnv(env);

  const source = options.registry?.source ?? paths.configPath;
  if (!source) {
    throw new EdgeError(
      `公网入口未启用：${paths.errors.join("；") || "未配置 edgectl 配置路径"}`,
    );
  }
  if (!options.registry && paths.disabled) {
    throw new EdgeError(`公网入口未启用：${paths.errors.join("；") || "配置不可用"}`);
  }

  // 只读一次：同一份 registryText 同时派生 registry 与 registrySha。
  // 注意：D1 的 upsertManagedSites 内部仍会读取 configPath（API 限制），
  // 因此候选文本与 registrySha 之间仍有一个很窄的二次读取窗口。后续可把
  // upsertManagedSites 改为接受已读文本，彻底消除该窗口。
  const registryText = options.registryText ?? readText(source);
  const registry = parseRegistryText(registryText, source);
  const registrySha = sha256Hex(registryText);

  const form = input.form ?? deriveDeployForm(env, role, options.repoRoot).form;
  const desired = desiredSites(form, role);

  // 只生成候选文本：write:false 不会动真实注册表。
  const upsert = upsertManagedSites(registry.source, desired.sites, { write: false });
  const candidateText = upsert.text;
  const candidateSha = sha256Hex(candidateText);

  // 缺 secrets 降级为空值继续出计划（页面仍能看到差异与原因），不直接抛错。
  let secrets: EdgeSecrets;
  let secretsWarning: string | undefined;
  let secretsMissing = false;
  if (options.secrets) {
    secrets = options.secrets;
  } else {
    try {
      secrets = loadEdgeSecrets({ registry, env });
    } catch (error) {
      if (!(error instanceof EdgeError)) throw error;
      secretsMissing = true;
      secretsWarning = error.message;
      secrets = {
        passwordHash: "",
        cookieSecret: "",
        secretsSha: canonicalSha256({ missing: "edge-secrets" }),
        passwordHashSource: "envfile",
        cookieSecretSource: "envfile",
      };
    }
  }

  let provider: EdgeProvider;
  let resolved: ProviderKind;
  if (options.provider) {
    provider = options.provider;
    resolved = provider.kind;
  } else {
    const selected = await resolveProvider(paths, {
      env,
      runner: options.runner,
      timeoutMs: options.timeoutMs,
      log: options.log,
    });
    provider = selected.provider;
    resolved = selected.resolved;
  }

  const jobId = options.jobId ?? randomUUID();
  const configuredCaddyVersion =
    options.caddyVersion ?? (env.QUBIUS_CADDY_VERSION?.trim() || undefined);
  const planInput: EdgeProviderPlanInput = {
    ...input,
    role,
    form,
    paths,
    registry,
    registryText,
    candidateText,
    secrets,
    jobId,
    env,
    runner: options.runner,
    log: options.log,
    timeoutMs: options.timeoutMs,
    caddyVersion: configuredCaddyVersion,
    probeCaddyVersion: options.probeCaddyVersion,
    remoteContent: options.remoteContent,
    warnings: desired.warnings,
    secretsMissing,
    ...(secretsWarning === undefined ? {} : { secretsWarning }),
  };

  const providerPlan = await provider.plan(planInput);

  const errors = uniqueStrings([...providerPlan.errors]);
  const blocking = uniqueStrings([
    ...providerPlan.blocking,
    ...(secretsMissing ? ["secrets-missing"] : []),
  ]);
  // errors/blocking 汇总进 warnings（带前缀），保证前端只读 warnings 也能看到原因。
  const warnings = uniqueStrings([
    ...desired.warnings,
    ...providerPlan.warnings,
    ...(secretsMissing && secretsWarning ? [secretsWarning] : []),
    ...errors.map((value) => `错误：${value}`),
    ...blocking.map((code) => `阻断：${code}`),
  ]);
  // non-owned-changed 只要求 confirmExisting，不直接判为不可应用。
  const hardBlocking = blocking.filter((code) => !CONFIRMABLE_BLOCKING.has(code));
  const appliable =
    hardBlocking.length === 0 && errors.length === 0 && !providerPlan.remoteUnavailable;

  const createdAt = (options.now ?? new Date()).toISOString();
  const planId = options.planId ?? randomUUID();
  const envSnapshot = edgeEnvSnapshot(env, role, options.repoRoot);
  const edgectl = {
    bin: paths.binPath ?? null,
    version: provider.version ?? null,
    source: paths.binSource ?? null,
  };
  const dryRunStdoutSha = providerPlan.dryRunStdoutSha ?? null;
  const caddyVersion = providerPlan.caddyVersion ?? null;

  const hashFields = {
    provider: resolved,
    registryPath: registry.source,
    registrySha,
    candidateSha,
    desired: desired.sites,
    remoteRawSha: providerPlan.remoteRawSha,
    expectedRemoteSha: providerPlan.expectedRemoteSha,
    dryRunStdoutSha,
    caddyVersion,
    envSnapshot,
    edgectl,
    nativeRenderVersion: NATIVE_RENDER_VERSION,
    secretsSha: secrets.secretsSha,
    createdAt,
    planId,
  };

  const rawPlan: StoredEdgePlan = {
    planId,
    planHash: computePlanHash(hashFields),
    createdAt,
    role,
    provider: resolved,
    registryPath: registry.source,
    registrySha,
    candidateSha,
    candidateBytes: candidateText,
    desired: desired.sites,
    disabledRoles: desired.disabledRoles,
    remoteRawSha: providerPlan.remoteRawSha,
    expectedRemoteSha: providerPlan.expectedRemoteSha,
    expectedRemoteContent: providerPlan.expectedRemoteContent,
    dryRunStdoutSha,
    caddyVersion,
    ...(providerPlan.dryRunStdout === undefined
      ? {}
      : { dryRunStdout: providerPlan.dryRunStdout }),
    registryDiff: providerPlan.registryDiff,
    remoteDiff: providerPlan.remoteDiff,
    warnings,
    errors,
    blocking,
    requiresConfirmExisting: providerPlan.requiresConfirmExisting,
    ...(providerPlan.remoteUnavailable === undefined
      ? {}
      : { remoteUnavailable: providerPlan.remoteUnavailable }),
    envSnapshot,
    edgectl,
    nativeRenderVersion: NATIVE_RENDER_VERSION,
    secretsSha: secrets.secretsSha,
    appliable,
  };

  const plan = redactPlan(rawPlan, secrets);
  if (options.persist !== false) {
    const configDir = options.configDir ?? deployConfigDir(env);
    writePlan(configDir, plan, secrets);
  }
  return plan;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** 原子写计划文件（0600）；写前再次脱敏，确保没有明文 secrets。 */
export function writePlan(
  configDir: string,
  plan: StoredEdgePlan,
  secrets?: EdgeSecrets | string[] | null,
): string {
  const safe = redactPlan(plan, secrets);
  const file = edgePlanFile(configDir);
  writeAtomic(file, `${JSON.stringify(safe, null, 2)}\n`, 0o600);
  return file;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** 读取计划文件；不存在/损坏返回 null（不抛）。 */
export function readPlan(configDir: string): StoredEdgePlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(edgePlanFile(configDir), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const required: Array<keyof StoredEdgePlan> = [
    "planId",
    "planHash",
    "createdAt",
    "role",
    "provider",
    "registryPath",
    "registrySha",
    "candidateSha",
    "candidateBytes",
    "expectedRemoteSha",
    "nativeRenderVersion",
    "secretsSha",
  ];
  for (const key of required) {
    if (!isString(record[key])) return null;
  }
  if (record.provider !== "cli" && record.provider !== "native") return null;
  if (record.role !== "primary" && record.role !== "secondary") return null;
  if (!Array.isArray(record.desired)) return null;
  if (!Array.isArray(record.warnings) || !Array.isArray(record.errors)) return null;
  if (!Array.isArray(record.blocking)) return null;
  if (!record.envSnapshot || typeof record.envSnapshot !== "object") return null;
  if (!record.edgectl || typeof record.edgectl !== "object") return null;

  return {
    planId: record.planId as string,
    planHash: record.planHash as string,
    createdAt: record.createdAt as string,
    role: record.role,
    provider: record.provider,
    registryPath: record.registryPath as string,
    registrySha: record.registrySha as string,
    candidateSha: record.candidateSha as string,
    candidateBytes: record.candidateBytes as string,
    desired: record.desired as EdgeSite[],
    disabledRoles: Array.isArray(record.disabledRoles)
      ? (record.disabledRoles.filter(
          (value): value is EdgeRole => value === "primary" || value === "secondary",
        ) as EdgeRole[])
      : [],
    remoteRawSha: isString(record.remoteRawSha) ? record.remoteRawSha : null,
    expectedRemoteSha: record.expectedRemoteSha as string,
    expectedRemoteContent: isString(record.expectedRemoteContent)
      ? record.expectedRemoteContent
      : "",
    dryRunStdoutSha: isString(record.dryRunStdoutSha) ? record.dryRunStdoutSha : null,
    caddyVersion: isString(record.caddyVersion) ? record.caddyVersion : null,
    ...(isString(record.dryRunStdout) ? { dryRunStdout: record.dryRunStdout } : {}),
    registryDiff: isString(record.registryDiff) ? record.registryDiff : "",
    remoteDiff: isString(record.remoteDiff) ? record.remoteDiff : "",
    warnings: (record.warnings as unknown[]).filter(isString),
    errors: (record.errors as unknown[]).filter(isString),
    blocking: (record.blocking as unknown[]).filter(isString),
    requiresConfirmExisting: record.requiresConfirmExisting === true,
    ...(isString(record.remoteUnavailable)
      ? { remoteUnavailable: record.remoteUnavailable }
      : {}),
    envSnapshot: record.envSnapshot as Record<string, string>,
    edgectl: {
      bin: isString((record.edgectl as Record<string, unknown>).bin)
        ? ((record.edgectl as Record<string, unknown>).bin as string)
        : null,
      version: isString((record.edgectl as Record<string, unknown>).version)
        ? ((record.edgectl as Record<string, unknown>).version as string)
        : null,
      source: isString((record.edgectl as Record<string, unknown>).source)
        ? ((record.edgectl as Record<string, unknown>).source as string)
        : null,
    },
    nativeRenderVersion: record.nativeRenderVersion as string,
    secretsSha: record.secretsSha as string,
    appliable: record.appliable === true,
  };
}

/** 删除计划文件；不存在不报错。 */
export function deletePlan(configDir: string): void {
  try {
    fs.unlinkSync(edgePlanFile(configDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export interface VerifyPlanOptions {
  /** 期望的 planHash（apply 请求里带回的值）。 */
  planHash?: string;
  /**
   * 是否重新读取注册表/env/secrets 并比较。默认 true（避免调用方漏检漂移）；
   * 只做纯内存 hash 校验时才显式传 false。
   */
  recheck?: boolean;
  registryText?: string;
  /**
   * 当前远端 Caddyfile 的 sha。recheck 时必须由调用方提供（除非计划
   * remoteRawSha===null，表示生成计划时远端就不可用）；缺失时返回
   * `remote-unchecked` stale。
   */
  remoteRawSha?: string | null;
  /** 当前远端 Caddy 版本。recheck 时若计划记录了版本则必须提供。 */
  caddyVersion?: string | null;
  secrets?: EdgeSecrets;
  env?: NodeJS.ProcessEnv;
  /** 仓库根目录；必须与生成计划时的取值一致，否则会误报 env-changed。 */
  repoRoot?: string;
  provider?: ProviderKind;
  nativeRenderVersion?: string;
  edgectl?: StoredEdgePlan["edgectl"];
}

/**
 * 校验计划是否仍然可用。
 *
 * 默认（recheck=true）会重新读取注册表、env、secrets，并要求调用方提供
 * `remoteRawSha` 以校验远端漂移；缺省 remoteRawSha（且计划记录了远端）时
 * 返回 `remote-unchecked` stale，避免 D2b 用默认调用漏检。纯内存校验传
 * `recheck:false`。返回结构化 stale 原因，不抛异常。
 */
export function verifyPlan(
  plan: StoredEdgePlan,
  options: VerifyPlanOptions = {},
): PlanVerification {
  const stale: PlanStaleReason[] = [];
  const push = (code: string, message: string): void => {
    stale.push({ code, message });
  };

  if (computePlanHash(plan) !== plan.planHash) {
    push("hash-mismatch", "计划文件内容与 planHash 不一致（可能被修改）。");
  }
  if (options.planHash !== undefined && options.planHash !== plan.planHash) {
    push("plan-mismatch", "planHash 与当前计划不一致，请重新生成计划。");
  }
  if (options.provider !== undefined && options.provider !== plan.provider) {
    push("provider-mismatch", `provider 已变化：${plan.provider} → ${options.provider}。`);
  }
  const expectedNative = options.nativeRenderVersion ?? NATIVE_RENDER_VERSION;
  if (plan.nativeRenderVersion !== expectedNative) {
    push(
      "version-mismatch",
      `native 渲染版本已变化：${plan.nativeRenderVersion} → ${expectedNative}。`,
    );
  }
  if (options.edgectl) {
    if (
      options.edgectl.bin !== plan.edgectl.bin ||
      options.edgectl.version !== plan.edgectl.version
    ) {
      push("edgectl-changed", "edgectl 路径或版本已变化。");
    }
  }
  if (sha256Hex(plan.candidateBytes) !== plan.candidateSha) {
    push("candidate-changed", "候选注册表内容与 candidateSha 不一致。");
  }

  const recheck = options.recheck !== false;
  if (recheck) {
    const env = options.env ?? process.env;
    const registryText =
      options.registryText ?? (safeRead(plan.registryPath) ?? undefined);
    if (registryText !== undefined) {
      if (sha256Hex(registryText) !== plan.registrySha) {
        push("registry-changed", "注册表在计划生成后发生了变化，请重新生成计划。");
      }
    } else {
      push("registry-unavailable", "无法读取注册表以校验计划。");
    }

    const snapshot = edgeEnvSnapshot(env, plan.role, options.repoRoot);
    if (canonicalJson(snapshot) !== canonicalJson(plan.envSnapshot)) {
      push("env-changed", "edge 相关环境变量在计划生成后发生了变化。");
    }

    if (options.secrets) {
      if (options.secrets.secretsSha !== plan.secretsSha) {
        push("secrets-changed", "dev 认证密钥在计划生成后发生了变化。");
      }
    } else if (registryText !== undefined) {
      try {
        const registry = parseRegistryText(registryText, plan.registryPath);
        const secrets = loadEdgeSecrets({ registry, env });
        if (secrets.secretsSha !== plan.secretsSha) {
          push("secrets-changed", "dev 认证密钥在计划生成后发生了变化。");
        }
      } catch {
        push("secrets-unavailable", "无法读取 dev 认证密钥以校验计划。");
      }
    }

    if (options.remoteRawSha !== undefined) {
      if (options.remoteRawSha !== plan.remoteRawSha) {
        push("remote-changed", "远端 Caddyfile 在计划生成后发生了变化。");
      }
    } else if (plan.remoteRawSha !== null) {
      // 计划记录了远端内容却没提供当前 sha：不能假设未漂移，直接判 stale。
      push(
        "remote-unchecked",
        "recheck 需要调用方提供当前 remoteRawSha 才能校验远端漂移。",
      );
    }
    // 注意：plan.remoteRawSha===null 表示生成计划时远端就不可用，此时没有
    // 可比较的远端指纹。verifyPlan 不能代替业务闸门——D2b 必须在 apply 前
    // 检查 plan.appliable === true 且 plan.remoteUnavailable 未设置。

    if (options.caddyVersion !== undefined) {
      if (options.caddyVersion !== plan.caddyVersion) {
        push(
          "caddy-version-changed",
          `远端 Caddy 版本已变化：${plan.caddyVersion ?? "未知"} → ${options.caddyVersion ?? "未知"}。`,
        );
      }
    } else if (plan.caddyVersion !== null) {
      push(
        "caddy-unchecked",
        "recheck 需要调用方提供当前 caddyVersion 才能校验 Caddy 版本。",
      );
    }
  }

  return { ok: stale.length === 0, stale };
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
