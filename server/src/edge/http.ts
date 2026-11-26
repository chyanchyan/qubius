import type { IncomingMessage, ServerResponse } from "node:http";

import {
  EdgeActionError,
  applyEdge,
  getEdgeView,
  planEdge,
  readEdgeJobForApi,
  reclaimEdge,
  redactApiText,
  restoreEdge,
  type EdgeActionDeps,
} from "./actions.js";

/**
 * /api/edge 路由。由顶层 http.ts 在解析 URL 后调用；返回 false 表示不是
 * edge 路由，交给后续处理（最终 /api 404）。
 *
 * 这里直接写响应（包括 4xx 的 code/kind/remainingPids），避免把 EdgeActionError
 * 的附加字段塞进顶层 HttpError。
 */

const MAX_BODY = 1_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new EdgeActionError(413, "请求过大");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new EdgeActionError(400, "请求不是 JSON");
  }
}

function errorBody(error: EdgeActionError, deps: EdgeActionDeps): Record<string, unknown> {
  return {
    error: redactApiText(deps, error.message),
    ...(error.extras.code ? { code: error.extras.code } : {}),
    ...(error.extras.kind ? { kind: error.extras.kind } : {}),
    ...(error.extras.remainingPids
      ? { remainingPids: error.extras.remainingPids }
      : {}),
    ...(error.extras.jobId ? { jobId: error.extras.jobId } : {}),
  };
}

/**
 * 处理 /api/edge 请求；命中返回 true。
 */
export async function handleEdgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  deps: EdgeActionDeps,
): Promise<boolean> {
  const pathname = url.pathname;
  try {
    if (pathname === "/api/edge" && method === "GET") {
      sendJson(res, 200, getEdgeView(deps));
      return true;
    }
    if (pathname === "/api/edge/plan" && method === "POST") {
      // 空 body 返回 {}；非法 JSON/超大 body 照常返回 400/413。
      await readJson(req);
      sendJson(res, 200, await planEdge(deps));
      return true;
    }
    if (pathname === "/api/edge/apply" && method === "POST") {
      const body = await readJson(req);
      sendJson(res, 202, await applyEdge(deps, body));
      return true;
    }
    if (pathname === "/api/edge/status" && method === "GET") {
      sendJson(res, 200, { job: readEdgeJobForApi(deps) });
      return true;
    }
    if (pathname === "/api/edge/restore" && method === "POST") {
      const body = await readJson(req);
      sendJson(res, 202, await restoreEdge(deps, body));
      return true;
    }
    if (pathname === "/api/edge/reclaim" && method === "POST") {
      const body = await readJson(req);
      sendJson(res, 202, reclaimEdge(deps, body));
      return true;
    }
    return false;
  } catch (error) {
    if (error instanceof EdgeActionError) {
      sendJson(res, error.status, errorBody(error, deps));
      return true;
    }
    throw error;
  }
}
