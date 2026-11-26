import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "./canonical.js";
import type { CommandResult, CommandRunner, CommandSpec } from "./cli.js";
import {
  applyNative,
  reloadOnly,
  restoreBackup,
  restoreCurrentUnknown,
  restoreUnknownFromBackup,
  type NativeApplyInput,
} from "./native-apply.js";
import { parseRegistryText } from "./registry.js";
import { renderVpsBlock, spliceManaged } from "./render.js";
import type { EdgeRegistry, EdgeSecrets } from "./types.js";

const HASH = "$2a$14$FakeSaltValue123456789FakeHashValue1234567890ABCDEFGH";
const COOKIE = "fedcba9876543210fedcba9876543210";

const REGISTRY_TEXT = [
  "version: 1",
  "edge:",
  "  vps:",
  "    ssh: ubuntu@203.0.113.10",
  "    caddy_container: example-caddy",
  "    caddyfile: /opt/example/Caddyfile",
  "    caddyfile_container: /etc/caddy/Caddyfile",
  "sites:",
  "  - name: qubius",
  "    domains: [qubius.example.com]",
  "    env: dev",
  "    upstream: http://127.0.0.1:8789",
  "    auth: dev",
  "    sse: true",
  "",
].join("\n");

const REGISTRY: EdgeRegistry = parseRegistryText(REGISTRY_TEXT, "/tmp/edgectl.yaml");
const SECRETS: EdgeSecrets = {
  passwordHash: HASH,
  cookieSecret: COOKIE,
  secretsSha: sha256Hex(`${HASH}:${COOKIE}`),
  passwordHashSource: "envfile",
  cookieSecretSource: "envfile",
};

const REMOTE = [
  "# existing Caddyfile",
  "",
  "legacy.example.com {",
  '\trespond "ok"',
  "}",
  "",
].join("\n");

const EXPECTED = spliceManaged(REMOTE, renderVpsBlock(REGISTRY, SECRETS));
const EXPECTED_SHA = sha256Hex(EXPECTED);
const REMOTE_SHA = sha256Hex(REMOTE);
const BACKUP = `${REGISTRY.vps.caddyfile}.bak.2026-01-02T03-04-05`;

interface Sim {
  content: string;
  backupContent: string;
  /** 从备份恢复时实际写入的内容；默认等于 backupContent。 */
  restoreContent?: string;
  calls: CommandSpec[];
  writes: string[];
  reloadAttempts: number;
  /** 远端 live 读取失败。 */
  failRead?: boolean;
  readStderr?: string;
  /** 目录可写探测失败（触发 /tmp 回退，不影响断言）。 */
  failProbe?: boolean;
  failCandidateValidate?: boolean;
  candidateStderr?: string;
  candidateTimeout?: boolean;
  /** 候选校验期间远端被外部修改。 */
  mutateDuringCandidate?: string;
  failBackup?: boolean;
  /** 备份期间远端被外部修改（备份内容仍是原始值）。 */
  mutateDuringBackup?: string;
  /** 读取备份文件失败。 */
  failReadBackup?: boolean;
  failWrite?: boolean;
  /** 写入命令超时，但内容实际已写入。 */
  writeTimeout?: boolean;
  /** 写入命令非 0 退出，但内容实际已写入。 */
  writeFailButApplied?: boolean;
  corruptWrite?: boolean;
  failLive?: boolean;
  liveTimeout?: boolean;
  /** 前 N 次 reload 失败。 */
  failReloads?: number;
}

function ok(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "", signal: null };
}

function fail(stderr = ""): CommandResult {
  return { status: 1, stdout: "", stderr, signal: null };
}

function timedOut(): CommandResult {
  return { status: null, stdout: "", stderr: "", signal: "SIGTERM" };
}

function makeSim(overrides: Partial<Sim> = {}): Sim {
  return {
    content: REMOTE,
    backupContent: REMOTE,
    calls: [],
    writes: [],
    reloadAttempts: 0,
    ...overrides,
  };
}

function scriptOf(spec: CommandSpec): string {
  return spec.args[spec.args.length - 1] ?? "";
}

