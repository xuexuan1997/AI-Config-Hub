# 04 落地路线图

本文把 UX 重设计拆成可评审、可测试的工程迭代。路线图只描述桌面端 UI 和 renderer 状态组织，不要求改写核心包。

## 迭代原则

- 每个迭代都必须保持现有 E2E 主流程可用：选择项目、扫描、资产检查、迁移预览、部署、历史、回滚。
- 优先改善理解和安全决策，不先做纯视觉翻新。
- UI 状态来自现有 API 和 renderer model；缺字段时先用可选展示，不伪造业务能力。
- 所有写入行为继续由主进程和 API 控制，renderer 不新增特权能力。

## Phase 1：全局上下文和首屏重构

### 目标

解决首次启动和扫描入口割裂的问题。

### 范围

- 重构 `AppShell` 的 project topbar 为 Global context bar。
- 首次启动 Overview 显示项目选择、只读承诺和扫描 CTA。
- 手动路径 fallback 改为可展开区域。
- 扫描状态文案改为用户语言，内部 task ID 进入技术详情。

### 主要文件

- `apps/desktop/src/renderer/components/app-shell.tsx`
- `apps/desktop/src/renderer/views/overview.tsx`
- `apps/desktop/src/renderer/model.ts`
- `apps/desktop/src/renderer/styles.css`
- `apps/desktop/src/renderer/views/view-structure.test.ts`
- `apps/desktop/src/renderer/model.test.ts`

### 验收

- 无项目时 Overview 是完整引导，而不是孤立扫描按钮。
- 文件选择器失败后手动路径 fallback 明显可用。
- 扫描完成主文案不展示内部 task id。
- 现有桌面 E2E 继续通过。

## Phase 2：资产分诊和详情分层

### 目标

把 Assets 从库存表升级为诊断优先的分诊工作台。

### 范围

- 增加 search 和筛选工具栏。
- 默认按诊断严重程度排序。
- 增加 row priority、status、selected for plan 等视觉标签。
- Asset detail 改为 Summary、Source、Effective、Diagnostics、Raw tabs。
- Raw normalized payload 默认折叠到 Raw tab。
- 诊断 Locate 变为行内次级 action。

### 主要文件

- `apps/desktop/src/renderer/views/assets.tsx`
- `apps/desktop/src/renderer/views/assets.test.ts`
- `apps/desktop/src/renderer/styles.css`
- `apps/desktop/src/renderer/model.ts`

### 验收

- 用户可一键筛选 error。
- 资产详情首屏显示可读摘要和下一步。
- Disabled assets 可见但不进入默认迁移选择。
- 现有 inspect、open source、effective、rescan after edit 能力保留。

## Phase 3：迁移计划构建器

### 目标

让 Migration 页面明确承载“选择 -> 预览 -> 证据 -> 进入部署”的计划构建流程。

### 范围

- 左侧 step controls：Source、Target、Conflict policy、Preview。
- 右侧 Plan preview：compatibility、field loss、operations、diff、hash snapshot、required confirmations。
- 生成 preview 后设置全局 Current plan 状态。
- 添加 `Review deployment` CTA。
- Unsupported、partial、expired、drifted 状态有明确视觉和文案。

### 主要文件

- `apps/desktop/src/renderer/views/migration.tsx`
- `apps/desktop/src/renderer/model.ts`
- `apps/desktop/src/renderer/model.test.ts`
- `apps/desktop/src/renderer/styles.css`

### 验收

- 混合资源类型 blocker 可见且阻止 preview。
- Field loss 和 required confirmations 在 preview 同屏展示。
- 生成 preview 后 Deployment 导航显示 needs approval。
- 计划 hash、source/target hash 和 expiresAt 可见。

## Phase 4：部署审批控制台

### 目标

把 Deployment 页面从按钮和 checkbox 集合，改为有证据的计划审批控制台。

### 范围

- 无计划空态和 `Build migration plan` CTA。
- Plan summary 展示来源、目标、操作数、compatibility、hash、expiresAt。
- Freshness/drift 状态阻断部署。
- Required confirmations 变成证据卡。
- 总确认保留。
- 部署进度按阶段显示。
- 部署完成后显示验证结果和 History/rollback 入口。

