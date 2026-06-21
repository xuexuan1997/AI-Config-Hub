# 仓库结构与开发工具约定

| 项目 | 内容 |
| --- | --- |
| 目的 | 规定 Monorepo 的模块职责、依赖边界、根命令和贡献门禁，使桌面端、CLI 与共享核心可独立演进并保持一致行为。 |
| 目标读者 | 应用工程师、适配器作者、测试工程师、依赖维护者和代码审查者。 |
| 状态 | MVP 技术基线；根脚手架和自动化尚未实现，文中命令在脚手架落地后生效。 |
| 相关文档 | [架构总览](../architecture/overview.md) · [适配器系统](../architecture/adapter-system.md) · [安全设计](../architecture/security.md) · [测试策略](./testing-strategy.md) · [已确认技术方案](../superpowers/specs/2026-06-21-technical-solution-design.md) |

## 1. 仓库布局与所有权

仓库采用 pnpm workspace 管理的全 TypeScript 模块化单体。应用入口位于 `apps/*`，可复用能力位于 `packages/*`；配置文件仍是事实来源，应用代码不得把 SQLite 索引当作唯一数据源。

| 目录 | 职责 | 公开入口与边界 | 测试位置 |
| --- | --- | --- | --- |
| `apps/desktop` | Electron 主进程、受限 preload、React renderer、窗口生命周期和桌面组装。 | 应用自身不作为库被其他 workspace 包引用；主进程仅从包的公开 `exports` 组装能力，renderer 仅使用 preload 暴露的 API。 | `src/**/*.test.ts(x)`；桌面集成测试放 `tests/integration/`；Electron E2E 放仓库根 `tests/e2e/desktop/`。 |
| `apps/cli` | Commander.js 命令、终端和 `--json` 输出、退出码、无图形运行时组装。 | `package.json#bin` 是可执行入口；不得导入 Electron、renderer 或 IPC handler。 | `src/**/*.test.ts`；CLI 集成与 smoke 测试放 `tests/integration/`。 |
| `packages/core` | 领域模型、用例编排、兼容判断和不依赖基础设施的业务规则。 | `src/index.ts` 导出稳定类型、端口和用例；不能依赖具体数据库、文件系统、Git 或 Electron。 | `src/**/*.test.ts`。 |
| `packages/adapters` | Claude Code、Cursor、Codex、OpenCode 适配器和编译时注册表。 | `src/index.ts` 仅导出适配器契约、注册表和已注册适配器；工具内部解析器不公开。 | `src/**/*.test.ts`；唯一夹具根为 `packages/adapters/test/fixtures/<toolId>/`，唯一 golden 根为 `packages/adapters/test/golden/<toolId>/`；契约测试代码在 `tests/contract/adapters/`。 |
| `packages/scanner` | 安全文件发现、解析调度、哈希、增量扫描和 Chokidar 事件归并。 | `src/index.ts` 导出扫描服务及其端口；不直接决定工具语义。 | `src/**/*.test.ts`；临时文件系统集成测试放 `tests/integration/`。 |
| `packages/deployer` | 差异与变更计划、备份、原子写入、验证、补偿和回滚。 | `src/index.ts` 导出预览、执行、验证和回滚用例；写入必须经过计划，不公开任意写文件函数。 | `src/**/*.test.ts`；故障注入测试放 `tests/integration/`。 |
| `packages/storage` | SQLite/Drizzle Schema、数据访问、事务边界和迁移。 | `src/index.ts` 导出 repository 接口实现、数据库启动与迁移 API；不导出 Drizzle 内部表路径。 | `src/**/*.test.ts`；迁移测试放 `tests/integration/migrations/`。 |
| `packages/git` | 个人/团队资产仓库的状态、同步和冲突处理，复用用户已有凭据机制。 | `src/index.ts` 导出业务级 Git 操作；不得暴露可拼接任意 shell 的入口。 | `src/**/*.test.ts`；临时仓库测试放 `tests/integration/`。 |
| `packages/api` | Zod 请求/响应/事件 Schema、IPC handler 绑定和类型安全客户端。 | `src/index.ts` 导出 Schema 与客户端；可使用子路径导出 `./client`、`./handlers`，但必须在 `package.json#exports` 明示。 | `src/**/*.test.ts`；IPC 契约测试放 `tests/contract/ipc/`。 |
| `packages/shared` | 稳定错误码、日志基础设施、无业务状态的通用类型和小型工具。 | `src/index.ts` 是默认入口；只能依赖外部基础库，不依赖任何 `apps/*` 或其他业务包。 | `src/**/*.test.ts`。 |

每个目录必须在 `CODEOWNERS` 中有明确所有者。包内单元测试与源码相邻，跨包测试按类型集中到 `tests/contract/`、`tests/integration/`、`tests/e2e/` 和 `tests/packaging/`。测试数据不得散落到生产源码目录以外的未声明路径。

## 2. 公开入口与依赖方向

