import { randomUUID } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import * as webpush from "web-push";
import type { PendingRequest, Phase } from "./types.js";

/**
 * 这条文件是服务器端 Web Push 的共享接口骨架。
 * http.ts / index.ts 只依赖这里的公开签名；实现（VAPID、订阅持久化、
 * web-push 发送、完成状态检测）在同一次提交里补齐，不改下面的签名。
 */

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** 通知正文由 service worker 直接显示。 */
export interface PushNotice {
  title: string;
  body: string;
  /** 点击通知后打开的前端路径，例如 /sessions/<id>。 */
  url: string;
  /** 同一个 tag 的通知会互相替换。 */
  tag?: string;
}

export interface PushSendResult {
  sent: number;
  failed: number;
}

export interface PushStatus {
  /** VAPID 公钥，前端 pushManager.subscribe 用。 */
  publicKey: string;
  /** 已保存的订阅数量。 */
  count: number;
}

/** 完成检测用的会话事件，字段来自 Store 的 SessionEvent。 */
export interface PushSessionEvent {
  id: string;
  projectId: string;
  title: string;
  phase: Phase;
  lastError?: string;
  /** 已结束的轮次数；增加即代表“本轮结束”，由 Store 在 result 落定时累加。 */
  turnEnd?: number;
  /** 最近一轮的结果；子 agent 收尾不会改写它。 */
  lastResult?: "success" | "error" | "stopped";
  /** 子 agent 状态：本轮结束时失败的子任务也应算作失败。 */
  subagents?: ReadonlyArray<{ status: string }>;
  /** 进入 needs_input 时正在等待确认或回答的请求。 */
  pending?: PendingRequest | null;
  removed?: boolean;
}

/** 可注入的发送器，测试里用它避免真的访问推送服务。 */
export type PushSender = (subscription: PushSubscriptionInput, payload: string) => Promise<void>;

/** 订阅校验失败等用户可修正的错误。 */
export class PushError extends Error {}

const DEFAULT_VAPID_SUBJECT = "mailto:admin@example.com";

/**
 * VAPID subject 告诉推送服务如何联系站点管理员。
 * 默认是占位邮箱；部署时可用 QUBIUS_VAPID_SUBJECT 覆盖，必须是
 * mailto: 或 https:// 地址。非法值在构造 PushService 时直接报错。
 */
export function vapidSubject(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.QUBIUS_VAPID_SUBJECT?.trim();
  const subject = configured || DEFAULT_VAPID_SUBJECT;
  const lower = subject.toLowerCase();
  if (!lower.startsWith("mailto:") && !lower.startsWith("https://")) {
    throw new PushError("QUBIUS_VAPID_SUBJECT 必须以 mailto: 或 https:// 开头");
  }
  try {
    // 前缀正确但缺少 host 等信息（例如 https://）时也算非法。
    new URL(subject);
  } catch {
    throw new PushError("QUBIUS_VAPID_SUBJECT 不是合法的 URL");
  }
  return subject;
}

/**
 * 某些网络（开发机 -> Apple 推送服务实测）下，Node 默认的 happy-eyeballs
 * 并行连接会让所有地址都 ETIMEDOUT，单连接（curl）却正常。关闭自动地址
 * 选择后按 DNS 顺序连接即可。所有推送请求共用一个连接池。
 */
