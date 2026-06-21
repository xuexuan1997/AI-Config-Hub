# 测试策略与质量门禁

| 项目 | 内容 |
| --- | --- |
| 目的 | 定义从纯业务规则到三平台安装包的验证层次、覆盖矩阵、故障注入和发布阻断条件。 |
| 目标读者 | 开发工程师、适配器作者、测试工程师、发布工程师和安全审查者。 |
| 状态 | MVP 技术基线；随脚手架建立后成为 CI 与发布审批的强制契约。 |
| 相关文档 | [仓库与工具约定](./repository-and-tooling.md) · [适配器系统](../architecture/adapter-system.md) · [API 与 IPC](../architecture/api-and-ipc.md) · [安全设计](../architecture/security.md) · [构建发布与兼容性](../operations/build-release-and-compatibility.md) · [已确认技术方案](../superpowers/specs/2026-06-21-technical-solution-design.md) |

## 1. 测试原则

- 同一输入经过 Electron 和 CLI 必须得到相同的核心结果；界面测试不能替代核心/契约测试。
- 测试使用真实 Schema、公开入口和生产级迁移，不为测试开放任意文件、IPC 或内部 deep import。
- 配置文件是不可信文本。成功路径、部分成功、恶意输入、损坏输入、并发漂移和补偿失败同等重要。
- 文件是事实来源，SQLite 是可重建索引。测试需证明索引重建不会改写源配置。
- 所有写入路径必须覆盖预览、确认、备份、原子写入、验证和回滚；只有“写入成功”不构成完成。
- 随机/时间相关测试固定 seed 和 clock；平台路径、大小写、权限和行尾差异必须显式构造，不依赖开发机状态。

## 2. 分层、归属与阻断级别

阻断级别定义：`merge` 表示任何 PR 必须通过；`affected merge` 表示变更触及相应边界时阻断合并；`release` 表示发布候选不得批准；`nightly` 失败会阻断下一次发布但不阻断无关文档 PR。

| 测试层 | 主要内容 | 归属/位置 | 运行频率 | 阻断级别 |
| --- | --- | --- | --- | --- |
| 单元测试 | 规范化、优先级、兼容等级、路径安全、错误映射、差异与部署计划。 | 各 `packages/*/src/**/*.test.ts`，Vitest。 | 每个 PR。 | `merge`。 |
| 适配器契约 | 发现、解析、生效规则、诊断、转换、`AdapterDeploymentDraft`、版本边界。 | 夹具：`packages/adapters/test/fixtures/<toolId>/`；golden：`packages/adapters/test/golden/<toolId>/`；测试代码：`tests/contract/adapters/`。适配器所有者负责。 | 每个 PR；四工具全量可并行。 | `merge`，任一工具/资源缺失也失败。 |
| 集成测试 | 临时目录、SQLite/Drizzle、Chokidar、原子写入、备份、Git、迁移。 | 各包 `tests/integration/` 与根 `tests/integration/`。 | 受影响 PR + 每日全量。 | `affected merge`；全量 `release`。 |
| IPC 契约 | Zod 请求/响应/事件、错误 envelope、进度顺序、取消、renderer 白名单。 | `tests/contract/ipc/`，`packages/api` 与 desktop 共同负责。 | API、preload、desktop PR；发布候选全量。 | `affected merge` 与 `release`。 |
| Electron E2E | 首次扫描、诊断、生效配置、迁移预览、确认、部署、验证、历史和回滚。 | `tests/e2e/desktop/`，Playwright。 | desktop PR 冒烟；发布候选三平台全量。 | `affected merge` 与 `release`。 |
| 打包/安装测试 | 产物结构、签名 hook、安装/卸载、首次启动、CLI 独立性、校验和。 | `tests/packaging/`；发布工程负责。 | 每个发布候选。 | `release`。 |
| 兼容测试 | OS/架构、glibc 2.28、升级/禁止降级、工具版本、文件系统差异。 | CI platform matrix 和 `tests/compatibility/`。 | nightly + 发布候选。 | nightly 失败冻结发布；候选失败直接 `release` 阻断。 |

失败测试不得以“已知 flaky”无限重跑后放行。最多一次自动重跑只用于收集诊断，最终状态仍按第一次失败阻断；隔离 flaky 用例必须有 issue、责任人和到期日，且不能隔离安全、写入、migration 或回滚门禁。

## 3. 夹具与 golden 文件政策

