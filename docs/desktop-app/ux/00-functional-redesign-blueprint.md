# 00 功能驱动 UX 重设计蓝图

## 设计立场

这份蓝图不是组件规范，也不是实现 checklist。它描述 AI Config Hub 桌面端在现有功能基础上应该变成什么样的产品体验。

当前桌面端已经拥有核心能力：

- 选择项目目录，支持系统选择器和手动路径 fallback。
- 启动只读扫描，并展示扫描任务结果。
- 展示资产列表、资源类型分组、诊断计数、资产详情、源文件、normalized 内容、生效配置、诊断定位。
- 配置迁移目标工具、目标项目、冲突策略和来源资产。
- 生成迁移预览，展示兼容性、字段损失、source drift、hash snapshot、文件级 diff 和 required confirmations。
- 在部署页确认写入和 required confirmations，执行部署或回滚。
- 查看历史记录、部署详情、plan hash、确认项、变更 diff 和 snapshot 状态。
- 管理主题、语言、设置 revision、只读恢复和 restart 状态。

问题不在于“缺少页面”，而在于这些能力现在以功能页散放。重设计目标是把它们组织为一个连续的本地配置治理流程：

```text
选择项目
-> 扫描并判断健康
-> 分诊资产和诊断
-> 解释生效配置
-> 构建迁移计划
-> 用证据审批部署
-> 验证、审计和恢复
```

## 产品体验总图

### 新的信息架构

保留左侧主导航，但改变每个页面承担的问题：

| 导航 | 目标问题 | 当前功能如何迁入 |
| --- | --- | --- |
| Overview | 这个项目现在处于什么状态，下一步是什么？ | 项目选择、扫描、资产/诊断/历史摘要、active task、当前计划摘要 |
| Assets | 哪些配置资产需要处理，为什么？ | 资产列表、诊断计数、Inspect、Open source、Enable/Disable、Rescan after edit、Locate diagnostic |
| Explain | 当前目录最终生效了什么配置？ | 现有 `effective.resolve` 从资产详情能力提升为可发现的解释模式 |
| Migration | 我要把哪些资产迁移到哪里，会改什么？ | 目标工具、目标项目、冲突策略、来源选择、preview、field loss、drift、hash、diff |
| Deployment | 这个计划能否安全写入？ | required confirmations、部署 blocker、active deployment task、rollback availability |
| History | 过去写入了什么，现在能否恢复？ | history list/detail、plan hash、changes diff、snapshot、rollback |
| Settings | 本地偏好和恢复模式如何控制？ | theme、language、revision、requires restart、readOnlyRecovery |

`Explain` 可以先不作为独立 route 实现，但在 UX 上应成为用户可见的一等模式：从 Assets 和 Overview 进入，解释贡献、覆盖、忽略和诊断。

### 全局工作台层

每个页面顶部都应共享一层“工作台上下文”，用户无需切页也能知道当前状态。

| 区块 | 展示内容 | 目标行为 |
| --- | --- | --- |
| Project | 项目路径、选择目录、手动路径 fallback | 项目是所有扫描、迁移和部署的上下文 |
| Scan | idle/queued/running/complete/error、资产数、诊断数 | 用户知道数据是否新鲜 |
| Plan | 无计划、预览完成、需确认、已过期、漂移、可部署 | 迁移和部署不会断开 |
| Recovery | 无恢复风险、rollback available、recovery lock、read-only recovery | 恢复状态始终可见 |

当前 topbar 的项目选择能力保留，但要从“顶部表单”变成“全局上下文卡”。手动路径输入不应长期占据主视觉，只在需要时展开。

## 主体验 1：首次启动和项目扫描

### 当前功能

用户可以点击 `Browse folder` 或输入手动路径，然后点击 Overview 的 `Start scan`。当前问题是项目选择和扫描按钮视觉上分离，用户需要自己推断下一步。

### 重设计结果

首次启动时，Overview 变成一个明确的开始面板：

