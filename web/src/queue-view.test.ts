import assert from "node:assert/strict";
import test from "node:test";
import { queueEntryPreview, queueSummary, willQueue } from "./queue-view";

test("排队预览取第一行，纯图片和空消息有占位", () => {
  assert.equal(queueEntryPreview({ text: "第一行\n第二行", images: 0 }), "第一行");
  assert.equal(queueEntryPreview({ text: "  \n第二行", images: 2 }), "（图片）");
  assert.equal(queueEntryPreview({ text: "", images: 0 }), "（空消息）");
});

test("排队标题带条数", () => {
  assert.equal(queueSummary(3), "排队 3 条");
  assert.equal(queueSummary(0), "没有排队消息");
});

test("willQueue：进行中或已有排队消息时默认排队，插话和空闲发送不排队", () => {
  assert.equal(willQueue({ phase: "running", queue: [] }, false), true);
  assert.equal(willQueue({ phase: "queued", queue: [] }, false), true);
  assert.equal(willQueue({ phase: "needs_input", queue: [] }, false), true);
  // 轮次刚落定但还有没被取走的消息：Enter 仍然是排队语义。
  assert.equal(willQueue({ phase: "completed", queue: [{ id: "q1", text: "x", images: 0, createdAt: "" }] }, false), true);
  assert.equal(willQueue({ phase: "running", queue: [] }, true), false);
  assert.equal(willQueue({ phase: "completed", queue: [] }, false), false);
});
