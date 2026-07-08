# 02 工作流与屏幕规格

本文定义桌面端重设计后的核心工作流和屏幕规格。实现时可以分阶段落地，但交互语义、状态文案和安全约束应保持一致。

## 1. 全局应用框架

### 目标

把项目、扫描、计划和恢复状态作为全局上下文，而不是散落在各页面。

### 布局

```text
Sidebar navigation
Main
  Global context bar
    Project selector
    Scan status
    Current plan status
    Recovery/read-only status
  Route workspace
```

### 全局上下文条

必备元素：

- Project：当前项目路径，支持系统选择器和手动路径。
- Scan：未扫描、扫描中、完成、部分完成、失败。
- Plan：无计划、草稿、已预览、需确认、可部署、已过期、漂移。
- Recovery：无、恢复锁、只读恢复、回滚可用。

交互规则：

- 项目路径较长时中间截断，但 hover/title 和复制按钮保留完整路径。
- 手动路径输入收进二级区域。只有文件选择器不可用、用户点击 `Enter path manually` 或错误提示建议时展开。
- 当前计划存在时，全局显示计划 hash 的短形式、目标工具、操作数和过期状态。
- 恢复锁存在时，全局条使用 warning/danger 状态，并提供 `Review recovery` CTA 到 History。

## 2. 首次启动与项目选择

### 用户目标

用户需要理解 AI Config Hub 会做什么、不会做什么，并选择一个项目开始只读扫描。

### 屏幕内容

标题：`Start with a project folder`

说明文案：

```text
AI Config Hub reads local AI tool configuration without running scripts or writing files.
Choose a project folder to scan Rules, Agents, Skills, and MCP configuration.
```

主要区域：

- `Choose folder` 主按钮。
- `Enter path manually` 次级按钮。
- 只读承诺列表：
  - `Scan is read-only.`
  - `No Skill, Hook, or MCP command is executed.`
  - `Writes require preview, confirmation, backup, and verification.`

### 状态

| 状态 | UI |
| --- | --- |
| 无项目 | 显示首次启动引导，禁用扫描以外的工作流入口 |
| 选择器可用 | 主按钮打开系统 folder picker |
| 选择器不可用 | 错误 banner 解释系统文件选择器不可用，并展开手动路径输入 |
| 手动路径为空 | inline validation：`Enter a project folder path first.` |
| 路径已选择 | 显示路径摘要和 `Start read-only scan` |

### 验收

- 无项目时不会出现“Start scan”孤立按钮。
- 文件选择器失败时不阻断用户，手动路径 fallback 可见。
- 首屏明确说明扫描只读和不执行第三方配置。

## 3. Overview：项目健康中心

### 用户目标

用户想知道项目是否已扫描、是否有问题、能否迁移、下一步该做什么。

### 屏幕结构

1. Project health summary
2. Recommended next action
3. Scan activity
4. Current plan card
5. Recent history

### Project health summary

指标卡：

- `Assets indexed`
- `Errors`
- `Warnings`
- `Ready to migrate`
- `Last verified deployment`

卡片规则：

- Error > 0 时，Overview 推荐 `Review errors in Assets`。
- Warning > 0 且 Error = 0 时，推荐 `Review warnings before migration`。
- Assets > 0 且无高风险时，推荐 `Build migration plan`。
- 有当前计划时，推荐 `Review deployment` 或 `Refresh preview`。

### Scan activity

扫描任务显示：

```text
Scanning project
Reading local configuration files...
12/48 files
```

完成时显示：

```text
Scan complete
3 assets indexed. 1 error and 1 warning need review.
```

技术详情折叠：

- task id
- started/finished time
- skipped files
- stable error code

### Current plan card

如果存在迁移预览：

- Source count
- Target tool
- Target project/scope
- Operations count
- Compatibility
- Required confirmations
- Plan freshness
- CTA：`Review deployment`

过期或漂移：

- 用 warning 状态。
- CTA 改为 `Refresh preview`。
- 禁用部署入口并解释原因。

### 验收

- Overview 不再只是状态数字，而是显示下一步。
- 内部 task ID 只出现在技术详情，不是主文案。
- 扫描完成后能直接进入 Assets 或 Migration。

## 4. Assets：资产分诊工作台

### 用户目标

用户需要找到配置资产、理解诊断、查看来源和生效结果，并决定哪些资产进入迁移。

### 页面结构

```text
Header: Assets
Toolbar: Search, Tool filter, Resource type filter, Severity filter, Scope filter, Status filter
Health queue: Errors, Warnings, Disabled, Partial conversions
Asset table
Inspector panel
```

### 表格列

| 列 | 内容 |
| --- | --- |
| Priority | error/warning/info/ready/disabled |
| Asset | logical key + resource type |
| Tool | claude-code/cursor/codex/opencode |
| Scope | user/project/directory + shortened path |
| Diagnostics | grouped severity count |
| Status | enabled/disabled |
| Last observed | observed timestamp or scan revision |
| Actions | Inspect, Add to plan |

