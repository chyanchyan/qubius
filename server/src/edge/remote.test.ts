import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CommandResult, CommandRunner, CommandSpec } from "./cli.js";
import { sha256Hex } from "./canonical.js";
import { readRegistry } from "./registry.js";
import {
  backupRemoteFile,
  caddyReload,
  caddyValidateCandidate,
  caddyValidateLive,
  caddyVersion,
  expandHome,
  parseCaddyVersion,
  prepareSshControlDir,
  readRemoteFile,
  remoteSha,
  restoreRemoteFile,
  shellQuote,
  sshCommand,
  sshControlPath,
  writeRemoteFileInPlace,
} from "./remote.js";
import { EdgeError, type EdgeRegistry, type EdgeSecrets } from "./types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "registry", "edgectl.yaml");
const COOKIE = "fedcba9876543210fedcba9876543210";

function baseRegistry(): EdgeRegistry {
  return readRegistry(FIXTURE);
}

function registryWith(vps: Partial<EdgeRegistry["vps"]>): EdgeRegistry {
  const base = baseRegistry();
  return { ...base, vps: { ...base.vps, ...vps } };
}

type Handler = (spec: CommandSpec) => Partial<CommandResult>;

function fakeRunner(handler: Handler): { runner: CommandRunner; calls: CommandSpec[] } {
  const calls: CommandSpec[] = [];
  const runner: CommandRunner = (spec) => {
    calls.push(spec);
    return { status: 0, stdout: "", stderr: "", signal: null, ...handler(spec) };
  };
  return { runner, calls };
}

function remoteScript(spec: CommandSpec): string {
  return spec.args[spec.args.length - 1]!;
}

const DEFAULT_CONTROL_PATH = path.join(os.homedir(), ".ssh", "qubius-control", "qubius-%C");

test("sshCommand 与 edgectl 一致（默认 key、端口 22 省略 -p、开启连接复用）", () => {
  const registry = baseRegistry();
  assert.deepEqual(sshCommand(registry, {}), [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${DEFAULT_CONTROL_PATH}`,
    "-o",
    "ControlPersist=60s",
    "-i",
    expandHome("~/.ssh/edgectl_vps"),
    "ubuntu@203.0.113.10",
  ]);
});

test("sshCommand：空 key 省略 -i，非 22 端口加 -p", () => {
  const registry = registryWith({ sshKey: "", sshPort: 2222 });
  assert.deepEqual(sshCommand(registry, {}), [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${DEFAULT_CONTROL_PATH}`,
    "-o",
    "ControlPersist=60s",
    "-p",
    "2222",
    "ubuntu@203.0.113.10",
  ]);
});

test("sshControlPath：XDG 专属子目录、相对 XDG 回退 home、自定义优先", () => {
  assert.equal(
    sshControlPath({ XDG_RUNTIME_DIR: "/run/user/1000" }),
    "/run/user/1000/qubius-ssh/qubius-%C",
  );
  // XDG 为相对路径时不可用，回退到 home 下的专属子目录。
  assert.equal(
    sshControlPath({ XDG_RUNTIME_DIR: "relative/run", HOME: "/home/u" }),
    "/home/u/.ssh/qubius-control/qubius-%C",
  );
  assert.equal(
    sshControlPath({ QUBIUS_SSH_CONTROL_PATH: "~/sock/qubius-%C", HOME: "/home/u" }),
    "/home/u/sock/qubius-%C",
  );
  // 自定义路径优先于 XDG。
  assert.equal(
    sshControlPath({
      XDG_RUNTIME_DIR: "/run/user/1000",
      QUBIUS_SSH_CONTROL_PATH: "/custom/dir/qubius-%C",
    }),
    "/custom/dir/qubius-%C",
  );
  // 不用 %C 时必须同时含远端用户 + 主机 + 端口。
  assert.equal(
    sshControlPath({ QUBIUS_SSH_CONTROL_PATH: "/custom/dir/qubius-%r-%h-%p" }),
    "/custom/dir/qubius-%r-%h-%p",
  );
  assert.equal(
    sshControlPath({ QUBIUS_SSH_CONTROL_PATH: "/custom/dir/qubius-%r-%n-%p" }),
    "/custom/dir/qubius-%r-%n-%p",
  );
  const argv = sshCommand(baseRegistry(), {
    QUBIUS_SSH_CONTROL_PATH: "/custom/dir/qubius-%C",
  });
  assert.ok(argv.includes("ControlPath=/custom/dir/qubius-%C"));
});

