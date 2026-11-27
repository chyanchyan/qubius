import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { DEFAULT_LIMITS, LIMIT_RULES, type LimitsConfig } from "./config.js";
import {
  isEffort,
  isProviderKind,
  type Effort,
  type ProviderKind,
  type PublicProvider,
  type PublicSettings,
  type RoleTeam,
} from "./types.js";

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
  /** 缺省表示老配置，按 Anthropic 兼容接口处理。 */
  kind?: ProviderKind;
  baseUrl: string;
  apiKey: string;
  models: string[];
  pricing?: ProviderPricing;
}

/** 读取接口类型；老设置文件没有 kind 字段时按 anthropic 处理。 */
export function providerKind(provider: { kind?: ProviderKind }): ProviderKind {
  return provider.kind ?? "anthropic";
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
  /**
   * 等待确认（提问/授权）超时，单位分钟；0 表示不自动拒绝。
   * 老设置文件可能没有这些字段，读取时由 resolveSettings 补默认值。
   */
  approvalTimeoutMinutes?: number;
  /** 会话裁剪与请求体/历史分页上限；可以只写部分字段。 */
  limits?: Partial<LimitsConfig>;
  /** 会话在本机保留多少天后归档；只有配置了归档目录时生效。 */
  archiveRetentionDays?: number;
  /** prl-role 的默认四角色团队；没有配置时缺省，配置弹窗退回会话当前模型。 */
  roleTeam?: RoleTeam;
}

/** 补全默认值后的设置：落盘和运行期使用，三个新字段一定存在。 */
export type ResolvedSettings = StoredSettings & {
  approvalTimeoutMinutes: number;
  limits: LimitsConfig;
  archiveRetentionDays: number;
};

export function resolveSettings(settings: StoredSettings): ResolvedSettings {
  return {
    ...settings,
    approvalTimeoutMinutes: settings.approvalTimeoutMinutes ?? DEFAULT_APPROVAL_TIMEOUT_MINUTES,
    limits: { ...DEFAULT_LIMITS, ...(settings.limits ?? {}) },
    archiveRetentionDays: settings.archiveRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS,
  };
}

/** 同时进行的对话数范围；与 config.yaml 的 maxConcurrent 校验保持一致。 */
export const MAX_CONCURRENT_MIN = 1;
export const MAX_CONCURRENT_MAX = 256;
export const DEFAULT_MAX_CONCURRENT = 4;

/** 确认超时范围与默认值；与 config.yaml 的 approvalTimeoutMinutes 保持一致。 */
export const APPROVAL_TIMEOUT_MIN = 0;
export const APPROVAL_TIMEOUT_MAX = 1440;
export const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 10;

/** 归档保留天数范围与默认值；与部署页 archiveRetentionDays 保持一致。 */
export const ARCHIVE_RETENTION_MIN = 1;
export const ARCHIVE_RETENTION_MAX = 3650;
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 30;

/** 首次启动时 config.yaml / env 提供的初始默认值；之后以设置文件为准。 */
export interface SettingsDefaults {
  maxConcurrent?: number;
  approvalTimeoutMinutes?: number;
  limits?: Partial<LimitsConfig>;
  archiveRetentionDays?: number;
}

function defaultSettings(defaults?: SettingsDefaults): ResolvedSettings {
  return {
    providers: [],
    effort: "high",
    maxConcurrent: defaults?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    approvalTimeoutMinutes: defaults?.approvalTimeoutMinutes ?? DEFAULT_APPROVAL_TIMEOUT_MINUTES,
    limits: { ...DEFAULT_LIMITS, ...(defaults?.limits ?? {}) },
    archiveRetentionDays: defaults?.archiveRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS,
  };
}

export function settingsPath(dataDir: string): string {
  return path.join(dataDir, "secrets.json");
}