适配器测试只使用以下三个规范位置，不建立其他别名目录：源夹具位于 `packages/adapters/test/fixtures/<toolId>/`，golden 位于 `packages/adapters/test/golden/<toolId>/`，契约测试代码位于 `tests/contract/adapters/`。

### 3.1 数据来源

- 夹具必须完全合成，或经过不可逆匿名化并由安全审查确认无法还原用户、组织、仓库、主机路径、Token、域名和业务文本。
- 禁止复制开发者真实 home 目录、客户仓库、日志或凭据到测试。敏感值测试使用明显虚构值，例如 `${TEST_TOKEN}`，并确保不会匹配真实密钥格式。
- 每个夹具目录包含短说明，写明工具、资源、Scope、输入意图、期望诊断和版本边界。夹具路径使用中性占位，例如 `/home/test-user/project` 或平台临时目录。
- 恶意/损坏集合至少包括：无效 UTF-8、截断 JSON/YAML、超深嵌套、超大字段、重复键、未知字段、路径穿越、符号链接逃逸、命令插值文本、控制字符、二进制伪装、secret-like 字段和引用环。

### 3.2 golden review

适配器契约为每个输入保存可读的 normalized、diagnostics、effective draft、conversion 和 `adapter-deployment-draft`（`AdapterDeploymentDraft`）golden；适配器 golden 不包含完整 `DeploymentPlan`。完整计划的 `deploymentPlanId`、`planHash`、来源/目标哈希、`backupPolicy`、`requiredConfirmations`、待确认警告和不可变性由 core/deployer 集成测试负责，并使用稳定字段断言或独立集成 golden 验证。更新流程为：

1. 先运行契约测试并保留旧/新差异。
2. 生成器不得自动覆盖已批准 golden；使用独立 `--update` 意图更新。
3. 作者逐字段说明增加、删除、重命名、排序和兼容等级变化。
4. 非作者审查原始夹具与 golden 差异，确认没有隐式丢字段、路径泄漏或敏感值。
5. 若输出是版本兼容面，同步 Schema/adapter version 与 release notes；仅重排也需要说明确定性规则。

golden 只验证完整结构，不替代针对关键不变量的断言。易变时间戳、随机 ID 和临时绝对路径必须在比较前规范化，禁止用大范围 snapshot mask 掩盖实际差异。

## 4. 四工具 × 四资源契约矩阵

每个单元格至少有 `valid`、`malformed`、`nested-scope`、`unknown-field`、`sensitive-value`、`version-min`、`version-max`、`unknown-newer-version` 用例；若某工具原生不支持某资源，也必须验证明确的 `unsupported` 诊断和零写入，而不是跳过。

| 工具 \ 资源 | Rule | Agent | Skill | MCP |
| --- | --- | --- | --- | --- |
| Claude Code | 发现/解析/生效/诊断/转换/golden | 发现/解析/生效/诊断/转换/golden | 发现/解析/生效/诊断/转换/golden | 发现/解析/生效/诊断/转换/golden |
| Cursor | 发现/解析/生效/诊断/转换/golden | 发现/解析/生效/诊断/转换/golden；不支持能力显式断言 | 发现/解析/生效/诊断/转换/golden；不支持能力显式断言 | 发现/解析/生效/诊断/转换/golden |
| Codex | 发现/解析/生效/诊断/转换/golden | 发现/解析/生效/诊断/转换/golden | 发现/解析/生效/诊断/转换/golden | 发现/解析/生效/诊断/转换/golden |
| OpenCode | 发现/解析/生效/诊断/转换/golden | 发现/解析/生效/诊断/转换/golden | 发现/解析/生效/诊断/转换/golden | 发现/解析/生效/诊断/转换/golden |

契约还必须证明 `detect` 声明的工具版本、capability 和 adapter version 与后续行为一致；未知更新版本只能返回保守兼容结果和可定位诊断，不能默认为 `full`。

## 5. 三平台与兼容矩阵

| 场景 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 路径与文件系统 | 盘符、UNC、反斜杠、大小写不敏感、占用文件替换 | app bundle、大小写差异、权限、quarantine/notarization hook | 权限、符号链接、大小写敏感、XDG 路径 |
| desktop 安装/启动 | 安装、开始菜单/卸载、首次启动 | installer、签名/notarization hook、首次启动 | AppImage 与 archive 启动、desktop 集成 |
| CLI | 无 Electron 安装也可运行，JSON/退出码稳定 | 无 UI 运行、路径与权限 | 在 glibc 2.28 基线环境 smoke，无 Electron 依赖 |
| 数据库 | 创建、WAL、锁冲突、旧版本升级 | 创建、WAL、锁冲突、旧版本升级 | 创建、WAL、锁冲突、旧版本升级 |
| 部署/回滚 | 原子替换等价策略、占用失败补偿 | 原子 rename、权限失败补偿 | 原子 rename、权限/跨设备失败补偿 |
| 证据 | 安装日志、版本清单、hash、smoke 结果 | 签名/notarization 结果、安装日志、hash | 基线镜像 digest、symbol inspection、Electron/CLI 结果、hash |

