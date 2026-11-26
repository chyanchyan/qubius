import { subscribePush, unsubscribePush, type PushSubscriptionPayload } from "./api";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * 推送相关的浏览器能力检测。顶层不访问 navigator / Notification，
 * 保证在 Node 里 import 这个模块不会报错。
 */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined" &&
    typeof Notification !== "undefined" &&
    typeof Notification.requestPermission === "function"
  );
}

/** 不支持时抛出中文错误。抽成纯函数便于测试，也避免依赖浏览器全局。 */
export function assertPushSupported(supported: boolean): void {
  if (supported) return;
  throw new Error("当前浏览器不支持推送通知（需要 Service Worker、PushManager 和 Notification）。iPhone 需要 iOS 16.4 及以上并先从主屏幕打开。");
}

export function getPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/**
 * 把 VAPID 公钥从 base64url 解成 Uint8Array。
 * 手工解码，不依赖 atob / Buffer，URL-safe 字符和缺失的补齐都能处理。
 */
export function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length === 0) throw new Error("推送公钥格式无效");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    const index = BASE64_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("推送公钥格式无效");
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(bytes);
}

/** 比较订阅里已有的 applicationServerKey 与当前 VAPID 公钥是否一致。 */
export function applicationServerKeyMatches(
  current: BufferSource | null | undefined,
  expected: Uint8Array<ArrayBuffer>,
): boolean {
  if (!current) return false;
  const bytes = current instanceof ArrayBuffer
    ? new Uint8Array(current)
    : new Uint8Array(current.buffer, current.byteOffset, current.byteLength);
  if (bytes.byteLength !== expected.byteLength) return false;
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== expected[index]) return false;
  }
  return true;
}

/**
 * 解析通知要打开的地址。只接受同源 URL；畸形 URL、空值和跨域地址
 * 一律回退到站点根路径，保证 notificationclick 不会同步抛错。
 */
export interface NotificationTarget {
  href: string;
  pathname: string;
  origin: string;
}

export function resolveNotificationTarget(raw: unknown, origin: string): NotificationTarget {
  const fallback = new URL("/", origin);
  let parsed: URL | null = null;
  if (typeof raw === "string" && raw) {
    try {
      parsed = new URL(raw, origin);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || parsed.origin !== fallback.origin) parsed = fallback;
  return { href: parsed.href, pathname: parsed.pathname, origin: parsed.origin };
}

/**
 * 从已打开窗口的 URL 里挑选通知目标：必须同源且 pathname 相同。
 * navigate 表示窗口路径相同但 URL 不完全一致（query/hash），需要先跳转。
 * 返回 null 表示没有匹配窗口，调用方应 openWindow。
 */
export function pickNotificationWindow(
  clientUrls: readonly string[],
  target: NotificationTarget,
): { index: number; navigate: boolean } | null {
  for (let index = 0; index < clientUrls.length; index++) {
    let clientUrl: URL;
    try {
      clientUrl = new URL(clientUrls[index]);
    } catch {
      continue;
    }
    if (clientUrl.origin !== target.origin) continue;
    if (clientUrl.pathname !== target.pathname) continue;
    return { index, navigate: clientUrl.href !== target.href };
  }
  return null;
}

// 同一页面里只注册一次；后续调用复用同一个 promise，避免重复 getRegistration/register。
let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;

/** 注册 service worker 并等待它进入 active 状态。 */
export async function getRegistration(): Promise<ServiceWorkerRegistration> {
  if (!registrationPromise) {
    registrationPromise = (async () => {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        throw new Error("当前浏览器不支持 Service Worker，无法使用推送通知");
      }
      await navigator.serviceWorker.register("/sw.js");
      return navigator.serviceWorker.ready;
    })().catch((reason: unknown) => {
      // 注册失败不缓存，下次调用可以重新尝试。
      registrationPromise = null;
      throw reason;
    });
  }
  return registrationPromise;
}

function toPayload(subscription: PushSubscription): PushSubscriptionPayload {
  const json = subscription.toJSON();
  const endpoint = json.endpoint ?? subscription.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new Error("浏览器没有返回完整的推送订阅，请重试");
  }
  return { endpoint, keys: { p256dh, auth } };
}

async function existingSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  if (getPermission() !== "granted") {
    // 未授权：不要注册 SW，但已有注册仍可用于展示/清理旧订阅。
    const existing = await navigator.serviceWorker.getRegistration();
    return existing ? existing.pushManager.getSubscription() : null;
  }
  const registration = await getRegistration();
  return registration.pushManager.getSubscription();
}

/**
 * 开启推送：申请通知权限（必须在用户点击的事件里调用）→ 复用或创建
 * PushSubscription → 上报服务端保存。
 */
export async function enablePush(publicKey: string): Promise<PushSubscriptionPayload> {
  assertPushSupported(pushSupported());
  if (!publicKey) throw new Error("缺少推送公钥，请刷新页面后重试");

  const permission = await Notification.requestPermission();
  if (permission === "denied") {
    throw new Error("通知权限已被拒绝，请在浏览器或系统设置里允许本站通知后重试");
  }
  if (permission !== "granted") {
    throw new Error("未获得通知权限，无法开启推送");
  }

  const registration = await getRegistration();
  const applicationServerKey = base64UrlToUint8Array(publicKey);
  let subscription = await registration.pushManager.getSubscription();

  // 服务端 VAPID 公钥重新生成后，旧订阅仍然存在但发不出去；先取消再重建。
  if (subscription && !applicationServerKeyMatches(subscription.options?.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }

  const payload = toPayload(subscription);
  await subscribePush(payload);
  return payload;
}

/** 关闭推送：先让服务端删掉订阅，再取消浏览器订阅。 */
export async function disablePush(): Promise<void> {
  const subscription = await existingSubscription();
  if (!subscription) return;
  await unsubscribePush(subscription.endpoint);
  await subscription.unsubscribe();
}

/** 当前浏览器的订阅，供设置页展示状态。 */
export async function currentSubscription(): Promise<PushSubscriptionPayload | null> {
  const subscription = await existingSubscription();
  return subscription ? toPayload(subscription) : null;
}
