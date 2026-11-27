import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicMessagesRequest,
  AnthropicStreamTranslator,
  buildGeminiRequest,
  geminiApiBase,
  geminiModelId,
  toAnthropicResponse,
  type GeminiResponse,
} from "./gemini.js";

interface SseEvent {
  event: string;
  data: unknown;
}

function parseEvents(sse: string): SseEvent[] {
  return sse
    .split("\n\n")
    .filter((raw) => raw.trim())
    .map((raw) => {
      const lines = raw.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      return { event, data: JSON.parse(data) as unknown };
    });
}

test("Gemini 地址自动补版本路径，模型名去掉 models/ 前缀", () => {
  assert.equal(
    geminiApiBase("https://generativelanguage.googleapis.com"),
    "https://generativelanguage.googleapis.com/v1beta",
  );
  assert.equal(
    geminiApiBase("https://generativelanguage.googleapis.com/"),
    "https://generativelanguage.googleapis.com/v1beta",
  );
  assert.equal(
    geminiApiBase("https://generativelanguage.googleapis.com/v1beta"),
    "https://generativelanguage.googleapis.com/v1beta",
  );
  assert.equal(
    geminiApiBase("https://gateway.example/proxy/"),
    "https://gateway.example/proxy/v1beta",
  );
  assert.equal(geminiModelId("models/gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(geminiModelId(" gemini-2.5-flash "), "gemini-2.5-flash");
});

test("Anthropic 请求转换成 Gemini 请求：system、图片、工具和 tool_result", () => {
  const body: AnthropicMessagesRequest = {
    model: "gemini-2.5-pro",
    max_tokens: 4096,
    temperature: 0.2,
    system: [
      { type: "text", text: "你是助手。", cache_control: { type: "ephemeral" } },
      { type: "text", text: "保持简洁。" },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "想一想", signature: "sig" },
          { type: "text", text: "我来读取。" },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "/tmp/a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "文件内容" },
          { type: "text", text: "继续" },
        ],
      },
    ],
    tools: [
      {
        name: "Read",
        description: "读取文件",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "路径" },
            mode: { const: "fast" },
          },
          required: ["path"],
          additionalProperties: false,
          $schema: "https://json-schema.org/draft/2020-12/schema",
        },
      },
      // Anthropic 服务端工具没有 input_schema，直接跳过。
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ],
    tool_choice: { type: "tool", name: "Read" },
  };

  const { request, toolNames } = buildGeminiRequest(body);
  assert.deepEqual(request.systemInstruction, { parts: [{ text: "你是助手。\n\n保持简洁。" }] });
  assert.equal(request.contents.length, 3);
  assert.equal(request.contents[0]?.role, "user");
  assert.deepEqual(request.contents[0]?.parts[0], { text: "看看这张图" });
  assert.deepEqual(request.contents[0]?.parts[1], {
    inlineData: { mimeType: "image/png", data: "AAAA" },
  });
  assert.equal(request.contents[1]?.role, "model");
  // thinking 块被丢弃，文本和工具调用保留。
  assert.deepEqual(request.contents[1]?.parts[0], { text: "我来读取。" });
  assert.deepEqual(request.contents[1]?.parts[1], {
    functionCall: { name: "Read", args: { path: "/tmp/a" } },
    // Gemini 3 要求当前回合的工具调用带思考签名；历史里没有真实签名，用占位值。
    thoughtSignature: "skip_thought_signature_validator",
  });
  assert.equal(request.contents[2]?.role, "user");
  assert.deepEqual(request.contents[2]?.parts[0], {
    functionResponse: { name: "Read", response: { result: "文件内容" } },
  });
  assert.deepEqual(request.contents[2]?.parts[1], { text: "继续" });

  assert.equal(request.tools?.length, 1);
  const declarations = request.tools?.[0]?.functionDeclarations ?? [];
  assert.equal(declarations.length, 1);
  const schema = declarations[0]?.parameters ?? {};
  assert.equal(schema.additionalProperties, undefined);
  assert.equal(schema.$schema, undefined);
  assert.deepEqual(schema.required, ["path"]);
  const properties = schema.properties as Record<string, unknown>;
  assert.deepEqual(properties.mode, { enum: ["fast"] });
  assert.deepEqual(request.toolConfig, {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["Read"] },
  });
  assert.equal(request.generationConfig?.maxOutputTokens, 4096);
  assert.equal(request.generationConfig?.temperature, 0.2);
  assert.equal(toolNames.get("Read"), "Read");
});

test("同一轮并行工具调用只有第一个带思考签名占位值", () => {
  const body: AnthropicMessagesRequest = {
    model: "gemini-3-pro-preview",
    messages: [
      { role: "user", content: "并行读两个文件" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { path: "/a" } },
          { type: "tool_use", id: "t2", name: "Read", input: { path: "/b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "A" },
          { type: "tool_result", tool_use_id: "t2", content: "B" },
        ],
      },
    ],
  };
  const parts = buildGeminiRequest(body).request.contents[1]?.parts ?? [];
  assert.equal(
    (parts[0] as { thoughtSignature?: string }).thoughtSignature,
    "skip_thought_signature_validator",
  );
  assert.equal((parts[1] as { thoughtSignature?: string }).thoughtSignature, undefined);
});

