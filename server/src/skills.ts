import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AppConfig } from "./config.js";
import { defaultSdkConfigDir } from "./sdk-files.js";

/**
 * skills 页按“来源域”组织：
 * - user：`<CLAUDE_CONFIG_DIR>/skills`
 * - project：每个项目主检出的 `.claude/skills`
 * - plugin：`<CLAUDE_CONFIG_DIR>/plugins` 下插件自带的 skills（只读）
 *
 * 启用/停用不删文件，只把停用的技能从 SDK 的 `skills` 过滤列表里去掉；
 * 过滤列表在每轮 query 启动时计算，所以改动对下一轮或新对话生效。
 */

export type SkillDomainKind = "user" | "project" | "plugin";

export interface SkillDomain {
  id: string;
  kind: SkillDomainKind;
  label: string;
  /** 项目域的 project id；用户域和插件域没有。 */
  projectId?: string;
  /** SKILL.md 所在目录（不是单个技能目录）。 */
  path: string;
  /** 能否在本页新建/编辑技能；插件目录归插件管理，只读。 */
  writable: boolean;
  /** 目录当前是否存在；不存在时仍可新建（可写域）。 */
  available: boolean;
}

export interface SkillSummary {
  /** 稳定 id：`<域 id>/<技能目录名>`。 */
  id: string;
  domain: string;
  /** 技能目录名，也是 URL 里使用的名字。 */
  dir: string;
  /** SKILL.md frontmatter 里的 name（缺失时退回目录名）。 */
  name: string;
  description: string;
  /** 传给 SDK `skills` 过滤器的名字；插件技能是 `plugin:skill`。 */
  sdkName: string;
  path: string;
  enabled: boolean;
  writable: boolean;
  /** 插件名；只有插件域的技能才有。 */
  plugin?: string;
  bytes: number;
  updatedAt?: string;
}

export interface SkillList {
  domains: SkillDomain[];
  skills: SkillSummary[];
}

export interface SkillDetail {
  skill: SkillSummary;
  content: string;
}

/** 域名和技能目录都不允许穿越；技能目录允许常见的 `.`、`_`、`-`。 */
const SKILL_DIR_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_DESCRIPTION_CHARS = 1024;
const PLUGIN_SCAN_DEPTH = 6;
const PLUGIN_SCAN_LIMIT = 2000;

export class SkillError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface SkillOptions {
  config: Pick<AppConfig, "projects">;
  /** Claude 配置目录；默认取 CLAUDE_CONFIG_DIR 或 ~/.claude。 */
  configDir?: string;
  /** 已被用户停用的技能 key 集合（`<域 id>/<技能目录名>`）。 */
  disabled?: ReadonlySet<string>;
}

export function skillKey(domainId: string, dir: string): string {
  return `${domainId}/${dir}`;
}

/** 列出当前配置下的所有来源域和技能；目录不存在时返回空列表而不是报错。 */
export function listSkills(options: SkillOptions): SkillList {
  const configDir = options.configDir ?? defaultSdkConfigDir();
  const disabled = options.disabled ?? new Set<string>();
  const domains = skillDomains(options.config, configDir);
  const skills: SkillSummary[] = [];
  for (const domain of domains) {
    skills.push(...domainSkills(domain, disabled));
  }
  skills.sort((a, b) => {
    const byDomain = domainOrder(domains, a.domain) - domainOrder(domains, b.domain);
    return byDomain !== 0 ? byDomain : a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir);
  });
  return { domains, skills };
}

export function skillDomains(
  config: Pick<AppConfig, "projects">,
  configDir = defaultSdkConfigDir(),
): SkillDomain[] {
  const domains: SkillDomain[] = [{
    id: "user",
    kind: "user",
    label: "用户级",
    path: path.join(configDir, "skills"),
    writable: true,
    available: false,
  }];
  for (const project of config.projects) {
    domains.push({
      id: `project:${project.id}`,
      kind: "project",
      label: project.name,
      projectId: project.id,
      path: path.join(project.path, ".claude", "skills"),
      writable: true,
      available: false,
    });
  }
  const pluginsRoot = path.join(configDir, "plugins");
  if (isDirectory(pluginsRoot)) {
    domains.push({
      id: "plugin",
      kind: "plugin",
      label: "插件",
      path: pluginsRoot,
      writable: false,
      available: true,
    });
  }
  for (const domain of domains) {
    if (domain.kind === "plugin") continue;
    domain.available = isDirectory(domain.path);
  }
  return domains;
}

