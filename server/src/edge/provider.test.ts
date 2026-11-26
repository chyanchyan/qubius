import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256Hex } from "./canonical.js";
import type { CommandRunner, CommandSpec } from "./cli.js";
import {
  caddyTooOld,
  nativeProvider,
  renderRemoteDiff,
  resolveProvider,
  type EdgeProviderPlanInput,
} from "./provider.js";
import { readRegistry, managedSites, upsertManagedSites } from "./registry.js";
import { renderVpsBlock, MANAGED_END, MANAGED_START } from "./render.js";
import { loadEdgeSecrets } from "./secrets.js";
import { EdgeError, type EdgePaths, type EdgeSite } from "./types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "registry", "edgectl.yaml");

const registry = readRegistry(FIXTURE);
const secrets = loadEdgeSecrets({ registry, env: {} });
const registryText = fs.readFileSync(FIXTURE, "utf8");

const NATIVE_PATHS: EdgePaths = {
  provider: "native",
  resolvedProvider: "native",
  configPath: FIXTURE,
  configSource: "envfile-qubius",
  binPath: null,
  binSource: null,
  disabled: false,
  errors: [],
};

function baseInput(overrides: Partial<EdgeProviderPlanInput> = {}): EdgeProviderPlanInput {
  return {
    role: "primary",
    paths: NATIVE_PATHS,
    registry,
    registryText,
    candidateText: registryText,
    secrets,
    jobId: "job-1",
    remoteContent: renderVpsBlock(registry, secrets),
    ...overrides,
  };
}

test("native plan：远端未变时无 diff、无阻断", async () => {
  const plan = await nativeProvider.plan(baseInput());
  assert.equal(plan.remoteUnavailable, undefined);
  assert.equal(plan.remoteRawSha, sha256Hex(renderVpsBlock(registry, secrets)));
  assert.equal(plan.expectedRemoteSha, plan.remoteRawSha);
  assert.equal(plan.remoteDiff, "远端无变化\n");
  assert.deepEqual(plan.blocking, []);
  assert.equal(plan.requiresConfirmExisting, false);
});

test("非 owned 站点在整块重渲染中变化 → blocking + confirmExisting", async () => {
  const remote = renderVpsBlock({ ...registry, sites: managedSites(registry) }, secrets);
  const plan = await nativeProvider.plan(baseInput({ remoteContent: remote }));
  assert.ok(plan.blocking.includes("non-owned-changed"));
  assert.equal(plan.requiresConfirmExisting, true);
  assert.ok(plan.warnings.some((value) => value.includes("非 qubius 管理")));
});

test("托管块之外的同域名站点视为冲突", async () => {
  const remote = `qubius.example.com {\n\trespond "conflict"\n}\n`;
  const plan = await nativeProvider.plan(baseInput({ remoteContent: remote }));
  assert.ok(plan.blocking.includes("conflict"));
  assert.ok(plan.errors.some((value) => value.includes("冲突")));
});

test("已有 owned 条目不同 → requiresConfirmExisting", async () => {
  const changed: EdgeSite = {
    name: "qubius",
    domains: ["qubius.example.com"],
    env: "dev",
    upstream: "http://127.0.0.1:9999",
    auth: "dev",
    sse: true,
  };
  const candidateText = upsertManagedSites(FIXTURE, [changed], { write: false }).text;
  const plan = await nativeProvider.plan(baseInput({ candidateText }));
  assert.equal(plan.requiresConfirmExisting, true);
});

test("仅在候选含 dev auth 站点时探测 Caddy 版本", async () => {
  const remoteScript = (spec: CommandSpec): string => spec.args[spec.args.length - 1]!;
  const calls: CommandSpec[] = [];
  const runner: CommandRunner = (spec) => {
    calls.push(spec);
    const script = remoteScript(spec);
    if (script.includes("caddy version")) {
      return { status: 0, stdout: "v2.8.1 h1:x\n", stderr: "", signal: null };
    }
    return { status: 0, stdout: "", stderr: "", signal: null };
  };
  const plan = await nativeProvider.plan(baseInput({ remoteContent: undefined, runner }));
  assert.equal(plan.caddyVersion, "2.8.1");
  assert.ok(calls.some((spec) => remoteScript(spec).includes("caddy version")));

  const noDevText = registryText.replace(/auth: dev/g, "auth: none");
  const calls2: CommandSpec[] = [];
  const runner2: CommandRunner = (spec) => {
    calls2.push(spec);
    return { status: 0, stdout: "", stderr: "", signal: null };
  };
  const noDev = await nativeProvider.plan(
    baseInput({ candidateText: noDevText, remoteContent: undefined, runner: runner2 }),
  );
  assert.equal(noDev.caddyVersion, null);
  assert.equal(
    calls2.some((spec) => remoteScript(spec).includes("caddy version")),
    false,
  );
});

