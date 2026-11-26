import { sha256Hex } from "./canonical.js";
import {
  defaultCommandRunner,
  redactText,
  type CommandRunner,
} from "./cli.js";
import { parseRegistryText } from "./registry.js";
import { renderVpsBlock, spliceManaged } from "./render.js";
import {
  assertRemoteBackupPath,
  backupRemoteFile,
  caddyReload,
  caddyValidateCandidate,
  caddyValidateLive,
  prepareSshControlDir,
  readRemoteFile,
  restoreRemoteFile,
  shellQuote,
  sshCommand,
  writeRemoteFileInPlace,
  type RemoteOptions,
  type RemoteResult,
} from "./remote.js";
import type { EdgeRegistry, EdgeSecrets } from "./types.js";

/**
 * native provider 的 apply-vps 与恢复（Phase C，D4）。
 *
 * 严格遵循已评审协议：
 *   1. 读远端原文 + sha，与计划记录的 remoteRawSha 比对（漂移则中止）；
 *   2. 用候选注册表原文重渲染托管块并 splice 到远端原文，校验
 *      sha === expectedRemoteSha（计划期望值；不符则中止，不写）；
 *   3. 先在容器内对候选内容做一次 `caddy validate`，失败时真文件分毫不动；
 *   4. 备份远端 Caddyfile 并立即读回备份 sha，确认等于原始远端 sha；
 *   5. 备份后、写入前紧邻再读一次远端 sha：再次确认未漂移，或若已是目标
 *      内容则跳过写入；
 *   6. `cat >` 原地写（不换 inode）。写命令报错时先回读 sha：等于期望值
 *      视为写入成功继续 reload；否则用备份恢复，恢复后 sha 等于原始值才
 *      restored，否则 unknown；
 *   7. live 复核后 `caddy reload`；reload 失败不回滚文件，返回
 *      writtenNotActive 交给上层决定 forceReload / 恢复。
 *
 * 结果分类约定（D2b 接入）：
 *   - writtenNotActive 时 remoteSha 通常等于 expectedRemoteSha（文件已是目标、
 *     运行配置未更新）；D2b 可据此调用 reloadOnly。
 *   - 进入 apply 时远端已经等于目标内容（本次未写文件）不会误报为普通写入：
 *     reload 成功返回 success 且 code="already-applied"；reload 失败返回
 *     writtenNotActive 且 code="already-applied-reload-failed"。
 *   - 写后校验失败但备份恢复成功返回 outcome="restored"（远端回到原内容，
 *     apply 未生效）；恢复失败返回 outcome="unknown"。
 *
 * 约定：
 *   - 远端内容（含 secrets）只在本模块内存里用于 sha/splice/校验，绝不写入
 *     日志或返回消息；
 *   - 所有返回消息、日志都经 redactText 脱敏（secrets + URL user:pass）；
 *   - runner 可注入，测试不跑真实 ssh/docker。
 */

export type NativeApplyOutcome =
  | "success"
  | "restored"
  | "writtenNotActive"
  | "unknown"
  | "failed";

export interface NativeApplyResult {
  outcome: NativeApplyOutcome;
  /** 最终远端 Caddyfile 的 sha；无法确定时为 null。 */
  remoteSha: string | null;
  /** 本次操作产生/使用的备份绝对路径；没有则为 null。 */
  backupPath: string | null;
  /** 已脱敏、面向用户的消息。 */
  message: string;
  /** 机器可读原因码（便于上层分支/状态展示）。 */
  code: string;
}

export interface NativeApplyInput {
  /** 注册表绝对路径（用于从 candidateBytes 重新解析）。 */
  registryPath: string;
  /** 候选注册表（已 upsert；用于远端连接与容器配置）。 */
  registry: EdgeRegistry;
  /** 候选注册表原文；必须用它 + 当前 secrets 重新渲染。 */
  candidateBytes: string;
  secrets: EdgeSecrets;
  /** 计划生成时的远端指纹。 */
  remoteRawSha: string;
  /** 计划期望的远端内容 sha。 */
  expectedRemoteSha: string;
  jobId: string;
  log: (text: string) => void;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** 备份后缀（安全字符）；默认 UTC 时间戳。 */
  backupSuffix?: string;
}

