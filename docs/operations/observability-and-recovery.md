# 本地可观测性、备份与恢复

| 项目 | 内容 |
| --- | --- |
| 目的 | 定义隐私优先的本地日志、可验证备份、诊断导出和常见失败的有序恢复 runbook。 |
| 目标读者 | 应用/CLI 工程师、支持人员、发布与运维工程师、安全审查者，以及执行恢复的高级用户。 |
| 状态 | MVP 技术基线；默认无遥测，所有恢复动作都必须先识别状态并保全证据。 |
| 相关文档 | [数据存储](../architecture/data-storage.md) · [安全设计](../architecture/security.md) · [API 与 IPC](../architecture/api-and-ipc.md) · [测试策略](../development/testing-strategy.md) · [构建发布与兼容性](./build-release-and-compatibility.md) · [ADR-0003：文件是事实来源](../adr/0003-files-as-source-of-truth.md) · [已确认技术方案](../superpowers/specs/2026-06-21-technical-solution-design.md) |

## 1. 可观测性目标与隐私边界

可观测性用于回答“哪个版本、哪项任务、在哪个阶段、对哪些缩略路径、发生了什么错误、系统采取了什么恢复动作”，不用于收集用户配置正文。桌面端和 CLI 使用同一 Pino 字段/脱敏政策；renderer 不直接写任意日志文件，而通过受限业务事件交由主进程记录。

产品默认：

- 不上传遥测、崩溃报告、日志、配置、路径或使用统计。
- 不发起后台诊断网络请求。版本检查或 Git 网络操作若存在，必须与遥测分离并可独立控制。
- support bundle 和诊断导出仅由用户主动触发，导出前显示精确文件/字段预览。
- 日志、SQLite、backup manifest 和 CLI `--json` 使用同一敏感键检测规则，但各自只允许其业务所需字段。

未来引入遥测需要独立安全/隐私设计、默认关闭、逐字段说明、明确保留期和用户主动 opt-in；本基线不预留静默上报开关。

## 2. Pino 日志规范

### 2.1 Levels

| Level | 使用场景 | 禁止用法 |
| --- | --- | --- |
| `trace` | 本地临时深度诊断，例如经过脱敏的状态机转移；正式构建默认关闭。 | 配置正文、凭据、完整环境变量、每字节解析输出。 |
| `debug` | 扫描批次计数、适配器选择、去抖/缓存决策；默认关闭，可由用户临时开启。 | 默认长期记录每个文件的完整路径。 |
| `info` | 应用启动/退出、版本、任务开始/完成、migration 版本、deployment/rollback 终态。 | 每文件成功造成噪声，或把正常用户输入记录为 payload。 |
| `warn` | 可恢复的部分扫描、未知更新工具版本、重试、备份保留清理跳过。 | 已造成不一致但仍伪装为 warning。 |
| `error` | 当前操作失败、验证失败、补偿/回滚失败、索引不可用。 | 未脱敏的原始 exception object 或命令 stdout/stderr。 |
| `fatal` | 进程无法安全继续、migration 失败进入只读恢复、不可判定的部分写入。 | 自动退出前未刷新日志，或隐瞒需要人工恢复。 |

日志 level 由预定义设置选择，不接受 renderer/配置文件注入任意 Pino transport 或输出路径。正式默认 `info`；用户启用 `debug` 时显示增加的字段和自动恢复时间，建议在 24 小时后回到默认。

### 2.2 Structured fields

每条日志由事件类型对应的 allowlist 生成，未声明字段在序列化前丢弃。公共字段为：

