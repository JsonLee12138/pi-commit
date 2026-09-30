# pi-commit

用 Pi 为已暂存的改动生成 Conventional Commit 文案，确认后由 CLI 执行 `git commit`。需要 Bun 1.3+。

```sh
npx @jsonlee_12138/pi-commit login
npx @jsonlee_12138/pi-commit login openai-codex
npx @jsonlee_12138/pi-commit model set openai-codex/gpt-6-luna
git add <files>
npx @jsonlee_12138/pi-commit commit
```

也可全局安装：`npm install -g @jsonlee_12138/pi-commit`，然后运行 `pc` 或 `pi-commit`。开发时运行 `bun run src/cli.ts --help`、`bun run check`、`bun test`。

`bun run test:e2e` 运行隔离的端到端测试，需要 Python 3 提供伪终端。测试启动真实 CLI、Pi SDK、Git 和本地模拟模型服务；不会调用真实模型或使用用户凭证。

`pc model fallback <provider/model>` 设置备用模型；仅网络、超时、限流和服务不可用等可恢复错误会触发备用模型。`pc model list` 显示当前可用模型。配置写入 `~/.config/pi-commit/config.json`，登录凭证由 Pi 保存在自己的标准位置。本工具不复制凭证。

`commit` 只读取当前目录所属 Git 仓库的已暂存改动，不自动暂存或 stash。生成前会拦截常见凭证文件和明显的密钥内容。模型只收到暂存 diff 与锁定的 `git-commit` skill，不获得写文件、执行命令或 MCP 工具。确认前会再次检查暂存内容。项目 Git hook 正常运行；hook 失败时保留 Git 错误，不自动绕过。

首个开发版本尚未实现 MCP 工具白名单、运行中问答和用户确认后的 lint 修复引导。真实 OAuth 登录需使用目标 Provider 帐号单独验收。

## 上游 skill

`skills/git-commit/SKILL.md` 来自 [GitHub Awesome Copilot](https://github.com/github/awesome-copilot/blob/e62be9667aff87958ed94bee2b396433897d1529/skills/git-commit/SKILL.md)，固定于提交 `e62be9667aff87958ed94bee2b396433897d1529`，SHA-256 为 `554d1a3c6d95f15bc1170160659ecdc9a9958b64f377f3988941b672c249b13f`。其 MIT 许可证见 `skills/git-commit/LICENSE`。
