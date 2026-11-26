import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import { handleDiffCommentRoutes } from "./diff-comments.js";
import { handleMultiModelGroupRoutes } from "./multi-model-groups.js";
import { handlePullRequestRoutes } from "./pull-request.js";
import type { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import type { Store } from "./store.js";

/**
 * 放在 http.ts 之外的独立功能路由。
 *
 * http.ts 已经很大，新增的 diff 评论、PR/MR 和多模型对比分组接口各自放在模块
 * 里；这里只做一次很薄的分发。模块返回 null 表示没匹配到自己的路径，交给后面的静态资源
 * 或 404 处理。模块直接返回状态码和 JSON，不依赖 http.ts 内部的 HttpError，
 * 避免循环引用。
 */
export interface FeatureContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  config: AppConfig;
  store: Store;
  runtime: Runtime;
  settings: { current: StoredSettings };
  readJson: (req: IncomingMessage) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

export interface FeatureResult {
  status: number;
  body: unknown;
}

export type FeatureHandler = (ctx: FeatureContext) => Promise<FeatureResult | null>;

const HANDLERS: FeatureHandler[] = [
  handleDiffCommentRoutes,
  handlePullRequestRoutes,
  handleMultiModelGroupRoutes,
];

export async function handleFeatureRoutes(ctx: FeatureContext): Promise<FeatureResult | null> {
  for (const handler of HANDLERS) {
    const result = await handler(ctx);
    if (result) return result;
  }
  return null;
}
