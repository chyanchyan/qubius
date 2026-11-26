import { request } from "./api";

/** 一个 CI 检查项；status/conclusion 由服务端归一化为小写。 */
export interface PullRequestCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
}

/** GET/POST /api/sessions/<id>/pull-request 的响应。 */
export interface PullRequestStatus {
  supported: boolean;
  /** 支持的平台标识（github/gitlab）；不支持的远端放域名。 */
  host: string | null;
  exists: boolean;
  url?: string;
  number?: number;
  state?: string;
  title?: string;
  mergeable?: string;
  checks: PullRequestCheck[];
  /** CLI 缺失/未登录、推送失败等可预期问题；不是 HTTP 错误。 */
  error?: string;
  /** 只在创建成功后出现。 */
  created?: boolean;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  /** 目标分支；留空交给托管平台用默认分支。 */
  base?: string;
}

// 服务端 GET 需要 remote 10s + view 20s，客户端留出余量。
const GET_TIMEOUT_MS = 45_000;
// 服务端 POST 需要 remote 10s + push 120s + create 120s + view 20s。
const CREATE_TIMEOUT_MS = 300_000;

export function getPullRequest(sessionId: string, signal?: AbortSignal): Promise<PullRequestStatus> {
  return request(
    `/api/sessions/${sessionId}/pull-request`,
    undefined,
    signal,
    GET_TIMEOUT_MS,
  );
}

export function createPullRequest(
  sessionId: string,
  input: CreatePullRequestInput,
  signal?: AbortSignal,
): Promise<PullRequestStatus> {
  return request(
    `/api/sessions/${sessionId}/pull-request`,
    { method: "POST", body: JSON.stringify(input) },
    signal,
    CREATE_TIMEOUT_MS,
  );
}

/**
 * 一个异步响应是否还能写回面板。
 *
 * 为 true 需要同时满足：组件仍挂载、仍属于发起请求的会话、且请求令牌仍是
 * 最新值。创建请求开始时推进会令牌，因此创建前发起的旧 GET 即使更晚返回
 * 也不能覆盖创建结果。
 */
export interface ResponseGuard {
  mounted: boolean;
  sessionMatches: boolean;
  /** 发起这次请求时捕获的令牌。 */
  requestToken: number;
  /** 此刻最新的令牌。 */
  currentToken: number;
}

export function canApplyResponse(guard: ResponseGuard): boolean {
  return guard.mounted && guard.sessionMatches && guard.requestToken === guard.currentToken;
}

/**
 * 面板 loading / refreshing 标志和请求令牌的纯状态。
 *
 * 令牌决定“谁能写回数据”，标志所有者决定“谁能清理加载态”。两者分开：
 * 创建推进令牌会让旧 GET 的数据作废，但旧 GET 仍要负责清理自己点亮的
 * “刷新中”，否则刷新按钮会永久卡住。
 */
export interface AsyncFlagState {
  /** 最新操作令牌；旧响应的令牌不等时不能写回状态数据。 */
  seq: number;
  /** 置位 refreshing 的请求令牌；0 表示当前没有刷新在进行。 */
  refreshingOwner: number;
  /** 置位 loading 的请求令牌；0 表示当前没有首次加载在进行。 */
  loadingOwner: number;
}

export function initialAsyncFlags(): AsyncFlagState {
  return { seq: 0, refreshingOwner: 0, loadingOwner: 0 };
}

export interface BeginLoadResult {
  state: AsyncFlagState;
  token: number;
  ownsRefreshing: boolean;
  ownsLoading: boolean;
}

/** 开始一次 GET：已有状态时显示“刷新中”，否则显示首次加载。 */
export function beginLoad(state: AsyncFlagState, hasStatus: boolean): BeginLoadResult {
  const token = state.seq + 1;
  return {
    state: {
      seq: token,
      refreshingOwner: hasStatus ? token : state.refreshingOwner,
      loadingOwner: hasStatus ? state.loadingOwner : token,
    },
    token,
    ownsRefreshing: hasStatus,
    ownsLoading: !hasStatus,
  };
}

/**
 * GET 返回（成功、失败或令牌已失效）时的清理：只释放本次请求置位的标志。
 * 刷新已被新请求接管时保留新所有者，旧响应不会误清“刷新中”。
 */
export function finishLoad(
  state: AsyncFlagState,
  token: number,
  ownsRefreshing: boolean,
  ownsLoading: boolean,
): AsyncFlagState {
  return {
    seq: state.seq,
    refreshingOwner: ownsRefreshing && state.refreshingOwner === token ? 0 : state.refreshingOwner,
    loadingOwner: ownsLoading && state.loadingOwner === token ? 0 : state.loadingOwner,
  };
}

export interface BeginCreateResult {
  state: AsyncFlagState;
  token: number;
}

/** 开始创建：推进令牌作废旧 GET，并清掉旧请求占着的刷新/加载标志。 */
export function beginCreate(state: AsyncFlagState): BeginCreateResult {
  const token = state.seq + 1;
  return {
    state: { seq: token, refreshingOwner: 0, loadingOwner: 0 },
    token,
  };
}

/** 创建落定：再推进一次令牌，并确保没有遗留的刷新/加载标志。 */
export function finishCreate(state: AsyncFlagState): AsyncFlagState {
  return { seq: state.seq + 1, refreshingOwner: 0, loadingOwner: 0 };
}

/**
 * 切换会话：令牌保持单调递增（不能归零），只清空加载态所有者。
 *
 * 归零会让旧会话的响应与新会话重新开始编号的令牌碰撞（S → T → S 时
 * 旧 S 的 token 1 可能与新 S 的 token 1 相同），被 canApplyResponse 放行，
 * 并误清新请求的 loading/refreshing。
 */
export function resetSessionFlags(state: AsyncFlagState): AsyncFlagState {
  return { seq: state.seq + 1, refreshingOwner: 0, loadingOwner: 0 };
}
