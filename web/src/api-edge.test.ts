import assert from "node:assert/strict";
import test from "node:test";
import { request } from "./api";
import {
  deployBusyKind,
  deployResidualPids,
  isDeployBusyError,
  isDeployResidualError,
} from "./api-deploy";
import {
  basename,
  edgeErrorCode,
  edgeErrorJobId,
  edgeErrorKind,
  edgeRemainingPids,
  isEdgeBackupName,
  isSafeBasename,
  localCommandHint,
} from "./api-edge";

/** 纯逻辑 + request 错误元数据的无 DOM 测试。 */

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respond(body: BodyInit | null, init: ResponseInit): typeof fetch {
  return async () => new Response(body, init);
}

test("basename 只保留文件名，去掉目录和查询串", () => {
  assert.equal(basename("/srv/qubius/conf/edge-registry.yaml"), "edge-registry.yaml");
  assert.equal(basename("/srv/qubius/conf/"), "conf");
  assert.equal(basename("C:\\qubius\\edge.yaml"), "edge.yaml");
  assert.equal(basename("edge.yaml?x=1"), "edge.yaml");
  assert.equal(basename(""), "");
});

test("isSafeBasename 只接受纯文件名", () => {
  assert.equal(isSafeBasename("edge-backup-job-1.Caddyfile"), true);
  assert.equal(isSafeBasename(".hidden.yaml"), true);
  assert.equal(isSafeBasename("dir/backup.yaml"), false);
  assert.equal(isSafeBasename("C:\\backup.yaml"), false);
  assert.equal(isSafeBasename("/backup.yaml"), false);
  assert.equal(isSafeBasename(".."), false);
  assert.equal(isSafeBasename("."), false);
  assert.equal(isSafeBasename("back up.yaml"), false);
  assert.equal(isSafeBasename("back\tup.yaml"), false);
  assert.equal(isSafeBasename(""), false);
});

test("isEdgeBackupName 只接受 edge-backup/edge-unknown 的 Caddyfile", () => {
  assert.equal(isEdgeBackupName("edge-backup-job-1.Caddyfile"), true);
  assert.equal(isEdgeBackupName("edge-unknown-job-9.Caddyfile"), true);
  assert.equal(isEdgeBackupName("registry-20261123.yaml"), false);
  assert.equal(isEdgeBackupName("edge-backup-.Caddyfile"), false);
  assert.equal(isEdgeBackupName("dir/edge-backup-x.Caddyfile"), false);
  assert.equal(isEdgeBackupName("edge-other-x.Caddyfile"), false);
  // 字符集与服务端 [A-Za-z0-9._-]+ 对齐：空白、非 ASCII 均不允许。
  assert.equal(isEdgeBackupName("edge-backup-bad name.Caddyfile"), false);
  assert.equal(isEdgeBackupName("edge-backup-文件.Caddyfile"), false);
});

test("localCommandHint 只展示 basename，不泄露完整路径", () => {
  const hint = localCommandHint({ name: "/srv/secret/qubius/edge-registry.yaml" });
  assert.equal(hint, "edgectl apply-local --yes --config edge-registry.yaml");
  assert.ok(!hint.includes("/srv"));
  assert.ok(!hint.includes("secret"));

  const fallback = localCommandHint(null);
  assert.equal(fallback, "edgectl apply-local --yes --config <配置文件>");
});

test("edgeErrorCode 只接受已知的分流码", () => {
  const withCode = (code: unknown) => Object.assign(new Error("x"), { code });
  assert.equal(edgeErrorCode(withCode("busy")), "busy");
  assert.equal(edgeErrorCode(withCode("stale")), "stale");
  assert.equal(edgeErrorCode(withCode("residual")), "residual");
  assert.equal(edgeErrorCode(withCode("conflict")), "conflict");
  assert.equal(edgeErrorCode(withCode("other")), undefined);
  assert.equal(edgeErrorCode(new Error("x")), undefined);
  assert.equal(edgeErrorCode("busy"), undefined);
});

test("edgeErrorKind / edgeErrorJobId / edgeRemainingPids 读结构化字段", () => {
  const error = Object.assign(new Error("锁被占用"), {
    code: "residual",
    kind: "apply",
    jobId: "job-9",
    remainingPids: [101, 202, "x", 3.5],
  });
  assert.equal(edgeErrorKind(error), "apply");
  assert.equal(edgeErrorJobId(error), "job-9");
  assert.equal(edgeErrorJobId(new Error("x")), undefined);
  assert.deepEqual(edgeRemainingPids(error), [101, 202]);
  assert.deepEqual(edgeRemainingPids(new Error("x")), []);
  assert.equal(edgeErrorKind({ kind: "apply" }), undefined);
});

test("isDeployBusyError 优先看 code，旧中文文案仍可识别", () => {
  assert.equal(isDeployBusyError(Object.assign(new Error("任意文案"), { code: "busy" })), true);
  assert.equal(isDeployBusyError(new Error("已有部署任务在运行")), true);
  assert.equal(isDeployBusyError(new Error("提交失败")), false);
  assert.equal(isDeployBusyError({ code: "busy" }), false);
});

test("deploy residual 识别残留进程", () => {
  const residual = Object.assign(new Error("锁空闲但有残留"), {
    code: "residual",
    remainingPids: [123, 456, "x"],
  });
  assert.equal(isDeployResidualError(residual), true);
  assert.deepEqual(deployResidualPids(residual), [123, 456]);
  assert.equal(isDeployResidualError(Object.assign(new Error("x"), { code: "busy" })), false);
  assert.deepEqual(deployResidualPids(new Error("x")), []);
  // residual 不应再被当成 busy 去轮询部署任务。
  assert.equal(isDeployBusyError(residual), false);
});

test("deployBusyKind 区分占用锁的任务类型", () => {
  const busy = (kind?: string) => Object.assign(new Error("锁被占用"), { code: "busy", kind });
  assert.equal(deployBusyKind(busy("apply")), "apply");
  assert.equal(deployBusyKind(busy("deploy")), "deploy");
  assert.equal(deployBusyKind(busy()), undefined);
  // 旧服务端只有中文文案：按部署任务处理。
  assert.equal(deployBusyKind(new Error("已有部署任务在运行")), undefined);
  assert.equal(deployBusyKind(new Error("其它错误")), undefined);
});

test("request 的 409 错误附带 status/code/kind/jobId/remainingPids", async () => {
  globalThis.fetch = respond(
    JSON.stringify({
      error: "还有残留进程",
      code: "residual",
      kind: "apply",
      jobId: "job-42",
      remainingPids: [111, 222],
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );

  await assert.rejects(request("/api/edge/apply", { method: "POST", body: "{}" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "还有残留进程");
    const typed = error as { status?: number; code?: string; kind?: string; jobId?: string; remainingPids?: number[] };
    assert.equal(typed.status, 409);
    assert.equal(typed.code, "residual");
    assert.equal(typed.kind, "apply");
    assert.equal(typed.jobId, "job-42");
    assert.deepEqual(typed.remainingPids, [111, 222]);
    return true;
  });
});

test("非 JSON 错误页仍附带 status，且保持旧文案", async () => {
  globalThis.fetch = respond("Bad Gateway", {
    status: 502,
    headers: { "content-type": "text/html" },
  });

  await assert.rejects(request("/api/edge"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "请求失败（502）");
    assert.equal((error as { status?: number }).status, 502);
    assert.equal((error as { code?: string }).code, undefined);
    return true;
  });
});
