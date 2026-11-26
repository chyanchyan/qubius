import assert from "node:assert/strict";
import test from "node:test";
import { queueEntryPreview, queueSummary } from "./queue-view";

test("排队预览取第一行，纯图片和空消息有占位", () => {
  assert.equal(queueEntryPreview({ text: "第一行\n第二行", images: 0 }), "第一行");
  assert.equal(queueEntryPreview({ text: "  \n第二行", images: 2 }), "（图片）");
  assert.equal(queueEntryPreview({ text: "", images: 0 }), "（空消息）");
});

test("排队标题带条数", () => {
  assert.equal(queueSummary(3), "排队 3 条");
  assert.equal(queueSummary(0), "没有排队消息");
});
