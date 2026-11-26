import assert from "node:assert/strict";
import test from "node:test";
import {
  beginCreate,
  beginLoad,
  canApplyResponse,
  finishCreate,
  finishLoad,
  initialAsyncFlags,
  resetSessionFlags,
} from "./api-pull-request";

/**
 * 响应守卫的时序测试：GET 和创建共用同一个令牌，创建开始时推进会令牌，
 * 创建结束后再推进一次，避免创建前的旧 GET 在创建完成后覆盖 exists:true。
 */

test("创建开始后，创建前发起的 GET 响应被丢弃", () => {
  // GET 用令牌 1 发起；submit 开始时把最新令牌推进到 2。
  assert.equal(
    canApplyResponse({
      mounted: true,
      sessionMatches: true,
      requestToken: 1,
      currentToken: 2,
    }),
    false,
  );
});

test("令牌仍是最新、会话一致且已挂载时，创建结果可以应用", () => {
  assert.equal(
    canApplyResponse({
      mounted: true,
      sessionMatches: true,
      requestToken: 2,
      currentToken: 2,
    }),
    true,
  );
});

test("创建结束后令牌再推进一次，期间夹着的旧响应全部失效", () => {
  // submit 成功时令牌 2 -> 3；此前发起的 GET 令牌 1/2 都不能再写回。
  for (const requestToken of [1, 2]) {
    assert.equal(
      canApplyResponse({
        mounted: true,
        sessionMatches: true,
        requestToken,
        currentToken: 3,
      }),
      false,
    );
  }
});

test("切换会话或组件已卸载时丢弃响应", () => {
  assert.equal(
    canApplyResponse({
      mounted: true,
      sessionMatches: false,
      requestToken: 4,
      currentToken: 4,
    }),
    false,
  );
  assert.equal(
    canApplyResponse({
      mounted: false,
      sessionMatches: true,
      requestToken: 4,
      currentToken: 4,
    }),
    false,
  );
});

test("刷新在途时提交创建，旧响应返回后 refreshing 被复位", () => {
  // 已有状态，用户点刷新：load 点亮 refreshing。
  const refresh = beginLoad(initialAsyncFlags(), true);
  let state = refresh.state;
  assert.equal(state.refreshingOwner, refresh.token);

  // GET 返回前提交创建：创建推进令牌并接管加载态。
  const create = beginCreate(state);
  state = create.state;
  assert.equal(state.seq, refresh.token + 1);
  assert.equal(state.refreshingOwner, 0);
  assert.equal(state.loadingOwner, 0);

  // 旧 GET 现在才返回：数据不能写回，但也不能留下“刷新中”。
  state = finishLoad(state, refresh.token, refresh.ownsRefreshing, refresh.ownsLoading);
  assert.equal(state.refreshingOwner, 0);
  assert.equal(state.loadingOwner, 0);
  // 组件由 owner 派生按钮状态：false 表示恢复可点。
  assert.equal(state.refreshingOwner !== 0, false);

  // 创建结束后再推进一次令牌，仍没有任何遗留标志。
  state = finishCreate(state);
  assert.equal(state.refreshingOwner, 0);
  assert.equal(state.loadingOwner, 0);
});

test("旧响应不会误清新请求的 refreshing", () => {
  const first = beginLoad(initialAsyncFlags(), true);
  let state = first.state;
  // 第二个刷新在旧响应返回前开始，接管 refreshing。
  const second = beginLoad(state, true);
  state = second.state;
  assert.equal(state.refreshingOwner, second.token);

  // 旧请求先返回：只释放自己拥有的标志，新请求的 refreshing 保留。
  state = finishLoad(state, first.token, first.ownsRefreshing, first.ownsLoading);
  assert.equal(state.refreshingOwner, second.token);
  assert.equal(state.refreshingOwner !== 0, true);

  // 新请求返回后才复位。
  state = finishLoad(state, second.token, second.ownsRefreshing, second.ownsLoading);
  assert.equal(state.refreshingOwner, 0);
});

test("首次加载被创建作废后 loading 也会复位", () => {
  const load = beginLoad(initialAsyncFlags(), false);
  let state = load.state;
  assert.equal(state.loadingOwner, load.token);

  const create = beginCreate(state);
  state = finishLoad(create.state, load.token, load.ownsRefreshing, load.ownsLoading);
  assert.equal(state.loadingOwner, 0);
});

test("S → T → S 后旧 S 响应被丢弃，且不会清除新 S 的 loading", () => {
  // 访问 S：初始加载令牌 1。
  const oldS = beginLoad(initialAsyncFlags(), false);
  let state = oldS.state;
  assert.equal(state.loadingOwner, oldS.token);

  // 切到 T：令牌递增，不能归零。
  state = resetSessionFlags(state);
  const tLoad = beginLoad(state, false);
  state = tLoad.state;
  assert.ok(tLoad.token > oldS.token);

  // 再切回 S：令牌继续递增。
  state = resetSessionFlags(state);
  const newS = beginLoad(state, false);
  state = newS.state;
  assert.ok(newS.token > tLoad.token);
  assert.equal(state.loadingOwner, newS.token);

  // 旧 S 的响应此时才返回：会话名又是 S（sessionMatches 为 true），但令牌
  // 已经不同，数据必须丢弃；finishLoad 也不能清掉新 S 的 loading。
  assert.equal(
    canApplyResponse({
      mounted: true,
      sessionMatches: true,
      requestToken: oldS.token,
      currentToken: state.seq,
    }),
    false,
  );
  state = finishLoad(state, oldS.token, oldS.ownsRefreshing, oldS.ownsLoading);
  assert.equal(state.loadingOwner, newS.token);
  assert.equal(state.loadingOwner !== 0, true);

  // 新 S 的响应返回后才复位。
  state = finishLoad(state, newS.token, newS.ownsRefreshing, newS.ownsLoading);
  assert.equal(state.loadingOwner, 0);
});

test("loading 被新请求接管后，旧响应不会误清", () => {
  const first = beginLoad(initialAsyncFlags(), false);
  let state = first.state;
  const second = beginLoad(state, false);
  state = second.state;
  assert.equal(state.loadingOwner, second.token);

  state = finishLoad(state, first.token, first.ownsRefreshing, first.ownsLoading);
  assert.equal(state.loadingOwner, second.token);

  state = finishLoad(state, second.token, second.ownsRefreshing, second.ownsLoading);
  assert.equal(state.loadingOwner, 0);
});
