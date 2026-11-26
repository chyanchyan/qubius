import { canonicalJson, sha256Hex } from "./canonical.js";
import {
  redactText,
  runDryRunCandidate,
  cliVersion,
  type CliOptions,
  type CommandRunner,
} from "./cli.js";
import {
  findConflictingSiteBlocks,
  renderVpsBlock,
  secretValues,
  spliceManaged,
  MANAGED_END,
  MANAGED_START,
} from "./render.js";
import {
  managedSites,
  parseRegistryText,
  renderRegistryDiff,
} from "./registry.js";
import { caddyVersion, readRemoteFile } from "./remote.js";
import {
  EdgeError,
  type EdgePlanInput,
  type EdgePaths,
  type EdgeRegistry,
  type EdgeRole,
  type EdgeSecrets,
  type EdgeSite,
  type EdgeWarnings,
  type RegistrySite,
} from "./types.js";

/**
 * provider 抽象：CLI（外部 edgectl）与 native（服务端内置渲染）。
 *
 * - CLI：握手 `edgectl --version`；plan 用候选临时注册表跑
 *         `validate --strict` + `apply-vps --dry-run`；
 * - native：纯渲染；
 * - 两者都读取远端 Caddyfile、计算候选内容和脱敏 diff，输出同一套计划模型。
 *
 * provider 只负责“选择 + 计划”。apply（锁、备份、写入、validate、reload、
 * 失败恢复）由 actions 层统一编排，不放在 provider 接口上；`EdgeProviderContext`
 * / `EdgeApplyOutcome` 是给 actions 层复用的上下文与结果类型。
 *
 * 注意：`EdgeProviderPlanInput` 在类型上扩展了 `EdgePlanInput`（role/form/apply），
 * 追加已解析的 paths/registry/候选文本/secrets。D2b/D4 通过 `plan.ts` 的
 * `buildPlan` 组装这些字段，而不是直接用裸 `EdgePlanInput` 调 provider。
 */

export type ProviderKind = "cli" | "native";

/** native 渲染版本；planHash 绑定它，渲染逻辑变化时递增。 */
export const NATIVE_RENDER_VERSION = "1";

export type EdgeLogFn = (message: string, ...args: unknown[]) => void;

export interface EdgeProviderContext {
  paths: EdgePaths;
  registry: EdgeRegistry;
  secrets: EdgeSecrets;
  repoRoot: string;
  jobId: string;
  log: EdgeLogFn;
}

export interface EdgeProviderPlanInput extends EdgePlanInput {
  paths: EdgePaths;
  registry: EdgeRegistry;
  /** 当前注册表原始文本（用于 diff / sha）。 */
  registryText: string;
  /** upsert 后的候选注册表文本（不落盘）。 */
  candidateText: string;
  secrets: EdgeSecrets;
  jobId: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  log?: EdgeLogFn;
  timeoutMs?: number;
  /** 远端 Caddy 版本（可选；用于 <2.8 + dev auth 的阻断）。 */
  caddyVersion?: string;
  /** 预先读取的远端内容（测试用；省略时通过 ssh 读取）。 */
  remoteContent?: string;
  /** desiredSites 已经产生的 warning。 */
  warnings?: string[];
  /** true 表示 secrets 加载失败，已降级为空 secrets（计划不可应用）。 */
  secretsMissing?: boolean;
  /** secrets 缺失时的原始错误文案（会脱敏后展示）。 */
  secretsWarning?: string;
  /** 是否探测远端 Caddy 版本；默认 true（remoteContent 注入时不探测）。 */
  probeCaddyVersion?: boolean;
}

export interface EdgeProviderPlan {
  /** 注册表差异（已脱敏）。 */
  registryDiff: string;
  /** 远端托管块差异（已脱敏，头部为通用标签）。 */
  remoteDiff: string;
  /** 期望的远端完整内容（原始；调用方落盘前必须脱敏/不落盘）。 */
  expectedRemoteContent: string;
  /** 期望远端内容的 sha256。 */
  expectedRemoteSha: string;
  /** 远端当前内容的 sha256；读取失败为 null。 */
  remoteRawSha: string | null;
  /** CLI dry-run 的脱敏 stdout（native 为 undefined）。 */
  dryRunStdout?: string;
  /** CLI dry-run 原始 stdout 的 sha256。 */
  dryRunStdoutSha?: string | null;
  /** 本次计划使用的远端 Caddy 版本；未探测/无 dev 站点时为 null。 */
  caddyVersion: string | null;
  warnings: string[];
  errors: string[];
  /** 机器可读的阻断码：non-owned-changed / conflict / caddy-too-old / ... */
  blocking: string[];
  requiresConfirmExisting: boolean;
  remoteUnavailable?: string;
}

