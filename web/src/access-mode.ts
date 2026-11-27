/* 顶栏的访问模式指示。
 *
 * 同一个实例可以同时开放本机、局域网和公网入口，所以这里判断的不是服务端
 * 部署了哪些入口，而是「这次页面是从哪个入口打开的」——浏览器地址栏的主机名
 * 就是最可靠的依据：lan-proxy 只改写上游请求的 Host，地址栏仍是局域网地址。
 */
export type AccessMode = "local" | "lan" | "public";

export const ACCESS_MODE_LABEL: Record<AccessMode, string> = {
  local: "本机访问",
  lan: "局域网访问",
  public: "公网访问",
};

export const ACCESS_MODE_HINT: Record<AccessMode, string> = {
  local: "页面通过本机地址打开",
  lan: "页面通过局域网地址打开",
  public: "页面通过公网地址打开",
};

/** 按浏览器当前访问的主机名判断访问模式。 */
export function accessModeForHost(raw: string | undefined | null): AccessMode {
  let host = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  // 主机名缺失时不能冒充本机入口，按公网处理更保守。
  if (!host) return "public";
  // IPv6 字面量在 URL 里带方括号，location.hostname 不带，两种都兼容。
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  if (host === "localhost" || host.endsWith(".localhost")) return "local";

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    if (ipv4[0] === 127 || (ipv4[0] === 0 && ipv4[1] === 0 && ipv4[2] === 0 && ipv4[3] === 0)) {
      return "local";
    }
    return isPrivateIpv4(ipv4) ? "lan" : "public";
  }

  if (host.includes(":")) return ipv6Mode(host);

  // 内网域名和单标签主机名（http://qubius）只会在局域网/内网 DNS 里出现。
  return isPrivateHostName(host) ? "lan" : "public";
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return parts as [number, number, number, number];
}

function isPrivateIpv4(ip: [number, number, number, number]): boolean {
  const [a, b] = ip;
  return a === 10                // 10.0.0.0/8
    || (a === 172 && b >= 16 && b <= 31) // 172.16.0.0/12
    || (a === 192 && b === 168)  // 192.168.0.0/16
    || (a === 169 && b === 254)  // 169.254.0.0/16 链路本地
    || (a === 100 && b >= 64 && b <= 127); // 100.64.0.0/10 CGNAT（含 Tailscale）
}

function ipv6Mode(host: string): AccessMode {
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return "local";
  // IPv4 映射地址（::ffff:192.168.1.5）按内嵌的 IPv4 判断。
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped) return accessModeForHost(mapped[1]);
  // fc00::/7 唯一本地地址、fe80::/10 链路本地地址都属于内网。
  if (host.startsWith("fc") || host.startsWith("fd")) return "lan";
  if (/^fe[89ab]/.test(host)) return "lan";
  return "public";
}

const PRIVATE_SUFFIXES = [".local", ".lan", ".home.arpa", ".internal", ".localdomain"];

function isPrivateHostName(host: string): boolean {
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // 单个标签（没有点）不可能是公网域名。
  return !host.includes(".");
}
