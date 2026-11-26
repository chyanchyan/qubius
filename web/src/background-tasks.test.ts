import assert from "node:assert/strict";
import test from "node:test";
import type { BackgroundTask } from "./api";
import {
  countTasks,
  isTaskActive,
  latestTaskLine,
  parseTaskProgress,
  sortTasksForDisplay,
  taskDisplayName,
  taskDurationMs,
  taskStatusLabel,
  TASK_POLL_MS,
} from "./background-tasks";

function task(overrides: Partial<BackgroundTask> & Pick<BackgroundTask, "taskId">): BackgroundTask {
  const { taskId, ...rest } = overrides;
  return {
    taskId,
    taskType: "local_bash",
    description: "sleep 10",
    status: "running",
    isBackgrounded: true,
    startedAt: "2026-01-02T03:04:05.000Z",
    ...rest,
  };
}

test("轮询间隔是 1 秒", () => {
  assert.equal(TASK_POLL_MS, 1000);
});

test("isTaskActive 只把 running 视为进行中", () => {
  assert.equal(isTaskActive(task({ taskId: "a", status: "running" })), true);
  assert.equal(isTaskActive(task({ taskId: "a", status: "completed" })), false);
  assert.equal(isTaskActive(task({ taskId: "a", status: "failed" })), false);
  assert.equal(isTaskActive(task({ taskId: "a", status: "stopped" })), false);
});

test("countTasks 分别统计运行中、已完成和失败", () => {
  const tasks = [
    task({ taskId: "run-a", status: "running" }),
    task({ taskId: "run-b", status: "running" }),
    task({ taskId: "done", status: "completed" }),
    task({ taskId: "bad", status: "failed" }),
    task({ taskId: "stop", status: "stopped" }),
  ];
  assert.deepEqual(countTasks(tasks), { running: 2, completed: 1, failed: 1 });
});

test("countTasks 空列表全为 0", () => {
  assert.deepEqual(countTasks([]), { running: 0, completed: 0, failed: 0 });
});

test("latestTaskLine 清理 ANSI 颜色和光标转义", () => {
  assert.equal(latestTaskLine("\x1b[31m红色\x1b[0m 文本"), "红色 文本");
  assert.equal(latestTaskLine("\x1b[2K\x1b[1G正在下载"), "正在下载");
  // OSC 标题序列：ESC ] ... BEL
  assert.equal(latestTaskLine("\x1b]0;标题\x07内容"), "内容");
  // OSC 也可以用 ST（ESC \）终止
  assert.equal(latestTaskLine("\x1b]0;标题\x1b\\内容"), "内容");
  // 字符集切换：ESC ( B
  assert.equal(latestTaskLine("\x1b(Bplain"), "plain");
});

test("latestTaskLine 按 \\r 原地刷新取最后一段（curl 式）", () => {
  assert.equal(latestTaskLine("  1%\r 10%\r 50%\r100%"), "100%");
  assert.equal(latestTaskLine("下载中\r\x1b[2K完成"), "完成");
});

test("latestTaskLine 跳过末尾空行和纯空白行", () => {
  assert.equal(latestTaskLine("第一行\n第二行\n\n   \n"), "第二行");
  assert.equal(latestTaskLine("  只有一行  \n"), "只有一行");
  assert.equal(latestTaskLine(""), "");
  assert.equal(latestTaskLine("\n \r\n\t"), "");
});

test("parseTaskProgress 解析 wget 式进度行", () => {
  const output = "下载中\n100%[===================>] 1.02M  1.20MB/s  用时 1s";
  assert.deepEqual(parseTaskProgress(output), {
    percent: 100,
    line: "100%[===================>] 1.02M  1.20MB/s  用时 1s",
  });
});

test("parseTaskProgress 解析 curl 的 \\r 刷新进度", () => {
  assert.deepEqual(parseTaskProgress(" 0.0%\r 42.5%\r 99.9%"), {
    percent: 99.9,
    line: "99.9%",
  });
});

test("parseTaskProgress 没有百分比时只返回最后一行（pip 式）", () => {
  assert.deepEqual(parseTaskProgress("Collecting numpy\nDownloading numpy-2.0.whl"), {
    line: "Downloading numpy-2.0.whl",
  });
  assert.deepEqual(parseTaskProgress("100  1024  100"), { line: "100  1024  100" });
  assert.deepEqual(parseTaskProgress(""), { line: "" });
});

test("parseTaskProgress 百分比边界：0、100、小数、逗号小数", () => {
  assert.equal(parseTaskProgress("0%").percent, 0);
  assert.equal(parseTaskProgress("100%").percent, 100);
  assert.equal(parseTaskProgress("100.0%").percent, 100);
  assert.equal(parseTaskProgress("42.5%").percent, 42.5);
  assert.equal(parseTaskProgress("42,5%").percent, 42.5);
});

