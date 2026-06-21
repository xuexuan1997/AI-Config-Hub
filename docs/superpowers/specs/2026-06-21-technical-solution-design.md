# AI Config Hub 完整技术方案设计

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档状态 | 已确认设计稿 |
| 编写日期 | 2026-06-21 |
| 产品阶段 | MVP 技术设计 |
| 技术栈 | TypeScript、Electron、React、Node.js |
| 目标平台 | Windows、macOS、Linux |
| Linux 兼容基线 | glibc 2.28 |
| 需求依据 | `docs/PRD.md` |

## 2. 目标与边界

本方案为 AI Config Hub 提供完整的 MVP 技术设计。系统统一发现、解析、诊断、转换和部署 Claude Code、Cursor、Codex 与 OpenCode 的 Rules、Agents、Skills 和 MCP 配置，并通过桌面应用和 CLI 提供相同的核心能力。

系统必须满足以下技术目标：

- 所有应用和核心模块统一使用 TypeScript。
- Electron 桌面端支持 Windows、macOS 和 Linux。
- Linux 桌面端与 CLI 兼容 glibc 2.28。
- CLI 可在无图形环境运行，不依赖 Electron 启动。
- 配置文件始终是事实来源，数据库只保存索引和派生信息。
- 首次扫描默认只读，任何写入都可预览、验证和回滚。
- 核心业务逻辑由桌面端和 CLI 共享，不在界面层重复实现。

MVP 不提供云端配置托管、账号系统、在线市场、MCP 进程管理、实时协作或第三方脚本执行能力。

## 3. 架构决策

### 3.1 架构形态

项目采用模块化单体 Monorepo。模块化单体可以在 MVP 阶段降低构建、安装、调试和发布复杂度，同时通过清晰的包边界为未来插件化演进保留空间。

适配器在编译时注册，由核心模块通过统一接口调用。MVP 不支持从任意路径动态加载第三方代码，避免扩大执行面和兼容性风险。

### 3.2 仓库结构

```text
apps/
  desktop/           Electron 主进程、预加载脚本和 React 渲染进程
  cli/               无图形环境 CLI
packages/
  core/              领域模型、用例编排和业务规则
  adapters/          工具适配器与适配器注册表
  scanner/           文件发现、解析、哈希和变化检测
  deployer/          变更计划、备份、写入、验证和回滚
  storage/           SQLite、数据访问层和数据库迁移
  git/               个人及团队资产仓库能力
  api/               IPC 命令、请求响应 Schema 和客户端封装
  shared/            公共类型、错误码、日志和基础工具
```

Monorepo 使用 pnpm workspace 管理依赖和任务。各包只能通过公开入口引用其他包，不允许跨包导入内部文件。

### 3.3 运行时边界

Electron 主进程持有文件系统、SQLite、Git 和子进程权限。渲染进程只负责界面展示和用户交互，通过预加载脚本暴露的白名单 IPC 调用业务能力。

CLI 直接调用与 Electron 主进程相同的核心用例，不经过 IPC，也不依赖 Electron。桌面端关闭 `nodeIntegration`、启用 `contextIsolation`，并限制导航、新窗口和外部链接行为。

## 4. 核心领域模型

### 4.1 Tool

表示受支持的 AI Coding 工具，包含工具标识、检测结果、版本、能力集合和适配器版本。

### 4.2 Resource

表示配置资源类型。MVP 支持 Rule、Agent、Skill 和 MCP。资源类型决定规范化字段、校验规则和可转换能力。

### 4.3 Scope

表示配置的作用范围，至少包含用户级、项目级和子目录级。Scope 保存规范化路径、项目归属、层级深度和适配器给出的优先级信息。

### 4.4 Asset

Asset 是可管理的统一资产，包含：

- 稳定标识、资源类型和所属工具。
- 来源文件、作用域和发现时间。
- 原始内容及其内容哈希。
- 规范化内容与 Schema 版本。
- 工具专属扩展字段。
- 兼容等级、诊断摘要和引用关系。

系统保留原始内容，不用规范化结果覆盖源文件。

### 4.5 EffectiveConfig

表示指定工具、项目和目标目录下的最终生效配置。除结果外，还必须保存参与计算的资产、优先级、合并或覆盖步骤、被忽略项以及推导依据。

### 4.6 Diagnostic

表示可解释的配置问题，包含稳定错误码、严重程度、问题位置、影响范围、判断证据和建议动作。诊断结果不得只返回无法定位的通用描述。

### 4.7 Deployment

表示一次受控写入，包含变更计划、差异、目标路径、写入策略、源文件哈希、备份位置、执行日志、验证结果和回滚状态。

## 5. 工具适配器

每个适配器负责工具差异，不将工具专属规则泄漏到通用领域层。统一接口为：

