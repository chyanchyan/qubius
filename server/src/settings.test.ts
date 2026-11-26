import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applySettingsPatch, loadSettings, publicSettings, saveSettings, type StoredSettings } from "./settings.js";

const secret = "sk-ant-secret-value";

function sample(): StoredSettings {
  return {
    effort: "high",
    maxConcurrent: 4,
    providers: [{
      id: "p1",
      name: "官方",
      baseUrl: "https://api.anthropic.com",
      apiKey: secret,
      models: ["sonnet", "opus"],
    }],
  };
}

test("对外设置不包含 API key", () => {
  const view = publicSettings(sample());
  assert.equal(view.providers[0]?.hasApiKey, true);
  assert.deepEqual(view.providers[0]?.models, ["sonnet", "opus"]);
  assert.equal(JSON.stringify(view).includes(secret), false);
  assert.equal(JSON.stringify(view).includes("apiKey"), false);
});

test("同地址留空密钥时保留原密钥，也能改名称和模型", () => {
  const next = applySettingsPatch(sample(), {
    effort: "max",
    providers: [{
      id: "p1",
      name: "官方-新名字",
      baseUrl: "https://api.anthropic.com",
      apiKey: "  ",
      models: ["claude-sonnet", "claude-opus", "claude-haiku"],
    }],
  });
  assert.equal(next.providers[0]?.apiKey, secret);
  assert.equal(next.providers[0]?.name, "官方-新名字");
  assert.equal(next.providers[0]?.baseUrl, "https://api.anthropic.com");
  assert.deepEqual(next.providers[0]?.models, ["claude-sonnet", "claude-opus", "claude-haiku"]);
  assert.equal(next.effort, "max");
});

test("旧地址未规范化时等价地址仍算同一地址并保留密钥", () => {
  const variants = [
    "https://api.anthropic.com/",
    "https://API.Anthropic.com",
    "https://api.anthropic.com:443",
    "https://api.anthropic.com/?from=old#section",
  ];
  for (const baseUrl of variants) {
    const existing: StoredSettings = {
      ...sample(),
      providers: [{ ...sample().providers[0]!, baseUrl }],
    };
    const next = applySettingsPatch(existing, {
      providers: [{
        id: "p1",
        name: "官方",
        baseUrl: "https://api.anthropic.com",
        apiKey: "",
        models: ["sonnet"],
      }],
    });
    assert.equal(next.providers[0]?.apiKey, secret, baseUrl);
    assert.equal(next.providers[0]?.baseUrl, "https://api.anthropic.com");
  }
  // 真正的地址变化仍然拒绝。
  const legacy: StoredSettings = {
    ...sample(),
    providers: [{ ...sample().providers[0]!, baseUrl: "https://API.Anthropic.com/" }],
  };
  assert.throws(() => applySettingsPatch(legacy, {
    providers: [{
      id: "p1",
      name: "官方",
      baseUrl: "https://gateway.example.com",
      models: ["sonnet"],
    }],
  }), /接口地址变化时必须重新填写 API key/);
});

test("改地址且留空密钥时拒绝沿用旧密钥", () => {
  assert.throws(() => applySettingsPatch(sample(), {
    providers: [{
      id: "p1",
      name: "中转",
      baseUrl: "https://gateway.example.com/v1",
      models: ["claude-sonnet"],
    }],
  }), /接口地址变化时必须重新填写 API key/);
  assert.throws(() => applySettingsPatch(sample(), {
    providers: [{
      id: "p1",
      name: "中转",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "   ",
      models: ["claude-sonnet"],
    }],
  }), /接口地址变化时必须重新填写 API key/);
});

test("改地址时带上新密钥就正常保存", () => {
  const next = applySettingsPatch(sample(), {
    providers: [{
      id: "p1",
      name: "中转",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "sk-gateway-key",
      models: ["claude-sonnet"],
    }],
  });
  assert.equal(next.providers[0]?.apiKey, "sk-gateway-key");
  assert.equal(next.providers[0]?.baseUrl, "https://gateway.example.com/v1");
});

