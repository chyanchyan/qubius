import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "./config.js";
import { createAppServer } from "./http.js";
import { PushService, type PushSender, type PushSubscriptionInput } from "./push.js";
import type { Runtime } from "./runtime.js";
import { Store } from "./store.js";
import type { Effort } from "./types.js";

// 一份格式合法的订阅（值取自 web-push 文档示例），避免测试真的访问推送网络。
const VALID_SUBSCRIPTION: PushSubscriptionInput = {
  endpoint: "https://fcm.googleapis.com/fcm/send/demo-endpoint",
  keys: {
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  },
};

interface Harness {
  url: string;
  dataDir: string;
  store: Store;
  push?: PushService;
  sent: Array<{ subscription: PushSubscriptionInput; payload: string }>;
  close: () => Promise<void>;
}

async function startHarness(options: { withPush?: boolean } = {}): Promise<Harness> {
  const withPush = options.withPush !== false;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-push-http-"));
  const dataDir = path.join(base, "data");
  const projectPath = path.join(base, "project");
  for (const dir of [dataDir, projectPath]) fs.mkdirSync(dir, { recursive: true });
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 1,
    configDir: base,
    role: "primary",
    projects: [
      { id: "p1", name: "项目", path: projectPath, permission: "acceptEdits", isolated: false },
    ],
  };
  const store = new Store(dataDir);
  const runtime = {
    stop: async () => {},
    isShuttingDown: () => false,
  } as unknown as Runtime;
  const sent: Harness["sent"] = [];
  // 注入假发送器，sendTest 只记录调用，不接触真实推送网络。
  const send: PushSender = async (subscription, payload) => {
    sent.push({ subscription, payload });
  };
  const push = withPush ? new PushService(dataDir, { send }) : undefined;
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(base, "web"),
    settings: { current: { providers: [], effort: "high" as Effort, maxConcurrent: 4 } },
    permissions: { current: {} },
    repoRoot: base,
    push,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    dataDir,
    store,
    push,
    sent,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

test("推送接口：公钥、订阅、退订和测试发送", async () => {
  const harness = await startHarness();
  try {
    const initial = await json(`${harness.url}/api/push`);
    assert.equal(initial.status, 200);
    assert.equal(typeof initial.body.publicKey, "string");
    assert.ok(initial.body.publicKey.length > 0);
    assert.equal(initial.body.count, 0);

    const subscribed = await json(`${harness.url}/api/push/subscriptions`, {
      method: "POST",
      body: JSON.stringify(VALID_SUBSCRIPTION),
    });
    assert.equal(subscribed.status, 201);
    assert.deepEqual(subscribed.body, { ok: true, count: 1 });

    const afterSubscribe = await json(`${harness.url}/api/push`);
    assert.equal(afterSubscribe.status, 200);
    assert.equal(afterSubscribe.body.count, 1);

    const invalid = await json(`${harness.url}/api/push/subscriptions`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /[一-鿿]/);

    const tested = await json(`${harness.url}/api/push/test`, { method: "POST", body: "{}" });
    assert.equal(tested.status, 200);
    assert.deepEqual(tested.body, { ok: true, sent: 1, failed: 0 });
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0]?.subscription.endpoint, VALID_SUBSCRIPTION.endpoint);

    const removed = await json(`${harness.url}/api/push/subscriptions`, {
      method: "DELETE",
      body: JSON.stringify({ endpoint: VALID_SUBSCRIPTION.endpoint }),
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { ok: true, count: 0 });

    const afterDelete = await json(`${harness.url}/api/push`);
    assert.equal(afterDelete.status, 200);
    assert.equal(afterDelete.body.count, 0);
  } finally {
    await harness.close();
  }
});

test("未配置推送服务时推送接口返回 503，其他路由不受影响", async () => {
  const harness = await startHarness({ withPush: false });
  try {
    const status = await json(`${harness.url}/api/push`);
    assert.equal(status.status, 503);
    assert.deepEqual(status.body, { error: "推送未配置" });

    const subscribe = await json(`${harness.url}/api/push/subscriptions`, {
      method: "POST",
      body: JSON.stringify(VALID_SUBSCRIPTION),
    });
    assert.equal(subscribe.status, 503);
    assert.deepEqual(subscribe.body, { error: "推送未配置" });

    const unsubscribe = await json(`${harness.url}/api/push/subscriptions`, {
      method: "DELETE",
      body: JSON.stringify({ endpoint: VALID_SUBSCRIPTION.endpoint }),
    });
    assert.equal(unsubscribe.status, 503);

    const sendTest = await json(`${harness.url}/api/push/test`, { method: "POST", body: "{}" });
    assert.equal(sendTest.status, 503);

    const health = await json(`${harness.url}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
  } finally {
    await harness.close();
  }
});
