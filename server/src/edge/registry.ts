import fs from "node:fs";
import path from "node:path";
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parse,
  parseDocument,
  visit,
  type Document,
  type Node as YAMLNode,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

import { canonicalJson } from "./canonical.js";
import { redact } from "./render.js";
import {
  EdgeError,
  type EdgeRegistry,
  type EdgeSite,
  type EdgeUpsertResult,
  type EdgeVpsConfig,
  type EdgeLocalConfig,
  type RegistryDeploy,
  type RegistrySite,
  type RegistrySiteAuth,
  type RegistrySiteEnv,
} from "./types.js";

/**
 * 读取/校验 edgectl 注册表，并原地 upsert qubius / co-qubius。
 *
 * 安全策略：
 *   1. 写入前先对「未修改的原始文本」做字节守卫：
 *        parseDocument(text).toString(opts) === text
 *      不成立就拒绝自动写入，提示用 edgectl CLI 或手工编辑。这样不会把
 *      用户文件的排版/注释悄悄改掉。
 *   2. CRLF 一律拒绝自动写入（edgectl.yaml 是 LF）。
 *   3. 受管条目带 anchor 或被 alias 引用时拒绝（原地改会破坏引用）。
 *   4. 同目录临时文件写好后先重新解析校验，再备份 *.bak.<timestamp>，
 *      最后 rename。临时文件沿用原 mode。
 */

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PROJECT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const COOKIE_RE = /^[A-Za-z0-9_]+$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 即使匹配标识符正则，也会破坏对象查找的名字。 */
const RESERVED_ENV_NAMES = new Set(["__proto__", "prototype", "constructor"]);

/** 自动 upsert 只允许这两个条目。 */
export const MANAGED_SITE_NAMES = ["qubius", "co-qubius"] as const;

/** 与 edgectl 一致的序列化参数。 */
export const REGISTRY_SERIALIZE_OPTIONS = {
  lineWidth: 0,
  flowCollectionPadding: false,
  indent: 2,
} as const;

const SITE_MODELED_KEYS = new Set(["name", "domains", "env", "upstream", "auth", "sse", "deploy"]);
const DEPLOY_MODELED_KEYS = new Set([
  "repo",
  "compose_file",
  "project",
  "branch",
  "health_url",
  "health_timeout",
  "pre_build",
  "post_up",
]);

function fail(message: string): never {
  throw new EdgeError(message);
}

function asMap(value: unknown, where: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    fail(`${where} 必须是映射（key: value）。`);
  }
  return value as Record<string, unknown>;
}

function str(
  value: unknown,
  where: string,
  options: { default?: string; allowEmpty?: boolean } = {},
): string {
  if (value === null || value === undefined) {
    if (options.default === undefined) fail(`缺少必填项 ${where}。`);
    value = options.default;
  }
  if (typeof value !== "string") fail(`${where} 必须是字符串。`);
  const trimmed = value.trim();
  if (!trimmed && !options.allowEmpty) fail(`${where} 不能为空。`);
  return trimmed;
}

