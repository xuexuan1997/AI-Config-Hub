# 桌面端 UX 重设计

## 文档状态

| 项目 | 内容 |
| --- | --- |
| 状态 | UX 重设计方案 |
| 适用范围 | `apps/desktop` Electron + React 桌面端 |
| 依据 | 当前 renderer 代码、PRD、桌面端设计审计截图、Electron E2E 主流程 |
| 不包含 | 核心领域模型重写、IPC 契约重写、云端协作、在线市场 |

本目录重新设计 AI Config Hub 桌面端体验。目标不是改变产品能力边界，也不只是补充组件规范，而是把当前已经存在的扫描、资产、诊断、生效解释、迁移预览、部署确认、历史证据和回滚能力，重新组织成一个连续、可理解、可审批的桌面工作台。

## 重设计目标

1. 让用户在首次打开时清楚知道先选择项目、再扫描、再处理诊断和迁移。
2. 把资产扫描结果从“库存表”升级为“可处理的配置健康工作台”。
3. 把迁移、部署和回滚串成连续的计划生命周期，避免用户在多个页面间丢失上下文。
4. 保留只读扫描、计划预览、显式确认、备份、验证和回滚等安全约束。
5. 为后续 UI 实现提供可验收的屏幕规格、组件规范、状态文案和测试点。

## 文档地图

| 文档 | 主要内容 | 读者 |
| --- | --- | --- |
| [00 功能驱动 UX 重设计蓝图](00-functional-redesign-blueprint.md) | 基于当前功能重新设计目标产品体验、屏幕结构和主流程 | 产品、设计、桌面工程 |
| [01 UX 策略](01-ux-strategy.md) | 用户、当前问题、目标信息架构、关键体验原则 | 产品、设计、桌面工程 |
| [02 工作流与屏幕规格](02-workflows-and-screen-specs.md) | 首次启动、扫描、资产、迁移、部署、历史、设置的详细交互 | 设计、前端、测试 |
| [03 组件、状态与内容规范](03-components-states-and-content.md) | 布局、导航、表格、详情、确认、diff、状态和可访问性 | 前端、设计、测试 |
| [04 落地路线图](04-implementation-roadmap.md) | 迭代拆分、验收标准、测试覆盖和风险 | 工程负责人、测试 |

## 证据来源

当前体验依据以下版本化材料评估：

- `apps/desktop/src/renderer/components/app-shell.tsx`：桌面端导航、项目选择和全局状态区域。
- `apps/desktop/src/renderer/views/*.tsx`：Overview、Assets、Migration、Deployment、History、Settings 的当前页面结构。
- `apps/desktop/src/renderer/model.ts`：扫描、资产详情、迁移预览、部署确认、回滚和设置状态。
- `tests/e2e/desktop.spec.ts`：端到端主路径，包括选择项目、扫描、检查资产、迁移预览、部署、历史和回滚。
- `docs/design-audit/desktop-app-current/screenshots/`：当前基线截图。
- `docs/design-audit/desktop-app-iteration-1/screenshots/`、`iteration-2`、`iteration-3`：已修复问题和仍可改进区域。
- `docs/PRD.md` 第 8 节产品设计原则：核心引擎与界面解耦、读取优先、诊断可解释、不执行第三方配置。
- `docs/superpowers/specs/2026-06-22-linux-appimage-full-manager-design.md`：桌面端工作区、事务式部署和回滚能力边界。

## 设计方向摘要

桌面端应从“六个并列功能页”调整为“本地配置治理工作台”。重设计后的主线不是让用户记住页面，而是让用户沿着计划生命周期做决策：

```text
Project context
-> Scan and health
-> Asset triage
-> Explain effective config
-> Build migration plan
-> Approve and deploy
-> Verify, history, rollback
```

新的体验保留左侧主导航，但把顶部项目区、扫描状态、当前计划和恢复状态做成贯穿全局的上下文层。每个页面都围绕现有功能回答一个明确问题：

| 区域 | 用户问题 |
| --- | --- |
| Overview | 这个项目现在是否安全、完整、可迁移？ |
| Assets | 有哪些配置资产，哪些需要处理，为什么？ |
| Explain | 某个目录最终生效哪些配置，谁贡献或覆盖了它？ |
| Migration | 我要把哪些资产迁移到哪里，会损失什么，会改哪些文件？ |
| Deployment | 这个计划是否仍然新鲜，确认了哪些风险，写入是否可验证？ |
| History | 过去改了什么，证据在哪里，现在能否安全回滚？ |
| Settings | 本地数据、备份、主题、语言和恢复模式如何控制？ |

## 设计验收标准

重设计实现后，桌面端至少满足以下 UX 验收：

- 首次启动空状态在一个视图中解释项目选择、扫描范围和只读安全承诺。
- 扫描完成后不显示内部 task ID 作为主要文案，而显示面向用户的摘要和下一步。
- 资产页支持按严重程度、工具、资源类型、作用域和状态筛选，并保留诊断优先级。
- 资产详情先展示人类可读摘要，再展示 source、normalized、effective、diagnostics 和 raw data。
- 迁移页明确分为来源选择、目标设置、兼容性、计划 diff 和确认要求。
- 部署页展示当前 plan hash、过期时间、漂移状态、备份/验证承诺和每项确认的来源证据。
- 历史页能快速回答“改了什么、是否验证、是否有快照、是否能回滚”。
- 错误、部分成功、权限不足、恢复锁、只读恢复和空状态都有稳定文案和操作建议。
- 桌面 E2E 主路径继续覆盖选择项目、扫描、检查资产、迁移预览、部署、历史和回滚。