export interface EdgeApplyOutcome {
  ok: boolean;
  /** 远端内容是否发生变化。 */
  changed: boolean;
  step: string;
  message: string;
  remoteRawSha?: string | null;
  warnings?: string[];
}

export interface EdgeProvider {
  kind: ProviderKind;
  /** CLI: `--version`；native: no-op。失败必须抛错，不能回退。 */
  handshake(): Promise<void>;
  /**
   * 生成计划。入参是扩展后的 `EdgeProviderPlanInput`（含 paths/registry/
   * candidate/secrets）；D2b/D4 请通过 `plan.ts` 的 `buildPlan` 组装，避免
   * 运行时缺字段。
   *
   * apply 不属于 provider：应用流程（锁、备份、validate、写回、reload、
   * 失败恢复）由 actions 层统一编排，CLI/native 只提供不同的动作原语。
   */
  plan(input: EdgeProviderPlanInput): Promise<EdgeProviderPlan>;
  /** 握手记录的 edgectl 版本（native 为 null）。 */
  readonly version?: string | null;
  /** CLI 的 bin 绝对路径（native 为 null）。 */
  readonly binPath?: string | null;
}

export interface ResolveProviderOptions {
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  timeoutMs?: number;
  log?: EdgeLogFn;
}

const MANAGED_NAMES = new Set(["qubius", "co-qubius"]);

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** 只比较会写进托管块的受管字段。 */
function siteSignature(site: Pick<RegistrySite, "name" | "domains" | "env" | "upstream" | "auth" | "sse">): string {
  return canonicalJson({
    name: site.name,
    domains: site.domains,
    env: site.env,
    upstream: site.upstream,
    auth: site.auth,
    sse: site.sse,
  });
}

/** 取托管块内部（去掉 marker 与首尾空白）。 */
function managedInner(block: string): string {
  const start = block.indexOf(MANAGED_START);
  const end = block.lastIndexOf(MANAGED_END);
  if (start < 0 || end < 0 || end < start) return block.trim();
  return block.slice(start + MANAGED_START.length, end).trim();
}

/**
 * 非 owned 站点是否会在整块重渲染中变化：将候选注册表里每个非 owned 站点
 * 单独渲染，检查其内容是否原样存在于远端托管块。任何缺失都视为变化。
 */
function nonOwnedChanges(
  remoteRaw: string,
  registry: EdgeRegistry,
  secrets: EdgeSecrets,
): string[] {
  const nonOwned = registry.sites.filter((site) => !MANAGED_NAMES.has(site.name));
  if (nonOwned.length === 0) return [];
  const remoteInner = managedInner(remoteRaw);
  const changed: string[] = [];
  for (const site of nonOwned) {
    let expectedInner: string;
    try {
      expectedInner = managedInner(
        renderVpsBlock({ ...registry, sites: [site] }, secrets),
      );
    } catch {
      // 非 owned 站点渲染失败（例如缺少密钥）时宁可阻断，不承诺“无变化”。
      changed.push(site.name);
      continue;
    }
    if (!remoteInner.includes(expectedInner)) changed.push(site.name);
  }
  return changed;
}

/** 简单行级 diff；头部固定为通用标签，避免泄露 VPS 用户/IP/路径。 */
export function renderRemoteDiff(
  remote: string,
  expected: string,
  secrets?: EdgeSecrets | string[] | null,
): string {
  if (remote === expected) return "远端无变化\n";
  const a = remote.split("\n");
  const b = expected.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf += 1;
  }
  const context = 3;
  const maxChange = 200;
  const out: string[] = ["--- 远端 Caddyfile", "+++ 候选 Caddyfile"];
  for (const line of a.slice(Math.max(0, pre - context), pre)) out.push(` ${line}`);
  const removed = a.slice(pre, a.length - suf);
  const added = b.slice(pre, b.length - suf);
  for (const line of removed.slice(0, maxChange)) out.push(`-${line}`);
  for (const line of added.slice(0, maxChange)) out.push(`+${line}`);
  if (removed.length > maxChange || added.length > maxChange) {
    out.push("…（差异过长，已截断）");
  }
  const suffixStart = a.length - suf;
  for (const line of a.slice(suffixStart, suffixStart + context)) out.push(` ${line}`);
  return redactText(`${out.join("\n")}\n`, secrets);
}

