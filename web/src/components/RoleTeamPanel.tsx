import { useEffect, useRef, useState } from "react";
import {
  EFFORTS,
  type Effort,
  type Provider,
  type RoleBinding,
  type RoleTeam,
  type Session,
} from "../api";
import { effortOptionLabel } from "../format";
import {
  ROLE_FIELDS,
  roleRunStatusText,
  roleTeamComplete,
  roleTeamDefaults,
  roleUnitStatusText,
} from "../role-team";
import { Dialog } from "../ui/Dialog";
import "./RoleTeamPanel.css";

/**
 * prl-role 的团队配置与运行进度。
 *
 * 发送带 prl-role 的消息后会话进入 setup：弹窗让用户确认四个固定角色；
 * 开始后服务端把每个阶段的发言追加进对话记录，这里保留一块只读进度面板。
 */

/** 某一行可选的接口配置：设置还没加载时提示加载中，确实找不到时才标已删除。 */
function providerOptions(binding: RoleBinding, providers: Provider[]): Array<{ id: string; label: string; models: string[] }> {
  const options = providers.map((provider) => ({
    id: provider.id,
    label: provider.name,
    models: provider.models,
  }));
  if (
    binding.providerId
    && !options.some((provider) => provider.id === binding.providerId)
  ) {
    options.unshift({
      id: binding.providerId,
      label: providers.length === 0 ? "接口配置加载中" : "已删除的接口",
      models: [binding.model],
    });
  }
  return options;
}

