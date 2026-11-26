import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProjectPermissions, resolvePermission, saveProjectPermissions } from "./project-permissions.js";

test("页面保存的授权级别优先于配置文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-permissions-"));
  assert.equal(resolvePermission("sample", "acceptEdits", {}), "acceptEdits");
  saveProjectPermissions(dir, { sample: "bypassPermissions", stale: "acceptEdits" });
  const saved = loadProjectPermissions(dir);
  assert.equal(resolvePermission("sample", "acceptEdits", saved), "bypassPermissions");
  assert.equal(saved.stale, "acceptEdits");
});

test("损坏的授权文件按没有保存处理", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-coder-permissions-"));
  fs.writeFileSync(path.join(dir, "project-permissions.json"), "{");
  assert.deepEqual(loadProjectPermissions(dir), {});
});