export function loadSettings(
  dataDir: string,
  defaults?: SettingsDefaults,
): ResolvedSettings {
  const file = settingsPath(dataDir);
  const fallback = defaultSettings(defaults);
  const mainExists = fs.existsSync(file);
  const loaded = mainExists ? decodeSettingsFile(file, fallback) : undefined;
  if (loaded) {
    if (loaded.migrated) saveSettings(dataDir, loaded.settings);
    return loaded.settings;
  }

  // 主文件读不出来（或已被删除）时先试同目录备份，避免把仍有密钥的旧配置直接丢掉。
  const backupFile = `${file}.bak`;
  const backup = decodeSettingsFile(backupFile, fallback);
  if (backup) {
    // 必须先把损坏的主文件隔离掉：否则之后任意 saveSettings 的 backup=true
    // 会把损坏内容复制进 .bak，覆盖掉唯一的好备份。
    const corruptFile = mainExists ? quarantineCorrupt(file) : undefined;
    const quarantined = corruptFile !== undefined;
    // 改名失败（例如 Windows 上文件被占用）时，改用备份内容原子覆盖主文件，
    // 保证主文件不再是坏数据，后续保存也不会污染 .bak。
    const restored = mainExists && !quarantined
      ? restoreFromBackup(file, backupFile)
      : false;
    console.warn(
      `设置文件 ${file} ${mainExists ? "无法读取" : "不存在"}，已改用备份 ${backupFile}`
        + (corruptFile ? `，损坏文件已保留为 ${corruptFile}` : "")
        + (mainExists && !quarantined && restored ? "，损坏文件无法改名，已用备份覆盖" : "")
        + (mainExists && !quarantined && !restored ? "，损坏文件无法隔离也无法覆盖，请手动检查" : ""),
    );
    if (backup.migrated) saveSettings(dataDir, backup.settings);
    return backup.settings;
  }

  // 主文件不存在且没有备份：首次启动的正常情况，直接返回默认值。
  if (!mainExists) return fallback;

  // 主文件和备份都不可用：尽力把原文件改名保留作为证据，再退回默认值，不阻止启动。
  const corruptFile = quarantineCorrupt(file);
  console.warn(
    `设置文件 ${file} 和备份都无法读取`
      + (corruptFile ? `，原文件已保留为 ${corruptFile}` : "，原文件未能改名保留")
      + "，使用默认设置",
  );
  return fallback;
}

/** 尽力把损坏的设置文件改名保留作为证据；失败时返回 undefined，不影响启动。 */
function quarantineCorrupt(file: string): string | undefined {
  const corruptFile = `${file}.corrupt.${Date.now()}`;
  try {
    fs.renameSync(file, corruptFile);
    return corruptFile;
  } catch {
    // 改名失败（例如权限不足）时原文件原地保留。
    return undefined;
  }
}

/** 用备份原文原子覆盖损坏的主文件（不动 .bak）；失败时返回 false，由调用方告警。 */
function restoreFromBackup(file: string, backupFile: string): boolean {
  try {
    writeFileAtomic(file, fs.readFileSync(backupFile, "utf8"), { mode: 0o600, backup: false });
    return true;
  } catch {
    return false;
  }
}

/** 读取单个设置文件；JSON 解析或字段校验失败都返回 undefined，交给调用方降级。 */
function decodeSettingsFile(
  file: string,
  defaults: ResolvedSettings,
): { settings: ResolvedSettings; migrated: boolean } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  try {
    return parseStored(parsed as Record<string, unknown>, defaults);
  } catch {
    return undefined;
  }
}

