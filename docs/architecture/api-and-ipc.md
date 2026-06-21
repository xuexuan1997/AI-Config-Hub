# API、IPC 与 CLI 契约

| 项目 | 内容 |
| --- | --- |
| 目的 | 定义桌面端 IPC、共享业务用例和独立 CLI 的稳定调用、错误及长任务契约 |
| 目标读者 | Electron 主进程与 preload 开发者、React 开发者、CLI 开发者、核心模块开发者、测试工程师 |
| 状态 | MVP 技术基线 |
| 相关文档 | [架构总览](./overview.md) · [领域模型](./domain-model.md) · [适配器系统](./adapter-system.md) · [数据存储](./data-storage.md) · [安全架构](./security.md) · [ADR-0002：Electron 特权能力仅存在于主进程](../adr/0002-electron-security-boundary.md) · [已确认技术方案](../superpowers/specs/2026-06-21-technical-solution-design.md) |

## 1. 边界与设计规则

`packages/api` 定义命令名称、Zod Schema、共享 TypeScript 类型、主进程 handler 注册器和 renderer 客户端。Electron renderer 只能通过 preload 暴露的命名业务方法调用主进程；CLI 不经过 IPC，而是调用相同的核心用例并复用同一请求、响应和错误 Schema。

必须遵守以下规则：

1. IPC 只暴露业务级命令，不暴露 `readFile(path)`、`writeFile(path)`、`exec(command)`、`spawn(binary)`、SQLite 查询、任意 URL 请求或其他通用 `fs`/shell API。
2. preload 收到 renderer 参数时先用 Zod 校验；主进程 handler 在进入用例前再次校验。主进程响应在发送前校验，renderer 客户端接收后再校验，防止任一边界实现漂移。
3. 所有路径由业务对象或已授权 root 推导；renderer 不能通过字符串参数扩大允许根。需要选目录时使用受控系统选择器，其结果在主进程登记为授权 root。
4. 查询默认只读。`settings.update`、`deployment.execute` 和 `deployment.rollback` 是明确写入口；迁移预览本身不写文件。
5. 业务错误使用稳定错误码，不能让 Node.js 异常、SQLite 文本或绝对秘密路径穿过 IPC。
6. 命令、事件和 CLI JSON 都有独立版本。MVP 使用 `apiVersion: 1` 和 `schemaVersion: 1`。

## 2. 版本与兼容策略

命令在传输层命名为 `ai-config-hub:v1:<command>`，例如 `ai-config-hub:v1:scan.start`。调用请求包含 `apiVersion: 1`。同一主版本内允许新增可选字段和枚举值，但不得删除字段、改变既有字段含义或改变错误码语义。

破坏性变更发布新命令主版本，并在至少一个桌面应用发布周期内保留旧 handler。客户端遇到未知可选字段应忽略，遇到未知状态或事件类型应安全展示为 `unknown` 并保留原始 code；遇到不支持的主版本返回 `API_VERSION_UNSUPPORTED`，不得尝试降级写入。

CLI 人类可读输出不作为机器接口；`--json` 的 `schemaVersion` 遵循相同的主版本兼容约束。自动化调用方必须检查 `schemaVersion`、`ok` 和进程退出码。

## 3. 通用请求、响应与错误 envelope

```ts
type ApiRequest<T> = {
  apiVersion: 1;
  requestId: string;
  payload: T;
};

type ApiSuccess<T> = {
  apiVersion: 1;
  requestId: string;
  ok: true;
  data: T;
};

type ApiFailure = {
  apiVersion: 1;
  requestId: string;
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    action?: string;
    details?: Record<string, string | number | boolean | null>;
    correlationId: string;
    taskId?: string;
  };
};

type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
```

`details` 经过字段 allowlist 和脱敏，不含调用栈、SQL、秘密、完整配置正文或未缩略的用户路径。不可预期异常统一映射为 `INTERNAL_ERROR`，详细信息仅进入本地受控日志。

通用错误码：

