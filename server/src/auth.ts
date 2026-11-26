import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { AppConfig } from "./config.js";

/** 自动生成的令牌落在 dataDir/auth-token，权限 0600。 */
export const AUTH_TOKEN_FILE = "auth-token";

const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 512;

/** 读取时与 config.ts 的 bootstrapEnv 语义一致：QUBIUS_* 优先，回退旧名；空串视为未设置。 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value !== undefined && value !== "") return value;
  if (name.startsWith("QUBIUS_")) {
    const legacy = env[`REMOTE_CODER_${name.slice("QUBIUS_".length)}`];
    if (legacy !== undefined && legacy !== "") return legacy;
  }
  return undefined;
}

function readTokenFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    // 文件不存在是正常的首次启动；权限等错误必须显式失败，不能静默跳过认证。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validateToken(token: string, label: string): string {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`${label}至少 ${MIN_TOKEN_LENGTH} 个字符`);
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new Error(`${label}最多 ${MAX_TOKEN_LENGTH} 个字符`);
  }
  return token;
}

function chmodQuietly(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // 某些文件系统（或 Windows）不支持 chmod；不影响令牌本身。
  }
}

/**
 * 解析实际使用的 API 令牌：
 * 1. auth=false 显式关闭认证，即使环境变量里配了令牌也不启用；
 * 2. 显式配置（YAML 或环境变量）优先，长度必须在 16 到 512 之间；
 * 3. auth=true 时读取 dataDir/auth-token（同样校验长度），不存在则生成并落盘；
 * 4. 否则不启用令牌，返回 undefined。
 */
export function resolveAuthToken(
  config: Pick<AppConfig, "auth" | "authToken" | "dataDir">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (config.auth === false) return undefined;
  const explicit = config.authToken?.trim() || envValue(env, "QUBIUS_AUTH_TOKEN")?.trim();
  if (explicit) return validateToken(explicit, "authToken ");
  if (config.auth !== true) return undefined;

  const file = path.join(config.dataDir, AUTH_TOKEN_FILE);
  // dataDir 可能是旧版本创建的，权限不一定足够收紧；尽力补一次。
  chmodQuietly(config.dataDir, 0o700);
  const existing = readTokenFile(file);
  if (existing !== undefined) {
    // 已有文件也要校验，避免手工写入了过短/过长的弱令牌被静默接受。
    const token = validateToken(existing.trim(), "auth-token 文件中的令牌");
    chmodQuietly(file, 0o600);
    return token;
  }

  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodQuietly(config.dataDir, 0o700);
  try {
    // wx：两个进程同时首启时只有一个能创建成功，另一个读取胜者的令牌。
    fs.writeFileSync(file, token, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = readTokenFile(file);
    if (raced === undefined) throw new Error(`无法读取自动生成的令牌文件 ${file}`);
    const existingToken = validateToken(raced.trim(), "auth-token 文件中的令牌");
    chmodQuietly(file, 0o600);
    return existingToken;
  }
  chmodQuietly(file, 0o600);
  return token;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // 编码不合法时按原值处理，让后续比较自然失败，而不是抛异常。
    return value;
  }
}

/** 从 Cookie 头里取指定名字的第一个值；没有时返回 undefined。 */
export function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1);
  }
  return undefined;
}

/**
 * 依次从 `x-qubius-token`、`Authorization: Bearer`、cookie `qubius_token` 取令牌。
 * 都没有时返回空串，交由 tokenMatches 判为不匹配。
 */
export function tokenFromRequest(req: IncomingMessage): string {
  const direct = headerValue(req.headers["x-qubius-token"]).trim();
  if (direct) return direct;

  const authorization = headerValue(req.headers.authorization).trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  const fromBearer = bearer?.[1]?.trim();
  if (fromBearer) return fromBearer;

  const cookie = parseCookie(headerValue(req.headers.cookie), "qubius_token");
  if (cookie !== undefined) {
    const decoded = decodeCookieValue(cookie).trim();
    if (decoded) return decoded;
  }
  return "";
}

/** 常量时间比较；长度不同直接失败，避免 timingSafeEqual 对长度敏感。 */
export function tokenMatches(expected: string, provided: string): boolean {
  if (!expected || !provided) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(provided, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