| 区域 | 设计 |
| --- | --- |
| 标题 | `Start with a project folder` |
| 说明 | `AI Config Hub scans local AI tool configuration in read-only mode first.` |
| 主操作 | `Choose project folder` |
| 次操作 | `Enter path manually` |
| 安全承诺 | `Read-only scan`、`No scripts executed`、`Writes require preview and confirmation` |
| 下一步预告 | `After scanning, you can inspect assets, preview migration, and deploy with rollback evidence.` |

选择项目后，同一面板切换为：

| 区域 | 设计 |
| --- | --- |
| Project | 完整路径摘要、复制路径、Change folder |
| Scan scope | 将扫描 Rules、Agents、Skills、MCP |
| 主操作 | `Start read-only scan` |
| 辅助说明 | `Scanning will not write files or execute configuration commands.` |

扫描中：

- 显示 task phase：Discovering、Reading、Parsing、Validating。
- 显示 progress：已完成数/总数；总数未知时显示已处理项。
- 不把 task id 放在主文案。

扫描完成：

```text
Scan complete
3 assets indexed. 1 error and 1 warning need review.
```

下方给出明确下一步：

- `Review errors`：跳到 Assets 且筛选 error。
- `Inspect assets`：跳到 Assets 全部。
- `Build migration plan`：有可迁移资产且无 error 时出现。

### 关键交互

- 文件选择器失败时，自动展开手动路径输入，并显示原因。
- 用户输入空路径时，不显示 toast，而在输入旁显示 inline error。
- 扫描完成后 Overview 自动刷新资产、诊断和历史摘要。
- 如果扫描失败但已有旧结果，显示“旧结果仍可查看，但不是最新”。

### 验收

- 用户第一次打开时能在一个屏幕内理解产品做什么和下一步。
- 无项目时不出现孤立的 `Start scan`。
- 扫描完成主文案没有内部 task id。

## 主体验 2：Overview 变成项目健康中心

### 当前功能

Overview 显示 Scan、Assets、History 三张卡和 Start scan 按钮。它没有解释健康状态，也没有推荐下一步。

### 重设计结果

Overview 由四个区域组成：

1. Health summary
2. Recommended action
3. Current plan
4. Recent activity

### Health summary

用当前 `assets`、`diagnosticCounts`、`history`、`scanStatus` 派生：

| 指标 | 说明 |
| --- | --- |
| Assets indexed | 当前项目索引到的资产数 |
| Blocking issues | error 诊断数 |
| Warnings | warning 诊断数 |
| Migration-ready | enabled 且可进入迁移的资产数 |
| Last deployment | 最新成功或失败记录 |

### Recommended action

推荐逻辑：

| 条件 | 推荐 |
| --- | --- |
| 无项目 | `Choose a project folder` |
| 有项目但未扫描 | `Start read-only scan` |
| scan error | `Review scan failure` + `Retry scan` |
| error > 0 | `Review blocking diagnostics` |
| warning > 0 | `Review warnings before migration` |
| assets > 0 且无 error | `Build migration plan` |
| preview 存在且未确认 | `Review deployment confirmations` |
| recoveryLock | `Review recovery in History` |

### Current plan

如果存在 preview，Overview 显示计划卡：

- target tool
- target project
- source asset count
- operation count
- compatibility
- required confirmations
- expiresAt
- drift status

操作：

- `Open migration preview`
- `Review deployment`
- `Refresh preview`，仅当过期或 drift。

### Recent activity

展示最近 3 条历史记录：

- kind：Deployment/Rollback
- status
- createdAt
- snapshot status
- `View evidence`

这里不展示完整 diff，避免 Overview 变成历史详情页。

## 主体验 3：Assets 变成资产分诊工作台

### 当前功能

资产页按 resource type 分组，展示 logical key、tool、resource、diagnostics 和 Inspect。资产详情中有 Open source、Disable/Enable、Rescan after edit、Load effective、source、redactions、normalized、effective、diagnostics。

