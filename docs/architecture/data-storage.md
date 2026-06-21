# 数据存储、扫描与变更检测

| 项目 | 内容 |
| --- | --- |
| 目的 | 定义配置文件、SQLite 索引、扫描任务、文件监听和部署记录之间的数据所有权与一致性边界 |
| 目标读者 | 核心模块开发者、存储层开发者、扫描器开发者、测试工程师、安全审查人员 |
| 状态 | MVP 技术基线 |
| 相关文档 | [架构总览](./overview.md) · [领域模型](./domain-model.md) · [适配器系统](./adapter-system.md) · [API、IPC 与 CLI](./api-and-ipc.md) · [安全架构](./security.md) · [ADR-0003：配置文件作为事实来源](../adr/0003-files-as-source-of-truth.md) · [已确认技术方案](../superpowers/specs/2026-06-21-technical-solution-design.md) |

## 1. 数据所有权与缓存边界

本地配置文件是 AI Config Hub 的唯一事实来源。SQLite 只是可重建的本地索引，不能成为配置内容的权威副本，也不能在文件缺失或哈希不一致时用旧记录静默恢复文件。Git 仓库中的资产只有在检出为本地文件并进入扫描范围后，才参与当前环境的生效计算。

SQLite 可以保存：

- 工具、项目、作用域和资产的可查询索引；
- 规范化内容、适配器版本、Schema 版本、内容哈希和引用关系；
- 诊断、扫描任务、部署历史、操作日志和备份元数据；
- 为解释差异所需的最小文本片段、位置和脱敏摘要。

SQLite 不得保存：

- 可用于恢复第三方服务访问权的明文 Token、密码、私钥、Cookie 或完整环境变量值；
- 未脱敏的 MCP `env`、认证头或命令参数中的秘密；
- 为便利而复制的完整配置正文，除非该正文经过字段级清洗且确实是差异解释所必需；
- 可执行对象、动态加载模块或第三方配置的执行结果。

缓存记录必须携带 `source_path_normalized`、`content_hash`、`observed_mtime_ms`、`observed_size`、`adapter_version` 和 `normalized_schema_version`。任何需要精确内容的查询都先比较当前文件元数据和哈希；不一致时返回 `STALE_INDEX` 或触发扫描，不能把数据库记录当作当前文件。

敏感字段处理采用键名与结构双重检测。键名匹配不区分大小写，至少覆盖 `token`、`secret`、`password`、`passwd`、`privateKey`、`apiKey`、`authorization`、`cookie` 和 `credential`。允许保存秘密是否存在、键路径和不可逆摘要，但不保存明文值；摘要使用带产品域分隔的单向哈希，不能用于跨产品关联用户秘密。

## 2. 标识、路径与时间约定

- SQLite 行主键 `id` 是随机 UUID surrogate key，数据库类型为 `TEXT`，仅用于外键连接和存储实现；它不等同于领域身份。
- 可跨扫描重建的实体另存稳定 `domain_id`。`AssetId`、`ScopeId` 等按[领域模型](./domain-model.md)的规范化输入确定生成，并分别受 `UNIQUE(domain_id)` 约束；数据库重建可以得到同一领域 ID，但会得到新的 surrogate `id`。
- 时间使用 UTC Unix 毫秒 `INTEGER`，API 层再编码为 ISO 8601。
- 枚举以受约束的 `TEXT` 保存，由 Drizzle Schema 和迁移中的 `CHECK` 共同约束。
- 路径在写入索引前完成绝对化、分隔符统一、`.`/`..` 折叠、平台大小写策略处理和真实路径校验。
- Windows 的比较键使用大小写折叠后的规范化路径，但同时保留仅用于展示的原始路径；POSIX 默认区分大小写。
- 内容哈希使用 SHA-256，基于读取到的原始字节计算；它用于漂移检测和乐观并发控制，不作为永久资产 ID。

## 3. 逻辑 SQLite Schema

所有业务表启用外键约束。下表是逻辑 Schema；实现可增加内部 staging 表和生成列，但不得改变所列数据所有权、唯一性和删除语义。

### 3.1 `tools`

