import fs from "node:fs";
import path from "node:path";
import type { SessionCore } from "./types.js";
import { removeWorktree, restoreWorktree } from "./worktree.js";

/**
 * 隔离项目里属于这个对话自己的目录。只接受 <项目目录>/<对话 id>，
 * 避免配置改动或损坏数据让删除操作误删项目根目录。
 */
export function isolatedWorkspace(session: SessionCore): string | null {
  if (session.git) return null;
  const cwd = path.resolve(session.cwd);
  const root = path.resolve(session.projectPath);
  if (cwd === root || path.dirname(cwd) !== root || path.basename(cwd) !== session.id) return null;
  return cwd;
}

/**
 * 删除一次对话自己的代码目录：
 * - git 会话删除 worktree 和会话自己的分支（qubius/<id>，旧会话是 qoder/<id> 或 remote-coder/<id>）；
 * - 隔离的非 git 会话删除 <项目目录>/<对话 id>。
 *
 * 删除失败时抛错，调用方应保留会话以便重试。
 */
export async function removeSessionWorkspace(session: SessionCore): Promise<void> {
  if (session.git && session.cwd !== session.projectPath) {
    await removeWorktree(session.projectPath, session.cwd, session.branch);
    return;
  }
  const workspace = isolatedWorkspace(session);
  if (workspace) {
    await fs.promises.rm(workspace, { recursive: true, force: true });
  }
}

/**
 * 恢复失败时清理本次新建的 worktree/目录。git 分支可能复用自清理失败
 * 的旧 worktree，不能删，所以这里只删 worktree 本身。
 */
export async function removeRestoredWorkspace(session: SessionCore): Promise<void> {
  if (session.git && session.cwd !== session.projectPath) {
    await removeWorktree(session.projectPath, session.cwd);
    return;
  }
  const workspace = isolatedWorkspace(session);
  if (workspace) {
    await fs.promises.rm(workspace, { recursive: true, force: true });
  }
}

/**
 * 归档恢复时重建可用的 cwd。git 会话重建 worktree/分支，隔离会话重建
 * 子目录。旧的未提交改动不会回来，只恢复对话上下文。
 * 返回是否新建了目录；恢复失败时调用方可以用它决定是否清理。
 */
export async function restoreSessionWorkspace(session: SessionCore): Promise<boolean> {
  const cwd = path.resolve(session.cwd);
  if (!fs.existsSync(session.projectPath)) {
    throw new Error(`项目目录不存在：${session.projectPath}`);
  }
  if (session.git && cwd !== path.resolve(session.projectPath)) {
    return restoreWorktree({
      projectPath: session.projectPath,
      cwd,
      branch: session.branch,
      sessionId: session.id,
    });
  }
  const workspace = isolatedWorkspace(session);
  if (!workspace || fs.existsSync(workspace)) return false;
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  return true;
}