Linux 发布候选必须在 glibc 2.28 基线镜像构建/验证 CLI，并在受支持目标发行版验证 Electron 启动；仅在较新 runner 成功不算兼容证据。所有平台保留 OS/架构、Node/Electron 版本、产物 SHA-256 和测试运行链接。

## 6. 扫描结果矩阵

| 输入/故障 | 期望扫描状态 | 索引行为 | 诊断与副作用 |
| --- | --- | --- | --- |
| 全部有效 | `succeeded` | 原子提交完整增量 | 结果可重放；不修改配置。 |
| 单文件损坏 | `partially_succeeded` | 有效项提交，损坏项保留/标记策略符合契约 | 为该文件生成可定位诊断，其他文件不受阻。 |
| 恶意路径或符号链接逃逸 | `partially_succeeded` 或 `failed` | 目标不入索引 | 稳定安全错误码；不读取允许根外内容。 |
| 权限拒绝 | `partially_succeeded` | 已完成项可提交 | 路径缩略后记录；不泄露内容。 |
| 用户取消（提交前） | `cancelled` | 未开始项停止；已定义的 staging 不半提交 | 事件顺序完整、可重新扫描。 |
| Chokidar 事件溢出/丢失 | 触发全量重扫，最终为 `succeeded`、`partially_succeeded` 或 `failed` | 全量重扫成功后原子替换 | 不凭事件流猜测最终状态，也不引入额外 ScanRun 状态。 |
| SQLite 提交失败 | `failed` | 原索引保持可读 | 文件不变；报告只读恢复建议。 |
| 进程在 staging 中断 | 下次启动将 ScanRun 状态标记为 `failed`，并记录结构化 `reason: "PROCESS_INTERRUPTED"` | 丢弃未提交 staging | 新扫描可恢复，任务关联 ID 可追踪。 |

## 7. 转换等级矩阵

| 等级 | 断言 | 允许部署 | 必测边界 |
| --- | --- | --- | --- |
| `full` | 所有语义字段有等价目标表达，round-trip 或语义比较通过，无丢失。 | 可进入预览；仍需用户确认、备份和验证。 | 字段顺序、行尾、路径规范化不应降低语义一致性。 |
| `partial` | 列出 retained、transformed、dropped 字段及用户可见 warning；golden 固定原因。 | 只有用户明确确认损失后可部署；CLI 非交互必须显式 flag。 | 未知字段、目标能力缺失、近似转换、secret reference 保留。 |
| `unsupported` | 明确稳定原因码；输出不伪造目标文件。 | 禁止部署，零写入、零备份垃圾。 | 工具/资源不支持、目标版本越界、无法安全表达的执行语义。 |

从任意工具到任意目标工具的支持对以 adapter capability 生成测试参数；不存在的转换边也要测试 `unsupported`。转换测试不得通过比较格式化文本代替规范化语义比较。

## 8. 部署与回滚故障注入矩阵

故障注入必须可确定复现，使用可控端口/文件系统抽象、failpoint 或测试专用适配层；不得通过随机杀进程作为唯一验证。

