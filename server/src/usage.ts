import type { TranscriptItem, UsageTotals } from "./types.js";

/** 每百万 token 的美元价格；缺失表示该项不计算成本。 */
export interface Pricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 金额统一用美元，按每百万 token 的单价换算。 */
export interface Cost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageSessionInput {
  id: string;
  title: string;
  projectId: string;
  providerId: string;
  providerName: string;
  messages?: TranscriptItem[];
  /**
   * 已缓存的会话汇总（由调用方维护，例如 Store 按会话缓存）。
   * 提供时不再扫描 messages；报告里会返回独立副本，不会泄露缓存对象。
   */
  totals?: UsageTotals;
  /** 按接口拆分的缓存汇总（多模型角色团队会话会把不同角色的用量记到各自接口）。 */
  byProvider?: ProviderUsageBucket[];
}

/** 单个接口在一场会话里的 token 累计；用于按实际接口统计跨模型会话的用量和成本。 */
export interface ProviderUsageBucket {
  providerId: string;
  providerName: string;
  totals: UsageTotals;
}

export interface UsageProviderInput {
  id: string;
  name: string;
  pricing?: Pricing;
}

export interface ProviderUsage {
  providerId: string;
  providerName: string;
  totals: UsageTotals;
  cost: number;
}

export interface SessionUsage {
  id: string;
  title: string;
  projectId: string;
  totals: UsageTotals;
  cost: number;
}

export interface UsageReport {
  totals: UsageTotals;
  cost: number;
  byProvider: ProviderUsage[];
  bySession: SessionUsage[];
}

const TOKENS_PER_UNIT = 1_000_000;

export function emptyTotals(): UsageTotals {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * 汇总对话里的 token 用量。只统计带 usage 的 assistant 条目；
 * 每次调用（calls）按条目计，缓存 token 单独累计。
 */
export function summarizeMessages(messages: TranscriptItem[]): UsageTotals {
  const totals = emptyTotals();
  for (const item of messages) {
    if (item.role !== "assistant" || !item.usage) continue;
    totals.calls += 1;
    totals.input += tokenCount(item.usage.input);
    totals.output += tokenCount(item.usage.output);
    totals.cacheRead += tokenCount(item.usage.cacheRead);
    totals.cacheWrite += tokenCount(item.usage.cacheWrite);
  }
  return totals;
}

/**
 * 按实际调用的接口拆分汇总消息用量：prl-role 的条目在 roleRun 上记着真实
 * providerId/providerName，其余条目归到会话默认接口。
 */
export function summarizeMessagesByProvider(
  messages: TranscriptItem[],
  fallbackProviderId: string,
  fallbackProviderName: string,
): ProviderUsageBucket[] {
  const buckets = new Map<string, ProviderUsageBucket>();
  for (const item of messages) {
    if (item.role !== "assistant" || !item.usage) continue;
    const roleProviderId = typeof item.roleRun?.providerId === "string" ? item.roleRun.providerId.trim() : "";
    const roleProviderName = typeof item.roleRun?.providerName === "string" ? item.roleRun.providerName.trim() : "";
    const providerId = roleProviderId || fallbackProviderId;
    const providerName = roleProviderId
      ? (roleProviderName || roleProviderId)
      : (fallbackProviderName || fallbackProviderId);
    let bucket = buckets.get(providerId);
    if (!bucket) {
      bucket = { providerId, providerName, totals: emptyTotals() };
      buckets.set(providerId, bucket);
    }
    bucket.totals.calls += 1;
    bucket.totals.input += tokenCount(item.usage.input);
    bucket.totals.output += tokenCount(item.usage.output);
    bucket.totals.cacheRead += tokenCount(item.usage.cacheRead);
    bucket.totals.cacheWrite += tokenCount(item.usage.cacheWrite);
  }
  return [...buckets.values()];
}

/** 按每百万 token 的美元单价换算成本；没有价格时所有成本为 0。 */
export function computeCost(totals: UsageTotals, pricing?: Pricing): Cost {
  if (!pricing) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }
  const input = (totals.input / TOKENS_PER_UNIT) * rate(pricing.input);
  const output = (totals.output / TOKENS_PER_UNIT) * rate(pricing.output);
  const cacheRead = (totals.cacheRead / TOKENS_PER_UNIT) * rate(pricing.cacheRead);
  const cacheWrite = (totals.cacheWrite / TOKENS_PER_UNIT) * rate(pricing.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

/**
 * 生成用量报告：总会列出传入的每套接口（即使还没有用量），
 * 会话按传入顺序返回，由前端决定展示哪几条。
 */
export function usageReport(
  sessions: UsageSessionInput[],
  providers: UsageProviderInput[],
): UsageReport {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const totals = emptyTotals();
  const byProvider = new Map<string, ProviderUsage>();
  for (const provider of providers) {
    byProvider.set(provider.id, {
      providerId: provider.id,
      providerName: provider.name,
      totals: emptyTotals(),
      cost: 0,
    });
  }

  const bySession = sessions.map((session) => {
    // 优先使用按接口拆分的明细（跨模型角色团队会话）；只有 totals 缓存时按会话接口归账。
    const buckets: ProviderUsageBucket[] = session.byProvider
      ? session.byProvider.map((bucket) => ({
        providerId: bucket.providerId,
        providerName: bucket.providerName,
        totals: { ...bucket.totals },
      }))
      : session.totals
        ? [{
          providerId: session.providerId,
          providerName: session.providerName || session.providerId,
          totals: { ...session.totals },
        }]
        : summarizeMessagesByProvider(session.messages ?? [], session.providerId, session.providerName);

    const sessionTotals = emptyTotals();
    let sessionCost = 0;
    for (const bucket of buckets) {
      const pricing = providerById.get(bucket.providerId)?.pricing;
      const bucketCost = computeCost(bucket.totals, pricing).total;
      addTotals(sessionTotals, bucket.totals);
      sessionCost += bucketCost;

      let group = byProvider.get(bucket.providerId);
      if (!group) {
        // 配置已经被删掉的旧会话/角色也要有归属，用记录的名字兜底。
        group = {
          providerId: bucket.providerId,
          providerName: bucket.providerName || bucket.providerId,
          totals: emptyTotals(),
          cost: 0,
        };
        byProvider.set(bucket.providerId, group);
      }
      addTotals(group.totals, bucket.totals);
      group.cost += bucketCost;
    }
    addTotals(totals, sessionTotals);

    return {
      id: session.id,
      title: session.title,
      projectId: session.projectId,
      totals: sessionTotals,
      cost: sessionCost,
    };
  });

  const cost = [...byProvider.values()].reduce((sum, group) => sum + group.cost, 0);
  return { totals, cost, byProvider: [...byProvider.values()], bySession };
}

function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.calls += source.calls;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
}

function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function rate(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
