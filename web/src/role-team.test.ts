import assert from "node:assert/strict";
import test from "node:test";
import type { Provider, RoleBinding, RoleTeam } from "./api";
import {
  ROLE_FIELDS,
  defaultRoleTeam,
  roleRunStatusText,
  roleTeamComplete,
  roleTeamDefaults,
  roleUnitStatusText,
} from "./role-team";

function provider(id: string, name: string, models: string[]): Provider {
  return {
    id,
    name,
    kind: "anthropic",
    baseUrl: "https://example.test",
    hasApiKey: true,
    models,
  };
}

function binding(providerId: string, providerName: string, model: string, effort: RoleBinding["effort"] = "medium"): RoleBinding {
  return { providerId, providerName, model, effort };
}

function team(overrides: Partial<RoleTeam> = {}): RoleTeam {
  return {
    orchestrator: binding("p1", "接口一", "m1"),
    executor: binding("p1", "接口一", "m1"),
    subReviewer: binding("p1", "接口一", "m1"),
    integrationReviewer: binding("p1", "接口一", "m1"),
    ...overrides,
  };
}

test("ROLE_FIELDS：顺序是编排、执行、子审核、集成审核", () => {
  assert.deepEqual(ROLE_FIELDS.map((field) => field.kind), [
    "orchestrator",
    "executor",
    "sub-reviewer",
    "integration-reviewer",
  ]);
  assert.deepEqual(ROLE_FIELDS.map((field) => field.key), [
    "orchestrator",
    "executor",
    "subReviewer",
    "integrationReviewer",
  ]);
  for (const field of ROLE_FIELDS) {
    assert.ok(field.label.length > 0);
    assert.ok(field.hint.length > 0);
  }
});

test("roleTeamComplete：四个角色都有接口和模型才算完整", () => {
  assert.equal(roleTeamComplete(team()), true);
  assert.equal(roleTeamComplete(undefined), false);
  assert.equal(roleTeamComplete(team({ executor: binding("", "接口一", "m1") })), false);
  assert.equal(roleTeamComplete(team({ subReviewer: binding("p1", "接口一", "  ") })), false);
  assert.equal(roleTeamComplete(team({ integrationReviewer: binding("p1", "接口一", "") })), false);
});

test("roleTeamDefaults：服务端保留团队优先，其次设置默认，最后会话当前模型", () => {
  const providers = [provider("p1", "接口一", ["m1"]), provider("p2", "接口二", ["m2"])];
  const fallback = { providerId: "p1", model: "m1", effort: "low" as const };
  const runTeam = team({ orchestrator: binding("p2", "接口二", "m2", "max") });
  const settingsTeam = team({ executor: binding("p2", "接口二", "m2", "high") });

  // runTeam 完整时整队采用，设置默认不参与。
  const fromRun = roleTeamDefaults(runTeam, settingsTeam, providers, fallback);
  assert.deepEqual(fromRun, runTeam);
  assert.notEqual(fromRun.orchestrator, runTeam.orchestrator);
  assert.equal(fromRun.executor.model, "m1");

  // runTeam 不完整时退回设置默认团队。
  const incompleteRun = team({ integrationReviewer: binding("", "", "") });
  const fromSettings = roleTeamDefaults(incompleteRun, settingsTeam, providers, fallback);
  assert.deepEqual(fromSettings, settingsTeam);
  assert.notEqual(fromSettings.executor, settingsTeam.executor);

  // 两者都缺失时四行都用会话当前的接口/模型/effort。
  const fromFallback = roleTeamDefaults(undefined, undefined, providers, fallback);
  for (const field of ROLE_FIELDS) {
    assert.deepEqual(fromFallback[field.key], {
      providerId: "p1",
      providerName: "接口一",
      model: "m1",
      effort: "low",
    });
  }
});

test("defaultRoleTeam：设置页团队完整时深拷贝原值", () => {
  const settingsTeam = team({ executor: binding("p2", "接口二", "m2", "high") });
  const result = defaultRoleTeam(settingsTeam, [provider("p1", "接口一", ["m1", "m9"])], {
    providerId: "p1",
    model: "m1",
    effort: "low",
  });
  assert.deepEqual(result, settingsTeam);
  // 不是同一批对象：弹窗里改行不会污染设置页的默认值。
  assert.notEqual(result.orchestrator, settingsTeam.orchestrator);
  assert.notEqual(result.executor, settingsTeam.executor);
});