| 项目 | 定义 |
| --- | --- |
| 主键 | `id TEXT`，随机 surrogate UUID |
| 核心字段 | `tool_installation_id`（稳定领域 ID）、`tool_key`、`canonical_config_root`、`display_name`、`detected_version`、`adapter_version`、`capabilities_json`、`last_seen_at` |
| 唯一约束 | `UNIQUE(tool_installation_id)`；`UNIQUE(tool_key, canonical_config_root)`，允许同一种工具存在多个安装/配置根 |
| 删除行为 | 被 `scopes`、`assets` 或历史部署引用时禁止删除；工具消失使用软状态 `is_detected = 0` |
| 关键索引 | `idx_tools_detected(is_detected, tool_key)` |

`tool_key` 是稳定工具种类，例如 `claude-code`、`cursor`、`codex`、`opencode`；`tools` 的一行表示一个工具安装实例。后续表中的 `tool_id`/`target_tool_id` 均外键到该安装实例的 surrogate `tools.id`，不能只凭 `tool_key` 选择实例。

### 3.2 `projects`

| 项目 | 定义 |
| --- | --- |
| 主键 | `id TEXT`，随机 surrogate UUID |
| 核心字段 | `domain_id`（稳定 `ProjectId`）、`root_path_display`、`root_path_normalized`、`name`、`git_root_normalized`、`first_seen_at`、`last_seen_at` |
| 唯一约束 | `UNIQUE(domain_id)`、`UNIQUE(root_path_normalized)` |
| 删除行为 | 删除项目时 `scopes` 级联删除；由此触发当前资产和诊断级联删除，历史部署保留并将 `project_id` 置空 |
| 关键索引 | `idx_projects_last_seen(last_seen_at DESC)`、`idx_projects_git_root(git_root_normalized)` |

### 3.3 `scopes`

| 项目 | 定义 |
| --- | --- |
| 主键 | `id TEXT`，随机 surrogate UUID |
| 外键 | `tool_id → tools.id ON DELETE RESTRICT`（具体工具安装实例）；`project_id → projects.id ON DELETE CASCADE`，用户级作用域允许为空；`parent_scope_id → scopes.id ON DELETE CASCADE` |
| 核心字段 | `domain_id`（稳定 `ScopeId`）、`scope_kind`、`root_path_display`、`root_path_normalized`、`depth`、`precedence`、`adapter_scope_key` |
| 唯一约束 | `UNIQUE(domain_id)`；`UNIQUE(tool_id, project_id, root_path_normalized, adapter_scope_key)`；SQLite 中对空 `project_id` 使用表达式唯一索引统一为空哨兵 |
| 关键索引 | `idx_scopes_resolution(tool_id, project_id, precedence DESC, depth DESC)`、`idx_scopes_parent(parent_scope_id)` |

`scope_kind` 至少支持 `user`、`project` 和 `directory`。删除父作用域会删除其当前索引子树，但不会删除磁盘文件。

### 3.4 `assets`

| 项目 | 定义 |
| --- | --- |
| 主键 | `id TEXT`，随机 surrogate UUID |
| 外键 | `tool_id → tools.id ON DELETE RESTRICT`（具体工具安装实例）；`scope_id → scopes.id ON DELETE CASCADE`；`last_scan_run_id → scan_runs.id ON DELETE SET NULL` |
| 核心字段 | `domain_id`（稳定 `AssetId`）、`resource_type`、`logical_key`、`source_path_display`、`source_path_normalized`、`content_hash`、`observed_mtime_ms`、`observed_size`、`normalized_json`、`normalized_schema_version`、`adapter_version`、`parse_status`、`sensitive_summary_json`、`first_seen_at`、`last_seen_at` |
| 唯一约束 | `UNIQUE(domain_id)`；`UNIQUE(tool_id, scope_id, source_path_normalized, logical_key)` |
| 关键索引 | `idx_assets_list(tool_id, resource_type, last_seen_at DESC)`、`idx_assets_scope(scope_id, resource_type, logical_key)`、`idx_assets_path(source_path_normalized)`、`idx_assets_hash(content_hash)`、`idx_assets_resolution(tool_id, logical_key, scope_id)` |

`normalized_json` 只能包含脱敏后的统一字段和工具扩展。文件移动可通过扫描中的路径、内容和引用证据关联到既有资产，但不能仅凭相同哈希自动合并两个独立文件。

### 3.5 `asset_references`