test("parseTaskProgress 越界或非法百分比不返回 percent", () => {
  assert.equal(parseTaskProgress("120%").percent, undefined);
  assert.equal(parseTaskProgress("-5%").percent, undefined);
  assert.equal(parseTaskProgress("1.2.3%").percent, undefined);
});

test("parseTaskProgress 多段百分比取最后一个", () => {
  assert.equal(parseTaskProgress("10% 50% 100%").percent, 100);
  assert.equal(parseTaskProgress("10%20%").percent, 20);
  assert.equal(parseTaskProgress("curl: 100%  1024  100%").percent, 100);
  // 最后一个越界时继续往前找范围内（0–100）的合法值。
  assert.equal(parseTaskProgress("50% 120%").percent, 50);
  assert.equal(parseTaskProgress("120%").percent, undefined);
});

test("taskDurationMs：正常、缺 endedAt、非法时间、负值", () => {
  const startedAt = "2026-01-02T03:04:05.000Z";
  const start = Date.parse(startedAt);
  assert.equal(taskDurationMs(task({ taskId: "a", startedAt, endedAt: "2026-01-02T03:04:09.000Z" }), 0), 4000);
  assert.equal(taskDurationMs(task({ taskId: "a", startedAt }), start + 2500), 2500);
  assert.equal(taskDurationMs(task({ taskId: "a", startedAt: "not-a-date" }), start + 2500), 0);
  assert.equal(
    taskDurationMs(task({ taskId: "a", startedAt, endedAt: "not-a-date" }), start + 3000),
    3000,
    "endedAt 非法时回退到 now",
  );
  assert.equal(taskDurationMs(task({ taskId: "a", startedAt, endedAt: "2026-01-02T03:04:01.000Z" }), 0), 0);
});

test("taskDisplayName：空描述回退到「后台任务」", () => {
  assert.equal(taskDisplayName(task({ taskId: "a", description: "  npm install  " })), "npm install");
  assert.equal(taskDisplayName(task({ taskId: "a", description: "   " })), "后台任务");
  assert.equal(taskDisplayName(task({ taskId: "a", description: "" })), "后台任务");
});

test("taskStatusLabel 给出中文状态", () => {
  assert.equal(taskStatusLabel("running"), "进行中");
  assert.equal(taskStatusLabel("completed"), "完成");
  assert.equal(taskStatusLabel("failed"), "失败");
  assert.equal(taskStatusLabel("stopped"), "已停止");
});

test("sortTasksForDisplay：running 优先，同状态按开始时间从新到旧", () => {
  const older = task({ taskId: "older", status: "running", startedAt: "2026-01-02T03:00:00.000Z" });
  const newer = task({ taskId: "newer", status: "running", startedAt: "2026-01-02T04:00:00.000Z" });
  const doneOld = task({ taskId: "done-old", status: "completed", startedAt: "2026-01-02T01:00:00.000Z" });
  const doneNew = task({ taskId: "done-new", status: "completed", startedAt: "2026-01-02T05:00:00.000Z" });

  assert.deepEqual(
    sortTasksForDisplay([doneNew, older, doneOld, newer]).map((item) => item.taskId),
    ["newer", "older", "done-new", "done-old"],
  );
});

test("sortTasksForDisplay：非法/缺失 startedAt 排后，taskId 稳定兜底", () => {
  const valid = task({ taskId: "valid", startedAt: "2026-01-02T03:00:00.000Z" });
  const invalid = task({ taskId: "invalid", startedAt: "not-a-date" });
  const missing = task({ taskId: "missing", startedAt: "" });
  const tieA = task({ taskId: "tie-a", startedAt: "2026-01-02T03:00:00.000Z" });
  const tieB = task({ taskId: "tie-b", startedAt: "2026-01-02T03:00:00.000Z" });

  assert.deepEqual(
    sortTasksForDisplay([missing, invalid, tieB, valid, tieA]).map((item) => item.taskId),
    ["tie-a", "tie-b", "valid", "invalid", "missing"],
  );
});

test("sortTasksForDisplay 不修改原数组", () => {
  const first = task({ taskId: "first", status: "completed", startedAt: "2026-01-02T01:00:00.000Z" });
  const second = task({ taskId: "second", status: "running", startedAt: "2026-01-02T02:00:00.000Z" });
  const input = [first, second];
  const snapshot = [...input];

  const sorted = sortTasksForDisplay(input);

  assert.notEqual(sorted, input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(sorted.map((item) => item.taskId), ["second", "first"]);
});
