# TODO：按优先级排序的能力清单

本清单基于当前仓库代码与 PRD 阶段目标的静态检查整理，记录尚未实现、尚未接入真实入口，或仅有底层雏形但未形成可用产品能力的事项。

状态更新于 2026-06-29：P0、P1、P2 已完成并保留在本节作为验收索引；P3 及之后仍按优先级排序。仍保留 `[ ]` 的条目可能已有底层实现或部分接线，但尚未满足该条目的完整产品验收面。

优先级口径：

- P0：影响真实配置安全读写、诊断可信度或桌面主流程闭环的阻塞项。
- P1：影响 MVP 可用性、用户判断和恢复操作的核心体验项。
- P2：影响持续使用时的变更响应、证据留存和阶段验收。
- P3：扩展到资产库、团队同步、Preset 和自定义工具的产品能力。
- P4：扩展入口与生态集成能力。

## P0：安全写入、诊断与主流程闭环

- [x] 支持默认家目录配置发现与扫描。
  - 扫描入口必须默认覆盖当前用户家目录下四个内置工具的标准配置位置，不能只依赖手工添加的项目目录或显式根目录。
  - 至少覆盖 Claude Code、Cursor、Codex、OpenCode 的用户级 Rules、Agents、Skills 和 MCP 配置目录/文件。
  - CLI 与桌面首次扫描应展示这些用户级配置资产、来源层级和缺失/不可读原因。
  - 覆盖证据：`apps/cli/src/app-services.test.ts`、`apps/desktop/src/main/composition.test.ts`。
- [x] 补齐适配器级部署规划。
  - 基类 `planDeployment()` 生成真实目标路径、冲突前置 hash、diff、`generated_file` 元数据和验证策略；四个内置工具通过转换输出声明各自标准配置目标。
  - `DeploymentPreviewService` 现在接受 adapter 规划的 `generated_file`、`copy` 与 `symlink`，并校验 source/target roots。
  - 覆盖证据：`packages/adapters/src/verification.test.ts`、`packages/deployer/src/preview-service.test.ts`。
- [x] 补齐适配器级写后验证。
  - 基类 `verify()` 已实现目标读取、存在性检查、hash 校验，并对 `generated_file` 按目标工具格式重新解析和验证资源类型。
  - 覆盖证据：`packages/adapters/src/verification.test.ts`、`packages/deployer/src/execution-service.test.ts`。
- [x] 明确并实现 PRD 中的部署操作类型。
  - Copy。
  - Symlink。
  - Generated File。
  - `DeploymentOperation` 支持三种部署类型；`DeploymentFilePort`、`NodeDeploymentFilePort`、preview 和 execution 已接入 copy/symlink/generated file。
  - 覆盖证据：`packages/core/src/domain/deployment.test.ts`、`packages/deployer/src/file-port.test.ts`、`packages/deployer/src/execution-service.test.ts`、`tests/integration/deployment-lifecycle.test.ts`。
- [x] 将适配器 `diagnose()` 从空实现升级为四工具、四资源的实际诊断。
- [x] 实现完整诊断能力。
  - 文件格式诊断。
  - 目录诊断。
  - 层级诊断。
  - 引用诊断。
  - MCP 安全诊断。
  - 内容漂移诊断。
  - 覆盖内容：parse 失败形成文件格式诊断；配置根外资产形成目录诊断；重复 locator、空白内容、层级忽略、skill 引用缺失、MCP 非可部署 secret 与明文 secret 风险均由 adapter 诊断输出；部署前后 source/target hash drift 由 preview/execution 阶段阻断。
  - 覆盖证据：`packages/adapters/src/verification.test.ts`、`packages/scanner/src/scan-service.test.ts`、`packages/deployer/src/execution-service.test.ts`。
- [x] 打通桌面端真实任务状态与事件流。
  - 扫描、部署和回滚均记录 accepted、phase/progress、completed；部署/回滚失败记录 item.failed、taskId 和 systemRecoveryLock；scan cancel 记录 cancel.requested。
  - 迁移预览保持同步命令语义，错误直接通过 API 返回，不作为长任务进入事件流。
  - 覆盖证据：`apps/desktop/src/main/composition.test.ts`、`apps/desktop/src/renderer/model.test.ts`。