const PUSH_AGENT = new https.Agent({ autoSelectFamily: false });
const MAX_SUBSCRIPTIONS = 20;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_BODY_LENGTH = 200;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export class PushService {
  private readonly pushDir: string;
  private readonly vapidFile: string;
  private readonly subscriptionsFile: string;
  private readonly vapidSubject: string;
  private readonly send?: PushSender;
  private subscriptions: PushSubscriptionInput[];
  private vapid: VapidKeys | null = null;
  /** 每个会话上次处理过的轮次结束计数；只在计数增加时推送完成/失败。 */
  private readonly turnEnds = new Map<string, number>();
  /** 每个会话最近一次已通知的 pending.requestId，避免同一个确认重复推送。 */
  private readonly pendingNotified = new Map<string, string>();

  constructor(dataDir: string, deps: { send?: PushSender } = {}) {
    this.pushDir = path.join(dataDir, "push");
    this.vapidFile = path.join(this.pushDir, "vapid.json");
    this.subscriptionsFile = path.join(this.pushDir, "subscriptions.json");
    this.vapidSubject = vapidSubject();
    this.send = deps.send;
    this.subscriptions = this.loadSubscriptions();
  }

  status(): PushStatus {
    const keys = this.ensureVapid();
    return { publicKey: keys.publicKey, count: this.subscriptions.length };
  }

  /** 保存浏览器推送订阅；input 来自 HTTP 请求体，必须做严格校验。 */
  subscribe(input: unknown): { count: number } {
    const subscription = readSubscription(input);
    const index = this.subscriptions.findIndex((item) => item.endpoint === subscription.endpoint);
    let next: PushSubscriptionInput[];
    if (index >= 0) {
      next = this.subscriptions.slice();
      next[index] = subscription;
    } else {
      if (this.subscriptions.length >= MAX_SUBSCRIPTIONS) {
        throw new PushError(`推送订阅最多 ${MAX_SUBSCRIPTIONS} 条，请先删除不用的设备`);
      }
      next = [...this.subscriptions, subscription];
    }
    this.writeSubscriptions(next);
    this.subscriptions = next;
    return { count: next.length };
  }

  /** 删除订阅，input 形如 { endpoint: string }。 */
  unsubscribe(input: unknown): { count: number } {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new PushError("取消推送订阅的请求格式不正确");
    }
    const endpoint = (input as Record<string, unknown>).endpoint;
    if (typeof endpoint !== "string") throw new PushError("缺少推送订阅地址");
    const target = endpoint.trim();
    const next = this.subscriptions.filter((item) => item.endpoint !== target);
    if (next.length !== this.subscriptions.length) {
      this.writeSubscriptions(next);
      this.subscriptions = next;
    }
    return { count: next.length };
  }

  /** 给所有订阅发一条测试通知。 */
  async sendTest(): Promise<PushSendResult> {
    return this.sendToAll({
      title: "测试通知",
      body: "qubius 推送已配置好。",
      url: "/",
      tag: "test",
    });
  }

  /**
   * 处理 Store 的会话事件：
   * - needs_input 分支按 pending.requestId 去重：拿到新的确认请求就发一次，
   *   同一请求重复上报不重复发；没有 pending 时不发。
   * - 完成/失败只在“本轮结束”时发一次，用 Store 的 turnEnd 计数判断。
   *   后台子 agent 跑完也会让 phase 从 running 落到 completed，但那不算本轮
   *   结束（可能比本轮结束还晚），不再单独推送。
   * 返回的 Promise 不阻塞调用方（内部自行吞掉发送错误）。
   */
  onSessionEvent(event: PushSessionEvent, projectName: string): void {
    if (event.removed) {
      this.turnEnds.delete(event.id);
      this.pendingNotified.delete(event.id);
      return;
    }
    const turnEnd = event.turnEnd ?? 0;
    const previousTurnEnd = this.turnEnds.get(event.id) ?? 0;
    this.turnEnds.set(event.id, turnEnd);

    if (event.phase === "needs_input") {
      // 不依赖 previous：例如 completed 后再次进入等待确认也要通知。
      const requestId = event.pending?.requestId;
      if (!requestId) return;
      if (this.pendingNotified.get(event.id) === requestId) return;
      if (this.subscriptions.length === 0) return;
      this.pendingNotified.set(event.id, requestId);
      this.notify(event, needsInputNotice(event, projectName));
      return;
    }

    if (event.phase === "completed" || event.phase === "failed" || event.phase === "stopped") {
      this.pendingNotified.delete(event.id);
    }
    if (turnEnd <= previousTurnEnd) return;
    // 用户主动停止不推送；失败/完成都以本轮结果为准。
    if (event.lastResult !== "success" && event.lastResult !== "error") return;
    if (this.subscriptions.length === 0) return;
    this.notify(event, sessionNotice(event, projectName));
  }

  private notify(event: PushSessionEvent, notice: PushNotice): void {
    void this.sendToAll(notice).catch((error: unknown) => {
      // 只记录状态码/错误码，避免把订阅 endpoint 或密钥写进日志。
      console.error(`推送通知发送失败（会话 ${event.id}）：${errorSummary(error)}`);
    });
  }

  private async sendToAll(notice: PushNotice): Promise<PushSendResult> {
    const subscriptions = this.subscriptions.slice();
    if (subscriptions.length === 0) return { sent: 0, failed: 0 };
    const payload = JSON.stringify(notice);
    if (!this.send) {
      const keys = this.ensureVapid();
      webpush.setVapidDetails(this.vapidSubject, keys.publicKey, keys.privateKey);
    }
    let sent = 0;
    let failed = 0;
    const gone: string[] = [];
    await Promise.all(subscriptions.map(async (subscription) => {
      try {
        if (this.send) await this.send(subscription, payload);
        // 对端长期不响应时及时失败，避免通知 promise 无限挂起。
        else await webpush.sendNotification(subscription, payload, {
          TTL: 3600,
          timeout: 10_000,
          agent: PUSH_AGENT,
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        if (isGoneStatus(error)) gone.push(subscription.endpoint);
      }
    }));
    if (gone.length > 0) this.removeEndpoints(gone);
    return { sent, failed };
  }

  private removeEndpoints(endpoints: string[]): void {
    const drop = new Set(endpoints);
    const next = this.subscriptions.filter((item) => !drop.has(item.endpoint));
    if (next.length === this.subscriptions.length) return;
    this.writeSubscriptions(next);
    this.subscriptions = next;
  }

  private loadSubscriptions(): PushSubscriptionInput[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.subscriptionsFile, "utf8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PushError("推送订阅文件损坏，无法读取已有订阅");
    }
    if (!Array.isArray(parsed)) throw new PushError("推送订阅文件损坏，无法读取已有订阅");
    return parsed.map((item) => {
      try {
        return readSubscription(item);
      } catch {
        // 不静默丢掉用户数据：保留原文件并明确报错。
        throw new PushError("推送订阅文件损坏，无法读取已有订阅");
      }
    });
  }

  private ensureVapid(): VapidKeys {
    if (this.vapid) return this.vapid;
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(this.vapidFile, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new PushError("VAPID 密钥文件损坏，请删除后重试");
      }
      this.vapid = readVapidKeys(parsed);
      return this.vapid;
    }
    const generated = webpush.generateVAPIDKeys();
    const keys: VapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    this.writePrivateFile(this.vapidFile, JSON.stringify(keys, null, 2));
    this.vapid = keys;
    return keys;
  }

  private writeSubscriptions(subscriptions: PushSubscriptionInput[]): void {
    this.writePrivateFile(this.subscriptionsFile, JSON.stringify(subscriptions, null, 2));
  }

  /** 写入敏感文件：目录 0700、文件 0600，用临时文件 + rename 原子替换。 */
  private writePrivateFile(file: string, body: string): void {
    fs.mkdirSync(this.pushDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.pushDir, 0o700);
    } catch {
      // Windows 或受限文件系统上 chmod 可能无效，文件仍然只放在 dataDir。
    }
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 临时文件可能根本没写成功。
      }
      throw error;
    }
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // 同上。
    }
  }
}

