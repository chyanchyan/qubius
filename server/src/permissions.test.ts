import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decideTool, isInside } from "./permissions.js";

const root = path.resolve("session-worktree");

test("工作区内的读、改和普通命令自动通过", () => {
  assert.equal(decideTool({ toolName: "Read", input: { file_path: "src/app.ts" }, cwd: root }), "allow");
  assert.equal(decideTool({ toolName: "Edit", input: { file_path: path.join(root, "src", "app.ts") }, cwd: root }), "allow");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "npm test" }, cwd: root }), "allow");
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "curl https://example.com/a" }, cwd: root }),
    "allow",
  );
});

test("工作区外的路径和越界命令需要确认", () => {
  const outside = path.resolve(root, "..", "secret.txt");
  assert.equal(decideTool({ toolName: "Read", input: { file_path: outside }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Read", input: { file_path: "../secret.txt" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat ../secret.txt" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat /etc/passwd" }, cwd: root }), "ask");
  assert.equal(
    decideTool({ toolName: "Read", input: { file_path: "src/app.ts" }, cwd: root, blockedPath: outside }),
    "ask",
  );
});

test("全部允许时工作区外的命令也通过，提问仍然要确认", () => {
  assert.equal(
    decideTool({
      toolName: "Bash",
      input: { command: "cat /etc/passwd" },
      cwd: root,
      permission: "bypassPermissions",
    }),
    "allow",
  );
  assert.equal(
    decideTool({
      toolName: "AskUserQuestion",
      input: { questions: [] },
      cwd: root,
      permission: "bypassPermissions",
    }),
    "ask",
  );
});

test("需要确认时，工作区内的修改和命令要询问", () => {
  assert.equal(
    decideTool({ toolName: "Read", input: { file_path: "src/app.ts" }, cwd: root, permission: "default" }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Edit", input: { file_path: "src/app.ts" }, cwd: root, permission: "default" }),
    "ask",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "npm test" }, cwd: root, permission: "default" }),
    "ask",
  );
});

test("只规划时拒绝修改，仍允许读取", () => {
  assert.equal(
    decideTool({ toolName: "Read", input: { file_path: "src/app.ts" }, cwd: root, permission: "plan" }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Edit", input: { file_path: "src/app.ts" }, cwd: root, permission: "plan" }),
    "deny",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "npm test" }, cwd: root, permission: "plan" }),
    "deny",
  );
});

test("自动判断把决定不了的调用交给确认", () => {
  assert.equal(
    decideTool({ toolName: "Read", input: { file_path: "src/app.ts" }, cwd: root, permission: "auto" }),
    "ask",
  );
});

test("变量展开、Home、双斜杠和命令替换都要确认", () => {
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat $HOME/.ssh/id_rsa" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat ~/.aws/credentials" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat //etc/passwd" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "echo $(whoami)" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "echo `id`" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat <(echo hi)" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat >(tee output.txt)" }, cwd: root }), "ask");
});

test("工作区内的正常命令和 URL 不被误判", () => {
  assert.equal(decideTool({ toolName: "Bash", input: { command: "npm test" }, cwd: root }), "allow");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat src/app.ts" }, cwd: root }), "allow");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "curl https://example.com/a" }, cwd: root }), "allow");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "echo hi > out.txt" }, cwd: root }), "allow");
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "awk '{print $1}' src/x.ts" }, cwd: root }),
    "allow",
  );
  assert.equal(decideTool({ toolName: "Bash", input: { command: "git diff HEAD~1" }, cwd: root }), "allow");
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "git commit -m \"fix ~\"" }, cwd: root }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "git remote add origin ssh://git@host/repo" }, cwd: root }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "npm run build -- --outDir=dist/assets" }, cwd: root }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "gcc -I./include main.c" }, cwd: root }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "gcc -I/usr/include main.c" }, cwd: root }),
    "ask",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "git commit -m \"cost $ 5\"" }, cwd: root }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "echo \\$HOME" }, cwd: root }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "sed -i 's/foo\\/bar/baz/' file" }, cwd: root }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "git commit -m 'see //x'" }, cwd: root }),
    "allow",
  );
  assert.equal(decideTool({ toolName: "Bash", input: { command: "echo a//b" }, cwd: root }), "allow");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "echo --out=~/x" }, cwd: root }), "allow");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "foo=~/x" }, cwd: root }), "ask");
});

test("重定向、管道和 file:// 里的工作区外路径也要确认", () => {
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat</etc/passwd" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat >/etc/motd" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat /etc/passwd | wc -l" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "echo pwn >../outside.txt" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat <../secret" }, cwd: root }), "ask");
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat \\/etc/passwd" }, cwd: root }), "ask");
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "curl https://example.com/x>/tmp/pwned" }, cwd: root }),
    "ask",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "curl file:/etc/passwd" }, cwd: root }),
    "ask",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "bash -c 'cat $HOME/.ssh/id_rsa'" }, cwd: root }),
    "ask",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "sh -c 'echo `id`'" }, cwd: root }),
    "ask",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "eval 'cat ~/.ssh/id_rsa'" }, cwd: root }),
    "ask",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "curl file:///etc/passwd" }, cwd: root }),
    "ask",
  );
});

