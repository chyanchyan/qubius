/* 顶栏访问模式图标旁的「其他已启用入口」标记数据。
 *
 * 顶栏主图标表示这次页面是从哪个入口打开的，这里补充实例另外还开放了哪些
 * 入口：本机入口始终可用，不需要上报；局域网入口看部署 env，公网入口看
 * edge 是否已配置可用。旧版页面不请求这个字段也不会出问题。
 */
import type { AppConfig } from "./config.js";
import { deriveDeployForm } from "./deploy.js";
import { getEdgeView, type EdgeActionDeps } from "./edge/actions.js";

export interface AccessEntries {
  /** 局域网入口（lan-proxy）是否启用。 */
  lan: boolean;
  /** 公网入口（edge）是否已配置可用。 */
  public: boolean;
}

/** 读取当前实例已启用的对外入口；任何一项解析失败都按未启用处理。 */
export function readAccessEntries(options: {
  config: AppConfig;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  /** 公网入口依赖注入（测试用）；生产环境留空。 */
  edge?: Partial<EdgeActionDeps>;
}): AccessEntries {
  const env = options.env ?? process.env;
  let lan = false;
  try {
    lan = deriveDeployForm(env, options.config.role, options.repoRoot).form.lanEnabled;
  } catch {
    // env 文件损坏时部署页本身仍能打开，这里也不要让 /api/instance 失败。
  }
  let isPublic = false;
  try {
    isPublic = getEdgeView({
      repoRoot: options.repoRoot,
      role: options.config.role,
      env,
      ...options.edge,
    }).enabled;
  } catch {
    // 公网入口不可用时只是少一个标记，不影响顶栏其它信息。
  }
  return { lan, public: isPublic };
}
