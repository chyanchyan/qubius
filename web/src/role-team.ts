import type {
  Effort,
  Provider,
  RoleBinding,
  RoleKind,
  RoleRunState,
  RoleTeam,
  RoleUnitState,
} from "./api";

/**
 * prl-role 角色团队的纯逻辑：固定四行配置、默认值回退和进度文案。
 * 组件只负责渲染，方便在没有 DOM 的测试里覆盖这些规则。
 */

/** 弹窗里的四个固定角色，顺序与运行顺序一致；不可增删。 */
export const ROLE_FIELDS: Array<{
  key: keyof RoleTeam;
  kind: RoleKind;
  label: string;
  hint: string;
}> = [
  { key: "orchestrator", kind: "orchestrator", label: "编排模型", hint: "拆分工作单元，不直接改代码" },
  { key: "executor", kind: "executor", label: "执行模型", hint: "逐个单元完成开发和自测" },
  { key: "subReviewer", kind: "sub-reviewer", label: "子审核模型", hint: "逐单元评审并给出修改意见" },
  { key: "integrationReviewer", kind: "integration-reviewer", label: "集成审核模型", hint: "全部单元结束后做整体审核" },
];

/** 进度文案里的角色短名，与服务端 ROLE_LABELS 一致。 */
const ROLE_SHORT_LABEL: Record<RoleKind, string> = {
  orchestrator: "编排",
  executor: "执行",
  "sub-reviewer": "子审核",
  "integration-reviewer": "集成审核",
};

function bindingComplete(binding: RoleBinding | undefined): boolean {
  return Boolean(binding && binding.providerId.trim() && binding.model.trim());
}

/** 四个角色都选了接口和模型才算完整。 */
export function roleTeamComplete(team: RoleTeam | undefined): boolean {
  if (!team) return false;
  return ROLE_FIELDS.every(({ key }) => bindingComplete(team[key]));
}

function copyBinding(binding: RoleBinding): RoleBinding {
  return {
    providerId: binding.providerId,
    providerName: binding.providerName,
    model: binding.model,
    effort: binding.effort,
  };
}

/** 接口和模型都仍然有效时沿用回退值，否则退回第一个接口的第一个模型。 */
function fallbackBinding(
  fallback: { providerId: string; model: string; effort: Effort },
  providers: Provider[],
): RoleBinding {
  const provider = providers.find((item) => item.id === fallback.providerId);
  if (provider && fallback.model && provider.models.includes(fallback.model)) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      model: fallback.model,
      effort: fallback.effort,
    };
  }
  const first = providers[0];
  if (first) {
    return {
      providerId: first.id,
      providerName: first.name,
      model: first.models[0] ?? "",
      effort: fallback.effort,
    };
  }
  // 接口列表还没加载时不能把团队清空：保留会话当前的接口/模型，等配置到位再校验。
  return {
    providerId: fallback.providerId,
    providerName: "",
    model: fallback.model,
    effort: fallback.effort,
  };
}

function copyTeam(team: RoleTeam): RoleTeam {
  return {
    orchestrator: copyBinding(team.orchestrator),
    executor: copyBinding(team.executor),
    subReviewer: copyBinding(team.subReviewer),
    integrationReviewer: copyBinding(team.integrationReviewer),
  };
}

/**
 * 弹窗的初始团队优先级：服务端保留的上一支团队 → 设置页默认团队 →
 * 当前会话的接口/模型/effort。前两者只要四个角色完整就整队采用。
 */
export function roleTeamDefaults(
  runTeam: RoleTeam | undefined,
  settingsTeam: RoleTeam | undefined,
  providers: Provider[],
  fallback: { providerId: string; model: string; effort: Effort },
): RoleTeam {
  if (roleTeamComplete(runTeam)) return copyTeam(runTeam as RoleTeam);
  if (roleTeamComplete(settingsTeam)) return copyTeam(settingsTeam as RoleTeam);
  const binding = fallbackBinding(fallback, providers);
  return {
    orchestrator: { ...binding },
    executor: { ...binding },
    subReviewer: { ...binding },
    integrationReviewer: { ...binding },
  };
}

/**
 * 兼容旧调用：没有服务端保留团队时，按设置页默认团队或会话当前模型取初始值。
 */
export function defaultRoleTeam(
  settingsTeam: RoleTeam | undefined,
  providers: Provider[],
  fallback: { providerId: string; model: string; effort: Effort },
): RoleTeam {
  return roleTeamDefaults(undefined, settingsTeam, providers, fallback);
}

/** 当前运行的整行状态：阶段 + 单元/轮次/角色/工具。 */
export function roleRunStatusText(state: RoleRunState): string {
  if (state.phase === "setup") return "选择角色团队后开始";
  if (state.phase === "running") {
    const parts: string[] = [];
    if (state.integrating) parts.push("集成审核");
    else if (state.activeUnit) parts.push(`单元 ${state.activeUnit}`);
    if (state.round > 0) parts.push(`第 ${state.round} 轮`);
    // 集成阶段由「集成审核」前缀已经说明角色，不再重复「集成审核中」。
    if (state.activeRole && !(state.integrating && state.activeRole === "integration-reviewer")) {
      parts.push(`${ROLE_SHORT_LABEL[state.activeRole]}中`);
    }
    let text = parts.join(" · ");
    if (!text) text = "运行中";
    if (state.activeTool) text += ` · ${state.activeTool}`;
    return text;
  }
  if (state.phase === "completed") {
    return state.agreed === false ? "运行完成 · 集成审核未通过" : "运行完成";
  }
  if (state.phase === "stopped") return "已停止";
  return state.error ? `运行失败：${state.error}` : "运行失败";
}

/** 单个工作单元的状态文案；轮次由面板单独展示。 */
export function roleUnitStatusText(unit: RoleUnitState): string {
  if (unit.phase === "pending") return "待处理";
  if (unit.phase === "running") return unit.round > 1 ? `第 ${unit.round} 轮运行中` : "运行中";
  if (unit.phase === "passed") return "已通过";
  if (unit.phase === "needs_attention") {
    return unit.verdict === "changes" ? "需要修改" : "待关注";
  }
  return "已停止";
}