test("软链接逃逸：工作区内指向外部的链接不算工作区内", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-perm-"));
  try {
    const work = path.join(base, "work");
    fs.mkdirSync(work);
    const secret = path.join(base, "secret.txt");
    fs.writeFileSync(secret, "secret");
    const link = path.join(work, "link");
    try {
      fs.symlinkSync(secret, link);
    } catch (error) {
      // Windows 无权限创建软链接时跳过这条用例。
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    assert.equal(isInside(work, link), false);
    assert.equal(isInside(work, path.join(work, "..", "secret.txt")), false);
    assert.equal(isInside(work, path.join(work, "src", "app.ts")), true);
    assert.equal(decideTool({ toolName: "Read", input: { file_path: link }, cwd: work }), "ask");
    assert.equal(decideTool({ toolName: "Read", input: { file_path: "link" }, cwd: work }), "ask");
    assert.equal(
      decideTool({ toolName: "Read", input: { path: path.join(work, "src", "app.ts") }, cwd: work }),
      "allow",
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("悬空软链接和连续 .. 不能绕过工作区", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-perm-"));
  try {
    const work = path.join(base, "work");
    fs.mkdirSync(work);
    const dangling = path.join(work, "dangling");
    try {
      fs.symlinkSync(path.join(base, "missing.txt"), dangling);
    } catch (error) {
      // Windows 无权限创建软链接时跳过这条用例。
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    assert.equal(isInside(work, dangling), false);
    assert.equal(decideTool({ toolName: "Write", input: { file_path: "dangling" }, cwd: work }), "ask");
    assert.equal(
      decideTool({ toolName: "Bash", input: { command: "cat ./../../etc/passwd" }, cwd: work }),
      "ask",
    );
    assert.equal(
      decideTool({ toolName: "Bash", input: { command: "cat foo/../../etc/passwd" }, cwd: work }),
      "ask",
    );
    // 工作区内指向外部的相对软链接也不能用 `cat link` 绕过。
    const outside = path.join(base, "outside.txt");
    fs.writeFileSync(outside, "outside");
    const outsideLink = path.join(work, "outside-link");
    const insideText = path.join(work, "inside.txt");
    fs.writeFileSync(insideText, "inside");
    const insideLink = path.join(work, "inside-link");
    fs.symlinkSync(outside, outsideLink);
    fs.symlinkSync(insideText, insideLink);
    assert.equal(
      decideTool({ toolName: "Bash", input: { command: "cat outside-link" }, cwd: work }),
      "ask",
    );
    assert.equal(
      decideTool({ toolName: "Bash", input: { command: "cat inside-link" }, cwd: work }),
      "allow",
    );
    // 短选项后直接粘路径也不能绕过。
    assert.equal(
      decideTool({ toolName: "Bash", input: { command: "tar -xf/etc/shadow" }, cwd: work }),
      "ask",
    );
    assert.equal(
      decideTool({ toolName: "Bash", input: { command: "curl -o/etc/cron.d/x" }, cwd: work }),
      "ask",
    );
    // 目录软链接和 link/.. 都要按内核语义解析。
    const outDir = path.join(base, "out");
    fs.mkdirSync(path.join(outDir, "a"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "secret.txt"), "secret");
    const dirLink = path.join(work, "linkdir");
    fs.symlinkSync(outDir, dirLink);
    assert.equal(isInside(work, "linkdir/secret.txt"), false);
    assert.equal(
      decideTool({ toolName: "Bash", input: { command: "cat linkdir/secret.txt" }, cwd: work }),
      "ask",
    );
    const dirLink2 = path.join(work, "alink");
    fs.symlinkSync(path.join(outDir, "a"), dirLink2);
    assert.equal(isInside(work, "alink/../secret.txt"), false);
    assert.equal(
      decideTool({ toolName: "Read", input: { file_path: "alink/../secret.txt" }, cwd: work }),
      "ask",
    );
    // 粘连在短选项后的相对值也可能是软链接。
    fs.symlinkSync(outDir, path.join(work, "include"));
    assert.equal(
      decideTool({ toolName: "Bash", input: { command: "gcc -Iinclude main.c" }, cwd: work }),
      "ask",
    );
    fs.symlinkSync(outside, path.join(work, "outfile"));
    assert.equal(
      decideTool({ toolName: "Bash", input: { command: "curl -ooutfile https://example.com" }, cwd: work }),
      "ask",
    );
    // 空引号拼接不能把真实路径切碎。
    fs.symlinkSync(outside, path.join(work, "link"));
    assert.equal(decideTool({ toolName: "Bash", input: { command: "cat link" }, cwd: work }), "ask");
    assert.equal(decideTool({ toolName: "Bash", input: { command: "cat li''nk" }, cwd: work }), "ask");
    assert.equal(decideTool({ toolName: "Bash", input: { command: "cat l\"ink\"" }, cwd: work }), "ask");
    assert.equal(decideTool({ toolName: "Bash", input: { command: "cat .''./secret" }, cwd: work }), "ask");
    // 工作区内尚未创建的文件仍然算工作区内。
    assert.equal(isInside(work, path.join(work, "new", "file.txt")), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("嵌套 shell、转义路径和 ANSI-C 引用不能绕过", () => {
  for (const command of [
    "bash -l -c 'cat $HOME/.ssh/id_rsa'",
    "sh -e -c 'cat ~/.aws/credentials'",
    "bash --norc -c 'cat $HOME/x'",
    "echo 'cat $HOME/.ssh/id_rsa' | bash",
    "bash <<< 'cat $HOME/x'",
    "cat '\\' $HOME/.ssh/id_rsa",
    "cat '\\' ~/.aws/credentials",
    "cat \\.\\./secret",
    "cat \\//etc/passwd",
    "cat $'\\x2fetc\\x2fpasswd'",
    "cat \\' //etc/passwd \\'",
    "cat \\\" ~/.ssh/id_rsa",
    "cat \\' ~/.ssh/id_rsa",
    "rm -rf /",
    "cat /",
    "python3 -c 'print(open(\"\\x2e\\x2e/secret\").read())'",
    "cat \"don't\" //etc/passwd",
    "cat \"a'b\" 'c' //etc/passwd",
    "cat {x,/etc/passwd}",
    "cat {x,//etc/passwd}",
    "node --eval 'const fs=require(\"fs\");fs.readFileSync(\"\\x2fetc\\x2fpasswd\")'",
    "python3 -c 'print(open(\"\\057etc\\057passwd\").read())'",
    "php -r 'readfile(\"\\x2fetc\\x2fpasswd\")'",
    "node -p '1+1'",
    "perl -E 'say 1'",
    "deno eval 'console.log(1)'",
    "python -c 'print(1)'",
    "cat .''./secret",
    "python3 -B -c 'print(open(chr(47)+\"etc/passwd\").read())'",
    "node --no-warnings -e '1'",
    "printf 'x' | python3 -",
    "python3 <<'EOF'\nprint(1)\nEOF",
    "Rscript -e 'cat(1)'",
    "find . -exec python3 -c {} \\;",
    "ls\npython3 -c '1'",
    "(python3 -c '1')",
    "time python3 -c '1'",
    "sudo -u root python3 -c '1'",
    "env -i python3 -c '1'",
    "npx node -e '1'",
    "xargs python3 -c '1'",
    "bash -c 'python3 -c \"print(chr(47))\"'",
  ]) {
    assert.equal(decideTool({ toolName: "Bash", input: { command }, cwd: root }), "ask", command);
  }
  // 普通 `-c` 选项、`grep -e`、`echo -e` 和转义的 ~ 不应被误判。
  assert.equal(decideTool({ toolName: "Bash", input: { command: "gcc -c main.c" }, cwd: root }), "allow");
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "grep -e 'a\\x41b' src/x.ts" }, cwd: root }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "echo -e '\\x1b[32m'" }, cwd: root }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "git commit -c HEAD -m 'cost $ 5'" }, cwd: root }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "git commit -m \"python is fun\"" }, cwd: root }),
    "allow",
  );
  assert.equal(
    decideTool({ toolName: "Bash", input: { command: "grep python file" }, cwd: root }),
    "allow",
  );
  assert.equal(decideTool({ toolName: "Bash", input: { command: "cat \\~/x" }, cwd: root }), "allow");
});