test("新配置必须带密钥，同一地址可以有多个模型", () => {
  assert.throws(() => applySettingsPatch(sample(), {
    providers: [{ name: "另一家", baseUrl: "https://other.example", models: ["a", "b"] }],
  }), /API key/);
  const next = applySettingsPatch(sample(), {
    providers: [
      { id: "p1", name: "官方", baseUrl: "https://api.anthropic.com", models: ["sonnet"] },
      { name: "另一家", baseUrl: "http://10.0.0.8:8080/anthropic/", apiKey: "sk-new-key", models: ["a", "b"] },
    ],
  });
  assert.equal(next.providers.length, 2);
  assert.equal(next.providers[1]?.apiKey, "sk-new-key");
  assert.equal(next.providers[1]?.baseUrl, "http://10.0.0.8:8080/anthropic");
  assert.deepEqual(next.providers[1]?.models, ["a", "b"]);
});

test("重复名称、重复模型和密钥进地址会被拒绝", () => {
  assert.throws(() => applySettingsPatch(sample(), {
    providers: [
      { id: "p1", name: "官方", baseUrl: "https://api.anthropic.com", models: ["sonnet"] },
      { name: "官方", baseUrl: "https://other.example", apiKey: "sk-other", models: ["x"] },
    ],
  }), /名称重复/);
  assert.throws(() => applySettingsPatch(sample(), {
    providers: [{ id: "p1", name: "官方", baseUrl: "https://api.anthropic.com", models: ["sonnet", "sonnet"] }],
  }), /模型名称重复/);
  assert.throws(() => applySettingsPatch(sample(), {
    providers: [{ id: "p1", name: "官方", baseUrl: "https://user:sk@api.anthropic.com", models: ["sonnet"] }],
  }), /密钥/);
});

test("旧格式没有价格字段时加载为 undefined，也不会凭空写回", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-pricing-"));
  fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({
    effort: "high",
    providers: [{
      id: "p1",
      name: "官方",
      baseUrl: "https://api.anthropic.com",
      apiKey: secret,
      models: ["sonnet"],
    }],
  }));
  const loaded = loadSettings(dir);
  assert.equal(loaded.providers[0]?.pricing, undefined);
  assert.equal("pricing" in (loaded.providers[0] ?? {}), false);
  const view = publicSettings(loaded);
  assert.equal(view.providers[0]?.pricing, undefined);
  saveSettings(dir, loaded);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")) as {
    providers: Array<Record<string, unknown>>;
  };
  assert.equal("pricing" in (raw.providers[0] ?? {}), false);
});

test("保存和重新加载会保留价格，0 也保留", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-pricing-"));
  const withPricing: StoredSettings = {
    effort: "high",
    maxConcurrent: 4,
    providers: [{
      id: "p1",
      name: "官方",
      baseUrl: "https://api.anthropic.com",
      apiKey: secret,
      models: ["sonnet"],
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    }],
  };
  saveSettings(dir, withPricing);
  const loaded = loadSettings(dir);
  assert.deepEqual(loaded.providers[0]?.pricing, {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 0,
  });
  const view = publicSettings(loaded);
  assert.deepEqual(view.providers[0]?.pricing, {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 0,
  });
  assert.equal(JSON.stringify(view).includes(secret), false);
});

test("非法价格会被拒绝", () => {
  const bad = [
    { input: -1 },
    { input: 10001 },
    { output: Number.NaN },
    { output: Number.POSITIVE_INFINITY },
    { cacheRead: "3" },
    { cacheWrite: null },
  ];
  for (const pricing of bad) {
    assert.throws(() => applySettingsPatch(sample(), {
      providers: [{
        id: "p1",
        name: "官方",
        baseUrl: "https://api.anthropic.com",
        models: ["sonnet"],
        pricing,
      }],
    }), /价格必须是非负数/);
  }
  assert.throws(() => applySettingsPatch(sample(), {
    providers: [{
      id: "p1",
      name: "官方",
      baseUrl: "https://api.anthropic.com",
      models: ["sonnet"],
      pricing: "free",
    }],
  }), /价格必须是非负数/);
});

