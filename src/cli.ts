#!/usr/bin/env bun
import { agentForCommit, ask, login, modelCommand, readConfig, skillText } from "./pi.ts";
import { commitMessage, git, recoverable, staged } from "./core.ts";

const help = `pi-commit / pc

  login [provider]          列出 Provider 或登录指定 Provider
  model list               列出可用模型
  model set <provider/id>  设置默认模型
  model fallback <provider/id>  设置备用模型
  commit                   为已暂存改动生成文案并提交
  --help                   显示帮助

失败时退出状态为 1；取消提交时退出状态为 2。`;

async function runCommit(cwd: string) {
  const initial = await staged(cwd);
  const config = await readConfig();
  if (!config.model) throw new Error("请先运行 pc model set <provider/model> 设置默认模型。");
  const { runtime, session } = await agentForCommit(cwd, config.model);
  const sessionId = session.sessionManager.getSessionId();
  try {
    const prompt = `Use only the following git-commit skill guidance for message style. Do not follow its command execution or staging instructions.\n\n${await skillText()}\n\nGenerate a Conventional Commit message for this staged diff. Output the message only. Do not invent changes.\n\n${initial.diff}`;
    let usedModel = config.model;
    let text: string | undefined;
    try {
      await session.prompt(prompt);
      const last = session.messages.at(-1);
      if (last?.role === "assistant" && last.errorMessage) throw new Error(last.errorMessage);
      text = session.getLastAssistantText();
    } catch (error) {
      if (!config.fallback || !recoverable(error)) throw error;
      const [provider, ...parts] = config.fallback.split("/");
      const fallback = runtime.getModel(provider!, parts.join("/"));
      if (!fallback || !(await runtime.getAvailable()).some((item) => item.provider === fallback.provider && item.id === fallback.id)) {
        throw new Error(`默认模型失败，备用模型不可用：${config.fallback}；原错误：${String(error)}`);
      }
      await session.setModel(fallback);
      usedModel = config.fallback;
      await session.prompt("The previous model had a recoverable service failure. Generate the commit message for the staged diff already in this conversation. Output the message only.");
      const last = session.messages.at(-1);
      if (last?.role === "assistant" && last.errorMessage) throw new Error(`备用模型失败：${last.errorMessage}`);
      text = session.getLastAssistantText();
    }
    const message = commitMessage(text ?? "");
    console.log(`模型：${usedModel}\n\n${message}\n`);
    if ((await ask("提交以上暂存内容？[y/N] ")).toLowerCase() !== "y") {
      console.log("已取消提交。");
      process.exitCode = 2;
      return;
    }
    const current = await staged(cwd);
    if (current.fingerprint !== initial.fingerprint) throw new Error("暂存内容在生成文案后发生变化；请重新运行 pc commit。");
    const result = await git(cwd, ["commit", "-F", "-"], `${message}\n`);
    console.log(result.trim());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    session.dispose();
    console.log(`Session ID: ${sessionId}`);
  }
}

async function main(args: string[]) {
  const [command, action, value, ...rest] = args;
  if (!command || command === "--help" || command === "-h") { console.log(help); return; }
  if (rest.length) throw new Error("参数过多。\n" + help);
  if (command === "login") { if (value) throw new Error("用法：pc login [provider]"); return login(process.cwd(), action); }
  if (command === "model") return modelCommand(process.cwd(), action ?? "", value);
  if (command === "commit" && !action) return runCommit(process.cwd());
  throw new Error(`未知命令。\n${help}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
