import { normalizeProxyUrl, shouldBypassProxy, systemProxy } from "./system-proxy.js";
import type { ProxySettings } from "./types.js";

/**
 * 按用户配置的域名白名单决定某个上游请求走不走代理。
 *
 * 路由只由设置页「代理」里的配置决定，不再依赖服务进程的代理环境变量：
 * 白名单命中的目标使用设置里填写的代理地址；没填时回退到系统代理
 * （Windows Internet 选项，或 QUBIUS_PROXY / HTTPS_PROXY 等环境变量）。
 */

export interface ResolvedProxy {
  /** 已补全协议的代理地址。 */
  url: string;
  /** 系统代理的绕过列表（来自 NO_PROXY / ProxyOverride）。 */
  bypass: string[];
}

/** 解析当前可用的代理：配置地址优先，留空时读取系统代理。 */
export function resolveProxy(settings: ProxySettings | undefined): ResolvedProxy | undefined {
  const configured = settings?.url?.trim();
  if (configured) {
    const url = normalizeProxyUrl(configured);
    return url ? { url, bypass: [] } : undefined;
  }
  return systemProxy();
}

/**
 * 目标地址应该使用的代理地址；不在白名单里、不是 http(s)、或落在
 * 回环/内网与系统绕过列表里时返回 undefined（调用方直连）。
 */
export function proxyUrlForTarget(
  target: string,
  settings: ProxySettings | undefined,
  resolved: ResolvedProxy | undefined = resolveProxy(settings),
): string | undefined {
  if (!resolved) return undefined;
  const host = targetHost(target);
  if (!host) return undefined;
  if (!matchesProxyDomain(host, settings?.domains ?? [])) return undefined;
  if (shouldBypassProxy(target, resolved.bypass)) return undefined;
  return resolved.url;
}

/** 目标是否在白名单里（不判断代理是否可用）。 */
export function targetMatchesProxyDomains(target: string, settings: ProxySettings | undefined): boolean {
  const host = targetHost(target);
  return host ? matchesProxyDomain(host, settings?.domains ?? []) : false;
}

/**
 * 域名是否命中白名单：支持精确域名和 `*.example.com`。
 * `*.example.com` 同时匹配主域名 example.com 和它的所有子域名。
 */
export function matchesProxyDomain(hostname: string, domains: string[]): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  for (const raw of domains) {
    const pattern = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!pattern) continue;
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      if (!suffix) continue;
      if (host === suffix || host.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (host === pattern) return true;
  }
  return false;
}

function targetHost(target: string): string | undefined {
  try {
    const url = new URL(target);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return undefined;
  }
}
