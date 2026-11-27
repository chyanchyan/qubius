import { clip } from "./status.js";
import type { RoleBinding, RoleKind, RoleTeam } from "./types.js";

/**
 * prl-role 角色团队的纯逻辑：角色标签、各阶段提示词、审核裁定解析。
 *
 * 与 discussion.ts 的讨论流程不同，prl-role 的「执行者」拥有完整工具权限，
 * 会真正修改工作区；编排者、子审核和集成审核都只读。这里只放不依赖 SDK
 * 和文件系统的部分，方便单独测试。
 */

/** 最多拆几个工作单元；同时限制串行开发的长度。 */
export const MAX_ROLE_UNITS = 4;
/** 每个单元最多几轮「执行 → 审核」；达到上限仍有问题时标为需要关注。 */
export const MAX_ROLE_ROUNDS = 3;

/** 角色短名，用于进度条和发言者标签。 */
export const ROLE_LABELS: Record<RoleKind, string> = {
  orchestrator: "编排",
  executor: "执行",
  "sub-reviewer": "子审核",
  "integration-reviewer": "集成审核",
};

/** 角色全名，用于设置页和配置弹窗。 */
export const ROLE_TITLES: Record<RoleKind, string> = {
  orchestrator: "编排模型",
  executor: "执行模型",
  "sub-reviewer": "子审核模型",
  "integration-reviewer": "集成审核模型",
};

/** 角色到 RoleTeam 字段的映射。 */
export const ROLE_TEAM_KEY: Record<RoleKind, keyof RoleTeam> = {
  orchestrator: "orchestrator",
  executor: "executor",
  "sub-reviewer": "subReviewer",
  "integration-reviewer": "integrationReviewer",
};

/** 角色团队里所有角色，按运行顺序排列。 */
export const ROLE_KINDS: RoleKind[] = [
  "orchestrator",
  "executor",
  "sub-reviewer",
  "integration-reviewer",
];

export function roleBindingFor(team: RoleTeam, kind: RoleKind): RoleBinding {
  return team[ROLE_TEAM_KEY[kind]];
}

/** 发言者显示名，例如「执行 · claude-sonnet-5-5」。 */
export function roleSpeaker(team: RoleTeam, kind: RoleKind): string {
  return `${ROLE_LABELS[kind]} · ${roleBindingFor(team, kind).model}`;
}

/** 各角色的 system prompt；执行者会追加在 SDK 的 claude_code 预设之后。 */
export function roleSystemPrompt(kind: RoleKind): string {
  if (kind === "orchestrator") {
    return [
      "你是 prl-role 团队里的编排者，只负责拆分工作，不写代码、不修改文件。",
      "拆分要互不重叠，尽量让每个单元能独立完成和评审。",
    ].join("\n");
  }
  if (kind === "executor") {
    return [
      "你是 prl-role 团队里的执行者，只负责分配给你的那个工作单元。",
      "不要在其它单元负责的文件上做无关改动；完成后用一段话说明改了哪些文件、做了哪些验证。",
    ].join("\n");
  }
  if (kind === "sub-reviewer") {
    return [
      "你是 prl-role 团队里的子审核者，只审查分配给你的工作单元。",
      "检查正确性、边界条件、回归风险和验收标准；不修改代码。",
    ].join("\n");
  }
  return [
    "你是 prl-role 团队里的集成审核者，审查所有单元合并后的整体改动。",
    "重点看跨单元冲突、遗漏、重复改动和整体验收标准；不修改代码。",
  ].join("\n");
}

/** 第一阶段：让编排模型把请求拆成 JSON 字符串数组。 */
export function roleDecomposePrompt(topic: string): string {
  return [
    "用户请求：",
    topic.trim(),
    "",
    "请把请求拆成互相独立、可以分别开发和评审的工作单元。",
    `单元数量 1-${MAX_ROLE_UNITS} 个；如果本身就是一个单一改动，只输出 1 个。`,
    "每个单元的描述要能独立作为开发任务，尽量写明涉及的文件或模块。",
    '只输出 JSON 字符串数组，例如 ["单元一：修改 a.ts 的校验","单元二：补充 a.ts 的测试"]，不要输出解释、编号或代码块标记。',
  ].join("\n");
}