### 重设计结果

Assets 页面从“资源列表”变成“分诊工作台”：

| 区域 | 设计 |
| --- | --- |
| Toolbar | Search、Tool、Resource type、Scope、Severity、Status |
| Triage queue | Errors、Warnings、Disabled、Ready、Selected for plan |
| Asset table | 按优先级排序的资产列表 |
| Inspector | 右侧详情面板或 modal |
| Diagnostic queue | 当前筛选范围内的诊断列表 |

### 资产表格重设计

列：

| 列 | 内容 |
| --- | --- |
| Priority | Error、Warning、Info、Ready、Disabled |
| Asset | logical key + path hint |
| Tool / Type | toolKey + resourceType |
| Scope | user/project/directory |
| Diagnostics | error/warning/info count |
| Status | enabled/disabled |
| Actions | Inspect、Add to migration、Open source |

默认排序不再按当前输入顺序，而是：

1. error assets
2. warning assets
3. disabled assets
4. selected for plan
5. resource type
6. logical key

### Inspector 重设计

资产详情不再以 raw normalized 为中心，而是分成五个 tab：

| Tab | 内容 | 当前功能来源 |
| --- | --- | --- |
| Summary | 工具、类型、作用域、状态、主要诊断、主要操作 | `assetDetail.asset`、diagnostics |
| Source | pathDisplay、contentHash、observedAt、redactions | `assetDetail.source`、redactions |
| Effective | contributors、ignored assets、effective diagnostics | `effective.resolve` |
| Diagnostics | 诊断、位置、建议、Locate | `diagnostics.list` |
| Raw | normalized JSON、技术 ID、hash | 当前 pre/json 内容 |

默认打开 Summary。Raw 只为调试和审计服务。

### 资产到迁移的交互

当前 Migration 可以勾选来源资产，但 Assets 没有清晰的“加入迁移计划”。重设计后：

- 每行有 `Add to migration`。
- Inspector Summary 有 `Use as migration source`。
- 加入后行上显示 `In plan`。
- 如果用户加入不同 resource type 的资产，立即提示：`Migration plans can include one resource type at a time.`，并提供 `Replace current plan sources` 或 `Keep current plan`。

### 诊断处理

诊断列表按影响组织：

- Blocking migration
- Affects effective config
- Informational

每条诊断展示：

- human title
- message
- affected asset
- file location
- suggested action
- `Locate`
- `Open source`
- `Rescan after edit`

### 验收

- 用户能从 error 摘要进入过滤后的资产列表。
- 用户能从资产行直接发起迁移来源选择。
- 用户能先看 Summary，再按需查看 Raw。

## 主体验 4：Explain 成为可发现的生效配置解释模式

### 当前功能

`Load effective` 在资产详情内存在，但发现性弱。它展示 contributors、ignored assets 和 effective diagnostics。

### 重设计结果

Explain 是 Assets 内的一等模式，可以先以 tab 或 drawer 实现，不必须新增 route。

入口：

- Overview：`Explain current project config`
- Assets toolbar：`Explain scope`
- Asset Inspector：`View effective config`
- Diagnostic：`Explain why this is ignored`

Explain 页面/面板回答：

| 问题 | 展示 |
| --- | --- |
| 最终生效什么？ | effective rules/agents/skills/mcp 摘要 |
| 谁贡献了？ | contributors 列表，按优先级 |
| 谁被忽略了？ | ignored assets + reason |
| 有什么风险？ | effective diagnostics |
| 如何处理？ | open source、rescan、add contributor to migration |

### 交互

- 用户可以选择 scope：当前项目、子目录、资产所在目录。
- 点击 contributor 跳到资产详情。
- 点击 ignored asset 跳到其诊断。
- 对诊断提供 `Open source` 和 `Rescan after edit`。

### 设计重点

不要只显示 JSON。Explain 要用自然语言表达：

```text
rule:AGENTS contributes because it is inherited from the project scope.
rule:.cursor/rules/agents.mdc is ignored because it conflicts with a higher-priority rule.
```

