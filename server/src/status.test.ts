import assert from "node:assert/strict";
import test from "node:test";
import {
  appendUserMessage,
  applySdkMessage,
  capMessageText,
  configureLimits,
  currentLimits,
  derivePhase,
  detectWorkflowSkill,
  limitTranscript,
  mainAgentRunning,
  MAX_MESSAGE_TEXT,
  MAX_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_MESSAGES,
} from "./status.js";
import { ROOT_FORK_POINT } from "./session-rewind.js";
import type { SessionCore, TranscriptItem } from "./types.js";

function blank(): SessionCore {
  return {
    id: "s1",
    projectId: "sample",
    projectPath: "/tmp/project",
    title: "标题",
    providerId: "p1",
    providerName: "官方",
    model: "sonnet",
    effort: "high",
    cwd: "/tmp/work",
    git: true,
    summary: "",
    phase: "queued",
    turnActive: true,
    queued: false,
    subagents: [],
    messages: [],
    pending: null,
    seen: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("子 agent 完成后主结果成功，对话记为本轮完成", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "u1",
    task_id: "t1",
    task_type: "local_agent",
    description: "阅读入口",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_progress",
    uuid: "u2",
    task_id: "t1",
    description: "阅读入口",
    summary: "正在看 main",
    last_tool_name: "Read",
    usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
  } as never);
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "u3",
    message: { role: "assistant", content: [{ type: "text", text: "先看结构。" }] },
    parent_tool_use_id: null,
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    uuid: "u4",
    task_id: "t1",
    status: "completed",
    summary: "看完了",
  });
  state = applySdkMessage(state, {
    type: "result",
    subtype: "success",
    uuid: "u5",
    result: "已完成。",
    is_error: false,
  });
  assert.equal(state.phase, "completed");
  assert.equal(state.subagents[0]?.status, "completed");
  assert.equal(state.subagents[0]?.summary, "看完了");
  assert.equal(state.summary, "已完成。");
  assert.equal(state.messages.some((item) => item.role === "assistant" && item.text === "先看结构。"), true);
});

test("result 之后 SDK 仍在跑时不算完成，收到 idle 才落定", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "session_state_changed",
    uuid: "state-1",
    state: "running",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "t1",
    task_id: "a1",
    task_type: "local_agent",
    description: "后台子任务",
  });
  state = applySdkMessage(state, {
    type: "result",
    subtype: "success",
    uuid: "r1",
    result: "等子任务",
    is_error: false,
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    uuid: "t2",
    task_id: "a1",
    status: "completed",
    summary: "子任务完成",
  });
  // 最后一个子任务已经落定、主轮 result 也到了，但 SDK 还在跑（继续做集成验证）：
  // 不能只凭“没有子 agent 在跑”就判成完成。
  assert.equal(state.phase, "running");

  state = applySdkMessage(state, {
    type: "system",
    subtype: "session_state_changed",
    uuid: "state-2",
    state: "idle",
  });
  assert.equal(state.phase, "completed");
});

test("requires_action 视为仍在推进，不会被上一轮 result 判成完成", () => {
  const state = blank();
  state.turnActive = false;
  state.lastResult = "success";
  state.agentState = "requires_action";
  assert.equal(derivePhase(state), "running");
});

test("mainAgentRunning 只看主 agent，等待确认和纯后台子 agent 不算", () => {
  const base = { phase: "running" as const, turnActive: false, agentState: undefined };
  assert.equal(mainAgentRunning({ ...base, turnActive: true }), true);
  assert.equal(mainAgentRunning({ ...base, agentState: "running" }), true);
  assert.equal(mainAgentRunning({ ...base, agentState: "requires_action" }), true);
  assert.equal(mainAgentRunning(base), false);
  assert.equal(mainAgentRunning({ ...base, agentState: "idle" }), false);
  // 等待确认：SDK 可能仍是 running，但主 agent 在等人，不算运行。
  assert.equal(mainAgentRunning({ phase: "needs_input", turnActive: true }), false);
  assert.equal(mainAgentRunning({ phase: "queued", turnActive: false, agentState: "running" }), false);
});

test("idle 兜底清掉 turnActive：没有 result 也不会一直停在运行中", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "session_state_changed",
    uuid: "state-1",
    state: "running",
  });
  assert.equal(state.turnActive, true);
  assert.equal(state.phase, "running");

  state = applySdkMessage(state, {
    type: "system",
    subtype: "session_state_changed",
    uuid: "state-2",
    state: "idle",
  });
  assert.equal(state.turnActive, false);
  assert.equal(state.agentState, "idle");
  assert.notEqual(state.phase, "running");
});

test("未知的 session_state_changed 值被忽略，不改变已有状态", () => {
  let state = blank();
  state.turnActive = false;
  state.agentState = "idle";
  state = applySdkMessage(state, {
    type: "system",
    subtype: "session_state_changed",
    uuid: "state-x",
    state: "weird",
  });
  assert.equal(state.agentState, "idle");
});

test("子 agent 记录开始/结束时间，续跑保留首次开始时间", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    task_id: "t1",
    task_type: "local_agent",
    description: "阅读入口",
    timestamp: "2026-01-01T00:00:05.000Z",
  });
  assert.equal(state.subagents[0]?.startedAt, "2026-01-01T00:00:05.000Z");
  assert.equal(state.subagents[0]?.endedAt, undefined);

  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    task_id: "t1",
    status: "completed",
    summary: "看完了",
    timestamp: "2026-01-01T00:00:35.000Z",
  });
  assert.equal(state.subagents[0]?.endedAt, "2026-01-01T00:00:35.000Z");

  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    task_id: "t1",
    run_id: "run-2",
    task_type: "local_agent",
    description: "阅读入口",
    timestamp: "2026-01-01T00:01:00.000Z",
  });
  assert.equal(state.subagents[0]?.startedAt, "2026-01-01T00:00:05.000Z");
  assert.equal(state.subagents[0]?.endedAt, undefined);
  assert.equal(state.subagents[0]?.runs, 2);
});

test("task_progress 和续跑不会覆盖带工作流标签的 description", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    task_id: "t1",
    task_type: "local_agent",
    description: "[wf:prl:1/2:dev] 登录接口",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_progress",
    task_id: "t1",
    description: "Verifying tsc",
  });
  assert.equal(state.subagents[0]?.description, "[wf:prl:1/2:dev] 登录接口");

  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    task_id: "t1",
    run_id: "run-2",
    task_type: "local_agent",
    description: "继续修复",
  });
  assert.equal(state.subagents[0]?.description, "[wf:prl:1/2:dev] 登录接口");
  assert.equal(state.subagents[0]?.runs, 2);

  // 没有标签的子任务，description 仍然跟随最新活动。
  let plain = blank();
  plain = applySdkMessage(plain, {
    type: "system",
    subtype: "task_started",
    task_id: "t2",
    task_type: "local_agent",
    description: "阅读入口",
  });
  plain = applySdkMessage(plain, {
    type: "system",
    subtype: "task_progress",
    task_id: "t2",
    description: "正在看 main",
  });
  assert.equal(plain.subagents[0]?.description, "正在看 main");

  // 旧子任务后来带上标签时允许补上，方便恢复归组。
  let recover = blank();
  recover = applySdkMessage(recover, {
    type: "system",
    subtype: "task_started",
    task_id: "t3",
    task_type: "local_agent",
    description: "阅读入口",
  });
  recover = applySdkMessage(recover, {
    type: "system",
    subtype: "task_started",
    task_id: "t3",
    run_id: "run-2",
    task_type: "local_agent",
    description: "[wf:prl:1/1:dev] 登录接口",
  });
  assert.equal(recover.subagents[0]?.description, "[wf:prl:1/1:dev] 登录接口");
});

test("忽略 ambient 和 bash 任务", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "a",
    task_id: "amb",
    task_type: "local_agent",
    ambient: true,
    description: "内部",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "b",
    task_id: "bash",
    task_type: "local_bash",
    description: "跑测试",
  });
  assert.equal(state.subagents.length, 0);
});

test("子 agent 仍在跑时，即使主结果已返回也保持进行中", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "a",
    task_id: "t1",
    task_type: "local_agent",
    description: "改接口",
  });
  state = applySdkMessage(state, {
    type: "result",
    subtype: "success",
    uuid: "b",
    result: "已派出。",
  });
  assert.equal(state.turnActive, false);
  assert.equal(state.phase, "running");
});

test("子 agent 失败且主回合结束后，对话记为失败", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "a",
    task_id: "t1",
    task_type: "local_agent",
    description: "改接口",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    uuid: "b",
    task_id: "t1",
    status: "failed",
    summary: "编译失败",
  });
  state = applySdkMessage(state, {
    type: "result",
    subtype: "success",
    uuid: "c",
    result: "子任务失败了。",
  });
  assert.equal(state.phase, "failed");
});

