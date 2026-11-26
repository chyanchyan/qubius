import assert from "node:assert/strict";
import test from "node:test";
import { classifyImageSrc } from "./markdown-images";

test("inline：图片 data: 和 blob: 直接显示", () => {
  assert.equal(classifyImageSrc("data:image/png;base64,iVBORw0KGgo="), "inline");
  assert.equal(classifyImageSrc("data:image/svg+xml,%3Csvg%3E"), "inline");
  assert.equal(classifyImageSrc("DATA:IMAGE/PNG;base64,AAAA"), "inline");
  assert.equal(classifyImageSrc("blob:https://example.com/1234"), "inline");
});

test("inline：相对路径直接显示（含 /x，但不含 //host）", () => {
  assert.equal(classifyImageSrc("foo.png"), "inline");
  assert.equal(classifyImageSrc("./x.png"), "inline");
  assert.equal(classifyImageSrc("../x"), "inline");
  assert.equal(classifyImageSrc("/x"), "inline");
  assert.equal(classifyImageSrc("images/a b.png"), "inline");
  assert.equal(classifyImageSrc("  ./spaced.png  "), "inline");
});

test("external：http(s) 与协议相对地址需要点击加载", () => {
  assert.equal(classifyImageSrc("http://evil.example/?d=secret"), "external");
  assert.equal(classifyImageSrc("https://evil.example/p.png"), "external");
  assert.equal(classifyImageSrc("HTTPS://EVIL.EXAMPLE/p.png"), "external");
  assert.equal(classifyImageSrc("//evil.example/p.png"), "external");
  assert.equal(classifyImageSrc("  https://evil.example/p.png  "), "external");
});

test("blocked：javascript: 等危险协议", () => {
  assert.equal(classifyImageSrc("javascript:alert(1)"), "blocked");
  assert.equal(classifyImageSrc("JavaScript:alert(1)"), "blocked");
  assert.equal(classifyImageSrc("vbscript:msgbox(1)"), "blocked");
  assert.equal(classifyImageSrc("file:///etc/passwd"), "blocked");
  assert.equal(classifyImageSrc("ftp://example.com/x.png"), "blocked");
  assert.equal(classifyImageSrc("mailto:a@example.com"), "blocked");
});

test("blocked：浏览器会把 \ 当作 / 的写法不能走 inline", () => {
  assert.equal(classifyImageSrc("/\\/evil.example/?d=secret"), "blocked");
  assert.equal(classifyImageSrc("/\\evil.example/?d=secret"), "blocked");
  assert.equal(classifyImageSrc("\\/evil.example/?d=secret"), "blocked");
  assert.equal(classifyImageSrc("\\\\evil.example/?d=secret"), "blocked");
  assert.equal(classifyImageSrc("images\\x.png"), "blocked");
});

test("external：三斜杠仍是协议相对地址，需要点击", () => {
  assert.equal(classifyImageSrc("///x"), "external");
});

test("blocked：非图片 data:、空串和含控制字符的源", () => {
  assert.equal(classifyImageSrc("data:text/html,<script>alert(1)</script>"), "blocked");
  assert.equal(classifyImageSrc("data:application/javascript,alert(1)"), "blocked");
  assert.equal(classifyImageSrc(""), "blocked");
  assert.equal(classifyImageSrc("   "), "blocked");
  assert.equal(classifyImageSrc("java\tscript:alert(1)"), "blocked");
  assert.equal(classifyImageSrc("https://evil.example/\nsplit"), "blocked");
});
