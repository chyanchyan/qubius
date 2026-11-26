import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectConfig } from "./config.js";
import {
  createSkill,
  enabledSkillFilter,
  listSkills,
  readSkill,
  SkillError,
  SkillSettings,
  writeSkill,
} from "./skills.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkillFile(root: string, dir: string, name: string, description: string): string {
  const folder = path.join(root, dir);
  fs.mkdirSync(folder, { recursive: true });
  const body = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
  const file = path.join(folder, "SKILL.md");
  fs.writeFileSync(file, body);
  return file;
}

interface Fixture {
  base: string;
  configDir: string;
  dataDir: string;
  projectPath: string;
  otherPath: string;
  config: { projects: ProjectConfig[] };
}

function fixture(): Fixture {
  const base = tempDir("rc-skills-");
  const configDir = path.join(base, "claude");
  const dataDir = path.join(base, "data");
  const projectPath = path.join(base, "project");
  const otherPath = path.join(base, "other");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(otherPath, { recursive: true });
  return {
    base,
    configDir,
    dataDir,
    projectPath,
    otherPath,
    config: {
      projects: [
        { id: "p1", name: "项目一", path: projectPath, permission: "acceptEdits", isolated: false },
        { id: "p2", name: "项目二", path: otherPath, permission: "acceptEdits", isolated: false },
      ],
    },
  };
}

test("按用户、项目、插件三个来源域发现技能", () => {
  const f = fixture();
  writeSkillFile(path.join(f.configDir, "skills"), "prl", "prl", "并行开发");
  writeSkillFile(path.join(f.projectPath, ".claude", "skills"), "review", "review", "项目评审");
  writeSkillFile(
    path.join(f.configDir, "plugins", "marketplaces", "mp", "my-plugin", "skills"),
    "deploy",
    "deploy",
    "插件部署",
  );

  const { domains, skills } = listSkills({ config: f.config, configDir: f.configDir });
  assert.deepEqual(domains.map((domain) => domain.id), ["user", "project:p1", "project:p2", "plugin"]);
  assert.equal(domains[0]?.writable, true);
  assert.equal(domains[3]?.writable, false);

  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  assert.equal(byId.get("user/prl")?.description, "并行开发");
  assert.equal(byId.get("user/prl")?.sdkName, "prl");
  assert.equal(byId.get("project:p1/review")?.sdkName, "review");
  assert.equal(byId.get("plugin/deploy")?.sdkName, "my-plugin:deploy");
  assert.equal(byId.get("plugin/deploy")?.plugin, "my-plugin");
  assert.equal(byId.get("plugin/deploy")?.writable, false);
  // 每个技能都带绝对路径和大小，页面直接展示。
  assert.ok(byId.get("user/prl")?.path.endsWith(path.join("skills", "prl", "SKILL.md")));
  assert.ok((byId.get("user/prl")?.bytes ?? 0) > 0);
});

test("frontmatter 缺失或损坏时列表仍然可用", () => {
  const f = fixture();
  const skillsDir = path.join(f.configDir, "skills");
  fs.mkdirSync(path.join(skillsDir, "broken"), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "broken", "SKILL.md"), "没有 frontmatter\n");
  fs.mkdirSync(path.join(skillsDir, "not-a-skill"), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "not-a-skill", "README.md"), "x");

  const { skills } = listSkills({ config: f.config, configDir: f.configDir });
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "broken");
  assert.equal(skills[0]?.description, "");
});