export function caddyTooOld(version: string | undefined | null): boolean {
  if (!version) return false;
  const match = version.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major < 2 || (major === 2 && minor < 8);
}

/** 计算两者共有的计划部分（不访问远端）。 */
function computeLocalPlan(input: EdgeProviderPlanInput): {
  registryDiff: string;
  warnings: string[];
  errors: string[];
  blocking: string[];
  requiresConfirmExisting: boolean;
  domains: Set<string>;
} {
  const warnings = [...(input.warnings ?? [])];
  const errors: string[] = [];
  const blocking: string[] = [];
  let requiresConfirmExisting = false;

  const candidateRegistry = parseRegistryText(input.candidateText, input.registry.source);
  const registryDiff = renderRegistryDiff(
    input.registryText,
    input.candidateText,
    secretValues(input.secrets),
  );

  if (input.secretsMissing) {
    warnings.push(input.secretsWarning ?? "缺少 dev 认证密钥，无法渲染候选 Caddyfile。");
    blocking.push("secrets-missing");
  }

  // 已有 owned 条目与 desired 不同：apply 需要 confirmExisting。
  const before = new Map(managedSites(input.registry).map((site) => [site.name, site]));
  for (const site of managedSites(candidateRegistry)) {
    const old = before.get(site.name);
    if (!old) continue;
    if (siteSignature(old) !== siteSignature(site)) requiresConfirmExisting = true;
  }

  if (caddyTooOld(input.caddyVersion) && candidateRegistry.sites.some((site) => site.auth === "dev")) {
    // 归入 blocking warning（前端只读 warnings 也能看到），不写成 errors。
    warnings.push(
      `远端 Caddy 版本 ${input.caddyVersion} 不支持 dev 认证所需的 basic_auth（需要 >= 2.8）；` +
        "请升级 Caddy 后再应用。",
    );
    blocking.push("caddy-too-old");
  }

  return {
    registryDiff,
    warnings,
    errors,
    blocking,
    requiresConfirmExisting,
    domains: new Set(candidateRegistry.sites.flatMap((site) => site.domains)),
  };
}

function remoteFailureMessage(error: unknown, secrets: EdgeSecrets): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, secrets);
}

/**
 * 未显式提供 caddyVersion、且没有注入 remoteContent 时，尝试探测远端
 * `caddy version`。只在候选注册表含 dev auth 站点时探测（否则 basic_auth
 * 兼容性无关）。探测失败静默返回 undefined，不产生噪音 warning。
 */