function int(value: unknown, where: string, fallback?: number): number {
  if (value === null || value === undefined) {
    if (fallback === undefined) fail(`缺少必填项 ${where}。`);
    return fallback;
  }
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${where} 必须是整数。`);
  }
  return value;
}

function bool(value: unknown, where: string, fallback = false): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "boolean") fail(`${where} 必须是 true 或 false。`);
  return value;
}

function absolute(value: string, where: string): string {
  if (!value.startsWith("/")) fail(`${where} 必须是 Linux 绝对路径：${value}`);
  return value;
}

export function normalizeDomain(value: string, where: string): string {
  const domain = value.trim().toLowerCase().replace(/\.+$/, "");
  if (domain.startsWith("*.")) {
    fail(
      `${where} 暂不支持通配域名 ${domain}；通配证书需要 DNS-01，` +
        "当前使用服务器 Caddy 的 HTTP-01。",
    );
  }
  if (!DOMAIN_RE.test(domain)) fail(`${where} 不是合法域名：${value}`);
  return domain;
}

function normalizeDomains(value: unknown, where: string): string[] {
  let values: unknown[];
  if (typeof value === "string") values = [value];
  else if (Array.isArray(value) && value.length > 0) values = value;
  else fail(`${where} 必须是域名或域名列表。`);
  const domains: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") fail(`${where} 里的域名必须是字符串。`);
    const domain = normalizeDomain(item, where);
    if (domains.includes(domain)) fail(`${where} 域名重复：${domain}`);
    domains.push(domain);
  }
  return domains;
}

export function normalizeUpstream(input: string, where: string): string {
  let value = input.trim();
  if (!value.includes("://")) value = `http://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`${where} 不是合法 URL：${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`${where} 只支持 http 或 https：${input}`);
  }
  if (!url.hostname) fail(`${where} 缺少主机名：${input}`);
  if (url.username || url.password) fail(`${where} 不能包含用户名或密码：${input}`);
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    fail(`${where} 只能是 scheme://host:port，不能带路径：${input}`);
  }
  return value.replace(/\/+$/, "");
}

function parseHooks(value: unknown, where: string): string[][] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) fail(`${where} 必须是命令列表的列表。`);
  const hooks: string[][] = [];
  for (const [index, item] of value.entries()) {
    if (
      !Array.isArray(item) ||
      item.length === 0 ||
      !item.every((part) => typeof part === "string" && part.length > 0)
    ) {
      fail(
        `${where}[${index}] 必须是非空的字符串列表，例如 ["npm", "run", "build"]。`,
      );
    }
    hooks.push([...(item as string[])]);
  }
  return hooks;
}

function readExtras(record: Record<string, unknown>, modeled: Set<string>): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (modeled.has(key)) continue;
    extras[key] = value;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

function parseDeploy(raw: unknown, siteName: string): RegistryDeploy | undefined {
  if (raw === null || raw === undefined) return undefined;
  const where = `site ${siteName}.deploy`;
  const data = asMap(raw, where);
  const repo = absolute(str(data.repo, `${where}.repo`), `${where}.repo`);
  const composeFile = str(data.compose_file, `${where}.compose_file`, {
    default: "docker-compose.yml",
  });
  const parts = composeFile.split("/");
  if (composeFile.startsWith("/") || parts.includes("..")) {
    fail(`${where}.compose_file 必须是仓库内的相对路径。`);
  }
  const project = str(data.project, `${where}.project`, { default: siteName });
  if (!PROJECT_RE.test(project)) fail(`${where}.project 不合法：${project}`);
  const branch = str(data.branch, `${where}.branch`, { default: "main" });
  if (/\s/.test(branch)) fail(`${where}.branch 不能包含空格。`);
  let healthUrl: string | null = null;
  if (data.health_url !== null && data.health_url !== undefined) {
    healthUrl = str(data.health_url, `${where}.health_url`);
    let scheme = "";
    try {
      scheme = new URL(healthUrl).protocol;
    } catch {
      scheme = "";
    }
    if (scheme !== "http:" && scheme !== "https:") {
      fail(`${where}.health_url 必须以 http:// 或 https:// 开头。`);
    }
  }
  const healthTimeout = int(data.health_timeout, `${where}.health_timeout`, 120);
  if (healthTimeout <= 0) fail(`${where}.health_timeout 必须大于 0。`);
  const extras = readExtras(data, DEPLOY_MODELED_KEYS);
  const deploy: RegistryDeploy = {
    repo,
    composeFile,
    project,
    branch,
    healthUrl,
    healthTimeout,
    preBuild: parseHooks(data.pre_build, `${where}.pre_build`),
    postUp: parseHooks(data.post_up, `${where}.post_up`),
  };
  if (extras) deploy.extras = extras;
  return deploy;
}