| 项目 | 定义 |
| --- | --- |
| 主键 | `id TEXT` |
| 外键 | `source_asset_id → assets.id ON DELETE CASCADE`；`target_asset_id → assets.id ON DELETE SET NULL` |
| 核心字段 | `reference_kind`、`target_key`、`location_json`、`resolution_status` |
| 唯一约束 | `UNIQUE(source_asset_id, reference_kind, target_key, location_json)` |
| 关键索引 | `idx_asset_refs_source(source_asset_id)`、`idx_asset_refs_target(target_asset_id)`、`idx_asset_refs_unresolved(resolution_status, target_key)` |

目标尚未解析或目标资产被删除时保留 `target_key` 和位置，使诊断仍可解释断链原因。

### 3.6 `diagnostics`

| 项目 | 定义 |
| --- | --- |
| 主键 | `id TEXT` |
| 外键 | `asset_id → assets.id ON DELETE CASCADE`；`scan_run_id → scan_runs.id ON DELETE CASCADE`；`project_id → projects.id ON DELETE CASCADE` |
| 核心字段 | `code`、`severity`、`message_key`、`location_json`、`evidence_json`、`suggested_action`、`fingerprint`、`created_at` |
| 唯一约束 | `UNIQUE(scan_run_id, fingerprint)`，避免同次扫描重复报告同一问题 |
| 关键索引 | `idx_diagnostics_query(project_id, severity, code, created_at DESC)`、`idx_diagnostics_asset(asset_id, severity)`、`idx_diagnostics_scan(scan_run_id)` |

`evidence_json` 必须脱敏；对没有资产记录的发现级问题，`asset_id` 可为空，但必须关联 `scan_run_id`。

### 3.7 `scan_runs`

| 项目 | 定义 |
| --- | --- |
| 主键 | `id TEXT`，随机 surrogate UUID |
| 外键 | `project_id → projects.id ON DELETE SET NULL` |
| 核心字段 | `domain_id`（公开 `ScanRunId`/`taskId`）、`scan_kind`、`status`、`phase`、`requested_roots_json`、`started_at`、`finished_at`、`discovered_count`、`processed_count`、`succeeded_count`、`failed_count`、`cancel_requested_at`、`error_summary_json` |
| 唯一约束 | `UNIQUE(domain_id)`；每次请求均生成独立记录 |
| 关键索引 | `idx_scan_runs_status(status, started_at DESC)`、`idx_scan_runs_project(project_id, started_at DESC)` |

任务记录是审计和重连依据。`status` 使用领域状态，成功提交索引后才改为 `succeeded` 或 `partially_succeeded`；`phase` 仅表示 `discovering`、`parsing`、`committing` 等运行进度，不得写入领域状态枚举。

### 3.8 `deployments`

| 项目 | 定义 |
| --- | --- |
| 主键 | `id TEXT`，随机 surrogate UUID |
| 外键 | `project_id → projects.id ON DELETE SET NULL`；`source_asset_id → assets.id ON DELETE SET NULL`；`target_tool_id → tools.id ON DELETE RESTRICT`（具体目标工具安装实例） |
| 核心字段 | `domain_id`（公开 `DeploymentRecordId`/`taskId`）、`plan_id`、`status`、`source_hash`、`target_hash_before`、`plan_json`、`compatibility`、`requested_at`、`confirmed_at`、`finished_at`、`verification_json`、`rollback_state`、`correlation_id` |
| 唯一约束 | `UNIQUE(domain_id)`；`UNIQUE(plan_id)`，一个计划最多被执行一次 |
| 关键索引 | `idx_deployments_history(project_id, requested_at DESC)`、`idx_deployments_status(status, requested_at)`、`idx_deployments_target(target_tool_id, requested_at DESC)` |

`plan_json` 不包含秘密明文。执行前必须验证 `source_hash` 和 `target_hash_before` 与磁盘一致。

### 3.9 `deployment_operations`

| 项目 | 定义 |
| --- | --- |
| 主键 | `id TEXT` |
| 外键 | `deployment_id → deployments.id ON DELETE CASCADE` |
| 核心字段 | `sequence_no`、`operation_kind`、`target_path_normalized`、`expected_hash_before`、`result_hash_after`、`fence_token`、`state`、`compensation_kind`、`compensation_payload_json`、`started_at`、`finished_at`、`error_code` |
| 唯一约束 | `UNIQUE(deployment_id, sequence_no)`；同一部署中的 `target_path_normalized` 在活动操作上唯一 |
| 关键索引 | `idx_deployment_ops_resume(deployment_id, state, sequence_no)`、`idx_deployment_ops_target(target_path_normalized, started_at DESC)` |

