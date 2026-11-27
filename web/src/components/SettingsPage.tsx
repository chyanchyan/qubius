import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  APPROVAL_TIMEOUT_MAX,
  APPROVAL_TIMEOUT_MIN,
  ARCHIVE_RETENTION_MAX,
  ARCHIVE_RETENTION_MIN,
  clampMaxConcurrent,
  DEFAULT_APPROVAL_TIMEOUT_MINUTES,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  DEFAULT_LIMITS,
  DEFAULT_MAX_CONCURRENT,
  EFFORTS,
  getSettings,
  LIMIT_RANGES,
  MAX_CONCURRENT_MAX,
  MAX_CONCURRENT_MIN,
  readApiToken,
  saveSettings,
  SETTINGS_SAVED_EVENT,
  writeApiToken,
  type Effort,
  type Limits,
  type ProviderDraft,
  type ProviderKind,
  type Settings,
} from "../api";
import { testSettingsProvider, type ProviderPricing } from "../api-usage";
import { Notice, SecretInput, useDialogs } from "../ui";
import { PushSettings } from "./PushSettings";
import "./SettingsPage.css";

type PricingKey = "input" | "output" | "cacheRead" | "cacheWrite";
type EditablePricing = Record<PricingKey, string>;

const PRICING_FIELDS: Array<{ key: PricingKey; label: string }> = [
  { key: "input", label: "输入" },
  { key: "output", label: "输出" },
  { key: "cacheRead", label: "缓存读" },
  { key: "cacheWrite", label: "缓存写" },
];

const LIMIT_FIELDS: Array<{ key: keyof Limits; label: string; hint: string }> = [
  { key: "transcriptBytes", label: "单会话总字节", hint: "单个会话序列化后的最大字节数" },
  { key: "transcriptMessages", label: "单会话消息条数", hint: "单个会话保留的消息条数" },
  { key: "messageText", label: "单条消息字符数", hint: "单条消息正文的最大字符数" },
  { key: "requestBodyBytes", label: "请求体字节数", hint: "单次 JSON 请求体的最大字节数" },
  { key: "historyPage", label: "历史分页条数", hint: "首帧/翻页一次返回的历史消息条数" },
];

const PRICING_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: "calc(8px * var(--control-scale))",
} as const;

/** settings API 的 provider 类型在别处定义，这里补充可选的价格字段。 */
type ProviderWithPricing = Settings["providers"][number] & { pricing?: ProviderPricing };
type SettingsWithPricing = Omit<Settings, "providers"> & { providers: ProviderWithPricing[] };
type ProviderDraftWithPricing = ProviderDraft & { pricing?: ProviderPricing };

interface EditableProvider {
  key: string;
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  models: string[];
  pricing: EditablePricing;
}

/** 切换类型时只替换仍是当前类型默认值的地址，用户自己填过的保持不动。 */
const DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

function emptyPricing(): EditablePricing {
  return { input: "", output: "", cacheRead: "", cacheWrite: "" };
}

function pricingToDraft(pricing: ProviderPricing | undefined): EditablePricing {
  const draft = emptyPricing();
  for (const field of PRICING_FIELDS) {
    const value = pricing?.[field.key];
    if (typeof value === "number" && Number.isFinite(value)) draft[field.key] = String(value);
  }
  return draft;
}