export interface NativeReloadInput {
  registry: EdgeRegistry;
  secrets: EdgeSecrets;
  /**
   * 可选期望远端 sha。提供时 reload 前先读远端 sha，不一致直接拒绝 reload
   * （避免把非目标内容激活）。
   */
  expectedSha?: string;
  jobId?: string;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  log?: (text: string) => void;
}

export interface RestoreBackupInput {
  registry: EdgeRegistry;
  secrets: EdgeSecrets;
  /** 备份绝对路径；必须形如 `<caddyfile>.bak.<safe>`。 */
  backup: string;
  /**
   * 备份内容 sha；应等于计划生成时的 remoteRawSha（备份创建于写入前，
   * 内容就是远端原文）。读取备份后会严格比对。
   */
  backupSha: string;
  /** 必须显式 true 才执行写操作（上层负责用户确认）。 */
  confirm: boolean;
  jobId?: string;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  log?: (text: string) => void;
}

export interface RestoreCurrentInput {
  registry: EdgeRegistry;
  secrets: EdgeSecrets;
  /** 上层在 reload 失败前保存的远端当前（unknown）内容。 */
  content: string;
  /** 内容 sha；提供时读取后校验。 */
  contentSha?: string;
  /** 必须显式 true 才执行写操作。 */
  confirm?: boolean;
  jobId?: string;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  log?: (text: string) => void;
}

interface RemoteContext {
  registry: EdgeRegistry;
  secrets: EdgeSecrets;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  log: (text: string) => void;
}

function makeLog(
  log: ((text: string) => void) | undefined,
  secrets: EdgeSecrets,
): (text: string) => void {
  return (text: string): void => {
    if (!log) return;
    try {
      log(redactText(text, secrets));
    } catch {
      // 日志失败不能影响 apply 主流程。
    }
  };
}

function remoteOptions(ctx: RemoteContext): RemoteOptions {
  return {
    runner: ctx.runner,
    env: ctx.env,
    secrets: ctx.secrets,
    timeoutMs: ctx.timeoutMs,
  };
}