| 错误码 | 含义 |
| --- | --- |
| `VALIDATION_FAILED` | 请求或响应不符合当前 Zod Schema |
| `API_VERSION_UNSUPPORTED` | 主版本不受支持 |
| `NOT_FOUND` | 业务实体不存在或调用者不可见 |
| `CONFLICT` | 修订号、任务或资源状态冲突 |
| `PATH_OUTSIDE_ALLOWED_ROOT` | 请求涉及未授权目录 |
| `PERMISSION_DENIED` | 操作系统权限或业务权限不足 |
| `READ_ONLY_RECOVERY` | 数据库迁移失败后处于只读恢复模式 |
| `STALE_INDEX` | 索引与磁盘哈希不一致 |
| `STALE_PREVIEW` | 预览后的源或目标发生变化 |
| `TASK_NOT_CANCELLABLE` | 任务已越过取消点 |
| `INTERNAL_ERROR` | 已脱敏的未知内部错误 |

## 4. 权限模型

MVP 是单用户本地应用，没有远程账号授权。这里的“权限”是能力与信任边界：

- renderer 只能调用 preload 明确列出的业务方法，不能选择任意 IPC channel。
- main process 负责路径允许根、符号链接、当前模式、确认令牌、哈希和并发锁校验，不能信任 renderer 已校验的结果。
- CLI 以启动它的操作系统用户身份运行，但仍执行相同 allowed roots、只读恢复和部署确认规则。
- 读取命令可在正常模式和有限的只读恢复模式运行；写命令仅在正常模式、目标可写且调用具备有效确认上下文时运行。
- 设置分为 `public` 与 `privileged`。MVP renderer 只能读写公开产品设置；路径登记、日志目录、备份根和安全策略由专门业务流程或 CLI 管理，不能经 `settings.update` 任意改写。

## 5. 长任务与事件协议

扫描、部署和回滚是长任务。接受请求只表示任务已排队，响应立即返回 `taskId`；最终结果通过状态查询和事件取得。

```ts
type TaskEvent = {
  apiVersion: 1;
  eventVersion: 1;
  taskId: string;
  sequence: number;
  emittedAt: string;
  type: "accepted" | "phase.changed" | "progress" | "item.failed" |
    "cancel.requested" | "completed";
  phase: string;
  progress: {
    completed: number;
    total: number | null;
    unit: "files" | "operations" | "items";
  };
  data: Record<string, unknown>;
};
```

### 5.1 顺序与重连

- 同一任务的 `sequence` 从 1 严格递增；`accepted` 必须是第一个事件，`completed` 必须是唯一终态事件。
- `phase.changed` 先于该 phase 的任何 `progress`；`item.failed` 不终止事件流。
- 传输可能重复，不应乱序。客户端按 `(taskId, sequence)` 去重；发现缺口时停止推进 UI 并重新同步。
- preload 暴露 `subscribeTask(taskId, afterSequence, listener)`，内部只订阅固定 `ai-config-hub:v1:task.event` channel。重连时，扫描调用 `scan.status`；部署或回滚调用带 `taskId` 的 `history.list` 取得活动任务快照；随后以返回的 `lastSequence` 订阅。
- 主进程持久化任务状态、计数、最终结果和有限事件尾部。若 `afterSequence` 早于保留范围，订阅先发送 `snapshot` 数据的 `phase.changed` 事件，再继续实时序列；最终状态永远可由 status 恢复。

### 5.2 phase 与进度

扫描 phase：`queued`、`discovering`、`reading`、`parsing`、`validating`、`committing`、`completed`。

部署 phase：`queued`、`preflight`、`backing_up`、`writing`、`verifying`、`rolling_back`、`completed`。

回滚 phase：`queued`、`preflight`、`restoring`、`verifying`、`completed`。

`total` 未知时为 `null`，发现完成后可从 `null` 变为确定值，但之后不得减小；`completed` 单调递增且不超过 `total`。事件不能包含秘密正文。

### 5.3 取消与部分成功

取消是请求，不是立即终止。扫描在候选文件之间、读取前、解析前和 `committing` 前检查取消信号；已经提交的旧索引不被破坏。部署仅在 `queued`、`preflight` 和 `backing_up` 的安全点允许取消。进入首个文件的原子 `writing` 阶段后不可取消，必须完成写入与验证，或失败后自动回滚。回滚进入 `restoring` 后也不可取消。

