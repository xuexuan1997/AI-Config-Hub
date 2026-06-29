# AI Config Hub

语言：简体中文 | [English](./README.en.md)

AI Config Hub 是一个本地优先的 AI 编程工具配置中枢，用统一领域模型读取、解释、诊断和迁移 Claude Code、Cursor、Codex 与 OpenCode 的 Rules、Agents、Skills 和 MCP 配置。它通过可预览、可备份、可验证、可回滚的事务式部署流程，降低多工具配置共存和迁移时覆盖用户文件的风险。

### 项目背景

AI 编程工具正在快速分化：不同工具使用不同目录、文件格式、继承规则和 MCP 配置方式。同一团队或个人在 Claude Code、Cursor、Codex、OpenCode 之间切换时，常见问题包括配置分散、有效配置难以解释、跨工具迁移存在语义丢失、手工复制容易覆盖已有文件，以及缺少可审计的回滚记录。

AI Config Hub 的目标是在不接管工具原生文件、不执行第三方配置脚本、不依赖云端服务的前提下，为这些本地配置提供统一的扫描、诊断、转换、预览、部署和历史能力。

### 项目概述

当前仓库是一个 TypeScript 模块化 Monorepo，包含共享核心、适配器、扫描器、部署器、存储层、中央资产库、Git 历史与远程资产库能力，以及 CLI、Electron 桌面端和本地 Web UI 入口。

核心设计原则：

- 本地工具配置文件是事实来源，SQLite 只保存可重建的索引、规范化结果、诊断和操作记录。
- 扫描默认只读，不执行 Skill、Hook、MCP 命令或配置中引用的第三方脚本。
- 写入必须经过转换、差异预览、用户确认、漂移检查、备份、原子写入、重新扫描验证和失败回滚。
- 工具差异被限制在适配器内，CLI 和桌面端共享同一套核心用例和错误语义。
- Electron renderer 不直接访问文件系统、SQLite、Git 或 shell，只通过白名单 preload IPC 调用业务级 API。

### 功能

- 多工具配置扫描：发现 Claude Code、Cursor、Codex 与 OpenCode 的 Rules、Agents、Skills、MCP 配置资产。
- 统一资产模型：将工具专属文件解析为通用的 `rule`、`agent`、`skill`、`mcp` 资源。
- 生效配置解释：按用户级、项目级、目录级作用域解释继承、覆盖、忽略和贡献关系。
- 诊断与报告：定位解析、兼容、权限、冲突、漂移、部署和验证问题，并支持导出诊断。
- 转换与迁移预览：评估跨工具转换结果，区分完整支持、部分支持和不支持，并展示字段保留、丢弃和变换信息。
- 事务式部署：生成结构化操作和 diff，在确认后执行备份、原子写入、验证和可验证回滚。
- 中央资产库与 Preset：提供个人文件系统资产库、资产导入、Preset 定义、预览、应用、来源追踪和回滚记录。
- Git 资产库工作流：支持远程资产库 clone、pull、commit、push、tag、restore、history，以及冲突状态提示和恢复引导。
- 自定义工具声明式配置：支持安全的内部工具 ID 和声明式扫描规则，用于发现 Rules、Agents、Skills 或 MCP 配置。
- 本地历史与 Git 证据：记录部署、回滚和本地快照证据，为后续审计和恢复提供依据。
- 多入口体验：提供 `apps/cli` 命令行入口、`apps/desktop` Electron + React 桌面入口，以及通过 Local API 连接的 `apps/web` 本地 Web UI。

当前实现状态见 [docs/implementation/phase-status.md](./docs/implementation/phase-status.md)。诊断、转换、部署、中央资产库、Git 资产库基础工作流、本地 API、本地 Web UI 和三平台打包均已覆盖当前 tracked scope；团队身份、审批流、托管协作服务和在线分享市场仍在 MVP 边界外。

### 开发环境准备

本项目要求 Node.js `>=24 <25`，仓库声明的包管理器为 `pnpm@11.5.3`。建议使用 `fnm` 固定本地 Node 版本：

```bash
fnm install 24
fnm use 24
node --version
```

启用 Corepack 并安装依赖：

```bash
corepack enable
corepack prepare pnpm@11.5.3 --activate
pnpm install --frozen-lockfile
```

如果 Vitest、Vite、Rolldown 或其他工具提示缺少现代 `node:*` 导出，先确认当前 shell 已切换到 Node 24：

```bash
node --version
pnpm --version
```

### 常用开发命令

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

其他常用脚本：

```bash
pnpm dev
pnpm test:integration
pnpm test:e2e
pnpm package
pnpm package:macos:arm64
pnpm package:windows:x64
pnpm package:linux:x64
```

### 项目结构

- `packages/shared`：稳定 ID、路径、哈希和脱敏错误等跨层原语。
- `packages/core`：规范化资产、作用域、生效配置、诊断、转换、部署与任务契约。
- `packages/api`：版本化命令、IPC envelope、事件协议和浏览器安全客户端。
- `packages/adapters`：Claude Code、Cursor、Codex、OpenCode 的工具适配器。
- `packages/scanner`：安全读取、哈希、扫描编排和增量变化检测。
- `packages/deployer`：差异、漂移检查、备份、原子写入、验证和回滚。
- `packages/storage`：SQLite 仓储、迁移和事务边界。
- `packages/git`：本地 Git 快照、历史和恢复证据。
- `packages/asset-library`：个人中央资产库、Preset 和资产来源追踪。
- `packages/local-api`：本机 HTTP/SSE API、认证和来源限制。
- `apps/cli`：共享核心用例的 Node.js CLI。
- `apps/desktop`：Electron + React 桌面应用。
- `apps/web`：通过 Local API 连接核心能力的本地 Web UI。

### 相关文档

- [架构总览](./docs/architecture/overview.md)
- [领域模型](./docs/architecture/domain-model.md)
- [适配器系统](./docs/architecture/adapter-system.md)
- [API 与 IPC](./docs/architecture/api-and-ipc.md)
- [安全设计](./docs/architecture/security.md)
- [实现状态](./docs/implementation/phase-status.md)
