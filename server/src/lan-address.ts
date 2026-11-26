import net from "node:net";
import os from "node:os";

/**
 * 服务端的局域网地址解析，规则与 deploy/deploy-lib.mjs 的 lanAddress() 保持一致
 * （同一台机器上的 lan-proxy 与部署页/凭据重置必须解析出同一个地址）：
 * - 只把私有/CGNAT/链路本地 IPv4 当作可自动选用的局域网地址；
 * - 显式 LAN_PROXY_HOST > QUBIUS_LAN_HOST > 自动选择；
 * - 自动选择优先级 private > shared(CGNAT) > link-local；
 * - 显式公网/回环/0.0.0.0/`::` 等允许但告警，非法值报错。
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 点分十进制 IPv4 -> 32 位无符号整数；非法地址（含前导零写法）返回 null。 */
function ipv4ToInt(address: string): number | null {
  const text = String(address).trim();
  const match = IPV4_RE.exec(text);
  if (!match) return null;
  const parts = match.slice(1);
  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  // 拒绝 "010.0.0.1" 这类写法：不同工具可能按八进制解析，导致分类和实际不一致。
  if (parts.some((part) => part.length > 1 && part.startsWith("0"))) return null;
  const [a, b, c, d] = octets as [number, number, number, number];
  return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;
}

function ipv4InRange(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((value & mask) >>> 0) === ((network & mask) >>> 0);
}

const IPV4_RANGES: Array<[string, number, number]> = [
  ["unspecified", ipv4ToInt("0.0.0.0")!, 8],
  ["loopback", ipv4ToInt("127.0.0.0")!, 8],
  ["private", ipv4ToInt("10.0.0.0")!, 8],
  ["private", ipv4ToInt("172.16.0.0")!, 12],
  ["private", ipv4ToInt("192.168.0.0")!, 16],
  ["shared", ipv4ToInt("100.64.0.0")!, 10],
  ["link-local", ipv4ToInt("169.254.0.0")!, 16],
  ["multicast", ipv4ToInt("224.0.0.0")!, 4],
  ["reserved", ipv4ToInt("240.0.0.0")!, 4],
  ["reserved", ipv4ToInt("192.0.0.0")!, 24],
  ["reserved", ipv4ToInt("192.0.2.0")!, 24],
  ["reserved", ipv4ToInt("198.18.0.0")!, 15],
  ["reserved", ipv4ToInt("198.51.100.0")!, 24],
  ["reserved", ipv4ToInt("203.0.113.0")!, 24],
];

export type IPv4Category =
  | "invalid"
  | "unspecified"
  | "loopback"
  | "private"
  | "shared"
  | "link-local"
  | "multicast"
  | "reserved"
  | "public";

/** IPv4 分类，规则与 deploy/deploy-lib.mjs 相同。 */
export function classifyIPv4(address: string): IPv4Category {
  const value = ipv4ToInt(address);
  if (value === null) return "invalid";
  for (const [category, network, prefix] of IPV4_RANGES) {
    if (ipv4InRange(value, network, prefix)) return category as IPv4Category;
  }
  return "public";
}

const LAN_IPV4_PRIORITY: Partial<Record<IPv4Category, number>> = {
  private: 0,
  shared: 1,
  "link-local": 2,
};

/** 是否是可自动选用的局域网 IPv4（私有 / CGNAT / 链路本地）。 */
export function isLanIPv4(address: string): boolean {
  return LAN_IPV4_PRIORITY[classifyIPv4(address)] !== undefined;
}