function makeRunner(sim: Sim): CommandRunner {
  return (spec) => {
    sim.calls.push(spec);
    const script = scriptOf(spec);
    const input = spec.input;

    // 远端文件读取（live 或 backup）。
    if (script.startsWith("cat -- ")) {
      if (script.includes(".bak.")) {
        return sim.failReadBackup ? fail("cannot read backup") : ok(sim.backupContent);
      }
      if (sim.failRead) return fail(sim.readStderr ?? "cannot read remote");
      return ok(sim.content);
    }
    // 容器内目录可写探测。
    if (script.includes("test -d") && script.includes("test -w")) {
      return sim.failProbe ? fail("not writable") : ok("");
    }
    // 容器内候选校验（含 .qubius-candidate- 路径）。
    if (script.includes(".qubius-candidate-")) {
      if (sim.candidateTimeout) return timedOut();
      if (sim.failCandidateValidate) return fail(sim.candidateStderr ?? "invalid candidate");
      if (sim.mutateDuringCandidate !== undefined) sim.content = sim.mutateDuringCandidate;
      return ok("");
    }
    // live 校验。
    if (script.includes("caddy validate --config")) {
      if (sim.liveTimeout) return timedOut();
      return sim.failLive ? fail("invalid live config") : ok("");
    }
    // reload。
    if (script.includes("caddy reload")) {
      sim.reloadAttempts += 1;
      if (sim.reloadAttempts <= (sim.failReloads ?? 0)) return fail("reload failed");
      return ok("");
    }
    // 从备份写回：umask 077; cat -- '<backup>' > '<caddyfile>'
    if (script.startsWith("umask 077; cat -- ")) {
      sim.content = sim.restoreContent ?? sim.backupContent;
      return ok("");
    }
    // 备份：cp -a -- <src> <dst>
    if (script.startsWith("cp -a -- ")) {
      if (sim.failBackup) return fail("backup failed");
      if (sim.mutateDuringBackup !== undefined) sim.content = sim.mutateDuringBackup;
      return ok("");
    }
    // 原地写：umask 077; cat > '<caddyfile>'（内容走 stdin）。
    if (script.startsWith("umask 077; cat > ")) {
      const written = input ?? "";
      if (sim.writeTimeout) {
        sim.content = written;
        sim.writes.push(written);
        return timedOut();
      }
      if (sim.failWrite) {
        if (sim.writeFailButApplied) {
          sim.content = written;
          sim.writes.push(written);
        }
        return fail("write failed");
      }
      sim.content = sim.corruptWrite ? `${written}corrupt\n` : written;
      sim.writes.push(written);
      return ok("");
    }
    throw new Error(`unexpected remote script: ${script}`);
  };
}

interface Harness {
  sim: Sim;
  logs: string[];
  input: NativeApplyInput;
}

function harness(
  simOverrides: Partial<Sim> = {},
  inputOverrides: Partial<NativeApplyInput> = {},
): Harness {
  const sim = makeSim(simOverrides);
  const logs: string[] = [];
  const input: NativeApplyInput = {
    registryPath: "/tmp/edgectl.yaml",
    registry: REGISTRY,
    candidateBytes: REGISTRY_TEXT,
    secrets: SECRETS,
    remoteRawSha: sha256Hex(sim.content),
    expectedRemoteSha: EXPECTED_SHA,
    jobId: "job-1",
    log: (text) => logs.push(text),
    runner: makeRunner(sim),
    backupSuffix: "2026-01-02T03-04-05",
    ...inputOverrides,
  };
  return { sim, logs, input };
}

function scripts(sim: Sim): string[] {
  return sim.calls.map(scriptOf);
}

function hasScript(sim: Sim, prefix: string): boolean {
  return scripts(sim).some((script) => script.startsWith(prefix));
}

