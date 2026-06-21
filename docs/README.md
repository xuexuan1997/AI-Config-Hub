# AI Config Hub 技术文档

## 阅读指南

本目录描述 AI Config Hub MVP 的技术基线，面向应用工程师、工具适配器作者、测试工程师、发布工程师和安全评审人员。

首次阅读建议按以下顺序进行：

1. 阅读[系统架构](architecture/overview.md)，理解运行时边界和模块关系。
2. 阅读[领域模型](architecture/domain-model.md)，统一核心术语和状态语义。
3. 按工作内容进入适配器、数据、接口、安全、开发或运维文档。
4. 通过 ADR 了解关键决策的背景、取舍和复审条件。

可访问的技术需求基线由[完整技术方案设计](superpowers/specs/2026-06-21-technical-solution-design.md)汇总。项目维护者提供原始产品需求材料时，其工作区位置为 `docs/PRD.md`；专题文档不得依赖未纳入版本控制的材料才能被理解。发生冲突时，先确认需求是否变化，再更新设计、ADR 和受影响的专题文档，不在单个实现文档中静默改变系统边界。

## 文档地图

| 文档 | 主要问题 | 目标读者 | 状态 |
| --- | --- | --- | --- |
| [系统架构](architecture/overview.md) | 系统如何分层、运行和扩展？ | 全体工程人员 | MVP 技术基线 |
| [领域模型](architecture/domain-model.md) | 资产、作用域、生效配置和部署如何表达？ | 核心与适配器工程师 | MVP 技术基线 |
| [工具适配器](architecture/adapter-system.md) | 四类工具如何通过统一契约接入？ | 适配器工程师 | MVP 技术基线 |
| [数据存储](architecture/data-storage.md) | 文件、SQLite、扫描和监听如何协作？ | 核心与数据工程师 | MVP 技术基线 |
| [API、IPC 与 CLI](architecture/api-and-ipc.md) | 桌面端和 CLI 如何安全调用核心能力？ | 桌面与 CLI 工程师 | MVP 技术基线 |
| [安全架构与威胁模型](architecture/security.md) | 权限边界和主要威胁如何控制？ | 安全与桌面工程师 | MVP 技术基线 |
| [仓库与工具链](development/repository-and-tooling.md) | 项目如何组织、开发和评审？ | 应用工程师 | MVP 技术基线 |
| [测试策略](development/testing-strategy.md) | 哪些测试与质量门禁保证交付？ | 测试与应用工程师 | MVP 技术基线 |
| [构建、发布与兼容性](operations/build-release-and-compatibility.md) | 三平台产物如何可靠发布？ | 发布工程师 | MVP 技术基线 |
| [可观测性与恢复](operations/observability-and-recovery.md) | 如何诊断、备份和恢复本地故障？ | 支持与运维工程师 | MVP 技术基线 |
| [ADR-0001：模块化单体](adr/0001-modular-monolith.md) | 为什么选择 TypeScript pnpm 模块化 Monorepo？ | 架构评审人员 | 已接受 |
| [ADR-0002：Electron 安全边界](adr/0002-electron-security-boundary.md) | 特权能力为何只存在于主进程？ | 桌面与安全工程师 | 已接受 |
| [ADR-0003：文件为事实来源](adr/0003-files-as-source-of-truth.md) | 为什么配置由文件权威管理，而 SQLite 区分派生与非派生记录？ | 核心与数据工程师 | 已接受 |

## 核心技术约束

- 所有应用和核心实现统一使用 TypeScript strict 模式。
- 桌面端采用 Electron 与 React，CLI 可脱离 Electron 独立运行。
- 桌面端和 CLI 必须调用相同核心用例，不能复制业务规则。
- 支持 Windows、macOS 和 Linux；Linux 最低兼容基线为 glibc 2.28。
- 配置文件是配置内容的事实来源；SQLite 保存可重建的派生索引，以及必须独立备份的设置和审计记录。
- 首次扫描默认只读；写入必须经过预览、确认、备份、原子替换、验证和回滚记录。
- 扫描不执行 Rule、Agent、Skill、MCP、Hook 或其他第三方配置中的命令。
- Claude Code、Cursor、Codex、OpenCode 通过编译时注册的统一适配器接入。
- 默认不上传配置、日志或遥测；任何未来遥测能力必须由用户主动选择加入。

## 文档状态

“MVP 技术基线”表示文档已经作为首版实现依据，但仍可通过 ADR 和评审流程演进。代码实现尚未存在时，示例路径、命令和接口是实现契约；脚手架落地后，持续集成必须验证这些契约。

文档状态变更规则：

- `草案`：允许较大调整，不能单独作为实现依据。
- `MVP 技术基线`：已评审，可用于实现和验收。
- `已废弃`：保留历史链接，并指向替代文档或 ADR。

## 维护规则

- 改变跨模块边界、信任边界、事实来源或兼容基线时，必须新增或替代 ADR。
- 改变领域术语时，先更新领域模型，再更新引用它的专题文档和代码类型。
- 新增适配器能力时，同步更新能力声明、契约测试矩阵和兼容性说明。
- 新增数据库字段时，同步更新逻辑 Schema、迁移策略、恢复流程和升级测试。
- 示例不得包含真实用户名、Token、密钥、企业仓库地址或未脱敏配置内容。
- 所有相对链接和 Mermaid 图必须在合并前验证。
