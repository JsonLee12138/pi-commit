import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export async function git(cwd: string, args: string[], input?: string) {
  const child = spawn("git", args, {
    cwd,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const stdoutPromise = collect(child.stdout!);
  const stderrPromise = collect(child.stderr!);
  if (input !== undefined) child.stdin?.end(input);
  const [stdout, stderr, code] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    }),
  ]);
  if (code !== 0) throw new Error((stderr || stdout).trim() || `git ${args[0]} failed (${code})`);
  return stdout;
}

function collect(stream: Readable) {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { output += chunk; });
    stream.once("error", reject);
    stream.once("end", () => resolve(output));
  });
}

export async function staged(cwd: string) {
  await git(cwd, ["rev-parse", "--show-toplevel"]);
  const names = (await git(cwd, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
  if (!names.length) throw new Error("没有已暂存改动；请先用 git add 暂存要提交的文件。");
  const suspicious = names.filter((name) => /(^|\/)(\.env(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12))$/i.test(name));
  if (suspicious.length) throw new Error(`疑似凭证文件已暂存，请先检查：${suspicious.join(", ")}`);
  const diff = await git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary"]);
  if (Buffer.byteLength(diff) > 200_000) throw new Error("暂存 diff 超过 200 KB；请拆分提交后重试。");
  if (/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/i.test(diff)) {
    throw new Error("暂存 diff 疑似包含密钥或令牌；请检查暂存内容。");
  }
  return { diff, fingerprint: createHash("sha256").update(diff).digest("hex") };
}

export function commitMessage(text: string) {
  const message = text.trim().replace(/^```(?:text)?\s*\n|\n```$/g, "").trim();
  if (!/^[a-z]+(?:\([^)\n]+\))?!?: \S.*$/.test(message.split("\n", 1)[0] ?? "")) {
    throw new Error("模型未生成有效的 Conventional Commit 标题。");
  }
  return message;
}

export function recoverable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b/.test(message)) return false;
  return /(?:timeout|timed out|network|ECONN|ENOTFOUND|EAI_AGAIN|rate.?limit|429|50[0234]|service unavailable|\b403\b)/i.test(message);
}
