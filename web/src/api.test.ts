import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundTask,
  clampMaxConcurrent,
  DEFAULT_MAX_CONCURRENT,
  ensureApiTokenCookie,
  getTaskOutput,
  parseMaxConcurrentInput,
  request,
  saveMaxConcurrent,
  stopBackgroundTask,
  UNAUTHORIZED_EVENT,
  writeApiToken,
} from "./api";

/**
 * 无 DOM 的 api 测试：mock global fetch，只覆盖 request 的响应/错误/取消语义。
 * Node 22 自带 fetch/Response，不需要引入新依赖。
 */

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  // 测试环境没有 window/localStorage，writeApiToken 会退回模块内存，这里同样用它清理。
  writeApiToken("");
});

function respond(body: BodyInit | null, init: ResponseInit): typeof fetch {
  return async () => new Response(body, init);
}

/**
 * 永不返回、只在 signal 被取消时 reject 的 fetch，用来验证超时/取消。
 * AbortSignal.timeout 的计时器本身是 unref 的，光靠它会先耗尽事件循环；
 * 这里保留一个 ref 的计时器，signal 一取消就清掉。
 */
function hangingFetch(): typeof fetch {
  return (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const keepAlive = setTimeout(() => {}, 5_000);
      const abort = () => {
        clearTimeout(keepAlive);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
}

test("非 JSON 的 502 回退为状态码文案", async () => {
  globalThis.fetch = respond("Bad Gateway", {
    status: 502,
    headers: { "content-type": "text/html" },
  });

  await assert.rejects(request("/api/x"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "请求失败（502）");
    return true;
  });
});

test("2xx 但非 JSON 响应报可读错误", async () => {
  globalThis.fetch = respond("not json", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });

  await assert.rejects(request("/api/x"), /服务器返回了无法解析的响应/);
});

test("空 body 的 2xx 响应返回空对象", async () => {
  globalThis.fetch = respond(null, { status: 200 });

  const data = await request<Record<string, unknown>>("/api/x");
  assert.deepEqual(data, {});
});

test("超过 timeoutMs 时抛出 TimeoutError", { timeout: 1_000 }, async () => {
  globalThis.fetch = hangingFetch();

  await assert.rejects(request("/api/x", undefined, undefined, 20), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "TimeoutError");
    assert.match(error.message, /请求超时/);
    return true;
  });
});

test("clampMaxConcurrent 把任意值夹到 1..256，非法值退回默认", () => {
  assert.equal(clampMaxConcurrent(8), 8);
  assert.equal(clampMaxConcurrent(0), 1);
  assert.equal(clampMaxConcurrent(257), 256);
  assert.equal(clampMaxConcurrent(3.6), 4);
  assert.equal(clampMaxConcurrent(Number.NaN), DEFAULT_MAX_CONCURRENT);
  assert.equal(clampMaxConcurrent("9"), DEFAULT_MAX_CONCURRENT);
  assert.equal(clampMaxConcurrent(undefined), DEFAULT_MAX_CONCURRENT);
});

test("parseMaxConcurrentInput 只接受 1..256 的整数字符串", () => {
  assert.equal(parseMaxConcurrentInput("8"), 8);
  assert.equal(parseMaxConcurrentInput(" 16 "), 16);
  assert.equal(parseMaxConcurrentInput("1"), 1);
  assert.equal(parseMaxConcurrentInput("256"), 256);
  assert.equal(parseMaxConcurrentInput("0"), null);
  assert.equal(parseMaxConcurrentInput("257"), null);
  assert.equal(parseMaxConcurrentInput("3.6"), null);
  assert.equal(parseMaxConcurrentInput("-1"), null);
  assert.equal(parseMaxConcurrentInput("1e2"), null);
  assert.equal(parseMaxConcurrentInput(""), null);
  assert.equal(parseMaxConcurrentInput("  "), null);
});

test("saveMaxConcurrent 只提交并发上限补丁", async () => {
  let method = "";
  let body: unknown = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    method = init?.method ?? "";
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ providers: [], effort: "high", maxConcurrent: 7 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const saved = await saveMaxConcurrent(7);
  assert.equal(method, "PUT");
  assert.deepEqual(body, { maxConcurrent: 7 });
  assert.equal(saved.maxConcurrent, 7);
});

test("调用方 signal 取消优先于超时", { timeout: 1_000 }, async () => {
  globalThis.fetch = hangingFetch();
  const controller = new AbortController();
  const reason = new Error("用户取消");
  controller.abort(reason);

  await assert.rejects(request("/api/x", undefined, controller.signal, 10_000), (error: unknown) => {
    assert.equal(error, reason);
    return true;
  });
});

