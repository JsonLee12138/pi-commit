# pi-commit 产品需求文档

> 状态：评审稿 · 2026-09-30  
> 项目名：`pi-commit` · npm 包：`@jsonlee_12138/pi-commit` · 命令：`pi-commit`、`pc`

本稿采用三个工作假设：默认只处理已暂存改动；每次进入模型生成阶段就保存一个可恢复的 Pi session；`git-commit` skill 负责文案规则，实际 Git 提交由 CLI 控制。这些行为已写入下方验收标准，评审时可直接修改。

## 1. 目标

开发一个可开源的命令行工具，在用户当前工作目录的 Git 仓库中，使用 Pi 和唯一允许的 `git-commit` skill 生成 Conventional Commit 文案，并完成提交。用户直接运行本工具完成模型登录、模型配置和提交，不需要进入 Pi 的交互界面，也不需要另找 agent 创建会话。

成功体验：用户安装工具后运行 `pc login` 查看 Provider，运行 `pc login <provider>` 完成登录，配置默认模型和备用模型，在已暂存修改的仓库运行 `pc commit`，检查生成的文案并确认提交，最后看到提交结果和本次 Pi session ID。完整命令名 `pi-commit` 与简称 `pc` 行为相同。

## 2. 已确认的产品边界

| 项目 | 要求 |
| --- | --- |
| 运行目录 | 所有 Git 操作以调用命令时的 `cwd` 为准；不切换到 CLI 安装目录。 |
| 技术栈 | TypeScript 源码直接由 Bun 运行，不使用 `tsdown` 或 Vite 打包。Pi SDK 作为固定版本依赖随 npm 包安装；Bun 是唯一要求的运行时。 |
| 模型 | 配置默认模型和一个 fallback 模型；默认模型因可恢复的服务故障无法完成生成时，尝试 fallback。 |
| 登录 | `pc login` 只列出当前支持的 Provider；`pc login <provider>` 才执行登录，在本 CLI 内复用 Pi 的认证实现和凭证存储；不启动 Pi TUI。 |
| Skill | 提交任务只加载固定版本的 GitHub Awesome Copilot `git-commit` skill；不加载用户或项目的其他 skill。 |
| pi-agy | 内置固定版本 `pi-agy` Provider 扩展，让 Antigravity 模型出现在登录和模型选择中。 |
| MCP | 可调用 Pi 配置的 MCP 服务器中明确允许的工具。 |
| 修改范围 | 模型不能任意编辑业务代码或逻辑代码。仓库写入仅发生在明确的 Git 提交步骤，以及提交受 lint 限制时项目已有 lint 修复命令产生、经用户检查的修改。不得自动执行 `git stash`。 |
| 终端界面 | `commit` 使用普通终端输出与确认提示，不新增全屏 TUI；模型在执行中需要用户决定时，可在终端给出选项或要求输入文本。 |

## 3. 用户命令

下表使用简称 `pc`；所有命令同时支持 `pi-commit` 前缀。

| 命令 | 行为 |
| --- | --- |
| `pc login` | 只列出 Pi 当前支持的 Provider、认证方式和登录状态；不启动任何登录流程。 |
| `pc login <provider>` | 调用所选 Provider 的登录流程。支持其定义的 API Key、OAuth 浏览器或设备码等方式；结果写入 Pi 标准凭证存储。未知 Provider 返回错误及可用列表。 |
| `pc model set <provider/model>` | 设置默认模型；拒绝不存在或当前不可用的模型，并给出原因。 |
| `pc model fallback <provider/model>` | 设置 fallback 模型；允许与默认模型属于不同 Provider。 |
| `pc model list` | 显示当前可用模型，以及默认与 fallback 标记。 |
| `pc commit` | 读取当前仓库已暂存改动，生成文案、展示文案并请求确认，确认后执行 Git 提交。提交受到 lint 限制时，AI 检查并调用仓库现有 lint 命令，再重新检查改动与正常运行 hook。 |
| `pc --help` | 展示命令、参数和退出状态。 |

