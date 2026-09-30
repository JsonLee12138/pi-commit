import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "../src/core.ts";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const bun = process.execPath;
const ptyDriver = `import json, os, pty, sys
answers = json.loads(sys.argv[1])
cmd = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0: os.execvp(cmd[0], cmd)
output = b''
index = 0
while True:
    try: chunk = os.read(fd, 4096)
    except OSError: break
    if not chunk: break
    output += chunk
    if index < len(answers) and answers[index]['marker'].encode() in output:
        os.write(fd, (answers[index]['answer'] + '\\n').encode())
        index += 1
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-commit-e2e-"));
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  const agentDir = join(home, ".pi", "agent");
  await mkdir(repo, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.name", "E2E Test"]);
  await git(repo, ["config", "user.email", "e2e@example.invalid"]);
  const requests: string[] = [];
  let onRequest: (() => Promise<void>) | undefined;
  let primaryFailureStatus: number | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      requests.push(body);
      if (onRequest) await onRequest();
      if (primaryFailureStatus && JSON.parse(body).model === "fixed") {
        const message = primaryFailureStatus === 403 ? "You do not have a valid license of this product. (#3501)" : "service unavailable";
        return Response.json({ error: { message } }, { status: primaryFailureStatus });
      }
      const chunk = (content: string, finishReason: string | null) =>
        `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "fixed", choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`;
      return new Response(chunk("test: commit staged file", null) + chunk("", "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: { local: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-key", models: [{ id: "fixed" }, { id: "backup" }] } },
  }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  await mkdir(join(home, ".config", "pi-commit"), { recursive: true });
  await writeFile(join(home, ".config", "pi-commit", "config.json"), JSON.stringify({ model: "local/fixed" }));
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, ANTIGRAVITY_NO_PREWARM: "1" };
  return { repo, agentDir, requests, env,
    onRequest: (fn: () => Promise<void>) => { onRequest = fn; },
    failPrimary: (status = 503) => { primaryFailureStatus = status; },
    close: async () => { server.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}

async function run(repo: string, env: Record<string, string | undefined>, args: string[], answer?: string | Array<{ marker: string; answer: string }>) {
  const answers = typeof answer === "string" ? [{ marker: "[y/N]", answer }] : answer;
  const command = answers === undefined ? [bun, cli, ...args] : ["python3", "-u", "-c", ptyDriver, JSON.stringify(answers), bun, cli, ...args];
  const child = Bun.spawn(command, { cwd: repo, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: (output + error).replace(/\r/g, "").replace(/\x1b\[[0-9;]*m/g, "") };
  } finally { clearTimeout(timer); }
}

test("CLI 经 Pi 和本地模型提交暂存内容，保留未暂存内容", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, "note.txt"), "staged\n");
    await git(f.repo, ["add", "note.txt"]);
    await writeFile(join(f.repo, "note.txt"), "staged\nunstaged\n");
    await mkdir(join(f.repo, ".pi", "skills", "extra"), { recursive: true });
    await writeFile(join(f.repo, ".pi", "skills", "extra", "SKILL.md"), "---\nname: extra\ndescription: extra\n---\nSHOULD_NOT_APPEAR\n");
    const result = await run(f.repo, f.env, ["commit"], "y");
    expect(result.code).toBe(0);
    expect(result.output.trim()).toMatch(/Session ID: [\w-]+$/);
    expect(await git(f.repo, ["log", "-1", "--format=%s"])).toBe("test: commit staged file\n");
    expect(await git(f.repo, ["show", "HEAD:note.txt"])).toBe("staged\n");
    expect(await readFile(join(f.repo, "note.txt"), "utf8")).toBe("staged\nunstaged\n");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toContain("staged");
    expect(f.requests[0]).not.toContain("unstaged");
    expect(f.requests[0]).not.toContain("SHOULD_NOT_APPEAR");
    expect(JSON.parse(f.requests[0]!).tools).toBeUndefined();
    const id = result.output.match(/Session ID: ([\w-]+)/)?.[1];
    const sessions = [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: f.agentDir })];
    expect(sessions.some((file) => file.includes(id ?? "missing"))).toBe(true);
  } finally { await f.close(); }
}, 25_000);

test("模型列表和备用模型配置使用 Pi 的本地模型目录", async () => {
  const f = await fixture();
  try {
    const listed = await run(f.repo, f.env, ["model", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.output).toContain("local/fixed [默认]");
    const changed = await run(f.repo, f.env, ["model", "fallback", "local/backup"]);
    expect(changed.code).toBe(0);
    expect(JSON.parse(await readFile(join(f.env.HOME!, ".config", "pi-commit", "config.json"), "utf8")).fallback).toBe("local/backup");
    const providers = await run(f.repo, f.env, ["login"]);
    expect(providers.code).toBe(0);
    expect(providers.output).toContain("antigravity");
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
}, 25_000);

test("API Key 登录写入 Pi 凭证存储且终端不回显密钥", async () => {
  const f = await fixture();
  try {
    const key = "test-api-key-not-for-network";
    const result = await run(f.repo, f.env, ["login", "anthropic"], [
      { marker: "请选择编号", answer: "1" },
      { marker: "Enter Anthropic API key", answer: key },
    ]);
    if (result.code !== 0) console.error(result);
    expect(result.code).toBe(0);
    expect(result.output).toContain("anthropic 登录成功");
    expect(result.output).not.toContain(key);
    expect(JSON.parse(await readFile(join(f.agentDir, "auth.json"), "utf8")).anthropic.key).toBe(key);
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
}, 25_000);

test("默认模型服务不可用时切换一次备用模型并提交", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.env.HOME!, ".config", "pi-commit", "config.json"), JSON.stringify({ model: "local/fixed", fallback: "local/backup" }));
    await writeFile(join(f.repo, "note.txt"), "staged\n");
    await git(f.repo, ["add", "note.txt"]);
    f.failPrimary();
    const result = await run(f.repo, f.env, ["commit"], "y");
    if (result.code !== 0) console.error(result);
    expect(result.code).toBe(0);
    expect(result.output).toContain("模型：local/backup");
    expect(f.requests.map((body) => JSON.parse(body).model)).toContain("fixed");
    expect(f.requests.filter((body) => JSON.parse(body).model === "backup")).toHaveLength(1);
  } finally { await f.close(); }
}, 25_000);

test("默认模型返回许可类 403 时改用备用模型并提交", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.env.HOME!, ".config", "pi-commit", "config.json"), JSON.stringify({ model: "local/fixed", fallback: "local/backup" }));
    await writeFile(join(f.repo, "note.txt"), "staged\n");
    await git(f.repo, ["add", "note.txt"]);
    f.failPrimary(403);
    const result = await run(f.repo, f.env, ["commit"], "y");
    expect(result.code).toBe(0);
    expect(result.output).toContain("模型：local/backup");
    expect(result.output.trim()).toMatch(/Session ID: [\w-]+$/);
    expect(f.requests.filter((body) => JSON.parse(body).model === "backup")).toHaveLength(1);
    expect(await git(f.repo, ["log", "-1", "--format=%s"])).toBe("test: commit staged file\n");
  } finally { await f.close(); }
}, 25_000);

test("取消提交时保留暂存内容和可恢复会话", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, "note.txt"), "staged\n");
    await git(f.repo, ["add", "note.txt"]);
    const result = await run(f.repo, f.env, ["commit"], "n");
    expect(result.code).toBe(2);
    expect(result.output.trim()).toMatch(/Session ID: [\w-]+$/);
    expect(await git(f.repo, ["diff", "--cached", "--name-only"])).toBe("note.txt\n");
    expect(await git(f.repo, ["rev-list", "--count", "HEAD"]).catch(() => "0")).toBe("0");
  } finally { await f.close(); }
}, 25_000);

test("Git hook 失败时不绕过 hook，保留暂存内容", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, "note.txt"), "staged\n");
    await git(f.repo, ["add", "note.txt"]);
    await writeFile(join(f.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho hook-blocked >&2\nexit 1\n", { mode: 0o755 });
    const result = await run(f.repo, f.env, ["commit"], "y");
    expect(result.code).toBe(1);
    expect(result.output).toContain("hook-blocked");
    expect(result.output.trim()).toMatch(/Session ID: [\w-]+$/);
    expect(await git(f.repo, ["diff", "--cached", "--name-only"])).toBe("note.txt\n");
  } finally { await f.close(); }
}, 25_000);

test("生成期间暂存内容变化时停止提交", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, "note.txt"), "first\n");
    await git(f.repo, ["add", "note.txt"]);
    f.onRequest(async () => {
      await writeFile(join(f.repo, "note.txt"), "changed\n");
      await git(f.repo, ["add", "note.txt"]);
    });
    const result = await run(f.repo, f.env, ["commit"], "y");
    expect(result.code).toBe(1);
    expect(result.output).toContain("暂存内容在生成文案后发生变化");
    expect(result.output.trim()).toMatch(/Session ID: [\w-]+$/);
  } finally { await f.close(); }
}, 25_000);

test("无暂存或疑似凭证时不调用模型，也不创建会话", async () => {
  const f = await fixture();
  try {
    const empty = await run(f.repo, f.env, ["commit"]);
    expect(empty.code).toBe(1);
    expect(empty.output).toContain("没有已暂存改动");
    await writeFile(join(f.repo, ".env"), "SECRET=example\n");
    await git(f.repo, ["add", ".env"]);
    const secret = await run(f.repo, f.env, ["commit"]);
    expect(secret.code).toBe(1);
    expect(secret.output).toContain("疑似凭证文件");
    expect(secret.output).not.toContain("Session ID:");
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
}, 25_000);