单个文件解析失败、单个不相关根无权限或部分资产不兼容可产生 `partial` 结果。最终数据必须同时给出 `succeededCount`、`failedCount`、`skippedCount` 和失败项的稳定诊断 ID。任何可能造成目标文件不一致的错误都不是部分成功：部署必须进入回滚或 `recovery_required`。

## 6. 命令目录

### 6.1 `scan.start`

| 项目 | 契约 |
| --- | --- |
| 用途 | 启动全量或增量只读扫描，更新可重建索引 |
| 请求 | `{ mode: "full" | "incremental", projectId?: string, toolKeys?: string[], roots?: AuthorizedRootId[], changedPaths?: RegisteredPathId[] }`；`incremental` 必须提供已登记路径或项目 |
| 响应 | `{ taskId: string, status: "queued", acceptedAt: string }` |
| 错误码 | `VALIDATION_FAILED`、`PATH_OUTSIDE_ALLOWED_ROOT`、`SCAN_ALREADY_RUNNING`、`READ_ONLY_RECOVERY`、`PERMISSION_DENIED` |
| 权限边界 | renderer 只能传主进程签发的 `AuthorizedRootId`/`RegisteredPathId`；main 重新解析到 canonical path；CLI 也受 allowed roots 限制 |
| 事件 | `accepted`；各扫描 phase 的 `phase.changed`/`progress`；逐项 `item.failed`；最终 `completed`，状态为 `succeeded`、`partial`、`cancelled` 或 `failed` |

### 6.2 `scan.status`

| 项目 | 契约 |
| --- | --- |
| 用途 | 获取扫描任务当前快照、计数和重连游标 |
| 请求 | `{ taskId: string }` |
| 响应 | `{ taskId, status, phase, progress, resultSummary?, lastSequence, cancellable, startedAt?, finishedAt? }` |
| 错误码 | `VALIDATION_FAILED`、`NOT_FOUND` |
| 权限边界 | 只读；只返回本应用创建的任务；路径和诊断证据按展示策略缩略/脱敏 |
| 事件 | 本命令不创建事件；响应用于恢复 `task.event` 订阅 |

### 6.3 `scan.cancel`

| 项目 | 契约 |
| --- | --- |
| 用途 | 请求扫描在下一个安全取消点停止 |
| 请求 | `{ taskId: string, reason?: "user" | "shutdown" }` |
| 响应 | `{ taskId, cancelRequested: true, effectiveAfterPhase: string }` |
| 错误码 | `VALIDATION_FAILED`、`NOT_FOUND`、`TASK_NOT_CANCELLABLE`、`CONFLICT` |
| 权限边界 | 只允许取消扫描任务；不能借此取消部署或另一实例持有的不可恢复工作 |
| 事件 | `cancel.requested`；到达安全点后最终 `completed(status="cancelled")` |

### 6.4 `assets.list`

| 项目 | 契约 |
| --- | --- |
| 用途 | 分页查询当前已提交资产索引 |
| 请求 | `{ projectId?: string, toolKeys?: string[], resourceTypes?: ResourceType[], scopeKinds?: ScopeKind[], diagnosticSeverity?: Severity, query?: string, cursor?: string, limit?: number }`，`limit` 为 1–200 |
| 响应 | `{ items: AssetSummary[], nextCursor: string | null, snapshotRevision: string, stale: boolean }` |
| 错误码 | `VALIDATION_FAILED`、`NOT_FOUND`、`CURSOR_INVALID`、`STALE_INDEX` |
| 权限边界 | 只读；不返回原始秘密字段，搜索仅作用于脱敏索引；游标绑定筛选条件和快照 |
| 事件 | 无 |

### 6.5 `assets.get`

| 项目 | 契约 |
| --- | --- |
| 用途 | 获取单个资产、来源、规范化内容、引用和诊断摘要 |
| 请求 | `{ assetId: string, include: ("normalized" | "references" | "diagnostics")[] }` |
| 响应 | `{ asset: AssetDetail, source: { pathDisplay, contentHash, observedAt }, redactions: RedactionMarker[] }` |
| 错误码 | `VALIDATION_FAILED`、`NOT_FOUND`、`STALE_INDEX`、`PERMISSION_DENIED` |
| 权限边界 | 只读；不通过 IPC 返回未清洗的完整文件正文或秘密值；需要打开文件时走独立受控 UI 流程 |
| 事件 | 无 |