export function findSkillDomain(domains: SkillDomain[], id: string): SkillDomain | undefined {
  return domains.find((domain) => domain.id === id);
}

/** 读取单个技能的 SKILL.md；技能不存在时抛 404。 */
export function readSkill(options: SkillOptions, domainId: string, dir: string): SkillDetail {
  const configDir = options.configDir ?? defaultSdkConfigDir();
  const disabled = options.disabled ?? new Set<string>();
  const domains = skillDomains(options.config, configDir);
  const domain = findSkillDomain(domains, domainId);
  if (!domain) throw new SkillError(404, "没有这个技能来源域");
  const file = skillFile(domain, dir);
  const content = fs.readFileSync(file, "utf8");
  const skill = describeSkill(domain, dir, file, content, disabled);
  return { skill, content };
}

/** 覆盖已有技能的 SKILL.md。 */
export function writeSkill(
  options: SkillOptions,
  domainId: string,
  dir: string,
  content: string,
): SkillSummary {
  const configDir = options.configDir ?? defaultSdkConfigDir();
  const disabled = options.disabled ?? new Set<string>();
  const domains = skillDomains(options.config, configDir);
  const domain = findSkillDomain(domains, domainId);
  if (!domain) throw new SkillError(404, "没有这个技能来源域");
  if (!domain.writable) throw new SkillError(403, "插件技能是只读的，请到插件里修改");
  const file = skillFile(domain, dir);
  validateSkillContent(content);
  atomicWrite(file, content);
  return describeSkill(domain, dir, file, content, disabled);
}

/** 在可写域里新建 `<name>/SKILL.md`。 */
export function createSkill(
  options: SkillOptions,
  domainId: string,
  name: string,
  content: string,
): SkillSummary {
  const configDir = options.configDir ?? defaultSdkConfigDir();
  const disabled = options.disabled ?? new Set<string>();
  const domains = skillDomains(options.config, configDir);
  const domain = findSkillDomain(domains, domainId);
  if (!domain) throw new SkillError(404, "没有这个技能来源域");
  if (!domain.writable) throw new SkillError(403, "插件技能是只读的，请到插件里修改");
  if (domain.kind === "project" && !isDirectory(domainRoot(domain))) {
    throw new SkillError(409, "项目目录不可用，不能在这里新建技能");
  }
  if (!SKILL_DIR_RE.test(name)) {
    throw new SkillError(400, "技能名只能包含字母、数字、点、下划线和连字符，且不超过 64 个字符");
  }
  const clean = normalizeSkillContent(content);
  validateSkillContent(clean);
  const meta = parseFrontmatter(clean);
  if (meta.name !== name) {
    throw new SkillError(400, "frontmatter 的 name 必须与技能名一致");
  }
  const dirPath = path.join(domain.path, name);
  if (fs.existsSync(dirPath)) throw new SkillError(409, `技能 ${name} 已存在`);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
  const file = path.join(dirPath, "SKILL.md");
  try {
    atomicWrite(file, clean);
  } catch (error) {
    // 新建失败时不要留下一个空技能目录。
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // 清理失败时保留原始错误。
    }
    throw error;
  }
  return describeSkill(domain, name, file, clean, disabled);
}

/** 计算某个项目的一轮会话应启用的技能名；没有停用项时返回 undefined（沿用 SDK 默认）。 */
export function enabledSkillFilter(options: {
  config: Pick<AppConfig, "projects">;
  configDir?: string;
  disabled: ReadonlySet<string>;
  projectId: string;
}): string[] | undefined {
  const { domains, skills } = listSkills({
    config: options.config,
    configDir: options.configDir,
    disabled: options.disabled,
  });
  const projectDomain = domains.find((domain) => domain.kind === "project" && domain.projectId === options.projectId);
  const inScope = skills.filter((skill) => {
    if (skill.domain === "user" || skill.domain === "plugin") return true;
    return projectDomain !== undefined && skill.domain === projectDomain.id;
  });
  if (!inScope.some((skill) => !skill.enabled)) return undefined;
  return [...new Set(inScope.filter((skill) => skill.enabled).map((skill) => skill.sdkName))];
}