该表是文件系统补偿日志的持久目录，不意味着 SQLite 事务可以回滚文件系统。`compensation_payload_json` 只记录备份 ID、目标哈希和动作，不存秘密正文。

### 3.10 `backups`

| 项目 | 定义 |
| --- | --- |
| 主键 | `id TEXT`，随机 surrogate UUID |
| 外键 | `deployment_id → deployments.id ON DELETE RESTRICT`；`operation_id → deployment_operations.id ON DELETE RESTRICT` |
| 核心字段 | `domain_id`（稳定 `BackupId`）、`backup_path_normalized`、`target_path_normalized`、`content_hash`、`size_bytes`、`created_at`、`expires_at`、`permission_mode`、`encryption_state`、`restore_verified_at` |
| 唯一约束 | `UNIQUE(domain_id)`；`UNIQUE(operation_id)`，每个覆盖或删除操作必须恰有一个可验证备份 |
| 关键索引 | `idx_backups_retention(expires_at)`、`idx_backups_deployment(deployment_id)`、`idx_backups_target(target_path_normalized, created_at DESC)` |

删除部署历史前必须先完成明确的备份保留或清理流程；外键使用 `RESTRICT` 防止审计记录与实际备份失配。备份始终使用用户私有权限：POSIX 目录 `0700`、文件 `0600`，Windows 使用仅当前用户和必要 SYSTEM 可访问的等价 ACL；不得因源文件权限更宽而放宽备份。

### 3.11 `deployment_locks`

| 项目 | 定义 |
| --- | --- |
| 主键 | `id TEXT`，随机 surrogate UUID |
| 外键 | `deployment_id → deployments.id ON DELETE SET NULL`，便于崩溃恢复后识别原持有任务 |
| 核心字段 | `canonical_target_key`、`owner_id`（desktop/CLI 进程实例随机 ID）、`lease_expires_at`、`fence_token INTEGER`、`acquired_at`、`renewed_at` |
| 唯一约束 | `UNIQUE(canonical_target_key)`；同一 canonical 目标集合任一时刻只有一个有效租约 |
| 关键索引 | `idx_deployment_locks_lease(lease_expires_at)`、`idx_deployment_locks_owner(owner_id)` |

desktop 与 CLI 共用该表协调部署。获取、续租和释放均在短 `BEGIN IMMEDIATE` 事务中完成：获取仅能插入空键、由当前 owner 续租，或接管已过期租约；每次新获取/接管都将 `fence_token` 单调递增且永不复用。释放使用 `(canonical_target_key, owner_id, fence_token)` 条件删除，旧 owner 不能删除新租约。进程内 mutex 只能减少本进程竞争，是优化而不是正确性边界。

### 3.12 `schema_migrations`

| 项目 | 定义 |
| --- | --- |
| 主键 | `version INTEGER`，单调递增 |
| 核心字段 | `name`、`checksum`、`started_at`、`applied_at`、`state`、`error_code`、`app_version` |
| 唯一约束 | `UNIQUE(name)`、`UNIQUE(checksum)` 仅用于已应用迁移；同名迁移校验和改变必须拒绝启动写模式 |
| 关键索引 | `idx_schema_migrations_state(state, version DESC)` |

迁移记录不依赖业务表，保证业务 Schema 损坏时仍能诊断启动状态。

## 4. SQLite 运行模式

连接初始化必须依次执行并校验：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

WAL 允许 UI/CLI 读查询与扫描写事务并发，但不代表允许多个写任务修改相同目标。desktop 与 CLI 可能是独立进程，必须以共享 SQLite `deployment_locks` 租约和 fencing token 协调；进程内互斥锁只用于降低本进程竞争。应用仍对扫描提交、迁移和部署历史更新使用短写事务。定期 checkpoint 在空闲期执行，不能在部署原子写入窗口中强制阻塞。

## 5. 扫描 staging 与原子替换

扫描不能边解析边覆盖当前可查询索引。每个 `scan_run` 使用以 `scan_run_id` 隔离的临时 staging 集合：

1. `discovering`：枚举候选并固定规范化路径集合。
2. `reading`：安全读取、计算原始字节哈希和元数据。
3. `parsing`：适配器解析并产生脱敏规范化资产、引用和诊断。
4. `validating`：检查 staging 中的唯一性、外键目标、敏感字段和计数。
5. `committing`：在一个 SQLite `IMMEDIATE` 事务中，将受影响作用域的当前索引替换为 staging 结果。
6. `completed`：提交计数和最终状态并发布终态事件。