每个可复用包都以 `package.json#exports` 和 `src/index.ts` 定义公开面。消费者只能使用包名或明示子路径，例如 `@ai-config-hub/api/client`；禁止 `@ai-config-hub/api/src/...`、相对路径穿越到其他包，或从构建目录 deep import。未列入 `exports` 的实现随时可变。

允许的依赖方向为：

```text
apps/desktop ─┬─> packages/api ─> packages/core ─> packages/shared
              ├─> packages/scanner ──────────────> packages/core/shared
              ├─> packages/deployer ─────────────> packages/core/shared
              ├─> packages/storage ──────────────> packages/core/shared
              ├─> packages/git ──────────────────> packages/core/shared
              └─> packages/adapters ─────────────> packages/core/shared

apps/cli ──────┴─> 与 desktop 相同的核心用例；不经过 IPC，不依赖 Electron
```

- `core` 声明端口，基础设施包实现端口；`core` 不反向依赖实现。
- `adapters` 依赖稳定领域契约，不能依赖 UI、数据库事务或 Git 凭据实现。
- `api` 负责跨边界 Schema，不成为装载全部业务实现的“公共杂物包”。
- `shared` 位于依赖图底部；新增内容必须能被至少两个包合理复用，且不能携带业务流程。
- 不允许包间循环依赖。CI 应使用 workspace 图检查阻断循环和未声明依赖。

## 3. 命名与文件组织

- workspace 包使用 `@ai-config-hub/<name>`；目录使用 `kebab-case`。
- TypeScript 文件使用 `kebab-case.ts`；React 组件文件使用 `PascalCase.tsx`；变量和函数使用 `camelCase`；类型、Schema 和组件使用 `PascalCase`；常量使用 `UPPER_SNAKE_CASE`。
- Zod 值以 `...Schema` 结尾，类型由 `z.infer<typeof ...Schema>` 派生；禁止复制维护同形的手写 interface。
- 业务错误使用稳定的 `UPPER_SNAKE_CASE` 错误码。日志字段、IPC 命令和 JSON 输出一经发布即视为兼容面。
- migration 文件按单调递增序号命名，例如 `0007_add_deployment_hash.sql`；已发布 migration 永不改写。
- 测试命名为 `*.test.ts(x)`；契约夹具目录必须包含用途说明，golden 文件命名体现输入和期望，而非 `case1`。

## 4. 根命令契约

以下命令是目标脚手架的统一开发入口。**当前文档阶段不保证命令已经存在；在根 `package.json`、workspace 和 CI 脚手架实现后才生效并成为强制契约。** 所有命令从仓库根执行，CI 不调用包内的私有替代命令。

| 命令 | 契约 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 按固定 pnpm 版本和已审查的 `pnpm-lock.yaml` 安装；CI 禁止隐式更新 lockfile。开发者首次安装可运行 `pnpm install`，任何 lockfile 变化必须提交审查。 |
| `pnpm dev` | 启动 desktop 开发模式及必要包的 watch 构建；CLI 开发入口通过根任务并行暴露，不绕过类型边界。 |
| `pnpm build` | 按依赖图生成所有包、desktop 和 CLI 的可发布构建；不执行平台安装包签名。 |
| `pnpm typecheck` | 对全 workspace 执行 `tsc --noEmit` 或等价 project references 检查，任何错误阻断合并。 |
| `pnpm lint` | 执行 ESLint 和格式一致性检查；禁止自动修复掩盖 CI 结果。 |
| `pnpm test` | 运行 Vitest 单元测试和快速适配器契约测试，输出机器可读结果和覆盖率。 |
| `pnpm test:integration` | 在隔离临时目录、临时 SQLite 和临时 Git 仓库运行扫描、存储、部署、迁移及 CLI 集成测试。 |
| `pnpm test:e2e` | 使用 Playwright 启动实际 Electron 应用，覆盖关键用户流程；平台差异由 CI matrix 提供。 |
| `pnpm package` | 使用 electron-builder 生成当前平台 desktop 产物并构建独立 CLI；发布 CI 再执行签名、notarization、安装验证和校验和生成。 |

脚本应支持 `--filter` 或 Vitest/Playwright 原生过滤参数，但过滤执行不满足完整合并门禁。根任务失败时必须传播非零退出码，不允许以日志告警替代失败。

## 5. TypeScript 与依赖治理

### 5.1 TypeScript 基线

- 根配置启用 `strict: true`，因此 `noImplicitAny` 必须为 `true`；不得使用未解释的 `any`、`@ts-ignore` 或双重断言绕过边界校验。
- 对无法静态信任的输入先使用 `unknown`，再通过 Zod 或类型守卫收窄。文件、数据库、IPC、CLI JSON、Git 和适配器输入都属于不可信边界。
- 请求、响应、事件、持久化枚举和适配器能力以 Schema 为源，TypeScript 类型从 Schema 派生。
- 公共函数和导出类型需要稳定语义；`.d.ts` 输出和 `exports` 解析在包构建测试中验证。
- 不使用 TypeScript path alias 绕过 workspace 依赖声明；本地成功但发布包无法解析视为阻断缺陷。

