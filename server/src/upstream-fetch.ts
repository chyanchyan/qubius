import { ProxyAgent, type Dispatcher } from "undici";
import { shouldBypassProxy, systemProxy } from "./system-proxy.js";

/**
 * 显式要求走系统代理的上游 fetch。
 *
 * Node 内置 fetch 不读取 Windows 系统代理；调用方勾选了「走系统代理」时改用
 * undici 的 ProxyAgent 发请求。回环和内网地址仍然直连。代理设置变化时自动换
 * 新的 ProxyAgent，不需要重启服务；没有检测到系统代理时退回直连。
 */

export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

interface CachedAgent {
  url: string;
  dispatcher: Dispatcher;
}

let cachedAgent: CachedAgent | undefined;

/** 目标地址对应的代理 dispatcher；不需要代理时返回 undefined。 */
export function proxyDispatcher(target: string): Dispatcher | undefined {
  const proxy = systemProxy();
  if (!proxy) return undefined;
  if (shouldBypassProxy(target, proxy.bypass)) return undefined;
  if (cachedAgent?.url === proxy.url) return cachedAgent.dispatcher;
  if (cachedAgent) void cachedAgent.dispatcher.close().catch(() => undefined);
  cachedAgent = { url: proxy.url, dispatcher: new ProxyAgent(proxy.url) };
  return cachedAgent.dispatcher;
}

export const upstreamFetch: UpstreamFetch = (url, init) => {
  const dispatcher = proxyDispatcher(url);
  if (!dispatcher) return fetch(url, init);
  // Node 的 fetch 运行期支持 undici 的 dispatcher，但 RequestInit 类型里没有。
  return fetch(url, { ...init, dispatcher } as unknown as RequestInit);
};
