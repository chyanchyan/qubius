import fs from "node:fs";
import path from "node:path";

/**
 * 部署 env 文件的单一来源解析。
 *
 * 与 deploy/lib.sh 的 qubius_env_file 保持一致，优先级从高到低：
 *   1. QUBIUS_ENV（显式指定的文件，即使不存在也优先）
 *   2. <configDir>/env（存在时）
 *   3. <repoRoot>/deploy/env（存在时；仅在调用方提供了 repoRoot 时检查）
 *   4. <configDir>/env（兜底路径，通常不存在）
 *
 * 存在性判断用 statSync().isFile()，与 shell 的 `[[ -f ... ]]` 对齐：
 * 目录、设备等非普通文件不会被当作 env 文件。
 *
 * QUBIUS_ENV 的相对路径按 repoRoot 解析；没有 repoRoot 时退化为
 * path.resolve()（相对当前进程工作目录），与 shell 侧 `cd` 后的行为一致。
 *
 * 空值判断刻意不做 trim：shell 的 `[[ -n ${QUBIUS_ENV:-} ]]` 认为纯空白也
 * 是非空值，会拿它当路径使用（随后因文件不存在而报错）。保持同样取舍，
 * 避免服务端悄悄回落到另一份 env，导致页面与 shell 读写不同文件。
 */
export type DeployEnvSource = "QUBIUS_ENV" | "config-dir" | "repo" | "default";

export interface DeployEnvResolution {
  /** 实际读写的 env 文件路径。 */
  file: string;
  /** 该路径来自哪条优先级规则。 */
  source: DeployEnvSource;
  /** 文件当前是否存在且为普通文件。 */
  exists: boolean;
}

/** 与 shell `-f` 对齐：只有普通文件才算存在。 */
function isEnvFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function resolveDeployEnvFile(
  env: NodeJS.ProcessEnv,
  configDir: string,
  repoRoot?: string,
): DeployEnvResolution {
  const configured = env.QUBIUS_ENV;
  if (configured !== undefined && configured !== "") {
    // 绝对路径原样使用；相对路径优先相对仓库根目录，缺省时相对进程 cwd。
    const file = path.isAbsolute(configured)
      ? path.resolve(configured)
      : repoRoot
        ? path.resolve(repoRoot, configured)
        : path.resolve(configured);
    return { file, source: "QUBIUS_ENV", exists: isEnvFile(file) };
  }

  const configFile = path.join(configDir, "env");
  if (isEnvFile(configFile)) {
    return { file: configFile, source: "config-dir", exists: true };
  }

  if (repoRoot) {
    const repoFile = path.join(repoRoot, "deploy", "env");
    if (isEnvFile(repoFile)) {
      return { file: repoFile, source: "repo", exists: true };
    }
  }

  return { file: configFile, source: "default", exists: false };
}