test("主结果错误时对话失败", () => {
  const state = applySdkMessage(blank(), {
    type: "result",
    subtype: "error_during_execution",
    uuid: "e",
    errors: ["连接中断"],
  });
  assert.equal(state.phase, "failed");
  assert.equal(state.lastError, "连接中断");
});

test("用户主动停止且无活动时记为已停止", () => {
  const state = blank();
  state.turnActive = false;
  state.lastResult = "stopped";
  assert.equal(derivePhase(state), "stopped");
});

test("存在失败子 agent 时停止仍记为失败（真实错误优先）", () => {
  const state = blank();
  state.turnActive = false;
  state.lastResult = "stopped";
  state.subagents = [{ taskId: "t1", description: "子任务", status: "failed" }];
  assert.equal(derivePhase(state), "failed");
});

test("普通错误结果仍记为失败（回归）", () => {
  const state = blank();
  state.turnActive = false;
  state.lastResult = "error";
  assert.equal(derivePhase(state), "failed");
});

test("同一 task 的新 run 重新变为进行中，旧 run 的进度被忽略", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "1",
    task_id: "t1",
    run_id: "run-b",
    task_type: "local_agent",
    description: "第一轮",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    uuid: "2",
    task_id: "t1",
    run_id: "run-b",
    status: "completed",
    summary: "第一轮完成",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_progress",
    uuid: "3",
    task_id: "t1",
    run_id: "run-a",
    summary: "过期进度",
  });
  assert.equal(state.subagents[0]?.summary, "第一轮完成");
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "4",
    task_id: "t1",
    run_id: "run-c",
    task_type: "local_agent",
    description: "第二轮",
  });
  assert.equal(state.subagents.length, 1);
  assert.equal(state.subagents[0]?.status, "running");
  assert.equal(state.subagents[0]?.description, "第二轮");
  assert.equal(state.phase, "running");
});

test("等待确认优先于进行中", () => {
  const state = blank();
  state.pending = {
    requestId: "r1",
    kind: "permission",
    toolName: "Bash",
    inputPreview: "rm -rf /",
    inputText: "rm -rf /",
    inputTruncated: false,
    requiresExpand: false,
  };
  state.turnActive = true;
  assert.equal(derivePhase(state), "needs_input");
});

test("重复 uuid 的事件只处理一次", () => {
  let state = blank();
  const message = {
    type: "assistant" as const,
    uuid: "same",
    message: { content: [{ type: "text", text: "只出现一次" }] },
    parent_tool_use_id: null,
  };
  state = applySdkMessage(state, message);
  state = applySdkMessage(state, message);
  assert.equal(state.messages.length, 1);
});

test("子 agent 自己的回复不写进主对话", () => {
  const state = applySdkMessage(blank(), {
    type: "assistant",
    uuid: "sub",
    agent_id: "t1",
    parent_tool_use_id: "tool-1",
    message: { content: [{ type: "text", text: "内部细节" }] },
  });
  assert.equal(state.messages.length, 0);
});

test("接口 401 立刻写到错误上，回合仍算进行中", () => {
  const state = applySdkMessage(blank(), {
    type: "system",
    subtype: "api_error",
    uuid: "err1",
    error: {
      status: 401,
      message: '401 {"error":{"message":"Authentication Fails, Your api key: ****4188 is invalid","type":"authentication_error"}}',
    },
  });
  assert.equal(state.phase, "running");
  assert.equal(state.lastError, "Authentication Fails, Your api key: ****4188 is invalid");
});

test("文本增量累加，完整回复到达后替换掉未完成的片段", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "d1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "你" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "d2",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "好" } },
  });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.text, "你好");
  assert.equal(state.messages[0]?.partial, true);
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "final",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "你好，我是 DeepSeek。" }] },
  });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.text, "你好，我是 DeepSeek。");
  assert.equal(state.messages[0]?.partial, undefined);
});

test("思考增量在完整消息到达后保留下来", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先看结构，" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t2",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "再动手。" } },
  });
  assert.equal(state.messages[0]?.kind, "thinking");
  assert.equal(state.messages[0]?.partial, true);
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "thinking", thinking: "先看结构，再动手。" },
        { type: "text", text: "开始修改。" },
      ],
    },
  });
  const thinking = state.messages.filter((item) => item.kind === "thinking");
  // 完整消息里的思考块复用流式片段，不重复、不残留“进行中”。
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0]?.text, "先看结构，再动手。");
  assert.equal(thinking[0]?.partial, undefined);
  assert.equal(state.messages.at(-1)?.text, "开始修改。");
});

test("按轮记录回答模型：流式片段、完整消息和 result 兜底都带上本轮模型", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "d1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "第一轮" } },
  }, undefined, "model-a");
  // 流式片段在产生时就带上本轮模型，回答开头能立刻显示。
  assert.equal(state.messages[0]?.partial, true);
  assert.equal(state.messages[0]?.model, "model-a");

  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "第一轮回答。" }] },
  }, undefined, "model-a");
  assert.equal(state.messages[0]?.model, "model-a");

  // 下一轮用新模型：只标记新一轮的条目，已有回答不回溯改写。
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a2",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "第二轮回答。" }] },
  }, undefined, "model-b");
  assert.deepEqual(state.messages.map((item) => item.model), ["model-a", "model-b"]);

  // result 正文兜底新增的 assistant 条目同样属于本轮。
  state = applySdkMessage(state, {
    type: "result",
    subtype: "success",
    uuid: "r1",
    result: "第三轮回答。",
    is_error: false,
  }, undefined, "model-c");
  assert.equal(state.messages.at(-1)?.text, "第三轮回答。");
  assert.equal(state.messages.at(-1)?.model, "model-c");
});

test("思考块结束时记录耗时，供简要档显示「思考了 N 秒」", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先想。" } },
  });
  assert.equal(state.messages[0]?.kind, "thinking");
  assert.equal(state.messages[0]?.durationMs, undefined);
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t2",
    parent_tool_use_id: null,
    event: { type: "content_block_stop" },
  });
  const item = state.messages[0];
  assert.equal(item?.partial, undefined);
  assert.equal(typeof item?.durationMs, "number");
  assert.ok((item?.durationMs ?? -1) >= 0);
});

test("完整消息没带 thinking 时保留已收到的思考", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先分析。" } },
  });
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "结论。" }] },
  });
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0]?.kind, "thinking");
  assert.equal(state.messages[0]?.text, "先分析。");
  assert.equal(state.messages[0]?.partial, undefined);
  assert.equal(state.messages[1]?.text, "结论。");
});

test("思考块结束后不再标记为进行中", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先想一下。" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t2",
    parent_tool_use_id: null,
    event: { type: "content_block_stop" },
  });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.kind, "thinking");
  assert.equal(state.messages[0]?.partial, undefined);
});

test("同一消息里的多个思考块分别复用各自的流式片段", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "第一段" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t2",
    parent_tool_use_id: null,
    event: { type: "content_block_stop" },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t3",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "第二段" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t4",
    parent_tool_use_id: null,
    event: { type: "content_block_stop" },
  });
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "thinking", thinking: "第一段" },
        { type: "thinking", thinking: "第二段" },
        { type: "text", text: "完成" },
      ],
    },
  });
  const thinking = state.messages.filter((item) => item.kind === "thinking");
  assert.deepEqual(thinking.map((item) => item.text), ["第一段", "第二段"]);
  // 多条思考不能共用同一个 id，否则前端列表会复用组件实例。
  assert.equal(new Set(state.messages.map((item) => item.id)).size, state.messages.length);
});

test("思考与工具块交错时按消息顺序记录且不重复", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先想 A" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t2",
    parent_tool_use_id: null,
    event: { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "Bash" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t3",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t4",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "再想 B" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t5",
    parent_tool_use_id: null,
    event: { type: "content_block_stop" },
  });
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "thinking", thinking: "先想 A" },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
        { type: "thinking", thinking: "再想 B" },
      ],
    },
  });
  assert.deepEqual(
    state.messages.map((item) => [item.kind ?? item.role, item.text]),
    [
      ["thinking", "先想 A"],
      ["tool", "{\"command\":\"ls\"}"],
      ["thinking", "再想 B"],
    ],
  );
  assert.equal(state.messages.filter((item) => item.role === "tool").length, 1);
  assert.equal(state.messages.some((item) => item.partial), false);
});