## 主体验 5：Migration 变成迁移计划构建器

### 当前功能

Migration 已有目标工具、目标项目、冲突策略、来源资产勾选、preview、blockers、field loss、source drift、hash snapshot、changes diff。

### 重设计结果

把当前单页表单重组为“计划构建器”，并把 preview 作为计划对象展示。

页面分为两列：

| 左列：Build plan | 右列：Plan evidence |
| --- | --- |
| Source assets | Plan summary |
| Target tool | Compatibility |
| Target project folder | Field loss |
| Existing target files | Source/target drift |
| Preview migration | Operations and diff |

### 左列：Build plan

Step 1 Source assets：

- 默认接收 Assets 中加入计划的资产。
- 支持搜索和筛选。
- 只允许同 resource type，一旦混选就阻断 preview。
- disabled assets 可见但不可默认选入。

Step 2 Target：

- Target tool 使用现有四个选项。
- Target project 默认当前项目。
- 用户显式修改后，切换源项目不覆盖目标项目。

Step 3 Conflict policy：

把 `replace/fail/merge` 转成用户语言：

| policy | UI 文案 | 风险说明 |
| --- | --- | --- |
| replace | Replace existing target files | Requires overwrite confirmation |
| fail | Stop if target exists | Safest, may block deployment |
| merge | Merge when supported | Only available when adapter can merge |

### 右列：Plan evidence

没有 preview 时，右列显示空态：

```text
No plan preview yet
Choose source assets and a target, then preview the exact file changes.
```

有 preview 时，显示：

1. Plan summary
   - plan hash short
   - compatibility
   - source asset count
   - operation count
   - required confirmations
   - expiresAt
2. Compatibility
   - Full：可部署
   - Partial：可部署但需要字段损失确认
   - Unsupported：不可部署
3. Field loss
   - dropped
   - retained
   - transformed
   - warning reason
4. Drift
   - current/changed/missing
   - expected/current hash
5. Operations
   - create/replace/delete
   - target path
   - before/after hash
   - diff

### 从 Migration 到 Deployment

生成 preview 后出现主 CTA：

```text
Review deployment
```

同时全局 Plan chip 显示：

```text
Plan ready: Cursor, 1 replace, partial, expires 13:30 UTC
```

如果 preview 有 required confirmations，Deployment 导航显示 `Needs approval`。

### 验收

- 用户在 Migration 就能理解“为什么部署页要我确认”。
- Preview 不是普通结果面板，而是可以进入审批的 plan。
- Drift 或过期会阻断进入部署执行态。

## 主体验 6：Deployment 变成证据驱动的审批控制台

### 当前功能

Deployment 显示部署说明、active task、总确认、required confirmations、Execute deployment、blocker、Execute rollback。

### 当前问题

确认项和 plan 证据分离。用户看见 checkbox，但不一定能看到它确认的是哪个文件、哪个字段损失或哪个风险。

### 重设计结果

Deployment 页面分为：

1. Plan being approved
2. Safety checks
3. Required confirmations
4. Deploy action
5. Execution progress
6. Rollback availability

### Plan being approved

页面顶部复述当前 preview：

- target tool
- target project
- source assets
- operations
- affected files
- compatibility
- plan hash
- expiresAt

如果没有 preview：

```text
No deployable plan
Create a migration preview before writing files.
```

CTA：`Build migration plan`

### Safety checks

展示部署前必须成立的条件：

| 检查 | 来源 |
| --- | --- |
| Plan exists | `state.preview` |
| Plan not expired | `preview.expiresAt` |
| Source unchanged | drift rows |
| Target unchanged | target hash snapshot |
| Required confirmations complete | `deploymentConfirmationGrants` |
| General write confirmation complete | `deploymentConfirmed` |

这些检查以 checklist 状态展示，但不可被用户手动勾选，避免和确认项混淆。

### Required confirmations