test("applyNative 正常成功：候选校验→备份+校验→写前复核→写→重读 sha→reload", async () => {
  const h = harness();
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "success");
  assert.equal(result.code, "ok");
  assert.equal(result.remoteSha, EXPECTED_SHA);
  assert.equal(result.backupPath, BACKUP);
  assert.equal(h.sim.content, EXPECTED);
  assert.deepEqual(h.sim.writes, [EXPECTED]);
  assert.equal(h.sim.reloadAttempts, 1);

  const all = scripts(h.sim);
  // 1 初始读 / 2 probe / 3 候选校验 / （备份前复核复用初始读）/ 4 备份 /
  // 5 备份回读校验 / 6 写前复核（必须重新读）/ 7 写 / 8 写后读 / 9 live / 10 reload
  assert.equal(all.length, 10);
  assert.ok(all[0]!.startsWith("cat -- "));
  assert.ok(all[1]!.includes("test -w"));
  assert.ok(all[2]!.includes(".qubius-candidate-"));
  assert.ok(all[3]!.startsWith("cp -a -- "));
  assert.ok(all[4]!.startsWith("cat -- "));
  assert.ok(all[4]!.includes(".bak."));
  assert.ok(all[5]!.startsWith("cat -- "));
  assert.ok(all[6]!.startsWith("umask 077; cat > "));
  assert.ok(all[7]!.startsWith("cat -- "));
  assert.ok(all[8]!.includes("caddy validate --config"));
  assert.ok(all[9]!.includes("caddy reload"));

  const candidateCall = h.sim.calls[2]!;
  assert.equal(candidateCall.input, EXPECTED);
  assert.ok(scriptOf(candidateCall).includes("/.qubius-candidate-job-1"));
  assert.equal(h.sim.calls[6]!.input, EXPECTED);

  assert.ok(h.logs.some((line) => line.includes("候选内容校验通过")));
  assert.ok(h.logs.some((line) => line.includes("备份内容 sha 校验通过")));
  assert.ok(h.logs.some((line) => line.includes("Caddy 已 reload")));
});

test("applyNative 候选 validate 失败时真文件完全不动", async () => {
  const h = harness({ failCandidateValidate: true });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "candidate-invalid");
  assert.equal(h.sim.content, REMOTE);
  assert.equal(h.sim.writes.length, 0);
  assert.equal(hasScript(h.sim, "cp -a -- "), false);
  assert.equal(hasScript(h.sim, "umask 077; cat > "), false);
  assert.ok(!scripts(h.sim).some((script) => script.includes("caddy reload")));
});

test("applyNative 候选 validate 超时会带上超时提示", async () => {
  const h = harness({ candidateTimeout: true });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "candidate-invalid");
  assert.ok(result.message.includes("超时"));
  assert.equal(h.sim.writes.length, 0);
});

test("applyNative 目录探测失败回退 /tmp 后仍可成功", async () => {
  const h = harness({ failProbe: true });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "success");
  const candidate = h.sim.calls[2]!;
  assert.ok(scriptOf(candidate).includes("/tmp/.qubius-candidate-job-1"));
});

test("applyNative 远端 sha 在计划后变化：中止且不写", async () => {
  const changed = `${REMOTE}# changed by someone else\n`;
  const h = harness({ content: changed }, { remoteRawSha: REMOTE_SHA });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "remote-changed");
  assert.equal(result.remoteSha, sha256Hex(changed));
  assert.equal(h.sim.content, changed);
  assert.equal(h.sim.writes.length, 0);
  assert.equal(hasScript(h.sim, "cp -a -- "), false);
});

test("applyNative 读远端失败：failed 且不写", async () => {
  const h = harness({ failRead: true });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "remote-read-failed");
  assert.equal(h.sim.writes.length, 0);
});

test("applyNative expectedRemoteSha 不匹配（计划过期）：中止且不写", async () => {
  const h = harness({}, { expectedRemoteSha: sha256Hex("stale") });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "stale-plan");
  assert.equal(h.sim.content, REMOTE);
  assert.equal(h.sim.writes.length, 0);
  assert.equal(hasScript(h.sim, "cp -a -- "), false);
});

test("applyNative 候选校验期间远端被改：写前复核发现漂移，中止且不写", async () => {
  const h = harness({ mutateDuringCandidate: `${REMOTE}# edited during validate\n` });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "remote-changed-during-apply");
  assert.equal(h.sim.content, `${REMOTE}# edited during validate\n`);
  assert.equal(h.sim.writes.length, 0);
  // 备份前复核复用初始读，因此会先备份；真正的写前复核（fresh）拦下写入。
  assert.equal(hasScript(h.sim, "cp -a -- "), true);
  assert.equal(hasScript(h.sim, "umask 077; cat > "), false);
});