| 字段 | 说明 |
| --- | --- |
| `timestamp` | UTC ISO 8601；由 logger 统一生成。 |
| `level`、`event`、`message` | Pino level、稳定事件名、无敏感内容的人类可读摘要。 |
| `appVersion`、`runtime`、`platform`、`arch` | 版本和执行环境；`runtime` 仅为 `desktop-main`、`cli` 等受控枚举。 |
| `correlationId` | 一次用户动作/调用链的 ID。 |
| `taskId`、`scanId`、`deploymentId` | 按事件类型允许；不得用配置内容生成。 |
| `phase`、`status`、`durationMs`、`attempt` | 稳定阶段、结果、耗时和有限重试次数。 |
| `toolId`、`resourceType`、`adapterVersion` | 受控枚举和版本。 |
| `pathRef` | 缩略路径或不可逆摘要，不是默认完整绝对路径。 |
| `itemCount`、`successCount`、`failureCount`、`warningCount` | 聚合计数。 |
| `errorCode`、`retryable`、`recoveryAction` | 稳定错误元数据；不直接序列化任意 `Error`。 |

事件专属字段在代码中使用 Zod Schema 定义并由类型派生。禁止通用 `context: Record<string, unknown>`、请求/响应整体、配置 AST、文件内容、数据库 row、Git remote URL、环境变量 map、argv 全量、HTTP header 或 shell command 字符串。

### 2.3 Correlation ID

- UI 用户动作、CLI 命令或启动恢复任务创建根 `correlationId`；IPC、核心用例、scanner、adapter、storage、deployer 和 Git 调用沿上下文传播。
- 每次 scan/deployment 另有稳定任务 ID；重试保留原 `correlationId` 并增加 `attempt`，人工重新发起生成新 ID。
- Chokidar 触发的增量扫描创建新 correlation，并用 `causedByDeploymentId` 关联内部写入；该字段只记录 ID，不记录路径。
- ID 使用随机无语义值，不能编码用户名、路径、时间之外的业务数据。日志、deployment record 和 UI 错误详情用 ID 交叉定位。

### 2.4 路径缩略与敏感字段 allowlist

默认路径展示按最长已知根替换：用户目录为 `~`，项目根为 `<project>`，应用数据目录为 `<app-data>`，备份根为 `<backup-root>`；根外路径仅保留 basename 和短 hash，例如 `<external>/settings.json#7ab2c1`。不同大小写/分隔符先 canonicalize，再缩略，避免通过变体绕过。

仅在用户明确选择“包含完整路径”且导出预览逐项显示时，诊断文件可包含绝对路径；普通日志不因该选项改变。日志只允许上述 structured fields。键名匹配 `token`、`secret`、`password`、`credential`、`authorization`、`cookie`、`privateKey`、`apiKey`、`env` 等（不区分大小写）时，无论 allowlist 与否都替换为 `[REDACTED]`。字符串值还需检测 credential-like pattern；误判时宁可脱敏。

### 2.5 Rolling files

- 日志写入平台应用数据目录下 `logs/`，不得写入项目或扫描目录。目录/文件使用与备份相同的最小权限原则。
- 按大小滚动，默认单文件 10 MiB、最多 10 个滚动文件；同时删除超过 30 天的日志。删除条件取较严格边界以控制暴露面，但当前进程文件和最近一次 fatal 诊断索引不得在写入中删除。
- 滚动使用原子 rename，启动时处理遗留临时文件；磁盘不足时停止 debug/trace 并发出一次可见 warning，不删除有效备份为日志腾空间。
- fatal 前同步刷新受控摘要；无法写日志不能改变业务原子性，错误仍通过 UI/CLI 稳定 envelope 返回。

## 3. 本地诊断导出

诊断导出不同于 support bundle：前者可只导出用户当前看到的一项任务摘要。内容默认包括版本 manifest 摘要、任务/阶段/错误码、聚合计数、缩略路径、adapter 版本和选定时间窗内的脱敏日志。默认不含配置正文、原始文件、备份文件、数据库、Git patch、环境变量、完整路径或凭据。

导出流程必须：选择任务 → 生成候选清单 → 运行 allowlist 和 secret scan → 展示每个文件、大小、字段与排除原因 → 用户精确确认 → 写到用户选择的位置 → 再扫描最终 archive。若最终扫描发现疑似秘密，导出失败并展示字段位置，不提供“一键忽略全部”。

## 4. 备份模型

### 4.1 目录布局