每个 required confirmation 变成证据卡：

Overwrite：

```text
Overwrite existing target files
1 target file will be replaced.
.cursor/rules/agents.mdc
View diff
```

Partial conversion：

```text
Deploy a partial conversion
activationHints will be dropped because Cursor rules cannot represent it.
View field loss
```

总确认：

```text
I reviewed the preview and understand AI Config Hub will write verified config files.
```

### Deploy action

按钮文案随操作数变化：

- `Deploy 1 change`
- `Deploy 3 changes`
- `Deployment blocked`
- `Deploying...`

按钮旁永远显示第一条 blocker。

### Execution progress

当前 active task 显示阶段：

- Preflight
- Backing up
- Writing
- Verifying
- Completed

成功后：

```text
Deployment verified
1 change was written, verified, and recorded. Rollback evidence is available in History.
```

部分成功或失败：

- 显示 recovery lock。
- 主 CTA 变成 `Review recovery in History`。
- 不允许用户继续执行新部署。

### Rollback availability

Deployment 页不直接承担完整恢复决策。它只显示最新可回滚摘要：

- latest deployment record
- affected files
- status
- `Review rollback evidence`

完整 rollback preview 和证据在 History 里完成。

## 主体验 7：History 变成证据与恢复中心

### 当前功能

History 显示记录列表、详情、plan id、plan hash、required confirmations、changes 和 diff。

### 重设计结果

History 不只是日志，而是“证据与恢复中心”。

页面结构：

| 区域 | 内容 |
| --- | --- |
| Recovery status | healthy、rollback available、recovery lock、snapshot issue |
| Filters | status、kind、snapshot、rollback availability |
| Record list | deployment/rollback 记录 |
| Evidence detail | plan、confirmations、changes、diff、snapshot |
| Rollback panel | eligibility、blockers、preview、execute |

### 记录列表

每条记录展示：

- kind
- status
- createdAt/finishedAt
- operation count
- verification status
- snapshot status
- rollback eligibility

不要在列表展示完整 hash。hash 进入详情。

### 详情页

顶部先回答：

```text
This deployment succeeded and can be rolled back.
1 file was replaced and verified.
Snapshot abcdef123456 was recorded.
```

然后展示：

- record id
- plan hash
- confirmations
- affected files
- before/after hash
- diff
- snapshot metadata

### Rollback panel

可回滚时：

- 显示将恢复哪些文件。
- 显示备份/hash 验证。
- 需要用户确认。
- CTA：`Rollback this deployment`

不可回滚时：

- 显示 blocker：
  - no succeeded deployment
  - backup missing
  - target drifted
  - recovery lock from another record
  - already rolled back

### Snapshot 状态

要清楚区分：

- 文件部署成功，但 snapshot 失败。
- 文件部署失败。
- snapshot missing。

Snapshot 问题不应被误读为配置写入失败。

## 主体验 8：Settings 变成本地偏好与恢复说明

### 当前功能

Settings 有 Theme、Language、Reload、revision、restart required、recovery mode。

### 重设计结果

Settings 不扩展成复杂控制台，但要分组：

| 分组 | 当前支持 | 未来扩展 |
| --- | --- | --- |
| Appearance | theme | density |
| Language | language | locale details |
| App state | revision、status、requiresRestart | settings sync status |
| Recovery | readOnlyRecovery | recovery details link |
| Diagnostics | reload | export diagnostics |

只读恢复时：

```text
Settings are read-only while recovery mode is active.
Review History to resolve the recovery state before changing settings.
```

Settings 的目标是解释偏好和状态，不承接迁移、部署或恢复主流程。

## 目标界面优先级

### 第一优先级：主流程连续

必须先保证：

- Overview 能引导选择项目和扫描。
- Assets 能处理诊断和选入迁移。
- Migration 能生成 plan。
- Deployment 能审批当前 plan。
- History 能证明和恢复。

### 第二优先级：信息分层

每个页面都遵循：