### 6.6 `effective.resolve`

| 项目 | 契约 |
| --- | --- |
| 用途 | 解释指定工具、项目和目标目录的最终生效配置 |
| 请求 | `{ toolKey: string, projectId: string, targetScopeId: string, resourceTypes?: ResourceType[] }` |
| 响应 | `{ effective: EffectiveConfigView, contributors: ContributorStep[], ignored: IgnoredAsset[], diagnostics: DiagnosticSummary[], snapshotRevision: string }` |
| 错误码 | `VALIDATION_FAILED`、`NOT_FOUND`、`STALE_INDEX`、`ADAPTER_VERSION_UNSUPPORTED`、`RESOLUTION_FAILED` |
| 权限边界 | 只读；`targetScopeId` 必须属于项目和已授权根；结果只包含脱敏规范化字段 |
| 事件 | 无 |

### 6.7 `diagnostics.list`

| 项目 | 契约 |
| --- | --- |
| 用途 | 分页查询可定位、可解释的诊断 |
| 请求 | `{ projectId?: string, assetId?: string, toolKeys?: string[], severities?: Severity[], codes?: string[], cursor?: string, limit?: number }` |
| 响应 | `{ items: DiagnosticView[], nextCursor: string | null, countsBySeverity: Record<Severity, number>, snapshotRevision: string }` |
| 错误码 | `VALIDATION_FAILED`、`NOT_FOUND`、`CURSOR_INVALID` |
| 权限边界 | 只读；证据和位置经过脱敏，禁止在消息中回显秘密原文 |
| 事件 | 无 |

### 6.8 `migration.preview`

| 项目 | 契约 |
| --- | --- |
| 用途 | 将源资产转换为目标工具格式并生成不写文件的结构化/文本差异 |
| 请求 | `{ sourceAssetIds: string[], targetToolKey: string, targetScopeId: string, conflictPolicy: "fail" | "replace" | "merge" }` |
| 响应 | `{ previewId, compatibility, changes: PlannedChange[], warnings: DiagnosticSummary[], sourceHashes, targetHashes, expiresAt, confirmationToken }` |
| 错误码 | `VALIDATION_FAILED`、`NOT_FOUND`、`STALE_INDEX`、`UNSUPPORTED_CONVERSION`、`TARGET_CONFLICT`、`PERMISSION_DENIED` |
| 权限边界 | 只读磁盘；目标必须在已授权且适配器声明的配置根；确认令牌绑定预览、调用实例、哈希和过期时间 |
| 事件 | 无；预览是有界同步用例，超出限制返回 `PREVIEW_TOO_LARGE` 而不是隐式后台执行 |

### 6.9 `deployment.execute`

| 项目 | 契约 |
| --- | --- |
| 用途 | 执行已确认预览：预检、备份、原子写入、验证，失败时回滚 |
| 请求 | `{ previewId: string, confirmationToken: string }`，不接受 renderer 重传或修改变更内容 |
| 响应 | `{ taskId: string, deploymentId: string, status: "queued", acceptedAt: string }` |
| 错误码 | `VALIDATION_FAILED`、`NOT_FOUND`、`CONFIRMATION_REQUIRED`、`CONFIRMATION_EXPIRED`、`STALE_PREVIEW`、`TARGET_LOCKED`、`READ_ONLY_RECOVERY`、`PERMISSION_DENIED` |
| 权限边界 | 唯一常规文件写入口；main 从持久预览重建计划并复核 canonical path、symlink、源/目标哈希和写权限 |
| 事件 | `accepted`；`preflight`、`backing_up`、`writing`、`verifying` 或 `rolling_back` 事件；最终 `completed`，状态为 `succeeded`、`rolled_back` 或 `recovery_required` |

### 6.10 `deployment.rollback`