- [x] 将桌面主进程接入真实核心服务。
  - `apps/desktop/src/main/composition.ts` 已接入真实 `scanner`、`storage`、`deployer`、本地 Git history/snapshot 与 API handler，不再返回固定 demo asset、preview、deployment 和 history。
  - 覆盖证据：`apps/desktop/src/main/composition.test.ts`、`tests/e2e/desktop.spec.ts`。

## P1：MVP 用户可用性与恢复体验

- [x] 在 UI/CLI 中展示兼容等级、字段损失、diff、required confirmations、plan freshness 和 hash drift。
  - 桌面迁移预览展示 compatibility、required confirmations、expiresAt、hash snapshot、source drift、structured field losses 和 diff；CLI JSON 暴露相同 preview 数据，并提供 migration preview 人读摘要。
  - 覆盖证据：`packages/api/src/commands.test.ts`、`apps/cli/src/cli.test.ts`、`apps/cli/src/app-services.test.ts`、`apps/desktop/src/renderer/model.test.ts`。
- [x] 完善桌面 UI。
  - 已部分完成：已有真实资产详情、诊断列表、迁移预览源资产筛选、部署确认、历史列表。
  - 已补齐：生效配置解释视图、诊断定位、恢复锁处理、历史详情与 diff 查看。
  - 覆盖证据：`packages/api/src/commands.test.ts`、`apps/desktop/src/renderer/model.test.ts`、`apps/cli/src/app-services.test.ts`、`apps/desktop/src/main/composition.test.ts`。
- [x] 实现诊断报告导出。
  - `diagnostics.export` 支持 JSON/Markdown 导出，CLI 提供 `diagnose export` 人读输出。
  - 导出内容已覆盖敏感值脱敏、home/project/app-data/backup/external 路径缩略，以及无资产 parse/read 诊断的工具/项目过滤。
  - 支持按任务、项目、工具、严重级别或时间窗导出；诊断列表入口同步补齐工具与 code 过滤。
  - 覆盖证据：`packages/api/src/diagnostic-report.test.ts`、`packages/api/src/commands.test.ts`、`packages/scanner/src/scan-service.test.ts`、`apps/cli/src/cli.test.ts`、`apps/cli/src/app-services.test.ts`、`apps/desktop/src/main/composition.test.ts`。
- [x] 实现外部编辑器集成。
  - 从资产详情打开源文件。
  - 编辑器保存后触发重扫、更新状态并重新计算冲突。
  - 桌面资产详情提供 Open source 与 Rescan after edit；打开源文件通过 `assets.openSource` 的 assetId-only API 在主进程解析真实路径并调用外部编辑器。
  - 保存后可从资产详情触发重扫，完成后刷新任务状态、资产、当前资产详情、诊断与历史；若原迁移预览仍可用则重新生成 preview 以更新冲突与 hash 状态。
  - 覆盖证据：`packages/api/src/commands.test.ts`、`packages/core/src/use-cases/application-services.test.ts`、`packages/core/src/ports/contracts.test.ts`、`apps/desktop/src/main/composition.test.ts`、`apps/desktop/src/main/ipc.test.ts`、`apps/desktop/src/renderer/model.test.ts`、`apps/cli/src/cli.test.ts`。

## P2：持续使用、变更响应与验收证据

- [x] 实现跨平台文件监听。
  - `WatchService` 对编辑器临时文件事件去抖、过滤与合并，`NodeFileWatcher` 以 Node `fs.watch` 接入平台文件事件。
  - 桌面端在扫描后按 `fileWatching` 设置启动监听；监听变更触发增量扫描，不稳定 watcher 信号触发完整刷新。
  - 部署与回滚写入目标路径在执行期间进入 watcher suppression，避免写入事件造成循环扫描。
  - 覆盖证据：`packages/scanner/src/watch-service.test.ts`、`apps/desktop/src/main/composition.test.ts`。