默认排序：

1. error
2. warning
3. disabled
4. partial conversion warnings
5. resource type
6. logical key

### Inspector panel

资产详情使用右侧 panel 或大屏 modal，但内容按 tab 分层：

1. Summary
2. Source
3. Effective
4. Diagnostics
5. Raw

Summary：

- 资源名称、工具、类型、作用域。
- 当前是否 enabled。
- 可迁移状态。
- 主要诊断。
- CTA：`Open source`、`Rescan after edit`、`Add to migration plan`、`Disable/Enable`。

Source：

- pathDisplay
- content hash 短形式和复制入口
- observedAt
- redaction summary

Effective：

- contributors
- ignored assets
- effective diagnostics
- provenance explanation

Diagnostics：

- 每条诊断包括 severity、标题、说明、位置、影响、建议操作。
- `Locate` 不应是整行宽按钮；应为每条诊断的次级 action。

Raw：

- normalized JSON
- redacted raw payload
- 技术字段默认折叠。

### 空状态

未扫描：

```text
No scan results yet
Choose a project and start a read-only scan to index local AI tool configuration.
```

扫描完成无资产：

```text
No supported configuration assets found
AI Config Hub looked for Rules, Agents, Skills, and MCP configuration for the supported tools.
```

### 验收

- 用户能按 error 一键筛选。
- 用户能从资产详情理解“为什么有诊断”和“下一步做什么”。
- Raw JSON 不抢占默认视线。
- Disabled assets 仍可见，但默认不进入迁移计划。

## 5. Effective Explain：生效配置解释

当前 effective 能力在资产详情中出现。重设计后保留在 Assets 内作为解释模式，不必新增主导航项。

### 用户目标

用户想知道某个目录实际生效哪些规则、哪些资产被贡献或忽略。

### 入口

- Asset inspector 的 `View effective config`。
- Overview 的诊断推荐。
- Assets toolbar 中的 `Explain directory`。

### 结构

- Scope selector：当前项目、子目录或资产作用域。
- Effective summary：rules、agents、skills、mcp counts。
- Contributors：按优先级排序。
- Overrides/Ignored：说明被忽略原因。
- Diagnostics：只显示影响生效结果的诊断。

### 文案

贡献者：

```text
rule:AGENTS contributes because it is inherited from the project scope.
```

忽略：

```text
rule:.cursor/rules/agents.mdc is ignored because a higher-priority target conflict exists.
```

### 验收

- 生效解释不是 raw object dump。
- 每个 ignored asset 都有原因。
- 用户能从解释结果返回资产详情或加入迁移计划。

## 6. Migration：计划构建器

### 用户目标

用户选择来源资产和目标工具，确认兼容性、字段损失、目标文件和 diff，然后生成可部署计划。

### 页面结构

```text
Header: Build migration plan
Left: Step controls
  1 Source assets
  2 Target
  3 Conflict policy
  4 Preview action
Right: Plan preview
  Compatibility
  Field loss
  Target operations
  Diff
  Hash snapshot
  Required confirmations
```

### Step 1 Source assets

支持：

- 从 Assets 带入选中资产。
- 在 Migration 中筛选选择。
- 禁止混合不兼容资源类型时即时说明。

混合资源类型错误：

```text
Select source assets from one resource type.
Rules, Skills, Agents, and MCP configuration have different target formats.
```

### Step 2 Target

字段：

- Target tool
- Target project/scope
- Target path preview

规则：

- 默认目标项目为当前项目。
- 用户显式输入目标项目后，切换源项目不覆盖该显式值。
- 目标路径未知时显示 `Will be resolved during preview`。

### Step 3 Conflict policy

选项：

- Replace existing files
- Fail if target exists
- Merge when adapter supports it

每项附带风险说明：

- Replace：需要 overwrite 确认。
- Fail：最安全，但可能无法生成可部署计划。
- Merge：仅在 adapter 支持时可用，否则禁用并说明。

### Step 4 Preview

按钮：

- `Preview migration`
- 禁用时显示第一条 blocker。

生成后：

- 右侧 preview 自动聚焦。
- 全局 Current plan 更新。
- CTA：`Review deployment`。

### Plan preview

摘要：

```text
Plan ready
1 source asset -> Cursor project rules
1 replace operation, partial compatibility
Expires 2026-06-29 13:30 UTC
```

兼容性：

- Full：绿色，可部署。
- Partial：黄色，需要确认和字段损失说明。
- Unsupported：红色，不可部署，只能查看原因。

字段损失：

| 字段 | 状态 | 说明 |
| --- | --- | --- |
| activationHints | Dropped | Cursor rules cannot represent Codex activation hints. |
| frontmatter.description | Transformed | Stored as Cursor metadata description. |

目标操作：

- create/replace/delete
- target path
- before/after hash
- required confirmation badge