### 5.2 包管理与 lockfile

- 根 `package.json#packageManager` 固定精确 pnpm 版本，Corepack 与 CI 使用同一版本；Node.js/Electron 版本在兼容清单中固定。
- `pnpm-lock.yaml` 是受审查的供应链输入。审查者检查新增 transitive dependency、下载脚本、许可证、维护状态、体积和已知漏洞。
- 生产依赖必须在实际使用它的 workspace 声明；禁止依赖幽灵提升。开发工具尽量统一放在根目录，避免版本漂移。
- 不在常规 CI 中无约束运行 `pnpm update`。依赖升级使用独立变更，附三平台测试证据。

### 5.3 原生依赖评审

引入或升级 native addon、预编译二进制、安装脚本、WASM runtime 或调用系统二进制的依赖时，必须由平台/发布所有者审查：

1. 列出下载来源、校验机制、支持架构和 fallback 行为。
2. 在 Windows、macOS、Linux 目标架构验证；Linux 额外证明 glibc 2.28 兼容。
3. 审计 Electron ABI 与 Node.js CLI ABI，确认 desktop 和独立 CLI 均能加载。
4. 运行 runtime symbol inspection，拒绝依赖高于基线的 GLIBC/GLIBCXX 符号。
5. 没有可靠预构建和可重复构建证据时，优先选择纯 TypeScript 或受控 WebAssembly 实现。

## 6. 贡献工作流

### 6.1 分支与提交

- 功能分支使用 `feat/<topic>`、`fix/<topic>`、`docs/<topic>`、`chore/<topic>` 或仓库自动化要求的 `codex/<topic>`；分支必须短生命周期并保持单一目标。
- 提交遵循 Conventional Commits：`feat`、`fix`、`docs`、`test`、`refactor`、`perf`、`build`、`ci`、`chore`、`revert`。破坏性变更使用 `!` 和 `BREAKING CHANGE:`，且 MVP 稳定兼容面不得仅凭提交标记跳过迁移设计。
- PR 描述列出用户影响、风险、测试证据、兼容影响和恢复方式；行为变化需同步文档与测试。

### 6.2 合并必需检查

每个 PR 至少通过 `pnpm typecheck`、`pnpm lint`、`pnpm test` 和受影响的集成/契约测试。涉及 Electron/IPC、部署写入、DB migration、打包或平台代码时，相应 IPC、E2E、迁移、安装和平台检查自动升级为必需。保护分支不得使用管理员绕过失败检查；紧急例外须记录批准者、风险、回退计划并补跑全部检查。

### 6.3 适配器与夹具变更

- 修改适配器发现、解析、优先级、诊断、转换或部署计划时，必须同时更新 `packages/adapters/test/fixtures/<toolId>/` 中对应工具/资源的合成或不可逆匿名夹具、`packages/adapters/test/golden/<toolId>/` 中的 normalized golden、兼容声明和 `tests/contract/adapters/` 中的契约测试。
- golden 更新不能由脚本生成后直接接受；审查者必须阅读差异，说明字段增加、丢弃或重写原因。
- 新工具版本先添加 version-boundary 与 unknown-newer-version 用例，不得默认为完全兼容。

### 6.4 数据库 migration

- Schema 变化只能新增 Drizzle migration；禁止编辑已发布文件或依赖开发环境自动同步。
- PR 必须包含空库创建、受支持旧版本升级、失败后只读恢复、重复启动幂等性和回滚兼容测试。
- migration 评审需说明锁定时间、数据量假设、是否可逆、备份要求，以及旧应用是否能读取迁移后的 DB。若不能，版本清单必须标记禁止降级。

### 6.5 安全评审触发条件

出现下列任一情况必须请求安全审查并在 PR 中更新威胁模型或说明为何无需更新：

- 新增/扩大 Electron preload、IPC、文件系统、子进程、网络、外部 URL 或 Git 凭据能力。
- 改变允许扫描/写入的根目录、路径规范化、符号链接、权限、原子替换、备份或回滚逻辑。
- 解析新的不可信格式，执行第三方内容，或新增模板/命令插值；MVP 默认禁止执行第三方配置。
- 日志、诊断包、遥测、崩溃报告、剪贴板或导出内容新增字段。
- 新增 native dependency、安装脚本、二进制下载、动态代码加载或远程更新机制。
- 改变密钥识别、敏感字段 allowlist/脱敏、加密、签名或发布凭据处理。

## 7. 维护检查表

- 新包有单一职责、`exports`、所有者、README 或入口注释，以及最小契约测试。
- 依赖箭头符合本文件，不存在跨包 deep import 或循环。
- 新 Schema 的运行时校验与派生类型来自同一来源。
- 新命令接入根任务和 CI，失败正确传播。
- lockfile 变化、原生依赖、适配器夹具、migration 和安全触发项均有明确审查证据。