function parseSites(raw: unknown): RegistrySite[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) fail("sites 必须是列表。");
  const sites: RegistrySite[] = [];
  const names = new Set<string>();
  const domainsSeen = new Map<string, string>();
  for (const [index, item] of raw.entries()) {
    const where = `sites[${index}]`;
    const data = asMap(item, where);
    const name = str(data.name, `${where}.name`);
    if (!NAME_RE.test(name)) {
      fail(`${where}.name 只能使用小写字母、数字、下划线和短横线：${name}`);
    }
    if (names.has(name)) fail(`sites 中项目名重复：${name}`);
    names.add(name);
    const domains = normalizeDomains(data.domains, `${where}.domains`);
    for (const domain of domains) {
      const previous = domainsSeen.get(domain);
      if (previous) fail(`域名 ${domain} 同时出现在 ${previous} 和 ${name}。`);
      domainsSeen.set(domain, name);
    }
    const env = str(data.env, `${where}.env`, { default: "prod" });
    if (env !== "dev" && env !== "prod") fail(`${where}.env 只能是 dev 或 prod：${env}`);
    const upstream = normalizeUpstream(str(data.upstream, `${where}.upstream`), `${where}.upstream`);
    const auth = str(data.auth, `${where}.auth`, { default: "none" });
    if (auth !== "none" && auth !== "dev") fail(`${where}.auth 只能是 none 或 dev：${auth}`);
    const sse = bool(data.sse, `${where}.sse`);
    const deploy = parseDeploy(data.deploy, name);
    const extras = readExtras(data, SITE_MODELED_KEYS);
    const site: RegistrySite = {
      name,
      domains,
      env: env as RegistrySiteEnv,
      upstream,
      auth: auth as RegistrySiteAuth,
      sse,
    };
    if (deploy) site.deploy = deploy;
    if (extras) site.extras = extras;
    sites.push(site);
  }
  return sites;
}

function parseVps(raw: unknown): EdgeVpsConfig {
  const data = asMap(raw, "edge.vps");
  const ssh = str(data.ssh, "edge.vps.ssh");
  if (/\s/.test(ssh)) fail("edge.vps.ssh 不能包含空格。");
  const sshKey = str(data.ssh_key, "edge.vps.ssh_key", { default: "~/.ssh/edgectl_vps" });
  const sshPort = int(data.ssh_port, "edge.vps.ssh_port", 22);
  if (sshPort < 1 || sshPort > 65535) fail("edge.vps.ssh_port 必须在 1..65535。");
  const tunnelBind = str(data.tunnel_bind, "edge.vps.tunnel_bind", { default: "172.17.0.1" });
  if (/\s/.test(tunnelBind)) fail("edge.vps.tunnel_bind 不能包含空格。");
  const gatewayPort = int(data.gateway_port, "edge.vps.gateway_port", 18080);
  if (gatewayPort < 1024 || gatewayPort > 65535) fail("edge.vps.gateway_port 必须在 1024..65535。");
  const caddyContainer = str(data.caddy_container, "edge.vps.caddy_container", { default: "caddy" });
  if (!CONTAINER_RE.test(caddyContainer)) fail(`edge.vps.caddy_container 不合法：${caddyContainer}`);
  const caddyfile = absolute(str(data.caddyfile, "edge.vps.caddyfile"), "edge.vps.caddyfile");
  const caddyfileContainer = absolute(
    str(data.caddyfile_container, "edge.vps.caddyfile_container", {
      default: "/etc/caddy/Caddyfile",
    }),
    "edge.vps.caddyfile_container",
  );
  return {
    ssh,
    sshKey,
    sshPort,
    tunnelBind,
    gatewayPort,
    caddyContainer,
    caddyfile,
    caddyfileContainer,
  };
}