/** 执行阶段：按单元、轮次和上一轮审核意见开发。 */
export function roleDevelopPrompt(input: {
  topic: string;
  unit: { index: number; title: string };
  round: number;
  issues?: string;
  previousSummary?: string;
}): string {
  const lines = [
    "用户请求（整体背景）：",
    input.topic.trim(),
    "",
    `你负责的工作单元（第 ${input.unit.index} 个）：${input.unit.title}`,
  ];
  if (input.round > 1) {
    lines.push(
      "",
      `这是第 ${input.round} 轮修复。上一轮审核提出了以下问题，请逐条处理：`,
      input.issues?.trim() || "（没有收到具体问题，请重新检查并改进实现）",
    );
  }
  if (input.previousSummary) {
    lines.push("", "上一轮你的自述：", input.previousSummary.trim());
  }
  lines.push(
    "",
    "要求：",
    "- 先读相关代码，再做最小必要的修改；不要动其它单元负责的内容。",
    "- 修改后尽可能运行相关测试或类型检查，确认没有引入回归。",
    "- 完成后用一段话总结：改了哪些文件、关键改动、验证结果。",
  );
  return lines.join("\n");
}

/** 子审核阶段：只读检查单元改动，输出固定裁定。 */
export function roleReviewPrompt(input: {
  topic: string;
  unit: { index: number; title: string };
  round: number;
  diff: string;
  issues?: string;
}): string {
  const lines = [
    "用户请求（整体背景）：",
    input.topic.trim(),
    "",
    `当前工作单元（第 ${input.unit.index} 个）：${input.unit.title}`,
    `这是第 ${input.round} 轮审核。`,
  ];
  if (input.issues) {
    lines.push("", "上一轮提出的问题（请逐条核验是否已修复，以及是否引入回归）：", input.issues.trim());
  }
  lines.push(
    "",
    "当前工作区的改动（可能包含前面单元的结果）：",
    input.diff.trim() || "（没有读到改动）",
    "",
    "你可以使用 Read/Grep/Glob 查看周边代码。只审查这个单元相关的改动，不要扩大范围。",
    "最后一行必须单独输出以下两种之一：",
    "结论：PASS",
    "结论：CHANGES",
    "输出 CHANGES 时，在上面用 `- [阻塞] 文件:行 问题、期望行为` 逐条列出必须修改的问题；不阻塞的建议用 `- [建议]`。",
  );
  return lines.join("\n");
}

/** 集成审核阶段：审查全部单元合并后的整体改动。 */
export function roleIntegrationPrompt(input: {
  topic: string;
  units: Array<{ index: number; title: string; phase: string; verdict?: string }>;
  diff: string;
}): string {
  const summary = input.units
    .map((unit) => `- 单元 ${unit.index}：${unit.title}（${unit.phase}${unit.verdict ? `，最近判定 ${unit.verdict}` : ""}）`)
    .join("\n");
  return [
    "用户请求：",
    input.topic.trim(),
    "",
    "各工作单元的完成情况：",
    summary || "（没有单元）",
    "",
    "全部单元结束后的整体改动：",
    input.diff.trim() || "（没有读到改动）",
    "",
    "请做整体审核：检查跨单元冲突、遗漏、重复改动、整体验收标准和回归风险。",
    "你可以使用 Read/Grep/Glob 查看代码。",
    "最后一行必须单独输出以下两种之一：",
    "结论：PASS",
    "结论：CHANGES",
    "输出 CHANGES 时，在上面用 `- [阻塞] 文件:行 问题、期望行为` 逐条列出必须修改的问题；不阻塞的建议用 `- [建议]`。",
  ].join("\n");
}

export interface RoleVerdict {
  pass: boolean;
  /** 没有找到裁定行：按未通过处理，宁可多修一轮。 */
  unknown: boolean;
  /** 审核原文（截断），修复轮交给执行者。 */
  issues: string;
}

const VERDICT_RE = /结论\s*[：:]\s*(PASS|CHANGES|通过|需要修改|需要改动)/gi;

/** 解析审核回复的裁定；取最后一次出现的结论。 */
export function parseRoleVerdict(text: string): RoleVerdict {
  const matches = [...text.matchAll(VERDICT_RE)];
  const last = matches[matches.length - 1];
  const issues = clip(text.trim(), 8_000);
  if (!last) return { pass: false, unknown: true, issues };
  const value = last[1]!.toLowerCase();
  return { pass: value === "pass" || value === "通过", unknown: false, issues };
}

/** 把 diffSummary 的结果拼成审核输入；没有改动时也明确说明。 */
export function formatRoleDiff(diff: { stat: string; patch: string }): string {
  if (!diff.patch.trim()) {
    return diff.stat.trim() || "（没有改动）";
  }
  return [diff.stat.trim(), diff.patch.trim()].filter(Boolean).join("\n\n");
}