/**
 * 停用状态存在 `dataDir/skills.json`；格式故意保持简单：
 * `{ "disabled": ["user/prl", "project:qubius/foo"] }`。
 * 每次变更递增版本号，运行时据此在下一轮消息前重启 query 让过滤列表生效。
 */
export class SkillSettings {
  private disabled = new Set<string>();
  private revision = 1;

  constructor(private readonly dataDir: string) {
    this.disabled = loadDisabled(dataDir);
  }

  /** 运行时用于判断“这一轮启动后技能开关是否变过”。 */
  get version(): number {
    return this.revision;
  }

  snapshot(): ReadonlySet<string> {
    return new Set(this.disabled);
  }

  isEnabled(domainId: string, dir: string): boolean {
    return !this.disabled.has(skillKey(domainId, dir));
  }

  /** 技能文件内容变了：进行中的会话在下一轮重启 query，重新读取技能。 */
  touch(): void {
    this.revision += 1;
  }

  setEnabled(domainId: string, dir: string, enabled: boolean): void {
    const key = skillKey(domainId, dir);
    const had = this.disabled.has(key);
    if (enabled) this.disabled.delete(key);
    else this.disabled.add(key);
    if (had === !enabled) return;
    this.revision += 1;
    saveDisabled(this.dataDir, this.disabled);
  }
}

function domainSkills(domain: SkillDomain, disabled: ReadonlySet<string>): SkillSummary[] {
  if (domain.kind === "plugin") return pluginSkills(domain, disabled);
  if (!isDirectory(domain.path)) return [];
  const out: SkillSummary[] = [];
  for (const dir of skillDirs(domain.path)) {
    const file = path.join(domain.path, dir, "SKILL.md");
    let content: string;
    try {
      if (!isFile(file)) continue;
      content = fs.readFileSync(file, "utf8");
    } catch {
      // 单个技能不可读时跳过，不能让整页失败。
      continue;
    }
    out.push(describeSkill(domain, dir, file, content, disabled));
  }
  return out;
}