function parseLocal(raw: unknown): EdgeLocalConfig {
  const data = asMap(raw, "edge.local");
  const root = absolute(str(data.root, "edge.local.root", { default: "/opt/edgectl" }), "edge.local.root");
  const gatewayImage = str(data.gateway_image, "edge.local.gateway_image", {
    default: "caddy:2-alpine",
  });
  const gatewayContainer = str(data.gateway_container, "edge.local.gateway_container", {
    default: "edgectl-gateway",
  });
  if (!CONTAINER_RE.test(gatewayContainer)) {
    fail(`edge.local.gateway_container 不合法：${gatewayContainer}`);
  }
  const tunnelService = str(data.tunnel_service, "edge.local.tunnel_service", {
    default: "edgectl-tunnel",
  });
  if (!CONTAINER_RE.test(tunnelService)) fail(`edge.local.tunnel_service 不合法：${tunnelService}`);
  const tunnelUser = str(data.tunnel_user, "edge.local.tunnel_user", {
    default: "",
    allowEmpty: true,
  });
  const sshBin = absolute(str(data.ssh_bin, "edge.local.ssh_bin", { default: "/usr/bin/ssh" }), "edge.local.ssh_bin");
  const stateFile = str(data.state_file, "edge.local.state_file", {
    default: ".edgectl/state.json",
  });
  return { root, gatewayImage, gatewayContainer, tunnelService, tunnelUser, sshBin, stateFile };
}

function parseAuth(raw: unknown): EdgeRegistry["authDev"] {
  const data = asMap(raw, "edge.auth");
  const dev = asMap(data.dev, "edge.auth.dev");
  const username = str(dev.username, "edge.auth.dev.username", { default: "example" });
  if (/\s/.test(username) || username.includes(":")) {
    fail("edge.auth.dev.username 不能包含空格或冒号。");
  }
  const cookieName = str(dev.cookie_name, "edge.auth.dev.cookie_name", { default: "edgectl_dev" });
  if (!COOKIE_RE.test(cookieName)) fail("edge.auth.dev.cookie_name 只能包含字母、数字、下划线。");
  const passwordHashEnv = str(dev.password_hash_env, "edge.auth.dev.password_hash_env", {
    default: "EDGECTL_DEV_PASSWORD_HASH",
  });
  const cookieSecretEnv = str(dev.cookie_secret_env, "edge.auth.dev.cookie_secret_env", {
    default: "EDGECTL_DEV_COOKIE_SECRET",
  });
  // 变量名会用于对象/环境查找；拒绝 __proto__、constructor 之类。
  const validEnvName = (name: string): boolean => ENV_NAME_RE.test(name) && !RESERVED_ENV_NAMES.has(name);
  if (!validEnvName(passwordHashEnv)) {
    fail(`edge.auth.dev.password_hash_env 不是合法的环境变量名：${passwordHashEnv}`);
  }
  if (!validEnvName(cookieSecretEnv)) {
    fail(`edge.auth.dev.cookie_secret_env 不是合法的环境变量名：${cookieSecretEnv}`);
  }
  return { username, cookieName, passwordHashEnv, cookieSecretEnv };
}

/** 校验解析后的普通 JS 对象，返回结构化注册表。 */
export function validateRegistry(raw: unknown, source = "<memory>"): EdgeRegistry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("配置文件顶层必须是映射。");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) fail("不支持的配置版本；当前只支持 version: 1。");
  const edge = asMap(record.edge, "edge");
  const vps = parseVps(edge.vps);
  const local = parseLocal(edge.local);
  const authDev = parseAuth(edge.auth);
  const gitlabRaw = asMap(record.gitlab, "gitlab");
  let gitlabUrl: string | null = null;
  if (gitlabRaw.url !== null && gitlabRaw.url !== undefined) {
    gitlabUrl = str(gitlabRaw.url, "gitlab.url").replace(/\/+$/, "");
    let scheme = "";
    try {
      scheme = new URL(gitlabUrl).protocol;
    } catch {
      scheme = "";
    }
    if (scheme !== "http:" && scheme !== "https:") {
      fail("gitlab.url 必须以 http:// 或 https:// 开头。");
    }
  }
  const sites = parseSites(record.sites);
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "version" || key === "edge" || key === "gitlab" || key === "sites") continue;
    extras[key] = value;
  }
  return {
    source: path.resolve(source),
    version: 1,
    vps,
    local,
    authDev,
    gitlabUrl,
    gitlabRaw,
    sites,
    extras,
  };
}

