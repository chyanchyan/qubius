/* 首次运行部署向导的纯逻辑：场景选择、步骤顺序、逐步校验和摘要。
   组件只负责渲染；这里保持无 React 依赖，方便单测。 */
import type { DeployForm } from "./api-deploy";
import { pathIsAbsolute } from "./deploy-path";

/** 与 DeployPage 共用的本地阶段；服务端 job.state 只有 running/success/failed。 */
export type DeployPhase =
  | "idle"
  | "submitting"
  | "running"
  | "restarting"
  | "success"
  | "failed"
  | "unknown"
  | "relocated";

export type WizardRole = "primary" | "secondary";
export type WizardScenario = "local" | "remote" | "dual";
export type WizardStepId = "scenario" | "instance" | "peer" | "review";

/** 向导入口：首次运行（还没有配置）或已有配置时的重新部署。 */
export type WizardMode = "setup" | "redeploy";

/** 与服务端 deploy/lib.sh、server/src/deploy.ts 的默认值保持一致。 */
export const DEFAULT_PUBLIC_HOST = "code.example.com";
export const DEFAULT_PUBLIC_HOST_SECONDARY = "code-bak.example.com";
export const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/** 服务端在没配置仓库地址时使用的占位值；检测到真实 origin 时向导会替换它。 */
const PLACEHOLDER_REPO_URL = "http://gitea.example.com/example/qubius.git";

export const ROLE_NAME: Record<WizardRole, string> = {
  primary: "主实例",
  secondary: "副实例",
};

export const SCENARIO_LABEL: Record<WizardScenario, string> = {
  local: "仅本机使用",
  remote: "远程访问",
  dual: "主副双实例",
};

export function isWindowsPlatform(platform: string): boolean {
  return platform === "win32";
}

export interface WizardCopy {
  title: string;
  intro: string;
  successLead: string;
  /** 切回完整表单的按钮文案：首次部署叫「使用」，重新部署叫「返回」。 */
  switchLabel: string;
}

/** 两种入口共用同一套步骤，只换页面文案，避免重新部署时仍说「第一次运行」。 */
export function wizardCopy(mode: WizardMode): WizardCopy {
  if (mode === "redeploy") {
    return {
      title: "重新部署",
      intro: "从第一步开始重新确认配置。当前配置已经预填，只改需要调整的项即可；部署会更新现有配置、重新构建并重启服务。",
      successLead: "qubius 已经按向导里的配置完成重新部署。",
      switchLabel: "返回完整部署表单",
    };
  }
  return {
    title: "部署向导",
    intro: "第一次运行还没有配置文件。按下面的步骤确认几个必要参数，部署会自动生成配置、构建并重启服务。",
    successLead: "qubius 已经按向导里的配置完成首次部署。",
    switchLabel: "使用完整部署表单",
  };
}

export interface WizardScenarioOption {
  id: WizardScenario;
  title: string;
  description: string;
}

/** 向导第一步的选项；Windows 不能同步/回滚副实例，文案要写清楚。 */
export function scenarioOptions(platform: string): WizardScenarioOption[] {
  const windows = isWindowsPlatform(platform);
  return [
    {
      id: "local",
      title: "只在这台机器使用",
      description: "用 127.0.0.1 或 SSH 隧道打开页面，不需要域名。最省事的方式。",
    },
    {
      id: "remote",
      title: "通过域名或局域网访问",
      description: "已经准备好反向代理或局域网入口。需要填写浏览器实际访问的域名。",
    },
    {
      id: "dual",
      title: windows ? "两个实例（Windows）" : "主副双实例互备",
      description: windows
        ? "同一台机器运行两个 checkout，一个页面改坏了可以用另一个修。Windows 上不支持副实例的同步/回滚按钮。"
        : "同一台机器运行两个 checkout，主实例出问题时可以从副实例修复。",
    },
  ];
}

export interface WizardPlaceholders {
  checkout: string;
  data: string;
  archive: string;
}

/** 输入框被清空时展示的路径示例，按平台和角色区分。 */
export function wizardPlaceholders(platform: string, role: WizardRole): WizardPlaceholders {
  if (isWindowsPlatform(platform)) {
    return role === "primary"
      ? {
        checkout: String.raw`C:\Users\you\qubius`,
        data: String.raw`C:\Users\you\AppData\Local\qubius`,
        archive: String.raw`C:\Users\you\qubius-archive`,
      }
      : {
        checkout: String.raw`C:\Users\you\co-qubius`,
        data: String.raw`C:\Users\you\AppData\Local\co-qubius`,
        archive: String.raw`C:\Users\you\co-qubius-archive`,
      };
  }
  return role === "primary"
    ? { checkout: "/srv/qubius", data: "/srv/qubius-data", archive: "/srv/qubius-archive" }
    : { checkout: "/srv/co-qubius", data: "/srv/co-qubius-data", archive: "/srv/co-qubius-archive" };
}