test("提问和未列入的工具需要确认", () => {
  assert.equal(
    decideTool({
      toolName: "AskUserQuestion",
      input: { questions: [] },
      cwd: root,
    }),
    "ask",
  );
  assert.equal(decideTool({ toolName: "Notebook", input: {}, cwd: root }), "ask");
});

test("cwd 本身是软链接时，相对和绝对路径判定一致", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-perm-"));
  try {
    const work = path.join(base, "work");
    fs.mkdirSync(path.join(work, "src"), { recursive: true });
    const inside = path.join(work, "src", "app.ts");
    fs.writeFileSync(inside, "app");
    const outside = path.join(base, "secret.txt");
    fs.writeFileSync(outside, "secret");
    const workLink = path.join(base, "worklink");
    try {
      fs.symlinkSync(work, workLink, "dir");
    } catch (error) {
      // Windows 无权限创建软链接时跳过这条用例。
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    // 相对候选和绝对候选都必须按解析后的真实工作区根目录判断。
    assert.equal(isInside(workLink, "src/app.ts"), true);
    assert.equal(isInside(workLink, inside), true);
    assert.equal(isInside(workLink, "../secret.txt"), false);
    assert.equal(isInside(workLink, outside), false);
    assert.equal(decideTool({ toolName: "Read", input: { file_path: "src/app.ts" }, cwd: workLink }), "allow");
    assert.equal(decideTool({ toolName: "Bash", input: { command: "cat src/app.ts" }, cwd: workLink }), "allow");
    assert.equal(decideTool({ toolName: "Bash", input: { command: "cat ../secret.txt" }, cwd: workLink }), "ask");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
