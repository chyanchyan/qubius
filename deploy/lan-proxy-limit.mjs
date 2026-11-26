// Basic 认证失败的按来源 IP 限速。纯内存、无 HTTP 依赖，便于单独测试。
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_LOCK_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

export function createFailureLimiter({
  maxFailures = DEFAULT_MAX_FAILURES,
  windowMs = DEFAULT_WINDOW_MS,
  lockMs = DEFAULT_LOCK_MS,
  now = Date.now,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  // Map 的插入顺序就是最近活动顺序：fail 时把 IP 移到末尾，淘汰时从开头删。
  const records = new Map();

  // 丢掉窗口外的失败，并在锁定到期时清空该 IP 的全部状态。
  function prune(record, t) {
    while (record.failures.length > 0 && t - record.failures[0] >= windowMs) {
      record.failures.shift();
    }
    if (record.lockedUntil > 0 && t >= record.lockedUntil) {
      record.lockedUntil = 0;
      record.failures.length = 0;
    }
    return record.lockedUntil > 0 || record.failures.length > 0;
  }

  // check/fail 时顺带清掉已过期的记录，避免没人访问的 IP 长期占内存。
  function sweep(t) {
    for (const [ip, record] of records) {
      if (!prune(record, t)) records.delete(ip);
    }
  }

  function check(ip) {
    const t = now();
    sweep(t);
    const record = records.get(ip);
    if (!record || record.lockedUntil <= t) return { allowed: true };
    return {
      allowed: false,
      retryAfter: Math.ceil((record.lockedUntil - t) / 1000),
    };
  }

  function fail(ip) {
    const t = now();
    sweep(t);

    let record = records.get(ip);
    if (!record) {
      record = { failures: [], lockedUntil: 0 };
      records.set(ip, record);
    }
    // check 已经在锁定期间挡掉了请求，这里的判断只防并发竞态。
    if (record.lockedUntil > t) return;

    record.failures.push(t);
    if (record.failures.length >= maxFailures) {
      record.lockedUntil = t + lockMs;
    }

    // 刷新为最近活动，maxEntries 淘汰时优先丢弃最久没失败的 IP。
    records.delete(ip);
    records.set(ip, record);

    while (records.size > maxEntries) {
      const oldest = records.keys().next().value;
      records.delete(oldest);
    }
  }

  function succeed(ip) {
    records.delete(ip);
  }

  function size() {
    return records.size;
  }

  return { check, fail, succeed, size };
}