全量扫描的替换范围是请求所覆盖的全部作用域；增量扫描只替换事件影响的路径及依赖闭包。解析失败的文件以 `parse_status = 'failed'` 的最小资产壳和诊断进入 staging，其他成功资产仍可提交，任务状态为 `partially_succeeded`。取消发生在 `committing` 前时丢弃未提交 staging；一旦开始 `committing`，必须完成提交或让数据库事务整体回滚。

读查询永远只读当前已提交快照，不读取 staging。进程崩溃后，启动清理未完成 staging，并把对应 `scan_runs.status` 标记为 `failed`、记录结构化 `reason = 'PROCESS_INTERRUPTED'`；`interrupted` 不是额外领域状态，旧索引仍可读。

## 6. 数据库迁移与只读恢复

Drizzle 迁移在任何业务写入和 Chokidar 启动前执行。迁移文件是只追加的版本序列；启动时校验已应用迁移的名称和校验和。

迁移流程：

1. 获取跨进程迁移锁并确认没有活动写任务。
2. 使用 SQLite Online Backup API（或驱动提供的等价一致性 backup API）生成并校验数据库快照，不能直接复制活动中的 DB/WAL/SHM 文件。若运行环境确实不提供安全 backup API，只允许在取得跨进程独占锁、停止全部写入、完成并校验 checkpoint 后复制关闭状态的数据库；复制后必须对源和副本执行完整性与 Schema/迁移版本校验，任一步失败都保持只读且不得迁移。
3. 在事务能力允许的范围内应用单个迁移并运行完整性检查。
4. 写入 `schema_migrations` 成功记录后再开放业务写入。

若版本过新、校验和不符、迁移 SQL 失败或完整性检查失败，应用进入“只读恢复”模式：

- 允许读取旧 Schema 可安全解码的资产、历史和诊断；无法解码的查询返回稳定错误；
- 禁止扫描提交、设置更新、部署、回滚和备份清理；
- 显示失败版本、脱敏错误码、数据库备份位置和恢复指引；
- 不自动降级 Schema，不继续尝试后续迁移，不删除原数据库。

只有恢复一致数据库或安装支持该 Schema 的应用后，才退出只读恢复。

## 7. 数据库事务与文件系统补偿边界

SQLite 事务只能原子提交数据库页，不能与文件重命名、`fsync` 或 Git 操作组成分布式事务。部署采用持久状态机和补偿日志：

1. 为全部目标计算排序稳定的 `canonical_target_key`，在 `BEGIN IMMEDIATE` 中取得共享 `deployment_locks` 租约及单调 `fence_token`；随后创建 `deployment`、顺序化的 `deployment_operations` 和待验证备份记录。
2. 对每个目标先安全备份并 `fsync`，再把操作状态提交为 `backed_up`。
3. 每个备份、临时文件写入和原子替换前，在短 `BEGIN IMMEDIATE` 事务中验证 lock 的 owner、未过期 lease 和相同 `fence_token`；失败立即停止。通过平台文件安全抽象以 no-follow 方式打开已校验父目录/目标句柄，复核目录与文件 identity（POSIX `device + inode`，Windows file ID/volume ID），在该目录句柄下创建用户私有临时文件，写入、`fsync`、解析验证后原子替换，并按平台能力同步父目录。
4. 每个文件操作完成后独立提交结果哈希和下一步补偿动作。
5. 全部文件完成后重新扫描并验证，最后标记部署成功。
6. 任一步失败时按 `sequence_no` 逆序执行补偿；补偿前同样验证 fencing token，补偿结果逐步持久化，崩溃后由新 owner 取得更高 token 后恢复继续。完成或进入人工恢复后以 owner/token 条件释放租约。

数据库事务不得在慢速文件 I/O 期间长时间保持；长操作由 owner 在 `BEGIN IMMEDIATE` 短事务中续租。SQLite 租约只能协调 AI Config Hub 的 desktop/CLI 实例，不能阻止编辑器或其他外部程序修改目标，因此每次实际写入前仍须复核源/目标哈希和打开句柄的 file identity。若文件已写而状态尚未提交即崩溃，恢复器通过 fencing token、目标哈希、文件 identity、临时文件、备份哈希和操作状态判定继续、补记或回滚；不凭时间戳猜测。补偿失败时 `DeploymentRecord.status` 保持 `failed`，系统为相关 `canonical_target_key` 设置持久 recovery lock/mode（可对用户显示 `recovery_required`），保留所有证据并阻止同一路径的新部署；`recovery_required` 不是 `DeploymentRecord.status`。

