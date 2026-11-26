import { createHash } from "node:crypto";

import { EdgeError } from "./types.js";

/**
 * 确定性 JSON：对象键按字典序（JS 默认 UTF-16 code unit）排序，数组保持顺序。
 *
 * 用途：注册表/计划状态做指纹时，不能受对象字面量键顺序影响；也不能把
 * NaN/Infinity 写进 JSON（JSON.stringify 会输出 null，导致指纹不唯一）。
 * - undefined 的对象属性会被跳过；
 * - undefined 的数组元素写成 null（与 JSON 语义一致）；
 * - -0 归一化为 0。
 *
 * 浮点数按 JSON.stringify 的 ES 数字格式输出（与引擎一致、跨平台稳定）；
 * 不做本地化或时间格式化。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$"));
}

function canonicalize(value: unknown, where: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new EdgeError(`canonicalJson: ${where} 不是有限数字`);
      }
      return Object.is(value, -0) ? 0 : value;
    case "undefined":
      return undefined;
    case "object":
      break;
    default:
      throw new EdgeError(`canonicalJson: ${where} 包含不支持的值类型 ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const normalized = canonicalize(item, `${where}[${index}]`);
      return normalized === undefined ? null : normalized;
    });
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const normalized = canonicalize(record[key], `${where}.${key}`);
    if (normalized === undefined) continue;
    out[key] = normalized;
  }
  return out;
}

/** sha256 十六进制小写；接受字符串（UTF-8）或 Buffer。 */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 对任意值做确定性 sha256。 */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
