import { useEffect, useState, type FormEvent } from "react";
import { getSettings, saveProxySettings, type ProxySettings } from "../api";
import { Notice } from "../ui";
import "./ProxyPage.css";

/**
 * 代理白名单页：只有列在这里的域名走代理，其余直连。
 *
 * 代理地址留空时使用系统代理；填了就以填的为准，方便没有系统代理设置的
 * Linux 主机。保存后立即生效，不需要重启服务。
 */
export function ProxyPage() {
  const [domainsText, setDomainsText] = useState("");
  const [url, setUrl] = useState("");
  const [detected, setDetected] = useState<string | undefined>(undefined);
  const [savedDomains, setSavedDomains] = useState("");
  const [savedUrl, setSavedUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const dirty = domainsText !== savedDomains || url !== savedUrl;

  useEffect(() => {
    const controller = new AbortController();
    getSettings(controller.signal)
      .then((settings) => {
        if (controller.signal.aborted) return;
        applyProxy(settings.proxy);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "读取设置失败");
        setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function applyProxy(proxy: ProxySettings | undefined) {
    const stored = proxy ?? { domains: [] };
    const text = stored.domains.join("\n");
    const address = stored.url ?? "";
    setDomainsText(text);
    setSavedDomains(text);
    setUrl(address);
    setSavedUrl(address);
    setDetected(proxy?.detected);
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    const domains: string[] = [];
    const seen = new Set<string>();
    for (const line of domainsText.split(/\r?\n/)) {
      const domain = line.trim().toLowerCase();
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      domains.push(domain);
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = await saveProxySettings({ domains, url: url.trim() });
      applyProxy(saved.proxy);
      setMessage("已保存，下一轮请求按新的白名单路由");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page settings-page proxy-page">
      <h1 tabIndex={-1}>代理</h1>
      <p className="lead">
        只有域名白名单里的上游请求走代理，其余全部直连。回环和内网地址始终直连。
        白名单支持精确域名和 <code>*.example.com</code> 通配。
      </p>
      <form id="proxy-form" className="stack settings-form" onSubmit={onSave} noValidate>
        <label className="field">
          代理地址（留空使用系统代理）
          <input
            value={url}
            placeholder="http://127.0.0.1:7890"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setUrl(event.target.value);
              setMessage("");
            }}
          />
        </label>
        <p className="muted">
          留空时自动读取系统代理：Windows 使用 Internet 选项，其它平台读取
          QUBIUS_PROXY / HTTPS_PROXY 等环境变量。
          {detected ? `当前生效的代理：${detected}` : "当前没有可用的系统代理。"}
        </p>
        <label className="field">
          域名白名单（每行一个）
          <textarea
            className="proxy-domains"
            rows={12}
            value={domainsText}
            spellCheck={false}
            placeholder={"api.deepseek.com\n*.anthropic.com"}
            onChange={(event) => {
              setDomainsText(event.target.value);
              setMessage("");
            }}
          />
        </label>
        <p className="muted">
          白名单为空时全部直连。<code>*.example.com</code> 同时匹配 example.com
          及其子域名；不接受协议、端口或路径。
        </p>
        {error && <Notice tone="error" onDismiss={() => setError("")}>{error}</Notice>}
        {message && <Notice tone="success" onDismiss={() => setMessage("")}>{message}</Notice>}
        <div className="actions proxy-actions">
          <button type="submit" className="btn-primary" disabled={loading || saving || !dirty}>
            {saving ? "保存中…" : "保存"}
          </button>
          <span className="muted">
            {loading ? "正在读取设置…" : dirty ? "有未保存的修改" : "没有未保存的修改"}
          </span>
        </div>
      </form>
    </section>
  );
}
