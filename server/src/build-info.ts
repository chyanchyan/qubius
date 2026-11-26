import fs from "node:fs";

/** deploy/build.sh（或 Windows 部署任务）写在 server/dist/build.json 里的构建信息。 */
export interface BuildInfo {
  /** 构建时的提交完整 sha。 */
  head?: string;
  /** 构建时仓库根 package.json 的版本号。 */
  version?: string;
  /** 构建时间（ISO 8601）。 */
  builtAt?: string;
  /** 构建时工作区有未提交改动；下次启动会重新构建。 */
  dirty?: boolean;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 读取 build.json；文件缺失、损坏或字段类型不对时忽略对应字段。 */
export function readBuildInfo(file: string): BuildInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const info: BuildInfo = {};
  const head = readString(record.head);
  const version = readString(record.version);
  const builtAt = readString(record.builtAt);
  if (head) info.head = head;
  if (version) info.version = version;
  if (builtAt) info.builtAt = builtAt;
  if (typeof record.dirty === "boolean") info.dirty = record.dirty;
  return info;
}

/** package.json 里的版本号；只接受 semver 常用字符。 */
export function readPackageVersion(file: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const version = readString((parsed as Record<string, unknown>).version);
    return version && /^[0-9A-Za-z.+-]+$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 运行中构建的信息。构建时写下的 version 优先；开发环境（tsx 直接跑 src，
 * 没有 build.json）退回当前 checkout 的 package.json，页面仍能显示版本号。
 */
export function resolveBuildInfo(buildFile: string, packageFile: string): BuildInfo {
  const info = readBuildInfo(buildFile);
  if (info.version) return info;
  const version = readPackageVersion(packageFile);
  return version ? { ...info, version } : info;
}