test("停用状态写入 dataDir，并能生成只含启用项的过滤列表", () => {
  const f = fixture();
  writeSkillFile(path.join(f.configDir, "skills"), "prl", "prl", "并行开发");
  writeSkillFile(path.join(f.configDir, "skills"), "ttb", "ttb", "提交部署");
  writeSkillFile(path.join(f.projectPath, ".claude", "skills"), "review", "review", "项目评审");
  writeSkillFile(path.join(f.otherPath, ".claude", "skills"), "review", "review", "另一个项目");

  const store = new SkillSettings(f.dataDir);
  assert.equal(store.isEnabled("user", "prl"), true);
  const before = store.version;
  store.setEnabled("user", "prl", false);
  assert.ok(store.version > before);
  assert.equal(store.isEnabled("user", "prl"), false);

  const reloaded = new SkillSettings(f.dataDir);
  assert.equal(reloaded.isEnabled("user", "prl"), false);
  assert.equal(reloaded.isEnabled("user", "ttb"), true);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, "skills.json"), "utf8"));
  assert.deepEqual(saved.disabled, ["user/prl"]);

  // 用户级停用对所有项目生效；项目一仍启用 ttb 和它自己的 review。
  assert.deepEqual(
    enabledSkillFilter({ config: f.config, configDir: f.configDir, disabled: reloaded.snapshot(), projectId: "p1" }),
    ["ttb", "review"],
  );
  assert.deepEqual(
    enabledSkillFilter({ config: f.config, configDir: f.configDir, disabled: reloaded.snapshot(), projectId: "p2" }),
    ["ttb", "review"],
  );

  // 只停用项目一的 review 时，项目二没有任何停用项，沿用 SDK 默认。
  const p1Only = new SkillSettings(path.join(f.base, "data-p1"));
  p1Only.setEnabled("project:p1", "review", false);
  assert.deepEqual(
    enabledSkillFilter({ config: f.config, configDir: f.configDir, disabled: p1Only.snapshot(), projectId: "p1" }),
    ["prl", "ttb"],
  );
  assert.equal(
    enabledSkillFilter({ config: f.config, configDir: f.configDir, disabled: p1Only.snapshot(), projectId: "p2" }),
    undefined,
  );
});

test("没有停用项时返回 undefined，保留 SDK 默认技能行为", () => {
  const f = fixture();
  writeSkillFile(path.join(f.configDir, "skills"), "prl", "prl", "并行开发");
  const store = new SkillSettings(f.dataDir);
  assert.equal(
    enabledSkillFilter({ config: f.config, configDir: f.configDir, disabled: store.snapshot(), projectId: "p1" }),
    undefined,
  );
});

test("读取、编辑和新建技能，并拒绝越界路径与非法内容", () => {
  const f = fixture();
  const file = writeSkillFile(path.join(f.configDir, "skills"), "prl", "prl", "并行开发");
  const options = { config: f.config, configDir: f.configDir };

  const detail = readSkill(options, "user", "prl");
  assert.match(detail.content, /name: prl/);
  assert.equal(detail.skill.enabled, true);

  const updated = writeSkill(options, "user", "prl", "---\nname: prl\ndescription: 新的描述\n---\n\n正文\n");
  assert.equal(updated.description, "新的描述");
  assert.match(fs.readFileSync(file, "utf8"), /新的描述/);

  assert.throws(
    () => writeSkill(options, "user", "prl", "缺少 frontmatter"),
    (error: unknown) => error instanceof SkillError && error.status === 400,
  );
  assert.throws(
    () => readSkill(options, "user", "../escape"),
    (error: unknown) => error instanceof SkillError && error.status === 400,
  );
  assert.throws(
    () => readSkill(options, "user", "missing"),
    (error: unknown) => error instanceof SkillError && error.status === 404,
  );
  assert.throws(
    () => writeSkill(options, "plugin", "x", "---\nname: x\ndescription: y\n---\n"),
    (error: unknown) => error instanceof SkillError && error.status === 404,
  );

  const created = createSkill(
    options,
    "project:p1",
    "new-skill",
    "---\nname: new-skill\ndescription: 新技能\n---\n",
  );
  assert.equal(created.id, "project:p1/new-skill");
  assert.ok(fs.existsSync(path.join(f.projectPath, ".claude", "skills", "new-skill", "SKILL.md")));

  assert.throws(
    () => createSkill(options, "project:p1", "new-skill", "---\nname: new-skill\ndescription: 重复\n---\n"),
    (error: unknown) => error instanceof SkillError && error.status === 409,
  );
  assert.throws(
    () => createSkill(options, "project:p1", "another", "---\nname: mismatch\ndescription: 不匹配\n---\n"),
    (error: unknown) => error instanceof SkillError && error.status === 400,
  );
  assert.throws(
    () => createSkill(options, "project:p1", "../bad", "---\nname: bad\ndescription: 非法\n---\n"),
    (error: unknown) => error instanceof SkillError && error.status === 400,
  );
});

test("插件技能只读", () => {
  const f = fixture();
  writeSkillFile(
    path.join(f.configDir, "plugins", "marketplaces", "mp", "my-plugin", "skills"),
    "deploy",
    "deploy",
    "插件部署",
  );
  const options = { config: f.config, configDir: f.configDir };
  assert.throws(
    () => writeSkill(options, "plugin", "deploy", "---\nname: deploy\ndescription: x\n---\n"),
    (error: unknown) => error instanceof SkillError && error.status === 403,
  );
});