test("思考之后的并行工具调用不产生重复条目", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先看一下。" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t2",
    parent_tool_use_id: null,
    event: { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "Read" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t3",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"a\"}" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t4",
    parent_tool_use_id: null,
    event: { type: "content_block_stop" },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t5",
    parent_tool_use_id: null,
    event: { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_2", name: "Read" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t6",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"b\"}" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t7",
    parent_tool_use_id: null,
    event: { type: "content_block_stop" },
  });
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "thinking", thinking: "先看一下。" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a" } },
        { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "b" } },
      ],
    },
  });
  assert.deepEqual(
    state.messages.map((item) => [item.kind ?? item.role, item.toolUseId ?? item.text]),
    [
      ["thinking", "先看一下。"],
      ["tool", "toolu_1"],
      ["tool", "toolu_2"],
    ],
  );
  assert.equal(state.messages.some((item) => item.partial || item.streaming), false);
});

test("已落定的思考不会被后续消息合并", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先读文件。" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t2",
    parent_tool_use_id: null,
    event: { type: "content_block_stop" },
  });
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "thinking", thinking: "先读文件。" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
      ],
    },
  });
  // 第二条完整消息的思考以第一条为前缀，但没有对应的流式片段，不能覆盖旧记录。
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a2",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "thinking", thinking: "先读文件。然后修改。" },
        { type: "text", text: "好" },
      ],
    },
  });
  assert.deepEqual(
    state.messages.filter((item) => item.kind === "thinking").map((item) => item.text),
    ["先读文件。", "先读文件。然后修改。"],
  );
  assert.equal(state.messages.findIndex((item) => item.role === "tool"), 1);
});

test("思考中途插入排队消息时仍只落一条思考", () => {
  let state = blank();
  state.messages.push({ id: "u1", role: "user", text: "Q1" });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先想一下。" } },
  });
  // 模拟用户在思考过程中排队发送下一条消息（store.addUserMessage → appendUserMessage）。
  state = appendUserMessage(state, "Q2");
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t2",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "继续想。" } },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t3",
    parent_tool_use_id: null,
    event: { type: "content_block_stop" },
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t4",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "答案" } },
  });
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "thinking", thinking: "先想一下。继续想。" },
        { type: "text", text: "答案" },
      ],
    },
  });
  const thinking = state.messages.filter((item) => item.kind === "thinking");
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0]?.text, "先想一下。继续想。");
  assert.equal(thinking[0]?.partial, undefined);
  // 排队发送的消息不能被思考清理逻辑吞掉。
  assert.equal(state.messages.some((item) => item.text === "Q2"), true);
});

test("排队消息固定在记录末尾，本轮输出接在它前面", () => {
  let state = blank();
  state.messages.push({ id: "u1", role: "user", text: "Q1" });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "先答" } },
  });
  // 用户在这一轮跑到一半时排队发了下一条：带排队标记，排在记录末尾。
  state.messages.push({ id: "q2", role: "user", text: "Q2", queued: true });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t2",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "一半" } },
  });
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "先答一半" }] },
  });
  // 正文没有被排队消息拆成两条，排队消息始终排在最后。
  const answers = state.messages.filter((item) => item.role === "assistant");
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.text, "先答一半");
  assert.deepEqual(state.messages.map((item) => item.text), ["Q1", "先答一半", "Q2"]);

  // 轮末结果同样插在排队消息之前，排队消息不会停在发送位置。
  state = applySdkMessage(state, {
    type: "result",
    subtype: "success",
    uuid: "r1",
    result: "本轮完成。",
    is_error: false,
  });
  assert.deepEqual(state.messages.map((item) => item.text), ["Q1", "先答一半", "本轮完成。", "Q2"]);
});

test("一轮结束时残留的流式片段不再进行中", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "没写完" } },
  });
  state = applySdkMessage(state, {
    type: "result",
    subtype: "success",
    uuid: "r1",
    result: "完成。",
    is_error: false,
  });
  assert.equal(state.phase, "completed");
  assert.equal(state.messages.every((item) => item.partial === undefined), true);
});

test("子 agent 的流式增量不写进主对话", () => {
  const state = applySdkMessage(blank(), {
    type: "stream_event",
    uuid: "sub",
    parent_tool_use_id: "tool-1",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "内部" } },
  });
  assert.equal(state.messages.length, 0);
});

test("排队且没有回合时保持排队", () => {
  const state = blank();
  state.turnActive = false;
  state.queued = true;
  assert.equal(derivePhase(state), "queued");
});

test("单条消息超长时截断并保留尾注", () => {
  const short = "短消息";
  assert.equal(capMessageText(short), short);

  const long = "a".repeat(MAX_MESSAGE_TEXT + 50);
  const capped = capMessageText(long);
  assert.equal(capped.length, MAX_MESSAGE_TEXT);
  assert.match(capped, /已截断/);
  assert.equal(capped.startsWith("a".repeat(Math.min(200, capped.length))), true);
});

test("消息条数超限时丢弃最旧的非 user 消息", () => {
  const total = MAX_TRANSCRIPT_MESSAGES + 20;
  const messages: TranscriptItem[] = Array.from({ length: total }, (_, index) => ({
    id: `m${index}`,
    role: index === 0 || index === 1 ? "user" : "assistant",
    text: "x",
  }));
  const limited = limitTranscript(messages);
  assert.equal(limited.length, MAX_TRANSCRIPT_MESSAGES);
  // 用户消息保留，最近一条也保留。
  assert.equal(limited.some((item) => item.id === "m0"), true);
  assert.equal(limited.some((item) => item.id === "m1"), true);
  assert.equal(limited.at(-1)?.id, `m${total - 1}`);
  // 最旧的非 user 消息被丢弃。
  assert.equal(limited.some((item) => item.id === "m2"), false);
});

test("消息总字节超限时丢弃最旧的非 user 消息并保留最近内容", () => {
  const big = "a".repeat(MAX_MESSAGE_TEXT);
  const total = Math.ceil(MAX_TRANSCRIPT_BYTES / MAX_MESSAGE_TEXT) + 8;
  const messages: TranscriptItem[] = Array.from({ length: total }, (_, index) => ({
    id: `b${index}`,
    role: index === 0 ? "user" : "assistant",
    text: big,
  }));
  const limited = limitTranscript(messages);
  const bytes = limited.reduce(
    (sum, item) => sum + Buffer.byteLength(JSON.stringify(item), "utf8"),
    0,
  );
  assert.ok(bytes <= MAX_TRANSCRIPT_BYTES);
  assert.equal(limited[0]?.id, "b0");
  assert.equal(limited.at(-1)?.id, `b${total - 1}`);
});

test("用户消息自身超限时仍会从最旧开始丢弃以满足硬上限", () => {
  const big = "a".repeat(MAX_MESSAGE_TEXT);
  const total = Math.ceil(MAX_TRANSCRIPT_BYTES / MAX_MESSAGE_TEXT) + 5;
  const messages: TranscriptItem[] = Array.from({ length: total }, (_, index) => ({
    id: `u${index}`,
    role: "user",
    text: big,
  }));
  const limited = limitTranscript(messages);
  assert.ok(limited.length < total);
  assert.equal(limited.at(-1)?.id, `u${total - 1}`);
});

test("超长回复写入对话时按上限截断", () => {
  const state = applySdkMessage(blank(), {
    type: "result",
    subtype: "success",
    uuid: "long-result",
    result: "x".repeat(MAX_MESSAGE_TEXT + 100),
    is_error: false,
  });
  const last = state.messages.at(-1);
  assert.ok(last);
  assert.ok(last.text.length <= MAX_MESSAGE_TEXT);
  assert.match(last.text, /已截断/);
});

test("assistant 消息记录产生时间和完整 token 用量", () => {
  const at = "2026-02-03T04:05:06.789Z";
  const state = applySdkMessage(blank(), {
    type: "assistant",
    uuid: "a1",
    timestamp: at,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "答案" }],
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 56,
        cache_creation_input_tokens: 78,
      },
    },
  });
  const item = state.messages.at(-1);
  assert.equal(item?.role, "assistant");
  assert.equal(item?.at, at);
  assert.equal(new Date(item?.at as string).toISOString(), item?.at);
  assert.deepEqual(item?.usage, { input: 12, output: 34, cacheRead: 56, cacheWrite: 78 });
});

test("没有 usage 的 assistant 消息不设 usage，但仍然记录时间", () => {
  const at = "2026-02-03T04:05:06.789Z";
  const state = applySdkMessage(blank(), {
    type: "assistant",
    uuid: "a2",
    timestamp: at,
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "没有用量" }] },
  });
  const item = state.messages.at(-1);
  assert.equal(item?.at, at);
  assert.equal(item?.usage, undefined);
});

