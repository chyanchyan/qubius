#!/usr/bin/env node
// 写入 server/dist/build.json：顶栏和部署页显示的版本号优先读这里。
//
// `npm run build`（quickstart、make build、deploy/cli.mjs 首次启动）都会调用，
// 避免沿用上一次部署留下的旧 build.json——否则升级后重新构建，页面仍显示旧版本。
// build.sh / deploy-job.mjs 在 staging 构建里写同样的字段。
//
// 用法：node deploy/build-info.mjs [仓库目录]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// 与 deploy/build.sh 一致：只接受 semver 里的安全字符，避免异常值写坏 build.json。
const VERSION_RE = /^[0-9A-Za-z.+-]+$/;

function git(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
}

/** 构建时的提交完整 sha；不是 git 仓库或 git 不可用时返回空串。 */
export function gitHead(repo) {
  const result = git(repo, ["rev-parse", "HEAD"]);
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

/**
 * 构建输入里是否有未提交改动（未跟踪的新文件也算）。
 * 与 deploy/lib.sh 的 qubius_build_status、deploy-lib.mjs 的 buildDirtyStatus 保持一致：
 * 只有 server/web/package.json/package-lock.json 算，文档和部署脚本改动不影响。
 */
export function gitDirty(repo) {
  const result = git(repo, [
    "status", "--porcelain", "--untracked-files=normal", "--",
    "server", "web", "package.json", "package-lock.json",
    ":(exclude)server/dist.next",
    ":(exclude)server/dist.prev",
    ":(exclude)web/dist.next",
    ":(exclude)web/dist.prev",
    ":(exclude)dist.next",
    ":(exclude)dist.prev",
  ]);
  return result.status === 0 && Boolean((result.stdout ?? "").trim());
}

/** 仓库根 package.json 的版本号；读不到或格式异常时退回 0.0.0，不阻断构建。 */
export function packageVersion(repo) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    const version = parsed && typeof parsed.version === "string" ? parsed.version.trim() : "";
    return VERSION_RE.test(version) ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildInfo(repo, now = new Date()) {
  return {
    head: gitHead(repo),
    version: packageVersion(repo),
    builtAt: now.toISOString(),
    dirty: gitDirty(repo),
  };
}

/** 原子写入 server/dist/build.json，返回写入内容和目标路径。 */
export function writeBuildInfo(repo, now = new Date()) {
  const info = buildInfo(repo, now);
  const dir = path.join(repo, "server", "dist");
  const target = path.join(dir, "build.json");
  fs.mkdirSync(dir, { recursive: true });
  // 临时文件 + rename，避免并发读到半截 JSON。
  const tmp = path.join(dir, `.build.json.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(info)}\n`);
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return { info, target };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const repo = path.resolve(process.argv[2] ?? process.cwd());
  if (!fs.existsSync(path.join(repo, "package.json"))) {
    console.error(`[build-info] 不是 qubius 仓库（缺少 package.json）：${repo}`);
    process.exitCode = 1;
  } else {
    const { info, target } = writeBuildInfo(repo);
    console.log(
      `[build-info] 已写入 ${target}：version=${info.version} head=${info.head || "未知"} dirty=${info.dirty}`,
    );
  }
}