test("设置文件损坏时退回默认值并保留原文件作为证据", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-pricing-"));
  const file = path.join(dir, "secrets.json");
  fs.writeFileSync(file, JSON.stringify({
    providers: [{
      id: "p1",
      name: "官方",
      baseUrl: "https://api.anthropic.com",
      apiKey: secret,
      models: ["sonnet"],
      pricing: { input: -5 },
    }],
  }));

  const loaded = loadSettings(dir);
  assert.deepEqual(loaded.providers, []);
  assert.equal(loaded.maxConcurrent, 4);
  // 原文件不被静默删除：改名成 secrets.json.corrupt.<时间戳>。
  assert.equal(fs.existsSync(file), false);
  const corrupt = fs.readdirSync(dir).filter((name) => name.startsWith("secrets.json.corrupt."));
  assert.equal(corrupt.length, 1);
  const saved = fs.readFileSync(path.join(dir, corrupt[0]!), "utf8");
  assert.equal(JSON.parse(saved).providers[0].pricing.input, -5);
});

test("主文件损坏但备份可用时加载备份并隔离损坏文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-settings-backup-"));
  const file = path.join(dir, "secrets.json");
  saveSettings(dir, { ...sample(), maxConcurrent: 5 });
  // 第二次保存会把上一版复制到 secrets.json.bak。
  saveSettings(dir, { ...sample(), maxConcurrent: 6 });
  fs.writeFileSync(file, "{ not json");

  const loaded = loadSettings(dir);
  assert.equal(loaded.maxConcurrent, 5);
  assert.equal(loaded.providers.length, 1);
  assert.equal(loaded.providers[0]?.apiKey, secret);
  // 损坏的主文件必须被移走，否则后续保存会用坏数据覆盖 .bak。
  assert.equal(fs.existsSync(file), false);
  const corrupt = fs.readdirSync(dir).filter((name) => name.startsWith("secrets.json.corrupt."));
  assert.equal(corrupt.length, 1);
});

test("主坏→读备份→再保存后 .bak 仍是完好的旧备份", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-settings-backup-"));
  const file = path.join(dir, "secrets.json");
  saveSettings(dir, { ...sample(), maxConcurrent: 5 });
  saveSettings(dir, { ...sample(), maxConcurrent: 6 });
  fs.writeFileSync(file, "{ not json");

  const loaded = loadSettings(dir);
  assert.equal(loaded.maxConcurrent, 5);
  // 主文件已被隔离，再次保存不会把损坏内容复制进 .bak。
  saveSettings(dir, { ...loaded, maxConcurrent: 7 });

  const backupText = fs.readFileSync(`${file}.bak`, "utf8");
  assert.equal(backupText.includes("not json"), false);
  const backup = JSON.parse(backupText) as {
    maxConcurrent: number;
    providers: Array<{ apiKey: string }>;
  };
  assert.equal(backup.maxConcurrent, 5);
  assert.equal(backup.providers[0]?.apiKey, secret);
  const current = JSON.parse(fs.readFileSync(file, "utf8")) as { maxConcurrent: number };
  assert.equal(current.maxConcurrent, 7);
});