```ts
interface ToolAdapter {
  detect(context: DetectionContext): Promise<DetectedTool[]>;
  discover(context: DiscoveryContext): Promise<DiscoveredResource[]>;
  parse(resource: DiscoveredResource): Promise<ParsedAsset>;
  resolveEffective(
    context: ResolutionContext,
    assets: Asset[],
  ): Promise<EffectiveConfig>;
  diagnose(
    context: DiagnosticContext,
    assets: Asset[],
  ): Promise<Diagnostic[]>;
  convert(asset: Asset, target: ConversionTarget): Promise<ConversionResult>;
  planDeployment(
    result: ConversionResult,
    target: DeploymentTarget,
  ): Promise<DeploymentPlan>;
  verify(deployment: DeploymentRecord): Promise<VerificationResult>;
}
```

适配器必须声明支持的工具版本、资源类型、目录规则、优先级规则、转换能力和不兼容字段。适配器升级时保留版本号，使历史扫描和部署记录可追溯。

## 6. 核心数据流

### 6.1 扫描与索引

```text
适配器发现工具和配置路径
→ 扫描候选文件
→ 安全解析与 Schema 校验
→ 保存原始内容摘要并生成统一资产
→ 计算层级、继承和覆盖关系
→ 生成诊断与生效配置
→ 在 SQLite 中更新索引
→ UI 或 CLI 查询结果
```

单个文件解析失败不会终止整次扫描。任务返回成功项、失败项和部分成功状态，并为失败项生成可定位诊断。

### 6.2 迁移与部署

```text
选择源资产和目标工具
→ 匹配目标能力并转换格式
→ 标记完整、部分或不兼容
→ 生成结构化差异和文本差异
→ 用户确认变更计划
→ 备份现有目标
→ 原子写入
→ 重新扫描并验证
→ 记录历史和回滚信息
```

若预览后源文件或目标文件的哈希发生变化，系统必须中止部署并要求重新生成预览。

### 6.3 文件变化监听

Chokidar 监听已登记的配置目录。变化事件先去抖和合并，再触发增量扫描。部署模块产生的写入事件通过任务关联标识去重，避免重复扫描和循环触发。

## 7. 数据存储

SQLite 保存工具、项目、资产索引、规范化内容、引用关系、诊断、扫描任务、部署记录、备份元数据和数据库迁移版本。

原始配置文件是事实来源。数据库中的原始内容只在解释差异确有需要时保存；敏感字段必须脱敏或只保存引用位置与摘要。文件内容哈希用于漂移检测和乐观并发控制。

SQLite 开启 WAL 模式。每次数据库 Schema 变更都通过 Drizzle 迁移执行。迁移在应用访问业务数据前完成；迁移失败时应用进入可诊断的只读恢复状态，不继续执行写入任务。

## 8. API 与 IPC

IPC 提供业务级命令，不暴露通用文件系统或进程执行方法。首批命令包括：

- `scan.start`、`scan.status`、`scan.cancel`
- `assets.list`、`assets.get`
- `effective.resolve`
- `diagnostics.list`
- `migration.preview`
- `deployment.execute`、`deployment.rollback`
- `history.list`
- `settings.get`、`settings.update`

所有请求、响应和事件使用 Zod 校验。`packages/api` 同时提供共享 TypeScript 类型、主进程处理器和渲染进程客户端。CLI 调用同一用例层，并将结果格式化为表格或 JSON。

长任务使用任务 ID、进度事件和取消信号。取消扫描只停止尚未开始的工作，不破坏已提交索引；部署进入原子写入阶段后不允许取消，必须完成或回滚。

## 9. 技术选型

| 领域 | 选型 | 用途 |
| --- | --- | --- |
| 语言 | TypeScript strict | 全仓类型与业务实现 |
| 运行时 | Node.js LTS | CLI、Electron 主进程和核心包 |
| 桌面端 | Electron | 三平台桌面壳 |
| UI | React、Vite | 渲染进程界面与构建 |
| Monorepo | pnpm workspace | 依赖和任务管理 |
| 数据库 | SQLite、Drizzle ORM | 本地索引和迁移 |
| 校验 | Zod | 配置、API 与 IPC Schema |
| CLI | Commander.js | 命令与参数解析 |
| 日志 | Pino | 结构化日志与脱敏 |
| 文件监听 | Chokidar | 配置增量变化检测 |
| 单元测试 | Vitest | 核心与包级测试 |
| 端到端测试 | Playwright | Electron 关键流程 |
| 打包 | electron-builder | 安装包与发布产物 |
| 代码质量 | ESLint、Prettier | 静态检查与格式化 |

依赖版本在实施阶段根据 Node.js 与 Electron 的兼容矩阵锁定。任何原生 Node 模块都必须验证预构建产物、三平台支持及 glibc 2.28 兼容性；存在风险时优先选择纯 TypeScript 或 WebAssembly 实现。

## 10. 安全设计

