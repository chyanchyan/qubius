import assert from "node:assert/strict";
import test from "node:test";
import { createFailureLimiter } from "./lan-proxy-limit.mjs";

function makeLimiter(overrides = {}) {
  let current = 0;
  const limiter = createFailureLimiter({
    maxFailures: 3,
    windowMs: 10_000,
    lockMs: 5_000,
    now: () => current,
    ...overrides,
  });
  return {
    limiter,
    advance(ms) {
      current += ms;
    },
  };
}

test("不到失败阈值时放行", () => {
  const { limiter } = makeLimiter();
  limiter.fail("10.0.0.1");
  limiter.fail("10.0.0.1");

  assert.deepEqual(limiter.check("10.0.0.1"), { allowed: true });
  assert.equal(limiter.size(), 1);
});

test("达到失败阈值后锁定", () => {
  const { limiter } = makeLimiter();
  limiter.fail("10.0.0.1");
  limiter.fail("10.0.0.1");
  limiter.fail("10.0.0.1");

  const result = limiter.check("10.0.0.1");
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfter, 5);
});

test("retryAfter 按剩余锁定时间向上取整", () => {
  const { limiter, advance } = makeLimiter();
  for (let i = 0; i < 3; i += 1) limiter.fail("10.0.0.1");

  advance(1);
  assert.equal(limiter.check("10.0.0.1").retryAfter, 5);

  advance(1_399);
  assert.equal(limiter.check("10.0.0.1").retryAfter, 4);

  advance(3_600);
  assert.deepEqual(limiter.check("10.0.0.1"), { allowed: true });
});

test("锁定过期后自动恢复并清除记录", () => {
  const { limiter, advance } = makeLimiter();
  for (let i = 0; i < 3; i += 1) limiter.fail("10.0.0.1");
  assert.equal(limiter.check("10.0.0.1").allowed, false);

  advance(5_000);
  assert.deepEqual(limiter.check("10.0.0.1"), { allowed: true });
  assert.equal(limiter.size(), 0);
});

test("认证成功清除该 IP 的失败记录", () => {
  const { limiter } = makeLimiter();
  limiter.fail("10.0.0.1");
  limiter.fail("10.0.0.1");
  limiter.succeed("10.0.0.1");

  assert.deepEqual(limiter.check("10.0.0.1"), { allowed: true });
  assert.equal(limiter.size(), 0);

  limiter.fail("10.0.0.1");
  limiter.fail("10.0.0.1");
  assert.equal(limiter.check("10.0.0.1").allowed, true);
});

test("窗口外的旧失败不计入阈值", () => {
  const { limiter, advance } = makeLimiter();
  limiter.fail("10.0.0.1");
  advance(6_000);
  limiter.fail("10.0.0.1");

  advance(4_000);
  limiter.fail("10.0.0.1");
  assert.equal(limiter.check("10.0.0.1").allowed, true);

  advance(1);
  limiter.fail("10.0.0.1");
  assert.equal(limiter.check("10.0.0.1").allowed, false);
});

test("不同 IP 的失败记录互不影响", () => {
  const { limiter } = makeLimiter();
  for (let i = 0; i < 3; i += 1) limiter.fail("10.0.0.1");

  assert.equal(limiter.check("10.0.0.1").allowed, false);
  assert.deepEqual(limiter.check("10.0.0.2"), { allowed: true });
});

test("超过 maxEntries 时淘汰最久未活动的记录", () => {
  const { limiter } = makeLimiter({ maxEntries: 2 });
  limiter.fail("10.0.0.1");
  limiter.fail("10.0.0.2");
  limiter.fail("10.0.0.3");

  assert.equal(limiter.size(), 2);
  // 10.0.0.1 已被淘汰；check 不会重新创建记录。
  assert.deepEqual(limiter.check("10.0.0.1"), { allowed: true });
  assert.equal(limiter.size(), 2);

  limiter.fail("10.0.0.4");
  assert.equal(limiter.size(), 2);
  assert.deepEqual(limiter.check("10.0.0.2"), { allowed: true });
});

test("check 清理其他已过期的记录", () => {
  const { limiter, advance } = makeLimiter();
  limiter.fail("10.0.0.1");
  advance(10_000);
  limiter.fail("10.0.0.2");

  assert.equal(limiter.size(), 1);
  assert.deepEqual(limiter.check("10.0.0.2"), { allowed: true });
});
