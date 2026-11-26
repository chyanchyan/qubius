import path from "node:path";
import { fileURLToPath } from "node:url";

import { deployConfigDir } from "./deploy.js";
import { runEdgeJob, type EdgeActionDeps } from "./edge/actions.js";
import { readEdgeRequest, verifyRequestOwnership } from "./edge/job-runner.js";

/**
 * detached edge 作业入口（编译后为 server/dist/edge-job.js）。
 *
 * `deploy/edge-job.sh` 已经持有 `<configDir>/ops.lock` 的 flock 并写好
 * running meta；这里只读取 server 原子写入的 `edge-request.json`，执行
 * apply/restore，把状态写进 edge.json，并以退出码告知脚本成功/失败。
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export function edgeRepoRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.QUBIUS_EDGE_REPO_ROOT ?? env.QUBIUS_DEPLOY_REPO_ROOT ?? "").trim();
  if (configured) return path.resolve(configured);
  // server/dist/edge-job.js → 仓库根目录。
  return path.resolve(here, "../..");
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const configDir = (env.QUBIUS_EDGE_CONFIG_DIR ?? "").trim()
    ? path.resolve(env.QUBIUS_EDGE_CONFIG_DIR as string)
    : deployConfigDir(env);
  const request = readEdgeRequest(configDir);
  if (!request) {
    console.error("edge-job：找不到或无法解析 edge-request.json");
    return 2;
  }
  const ownership = verifyRequestOwnership(request, env);
  if (!ownership.ok) {
    console.error(`edge-job：${ownership.message}`);
    return 2;
  }
  const deps: EdgeActionDeps = {
    repoRoot: edgeRepoRoot(env),
    env,
  };
  const job = await runEdgeJob(configDir, request, deps);
  return job.state === "success" ? 0 : 1;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("edge-job 异常退出：", error);
      process.exit(1);
    });
}