export interface RoleFieldKeys {
  start: "startPrimary" | "startSecondary";
  dir: "primaryDir" | "secondaryDir";
  data: "dataPrimary" | "dataSecondary";
  port: "primaryPort" | "secondaryPort";
  host: "publicHost" | "publicHostSecondary";
}

export function roleKeys(role: WizardRole): RoleFieldKeys {
  return role === "primary"
    ? { start: "startPrimary", dir: "primaryDir", data: "dataPrimary", port: "primaryPort", host: "publicHost" }
    : {
      start: "startSecondary",
      dir: "secondaryDir",
      data: "dataSecondary",
      port: "secondaryPort",
      host: "publicHostSecondary",
    };
}

export function otherRole(role: WizardRole): WizardRole {
  return role === "primary" ? "secondary" : "primary";
}

/** 访问页面用的主机名可以直接当访问域名，省得再手写一遍。 */
export function browserHostSuggestion(hostname: string | undefined): string | undefined {
  const value = (hostname ?? "").trim().toLowerCase();
  if (!value || isLoopbackHost(value)) return undefined;
  return HOST_RE.test(value) ? value : undefined;
}

/** 首次部署时把向导最可能需要改的默认值对齐到当前 checkout。 */
export function prepareWizardForm(
  input: {
    repoDir: string;
    role: WizardRole;
    detectedRepoUrl?: string;
    /** 浏览器当前访问的主机名；通过域名/局域网 IP 打开时直接作为访问域名。 */
    browserHost?: string;
  },
  form: DeployForm,
): DeployForm {
  const next: DeployForm = {
    ...form,
    projects: form.projects.map((project) => ({ ...project })),
  };
  const keys = roleKeys(input.role);
  // 当前服务就是从 repoDir 跑起来的，它一定是一个可用的 checkout；
  // 用户仍可在向导里改成别的目录。
  next[keys.dir] = input.repoDir;
  const currentHost = next[keys.host].trim();
  if (!currentHost || isLoopbackHost(currentHost)) {
    // 默认 localhost 只是本机入口；通过域名/局域网 IP 打开页面时换成当前地址。
    const suggested = browserHostSuggestion(input.browserHost);
    if (suggested) next[keys.host] = suggested;
    else if (!currentHost) next[keys.host] = "localhost";
  }
  if (input.detectedRepoUrl && next.primaryRepoUrl === PLACEHOLDER_REPO_URL) {
    next.primaryRepoUrl = input.detectedRepoUrl;
  }
  return next;
}

/** 从已有表单推断用户上次的选择；默认走最省事的本机模式。 */
export function initialScenario(form: DeployForm, role: WizardRole): WizardScenario {
  if (form.startPrimary && form.startSecondary) return "dual";
  const host = form[roleKeys(role).host].trim();
  if (!host || host === "localhost" || host === "127.0.0.1") return "local";
  return "remote";
}

export function wizardSteps(scenario: WizardScenario): WizardStepId[] {
  return scenario === "dual"
    ? ["scenario", "instance", "peer", "review"]
    : ["scenario", "instance", "review"];
}