/** 解析注册表文本（不做文件 IO）。 */
export function parseRegistryText(text: string, source = "<memory>"): EdgeRegistry {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    fail(`YAML 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return validateRegistry(parsed, source);
}

/** 读取并校验注册表。文件不存在/解析失败抛中文 EdgeError。 */
export function readRegistry(configPath: string): EdgeRegistry {
  const source = path.resolve(configPath);
  let text: string;
  try {
    text = fs.readFileSync(source, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fail(`找不到 edgectl 配置：${source}`);
    }
    fail(`读取 edgectl 配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseRegistryText(text, source);
  } catch (error) {
    if (error instanceof EdgeError) throw new EdgeError(`${source}：${error.message}`);
    throw error;
  }
}

function siteValue(node: unknown): Record<string, unknown> | undefined {
  if (!isMap(node)) return undefined;
  return node.toJSON() as Record<string, unknown>;
}

function nameOf(node: unknown): string | undefined {
  if (!isMap(node)) return undefined;
  const value = node.get("name");
  return typeof value === "string" ? value : undefined;
}

function collectAnchors(node: unknown): Set<string> {
  const anchors = new Set<string>();
  visit(node as YAMLNode, {
    Node(_key, value) {
      if (isNode(value) && value.anchor) anchors.add(value.anchor);
    },
  });
  return anchors;
}

function assertNoAnchorsOrAliases(doc: Document, managedNodes: unknown[]): void {
  const anchors = new Set<string>();
  for (const node of managedNodes) {
    for (const anchor of collectAnchors(node)) anchors.add(anchor);
  }
  if (anchors.size === 0) return;
  let referenced = false;
  visit(doc, {
    Alias(_key, alias) {
      if (isAlias(alias) && alias.source && anchors.has(alias.source)) referenced = true;
    },
  });
  fail(
    "注册表里的 qubius / co-qubius 条目包含 YAML anchor" +
      (referenced ? "，且被 alias 引用" : "") +
      "；原地修改可能破坏引用，请用 edgectl CLI 或手工编辑。",
  );
}

type ManagedSiteFields = Pick<RegistrySite, "name" | "domains" | "env" | "upstream" | "auth" | "sse">;

function createSiteNode(doc: Document, site: ManagedSiteFields): YAMLMap {
  const node = doc.createNode({
    name: site.name,
    domains: site.domains,
    env: site.env,
    upstream: site.upstream,
    auth: site.auth,
    sse: site.sse,
  }) as YAMLMap;
  const domains = node.get("domains", true);
  if (isSeq(domains)) domains.flow = true;
  return node;
}