test("主文件无法隔离时用备份覆盖，保存后 .bak 仍完好", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-settings-backup-"));
  const file = path.join(dir, "secrets.json");
  saveSettings(dir, { ...sample(), maxConcurrent: 5 });
  saveSettings(dir, { ...sample(), maxConcurrent: 6 });
  fs.writeFileSync(file, "{ not json");

  // 模拟 Windows 上文件被占用：只让「把主文件改名为 .corrupt」失败，
  // 原子写入临时文件的 rename 仍然可用。
  const originalRename = fs.renameSync;
  const patchedRename: typeof fs.renameSync = (oldPath, newPath) => {
    if (oldPath === file && String(newPath).includes(".corrupt.")) {
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    }
    originalRename(oldPath, newPath);
  };
  (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = patchedRename;
  t.after(() => {
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = originalRename;
  });

  const loaded = loadSettings(dir);
  assert.equal(loaded.maxConcurrent, 5);
  assert.equal(loaded.providers[0]?.apiKey, secret);

  // 隔离失败后用备份内容原子覆盖主文件，不再是坏 JSON。
  const repaired = JSON.parse(fs.readFileSync(file, "utf8")) as { maxConcurrent: number };
  assert.equal(repaired.maxConcurrent, 5);

  // 再次保存时主文件可解析，坏内容不会进入 .bak。
  saveSettings(dir, { ...loaded, maxConcurrent: 7 });
  const backupText = fs.readFileSync(`${file}.bak`, "utf8");
  assert.equal(backupText.includes("not json"), false);
  const backup = JSON.parse(backupText) as {
    maxConcurrent: number;
    providers: Array<{ apiKey: string }>;
  };
  assert.equal(backup.maxConcurrent, 5);
  assert.equal(backup.providers[0]?.apiKey, secret);
});

test("saveSettings 遇到损坏主文件时直接覆盖，不污染现有 .bak", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-settings-backup-"));
  const file = path.join(dir, "secrets.json");
  saveSettings(dir, { ...sample(), maxConcurrent: 5 });
  saveSettings(dir, { ...sample(), maxConcurrent: 6 });
  fs.writeFileSync(file, "{ not json");

  // 不经过 loadSettings，直接保存：主文件不可解析，必须保留旧 .bak。
  saveSettings(dir, { ...sample(), maxConcurrent: 8 });
  const backupText = fs.readFileSync(`${file}.bak`, "utf8");
  assert.equal(backupText.includes("not json"), false);
  const backup = JSON.parse(backupText) as { maxConcurrent: number };
  assert.equal(backup.maxConcurrent, 5);
  const current = JSON.parse(fs.readFileSync(file, "utf8")) as { maxConcurrent: number };
  assert.equal(current.maxConcurrent, 8);
});

test("主文件不存在但备份可用时加载备份，不静默丢配置", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-settings-backup-"));
  const file = path.join(dir, "secrets.json");
  saveSettings(dir, { ...sample(), maxConcurrent: 5 });
  saveSettings(dir, { ...sample(), maxConcurrent: 6 });
  fs.rmSync(file);

  const loaded = loadSettings(dir);
  assert.equal(loaded.maxConcurrent, 5);
  assert.equal(loaded.providers[0]?.apiKey, secret);
});

test("主文件和备份都损坏时退回调用方默认值", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-settings-corrupt-"));
  const file = path.join(dir, "secrets.json");
  fs.writeFileSync(file, "{ not json");
  fs.writeFileSync(`${file}.bak`, "also not json");

  const loaded = loadSettings(dir, { maxConcurrent: 9 });
  assert.deepEqual(loaded.providers, []);
  assert.equal(loaded.maxConcurrent, 9);
  assert.equal(fs.existsSync(file), false);
  // 备份也保留下来，便于人工恢复。
  assert.equal(fs.existsSync(`${file}.bak`), true);
});

test("保存设置会生成备份，且备份里是上一版内容", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-settings-backup-"));
  const file = path.join(dir, "secrets.json");
  saveSettings(dir, sample());
  saveSettings(dir, {
    ...sample(),
    providers: [{ ...sample().providers[0]!, apiKey: "sk-new-secret" }],
  });

  const backup = JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")) as {
    providers: Array<{ apiKey: string }>;
  };
  assert.equal(backup.providers[0]?.apiKey, secret);
  const current = JSON.parse(fs.readFileSync(file, "utf8")) as {
    providers: Array<{ apiKey: string }>;
  };
  assert.equal(current.providers[0]?.apiKey, "sk-new-secret");
});

