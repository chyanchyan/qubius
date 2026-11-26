import type { ImageMediaType, OutgoingImage } from "./api";

export const MAX_ATTACHMENTS = 4;
/** 和 Anthropic 建议的图片长边一致，避免手机原图直接上传。 */
const MAX_DIMENSION = 1568;
const MAX_KEEP_BYTES = 1.5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/** 在浏览器里缩放并转码，尽量让每张图小于服务器限制。 */
export async function prepareImage(file: File): Promise<OutgoingImage> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name} 不是图片`);
  if (file.size === 0) throw new Error(`${file.name} 是空文件`);
  if (file.type === "image/gif") {
    if (file.size > MAX_OUTPUT_BYTES) throw new Error("GIF 不能超过 5MB");
    return { mediaType: "image/gif", data: await blobToBase64(file), name: file.name };
  }
  const bitmap = await decode(file);
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) throw new Error(`${file.name} 尺寸无效`);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= MAX_KEEP_BYTES && isKeepType(file.type)) {
      return { mediaType: file.type, data: await blobToBase64(file), name: file.name };
    }
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持图片处理");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    let blob = await canvasToBlob(canvas, file.type === "image/png" ? "image/png" : "image/jpeg");
    if (!blob) throw new Error("图片编码失败");
    if (blob.type !== "image/jpeg" && blob.size > MAX_OUTPUT_BYTES) {
      blob = await canvasToBlob(canvas, "image/jpeg", 0.85);
    }
    if (!blob) throw new Error("图片编码失败");
    if (blob.size > MAX_OUTPUT_BYTES) throw new Error("图片压缩后仍然太大");
    return { mediaType: blob.type as ImageMediaType, data: await blobToBase64(blob), name: file.name };
  } finally {
    bitmap.close();
  }
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`${file.name} 无法读取，请换成 JPEG、PNG、GIF 或 WebP`);
  }
}

function isKeepType(type: string): type is ImageMediaType {
  return type === "image/jpeg" || type === "image/png" || type === "image/webp";
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
}