- [x] 完整接入增量扫描。
  - CLI 和桌面端均将 `changedPaths` 规范化为扫描器使用的 canonical path 后传入 `ScanService`。
  - 扫描器从 changed paths 推导受影响候选文件并重新解析、重新生成对应生效配置和诊断。
  - SQLite 索引使用 `mergeIncrementalIndex` 合并 changed paths，删除或替换变更路径资产，同时保留未受影响资产。
  - 覆盖证据：`packages/scanner/src/scan-service.test.ts`、`packages/storage/src/repositories.test.ts`、`apps/cli/src/app-services.test.ts`、`apps/desktop/src/main/composition.test.ts`。
- [x] 为 Phase 3 及之后阶段补充 implementation evidence。
  - 已补充 Phase 3、Phase 4、Phase 5、Phase 6 evidence 文档；Phase 5 和 Phase 6 明确标记为部分实现，不声明 P3/P4 剩余能力完成。
  - 覆盖证据：`docs/implementation/phase-3-evidence.md`、`docs/implementation/phase-4-evidence.md`、`docs/implementation/phase-5-evidence.md`、`docs/implementation/phase-6-evidence.md`。
- [x] 将 PRD 第三至第六阶段的完成状态与测试证据保持同步。
  - `docs/implementation/phase-status.md` 汇总 PRD 第三至第六阶段状态、证据文档、已完成范围和剩余 TODO bucket。
  - `docs/PRD.md` 第 24 节链接实现状态索引；`docs/README.md` 文档地图列出阶段证据文档。
  - 覆盖证据：`docs/implementation/phase-status.md`、`docs/PRD.md`、`docs/README.md`。

## P3：中央资产、Git 与 Preset

- [x] 实现个人中央资产库。
  - `@ai-config-hub/asset-library` 提供文件系统个人中央库，初始化 `manifest.json`、`rules/`、`agents/`、`skills/`、`mcp/`、`presets/`、`schemas/` 推荐结构。
  - 支持从规范化资产导入中央资产、确定性文件路径、来源资产/工具/路径追踪、内容 hash、列表与详情读取。
  - 覆盖证据：`packages/asset-library/src/asset-library.test.ts`。
- [x] 扩展当前 Git port。
  - 当前只包含 `initialize`、`snapshot`、`diff`、`history`。
  - 已保留 `LocalGitPort` 的本地快照安全边界，并新增独立的 `AssetRepositoryGitPort` 承载远端资产库操作。
  - 远端 Git 实现使用 `execFile`、禁用 hook、禁用交互式凭据提示、限制 clone URL 协议、校验 clone 目标根、限制相对路径、拒绝 `.git`/路径穿越/符号链接逃逸。
  - 覆盖证据：`packages/core/src/ports/contracts.test.ts`、`packages/git/src/asset-repository-git.test.ts`、`packages/git/src/local-git.test.ts`。
- [x] 实现 Git 资产库工作流。
  - Clone。
  - Pull。
  - Commit。
  - Push。
  - Git 冲突提示与恢复引导。
  - `SystemAssetRepositoryGitPort` 覆盖 clone、pull、status、diff、commit、push、tag、restore 和 history；status 输出 clean/dirty/ahead/behind/diverged/conflicted 分类和冲突恢复引导。
  - 覆盖证据：`packages/git/src/asset-repository-git.test.ts`。
- [x] 实现 Preset 基础能力。
  - Preset 定义、预览、应用、来源追踪和回滚记录。
  - `@ai-config-hub/asset-library` 支持 Preset 定义创建/更新、预览 create/update/delete/unchanged/incompatible、应用记录、来源 hash、目标回滚 hash 与部署记录关联。
  - 覆盖证据：`packages/asset-library/src/asset-library.test.ts`。
- [x] 实现自定义工具声明式配置。
  - 支持用户添加内部工具并扫描其 Rules、Agents、Skills 或 MCP 配置。
  - `ToolIdSchema` 支持内置工具和安全的小写 kebab 自定义工具 ID；SQLite 迁移放宽 `tools.tool_key` 约束。
  - `createDeclarativeToolRegistration()` 支持声明式 detect/path/resource 配置，发现并解析 Rules、Agents、Skills、MCP 文件，不执行脚本或远程内容；默认 registry 可接入自定义工具定义。
  - 覆盖证据：`packages/shared/src/primitives.test.ts`、`packages/storage/src/database.test.ts`、`packages/adapters/src/declarative-tool.test.ts`。