```text
Decision summary
-> Evidence
-> Raw technical detail
```

当前 raw JSON、hash、task id、plan id 都不删除，但从默认主视觉下移到证据或技术详情区域。

### 第三优先级：视觉 polish

视觉更新服务于功能重组：

- 保留专业、深色、工具型气质。
- 减少大卡片堆叠。
- 表格和详情更紧凑。
- 风险状态更可见。
- 确认和证据绑定。

## 与当前功能的映射清单

| 当前功能 | 目标 UX 位置 | 变化 |
| --- | --- | --- |
| `selectProjectRoot` | Overview + global context | 从顶栏表单变成项目上下文 |
| manual path | Project fallback drawer | 默认收起，错误时展开 |
| `scan.start` | Overview health action | 显示只读承诺和任务阶段 |
| `assets.list` | Assets table | 增加筛选、排序、优先级 |
| `assets.get` | Asset inspector | Summary-first，Raw 后置 |
| `effective.resolve` | Explain mode | 从详情按钮提升为解释能力 |
| `diagnostics.list` | Assets diagnostic queue | 按影响分组，能定位和处理 |
| `assets.openSource` | Asset inspector / diagnostics | 作为处理动作，不是隐藏能力 |
| `assets.disable/enable` | Asset row + inspector | 状态可见，影响迁移选择 |
| `migration.preview` | Migration plan builder | preview 成为 plan evidence |
| `requiredConfirmations` | Deployment evidence cards | 确认项绑定字段损失和文件 diff |
| `deployment.execute` | Deployment approval console | 只有安全检查通过才可执行 |
| `deployment.rollback` | History recovery panel | Deployment 只放快捷入口 |
| `history.list/get` | History evidence center | 列表看恢复资格，详情看证据 |
| `settings.get/update` | Settings grouped panels | 按偏好/状态/恢复分组 |

## 产品验收故事

### 故事 1：新用户扫描项目

用户打开桌面端，看见“选择项目目录”和只读扫描说明。选择项目后点击 `Start read-only scan`。扫描完成后，Overview 告诉他索引到 3 个资产，有 1 个错误和 1 个警告，并推荐去 Assets 处理错误。

### 故事 2：用户处理诊断

用户进入 Assets，默认看到 error 在最上方。点击资产后，Inspector Summary 告诉他这个 Cursor rule 有冲突。Diagnostics tab 展示文件位置和建议。用户点击 `Open source` 修复后，点击 `Rescan after edit`，诊断消失。

### 故事 3：用户迁移 Codex rule 到 Cursor

用户在 Assets 把 `rule:AGENTS` 加入迁移计划，进入 Migration。目标工具选择 Cursor，冲突策略选择 Replace。预览生成后，右侧显示将替换 `.cursor/rules/agents.mdc`，兼容性为 Partial，`activationHints` 会丢失，并要求 overwrite 和 partial conversion 确认。

### 故事 4：用户审批部署

用户进入 Deployment。页面顶部复述当前 plan，安全检查显示 plan fresh、source unchanged、target unchanged。用户展开 overwrite 证据卡查看 diff，展开 partial conversion 证据卡查看字段损失，然后勾选确认并点击 `Deploy 1 change`。部署完成后页面显示已验证，并引导到 History 查看回滚证据。

### 故事 5：用户回滚

用户进入 History，最新部署显示 `Rollback available`。打开详情后，顶部摘要说明 1 个文件可恢复，snapshot 已记录。用户查看 inverse operation，确认后执行 rollback。完成后 History 显示一条 linked rollback 记录。

## 不做什么

- 不把桌面端改成向导式单一路径；高级用户仍能直接进入 Assets、Migration、History。
- 不弱化 required confirmations；确认项只会更有证据，不会减少。
- 不把 raw technical details 删除；只从默认主视觉下移。
- 不引入云同步、团队审批、在线市场或远程分享。
- 不让 renderer 获得新的文件系统、Git、SQLite 或 shell 权限。