`pc login` 只负责模型 Provider。MCP 服务器及其 OAuth 登录沿用 Pi 的 MCP 配置和凭证；第一版无需复制一套 MCP 管理命令。

## 4. Commit 流程

1. 验证 `cwd` 位于 Git 仓库，读取工作区状态和已暂存 diff。没有已暂存改动时直接提示用户先暂存，不创建 Pi session，也不自动执行 `git add`。
2. 对将要发送给模型的内容做基础敏感信息检查；发现疑似私钥、令牌或常见凭证文件时停止并指出文件，不把对应 diff 发送给模型。
3. 创建并保存一个本次 commit 专用的 Pi session；只提供 `git-commit` skill、必要的 Git 上下文和明确允许的 MCP 工具。模型负责分析改动并生成 Conventional Commit 文案；Git 命令由 CLI 自己执行。
4. 校验文案至少包含非空的 `type: description` 或 `type(scope): description` 标题；展示完整文案。用户可确认或取消。取消时不执行提交。
5. 确认后，再检查暂存内容与生成时一致，然后使用文案执行 `git commit`。保留项目现有 Git hooks；如果 hook 因 lint 失败，AI 可以检查项目中的 lint 配置并提出已有的修复命令。用户选择执行后展示新 diff，重新确认暂存内容，再正常重试提交。不得跳过 hook、自动改写业务逻辑、擅自 amend 或执行 `git stash`。
6. 如果本次已创建 Pi session，无论生成、确认或提交结果如何，都在正常结束输出的最后一行显示 `Session ID: <id>`；该 ID 可用于在 Pi 中找到本次记录。没有创建 session 时不显示这一行。

默认只提交调用命令前已暂存的内容。未暂存文件不会由工具自动加入本次提交。

### 执行中向用户提问

Pi SDK 支持为模型注册自定义工具，因此提供一个只负责终端问答的工具：模型确实缺少提交范围、描述或其他必要信息时，可在运行中展示候选项或请求用户输入文本，再将答案交回本次 Pi session。问答使用普通终端提示，不打开全屏 TUI。用户取消则停止本次生成；标准输入不可交互时返回清晰错误，不替用户猜测答案。

### 模型 fallback

- 仅在默认模型发生超时、网络错误、限流或服务端不可用等可恢复故障，且尚未执行 `git commit` 时尝试一次 fallback。
- 未配置凭证、模型不存在、Git 状态错误、用户取消、文案校验失败或 Git hook 失败时，不切换模型。
- fallback 使用同一次提交任务的上下文；最终输出标明实际使用的模型。

### 提交时的 lint 处理

提交提示词明确要求：只有发现项目对本次提交有 lint 限制，或 Git hook 因 lint 失败时，AI 才检查项目现有脚本、工具配置、文档和 hook，选择已有的 lint 检查或修复命令；不得安装新工具、执行 `git stash`、跳过 hook、修改业务逻辑或运行无关命令。用户不需要配置或输入 lint 命令，也不提供独立的 lint 子命令。执行有写入效果的修复前，终端展示确切命令并让用户选择；执行后展示相对于执行前的新变更，不自动暂存或提交。

项目 lint 命令可能修改源码，提示词也不能强制保证修改不影响业务语义。因此修复后的差异必须交给用户检查；用户确认新暂存内容后才能继续，且必须重新运行原 Git hook。若项目找不到可确认的 lint 命令，说明原因并停止修复，不猜测命令。

## 5. 登录与 Provider

- Provider 列表、支持的认证方式、认证状态和模型列表来自 Pi 的运行时，不在本项目维护第二份硬编码列表。
- `pc login` 只显示 Provider 列表和状态，不进行登录或选择；`pc login <provider>` 才使用本 CLI 的普通终端选择和输入提示承接该 Provider 的认证回调。API Key 输入不得回显。凭证存储和刷新由 Pi 管理，本工具不另存一份。
- 内置 `pi-agy` 扩展，注册其 `antigravity` Provider。该 Provider 的 Google OAuth、多账号和额度切换能力由扩展负责；本 CLI 只承接其需要的终端交互。若扩展或帐号不可用，其他 Provider 仍可使用。
- 用户在设置模型时使用完整的 `provider/model` 标识，避免同名模型指向不同 Provider。

