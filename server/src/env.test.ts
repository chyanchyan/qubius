import assert from "node:assert/strict";
import test from "node:test";
import { envCompat, envFlag } from "./env.js";

// 在给定环境变量下执行，结束后恢复原值（包括原本不存在的情况）。
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("envCompat 优先新变量，回退旧变量", () => {
  withEnv({ QUBIUS_CONFIG: "/new.yaml", REMOTE_CODER_CONFIG: "/old.yaml" }, () => {
    assert.equal(envCompat("QUBIUS_CONFIG"), "/new.yaml");
  });
  withEnv({ QUBIUS_CONFIG: undefined, REMOTE_CODER_CONFIG: "/old.yaml" }, () => {
    assert.equal(envCompat("QUBIUS_CONFIG"), "/old.yaml");
  });
  withEnv({ QUBIUS_CONFIG: undefined, REMOTE_CODER_CONFIG: undefined }, () => {
    assert.equal(envCompat("QUBIUS_CONFIG"), undefined);
  });
  // 新变量是空串时视作未设置，继续回退旧变量。
  withEnv({ QUBIUS_CONFIG: "", REMOTE_CODER_CONFIG: "/old.yaml" }, () => {
    assert.equal(envCompat("QUBIUS_CONFIG"), "/old.yaml");
  });
});

test("envFlag 只认值为 1，且新变量优先", () => {
  withEnv({ QUBIUS_FAKE_AGENT: "1", REMOTE_CODER_FAKE_AGENT: undefined }, () => {
    assert.equal(envFlag("QUBIUS_FAKE_AGENT"), true);
  });
  withEnv({ QUBIUS_FAKE_AGENT: undefined, REMOTE_CODER_FAKE_AGENT: "1" }, () => {
    assert.equal(envFlag("QUBIUS_FAKE_AGENT"), true);
  });
  // 新变量显式关闭时，旧变量的 1 不再生效。
  withEnv({ QUBIUS_FAKE_AGENT: "0", REMOTE_CODER_FAKE_AGENT: "1" }, () => {
    assert.equal(envFlag("QUBIUS_FAKE_AGENT"), false);
  });
  withEnv({ QUBIUS_FAKE_AGENT: undefined, REMOTE_CODER_FAKE_AGENT: undefined }, () => {
    assert.equal(envFlag("QUBIUS_FAKE_AGENT"), false);
  });
});
