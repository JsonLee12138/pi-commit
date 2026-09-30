import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMessage, git, recoverable, staged } from "../src/core.ts";

test("只读取暂存内容，拒绝凭证，检测暂存变化", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-commit-"));
  try {
    await git(cwd, ["init", "-q"]);
    await writeFile(join(cwd, "a.txt"), "first\n");
    await git(cwd, ["add", "a.txt"]);
    const first = await staged(cwd);
    await writeFile(join(cwd, "a.txt"), "first\nunstaged\n");
    expect((await staged(cwd)).fingerprint).toBe(first.fingerprint);
    await git(cwd, ["add", "a.txt"]);
    expect((await staged(cwd)).fingerprint).not.toBe(first.fingerprint);
    await writeFile(join(cwd, ".env"), "TOKEN=x\n");
    await git(cwd, ["add", ".env"]);
    expect(staged(cwd)).rejects.toThrow("凭证");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("文案与 fallback 条件", () => {
  expect(commitMessage("feat(cli): add commit flow\n\nBody")).toStartWith("feat(cli):");
  expect(() => commitMessage("hello")).toThrow();
  expect(recoverable(new Error("HTTP 429 rate limit"))).toBe(true);
  expect(recoverable(new Error("missing API key"))).toBe(false);
});