/** 空输入表示不计算该项；0 是合法价格，必须保留。 */
function pricingFromDraft(draft: EditablePricing): ProviderPricing | undefined {
  const pricing: ProviderPricing = {};
  for (const field of PRICING_FIELDS) {
    const raw = draft[field.key].trim();
    if (raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 10_000) {
      throw new Error("价格必须是非负数");
    }
    pricing[field.key] = value;
  }
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

function blankProvider(): EditableProvider {
  return {
    key: crypto.randomUUID(),
    name: "",
    kind: "anthropic",
    baseUrl: DEFAULT_BASE_URL.anthropic,
    apiKey: "",
    hasApiKey: false,
    models: [""],
    pricing: emptyPricing(),
  };
}

function fromSettings(data: SettingsWithPricing): EditableProvider[] {
  return data.providers.map((provider) => ({
    key: provider.id,
    id: provider.id,
    name: provider.name,
    kind: provider.kind ?? "anthropic",
    baseUrl: provider.baseUrl,
    apiKey: "",
    hasApiKey: provider.hasApiKey,
    models: provider.models.length > 0 ? [...provider.models] : [""],
    pricing: pricingToDraft(provider.pricing),
  }));
}

/* 浏览器 fetch 失败时往往只给出英文 TypeError（Chrome: Failed to fetch，
   Safari: Load failed），统一换成中文后再展示。 */
const NETWORK_ERROR_PATTERN = /failed to fetch|load failed|networkerror|network error|fetch failed|internet connection appears to be offline/i;

function readableError(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) return fallback;
  const message = reason.message.trim();
  if (!message) return fallback;
  if (NETWORK_ERROR_PATTERN.test(message)) return "网络连接失败，请检查网络后重试。";
  return message;
}

