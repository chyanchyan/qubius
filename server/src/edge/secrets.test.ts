import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalSha256 } from "./canonical.js";
import { parseRegistryText } from "./registry.js";
import { isValidBcryptHash, isValidCookieSecret, loadEdgeSecrets, readRawSecrets } from "./secrets.js";
import { EdgeError } from "./types.js";

const HASH = "$2a$14$FakeSaltValue123456789FakeHashValue1234567890ABCDEFGH";
const COOKIE = "fedcba9876543210fedcba9876543210";

function registryAt(dir: string) {
  const source = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(source, "version: 1\n");
  return parseRegistryText(
    [
      "version: 1",
      "edge:",
      "  vps:",
      "    ssh: ubuntu@example.test",
      "    caddyfile: /opt/example/Caddyfile",
      "  auth:",
      "    dev:",
      "      password_hash_env: TEST_EDGE_HASH",
      "      cookie_secret_env: TEST_EDGE_COOKIE",
      "sites: []",
      "",
    ].join("\n"),
    source,
  );
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "edge-secrets-"));
}

test("从 .env 读取密钥并计算 secretsSha", () => {
  const dir = tempDir();
  const registry = registryAt(dir);
  fs.writeFileSync(
    path.join(dir, ".env"),
    `TEST_EDGE_HASH=${HASH}\nTEST_EDGE_COOKIE=${COOKIE}\n`,
  );
  const secrets = loadEdgeSecrets({ registry, env: {} });
  assert.equal(secrets.passwordHash, HASH);
  assert.equal(secrets.cookieSecret, COOKIE);
  assert.equal(secrets.passwordHashSource, "envfile");
  assert.equal(secrets.cookieSecretSource, "envfile");
  assert.equal(secrets.secretsSha, canonicalSha256([HASH, COOKIE]));
  assert.ok(!secrets.secretsSha.includes(HASH));
});

test("进程 env 优先于 .env（python-dotenv override=False）", () => {
  const dir = tempDir();
  const registry = registryAt(dir);
  fs.writeFileSync(
    path.join(dir, ".env"),
    `TEST_EDGE_HASH=${HASH}\nTEST_EDGE_COOKIE=${COOKIE}\n`,
  );
  const otherHash = "$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234";
  const secrets = loadEdgeSecrets({
    registry,
    env: { TEST_EDGE_HASH: otherHash },
  });
  assert.equal(secrets.passwordHash, otherHash);
  assert.equal(secrets.passwordHashSource, "process");
  assert.equal(secrets.cookieSecret, COOKIE);
  assert.equal(secrets.cookieSecretSource, "envfile");
});

test("缺失密钥返回中文错误并列出变量名", () => {
  const dir = tempDir();
  const registry = registryAt(dir);
  assert.throws(
    () => loadEdgeSecrets({ registry, env: {} }),
    (error: unknown) =>
      error instanceof EdgeError &&
      /缺少 dev 认证密钥/.test(error.message) &&
      error.message.includes("TEST_EDGE_HASH") &&
      error.message.includes("TEST_EDGE_COOKIE"),
  );
});

test("bcrypt 格式错误被拒绝", () => {
  const dir = tempDir();
  const registry = registryAt(dir);
  assert.throws(
    () => loadEdgeSecrets({ registry, env: { TEST_EDGE_HASH: "not-a-hash", TEST_EDGE_COOKIE: COOKIE } }),
    /bcrypt/,
  );
  assert.equal(isValidBcryptHash(HASH), true);
  assert.equal(isValidBcryptHash("$2a$14$short"), false);
});

test("cookie secret 少于 16 位被拒绝", () => {
  const dir = tempDir();
  const registry = registryAt(dir);
  assert.throws(
    () => loadEdgeSecrets({ registry, env: { TEST_EDGE_HASH: HASH, TEST_EDGE_COOKIE: "short" } }),
    /至少 16 位/,
  );
  assert.equal(isValidCookieSecret("x".repeat(16)), true);
  assert.equal(isValidCookieSecret("x".repeat(15)), false);
});

test("cookie secret 拒绝换行/分号/引号/花括号等注入字符", () => {
  const dir = tempDir();
  const registry = registryAt(dir);
  const badValues = [
    "0123456789abcdef\nheader X injected y",
    '0123456789abcdef"; Path=/; evil',
    "0123456789abcdef{}",
    "0123456789abcdef;rm -rf /",
    "0123456789 abcdef",
    "0123456789abcdef\t.",
  ];
  for (const bad of badValues) {
    assert.throws(
      () => loadEdgeSecrets({ registry, env: { TEST_EDGE_HASH: HASH, TEST_EDGE_COOKIE: bad } }),
      /只能包含.*\._~-/,
      `应拒绝 cookie secret: ${JSON.stringify(bad)}`,
    );
    assert.equal(isValidCookieSecret(bad), false);
  }
  assert.equal(isValidCookieSecret("Abc.def_~-0123456789"), true);
});

test(".env 中密钥键的 ${ 变量展开报错", () => {
  const dir = tempDir();
  const registry = registryAt(dir);
  fs.writeFileSync(path.join(dir, ".env"), "TEST_EDGE_HASH=${HOME}/hash\n");
  assert.throws(
    () => readRawSecrets({ registry, env: {} }),
    /变量展开/,
  );
  fs.writeFileSync(path.join(dir, ".env"), "TEST_EDGE_COOKIE=${HOME}/cookie\n");
  assert.throws(
    () => readRawSecrets({ registry, env: {} }),
    /变量展开/,
  );
});

test(".env 中无关键的 ${ 不影响密钥读取", () => {
  const dir = tempDir();
  const registry = registryAt(dir);
  fs.writeFileSync(
    path.join(dir, ".env"),
    [
      "UNRELATED_PATH=${HOME}/x",
      `TEST_EDGE_HASH=${HASH}`,
      `TEST_EDGE_COOKIE=${COOKIE}`,
      "",
    ].join("\n"),
  );
  const raw = readRawSecrets({ registry, env: {} });
  assert.equal(raw.passwordHash, HASH);
  assert.equal(raw.cookieSecret, COOKIE);
  const secrets = loadEdgeSecrets({ registry, env: {} });
  assert.equal(secrets.passwordHash, HASH);
});
