import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { deployConfigDir } from "../deploy.js";
import { EdgeError, type EdgeBinSource, type EdgeConfigSource, type EdgePaths } from "./types.js";

/**
 * env / 路径解析。
 *
 * 优先级与 server/src/deploy.ts 的 deriveDeployForm 一致：
 *   <deployConfigDir>/env 文件优先 → 进程 env 兜底 → 默认值。
 *
 * 支持的键：
 *   QUBIUS_EDGECTL_CONFIG / EDGECTL_CONFIG   注册表绝对路径（前者优先）
 *   QUBIUS_EDGECTL_BIN                        edgectl CLI 绝对路径
 *   QUBIUS_EDGE_PROVIDER                      auto / cli / native（大小写不敏感）
 *
 * 只接受绝对路径；相对路径（包括 ~/...）返回中文错误。两个 config 键都没有
 * 配置时 edge 功能禁用——不会自动启用 $HOME/edgectl/edgectl.yaml，避免在
 * 用户没有明确配置时偷偷读取别的文件。
 *
 * provider 语义：
 *   auto   未显式设置 BIN 时有可用 CLI 用 cli，否则 native
 *   cli    必须有可用 CLI，否则报错并禁用 edge（绝不静默回退 native）
 *   native 只做内置渲染，不要求 CLI
 * 非法 provider 值直接报错。显式 QUBIUS_EDGECTL_BIN 不可用（相对路径/不存在/
 * 不可执行）时，无论 auto/cli/native 都报错、禁用 edge、resolvedProvider=null，
 * 不会退而选择 native。只有未显式设置 BIN 时，auto 才能因无 CLI 选 native。
 *
 * 注意：这里只检查 CLI 文件可执行，不执行 `--version` 握手。若 D2 选择 cli，
 * 应在真正渲染前跑一次 `--version`；握手失败必须作为错误上报，不能回退。
 *
 * 这里有意的差异：python-dotenv 会展开 ${VAR}。对 edge 相关键遇到 `${` 直接
 * 报错（部署 env 由部署页生成，不应出现变量引用）；其它键里的 `${` 不展开，
 * 也不会因此丢弃整个 env 文件（避免 QUBIUS_EDGECTL_CONFIG 被无关变量误伤）。
 */

const ENV_KEY_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const PROVIDERS = new Set(["auto", "cli", "native"]);
const EDGE_ENV_KEYS = new Set([
  "QUBIUS_EDGECTL_CONFIG",
  "EDGECTL_CONFIG",
  "QUBIUS_EDGECTL_BIN",
  "QUBIUS_EDGE_PROVIDER",
]);

export interface DetailedEdgeEnv {
  values: Record<string, string>;
  /** 值里含 ${...} 的键 → 行号。 */
  variableKeys: Map<string, number>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 解析 shell 风格 env 文本；不做变量展开，记录含 ${...} 的键。 */
export function parseEdgeEnvDetailed(text: string): DetailedEdgeEnv {
  // 用无原型对象，避免 `__proto__` 之类的键污染原型。
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const variableKeys = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimStart();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(ENV_KEY_RE);
    if (!match) continue;
    const key = match[1]!;
    let rest = match[2]!.trim();
    let value: string;
    if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) throw new EdgeError(`env 文件第 ${index + 1} 行的 ${key} 单引号没有闭合`);
      value = rest.slice(1, end);
      const tail = rest.slice(end + 1).trim();
      if (tail && !tail.startsWith("#")) {
        throw new EdgeError(`env 文件第 ${index + 1} 行的 ${key} 引号后有多余内容`);
      }
    } else if (rest.startsWith('"')) {
      let out = "";
      let escaped = false;
      let end = -1;
      for (let i = 1; i < rest.length; i += 1) {
        const ch = rest[i]!;
        if (escaped) {
          out += ch === "n" ? "\n" : ch === "t" ? "\t" : ch;
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          end = i;
          break;
        }
        out += ch;
      }
      if (end < 0) throw new EdgeError(`env 文件第 ${index + 1} 行的 ${key} 双引号没有闭合`);
      value = out;
      const tail = rest.slice(end + 1).trim();
      if (tail && !tail.startsWith("#")) {
        throw new EdgeError(`env 文件第 ${index + 1} 行的 ${key} 引号后有多余内容`);
      }
    } else {
      const hash = rest.search(/\s#/);
      if (hash >= 0) rest = rest.slice(0, hash).trimEnd();
      value = rest;
    }
    if (value.includes("${")) variableKeys.set(key, index + 1);
    values[key] = value;
  }
  return { values, variableKeys };
}