export function SettingsPage() {
  const dialogs = useDialogs();
  const [providers, setProviders] = useState<EditableProvider[]>([]);
  /** 用户手动折叠/展开过的配置；没有记录时按“第一套展开、新增展开”的默认值。 */
  const [openProviders, setOpenProviders] = useState<Record<string, boolean>>({});
  /** 保存前显式校验时用来定位输入框（原生 required 对折叠内容不可靠）。 */
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [effort, setEffort] = useState<Effort>("high");
  const [maxConcurrent, setMaxConcurrent] = useState(DEFAULT_MAX_CONCURRENT);
  const [approvalTimeoutMinutes, setApprovalTimeoutMinutes] = useState(
    DEFAULT_APPROVAL_TIMEOUT_MINUTES,
  );
  const [limits, setLimits] = useState<Limits>({ ...DEFAULT_LIMITS });
  const [archiveRetentionDays, setArchiveRetentionDays] = useState(
    DEFAULT_ARCHIVE_RETENTION_DAYS,
  );
  /* 访问令牌只保存在本机浏览器，独立于上面的服务端设置表单。 */
  const [apiToken, setApiToken] = useState(() => readApiToken());
  const [tokenMessage, setTokenMessage] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string }>>({});
  /** 每套配置的 API key 是否显示明文；默认隐藏，眼睛按钮切换。 */
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});

  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    getSettings().then((data) => {
      if (!mounted.current) return;
      setProviders(fromSettings(data));
      setEffort(data.effort);
      setMaxConcurrent(clampMaxConcurrent(data.maxConcurrent));
      // 旧服务端还没有这些字段时退回内置默认值，页面照常可用。
      setApprovalTimeoutMinutes(data.approvalTimeoutMinutes ?? DEFAULT_APPROVAL_TIMEOUT_MINUTES);
      setLimits({ ...DEFAULT_LIMITS, ...(data.limits ?? {}) });
      setArchiveRetentionDays(data.archiveRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS);
      setDirty(false);
    }).catch((reason: unknown) => {
      if (mounted.current) setError(readableError(reason, "读取设置失败"));
    });
  }, []);

  /* Warn before a reload/closing the tab would discard unsaved edits. In-app
     navigation is intentionally not intercepted. */
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Some browsers still require returnValue to be set to show the prompt.
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function update(key: string, patch: Partial<EditableProvider>) {
    setProviders((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
    setDirty(true);
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    // 不用原生 required：折叠卡片里的控件虽然还在 DOM 中，但原生校验失败时
    // 浏览器无法聚焦隐藏控件，只会静默中止提交。这里显式校验并展开卡片。
    const invalidIndex = providers.findIndex(
      (provider) => !provider.name.trim() || !provider.baseUrl.trim(),
    );
    if (invalidIndex !== -1) {
      const provider = providers[invalidIndex];
      if (!provider) return;
      const nameMissing = !provider.name.trim();
      const field = nameMissing ? "name" : "baseUrl";
      const fieldLabel = nameMissing ? "名称" : "地址";
      setError(`配置 ${invalidIndex + 1} 的${fieldLabel}不能为空，请填写后再保存。`);
      setOpenProviders((current) => ({ ...current, [provider.key]: true }));
      window.requestAnimationFrame(() => {
        const input = fieldRefs.current[`${provider.key}:${field}`];
        input?.scrollIntoView({ block: "center", behavior: "smooth" });
        input?.focus({ preventScroll: true });
      });
      return;
    }
    if (
      !Number.isInteger(maxConcurrent)
      || maxConcurrent < MAX_CONCURRENT_MIN
      || maxConcurrent > MAX_CONCURRENT_MAX
    ) {
      setError(`并发上限必须是 ${MAX_CONCURRENT_MIN} 到 ${MAX_CONCURRENT_MAX} 之间的整数。`);
      return;
    }
    if (
      !Number.isInteger(approvalTimeoutMinutes)
      || approvalTimeoutMinutes < APPROVAL_TIMEOUT_MIN
      || approvalTimeoutMinutes > APPROVAL_TIMEOUT_MAX
    ) {
      setError(
        `确认超时必须是 ${APPROVAL_TIMEOUT_MIN} 到 ${APPROVAL_TIMEOUT_MAX} 之间的整数（0 表示不自动拒绝）。`,
      );
      return;
    }
    if (
      !Number.isInteger(archiveRetentionDays)
      || archiveRetentionDays < ARCHIVE_RETENTION_MIN
      || archiveRetentionDays > ARCHIVE_RETENTION_MAX
    ) {
      setError(
        `归档保留天数必须是 ${ARCHIVE_RETENTION_MIN} 到 ${ARCHIVE_RETENTION_MAX} 之间的整数。`,
      );
      return;
    }
    for (const range of LIMIT_RANGES) {
      const value = limits[range.key];
      if (!Number.isInteger(value) || value < range.min || value > range.max) {
        const label = LIMIT_FIELDS.find((field) => field.key === range.key)?.label ?? range.key;
        setError(`${label}必须是 ${range.min} 到 ${range.max} 之间的整数。`);
        return;
      }
    }
    try {
      const previousProviders = providers;
      const body: ProviderDraftWithPricing[] = providers.map((provider) => {
        const draft: ProviderDraftWithPricing = {
          id: provider.id,
          name: provider.name.trim(),
          kind: provider.kind,
          baseUrl: provider.baseUrl.trim(),
          models: provider.models.map((model) => model.trim()).filter(Boolean),
        };
        if (provider.apiKey.trim()) draft.apiKey = provider.apiKey.trim();
        const pricing = pricingFromDraft(provider.pricing);
        if (pricing) draft.pricing = pricing;
        return draft;
      });
      const saved = await saveSettings({
        providers: body,
        effort,
        maxConcurrent,
        approvalTimeoutMinutes,
        limits,
        archiveRetentionDays,
      }) as SettingsWithPricing;
      const nextProviders = fromSettings(saved);
      setProviders(nextProviders);
      setEffort(saved.effort);
      setMaxConcurrent(clampMaxConcurrent(saved.maxConcurrent));
      setApprovalTimeoutMinutes(saved.approvalTimeoutMinutes ?? DEFAULT_APPROVAL_TIMEOUT_MINUTES);
      setLimits({ ...DEFAULT_LIMITS, ...(saved.limits ?? {}) });
      setArchiveRetentionDays(saved.archiveRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS);
      setDirty(false);
      // 顶栏的「运行中 / 上限」跟着立即更新，不必等下次加载。
      window.dispatchEvent(new CustomEvent(SETTINGS_SAVED_EVENT, { detail: saved }));
      // 新增配置保存后 key 会从临时 UUID 变成服务端 id；把展开状态迁移过去，
      // 避免原来展开的新卡片在保存后意外折叠。
      setOpenProviders((current) => {
        const next: Record<string, boolean> = {};
        nextProviders.forEach((provider, index) => {
          // 已有配置按 id 找回旧 key；新增配置（保存前还没有 id）按数组位置对应。
          const matched = (provider.id
            ? previousProviders.find((item) => item.id === provider.id)
            : undefined) ?? previousProviders[index];
          const recorded = matched ? current[matched.key] : undefined;
          const defaultOpen = index === 0 || Boolean(matched && !matched.id);
          next[provider.key] = recorded ?? defaultOpen;
        });
        return next;
      });
      const leaked = JSON.stringify(saved).includes("apiKey");
      setMessage(leaked ? "保存异常：响应里出现了密钥字段" : "已保存。响应里没有密钥。");
    } catch (reason) {
      if (mounted.current) setError(readableError(reason, "保存失败"));
    }
  }

  function setTestResult(key: string, result: { ok: boolean; detail: string }) {
    setTestResults((current) => ({ ...current, [key]: result }));
  }

  function dismissTestResult(key: string) {
    setTestResults((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function onDeleteProvider(provider: EditableProvider, index: number) {
    const label = provider.name.trim() || `配置 ${index + 1}`;
    const confirmed = await dialogs.confirm({
      title: "删除配置",
      message: `确定删除「${label}」吗？点击「保存」后才会真正移除；刷新页面可以撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!confirmed || !mounted.current) return;
    setProviders((current) => current.filter((item) => item.key !== provider.key));
    setDirty(true);
  }

  /**
   * 用服务端已保存的配置测试连接。表单有未保存修改时不发请求，
   * 避免测试结果和屏幕上看到的配置对不上。
   */
  async function onTestProvider(provider: EditableProvider) {
    if (testingKey !== null) return;
    if (!provider.id) {
      setTestResult(provider.key, { ok: false, detail: "先保存再测试（新配置还没有保存到服务端）。" });
      return;
    }
    if (dirty) {
      setTestResult(provider.key, {
        ok: false,
        detail: "有未保存的修改，请先保存再测试；测试使用的是已保存的配置。",
      });
      return;
    }
    const model = provider.models.map((item) => item.trim()).find((item) => item.length > 0);
    if (!model) {
      setTestResult(provider.key, { ok: false, detail: "请先添加模型再测试。" });
      return;
    }
    setTestingKey(provider.key);
    setTestResults((current) => {
      const next = { ...current };
      delete next[provider.key];
      return next;
    });
    try {
      const result = await testSettingsProvider({ providerId: provider.id, model });
      if (mounted.current) {
        setTestResult(provider.key, { ok: result.ok, detail: result.detail || (result.ok ? "连接正常" : "测试失败") });
      }
    } catch (reason) {
      if (mounted.current) setTestResult(provider.key, { ok: false, detail: readableError(reason, "测试连接失败") });
    } finally {
      if (mounted.current) setTestingKey(null);
    }
  }

  /* 只写本机 localStorage/cookie，不参与 PUT /api/settings。 */
  function onSaveToken() {
    writeApiToken(apiToken);
    setApiToken(apiToken.trim());
    setTokenMessage("已保存，请刷新页面让实时连接使用新令牌。");
  }

  function onClearToken() {
    writeApiToken("");
    setApiToken("");
    setTokenMessage("已清除访问令牌，请刷新页面。");
  }

  return (
    <section className="page settings-page">
      <h1 tabIndex={-1}>设置</h1>
      <p className="lead">每套配置选择协议类型（Anthropic 兼容或 Gemini），填地址、密钥和多个模型名。密钥只写在这台开发机上，保存后不会再显示。</p>
      <form id="settings-form" className="stack settings-form" onSubmit={onSave} noValidate>
        {providers.map((provider, index) => {
          const result = testResults[provider.key];
          const hasKey = provider.hasApiKey || provider.apiKey.trim().length > 0;
          return (
          <details
            key={provider.key}
            className="provider settings-provider"
            /* 第一套默认展开；新增的配置（还没有 id）也展开，方便直接填写。
               用户手动折叠会记在 openProviders 里，重新渲染不会弹回去。 */
            open={openProviders[provider.key] ?? (index === 0 || !provider.id)}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setOpenProviders((current) => (
                current[provider.key] === open ? current : { ...current, [provider.key]: open }
              ));
            }}
          >
            <summary className="settings-provider-summary">
              <span className="settings-provider-index">配置 {index + 1}</span>
              <span className="settings-provider-name">{provider.name.trim() || "未命名配置"}</span>
              <span className="settings-provider-key" data-on={hasKey}>
                {hasKey ? "已配置密钥" : "未配置密钥"}
              </span>
            </summary>
            <div className="settings-provider-body">
            <label className="field">
              名称
              <input
                ref={(element) => { fieldRefs.current[`${provider.key}:name`] = element; }}
                value={provider.name}
                required
                onChange={(event) => update(provider.key, { name: event.target.value })}
              />
            </label>
            <label className="field">
              类型
              <select
                value={provider.kind}
                onChange={(event) => {
                  const kind = event.target.value as ProviderKind;
                  const current = provider.baseUrl.trim();
                  // 只替换仍是另一类型默认值的地址，用户自己填过的保持不动。
                  const baseUrl = !current || current === DEFAULT_BASE_URL[provider.kind]
                    ? DEFAULT_BASE_URL[kind]
                    : provider.baseUrl;
                  update(provider.key, { kind, baseUrl });
                }}
              >
                <option value="anthropic">Anthropic 兼容</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>
            <label className="field">
              地址
              <input
                ref={(element) => { fieldRefs.current[`${provider.key}:baseUrl`] = element; }}
                value={provider.baseUrl}
                required
                onChange={(event) => update(provider.key, { baseUrl: event.target.value })}
              />
            </label>
            <p className="muted">
              {provider.kind === "gemini"
                ? "Gemini API 地址，会自动补 /v1beta；一般留默认值即可。"
                : "兼容 Anthropic Messages 的地址，会作为 ANTHROPIC_BASE_URL 传给 Agent SDK。"}
            </p>
            <div className="field">
              <label htmlFor={`provider-key-${provider.key}`}>API key</label>
              <span className="secret-input">
                <input
                  id={`provider-key-${provider.key}`}
                  type={revealedKeys[provider.key] ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={provider.apiKey}
                  placeholder={
                    !provider.hasApiKey
                      ? (provider.kind === "gemini" ? "粘贴 Gemini API key" : "粘贴 API key")
                      : revealedKeys[provider.key]
                        // 已保存的密钥不会从服务端返回，明文只能显示新输入的内容。
                        ? "已保存的密钥无法查看，输入新值可替换"
                        : "••••••••••••"
                  }
                  onChange={(event) => update(provider.key, { apiKey: event.target.value })}
                />
                <button
                  type="button"
                  className="secret-toggle"
                  aria-label={revealedKeys[provider.key] ? "隐藏 API key 明文" : "显示 API key 明文"}
                  title={revealedKeys[provider.key] ? "隐藏 API key 明文" : "显示 API key 明文"}
                  aria-pressed={Boolean(revealedKeys[provider.key])}
                  onClick={() => {
                    setRevealedKeys((current) => ({
                      ...current,
                      [provider.key]: !current[provider.key],
                    }));
                  }}
                >
                  {revealedKeys[provider.key] ? (
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
                      <circle cx="8" cy="8" r="2" />
                      <path d="M2.5 2.5l11 11" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
                      <circle cx="8" cy="8" r="2" />
                    </svg>
                  )}
                </button>
              </span>
            </div>
            <p className="muted">{provider.hasApiKey ? "当前已配置密钥，留空则不修改" : "当前未配置密钥"}</p>
            <div className="stack">
              <span className="muted">模型</span>
              {provider.models.map((model, modelIndex) => (
                <div className="model-row" key={`${provider.key}-${modelIndex}`}>
                  <input
                    value={model}
                    aria-label={`模型 ${modelIndex + 1}`}
                    onChange={(event) => {
                      const models = [...provider.models];
                      models[modelIndex] = event.target.value;
                      update(provider.key, { models });
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      const models = provider.models.filter((_, item) => item !== modelIndex);
                      update(provider.key, { models: models.length > 0 ? models : [""] });
                    }}
                  >
                    移除
                  </button>
                </div>
              ))}
              <button type="button" className="btn" onClick={() => update(provider.key, { models: [...provider.models, ""] })}>
                添加模型
              </button>
              <p className="muted">
                {provider.kind === "gemini"
                  ? "例如 gemini-2.5-pro、gemini-2.5-flash。"
                  : "模型名会原样传给接口。"}
              </p>
            </div>
            <div className="stack">
              <span className="muted">价格（美元 / 百万 token，留空表示不计算成本）</span>
              <div style={PRICING_GRID_STYLE}>
                {PRICING_FIELDS.map((field) => (
                  <label className="field" key={field.key}>
                    {field.label}
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      step="any"
                      inputMode="decimal"
                      placeholder="留空"
                      value={provider.pricing[field.key]}
                      onChange={(event) => update(provider.key, {
                        pricing: { ...provider.pricing, [field.key]: event.target.value },
                      })}
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="actions settings-provider-actions">
              <button
                type="button"
                className="btn"
                disabled={testingKey !== null}
                onClick={() => void onTestProvider(provider)}
              >
                {testingKey === provider.key ? "测试中…" : "测试连接"}
              </button>
              <button
                type="button"
                className="text-btn danger settings-provider-remove"
                onClick={() => void onDeleteProvider(provider, index)}
              >
                删除
              </button>
            </div>
            {result && (
              <Notice
                tone={result.ok ? "success" : "error"}
                onDismiss={() => dismissTestResult(provider.key)}
              >
                {result.ok ? "连接正常" : result.detail}
              </Notice>
            )}
            </div>
          </details>
          );
        })}
        <button
          type="button"
          className="btn"
          onClick={() => {
            setProviders((current) => [...current, blankProvider()]);
            setDirty(true);
          }}
        >
          添加一套配置
        </button>
        <label className="field">
          默认 effort
          <select
            value={effort}
            onChange={(event) => {
              setEffort(event.target.value as Effort);
              setDirty(true);
            }}
          >
            {EFFORTS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="field">
          并发 / agent 上限
          <input
            type="number"
            min={MAX_CONCURRENT_MIN}
            max={MAX_CONCURRENT_MAX}
            step={1}
            inputMode="numeric"
            value={Number.isFinite(maxConcurrent) ? maxConcurrent : ""}
            onChange={(event) => {
              const next = event.target.value === "" ? Number.NaN : Number(event.target.value);
              setMaxConcurrent(next);
              setDirty(true);
            }}
          />
        </label>
        <p className="muted">
          同时进行的对话数上限（{MAX_CONCURRENT_MIN} 到 {MAX_CONCURRENT_MAX}），顶栏「运行中 / 上限」也用这个值作为 agent 上限。
          超出的对话会排队；保存后立即生效，调高后排队中的对话马上开始，调低不会打断正在运行的对话。
          config.yaml / 部署环境里的 maxConcurrent 只作为初始默认值。
        </p>
        <label className="field">
          确认超时（分钟，0 不自动拒绝）
          <input
            type="number"
            min={APPROVAL_TIMEOUT_MIN}
            max={APPROVAL_TIMEOUT_MAX}
            step={1}
            inputMode="numeric"
            value={Number.isFinite(approvalTimeoutMinutes) ? approvalTimeoutMinutes : ""}
            onChange={(event) => {
              const next = event.target.value === "" ? Number.NaN : Number(event.target.value);
              setApprovalTimeoutMinutes(next);
              setDirty(true);
            }}
          />
        </label>
        <p className="muted">
          等待提问/授权多久没人回应就自动拒绝（{APPROVAL_TIMEOUT_MIN} 到 {APPROVAL_TIMEOUT_MAX}）；
          0 表示一直等待、不显示倒计时。保存后立即生效，但已经挂起的确认保留原来的时限。
          部署环境里的 approvalTimeoutMinutes 只作为初始默认值。
        </p>
        <label className="field">
          归档保留天数
          <input
            type="number"
            min={ARCHIVE_RETENTION_MIN}
            max={ARCHIVE_RETENTION_MAX}
            step={1}
            inputMode="numeric"
            value={Number.isFinite(archiveRetentionDays) ? archiveRetentionDays : ""}
            onChange={(event) => {
              const next = event.target.value === "" ? Number.NaN : Number(event.target.value);
              setArchiveRetentionDays(next);
              setDirty(true);
            }}
          />
        </label>
        <p className="muted">
          会话在本机保留多少天后归档到冷存储（{ARCHIVE_RETENTION_MIN} 到 {ARCHIVE_RETENTION_MAX}）。
          未配置归档目录时不生效；保存后下一轮整理（最多 1 小时）按新天数判断。
          部署环境里的保留天数只作为初始默认值。
        </p>
        <details className="field">
          <summary>高级限制（一般不用改）</summary>
          <div style={PRICING_GRID_STYLE}>
            {LIMIT_FIELDS.map((field) => {
              const range = LIMIT_RANGES.find((item) => item.key === field.key);
              if (!range) return null;
              const value = limits[field.key];
              return (
                <label key={field.key} className="field">
                  {field.label}
                  <input
                    type="number"
                    min={range.min}
                    max={range.max}
                    step={1}
                    inputMode="numeric"
                    value={Number.isFinite(value) ? value : ""}
                    onChange={(event) => {
                      const next = event.target.value === "" ? Number.NaN : Number(event.target.value);
                      setLimits((current) => ({ ...current, [field.key]: next }));
                      setDirty(true);
                    }}
                  />
                  <span className="muted">{field.hint}（{range.min}–{range.max}）</span>
                </label>
              );
            })}
          </div>
        </details>
        <p className="muted">
          会话/请求上限保存后立即生效：新请求按新请求体上限处理，旧会话在下次加载或保存时按新条数/字节上限收敛。
          部署环境里的 limits 只作为初始默认值。
        </p>
      </form>
      <article className="provider" aria-label="访问令牌">
        <strong>访问令牌</strong>
        <p className="muted">
          仅在服务端启用 auth / QUBIUS_AUTH_TOKEN 时需要。令牌只保存在本机浏览器，不写入服务端设置。
        </p>
        <label className="field">
          访问令牌
          <SecretInput
            revealLabel="访问令牌"
            autoComplete="off"
            value={apiToken}
            placeholder="粘贴访问令牌"
            onChange={(event) => {
              setApiToken(event.target.value);
              setTokenMessage("");
            }}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            className="btn-primary"
            disabled={!apiToken.trim()}
            onClick={onSaveToken}
          >
            保存令牌
          </button>
          <button
            type="button"
            className="btn"
            disabled={!apiToken && !readApiToken()}
            onClick={onClearToken}
          >
            清除令牌
          </button>
        </div>
        {tokenMessage && (
          <Notice tone="success" onDismiss={() => setTokenMessage("")}>{tokenMessage}</Notice>
        )}
      </article>
      {/* 推送通知：本机订阅开关，和上面的服务端设置分开；部署页里保留同一个组件的实例。 */}
      <PushSettings />
      {/* 底部 sticky 保存栏同时承载保存反馈；整个页面滚到哪都能保存。 */}
      <div className="settings-savebar settings-savebar-bottom">
        {error && <Notice tone="error" onDismiss={() => setError("")}>{error}</Notice>}
        {message && (
          <Notice
            tone={message.startsWith("保存异常") ? "warn" : "success"}
            onDismiss={() => setMessage("")}
          >
            {message}
          </Notice>
        )}
        <div className="settings-savebar-row">
          <span className="settings-savebar-status">
            {dirty ? "有未保存的修改" : "没有未保存的修改"}
          </span>
          <button type="submit" form="settings-form" className="btn-primary">保存</button>
        </div>
      </div>
    </section>
  );
}
