import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { balanceEndpoint, queryProviderBalance, supportsBalance } from "./balance.js";

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function startServer(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("DeepSeek 的余额地址从站点根路径推导", () => {
  assert.equal(
    balanceEndpoint("anthropic", "https://api.deepseek.com/anthropic"),
    "https://api.deepseek.com/user/balance",
  );
  assert.equal(
    balanceEndpoint("anthropic", "https://api.deepseek.com"),
    "https://api.deepseek.com/user/balance",
  );
  assert.equal(balanceEndpoint("anthropic", "https://api.deepseek.com/anthropic/"), "https://api.deepseek.com/user/balance");
  assert.equal(supportsBalance("anthropic", "https://api.deepseek.com/anthropic"), true);
});

test("其他接口没有余额地址", () => {
  assert.equal(balanceEndpoint("anthropic", "https://api.anthropic.com"), undefined);
  assert.equal(balanceEndpoint("anthropic", "https://example.com/anthropic"), undefined);
  assert.equal(balanceEndpoint("gemini", "https://generativelanguage.googleapis.com"), undefined);
  assert.equal(supportsBalance("gemini", "https://generativelanguage.googleapis.com"), false);
});

test("Gemini 返回不支持，并提示到控制台查看", async () => {
  const result = await queryProviderBalance({
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "secret",
  });
  assert.equal(result.ok, false);
  assert.equal(result.supported, false);
  assert.match(result.detail, /Gemini/);
  assert.match(result.detail, /控制台/);
});

test("查询 DeepSeek 余额并带上 Bearer 头", async () => {
  let captured: { method?: string; url?: string; authorization?: string | string[] } = {};
  const server = await startServer((req, res) => {
    captured = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: "CNY",
        total_balance: "110.00",
        granted_balance: "10.00",
        topped_up_balance: "100.00",
      }],
    }));
  });
  try {
    const result = await queryProviderBalance(
      { baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-test" },
      { endpoint: `${server.url}/user/balance` },
    );
    assert.equal(result.ok, true);
    assert.equal(result.supported, true);
    assert.equal(result.detail, "账户可用");
    assert.deepEqual(result.balances, [{
      currency: "CNY",
      total: "110.00",
      granted: "10.00",
      toppedUp: "100.00",
    }]);
    assert.equal(captured.method, "GET");
    assert.equal(captured.url, "/user/balance");
    assert.equal(captured.authorization, "Bearer sk-test");
  } finally {
    await server.close();
  }
});

test("余额不足时仍返回金额，并说明账户不可用", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      is_available: false,
      balance_infos: [{ currency: "USD", total_balance: 0 }],
    }));
  });
  try {
    const result = await queryProviderBalance(
      { baseUrl: "https://api.deepseek.com", apiKey: "sk-test" },
      { endpoint: `${server.url}/user/balance` },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.balances, [{ currency: "USD", total: "0" }]);
    assert.match(result.detail, /不可用|不足/);
  } finally {
    await server.close();
  }
});

test("鉴权失败不回显密钥", async () => {
  const apiKey = "sk-balance-secret";
  const server = await startServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Incorrect API key provided: ${apiKey}` }));
  });
  try {
    const result = await queryProviderBalance(
      { baseUrl: "https://api.deepseek.com", apiKey },
      { endpoint: `${server.url}/user/balance` },
    );
    assert.equal(result.ok, false);
    assert.equal(result.supported, true);
    assert.match(result.detail, /无效|权限/);
    assert.equal(JSON.stringify(result).includes(apiKey), false);
  } finally {
    await server.close();
  }
});

test("余额响应不是 JSON 时给出可读提示", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>login</html>");
  });
  try {
    const result = await queryProviderBalance(
      { baseUrl: "https://api.deepseek.com", apiKey: "sk-test" },
      { endpoint: `${server.url}/user/balance` },
    );
    assert.equal(result.ok, false);
    assert.equal(result.supported, true);
    assert.match(result.detail, /JSON/);
  } finally {
    await server.close();
  }
});

test("没有可识别的余额字段时返回失败", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hello: "world" }));
  });
  try {
    const result = await queryProviderBalance(
      { baseUrl: "https://api.deepseek.com", apiKey: "sk-test" },
      { endpoint: `${server.url}/user/balance` },
    );
    assert.equal(result.ok, false);
    assert.equal(result.supported, true);
    assert.match(result.detail, /余额信息/);
  } finally {
    await server.close();
  }
});
