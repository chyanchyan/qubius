/**
 * 服务端发出的上游请求统一走这里。
 *
 * qubius 不管理代理：不读自己的代理设置，也不显式传 dispatcher。出站路由由机器
 * 或部署环境统一决定——服务进程继承的 HTTP(S)_PROXY / NO_PROXY，在 Node 22.21+
 * 配合 NODE_USE_ENV_PROXY=1 时对内置 fetch 生效；没有配置代理时直接连接。
 * 这样代理路由与会话、消息和项目完全解耦，改机器上的代理不需要动 qubius。
 */

export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

export const fetchUpstream: UpstreamFetch = (url, init) => fetch(url, init);
