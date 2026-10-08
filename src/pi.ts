import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, ModelRuntime, SessionManager, createAgentSession, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";

const configPath = join(homedir(), ".config", "pi-commit", "config.json");
const skillPath = fileURLToPath(new URL("../skills/git-commit/SKILL.md", import.meta.url));
const agyPath = fileURLToPath(import.meta.resolve("pi-agy"));

export type Config = { model?: string; fallback?: string };

export async function readConfig(): Promise<Config> {
  try { return JSON.parse(await readFile(configPath, "utf8")) as Config; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveConfig(config: Config) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export async function ask(question: string) {
  if (!process.stdin.isTTY) throw new Error(`需要终端输入：${question}`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await rl.question(question)).trim(); }
  finally { rl.close(); }
}

async function authPrompt(prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    console.error(prompt.message);
    prompt.options.forEach((option, index) => console.error(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`));
    const answer = await ask("请选择编号：");
    const selected = prompt.options[Number(answer) - 1];
    if (!selected) throw new Error("无效的选择。");
    return selected.id;
  }
  if (prompt.type === "secret") {
    if (!process.stdin.isTTY) throw new Error(`需要终端输入：${prompt.message}`);
    const noEcho = spawnSync("stty", ["-echo"], { stdio: "inherit" });
    if (noEcho.status !== 0) throw new Error("无法关闭密钥输入回显。");
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    try { return (await rl.question(`${prompt.message}: `)).trim(); }
    finally {
      rl.close();
      spawnSync("stty", ["echo"], { stdio: "inherit" });
      console.error();
    }
  }
  return ask(`${prompt.message}: `);
}

export async function piContext(cwd: string) {
  const runtime = await ModelRuntime.create();
  const loader = new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true,
    noContextFiles: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [agyPath], additionalSkillPaths: [skillPath],
    systemPrompt: "You write Conventional Commit messages. Follow the git-commit skill's message rules. Do not run Git, edit files, or suggest staging. Return only the finished commit message.",
  });
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error(`pi-agy 加载失败：${loader.getExtensions().errors[0]?.error}`);
  const skills = loader.getSkills().skills;
  if (skills.length !== 1 || skills[0]?.name !== "git-commit") throw new Error("git-commit skill 加载失败或出现额外 skill。");
  const { session } = await createAgentSession({ cwd, modelRuntime: runtime, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: [] });
  return { runtime, loader, session };
}

export async function login(cwd: string, providerId?: string) {
  const { runtime, session } = await piContext(cwd);
  try {
    const providers = runtime.getProviders();
    if (!providerId) {
      for (const provider of providers) {
        const methods = [provider.auth.apiKey?.login && "API Key", provider.auth.oauth && "OAuth"].filter(Boolean).join(" / ") || "环境凭证";
        const status = runtime.hasConfiguredAuth(provider.id) ? "已配置" : "未配置";
        console.log(`${provider.id}\t${methods}\t${status}`);
      }
      return;
    }
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) throw new Error(`未知 Provider：${providerId}。可用：${providers.map((item) => item.id).join(", ")}`);
    const choices = [provider.auth.apiKey?.login && "api_key", provider.auth.oauth && "oauth"].filter(Boolean) as Array<"api_key" | "oauth">;
    if (!choices.length) throw new Error(`${providerId} 只支持环境凭证，无交互登录流程。`);
    const type = choices.length === 1 ? choices[0]! : (await authPrompt({ type: "select", message: "选择登录方式", options: choices.map((id) => ({ id, label: id === "oauth" ? "OAuth" : "API Key" })) })) as "api_key" | "oauth";
    await runtime.login(providerId, type, {
      prompt: authPrompt,
      notify: (event) => {
        if (event.type === "auth_url") console.error(`请打开：${event.url}`);
        else if (event.type === "device_code") console.error(`请打开 ${event.verificationUri} 并输入 ${event.userCode}`);
        else console.error(event.message);
      },
    });
    console.log(`${providerId} 登录成功。`);
  } finally { session.dispose(); }
}

export async function modelCommand(cwd: string, action: string, value?: string) {
  const { runtime, session } = await piContext(cwd);
  try {
    const config = await readConfig();
    if (action === "list") {
      const available = await runtime.getAvailable();
      for (const model of available) {
        const id = `${model.provider}/${model.id}`;
        console.log(`${id}${id === config.model ? " [默认]" : ""}${id === config.fallback ? " [备用]" : ""}`);
      }
      return;
    }
    if ((action !== "set" && action !== "fallback") || !value || !value.includes("/")) throw new Error("用法：pc model set|fallback <provider/model> 或 pc model list");
    const [provider, ...parts] = value.split("/");
    const model = runtime.getModel(provider!, parts.join("/"));
    if (!model) throw new Error(`模型不存在：${value}`);
    if (!(await runtime.getAvailable()).some((item) => item.provider === model.provider && item.id === model.id)) throw new Error(`模型当前不可用，请先登录 ${provider}。`);
    config[action === "set" ? "model" : "fallback"] = value;
    await saveConfig(config);
    console.log(`${action === "set" ? "默认" : "备用"}模型：${value}`);
  } finally { session.dispose(); }
}

export async function agentForCommit(cwd: string, modelId: string) {
  const { runtime, loader, session: probe } = await piContext(cwd);
  probe.dispose();
  const [provider, ...parts] = modelId.split("/");
  const model = runtime.getModel(provider!, parts.join("/"));
  if (!model) throw new Error(`模型不存在：${modelId}`);
  if (!(await runtime.getAvailable()).some((item) => item.provider === model.provider && item.id === model.id)) throw new Error(`模型当前不可用：${modelId}`);
  const { session } = await createAgentSession({ cwd, modelRuntime: runtime, resourceLoader: loader, model, sessionManager: SessionManager.create(cwd), tools: [] });
  return { runtime, session };
}

export async function skillText() { return readFile(skillPath, "utf8"); }
