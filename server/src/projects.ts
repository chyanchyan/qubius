import fs from "node:fs";
import type { ProjectConfig } from "./config.js";
import type { ProjectInfo } from "./types.js";
import { isGitRepo } from "./worktree.js";

export async function describeProject(
  project: ProjectConfig,
): Promise<Omit<ProjectInfo, "permission" | "removable">> {
  // statSync 可能在 existsSync 之后路径消失，或权限不足时抛错，这里统一当作不可用。
  let available = false;
  try {
    available = fs.statSync(project.path).isDirectory();
  } catch {
    available = false;
  }
  // 内置「普通对话」目录即使恰好落在某个仓库里也不走 worktree：它不对应代码仓库。
  const git = available && !project.builtin ? await isGitRepo(project.path) : false;
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    git,
    available,
    builtin: project.builtin === true,
    isolated: project.isolated && !git,
  };
}