Diff：

- 文件级折叠。
- 默认展开第一个高风险改动。
- 长 diff 有最大高度和复制入口。

Hash snapshot：

- Source hashes
- Target hashes
- Plan hash
- ExpiresAt

### 验收

- 用户在 Migration 页面能理解计划为何需要 Deployment 确认。
- 生成 preview 后，目标操作、字段损失和 required confirmations 在同一屏可见。
- Unsupported preview 不能进入可部署状态。

## 7. Deployment：计划审批与执行控制台

### 用户目标

用户需要确认当前计划是否安全、新鲜、可写，并执行部署或查看阻断原因。

### 页面结构

```text
Header: Review and deploy
Plan summary
Freshness and drift
Required confirmations
Backup and verification promise
Primary action
Task progress
Rollback availability
```

### Plan summary

必显字段：

- target tool
- target project/scope
- operation count
- affected files
- compatibility
- plan hash short + copy
- expiresAt
- source/target drift status

如果没有计划：

```text
No migration plan is ready
Build a preview before deploying so AI Config Hub can show exact file changes.
```

CTA：`Build migration plan`

### Freshness and drift

状态：

- Fresh：可继续确认。
- Expired：禁用部署，CTA `Refresh preview`。
- Source changed：禁用部署，说明需要重新扫描或重新预览。
- Target changed：禁用部署，说明目标文件已变化。

### Required confirmations

每项确认以证据卡呈现：

```text
[ ] Overwrite existing target files
    1 target file will be replaced: .cursor/rules/agents.mdc
    View affected files
```

```text
[ ] Deploy a partial conversion with documented warnings
    activationHints will be dropped. Cursor cannot represent this field.
    View field loss
```

总确认：

```text
[ ] I reviewed the preview and understand AI Config Hub will write verified config files.
```

部署按钮文案：

- 可执行：`Deploy 1 change`
- 不可执行：`Deployment blocked`
- 进行中：`Deploying...`

### Task progress

阶段显示：

- Preflight
- Backing up
- Writing
- Verifying
- Completed

每个阶段展示 completed/total、当前文件、失败项和 retryable。

完成：

```text
Deployment verified
1 change written and verified. A rollback record is available in History.
```

部分成功：

```text
Deployment partially completed
Some changes were written, and recovery is required before new writes.
```

### Rollback

Deployment 页只显示最新成功部署的快速回滚摘要，不替代 History：

- Latest rollback candidate
- record id short
- affected files
- verification status
- CTA：`Review rollback in History`

直接 `Execute rollback` 需要有可验证记录；否则禁用并说明。

### 验收

- 没有计划时不能展示可勾选的空确认。
- 每个确认项能追溯到计划证据。
- 部署按钮禁用时，第一条 blocker 可见。
- 部署完成后明确指向 History 和 rollback。

## 8. History：证据与恢复

### 用户目标

用户需要审计过去部署，确认变更证据，判断是否能回滚。

### 页面结构

```text
Header: History and recovery
Recovery status summary
Filters
Record list
Record detail
Rollback preview/action
```

### Recovery status summary

状态：

- Healthy：无恢复锁。
- Rollback available：最近部署可回滚。
- Recovery lock active：必须先处理失败或部分成功记录。
- Snapshot issue：Git snapshot missing/failed，但文件部署记录仍可见。

### Record list

列：

- Kind
- Status
- Created/finished
- Operations
- Verification
- Snapshot
- Rollback status
- Actions

默认排序：最新在前。

### Record detail

顶部摘要：

- Deployment/Rollback
- status
- plan hash
- compatibility at deployment time
- confirmations granted
- verification result
- backup location if available

Changes：

- operation
- path
- before/after hash
- diff
- verification status

Snapshot：

- recorded/missing/failed
- commit id
- retry action if retryable

Rollback：

- eligible/not eligible
- blockers
- preview inverse operations
- required confirmations
- execute rollback

### 验收

- 用户不用读完整 diff 就知道某条记录是否可回滚。
- Snapshot 失败不会被误解成文件部署失败。
- 恢复锁状态优先展示，并指向可操作记录。

## 9. Settings：本地偏好与恢复设置

### 用户目标

用户需要管理主题、语言、本地数据位置、备份保留、Git 快照和恢复模式。

### 页面分区

1. Appearance
2. Language
3. Project and roots
4. Backups and retention
5. Local Git snapshots
6. Recovery mode
7. Diagnostics export

### 当前 MVP 可先落地

当前代码已有 theme 和 language。重设计可先重排为：

- Appearance：theme select。
- Language：language select。
- Status：revision、saving/error、requires restart、read-only recovery。
- Recovery：只读恢复说明。

后续扩展再加入备份、Git 和导出。

### 验收

- 设置页不混入迁移或部署主流程。
- 只读恢复状态在 Settings 可解释，但处理入口仍在 History/Recovery。
- 修改需要 restart 时明确提示。
