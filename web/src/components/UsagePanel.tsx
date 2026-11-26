import { useEffect, useRef, useState } from "react";
import { getUsage, type UsageReport, type UsageTotals } from "../api-usage";
import "./UsagePanel.css";

const REFRESH_MS = 60_000;
const TOP_SESSIONS = 10;

const numberFormat = new Intl.NumberFormat("zh-CN");

function formatTokens(value: number): string {
  return numberFormat.format(Math.round(value));
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.0000";
  return `$${value.toFixed(4)}`;
}

function totalTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

function topSessions(report: UsageReport): UsageReport["bySession"] {
  return report.bySession
    .filter((session) => session.totals.calls > 0)
    .sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals))
    .slice(0, TOP_SESSIONS);
}

/**
 * 用量与成本面板：总量、按接口分组、按会话 Top 10。
 * 打开时拉取一次，之后定时刷新，并在标签页重新可见时刷新。
 */
export function UsagePanel() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await getUsage();
        if (!mounted.current) return;
        setReport(data);
        setError("");
      } catch (reason) {
        if (!mounted.current) return;
        setError(reason instanceof Error ? reason.message : "读取用量失败");
      } finally {
        inFlight = false;
        if (mounted.current) setLoading(false);
      }
    }

    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    function onVisibility() {
      if (document.visibilityState === "visible") void load();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const sessions = report ? topSessions(report) : [];

  return (
    <section className="usage-panel" aria-label="用量与成本">
      <div className="usage-head">
        <h2>用量与成本</h2>
        {report && <span className="muted">调用 {formatTokens(report.totals.calls)} 次</span>}
      </div>
      {error && <p className="error">{error}</p>}
      {loading && !report && <p className="muted">正在加载用量</p>}
      {report && report.totals.calls === 0 && (
        <p className="muted">还没有用量记录。对话产生 token 用量后会显示在这里。</p>
      )}
      {report && report.totals.calls > 0 && (
        <>
          <div className="usage-totals">
            <div><span>输入</span><strong>{formatTokens(report.totals.input)}</strong></div>
            <div><span>输出</span><strong>{formatTokens(report.totals.output)}</strong></div>
            <div><span>缓存读</span><strong>{formatTokens(report.totals.cacheRead)}</strong></div>
            <div><span>缓存写</span><strong>{formatTokens(report.totals.cacheWrite)}</strong></div>
            <div><span>总成本</span><strong>{formatCost(report.cost)}</strong></div>
          </div>
          <h3>按接口</h3>
          <div className="usage-scroll">
            <table className="usage-table">
              <thead>
                <tr>
                  <th scope="col">接口</th>
                  <th scope="col">调用</th>
                  <th scope="col">输入</th>
                  <th scope="col">输出</th>
                  <th scope="col">缓存读</th>
                  <th scope="col">缓存写</th>
                  <th scope="col">成本</th>
                </tr>
              </thead>
              <tbody>
                {report.byProvider.map((provider) => (
                  <tr key={provider.providerId}>
                    <th scope="row">{provider.providerName || provider.providerId}</th>
                    <td>{formatTokens(provider.totals.calls)}</td>
                    <td>{formatTokens(provider.totals.input)}</td>
                    <td>{formatTokens(provider.totals.output)}</td>
                    <td>{formatTokens(provider.totals.cacheRead)}</td>
                    <td>{formatTokens(provider.totals.cacheWrite)}</td>
                    <td>{formatCost(provider.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>按会话 Top {TOP_SESSIONS}</h3>
          {sessions.length === 0 ? (
            <p className="muted">还没有会话产生用量。</p>
          ) : (
            <div className="usage-scroll">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th scope="col">会话</th>
                    <th scope="col">token</th>
                    <th scope="col">成本</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id}>
                      <th scope="row" className="usage-session-title" title={session.title}>
                        {session.title || "未命名对话"}
                      </th>
                      <td>{formatTokens(totalTokens(session.totals))}</td>
                      <td>{formatCost(session.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
