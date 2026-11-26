import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ImageMediaType, ImageRef, SessionCore } from "./types.js";

export const MAX_IMAGES = 4;
/** 单张图片解码后的大小上限。客户端会先压缩，这里只是最后一道防线。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXTENSIONS: Record<ImageMediaType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

const IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ImageInputError extends Error {}

export interface IncomingImage {
  mediaType: ImageMediaType;
  data: Buffer;
  /** 解析时保留的原始 base64（已去空白），下发给 agent 时直接复用，避免二次编码。 */
  base64?: string;
  name?: string;
}

export function isImageMediaType(value: unknown): value is ImageMediaType {
  return typeof value === "string" && Object.hasOwn(EXTENSIONS, value);
}

/** 校验 API 请求里的图片，返回解码后的字节。 */
export function parseIncomingImages(value: unknown): IncomingImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ImageInputError("images 必须是数组");
  if (value.length > MAX_IMAGES) throw new ImageInputError(`一条消息最多 ${MAX_IMAGES} 张图片`);
  return value.map((item, index) => {
    const label = `第 ${index + 1} 张图片`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ImageInputError(`${label}格式无效`);
    }
    const record = item as Record<string, unknown>;
    const mediaType = record.mediaType;
    if (!isImageMediaType(mediaType)) {
      throw new ImageInputError(`${label}只支持 JPEG、PNG、GIF、WebP`);
    }
    const encoded = typeof record.data === "string" ? record.data.replace(/\s+/g, "") : "";
    if (!encoded) throw new ImageInputError(`${label}缺少内容`);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new ImageInputError(`${label}不是有效的 base64`);
    }
    const data = Buffer.from(encoded, "base64");
    if (data.length === 0) throw new ImageInputError(`${label}缺少内容`);
    if (data.length > MAX_IMAGE_BYTES) {
      throw new ImageInputError(`${label}超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`);
    }
    if (!matchesMagic(data, mediaType)) {
      throw new ImageInputError(`${label}的内容和格式不一致`);
    }
    const name = typeof record.name === "string" ? record.name.trim().slice(0, 120) : "";
    return { mediaType, data, base64: encoded, name: name || undefined };
  });
}

export function saveImages(dataDir: string, sessionId: string, images: IncomingImage[]): ImageRef[] {
  if (images.length === 0) return [];
  const dir = sessionImageDir(dataDir, sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return images.map((image) => {
    const id = randomUUID();
    fs.writeFileSync(path.join(dir, `${id}.${EXTENSIONS[image.mediaType]}`), image.data, { mode: 0o600 });
    return { id, mediaType: image.mediaType, name: image.name };
  });
}

export function imageFilePath(dataDir: string, sessionId: string, image: ImageRef): string | undefined {
  if (!IMAGE_ID_RE.test(image.id) || !isImageMediaType(image.mediaType)) return undefined;
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) return undefined;
  return path.join(sessionImageDir(dataDir, sessionId), `${image.id}.${EXTENSIONS[image.mediaType]}`);
}

export function findImage(session: SessionCore, imageId: string): ImageRef | undefined {
  if (!IMAGE_ID_RE.test(imageId)) return undefined;
  for (const item of session.messages) {
    const image = item.images?.find((candidate) => candidate.id === imageId);
    if (image) return image;
  }
  return undefined;
}

export function removeSessionImages(dataDir: string, sessionId: string): void {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) return;
  fs.rmSync(sessionImageDir(dataDir, sessionId), { recursive: true, force: true });
}

/**
 * 把源会话的图片复制到新会话目录（分叉用）。同名同扩展名；目标已存在或
 * 源文件缺失时跳过，不抛错，避免一张坏图片让整个分叉失败。
 */
export function copyImageRefs(
  dataDir: string,
  fromSessionId: string,
  toSessionId: string,
  refs: readonly ImageRef[],
): void {
  let dirReady = false;
  for (const ref of refs) {
    const source = imageFilePath(dataDir, fromSessionId, ref);
    const dest = imageFilePath(dataDir, toSessionId, ref);
    if (!source || !dest || !fs.existsSync(source) || fs.existsSync(dest)) continue;
    if (!dirReady) {
      fs.mkdirSync(sessionImageDir(dataDir, toSessionId), { recursive: true, mode: 0o700 });
      dirReady = true;
    }
    try {
      fs.copyFileSync(source, dest);
      fs.chmodSync(dest, 0o600);
    } catch (error) {
      // 单张复制失败不影响其余图片；引用仍指向缺失文件时由读取端兜底。
      console.warn(`[images] 无法复制图片 ${source} -> ${dest}:`, error);
    }
  }
}

/**
 * 读取源会话里已保存的图片（编辑重发用）。文件缺失、引用非法或内容与
 * 声明的格式不一致时抛 ImageInputError，HTTP 层转 400。
 */
export function readSavedImages(
  dataDir: string,
  sessionId: string,
  refs: readonly ImageRef[],
): IncomingImage[] {
  if (refs.length > MAX_IMAGES) throw new ImageInputError(`一条消息最多 ${MAX_IMAGES} 张图片`);
  return refs.map((ref, index) => {
    const label = `第 ${index + 1} 张图片`;
    const file = imageFilePath(dataDir, sessionId, ref);
    if (!file) throw new ImageInputError(`${label}引用无效`);
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch {
      throw new ImageInputError("原消息的图片已不存在");
    }
    if (data.length === 0) throw new ImageInputError(`${label}内容为空`);
    if (data.length > MAX_IMAGE_BYTES) {
      throw new ImageInputError(`${label}超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`);
    }
    if (!matchesMagic(data, ref.mediaType)) {
      throw new ImageInputError(`${label}的内容和格式不一致`);
    }
    return {
      mediaType: ref.mediaType,
      data,
      base64: data.toString("base64"),
      name: ref.name,
    };
  });
}

function sessionImageDir(dataDir: string, sessionId: string): string {
  return path.join(dataDir, "images", sessionId);
}

function matchesMagic(data: Buffer, mediaType: ImageMediaType): boolean {
  switch (mediaType) {
    case "image/jpeg":
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case "image/png":
      return data.length >= 8
        && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
        && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
    case "image/gif": {
      const head = data.subarray(0, 6).toString("latin1");
      return head === "GIF87a" || head === "GIF89a";
    }
    case "image/webp":
      return data.length >= 12
        && data.subarray(0, 4).toString("latin1") === "RIFF"
        && data.subarray(8, 12).toString("latin1") === "WEBP";
  }
}
