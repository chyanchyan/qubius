import type { WorkflowSkill } from "./api";

/** 发送区工作流下拉的取值；空串表示普通对话。 */
export interface WorkflowOption {
  value: WorkflowSkill | "";
  label: string;
  /** 选项下方的一行说明，帮用户区分几种工作流。 */
  description: string;
  /** 下拉选项和触发器的强调色令牌；普通对话不带颜色。 */
  tone?: WorkflowSkill;
}

/** 发送区下拉的选项顺序：普通在最前，工作流按常用程度排列。 */
export const WORKFLOW_OPTIONS: WorkflowOption[] = [
  { value: "", label: "普通", description: "直接对话，不启动工作流" },
  { value: "prl", label: "prl 并行", description: "多个 agent 并行开发，逐项评审", tone: "prl" },
  { value: "ser", label: "ser 串行", description: "单线程逐个实现并评审", tone: "ser" },
  { value: "plan", label: "plan 计划", description: "只输出开发计划，不改代码", tone: "plan" },
  { value: "discuss", label: "discuss 讨论", description: "多个模型依次回答、审阅，最后给出结论", tone: "discuss" },
  { value: "dis-prl", label: "dis-prl 并行讨论", description: "先拆分主题，子任务并行讨论，最后集成结论", tone: "dis-prl" },
  { value: "prl-role", label: "prl-role 团队", description: "四个模型分别编排、开发、子审核和集成审核", tone: "prl-role" },
];

/** 消息末尾允许跟随的标点/引号/括号；与服务端保持一致。 */
const WORKFLOW_TAIL = /[。.!！?？,，;；、：:）)】」』'"”’\s]+$/u;
/** 末尾独立 token；前面不能紧邻拉丁字母/数字/下划线。dis-prl、prl-role 放在 prl 前面优先匹配。 */
const WORKFLOW_TAIL_TOKEN = /(?:^|[^A-Za-z0-9_])(dis-prl|prl-role|prl|ser|plan|discuss)$/i;
/** 消息开头的 /prl、/ser、/plan、/discuss、/dis-prl、/prl-role。 */
const WORKFLOW_SLASH_COMMAND = /^\/(dis-prl|prl-role|prl|ser|plan|discuss)(?=$|[^A-Za-z0-9_])/i;

/**
 * 从用户输入里识别工作流；发送时用它在本地立即切换模式并带上 workflow，
 * 不必等 agent 消费 prompt。规则与服务端 detectWorkflowSkill 一致：
 * 末尾独立 token、可带标点、大小写不敏感、支持开头的斜杠命令；
 * plan 额外排除 "the plan" 这类英文词尾。
 */
export function detectWorkflowSkill(text: string): WorkflowSkill | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tail = trimmed.replace(WORKFLOW_TAIL, "");
  let lastIndex = -1;
  let skill: WorkflowSkill | null = null;

  const slash = WORKFLOW_SLASH_COMMAND.exec(trimmed);
  if (slash) {
    lastIndex = 0;
    skill = slash[1].toLowerCase() as WorkflowSkill;
  }

  const match = WORKFLOW_TAIL_TOKEN.exec(tail);
  if (match) {
    const index = match.index + match[0].length - match[1].length;
    const candidate = match[1].toLowerCase() as WorkflowSkill;
    // plan 和英文单词重合，避免把 "the plan" 误判成工作流；中文紧邻仍然识别。
    const latinPrefix = /[A-Za-z0-9_]$/.test(tail.slice(0, index).trimEnd());
    if ((candidate !== "plan" || !latinPrefix) && index >= lastIndex) {
      skill = candidate;
    }
  }
  return skill;
}
