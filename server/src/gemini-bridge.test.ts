import assert from "node:assert/strict";
import test from "node:test";
import { GeminiBridge, type GeminiBridgeProvider } from "./gemini-bridge.js";

const apiKey = "AIza-test-key";
const provider: GeminiBridgeProvider = {
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey,
};

interface Captured {
  url?: string;
  init?: RequestInit;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(chunks: unknown[]): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function post(
  base: string,
  path: string,
  body: unknown,
  key = apiKey,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });
}

test("非流式请求翻译到 Gemini 并把结果翻译回 Anthropic", async () => {
  const captured: Captured = {};
  const bridge = new GeminiBridge({
    provider: (id) => (id === "p1" ? provider : undefined),
    fetch: async (url, init) => {
      captured.url = String(url);
      captured.init = init;
      return jsonResponse({
        candidates: [{
          content: { parts: [{ text: "你好" }, { functionCall: { name: "Read", args: { path: "/a" } } }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 },
      });
    },
  });
  await bridge.start();
  try {
    const response = await post(bridge.baseUrl("p1"), "/v1/messages", {
      model: "models/gemini-2.5-pro",
      max_tokens: 128,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(response.status, 200);
    const message = await response.json() as {
      type: string;
      model: string;
      stop_reason: string;
      content: Array<{ type: string; text?: string; name?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(message.type, "message");
    assert.equal(message.model, "models/gemini-2.5-pro");
    assert.equal(message.stop_reason, "tool_use");
    assert.equal(message.content[0]?.text, "你好");
    assert.equal(message.content[1]?.name, "Read");
    assert.deepEqual(message.usage, {
      input_tokens: 8,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });

    assert.equal(
      captured.url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    const headers = new Headers(captured.init?.headers);
    assert.equal(headers.get("x-goog-api-key"), apiKey);
    const upstream = JSON.parse(String(captured.init?.body)) as {
      contents: unknown;
      generationConfig: { maxOutputTokens: number };
    };
    assert.deepEqual(upstream.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
    assert.equal(upstream.generationConfig.maxOutputTokens, 128);
  } finally {
    await bridge.close();
  }
});

test("流式请求把 Gemini SSE 翻译成 Anthropic SSE", async () => {
  const bridge = new GeminiBridge({
    provider: (id) => (id === "p1" ? provider : undefined),
    fetch: async () => streamResponse([
      { candidates: [{ content: { parts: [{ text: "你" }] } }] },
      { candidates: [{ content: { parts: [{ text: "好" }] } }] },
      {
        candidates: [{
          content: { parts: [{ functionCall: { name: "Read", args: { path: "/a" } } }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
      },
    ]),
  });
  await bridge.start();
  try {
    const response = await post(bridge.baseUrl("p1"), "/v1/messages", {
      model: "gemini-2.5-pro",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_delta/);
    assert.match(text, /event: message_stop/);
    assert.match(text, /"partial_json":"\{\\"path\\":\\"\/a\\"\}"/);
    assert.match(text, /"stop_reason":"tool_use"/);
  } finally {
    await bridge.close();
  }
});

test("适配服务校验 API key 和接口类型", async () => {
  let upstreamCalls = 0;
  const bridge = new GeminiBridge({
    provider: (id) => (id === "p1" ? provider : undefined),
    fetch: async () => {
      upstreamCalls += 1;
      return jsonResponse({});
    },
  });
  await bridge.start();
  try {
    const base = bridge.baseUrl("p1");
    const wrongKey = await post(base, "/v1/messages", {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
    }, "wrong");
    assert.equal(wrongKey.status, 401);
    assert.equal(upstreamCalls, 0);

    const unknownProvider = await post(bridge.baseUrl("missing"), "/v1/messages", {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(unknownProvider.status, 404);
    assert.equal(upstreamCalls, 0);
  } finally {
    await bridge.close();
  }
});

test("Gemini 上游错误会转成 Anthropic 错误结构", async () => {
  const bridge = new GeminiBridge({
    provider: (id) => (id === "p1" ? provider : undefined),
    fetch: async () => jsonResponse({
      error: { code: 429, message: `quota exceeded for ${apiKey}`, status: "RESOURCE_EXHAUSTED" },
    }, 429),
  });
  await bridge.start();
  try {
    const response = await post(bridge.baseUrl("p1"), "/v1/messages", {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(response.status, 429);
    const body = await response.json() as { type: string; error: { type: string; message: string } };
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "rate_limit_error");
    assert.equal(body.error.message.includes(apiKey), false);
  } finally {
    await bridge.close();
  }
});

test("count_tokens 转发给 Gemini 并使用 totalTokens", async () => {
  const captured: Captured = {};
  const bridge = new GeminiBridge({
    provider: (id) => (id === "p1" ? provider : undefined),
    fetch: async (url, init) => {
      captured.url = String(url);
      captured.init = init;
      return jsonResponse({ totalTokens: 42 });
    },
  });
  await bridge.start();
  try {
    const response = await post(bridge.baseUrl("p1"), "/v1/messages/count_tokens", {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { input_tokens: 42 });
    assert.equal(
      captured.url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:countTokens",
    );
    const upstream = JSON.parse(String(captured.init?.body)) as {
      contents: unknown;
      tools?: unknown;
      generationConfig?: unknown;
    };
    assert.deepEqual(upstream.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
    assert.equal(upstream.generationConfig, undefined);
    assert.ok(upstream.tools);
  } finally {
    await bridge.close();
  }
});

test("count_tokens 上游失败时退回本地估算，不阻塞对话", async () => {
  const bridge = new GeminiBridge({
    provider: (id) => (id === "p1" ? provider : undefined),
    fetch: async () => jsonResponse({ error: { message: "boom" } }, 500),
  });
  await bridge.start();
  try {
    const response = await post(bridge.baseUrl("p1"), "/v1/messages/count_tokens", {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { input_tokens: number };
    assert.ok(body.input_tokens > 0);
  } finally {
    await bridge.close();
  }
});