test("sshControlPath：自定义路径必须绝对且 token 足够区分目标", () => {
  assert.throws(
    () => sshControlPath({ QUBIUS_SSH_CONTROL_PATH: "relative/qubius-%C" }),
    /必须是绝对路径/,
  );
  // 完全没 token：所有目标共用一个 socket。
  assert.throws(
    () => sshControlPath({ QUBIUS_SSH_CONTROL_PATH: "/custom/dir/qubius-socket" }),
    /必须包含 %C/,
  );
  assert.throws(
    () => sshCommand(baseRegistry(), { QUBIUS_SSH_CONTROL_PATH: "/custom/control" }),
    /必须包含 %C/,
  );
  // 只有主机+端口会错误复用不同远端用户的连接。
  assert.throws(
    () => sshControlPath({ QUBIUS_SSH_CONTROL_PATH: "/custom/dir/qubius-%h-%p" }),
    /必须包含 %C/,
  );
  assert.throws(
    () => sshControlPath({ QUBIUS_SSH_CONTROL_PATH: "/custom/dir/qubius-%r-%h" }),
    /必须包含 %C/,
  );
  assert.throws(
    () => sshControlPath({ QUBIUS_SSH_CONTROL_PATH: "/custom/dir/qubius-%r-%p" }),
    /必须包含 %C/,
  );
  // `..` 会把 token 解析掉：必须在 resolve 之后校验。
  assert.throws(
    () => sshControlPath({ QUBIUS_SSH_CONTROL_PATH: "/custom/dir/qubius-%C/../sock" }),
    /必须包含 %C/,
  );
  // token 出现在目录部分会让准备目录与 ssh 展开结果不一致。
  assert.throws(
    () => sshControlPath({ QUBIUS_SSH_CONTROL_PATH: "/custom/qubius-%C/sock" }),
    /只能出现在文件名/,
  );
});

test("sshCommand 是纯函数：不创建任何目录", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-ssh-pure-"));
  sshCommand(baseRegistry(), { HOME: home });
  assert.equal(fs.existsSync(path.join(home, ".ssh")), false);
});

test("prepareSshControlDir 只创建专属子目录，不改父目录权限", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-ssh-home-"));
  const sshHome = path.join(home, ".ssh");
  fs.mkdirSync(sshHome, { mode: 0o755 });
  fs.chmodSync(sshHome, 0o755);
  const argv = sshCommand(baseRegistry(), { HOME: home });
  prepareSshControlDir(argv);
  const dir = path.join(sshHome, "qubius-control");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  // 父目录权限不被收紧（只对专属子目录 chmod）。
  assert.equal(fs.statSync(sshHome).mode & 0o777, 0o755);
});

test("注入 mock runner 时不做任何目录准备", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-ssh-nohome-"));
  const { runner } = fakeRunner(() => ({ stdout: "x" }));
  readRemoteFile(baseRegistry(), { runner, env: { HOME: home } });
  assert.equal(fs.existsSync(path.join(home, ".ssh")), false);
});

test("sshCommand：QUBIUS_SSH_CONTROL=0 关闭连接复用", () => {
  const registry = baseRegistry();
  const argv = sshCommand(registry, { QUBIUS_SSH_CONTROL: "0" });
  assert.deepEqual(argv, [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-i",
    expandHome("~/.ssh/edgectl_vps"),
    "ubuntu@203.0.113.10",
  ]);
  assert.equal(argv.some((part) => part.startsWith("ControlPath=")), false);
});

test("readRemoteFile 把注入的 env 传给 sshCommand（可关闭复用）", () => {
  const registry = baseRegistry();
  const { runner, calls } = fakeRunner(() => ({ stdout: "x" }));
  readRemoteFile(registry, { runner, env: { QUBIUS_SSH_CONTROL: "0" } });
  assert.equal(
    calls[0]!.args.some((part) => part.startsWith("ControlPath=")),
    false,
  );
});