export function stepTitle(step: WizardStepId, scenario: WizardScenario, role: WizardRole): string {
  switch (step) {
    case "scenario":
      return "选择使用方式";
    case "instance":
      return scenario === "dual" ? `${ROLE_NAME[role]}设置` : "实例设置";
    case "peer":
      return `${ROLE_NAME[otherRole(role)]}设置`;
    case "review":
      return "确认并部署";
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** 选择使用方式后要写入表单的补丁；只改场景真正相关的字段。 */
export function scenarioPatch(
  form: DeployForm,
  role: WizardRole,
  scenario: WizardScenario,
  suggestedHost?: string,
): Partial<DeployForm> {
  const dual = scenario === "dual";
  const patch: Partial<DeployForm> = {
    startPrimary: role === "primary" || dual,
    startSecondary: role === "secondary" || dual,
    clonePeer: dual ? form.clonePeer : false,
  };
  if (scenario === "local") {
    const keys = roleKeys(role);
    patch[keys.host] = "localhost";
    return patch;
  }
  if (scenario === "remote") {
    // 远程模式要填浏览器实际访问的域名；用当前页面地址补上，省得手写。
    // 页面本身就是通过回环地址打开的，没有可用的建议值，保留 localhost 作为
    // 可编辑的默认值，避免必填项直接空着、下一步才报错。
    const keys = roleKeys(role);
    const currentHost = form[keys.host].trim();
    if (!currentHost || isLoopbackHost(currentHost)) {
      patch[keys.host] = suggestedHost ?? "localhost";
    }
    return patch;
  }
  if (dual) {
    // 两个实例必须使用可区分的 Host；本机双实例用 localhost / 127.0.0.1 即可。
    const primaryHost = form.publicHost || "localhost";
    let secondaryHost = form.publicHostSecondary;
    if (!secondaryHost || secondaryHost === primaryHost) {
      secondaryHost = primaryHost === "127.0.0.1" ? "localhost" : "127.0.0.1";
    }
    patch.publicHost = primaryHost;
    patch.publicHostSecondary = secondaryHost;
  }
  return patch;
}

function validateHost(host: string, label: string): string | null {
  if (!host) return `${label}不能为空；只在本机使用时可以填 localhost。`;
  if (!HOST_RE.test(host)) return `${label}只能包含小写字母、数字、点和连字符。`;
  return null;
}

function validateRole(form: DeployForm, role: WizardRole, requireHost: boolean): string | null {
  const keys = roleKeys(role);
  const name = ROLE_NAME[role];
  const dir = form[keys.dir].trim();
  if (!dir) return `${name}的 Checkout 路径不能为空。`;
  if (!pathIsAbsolute(dir)) return `${name}的 Checkout 路径必须是绝对路径。`;
  const data = form[keys.data].trim();
  if (!data) return `${name}的数据目录不能为空。`;
  if (!pathIsAbsolute(data)) return `${name}的数据目录必须是绝对路径。`;
  const port = form[keys.port];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return `${name}端口必须是 1–65535 的整数。`;
  }
  if (requireHost) return validateHost(form[keys.host].trim(), `${name}的访问域名`);
  return null;
}

/** 校验当前步骤可见的字段；返回中文错误，null 表示可以继续。 */
export function validateWizardStep(
  step: WizardStepId,
  form: DeployForm,
  role: WizardRole,
  scenario: WizardScenario,
): string | null {
  if (step === "scenario") return null;
  if (step === "instance") {
    const roleFailure = validateRole(form, role, scenario !== "local");
    if (roleFailure) return roleFailure;
    // 归档等可选参数也放在这一步，确认部署前就能发现格式问题。
    const archiveDir = form.archiveDir.trim();
    if (archiveDir && !pathIsAbsolute(archiveDir)) {
      return "归档目录必须是绝对路径，或留空不归档。";
    }
    if (
      !Number.isInteger(form.archiveRetentionDays)
      || form.archiveRetentionDays < 1
      || form.archiveRetentionDays > 3650
    ) {
      return "列表保留天数必须在 1 到 3650 之间；到期后会话归档到冷存储并永久保留。";
    }
    if (form.startPrimary && !/^https?:\/\//.test(form.primaryRepoUrl.trim())) {
      return "qubius 仓库地址必须是 http(s):// 开头。";
    }
    return null;
  }
  if (step === "peer") {
    const failure = validateRole(form, otherRole(role), true);
    if (failure) return failure;
    if (form.primaryPort === form.secondaryPort) {
      return "主实例和副实例的端口不能相同。";
    }
    if (form.publicHost === form.publicHostSecondary) {
      return "主实例和副实例不能使用同一个访问域名。";
    }
    if (form.clonePeer && !/^https?:\/\//.test(form.primaryRepoUrl.trim())) {
      return "自动克隆需要填写 http(s) 开头的 qubius 仓库地址。";
    }
    return null;
  }
  return null;
}

export interface WizardSummaryRow {
  label: string;
  value: string;
  mono?: boolean;
}

export interface WizardSummaryGroup {
  title: string;
  rows: WizardSummaryRow[];
}

export function wizardSummaryGroups(
  form: DeployForm,
  role: WizardRole,
  scenario: WizardScenario,
): WizardSummaryGroup[] {
  const groups: WizardSummaryGroup[] = [];
  const addRole = (target: WizardRole) => {
    const keys = roleKeys(target);
    groups.push({
      title: `${ROLE_NAME[target]}${target === role ? "（当前）" : ""}`,
      rows: [
        { label: "Checkout", value: form[keys.dir] || "—", mono: true },
        { label: "数据目录", value: form[keys.data] || "—", mono: true },
        { label: "端口", value: String(form[keys.port]), mono: true },
        { label: "访问域名", value: form[keys.host] || "—", mono: true },
      ],
    });
  };
  addRole(role);
  if (scenario === "dual") addRole(otherRole(role));
  groups.push({
    title: "部署",
    rows: [
      { label: "使用方式", value: SCENARIO_LABEL[scenario] },
      { label: "配置目录", value: form.configDir || "—", mono: true },
      {
        label: "会话归档",
        value: form.archiveDir.trim()
          ? `${form.archiveDir}（列表保留 ${form.archiveRetentionDays} 天）`
          : "未启用",
        mono: Boolean(form.archiveDir.trim()),
      },
    ],
  });
  return groups;
}
