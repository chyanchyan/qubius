import fs from "node:fs";
import path from "node:path";

import { canonicalSha256 } from "./canonical.js";
import { parseEdgeEnvDetailed } from "./envfile.js";
import { EdgeError, type EdgeRegistry, type EdgeSecrets } from "./types.js";

/**
 * dev 认证密钥解析。
 *
 * 读取顺序与 python-dotenv 的 override=False 一致：进程 env 优先，其次
 * 注册表同目录的 .env。键名来自 edge.auth.dev.password_hash_env /
 * cookie_secret_env。
 *
 * 校验：
 *   - bcrypt：^\\$2[aby]\\$\\d{2}\\$[./A-Za-z0-9]{53}$
 *   - cookie secret：^[A-Za-z0-9._~-]{16,}$（与 edgectl _SECRET_RE 一致，
 *     拒绝空白/换行/分号/引号/花括号，避免注入 Caddyfile）
 * 任何缺失/格式错误都返回中文错误（抛 EdgeError）。
 *
 * secretsSha 只保存两个值的 sha256 指纹，不保存明文。
 */

const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
/** 与 edgectl 的 _SECRET_RE 对齐：拒绝空白/换行/分号/引号/花括号等。 */
const COOKIE_SECRET_RE = /^[A-Za-z0-9._~-]{16,}$/;
const MIN_COOKIE_SECRET = 16;

export interface LoadSecretsOptions {
  registry: EdgeRegistry;
  env?: NodeJS.ProcessEnv;
  /** 覆盖 .env 路径（测试用）；默认 <registry 目录>/.env。 */
  envFile?: string;
}

export interface RawSecrets {
  passwordHash?: string;
  cookieSecret?: string;
  passwordHashEnv: string;
  cookieSecretEnv: string;
  envFile: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 只读自有的字符串属性，避免 __proto__/constructor 取到对象。
 * 同时用于进程 env 和 .env 解析结果（两者都是字符串映射）。
 */
function ownString(source: Record<string, string | undefined>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * 按优先级读出原始值（不校验）。进程 env 优先于 .env。
 *
 * `<registry.parent>/.env` 里无关键的 ${...} 不会导致整份密钥读取失败；
 * 只有 password_hash_env / cookie_secret_env 两个键含 ${...} 才报错。
 */
export function readRawSecrets(options: LoadSecretsOptions): RawSecrets {
  const { registry } = options;
  const env = options.env ?? process.env;
  const envFile = options.envFile ?? path.join(path.dirname(registry.source), ".env");
  const passwordHashEnv = registry.authDev.passwordHashEnv;
  const cookieSecretEnv = registry.authDev.cookieSecretEnv;
  let stored: Record<string, string> = Object.create(null) as Record<string, string>;
  let text: string | null = null;
  try {
    text = fs.readFileSync(envFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new EdgeError(
        `读取 ${envFile} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (text !== null) {
    let detailed;
    try {
      detailed = parseEdgeEnvDetailed(text);
    } catch (error) {
      // 引号未闭合等硬解析错误仍然拒绝，避免带着半套密钥渲染。
      throw new EdgeError(
        `读取 ${envFile} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const name of [passwordHashEnv, cookieSecretEnv]) {
      if (detailed.variableKeys.has(name)) {
        throw new EdgeError(
          `${envFile} 的 ${name} 使用了 \${...} 变量展开；密钥不支持变量引用。`,
        );
      }
    }
    stored = detailed.values;
  }
  return {
    passwordHash: nonEmpty(ownString(env,passwordHashEnv)) ?? nonEmpty(ownString(stored,passwordHashEnv)),
    cookieSecret: nonEmpty(ownString(env,cookieSecretEnv)) ?? nonEmpty(ownString(stored,cookieSecretEnv)),
    passwordHashEnv,
    cookieSecretEnv,
    envFile,
  };
}

/** 组装并校验密钥。缺失/格式错误抛中文 EdgeError。 */
export function loadEdgeSecrets(options: LoadSecretsOptions): EdgeSecrets {
  const raw = readRawSecrets(options);
  const missing: string[] = [];
  if (!raw.passwordHash) missing.push(raw.passwordHashEnv);
  if (!raw.cookieSecret) missing.push(raw.cookieSecretEnv);
  if (missing.length > 0) {
    throw new EdgeError(
      `缺少 dev 认证密钥：${missing.join("、")}。` +
        `请在 ${raw.envFile} 或进程环境中设置。`,
    );
  }
  const passwordHash = raw.passwordHash!;
  const cookieSecret = raw.cookieSecret!;
  if (!BCRYPT_RE.test(passwordHash)) {
    throw new EdgeError(
      `${raw.passwordHashEnv} 不是合法的 bcrypt 哈希（应为 $2a$/$2b$/$2y$ 开头、共 60 字符）。`,
    );
  }
  if (!COOKIE_SECRET_RE.test(cookieSecret)) {
    const reason =
      cookieSecret.length < MIN_COOKIE_SECRET
        ? `至少 ${MIN_COOKIE_SECRET} 位`
        : "只能包含字母、数字、._~-（不能有空白、换行、分号、引号、花括号）";
    throw new EdgeError(`${raw.cookieSecretEnv} ${reason}。`);
  }
  // 进程 env 优先，否则来自 .env。
  const env = options.env ?? process.env;
  const passwordHashSource = nonEmpty(ownString(env,raw.passwordHashEnv)) ? "process" : "envfile";
  const cookieSecretSource = nonEmpty(ownString(env,raw.cookieSecretEnv)) ? "process" : "envfile";
  return {
    passwordHash,
    cookieSecret,
    secretsSha: canonicalSha256([passwordHash, cookieSecret]),
    passwordHashSource,
    cookieSecretSource,
  };
}

/** 导出校验规则，供测试/API 预览使用。 */
export function isValidBcryptHash(value: string): boolean {
  return BCRYPT_RE.test(value);
}

export function isValidCookieSecret(value: string): boolean {
  return COOKIE_SECRET_RE.test(value);
}