备份位于平台应用数据目录下的专用 `backups/`，不与日志、SQLite 主库、临时写入或 Git working tree 混放：

```text
<app-data>/backups/
  <deployment-id>/
    manifest.json
    files/
      <operation-index>-<opaque-name>.bak
    verification.json
    operation-log.jsonl
```

`opaque-name` 不含原绝对路径；路径映射只存在受保护的 manifest。临时创建使用 `<deployment-id>.tmp`，所有文件写入、fsync 和 hash 校验完成后原子 rename 为正式目录。未完成 `.tmp` 不可作为有效备份。

### 4.2 Manifest

`manifest.json` 使用版本化 Zod Schema，至少包含：`manifestVersion`、`deploymentId`、`correlationId`、`createdAt`、`appVersion`、`databaseSchemaVersion`、`assetSchemaVersion`、`adapterId/version`、目标 platform、每个 operation 的规范化目标路径、备份相对文件名、原文件是否存在、原/备份 SHA-256、mode/ACL 摘要、大小、预览时与执行前 hash，以及 manifest 自身完整性信息。它不得保存配置正文、密钥抽取值或 Git 凭据。

SQLite `deployments` 与 `backups` 记录保存 `deploymentId`、backup directory reference、manifest version/hash、验证状态和保留状态。文件夹是恢复事实，数据库是索引；索引损坏时可通过已验证 manifest 重建关联，但不能通过目录名猜测内容。

### 4.3 权限

- POSIX：backup 根和 deployment 目录目标 mode 为 `0700`，manifest/backup/日志文件为 `0600`，创建时使用限制性 umask；复制后不放宽权限。
- Windows：ACL 只授予当前用户和必要的 SYSTEM，禁用从宽松父目录继承；不得授予 `Everyone`/普通 Users 读取。
- 创建后重新读取 mode/ACL 并验证。不满足最小权限时在任何目标替换前失败。
- 不跟随备份根中的符号链接；canonical path 必须仍位于受控 backup 根。

### 4.4 保留与清理

默认每个规范化目标集合保留**最近 20 个有效 deployment 备份**，并保留**最近 90 天**创建的有效备份。只有同时“排名早于最近 20 个”且“年龄超过 90 天”才有资格自动清理。以下备份受保护，不受自动清理：活动 deployment、最近一次成功 deployment、未解决的 rollback/verification failure、用户 pin、数据库升级前备份，以及其 manifest/文件未通过校验的目录。

清理按“扫描候选 → 验证 DB 引用/文件锁 → 写 cleanup plan → 删除单个目录 → 记录结果”执行，不能与 deployment/rollback 并发。先删除文件内容，再删除目录和索引；部分删除标记 `cleanup_failed` 并保留可诊断记录。磁盘压力只提示用户并允许精确预览清理候选，不能违反保护规则自动清空。用户修改保留策略时应显示预计占用和将受影响的 deployment。

### 4.5 备份校验与 deployment 关联

替换目标前必须验证：备份目录权限正确、manifest Schema 通过、每个声明文件存在、大小/hash 与原目标一致、operation 数量匹配 deployment plan、备份可读且 fsync 完成。成功替换后再次抽样/全量（MVP 默认全量）读取备份并记录 `verification.json`。

回滚只接受 manifest hash 与 deployment record 一致且文件 hash 验证通过的备份。校验失败时不尝试“最接近”文件；进入备份丢失/损坏 runbook。一个备份只关联一个 deployment，但一个批量 deployment 可含多个 target operation。

## 5. 恢复总则

所有 runbook 都遵循：停止产生新写入 → 记录版本/错误码/correlation ID → 保全 DB、WAL、operation log、backup manifest 和当前目标 hash → 判断事实状态 → 预览恢复计划 → 执行最小动作 → 验证源文件和索引 → 记录结果。不得从失败日志直接复制未审查 shell 命令，也不得为了“重试”先删除数据库或备份。