/** 插件域递归查找 `skills` 目录；插件树较深，限制深度和扫描量。 */
function pluginSkills(domain: SkillDomain, disabled: ReadonlySet<string>): SkillSummary[] {
  const out: SkillSummary[] = [];
  for (const skillsDir of findPluginSkillDirs(domain.path)) {
    for (const dir of skillDirs(skillsDir)) {
      const file = path.join(skillsDir, dir, "SKILL.md");
      let content: string;
      try {
        if (!isFile(file)) continue;
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const plugin = pluginName(skillsDir);
      out.push(describeSkill(domain, dir, file, content, disabled, plugin));
    }
  }
  return out;
}

function findPluginSkillDirs(root: string): string[] {
  const found: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > PLUGIN_SCAN_DEPTH || visited > PLUGIN_SCAN_LIMIT) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      visited += 1;
      if (entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      if (!isDirectoryEntry(child, entry)) continue;
      if (entry.name === "skills") {
        found.push(child);
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function skillDirs(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.name.startsWith(".") && SKILL_DIR_RE.test(entry.name))
    .filter((entry) => isDirectoryEntry(path.join(root, entry.name), entry))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function describeSkill(
  domain: SkillDomain,
  dir: string,
  file: string,
  content: string,
  disabled: ReadonlySet<string>,
  plugin?: string,
): SkillSummary {
  const meta = parseFrontmatter(content);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = undefined;
  }
  const name = meta.name || dir;
  const summary: SkillSummary = {
    id: skillKey(domain.id, dir),
    domain: domain.id,
    dir,
    name,
    description: clipDescription(meta.description),
    sdkName: plugin ? `${plugin}:${name}` : name,
    path: file,
    enabled: !disabled.has(skillKey(domain.id, dir)),
    writable: domain.writable,
    bytes: stat?.size ?? Buffer.byteLength(content),
  };
  if (plugin) summary.plugin = plugin;
  if (stat) summary.updatedAt = stat.mtime.toISOString();
  return summary;
}

function skillFile(domain: SkillDomain, dir: string): string {
  if (!SKILL_DIR_RE.test(dir)) throw new SkillError(400, "技能名不合法");
  const dirPath = path.join(domain.path, dir);
  const file = path.join(dirPath, "SKILL.md");
  // 目录名已经过正则校验；这里再确认解析后的路径确实在域根目录下。
  if (path.dirname(file) !== dirPath) throw new SkillError(400, "技能名不合法");
  if (!isFile(file)) throw new SkillError(404, "没有这个技能");
  return file;
}

/** 解析 frontmatter；内容不合法时返回空元数据，列表仍能显示这个技能。 */
export function parseFrontmatter(content: string): { name?: string; description?: string } {
  const text = content.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const record = data as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : undefined;
  const description = typeof record.description === "string" ? record.description : undefined;
  return {
    ...(name ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/** 保存前校验：必须是带 name/description 的 SKILL.md。 */
export function validateSkillContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
    throw new SkillError(400, `技能文件不能超过 ${MAX_SKILL_BYTES / 1024} KB`);
  }
  const meta = parseFrontmatter(content);
  if (!meta.name) throw new SkillError(400, "frontmatter 里需要 name");
  if (!SKILL_NAME_RE.test(meta.name)) {
    throw new SkillError(400, "frontmatter 的 name 只能包含字母、数字、点、下划线和连字符");
  }
  const description = meta.description?.trim() ?? "";
  if (!description) throw new SkillError(400, "frontmatter 里需要 description");
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new SkillError(400, `description 不能超过 ${MAX_DESCRIPTION_CHARS} 个字符`);
  }
}

function normalizeSkillContent(content: string): string {
  return content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

function clipDescription(value: string | undefined): string {
  if (!value) return "";
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > 200 ? `${single.slice(0, 200)}…` : single;
}

function atomicWrite(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o644 });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 清理失败时保留原始错误。
    }
    throw error;
  }
}

/** 可写域对应的项目根目录或 Claude 配置目录。 */
function domainRoot(domain: SkillDomain): string {
  if (domain.kind === "user") return path.dirname(domain.path);
  return path.dirname(path.dirname(domain.path));
}

function pluginName(skillsDir: string): string {
  // 常见布局：<plugins>/…/<plugin>/skills/<skill>；取 skills 的父目录名。
  const name = path.basename(path.dirname(skillsDir));
  return name && name !== "plugins" ? name : "plugin";
}

function domainOrder(domains: SkillDomain[], id: string): number {
  const index = domains.findIndex((domain) => domain.id === id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function isDirectoryEntry(fullPath: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function dataFile(dataDir: string): string {
  return path.join(dataDir, "skills.json");
}

function loadDisabled(dataDir: string): Set<string> {
  const file = dataFile(dataDir);
  if (!fs.existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();
    const list = (parsed as Record<string, unknown>).disabled;
    if (!Array.isArray(list)) return new Set();
    const out = new Set<string>();
    for (const item of list) {
      if (typeof item !== "string") continue;
      const slash = item.indexOf("/");
      if (slash <= 0 || slash === item.length - 1) continue;
      const domain = item.slice(0, slash);
      const dir = item.slice(slash + 1);
      if (!SKILL_DIR_RE.test(dir)) continue;
      out.add(item);
    }
    return out;
  } catch {
    // 文件损坏时按“全部启用”处理，不拖垮服务。
    return new Set();
  }
}

function saveDisabled(dataDir: string, disabled: ReadonlySet<string>): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = dataFile(dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ disabled: [...disabled].sort() }, null, 2);
  fs.writeFileSync(temp, `${body}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(temp, 0o600);
  } catch {
    // Windows 上 chmod 可能无效，文件仍然只放在 dataDir。
  }
  fs.renameSync(temp, file);
}
