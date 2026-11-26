#!/usr/bin/env node
// 极简模板渲染：把 {{NAME}} 替换成环境变量 NAME，缺少变量直接失败。
// 用法：node render.mjs <模板> <输出>
import fs from "node:fs";

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error("用法：render.mjs <模板> <输出>");
  process.exit(2);
}

let text = fs.readFileSync(src, "utf8");
const missing = new Set();
text = text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, name) => {
  if (!(name in process.env)) {
    missing.add(name);
    return "";
  }
  return process.env[name];
});

if (missing.size > 0) {
  console.error(`缺少模板变量：${[...missing].sort().join(", ")}`);
  process.exit(1);
}

fs.writeFileSync(dst, text, { mode: 0o644 });