/**
 * 严格解析：任何值里有 ${...} 都报错。
 *
 * 生产路径用 `parseEdgeEnvDetailed` / `readEdgeEnvSources`（只对 edge 键严格；
 * secrets 用 `parseEdgeEnvDetailed` 后只检查密钥键）。本函数保留给测试和
 * 需要“整份严格”的调试调用。
 */
export function parseEdgeEnv(text: string): Record<string, string> {
  const detailed = parseEdgeEnvDetailed(text);
  const first = detailed.variableKeys.entries().next();
  if (!first.done) {
    const [key, line] = first.value;
    throw new EdgeError(
      `env 文件第 ${line} 行的 ${key} 使用了 \${...} 变量展开；` +
        "edge 配置要求写死绝对路径，请改成实际值。",
    );
  }
  return detailed.values;
}

/**
 * 读取并严格解析 env 文件（文件不存在返回空对象）。
 *
 * 主要用于测试/调试；生产路径是 `readEdgeEnvSources`（env 文件优先、
 * 进程 env 兜底，且 `${...}` 只对 edge 键严格）。
 */
export function readEdgeEnvFile(file: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new EdgeError(`无法读取 env 文件 ${file}：${messageOf(error)}`);
  }
  try {
    return parseEdgeEnv(text);
  } catch (error) {
    if (error instanceof EdgeError) {
      throw new EdgeError(`${file}：${error.message}`);
    }
    throw error;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** 只读自己的字符串属性，避免 `__proto__`/`constructor` 取到对象。 */
function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(env, key)) return undefined;
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * 读取进程 env 与 <deployConfigDir>/env。env 文件优先、进程兜底。
 *
 * 只有 edge 相关键里的 `${...}` 会报错并从 stored 删除；其它键保持原样，
 * 保证无关变量不会导致整个 env 被丢弃。
 */
export function readEdgeEnvSources(env: NodeJS.ProcessEnv = process.env): {
  configDir: string;
  envFile: string;
  stored: Record<string, string>;
  errors: string[];
} {
  const configDir = deployConfigDir(env);
  const envFile = path.join(configDir, "env");
  let stored: Record<string, string> = Object.create(null) as Record<string, string>;
  const errors: string[] = [];
  try {
    const text = fs.readFileSync(envFile, "utf8");
    const detailed = parseEdgeEnvDetailed(text);
    stored = detailed.values;
    for (const [key, line] of detailed.variableKeys) {
      if (!EDGE_ENV_KEYS.has(key)) continue;
      errors.push(
        `env 文件第 ${line} 行的 ${key} 使用了 \${...} 变量展开；` +
          "edge 配置要求写死绝对路径，请改成实际值。",
      );
      delete stored[key];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(`${envFile}：${messageOf(error)}`);
    }
    stored = Object.create(null) as Record<string, string>;
  }
  return { configDir, envFile, stored, errors };
}

interface Lookup {
  value: string;
  source: "envfile" | "process";
}

function makeLookup(stored: Record<string, string>, env: NodeJS.ProcessEnv) {
  return (name: string): Lookup | undefined => {
    const fromFile = nonEmpty(stored[name]);
    if (fromFile !== undefined) return { value: fromFile, source: "envfile" };
    const fromProcess = nonEmpty(envString(env, name));
    if (fromProcess !== undefined) return { value: fromProcess, source: "process" };
    return undefined;
  };
}