function makeResult(
  outcome: NativeApplyOutcome,
  secrets: EdgeSecrets,
  code: string,
  message: string,
  remoteSha: string | null,
  backupPath: string | null,
): NativeApplyResult {
  return {
    outcome,
    code,
    remoteSha,
    backupPath,
    message: redactText(message, secrets),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeRemote(
  action: string,
  result: RemoteResult,
  secrets: EdgeSecrets,
): string {
  if (result.timedOut) return `${action}超时`;
  const detail = result.stderr || result.stdout || "无输出";
  return `${action}失败（exit ${result.code ?? "?"}）：${redactText(detail, secrets)}`;
}

interface RawRemoteRead {
  ok: boolean;
  /** 原始内容（未脱敏；不得直接展示）。 */
  content: string;
  sha: string;
  detail: string;
}

/**
 * 读取远端任意文件原文（restore 需要备份内容做容器内校验）。
 *
 * remote.ts 没有导出“读取任意路径”的原语，且 RemoteResult.stdout 已脱敏，
 * 无法用于 sha/validate。这里按 remote.ts 同样的 argv 约定做一次原始读取；
 * 内容只在内存里使用，不写日志。整体 try/catch：本函数保证不抛异常。
 */
function readRemotePathRaw(
  registry: EdgeRegistry,
  remotePath: string,
  options: RemoteOptions,
): RawRemoteRead {
  try {
    const ssh = sshCommand(registry, options.env);
    const script = `cat -- ${shellQuote(remotePath)}`;
    const runner = options.runner ?? defaultCommandRunner;
    // 只有真正 spawn 时才准备目录；注入 runner 时不做 FS 操作。
    if (!options.runner) prepareSshControlDir(ssh);
    const proc = runner({
      command: ssh[0]!,
      args: [...ssh.slice(1), script],
      timeoutMs: options.timeoutMs ?? 30_000,
      env: options.env,
    });
    const stdout = proc.stdout ?? "";
    const stderr = [proc.stderr ?? "", proc.error ? proc.error.message : ""]
      .filter((value) => value.length > 0)
      .join("\n");
    const ok = proc.status === 0 && !proc.error;
    return {
      ok,
      content: ok ? stdout : "",
      sha: sha256Hex(stdout),
      detail: redactText(proc.error?.message || stderr || "无输出", options.secrets),
    };
  } catch (caught) {
    return {
      ok: false,
      content: "",
      sha: sha256Hex(""),
      detail: redactText(errorText(caught), options.secrets),
    };
  }
}

const SAFE_JOB_ID_RE = /^[A-Za-z0-9._-]+$/;

/** 未显式提供 jobId 时生成一个安全候选名。 */
function fallbackJobId(prefix: string): string {
  const value = `${prefix}-${Date.now()}`;
  return SAFE_JOB_ID_RE.test(value) ? value : `${prefix}-${process.pid}`;
}

/**
 * native apply：候选校验 → 备份（并校验备份）→ 写前再核对漂移 → 原地写
 * → 回读校验 → live validate → reload。
 *
 * 返回而不是抛异常，便于 D2b 的状态机直接映射；除非输入本身不可解析，
 * 否则不会把远端内容/密钥带进消息。
 */
export async function applyNative(input: NativeApplyInput): Promise<NativeApplyResult> {
  const secrets = input.secrets;
  const ctx: RemoteContext = {
    registry: input.registry,
    secrets,
    runner: input.runner,
    env: input.env,
    timeoutMs: input.timeoutMs,
    log: makeLog(input.log, secrets),
  };
  const opts = remoteOptions(ctx);

  /**
   * 一次 apply 内复用最近一次读取的 content/sha，减少整份 Caddyfile 的重复
   * 远端读取；`fresh=true` 强制重新读取。备份/写入等可能改动远端的操作之后
   * 必须传 fresh=true，否则会把过期 sha 当成写前校验结果。
   */
  let current: { content: string; sha: string } | null = null;
  const currentSha = (fresh = false): string | null => {
    try {
      if (fresh || current === null) {
        const read = readRemoteFile(input.registry, opts);
        current = { content: read.content, sha: read.sha };
      }
      return current.sha;
    } catch {
      return null;
    }
  };

  // 候选注册表用 candidateBytes 重新解析，确保渲染输入与计划字节一致。
  let candidate: EdgeRegistry;
  try {
    candidate = parseRegistryText(
      input.candidateBytes,
      input.registryPath || input.registry.source,
    );
  } catch (error) {
    return makeResult(
      "failed",
      secrets,
      "candidate-invalid",
      `候选注册表无法解析：${errorText(error)}`,
      null,
      null,
    );
  }

  // 1. 读远端原文与 sha；与计划指纹不一致则中止，不写。
  let remote;
  try {
    remote = readRemoteFile(input.registry, opts);
  } catch (error) {
    return makeResult(
      "failed",
      secrets,
      "remote-read-failed",
      `读取远端 Caddyfile 失败：${errorText(error)}`,
      null,
      null,
    );
  }
  // 首次读取作为缓存基线：候选校验后的第一次 recheck 直接复用。
  current = { content: remote.content, sha: remote.sha };
  if (remote.sha !== input.remoteRawSha) {
    ctx.log("远端 Caddyfile 在计划生成后发生变化，中止写回。");
    return makeResult(
      "failed",
      secrets,
      "remote-changed",
      "远端 Caddyfile 在计划生成后已被修改，请重新生成计划。",
      remote.sha,
      null,
    );
  }

  // 2. 用候选注册表 + 当前 secrets 重新渲染，并 splice 到远端原文。
  let expected: string;
  try {
    const block = renderVpsBlock(candidate, secrets);
    expected = spliceManaged(remote.content, block);
  } catch (error) {
    return makeResult(
      "failed",
      secrets,
      "render-failed",
      `渲染候选 Caddyfile 失败：${errorText(error)}`,
      remote.sha,
      null,
    );
  }
  const expectedSha = sha256Hex(expected);
  if (expectedSha !== input.expectedRemoteSha) {
    return makeResult(
      "failed",
      secrets,
      "stale-plan",
      "候选内容与计划期望不一致（expectedRemoteSha 不匹配），请重新生成计划。",
      remote.sha,
      null,
    );
  }
  ctx.log(`候选内容校验通过（sha ${expectedSha.slice(0, 12)}）。`);

  // 3. 先校验候选，后动真文件；失败时远端文件完全不动。
  let candidateCheck;
  try {
    candidateCheck = caddyValidateCandidate(
      input.registry,
      expected,
      input.jobId,
      opts,
    );
  } catch (error) {
    return makeResult(
      "failed",
      secrets,
      "candidate-validate-error",
      `候选 Caddyfile 校验未能执行：${errorText(error)}`,
      remote.sha,
      null,
    );
  }
  if (!candidateCheck.result.ok) {
    return makeResult(
      "failed",
      secrets,
      "candidate-invalid",
      `${describeRemote("候选 Caddyfile 校验", candidateCheck.result, secrets)}；远端文件未改动。`,
      remote.sha,
      null,
    );
  }
  ctx.log("容器内候选校验通过。");

  /**
   * 漂移检查：远端必须仍是原始内容（remote.sha）或已经是目标内容
   * （expectedSha）。`fresh=false` 时复用缓存读数（候选校验后这一次不再
   * 重新读取）；真正写前的检查必须传 fresh=true，防止用过期 sha 覆盖
   * 期间的外部修改。
   */
  const recheck = (
    phase: string,
    backup: string | null,
    fresh = false,
  ): { sha: string | null; result?: NativeApplyResult } => {
    const sha = currentSha(fresh);
    if (sha === null) {
      return {
        sha,
        result: makeResult(
          "unknown",
          secrets,
          "remote-recheck-failed",
          `在${phase}前重新读取远端 Caddyfile 失败；未写入。`,
          null,
          backup,
        ),
      };
    }
    if (sha === expectedSha || sha === remote.sha) return { sha };
    ctx.log(`远端 Caddyfile 在${phase}期间被修改，中止写回。`);
    return {
      sha,
      result: makeResult(
        "failed",
        secrets,
        "remote-changed-during-apply",
        `远端 Caddyfile 在${phase}期间被修改，已中止写回；请重新生成计划。`,
        sha,
        backup,
      ),
    };
  };

  // 4. 候选校验后检查一次（复用初始缓存读数），避免对已达标内容重复备份。
  //    真正的漂移防护在备份后的 fresh 检查。
  const beforeBackup = recheck("候选校验", null);
  if (beforeBackup.result) return beforeBackup.result;

  let skippedWrite = false;
  let backupPath: string | null = null;

  if (beforeBackup.sha === expectedSha) {
    skippedWrite = true;
    ctx.log("远端已等于目标内容，跳过备份与写入。");
  } else {
    // 5. 备份远端，并立即读回确认备份内容等于原始远端。
    let backup;
    try {
      backup = backupRemoteFile(input.registry, {
        ...opts,
        ...(input.backupSuffix === undefined ? {} : { suffix: input.backupSuffix }),
      });
    } catch (error) {
      return makeResult(
        "failed",
        secrets,
        "backup-failed",
        `备份远端 Caddyfile 失败：${errorText(error)}；远端文件未改动。`,
        remote.sha,
        null,
      );
    }
    if (!backup.backup || !backup.result.ok) {
      return makeResult(
        "failed",
        secrets,
        "backup-failed",
        `${describeRemote("备份远端 Caddyfile", backup.result, secrets)}；远端文件未改动。`,
        remote.sha,
        null,
      );
    }
    backupPath = backup.backup;
    ctx.log(`已备份远端 Caddyfile 到 ${backupPath}。`);

    const backupRead = readRemotePathRaw(input.registry, backupPath, opts);
    if (!backupRead.ok) {
      return makeResult(
        "failed",
        secrets,
        "backup-verify-failed",
        `备份后读取备份文件失败：${backupRead.detail}；远端文件未改动。`,
        remote.sha,
        backupPath,
      );
    }
    if (backupRead.sha !== remote.sha) {
      return makeResult(
        "failed",
        secrets,
        "backup-sha-mismatch",
        "备份内容 sha 与原始远端不一致（可能备份期间被修改）；远端文件未改动。",
        null,
        backupPath,
      );
    }
    ctx.log(`备份内容 sha 校验通过（sha ${backupRead.sha.slice(0, 12)}）。`);

    // 6. 备份后、写入前紧邻再读一次远端 sha（覆盖备份期间的外部修改）。
    //    这里必须 fresh：缓存的 sha 可能早于备份，不能作为写前漂移检查。
    const beforeWrite = recheck("备份", backupPath, true);
    if (beforeWrite.result) return beforeWrite.result;
    if (beforeWrite.sha === expectedSha) {
      skippedWrite = true;
      ctx.log("远端在备份后已等于目标内容，跳过写入。");
    }
  }

  const recoverFromBackup = (
    code: string,
    detail: string,
  ): NativeApplyResult => {
    if (!backupPath) {
      return makeResult(
        "unknown",
        secrets,
        code,
        `${detail}；没有可用备份，远端内容状态未知，请人工检查。`,
        currentSha(true),
        null,
      );
    }
    ctx.log(`${detail}，尝试用备份恢复。`);
    let restoreResult: RemoteResult | null = null;
    try {
      restoreResult = restoreRemoteFile(input.registry, backupPath, opts);
    } catch (error) {
      restoreResult = null;
      ctx.log(`备份恢复命令执行失败：${errorText(error)}`);
    }
    const afterSha = currentSha(true);
    if (restoreResult?.ok && afterSha === remote.sha) {
      return makeResult(
        "restored",
        secrets,
        `${code}-restored`,
        `${detail}，已用备份恢复远端 Caddyfile（未 reload）。`,
        afterSha,
        backupPath,
      );
    }
    return makeResult(
      "unknown",
      secrets,
      `${code}-restore-failed`,
      `${detail}，且备份恢复未通过校验；请人工检查远端 Caddyfile。（备份：${backupPath}）`,
      afterSha,
      backupPath,
    );
  };

  // 7. 原地写；写命令报错时先回读，决定是否真的写入成功。
  if (!skippedWrite) {
    let write: RemoteResult | null = null;
    let writeThrew: string | null = null;
    try {
      write = writeRemoteFileInPlace(input.registry, expected, opts);
    } catch (error) {
      writeThrew = errorText(error);
    }

    if (!write || !write.ok) {
      // 阻塞 1：写命令失败不等于没写进去。回读 sha 判定真实状态（必须 fresh）。
      const afterFailedWrite = currentSha(true);
      if (afterFailedWrite === expectedSha) {
        ctx.log("写入命令报告失败，但回读内容已等于期望，视为写入成功继续。");
      } else {
        const detail = write
          ? describeRemote("写入远端 Caddyfile", write, secrets)
          : `写入远端 Caddyfile 出错：${writeThrew}`;
        return recoverFromBackup("write-failed", detail);
      }
    } else {
      const verifySha = currentSha(true);
      if (verifySha === null) {
        return makeResult(
          "unknown",
          secrets,
          "verify-read-failed",
          `写入后读取远端 Caddyfile 失败；请用备份 ${backupPath} 校验/恢复。`,
          null,
          backupPath,
        );
      }
      if (verifySha !== expectedSha) {
        return recoverFromBackup("write-verify-failed", "写入后内容校验失败");
      }
      ctx.log("写入后 sha 校验通过。");
    }
  }

  // 8. live 复核 → reload。reload 失败不回滚文件。
  let live: RemoteResult;
  try {
    live = caddyValidateLive(input.registry, opts);
  } catch (error) {
    return makeResult(
      "writtenNotActive",
      secrets,
      skippedWrite ? "already-applied-live-error" : "live-validate-error",
      `文件已是目标内容，但 live 校验未能执行：${errorText(error)}；` +
        "运行配置未更新，可调用 reloadOnly 重试。",
      expectedSha,
      backupPath,
    );
  }
  if (!live.ok) {
    return makeResult(
      "writtenNotActive",
      secrets,
      skippedWrite ? "already-applied-live-invalid" : "live-invalid",
      `文件已是目标内容，但 ${describeRemote("live 校验", live, secrets)}；` +
        "运行配置未更新，请检查后调用 reloadOnly 重试。",
      expectedSha,
      backupPath,
    );
  }

  let reload: RemoteResult;
  try {
    reload = caddyReload(input.registry, opts);
  } catch (error) {
    return makeResult(
      "writtenNotActive",
      secrets,
      skippedWrite ? "already-applied-reload-error" : "reload-error",
      `文件已是目标内容，但 reload 出错：${errorText(error)}；` +
        "运行配置未更新，可调用 reloadOnly 重试或 force reload。",
      expectedSha,
      backupPath,
    );
  }
  if (!reload.ok) {
    return makeResult(
      "writtenNotActive",
      secrets,
      skippedWrite ? "already-applied-reload-failed" : "reload-failed",
      `文件已是目标内容，但 ${describeRemote("caddy reload", reload, secrets)}；` +
        "运行配置未更新，可调用 reloadOnly 重试或 force reload。",
      expectedSha,
      backupPath,
    );
  }

  ctx.log("Caddy 已 reload。");
  return makeResult(
    "success",
    secrets,
    skippedWrite ? "already-applied" : "ok",
    skippedWrite
      ? "远端 Caddyfile 已是目标内容（未写入），已 reload。"
      : "已应用并 reload 远端 Caddyfile。",
    expectedSha,
    backupPath,
  );
}

/**
 * 仅重新校验 live 并 reload（writtenNotActive 的 retry 路径）。
 *
 * 先做一次 live validate；reload 失败时最多再重试 1 次（共 2 次）。不修改
 * 任何文件。提供 expectedSha 时，reload 前先读远端 sha，不一致直接拒绝，
 * 避免把非目标内容激活。
 */
export async function reloadOnly(input: NativeReloadInput): Promise<NativeApplyResult> {
  const ctx: RemoteContext = {
    registry: input.registry,
    secrets: input.secrets,
    runner: input.runner,
    env: input.env,
    timeoutMs: input.timeoutMs,
    log: makeLog(input.log, input.secrets),
  };
  const opts = remoteOptions(ctx);

  let current: string | null = null;
  if (input.expectedSha !== undefined) {
    try {
      current = readRemoteFile(input.registry, opts).sha;
    } catch (error) {
      return makeResult(
        "failed",
        input.secrets,
        "remote-read-failed",
        `读取远端 Caddyfile 失败，未 reload：${errorText(error)}`,
        null,
        null,
      );
    }
    if (current !== input.expectedSha) {
      return makeResult(
        "failed",
        input.secrets,
        "remote-changed",
        "远端 Caddyfile sha 与 expectedSha 不一致，已拒绝 reload。",
        current,
        null,
      );
    }
  }

  let live: RemoteResult;
  try {
    live = caddyValidateLive(input.registry, opts);
  } catch (error) {
    return makeResult(
      "failed",
      input.secrets,
      "live-validate-error",
      `live 校验未能执行，未 reload：${errorText(error)}`,
      current,
      null,
    );
  }
  if (!live.ok) {
    return makeResult(
      "failed",
      input.secrets,
      "live-invalid",
      `${describeRemote("live 校验", live, input.secrets)}；未执行 reload。`,
      current,
      null,
    );
  }

  let last: RemoteResult | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      last = caddyReload(input.registry, opts);
    } catch (error) {
      last = null;
      ctx.log(`reload 第 ${attempt} 次执行出错：${errorText(error)}`);
      continue;
    }
    if (last.ok) {
      ctx.log(`reload 成功（第 ${attempt} 次尝试）。`);
      return makeResult(
        "success",
        input.secrets,
        "ok",
        `Caddy reload 成功（第 ${attempt} 次尝试）。`,
        input.expectedSha ?? current,
        null,
      );
    }
    ctx.log(
      `reload 第 ${attempt} 次失败：${describeRemote("caddy reload", last, input.secrets)}`,
    );
  }

  return makeResult(
    "writtenNotActive",
    input.secrets,
    "reload-failed",
    last
      ? `${describeRemote("caddy reload", last, input.secrets)}（已重试 1 次）；运行配置未更新。`
      : "caddy reload 执行出错（已重试 1 次）；运行配置未更新。",
    input.expectedSha ?? current,
    null,
  );
}

