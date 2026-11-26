import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/* 版本号和更新说明必须在同一次提交里更新：漏写 CHANGELOG 时让测试失败，
   而不是等到发布后才发现页面上的版本没有说明。 */

const ROOT = path.join(import.meta.dirname, "..", "..");
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

interface Section {
  version: string;
  date?: string;
  lines: string[];
}

function readText(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+\[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/);
    if (heading?.[1]) {
      current = {
        version: heading[1].trim(),
        ...(heading[2] ? { date: heading[2] } : {}),
        lines: [],
      };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

function bullets(section: Section): string[] {
  return section.lines.filter((line) => /^- \S/.test(line.trim()));
}

/** 版本小节的第一行正文（跳过空行、子标题和 bullet）作为摘要。 */
function summaryOf(section: Section): string | undefined {
  return section.lines
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("- ") && !line.startsWith("### "));
}

test("CHANGELOG 顶部版本与 package.json 一致", () => {
  const packageVersion = JSON.parse(readText("package.json")).version;
  assert.equal(typeof packageVersion, "string");
  const sections = parseSections(readText("CHANGELOG.md"));
  assert.ok(sections.length > 0, "CHANGELOG.md 里没有版本小节");
  assert.equal(sections[0]!.version, packageVersion, "package.json 的版本必须出现在 CHANGELOG 顶部");
});

test("每个版本小节都有日期、合法版本号、摘要和改动条目", () => {
  const sections = parseSections(readText("CHANGELOG.md"));
  const seen = new Set<string>();
  for (const section of sections) {
    assert.match(section.version, VERSION_RE, `版本号不合法：${section.version}`);
    assert.ok(!seen.has(section.version), `版本重复：${section.version}`);
    seen.add(section.version);
    assert.ok(section.date, `版本 ${section.version} 缺少日期（格式：## [x.y.z] - YYYY-MM-DD）`);
    assert.ok(summaryOf(section), `版本 ${section.version} 缺少一句摘要`);
    assert.ok(bullets(section).length > 0, `版本 ${section.version} 没有改动条目`);
  }
});