function isExecutableFile(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichEdgectl(env: NodeJS.ProcessEnv): string | null {
  const rawPath = envString(env, "PATH") ?? process.env.PATH ?? "";
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "edgectl");
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** 独立的 bin 解析，便于测试。 */
export function resolveEdgeBin(
  lookup: (name: string) => Lookup | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { binPath: string | null; binSource: EdgeBinSource; errors: string[]; explicit: boolean } {
  const errors: string[] = [];
  const configured = lookup("QUBIUS_EDGECTL_BIN");
  if (configured) {
    if (!path.isAbsolute(configured.value)) {
      errors.push(`QUBIUS_EDGECTL_BIN 必须是绝对路径：${configured.value}`);
      return { binPath: null, binSource: null, errors, explicit: true };
    }
    if (!isExecutableFile(configured.value)) {
      errors.push(`QUBIUS_EDGECTL_BIN 不存在或不可执行：${configured.value}`);
      return { binPath: null, binSource: null, errors, explicit: true };
    }
    return { binPath: path.resolve(configured.value), binSource: "env", errors, explicit: true };
  }
  const inPath = whichEdgectl(env);
  if (inPath) return { binPath: inPath, binSource: "path", errors, explicit: false };
  const home = envString(env, "HOME") || os.homedir();
  const fallback = path.join(home, "edgectl", ".venv", "bin", "edgectl");
  if (isExecutableFile(fallback)) {
    return { binPath: fallback, binSource: "home", errors, explicit: false };
  }
  return { binPath: null, binSource: null, errors, explicit: false };
}

/**
 * 解析 edge 配置路径与 CLI。所有分支都返回结构化结果，不抛异常；
 * disabled=true 时上层应把「公网入口」标记为不可用。
 */
export function resolveEdgeEnv(env: NodeJS.ProcessEnv = process.env): EdgePaths {
  const { stored, errors } = readEdgeEnvSources(env);
  const lookup = makeLookup(stored, env);
  const rawProvider = lookup("QUBIUS_EDGE_PROVIDER")?.value ?? "auto";
  const provider = rawProvider.trim().toLowerCase();
  const providerValid = PROVIDERS.has(provider);
  const providerErrors: string[] = [];
  if (!providerValid) {
    providerErrors.push(`QUBIUS_EDGE_PROVIDER 只能是 auto、cli 或 native：${rawProvider}`);
  }

  // env 文件整体优先于进程 env；同一来源里 QUBIUS_ 前缀优先于 EDGECTL_。
  // 注意：若 env 文件里的 edge 键含 ${...}，readEdgeEnvSources 已把它从
  // stored 删除并记 error；这里会继续回落到进程 env（有意为之，见测试），
  // 既保留明确报错，又不会因为 env 文件一条坏键就让整个 edge 不可用。
  const candidates: Array<{ key: string; source: EdgeConfigSource; fromFile: boolean }> = [
    { key: "QUBIUS_EDGECTL_CONFIG", source: "envfile-qubius", fromFile: true },
    { key: "EDGECTL_CONFIG", source: "envfile-edgectl", fromFile: true },
    { key: "QUBIUS_EDGECTL_CONFIG", source: "process-qubius", fromFile: false },
    { key: "EDGECTL_CONFIG", source: "process-edgectl", fromFile: false },
  ];
  let configPath: string | null = null;
  let configSource: EdgeConfigSource = null;
  const fatal: string[] = [];
  for (const candidate of candidates) {
    const value = nonEmpty(candidate.fromFile ? stored[candidate.key] : envString(env, candidate.key));
    if (value === undefined) continue;
    // 找到第一个显式配置就停下：相对路径/文件缺失都直接报错，不再回退到
    // 其它来源，避免用户以为生效的是 A、实际读取的是 B。
    configSource = candidate.source;
    if (!path.isAbsolute(value)) {
      fatal.push(`${candidate.key} 必须是绝对路径：${value}`);
      break;
    }
    const resolved = path.resolve(value);
    let isFile = false;
    try {
      isFile = fs.statSync(resolved).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      fatal.push(`找不到 edgectl 配置：${resolved}`);
      break;
    }
    configPath = resolved;
    break;
  }

  const bin = resolveEdgeBin(lookup, env);
  const configAvailable = configPath !== null;
  // 显式配置了 BIN 却不可用：无论 provider 是什么都禁用，不选 native。
  const explicitBinInvalid = bin.explicit && !bin.binPath;
  let resolvedProvider: "cli" | "native" | null = null;
  if (configAvailable && providerErrors.length === 0 && !explicitBinInvalid) {
    if (provider === "cli") {
      if (!bin.binPath) {
        providerErrors.push(
          "QUBIUS_EDGE_PROVIDER=cli，但找不到可用的 edgectl CLI；" +
            "请设置 QUBIUS_EDGECTL_BIN 或把 edgectl 加入 PATH（不会静默回退 native）。",
        );
      } else {
        resolvedProvider = "cli";
      }
    } else if (provider === "native") {
      resolvedProvider = "native";
    } else {
      // auto：只有未显式设置 BIN 时，无 CLI 才允许 native。
      resolvedProvider = bin.binPath ? "cli" : "native";
    }
  }

  const allErrors = [...errors, ...fatal, ...providerErrors, ...bin.errors];
  const disabled = !configAvailable || providerErrors.length > 0 || explicitBinInvalid;
  return {
    provider: providerValid ? (provider as "auto" | "cli" | "native") : null,
    resolvedProvider,
    configPath,
    configSource,
    binPath: bin.binPath,
    binSource: bin.binSource,
    disabled,
    errors: allErrors,
  };
}
