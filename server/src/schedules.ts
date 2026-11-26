import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isEffort, type Effort } from "./types.js";

/** 最短 5 分钟，最长 7 天。 */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 10_080;
const MAX_PROMPT_LENGTH = 5_000;
const MAX_ERROR_LENGTH = 500;

/** 一条按固定间隔重复的日程：每次到点都用固定 prompt 新建一个对话。 */
export interface Schedule {
  id: string;
  projectId: string;
  prompt: string;
  providerId: string;
  model: string;
  effort: Effort;
  intervalMinutes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastError?: string;
}

export type CreateScheduleInput =
  Omit<Schedule, "id" | "createdAt" | "updatedAt" | "nextRunAt" | "enabled" | "lastRunAt" | "lastError">
  & { enabled?: boolean };

export interface SchedulePatch {
  enabled?: boolean;
  intervalMinutes?: number;
  prompt?: string;
}

export interface MarkRunResult {
  lastRunAt: Date;
  nextRunAt: Date;
  lastError?: string;
}

function schedulesPath(dataDir: string): string {
  return path.join(dataDir, "schedules.json");
}

function assertInterval(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_INTERVAL_MINUTES || value > MAX_INTERVAL_MINUTES) {
    throw new Error(`间隔必须是 ${MIN_INTERVAL_MINUTES} 到 ${MAX_INTERVAL_MINUTES} 分钟的整数`);
  }
}

function normalizePrompt(value: unknown): string {
  if (typeof value !== "string") throw new Error("prompt 不能为空");
  const prompt = value.trim();
  if (!prompt) throw new Error("prompt 不能为空");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`prompt 太长（最多 ${MAX_PROMPT_LENGTH} 字）`);
  return prompt;
}

