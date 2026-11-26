import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isEffort, type Effort, type PublicProvider, type PublicSettings } from "./types.js";

/** 每百万 token 的美元价格；缺失表示不计算这一项成本。 */
export interface ProviderPricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  pricing?: ProviderPricing;
}

/** 对外设置里的接口配置：PublicProvider 本身没有价格字段，这里用交叉类型补上。 */
export type PublicProviderWithPricing = PublicProvider & { pricing?: ProviderPricing };

/** 与 PublicSettings 兼容，但 provider 上可能带 pricing。 */
export type PublicSettingsView = Omit<PublicSettings, "providers"> & {
  providers: PublicProviderWithPricing[];
};

/** 价格字段名；顺序也用于前端展示。 */
const PRICING_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** 单次模型调用（每百万 token）的合理上限，防止误填离谱数字。 */
const PRICING_MAX = 10_000;

export interface StoredSettings {
  providers: ProviderConfig[];
  effort: Effort;
  /**
   * 同时进行的对话数上限；超出的对话排队，运行中修改立即生效。
   * 顶栏「运行中 / 上限」也用这个值作为 agent 上限，两者共用一个变量。
   */
  maxConcurrent: number;
}

/** 同时进行的对话数范围；与 config.yaml 的 maxConcurrent 校验保持一致。 */
export const MAX_CONCURRENT_MIN = 1;
export const MAX_CONCURRENT_MAX = 256;
export const DEFAULT_MAX_CONCURRENT = 4;

const DEFAULTS: StoredSettings = {
  providers: [],
  effort: "high",
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
};

export function settingsPath(dataDir: string): string {
  return path.join(dataDir, "secrets.json");
}

export function loadSettings(
  dataDir: string,
  defaults?: { maxConcurrent?: number },
): StoredSettings {
  const file = settingsPath(dataDir);
  const defaultMax = defaults?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const fallback: StoredSettings = { ...DEFAULTS, maxConcurrent: defaultMax, providers: [] };
  if (!fs.existsSync(file)) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`无法读取 ${file}`);
  }
  if (!parsed || typeof parsed !== "object") return fallback;
  const loaded = parseStored(parsed as Record<string, unknown>, defaultMax);
  if (loaded.migrated) saveSettings(dataDir, loaded.settings);
  return loaded.settings;
}

export function saveSettings(dataDir: string, settings: StoredSettings): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = settingsPath(dataDir);
  const body = JSON.stringify(
    {
      effort: settings.effort,
      maxConcurrent: settings.maxConcurrent,
      providers: settings.providers.map((provider) => {
        const pricing = cleanPricing(provider.pricing);
        return {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          models: provider.models,
          ...(pricing ? { pricing } : {}),
        };
      }),
    },
    null,
    2,
  );
  fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 可能无效，文件仍然只放在 dataDir。
  }
}

export function publicSettings(settings: StoredSettings): PublicSettingsView {
  return {
    effort: settings.effort,
    maxConcurrent: settings.maxConcurrent,
    providers: settings.providers.map((provider) => {
      const pricing = cleanPricing(provider.pricing);
      return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        hasApiKey: provider.apiKey.trim().length > 0,
        models: [...provider.models],
        ...(pricing ? { pricing } : {}),
      };
    }),
  };
}

export interface SettingsPatch {
  providers?: unknown;
  effort?: unknown;
  maxConcurrent?: unknown;
}

export function applySettingsPatch(current: StoredSettings, patch: SettingsPatch): StoredSettings {
  const next: StoredSettings = {
    effort: current.effort,
    maxConcurrent: current.maxConcurrent,
    providers: current.providers.map((provider) => ({ ...provider, models: [...provider.models] })),
  };
  if (patch.effort !== undefined) {
    if (!isEffort(patch.effort)) throw new Error("effort 必须是 low、medium、high、xhigh 或 max");
    next.effort = patch.effort;
  }
  if (patch.maxConcurrent !== undefined) {
    next.maxConcurrent = readMaxConcurrent(patch.maxConcurrent);
  }
  if (patch.providers !== undefined) {
    next.providers = readProviderList(patch.providers, current.providers);
  }
  return next;
}

export function findProvider(settings: StoredSettings, id: string): ProviderConfig | undefined {
  return settings.providers.find((provider) => provider.id === id);
}

function parseStored(
  record: Record<string, unknown>,
  defaultMaxConcurrent: number,
): { settings: StoredSettings; migrated: boolean } {
  const effort = isEffort(record.effort) ? record.effort : DEFAULTS.effort;
  // 老文件没有这个字段：按默认值加载，不会因为缺字段而报错。
  // 旧版的 agentLimit 已并入 maxConcurrent，读取时直接忽略。
  const maxConcurrent = record.maxConcurrent === undefined
    ? defaultMaxConcurrent
    : readMaxConcurrent(record.maxConcurrent);
  if (Array.isArray(record.providers)) {
    return {
      migrated: false,
      settings: { effort, maxConcurrent, providers: record.providers.map(readSavedProvider) },
    };
  }
  const apiKey = typeof record.apiKey === "string" ? record.apiKey : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  if (!apiKey.trim() && !model) {
    return { migrated: false, settings: { effort, maxConcurrent, providers: [] } };
  }
  return {
    migrated: true,
    settings: {
      effort,
      maxConcurrent,
      providers: [{
        id: randomUUID(),
        name: "默认",
        baseUrl: "https://api.anthropic.com",
        apiKey: apiKey.trim(),
        models: [model || "sonnet"],
      }],
    },
  };
}

