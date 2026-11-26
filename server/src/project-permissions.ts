import fs from "node:fs";
import path from "node:path";
import { isPermission, type PermissionLevel } from "./permissions.js";

export function loadProjectPermissions(dataDir: string): Record<string, PermissionLevel> {
  const file = path.join(dataDir, "project-permissions.json");
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const saved: Record<string, PermissionLevel> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isPermission(value)) saved[key] = value;
    }
    return saved;
  } catch {
    return {};
  }
}

export function saveProjectPermissions(dataDir: string, saved: Record<string, PermissionLevel>): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "project-permissions.json");
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(saved, null, 2)}\n`);
  try {
    fs.chmodSync(temp, 0o600);
  } catch {
    // Windows 上 chmod 可能无效，文件仍然只放在 dataDir。
  }
  fs.renameSync(temp, file);
}

export function resolvePermission(
  projectId: string,
  fallback: PermissionLevel,
  saved: Record<string, PermissionLevel>,
): PermissionLevel {
  return saved[projectId] ?? fallback;
}