function needsInputNotice(event: PushSessionEvent, projectName: string): PushNotice {
  let body = event.title;
  const pending = event.pending;
  if (pending?.kind === "question") {
    const first = pending.questions?.[0];
    body = first?.question || first?.header || event.title;
  } else if (pending) {
    const path = pending.blockedPath ? `：${pending.blockedPath}` : "";
    body = pending.toolName ? `${pending.toolName}${path}` : event.title;
  }
  if (body.length > MAX_BODY_LENGTH) body = body.slice(0, MAX_BODY_LENGTH);
  return {
    title: `${projectName} · 等待确认`,
    body,
    url: `/sessions/${event.id}`,
    tag: `session-${event.id}`,
  };
}

function sessionNotice(event: PushSessionEvent, projectName: string): PushNotice {
  // 本轮结束的那一刻后台子 agent 可能还在跑（phase 仍是 running），
  // 所以失败与否看本轮结果；已经失败的子任务也算失败。
  const failed = event.lastResult === "error"
    || event.phase === "failed"
    || (event.subagents ?? []).some((item) => item.status === "failed");
  let body = event.title;
  if (failed && event.lastError) body += `：${event.lastError}`;
  if (body.length > MAX_BODY_LENGTH) body = body.slice(0, MAX_BODY_LENGTH);
  return {
    title: `${projectName} · ${failed ? "失败" : "完成"}`,
    body,
    url: `/sessions/${event.id}`,
    tag: `session-${event.id}`,
  };
}

function readSubscription(input: unknown): PushSubscriptionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PushError("推送订阅格式不正确");
  }
  const record = input as Record<string, unknown>;
  const endpoint = readEndpoint(record.endpoint);
  const keys = record.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new PushError("推送订阅缺少密钥");
  }
  const keyRecord = keys as Record<string, unknown>;
  return {
    endpoint,
    keys: {
      p256dh: readKey(keyRecord.p256dh, "p256dh", 65),
      auth: readKey(keyRecord.auth, "auth", 16),
    },
  };
}

function readEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new PushError("推送订阅地址无效");
  const endpoint = value.trim();
  if (!endpoint) throw new PushError("推送订阅地址不能为空");
  if (endpoint.length > MAX_ENDPOINT_LENGTH) throw new PushError("推送订阅地址过长");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushError("推送订阅地址不是有效的 URL");
  }
  if (url.protocol !== "https:") throw new PushError("推送订阅地址必须是 https 地址");
  if (url.username || url.password) throw new PushError("推送订阅地址不能包含用户名或密码");
  return endpoint;
}

function readKey(value: unknown, field: string, bytes: number): string {
  if (typeof value !== "string" || !value) {
    throw new PushError(`推送订阅缺少 ${field} 密钥`);
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new PushError(`推送订阅的 ${field} 密钥不是合法的 base64url`);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new PushError(`推送订阅的 ${field} 密钥不是合法的 base64url`);
  }
  if (decoded.length !== bytes) {
    throw new PushError(`推送订阅的 ${field} 密钥长度应为 ${bytes} 字节`);
  }
  return value;
}

function readVapidKeys(value: unknown): VapidKeys {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PushError("VAPID 密钥文件损坏，请删除后重试");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.publicKey !== "string" || !record.publicKey
    || typeof record.privateKey !== "string" || !record.privateKey) {
    throw new PushError("VAPID 密钥文件损坏，请删除后重试");
  }
  return { publicKey: record.publicKey, privateKey: record.privateKey };
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isGoneStatus(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { statusCode?: unknown }).statusCode;
  return status === 404 || status === 410;
}

function errorSummary(error: unknown): string {
  if (error instanceof PushError) return error.message;
  if (error && typeof error === "object") {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") return `推送服务返回 ${status}`;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "未知错误";
}
