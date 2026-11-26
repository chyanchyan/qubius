import { memo, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  SCHEDULE_EFFORTS,
  createSchedule,
  deleteSchedule,
  getScheduleSettings,
  getSchedules,
  runSchedule,
  updateSchedule,
  type Schedule,
  type ScheduleEffort,
  type ScheduleSettings,
} from "../api-schedules";
import {
  effortLabel,
  effortOptionLabel,
  formatIntervalMinutes,
  formatMessageFullTime,
  formatRelativeTime,
} from "../format";
import { Notice, useDialogs } from "../ui";
import { useNow } from "../useNow";
import "./SchedulesPanel.css";

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 10_080;
const DEFAULT_INTERVAL = 1_440;
const REFRESH_MS = 30_000;
/** 相对时间每分钟刷新一次就够；页面隐藏时 useNow 会自动停表。 */
const NOW_REFRESH_MS = 60_000;

/** 常用间隔预设；写入的是分钟数，展示交给 formatIntervalMinutes。 */
const INTERVAL_PRESETS: Array<{ minutes: number; label: string }> = [
  { minutes: 5, label: "5 分钟" },
  { minutes: 60, label: "1 小时" },
  { minutes: 360, label: "6 小时" },
  { minutes: 1_440, label: "每天" },
  { minutes: 10_080, label: "每周" },
];

interface FormState {
  prompt: string;
  providerId: string;
  model: string;
  effort: ScheduleEffort;
  intervalMinutes: string;
}

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return fallback;
}

