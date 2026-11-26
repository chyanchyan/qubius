import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { writeFileAtomic } from "./atomic-file.js";

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tmpEntries(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.includes(".tmp."));
}

test("写入后内容正确，父目录自动创建，且不残留临时文件", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "nested", "state.json");

  writeFileAtomic(file, '{"a":1}');

  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}');
  assert.deepEqual(tmpEntries(path.dirname(file)), []);
  assert.deepEqual(tmpEntries(dir), []);
});

test("backup=true 时保留上一版内容，backup=false 不生成备份", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");

  writeFileAtomic(file, "one");
  writeFileAtomic(file, "two");
  assert.equal(fs.readFileSync(file, "utf8"), "two");
  assert.equal(fs.existsSync(`${file}.bak`), false);

  writeFileAtomic(file, "three", { backup: true });
  assert.equal(fs.readFileSync(file, "utf8"), "three");
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), "two");
});

test("POSIX 上主文件和备份的权限都是 0600", { skip: process.platform === "win32" }, (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");

  writeFileAtomic(file, "one");
  writeFileAtomic(file, "two", { backup: true });

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${file}.bak`).mode & 0o777, 0o600);
});

test("rename 失败时删除临时文件并抛出", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  // 目标被目录占据时 rename 会失败。
  fs.mkdirSync(file);

  assert.throws(() => writeFileAtomic(file, "data"), /EISDIR|ENOTDIR|EEXIST|EACCES|EPERM/);
  assert.deepEqual(tmpEntries(dir), []);
  assert.equal(fs.statSync(file).isDirectory(), true);
});