## 8. Chokidar 监听与增量扫描

### 8.1 事件规范化、去抖和合并

- 只监听已登记且通过允许根校验的配置目录，不递归监听整个家目录。
- `add`、`change`、`unlink`、`addDir`、`unlinkDir` 先转换为规范化绝对路径，再进入事件缓冲区。
- 默认以 250 ms 静默窗口去抖；编辑器的临时文件创建、重命名和删除被合并为目标路径的一次稳定事件。
- 同一路径按最终可观察状态合并：`add + change → add`、`change + unlink → unlink`、`unlink + add → change`；目录删除覆盖其子路径事件。
- 批次按路径排序并去重，扫描开始前再次读取文件状态，不相信事件携带的旧元数据。

### 8.2 部署事件抑制

部署器在写入前登记 `deployment_id`、目标规范化路径、预计结果哈希和抑制截止时间。监听器收到事件后仍读取并计算哈希：只有路径、时间窗口和结果哈希全部匹配时，才将事件关联到该部署并避免启动重复扫描。抑制不是忽略；部署完成后的验证扫描会覆盖这些路径。哈希不匹配的事件视为外部并发修改，立即停止后续写入并报告 `STALE_TARGET`。

### 8.3 增量扫描和依赖闭包

单文件变化触发该文件、其解析引用方、同一 `logical_key` 的上下层资产以及受影响 `EffectiveConfig` 的增量重算。作用域目录增删、适配器版本变化、工具版本变化或项目根移动会扩大到对应作用域或项目全量扫描。删除事件先确认文件确实不存在，再从新快照中移除资产并重新计算引用诊断。

### 8.4 哈希漂移检测

文件大小和 `mtime` 仅用于快速候选判断；部署、预览复用和可疑变化必须重算 SHA-256。以下情况均视为漂移：

- 当前源哈希与预览中的 `source_hash` 不同；
- 当前目标哈希与 `target_hash_before` 不同；
- 数据库 `content_hash` 与磁盘内容不同；
- 文件在读取前后的标识、大小或时间改变，表明读取可能撕裂。

漂移不会被自动覆盖。扫描可更新索引；部署必须中止并要求重新预览。

### 8.5 事件丢失与溢出恢复

Chokidar 报错、操作系统监听队列溢出、休眠恢复、网络/可移动文件系统重连、监听根被替换或事件序列出现无法解释的缺口时，将监听状态标记为 `degraded`，停止依赖增量完整性，并安排受影响根的全量扫描。全量扫描完成且索引与磁盘对账成功后才恢复 `healthy`。在此期间查询可返回旧快照并标记 `stale: true`，部署被禁止。

此外，应用在启动、监听恢复和可配置的低频校验周期执行哈希抽样或全量对账，以检测未产生事件的变化。

## 9. 保留、清理与可重建性

- 当前索引可随时通过全量扫描重建；清库不会修改配置文件。
- 诊断和失败扫描按保留期清理，但部署审计和仍可回滚的备份不得被孤立删除。
- 备份到期清理先验证部署状态和恢复策略，再安全删除文件，最后删除元数据；失败时保留元数据并重试。
- WAL checkpoint、`VACUUM` 和清理任务仅在无迁移、无索引提交和无部署的空闲窗口运行。
- 数据库导出、调试包和测试夹具继续执行与日志相同的敏感字段清洗规则。

## 10. 验收检查表

- 删除 SQLite 后，全量扫描可以重建当前资产与诊断，且不修改任何配置文件。
- 扫描失败或取消不会暴露半提交索引。
- 迁移失败进入可诊断的只读恢复，所有写入口均被拒绝。
- 文件写入失败能按补偿日志逆序恢复，崩溃后可继续恢复。
- Chokidar 合并编辑器事件，部署事件不会形成循环扫描，外部并发修改不会被抑制。
- 事件溢出后自动执行全量扫描，并在完成前阻止部署。
- SQLite、日志、备份元数据和 API 响应中均不出现秘密明文。