test("usage 缺失或非数字字段按 0 处理", () => {
  const state = applySdkMessage(blank(), {
    type: "assistant",
    uuid: "a3",
    timestamp: "2026-02-03T04:05:06.789Z",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "部分用量" }],
      usage: {
        input_tokens: 7,
        cache_read_input_tokens: "9" as unknown as number,
        output_tokens: -3,
        cache_creation_input_tokens: Number.NaN,
      },
    },
  });
  assert.deepEqual(state.messages.at(-1)?.usage, {
    input: 7,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });

  // 负数、NaN、Infinity 同样按 0 处理；四项都无效时整体视为没有用量。
  const invalid = applySdkMessage(blank(), {
    type: "assistant",
    uuid: "a3b",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "无效用量" }],
      usage: {
        input_tokens: Number.POSITIVE_INFINITY,
        output_tokens: Number.NEGATIVE_INFINITY,
        cache_read_input_tokens: Number.NaN,
        cache_creation_input_tokens: -1,
      },
    },
  });
  assert.equal(invalid.messages.at(-1)?.usage, undefined);
});

test("usage 全为 0 时视为没有用量", () => {
  const state = applySdkMessage(blank(), {
    type: "assistant",
    uuid: "a4",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "零用量" }],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
  assert.equal(state.messages.at(-1)?.at !== undefined, true);
  assert.equal(state.messages.at(-1)?.usage, undefined);
});

test("无效 timestamp 回退为有效 ISO 时间", () => {
  const state = applySdkMessage(blank(), {
    type: "assistant",
    uuid: "a5",
    timestamp: "not-a-time",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "回退" }] },
  });
  const at = state.messages.at(-1)?.at;
  assert.equal(typeof at, "string");
  assert.notEqual(at, "not-a-time");
  assert.equal(Number.isNaN(Date.parse(at as string)), false);
});

test("复用流式思考条目时保留原时间且不附加用量", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "t1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先想一想。" } },
  });
  const streamedAt = state.messages[0]?.at;
  assert.equal(typeof streamedAt, "string");
  const at = "2026-02-03T04:05:06.789Z";
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a6",
    timestamp: at,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先想一想。" },
        { type: "text", text: "好的" },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  });
  const thinking = state.messages.find((item) => item.kind === "thinking");
  assert.equal(thinking?.at, streamedAt);
  assert.equal(thinking?.usage, undefined);
  const body = state.messages.find((item) => item.role === "assistant" && item.kind !== "thinking");
  assert.equal(body?.at, at);
  assert.deepEqual(body?.usage, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test("result 正文新建条目时也记录时间和用量", () => {
  const at = "2026-02-03T05:06:07.890Z";
  let state = applySdkMessage(blank(), {
    type: "assistant",
    uuid: "a7",
    timestamp: at,
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "先说明" }] },
  });
  state = applySdkMessage(state, {
    type: "result",
    subtype: "success",
    uuid: "r1",
    result: "最终结果",
    timestamp: at,
    usage: {
      input_tokens: 5,
      output_tokens: 6,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 2,
    },
  });
  const item = state.messages.at(-1);
  assert.equal(item?.text, "最终结果");
  assert.equal(item?.at, at);
  assert.deepEqual(item?.usage, { input: 5, output: 6, cacheRead: 0, cacheWrite: 2 });
});

test("limitTranscript 重复调用复用字节缓存，不重复全量 stringify", () => {
  const messages: TranscriptItem[] = Array.from({ length: 300 }, (_, index) => ({
    id: `c${index}`,
    role: index % 3 === 0 ? "user" : "assistant",
    text: "x".repeat(80),
  }));
  const original = JSON.stringify;
  let calls = 0;
  (JSON as unknown as { stringify: (value: unknown) => string }).stringify = (value: unknown) => {
    calls += 1;
    return original(value);
  };
  try {
    const first = limitTranscript(messages);
    // 未超限时原样返回同一个数组。
    assert.equal(first, messages);
    // 首次需要为每条消息各 stringify 一次。
    assert.ok(calls >= messages.length);
    calls = 0;
    const second = limitTranscript(messages);
    assert.equal(second, messages);
    // 第二次走数组级缓存，不再 stringify 任何一条消息。
    assert.equal(calls, 0);
    // 新数组（数组级缓存未命中）时，仍靠条目级缓存避免再次 stringify。
    calls = 0;
    const sliced = limitTranscript(messages.slice());
    assert.deepEqual(sliced.map((item) => item.id), messages.map((item) => item.id));
    assert.equal(calls, 0);
  } finally {
    (JSON as unknown as { stringify: typeof JSON.stringify }).stringify = original;
  }
});

test("超长正文被替换为新对象后按新对象计算字节", () => {
  const original = JSON.stringify;
  const measured: unknown[] = [];
  (JSON as unknown as { stringify: (value: unknown) => string }).stringify = (value: unknown) => {
    measured.push(value);
    return original(value);
  };
  try {
    const messages: TranscriptItem[] = [
      { id: "long", role: "user", text: "a".repeat(MAX_MESSAGE_TEXT + 50) },
    ];
    const limited = limitTranscript(messages);
    const capped = limited[0];
    assert.ok(capped);
    assert.notEqual(capped, messages[0]);
    assert.ok(capped.text.length <= MAX_MESSAGE_TEXT);
    // 被度量的是截断后的新对象，而不是原始超长对象。
    assert.equal(measured.includes(capped), true);
    assert.equal(measured.includes(messages[0]), false);
  } finally {
    (JSON as unknown as { stringify: typeof JSON.stringify }).stringify = original;
  }
});

test("limitTranscript 裁剪结果重复调用保持一致", () => {
  const total = MAX_TRANSCRIPT_MESSAGES + 10;
  const messages: TranscriptItem[] = Array.from({ length: total }, (_, index) => ({
    id: `r${index}`,
    role: index < 2 ? "user" : "assistant",
    text: "x",
  }));
  const limited = limitTranscript(messages);
  assert.equal(limited.length, MAX_TRANSCRIPT_MESSAGES);
  const again = limitTranscript(limited);
  assert.equal(again, limited);
  assert.deepEqual(again.map((item) => item.id), limited.map((item) => item.id));
});