test("非法工具名会规整，并在响应里映射回原名", () => {
  const body: AnthropicMessagesRequest = {
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "bad name!", description: "x", input_schema: { type: "object" } }],
  };
  const { request, toolNames } = buildGeminiRequest(body);
  const name = request.tools?.[0]?.functionDeclarations[0]?.name;
  assert.equal(name, "bad_name_");
  assert.equal(toolNames.get("bad_name_"), "bad name!");

  const response: GeminiResponse = {
    candidates: [{
      content: { parts: [{ functionCall: { name: "bad_name_", args: { a: 1 } } }] },
      finishReason: "STOP",
    }],
  };
  const message = toAnthropicResponse(response, "gemini-2.5-pro", toolNames);
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.content[0]?.type, "tool_use");
  assert.equal(message.content[0]?.name, "bad name!");
  assert.deepEqual(message.content[0]?.input, { a: 1 });
});

test("Gemini 响应转换回 Anthropic message：跳过 thought、合并文本、统计用量", () => {
  const response: GeminiResponse = {
    candidates: [{
      content: {
        parts: [
          { text: "先想一下。", thought: true },
          { text: "你好" },
          { text: "，世界" },
          { functionCall: { name: "Bash", args: { command: "ls" } } },
        ],
      },
      finishReason: "STOP",
    }],
    usageMetadata: {
      promptTokenCount: 100,
      cachedContentTokenCount: 40,
      candidatesTokenCount: 12,
      thoughtsTokenCount: 3,
    },
  };
  const message = toAnthropicResponse(response, "gemini-2.5-pro", new Map());
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content[0], { type: "text", text: "你好，世界" });
  assert.equal(message.content[1]?.type, "tool_use");
  assert.equal(message.content[1]?.name, "Bash");
  assert.deepEqual(message.usage, {
    input_tokens: 60,
    output_tokens: 15,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
  });
});

test("被安全策略拦截时返回可读文本，而不是空消息", () => {
  const response: GeminiResponse = {
    candidates: [{ finishReason: "SAFETY" }],
    promptFeedback: { blockReason: "SAFETY" },
  };
  const message = toAnthropicResponse(response, "gemini-2.5-pro", new Map());
  assert.equal(message.stop_reason, "end_turn");
  assert.match(message.content[0]?.text ?? "", /SAFETY/);
});

test("流式翻译输出 Anthropic SSE：文本增量、工具调用和停止原因", () => {
  const translator = new AnthropicStreamTranslator("gemini-2.5-pro", 10, new Map([["Read", "Read"]]));
  let sse = translator.start();
  sse += translator.push({ candidates: [{ content: { parts: [{ text: "Hel" }] } }] });
  sse += translator.push({ candidates: [{ content: { parts: [{ text: "lo" }] } }] });
  sse += translator.push({
    candidates: [{
      content: { parts: [{ functionCall: { name: "Read", args: { path: "/a" } } }] },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
  });
  sse += translator.finish();

  const events = parseEvents(sse);
  assert.deepEqual(events.map((event) => event.event), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);

  const start = events[0]?.data as { message: { id: string; usage: { input_tokens: number } } };
  assert.match(start.message.id, /^msg_/);
  assert.equal(start.message.usage.input_tokens, 10);

  const firstDelta = events[2]?.data as { delta: { type: string; text: string } };
  assert.deepEqual(firstDelta.delta, { type: "text_delta", text: "Hel" });
  const secondDelta = events[3]?.data as { delta: { type: string; text: string } };
  assert.deepEqual(secondDelta.delta, { type: "text_delta", text: "lo" });

  const toolStart = events[5]?.data as {
    content_block: { type: string; id: string; name: string; input: unknown };
  };
  assert.equal(toolStart.content_block.type, "tool_use");
  assert.match(toolStart.content_block.id, /^toolu_/);
  assert.equal(toolStart.content_block.name, "Read");
  const toolDelta = events[6]?.data as { delta: { type: string; partial_json: string } };
  assert.equal(toolDelta.delta.type, "input_json_delta");
  assert.deepEqual(JSON.parse(toolDelta.delta.partial_json), { path: "/a" });

  const delta = events[8]?.data as {
    delta: { stop_reason: string };
    usage: { input_tokens: number; output_tokens: number };
  };
  assert.equal(delta.delta.stop_reason, "tool_use");
  assert.equal(delta.usage.input_tokens, 10);
  assert.equal(delta.usage.output_tokens, 2);
});

test("流式翻译在安全拦截时输出提示文本", () => {
  const translator = new AnthropicStreamTranslator("gemini-2.5-pro", 1, new Map());
  let sse = translator.start();
  sse += translator.push({ promptFeedback: { blockReason: "SAFETY" }, candidates: [] });
  sse += translator.finish();
  const events = parseEvents(sse);
  const delta = events.find((event) => event.event === "content_block_delta")?.data as
    | { delta: { text: string } }
    | undefined;
  assert.match(delta?.delta.text ?? "", /SAFETY/);
});

test("max_tokens 停止原因映射为 max_tokens", () => {
  const response: GeminiResponse = {
    candidates: [{ content: { parts: [{ text: "截断" }] }, finishReason: "MAX_TOKENS" }],
  };
  assert.equal(
    toAnthropicResponse(response, "gemini-2.5-pro", new Map()).stop_reason,
    "max_tokens",
  );
});