/**
 * 从备份恢复：读备份内容 → 容器内 validate → 通过才原地写回 → reload。
 *
 * - 必须显式 confirm:true；
 * - 备份路径必须是本工具生成的 `<caddyfile>.bak.<safe>`；
 * - backupSha 应等于计划 remoteRawSha（备份即写入前的远端原文）；
 * - validate 失败时真文件完全不动；
 * - 写回使用已校验的备份内容（不重新从远端读备份，消除 TOCTOU）；
 * - 写回后重读 sha 校验；写回/reload 失败返回 unknown/writtenNotActive。
 */
export async function restoreBackup(
  input: RestoreBackupInput,
): Promise<NativeApplyResult> {
  const secrets = input.secrets;
  const ctx: RemoteContext = {
    registry: input.registry,
    secrets,
    runner: input.runner,
    env: input.env,
    timeoutMs: input.timeoutMs,
    log: makeLog(input.log, secrets),
  };
  const opts = remoteOptions(ctx);

  const currentSha = (): string | null => {
    try {
      return readRemoteFile(input.registry, opts).sha;
    } catch {
      return null;
    }
  };

  if (input.confirm !== true) {
    return makeResult(
      "failed",
      secrets,
      "confirm-required",
      "恢复备份需要显式确认（confirm: true）；未改动远端文件。",
      null,
      input.backup,
    );
  }

  let safeBackup: string;
  try {
    safeBackup = assertRemoteBackupPath(input.registry, input.backup);
  } catch (error) {
    return makeResult(
      "failed",
      secrets,
      "invalid-backup",
      `备份路径不合法：${errorText(error)}；未改动远端文件。`,
      null,
      null,
    );
  }

  const raw = readRemotePathRaw(input.registry, safeBackup, opts);
  if (!raw.ok) {
    // readRemotePathRaw 的 detail 已脱敏，且函数本身不抛异常。
    return makeResult(
      "failed",
      secrets,
      "backup-read-failed",
      `读取备份 ${safeBackup} 失败：${raw.detail}；未改动远端文件。`,
      null,
      safeBackup,
    );
  }
  if (input.backupSha !== raw.sha) {
    return makeResult(
      "failed",
      secrets,
      "backup-sha-mismatch",
      "备份内容 sha 与调用方提供的值不一致；未改动远端文件。",
      null,
      safeBackup,
    );
  }

  // 容器内校验备份内容，通过后才允许写回。
  const jobId = input.jobId ?? fallbackJobId("restore");
  let check;
  try {
    check = caddyValidateCandidate(input.registry, raw.content, jobId, opts);
  } catch (error) {
    return makeResult(
      "failed",
      secrets,
      "backup-validate-error",
      `备份内容校验未能执行：${errorText(error)}；未改动远端文件。`,
      null,
      safeBackup,
    );
  }
  if (!check.result.ok) {
    return makeResult(
      "failed",
      secrets,
      "backup-invalid",
      `${describeRemote("备份 Caddyfile 校验", check.result, secrets)}；未改动远端文件。`,
      null,
      safeBackup,
    );
  }

  // 写回已校验的内容（不重新读远端备份文件）。
  let write: RemoteResult | null = null;
  let writeThrew: string | null = null;
  try {
    write = writeRemoteFileInPlace(input.registry, raw.content, opts);
  } catch (error) {
    writeThrew = errorText(error);
  }
  if (!write || !write.ok) {
    const writtenSha = currentSha();
    if (writtenSha === raw.sha) {
      ctx.log("写回命令报告失败，但回读内容已等于备份，视为写入成功继续。");
    } else {
      return makeResult(
        "unknown",
        secrets,
        "restore-write-failed",
        write
          ? `${describeRemote("写回备份", write, secrets)}；远端内容可能不完整，请人工检查。`
          : `写回备份时出错：${writeThrew}；远端内容状态未知，请人工检查。`,
        writtenSha,
        safeBackup,
      );
    }
  }

  let after;
  try {
    after = readRemoteFile(input.registry, opts);
  } catch (error) {
    return makeResult(
      "unknown",
      secrets,
      "restore-verify-read-failed",
      `写回备份后读取远端 Caddyfile 失败：${errorText(error)}；请人工检查。`,
      null,
      safeBackup,
    );
  }
  if (after.sha !== raw.sha) {
    return makeResult(
      "unknown",
      secrets,
      "restore-verify-failed",
      "写回备份后内容 sha 校验失败；请人工检查远端 Caddyfile。",
      after.sha,
      safeBackup,
    );
  }
  ctx.log(`备份已写回并通过 sha 校验（sha ${raw.sha.slice(0, 12)}）。`);

  let reload: RemoteResult;
  try {
    reload = caddyReload(input.registry, opts);
  } catch (error) {
    return makeResult(
      "writtenNotActive",
      secrets,
      "reload-error",
      `备份已写回，但 reload 出错：${errorText(error)}；运行配置未更新。`,
      raw.sha,
      safeBackup,
    );
  }
  if (!reload.ok) {
    return makeResult(
      "writtenNotActive",
      secrets,
      "reload-failed",
      `备份已写回，但 ${describeRemote("caddy reload", reload, secrets)}；运行配置未更新。`,
      raw.sha,
      safeBackup,
    );
  }

  return makeResult(
    "restored",
    secrets,
    "ok",
    "已从备份恢复 Caddyfile 并 reload。",
    raw.sha,
    safeBackup,
  );
}

