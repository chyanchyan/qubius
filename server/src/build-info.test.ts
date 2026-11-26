import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readBuildInfo, readPackageVersion, resolveBuildInfo } from "./build-info.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qubius-build-info-"));
}

test("读取构建信息里的 head / version / builtAt / dirty", () => {
  const dir = tempDir();
  const file = path.join(dir, "build.json");
  fs.writeFileSync(file, JSON.stringify({
    head: " 382c83f ",
    version: "0.1.0",
    builtAt: "2026-11-26T09:46:00+08:00",
    dirty: false,
  }));
  assert.deepEqual(readBuildInfo(file), {
    head: "382c83f",
    version: "0.1.0",
    builtAt: "2026-11-26T09:46:00+08:00",
    dirty: false,
  });
});

test("build.json 缺失或损坏时返回空信息，不抛错", () => {
  const dir = tempDir();
  assert.deepEqual(readBuildInfo(path.join(dir, "missing.json")), {});
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{not json");
  assert.deepEqual(readBuildInfo(broken), {});
  const array = path.join(dir, "array.json");
  fs.writeFileSync(array, "[]");
  assert.deepEqual(readBuildInfo(array), {});
});

test("只接受字符串字段，空串和错误类型被忽略", () => {
  const dir = tempDir();
  const file = path.join(dir, "build.json");
  fs.writeFileSync(file, JSON.stringify({ head: 42, version: "", builtAt: null, dirty: "yes" }));
  assert.deepEqual(readBuildInfo(file), {});
});

test("package.json 版本号只接受 semver 字符", () => {
  const dir = tempDir();
  const file = path.join(dir, "package.json");
  fs.writeFileSync(file, JSON.stringify({ version: "1.2.3-beta.1+build.5" }));
  assert.equal(readPackageVersion(file), "1.2.3-beta.1+build.5");
  fs.writeFileSync(file, JSON.stringify({ version: '1.0.0"}\n' }));
  assert.equal(readPackageVersion(file), undefined);
  fs.writeFileSync(file, JSON.stringify({ version: 1 }));
  assert.equal(readPackageVersion(file), undefined);
});

test("开发环境没有 build.json 时回退到 package.json 版本", () => {
  const dir = tempDir();
  const pkg = path.join(dir, "package.json");
  fs.writeFileSync(pkg, JSON.stringify({ version: "0.2.0" }));
  assert.deepEqual(resolveBuildInfo(path.join(dir, "missing.json"), pkg), { version: "0.2.0" });
});

test("构建时写下的版本优先于当前 package.json", () => {
  const dir = tempDir();
  const build = path.join(dir, "build.json");
  const pkg = path.join(dir, "package.json");
  fs.writeFileSync(build, JSON.stringify({ head: "abc", version: "0.1.0" }));
  fs.writeFileSync(pkg, JSON.stringify({ version: "0.2.0" }));
  assert.equal(resolveBuildInfo(build, pkg).version, "0.1.0");
});