## P4：扩展入口

- [x] 实现本地 Local API。
  - 仅监听本机地址。
  - 需要明确认证、来源限制和关闭策略。
  - `@ai-config-hub/local-api` 通过现有 `CommandServiceMap` 和 `createCommandHandlers()` 暴露本地 HTTP API，默认仅允许 `127.0.0.1`、`::1`、`localhost`，需要 Bearer token，校验浏览器 Origin，API 响应设置 no-store，并在 shutdown 时关闭 SSE 订阅。
  - 覆盖证据：`packages/local-api/src/server.test.ts`。
- [x] 实现本地 Web UI。
  - 与桌面端共享同一业务 API 和核心用例，不复制业务逻辑。
  - `@ai-config-hub/web` 提供 Vite/React 本地 Web UI，通过 browser-safe `@ai-config-hub/api/browser` 客户端、fetch 和 SSE 调用 Local API，不导入 filesystem/storage/git/core 等特权实现包。
  - 覆盖证据：`apps/web/src/local-transport.test.ts`、`apps/web/src/import-boundary.test.ts`、`packages/api/src/browser.ts`、`dependency-cruiser.mjs`。

## 已完成归档

- [x] 实现 `apps/cli` 真实命令入口。
  - `apps/cli/src/index.ts` 已创建真实进程入口并组合 CLI command services。
  - `apps/cli/src/cli.ts` 已覆盖 `scan`、`assets`、`effective`、`diagnose`、`migrate --dry-run`、`deploy`、`rollback`、`history` 等 CLI 映射。
  - 覆盖证据：`apps/cli/src/cli.test.ts`、`apps/cli/src/app-services.test.ts`、`tests/e2e/cli.spec.ts`。
- [x] 将底层 `deployer` 预览、执行、回滚服务接入 API 与桌面/CLI 入口。
  - `migration.preview`、`deployment.execute`、`deployment.rollback` 已由 CLI 与桌面 command services 调用真实 deployer 服务。
  - 覆盖证据：`apps/cli/src/app-services.ts`、`apps/desktop/src/main/composition.ts`、`tests/e2e/cli.spec.ts`、`tests/e2e/desktop.spec.ts`。
- [x] 补齐 Windows 安装包。
  - 已配置 Windows x64 NSIS 目标、根 package script、CI packaging matrix 与 release artifact 发布。
  - 覆盖证据：`apps/desktop/electron-builder.yml`、`package.json`、`apps/desktop/package.json`、`.github/workflows/linux-package.yml`、`.github/workflows/release.yml`、`tests/packaging/config.test.mjs`、`tests/packaging/release-evidence.test.mjs`。
- [x] 补齐 macOS 安装包。
  - 已配置 macOS x64/arm64 DMG 目标、根 package script、CI packaging matrix 与 release artifact 发布。
  - 覆盖证据：`apps/desktop/electron-builder.yml`、`package.json`、`apps/desktop/package.json`、`.github/workflows/linux-package.yml`、`.github/workflows/release.yml`、`tests/packaging/config.test.mjs`、`tests/packaging/release-evidence.test.mjs`。
- [x] 保持并扩展 Linux AppImage 发布验证。
  - Linux x64 AppImage 仍在 Rocky Linux 8.10/glibc 2.28 基线容器中构建。
  - 已保留 ELF audit、AppImage smoke、SBOM、checksum、version manifest，并纳入三平台发布矩阵。
  - 覆盖证据：`.github/workflows/linux-package.yml`、`scripts/release/audit-linux-elf.sh`、`scripts/release/smoke-appimage.sh`、`scripts/release/generate-manifest.mjs`、`scripts/release/verify-artifacts.mjs`、`tests/packaging/release-evidence.test.mjs`。
- [x] 为真实入口接线后补充端到端测试。
  - 已有 CLI 与桌面端 E2E 覆盖扫描、迁移预览、部署、历史和回滚。
  - 覆盖证据：`tests/e2e/cli.spec.ts`、`tests/e2e/desktop.spec.ts`。
  - 后续若扩展真实入口能力，仍需随新增命令继续补充 E2E。