export function saveSettings(dataDir: string, stored: StoredSettings): void {
  const file = settingsPath(dataDir);
  const settings = resolveSettings(stored);
  const body = JSON.stringify(
    {
      effort: settings.effort,
      maxConcurrent: settings.maxConcurrent,
      approvalTimeoutMinutes: settings.approvalTimeoutMinutes,
      limits: { ...settings.limits },
      archiveRetentionDays: settings.archiveRetentionDays,
      ...(settings.roleTeam ? { roleTeam: settings.roleTeam } : {}),
      providers: settings.providers.map((provider) => {
        const pricing = cleanPricing(provider.pricing);
        return {
          id: provider.id,
          name: provider.name,
          kind: providerKind(provider),
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
  // 只有现有主文件仍能解析时才生成备份：损坏内容一旦复制进 .bak，
  // 会覆盖掉唯一的好备份。主文件不可解析时直接原子覆盖它，保留旧 .bak。
  const backup = fs.existsSync(file)
    && decodeSettingsFile(file, settings) !== undefined;
  writeFileAtomic(file, body, { mode: 0o600, backup });
}

export function publicSettings(stored: StoredSettings): PublicSettingsView {
  const settings = resolveSettings(stored);
  return {
    effort: settings.effort,
    maxConcurrent: settings.maxConcurrent,
    approvalTimeoutMinutes: settings.approvalTimeoutMinutes,
    limits: { ...settings.limits },
    archiveRetentionDays: settings.archiveRetentionDays,
    ...(settings.roleTeam ? { roleTeam: settings.roleTeam } : {}),
    providers: settings.providers.map((provider) => {
      const pricing = cleanPricing(provider.pricing);
      return {
        id: provider.id,
        name: provider.name,
        kind: providerKind(provider),
        baseUrl: provider.baseUrl,
        // 设置页需要显示已保存密钥的明文；服务端和页面在同一台开发机上。
        apiKey: provider.apiKey,
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
  approvalTimeoutMinutes?: unknown;
  limits?: unknown;
  archiveRetentionDays?: unknown;
  roleTeam?: unknown;
}

export function applySettingsPatch(current: StoredSettings, patch: SettingsPatch): ResolvedSettings {
  const base = resolveSettings(current);
  const next: ResolvedSettings = {
    effort: base.effort,
    maxConcurrent: base.maxConcurrent,
    approvalTimeoutMinutes: base.approvalTimeoutMinutes,
    limits: { ...base.limits },
    archiveRetentionDays: base.archiveRetentionDays,
    ...(base.roleTeam ? { roleTeam: base.roleTeam } : {}),
    providers: base.providers.map((provider) => ({ ...provider, models: [...provider.models] })),
  };
  if (patch.effort !== undefined) {
    if (!isEffort(patch.effort)) throw new Error("effort 必须是 low、medium、high、xhigh 或 max");
    next.effort = patch.effort;
  }
  if (patch.maxConcurrent !== undefined) {
    next.maxConcurrent = readMaxConcurrent(patch.maxConcurrent);
  }
  if (patch.approvalTimeoutMinutes !== undefined) {
    next.approvalTimeoutMinutes = readApprovalTimeout(patch.approvalTimeoutMinutes);
  }
  if (patch.limits !== undefined) {
    next.limits = readLimits(patch.limits, base.limits);
  }
  if (patch.archiveRetentionDays !== undefined) {
    next.archiveRetentionDays = readArchiveRetentionDays(patch.archiveRetentionDays);
  }
  if (patch.providers !== undefined) {
    next.providers = readProviderList(patch.providers, current.providers);
    // 接口或模型被删掉后，已保存的默认团队可能引用失效；重新校验，坏了就丢弃，
    // 避免用户没碰角色区时把失效配置继续落盘、下次加载又静默消失。
    if (next.roleTeam) {
      try {
        next.roleTeam = readRoleTeam(next.roleTeam, next.providers);
      } catch {
        delete next.roleTeam;
      }
    }
  }
  // 角色团队引用接口和模型：先应用接口改动，再按最新的接口列表校验。
  if (patch.roleTeam !== undefined) {
    if (patch.roleTeam === null) delete next.roleTeam;
    else next.roleTeam = readRoleTeam(patch.roleTeam, next.providers);
  }
  return next;
}

export function findProvider(settings: StoredSettings, id: string): ProviderConfig | undefined {
  return settings.providers.find((provider) => provider.id === id);
}

function parseStored(
  record: Record<string, unknown>,
  defaults: ResolvedSettings,
): { settings: ResolvedSettings; migrated: boolean } {
  const effort = isEffort(record.effort) ? record.effort : defaults.effort;
  // 老文件没有这些字段：按调用方给的初始默认值加载，不会因为缺字段而报错。
  // 旧版的 agentLimit 已并入 maxConcurrent，读取时直接忽略。
  const maxConcurrent = record.maxConcurrent === undefined
    ? defaults.maxConcurrent
    : readMaxConcurrent(record.maxConcurrent);
  const approvalTimeoutMinutes = record.approvalTimeoutMinutes === undefined
    ? defaults.approvalTimeoutMinutes
    : readApprovalTimeout(record.approvalTimeoutMinutes);
  const limits = record.limits === undefined
    ? { ...defaults.limits }
    : readLimits(record.limits, defaults.limits);
  const archiveRetentionDays = record.archiveRetentionDays === undefined
    ? defaults.archiveRetentionDays
    : readArchiveRetentionDays(record.archiveRetentionDays);
  const common = { effort, maxConcurrent, approvalTimeoutMinutes, limits, archiveRetentionDays };
  let providers: ProviderConfig[];
  let migrated = false;
  if (Array.isArray(record.providers)) {
    providers = record.providers.map(readSavedProvider);
    // 旧版的 proxy / systemProxy 字段直接忽略：代理路由由机器/部署环境统一决定。
  } else {
    const apiKey = typeof record.apiKey === "string" ? record.apiKey : "";
    const model = typeof record.model === "string" ? record.model.trim() : "";
    if (!apiKey.trim() && !model) {
      providers = [];
    } else {
      migrated = true;
      providers = [{
        id: randomUUID(),
        name: "默认",
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: apiKey.trim(),
        models: [model || "sonnet"],
      }];
    }
  }
  // 角色团队引用接口和模型：手改或旧数据里失效时整段丢弃，不影响设置加载。
  const roleTeam = readRoleTeamOrUndefined(record.roleTeam, providers);
  return {
    migrated,
    settings: { ...common, ...(roleTeam ? { roleTeam } : {}), providers },
  };
}

/** 技能角色团队字段的展示名与顺序；与 prl-role 的四个角色一一对应。 */
const ROLE_TEAM_FIELDS: Array<{ key: keyof RoleTeam; label: string }> = [
  { key: "orchestrator", label: "编排模型" },
  { key: "executor", label: "执行模型" },
  { key: "subReviewer", label: "子审核模型" },
  { key: "integrationReviewer", label: "集成审核模型" },
];

/** 加载时容错：字段缺失或引用失效都返回 undefined，不让整份设置失败。 */
function readRoleTeamOrUndefined(value: unknown, providers: ProviderConfig[]): RoleTeam | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return readRoleTeam(value, providers);
  } catch {
    return undefined;
  }
}

/** 校验设置页保存的四角色团队：接口必须存在、模型必须属于该接口、effort 合法。 */
export function readRoleTeam(value: unknown, providers: ProviderConfig[]): RoleTeam {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("roleTeam 必须是对象");
  }
  const record = value as Record<string, unknown>;
  const team: Partial<RoleTeam> = {};
  for (const field of ROLE_TEAM_FIELDS) {
    const raw = record[field.key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${field.label}配置无效`);
    }
    const binding = raw as Record<string, unknown>;
    const providerId = typeof binding.providerId === "string" ? binding.providerId.trim() : "";
    if (!providerId) throw new Error(`${field.label}缺少接口`);
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) throw new Error(`${field.label}的接口不存在：${providerId}`);
    const model = typeof binding.model === "string" ? binding.model.trim() : "";
    if (!model || !provider.models.includes(model)) {
      throw new Error(`${field.label}的模型不在「${provider.name}」里`);
    }
    if (!isEffort(binding.effort)) {
      throw new Error(`${field.label}的 effort 必须是 low、medium、high、xhigh 或 max`);
    }
    team[field.key] = {
      providerId: provider.id,
      providerName: provider.name,
      model,
      effort: binding.effort,
    };
  }
  return team as RoleTeam;
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

/** 确认超时与 config.yaml / env 的范围一致：0 表示一直等待。 */
function readApprovalTimeout(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < APPROVAL_TIMEOUT_MIN
    || value > APPROVAL_TIMEOUT_MAX
  ) {
    throw new Error(
      `确认超时必须是 ${APPROVAL_TIMEOUT_MIN} 到 ${APPROVAL_TIMEOUT_MAX} 之间的整数（0 表示不自动拒绝）`,
    );
  }
  return value;
}

/** 合并式读取上限：只校验出现的字段，其余沿用当前值，方便前端部分提交。 */
function readLimits(value: unknown, base: LimitsConfig): LimitsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("limits 必须是对象");
  }
  const record = value as Record<string, unknown>;
  const result = { ...base };
  for (const rule of LIMIT_RULES) {
    const raw = record[rule.key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < rule.min || raw > rule.max) {
      throw new Error(
        `limits.${rule.key} 必须是 ${rule.min} 到 ${rule.max} 的整数${rule.unit ? `（${rule.unit}）` : ""}`,
      );
    }
    result[rule.key] = raw;
  }
  return result;
}

/** 归档保留天数与部署页一致：1..3650 天。 */
function readArchiveRetentionDays(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < ARCHIVE_RETENTION_MIN
    || value > ARCHIVE_RETENTION_MAX
  ) {
    throw new Error(`归档保留天数必须是 ${ARCHIVE_RETENTION_MIN} 到 ${ARCHIVE_RETENTION_MAX} 之间的整数`);
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
    kind: readProviderKind(record.kind),
    baseUrl: record.baseUrl.trim(),
    apiKey: record.apiKey,
    models,
    ...(pricing ? { pricing } : {}),
  };
}

/** 缺省按 anthropic 兼容接口读取；写入时始终落盘明确的类型。 */
function readProviderKind(value: unknown): ProviderKind {
  if (value === undefined) return "anthropic";
  if (!isProviderKind(value)) throw new Error("接口类型无效");
  return value;
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
    const kind = readProviderKind(record.kind);
    const baseUrl = normalizeBaseUrl(record.baseUrl);
    const models = readModels(record.models);
    const requestedId = typeof record.id === "string" ? record.id.trim() : "";
    const existing = requestedId ? current.find((provider) => provider.id === requestedId) : undefined;
    if (requestedId && !existing) throw new Error("接口配置不存在");
    if (requestedId && ids.has(requestedId)) throw new Error("接口配置重复提交");
    // 留空表示沿用旧密钥；修改地址或类型时也一样沿用，不需要重新填写。
    const apiKey = readApiKey(record.apiKey, existing, name);
    const pricing = readPricing(record.pricing);
    const id = existing?.id ?? randomUUID();
    ids.add(id);
    return {
      id,
      name,
      kind,
      baseUrl,
      apiKey,
      models,
      ...(pricing ? { pricing } : {}),
    };
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