test("configureLimits 注入更小的上限后，截断和条数限制立即生效", () => {
  try {
    configureLimits({ transcriptMessages: 3, transcriptBytes: 1_000_000, messageText: 5 });
    assert.deepEqual(currentLimits(), {
      transcriptBytes: 1_000_000,
      transcriptMessages: 3,
      messageText: 5,
    });
    // 单条正文按注入的字符数上限截断。
    assert.equal(capMessageText("abcdefghij").length, 5);
    // 超过注入的条数上限时丢弃最旧的非 user 消息。
    const messages: TranscriptItem[] = Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`,
      role: index === 0 ? "user" : "assistant",
      text: "x",
    }));
    const limited = limitTranscript(messages);
    assert.equal(limited.length, 3);
    assert.equal(limited[0]?.id, "m0");
    assert.equal(limited.at(-1)?.id, "m5");
  } finally {
    // 恢复默认值，避免影响同一文件里的其他用例。
    configureLimits();
  }
  assert.deepEqual(currentLimits(), {
    transcriptBytes: MAX_TRANSCRIPT_BYTES,
    transcriptMessages: MAX_TRANSCRIPT_MESSAGES,
    messageText: MAX_MESSAGE_TEXT,
  });
});

test("configureLimits 只保留 transcript 三项，不混入请求体/分页配置", () => {
  const configLike = {
    transcriptMessages: 120,
    requestBodyBytes: 4096,
    historyPage: 100,
  };
  try {
    configureLimits(configLike);
    assert.deepEqual(currentLimits(), {
      transcriptBytes: MAX_TRANSCRIPT_BYTES,
      transcriptMessages: 120,
      messageText: MAX_MESSAGE_TEXT,
    });
  } finally {
    configureLimits();
  }
});

test("流式增量复制消息数组但不复制 subagents，且不就地修改 prev", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "task",
    task_id: "t1",
    task_type: "local_agent",
    description: "子任务",
  });
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "d1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "你" } },
  });

  const prev = state;
  const prevMessages = prev.messages;
  const prevSubagents = prev.subagents;
  const prevItem = prev.messages.at(-1);
  assert.ok(prevItem);

  const next = applySdkMessage(prev, {
    type: "stream_event",
    uuid: "d2",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "好" } },
  });

  // stream_event 不触碰子 agent，数组保持共享。
  assert.equal(next.subagents, prevSubagents);
  // 消息数组复制一次，被改的条目也换成新对象。
  assert.notEqual(next.messages, prevMessages);
  assert.notEqual(next.messages.at(-1), prevItem);
  // prev 完全不受影响。
  assert.equal(prev.messages, prevMessages);
  assert.equal(prev.messages.at(-1), prevItem);
  assert.equal(prevItem?.text, "你");
  assert.equal(next.messages.at(-1)?.text, "你好");
});

test("task_* 分支按写时复制更新 subagents，prev 条目不变", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    uuid: "s1",
    task_id: "t1",
    task_type: "local_agent",
    description: "子任务",
  });
  const prevSubagents = state.subagents;
  const prevItem = state.subagents[0];
  assert.ok(prevItem);

  const next = applySdkMessage(state, {
    type: "system",
    subtype: "task_progress",
    uuid: "s2",
    task_id: "t1",
    summary: "进行中",
    last_tool_name: "Read",
  });

  assert.notEqual(next.subagents, prevSubagents);
  assert.notEqual(next.subagents[0], prevItem);
  // prev 里的条目仍是原对象且未被修改。
  assert.equal(prevSubagents[0], prevItem);
  assert.equal(prevItem?.summary, undefined);
  assert.equal(prevItem?.lastToolName, undefined);
  assert.equal(next.subagents[0]?.summary, "进行中");
  assert.equal(next.subagents[0]?.lastToolName, "Read");
});

function toolItem(id: string, at?: string, extra?: Partial<TranscriptItem>): TranscriptItem {
  return {
    id,
    role: "tool",
    toolName: "Bash",
    toolUseId: id,
    text: "{\"command\":\"ls\"}",
    at: at ?? "2026-01-01T00:00:10.000Z",
    ...extra,
  };
}

test("工具结果回填成功状态、正文、耗时并清除进行中", () => {
  const state = blank();
  state.messages = [toolItem("toolu_1", "2026-01-01T00:00:10.000Z", { partial: true, streaming: true })];
  const next = applySdkMessage(state, {
    type: "user",
    uuid: "r1",
    timestamp: "2026-01-01T00:00:12.500Z",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file-a\nfile-b" }],
    },
  });
  const item = next.messages[0];
  assert.equal(next.messages.length, 1);
  assert.equal(item?.toolStatus, "ok");
  assert.equal(item?.result, "file-a\nfile-b");
  assert.equal(item?.durationMs, 2500);
  assert.equal(item?.partial, undefined);
  assert.equal(item?.streaming, undefined);
  // 写时复制：prev 里的条目保持原样。
  assert.notEqual(item, state.messages[0]);
  assert.equal(state.messages[0]?.toolStatus, undefined);
  assert.equal(state.messages[0]?.partial, true);
});

test("工具结果 is_error 回填为失败", () => {
  const blockError = blank();
  blockError.messages = [toolItem("toolu_e1")];
  const fromBlock = applySdkMessage(blockError, {
    type: "user",
    uuid: "e1",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "toolu_e1", content: "命令失败", is_error: true },
      ],
    },
  });
  assert.equal(fromBlock.messages[0]?.toolStatus, "error");
  assert.equal(fromBlock.messages[0]?.result, "命令失败");

  const messageError = blank();
  messageError.messages = [toolItem("toolu_e2")];
  const fromMessage = applySdkMessage(messageError, {
    type: "user",
    uuid: "e2",
    is_error: true,
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_e2", content: "失败" }],
    },
  });
  assert.equal(fromMessage.messages[0]?.toolStatus, "error");
});

test("工具结果 content 为数组时拼接 text 块", () => {
  const state = blank();
  state.messages = [toolItem("toolu_a")];
  const next = applySdkMessage(state, {
    type: "user",
    uuid: "a1",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_a",
          content: [
            { type: "text", text: "第一段" },
            { type: "image", source: { data: "xxx" } },
            { type: "text", text: "第二段" },
          ],
        },
      ],
    },
  });
  assert.equal(next.messages[0]?.result, "第一段\n第二段");
});

test("同一条 user 消息里的多个工具结果分别配对", () => {
  const state = blank();
  state.messages = [toolItem("toolu_1"), toolItem("toolu_2")];
  const next = applySdkMessage(state, {
    type: "user",
    uuid: "m1",
    timestamp: "2026-01-01T00:00:10.000Z",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "结果一" },
        { type: "tool_result", tool_use_id: "toolu_2", content: "结果二", is_error: true },
      ],
    },
  });
  assert.equal(next.messages[0]?.result, "结果一");
  assert.equal(next.messages[0]?.toolStatus, "ok");
  assert.equal(next.messages[1]?.result, "结果二");
  assert.equal(next.messages[1]?.toolStatus, "error");
  // 找不到配对条目的结果静默跳过，不新建条目。
  const unmatched = applySdkMessage(next, {
    type: "user",
    uuid: "m2",
    message: {
      content: [{ type: "tool_result", tool_use_id: "missing", content: "无主结果" }],
    },
  });
  assert.equal(unmatched.messages.length, 2);
});

test("子 agent 作用域的 tool_result 不改主对话", () => {
  const state = blank();
  state.messages = [toolItem("toolu_1")];
  const item = state.messages[0];
  const next = applySdkMessage(state, {
    type: "user",
    uuid: "s1",
    parent_tool_use_id: "task-1",
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "子 agent 结果" }],
    },
  });
  // 消息数组保持共享，且原条目没有被改动。
  assert.equal(next.messages, state.messages);
  assert.equal(next.messages[0], item);
  assert.equal(next.messages[0]?.toolStatus, undefined);
  assert.equal(next.messages[0]?.result, undefined);
});

test("纯文本 user 消息不新增也不修改条目", () => {
  const state = blank();
  state.messages = [toolItem("toolu_1")];
  const next = applySdkMessage(state, {
    type: "user",
    uuid: "t1",
    message: { role: "user", content: [{ type: "text", text: "用户回声" }] },
  });
  assert.equal(next.messages, state.messages);
  assert.equal(next.messages.length, 1);
  assert.equal(next.messages[0]?.text, "{\"command\":\"ls\"}");
});

test("工具输入正文保留换行，不被折叠成一行", () => {
  const multiLine = "第一行\n第二行\n\n  缩进";
  const complete = applySdkMessage(blank(), {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: multiLine }],
    },
  });
  assert.equal(complete.messages[0]?.text, multiLine);
  assert.match(complete.messages[0]?.text ?? "", /\n/);

  let streamed = applySdkMessage(blank(), {
    type: "stream_event",
    uuid: "d1",
    parent_tool_use_id: null,
    event: { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_2", name: "Bash" } },
  });
  streamed = applySdkMessage(streamed, {
    type: "stream_event",
    uuid: "d2",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: "{\n  \"command\": \"ls\"\n}" },
    },
  });
  assert.equal(streamed.messages[0]?.text, "{\n  \"command\": \"ls\"\n}");
  assert.match(streamed.messages[0]?.text ?? "", /\n/);
});

test("重复 uuid 的工具结果消息只处理一次", () => {
  const state = blank();
  state.messages = [toolItem("toolu_1")];
  const message = {
    type: "user" as const,
    uuid: "dup",
    timestamp: "2026-01-01T00:00:11.000Z",
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "结果" }],
    },
  };
  const first = applySdkMessage(state, message);
  const item = first.messages[0];
  assert.equal(item?.result, "结果");
  const second = applySdkMessage(first, message);
  assert.equal(second, first);
  assert.equal(second.messages[0], item);
});

test("传入 seen Set 时去重查询与持久化数组保持同步", () => {
  const seen = new Set<string>();
  const message = {
    type: "assistant" as const,
    uuid: "same",
    message: { content: [{ type: "text", text: "只出现一次" }] },
    parent_tool_use_id: null,
  };
  let state = applySdkMessage(blank(), message, seen);
  assert.equal(seen.has("same"), true);
  state = applySdkMessage(state, message, seen);
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.seen, ["same"]);
});

test("local_bash task_started 创建后台任务条目，不创建子 agent", () => {
  const state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    uuid: "b1",
    task_id: "shell-1",
    task_type: "local_bash",
    description: "下载模型权重",
    tool_use_id: "toolu_1",
    timestamp: "2026-01-01T00:00:05.000Z",
  });
  assert.equal(state.subagents.length, 0);
  assert.equal(state.backgroundTasks?.length, 1);
  const task = state.backgroundTasks?.[0];
  assert.equal(task?.taskId, "shell-1");
  assert.equal(task?.taskType, "local_bash");
  assert.equal(task?.description, "下载模型权重");
  assert.equal(task?.toolUseId, "toolu_1");
  assert.equal(task?.status, "running");
  // 没给 is_backgrounded 时按已转后台处理。
  assert.equal(task?.isBackgrounded, true);
  assert.equal(task?.startedAt, "2026-01-01T00:00:05.000Z");
  assert.equal(task?.endedAt, undefined);
});

test("local_bash 前台执行时 isBackgrounded 为 false，仍会被跟踪", () => {
  const state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    task_id: "shell-fg",
    task_type: "local_bash",
    description: "前台跑测试",
    is_backgrounded: false,
  });
  assert.equal(state.subagents.length, 0);
  assert.equal(state.backgroundTasks?.[0]?.isBackgrounded, false);
  assert.equal(state.backgroundTasks?.[0]?.status, "running");
});

test("task_notification 落定后台任务状态与摘要", () => {
  const cases = [
    ["completed", "completed"],
    ["failed", "failed"],
    ["stopped", "stopped"],
  ] as const;
  for (const [status, expected] of cases) {
    let state = applySdkMessage(blank(), {
      type: "system",
      subtype: "task_started",
      task_id: "shell-1",
      task_type: "local_bash",
      description: "下载",
      timestamp: "2026-01-01T00:00:05.000Z",
    });
    state = applySdkMessage(state, {
      type: "system",
      subtype: "task_notification",
      task_id: "shell-1",
      status,
      summary: `下载${status}`,
      timestamp: "2026-01-01T00:01:05.000Z",
    });
    const task = state.backgroundTasks?.[0];
    assert.equal(task?.status, expected);
    assert.equal(task?.summary, `下载${status}`);
    assert.equal(task?.endedAt, "2026-01-01T00:01:05.000Z");
    // 后台任务收尾不能影响子 agent。
    assert.equal(state.subagents.length, 0);
  }
});

test("task_updated 映射后台任务状态并同步 patch 字段", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    task_type: "local_bash",
    description: "下载",
    is_backgrounded: false,
  });
  // 前台任务转入后台 + 暂停：paused 仍算进行中。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_updated",
    task_id: "shell-1",
    patch: {
      status: "paused",
      description: "下载中（已暂停）",
      is_backgrounded: true,
      total_paused_ms: 1200,
    },
  });
  let task = state.backgroundTasks?.[0];
  assert.equal(task?.status, "running");
  assert.equal(task?.description, "下载中（已暂停）");
  assert.equal(task?.isBackgrounded, true);
  assert.equal(task?.endedAt, undefined);

  // killed 映射为 stopped，并补结束时间。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_updated",
    task_id: "shell-1",
    timestamp: "2026-01-01T00:02:00.000Z",
    patch: { status: "killed" },
  });
  task = state.backgroundTasks?.[0];
  assert.equal(task?.status, "stopped");
  assert.equal(task?.endedAt, "2026-01-01T00:02:00.000Z");

  // 错误写入摘要。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_updated",
    task_id: "shell-1",
    patch: { error: "磁盘已满" },
  });
  assert.equal(state.backgroundTasks?.[0]?.summary, "磁盘已满");
});

test("后台任务续跑（新 run_id）回到 running，保留首次开始时间", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    run_id: "run-1",
    task_type: "local_bash",
    description: "第一次下载",
    timestamp: "2026-01-01T00:00:05.000Z",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    task_id: "shell-1",
    run_id: "run-1",
    status: "completed",
    summary: "第一次完成",
    timestamp: "2026-01-01T00:10:00.000Z",
  });
  assert.equal(state.backgroundTasks?.[0]?.status, "completed");

  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    run_id: "run-2",
    task_type: "local_bash",
    description: "第二次下载",
    timestamp: "2026-01-01T00:20:00.000Z",
  });
  const task = state.backgroundTasks?.[0];
  assert.equal(state.backgroundTasks?.length, 1);
  assert.equal(task?.runId, "run-2");
  assert.equal(task?.status, "running");
  assert.equal(task?.description, "第二次下载");
  // 首次开始时间保留，上一轮的结束时间与摘要被清掉。
  assert.equal(task?.startedAt, "2026-01-01T00:00:05.000Z");
  assert.equal(task?.endedAt, undefined);
  assert.equal(task?.summary, undefined);
});

test("ambient 的 local_bash 任务被忽略", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    uuid: "amb-1",
    task_id: "ambient-shell",
    task_type: "local_bash",
    ambient: true,
    description: "内部检查",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "background_tasks_changed",
    uuid: "bg-1",
    tasks: [
      { task_id: "ambient-shell", task_type: "local_bash", ambient: true, description: "内部检查" },
      { task_id: "agent-1", task_type: "local_agent", description: "子 agent" },
    ],
  });
  assert.deepEqual(state.backgroundTasks ?? [], []);
  assert.equal(state.subagents.length, 0);
});

test("background_tasks_changed upsert 存活任务为 running，不误删历史条目", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    task_id: "shell-a",
    run_id: "run-1",
    task_type: "local_bash",
    description: "下载 A",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    task_id: "shell-a",
    run_id: "run-1",
    status: "completed",
    summary: "A 完成",
  });
  assert.equal(state.backgroundTasks?.[0]?.status, "completed");
  // 前台启动的 C：快照里出现后应补上 isBackgrounded。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    task_id: "shell-c",
    task_type: "local_bash",
    description: "前台 C",
    is_backgrounded: false,
  });
  assert.equal(state.backgroundTasks?.find((item) => item.taskId === "shell-c")?.isBackgrounded, false);

  state = applySdkMessage(state, {
    type: "system",
    subtype: "background_tasks_changed",
    uuid: "bg-1",
    tasks: [
      { task_id: "shell-a", run_id: "run-1", task_type: "local_bash", description: "下载 A" },
      { task_id: "shell-b", task_type: "local_bash", description: "下载 B" },
      { task_id: "shell-c", task_type: "local_bash", description: "前台 C" },
      { task_id: "agent-1", task_type: "local_agent", description: "子 agent" },
    ],
  });
  assert.equal(state.backgroundTasks?.length, 3);
  // 已落定的同一 run 不能被迟到的快照复活。
  assert.equal(state.backgroundTasks?.find((item) => item.taskId === "shell-a")?.status, "completed");
  const b = state.backgroundTasks?.find((item) => item.taskId === "shell-b");
  assert.equal(b?.status, "running");
  assert.equal(b?.taskType, "local_bash");
  assert.equal(b?.isBackgrounded, true);
  // 已存在的存活任务在快照里补上“已在后台”。
  assert.equal(state.backgroundTasks?.find((item) => item.taskId === "shell-c")?.isBackgrounded, true);
  // 快照里的子 agent 不能写进 backgroundTasks，也不创建 subagent。
  assert.equal(state.subagents.length, 0);

  // 快照里出现更新的 run_id 才视为续跑，重新回到 running。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "background_tasks_changed",
    uuid: "bg-2",
    tasks: [{ task_id: "shell-a", run_id: "run-2", task_type: "local_bash", description: "下载 A" }],
  });
  assert.equal(state.backgroundTasks?.find((item) => item.taskId === "shell-a")?.status, "running");
  assert.equal(state.backgroundTasks?.find((item) => item.taskId === "shell-a")?.runId, "run-2");

  // 下一次快照只剩 B：其它历史条目保留，不被删除。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "background_tasks_changed",
    uuid: "bg-3",
    tasks: [{ task_id: "shell-b", task_type: "local_bash", description: "下载 B" }],
  });
  assert.equal(state.backgroundTasks?.length, 3);
  assert.equal(state.backgroundTasks?.some((item) => item.taskId === "shell-a"), true);
});

test("终态任务出现在后续快照里不会复活（顺序未定义）", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    run_id: "run-1",
    task_type: "local_bash",
    description: "下载",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    task_id: "shell-1",
    run_id: "run-1",
    status: "completed",
    summary: "下载完成",
    timestamp: "2026-01-01T00:10:00.000Z",
  });
  // 迟到的成员变更快照仍列出这个刚结束的任务：不能改回 running。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "background_tasks_changed",
    uuid: "bg-late",
    tasks: [{ task_id: "shell-1", run_id: "run-1", task_type: "local_bash", description: "下载" }],
  });
  const task = state.backgroundTasks?.[0];
  assert.equal(task?.status, "completed");
  assert.equal(task?.endedAt, "2026-01-01T00:10:00.000Z");
  assert.equal(task?.summary, "下载完成");
});

test("迟到的旧 run 快照/patch/notification/task_started 都被忽略", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    run_id: "run-1",
    task_type: "local_bash",
    description: "第一轮",
    timestamp: "2026-01-01T00:00:05.000Z",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    run_id: "run-2",
    task_type: "local_bash",
    description: "第二轮",
    timestamp: "2026-01-01T00:10:00.000Z",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    task_id: "shell-1",
    run_id: "run-2",
    status: "completed",
    summary: "第二轮完成",
    timestamp: "2026-01-01T00:20:00.000Z",
  });
  const before = state.backgroundTasks?.[0];
  assert.equal(before?.runId, "run-2");
  assert.equal(before?.status, "completed");
  assert.equal(before?.endedAt, "2026-01-01T00:20:00.000Z");
  assert.equal(before?.summary, "第二轮完成");
  assert.equal(before?.description, "第二轮");

  // 迟到的旧 run 快照：不得复活，也不得回退 runId/说明。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "background_tasks_changed",
    uuid: "bg-late-old",
    tasks: [{ task_id: "shell-1", run_id: "run-1", task_type: "local_bash", description: "旧说明" }],
  });
  assert.deepEqual(state.backgroundTasks?.[0], before);

  // 迟到的旧 run patch：不更新状态、说明或错误。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_updated",
    task_id: "shell-1",
    run_id: "run-1",
    patch: { status: "running", description: "旧 patch", error: "旧错误" },
  });
  assert.deepEqual(state.backgroundTasks?.[0], before);

  // 迟到的旧 run notification：不影响最终状态与摘要。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    task_id: "shell-1",
    run_id: "run-1",
    status: "failed",
    summary: "旧失败",
  });
  assert.deepEqual(state.backgroundTasks?.[0], before);

  // 迟到的旧 run task_started：不重置状态和开始时间。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    run_id: "run-1",
    task_type: "local_bash",
    description: "旧开始",
  });
  assert.deepEqual(state.backgroundTasks?.[0], before);
});

test("快照先于 task_started 时，同 run 合并补齐 toolUseId 和说明", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "background_tasks_changed",
    uuid: "bg-first",
    tasks: [{ task_id: "shell-1", run_id: "run-1", task_type: "local_bash" }],
  });
  let task = state.backgroundTasks?.[0];
  assert.equal(task?.status, "running");
  assert.equal(task?.isBackgrounded, true);
  // 说明缺失时存空字符串，而不是占位文本。
  assert.equal(task?.description, "");
  assert.equal(task?.toolUseId, undefined);
  const startedAt = task?.startedAt;
  assert.equal(typeof startedAt, "string");

  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    run_id: "run-1",
    task_type: "local_bash",
    description: "curl 下载权重",
    tool_use_id: "toolu_9",
    timestamp: "2026-01-01T00:00:09.000Z",
  });
  task = state.backgroundTasks?.[0];
  assert.equal(task?.description, "curl 下载权重");
  assert.equal(task?.toolUseId, "toolu_9");
  // 同 run 合并不重置开始时间。
  assert.equal(task?.startedAt, startedAt);
  assert.equal(task?.status, "running");
});

test("动态 description 不被后续同 run 快照/开始帧覆盖", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    run_id: "run-1",
    task_type: "local_bash",
    description: "下载",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_updated",
    task_id: "shell-1",
    run_id: "run-1",
    patch: { status: "running", description: "下载到 50%" },
  });
  assert.equal(state.backgroundTasks?.[0]?.description, "下载到 50%");

  state = applySdkMessage(state, {
    type: "system",
    subtype: "background_tasks_changed",
    uuid: "bg-static",
    tasks: [{ task_id: "shell-1", run_id: "run-1", task_type: "local_bash", description: "下载" }],
  });
  assert.equal(state.backgroundTasks?.[0]?.description, "下载到 50%");

  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    run_id: "run-1",
    task_type: "local_bash",
    description: "下载",
  });
  assert.equal(state.backgroundTasks?.[0]?.description, "下载到 50%");
});

test("已落定任务的迟到 running patch 不清 endedAt，较新 run 的 patch 可以重置", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    run_id: "run-1",
    task_type: "local_bash",
    description: "下载",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    task_id: "shell-1",
    run_id: "run-1",
    status: "completed",
    summary: "完成",
    timestamp: "2026-01-01T00:10:00.000Z",
  });
  // 同 run 的迟到 running patch 不复活、不清 endedAt。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_updated",
    task_id: "shell-1",
    run_id: "run-1",
    patch: { status: "running", description: "迟到的进行中" },
  });
  let task = state.backgroundTasks?.[0];
  assert.equal(task?.status, "completed");
  assert.equal(task?.endedAt, "2026-01-01T00:10:00.000Z");
  assert.equal(task?.summary, "完成");

  // 较新 run 的 patch 允许把状态改回 running（正常会有 task_started 先行）。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_updated",
    task_id: "shell-1",
    run_id: "run-2",
    patch: { status: "running" },
  });
  task = state.backgroundTasks?.[0];
  assert.equal(task?.status, "running");
  assert.equal(task?.runId, "run-2");
  assert.equal(task?.endedAt, undefined);
});

test("重复到达的 task_notification 幂等", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    task_id: "shell-1",
    run_id: "run-1",
    task_type: "local_bash",
    description: "下载",
  });
  const notification = {
    type: "system" as const,
    subtype: "task_notification" as const,
    task_id: "shell-1",
    run_id: "run-1",
    status: "failed" as const,
    summary: "网络中断",
    timestamp: "2026-01-01T00:10:00.000Z",
  };
  state = applySdkMessage(state, { ...notification, uuid: "n1" });
  const first = state.backgroundTasks?.[0];
  state = applySdkMessage(state, { ...notification, uuid: "n2" });
  const second = state.backgroundTasks?.[0];
  assert.deepEqual(second, first);
  assert.equal(second?.status, "failed");
  assert.equal(second?.summary, "网络中断");
});

test("running 的后台任务不影响 phase 和 mainAgentRunning", () => {
  const state = blank();
  state.turnActive = false;
  state.lastResult = "success";
  state.backgroundTasks = [{
    taskId: "shell-1",
    taskType: "local_bash",
    description: "下载",
    status: "running",
    isBackgrounded: true,
    startedAt: "2026-01-01T00:00:05.000Z",
  }];
  assert.equal(derivePhase(state), "completed");
  assert.equal(mainAgentRunning(state), false);
});

test("后台任务数组按写时复制：只有相关消息才复制且不改动 prev 条目", () => {
  let state = applySdkMessage(blank(), {
    type: "system",
    subtype: "task_started",
    uuid: "b1",
    task_id: "shell-1",
    task_type: "local_bash",
    description: "下载",
  });
  const prevTasks = state.backgroundTasks;
  const prevTask = state.backgroundTasks?.[0];
  assert.ok(prevTasks && prevTask);

  // 普通流式增量不碰后台任务，数组保持共享。
  const streamed = applySdkMessage(state, {
    type: "stream_event",
    uuid: "d1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "你" } },
  });
  assert.equal(streamed.backgroundTasks, prevTasks);

  // task_updated 命中后台任务时才复制数组，且 prev 里的条目不被就地修改。
  const updated = applySdkMessage(streamed, {
    type: "system",
    subtype: "task_updated",
    uuid: "u1",
    task_id: "shell-1",
    patch: { description: "下载到 50%" },
  });
  assert.notEqual(updated.backgroundTasks, prevTasks);
  assert.equal(prevTask?.description, "下载");
  assert.equal(updated.backgroundTasks?.[0]?.description, "下载到 50%");
});

test("task_progress 的用量记到子任务上，并在通知落定时更新", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "s1",
    task_id: "t1",
    run_id: "run-1",
    task_type: "local_agent",
    description: "阅读入口",
    timestamp: "2026-01-01T00:00:05.000Z",
  });
  assert.equal(state.subagents[0]?.runStartedAt, "2026-01-01T00:00:05.000Z");
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_progress",
    uuid: "p1",
    task_id: "t1",
    run_id: "run-1",
    usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 30_000 },
    timestamp: "2026-01-01T00:00:35.000Z",
  });
  assert.equal(state.subagents[0]?.tokens, 1200);
  assert.equal(state.subagents[0]?.toolUses, 4);
  assert.equal(state.subagents[0]?.durationMs, 30_000);
  assert.equal(state.subagents[0]?.usageAt, "2026-01-01T00:00:35.000Z");

  // 通知里的用量是落定快照，覆盖最后一次进度。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_notification",
    uuid: "n1",
    task_id: "t1",
    run_id: "run-1",
    status: "completed",
    usage: { total_tokens: 1500, tool_uses: 5, duration_ms: 42_000 },
    timestamp: "2026-01-01T00:00:47.000Z",
  });
  assert.equal(state.subagents[0]?.tokens, 1500);
  assert.equal(state.subagents[0]?.toolUses, 5);
  assert.equal(state.subagents[0]?.durationMs, 42_000);
  assert.equal(state.subagents[0]?.usageAt, "2026-01-01T00:00:47.000Z");
});

test("子任务续跑时重置当前轮计时，忽略脏用量字段", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "s1",
    task_id: "t1",
    run_id: "run-1",
    task_type: "local_agent",
    description: "单元",
    timestamp: "2026-01-01T00:00:05.000Z",
  });
  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_progress",
    uuid: "p1",
    task_id: "t1",
    run_id: "run-1",
    usage: { total_tokens: -5, tool_uses: 2.6, duration_ms: Number.NaN },
    timestamp: "2026-01-01T00:00:35.000Z",
  });
  assert.equal(state.subagents[0]?.tokens, undefined);
  assert.equal(state.subagents[0]?.toolUses, 3);
  assert.equal(state.subagents[0]?.durationMs, undefined);

  state = applySdkMessage(state, {
    type: "system",
    subtype: "task_started",
    uuid: "s2",
    task_id: "t1",
    run_id: "run-2",
    task_type: "local_agent",
    timestamp: "2026-01-01T00:10:00.000Z",
  });
  assert.equal(state.subagents[0]?.startedAt, "2026-01-01T00:00:05.000Z");
  assert.equal(state.subagents[0]?.runStartedAt, "2026-01-01T00:10:00.000Z");
  assert.equal(state.subagents[0]?.runs, 2);
});

test("applySdkMessage 只记录主线程 assistant/user/compact_boundary 的 chain uuid", () => {
  let state = blank();
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "回答" }] },
  });
  assert.equal(state.lastSdkUuid, "a1");

  // 子 agent 的 assistant/user 属于 sidechain，不能挤进主线程指针。
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "a2",
    parent_tool_use_id: "tool-1",
    message: { role: "assistant", content: [{ type: "text", text: "子 agent" }] },
  });
  assert.equal(state.lastSdkUuid, "a1");
  state = applySdkMessage(state, {
    type: "user",
    uuid: "a3",
    agent_id: "agent-1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
  });
  assert.equal(state.lastSdkUuid, "a1");

  // 主线程 user 条目（tool_result 回填）也是 chain 条目。
  state = applySdkMessage(state, {
    type: "user",
    uuid: "u1",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
  });
  assert.equal(state.lastSdkUuid, "u1");

  // init 不推进 chain 指针，但保留 claudeSessionId。
  state = applySdkMessage(state, {
    type: "system",
    subtype: "init",
    uuid: "i1",
    session_id: "sdk-1",
  });
  assert.equal(state.lastSdkUuid, "u1");
  assert.equal(state.claudeSessionId, "sdk-1");

  state = applySdkMessage(state, { type: "system", subtype: "compact_boundary", uuid: "c1" });
  assert.equal(state.lastSdkUuid, "c1");
  state = applySdkMessage(state, {
    type: "system",
    subtype: "api_error",
    uuid: "e1",
    error: { message: "出错" },
  });
  assert.equal(state.lastSdkUuid, "c1");
});

test("applySdkMessage 去重命中时不改 chain 指针", () => {
  const state: SessionCore = { ...blank(), seen: ["dup"], lastSdkUuid: "old" };
  const next = applySdkMessage(state, {
    type: "assistant",
    uuid: "dup",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "重复" }] },
  });
  assert.equal(next, state);
  assert.equal(next.lastSdkUuid, "old");
});

test("init 在 newSdkSession 时清空标记和旧 chain 指针", () => {
  let state: SessionCore = {
    ...blank(),
    newSdkSession: true,
    lastSdkUuid: "old",
    claudeSessionId: "old-sdk",
  };
  state = applySdkMessage(state, {
    type: "system",
    subtype: "init",
    uuid: "i1",
    session_id: "new-sdk",
  });
  assert.equal(state.claudeSessionId, "new-sdk");
  assert.equal(state.newSdkSession, undefined);
  assert.equal(state.lastSdkUuid, undefined);

  // 普通 init 不清旧指针。
  let kept: SessionCore = { ...blank(), lastSdkUuid: "keep", claudeSessionId: "sdk-old" };
  kept = applySdkMessage(kept, {
    type: "system",
    subtype: "init",
    uuid: "i2",
    session_id: "sdk-new",
  });
  assert.equal(kept.claudeSessionId, "sdk-new");
  assert.equal(kept.lastSdkUuid, "keep");
});

test("user 回显时用回显前的 chain 指针写 forkPoint，tool_result/result/stream_event 不写", () => {
  let state: SessionCore = {
    ...blank(),
    messages: [
      { id: "u1", role: "user", text: "第一问", sdkUuid: "sdk-u1" },
      { id: "a1", role: "assistant", text: "回答" },
      { id: "u2", role: "user", text: "第二问", sdkUuid: "sdk-u2" },
    ],
  };
  const before = state.messages;

  // user1 回显：之前没有 chain 条目，截断点是 ROOT。
  state = applySdkMessage(state, {
    type: "user",
    uuid: "sdk-u1",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: "第一问" }] },
  });
  assert.equal(state.messages[0]?.forkPoint, ROOT_FORK_POINT);
  assert.equal(state.lastSdkUuid, "sdk-u1");
  // 写时复制：不能就地改 prev 的数组。
  assert.notEqual(state.messages, before);
  assert.equal(before[0]?.forkPoint, undefined);

  // assistant1 推进 chain 指针（注意本地已有一条同名 assistant 记录，下标仍稳定）。
  state = applySdkMessage(state, {
    type: "assistant",
    uuid: "assistant-1",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "回答" }] },
  });
  assert.equal(state.lastSdkUuid, "assistant-1");

  // user2 回显：截断点指向 assistant1，而不是自己。
  state = applySdkMessage(state, {
    type: "user",
    uuid: "sdk-u2",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: "第二问" }] },
  });
  assert.equal(state.messages[2]?.forkPoint, "assistant-1");
  assert.equal(state.lastSdkUuid, "sdk-u2");

  // tool_result 型 user 是 chain 条目（推进 lastSdkUuid），但不是真实 prompt，不写 forkPoint。
  state = applySdkMessage(state, {
    type: "user",
    uuid: "tool-1",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
  });
  assert.equal(state.messages[0]?.forkPoint, ROOT_FORK_POINT);
  assert.equal(state.messages[2]?.forkPoint, "assistant-1");
  assert.equal(state.lastSdkUuid, "tool-1");

  // result / stream_event 不推进 chain 指针。
  state = applySdkMessage(state, {
    type: "result",
    subtype: "success",
    uuid: "result-1",
    result: "完成",
    is_error: false,
  });
  assert.equal(state.lastSdkUuid, "tool-1");
  state = applySdkMessage(state, {
    type: "stream_event",
    uuid: "event-1",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
  });
  assert.equal(state.lastSdkUuid, "tool-1");
});

test("连续两个 user 回显（中间没有 assistant）时第二条 forkPoint 指向第一条 uuid", () => {
  let state: SessionCore = {
    ...blank(),
    messages: [
      { id: "u1", role: "user", text: "第一问", sdkUuid: "sdk-u1" },
      { id: "u2", role: "user", text: "第二问", sdkUuid: "sdk-u2" },
    ],
  };

  // streaming input 可能在上一条 chain 条目回显前就取走下一条 prompt：
  // 两条 user 回显背靠背到达，第二条的截断点必须指向第一条，而不是陈旧值。
  state = applySdkMessage(state, {
    type: "user",
    uuid: "sdk-u1",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: "第一问" }] },
  });
  assert.equal(state.messages[0]?.forkPoint, ROOT_FORK_POINT);
  assert.equal(state.lastSdkUuid, "sdk-u1");

  state = applySdkMessage(state, {
    type: "user",
    uuid: "sdk-u2",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: "第二问" }] },
  });
  assert.equal(state.messages[1]?.forkPoint, "sdk-u1");
  assert.equal(state.lastSdkUuid, "sdk-u2");
});

test("derivePhase：角色团队配置阶段返回 setup", () => {
  const state = blank();
  state.turnActive = false;
  state.lastResult = undefined;
  state.roleRun = {
    phase: "setup",
    units: [],
    round: 0,
    maxRounds: 3,
  };
  assert.equal(derivePhase(state), "setup");
  // 运行中的角色团队按 turnActive 判定，不依赖 roleRun 的阶段。
  state.turnActive = true;
  state.roleRun.phase = "running";
  assert.equal(derivePhase(state), "running");
});

test("detectWorkflowSkill：识别 prl-role，且优先于 prl", () => {
  assert.equal(detectWorkflowSkill("用角色团队 prl-role"), "prl-role");
  assert.equal(detectWorkflowSkill("用角色团队 PRL-ROLE。"), "prl-role");
  assert.equal(detectWorkflowSkill("/prl-role 实现这个"), "prl-role");
  assert.equal(detectWorkflowSkill("实现这个 prl"), "prl");
  assert.equal(detectWorkflowSkill("拆开并行讨论 dis-prl"), "dis-prl");
});