function normalizeName(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空`);
  return value.trim();
}

function readStored(value: unknown): Schedule {
  if (!value || typeof value !== "object") throw new Error("日程格式不对");
  const record = value as Record<string, unknown>;
  const id = normalizeName(record.id, "id");
  const projectId = normalizeName(record.projectId, "projectId");
  const prompt = normalizePrompt(record.prompt);
  const providerId = normalizeName(record.providerId, "providerId");
  const model = normalizeName(record.model, "model");
  if (!isEffort(record.effort)) throw new Error("effort 无效");
  assertInterval(record.intervalMinutes);
  if (typeof record.enabled !== "boolean") throw new Error("enabled 无效");
  const createdAt = normalizeTimestamp(record.createdAt);
  const updatedAt = normalizeTimestamp(record.updatedAt);
  const nextRunAt = normalizeTimestamp(record.nextRunAt);
  const lastRunAt = record.lastRunAt === undefined ? undefined : normalizeTimestamp(record.lastRunAt);
  if (record.lastError !== undefined && typeof record.lastError !== "string") throw new Error("lastError 无效");
  return {
    id,
    projectId,
    prompt,
    providerId,
    model,
    effort: record.effort,
    intervalMinutes: record.intervalMinutes,
    enabled: record.enabled,
    createdAt,
    updatedAt,
    nextRunAt,
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  };
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("时间格式不对");
  return new Date(value).toISOString();
}

/** 列表与持久化顺序：创建时间升序，同一时刻按 id。 */
function compareSchedules(
  a: Pick<Schedule, "createdAt" | "id">,
  b: Pick<Schedule, "createdAt" | "id">,
): number {
  const byCreated = a.createdAt.localeCompare(b.createdAt);
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

/** schedules.json 的读写。所有写操作立即落盘，先写临时文件再 rename。 */
export class ScheduleStore {
  private schedules = new Map<string, Schedule>();
  /**
   * 与 schedules 同步维护的 id 有序数组（createdAt/id 不会变，只有增删需要调整）。
   * 这样 list()/due() 不需要每次全量排序；排序只在写入单条时做局部插入。
   */
  private order: string[] = [];
  private readonly file: string;
  private readonly now: () => Date;

  constructor(private dataDir: string, now: () => Date = () => new Date()) {
    this.file = schedulesPath(dataDir);
    this.now = now;
    this.load();
  }

  private load(): void {
    this.order = [];
    if (!fs.existsSync(this.file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      throw new Error(`无法读取日程文件 ${this.file}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`无法读取日程文件 ${this.file}`);
    // 单条坏数据只跳过并告警，和 store.ts 的策略一致；整份文件坏掉才报错。
    for (const item of parsed) {
      try {
        const schedule = readStored(item);
        this.schedules.set(schedule.id, schedule);
      } catch (error) {
        console.warn(
          `跳过无法读取的日程条目 ${this.file}: ${error instanceof Error ? error.message : "格式不对"}`,
        );
      }
    }
    this.order = [...this.schedules.values()]
      .sort(compareSchedules)
      .map((schedule) => schedule.id);
  }

  private persist(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const body = JSON.stringify(this.sorted(), null, 2);
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 临时文件可能根本没写出来，忽略清理失败。
      }
      throw error;
    }
  }

  /**
   * 先改内存再落盘；写盘失败时执行 rollback 恢复被改动的那一条（不再克隆
   * 整张 Map），然后重新抛出，避免内存里留下磁盘上没有的半截状态。
   */
  private commit(apply: () => void, rollback: () => void): void {
    apply();
    try {
      this.persist();
    } catch (error) {
      rollback();
      throw error;
    }
  }

  /** 按维护好的顺序返回 live 引用（调用方需要副本时自行 clone）。 */
  private sorted(): Schedule[] {
    const result: Schedule[] = [];
    for (const id of this.order) {
      const schedule = this.schedules.get(id);
      if (schedule) result.push(schedule);
    }
    return result;
  }

  /** 在有序数组中按 (createdAt, id) 插入。 */
  private insertOrder(schedule: Schedule): number {
    let low = 0;
    let high = this.order.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const other = this.schedules.get(this.order[mid]!);
      if (other && compareSchedules(other, schedule) <= 0) low = mid + 1;
      else high = mid;
    }
    this.order.splice(low, 0, schedule.id);
    return low;
  }

  private get(id: string): Schedule | undefined {
    return this.schedules.get(id);
  }

  /** 按 id 直接取（返回副本）；供 runner 避免 list().find()。 */
  getById(id: string): Schedule | undefined {
    const schedule = this.schedules.get(id);
    return schedule ? { ...schedule } : undefined;
  }

  private nextFrom(intervalMinutes: number): string {
    return new Date(this.now().getTime() + intervalMinutes * 60_000).toISOString();
  }

  list(projectId?: string): Schedule[] {
    return this.sorted()
      .filter((schedule) => projectId === undefined || schedule.projectId === projectId)
      .map((schedule) => ({ ...schedule }));
  }

  create(input: CreateScheduleInput): Schedule {
    const projectId = normalizeName(input.projectId, "projectId");
    const prompt = normalizePrompt(input.prompt);
    const providerId = normalizeName(input.providerId, "providerId");
    const model = normalizeName(input.model, "model");
    if (!isEffort(input.effort)) throw new Error("effort 必须是 low、medium、high、xhigh 或 max");
    assertInterval(input.intervalMinutes);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new Error("enabled 必须是布尔值");
    }

    const at = this.now().toISOString();
    const schedule: Schedule = {
      id: randomUUID(),
      projectId,
      prompt,
      providerId,
      model,
      effort: input.effort,
      intervalMinutes: input.intervalMinutes,
      enabled: input.enabled ?? true,
      createdAt: at,
      updatedAt: at,
      nextRunAt: this.nextFrom(input.intervalMinutes),
    };
    this.commit(
      () => {
        this.schedules.set(schedule.id, schedule);
        this.insertOrder(schedule);
      },
      () => {
        this.schedules.delete(schedule.id);
        this.order = this.order.filter((item) => item !== schedule.id);
      },
    );
    return { ...schedule };
  }

  update(id: string, patch: SchedulePatch): Schedule {
    const schedule = this.get(id);
    if (!schedule) throw new Error("找不到定时任务");

    // 全部先校验/规范化到局部变量；任何一项失败都不会碰到内存。
    let prompt = schedule.prompt;
    if (patch.prompt !== undefined) prompt = normalizePrompt(patch.prompt);
    let intervalMinutes = schedule.intervalMinutes;
    let intervalChanged = false;
    if (patch.intervalMinutes !== undefined) {
      assertInterval(patch.intervalMinutes);
      if (patch.intervalMinutes !== intervalMinutes) {
        intervalMinutes = patch.intervalMinutes;
        intervalChanged = true;
      }
    }
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
      throw new Error("enabled 必须是布尔值");
    }
    const enabled = patch.enabled ?? schedule.enabled;
    const at = this.now();
    let nextRunAt = schedule.nextRunAt;
    // 从关到开或间隔变化时从现在起重新计时，避免补跑停用期间错过的次数。
    if (intervalChanged || (enabled && !schedule.enabled)) {
      nextRunAt = new Date(at.getTime() + intervalMinutes * 60_000).toISOString();
    }

    const next: Schedule = {
      ...schedule,
      prompt,
      intervalMinutes,
      enabled,
      nextRunAt,
      updatedAt: at.toISOString(),
    };
    this.commit(
      () => {
        this.schedules.set(id, next);
      },
      () => {
        this.schedules.set(id, schedule);
      },
    );
    return { ...next };
  }

  remove(id: string): boolean {
    const schedule = this.schedules.get(id);
    if (!schedule) return false;
    const index = this.order.indexOf(id);
    this.commit(
      () => {
        this.schedules.delete(id);
        if (index >= 0) this.order.splice(index, 1);
      },
      () => {
        this.schedules.set(id, schedule);
        if (index >= 0) this.order.splice(index, 0, id);
        else this.insertOrder(schedule);
      },
    );
    return true;
  }

  due(now: Date): Schedule[] {
    const cutoff = now.getTime();
    const result: Schedule[] = [];
    for (const id of this.order) {
      const schedule = this.schedules.get(id);
      if (!schedule || !schedule.enabled) continue;
      if (Date.parse(schedule.nextRunAt) <= cutoff) result.push({ ...schedule });
    }
    return result;
  }

  /** 最近一个启用日程的 nextRunAt（毫秒时间戳）；没有启用日程时返回 null。 */
  nextEnabledRunAt(): number | null {
    let next: number | null = null;
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      const at = Date.parse(schedule.nextRunAt);
      if (!Number.isFinite(at)) continue;
      if (next === null || at < next) next = at;
    }
    return next;
  }

  /** 运行结束后更新状态；日程已被删除时幂等返回 false。 */
  markRun(id: string, result: MarkRunResult): boolean {
    const schedule = this.get(id);
    if (!schedule) return false;
    const next: Schedule = {
      ...schedule,
      lastRunAt: result.lastRunAt.toISOString(),
      nextRunAt: result.nextRunAt.toISOString(),
      updatedAt: result.lastRunAt.toISOString(),
    };
    if (result.lastError === undefined) {
      delete next.lastError;
    } else {
      next.lastError = result.lastError;
    }
    this.commit(
      () => {
        this.schedules.set(id, next);
      },
      () => {
        this.schedules.set(id, schedule);
      },
    );
    return true;
  }
}

