import { request } from "./api";

/** 每百万 token 的美元价格；缺失表示不算这一项成本。 */
export interface ProviderPricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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

export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  detail: string;
}

/** 用量与成本报告（服务端读取所有会话后汇总）。 */
export function getUsage(signal?: AbortSignal): Promise<UsageReport> {
  return request<UsageReport>("/api/usage", undefined, signal);
}

/**
 * 用已保存的接口配置发一个最小请求验证连通性。
 * 服务端正常返回 200 + { ok, detail }；HTTP 错误会由 request 抛出。
 */
export function testSettingsProvider(
  body: { providerId: string; model?: string },
  signal?: AbortSignal,
): Promise<ProviderTestResult> {
  return request<ProviderTestResult>(
    "/api/settings/test",
    { method: "POST", body: JSON.stringify(body) },
    signal,
  );
}