test("applyNative 备份期间远端被改：中止且不写（备份已创建）", async () => {
  const h = harness({ mutateDuringBackup: `${REMOTE}# edited during backup\n` });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "remote-changed-during-apply");
  assert.equal(result.backupPath, BACKUP);
  assert.equal(h.sim.writes.length, 0);
  assert.equal(hasScript(h.sim, "cp -a -- "), true);
  assert.equal(hasScript(h.sim, "umask 077; cat > "), false);
});

test("applyNative 备份内容被改动（sha 不符）：failed 且不写", async () => {
  const sim = makeSim({ backupContent: "unexpected backup\n" });
  const logs: string[] = [];
  const result = await applyNative({
    registryPath: "/tmp/edgectl.yaml",
    registry: REGISTRY,
    candidateBytes: REGISTRY_TEXT,
    secrets: SECRETS,
    remoteRawSha: REMOTE_SHA,
    expectedRemoteSha: EXPECTED_SHA,
    jobId: "job-1",
    log: (text) => logs.push(text),
    runner: makeRunner(sim),
    backupSuffix: "2026-01-02T03-04-05",
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "backup-sha-mismatch");
  assert.equal(result.backupPath, BACKUP);
  assert.equal(sim.writes.length, 0);
});

test("applyNative 远端已是目标内容：跳过写入，reload 成功 code=already-applied", async () => {
  const h = harness(
    { content: EXPECTED },
    { remoteRawSha: EXPECTED_SHA },
  );
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "success");
  assert.equal(result.code, "already-applied");
  assert.equal(result.remoteSha, EXPECTED_SHA);
  assert.equal(result.backupPath, null);
  assert.equal(h.sim.writes.length, 0);
  assert.equal(hasScript(h.sim, "cp -a -- "), false);
  assert.equal(h.sim.reloadAttempts, 1);
});

test("applyNative 远端已是目标内容但 reload 失败：writtenNotActive", async () => {
  const h = harness(
    { content: EXPECTED, failReloads: 1 },
    { remoteRawSha: EXPECTED_SHA },
  );
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "writtenNotActive");
  assert.equal(result.code, "already-applied-reload-failed");
  assert.equal(result.remoteSha, EXPECTED_SHA);
  assert.equal(result.backupPath, null);
  assert.equal(h.sim.writes.length, 0);
});

test("applyNative 写后 sha 不符：不 reload，尝试用备份恢复", async () => {
  const h = harness({ corruptWrite: true });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "restored");
  assert.equal(result.code, "write-verify-failed-restored");
  assert.equal(result.remoteSha, REMOTE_SHA);
  assert.equal(result.backupPath, BACKUP);
  assert.equal(h.sim.content, REMOTE);
  assert.equal(hasScript(h.sim, "umask 077; cat -- "), true);
  assert.ok(!scripts(h.sim).some((script) => script.includes("caddy reload")));
});

test("applyNative 写后 sha 不符且恢复未通过校验：unknown", async () => {
  const h = harness({ corruptWrite: true, restoreContent: "different backup\n" });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "unknown");
  assert.equal(result.code, "write-verify-failed-restore-failed");
  assert.equal(h.sim.content, "different backup\n");
  assert.equal(result.backupPath, BACKUP);
  assert.ok(!scripts(h.sim).some((script) => script.includes("caddy reload")));
});

test("applyNative 写命令失败且确未写入：用备份恢复成功 → restored", async () => {
  const h = harness({ failWrite: true });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "restored");
  assert.equal(result.code, "write-failed-restored");
  assert.equal(result.backupPath, BACKUP);
  assert.equal(h.sim.content, REMOTE);
  assert.equal(hasScript(h.sim, "umask 077; cat -- "), true);
  assert.ok(!scripts(h.sim).some((script) => script.includes("caddy reload")));
});

test("applyNative 写命令失败且恢复不通过：unknown", async () => {
  const h = harness({ failWrite: true, restoreContent: "different backup\n" });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "unknown");
  assert.equal(result.code, "write-failed-restore-failed");
  assert.equal(result.backupPath, BACKUP);
  assert.equal(h.sim.content, "different backup\n");
});