test("readRemoteFile 使用 cat -- <path>，返回原始内容与 sha", () => {
  const registry = baseRegistry();
  const content = "hello\nworld\n";
  const { runner, calls } = fakeRunner(() => ({ stdout: content }));
  const read = readRemoteFile(registry, { runner });
  assert.equal(read.content, content);
  assert.equal(read.sha, sha256Hex(content));
  assert.match(remoteScript(calls[0]!), /^cat -- '/);
  assert.ok(remoteScript(calls[0]!).includes(registry.vps.caddyfile));
  assert.equal(calls[0]!.command, "ssh");
  assert.ok(calls[0]!.args.includes("BatchMode=yes"));
  assert.equal(remoteSha(registry, { runner }), sha256Hex(content));
});

test("readRemoteFile 失败抛错并脱敏", () => {
  const registry = baseRegistry();
  const secrets: EdgeSecrets = {
    passwordHash: "$2a$14$FakeSaltValue123456789FakeHashValue1234567890ABCDEFGH",
    cookieSecret: COOKIE,
    secretsSha: "x",
    passwordHashSource: "envfile",
    cookieSecretSource: "envfile",
  };
  const { runner } = fakeRunner(() => ({
    status: 1,
    stderr: `denied ${COOKIE} https://user:pw@host/x`,
  }));
  assert.throws(
    () => readRemoteFile(registry, { runner, secrets }),
    (error: unknown) =>
      error instanceof EdgeError &&
      !error.message.includes(COOKIE) &&
      !error.message.includes("user:pw") &&
      error.message.includes("<redacted>"),
  );
});

test("writeRemoteFileInPlace 通过 stdin 原地 cat >，不换 inode", () => {
  const registry = baseRegistry();
  const content = "new content\n";
  const { runner, calls } = fakeRunner(() => ({}));
  const result = writeRemoteFileInPlace(registry, content, { runner });
  assert.equal(result.ok, true);
  assert.equal(calls[0]!.input, content);
  assert.match(remoteScript(calls[0]!), /^umask 077; cat > '/);
  assert.ok(remoteScript(calls[0]!).includes(registry.vps.caddyfile));
});

test("caddyValidateCandidate：可写目录、候选名、stdin 内容、清理命令", () => {
  const registry = baseRegistry();
  const content = "candidate\n";
  const { runner, calls } = fakeRunner(() => ({}));
  const result = caddyValidateCandidate(registry, content, "job-1", { runner });

  assert.equal(result.fallback, false);
  assert.equal(result.candidateDir, path.posix.dirname(registry.vps.caddyfileContainer));
  assert.equal(result.candidate, `${result.candidateDir}/.qubius-candidate-job-1`);
  assert.equal(calls.length, 2); // probe + validate
  assert.match(remoteScript(calls[0]!), /test -d .* && test -w/);
  const script = remoteScript(calls[1]!);
  assert.match(script, /docker exec -i 'example-caddy' sh -c '/);
  assert.match(script, /umask 077; cat > '.*\.qubius-candidate-job-1'/);
  assert.match(script, /caddy validate --config .*\.qubius-candidate-job-1.* --adapter caddyfile/);
  assert.match(script, /rc=\$\?; rm -f .*\.qubius-candidate-job-1.*; exit \$rc/);
  assert.equal(calls[1]!.input, content);
});

test("caddyValidateCandidate：目录不可写回退 /tmp 并注明", () => {
  const registry = baseRegistry();
  const { runner, calls } = fakeRunner((spec) => {
    if (remoteScript(spec).includes("test -d")) return { status: 1 };
    return {};
  });
  const result = caddyValidateCandidate(registry, "x\n", "job-2", { runner });
  assert.equal(result.fallback, true);
  assert.equal(result.candidateDir, "/tmp");
  assert.equal(result.candidate, "/tmp/.qubius-candidate-job-2");
  assert.ok(remoteScript(calls[1]!).includes("/tmp/.qubius-candidate-job-2"));
});

test("caddyValidateCandidate：checkWritable=false 时跳过探测", () => {
  const registry = baseRegistry();
  const { runner, calls } = fakeRunner(() => ({}));
  caddyValidateCandidate(registry, "x\n", "job-3", { runner, checkWritable: false });
  assert.equal(calls.length, 1);
});

test("caddyValidateCandidate 拒绝不安全 jobId", () => {
  const registry = baseRegistry();
  const { runner } = fakeRunner(() => ({}));
  assert.throws(
    () => caddyValidateCandidate(registry, "x", "../evil", { runner }),
    /非法 jobId/,
  );
});

test("caddyValidateLive / caddyReload 使用注册表校验值且 argv 直传", () => {
  const registry = baseRegistry();
  const { runner, calls } = fakeRunner(() => ({}));
  const validate = caddyValidateLive(registry, { runner });
  assert.equal(validate.ok, true);
  const validateScript = remoteScript(calls[0]!);
  assert.match(validateScript, /docker exec 'example-caddy' sh -c '/);
  assert.ok(validateScript.includes("caddy validate --config"));
  assert.ok(validateScript.includes(registry.vps.caddyfileContainer));
  assert.ok(validateScript.includes("--adapter caddyfile"));

  caddyReload(registry, { runner });
  const reloadScript = remoteScript(calls[1]!);
  assert.ok(reloadScript.includes("caddy reload --config"));
  assert.ok(reloadScript.includes(registry.vps.caddyfileContainer));
});

test("shellQuote 处理单引号，expandHome 展开 ~", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(expandHome("~/x", "/home/u"), "/home/u/x");
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("/abs", "/home/u"), "/abs");
});

test("sshCommand 拒绝以 - 开头的 target（纵深防御）", () => {
  const registry = registryWith({ ssh: "-oProxyCommand=evil" });
  assert.throws(() => sshCommand(registry), /不能为空或以 - 开头/);
});

test("caddyVersion 探测并解析版本", () => {
  const registry = baseRegistry();
  const { runner, calls } = fakeRunner(() => ({ stdout: "v2.7.6 h1:abcdef\n" }));
  const probe = caddyVersion(registry, { runner });
  assert.equal(probe.version, "2.7.6");
  assert.match(remoteScript(calls[0]!), /docker exec 'example-caddy' caddy version/);

  const failed = fakeRunner(() => ({ status: 1, stderr: "not found" }));
  assert.equal(caddyVersion(registry, { runner: failed.runner }).version, null);
  assert.equal(parseCaddyVersion("2.10.0"), "2.10.0");
  assert.equal(parseCaddyVersion("no version"), null);
});

test("backupRemoteFile 使用 cp -a，restoreRemoteFile 写回备份内容", () => {
  const registry = baseRegistry();
  const { runner, calls } = fakeRunner(() => ({}));
  const backup = backupRemoteFile(registry, { runner, suffix: "2026-01-02T03-04-05" });
  assert.equal(backup.backup, `${registry.vps.caddyfile}.bak.2026-01-02T03-04-05`);
  const cpScript = remoteScript(calls[0]!);
  assert.match(cpScript, /^cp -a -- '/);
  assert.ok(cpScript.includes(registry.vps.caddyfile));

  const restore = restoreRemoteFile(registry, backup.backup!, { runner });
  assert.equal(restore.ok, true);
  const restoreScript = remoteScript(calls[1]!);
  assert.match(restoreScript, /^umask 077; cat -- '/);
  assert.ok(restoreScript.includes(`${registry.vps.caddyfile}.bak.`));
});

test("restoreRemoteFile 拒绝非本工具生成的备份路径", () => {
  const registry = baseRegistry();
  const { runner } = fakeRunner(() => ({}));
  assert.throws(
    () => restoreRemoteFile(registry, "/etc/passwd", { runner }),
    /不属于当前 Caddyfile/,
  );
  assert.throws(
    () => restoreRemoteFile(registry, "relative.bak.x", { runner }),
    /必须是绝对路径/,
  );
  assert.throws(
    () =>
      restoreRemoteFile(
        registry,
        `${registry.vps.caddyfile}.bak.../../etc/shadow`,
        { runner },
      ),
    /备份文件名不合法/,
  );
  assert.throws(
    () => backupRemoteFile(registry, { runner, suffix: "bad suffix" }),
    /非法备份后缀/,
  );
});
