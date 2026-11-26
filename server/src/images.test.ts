import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyImageRefs,
  findImage,
  ImageInputError,
  imageFilePath,
  parseIncomingImages,
  readSavedImages,
  removeSessionImages,
  saveImages,
} from "./images.js";
import type { SessionCore } from "./types.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("test"),
]);

function pngPayload(extra: Record<string, unknown> = {}) {
  return { mediaType: "image/png", data: PNG.toString("base64"), name: "shot.png", ...extra };
}

test("没有 images 字段时返回空数组", () => {
  assert.deepEqual(parseIncomingImages(undefined), []);
  assert.deepEqual(parseIncomingImages(null), []);
});

test("解析有效的 base64 图片", () => {
  const parsed = parseIncomingImages([pngPayload()]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.mediaType, "image/png");
  assert.equal(parsed[0]?.name, "shot.png");
  assert.ok(parsed[0]?.data.equals(PNG));
});

test("拒绝不支持的格式和非 base64 内容", () => {
  assert.throws(() => parseIncomingImages([pngPayload({ mediaType: "image/svg+xml" })]), ImageInputError);
  assert.throws(() => parseIncomingImages([pngPayload({ data: "not base64!" })]), ImageInputError);
  assert.throws(() => parseIncomingImages([pngPayload({ data: "" })]), ImageInputError);
});

test("图片内容和声明的格式不一致时报错", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.throws(
    () => parseIncomingImages([pngPayload({ data: jpeg.toString("base64") })]),
    ImageInputError,
  );
});

test("一条消息最多四张图片", () => {
  const many = Array.from({ length: 5 }, () => pngPayload());
  assert.throws(() => parseIncomingImages(many), ImageInputError);
});

test("保存后可以按会话和 id 找到，删除会话时清掉目录", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-images-"));
  try {
    const sessionId = randomUUID();
    const refs = saveImages(dataDir, sessionId, parseIncomingImages([pngPayload()]));
    assert.equal(refs.length, 1);
    const ref = refs[0];
    assert.ok(ref);
    const file = imageFilePath(dataDir, sessionId, ref);
    assert.ok(file);
    assert.ok(fs.existsSync(file));

    const session = {
      messages: [{ id: "m1", role: "user", text: "", images: refs }],
    } as unknown as SessionCore;
    assert.equal(findImage(session, ref.id)?.id, ref.id);
    assert.equal(findImage(session, "../etc/passwd"), undefined);

    removeSessionImages(dataDir, sessionId);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("会话 id 不能跳出图片目录", () => {
  assert.equal(imageFilePath("/tmp/data", "../../etc", { id: randomUUID(), mediaType: "image/png" }), undefined);
});

test("copyImageRefs 复制图片，跳过已存在和源缺失的项", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-images-copy-"));
  try {
    const from = randomUUID();
    const to = randomUUID();
    const refs = saveImages(dataDir, from, parseIncomingImages([pngPayload()]));
    const ref = refs[0];
    assert.ok(ref);

    copyImageRefs(dataDir, from, to, refs);
    const dest = imageFilePath(dataDir, to, ref);
    assert.ok(dest);
    assert.ok(fs.existsSync(dest));
    assert.ok(fs.readFileSync(dest).equals(PNG));

    // 目标已存在：重复调用不报错、内容保持不变。
    copyImageRefs(dataDir, from, to, refs);
    assert.ok(fs.existsSync(dest));

    // 源缺失：跳过，不创建目标文件。
    const missingId = randomUUID();
    const missingRef = { id: missingId, mediaType: "image/png" as const };
    const otherTarget = randomUUID();
    copyImageRefs(dataDir, from, otherTarget, [missingRef]);
    assert.equal(
      fs.existsSync(path.join(dataDir, "images", otherTarget, `${missingId}.png`)),
      false,
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("readSavedImages 读取已保存图片，缺失或非法引用抛错", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-images-read-"));
  try {
    const sessionId = randomUUID();
    const refs = saveImages(dataDir, sessionId, parseIncomingImages([pngPayload()]));
    const ref = refs[0];
    assert.ok(ref);
    const images = readSavedImages(dataDir, sessionId, [ref]);
    assert.equal(images.length, 1);
    assert.equal(images[0]?.mediaType, "image/png");
    assert.ok(images[0]?.data.equals(PNG));
    assert.equal(images[0]?.name, "shot.png");

    assert.throws(
      () => readSavedImages(dataDir, sessionId, [{ id: randomUUID(), mediaType: "image/png" }]),
      ImageInputError,
    );
    assert.throws(
      () => readSavedImages(dataDir, sessionId, [{ id: "../x", mediaType: "image/png" }]),
      ImageInputError,
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