/**
 * 用受控备份恢复“未知”远端内容的别名（协议命名）。
 * 等价于 restoreBackup，必须提供 confirm:true 与 backupSha。
 */
export function restoreUnknownFromBackup(
  input: RestoreBackupInput,
): Promise<NativeApplyResult> {
  return restoreBackup(input);
}

/**
 * 用上层保存的当前（unknown）内容恢复：validate → 原地写 → 重读校验 → reload。
 *
 * 用于 writtenNotActive 之后 reload 仍失败、需要回到保存内容的场景。二次
 * 失败不再自动重试：写入失败/校验失败返回 unknown，reload 失败返回
 * writtenNotActive（文件已是保存内容、运行配置未更新）。
 */
export async function restoreCurrentUnknown(
  input: RestoreCurrentInput,
): Promise<NativeApplyResult> {
  const secrets = input.secrets;
  const ctx: RemoteContext = {
    registry: input.registry,
    secrets,
    runner: input.runner,
    env: input.env,
    timeoutMs: input.timeoutMs,
    log: makeLog(input.log, secrets),
  };
  const opts = remoteOptions(ctx);

  const currentSha = (): string | null => {
    try {
      return readRemoteFile(input.registry, opts).sha;
    } catch {
      return null;
    }
  };

  if (input.confirm !== true) {
    return makeResult(
      "failed",
      secrets,
      "confirm-required",
      "恢复远端内容需要显式确认（confirm: true）；未改动远端文件。",
      null,
      null,
    );
  }

  const contentSha = sha256Hex(input.content);
  if (input.contentSha !== undefined && input.contentSha !== contentSha) {
    return makeResult(
      "failed",
      secrets,
      "content-sha-mismatch",
      "保存的内容 sha 与调用方提供的值不一致；未改动远端文件。",
      null,
      null,
    );
  }

  const jobId = input.jobId ?? fallbackJobId("restore");
  let check;
  try {
    check = caddyValidateCandidate(input.registry, input.content, jobId, opts);
  } catch (error) {
    return makeResult(
      "failed",
      secrets,
      "content-validate-error",
      `保存内容校验未能执行：${errorText(error)}；未改动远端文件。`,
      null,
      null,
    );
  }
  if (!check.result.ok) {
    return makeResult(
      "failed",
      secrets,
      "content-invalid",
      `${describeRemote("保存内容校验", check.result, secrets)}；未改动远端文件。`,
      null,
      null,
    );
  }

  let write: RemoteResult | null = null;
  let writeThrew: string | null = null;
  try {
    write = writeRemoteFileInPlace(input.registry, input.content, opts);
  } catch (error) {
    writeThrew = errorText(error);
  }
  if (!write || !write.ok) {
    const writtenSha = currentSha();
    if (writtenSha === contentSha) {
      ctx.log("恢复写入命令报告失败，但回读内容已等于期望，视为写入成功继续。");
    } else {
      return makeResult(
        "unknown",
        secrets,
        "restore-write-failed",
        write
          ? `${describeRemote("恢复写入", write, secrets)}；远端内容可能不完整，请人工检查。`
          : `恢复写入时出错：${writeThrew}；远端内容状态未知，请人工检查。`,
        writtenSha,
        null,
      );
    }
  }

  let after;
  try {
    after = readRemoteFile(input.registry, opts);
  } catch (error) {
    return makeResult(
      "unknown",
      secrets,
      "restore-verify-read-failed",
      `恢复写入后读取远端 Caddyfile 失败：${errorText(error)}；请人工检查。`,
      null,
      null,
    );
  }
  if (after.sha !== contentSha) {
    return makeResult(
      "unknown",
      secrets,
      "restore-verify-failed",
      "恢复写入后内容 sha 校验失败；请人工检查远端 Caddyfile。",
      after.sha,
      null,
    );
  }
  ctx.log(`保存内容已写回并通过 sha 校验（sha ${contentSha.slice(0, 12)}）。`);

  let reload: RemoteResult;
  try {
    reload = caddyReload(input.registry, opts);
  } catch (error) {
    return makeResult(
      "writtenNotActive",
      secrets,
      "restore-reload-error",
      `已写回保存内容，但 reload 出错：${errorText(error)}；运行配置未更新。`,
      contentSha,
      null,
    );
  }
  if (!reload.ok) {
    return makeResult(
      "writtenNotActive",
      secrets,
      "restore-reload-failed",
      `已写回保存内容，但 ${describeRemote("caddy reload", reload, secrets)}；` +
        "运行配置未更新，请人工执行 reload。",
      contentSha,
      null,
    );
  }

  return makeResult(
    "restored",
    secrets,
    "ok",
    "已用保存的远端内容恢复并 reload。",
    contentSha,
    null,
  );
}