function applySiteFields(doc: Document, node: YAMLMap, site: ManagedSiteFields): void {
  node.set("name", doc.createNode(site.name));
  const domains = doc.createNode(site.domains) as YAMLSeq;
  domains.flow = true;
  node.set("domains", domains);
  node.set("env", doc.createNode(site.env));
  node.set("upstream", doc.createNode(site.upstream));
  node.set("auth", doc.createNode(site.auth));
  node.set("sse", doc.createNode(site.sse));
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

interface FileOwner {
  uid: number;
  gid: number;
}

function writeFileAtomic(file: string, content: string, mode: number, owner?: FileOwner): void {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    if (owner) {
      // rename 后 inode 所有者会变；尽量 chown 回原 uid/gid，做不到就拒绝，
      // 避免悄悄改变文件所有权。
      const stat = fs.statSync(tmp);
      if (stat.uid !== owner.uid || stat.gid !== owner.gid) {
        try {
          fs.chownSync(tmp, owner.uid, owner.gid);
        } catch (error) {
          throw new EdgeError(
            `无法保持文件所有权（uid ${owner.uid}/gid ${owner.gid}）：` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能没创建成功。
    }
    throw error;
  }
}

function backupRegistry(file: string, mode: number, owner?: FileOwner): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const base = `${file}.bak.${timestamp()}`;
  let target = base;
  let counter = 1;
  while (fs.existsSync(target)) {
    target = `${base}-${counter}`;
    counter += 1;
  }
  writeFileAtomic(target, fs.readFileSync(file, "utf8"), mode, owner);
  return target;
}

export interface UpsertOptions {
  /** 写入后是否真的落盘；false 时只返回新文本（测试/预览）。 */
  write?: boolean;
}

/**
 * 只更新 qubius / co-qubius 两个条目：已存在则原地改字段（保留 deploy/未知键），
 * 不存在则追加到 sites 末尾。不会删除未在参数里出现的受管条目。
 */
export function upsertManagedSites(
  configPath: string,
  sites: Array<EdgeSite | RegistrySite>,
  options: UpsertOptions = {},
): EdgeUpsertResult {
  const file = path.resolve(configPath);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(`找不到 edgectl 配置：${file}`);
    fail(`读取 edgectl 配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (sites.length === 0) {
    // 两个角色都停用：不产生 desired，也不要重写文件（保留旧条目）。
    parseRegistryText(text, file);
    return { changed: false, text, diff: "注册表无变化\n" };
  }
  if (text.includes("\r\n")) {
    fail("edgectl 配置使用 CRLF 换行；为避免破坏文件，拒绝自动写入，请先转成 LF。");
  }
  for (const site of sites) {
    if (!(MANAGED_SITE_NAMES as readonly string[]).includes(site.name)) {
      fail(`只能 upsert 受管站点（${MANAGED_SITE_NAMES.join(" / ")}），收到：${site.name}`);
    }
  }

  const guard = parseDocument(text);
  if (guard.errors.length > 0) {
    fail(`YAML 解析失败：${guard.errors[0]?.message ?? "未知错误"}`);
  }
  if (guard.toString(REGISTRY_SERIALIZE_OPTIONS) !== text) {
    fail(
      "edgectl 配置用 yaml 序列化后与原文字节不一致（排版/注释会被改动）；" +
        "为避免破坏文件，拒绝自动写入。请用 edgectl CLI 或手工修改。",
    );
  }

  const doc = parseDocument(text);
  let seq = doc.get("sites", true);
  // `sites:`（YAML null）与 edgectl 一样视为空列表。
  if (seq === undefined || seq === null || (isScalar(seq) && seq.value === null)) {
    seq = doc.createNode([]);
    doc.set("sites", seq);
  }
  if (!isSeq(seq)) fail("注册表的 sites 必须是列表。");
  const sitesSeq = seq as YAMLSeq;

  const managedNodes: YAMLMap[] = [];
  for (const item of sitesSeq.items) {
    // alias 形式的条目要先 resolve 才能拿到 name。
    const resolved = isAlias(item) ? item.resolve(doc) : item;
    const name = nameOf(resolved);
    if (name && (MANAGED_SITE_NAMES as readonly string[]).includes(name)) {
      if (!isMap(resolved)) fail(`受管站点 ${name} 不是映射，无法安全修改。`);
      if (isAlias(item)) fail(`受管站点 ${name} 是 YAML alias，无法安全修改。`);
      managedNodes.push(resolved);
    }
  }
  assertNoAnchorsOrAliases(doc, managedNodes);

  for (const site of sites) {
    const existing = sitesSeq.items.find((item) => nameOf(item) === site.name);
    if (existing) {
      if (!isMap(existing)) fail(`受管站点 ${site.name} 不是映射，无法安全修改。`);
      applySiteFields(doc, existing, site);
    } else {
      sitesSeq.items.push(createSiteNode(doc, site));
    }
  }

  let out = doc.toString(REGISTRY_SERIALIZE_OPTIONS);
  if (!out.endsWith("\n")) out += "\n";
  // 写前再校验一次结构，避免产出非法注册表。
  validateRegistry(parse(out), file);

  const diff = renderRegistryDiff(text, out);
  if (out === text) {
    return { changed: false, text: out, diff };
  }
  if (options.write === false) {
    return { changed: true, text: out, diff };
  }

  let mode = 0o600;
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(file);
    mode = stat.mode & 0o777;
  } catch {
    stat = undefined;
  }
  if (stat) {
    // 只有「uid/gid 不同且确实不可写」时才拒绝；root 或可写则继续。
    let writable = true;
    try {
      fs.accessSync(file, fs.constants.W_OK);
      fs.accessSync(path.dirname(file), fs.constants.W_OK);
    } catch {
      writable = false;
    }
    if (!writable) {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
      fail(
        `无权限修改 ${file}：文件属于 uid ${stat.uid}/gid ${stat.gid}，` +
          `当前 uid ${uid ?? "?"}/gid ${gid ?? "?"} 且不可写。`,
      );
    }
  }
  const owner = stat ? { uid: stat.uid, gid: stat.gid } : undefined;
  const backup = backupRegistry(file, mode, owner);
  writeFileAtomic(file, out, mode, owner);
  return { changed: true, text: out, diff, ...(backup ? { backup } : {}) };
}

/**
 * 结构化差异（脱敏）。只比较站点建模字段与 deploy 结构，不输出密钥值。
 * secrets 可选；传了就把其中出现的值替换为 <redacted>。
 */
export function renderRegistryDiff(
  beforeText: string,
  afterText: string,
  secrets: string[] = [],
): string {
  let before: EdgeRegistry | undefined;
  let after: EdgeRegistry | undefined;
  try {
    before = parseRegistryText(beforeText);
    after = parseRegistryText(afterText);
  } catch {
    return redact("<注册表无法解析，差异不可用>\n", secrets);
  }
  const beforeSites = new Map(before.sites.map((site) => [site.name, site]));
  const afterSites = new Map(after.sites.map((site) => [site.name, site]));
  const lines: string[] = [];
  const names = [...new Set([...beforeSites.keys(), ...afterSites.keys()])];
  for (const name of names) {
    const oldSite = beforeSites.get(name);
    const newSite = afterSites.get(name);
    if (!oldSite && newSite) {
      lines.push(`  + 新增站点 ${name}（${newSite.domains.join(", ")} -> ${newSite.upstream}）`);
      continue;
    }
    if (oldSite && !newSite) {
      lines.push(`  - 删除站点 ${name}`);
      continue;
    }
    if (!oldSite || !newSite) continue;
    const changes: string[] = [];
    if (canonicalJson(oldSite.domains) !== canonicalJson(newSite.domains)) {
      changes.push(`domains: ${oldSite.domains.join(", ")} -> ${newSite.domains.join(", ")}`);
    }
    if (oldSite.upstream !== newSite.upstream) changes.push(`upstream: ${oldSite.upstream} -> ${newSite.upstream}`);
    if (oldSite.env !== newSite.env) changes.push(`env: ${oldSite.env} -> ${newSite.env}`);
    if (oldSite.auth !== newSite.auth) changes.push(`auth: ${oldSite.auth} -> ${newSite.auth}`);
    if (oldSite.sse !== newSite.sse) changes.push(`sse: ${oldSite.sse} -> ${newSite.sse}`);
    if (canonicalJson(oldSite.deploy ?? null) !== canonicalJson(newSite.deploy ?? null)) {
      changes.push("deploy: 已更新");
    }
    if (canonicalJson(oldSite.extras ?? null) !== canonicalJson(newSite.extras ?? null)) {
      changes.push("扩展字段: 已更新");
    }
    if (changes.length > 0) {
      lines.push(`  ~ 修改站点 ${name}:`);
      for (const change of changes) lines.push(`      ${change}`);
    }
  }
  const body = lines.length > 0 ? `注册表变更：\n${lines.join("\n")}\n` : "注册表无变化\n";
  return redact(body, secrets);
}

/** 便捷：受管站点当前值（按名字）。 */
export function managedSites(registry: EdgeRegistry): RegistrySite[] {
  return registry.sites.filter((site) => (MANAGED_SITE_NAMES as readonly string[]).includes(site.name));
}

export { siteValue };
