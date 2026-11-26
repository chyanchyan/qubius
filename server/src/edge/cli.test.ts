import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyVps,
  candidateRegistryPath,
  cliVersion,
  redactText,
  runDryRunCandidate,
  validateConfig,
  withCandidateRegistry,
  type CommandResult,
  type CommandRunner,
  type CommandSpec,
} from "./cli.js";
import { sha256Hex } from "./canonical.js";
import { EdgeError, type EdgePaths, type EdgeSecrets } from "./types.js";

const HASH = "$2a$14$FakeSaltValue123456789FakeHashValue1234567890ABCDEFGH";
const COOKIE = "fedcba9876543210fedcba9876543210";
const SECRETS: EdgeSecrets = {
  passwordHash: HASH,
  cookieSecret: COOKIE,
  secretsSha: "ignored",
  passwordHashSource: "envfile",
  cookieSecretSource: "envfile",
};

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "edge-cli-"));
}

function pathsFor(bin: string, config: string): EdgePaths {
  return {
    provider: "cli",
    resolvedProvider: "cli",
    configPath: config,
    configSource: "envfile-qubius",
    binPath: bin,
    binSource: "env",
    disabled: false,
    errors: [],
  };
}

type Handler = (spec: CommandSpec) => Partial<CommandResult>;

function fakeRunner(handler: Handler): { runner: CommandRunner; calls: CommandSpec[] } {
  const calls: CommandSpec[] = [];
  const runner: CommandRunner = (spec) => {
    calls.push(spec);
    return { status: 0, stdout: "", stderr: "", signal: null, ...handler(spec) };
  };
  return { runner, calls };
}

test("cliVersion 解析版本且参数为 --version", () => {
  const dir = tempDir();
  const config = path.join(dir, "edgectl.yaml");
  const { runner, calls } = fakeRunner(() => ({ stdout: "edgectl 0.1.0\n" }));
  const result = cliVersion({ paths: pathsFor("/bin/edgectl", config), runner });
  assert.equal(result.version, "0.1.0");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, ["--version"]);
  assert.equal(calls[0]!.command, "/bin/edgectl");
});

test("握手失败抛错且不回退（错误信息脱敏）", () => {
  const dir = tempDir();
  const config = path.join(dir, "edgectl.yaml");
  const { runner } = fakeRunner(() => ({
    status: 1,
    stderr: `bad secret ${HASH}`,
  }));
  assert.throws(
    () => cliVersion({ paths: pathsFor("/bin/edgectl", config), runner, secrets: SECRETS }),
    (error: unknown) =>
      error instanceof EdgeError &&
      /握手失败/.test(error.message) &&
      !error.message.includes(HASH) &&
      error.message.includes("<redacted>"),
  );
});

test("validate/applyVps 始终显式传绝对 --config，且 --yes 顺序正确", () => {
  const dir = tempDir();
  const config = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(config, "version: 1\n");
  const { runner, calls } = fakeRunner(() => ({}));
  const paths = pathsFor("/bin/edgectl", config);

  const validate = validateConfig(config, { paths, runner });
  assert.equal(validate.ok, true);
  assert.deepEqual(calls[0]!.args, ["validate", "--strict", "--config", config]);

  const apply = applyVps(config, { paths, runner });
  assert.equal(apply.ok, true);
  assert.deepEqual(calls[1]!.args, ["apply-vps", "--yes", "--config", config]);

  assert.throws(
    () => validateConfig("relative/edgectl.yaml", { paths, runner }),
    /必须是绝对路径/,
  );
});

test("runDryRunCandidate：候选文件同目录、0600、argv 正确、finally 删除", () => {
  const dir = tempDir();
  const config = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(config, "version: 1\n");
  const candidateText = "version: 1\nsites: []\n";
  const { runner, calls } = fakeRunner((spec) => {
    if (spec.args[0] === "validate") {
      const candidate = spec.args[3]!;
      assert.equal(path.dirname(candidate), dir);
      assert.ok(path.basename(candidate).startsWith(".qubius-edge-candidate-"));
      const stat = fs.statSync(candidate);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(candidate, "utf8"), candidateText);
      return {};
    }
    return { stdout: `diff contains ${HASH} and http://user:pass@example.test/x\n` };
  });

  const result = runDryRunCandidate({
    paths: pathsFor("/bin/edgectl", config),
    runner,
    secrets: SECRETS,
    registryPath: config,
    jobId: "job-1",
    candidateText,
  });

  const expectedCandidate = candidateRegistryPath(config, "job-1");
  assert.deepEqual(calls[0]!.args, [
    "validate",
    "--strict",
    "--config",
    expectedCandidate,
  ]);
  assert.deepEqual(calls[1]!.args, [
    "apply-vps",
    "--dry-run",
    "--config",
    expectedCandidate,
  ]);
  assert.equal(calls[1]!.input, undefined);
  assert.ok(!result.dryRunStdout.includes(HASH));
  assert.ok(result.dryRunStdout.includes("<redacted>"));
  assert.ok(result.dryRunStdout.includes("***@"));
  assert.equal(
    result.dryRunStdoutSha,
    sha256Hex(`diff contains ${HASH} and http://user:pass@example.test/x\n`),
  );
  // finally 删除候选文件
  assert.equal(fs.existsSync(expectedCandidate), false);
});

test("runDryRunCandidate 在异常/失败时也删除候选文件", () => {
  const dir = tempDir();
  const config = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(config, "version: 1\n");
  const candidate = candidateRegistryPath(config, "job-x");

  const throwing: CommandRunner = () => {
    throw new Error("runner boom");
  };
  assert.throws(
    () =>
      runDryRunCandidate({
        paths: pathsFor("/bin/edgectl", config),
        runner: throwing,
        registryPath: config,
        jobId: "job-x",
        candidateText: "version: 1\n",
      }),
    /runner boom/,
  );
  assert.equal(fs.existsSync(candidate), false);

  const failing = fakeRunner(() => ({ status: 2, stderr: "nope" }));
  const result = runDryRunCandidate({
    paths: pathsFor("/bin/edgectl", config),
    runner: failing.runner,
    registryPath: config,
    jobId: "job-y",
    candidateText: "version: 1\n",
  });
  assert.equal(result.validate.ok, false);
  // validate 失败后跳过 dry-run，只调用一次 edgectl。
  assert.equal(result.dryRunSkipped, true);
  assert.equal(result.dryRun.ok, false);
  assert.equal(result.dryRunStdoutSha, null);
  assert.equal(failing.calls.length, 1);
  assert.equal(fs.existsSync(candidateRegistryPath(config, "job-y")), false);
});

test("withCandidateRegistry 拒绝不安全 jobId", () => {
  const dir = tempDir();
  const config = path.join(dir, "edgectl.yaml");
  assert.throws(
    () => withCandidateRegistry(config, "../escape", "x", () => undefined),
    /非法 jobId/,
  );
  assert.throws(() => candidateRegistryPath(config, "a b"), /非法 jobId/);
});

test("redactText 同时处理密钥和 URL user:pass", () => {
  const text = `secret=${COOKIE} url=https://user:pw@host/x`;
  const out = redactText(text, SECRETS);
  assert.ok(!out.includes(COOKIE));
  assert.ok(!out.includes("user:pw"));
  assert.ok(out.includes("://***@"));
});