| 项目 | 契约 |
| --- | --- |
| 用途 | 使用已验证备份恢复某次部署影响的目标 |
| 请求 | `{ deploymentId: string, confirmationToken: string }`，令牌来自回滚确认视图 |
| 响应 | `{ taskId: string, rollbackId: string, status: "queued", acceptedAt: string }` |
| 错误码 | `VALIDATION_FAILED`、`NOT_FOUND`、`CONFIRMATION_REQUIRED`、`BACKUP_MISSING`、`BACKUP_HASH_MISMATCH`、`STALE_TARGET`、`TARGET_LOCKED`、`READ_ONLY_RECOVERY`、`PERMISSION_DENIED` |
| 权限边界 | 只恢复该部署登记的路径；默认目标已漂移时拒绝，不能选择任意备份路径或目标路径 |
| 事件 | `accepted`；`preflight`、`restoring`、`verifying`；最终 `completed`，失败时给出 `recovery_required` 和未恢复操作 ID |

### 6.11 `history.list`

| 项目 | 契约 |
| --- | --- |
| 用途 | 分页查询扫描、迁移预览、部署和回滚审计历史 |
| 请求 | `{ taskId?: string, kinds?: ("scan" | "preview" | "deployment" | "rollback")[], projectId?: string, statuses?: string[], from?: string, to?: string, cursor?: string, limit?: number }`；提供 `taskId` 时返回该任务的活动或终态条目 |
| 响应 | `{ items: HistoryEntry[], nextCursor: string | null }`；活动长任务条目包含 `{ phase, progress, lastSequence, cancellable }` 快照 |
| 错误码 | `VALIDATION_FAILED`、`NOT_FOUND`、`CURSOR_INVALID` |
| 权限边界 | 只读；计划和错误上下文脱敏，不返回备份正文、凭据或补偿 payload 的秘密字段 |
| 事件 | 无 |

### 6.12 `settings.get`

| 项目 | 契约 |
| --- | --- |
| 用途 | 读取公开产品设置和当前修订号 |
| 请求 | `{ keys?: PublicSettingKey[] }` |
| 响应 | `{ values: Partial<Record<PublicSettingKey, JsonValue>>, revision: number, readOnlyRecovery: boolean }` |
| 错误码 | `VALIDATION_FAILED`、`SETTING_NOT_PUBLIC` |
| 权限边界 | 只读；不返回 OS 凭据、Git 凭据、秘密值、内部绝对路径或安全策略原文 |
| 事件 | 无 |

### 6.13 `settings.update`

| 项目 | 契约 |
| --- | --- |
| 用途 | 以乐观并发方式更新 allowlist 中的公开设置 |
| 请求 | `{ patch: Partial<Record<PublicSettingKey, JsonValue>>, expectedRevision: number }` |
| 响应 | `{ values: Partial<Record<PublicSettingKey, JsonValue>>, revision: number, requiresRestart: boolean }` |
| 错误码 | `VALIDATION_FAILED`、`SETTING_NOT_PUBLIC`、`CONFLICT`、`READ_ONLY_RECOVERY`、`PERMISSION_DENIED` |
| 权限边界 | 只能更新主题、显示路径策略、扫描提示等公开键；不能设置任意路径、命令、环境变量、外部 URL 或凭据 |
| 事件 | 成功后主进程向所有窗口发布固定 `settings.changed` 事件 `{ revision, changedKeys }`，不携带秘密值 |

## 7. CLI 映射与退出码

CLI 可执行文件名为 `ai-config-hub`。所有命令调用与 IPC 相同的用例；人类输出写 `stdout`，进度在 TTY 中动态展示，错误摘要写 `stderr`。使用 `--json` 时 `stdout` 只输出一个 JSON 文档，不输出进度动画；日志仍写日志文件或 `stderr`，且不能污染 JSON。

稳定退出码：`0` 成功，`2` 参数/Schema 错误，`3` 部分成功，`4` 业务冲突或陈旧状态，`5` 权限/路径安全错误，`6` 部署或回滚失败，`7` 只读恢复，`10` 已脱敏内部错误。

所有 `--json` 输出共享 envelope：

```ts
type CliJson<T> = {
  schemaVersion: 1;
  command: string;
  ok: boolean;
  data?: T;
  error?: ApiFailure["error"];
  meta: { generatedAt: string; partial: boolean };
};
```

### 7.1 `scan`

映射：`scan.start`，前台等待时轮询 `scan.status`；`--detach` 只返回 `taskId`。

```text
$ ai-config-hub scan --project ./demo
扫描完成（部分成功）
发现 42 个文件：成功 40，失败 2，跳过 0
任务：scn_01JZ8M2Y6S7Q
诊断：2 个错误，5 个警告
```

