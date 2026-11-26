import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "./config.js";
import { createAppServer } from "./http.js";
import { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import { SkillSettings } from "./skills.js";
import { Store } from "./store.js";

interface Harness {
  url: string;
  base: string;
  configDir: string;
  dataDir: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-skills-http-"));
  const dataDir = path.join(base, "data");
  const configDir = path.join(base, "claude");
  const projectPath = path.join(base, "project");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });

  function skill(root: string, dir: string, name: string, description: string): void {
    const folder = path.join(root, dir);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    );
  }

  skill(path.join(configDir, "skills"), "prl", "prl", "并行开发");
  skill(path.join(projectPath, ".claude", "skills"), "review", "review", "项目评审");
  skill(
    path.join(configDir, "plugins", "marketplaces", "mp", "my-plugin", "skills"),
    "deploy",
    "deploy",
    "插件部署",
  );

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 1,
    configDir: base,
    role: "primary",
    projects: [{ id: "p1", name: "项目一", path: projectPath, permission: "acceptEdits", isolated: true }],
  };
  const settings = {
    current: { effort: "high", providers: [], maxConcurrent: 4 } satisfies StoredSettings,
  };
  const store = new Store(dataDir);
  const runtime = new Runtime(store, {
    maxConcurrent: 1,
    fake: true,
    credential: () => ({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:9" }),
    permission: () => "acceptEdits",
    secrets: () => [],
  });
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(base, "web"),
    settings,
    permissions: { current: {} },
    repoRoot: base,
    skills: { store: new SkillSettings(dataDir), configDir },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    base,
    configDir,
    dataDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown().catch(() => undefined);
      await store.flush().catch(() => undefined);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

async function call<T = Record<string, unknown>>(
  harness: Harness,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${harness.url}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) as T : {} as T };
}

interface SkillsBody {
  domains: Array<{ id: string; kind: string; writable: boolean; path: string }>;
  skills: Array<{ id: string; name: string; enabled: boolean; writable: boolean; sdkName: string }>;
}

test("技能列表按来源域返回，可读取和编辑", async () => {
  const harness = await startHarness();
  try {
    const list = await call<SkillsBody>(harness, "GET", "/api/skills");
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.domains.map((domain) => domain.id), ["user", "project:p1", "plugin"]);
    assert.deepEqual(
      list.data.skills.map((skill) => `${skill.id}:${skill.enabled}`),
      ["user/prl:true", "project:p1/review:true", "plugin/deploy:true"],
    );
    assert.equal(list.data.skills[2]?.sdkName, "my-plugin:deploy");
    assert.equal(list.data.skills[2]?.writable, false);

    const detail = await call<{ skill: { name: string }; content: string }>(harness, "GET", "/api/skills/user/prl");
    assert.equal(detail.status, 200);
    assert.match(detail.data.content, /name: prl/);

    const saved = await call<{ skill: { description: string } }>(
      harness,
      "PUT",
      "/api/skills/user/prl",
      { content: "---\nname: prl\ndescription: 更新后的描述\n---\n" },
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.data.skill.description, "更新后的描述");

    const invalid = await call(harness, "PUT", "/api/skills/user/prl", { content: "没有 frontmatter" });
    assert.equal(invalid.status, 400);
  } finally {
    await harness.close();
  }
});

test("启用/停用持久化到 skills.json", async () => {
  const harness = await startHarness();
  try {
    const toggled = await call<{ skill: { enabled: boolean } }>(
      harness,
      "PATCH",
      "/api/skills/user/prl",
      { enabled: false },
    );
    assert.equal(toggled.status, 200);
    assert.equal(toggled.data.skill.enabled, false);
    const saved = JSON.parse(fs.readFileSync(path.join(harness.dataDir, "skills.json"), "utf8"));
    assert.deepEqual(saved.disabled, ["user/prl"]);

    const list = await call<SkillsBody>(harness, "GET", "/api/skills");
    assert.equal(list.data.skills.find((skill) => skill.id === "user/prl")?.enabled, false);

    const missing = await call(harness, "PATCH", "/api/skills/user/nope", { enabled: false });
    assert.equal(missing.status, 404);
    const badBody = await call(harness, "PATCH", "/api/skills/user/prl", { enabled: "no" });
    assert.equal(badBody.status, 400);
  } finally {
    await harness.close();
  }
});

test("新建技能、重复名、只读插件和非法路径", async () => {
  const harness = await startHarness();
  try {
    const created = await call<{ skill: { id: string } }>(harness, "POST", "/api/skills", {
      domain: "project:p1",
      name: "new-skill",
      content: "---\nname: new-skill\ndescription: 新技能\n---\n",
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.skill.id, "project:p1/new-skill");
    assert.ok(fs.existsSync(path.join(harness.base, "project", ".claude", "skills", "new-skill", "SKILL.md")));

    const duplicate = await call(harness, "POST", "/api/skills", {
      domain: "project:p1",
      name: "new-skill",
      content: "---\nname: new-skill\ndescription: 重复\n---\n",
    });
    assert.equal(duplicate.status, 409);

    const plugin = await call(harness, "PUT", "/api/skills/plugin/deploy", {
      content: "---\nname: deploy\ndescription: x\n---\n",
    });
    assert.equal(plugin.status, 403);

    const escape = await call(harness, "GET", "/api/skills/user/..%2Fescape");
    assert.equal(escape.status, 400);

    const unknownDomain = await call(harness, "GET", "/api/skills/nope/x");
    assert.equal(unknownDomain.status, 404);
  } finally {
    await harness.close();
  }
});
