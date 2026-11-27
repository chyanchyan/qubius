import { execFileSync } from "node:child_process";

/**
 * 读取系统代理设置。
 *
 * Node 内置 fetch 不会读取 Windows「Internet 设置」里的系统代理，所以勾选了
 * 「走系统代理」的配置需要自己读出来交给 undici 的 ProxyAgent。代理客户端
 * （Veee 等）随时可能开关或换端口，注册表结果只缓存一小段时间，不重启也能跟上。
 */

/** 代理地址和绕过列表；bypass 来自 ProxyOverride 或 NO_PROXY。 */
export interface SystemProxy {
  /** 已补全协议、去掉末尾斜杠的代理地址。 */
  url: string;
  /** 不走代理的主机模式，支持 `*` 通配和 IE 的 `<local>`。 */
  bypass: string[];
}

/** Windows 注册表里读到的原始设置，单独拆出来便于测试。 */
export interface WindowsProxySettings {
  enabled: boolean;
  /** 可能是 `host:port`，也可能是 `http=host:port;https=host:port`。 */
  server: string;
  override: string;
}

export interface SystemProxyOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** 测试注入；默认读取 Windows 注册表。 */
  readRegistry?: () => WindowsProxySettings | undefined;
}

/** QUBIUS_PROXY 留给本服务单独指定，其余按常见约定回退。 */
const PROXY_ENV_NAMES = [
  "QUBIUS_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

const REGISTRY_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
/** 系统代理可能随代理客户端开关变化；缓存 30 秒，避免每次请求都起 reg.exe。 */
const REGISTRY_CACHE_MS = 30_000;

let registryCache: { at: number; value: WindowsProxySettings | undefined } | undefined;

/**
 * 当前生效的系统代理；没有配置或无法解析时返回 undefined（调用方直接连接）。
 * 环境变量优先于 Windows 系统设置，方便临时覆盖。
 */
export function systemProxy(options: SystemProxyOptions = {}): SystemProxy | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  for (const name of PROXY_ENV_NAMES) {
    const value = env[name]?.trim();
    if (!value) continue;
    const url = normalizeProxyUrl(value);
    if (url) {
      return { url, bypass: splitBypass(env.NO_PROXY ?? env.no_proxy ?? "") };
    }
  }

  if (platform !== "win32") return undefined;
  const settings = (options.readRegistry ?? readWindowsProxySettings)();
  if (!settings?.enabled) return undefined;
  const url = proxyUrlFromServer(settings.server);
  if (!url) return undefined;
  return { url, bypass: splitBypass(settings.override) };
}

/** 读取注册表；结果缓存 30 秒。读取失败按「没有代理」处理，不影响直连。 */
export function readWindowsProxySettings(): WindowsProxySettings | undefined {
  const now = Date.now();
  if (registryCache && now - registryCache.at < REGISTRY_CACHE_MS) {
    return registryCache.value;
  }
  let value: WindowsProxySettings | undefined;
  try {
    const output = execFileSync("reg.exe", ["query", REGISTRY_PATH], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
    });
    value = parseRegistryOutput(output);
  } catch {
    value = undefined;
  }
  registryCache = { at: now, value };
  return value;
}

/** 测试用：清掉注册表缓存。 */
export function resetWindowsProxyCache(): void {
  registryCache = undefined;
}

/** 解析 `reg query` 输出；中英文 Windows 都使用 REG_DWORD / REG_SZ 标识。 */
export function parseRegistryOutput(output: string): WindowsProxySettings | undefined {
  const enabled = /ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i.exec(output);
  if (!enabled?.[1]) return undefined;
  const raw = enabled[1];
  const value = Number.parseInt(raw, raw.toLowerCase().startsWith("0x") ? 16 : 10);
  return {
    enabled: value !== 0,
    server: registryString(output, "ProxyServer"),
    override: registryString(output, "ProxyOverride"),
  };
}

function registryString(output: string, name: string): string {
  const match = new RegExp(`${name}\\s+REG_SZ\\s+([^\\r\\n]*)`, "i").exec(output);
  return match?.[1]?.trim() ?? "";
}

/** 从 ProxyServer 值里挑出可用的代理地址：https 优先，其次 http，最后裸地址。 */
export function proxyUrlFromServer(server: string): string | undefined {
  let https: string | undefined;
  let http: string | undefined;
  let plain: string | undefined;
  for (const raw of server.split(";")) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq > 0) {
      const scheme = entry.slice(0, eq).trim().toLowerCase();
      const value = entry.slice(eq + 1).trim();
      if (!value) continue;
      if (scheme === "https") https ??= value;
      else if (scheme === "http") http ??= value;
      continue;
    }
    plain ??= entry;
  }
  return normalizeProxyUrl(https ?? http ?? plain ?? "");
}

/** 补全协议并校验；只支持 HTTP(S) 代理，SOCKS 等其它协议返回 undefined。 */
export function normalizeProxyUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!url.hostname) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** ProxyOverride 用分号，NO_PROXY 常用逗号或空白；统一拆成列表。 */
export function splitBypass(value: string): string[] {
  return value.split(/[;,\s]+/).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * 目标地址是否应该绕开代理。
 *
 * 回环和 RFC1918 内网地址始终直连（代理客户端通常也到不了内网）；其余看
 * ProxyOverride / NO_PROXY，支持 `*` 通配和 IE 的 `<local>`（不带点的主机名）。
 */
export function shouldBypassProxy(target: string, bypass: string[]): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (isPrivateHost(host)) return true;
  for (const raw of bypass) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "<local>") {
      if (!host.includes(".")) return true;
      continue;
    }
    if (entry === "<-loopback>") continue;
    if (wildcardMatch(host, entry)) return true;
  }
  return false;
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  if (host.endsWith(".local")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }
  const match = /^172\.(\d{1,3})\./.exec(host);
  if (match) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function wildcardMatch(host: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(host);
}
