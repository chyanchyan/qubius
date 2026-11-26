/* Web Push service worker. 原生 JS，不经构建；只负责接收推送和跳转，
   不拦截 fetch，也不缓存页面资源。 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== "object") payload = {};

  const title = typeof payload.title === "string" && payload.title ? payload.title : "Qubius";
  const body = typeof payload.body === "string" ? payload.body : "";
  const tag = typeof payload.tag === "string" && payload.tag ? payload.tag : undefined;
  const url = typeof payload.url === "string" && payload.url ? payload.url : "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      data: { url },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

/* 只接受同源地址；畸形 URL、空值和跨域地址回退到站点根路径。
   与 push-client.ts 的 resolveNotificationTarget 保持同一语义。 */
function resolveTarget(raw) {
  const fallback = new URL("/", self.location.origin);
  let parsed = null;
  if (typeof raw === "string" && raw) {
    try {
      parsed = new URL(raw, self.location.origin);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || parsed.origin !== fallback.origin) parsed = fallback;
  return parsed;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data;
  const target = resolveTarget(data && data.url);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        let clientUrl;
        try {
          clientUrl = new URL(client.url);
        } catch {
          continue;
        }
        if (clientUrl.origin !== target.origin || clientUrl.pathname !== target.pathname) continue;
        try {
          // pathname 相同但 query/hash 不同（或 SPA 内跳转后 URL 未同步）时先导航。
          // navigate() 返回导航后的新 WindowClient，focus 必须用它而不是旧引用。
          let focused = client;
          if (clientUrl.href !== target.href) {
            const navigated = await client.navigate(target.href);
            if (!navigated) continue;
            focused = navigated;
          }
          await focused.focus();
          return;
        } catch {
          continue;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