test("applyNative 写命令超时但内容已写入：回读等于期望，继续 reload", async () => {
  const h = harness({ writeTimeout: true });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "success");
  assert.equal(result.code, "ok");
  assert.equal(h.sim.content, EXPECTED);
  assert.equal(h.sim.reloadAttempts, 1);
});

test("applyNative 写命令非 0 退出但内容已写入：回读等于期望，继续 reload", async () => {
  const h = harness({ writeFailButApplied: true });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "success");
  assert.equal(result.code, "ok");
  assert.equal(h.sim.content, EXPECTED);
  assert.equal(h.sim.reloadAttempts, 1);
});

test("applyNative 备份失败：failed，不写", async () => {
  const h = harness({ failBackup: true });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "backup-failed");
  assert.equal(h.sim.content, REMOTE);
  assert.equal(h.sim.writes.length, 0);
});

test("applyNative live 校验失败：writtenNotActive，文件已是目标", async () => {
  const h = harness({ failLive: true });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "writtenNotActive");
  assert.equal(result.code, "live-invalid");
  assert.equal(result.remoteSha, EXPECTED_SHA);
  assert.equal(result.backupPath, BACKUP);
  assert.equal(h.sim.content, EXPECTED);
  assert.equal(h.sim.reloadAttempts, 0);
});

test("applyNative reload 失败：writtenNotActive，文件已是目标且不回滚", async () => {
  const h = harness({ failReloads: 1 });
  const result = await applyNative(h.input);

  assert.equal(result.outcome, "writtenNotActive");
  assert.equal(result.code, "reload-failed");
  assert.equal(result.remoteSha, EXPECTED_SHA);
  assert.equal(result.backupPath, BACKUP);
  assert.equal(h.sim.content, EXPECTED);
  assert.equal(h.sim.reloadAttempts, 1);
});

