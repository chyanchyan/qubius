import assert from "node:assert/strict";
import test from "node:test";
import { pathIsAbsolute } from "./deploy-path";

test("绝对路径同时接受 POSIX 与 Windows", () => {
  assert.equal(pathIsAbsolute("/var/lib/qubius"), true);
  assert.equal(pathIsAbsolute("  /archive/qubius  "), true);
  assert.equal(pathIsAbsolute(String.raw`C:\Users\q\.config\qubius`), true);
  assert.equal(pathIsAbsolute("C:/Users/q/.config/qubius"), true);
  assert.equal(pathIsAbsolute(String.raw`D:\projects\sdata`), true);
  assert.equal(pathIsAbsolute(String.raw`\\server\share\qubius`), true);
  assert.equal(pathIsAbsolute("data"), false);
  assert.equal(pathIsAbsolute("C:qubius"), false);
  assert.equal(pathIsAbsolute(""), false);
});