// BoardPage 每次 SSE 推送都会重渲染；props 在两次推送之间不变，用 memo 跳过多余的重新渲染。
export const SchedulesPanel = memo(function SchedulesPanel({ projectId, go }: { projectId: string; go?: (to: string) => void }) {
  const dialogs = useDialogs();
  const now = useNow(NOW_REFRESH_MS);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [settings, setSettings] = useState<ScheduleSettings | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  // 按操作 key 记录在途请求（create、`${id}:run` 等）；每个 finally 只清自己的 key，
  // 且任一写操作在途时就禁用所有写按钮，避免互相覆盖导致重复提交。
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const busyAnywhere = busy.size > 0;
  /** 供 await 对话框之后同步复查，避免确认期间状态已变化。 */
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busyAnywhere;
  }, [busyAnywhere]);
  const [form, setForm] = useState<FormState>({
    prompt: "",
    providerId: "",
    model: "",
    effort: "high",
    intervalMinutes: String(DEFAULT_INTERVAL),
  });
  const effortTouched = useRef(false);
  const mounted = useRef(true);
  // 旧请求返回时如果已经有更新的请求发出，就不要用旧数据覆盖新列表。
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const scheduleData = await getSchedules(projectId);
      if (!mounted.current || seq !== seqRef.current) return;
      setSchedules(scheduleData.schedules);
      setError("");
    } catch (reason) {
      if (!mounted.current || seq !== seqRef.current) return;
      setError(errorText(reason, "无法读取定时任务"));
    }
  }, [projectId]);

  // 设置只在设置页改动；挂载和切回页面时连同定时任务一起读取，轮询时只取定时任务。
  const refreshAll = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const [scheduleData, settingsData] = await Promise.all([getSchedules(projectId), getScheduleSettings()]);
      if (!mounted.current || seq !== seqRef.current) return;
      setSchedules(scheduleData.schedules);
      setSettings(settingsData);
      setForm((current) => {
        const provider = settingsData.providers.find((item) => item.id === current.providerId)
          ?? settingsData.providers[0];
        if (!provider) return current;
        const model = provider.models.includes(current.model) ? current.model : provider.models[0] ?? "";
        return {
          ...current,
          providerId: provider.id,
          model,
          effort: effortTouched.current ? current.effort : settingsData.effort,
        };
      });
      setError("");
    } catch (reason) {
      if (!mounted.current || seq !== seqRef.current) return;
      setError(errorText(reason, "无法读取定时任务"));
    }
  }, [projectId]);

  useEffect(() => {
    mounted.current = true;
    void refreshAll();
    const timer = window.setInterval(() => {
      // 隐藏时浏览器还会触发挥调，但页面不可见就没必要发请求；切回来时下面会立即刷新。
      if (document.visibilityState === "hidden") return;
      void refresh();
    }, REFRESH_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void refreshAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, refreshAll]);

  const providers = settings?.providers ?? [];
  const currentProvider = providers.find((item) => item.id === form.providerId);
  const intervalMinutesValue = Number(form.intervalMinutes);
  const intervalLabel = formatIntervalMinutes(intervalMinutesValue);

  function markBusy(key: string): void {
    setBusy((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  function clearBusy(key: string): void {
    setBusy((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function chooseProvider(providerId: string): void {
    const provider = providers.find((item) => item.id === providerId);
    setForm((current) => ({ ...current, providerId, model: provider?.models[0] ?? "" }));
  }

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busyAnywhere) return;
    const provider = providers.find((item) => item.id === form.providerId);
    if (!provider) {
      setError("先在设置里添加一套接口配置");
      return;
    }
    const model = form.model || provider.models[0] || "";
    if (!model) {
      setError("这套配置还没有模型，先在设置里添加");
      return;
    }
    const prompt = form.prompt.trim();
    if (!prompt) {
      setError("prompt 不能为空");
      return;
    }
    const intervalMinutes = Number(form.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL || intervalMinutes > MAX_INTERVAL) {
      setError(`间隔必须是 ${MIN_INTERVAL} 到 ${MAX_INTERVAL} 分钟的整数`);
      return;
    }
    const key = "create";
    markBusy(key);
    setError("");
    setNote("");
    try {
      await createSchedule(projectId, { prompt, providerId: provider.id, model, effort: form.effort, intervalMinutes });
      setForm((current) => ({ ...current, prompt: "" }));
      setNote("已添加定时任务");
      await refresh();
    } catch (reason) {
      setError(errorText(reason, "创建定时任务失败"));
    } finally {
      clearBusy(key);
    }
  }

  async function onToggle(schedule: Schedule): Promise<void> {
    if (busyAnywhere) return;
    // 让所有在途 GET 失效，避免它们稍后覆盖这次写操作的结果。
    seqRef.current += 1;
    const key = `${schedule.id}:toggle`;
    markBusy(key);
    setError("");
    try {
      const data = await updateSchedule(projectId, schedule.id, { enabled: !schedule.enabled });
      setSchedules((current) => current?.map((item) => (item.id === schedule.id ? data.schedule : item)) ?? null);
    } catch (reason) {
      setError(errorText(reason, "更新定时任务失败"));
    } finally {
      clearBusy(key);
    }
  }

  async function onRemove(schedule: Schedule): Promise<void> {
    if (busyAnywhere) return;
    const label = schedule.prompt.split("\n")[0] || "这条定时任务";
    const confirmed = await dialogs.confirm({
      title: "删除定时任务",
      message: `确定删除「${label}」吗？已经创建的对话不会受影响。`,
      confirmLabel: "删除",
      danger: true,
    });
    // 对话框打开期间状态可能已变化：确认后再复查一次，避免重复/过期删除。
    if (!confirmed || !mounted.current || busyRef.current) return;
    // 让所有在途 GET 失效，避免它们稍后把刚删掉的条目又写回列表。
    seqRef.current += 1;
    const key = `${schedule.id}:delete`;
    markBusy(key);
    setError("");
    try {
      await deleteSchedule(projectId, schedule.id);
      setSchedules((current) => current?.filter((item) => item.id !== schedule.id) ?? null);
    } catch (reason) {
      setError(errorText(reason, "删除定时任务失败"));
    } finally {
      clearBusy(key);
    }
  }

  async function onRun(schedule: Schedule): Promise<void> {
    if (busyAnywhere) return;
    const key = `${schedule.id}:run`;
    markBusy(key);
    setError("");
    setNote("");
    try {
      const data = await runSchedule(projectId, schedule.id);
      if (data.sessionId && go) {
        go(`/sessions/${data.sessionId}`);
        return;
      }
      setNote(data.sessionId ? "已开始运行，稍后可在对话列表查看" : "已运行");
      await refresh();
    } catch (reason) {
      setError(errorText(reason, "运行定时任务失败"));
    } finally {
      clearBusy(key);
    }
  }

  return (
    <section className="schedules" aria-label="定时任务">
      <div className="sched-head">
        <strong>定时任务</strong>
        <span className="muted">按间隔自动用固定 prompt 新开对话</span>
      </div>

      {settings && providers.length === 0 && (
        <Notice tone="warn">
          还没有接口配置，定时任务无法运行。
          {go && (
            <>
              {" "}
              <button type="button" className="text-btn" onClick={() => go("/settings")}>去设置里添加</button>
            </>
          )}
        </Notice>
      )}

      {error && <Notice tone="error" onDismiss={() => setError("")}>{error}</Notice>}
      {note && <Notice tone="success" onDismiss={() => setNote("")}>{note}</Notice>}

      {schedules === null && <p className="muted">正在读取定时任务…</p>}
      {schedules && schedules.length === 0 && <p className="muted">还没有定时任务。</p>}
      {schedules && schedules.length > 0 && (
        <div className="sched-list">
          {schedules.map((schedule) => {
            const provider = providers.find((item) => item.id === schedule.providerId);
            return (
              <article key={schedule.id} className="sched-item" data-off={!schedule.enabled}>
                <div className="sched-item-head">
                  <strong className="sched-title">{schedule.prompt.split("\n")[0]}</strong>
                  <label className="sched-toggle">
                    <input
                      type="checkbox"
                      checked={schedule.enabled}
                      disabled={busyAnywhere}
                      onChange={() => void onToggle(schedule)}
                    />
                    启用
                  </label>
                </div>
                <p className="sched-meta">
                  {provider?.name ?? schedule.providerId} · {schedule.model} · {effortLabel(schedule.effort)} ·{" "}
                  <span title={`${schedule.intervalMinutes} 分钟`}>
                    {formatIntervalMinutes(schedule.intervalMinutes) || `每 ${schedule.intervalMinutes} 分钟`}
                  </span>
                </p>
                <p className="sched-meta">
                  下次运行：
                  <time
                    dateTime={schedule.nextRunAt || undefined}
                    title={formatMessageFullTime(schedule.nextRunAt) || schedule.nextRunAt}
                  >
                    {formatRelativeTime(schedule.nextRunAt, now) || schedule.nextRunAt}
                  </time>
                  {schedule.lastRunAt && (
                    <>
                      {" · 上次运行："}
                      <time
                        dateTime={schedule.lastRunAt}
                        title={formatMessageFullTime(schedule.lastRunAt) || schedule.lastRunAt}
                      >
                        {formatRelativeTime(schedule.lastRunAt, now) || schedule.lastRunAt}
                      </time>
                    </>
                  )}
                </p>
                {schedule.lastError && (
                  <Notice tone="error" className="sched-error">上次失败：{schedule.lastError}</Notice>
                )}
                <div className="actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busyAnywhere || !schedule.enabled}
                    title={schedule.enabled ? undefined : "先启用这条定时任务"}
                    onClick={() => void onRun(schedule)}
                  >
                    立即运行
                  </button>
                  <button type="button" className="text-btn danger" disabled={busyAnywhere} onClick={() => void onRemove(schedule)}>
                    删除
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {settings && providers.length > 0 && (
        <form className="stack sched-form" onSubmit={(event) => void onCreate(event)}>
          <strong>新增定时任务</strong>
          <label className="field">
            prompt
            <textarea
              className="sched-textarea"
              value={form.prompt}
              rows={4}
              maxLength={5_000}
              placeholder="每次到点都用这段文字新建一个对话"
              onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
            />
          </label>
          <label className="field">
            接口
            <select value={form.providerId} onChange={(event) => chooseProvider(event.target.value)}>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            模型
            <select value={form.model} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}>
              {(currentProvider?.models ?? []).map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </label>
          <label className="field">
            effort
            <select
              value={form.effort}
              onChange={(event) => {
                effortTouched.current = true;
                setForm((current) => ({ ...current, effort: event.target.value as ScheduleEffort }));
              }}
            >
              {SCHEDULE_EFFORTS.map((item) => (
                <option key={item} value={item}>{effortOptionLabel(item)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            间隔（分钟，{MIN_INTERVAL}–{MAX_INTERVAL}）
            <input
              type="number"
              min={MIN_INTERVAL}
              max={MAX_INTERVAL}
              step={1}
              value={form.intervalMinutes}
              onChange={(event) => setForm((current) => ({ ...current, intervalMinutes: event.target.value }))}
            />
          </label>
          <div className="sched-presets" role="group" aria-label="常用间隔">
            {INTERVAL_PRESETS.map((preset) => (
              <button
                key={preset.minutes}
                type="button"
                className="btn sched-preset"
                data-on={intervalMinutesValue === preset.minutes}
                aria-pressed={intervalMinutesValue === preset.minutes}
                onClick={() => setForm((current) => ({ ...current, intervalMinutes: String(preset.minutes) }))}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <p className="sched-meta sched-interval-hint" role="status">
            {intervalLabel
              ? `当前：${intervalLabel}（${intervalMinutesValue} 分钟）`
              : `请输入 ${MIN_INTERVAL}–${MAX_INTERVAL} 之间的分钟数`}
          </p>
          <div className="actions">
            <button className="btn-primary" disabled={busyAnywhere}>
              {busy.has("create") ? "添加中…" : "添加"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
});
