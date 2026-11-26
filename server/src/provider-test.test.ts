import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { testProvider } from "./provider-test.js";

const apiKey = "sk-test-secret-key";

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

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test("成功连接返回连接正常，并发送最小 Anthropic 请求", async () => {
  let captured: {
    method?: string;
    url?: string;
    apiKey?: string | string[];
    version?: string | string[];
    body: string;
  } = { body: "" };
  const server = await startServer(async (req, res) => {
    captured = {
      method: req.method,
      url: req.url,
      apiKey: req.headers["x-api-key"],
      version: req.headers["anthropic-version"],
      body: await readBody(req),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  try {
    const result = await testProvider({ baseUrl: server.url, apiKey, model: "sonnet" });
    assert.deepEqual(result, { ok: true, status: 200, detail: "连接正常" });
    assert.equal(captured.method, "POST");
    assert.equal(captured.url, "/v1/messages");
    assert.equal(captured.apiKey, apiKey);
    assert.equal(captured.version, "2023-06-01");
    const body = JSON.parse(captured.body) as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(body.model, "sonnet");
    assert.equal(body.max_tokens, 1);
    assert.deepEqual(body.messages, [{ role: "user", content: "ping" }]);
  } finally {
    await server.close();
  }
});

const statusCases: Array<[number, RegExp]> = [
  [401, /无效|权限/],
  [403, /无效|权限/],
  [404, /地址或模型不存在/],
  [429, /限流/],
];

for (const [status, expected] of statusCases) {
  test(`HTTP ${status} 会给出可读分类且不泄露密钥`, async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `server said ${apiKey}` }));
    });
    try {
      const result = await testProvider({ baseUrl: server.url, apiKey, model: "sonnet" });
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.match(result.detail, expected);
      assert.equal(JSON.stringify(result).includes(apiKey), false);
    } finally {
      await server.close();
    }
  });
}

test("其他状态码带 HTTP 状态和响应体前 300 字", async () => {
  const longBody = "x".repeat(400);
  const server = await startServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(longBody);
  });
  try {
    const result = await testProvider({ baseUrl: server.url, apiKey, model: "sonnet" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.match(result.detail, /^HTTP 500：/);
    // "HTTP 500：" 之后最多 300 字。
    assert.ok(result.detail.length <= "HTTP 500：".length + 300);
    assert.equal(result.detail.includes("x".repeat(301)), false);
    assert.equal(JSON.stringify(result).includes(apiKey), false);
  } finally {
    await server.close();
  }
});

test("错误体回显密钥时会在返回前脱敏", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: `Incorrect API key provided: ${apiKey}`,
      authorization: `Bearer ${apiKey}`,
    }));
  });
  try {
    const result = await testProvider({ baseUrl: server.url, apiKey, model: "sonnet" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.detail, /^HTTP 400：/);
    assert.match(result.detail, /\*\*\*/);
    assert.equal(result.detail.includes(apiKey), false);
    assert.equal(JSON.stringify(result).includes(apiKey), false);
  } finally {
    await server.close();
  }
});

test("重定向按地址配置错误处理，不跟随成登录页的 200", async () => {
  const server = await startServer((req, res) => {
    if (req.url === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>login</html>");
      return;
    }
    res.writeHead(302, { location: "/login" });
    res.end();
  });
  try {
    const result = await testProvider({ baseUrl: server.url, apiKey, model: "sonnet" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 302);
    assert.match(result.detail, /重定向|地址配置/);
  } finally {
    await server.close();
  }
});

test("超大错误页只截取有限内容", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("A".repeat(1_000_000));
  });
  try {
    const result = await testProvider({ baseUrl: server.url, apiKey, model: "sonnet" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.ok(result.detail.length <= "HTTP 500：".length + 300);
  } finally {
    await server.close();
  }
});

test("网络错误给出可读文案", async () => {
  const failingFetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const result = await testProvider(
    { baseUrl: "https://api.example.com", apiKey, model: "sonnet" },
    { fetch: failingFetch },
  );
  assert.equal(result.ok, false);
  assert.equal(result.detail, "网络连接失败，请检查接口地址和网络");
});

test("超时给出可读文案", async () => {
  const timeoutFetch = (async () => {
    throw new DOMException("Timeout", "TimeoutError");
  }) as unknown as typeof fetch;
  const result = await testProvider(
    { baseUrl: "https://api.example.com", apiKey, model: "sonnet" },
    { fetch: timeoutFetch },
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /超时/);
});

test("DeepSeek 地址和模型会先规范化再请求", async () => {
  let seen: { url: string; body: string } | undefined;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), body: String(init?.body) };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const result = await testProvider(
    { baseUrl: "https://api.deepseek.com", apiKey, model: "deepseek-flash" },
    { fetch: fakeFetch },
  );
  assert.deepEqual(result, { ok: true, status: 200, detail: "连接正常" });
  assert.equal(seen?.url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal((JSON.parse(seen?.body ?? "{}") as { model: string }).model, "deepseek-flash[1m]");
});