## 6. MCP 与执行权限

- 读取 Pi 标准 MCP 配置；以 `cwd` 作为项目配置解析位置。
- 默认不向本次提交任务暴露 MCP 工具。用户在本 CLI 配置中按完整工具名明确允许后，才可调用；仅允许已审核为读取用途的工具。MCP 的 `readOnlyHint` 只能作为提示，不能单独视为安全保证。
- 不向模型提供通用 `bash`、`edit`、`write` 或可修改仓库的 MCP 工具。Git 状态读取和提交由本 CLI 调用 Git 完成；提交受 lint 限制时，AI 可通过受限命令工具提出项目已有的 lint 命令，CLI 展示命令并要求用户确认后才执行。提示词规定何时检查 lint，终端问答工具负责取得用户的选择；实际命令及产生的 diff 必须对用户可见。
- 只过滤 skill 不足以满足权限限制；扩展和 MCP 工具也必须经过上述限制。

## 7. 配置、安装和开源交付

- 配置项仅包含默认模型、fallback 模型和允许的 MCP 工具名；配置为用户级，凭证继续由 Pi 管理。配置文件使用项目名 `pi-commit`，不保存 lint 命令。
- 发布公开 npm 包 `@jsonlee_12138/pi-commit`。入口文件为带 `#!/usr/bin/env bun` shebang 的 TypeScript 源码；用户需先安装 Bun，然后可用 `npx @jsonlee_12138/pi-commit commit` 一次性运行，或 `npm install -g @jsonlee_12138/pi-commit` 后运行 `pc commit`。两个命令入口指向同一实现。
- npm 安装本工具时自动获取固定版本的 Pi SDK 和 `pi-agy`；用户无需另行安装 Pi 内核。不进行额外打包，也不承诺 Node.js 直接运行 TypeScript 入口。
- 随包提供固定上游版本的 `git-commit` skill，并保留来源和许可证说明。升级 Pi、`pi-agy` 或 skill 版本需显式发布新版本，避免用户运行时行为漂移。
- npm 包提供 `pi-commit` 和 `pc` 两个等价可执行命令。README 提供 Bun 前置条件、npx 与全局安装、首次登录、配置模型、暂存文件、提交时的 lint 处理、MCP 工具允许配置和凭证存储说明。首次公开发布需确认 npm scope 的发布权限，并以公开权限发布。

## 8. 异常与输出

| 场景 | 预期结果 |
| --- | --- |
| 不在 Git 仓库 | 非零退出；指出当前目录。 |
| 没有已暂存改动 | 非零退出；提示先暂存；不创建 session。 |
| 默认模型故障且 fallback 成功 | 使用 fallback 文案继续，显示实际模型。 |
| 两个模型均失败 | 非零退出；保留仓库原状，给出两个失败原因。 |
| 用户取消 | 不执行提交；若已创建 session，末行显示 ID。 |
| Git hook 或 `git commit` 失败 | 非零退出；保留 Git 原错误和已暂存状态；若已创建 session，末行显示 ID。 |
| 可疑敏感内容 | 在发送模型前停止，指出需检查的文件；不创建 session。 |
| 执行中需要用户输入但当前终端不可交互 | 停止生成并提示所需输入；若已创建 session，末行显示 ID。 |
| 提交受 lint 限制，但项目没有可确认的 lint 命令 | 不执行猜测的命令或安装工具；给出已检查的位置和失败原因。 |
| lint 修复需要确认但终端不可交互 | 不执行修复；非零退出并指出待确认命令。 |

## 9. 验收标准

