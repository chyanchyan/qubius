/**
 * 读取环境变量时优先新的 QUBIUS_*，回退旧的 REMOTE_CODER_* 兼容旧部署脚本。
 * QUBIUS_* 未设置或为空串时回退；显式设为非空值（包括 "0"）则以新变量为准。
 */
export function envCompat(name: string, legacyName?: string): string | undefined {
  const legacy = legacyName
    ?? (name.startsWith("QUBIUS_") ? `REMOTE_CODER_${name.slice("QUBIUS_".length)}` : undefined);
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  return legacy ? process.env[legacy] : undefined;
}

/** 布尔开关：值为 "1" 时开启，QUBIUS_* 优先。 */
export function envFlag(name: string): boolean {
  return envCompat(name) === "1";
}
