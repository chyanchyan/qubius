import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const REACT_PACKAGES = new Set(["react", "react-dom", "scheduler"]);

/* react-markdown/remark-gfm 及其运行时依赖只在对话页按需加载。列成固定的
   vendor chunk 后，首屏不请求它，升级 markdown 依赖也不会让 react 缓存失效。
   未列出的新增传递依赖会被 Rollup 放进动态 import 的异步 chunk，仍然按需。 */
const MARKDOWN_PACKAGES = new Set([
  "react-markdown",
  "unified",
  "bail",
  "trough",
  "ccount",
  "comma-separated-tokens",
  "decode-named-character-reference",
  "debug",
  "dequal",
  "devlop",
  "ms",
  "escape-string-regexp",
  "estree-util-is-identifier-name",
  "extend",
  "html-url-attributes",
  "inline-style-parser",
  "is-alphabetical",
  "is-alphanumerical",
  "is-decimal",
  "is-hexadecimal",
  "is-plain-obj",
  "longest-streak",
  "markdown-table",
  "parse-entities",
  "property-information",
  "space-separated-tokens",
  "stringify-entities",
  "style-to-object",
  "trim-lines",
  "zwitch",
  "@ungap/structured-clone",
]);

const MARKDOWN_PREFIXES = ["remark-", "mdast-", "micromark", "hast-", "unist-", "vfile", "character-"];

function packageName(id: string): string | undefined {
  return id
    .replace(/\\/g, "/")
    .match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const name = packageName(id);
          if (!name) return;
          if (REACT_PACKAGES.has(name)) return "react-vendor";
          if (MARKDOWN_PACKAGES.has(name) || MARKDOWN_PREFIXES.some((prefix) => name.startsWith(prefix))) {
            return "markdown";
          }
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
});
