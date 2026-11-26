/* 公网入口（edge）接口契约。服务端在 /api/edge 下提供状态、计划、应用、恢复和回收。 */
import { request } from "./api";

export type EdgeProviderResolved = "cli" | "native";
export type EdgeJobKind = "plan" | "apply" | "restore" | "reclaim";
export type EdgeJobState = "running" | "success" | "failed";
export type EdgeErrorCode = "busy" | "stale" | "residual" | "conflict";

/** 一个对外暴露的站点；domains 是公网域名列表。 */
export interface EdgeSite {
  name: "qubius" | "co-qubius";
  domains: string[];
  env: "dev";
  upstream: string;
  auth: "dev";
  sse: true;
}

export interface EdgeProvider {
  /** 实际使用的执行方式：edgectl CLI 或服务端原生实现；未解析时为 null。 */
  resolved: EdgeProviderResolved | null;
  /** 该结论来自哪里（配置、探测等），原样展示。 */
  source: string;
  available: boolean;
  reason?: string;
}

export interface EdgeRegistry {
  /** 注册表文件名；展示时只取 basename。 */
  name: string;
  sha?: string;
  drift: boolean;
  error?: string;
}

export interface EdgeJob {
  jobId: string;
  state: EdgeJobState;
  kind: EdgeJobKind;
  step: string;
  message: string;
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  logTail?: string;
  remainingPids?: number[];
}

/** 最近一次失败的入口任务；用于恢复表单自动预填。字段以服务端实际返回为准。 */
export interface EdgeLastFailure {
  jobId: string;
  /** 当前远端 Caddyfile 的 sha，不是备份文件的 sha。 */
  remoteSha?: string;
  /** 恢复用的备份文件名（服务端可能给出完整路径，前端只展示 basename）。 */
  backup?: string;
  /** unknown 快照文件名；没有 backup 时用它预填。 */
  unknown?: string;
  /** 备份文件自身的 sha，仅作参考展示。 */
  backupSha?: string;
  /** 失败发生时间。 */
  at?: string;
}

export interface EdgeView {
  enabled: boolean;
  hint?: string;
  provider: EdgeProvider;
  registry: EdgeRegistry;
  desired: EdgeSite[];
  /** deploy 表示部署任务在跑；edge 表示已有入口任务在跑。 */
  appBusy?: "deploy" | "edge" | null;
  lastJob?: EdgeJob | null;
  /** 最近失败详情；有它时可自动预填恢复表单。 */
  lastFailure?: EdgeLastFailure | null;
  canPlan: boolean;
  planHint?: string;
}

export interface EdgePlanView {
  planHash: string;
  provider: EdgeProviderResolved;
  desired: EdgeSite[];
  /** 注册表差异；服务端已脱敏。 */
  registryDiff: string;
  /** 远端差异；服务端已脱敏。 */
  remoteDiff: string;
  warnings: string[];
  requiresConfirmExisting: boolean;
  requiresForceReclaim: boolean;
  /** 服务端判断该计划是否可以直接应用；false 时前端禁用「应用入口」。 */
  appliable?: boolean;
  /** 远端不可用时的说明文案（契约是 string，不是 boolean）。 */
  remoteUnavailable?: string;
}

export interface EdgeApplyBody {
  planHash: string;
  confirmDomain: string;
  confirmExisting?: boolean;
}

export interface EdgeRestoreBody {
  /** 备份文件名（basename）。 */
  backup: string;
  /** 当前远端 Caddyfile 的 sha，不是备份文件的 sha。 */
  remoteSha: string;
  confirmDomain: string;
}

export interface EdgeReclaimBody {
  confirm: "RECLAIM";
  jobId?: string;
}

/** 计划可能探测远端，给比默认请求更长的超时。 */
const EDGE_TIMEOUT_MS = 30_000;
/** 服务端 plan 子进程默认预算 90s（QUBIUS_EDGE_PLAN_TIMEOUT_MS 可配），前端需留出收尾余量。 */
export const PLAN_TIMEOUT_MS = 120_000;

export function getEdgeView(signal?: AbortSignal): Promise<EdgeView> {
  return request("/api/edge", undefined, signal, EDGE_TIMEOUT_MS);
}