export interface ScheduleRunResult {
  scheduleId: string;
  ok: boolean;
  sessionId?: string;
  error?: string;
}

export interface ScheduleRunnerDeps {
  store: ScheduleStore;
  createSession: (schedule: Schedule) => Promise<{ id: string } | void>;
  now?: () => Date;
  tickMs?: number;
}

/** 已到点但暂不能跑（例如同一日程仍在途/markRun 失败）时的最小重试间隔。 */
const MIN_RETRY_DELAY_MS = 1_000;

/** 到点后逐条串行创建对话，避免同时开太多 worktree。 */
export class ScheduleRunner {
  private readonly store: ScheduleStore;
  private readonly createSession: (schedule: Schedule) => Promise<{ id: string } | void>;
  private readonly now: () => Date;
  private readonly tickMs: number;
  /** 在跑的日程 id：同时在途的 tick 不会对同一条重复创建对话。 */
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  /** tick/重排异常的按 context 节流日志时间。 */
  private readonly errorLogAt = new Map<string, number>();

  constructor(deps: ScheduleRunnerDeps) {
    this.store = deps.store;
    this.createSession = deps.createSession;
    this.now = deps.now ?? (() => new Date());
    this.tickMs = deps.tickMs ?? 30_000;
  }

  private nextFrom(intervalMinutes: number): Date {
    return new Date(this.now().getTime() + intervalMinutes * 60_000);
  }

  private findSchedule(id: string): Schedule | undefined {
    return this.store.getById(id);
  }

  /**
   * 跑一条日程。执行前重新查存储，确认它仍然存在且启用；否则返回 null 跳过。
   * mode === "due" 时还要求它仍然到点：runDue 用的是开头快照，期间可能已被
   * runNow 或重叠 tick 跑过并推进了 nextRunAt，不能再用旧快照补跑一次。
   */
  private async runOne(id: string, mode: "due" | "now"): Promise<ScheduleRunResult | null> {
    this.inFlight.add(id);
    try {
      const schedule = this.findSchedule(id);
      if (!schedule || !schedule.enabled) return null;
      if (mode === "due" && Date.parse(schedule.nextRunAt) > this.now().getTime()) return null;
      const result = await this.createSession(schedule);
      const latest = this.findSchedule(id);
      if (!latest) return { scheduleId: id, ok: false, error: "定时任务已被删除" };
      this.store.markRun(id, {
        lastRunAt: this.now(),
        nextRunAt: this.nextFrom(latest.intervalMinutes),
      });
      const sessionId = result?.id;
      return {
        scheduleId: id,
        ok: true,
        ...(typeof sessionId === "string" && sessionId ? { sessionId } : {}),
      };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
      // 失败的日程同样推进到下一个周期；已被删除时 markRun 幂等跳过。
      const latest = this.findSchedule(id);
      if (latest) {
        this.store.markRun(id, {
          lastRunAt: this.now(),
          nextRunAt: this.nextFrom(latest.intervalMinutes),
          lastError: message,
        });
      }
      return { scheduleId: id, ok: false, error: message };
    } finally {
      this.inFlight.delete(id);
    }
  }

