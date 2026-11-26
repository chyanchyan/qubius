import assert from "node:assert/strict";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AUTH_TOKEN_FILE,
  parseCookie,
  resolveAuthToken,
  tokenFromRequest,
  tokenMatches,
} from "./auth.js";

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("显式令牌太短会报错，够长时原样 trim 返回", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-auth-"));
  try {
    assert.throws(
      () => resolveAuthToken({ authToken: "short", dataDir }, {}),
      /authToken 至少 16 个字符/,
    );
    assert.equal(
      resolveAuthToken({ authToken: "  0123456789abcdef  ", dataDir }, {}),
      "0123456789abcdef",
    );
    // 环境变量里的令牌同样校验长度。
    assert.throws(
      () => resolveAuthToken({ dataDir }, { QUBIUS_AUTH_TOKEN: "short" }),
      /authToken 至少 16 个字符/,
    );
    assert.equal(
      resolveAuthToken({ dataDir }, { QUBIUS_AUTH_TOKEN: "fedcba9876543210" }),
      "fedcba9876543210",
    );
    // 过长令牌同样拒绝，避免异常的配置文件撑爆比较/日志。
    assert.throws(
      () => resolveAuthToken({ authToken: "x".repeat(513), dataDir }, {}),
      /authToken 最多 512 个字符/,
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("auth=true 首次生成令牌并复用到 dataDir/auth-token", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-auth-"));
  try {
    const first = resolveAuthToken({ auth: true, dataDir }, {});
    assert.ok(first);
    assert.equal(first.length, 64);
    const file = path.join(dataDir, AUTH_TOKEN_FILE);
    assert.equal(fs.readFileSync(file, "utf8").trim(), first);
    // 权限 0600；Windows 等不支持时这里跳过。
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }

    const second = resolveAuthToken({ auth: true, dataDir }, {});
    assert.equal(second, first);

    // 没有 auth 也没有显式令牌时保持未启用。
    assert.equal(resolveAuthToken({ dataDir }, {}), undefined);
    assert.equal(resolveAuthToken({ auth: false, dataDir }, {}), undefined);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("auth: false 显式关闭认证，优先于令牌配置", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-auth-"));
  try {
    assert.equal(
      resolveAuthToken({ auth: false, authToken: "0123456789abcdef", dataDir }, {}),
      undefined,
    );
    assert.equal(
      resolveAuthToken({ auth: false, dataDir }, { QUBIUS_AUTH_TOKEN: "fedcba9876543210" }),
      undefined,
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("复用已有 auth-token 时校验内容，弱令牌会报错", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-auth-"));
  const file = path.join(dataDir, AUTH_TOKEN_FILE);
  try {
    fs.writeFileSync(file, "short\n");
    assert.throws(
      () => resolveAuthToken({ auth: true, dataDir }, {}),
      /auth-token 文件中的令牌至少 16 个字符/,
    );

    fs.writeFileSync(file, "");
    assert.throws(
      () => resolveAuthToken({ auth: true, dataDir }, {}),
      /auth-token 文件中的令牌至少 16 个字符/,
    );

    // 长度合法时读回 trim 后的值，并把文件权限收紧到 0600。
    fs.writeFileSync(file, "fedcba9876543210\n", { mode: 0o644 });
    assert.equal(resolveAuthToken({ auth: true, dataDir }, {}), "fedcba9876543210");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("tokenFromRequest 依次读取 X-Qubius-Token、Bearer 和 cookie", () => {
  assert.equal(tokenFromRequest(request({ "x-qubius-token": "header-token" })), "header-token");
  assert.equal(
    tokenFromRequest(request({ authorization: "Bearer bearer-token" })),
    "bearer-token",
  );
  assert.equal(
    tokenFromRequest(request({ authorization: "bearer   bearer-token   " })),
    "bearer-token",
  );
  assert.equal(
    tokenFromRequest(request({ cookie: "a=1; qubius_token=cookie-token; b=2" })),
    "cookie-token",
  );
  // cookie 值做 URL 解码；非法编码按原值处理。
  assert.equal(
    tokenFromRequest(request({ cookie: "qubius_token=hello%20world" })),
    "hello world",
  );
  assert.equal(
    tokenFromRequest(request({ cookie: "qubius_token=broken%zz" })),
    "broken%zz",
  );
  // 头部优先于 cookie。
  assert.equal(
    tokenFromRequest(request({ "x-qubius-token": "header", cookie: "qubius_token=cookie" })),
    "header",
  );
  assert.equal(tokenFromRequest(request({})), "");
});

test("parseCookie 处理空白、等号和缺失值", () => {
  assert.equal(parseCookie("a=1; qubius_token=abc", "qubius_token"), "abc");
  assert.equal(parseCookie("qubius_token=a=b", "qubius_token"), "a=b");
  assert.equal(parseCookie("qubius_token=", "qubius_token"), "");
  assert.equal(parseCookie("x=1", "qubius_token"), undefined);
  assert.equal(parseCookie("", "qubius_token"), undefined);
});

test("tokenMatches 长度不同直接失败，内容相同才通过", () => {
  assert.equal(tokenMatches("0123456789abcdef", "0123456789abcdef"), true);
  assert.equal(tokenMatches("0123456789abcdef", "0123456789abcde"), false);
  assert.equal(tokenMatches("0123456789abcdef", "0123456789abcdeg"), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches("0123456789abcdef", ""), false);
});
