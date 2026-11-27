import assert from "node:assert/strict";
import test from "node:test";
import type { Provider, Session } from "./api";
import {
  createMultiModelGroup,
  deleteMultiModelGroup,
  getMultiModelGroups,
} from "./api-multi-model";
import type { SessionUsage } from "./api-usage";
import {
  MAX_SELECTIONS,
  duplicateSelectionIndexes,
  groupMemberStatuses,
  groupsForProject,
  isCurrentResponse,
  nextSelection,
  promptPreview,
  selectionKey,
  summarizeMembers,
  validateSelections,
  type GroupMember,
  type MultiModelGroup,
} from "./multi-model";

const NOW = "2026-01-01T00:00:00.000Z";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function selection(overrides: Partial<{ providerId: string; model: string; effort: "low" | "medium" | "high" | "xhigh" | "max" }> = {}) {
  return { providerId: "p1", model: "m1", effort: "high" as const, ...overrides };
}

function member(overrides: Partial<GroupMember> = {}): GroupMember {
  return {
    id: "s1",
    providerId: "p1",
    providerName: "接口一",
    model: "m1",
    effort: "high",
    title: "多模型 · m1",
    ...overrides,
  };
}

function group(overrides: Partial<MultiModelGroup> = {}): MultiModelGroup {
  return {
    id: "g1",
    projectId: "proj",
    createdAt: NOW,
    promptPreview: "实现一个功能",
    sessions: [member(), member({ id: "s2", model: "m2" })],
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "proj",
    title: "多模型 · m1",
    providerId: "p1",
    providerName: "接口一",
    model: "m1",
    effort: "high",
    phase: "running",
    summary: "",
    git: true,
    cwd: "/tmp",
    isolated: false,
    subagentDone: 0,
    subagentTotal: 0,
    subagents: [],
    pending: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function usage(id: string, cost: number): SessionUsage {
  return {
    id,
    title: id,
    projectId: "proj",
    totals: { calls: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    cost,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("selectionKey distinguishes provider, model and effort", () => {
  assert.equal(selectionKey(selection()), selectionKey(selection()));
  assert.notEqual(selectionKey(selection()), selectionKey(selection({ providerId: "p2" })));
  assert.notEqual(selectionKey(selection()), selectionKey(selection({ model: "m2" })));
  assert.notEqual(selectionKey(selection()), selectionKey(selection({ effort: "low" })));
});

test("duplicateSelectionIndexes reports only later duplicates", () => {
  const rows = [
    selection(),
    selection({ model: "m2" }),
    selection(),
    selection({ effort: "low" }),
    selection({ model: "m2" }),
  ];
  assert.deepEqual(duplicateSelectionIndexes(rows), [2, 4]);
  assert.deepEqual(duplicateSelectionIndexes([selection()]), []);
});

test("validateSelections enforces count, completeness and uniqueness", () => {
  assert.equal(validateSelections([selection()]).ok, false);
  assert.match(validateSelections([selection()]).error ?? "", /至少/);

  const tooMany = Array.from({ length: MAX_SELECTIONS + 1 }, (_, index) =>
    selection({ model: `m${index}` }),
  );
  assert.match(validateSelections(tooMany).error ?? "", /最多/);

  assert.equal(validateSelections([selection(), selection({ model: "m2" })]).ok, true);

  const duplicate = validateSelections([selection(), selection()]);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error ?? "", /第 2 行/);

  assert.match(validateSelections([selection({ providerId: "" }), selection({ model: "m2" })]).error ?? "", /接口/);
  assert.match(validateSelections([selection({ model: "" }), selection({ model: "m2" })]).error ?? "", /模型/);
});

test("nextSelection skips combinations already used", () => {
  const providers: Provider[] = [
    { id: "p1", name: "接口一", kind: "anthropic", baseUrl: "", hasApiKey: true, models: ["m1", "m2"] },
    { id: "p2", name: "接口二", kind: "anthropic", baseUrl: "", hasApiKey: true, models: ["m3"] },
  ];
  const fallback = selection();
  const next = nextSelection(providers, [fallback, selection({ model: "m2" })], fallback);
  assert.deepEqual(next, { providerId: "p2", model: "m3", effort: "high" });

  // 全部用完后退回 fallback。
  const all: ReturnType<typeof selection>[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
        all.push({ providerId: provider.id, model, effort });
      }
    }
  }
  const usedAll = nextSelection(providers, all, fallback);
  assert.deepEqual(usedAll, fallback);
});

test("promptPreview collapses whitespace and truncates", () => {
  assert.equal(promptPreview("  你好\n\n世界  "), "你好 世界");
  assert.equal(promptPreview("", 10), "");
  assert.equal(promptPreview(undefined, 10), "");
  const long = "a".repeat(100);
  const preview = promptPreview(long, 10);
  assert.equal(preview.length, 10);
  assert.match(preview, /…$/);
  assert.equal(promptPreview(long, 0), "");
});

test("isCurrentResponse rejects stale, aborted or unmounted responses", () => {
  const current = { mounted: true, seq: 2, currentSeq: 2, aborted: false };
  assert.equal(isCurrentResponse(current), true);
  assert.equal(isCurrentResponse({ ...current, mounted: false }), false);
  assert.equal(isCurrentResponse({ ...current, seq: 1 }), false);
  assert.equal(isCurrentResponse({ ...current, aborted: true }), false);
});

test("groupsForProject filters by project and keeps newest-first order", () => {
  const groups = [
    group({ id: "g1", projectId: "proj" }),
    group({ id: "g2", projectId: "other" }),
    group({ id: "g3", projectId: "proj" }),
  ];
  assert.deepEqual(groupsForProject(groups, "proj").map((item) => item.id), ["g1", "g3"]);
  assert.deepEqual(groupsForProject(groups, "other").map((item) => item.id), ["g2"]);
  assert.deepEqual(groupsForProject(groups, "missing"), []);
});

test("api-multi-model 使用项目路由读取、创建和删除分组", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (init?.method === "POST") return jsonResponse({ group: group() }, 201);
    if (init?.method === "DELETE") return jsonResponse({ ok: true });
    return jsonResponse({ groups: [group()] });
  }) as typeof fetch;

  const listed = await getMultiModelGroups("proj");
  assert.deepEqual(listed.groups.map((item) => item.id), ["g1"]);

  const created = await createMultiModelGroup("proj", {
    promptPreview: "实现一个功能",
    sessions: [member(), member({ id: "s2", model: "m2" })],
  });
  assert.equal(created.group.id, "g1");

  await deleteMultiModelGroup("proj", "g1");

  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, "/api/projects/proj/multi-model-groups");
  assert.equal(calls[0]?.init?.method, undefined);
  assert.equal(calls[1]?.url, "/api/projects/proj/multi-model-groups");
  assert.equal(calls[1]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    promptPreview: "实现一个功能",
    sessions: [member(), member({ id: "s2", model: "m2" })],
  });
  assert.equal(calls[2]?.url, "/api/projects/proj/multi-model-groups/g1");
  assert.equal(calls[2]?.init?.method, "DELETE");
});

