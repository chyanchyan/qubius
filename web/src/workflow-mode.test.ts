import assert from "node:assert/strict";
import test from "node:test";
import { detectWorkflowSkill, WORKFLOW_OPTIONS } from "./workflow-mode";

test("detectWorkflowSkill：识别末尾 prl/ser/plan/discuss/dis-prl 和斜杠命令", () => {
  assert.equal(detectWorkflowSkill("帮我实现 prl"), "prl");
  assert.equal(detectWorkflowSkill("帮我实现 prl。"), "prl");
  assert.equal(detectWorkflowSkill("实现PRL"), "prl");
  assert.equal(detectWorkflowSkill("做这个 ser"), "ser");
  assert.equal(detectWorkflowSkill("/plan 做个计划"), "plan");
  assert.equal(detectWorkflowSkill("（plan）"), "plan");
  assert.equal(detectWorkflowSkill("大家讨论一下 discuss"), "discuss");
  assert.equal(detectWorkflowSkill("/discuss 这个方案"), "discuss");
  assert.equal(detectWorkflowSkill("拆开并行讨论 dis-prl"), "dis-prl");
  assert.equal(detectWorkflowSkill("拆开并行讨论 DIS-PRL"), "dis-prl");
  assert.equal(detectWorkflowSkill("/dis-prl 这个方案"), "dis-prl");
  assert.equal(detectWorkflowSkill("帮我做这个 prl-role"), "prl-role");
  assert.equal(detectWorkflowSkill("帮我做这个 prl-role。"), "prl-role");
  assert.equal(detectWorkflowSkill("帮我做这个 PRL-ROLE"), "prl-role");
  assert.equal(detectWorkflowSkill("/prl-role 这个方案"), "prl-role");
});

test("detectWorkflowSkill：prl-role 不会退化成 prl", () => {
  assert.equal(detectWorkflowSkill("帮我实现 prl"), "prl");
  assert.equal(detectWorkflowSkill("用 prl-role 模式"), null);
  assert.equal(detectWorkflowSkill("prl-role"), "prl-role");
  assert.equal(detectWorkflowSkill("/prl"), "prl");
  assert.equal(detectWorkflowSkill("/prl-role"), "prl-role");
});

test("detectWorkflowSkill：不误判词内子串和英文 the plan", () => {
  assert.equal(detectWorkflowSkill("parser"), null);
  assert.equal(detectWorkflowSkill("super"), null);
  assert.equal(detectWorkflowSkill("the plan"), null);
  assert.equal(detectWorkflowSkill("review the plan"), null);
  assert.equal(detectWorkflowSkill("用 plan 模式"), null);
  assert.equal(detectWorkflowSkill(""), null);
});

test("detectWorkflowSkill：多个 token 取最后一个", () => {
  assert.equal(detectWorkflowSkill("prl ser"), "ser");
});

test("WORKFLOW_OPTIONS：普通在最前，六种工作流都可选", () => {
  assert.deepEqual(
    WORKFLOW_OPTIONS.map((option) => option.value),
    ["", "prl", "ser", "plan", "discuss", "dis-prl", "prl-role"],
  );
});

test("WORKFLOW_OPTIONS：每项都有说明，工作流项带强调色", () => {
  for (const option of WORKFLOW_OPTIONS) {
    assert.ok(option.description.length > 0);
    assert.equal(option.tone, option.value || undefined);
  }
});