// RFC 1123 主机名：标签只含字母数字和连字符，不以连字符开头/结尾，可带结尾点。
const HOSTNAME_RE = /^(?=.{1,253}\.?$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/;

/** 显式监听地址：合法 IPv4/IPv6 或主机名；像 IPv4 但越界/前导零的写法直接拒绝。 */
function isValidListenHost(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (net.isIP(text) !== 0) return true;
  if (/^[0-9.]+$/.test(text)) return false;
  return HOSTNAME_RE.test(text);
}

const warnedHosts = new Set<string>();

function explicitWarning(host: string): string | undefined {
  const version = net.isIP(host);
  if (version === 4) {
    const category = classifyIPv4(host);
    if (category === "public") {
      return `警告：LAN_PROXY_HOST/QUBIUS_LAN_HOST 指定了公网地址 ${host}。`
        + "局域网入口会用明文 HTTP 传输 Basic 凭据，公网可被嗅探或中间人截获；"
        + "请改用私有地址，或把入口放在 TLS/VPN 之后。";
    }
    if (category === "unspecified" || category === "loopback" || category === "multicast" || category === "reserved") {
      return `警告：LAN_PROXY_HOST/QUBIUS_LAN_HOST 指定的 ${host} 不是私有/链路本地地址（${category}），`
        + "局域网其他设备可能无法访问；如只想本机测试可以忽略。";
    }
    return undefined;
  }
  if (version === 6) {
    const normalized = host.toLowerCase();
    if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") {
      return `警告：LAN_PROXY_HOST/QUBIUS_LAN_HOST 指定了通配地址 ${host}，`
        + "会监听所有 IPv6 接口；请确认这是预期行为。";
    }
    if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
      return `警告：LAN_PROXY_HOST/QUBIUS_LAN_HOST 指定了回环地址 ${host}，`
        + "局域网其他设备可能无法访问；如只想本机测试可以忽略。";
    }
  }
  return undefined;
}

export interface LanAddressOptions {
  env?: NodeJS.ProcessEnv;
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** 默认写到 console.warn；测试可注入收集器。 */
  warn?: (text: string) => void;
}

/**
 * 解析局域网绑定地址；找不到自动候选时返回 undefined（显式值非法时仍然抛错）。
 * 需要在调用方合并部署 env 文件里的 LAN_PROXY_HOST/QUBIUS_LAN_HOST。
 */
export function tryLanAddress({
  env = process.env,
  interfaces = os.networkInterfaces(),
  warn = (text) => console.warn(text),
}: LanAddressOptions = {}): string | undefined {
  const explicit = String(env.LAN_PROXY_HOST ?? "").trim() || String(env.QUBIUS_LAN_HOST ?? "").trim();
  if (explicit) {
    if (!isValidListenHost(explicit)) {
      throw new Error(
        `LAN_PROXY_HOST/QUBIUS_LAN_HOST 不是合法的 IP 或主机名：${explicit}（不能含空格或非法字符）`,
      );
    }
    const warning = explicitWarning(explicit);
    if (warning && !warnedHosts.has(explicit)) {
      warnedHosts.add(explicit);
      warn(warning);
    }
    return explicit;
  }

  const skip = /^(lo|docker|br-|veth|virbr|tun|tap|cni)/;
  let best: string | undefined;
  let bestPriority = Infinity;
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (skip.test(name) || !addrs) continue;
    for (const addr of addrs) {
      // 新版 Node 是 "IPv4"，老版本可能是数字 4。
      const family = String(addr.family);
      if ((family !== "IPv4" && family !== "4") || addr.internal) continue;
      const priority = LAN_IPV4_PRIORITY[classifyIPv4(addr.address)];
      if (priority === undefined || priority >= bestPriority) continue;
      best = addr.address;
      bestPriority = priority;
    }
  }
  return best;
}

/** 解析局域网绑定地址；找不到可用地址时抛错，提示显式设置。 */
export function lanAddress(options: LanAddressOptions = {}): string {
  const host = tryLanAddress(options);
  if (!host) {
    throw new Error(
      "找不到可用的局域网 IPv4 地址（只接受 10/8、172.16/12、192.168/16、100.64/10、169.254/16）；"
      + "请用 LAN_PROXY_HOST 或 QUBIUS_LAN_HOST 显式指定",
    );
  }
  return host;
}
