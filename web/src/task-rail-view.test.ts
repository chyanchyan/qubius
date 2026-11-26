import assert from "node:assert/strict";
import test from "node:test";
import { taskRailTasks } from "./task-rail-view";

const tasks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test("任务数不超过上限时全部显示", () => {
  assert.deepEqual(taskRailTasks([1, 2, 3], false, 8), [1, 2, 3]);
  assert.deepEqual(taskRailTasks([1, 2, 3], false, 3), [1, 2, 3]);
});

test("超过上限时只显示前 max 条", () => {
  assert.deepEqual(taskRailTasks(tasks, false, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("展开后显示全部任务", () => {
  assert.deepEqual(taskRailTasks(tasks, true, 8), tasks);
});

test("收起后恢复截断", () => {
  assert.deepEqual(taskRailTasks(taskRailTasks(tasks, true, 8), false, 8), tasks.slice(0, 8));
});

test("空列表始终返回空数组", () => {
  assert.deepEqual(taskRailTasks([], false, 8), []);
  assert.deepEqual(taskRailTasks([], true, 8), []);
});

test("不修改入参并返回新数组", () => {
  const input = [1, 2, 3, 4];
  const limited = taskRailTasks(input, false, 2);
  const all = taskRailTasks(input, true, 2);
  assert.deepEqual(input, [1, 2, 3, 4]);
  assert.notEqual(limited, input);
  assert.notEqual(all, input);
});

test("非法上限按 0 或全部处理", () => {
  assert.deepEqual(taskRailTasks(tasks, false, -1), []);
  assert.deepEqual(taskRailTasks(tasks, false, Number.NaN), tasks);
});