| 注入点 | 预期执行行为 | 预期恢复与断言 |
| --- | --- | --- |
| 预览后源 hash 漂移 | 确认前阻断 | 不创建备份、不写目标；要求重新预览。 |
| 预览后目标 hash 漂移 | 备份/写入前阻断 | 不覆盖外部修改；错误包含冲突路径和 correlation ID。 |
| 备份目录创建失败 | 写入前失败 | 目标不变；deployment 记录为失败且不可声称可回滚。 |
| 备份复制或 fsync 失败 | 写入前失败 | 清理不完整备份；目标不变；manifest 标记无有效备份。 |
| 临时文件写入失败 | 替换前失败 | 删除临时文件，目标与原 hash 一致。 |
| 第 N 个文件原子替换失败 | 停止后续替换 | 按补偿日志逆序恢复 1..N-1；逐个校验恢复 hash。 |
| 写入后重新扫描失败 | 进入验证失败 | 自动回滚或按策略要求用户动作；不得标记 `succeeded`。 |
| 验证语义不一致 | 验证失败 | 逆序回滚并重新验证原状态。 |
| 回滚时单文件恢复失败 | DeploymentRecord 状态为 `failed`，并记录 `failureStage: "rolling_back"` 与结构化 `reason` | 保留备份与操作日志，列出已恢复/未恢复文件；禁止自动清理证据。 |
| 进程在 `writing` 中断 | 启动恢复检测到未完成记录 | 根据操作日志和 hash 判定补偿；不盲目重放写入。 |
| 备份 manifest 损坏 | 回滚前阻断 | 不使用未验证备份；转人工恢复 runbook。 |
| 清理任务与部署并发 | 有效备份加锁/引用保护 | 关联活动 deployment 的备份不删除。 |

## 9. IPC 与 E2E 核心场景

IPC 契约覆盖每个命令的合法/非法 request、成功/错误 response、Zod 拒绝、错误码、任务 ID、progress phase、事件单调顺序、断线重连和取消点。还必须验证 renderer 无法访问未暴露的文件系统、shell 或任意 channel；主进程返回前再次校验 response。

Electron E2E 至少覆盖：

1. 干净 profile 首次启动并执行只读扫描。
2. 展示单文件损坏的部分成功和可定位诊断。
3. 查看 EffectiveConfig 的来源与覆盖链。
4. 预览 `full`/`partial`/`unsupported` 转换，验证确认语义。
5. 外部修改造成 hash 漂移后部署被阻断。
6. 成功部署、重新扫描验证、历史记录和用户发起回滚。
7. 故障注入后的失败状态、补偿结果和恢复入口。
8. 日志/支持包预览中秘密和完整路径按政策脱敏。

E2E 使用隔离的 `userData`、临时 home、临时配置根和临时数据库；测试结束校验没有写到真实用户目录。

## 10. 发布质量门禁

发布候选只有在以下项目全部通过并绑定到同一 commit、version manifest 和产物 hash 后才能批准：

- `pnpm typecheck`：全 workspace TypeScript strict，无隐式 `any`。
- `pnpm lint`：ESLint、格式和禁止 deep import/循环依赖规则通过。
- `pnpm test`：unit 与四工具 × 四资源 adapter contract 全量通过，golden diff 已审查。
- `pnpm test:integration`：扫描、SQLite、Chokidar、Git、备份、原子写入、故障补偿、migration 全量通过。
- IPC contract：所有命令、Schema、错误、任务事件、取消和 preload allowlist 通过。
- `pnpm test:e2e`：Windows、macOS、Linux 的关键 Electron E2E 通过。
- package installation：每个平台实际安装/启动 desktop；Linux 同时启动 AppImage 和 archive；独立 CLI 在未安装 Electron 情况下 smoke。
- glibc 2.28：基线镜像中的 CLI smoke、runtime symbol inspection 以及目标 Linux 的 Electron 启动留证。
- migration upgrade：从每个受支持旧 DB 版本升级，数据/索引/历史检查通过；失败进入只读恢复。
- rollback：成功部署后回滚、部分替换补偿、验证失败回滚和回滚失败可诊断场景通过。
- 秘密脱敏：日志、Pino error、CLI JSON、IPC error、诊断导出、备份 manifest 和 support bundle 不包含凭据或默认配置正文。
- checksums/install evidence：发布产物校验和、签名/notarization hook 结果、安装日志和三平台版本证据完整。

任何门禁失败都生成可归属的失败记录，不允许仅凭人工试用覆盖自动化结果。豁免必须由发布与安全所有者共同批准、限定到一个版本、记录风险和撤回条件；glibc 2.28、秘密脱敏、迁移、写入/回滚和安装启动不得豁免。

## 11. 测试证据与维护

- CI 结果保留 commit、runner image digest、平台/架构、工具链版本、测试 shard 和产物 SHA-256。
- 发布证据保存期限不得短于对应发行版的支持期；测试日志应用与生产相同的敏感字段 allowlist。
- 新工具版本、新资源能力、新 IPC 命令、新 migration 和新产物格式必须先扩展本文件矩阵，再修改发布门禁。
- 覆盖率是趋势信号，不替代行为矩阵。核心兼容、路径安全、部署补偿和错误分支要求分支覆盖，并由契约用例证明语义。
