import assert from "node:assert/strict";
import test from "node:test";
import { claudeConnection, claudeEnv } from "./endpoint.js";

test("DeepSeek 的根地址改到 Anthropic 接口，并带上 1M 上下文", () => {
  const connection = claudeConnection("https://api.deepseek.com", "deepseek-flash");
  assert.equal(connection.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(connection.model, "deepseek-flash[1m]");
  assert.equal(connection.subagentModel, "deepseek-flash");
});

test("已经写了 /anthropic 或上下文后缀时不再重复添加", () => {
  const connection = claudeConnection("https://api.deepseek.com/anthropic/", "deepseek-v4-pro[1m]");
  assert.equal(connection.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(connection.model, "deepseek-v4-pro[1m]");
  assert.equal(connection.subagentModel, "deepseek-v4-pro");
});

test("其他接口保持原地址和模型名", () => {
  const connection = claudeConnection("https://api.anthropic.com", "sonnet");
  assert.equal(connection.baseUrl, "https://api.anthropic.com");
  assert.equal(connection.model, "sonnet");
  const env = claudeEnv({}, "sk-test", connection);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-test");
  assert.equal(env.ANTHROPIC_MODEL, "sonnet");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  // SDK 默认只把它当 host-only 消息丢掉；必须显式让 CLI 正常下发。
  assert.equal(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, "1");
});

test("环境过滤剔除密钥类变量，但保留运行所需变量", () => {
  const connection = claudeConnection("https://api.anthropic.com", "sonnet");
  const env = claudeEnv(
    {
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
      TERM: "xterm-256color",
      SHELL: "/bin/bash",
      TMPDIR: "/tmp",
      HTTPS_PROXY: "http://proxy.internal:3128",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/private-ca.pem",
      AWS_ACCESS_KEY_ID: "aws-key",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-session",
      AWS_REGION: "us-east-1",
      AWS_PROFILE: "prod",
      GITHUB_TOKEN: "gh-token",
      NPM_TOKEN: "npm-token",
      ANTHROPIC_API_KEY: "base-anthropic-key",
      ANTHROPIC_AUTH_TOKEN: "base-anthropic-token",
      OPENAI_API_KEY: "openai-key",
      STRIPE_KEY: "stripe-key",
      DB_PASSWORD: "db-pass",
      DB_PASS: "db-pass-2",
      REDIS_PASS: "redis-pass",
      DATABASE_URL: "postgres://user:secret@db.internal/app",
      REDIS_URL: "redis://:secret@cache.internal",
      GIT_URL: "ssh://git@example.com/repo",
      PUBLIC_URL: "https://example.com",
      COMPASS: "compass",
      BYPASS: "bypass",
      PGPASSWORD: "pg-pass",
      MYSQL_PWD: "mysql-pass",
      "npm_config_//registry.npmjs.org/:_authToken": "npm-auth-token",
      MY_SECRET: "secret",
      EDITOR: "vim",
    },
    "sk-test",
    connection,
  );

  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/tester");
  assert.equal(env.LANG, "zh_CN.UTF-8");
  assert.equal(env.LC_ALL, "zh_CN.UTF-8");
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.SHELL, "/bin/bash");
  assert.equal(env.TMPDIR, "/tmp");
  // 继承的代理变量会被清掉：是否走代理只由设置页的白名单决定。
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/ssl/private-ca.pem");

  // 非密钥的 AWS 配置要保留，否则 agent 里的 aws/gcloud 会跑错区域或配置。
  assert.equal(env.AWS_REGION, "us-east-1");
  assert.equal(env.AWS_PROFILE, "prod");
  // 不含凭据的普通 URL 和普通单词保留；带 user:pass@ 的 URL 剔除。
  assert.equal(env.PUBLIC_URL, "https://example.com");
  assert.equal(env.GIT_URL, "ssh://git@example.com/repo");
  assert.equal(env.COMPASS, "compass");
  assert.equal(env.BYPASS, "bypass");

  for (const name of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "OPENAI_API_KEY",
    "STRIPE_KEY",
    "DB_PASSWORD",
    "DB_PASS",
    "REDIS_PASS",
    "DATABASE_URL",
    "REDIS_URL",
    "PGPASSWORD",
    "MYSQL_PWD",
    "npm_config_//registry.npmjs.org/:_authToken",
    "MY_SECRET",
  ]) {
    assert.equal(env[name], undefined, `${name} 应该被剔除`);
  }

  // 函数显式构造的 ANTHROPIC_* 覆盖 base 里的同名值。
  assert.equal(env.ANTHROPIC_API_KEY, "sk-test");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-test");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(env.ANTHROPIC_MODEL, "sonnet");
  // 普通变量不受影响。
  assert.equal(env.EDITOR, "vim");
});

test("命中白名单时把代理地址显式传给子进程", () => {
  const connection = claudeConnection("https://api.deepseek.com", "deepseek-flash");
  const env = claudeEnv({
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://old.lan:3128",
    https_proxy: "http://old.lan:3128",
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: "example.com",
  }, "sk-test", connection, "http://127.0.0.1:7899");

  for (const name of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    assert.equal(env[name], "http://127.0.0.1:7899", name);
  }
  // Node 的 fetch 需要这个开关才会读代理环境变量。
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.equal(env.NO_PROXY, "example.com,127.0.0.1,localhost,::1");
  assert.equal(env.no_proxy, "example.com,127.0.0.1,localhost,::1");
});

test("没有代理时清掉继承的代理变量，保证直连", () => {
  const connection = claudeConnection("https://api.deepseek.com", "deepseek-flash");
  const env = claudeEnv({
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.lan:3128",
    https_proxy: "http://proxy.lan:3128",
    HTTP_PROXY: "http://proxy.lan:3128",
    http_proxy: "http://proxy.lan:3128",
    ALL_PROXY: "socks5://proxy.lan:1080",
    all_proxy: "socks5://proxy.lan:1080",
    NODE_USE_ENV_PROXY: "1",
  }, "sk-test", connection);

  for (const name of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NODE_USE_ENV_PROXY",
  ]) {
    assert.equal(env[name], undefined, `${name} 应该被清掉`);
  }
});