若 UI 和 CLI 仍可用，优先使用受控恢复命令；手工文件操作是最后手段，并在副本上进行。任何 runbook 遇到 hash 与记录不符时立即停止自动化，避免覆盖用户在故障后做的新修改。

## 6. Runbook：数据库 migration 失败

1. 停止新的 scan、deployment、rollback 和 Git 写操作；应用进入只读恢复模式，不重复自动 migration。
2. 记录应用版本、DB `user_version`/migration 表、稳定错误码、correlation ID、DB/WAL/SHM 是否存在和文件 hash；日志只保留脱敏摘要。
3. 验证启动前数据库备份的 manifest、大小和 SHA-256。若不存在或损坏，跳到备份丢失 runbook，不覆盖现库。
4. 在临时副本对当前 DB 执行 SQLite integrity check，并确认 migration 是“未开始、事务已回滚、已完成但版本未记账”中的哪种状态；禁止猜测后手改版本号。
5. 若事务完整回滚且 integrity 正常，修复环境原因（磁盘、权限、锁）后只重试一次受控 migration；重试仍失败则保持只读。
6. 若 DB 不一致，预览并由用户确认恢复启动前备份；保留失败 DB 副本供诊断，不在原文件上实验。
7. 恢复/迁移后执行 integrity check，核对 migration 序列、deployment/backup 关联和只读查询，再重新扫描文件重建可派生索引。
8. 记录恢复结果和禁止降级状态；只有全部校验通过才重新开放部署。

## 7. Runbook：扫描中断

1. 将对应 ScanRun 状态标记为 `failed`，记录结构化 `reason: "PROCESS_INTERRUPTED"`，并停止其 worker/watch 回调；扫描中断本身不触发配置写入。
2. 记录 correlation ID、最后 phase、已处理/失败计数、staging transaction 和 Chokidar 队列状态。
3. 检查 SQLite 是否存在未提交 staging；回滚未提交事务，保留上一次完整索引，不混合半次扫描结果。
4. 若中断来自进程崩溃，验证 DB integrity 和允许扫描根；若来自用户取消，确认取消事件顺序和无运行中解析器。
5. 合并中断期间的文件变化为一次全量/边界重扫，不逐条重放可能缺失的 watcher 事件。
6. 启动新 `scanId`，校验部分损坏文件产生诊断但不阻断其他文件；比较最终文件 hash 与索引。
7. 恢复 Chokidar 监听并记录新旧 scan 的关联；不修改任何源配置。

## 8. Runbook：替换前 deployment 失败

适用于目标 hash 冲突、备份/权限/临时文件/fsync 失败，且 operation log 证明没有执行任何原子替换。

1. 锁定 deployment，禁止直接重试；读取 operation log，确认所有 operation 都处于 `planned`/`backed_up`/`temp_written` 而非 `replaced`。
2. 重新计算每个目标 hash 并与预览/执行前 hash 比较；任何外部变化都要求重新生成预览。
3. 验证目标文件未变。若有差异或无法判定，转“部分替换失败”runbook。
4. 删除仅属于本 deployment 且 hash 可核对的临时文件；不得按通配符删除目标目录内容。
5. 有效备份保留并标记失败原因；不完整 `.tmp` 目录按清理计划隔离，不宣称可回滚。
6. 修复磁盘、权限或锁后重新生成完整 diff、备份计划和确认；不要复用旧确认。
7. 记录失败终态与恢复动作，验证没有配置写入后解除锁。

## 9. Runbook：部分替换失败

1. 立即停止后续 operation 和该目标集合的 scan/watch-triggered deployment；不要再次执行正向写入。
2. 从持久化 operation log 逐项列出 `replaced`、`not_started`、`unknown`，读取当前 hash；以文件事实为准，不只信内存状态。
3. 验证 backup manifest、每个原文件 hash 和权限。任一备份缺失/损坏时停止自动补偿并进入备份丢失 runbook。
4. 生成逆序补偿预览：只恢复当前 hash 等于本 deployment 写入 hash 的文件。若用户/外部进程随后修改，标为冲突并等待选择。
5. 用户确认后按相反顺序恢复已替换文件，每次原子写入并 fsync；每步追加 operation log。
6. 逐个验证恢复 hash、mode/ACL 和原先“不存在”的目标仍不存在；失败时将 DeploymentRecord 状态标记为 `failed`，并记录 `failureStage: "rolling_back"` 和结构化 `reason`，保留所有证据。
7. 完成后全量重扫受影响根，核对 EffectiveConfig 和 deployment/backup 状态；只有全部恢复验证通过才标记 `rolled_back`。
8. 保留此备份和日志直至问题关闭，不参与自动保留清理。