- 扫描过程只读取文本，不执行 Skill、Hook、MCP 命令或第三方脚本。
- 配置路径经过规范化、允许范围检查和符号链接解析，防止目录逃逸。
- MCP Token、密钥和环境变量只显示脱敏值，不写入普通日志。
- Electron 启用上下文隔离，禁用渲染进程 Node.js 集成。
- 外部链接交给系统浏览器前必须经过协议白名单检查。
- Git 凭据复用系统或用户已有凭据机制，产品不自建明文密钥库。
- 所有写入均需要明确目标、差异预览和用户确认。
- 备份目录使用最小权限，并按保留策略清理。

## 11. 一致性、错误与恢复

### 11.1 并发控制

同一目标路径使用进程内互斥锁，防止扫描、监听和部署竞争。部署前检查预览时记录的源与目标哈希，实现乐观并发控制。

### 11.2 原子写入

写入先在目标目录创建临时文件，完成刷新与校验后再原子替换。批量部署使用操作日志记录每一步及其补偿动作。任一步失败时，按相反顺序恢复已经修改的文件。

### 11.3 错误模型

错误分为发现、解析、兼容、权限、冲突、部署、验证、Git 和内部错误。每个错误包含：

- 稳定错误码。
- 面向用户的信息。
- 可脱敏的技术上下文。
- 是否允许重试。
- 建议处理动作。
- 所属任务和关联 ID。

可恢复错误以部分成功形式返回；会造成数据不一致的错误必须阻止部署，并提供回滚结果。

## 12. 测试策略

### 12.1 单元测试

覆盖资产规范化、优先级计算、兼容等级、路径安全、错误映射、转换规则和部署计划生成。

### 12.2 适配器契约测试

每个工具维护脱敏配置夹具和黄金文件，验证发现路径、解析结果、生效规则、诊断、转换输出和版本兼容声明。

### 12.3 集成测试

在临时目录和临时 SQLite 数据库中验证完整扫描、增量扫描、备份、原子写入、失败回滚、数据库迁移和 Git 资产库流程。

### 12.4 API 与 IPC 契约测试

验证 Schema、错误码、任务事件和取消语义，保证 Electron、CLI 与核心层行为一致。

### 12.5 端到端与平台测试

Playwright 覆盖首次扫描、诊断、生效配置、迁移预览、部署和回滚。CI 分别验证 Windows、macOS 和 glibc 2.28 Linux 的安装、启动及核心冒烟流程。

## 13. 构建与发布

桌面端通过 electron-builder 生成 Windows 安装包、macOS 安装包以及 Linux AppImage 和压缩包。CLI 作为独立产物发布，可在无桌面组件的环境运行。

项目版本遵循 SemVer。数据库 Schema、统一资产 Schema 和适配器接口分别维护版本。发布流程必须生成校验和，并在三平台完成安装与启动验证。

Linux 产物在 glibc 2.28 基线构建环境中生成。CI 使用相同或更低基线容器进行 CLI 测试，并在目标 Linux 发行版执行 Electron 启动测试，防止构建环境无意引入更高版本的系统符号。

## 14. 日志与隐私

Pino 输出结构化滚动日志，使用关联 ID 串联一次扫描、迁移或部署。日志字段采用允许列表，路径可按设置进行缩略，敏感键名和值统一脱敏。

产品默认不上传遥测、配置内容或日志。未来若增加遥测，必须默认关闭、明确说明字段，并由用户主动选择加入。

## 15. MVP 技术交付顺序

1. 建立 Monorepo、共享类型、错误模型和测试基线。
2. 实现统一资产模型、SQLite Schema 和核心用例。
3. 实现四个工具适配器及扫描流程。
4. 实现层级计算、生效配置与诊断。
5. 实现转换、差异、部署、备份和回滚。
6. 实现 CLI 命令和 JSON 输出。
7. 实现 Electron IPC、React 界面和文件监听。
8. 实现 Git 资产库和版本历史。
9. 完成三平台打包、glibc 2.28 验证和发布流水线。

## 16. 验收原则

技术实现满足以下条件时可进入 MVP 验收：

- 桌面端和 CLI 对相同输入产生一致的核心结果。
- 四个目标工具及四类资源均有适配器契约测试。
- 任一诊断均可定位来源、影响范围和判断依据。
- 任一写入均有预览、备份、验证和可验证的回滚记录。
- 外部文件变化不会被静默覆盖。
- 损坏的单个配置不会阻断其他配置扫描。
- 三平台产物完成安装和启动测试。
- Linux 桌面端及 CLI 通过 glibc 2.28 基线验证。
- 默认运行不会执行第三方配置或上传用户数据。

## 17. 后续演进

当适配器数量或第三方扩展需求显著增长时，可将编译时适配器注册表演进为签名插件机制。演进前需先定义插件权限、兼容协商、沙箱、签名验证和升级策略；这些能力不属于 MVP。

本地 Web UI 可在核心 API 边界稳定后拆分为独立入口。若需要远程访问，必须新增身份认证、来源限制、TLS 和网络威胁模型，不直接暴露当前 Electron IPC。