test("groupMemberStatuses merges session state and cost by id", () => {
  const statuses = groupMemberStatuses(
    group({
      sessions: [
        member({ id: "s1" }),
        member({ id: "s2", model: "m2" }),
        member({ id: "gone", model: "m3", providerName: "旧接口", title: "旧标题" }),
      ],
    }),
    [
      session({ id: "s1", phase: "completed", branch: "qubius/s1", title: "新标题" }),
      session({ id: "s2", phase: "running", model: "m2-new" }),
    ],
    [usage("s1", 0.25), usage("s2", 0.5)],
  );

  assert.equal(statuses.length, 3);
  assert.deepEqual(
    statuses.map((item) => [item.id, item.phase, item.present, item.cost]),
    [
      ["s1", "completed", true, 0.25],
      ["s2", "running", true, 0.5],
      ["gone", "unknown", false, undefined],
    ],
  );
  assert.equal(statuses[0]?.title, "新标题");
  assert.equal(statuses[0]?.branch, "qubius/s1");
  // 会话被删除时保留分组快照。
  assert.equal(statuses[2]?.title, "旧标题");
  assert.equal(statuses[2]?.providerName, "旧接口");
  assert.equal(statuses[1]?.model, "m2-new");
});

test("groupMemberStatuses works before session data is loaded", () => {
  const statuses = groupMemberStatuses(group(), null, undefined);
  assert.deepEqual(statuses.map((item) => item.phase), ["unknown", "unknown"]);
  assert.ok(statuses.every((item) => item.present === false));
  assert.ok(statuses.every((item) => item.cost === undefined));
});

test("summarizeMembers aggregates counts and costs", () => {
  const statuses = groupMemberStatuses(
    group({
      sessions: [member({ id: "s1" }), member({ id: "s2" }), member({ id: "s3" }), member({ id: "s4" })],
    }),
    [
      session({ id: "s1", phase: "completed" }),
      session({ id: "s2", phase: "running" }),
      session({ id: "s3", phase: "failed" }),
      // s4 缺失
    ],
    [usage("s1", 0.1), usage("s2", 0.2), usage("s3", 0.3)],
  );
  const summary = summarizeMembers(statuses);
  assert.equal(summary.total, 4);
  assert.equal(summary.running, 1);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.ok(Math.abs(summary.cost - 0.6) < 1e-9);
});