## 10. Runbook：验证失败

1. 将 DeploymentRecord 状态标记为 `failed`，记录 `failureStage: "verifying"` 和结构化 `reason: "VERIFICATION_FAILED"`；停止关联 watcher 触发的自动动作，并保存写入后 hash 和验证诊断。
2. 区分“重新扫描失败”“Schema/语义不一致”“目标工具不可读取”和“外部并发修改”。不得以文本存在替代语义验证。
3. 检查当前目标 hash 是否仍等于 deployment 输出。若已漂移，停止自动回滚并要求冲突处理。
4. 验证备份和操作日志，生成回滚 diff 与预计影响，向用户明确验证失败原因。
5. 执行受控逆序回滚；恢复后重新扫描并验证原始语义、hash、权限和索引。
6. 若回滚验证成功，将 DeploymentRecord 状态标记为 `rolled_back` 并记录 `cause: "VERIFICATION_FAILED"`；若失败，将状态标记为 `failed`，记录 `failureStage: "rolling_back"` 和结构化 `reason`，并转部分替换 runbook 的人工分支。
7. 修复转换/适配器前新增该输入的合成 fixture 与 golden 回归测试；旧失败 deployment 不可改写成成功。

## 11. Runbook：索引损坏

1. 禁止 deployment 和 migration，只读访问文件；记录 SQLite 错误、版本和 DB/WAL/SHM hash。
2. 在副本运行 integrity check，确认是主库损坏、WAL 不完整、Schema 不兼容还是查询/代码错误。
3. 导出仍可读的非派生元数据清单，尤其 deployment、backup、用户设置和 migration 版本；不把配置正文加入诊断包。
4. 验证最近数据库备份。若恢复备份，先保留损坏副本并预览将丢失的历史区间。
5. 对可重建的 tools/projects/scopes/assets/diagnostics 索引创建全新数据库并从事实来源文件全量扫描；不得用损坏 row 覆盖文件。
6. 从已验证 manifest 重建 backup 关联；无法证明的记录标为 orphaned，不能用于自动回滚。
7. 执行 integrity check、外键检查、Schema 版本检查和 EffectiveConfig 抽样；通过后原子切换新 DB。
8. 恢复监听和写入前运行一次只读 scan；保留损坏 DB 直至用户确认清理。

## 12. Runbook：备份丢失或损坏

1. 立即禁止依赖该备份的 rollback；不要创建同 ID 空目录、修改 manifest 或从其他 deployment 猜测替代。
2. 核对 DB backup record、规范化 backup path、manifest hash、文件权限和清理日志，排除索引路径错误。
3. 在受控 backup 根查找具有同 `deploymentId` 且 manifest hash 匹配的有效目录；不扫描/上传用户全盘。
4. 若存在用户明确管理的外部副本，先复制到隔离目录并验证完整 manifest、每文件 hash 和版本；不要直接从外部位置回滚。
5. 生成当前目标与可得历史/源资产的只读 diff。没有可验证备份时，自动回滚不可用，只能由用户基于 Git、工具自身历史或人工重建选择恢复内容。
6. 在任何人工恢复前再备份当前状态，避免覆盖故障后的有效修改；精确预览每个目标。
7. 恢复后全量扫描和语义验证，把原 DeploymentRecord 状态标记为 `failed` 并记录结构化 `reason: "BACKUP_UNAVAILABLE"`，不得改写历史。
8. 调查是权限、磁盘、手工删除还是清理竞态；修复保护规则并新增故障注入测试。

