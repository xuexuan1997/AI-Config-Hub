# 03 组件、状态与内容规范

本文定义桌面 UX 重设计需要的组件、状态和文案规范。实现时应优先复用现有 React 结构和 API，不为了视觉重做而破坏 Electron 安全边界。

## 1. 视觉系统方向

当前界面以深色蓝黑为主。重设计可以保留暗色专业感，但需要减少单一深蓝层级造成的信息混在一起的问题。

### 颜色语义

| 语义 | 用途 |
| --- | --- |
| Surface | 应用背景、导航背景、面板背景 |
| Border | 分割线、表格线、输入边框 |
| Text strong | 标题、关键值 |
| Text default | 正文、表格主要内容 |
| Text muted | 辅助说明、路径次要部分 |
| Accent | 主操作、选中导航、当前步骤 |
| Success | 扫描完成、验证成功、可回滚 |
| Warning | 部分转换、计划过期、需要确认 |
| Danger | 错误诊断、恢复锁、漂移阻断 |
| Info | 只读承诺、扫描说明、普通诊断 |

不要仅靠颜色表达状态。每个状态同时使用标签、文案或图标。

### 圆角和密度

- 应用主面板、工具栏、表格容器：8px。
- 小按钮、标签、输入框：6px 到 8px。
- 大面积卡片只用于重复记录、详情面板和状态摘要，不把整个页面堆成卡片集合。
- 表格和工作台保持高信息密度，适合反复检查和比较。

### 字体和字号

- 页面标题：24px 到 30px。
- 面板标题：16px 到 18px。
- 表格正文：13px 到 14px。
- 辅助说明：12px 到 13px。
- 不使用随 viewport 宽度缩放的字体。
- 长路径、hash 和 logical key 必须支持换行、截断和复制。

## 2. 导航组件

### Sidebar

导航项：

- Overview
- Assets
- Migration
- Deployment
- History
- Settings

每个导航项可带状态徽标：

- Assets：error/warning count。
- Migration：draft/preview ready。
- Deployment：blocked/needs approval/deploying。
- History：new record/recovery lock。

规则：

- 当前 route 只使用一个 active 样式。
- 徽标不改变导航项高度，避免跳动。
- 键盘可 Tab 到所有导航项。

### Global context bar

组成：

- Project selector compact。
- Scan status chip。
- Current plan chip。
- Recovery chip。

Project selector 行为：

- 默认显示 `Project` label 和路径摘要。
- `Choose folder` 是主入口。
- 手动输入放在展开区。
- 选择项目后清除旧错误消息。

## 3. 操作按钮

### 按钮层级

| 层级 | 用途 |
| --- | --- |
| Primary | 当前页面主要动作：Start scan、Preview migration、Deploy changes |
| Secondary | 安全辅助动作：Refresh、Inspect、Review history |
| Destructive | 真实破坏性动作。当前部署不是 destructive 样式，因为它已通过确认约束；危险阻断用 danger 状态表达 |
| Ghost/Icon | 表格行内操作、复制、展开、关闭 |

### 禁用按钮

禁用按钮附近必须有 blocker 文案：

```text
Preview blocked: select source assets from one resource type.
```

不要只依赖 disabled 视觉状态。

## 4. 状态 Banner

### Banner 类型

| 类型 | 场景 |
| --- | --- |
| Info | 只读扫描说明、手动路径 fallback |
| Success | 扫描完成、部署验证完成、回滚完成 |
| Warning | 部分成功、部分转换、计划即将过期 |
| Danger | 错误、恢复锁、漂移阻断、权限不足 |

### 文案结构

```text
Title
Plain-language summary.
Suggested action.
Technical details (collapsed)
```

示例：

```text
Scan complete
3 assets indexed. 1 error and 1 warning need review.
Review diagnostics in Assets.
```

技术详情折叠中可以展示：

- task id
- error code
- correlation id
- raw message

## 5. 表格

### Asset table

表格要支持：

- sticky header。
- search。
- multi-filter。
- row selection。
- default priority sorting。
- keyboard row focus。

行内状态：

- error/warning/info badge。
- disabled badge。
- partial conversion badge。
- selected for plan badge。

操作：

- `Inspect`
- `Add to plan` 或 `Remove from plan`
- `Open source` 只在有权限且已 inspect 后可用。

### History table

重点列：

- record kind
- status
- affected files
- verification
- snapshot
- rollback
- created time

不要把所有 hash 直接放进列表。hash 进入详情。

## 6. Inspector 和 Detail

### 使用场景

- Asset detail。
- History record detail。
- Diagnostic detail。
- Plan operation detail。

### 布局

详情应采用：

```text
Header
  Title
  Status badges
  Key actions
Tabs
  Summary
  Evidence
  Raw
```

### Summary-first 规则

每个详情页面第一屏必须回答：

- 这个对象是什么？
- 现在是否有问题？
- 用户下一步能做什么？
- 是否会影响写入或回滚？

Raw JSON、完整 diff 和内部 ID 不应出现在默认第一屏顶部。

## 7. Diff Viewer

### 目标

让用户在部署前理解写入影响。

### 必备信息

- operation：create/replace/delete。
- path。
- before hash / after hash。
- required confirmation。
- compatibility note。
- diff body。

### 交互

- 文件级折叠。
- 长 diff 默认限定高度，可展开。
- 复制 diff。
- 高风险文件默认展开。
- 无 diff 的 create/delete 需要结构化说明。