test("reloadOnly：live validate 后 reload，失败重试 1 次成功", async () => {
  const sim = makeSim({ content: EXPECTED, failReloads: 1 });
  const result = await reloadOnly({
    registry: REGISTRY,
    secrets: SECRETS,
    expectedSha: EXPECTED_SHA,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.remoteSha, EXPECTED_SHA);
  assert.equal(sim.reloadAttempts, 2);
  assert.equal(sim.content, EXPECTED);
  assert.equal(hasScript(sim, "umask 077; cat > "), false);
});

test("reloadOnly：expectedSha 不符时拒绝 reload", async () => {
  const sim = makeSim({ content: REMOTE });
  const result = await reloadOnly({
    registry: REGISTRY,
    secrets: SECRETS,
    expectedSha: EXPECTED_SHA,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "remote-changed");
  assert.equal(result.remoteSha, REMOTE_SHA);
  assert.equal(sim.reloadAttempts, 0);
});

test("reloadOnly：expectedSha 读取失败时拒绝 reload", async () => {
  const sim = makeSim({ content: EXPECTED, failRead: true });
  const result = await reloadOnly({
    registry: REGISTRY,
    secrets: SECRETS,
    expectedSha: EXPECTED_SHA,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "remote-read-failed");
  assert.equal(sim.reloadAttempts, 0);
});

test("reloadOnly：连续失败返回 writtenNotActive（共 2 次尝试）", async () => {
  const sim = makeSim({ content: EXPECTED, failReloads: 5 });
  const result = await reloadOnly({
    registry: REGISTRY,
    secrets: SECRETS,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "writtenNotActive");
  assert.equal(result.code, "reload-failed");
  assert.equal(sim.reloadAttempts, 2);
});

test("reloadOnly：live validate 失败时不 reload", async () => {
  const sim = makeSim({ content: EXPECTED, failLive: true });
  const result = await reloadOnly({
    registry: REGISTRY,
    secrets: SECRETS,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "live-invalid");
  assert.equal(sim.reloadAttempts, 0);
});

test("reloadOnly：live validate 超时返回 failed", async () => {
  const sim = makeSim({ content: EXPECTED, liveTimeout: true });
  const result = await reloadOnly({
    registry: REGISTRY,
    secrets: SECRETS,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "live-invalid");
  assert.ok(result.message.includes("超时"));
  assert.equal(sim.reloadAttempts, 0);
});

test("restoreBackup：需要显式 confirm，未确认时不执行任何远端命令", async () => {
  const sim = makeSim();
  const result = await restoreBackup({
    registry: REGISTRY,
    secrets: SECRETS,
    backup: BACKUP,
    backupSha: REMOTE_SHA,
    confirm: false,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "confirm-required");
  assert.equal(sim.calls.length, 0);
});

test("restoreBackup：拒绝非本工具生成的备份路径", async () => {
  const sim = makeSim();
  const result = await restoreBackup({
    registry: REGISTRY,
    secrets: SECRETS,
    backup: "/etc/passwd",
    backupSha: REMOTE_SHA,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "invalid-backup");
  assert.equal(sim.calls.length, 0);
});

test("restoreBackup：读取备份失败时不动真文件", async () => {
  const sim = makeSim({ content: EXPECTED, failReadBackup: true });
  const result = await restoreBackup({
    registry: REGISTRY,
    secrets: SECRETS,
    backup: BACKUP,
    backupSha: REMOTE_SHA,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "backup-read-failed");
  assert.equal(sim.content, EXPECTED);
  assert.equal(sim.writes.length, 0);
});

test("restoreBackup：备份 validate 失败时不动真文件", async () => {
  const sim = makeSim({ content: EXPECTED, backupContent: REMOTE, failCandidateValidate: true });
  const result = await restoreBackup({
    registry: REGISTRY,
    secrets: SECRETS,
    backup: BACKUP,
    backupSha: REMOTE_SHA,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "backup-invalid");
  assert.equal(sim.content, EXPECTED);
  assert.equal(sim.writes.length, 0);
  assert.equal(hasScript(sim, "umask 077; cat -- "), false);
});

test("restoreBackup：校验通过后用已校验内容写回并 reload（不重读备份）", async () => {
  const sim = makeSim({ content: EXPECTED, backupContent: REMOTE });
  const result = await restoreBackup({
    registry: REGISTRY,
    secrets: SECRETS,
    backup: BACKUP,
    backupSha: REMOTE_SHA,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "restored");
  assert.equal(result.code, "ok");
  assert.equal(result.remoteSha, REMOTE_SHA);
  assert.equal(result.backupPath, BACKUP);
  assert.equal(sim.content, REMOTE);
  assert.equal(sim.reloadAttempts, 1);
  // 只读一次备份（校验用）；写回走 writeRemoteFileInPlace，不重读备份。
  const backupReads = scripts(sim).filter(
    (script) => script.startsWith("cat -- ") && script.includes(".bak."),
  );
  assert.equal(backupReads.length, 1);
  assert.equal(hasScript(sim, "umask 077; cat -- "), false);
  assert.equal(hasScript(sim, "umask 077; cat > "), true);
});

test("restoreBackup：备份 sha 不匹配时拒绝写回", async () => {
  const sim = makeSim({ content: EXPECTED, backupContent: REMOTE });
  const result = await restoreBackup({
    registry: REGISTRY,
    secrets: SECRETS,
    backup: BACKUP,
    backupSha: "not-the-real-sha",
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "backup-sha-mismatch");
  assert.equal(sim.content, EXPECTED);
  assert.equal(sim.writes.length, 0);
});

test("restoreBackup：写回命令失败但回读等于备份，继续 reload 成功", async () => {
  const sim = makeSim({ content: EXPECTED, backupContent: REMOTE, writeFailButApplied: true });
  const result = await restoreBackup({
    registry: REGISTRY,
    secrets: SECRETS,
    backup: BACKUP,
    backupSha: REMOTE_SHA,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "restored");
  assert.equal(sim.content, REMOTE);
  assert.equal(sim.reloadAttempts, 1);
});

test("restoreBackup：写回后 reload 失败返回 writtenNotActive（最终态）", async () => {
  const sim = makeSim({ content: EXPECTED, backupContent: REMOTE, failReloads: 5 });
  const result = await restoreBackup({
    registry: REGISTRY,
    secrets: SECRETS,
    backup: BACKUP,
    backupSha: REMOTE_SHA,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "writtenNotActive");
  assert.equal(result.code, "reload-failed");
  assert.equal(sim.content, REMOTE);
  assert.equal(result.remoteSha, REMOTE_SHA);
  assert.equal(result.backupPath, BACKUP);
});

test("restoreBackup 别名 restoreUnknownFromBackup 行为一致", async () => {
  const sim = makeSim({ content: EXPECTED, backupContent: REMOTE });
  const result = await restoreUnknownFromBackup({
    registry: REGISTRY,
    secrets: SECRETS,
    backup: BACKUP,
    backupSha: REMOTE_SHA,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "restored");
});

test("restoreCurrentUnknown：validate 失败不动真文件", async () => {
  const sim = makeSim({ content: EXPECTED, failCandidateValidate: true });
  const result = await restoreCurrentUnknown({
    registry: REGISTRY,
    secrets: SECRETS,
    content: REMOTE,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "content-invalid");
  assert.equal(sim.content, EXPECTED);
  assert.equal(sim.writes.length, 0);
});

test("restoreCurrentUnknown：写回保存内容并 reload", async () => {
  const sim = makeSim({ content: EXPECTED });
  const result = await restoreCurrentUnknown({
    registry: REGISTRY,
    secrets: SECRETS,
    content: REMOTE,
    contentSha: REMOTE_SHA,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "restored");
  assert.equal(result.code, "ok");
  assert.equal(result.remoteSha, REMOTE_SHA);
  assert.equal(sim.content, REMOTE);
  assert.equal(sim.reloadAttempts, 1);
});

test("restoreCurrentUnknown：写命令失败且未写入 → unknown", async () => {
  const sim = makeSim({ content: EXPECTED, failWrite: true });
  const result = await restoreCurrentUnknown({
    registry: REGISTRY,
    secrets: SECRETS,
    content: REMOTE,
    contentSha: REMOTE_SHA,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "unknown");
  assert.equal(result.code, "restore-write-failed");
  assert.equal(sim.content, EXPECTED);
});

test("restoreCurrentUnknown：写命令超时但已写入 → 继续 reload", async () => {
  const sim = makeSim({ content: EXPECTED, writeTimeout: true });
  const result = await restoreCurrentUnknown({
    registry: REGISTRY,
    secrets: SECRETS,
    content: REMOTE,
    contentSha: REMOTE_SHA,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "restored");
  assert.equal(sim.content, REMOTE);
  assert.equal(sim.reloadAttempts, 1);
});

test("restoreCurrentUnknown：reload 再次失败返回 writtenNotActive", async () => {
  const sim = makeSim({ content: EXPECTED, failReloads: 5 });
  const result = await restoreCurrentUnknown({
    registry: REGISTRY,
    secrets: SECRETS,
    content: REMOTE,
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "writtenNotActive");
  assert.equal(result.code, "restore-reload-failed");
  assert.equal(sim.content, REMOTE);
  assert.equal(result.remoteSha, REMOTE_SHA);
});

test("restoreCurrentUnknown：content sha 不匹配时拒绝写回", async () => {
  const sim = makeSim({ content: EXPECTED });
  const result = await restoreCurrentUnknown({
    registry: REGISTRY,
    secrets: SECRETS,
    content: REMOTE,
    contentSha: "wrong",
    confirm: true,
    runner: makeRunner(sim),
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "content-sha-mismatch");
  assert.equal(sim.writes.length, 0);
});

test("日志与返回消息脱敏：不泄露 secrets / URL user:pass", async () => {
  const secretStderr = `bad ${COOKIE} ${HASH} https://user:pw@example.test/x`;
  const h = harness({ failCandidateValidate: true, candidateStderr: secretStderr });
  const result = await applyNative(h.input);

  const blob = [JSON.stringify(result), ...h.logs].join("\n");
  assert.equal(result.outcome, "failed");
  assert.ok(!blob.includes(COOKIE));
  assert.ok(!blob.includes(HASH));
  assert.ok(!blob.includes("user:pw"));
  assert.ok(blob.includes("<redacted>") || blob.includes("***@"));
});
