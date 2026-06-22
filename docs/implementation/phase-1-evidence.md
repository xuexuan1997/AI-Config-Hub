# 阶段一：基础设施与核心契约验收证据

## 验收范围

本阶段交付可复现的 pnpm/TypeScript 工作区、稳定共享原语与错误模型、规范化领域记录、能力受限端口、13 个版本化 API 命令、长任务事件协议、浏览器安全客户端及 CI 架构门禁。

验收分支为 `codex/implement-ai-config-hub`，功能基线提交为 `0d5e19a`；本文件、CI 和架构门禁与其共同组成阶段一验收提交，可用 `git show --format=%H` 获取最终提交 ID。

## 工具链

| 项目 | 已验证版本 |
| --- | --- |
| Node.js | 24.14.0 |
| pnpm | 11.5.3 |
| TypeScript | 6.0.3 |
| Vitest | 4.1.9 |

## 命令证据

2026-06-21 在隔离 worktree 中执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过；11 个工作区项目，锁文件无变更 |
| `pnpm typecheck` | 通过；根配置及 10 个可构建项目全部严格类型检查成功 |
| `pnpm lint` | 通过；ESLint、Prettier 和 dependency-cruiser 均成功 |
| `pnpm test` | 通过；17 个测试文件、68 个测试，语句覆盖率 89.73%，行覆盖率 91% |
| `pnpm build` | 通过；10 个项目按依赖拓扑构建成功 |
| `git diff --check` | 通过；无空白错误 |

依赖图检查覆盖 46 个模块和 73 条依赖，无违规。另将全部 `dist` 与 TypeScript 增量缓存移出工作区后重新执行构建，验证干净检出不依赖历史输出；同样在无 `dist` 状态下通过类型检查与全部测试。

## 安全与契约证据

- `packages/shared` 的错误 JSON 只允许稳定错误码、脱敏消息、建议动作及标量安全上下文，不序列化 cause、调用栈、SQL 或秘密正文。
- `packages/core` 为资产、生效配置、诊断、转换、部署计划/记录和任务状态提供运行时 schema；端口不暴露任意 `fs`、shell、Electron 或 renderer 能力。
- `packages/api` 精确暴露 13 个 MVP 业务命令。每个命令的请求与响应都有严格 Zod schema；列表上限为 200。
- renderer 的部署和回滚请求只包含持久实体 ID，不接受确认 grant、备份路径、目标路径或任意执行凭据。
- 事件游标拒绝错误任务、未知字段、重复推进、序列缺口、非法 phase 转换、phase 未激活的进度和终态后的事件；过期游标通过 `cursor.reset` 后的原子 snapshot 恢复。
- fixture 验证 renderer 可导入 `@ai-config-hub/api`，但导入 Node 文件系统、storage、deployer 或 Git 包会触发 `renderer-no-privileged-capabilities` 架构错误。

## 尚未声明完成的能力

本阶段不声称适配器、SQLite 存储、扫描器、生效解析、部署执行、Git 工作流、CLI、Electron UI 或发布包已经可用。这些能力依次在阶段二至八实现，并在阶段九按架构矩阵统一验收。