1. 在任意 Git 仓库子目录执行 `pc commit`，Git 操作始终针对该仓库，且仅提交已暂存内容。
2. `pc login` 仅列出 Pi Provider 且不产生登录副作用；`pc login <provider>` 能完成至少一种 API Key 登录和一种 OAuth 登录；`antigravity` 出现在列表中且能走 `pi-agy` 的登录流程。
3. 配置默认及 fallback 模型后，可恢复的默认模型故障会触发一次 fallback；Git、认证和用户取消错误不会触发。
4. 提交任务只加载 `git-commit` skill。即使目标仓库和用户目录存在其他 skill，它们也不会进入该任务的可用 skill 列表。
5. 模型不能通过本工具修改业务文件；未明确允许的 MCP 工具不可调用。
6. `commit` 无全屏界面；成功、失败或取消后，只要创建了持久化 Pi session，最后一行均为 `Session ID: <id>`，且该 ID 能定位到对应记录。
7. Git hook 正常运行；lint 修复后再次正常运行 hook，工具不会跳过或 amend。
8. 安装 Bun 后，可通过 `npx @jsonlee_12138/pi-commit commit` 和全局安装后的 `pc commit` 运行；无需用户手动安装 Pi SDK 或 `pi-agy`。
9. `pc commit` 和模型工具都不会自动执行 `git stash`；未暂存改动保持在原位置。
10. 模型运行中可以通过普通终端提示让用户选择选项或输入文本，并在得到答案后继续同一个 session；不可交互时清楚失败。
11. 仅在提交受到 lint 限制时，AI 才按提示词检查项目现有配置并运行 lint 命令；修复前显示命令并等待用户选择，修复后展示新变更，不自动暂存或绕过 hook。CLI 不提供 `lint` 子命令。

## 10. 开发与验证约定

首版保持单包：`src/` 放命令和 Pi 集成代码，`skills/git-commit/` 放锁定的上游 skill，`tests/` 放少量行为检查，`README.md` 放安装与用法。`package.json` 的两个 `bin` 指向同一个带 Bun shebang 的 TypeScript 入口。命令处理函数采用明确的输入和返回值，不在模块加载时执行 Git 或网络操作。例如 `await runCommit({ cwd: process.cwd(), model, fallbackModel })`；输出由命令入口统一处理。

开发命令为 `bun run src/cli.ts`，类型与格式检查为 `bun run check`，验证命令为 `bun test`，发布内容检查为 `npm pack --dry-run`。最小验证覆盖 Git 暂存范围、模型 fallback 条件、唯一 skill 加载、MCP 工具限制、登录凭证复用、终端问答、禁止自动 stash、提交受 lint 限制时的提示词与处理流程，以及 session ID 的末行输出。真实 Provider 登录、`npx` 入口和提交需在隔离的临时仓库做人工验收；不得使用用户正在开发的仓库作为测试目标。

开发边界：始终保留 Git hooks 并检查待提交内容；新增依赖、修改认证存储位置或扩大可写工具范围时先更新本 PRD；不得提交密钥、由模型修改业务逻辑文件、跳过 hook、自动 stash 或静默运行 lint 修复。

## 11. 暂不纳入第一版

- 自动暂存、自动拆分多个 commit、自动 push。
- 通用代码修复或由模型编辑业务逻辑。
- 独立的 `lint` 子命令和用户自定义 lint 命令配置。
- 自建模型 Provider 认证协议、MCP 服务器管理界面。
- 全屏 TUI、后台常驻进程、独立的 agent 派发系统。

## 12. 待定项

1. 发布前确认当前 npm 账号拥有 `@jsonlee_12138` scope 的发布权限。

## 参考

- [Pi SDK：认证、session、skill 与工具配置](https://pi.dev/docs/latest/sdk)
- [Pi MCP 文档](https://pi.dev/docs/latest/mcp)
- [GitHub Awesome Copilot git-commit skill](https://github.com/github/awesome-copilot/blob/main/skills/git-commit/SKILL.md)
- [pi-agy 包说明](https://pi.dev/packages/pi-agy)
- [Bun 直接运行 TypeScript](https://bun.sh/docs/runtime)
- [npm exec 对 scoped 包双入口的选择规则](https://docs.npmjs.com/cli/v11/commands/npm-exec/)
