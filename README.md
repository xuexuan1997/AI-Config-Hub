# AI Config Hub

AI Config Hub 是一个本地优先的 AI 编程工具配置中枢。它以统一领域模型读取、解释、诊断和迁移 Claude Code、Cursor、Codex 与 OpenCode 的 Rules、Agents、Skills 和 MCP 配置，并通过可预览、可备份、可验证、可回滚的事务式部署保护用户文件。

当前仓库按严格 TypeScript 模块化单体组织：

- `packages/shared`：稳定 ID、路径、哈希和脱敏错误等跨层原语。
- `packages/core`：规范化资产、作用域、生效配置、诊断、转换、部署与任务契约。
- `packages/api`：版本化命令、IPC envelope、事件协议和浏览器安全客户端。
- `packages/adapters`、`scanner`、`storage`、`deployer`、`git`：受能力端口约束的基础设施模块。
- `apps/cli` 与 `apps/desktop`：共享同一核心用例的两个入口。

## 开发

需要 Node.js 24.14.0 与 pnpm 11.5.3：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

架构与产品基线位于 [`docs/architecture`](./docs/architecture)，实现按阶段记录在 [`docs/implementation`](./docs/implementation)。
