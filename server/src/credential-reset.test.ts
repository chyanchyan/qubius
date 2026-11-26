import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetAuthToken, resetLanPassword, type AuthTokenState } from "./credential-reset.js";
import type { AppConfig } from "./config.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qubius-credential-reset-"));
}

function configAt(base: string): AppConfig {
  const dataDir = path.join(base, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    host: "127.0.0.1",
    port: 8787,
    dataDir,
    maxConcurrent: 4,
    configDir: base,
    role: "primary",
    projects: [],
  };
}

test("重置局域网密码：写盘、保留用户名、返回访问地址和重启说明", () => {
  const base = tmp();
  const config = configAt(base);
  const credentials = path.join(base, "lan-proxy.credentials");
  fs.writeFileSync(credentials, "olduser:old-password\n");
  const env = { QUBIUS_LAN_HOST: "192.168.1.10" };

  const { result, credentialsFile, needsRestart } = resetLanPassword({
    config,
    configDir: base,
    repoRoot: base,
    env,
    user: "newuser",
  });
  assert.equal(credentialsFile, credentials);
  assert.equal(needsRestart, false);
  assert.equal(result.user, "newuser");
  assert.equal(result.restart, "none");
  assert.equal(result.restartMethod, "none");
  assert.match(result.restartNote, /未运行/);
  assert.deepEqual(result.urls, ["http://192.168.1.10:8787"]);
  assert.ok(result.password.length >= 12);
  const stored = fs.readFileSync(credentials, "utf8");
  assert.match(stored, /^newuser:/);
  assert.doesNotMatch(stored, /old-password/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(credentials).mode & 0o777, 0o600);
  }

  // 不传用户名时沿用文件里的用户名。
  const second = resetLanPassword({ config, configDir: base, repoRoot: base, env });
  assert.equal(second.result.user, "newuser");
  assert.notEqual(second.result.password, result.password);
});

test("重置 API 令牌：立即更新状态、写 env，并保留其它配置", () => {
  const base = tmp();
  const config = configAt(base);
  const envFile = path.join(base, "env");
  fs.writeFileSync(envFile, "QUBIUS_PRIMARY_PORT=8787\nQUBIUS_GITEA_TOKEN=keep\n");
  const state: AuthTokenState = { current: "old-token-0123456789", source: "env" };

  const result = resetAuthToken({ config, configDir: base, repoRoot: base, env: {}, state });
  assert.equal(result.token.length, 64);
  assert.match(result.token, /^[0-9a-f]+$/);
  assert.equal(result.restartNeeded, false);
  assert.match(result.note, /无需重启/);
  assert.equal(state.current, result.token);
  assert.equal(state.previous, "old-token-0123456789");
  assert.ok((state.previousUntil ?? 0) > Date.now());
  assert.equal(state.source, "env");

  const text = fs.readFileSync(envFile, "utf8");
  assert.match(text, /^QUBIUS_AUTH=1$/m);
  assert.match(text, new RegExp(`^QUBIUS_AUTH_TOKEN=${result.token}$`, "m"));
  assert.match(text, /^QUBIUS_GITEA_TOKEN=keep$/m);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  }

  // 旧令牌保留 60 秒宽限，新令牌是唯一当前值。
  assert.ok((state.previousUntil ?? 0) <= Date.now() + 61_000 + 1000);
});

test("重置 API 令牌：文件来源同步更新 auth-token", () => {
  const base = tmp();
  const config = configAt(base);
  const tokenFile = path.join(config.dataDir, "auth-token");
  fs.writeFileSync(tokenFile, "old-file-token-0123456789\n");
  const state: AuthTokenState = {
    current: "old-file-token-0123456789",
    source: "file",
    file: tokenFile,
  };
  const result = resetAuthToken({ config, configDir: base, repoRoot: base, env: {}, state });
  assert.equal(fs.readFileSync(tokenFile, "utf8"), result.token);
  assert.equal(state.file, tokenFile);
});

test("重置 API 令牌：config.yaml 来源同步改 authToken 和 auth", () => {
  const base = tmp();
  const config = configAt(base);
  const configFile = path.join(base, "config.yaml");
  fs.writeFileSync(configFile, [
    "listen: 127.0.0.1:8787",
    "auth: false",
    "authToken: old-config-token-0123456789",
    "",
  ].join("\n"));
  const state: AuthTokenState = {
    current: "old-config-token-0123456789",
    source: "config",
  };
  const result = resetAuthToken({ config, configDir: base, repoRoot: base, env: {}, state });
  const text = fs.readFileSync(configFile, "utf8");
  assert.match(text, /^auth: true$/m);
  assert.match(text, new RegExp(`^authToken: "${result.token}"$`, "m"));
  assert.match(fs.readFileSync(path.join(base, "env"), "utf8"), new RegExp(`QUBIUS_AUTH_TOKEN=${result.token}`));
});

test("重置 API 令牌：QUBIUS_ENV 指向不存在的文件时拒绝", () => {
  const base = tmp();
  const config = configAt(base);
  const state: AuthTokenState = { current: "old-token-0123456789", source: "env" };
  assert.throws(
    () => resetAuthToken({
      config,
      configDir: base,
      repoRoot: base,
      env: { QUBIUS_ENV: path.join(base, "missing.env") },
      state,
    }),
    /QUBIUS_ENV/,
  );
});