function probeCaddyVersion(input: EdgeProviderPlanInput): string | undefined {
  if (input.caddyVersion !== undefined) return input.caddyVersion;
  if (input.remoteContent !== undefined) return undefined;
  if (input.probeCaddyVersion === false) return undefined;
  const candidate = parseRegistryText(input.candidateText, input.registry.source);
  if (!candidate.sites.some((site) => site.auth === "dev")) return undefined;
  try {
    const probe = caddyVersion(input.registry, {
      runner: input.runner,
      env: input.env,
      secrets: input.secrets,
      timeoutMs: Math.min(input.timeoutMs ?? 15_000, 15_000),
    });
    return probe.version ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 共同 plan 流程：探测版本 → 读远端 → 计算期望内容 → diff / 冲突 / 非 owned 变化。
 * CLI 与 native 的唯一差异是是否附加 dry-run。
 */
async function computeProviderPlan(
  input: EdgeProviderPlanInput,
  options: { dryRun: boolean },
): Promise<EdgeProviderPlan> {
  const probedCaddyVersion = probeCaddyVersion(input);
  const local = computeLocalPlan({ ...input, caddyVersion: probedCaddyVersion });

  const warnings = local.warnings;
  const errors = [...local.errors];
  const blocking = [...local.blocking];
  let requiresConfirmExisting = local.requiresConfirmExisting;

  const base: EdgeProviderPlan = {
    registryDiff: local.registryDiff,
    remoteDiff: "",
    expectedRemoteContent: "",
    expectedRemoteSha: sha256Hex(""),
    remoteRawSha: null,
    caddyVersion: probedCaddyVersion ?? null,
    warnings,
    errors,
    blocking,
    requiresConfirmExisting,
  };

  let remoteRaw: string;
  if (input.remoteContent !== undefined) {
    remoteRaw = input.remoteContent;
  } else {
    try {
      remoteRaw = readRemoteFile(input.registry, {
        runner: input.runner,
        env: input.env,
        secrets: input.secrets,
        timeoutMs: input.timeoutMs,
      }).content;
    } catch (error) {
      return {
        ...base,
        warnings: unique([...warnings, "远端不可用，计划不可应用。"]),
        remoteUnavailable: remoteFailureMessage(error, input.secrets),
        dryRunStdoutSha: null,
      };
    }
  }

  const remoteRawSha = sha256Hex(remoteRaw);
  base.remoteRawSha = remoteRawSha;

  // 托管块之外与候选域名冲突的站点块。
  const conflicts = findConflictingSiteBlocks(remoteRaw, local.domains);
  if (conflicts.length > 0) {
    errors.push(
      `远端 Caddyfile 中有 ${conflicts.length} 个托管块之外的站点使用了相同的域名` +
        `（第 ${conflicts.map(([line]) => line).join("、")} 行）；请先手工处理冲突。`,
    );
    blocking.push("conflict");
  }

  const candidateRegistry = parseRegistryText(input.candidateText, input.registry.source);
  // 注意：不能用 desired 是否为空来跳过此检查——候选块是按整份候选注册表
  // 渲染的，desired 为空时注册表里仍可能有非 owned 站点被重写。只有候选完全
  // 没有站点时 nonOwnedChanges 才天然返回空。
  if (!input.secretsMissing && candidateRegistry.sites.length > 0) {
    // 非 owned 站点变化：整块重渲染会波及它们，要求 confirmExisting 才能继续。
    const changedNonOwned = nonOwnedChanges(remoteRaw, candidateRegistry, input.secrets);
    if (changedNonOwned.length > 0) {
      warnings.push(
        `整块重渲染会改变非 qubius 管理的站点：${changedNonOwned.join("、")}；` +
          "继续应用需要额外确认（confirmExisting）。",
      );
      blocking.push("non-owned-changed");
      requiresConfirmExisting = true;
    }
  }

  // 缺 secrets：保留注册表/远端信息，但不尝试渲染（渲染必然缺 auth）。
  if (input.secretsMissing) {
    return {
      ...base,
      warnings,
      errors,
      blocking,
      requiresConfirmExisting,
      remoteDiff: "缺少 dev 认证密钥，无法渲染候选 Caddyfile。\n",
      dryRunStdoutSha: null,
    };
  }

  // 期望内容：native 渲染 + splice。CLI 也计算，用于展示期望 sha 和远端 diff。
  let expectedRemoteContent: string;
  try {
    const block = renderVpsBlock(candidateRegistry, input.secrets);
    expectedRemoteContent = spliceManaged(remoteRaw, block);
  } catch (error) {
    errors.push(`渲染候选 Caddyfile 失败：${remoteFailureMessage(error, input.secrets)}`);
    blocking.push("render-failed");
    return {
      ...base,
      warnings,
      errors,
      blocking,
      requiresConfirmExisting,
      dryRunStdoutSha: null,
    };
  }

  const expectedRemoteSha = sha256Hex(expectedRemoteContent);
  const remoteDiff = renderRemoteDiff(remoteRaw, expectedRemoteContent, input.secrets);

  const plan: EdgeProviderPlan = {
    ...base,
    warnings,
    errors,
    blocking,
    requiresConfirmExisting,
    expectedRemoteContent,
    expectedRemoteSha,
    remoteDiff,
  };

  if (options.dryRun && !input.secretsMissing) {
    const configPath = input.paths.configPath ?? input.registry.source;
    try {
      const run = runDryRunCandidate({
        paths: input.paths,
        secrets: input.secrets,
        runner: input.runner,
        env: input.env,
        timeoutMs: input.timeoutMs,
        log: input.log ? (line) => input.log!(line) : undefined,
        registryPath: configPath,
        jobId: input.jobId,
        candidateText: input.candidateText,
      });
      if (!run.validate.ok) {
        errors.push(
          `edgectl validate --strict 校验候选配置失败（exit ${run.validate.code ?? "?"}）：` +
            (run.validate.stderr || run.validate.stdout || "无输出"),
        );
        blocking.push("validate-failed");
      }
      if (run.dryRunSkipped) {
        // validate 已失败，按要求跳过 dry-run；不额外记一条 dry-run 错误。
        plan.dryRunStdoutSha = null;
      } else {
        plan.dryRunStdout = run.dryRunStdout;
        plan.dryRunStdoutSha = run.dryRunStdoutSha;
        if (!run.dryRun.ok) {
          errors.push(
            `edgectl apply-vps --dry-run 失败（exit ${run.dryRun.code ?? "?"}）：` +
              (run.dryRun.stderr || run.dryRun.stdout || "无输出"),
          );
          blocking.push("dry-run-failed");
        }
      }
    } catch (error) {
      errors.push(`执行 edgectl dry-run 失败：${remoteFailureMessage(error, input.secrets)}`);
      blocking.push("dry-run-failed");
      plan.dryRunStdoutSha = null;
    }
  }

  return plan;
}

/** CLI provider：外部 edgectl。 */
class CliProvider implements EdgeProvider {
  readonly kind = "cli" as const;
  version: string | null = null;
  readonly binPath: string | null;
  private handshaken = false;

  constructor(
    private readonly paths: EdgePaths,
    private readonly options: ResolveProviderOptions,
  ) {
    this.binPath = paths.binPath;
  }

  private cliOptions(): CliOptions {
    return {
      paths: this.paths,
      runner: this.options.runner,
      env: this.options.env,
      timeoutMs: this.options.timeoutMs,
    };
  }

  async handshake(): Promise<void> {
    // 握手失败直接抛错；调用方（resolveProvider）不得回退 native。
    const result = cliVersion(this.cliOptions());
    this.version = result.version;
    this.handshaken = true;
  }

  async plan(input: EdgeProviderPlanInput): Promise<EdgeProviderPlan> {
    // 允许 D2b/D4 直接调用；确保握手已执行，但仍不回退。
    if (!this.handshaken) await this.handshake();
    return computeProviderPlan(input, { dryRun: true });
  }
}

/** native provider：内置渲染；apply 由 actions 层编排。 */
class NativeProvider implements EdgeProvider {
  readonly kind = "native" as const;
  readonly version = null;
  readonly binPath = null;

  async handshake(): Promise<void> {
    // native 不需要外部二进制。
  }

  async plan(input: EdgeProviderPlanInput): Promise<EdgeProviderPlan> {
    return computeProviderPlan(input, { dryRun: false });
  }
}

export const nativeProvider: EdgeProvider = new NativeProvider();

/**
 * 按 `paths.resolvedProvider` 选择 provider。
 *
 * - cli：必须存在 binPath，并立即执行 `--version` 握手；失败抛错，绝不回退。
 * - native：直接返回。
 * - null（disabled）：抛错并带上 D1 的错误信息。
 *
 * 不使用 `paths.provider`（auto/cli/native 的原始配置值）来决定执行方式。
 */
export async function resolveProvider(
  paths: EdgePaths,
  options: ResolveProviderOptions = {},
): Promise<{ provider: EdgeProvider; resolved: ProviderKind }> {
  if (paths.resolvedProvider === "cli") {
    if (!paths.binPath) {
      throw new EdgeError("QUBIUS_EDGE_PROVIDER=cli，但找不到可用的 edgectl CLI。");
    }
    const provider = new CliProvider(paths, options);
    // 握手失败直接抛出；这里绝不 catch 后改走 native。
    await provider.handshake();
    return { provider, resolved: "cli" };
  }
  if (paths.resolvedProvider === "native") {
    return { provider: nativeProvider, resolved: "native" };
  }
  const detail = paths.errors.length > 0 ? paths.errors.join("；") : "edge 配置不可用";
  throw new EdgeError(`公网入口未启用：${detail}`);
}

/** 便捷：从 desired 里提取 warning 集合（供 D2b 复用）。 */
export function edgeWarnings(input: {
  warnings?: string[];
  disabledRoles?: EdgeRole[];
  desired?: EdgeSite[];
}): EdgeWarnings {
  return {
    warnings: input.warnings ?? [],
    disabledRoles: input.disabledRoles ?? [],
  };
}
