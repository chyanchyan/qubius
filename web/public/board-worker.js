/* 跨标签页共享唯一一条 /api/events(SSE) 看板连接。
 *
 * 浏览器对同一 origin 的 HTTP/1.1 并发连接上限是 6 条；如果每个标签页都
 * 自己 new EventSource("/api/events")，开几个标签就会把连接池占满，后续
 * 的普通请求只能排队，直到 15s 超时——页面表现为一直 loading。
 *
 * SharedWorker 在每个浏览器 profile 里只运行一份，所有标签页通过 MessagePort
 * 订阅同一条流，所以看板连接数恒为 1，与标签页数量无关。页面隐藏/显示不影响
 * 这条连接，后台标签仍能更新标题角标；页面关闭时通知 worker 回收端口。
 */
const ports = new Set();
let source = null;
let sourceStatus = "idle";

function post(port, message) {
  try {
    port.postMessage(message);
  } catch {
    /* 端口已随页面关闭，忽略。 */
  }
}

function broadcast(message) {
  for (const port of ports) post(port, message);
}

function closeSource() {
  if (!source) return;
  source.close();
  source = null;
}

function ensureSource() {
  if (source) return;
  sourceStatus = "connecting";
  broadcast({ type: "status", status: sourceStatus });
  const eventSource = new EventSource("/api/events");
  source = eventSource;
  eventSource.addEventListener("open", () => {
    if (source !== eventSource) return;
    sourceStatus = "live";
    broadcast({ type: "status", status: sourceStatus });
  });
  eventSource.addEventListener("error", () => {
    if (source !== eventSource) return;
    sourceStatus = "error";
    broadcast({ type: "status", status: sourceStatus });
  });
  eventSource.addEventListener("session", (event) => {
    if (source !== eventSource) return;
    broadcast({ type: "event", data: event.data });
  });
}

self.onconnect = (connectEvent) => {
  const port = connectEvent.ports[0];
  ports.add(port);
  port.onmessage = (messageEvent) => {
    const message = messageEvent.data || {};
    if (message.type === "close") {
      ports.delete(port);
      try {
        port.close();
      } catch {
        /* 已关闭。 */
      }
      if (ports.size === 0) {
        closeSource();
        sourceStatus = "idle";
      }
      return;
    }
    if (message.type === "retry") {
      closeSource();
      ensureSource();
      return;
    }
    /* hello：新标签页接入。只把当前状态回给这个订阅者（带 helloId），
       已经 live 时它立刻做一次整表同步，补上接入前错过的事件；不要让
       其它标签页跟着重新拉数据。 */
    ensureSource();
    post(port, { type: "status", status: sourceStatus, helloId: message.helloId });
  };
  ensureSource();
  post(port, { type: "status", status: sourceStatus });
};