### 空 diff

如果计划没有文本 diff，但仍有操作：

```text
No text diff is available for this operation.
AI Config Hub will still verify the target hash after writing.
```

## 8. Confirmation checklist

确认项不是普通 checkbox 列表，而是计划风险证据。

每项结构：

```text
Checkbox
Label
Evidence summary
Evidence link
```

确认项来源：

- `overwrite`
- `partial_conversion`
- 未来 adapter 定义的稳定确认类型。

总确认：

```text
I reviewed this plan and understand AI Config Hub will write verified config files.
```

禁用规则：

- 缺少任何必需确认时，部署按钮禁用。
- 计划过期、漂移、无 preview、unsupported 时，即使确认都勾选也禁用。

## 9. 状态模型

### Project

| 状态 | 文案 |
| --- | --- |
| none | `Choose a project folder to begin.` |
| selected | `Project ready for scan.` |
| invalid | `The selected path could not be scanned.` |
| chooser unavailable | `The system folder picker is unavailable. Paste the project folder path instead.` |

### Scan

| 状态 | 文案 |
| --- | --- |
| idle | `No scan has run yet.` |
| queued | `Scan queued.` |
| running | `Scanning local configuration files...` |
| complete | `Scan complete.` |
| partial | `Scan completed with issues.` |
| error | `Scan failed before results could be updated.` |

### Plan

| 状态 | 文案 |
| --- | --- |
| none | `No migration plan is ready.` |
| draft | `Source and target selections are incomplete.` |
| preview ready | `Plan preview is ready for review.` |
| needs confirmation | `Review required confirmations before deployment.` |
| ready | `Plan is ready to deploy.` |
| expired | `Plan expired. Refresh the preview before deploying.` |
| drifted | `Source or target files changed after preview.` |
| unsupported | `This migration cannot be deployed.` |

### Deployment

| 状态 | 文案 |
| --- | --- |
| blocked | `Deployment blocked.` |
| preflight | `Checking plan freshness and target paths.` |
| backing_up | `Creating backups before writing.` |
| writing | `Writing verified configuration files.` |
| verifying | `Rescanning and verifying results.` |
| completed | `Deployment verified.` |
| partially_succeeded | `Deployment partially completed. Recovery is required.` |
| failed | `Deployment failed before completion.` |

### Rollback

| 状态 | 文案 |
| --- | --- |
| unavailable | `No verified deployment is available to roll back.` |
| available | `Rollback is available for the latest verified deployment.` |
| blocked | `Rollback is blocked until recovery requirements are resolved.` |
| running | `Restoring backed up files.` |
| verified | `Rollback verified.` |

## 10. 文案规范

### 语气

- 准确、克制、可操作。
- 不使用恐吓式文案。
- 不隐藏风险。
- 不把内部实现术语放在主文案。

### 首选词

| 用 | 不用 |
| --- | --- |
| Project folder | Root unless in technical detail |
| Preview | Dry run in UI |
| Plan | Random task output |
| Verify | Check if files exist |
| Rollback | Restore previous files |
| Recovery lock | Unknown blocked state |

### 示例替换

| 当前可能文案 | 重设计文案 |
| --- | --- |
| `Task task:scan:audit succeeded: 1 succeeded.` | `Scan complete: 1 asset indexed.` |
| `No assets indexed yet.` | `No scan results yet. Start a read-only scan to index local configuration.` |
| `Execute deployment` | `Deploy 1 change` |
| `No succeeded deployment is available to roll back.` | `No verified deployment is available to roll back yet.` |

## 11. 可访问性

### 键盘

- Sidebar、toolbar、表格行、tabs、modal、diff 展开都可键盘操作。
- Modal 打开后 focus trap，关闭后回到触发按钮。
- 表格行操作按钮有明确 aria-label。

### 语义

- 页面主标题使用单个 `h1`。
- 面板标题使用层级正确的 `h2`/`h3`。
- 状态 badge 不只用颜色表达。
- 表单字段有 label，错误有 `aria-describedby`。

### 动态状态

- 扫描、部署、回滚进度使用 live region。
- 错误 banner 可被屏幕阅读器读取。
- 刷新后不要把用户滚动位置留在旧页面底部；当前路由切换已处理 scroll reset，应保留。

## 12. 响应式规则

桌面端优先，但仍需支持窄窗口和 E2E/mobile 截图检查。

### 宽屏

- Sidebar 固定。
- Global context bar 横向。
- Migration 使用左右双栏。
- Asset inspector 可右侧停靠。

### 中等宽度

- Global context bar 换行。
- Migration preview 移到 controls 下方。
- Inspector 变成 modal。

### 窄屏

- Sidebar 可折叠为顶部导航或 drawer。
- 表格转为 record list。
- 主 CTA 固定在页面内容顶部或底部，不遮挡内容。
- 长路径和 hash 必须换行。

## 13. 测试关注点

需要新增或调整测试覆盖：

- 首次启动引导文案和手动路径 fallback。
- Overview 扫描完成的用户文案，不出现内部 task ID 主文案。
- Assets 默认排序和筛选。
- Asset inspector 的 tab 顺序和 raw data 折叠。
- Migration 混合资源类型 blocker。
- Deployment 确认项与 required confirmations 绑定。
- Plan expired/drifted 禁用部署。
- History 回滚可用和不可用状态。
- Recovery lock 优先展示。
- Keyboard focus 和 modal close 行为。