/** 并发对话上限必须落在 1..256，与 config.yaml 的 maxConcurrent 保持一致。 */
function readMaxConcurrent(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < MAX_CONCURRENT_MIN
    || value > MAX_CONCURRENT_MAX
  ) {
    throw new Error(`并发上限必须是 ${MAX_CONCURRENT_MIN} 到 ${MAX_CONCURRENT_MAX} 之间的整数`);
  }
  return value;
}

function readSavedProvider(value: unknown): ProviderConfig {
  if (!value || typeof value !== "object") throw new Error("接口配置格式不对");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) throw new Error("接口配置缺少 id");
  if (typeof record.name !== "string" || !record.name.trim()) throw new Error("接口配置缺少名称");
  if (typeof record.baseUrl !== "string" || !record.baseUrl.trim()) throw new Error("接口配置缺少地址");
  if (typeof record.apiKey !== "string") throw new Error("接口配置缺少密钥");
  if (!Array.isArray(record.models) || record.models.length === 0) throw new Error("接口配置缺少模型");
  const models = record.models.map((model) => {
    if (typeof model !== "string" || !model.trim()) throw new Error("接口配置里的模型名称无效");
    return model.trim();
  });
  const pricing = readPricing(record.pricing);
  return {
    id: record.id.trim(),
    name: record.name.trim(),
    baseUrl: record.baseUrl.trim(),
    apiKey: record.apiKey,
    models,
    ...(pricing ? { pricing } : {}),
  };
}

function readProviderList(value: unknown, current: ProviderConfig[]): ProviderConfig[] {
  if (!Array.isArray(value)) throw new Error("接口配置必须是列表");
  if (value.length > 20) throw new Error("接口配置最多 20 套");
  const names = new Set<string>();
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("接口配置格式不对");
    const record = item as Record<string, unknown>;
    const name = readName(record.name);
    if (names.has(name)) throw new Error(`配置名称重复：${name}`);
    names.add(name);
    const baseUrl = normalizeBaseUrl(record.baseUrl);
    const models = readModels(record.models);
    const requestedId = typeof record.id === "string" ? record.id.trim() : "";
    const existing = requestedId ? current.find((provider) => provider.id === requestedId) : undefined;
    if (requestedId && !existing) throw new Error("接口配置不存在");
    if (requestedId && ids.has(requestedId)) throw new Error("接口配置重复提交");
    // 留空表示沿用旧密钥；但地址一旦换了，旧密钥不能再跟着发往新地址。
    // 旧文件里的地址可能没规范化过（尾斜杠/大写 host 等），比较前先尽量规范化。
    const submittedKey = record.apiKey;
    const keyLeftBlank = submittedKey === undefined
      || (typeof submittedKey === "string" && !submittedKey.trim());
    if (existing && keyLeftBlank && baseUrl !== normalizedExistingBaseUrl(existing.baseUrl)) {
      throw new Error("接口地址变化时必须重新填写 API key");
    }
    const apiKey = readApiKey(record.apiKey, existing, name);
    const pricing = readPricing(record.pricing);
    const id = existing?.id ?? randomUUID();
    ids.add(id);
    return { id, name, baseUrl, apiKey, models, ...(pricing ? { pricing } : {}) };
  });
}

/**
 * 解析可选价格。缺失（undefined）表示不算成本；一旦出现就必须是
 * 0 到 10000 之间的有限数字，避免误填导致成本离谱。
 */
function readPricing(value: unknown): ProviderPricing | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("价格必须是非负数");
  }
  const record = value as Record<string, unknown>;
  const pricing: ProviderPricing = {};
  for (const key of PRICING_KEYS) {
    const raw = record[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > PRICING_MAX) {
      throw new Error("价格必须是非负数");
    }
    pricing[key] = raw;
  }
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

/** 写盘/对外展示时只保留明确给出的价格项（0 也要保留）。 */
function cleanPricing(pricing: ProviderPricing | undefined): ProviderPricing | undefined {
  if (!pricing) return undefined;
  const cleaned: ProviderPricing = {};
  for (const key of PRICING_KEYS) {
    const value = pricing[key];
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function readName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("配置名称不能为空");
  const name = value.trim();
  if (name.length > 40) throw new Error("配置名称过长");
  if (/[\r\n]/.test(name)) throw new Error("配置名称不能换行");
  return name;
}

function readModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("每套配置至少要有一个模型");
  if (value.length > 30) throw new Error("一套配置最多 30 个模型");
  const models: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) throw new Error("模型名称不能为空");
    const model = item.trim();
    if (model.length > 120) throw new Error("模型名称过长");
    if (seen.has(model)) throw new Error(`模型名称重复：${model}`);
    seen.add(model);
    models.push(model);
  }
  return models;
}

function readApiKey(value: unknown, existing: ProviderConfig | undefined, name: string): string {
  if (value === undefined || (typeof value === "string" && !value.trim())) {
    if (existing?.apiKey.trim()) return existing.apiKey;
    throw new Error(`「${name}」还没有 API key`);
  }
  if (typeof value !== "string") throw new Error("API key 不能为空");
  return value.trim();
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("接口地址不能为空");
  if (value.trim().length > 300) throw new Error("接口地址过长");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("接口地址不是有效的 URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("接口地址只支持 http 或 https");
  if (url.username || url.password) throw new Error("不要把密钥写进地址");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

/** 历史文件里的地址可能没规范化过；解析失败时退回原字符串参与比较。 */
function normalizedExistingBaseUrl(value: string): string {
  try {
    return normalizeBaseUrl(value);
  } catch {
    return value;
  }
}