### 主要文件

- `apps/desktop/src/renderer/views/deployment.tsx`
- `apps/desktop/src/renderer/model.ts`
- `apps/desktop/src/renderer/views/view-structure.test.ts`
- `apps/desktop/src/renderer/styles.css`

### 验收

- 没有 preview 时不会出现可勾选确认。
- 每个 required confirmation 都能对应计划证据。
- 计划过期或漂移时，部署按钮禁用并显示原因。
- 部署成功后清楚说明 rollback 记录可在 History 查看。

## Phase 5：历史证据和恢复入口

### 目标

让 History 支持审计和恢复决策。

### 范围

- 顶部 Recovery status summary。
- 历史列表增加 verification、snapshot、rollback status。
- 详情页顶部增加 recovery summary。
- Rollback preview 和 blockers 在详情内展示。
- Snapshot failed/missing 与 deployment failed 区分。

### 主要文件

- `apps/desktop/src/renderer/views/history.tsx`
- `apps/desktop/src/renderer/model.ts`
- `apps/desktop/src/renderer/views/view-structure.test.ts`
- `apps/desktop/src/renderer/styles.css`

### 验收

- 用户不用打开 diff 就知道记录是否可回滚。
- 恢复锁存在时 History 给出推荐操作。
- Snapshot 状态不会误导文件写入状态。
- 回滚按钮只在可验证记录存在时可用。

## Phase 6：设置页扩展和最终 UX QA

### 目标

整理设置页，补齐全局状态、可访问性和响应式 QA。

### 范围

- Settings 按 Appearance、Language、Recovery、Diagnostics 分区。
- readOnlyRecovery 和 requiresRestart 以稳定文案展示。
- 全站 keyboard focus、modal focus trap、live region QA。
- 窄窗口布局检查。
- README 截图可在 UI 稳定后更新。

### 主要文件

- `apps/desktop/src/renderer/views/settings.tsx`
- `apps/desktop/src/renderer/views/view-structure.test.ts`
- `apps/desktop/src/renderer/styles.css`
- `tests/e2e/desktop.spec.ts`
- `docs/readme/assets/*.png`

### 验收

- 主题和语言设置保留。
- 只读恢复状态可解释。
- 所有主路径在窄窗口无文本重叠。
- E2E 主路径和 renderer view tests 通过。

## 测试矩阵

| 范围 | 测试 |
| --- | --- |
| AppShell | 项目选择、手动路径 fallback、全局状态、导航徽标 |
| Overview | 首次启动、扫描中、扫描完成、扫描失败、当前计划 |
| Assets | 筛选、排序、详情 tabs、诊断定位、disabled assets |
| Migration | blocker、preview request、field loss、hash snapshot、unsupported |
| Deployment | 无计划、确认项、过期、漂移、部署进度、完成 |
| History | 空态、列表、详情、snapshot、rollback eligibility、recovery lock |
| Settings | theme、language、saving/error、read-only recovery |
| E2E | 选择项目、扫描、检查资产、迁移预览、部署、历史、回滚 |

## 风险和缓解

| 风险 | 缓解 |
| --- | --- |
| UI 重构破坏 E2E selector | 优先使用 accessible role/name，更新测试时保留用户可见语义 |
| 状态模型过度扩展 | 先从现有 `AppState` 派生展示状态，只有重复逻辑稳定后再抽 helper |
| 计划证据字段不足 | 缺字段时展示可用证据，不伪造；必要时提出 API 增量需求 |
| 详情 tabs 增加复杂度 | tabs 只改变展示层，不改变资产详情和 effective 请求 |
| 视觉翻新掩盖安全信息 | 每次迭代验收都包含安全文案、阻断原因和确认证据 |

## 完成定义

桌面 UX 重设计实现完成需要同时满足：

- 本目录的屏幕规格和状态规范已在 UI 中落实或明确标记为后续 API 依赖。
- 当前 E2E 主流程通过。
- Renderer view/model tests 覆盖新增状态。
- 无项目、无扫描、扫描失败、部分转换、部署阻断、部署完成、历史空态和回滚不可用状态都有可见文案。
- README 预览截图在 UI 稳定后更新，避免公开文档展示旧体验。