export function RoleTeamPanel({
  session,
  providers,
  defaultTeam,
  onStart,
  onError,
}: {
  session: Session;
  providers: Provider[];
  defaultTeam?: RoleTeam;
  onStart: (team: RoleTeam) => Promise<void>;
  onError: (message: string) => void;
}) {
  const run = session.roleRun;
  /* 同一轮运行里点过「稍后配置」就不再自动弹窗；开始时间变化后恢复。 */
  const resetKey = session.id + ":" + (run?.startedAt ?? "");
  const [dismissed, setDismissed] = useState(false);
  const [starting, setStarting] = useState(false);
  /* 弹窗是 fixed 遮罩，App 的 .dock-notice 会被盖住；这里保留一份可见的表单错误。 */
  const [formError, setFormError] = useState("");
  const fallback = {
    providerId: session.providerId,
    model: session.model,
    effort: session.effort,
  };
  const [team, setTeam] = useState<RoleTeam>(() =>
    roleTeamDefaults(run?.team, defaultTeam, providers, fallback));
  /* 用户是否手动改过任何一行；晚到的设置/接口列表不能覆盖这些编辑。 */
  const editedRef = useRef(false);

  useEffect(() => {
    setDismissed(false);
    setFormError("");
  }, [resetKey]);

  useEffect(() => {
    if (editedRef.current) return;
    if (!defaultTeam && providers.length === 0) return;
    setTeam(roleTeamDefaults(run?.team, defaultTeam, providers, fallback));
    // fallback 的字段来自 session，下面显式列出，避免每次 SSE 元数据变化都重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.team, defaultTeam, providers, session.providerId, session.model, session.effort]);

  if (!run) return null;

  function patchRole(key: keyof RoleTeam, patch: Partial<RoleBinding>) {
    editedRef.current = true;
    setFormError("");
    setTeam((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }

  function dismiss() {
    if (starting) return;
    setFormError("");
    setDismissed(true);
  }

  function showError(message: string) {
    setFormError(message);
    onError(message);
  }

  async function start() {
    if (starting) return;
    if (!roleTeamComplete(team)) {
      showError("请为四个角色都选择接口和模型");
      return;
    }
    const resolved = {} as RoleTeam;
    for (const field of ROLE_FIELDS) {
      const binding = team[field.key];
      const provider = providers.find((item) => item.id === binding.providerId);
      resolved[field.key] = {
        providerId: binding.providerId,
        providerName: provider?.name || binding.providerName || (providers.length === 0 ? "接口配置加载中" : "已删除的接口"),
        model: binding.model,
        effort: binding.effort,
      };
    }
    setStarting(true);
    setFormError("");
    try {
      await onStart(resolved);
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : "无法开始 prl-role 团队");
    } finally {
      setStarting(false);
    }
  }

  if (run.phase === "setup") {
    return (
      <>
        <Dialog
          open={!dismissed}
          wide
          showActions={false}
          title="选择 prl-role 角色团队"
          onConfirm={() => {}}
          onClose={dismiss}
        >
          <div className="role-team-dialog">
            <p className="role-team-dialog-hint">
              四个角色分别负责编排、开发、子审核和集成审核；默认值来自设置页保存的团队。
            </p>
            <div className="role-team-rows">
              {ROLE_FIELDS.map((field) => {
                const binding = team[field.key];
                const options = providerOptions(binding, providers);
                const models = options.find((provider) => provider.id === binding.providerId)?.models ?? [];
                const modelOptions = binding.model && !models.includes(binding.model)
                  ? [binding.model, ...models]
                  : models;
                return (
                  <div className="role-team-row" key={field.key}>
                    <span className="role-team-role">
                      <span className="role-team-role-name">{field.label}</span>
                      <span className="role-team-role-hint">{field.hint}</span>
                    </span>
                    <select
                      className="role-team-select"
                      value={binding.providerId}
                      aria-label={`${field.label}的接口`}
                      onChange={(event) => {
                        const provider = providers.find((item) => item.id === event.target.value);
                        patchRole(field.key, {
                          providerId: event.target.value,
                          providerName: provider?.name ?? (providers.length === 0 ? "接口配置加载中" : "已删除的接口"),
                          model: provider?.models[0] ?? "",
                        });
                      }}
                    >
                      {options.length === 0 && <option value="">没有可用接口</option>}
                      {options.map((provider) => (
                        <option key={provider.id} value={provider.id}>{provider.label}</option>
                      ))}
                    </select>
                    <select
                      className="role-team-select"
                      value={binding.model}
                      aria-label={`${field.label}的模型`}
                      onChange={(event) => patchRole(field.key, { model: event.target.value })}
                    >
                      {modelOptions.length === 0 && <option value="">没有模型</option>}
                      {modelOptions.map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                    <select
                      className="role-team-select role-team-effort"
                      value={binding.effort}
                      aria-label={`${field.label}的思考强度`}
                      onChange={(event) => patchRole(field.key, { effort: event.target.value as Effort })}
                    >
                      {EFFORTS.map((effort) => (
                        <option key={effort} value={effort}>{effortOptionLabel(effort)}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            {formError && (
              <p className="role-team-error" role="alert">{formError}</p>
            )}
            <div className="role-team-actions">
              <button type="button" className="role-team-later" disabled={starting} onClick={dismiss}>
                稍后配置
              </button>
              <button type="button" className="role-team-start" disabled={starting} onClick={() => void start()}>
                {starting ? "正在开始…" : "开始"}
              </button>
            </div>
          </div>
        </Dialog>
        {dismissed && (
          <div className="role-team-hint" data-phase="setup">
            <span className="role-team-hint-text">prl-role 团队待配置</span>
            <button
              type="button"
              className="role-team-configure"
              onClick={() => {
                setFormError("");
                setDismissed(false);
              }}
            >
              配置并开始
            </button>
          </div>
        )}
      </>
    );
  }

  const activeTeam = run.team ?? team;
  return (
    <div className="role-team-panel" data-phase={run.phase}>
      <div className="role-team-head">
        <span className="role-team-title">prl-role 团队</span>
        <span className="role-team-status" data-state={run.phase}>{roleRunStatusText(run)}</span>
      </div>
      <div className="role-team-models">
        {ROLE_FIELDS.map((field) => {
          const binding = activeTeam[field.key];
          return (
            <span className="role-team-model" key={field.key} title={binding.providerName}>
              <span className="role-team-model-role">{field.label.replace(/模型$/, "")}</span>
              <span className="role-team-model-name">{binding.model || "未配置"}</span>
            </span>
          );
        })}
      </div>
      {run.units.length > 0 && (
        <ol className="role-team-units">
          {run.units.map((unit) => (
            <li
              key={unit.index}
              className="role-team-unit"
              data-phase={unit.phase}
              data-active={(run.phase === "running" && run.activeUnit === unit.index) || undefined}
            >
              <span className="role-team-unit-index">{unit.index}</span>
              <span className="role-team-unit-title" title={unit.title}>{unit.title}</span>
              <span className="role-team-unit-phase">{roleUnitStatusText(unit)}</span>
              <span className="role-team-unit-round">
                {unit.round > 0 ? `第 ${unit.round} 轮` : "未开始"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