  async runDue(): Promise<ScheduleRunResult[]> {
    const results: ScheduleRunResult[] = [];
    for (const schedule of this.store.due(this.now())) {
      if (this.inFlight.has(schedule.id)) continue;
      try {
        const result = await this.runOne(schedule.id, "due");
        if (result) results.push(result);
      } catch (error) {
        // runOne 自身已经处理业务失败；这里兜底写盘错误等异常，不能中断后面的日程。
        const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
        results.push({ scheduleId: schedule.id, ok: false, error: message });
      }
    }
    return results;
  }

  /** 「立即运行」：不等到点，直接跑一次并重新计时。 */
  async runNow(id: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    if (this.inFlight.has(id)) return { ok: false, error: "定时任务正在运行" };
    const schedule = this.findSchedule(id);
    if (!schedule) return { ok: false, error: "找不到定时任务" };
    if (!schedule.enabled) return { ok: false, error: "定时任务已停用" };
    let result: ScheduleRunResult | null;
    try {
      result = await this.runOne(id, "now");
    } catch (error) {
      return {
        ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH),
      };
    }
    if (!result) {
      return this.findSchedule(id)
        ? { ok: false, error: "定时任务已停用" }
        : { ok: false, error: "找不到定时任务" };
    }
    return {
      ok: result.ok,
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }

  /**
   * 只保留一个 setTimeout：睡到最近的 nextRunAt（上限仍是 tickMs）。
   * 触发后先跑一轮 due，再按新的 nextRunAt 重排。
   */
  private tickCap(): number {
    return Number.isFinite(this.tickMs) && this.tickMs > 0 ? this.tickMs : 30_000;
  }

  private reportTickError(context: string, error: unknown): void {
    // 调度异常可能每 1s 出现一次；按 context 各自节流到每分钟一条，避免刷爆日志。
    const now = Date.now();
    const last = this.errorLogAt.get(context) ?? 0;
    if (now - last < 60_000) return;
    this.errorLogAt.set(context, now);
    console.error(`[schedules] ${context}:`, error);
  }

  private scheduleFallback(): void {
    if (!this.started) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.tickCap());
    this.timer.unref?.();
  }

  private scheduleNext(): void {
    if (!this.started) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const cap = this.tickCap();
    const now = this.now().getTime();
    const next = this.store.nextEnabledRunAt();
    let delay: number;
    if (next === null) {
      // 没有启用日程：仍按 tick 上限醒来，以便发现新创建/重新启用的日程。
      delay = cap;
    } else {
      const remaining = next - now;
      if (!Number.isFinite(remaining)) {
        // 注入的 now 不可解析（Invalid Date）时退回固定 tick，避免 NaN 造成忙循环。
        delay = cap;
      } else if (remaining <= 0) {
        // 已到点（例如同一条仍在途）时用最小重试间隔，避免忙循环。
        delay = Math.min(cap, MIN_RETRY_DELAY_MS);
      } else {
        delay = Math.min(cap, remaining);
      }
    }
    if (!Number.isFinite(delay) || delay < 1) delay = Math.max(1, cap);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.started) return;
    try {
      await this.runDue();
    } catch (error) {
      // runDue 内部已逐条兜底；这里只保护调度循环不因意外异常停摆。
      this.reportTickError("runDue 异常", error);
    }
    try {
      this.scheduleNext();
    } catch (error) {
      // 计算下一次唤醒失败时退回到固定 tick，避免抛异常后调度彻底停止。
      this.reportTickError("重排失败，退回固定 tick", error);
      this.scheduleFallback();
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.scheduleNext();
    } catch (error) {
      this.reportTickError("启动调度失败，退回固定 tick", error);
      this.scheduleFallback();
    }
  }

  stop(): void {
    this.started = false;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