## 13. Runbook：Git 同步冲突

1. 停止自动 pull/push/merge 和基于冲突 worktree 的 deployment；保留用户当前 branch、HEAD、index 和 working tree。
2. 记录仓库缩略标识、当前/上游 commit、冲突文件列表和 correlation ID；不记录 remote URL 凭据或文件正文到普通日志。
3. 执行只读 status，区分未提交本地修改、非 fast-forward、文本冲突、删除/修改冲突和凭据/网络错误。网络错误不得伪装为内容冲突。
4. 创建受控恢复点（例如经用户确认的本地 commit 或 Git 原生 stash）；工具不得自动 force push、reset --hard 或删除 untracked 文件。
5. 向用户展示逐文件 base/local/remote 来源和冲突标记预览。AI Config Hub 可辅助选择，但不执行配置中的 Hook/Skill/MCP。
6. 用户解决后验证 Git index 无未合并项，对受影响配置运行 adapter parse/diagnose 和 secret scan。
7. 在生成 deployment 前重新扫描并重新计算 hash；旧预览和确认全部失效。
8. push 仅在用户明确确认且 remote 未再次前进时执行；失败保留本地恢复点和冲突记录。

## 14. Support bundle

support bundle **只在用户主动点击/执行导出命令时生成**，不在崩溃、更新或错误发生时自动创建/上传。默认内容为：

- `bundle-manifest.json`：应用/CLI、OS/架构、Node/Electron、DB/asset/adapter 版本，生成时间和每个 bundle 文件 hash。
- 选定时间窗的脱敏 Pino 日志与任务摘要。
- SQLite integrity/migration 状态的聚合结果，不含数据库文件和 row 内容。
- 适配器 capability/版本、扫描/部署状态计数、错误码和缩略路径。
- 用户选择纳入的兼容性检查结果，例如 glibc symbol/smoke 摘要。

默认明确排除：所有配置/Rule/Agent/Skill/MCP 正文，原始输入与 golden 以外的用户文件，backup 文件，SQLite/WAL/SHM，Git diff/patch/remote URL，用户名、完整 home/项目路径，环境变量，argv 自由文本，剪贴板，Token、Cookie、SSH key、API key 和其他凭据。

### 14.1 精确预览与导出流程

1. 用户选择 correlation/task 和时间范围；系统不默认选择“全部历史”。
2. 在内存/受控临时目录生成候选，逐文件应用 allowlist、路径缩略和 secret scan。
3. UI/CLI 显示**精确预览**：最终文件名、大小、字段名、每类记录数量、路径是否完整、每项排除/脱敏说明，以及 archive 总大小。
4. 用户可逐项取消；选择包含完整路径或额外文件时再次显示风险和该项精确内容预览。配置正文与凭据没有“快速全选”。
5. 用户明确确认目标位置后生成 archive；使用随机限制性临时目录，完成后清理。
6. 对最终 archive 解包视图再运行 Schema/secret scan，生成 hash；失败则不导出并报告疑似字段位置。
7. 本地导出不等于同意上传。产品不提供默认接收端；用户自行决定如何传递。

支持人员必须用 bundle 中的 correlation ID、稳定错误码和版本证据进行定位，不要求用户关闭脱敏或直接发送整个应用数据目录。

## 15. 运维验证清单

- 日志 level、rolling、权限、磁盘不足、路径缩略和敏感字段 allowlist 有自动化测试。
- desktop、CLI、IPC error、诊断导出与 support bundle 的脱敏结果一致。
- 每个 deployment 在替换前都有已校验备份，并能通过 `deploymentId` 找到 manifest 与 operation log。
- 保留策略不会删除活动、最近成功、失败恢复、pin 或 migration 前备份。
- 八类 runbook 都有至少一个确定性故障注入演练，部分替换/回滚失败必须三平台覆盖。
- 默认安装无遥测网络请求；support bundle 只由用户触发且导出前显示精确预览。