export function planEdge(signal?: AbortSignal): Promise<EdgePlanView> {
  return request("/api/edge/plan", { method: "POST", body: "{}" }, signal, PLAN_TIMEOUT_MS);
}

export function applyEdge(body: EdgeApplyBody, signal?: AbortSignal): Promise<{ ok: true; jobId: string }> {
  return request("/api/edge/apply", { method: "POST", body: JSON.stringify(body) }, signal, EDGE_TIMEOUT_MS);
}

export function getEdgeStatus(signal?: AbortSignal): Promise<{ job: EdgeJob | null }> {
  return request("/api/edge/status", undefined, signal, EDGE_TIMEOUT_MS);
}

export function restoreEdge(body: EdgeRestoreBody, signal?: AbortSignal): Promise<{ ok: true; jobId: string }> {
  return request("/api/edge/restore", { method: "POST", body: JSON.stringify(body) }, signal, EDGE_TIMEOUT_MS);
}

export function reclaimEdge(body: EdgeReclaimBody, signal?: AbortSignal): Promise<{ ok: true }> {
  return request("/api/edge/reclaim", { method: "POST", body: JSON.stringify(body) }, signal, EDGE_TIMEOUT_MS);
}

const EDGE_ERROR_CODES: readonly string[] = ["busy", "stale", "residual", "conflict"];

/** 把请求错误里的 code 收窄成公网入口已知的分流码。 */
export function edgeErrorCode(reason: unknown): EdgeErrorCode | undefined {
  if (!(reason instanceof Error)) return undefined;
  const code = (reason as { code?: unknown }).code;
  if (typeof code !== "string" || !EDGE_ERROR_CODES.includes(code)) return undefined;
  return code as EdgeErrorCode;
}

/** busy 错误里的 kind（哪个任务占用了锁），用于提示。 */
export function edgeErrorKind(reason: unknown): string | undefined {
  if (!(reason instanceof Error)) return undefined;
  const kind = (reason as { kind?: unknown }).kind;
  return typeof kind === "string" && kind ? kind : undefined;
}

/** residual 错误里服务端明确给出的任务 id；没有就返回 undefined，避免前端猜。 */
export function edgeErrorJobId(reason: unknown): string | undefined {
  if (!(reason instanceof Error)) return undefined;
  const jobId = (reason as { jobId?: unknown }).jobId;
  return typeof jobId === "string" && jobId ? jobId : undefined;
}

/** residual 错误里的残留进程列表。 */
export function edgeRemainingPids(reason: unknown): number[] {
  if (!(reason instanceof Error)) return [];
  const pids = (reason as { remainingPids?: unknown }).remainingPids;
  if (!Array.isArray(pids)) return [];
  return pids.filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid));
}

/** 只取文件名，避免把完整敏感路径展示到页面上。 */
export function basename(path: string): string {
  const trimmed = path.trim().replace(/[?#].*$/, "");
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

/**
 * 备份文件名白名单：必须本身就是 basename，且不含路径分隔符、空白/控制字符，
 * 也不允许 . 或 ..。用于 restore 的前端校验。
 */
export function isSafeBasename(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (name !== name.trim()) return false;
  if (name !== basename(name)) return false;
  return !/[\s/\\\x00-\x1f\x7f]/.test(name);
}

/**
 * 恢复备份名白名单：只允许 edge-backup-*.Caddyfile / edge-unknown-*.Caddyfile，
 * 字符集与服务端的 [A-Za-z0-9._-]+ 对齐。
 */
export function isEdgeBackupName(name: string): boolean {
  return isSafeBasename(name) && /^edge-(?:backup|unknown)-[A-Za-z0-9._-]+\.Caddyfile$/.test(name);
}

/**
 * 本地网关需要手动更新：只展示 basename，不展示完整路径，也不执行。
 * registry 缺失时给出占位文案。
 */
export function localCommandHint(registry: Pick<EdgeRegistry, "name"> | null | undefined): string {
  const name = basename(registry?.name ?? "") || "<配置文件>";
  return `edgectl apply-local --yes --config ${name}`;
}