test("补丁里只改价格时保留密钥和模型", () => {
  const next = applySettingsPatch(sample(), {
    providers: [{
      id: "p1",
      name: "官方",
      baseUrl: "https://api.anthropic.com",
      models: ["sonnet", "opus"],
      pricing: { input: 1.5 },
    }],
  });
  assert.equal(next.providers[0]?.apiKey, secret);
  assert.deepEqual(next.providers[0]?.models, ["sonnet", "opus"]);
  assert.deepEqual(next.providers[0]?.pricing, { input: 1.5 });
});

test("旧文件里的 agentLimit 会被忽略，统一使用并发上限", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-agent-limit-"));
  fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({
    effort: "high",
    agentLimit: 8,
    maxConcurrent: 6,
    providers: [],
  }));
  const loaded = loadSettings(dir);
  assert.equal(loaded.maxConcurrent, 6);
  assert.equal("agentLimit" in loaded, false);
  assert.equal("agentLimit" in publicSettings(loaded), false);
});

test("并发上限随设置保存、加载并出现在对外设置里", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-max-concurrent-"));
  saveSettings(dir, { ...sample(), maxConcurrent: 7 });
  const loaded = loadSettings(dir);
  assert.equal(loaded.maxConcurrent, 7);
  assert.equal(publicSettings(loaded).maxConcurrent, 7);
});

test("旧文件没有并发上限时使用调用方给的初始默认值", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-max-concurrent-"));
  fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({
    effort: "high",
    providers: [],
  }));
  // 没有注入默认值时退回内置的 4。
  assert.equal(loadSettings(dir).maxConcurrent, 4);
  // config.yaml / env 的值作为初始默认。
  assert.equal(loadSettings(dir, { maxConcurrent: 9 }).maxConcurrent, 9);
});

test("并发上限只接受 1 到 256 之间的整数", () => {
  for (const maxConcurrent of [1, 256, 12]) {
    assert.equal(applySettingsPatch(sample(), { maxConcurrent }).maxConcurrent, maxConcurrent);
  }
  for (const maxConcurrent of [0, 257, -1, 2.5, Number.NaN, "8", null]) {
    assert.throws(
      () => applySettingsPatch(sample(), { maxConcurrent }),
      /并发上限必须是 1 到 256 之间的整数/,
    );
  }
});

test("补丁只改并发上限时保留接口、effort 和密钥", () => {
  const next = applySettingsPatch(sample(), { maxConcurrent: 16 });
  assert.equal(next.maxConcurrent, 16);
  assert.equal(next.effort, "high");
  assert.equal(next.providers[0]?.apiKey, secret);
});

test("旧的单密钥文件会变成一套接口配置", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-settings-"));
  fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({
    apiKey: "sk-legacy-secret",
    model: "opus",
    effort: "max",
  }));
  const loaded = loadSettings(dir);
  assert.equal(loaded.providers.length, 1);
  assert.equal(loaded.providers[0]?.apiKey, "sk-legacy-secret");
  assert.equal(loaded.providers[0]?.name, "默认");
  assert.equal(loaded.providers[0]?.baseUrl, "https://api.anthropic.com");
  assert.deepEqual(loaded.providers[0]?.models, ["opus"]);
  assert.equal(loaded.effort, "max");
  const again = loadSettings(dir);
  assert.equal(again.providers[0]?.id, loaded.providers[0]?.id);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")) as Record<string, unknown>;
  assert.equal("apiKey" in raw, false);
  assert.equal(JSON.stringify(publicSettings(again)).includes("sk-legacy-secret"), false);
});
