import { Agent, ProxyAgent, type Dispatcher } from "undici";

/**
 * 服务端发出的上游请求统一走这里，由调用方按域名白名单决定直连还是代理。
 *
 * 每次都显式传入 dispatcher：服务进程可能带着 NODE_USE_ENV_PROXY / HTTPS_PROXY
 * 等环境变量，不传 dispatcher 时 Node 会自动使用环境代理，从而绕过设置页的
 * 白名单。显式的 Agent 表示直连，ProxyAgent 表示走指定代理。
 */

export type UpstreamFetch = (url: string, init: RequestInit, proxyUrl?: string) => Promise<Response>;

/** 直连连接池；复用连接，避免每次请求重新握手。 */
let directAgent: Agent | undefined;
/** 当前代理地址对应的连接池；地址变化时换新，旧池异步关闭。 */
let cachedProxy: { url: string; dispatcher: ProxyAgent } | undefined;

function directDispatcher(): Dispatcher {
  directAgent ??= new Agent();
  return directAgent;
}

function proxyDispatcher(url: string): Dispatcher {
  if (cachedProxy?.url === url) return cachedProxy.dispatcher;
  if (cachedProxy) void cachedProxy.dispatcher.close().catch(() => undefined);
  cachedProxy = { url, dispatcher: new ProxyAgent(url) };
  return cachedProxy.dispatcher;
}

/** 发往模型/余额等上游的请求；proxyUrl 缺省表示直连。 */
export const fetchUpstream: UpstreamFetch = (url, init, proxyUrl) => {
  const dispatcher = proxyUrl ? proxyDispatcher(proxyUrl) : directDispatcher();
  // Node 的 fetch 运行期支持 undici 的 dispatcher，但 RequestInit 类型里没有。
  return fetch(url, { ...init, dispatcher } as unknown as RequestInit);
};