test("defaultRoleTeam：设置缺失时不完整时四个角色都用会话当前模型", () => {
  const providers = [provider("p1", "接口一", ["m1", "m2"])];
  const result = defaultRoleTeam(undefined, providers, {
    providerId: "p1",
    model: "m2",
    effort: "xhigh",
  });
  for (const field of ROLE_FIELDS) {
    assert.deepEqual(result[field.key], {
      providerId: "p1",
      providerName: "接口一",
      model: "m2",
      effort: "xhigh",
    });
  }
  // 四行是独立对象，改一行不会连带其它角色。
  result.executor.model = "m1";
  assert.equal(result.orchestrator.model, "m2");

  // 设置里的团队不完整（缺模型）时也按回退处理。
  const incomplete = defaultRoleTeam(team({ executor: binding("", "", "") }), providers, {
    providerId: "p1",
    model: "m2",
    effort: "low",
  });
  assert.equal(incomplete.executor.providerId, "p1");
  assert.equal(incomplete.executor.model, "m2");
});

test("defaultRoleTeam：回退的接口或模型不存在时用第一个接口的第一个模型", () => {
  const providers = [provider("p1", "接口一", ["m1", "m2"]), provider("p2", "接口二", ["n1"])];
  const result = defaultRoleTeam(undefined, providers, {
    providerId: "gone",
    model: "nope",
    effort: "high",
  });
  assert.deepEqual(result.orchestrator, {
    providerId: "p1",
    providerName: "接口一",
    model: "m1",
    effort: "high",
  });

  const badModel = defaultRoleTeam(undefined, providers, {
    providerId: "p2",
    model: "missing",
    effort: "max",
  });
  assert.deepEqual(badModel.executor, {
    providerId: "p1",
    providerName: "接口一",
    model: "m1",
    effort: "max",
  });
});

test("defaultRoleTeam：没有任何接口时保留会话当前的接口和模型", () => {
  const result = defaultRoleTeam(undefined, [], {
    providerId: "p1",
    model: "m1",
    effort: "medium",
  });
  for (const field of ROLE_FIELDS) {
    assert.deepEqual(result[field.key], {
      providerId: "p1",
      providerName: "",
      model: "m1",
      effort: "medium",
    });
  }
});

test("roleRunStatusText：setup、运行中、完成、失败、停止", () => {
  const base = { phase: "setup" as const, units: [], round: 0, maxRounds: 3 };
  assert.equal(roleRunStatusText(base), "选择角色团队后开始");

  assert.equal(
    roleRunStatusText({
      ...base,
      phase: "running",
      round: 2,
      activeUnit: 3,
      activeRole: "executor",
      activeTool: "Edit",
    }),
    "单元 3 · 第 2 轮 · 执行中 · Edit",
  );
  assert.equal(
    roleRunStatusText({ ...base, phase: "running", integrating: true, round: 1, activeRole: "integration-reviewer" }),
    "集成审核 · 第 1 轮",
  );
  assert.equal(roleRunStatusText({ ...base, phase: "running" }), "运行中");

  assert.equal(roleRunStatusText({ ...base, phase: "completed" }), "运行完成");
  assert.equal(roleRunStatusText({ ...base, phase: "completed", agreed: false }), "运行完成 · 集成审核未通过");
  assert.equal(roleRunStatusText({ ...base, phase: "failed", error: "上游超时" }), "运行失败：上游超时");
  assert.equal(roleRunStatusText({ ...base, phase: "failed" }), "运行失败");
  assert.equal(roleRunStatusText({ ...base, phase: "stopped" }), "已停止");
});

test("roleUnitStatusText：各阶段文案", () => {
  assert.equal(roleUnitStatusText({ index: 1, title: "单元", phase: "pending", round: 0 }), "待处理");
  assert.equal(roleUnitStatusText({ index: 1, title: "单元", phase: "running", round: 1 }), "运行中");
  assert.equal(roleUnitStatusText({ index: 1, title: "单元", phase: "running", round: 2 }), "第 2 轮运行中");
  assert.equal(roleUnitStatusText({ index: 1, title: "单元", phase: "passed", round: 1 }), "已通过");
  assert.equal(
    roleUnitStatusText({ index: 1, title: "单元", phase: "needs_attention", round: 3, verdict: "changes" }),
    "需要修改",
  );
  assert.equal(
    roleUnitStatusText({ index: 1, title: "单元", phase: "needs_attention", round: 3 }),
    "待关注",
  );
  assert.equal(roleUnitStatusText({ index: 1, title: "单元", phase: "stopped", round: 1 }), "已停止");
});