```json
{"schemaVersion":1,"command":"scan","ok":true,"data":{"taskId":"scn_01JZ8M2Y6S7Q","status":"partial","phase":"completed","counts":{"discovered":42,"succeeded":40,"failed":2,"skipped":0},"diagnosticIds":["diag_01JZ8M31","diag_01JZ8M32"]},"meta":{"generatedAt":"2026-06-21T08:00:00.000Z","partial":true}}
```

### 7.2 `assets`

映射：`assets.list`；`--id` 时映射 `assets.get`。

```text
$ ai-config-hub assets --tool codex --type rule
ID              工具    类型   作用域   名称                 状态
ast_01JZ8N1A    codex   rule   project  repository-policy    正常
共 1 项
```

```json
{"schemaVersion":1,"command":"assets","ok":true,"data":{"items":[{"id":"ast_01JZ8N1A","toolKey":"codex","resourceType":"rule","scopeKind":"project","logicalKey":"repository-policy","contentHash":"sha256:8ae3c1","diagnosticCounts":{"error":0,"warning":0,"info":0}}],"nextCursor":null,"snapshotRevision":"idx_1042","stale":false},"meta":{"generatedAt":"2026-06-21T08:01:00.000Z","partial":false}}
```

### 7.3 `effective`

映射：`effective.resolve`。

```text
$ ai-config-hub effective --tool codex --project ./demo --scope src
最终生效：3 条 Rules，1 个 Agent，2 个 Skills
repository-policy  来自 project  覆盖 user/repository-policy
解释步骤：6；忽略项：1；警告：0
```

```json
{"schemaVersion":1,"command":"effective","ok":true,"data":{"toolKey":"codex","projectId":"prj_01JZ8","targetScopeId":"scp_01JZ8SRC","snapshotRevision":"idx_1042","effective":{"counts":{"rule":3,"agent":1,"skill":2,"mcp":0}},"contributors":[{"assetId":"ast_01JZ8N1A","action":"override","reasonCode":"HIGHER_SCOPE_PRECEDENCE"}],"ignored":[{"assetId":"ast_01JZ8USER","reasonCode":"OVERRIDDEN"}],"diagnosticIds":[]},"meta":{"generatedAt":"2026-06-21T08:02:00.000Z","partial":false}}
```

### 7.4 `diagnose`

映射：`diagnostics.list`；需要最新结果时先显式运行 `scan`，本命令不隐式写索引。

```text
$ ai-config-hub diagnose --severity error,warning
ERROR    CFG_PARSE_INVALID       .cursor/rules/team.mdc:12
WARNING  REFERENCE_UNRESOLVED    AGENTS.md:8
共 2 项：1 error，1 warning
```

```json
{"schemaVersion":1,"command":"diagnose","ok":true,"data":{"items":[{"id":"diag_01JZ8P1","code":"CFG_PARSE_INVALID","severity":"error","assetId":"ast_01JZ8BAD","location":{"pathDisplay":".cursor/rules/team.mdc","line":12},"message":"Frontmatter 格式无效","suggestedAction":"修正第 12 行后重新扫描"},{"id":"diag_01JZ8P2","code":"REFERENCE_UNRESOLVED","severity":"warning","assetId":"ast_01JZ8AGT","location":{"pathDisplay":"AGENTS.md","line":8},"message":"引用的 Skill 不存在","suggestedAction":"安装或移除该引用"}],"countsBySeverity":{"error":1,"warning":1,"info":0},"nextCursor":null},"meta":{"generatedAt":"2026-06-21T08:03:00.000Z","partial":false}}
```

### 7.5 `migrate --dry-run`

映射：`migration.preview`。MVP 的 `migrate` 必须带 `--dry-run`；实际写入只能由 `deploy --preview <id>` 触发。

```text
$ ai-config-hub migrate --dry-run --asset ast_01JZ8N1A --to cursor --scope project
兼容性：partial
计划：新增 1，修改 0，删除 0
警告：字段 permissions 不受 Cursor 支持，已从输出移除
预览 ID：prv_01JZ8Q5（30 分钟内有效）
```

