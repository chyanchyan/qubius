import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareVersions,
  fetchGithubVersion,
  githubRepoFromRemote,
  resolveGithubRepo,
} from "./github-version.js";

const ENV_KEY = "QUBIUS_GITHUB_REPO";

function withRepoEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  return fn().finally(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });
}

function tempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qubius-github-version-"));
}

test("从 SSH / HTTPS remote 解析 owner/repo", () => {
  assert.equal(githubRepoFromRemote("git@github.com:chyanchyan/qubius.git"), "chyanchyan/qubius");
  assert.equal(githubRepoFromRemote("ssh://git@github.com/chyanchyan/qubius.git"), "chyanchyan/qubius");
  assert.equal(githubRepoFromRemote("https://github.com/chyanchyan/qubius.git"), "chyanchyan/qubius");
  assert.equal(githubRepoFromRemote("https://user:token@github.com/chyanchyan/qubius"), "chyanchyan/qubius");
  assert.equal(githubRepoFromRemote("git@gitlab.com:chyanchyan/qubius.git"), undefined);
  assert.equal(githubRepoFromRemote("not a remote"), undefined);
});

test("版本比较覆盖相等、新旧和预发布", () => {
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.ok(compareVersions("0.1.0", "0.2.0")! < 0);
  assert.ok(compareVersions("1.0.0", "0.9.9")! > 0);
  assert.ok(compareVersions("0.1.0-beta.1", "0.1.0")! < 0);
  assert.equal(compareVersions("0.1", "0.1.0"), undefined);
  assert.equal(compareVersions("abc", "0.1.0"), undefined);
});

test("GitHub 版本落后 / 一致 / 更新都能识别", async () => {
  await withRepoEnv("chyanchyan/qubius", async () => {
    const dir = tempRepo();
    const makeFetch = (version: string) => (async () => new Response(JSON.stringify({ version }), { status: 200 })) as typeof fetch;

    const behind = await fetchGithubVersion({ repoRoot: dir, current: "0.2.0", fetchImpl: makeFetch("0.1.0") });
    assert.equal(behind.repo, "chyanchyan/qubius");
    assert.equal(behind.version, "0.1.0");
    assert.equal(behind.current, "0.2.0");
    assert.equal(behind.status, "behind");

    const same = await fetchGithubVersion({ repoRoot: dir, current: "0.1.0", fetchImpl: makeFetch("0.1.0") });
    assert.equal(same.status, "same");

    const ahead = await fetchGithubVersion({ repoRoot: dir, current: "0.1.0", fetchImpl: makeFetch("0.2.0") });
    assert.equal(ahead.status, "ahead");
  });
});

test("拉取失败时返回 error 而不是抛错", async () => {
  await withRepoEnv("chyanchyan/qubius", async () => {
    const dir = tempRepo();
    const httpError = await fetchGithubVersion({
      repoRoot: dir,
      current: "0.1.0",
      fetchImpl: (async () => new Response("missing", { status: 404 })) as typeof fetch,
    });
    assert.equal(httpError.error, "GitHub 返回 HTTP 404");
    assert.equal(httpError.status, "unknown");

    const networkError = await fetchGithubVersion({
      repoRoot: dir,
      current: "0.1.0",
      fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
    });
    assert.equal(networkError.error, "无法连接 GitHub");

    const badJson = await fetchGithubVersion({
      repoRoot: dir,
      current: "0.1.0",
      fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch,
    });
    assert.equal(badJson.error, "GitHub 返回的内容无法解析");

    const noVersion = await fetchGithubVersion({
      repoRoot: dir,
      current: "0.1.0",
      fetchImpl: (async () => new Response(JSON.stringify({ name: "x" }), { status: 200 })) as typeof fetch,
    });
    assert.equal(noVersion.error, "GitHub 镜像里没有版本号");
  });
});

test("QUBIUS_GITHUB_REPO 接受完整 GitHub URL", () => {
  assert.equal(
    resolveGithubRepo(tempRepo(), {
      QUBIUS_GITHUB_REPO: "https://github.com/chyanchyan/qubius.git",
    }),
    "chyanchyan/qubius",
  );
});

test("没有名为 github 的 remote 时回退到 origin / 其它 github 地址", () => {
  const dir = tempRepo();
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:chyanchyan/qubius.git"]);
  assert.equal(resolveGithubRepo(dir, {}), "chyanchyan/qubius");

  // 名为 github 的 remote 优先于 origin。
  execFileSync("git", ["-C", dir, "remote", "add", "github", "https://github.com/other/mirror.git"]);
  assert.equal(resolveGithubRepo(dir, {}), "other/mirror");

  // 非 GitHub 的 origin 不会误识别。
  const local = tempRepo();
  execFileSync("git", ["init", "-q", local]);
  execFileSync("git", ["-C", local, "remote", "add", "origin", "http://gitlab.example.com/a/b.git"]);
  assert.equal(resolveGithubRepo(local, {}), undefined);
});

test("没有镜像配置时不发请求", async () => {
  await withRepoEnv(undefined, async () => {
    let called = false;
    const result = await fetchGithubVersion({
      repoRoot: tempRepo(),
      current: "0.1.0",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(called, false);
    assert.match(result.error ?? "", /没有找到 GitHub 镜像/);
    assert.equal(result.current, "0.1.0");
  });
});