test("Caddy < 2.8 且存在 dev auth → blocking + warning（不进 errors）", async () => {
  const plan = await nativeProvider.plan(baseInput({ caddyVersion: "2.7.6" }));
  assert.ok(plan.blocking.includes("caddy-too-old"));
  assert.ok(plan.warnings.some((value) => value.includes("Caddy")));
  assert.equal(plan.errors.some((value) => value.includes("Caddy")), false);
  assert.equal(caddyTooOld("2.8.0"), false);
  assert.equal(caddyTooOld("2.7.6"), true);
  assert.equal(caddyTooOld("v2.10.0"), false);
  assert.equal(caddyTooOld(undefined), false);
});

test("secrets 缺失降级：blocking secrets-missing，不渲染也不抛错", async () => {
  const plan = await nativeProvider.plan(
    baseInput({
      secretsMissing: true,
      secretsWarning: "缺少 dev 认证密钥：X。",
      secrets: {
        passwordHash: "",
        cookieSecret: "",
        secretsSha: "missing",
        passwordHashSource: "envfile",
        cookieSecretSource: "envfile",
      },
    }),
  );
  assert.ok(plan.blocking.includes("secrets-missing"));
  assert.ok(plan.warnings.some((value) => value.includes("缺少 dev 认证密钥")));
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.expectedRemoteContent, "");
  assert.equal(plan.expectedRemoteSha, sha256Hex(""));
});

test("desired 为空但候选仍有非 owned 站点时仍要求 confirmExisting", async () => {
  // 候选块按整份候选注册表渲染：即使本次没有 desired 站点，注册表里已有的
  // 非 owned 站点仍会被重写。不能用 desired 为空来跳过差异检查。
  const remote = renderVpsBlock({ ...registry, sites: managedSites(registry) }, secrets);
  const plan = await nativeProvider.plan(baseInput({ remoteContent: remote }));
  assert.ok(plan.blocking.includes("non-owned-changed"));
  assert.equal(plan.requiresConfirmExisting, true);
});

test("远端读取失败返回 remoteUnavailable 且脱敏", async () => {
  const throwing: CommandRunner = () => {
    throw new Error("ssh failed for https://user:pw@vps");
  };
  const plan = await nativeProvider.plan(
    baseInput({ remoteContent: undefined, runner: throwing }),
  );
  assert.ok(plan.remoteUnavailable);
  assert.equal(plan.remoteRawSha, null);
  assert.ok(!plan.remoteUnavailable!.includes("user:pw"));
  assert.ok(plan.warnings.some((value) => value.includes("远端不可用")));
});

test("resolveProvider：native 直接返回，provider 不再暴露 apply", async () => {
  const { provider, resolved } = await resolveProvider(NATIVE_PATHS);
  assert.equal(resolved, "native");
  assert.equal(provider.kind, "native");
  // apply 由 actions 层编排；provider 上不应再有死代码 apply。
  assert.equal("apply" in provider, false);
});

test("resolveProvider：disabled 报错", async () => {
  const disabled: EdgePaths = {
    ...NATIVE_PATHS,
    provider: null,
    resolvedProvider: null,
    disabled: true,
    errors: ["找不到 edgectl 配置"],
  };
  await assert.rejects(resolveProvider(disabled), /公网入口未启用/);
});

test("resolveProvider：cli 握手失败直接报错，不回退 native", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-provider-"));
  const bin = path.join(dir, "edgectl");
  fs.writeFileSync(bin, "#!/bin/sh\n");
  const paths: EdgePaths = {
    ...NATIVE_PATHS,
    provider: "cli",
    resolvedProvider: "cli",
    binPath: bin,
    binSource: "env",
  };
  const runner: CommandRunner = () => ({
    status: 1,
    stdout: "",
    stderr: "boom",
    signal: null,
  });
  await assert.rejects(
    resolveProvider(paths, { runner }),
    (error: unknown) => error instanceof EdgeError && /握手失败/.test(error.message),
  );
});

test("resolveProvider：cli 握手成功记录版本", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-provider-"));
  const bin = path.join(dir, "edgectl");
  fs.writeFileSync(bin, "#!/bin/sh\n");
  const paths: EdgePaths = {
    ...NATIVE_PATHS,
    provider: "cli",
    resolvedProvider: "cli",
    binPath: bin,
    binSource: "env",
  };
  const runner: CommandRunner = () => ({
    status: 0,
    stdout: "edgectl 0.1.0\n",
    stderr: "",
    signal: null,
  });
  const { provider, resolved } = await resolveProvider(paths, { runner });
  assert.equal(resolved, "cli");
  assert.equal(provider.version, "0.1.0");
  assert.equal("apply" in provider, false);
});

test("renderRemoteDiff 头部为通用标签并脱敏", () => {
  const diff = renderRemoteDiff(
    `${MANAGED_START}\nold secret\n${MANAGED_END}\n`,
    `${MANAGED_START}\nnew https://user:pw@host\n${MANAGED_END}\n`,
    secrets,
  );
  assert.ok(diff.startsWith("--- 远端 Caddyfile\n+++ 候选 Caddyfile\n"));
  assert.ok(!diff.includes("user:pw"));
  assert.ok(!diff.includes("ubuntu@"));
});
