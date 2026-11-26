import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "./config.js";
import type { FeatureContext, FeatureResult } from "./feature-routes.js";
import {
  createMultiModelGroup,
  deleteMultiModelGroup,
  handleMultiModelGroupRoutes,
  listMultiModelGroups,
  MAX_GROUPS_PER_PROJECT,
  MAX_GROUP_SESSIONS,
  PROMPT_PREVIEW_LIMIT,
  validateGroupInput,
  type MultiModelGroup,
  type MultiModelGroupMember,
  type ValidatedGroupInput,
} from "./multi-model-groups.js";
import type { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import type { Store } from "./store.js";
import type { SessionCore } from "./types.js";

interface TempData {
  dataDir: string;
  cleanup: () => void;
}

function makeTempData(): TempData {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-multi-model-groups-"));
  return {
    dataDir: path.join(root, "data"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function groupsFile(dataDir: string): string {
  return path.join(dataDir, "multi-model-groups.json");
}

function member(overrides: Partial<MultiModelGroupMember> = {}): MultiModelGroupMember {
  return {
    id: "s1",
    providerId: "p1",
    providerName: "接口一",
    model: "m1",
    effort: "high",
    title: "多模型 · m1",
    ...overrides,
  };
}

function input(overrides: Partial<ValidatedGroupInput> = {}): ValidatedGroupInput {
  return {
    promptPreview: "实现一个功能",
    sessions: [
      member({ id: "s1" }),
      member({ id: "s2", model: "m2" }),
    ],
    ...overrides,
  };
}

const PROJECT_SESSIONS = new Map<string, { id: string; projectId: string }>([
  ["s1", { id: "s1", projectId: "proj" }],
  ["s2", { id: "s2", projectId: "proj" }],
  ["s3", { id: "s3", projectId: "proj" }],
  ["s4", { id: "s4", projectId: "proj" }],
  ["other-1", { id: "other-1", projectId: "other" }],
]);

const lookup = (id: string) => PROJECT_SESSIONS.get(id);

interface InvokeOptions {
  dataDir: string;
  pathname: string;
  method: string;
  body?: unknown;
  projects?: string[];
}

/** 伪造 FeatureContext：只实现路由用到的 config / store.get / readJson。 */
async function invoke(options: InvokeOptions): Promise<FeatureResult | null> {
  const projects = options.projects ?? ["proj", "other"];
  const ctx = {
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    url: new URL(`http://127.0.0.1${options.pathname}`),
    method: options.method,
    config: {
      dataDir: options.dataDir,
      projects: projects.map((id) => ({ id, name: id, path: `/tmp/${id}` })),
    } as AppConfig,
    store: {
      get: (id: string) => PROJECT_SESSIONS.get(id) as SessionCore | undefined,
    } as unknown as Store,
    runtime: {} as Runtime,
    settings: { current: {} as StoredSettings },
    readJson: async () => options.body,
    sendJson: () => undefined,
  } satisfies FeatureContext;
  return handleMultiModelGroupRoutes(ctx);
}

function bodyOf(result: FeatureResult | null): Record<string, unknown> {
  assert.ok(result, "路由应该匹配并返回结果");
  assert.equal(typeof result.body, "object");
  return result.body as Record<string, unknown>;
}

test("存储层 CRUD：新增、按项目读取、删除", async () => {
  const temp = makeTempData();
  try {
    assert.deepEqual(await listMultiModelGroups(temp.dataDir, "proj"), []);

    const first = await createMultiModelGroup(temp.dataDir, "proj", input());
    assert.match(first.id, /^[0-9a-f-]{36}$/i);
    assert.equal(first.projectId, "proj");
    assert.ok(first.createdAt);
    assert.deepEqual(first.sessions, input().sessions);
    assert.equal(first.promptPreview, "实现一个功能");

    const second = await createMultiModelGroup(
      temp.dataDir,
      "proj",
      input({ promptPreview: "第二个" }),
    );
    const other = await createMultiModelGroup(
      temp.dataDir,
      "other",
      input({ sessions: [member({ id: "other-1" }), member({ id: "other-1", model: "m2" })] }),
    );

    const listed = await listMultiModelGroups(temp.dataDir, "proj");
    // 新记录在前，且只看当前项目。
    assert.deepEqual(listed.map((group) => group.id), [second.id, first.id]);
    assert.deepEqual(
      (await listMultiModelGroups(temp.dataDir, "other")).map((group) => group.id),
      [other.id],
    );

    assert.equal(await deleteMultiModelGroup(temp.dataDir, "proj", first.id), true);
    assert.deepEqual(
      (await listMultiModelGroups(temp.dataDir, "proj")).map((group) => group.id),
      [second.id],
    );
    // 重复删除 / 项目不匹配都返回 false，不误删其它项目。
    assert.equal(await deleteMultiModelGroup(temp.dataDir, "proj", first.id), false);
    assert.equal(await deleteMultiModelGroup(temp.dataDir, "other", second.id), false);
    assert.equal((await listMultiModelGroups(temp.dataDir, "proj")).length, 1);
    assert.equal((await listMultiModelGroups(temp.dataDir, "other")).length, 1);
  } finally {
    temp.cleanup();
  }
});

test("每个项目最多保留 20 组，超出丢弃最旧的", async () => {
  const temp = makeTempData();
  try {
    const created: MultiModelGroup[] = [];
    for (let index = 0; index < MAX_GROUPS_PER_PROJECT + 5; index += 1) {
      created.push(
        await createMultiModelGroup(
          temp.dataDir,
          "proj",
          input({ promptPreview: `第 ${index} 组` }),
        ),
      );
    }
    const listed = await listMultiModelGroups(temp.dataDir, "proj");
    assert.equal(listed.length, MAX_GROUPS_PER_PROJECT);
    assert.deepEqual(
      listed.map((group) => group.id),
      created.slice(5).reverse().map((group) => group.id),
    );
    // 最旧的 5 组已从文件里删除。
    const raw = JSON.parse(fs.readFileSync(groupsFile(temp.dataDir), "utf8")) as MultiModelGroup[];
    assert.equal(raw.length, MAX_GROUPS_PER_PROJECT);
    assert.ok(!raw.some((group) => created.slice(0, 5).some((old) => old.id === group.id)));
  } finally {
    temp.cleanup();
  }
});

test("项目数量上限按项目独立计算", async () => {
  const temp = makeTempData();
  try {
    for (let index = 0; index < MAX_GROUPS_PER_PROJECT + 3; index += 1) {
      await createMultiModelGroup(temp.dataDir, "other", input({
        sessions: [member({ id: "other-1" }), member({ id: "other-1", model: "m2" })],
      }));
    }
    assert.equal((await listMultiModelGroups(temp.dataDir, "other")).length, MAX_GROUPS_PER_PROJECT);
    // 另一个项目不受影响，仍可新增。
    await createMultiModelGroup(temp.dataDir, "proj", input());
    assert.equal((await listMultiModelGroups(temp.dataDir, "proj")).length, 1);
    assert.equal((await listMultiModelGroups(temp.dataDir, "other")).length, MAX_GROUPS_PER_PROJECT);
  } finally {
    temp.cleanup();
  }
});

test("损坏的 JSON 视为空数组，且仍可继续写入", async () => {
  const temp = makeTempData();
  try {
    fs.mkdirSync(temp.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(groupsFile(temp.dataDir), "{不是合法 JSON");
    assert.deepEqual(await listMultiModelGroups(temp.dataDir, "proj"), []);

    fs.writeFileSync(groupsFile(temp.dataDir), JSON.stringify({ groups: [] }));
    assert.deepEqual(await listMultiModelGroups(temp.dataDir, "proj"), []);

    const created = await createMultiModelGroup(temp.dataDir, "proj", input());
    assert.deepEqual(
      (await listMultiModelGroups(temp.dataDir, "proj")).map((group) => group.id),
      [created.id],
    );

    // 数组里混入坏条目时只丢弃坏条目。
    fs.writeFileSync(
      groupsFile(temp.dataDir),
      JSON.stringify([
        { id: "missing-project", sessions: [] },
        { id: "x", projectId: "proj", createdAt: "now", promptPreview: "", sessions: [{ id: "s1" }] },
        {
          id: "good",
          projectId: "proj",
          createdAt: "now",
          promptPreview: "ok",
          sessions: [member(), member({ id: "s2" })],
        },
        "not-an-object",
      ]),
    );
    const filtered = await listMultiModelGroups(temp.dataDir, "proj");
    assert.deepEqual(filtered.map((group) => group.id), ["good"]);
  } finally {
    temp.cleanup();
  }
});

test("并发新增不会丢数据", async () => {
  const temp = makeTempData();
  try {
    const creations = Array.from({ length: 12 }, (_, index) =>
      createMultiModelGroup(temp.dataDir, "proj", input({ promptPreview: `并发 ${index}` })),
    );
    const created = await Promise.all(creations);
    assert.equal(new Set(created.map((group) => group.id)).size, 12);

    const listed = await listMultiModelGroups(temp.dataDir, "proj");
    assert.equal(listed.length, 12);
    assert.equal(new Set(listed.map((group) => group.id)).size, 12);
  } finally {
    temp.cleanup();
  }
});

test("校验：数量、会话存在性、项目匹配、字段类型、重复 id", () => {
  assert.deepEqual(validateGroupInput("proj", { sessions: [member(), member({ id: "s2" })] }, lookup), {
    promptPreview: "",
    sessions: [member(), member({ id: "s2" })],
  });

  const base = { sessions: [member({ id: "s1" }), member({ id: "s2" })] };
  const rejects: Array<[unknown, RegExp]> = [
    [null, /对象/],
    [[], /对象/],
    [{ sessions: "nope" }, /数组/],
    [{ sessions: [] }, /2 到 4/],
    [{ sessions: [member({ id: "s1" })] }, /2 到 4/],
    [{
      sessions: Array.from({ length: MAX_GROUP_SESSIONS + 1 }, (_, index) =>
        member({ id: `s${index}` })),
    }, /2 到 4/],
    [{ sessions: [member({ id: "missing" }), member({ id: "s2" })] }, /不存在/],
    [{ sessions: [member({ id: "other-1" }), member({ id: "s2" })] }, /不属于/],
    [{ sessions: [member({ id: "s1" }), member({ id: "s1" })] }, /重复/],
    [{ sessions: [{ id: "s1" }, member({ id: "s2" })] }, /providerId/],
    [{ sessions: [{ ...member({ id: "s1" }), providerId: 1 }, member({ id: "s2" })] }, /providerId/],
    [{ sessions: [{ ...member({ id: "s1" }), providerName: null }, member({ id: "s2" })] }, /providerName/],
    [{ sessions: [{ ...member({ id: "s1" }), model: 3 }, member({ id: "s2" })] }, /model/],
    [{ sessions: [{ ...member({ id: "s1" }), title: 3 }, member({ id: "s2" })] }, /title/],
    [{ sessions: [{ ...member({ id: "s1" }), effort: "turbo" }, member({ id: "s2" })] }, /effort/],
    [{ sessions: [{ ...member({ id: "s1" }), effort: undefined }, member({ id: "s2" })] }, /effort/],
    [{ ...base, promptPreview: 1 }, /promptPreview/],
    [{ sessions: [null, member({ id: "s2" })] }, /对象/],
    [{ sessions: [{ ...member({ id: "" }) }, member({ id: "s2" })] }, /非空/],
  ];
  for (const [value, pattern] of rejects) {
    assert.throws(() => validateGroupInput("proj", value, lookup), pattern, JSON.stringify(value));
  }

  // promptPreview trim 后最多 200 字；客户端带来的 id / createdAt 不参与校验。
  const validated = validateGroupInput(
    "proj",
    {
      id: "client-id",
      createdAt: "2000-01-01T00:00:00.000Z",
      promptPreview: `  ${"x".repeat(PROMPT_PREVIEW_LIMIT + 40)}  `,
      sessions: [member({ id: "s1" }), member({ id: "s2" })],
    },
    lookup,
  );
  assert.equal(validated.promptPreview.length, PROMPT_PREVIEW_LIMIT);
  assert.equal(validated.promptPreview, "x".repeat(PROMPT_PREVIEW_LIMIT));
});

test("路由：GET/POST/DELETE 正常流程", async () => {
  const temp = makeTempData();
  const base = "/api/projects/proj/multi-model-groups";
  try {
    const empty = await invoke({ dataDir: temp.dataDir, pathname: base, method: "GET" });
    assert.equal(empty?.status, 200);
    assert.deepEqual(bodyOf(empty).groups, []);

    const created = await invoke({
      dataDir: temp.dataDir,
      pathname: base,
      method: "POST",
      body: {
        // 客户端 id / createdAt 应被忽略。
        id: "client-id",
        createdAt: "2000-01-01T00:00:00.000Z",
        promptPreview: "  实现一个功能  ",
        sessions: [
          {
            id: "s1",
            providerId: "p1",
            providerName: "接口一",
            model: "m1",
            effort: "high",
            title: "多模型 · m1",
          },
          {
            id: "s2",
            providerId: "p1",
            providerName: "接口一",
            model: "m2",
            effort: "medium",
            title: "多模型 · m2",
          },
        ],
      },
    });
    assert.equal(created?.status, 201);
    const group = bodyOf(created).group as MultiModelGroup;
    assert.notEqual(group.id, "client-id");
    assert.match(group.id, /^[0-9a-f-]{36}$/i);
    assert.notEqual(group.createdAt, "2000-01-01T00:00:00.000Z");
    assert.equal(group.projectId, "proj");
    assert.equal(group.promptPreview, "实现一个功能");
    assert.deepEqual(group.sessions.map((item) => item.id), ["s1", "s2"]);

    const listed = await invoke({ dataDir: temp.dataDir, pathname: base, method: "GET" });
    assert.equal(listed?.status, 200);
    assert.deepEqual((bodyOf(listed).groups as MultiModelGroup[]).map((item) => item.id), [group.id]);

    const removed = await invoke({
      dataDir: temp.dataDir,
      pathname: `${base}/${group.id}`,
      method: "DELETE",
    });
    assert.equal(removed?.status, 200);
    assert.deepEqual(removed?.body, { ok: true });
    assert.deepEqual(await listMultiModelGroups(temp.dataDir, "proj"), []);

    const missing = await invoke({
      dataDir: temp.dataDir,
      pathname: `${base}/${group.id}`,
      method: "DELETE",
    });
    assert.equal(missing?.status, 404);
  } finally {
    temp.cleanup();
  }
});

test("路由：项目不存在返回 404，非法请求体返回 400", async () => {
  const temp = makeTempData();
  try {
    const unknown = await invoke({
      dataDir: temp.dataDir,
      pathname: "/api/projects/nope/multi-model-groups",
      method: "GET",
    });
    assert.equal(unknown?.status, 404);
    assert.deepEqual(unknown?.body, { error: "找不到项目" });

    const validSessions = [member({ id: "s1" }), member({ id: "s2" })];
    const badBodies: unknown[] = [
      [],
      { sessions: [] },
      { sessions: [member({ id: "s1" })] },
      { sessions: [member({ id: "s1" }), member({ id: "s1" })] },
      { sessions: [member({ id: "missing" }), member({ id: "s2" })] },
      { sessions: [member({ id: "other-1" }), member({ id: "s2" })] },
      { sessions: [member({ id: "s1" }), { ...member({ id: "s2" }), effort: "turbo" }] },
      { sessions: validSessions, promptPreview: 42 },
    ];
    for (const body of badBodies) {
      const result = await invoke({
        dataDir: temp.dataDir,
        pathname: "/api/projects/proj/multi-model-groups",
        method: "POST",
        body,
      });
      assert.equal(result?.status, 400, `应拒绝：${JSON.stringify(body)}`);
    }
    assert.deepEqual(await listMultiModelGroups(temp.dataDir, "proj"), []);
  } finally {
    temp.cleanup();
  }
});

test("路由：不支持的方法返回 405，路径不匹配返回 null", async () => {
  const temp = makeTempData();
  const base = "/api/projects/proj/multi-model-groups";
  try {
    const collectionPut = await invoke({ dataDir: temp.dataDir, pathname: base, method: "PUT" });
    assert.equal(collectionPut?.status, 405);
    assert.deepEqual(collectionPut?.body, { error: "不支持的方法" });

    const itemPost = await invoke({
      dataDir: temp.dataDir,
      pathname: `${base}/${randomUUID()}`,
      method: "POST",
    });
    assert.equal(itemPost?.status, 405);

    const itemGet = await invoke({
      dataDir: temp.dataDir,
      pathname: `${base}/${randomUUID()}`,
      method: "GET",
    });
    assert.equal(itemGet?.status, 405);

    for (const pathname of [
      "/api/projects/proj",
      "/api/projects/proj/multi-model-groups-extra",
      `${base}/${randomUUID()}/extra`,
      "/api/sessions/whatever/multi-model-groups",
    ]) {
      const result = await invoke({ dataDir: temp.dataDir, pathname, method: "GET" });
      assert.equal(result, null, `不应匹配：${pathname}`);
    }
  } finally {
    temp.cleanup();
  }
});
