import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProjectConfig, WorktreeConfig } from "./config.js";
import { isPermission } from "./permissions.js";
import { normalizeWorktreeConfig } from "./worktree-prep.js";

/**
 * 额外项目文件（默认 `<configDir>/projects.yaml`）的读写。
 * 文件内容直接挂在 config.yaml 的 `projects:` 下，格式必须满足
 * deploy/install.sh 的缩进校验：条目以两个空格加短横开头，续行四个空格。
 */

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface ProjectsFileResult {
  projects: ProjectConfig[];
  /** 读取或校验失败时的说明；调用方应保留现有项目列表。 */
  error?: string;
}

/** QUBIUS_PROJECTS_FILE 未配置时用配置目录下的 projects.yaml。 */
export function resolveProjectsFile(configDir: string, configured?: string): string {
  const raw = (configured ?? "").trim();
  return raw ? path.resolve(configDir, raw) : path.join(configDir, "projects.yaml");
}

export function readProjectsFile(file: string, configDir: string): ProjectsFileResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: [] };
    return { projects: [], error: `无法读取 ${file}：${messageOf(error)}` };
  }
  // 空文件、纯注释都视为没有额外项目。
  if (text.split(/\r?\n/).every((line) => !line.trim() || line.trimStart().startsWith("#"))) {
    return { projects: [] };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    return { projects: [], error: `不是合法 YAML：${messageOf(error)}` };
  }
  if (parsed === null || parsed === undefined) return { projects: [] };
  if (!Array.isArray(parsed)) return { projects: [], error: "必须是 YAML 列表" };
  const projects: ProjectConfig[] = [];
  const seen = new Set<string>();
  for (const [index, item] of parsed.entries()) {
    const at = `第 ${index + 1} 项`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { projects: [], error: `${at}必须是对象` };
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const rawPath = typeof record.path === "string" ? record.path.trim() : "";
    if (!PROJECT_ID_RE.test(id)) {
      return { projects: [], error: `${at} id 只能用小写字母、数字和连字符` };
    }
    if (seen.has(id)) return { projects: [], error: `项目 id 重复：${id}` };
    seen.add(id);
    if (!name) return { projects: [], error: `${at} name 不能为空` };
    if (!rawPath) return { projects: [], error: `${at} path 不能为空` };
    const permission = record.permission === undefined ? "acceptEdits" : record.permission;
    if (!isPermission(permission)) {
      return { projects: [], error: `${at} permission 必须是 default、acceptEdits、plan、auto 或 bypassPermissions` };
    }
    const isolated = record.isolated === undefined ? false : record.isolated;
    if (typeof isolated !== "boolean") {
      return { projects: [], error: `${at} isolated 必须是 true 或 false` };
    }
    let worktree: WorktreeConfig | undefined;
    try {
      worktree = normalizeWorktreeConfig(record.worktree, `${at} worktree`);
    } catch (error) {
      return { projects: [], error: messageOf(error) };
    }
    projects.push({
      id,
      name,
      path: path.resolve(configDir, rawPath),
      permission,
      isolated,
      ...(worktree ? { worktree } : {}),
    });
  }
  return { projects };
}

/** 额外项目覆盖 config.yaml 里的同 id 项目，其余按原顺序保留。 */
export function mergeProjectLists(base: ProjectConfig[], extras: ProjectConfig[]): ProjectConfig[] {
  if (extras.length === 0) return [...base];
  const overrides = new Set(extras.map((project) => project.id));
  return [...base.filter((project) => !overrides.has(project.id)), ...extras];
}

/** YAML 单引号字符串；含控制字符时退回 JSON 双引号（YAML 兼容）。 */
function yamlString(value: string): string {
  if (CONTROL_RE.test(value)) return JSON.stringify(value);
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderProjectEntry(project: ProjectConfig): string {
  const lines = [
    `  - id: ${yamlString(project.id)}`,
    `    name: ${yamlString(project.name)}`,
    `    path: ${yamlString(project.path)}`,
    `    permission: ${project.permission}`,
  ];
  if (project.isolated) lines.push("    isolated: true");
  if (project.worktree) {
    const { setup, setupTimeoutSeconds, sharedDirectories, include } = project.worktree;
    const worktree = {
      ...(setup ? { setup } : {}),
      setupTimeoutSeconds,
      ...(sharedDirectories.length ? { sharedDirectories } : {}),
      ...(include.length ? { include } : {}),
    };
    // deploy/install.sh 只允许条目内四空格续行，嵌套块状映射会被拒绝；
    // 这里写成 YAML 兼容的 JSON 流式映射，保持单行四空格续行。
    lines.push(`    worktree: ${JSON.stringify(worktree)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 追加一条项目，保留文件里的注释和已有条目。
 * 调用方负责先确认文件可解析且没有同 id 条目。
 */
export function appendProjectToFile(file: string, project: ProjectConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let prefix = "";
  try {
    const existing = fs.readFileSync(file, "utf8");
    if (existing && !existing.endsWith("\n")) prefix = "\n";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.appendFileSync(file, `${prefix}${renderProjectEntry(project)}`, { mode: 0o644 });
}

/**
 * 从额外项目文件里删除一个 id 的条目，保留注释和其它条目。
 * 只处理本文件写出的块状格式（`  - ` 开头、4 空格续行）；无法识别时返回 false，
 * 由调用方提示用户手动编辑。空行和顶格注释会保留，缩进注释随所属条目一起删除。
 */
export function removeProjectFromFile(file: string, id: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const lines = text.split("\n");
  const starts: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (/^  - /.test(line)) starts.push(index);
  }

  let target = -1;
  for (const [position, start] of starts.entries()) {
    const end = starts[position + 1] ?? lines.length;
    let parsed: unknown;
    try {
      parsed = parseYaml(lines.slice(start, end).join("\n"));
    } catch {
      continue;
    }
    const item = Array.isArray(parsed) ? parsed[0] : undefined;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const value = (item as Record<string, unknown>).id;
      if (typeof value === "string" && value.trim() === id) {
        target = start;
        break;
      }
    }
  }
  if (target === -1) return false;

  const nextStart = starts.find((start) => start > target) ?? lines.length;
  const kept: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (index <= target) {
      if (index !== target) kept.push(line);
      continue;
    }
    if (index >= nextStart) {
      kept.push(line);
      continue;
    }
    // 空行和顶格注释是分隔/说明，保留；缩进内容（含缩进注释）属于被删条目。
    if (!line.trim() || line.startsWith("#")) kept.push(line);
  }

  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, kept.join("\n"), { mode: 0o644 });
  fs.renameSync(temp, file);
  return true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