test("getTaskOutput 编码路径参数并解析输出尾部", async () => {
  let called = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    called = String(input);
    return new Response(JSON.stringify({ output: "100%\n", totalBytes: 4096, truncated: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const data = await getTaskOutput("sess 1", "task/1?x=2");

  assert.equal(called, "/api/sessions/sess%201/tasks/task%2F1%3Fx%3D2/output");
  assert.deepEqual(data, { output: "100%\n", totalBytes: 4096, truncated: true });
});

test("getTaskOutput 编码中文 taskId，使用 GET 且没有 body", async () => {
  let called = "";
  let init: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    called = String(input);
    init = options;
    return new Response(JSON.stringify({ output: "", totalBytes: 0, truncated: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await getTaskOutput("会话 1", "任务-中文");

  assert.equal(
    called,
    "/api/sessions/%E4%BC%9A%E8%AF%9D%201/tasks/%E4%BB%BB%E5%8A%A1-%E4%B8%AD%E6%96%87/output",
  );
  assert.equal(init?.method ?? "GET", "GET");
  assert.equal(init?.body, undefined);
});

test("backgroundTask 以 POST 发送 toolUseId 并返回 backgrounded", async () => {
  let called = "";
  let init: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    called = String(input);
    init = options;
    return new Response(JSON.stringify({ ok: true, backgrounded: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const data = await backgroundTask("sess", "toolu/1");

  assert.equal(called, "/api/sessions/sess/tasks/background");
  assert.equal(init?.method, "POST");
  assert.equal(init?.body, JSON.stringify({ toolUseId: "toolu/1" }));
  assert.deepEqual(data, { ok: true, backgrounded: true });
});

test("stopBackgroundTask 以 POST 调用停止接口并编码 taskId", async () => {
  let called = "";
  let init: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    called = String(input);
    init = options;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const data = await stopBackgroundTask("sess", "task/1");

  assert.equal(called, "/api/sessions/sess/tasks/task%2F1/stop");
  assert.equal(init?.method, "POST");
  assert.deepEqual(data, { ok: true });
});

test("writeApiToken 在无 window/localStorage 的环境里不抛错，并让 request 带上令牌头", async () => {
  writeApiToken("  secret-token  ");
  let headers: Headers | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await request("/api/x");

  assert.equal(headers?.get("X-Qubius-Token"), "secret-token");
});

test("401 在抛出前保留 status，错误文案来自响应体", async () => {
  globalThis.fetch = respond(JSON.stringify({ error: "需要访问令牌" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

  await assert.rejects(request("/api/x"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "需要访问令牌");
    assert.equal((error as { status?: number }).status, 401);
    return true;
  });
});

test("401 在 reject 前派发 qubius:unauthorized", async () => {
  const events: string[] = [];
  const globalRecord = globalThis as unknown as { window?: unknown };
  const previousWindow = globalRecord.window;
  globalRecord.window = {
    dispatchEvent(event: Event) {
      events.push(event.type);
      return true;
    },
  };
  try {
    globalThis.fetch = respond(JSON.stringify({ error: "需要访问令牌" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

    await assert.rejects(request("/api/x"), (error: unknown) => {
      // reject 回调执行时事件已经派发，status 也已经在错误上。
      assert.deepEqual(events, [UNAUTHORIZED_EVENT]);
      assert.equal((error as { status?: number }).status, 401);
      return true;
    });
  } finally {
    if (previousWindow === undefined) delete globalRecord.window;
    else globalRecord.window = previousWindow;
  }
});

test("ensureApiTokenCookie 在无 document 的环境也能安全执行", () => {
  // 没有 document 时只写内存；这里只要求不抛错，也不依赖真实 cookie。
  assert.doesNotThrow(() => ensureApiTokenCookie());
  writeApiToken("cookie-token");
  assert.doesNotThrow(() => ensureApiTokenCookie());
});

test("writeApiToken 种 cookie：Path/SameSite、https 才加 Secure、空值带 Max-Age=0", () => {
  const written: string[] = [];
  const globalRecord = globalThis as unknown as { window?: unknown; document?: unknown };
  const previousWindow = globalRecord.window;
  const previousDocument = globalRecord.document;
  globalRecord.document = {
    get cookie() {
      return "";
    },
    set cookie(value: string) {
      written.push(value);
    },
  };
  try {
    globalRecord.window = { location: { protocol: "http:" } };
    writeApiToken("tok en");
    assert.equal(written[0], "qubius_token=tok%20en; Path=/; SameSite=Strict");

    globalRecord.window = { location: { protocol: "https:" } };
    writeApiToken("tok en");
    assert.equal(written[1], "qubius_token=tok%20en; Path=/; SameSite=Strict; Secure");

    globalRecord.window = { location: { protocol: "http:" } };
    writeApiToken("");
    assert.equal(written[2], "qubius_token=; Path=/; SameSite=Strict; Max-Age=0");
  } finally {
    if (previousWindow === undefined) delete globalRecord.window;
    else globalRecord.window = previousWindow;
    if (previousDocument === undefined) delete globalRecord.document;
    else globalRecord.document = previousDocument;
  }
});

test("任务接口非 2xx 沿用 request 的错误语义", async () => {
  globalThis.fetch = respond(JSON.stringify({ error: "任务不存在" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

  await assert.rejects(getTaskOutput("sess", "task"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "任务不存在");
    assert.equal((error as { status?: number }).status, 404);
    return true;
  });
});