```json
{"schemaVersion":1,"command":"migrate --dry-run","ok":true,"data":{"previewId":"prv_01JZ8Q5","compatibility":"partial","changes":[{"operation":"create","pathDisplay":".cursor/rules/repository-policy.mdc","beforeHash":null,"afterHash":"sha256:71c99a"}],"warnings":[{"code":"FIELD_DROPPED","field":"permissions"}],"sourceHashes":{"ast_01JZ8N1A":"sha256:8ae3c1"},"targetHashes":{".cursor/rules/repository-policy.mdc":null},"expiresAt":"2026-06-21T08:34:00.000Z"},"meta":{"generatedAt":"2026-06-21T08:04:00.000Z","partial":true}}
```

JSON 输出故意不包含 `confirmationToken`；CLI 将令牌存入当前用户权限受限的本地会话记录，并通过 `previewId` 取用，避免 shell 历史泄漏。

### 7.6 `deploy`

映射：`deployment.execute`。交互终端显示差异摘要并要求输入确认；非交互模式必须显式传 `--yes --preview <id>`，且预览仍需有效。

```text
$ ai-config-hub deploy --preview prv_01JZ8Q5
已验证预览和目标哈希
备份 1/1；写入 1/1；验证 1/1
部署成功：dep_01JZ8R2
```

```json
{"schemaVersion":1,"command":"deploy","ok":true,"data":{"taskId":"dep_01JZ8R2","deploymentId":"dep_01JZ8R2","status":"succeeded","counts":{"planned":1,"backedUp":1,"written":1,"verified":1,"failed":0},"backupIds":["bkp_01JZ8R3"],"verification":{"status":"passed","scanRunId":"scn_01JZ8R4"}},"meta":{"generatedAt":"2026-06-21T08:05:00.000Z","partial":false}}
```

### 7.7 `rollback`

映射：`deployment.rollback`。交互确认显示将恢复的路径数；非交互模式要求 `--yes`。

```text
$ ai-config-hub rollback dep_01JZ8R2
备份校验通过：1/1
恢复 1/1；验证 1/1
回滚成功：rbk_01JZ8S1
```

```json
{"schemaVersion":1,"command":"rollback","ok":true,"data":{"taskId":"rbk_01JZ8S1","rollbackId":"rbk_01JZ8S1","deploymentId":"dep_01JZ8R2","status":"succeeded","counts":{"planned":1,"restored":1,"verified":1,"failed":0},"verification":{"status":"passed","scanRunId":"scn_01JZ8S2"}},"meta":{"generatedAt":"2026-06-21T08:06:00.000Z","partial":false}}
```

### 7.8 `history`

映射：`history.list`。

```text
$ ai-config-hub history --kind deployment,rollback
时间                 类型        状态       ID
2026-06-21 16:06     rollback    succeeded  rbk_01JZ8S1
2026-06-21 16:05     deployment  succeeded  dep_01JZ8R2
```

```json
{"schemaVersion":1,"command":"history","ok":true,"data":{"items":[{"id":"rbk_01JZ8S1","kind":"rollback","status":"succeeded","projectId":"prj_01JZ8","createdAt":"2026-06-21T08:06:00.000Z","relatedId":"dep_01JZ8R2"},{"id":"dep_01JZ8R2","kind":"deployment","status":"succeeded","projectId":"prj_01JZ8","createdAt":"2026-06-21T08:05:00.000Z","relatedId":"prv_01JZ8Q5"}],"nextCursor":null},"meta":{"generatedAt":"2026-06-21T08:07:00.000Z","partial":false}}
```

## 8. 契约测试要求

- 每个命令以有效请求、边界值、未知字段、错误类型、错误码脱敏和响应反向校验建立契约测试。
- Electron 测试必须证明 renderer 无法调用未登记 channel，preload 和 main 任一侧拒绝畸形请求。
- CLI 与 IPC 对同一夹具产生相同业务数据、错误码和部分成功计数。
- 长任务测试覆盖事件严格递增、重复去重、缺口重连、取消安全点、`writing` 后拒绝取消和终态唯一性。
- 漂移测试必须证明过期 `previewId`、改变的源哈希和改变的目标哈希都无法触发写入。
- `--json` 黄金测试固定 Schema 和字段类型，同时允许新增可选字段；任何日志或进度文本污染 `stdout` 都应失败。
