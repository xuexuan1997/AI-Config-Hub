# 构建、发布与兼容性工程

| 项目 | 内容 |
| --- | --- |
| 目的 | 规定可复现构建、三平台产物、Linux glibc 2.28 证明、版本协商、升级与降级保护。 |
| 目标读者 | 构建/发布工程师、平台维护者、应用工程师、安全审查者和发布审批者。 |
| 状态 | MVP 技术基线；CI、签名和发布凭据 hook 在实现阶段接入，未满足门禁不得标记正式版。 |
| 相关文档 | [仓库与工具约定](../development/repository-and-tooling.md) · [测试策略](../development/testing-strategy.md) · [数据存储](../architecture/data-storage.md) · [安全设计](../architecture/security.md) · [可观测与恢复](./observability-and-recovery.md) · [已确认技术方案](../superpowers/specs/2026-06-21-technical-solution-design.md) |

## 1. 发布产物契约

每次发布由同一受保护 commit 和唯一版本号生成。草稿/正式发布页面只能引用经审批的 CI 产物，不接受开发机手工构建替换。

| 产物 | 目标 | 最低要求 |
| --- | --- | --- |
| Windows installer | Windows 支持架构 | electron-builder 生成的安装程序；包含应用版本、卸载入口和签名 hook；安装后执行首次启动。 |
| macOS installer | macOS 支持架构 | installer（例如 DMG/PKG 由实施选型固定）；包含签名和 notarization hook；验证安装、首次启动和 Gatekeeper 结果。 |
| Linux AppImage | Linux 支持架构 | 可执行 AppImage；在支持发行版启动 Electron，记录运行库与沙箱行为。 |
| Linux archive | Linux 支持架构 | 压缩 archive（固定为 `.tar.gz` 或实现时批准的格式）；解压后可直接启动并附启动说明。 |
| 独立 CLI | Windows、macOS、Linux | 不包含/启动 Electron，不依赖 desktop 安装；发布 Node.js CLI 入口、支持的 Node.js LTS 范围、许可证和第三方声明；平台相关 native 依赖必须分产物。 |
| `SHA256SUMS` | 所有下载文件 | 按最终字节生成 SHA-256，文件名排序稳定；校验和文件签名能力作为发布 hook。 |
| release notes | 用户与运维 | 新增、修复、已知问题、兼容变化、安全影响、升级/回滚要求和不兼容降级警告。 |
| version manifest | 自动化与支持 | 机器可读 JSON，关联所有产物、Schema/adapter 版本、工具链、基线镜像、hash 和签名状态。 |

所有 archive/installer 内部必须包含版本、许可证和构建 commit。调试符号与 source map 作为受访问控制的内部产物保存，不默认随公开包分发；公开 source map 不得含绝对路径、凭据或构建环境秘密。

### 1.1 Version manifest

`version-manifest.json` 至少包含：

```json
{
  "releaseVersion": "1.2.3",
  "commit": "<full-commit-sha>",
  "buildId": "<ci-run-id>",
  "builtAt": "<utc-iso-8601>",
  "nodeVersion": "<pinned-version>",
  "electronVersion": "<pinned-version>",
  "pnpmVersion": "<pinned-version>",
  "databaseSchemaVersion": 7,
  "assetSchemaVersion": "3.0.0",
  "adapterApiVersion": 1,
  "adapters": {
    "claude-code": "1.0.0",
    "cursor": "1.0.0",
    "codex": "1.0.0",
    "opencode": "1.0.0"
  },
  "linuxBaseline": {
    "glibc": "2.28",
    "imageDigest": "sha256:<baseline-image-digest>"
  },
  "artifacts": [
    {
      "name": "<artifact-file-name>",
      "platform": "linux",
      "arch": "x64",
      "sha256": "<sha256>",
      "signatureStatus": "verified"
    }
  ]
}
```

构建时占位符必须全部替换；manifest Schema 校验失败、产物未列出或 hash 不一致均阻断发布。`builtAt` 不参与可重复字节比较；构建系统应通过 `SOURCE_DATE_EPOCH`、稳定排序和固定工具链减少无意义差异。

## 2. CI 发布流水线

流水线按以下顺序执行。各阶段输出只被下游按 digest 引用，不能在阶段间重新从不固定来源下载同名产物。

1. **源校验**：确认受保护 tag 指向受保护分支 commit、工作树来源唯一、SemVer 与 manifest/`package.json` 一致；扫描禁止的秘密、未批准大文件和未锁定 action/image。
2. **工具链与依赖安装**：启用根 `packageManager` 固定的 pnpm，通过 Corepack 安装，使用固定 Node.js/Electron；执行 `pnpm install --frozen-lockfile`，保存 lockfile hash、SBOM 和依赖审计结果。
3. **静态检查**：运行 `pnpm typecheck`、`pnpm lint`、包 `exports`/deep import/循环依赖检查、许可证与安全策略检查。
4. **测试**：运行 unit、四工具 × 四资源 adapter contract、integration、IPC contract；构建 Electron 后运行受影响平台 E2E。测试证据必须与 commit 绑定。
5. **三平台构建**：Windows runner 构建 Windows installer，macOS runner 构建 macOS installer，glibc 2.28 基线 Linux 环境构建 Linux AppImage/archive 和相应 CLI；禁止用跨平台打包结果替代原生安装验证。
6. **签名/notarization hook**：只有受保护发布 job 可读取短期签名身份。Windows code signing、macOS signing/notarization 和可选校验和签名在此接入；日志禁止输出凭据。未配置正式凭据时只能产出明确标记的内部 unsigned 候选，不能发布为正式版。
7. **安装与启动测试**：在干净 VM/runner 安装实际候选。启动 Electron、执行只读首次扫描 smoke；在无 desktop 依赖环境运行 CLI `--version`、`--help` 和合成目录 `scan --json`。
8. **兼容与迁移测试**：运行 glibc 2.28 检查、native binary 审计、runtime symbol inspection、受支持旧 DB 升级、回滚和禁止不兼容降级场景。
9. **校验和与最终 manifest**：对不会再修改的最终文件生成 `SHA256SUMS` 和 `version-manifest.json`；重新验证签名、hash、文件名和产物清单。
10. **staging 发布**：上传到不可变候选区，生成 release notes 和证据索引。下载 staging 产物重新校验一次，防止上传替换或损坏。
11. **人工发布审批**：发布负责人核对门禁；涉及安全、migration、native dependency 或不兼容变化时要求对应所有者共同审批。审批记录必须引用 commit、manifest hash 和 CI run。
12. **正式发布与发布后 smoke**：以原字节晋升 staging 产物，不重新构建；验证公开下载、校验和、安装/启动和版本上报。失败按发布回撤流程停止分发并保留证据。

CI cache 以 OS、架构、lockfile、Node/Electron/pnpm 和基线镜像 digest 为键。cache 只能加速，不作为未校验二进制来源；恢复 cache 后仍运行完整性检查。

## 3. glibc 2.28 兼容基线

Linux desktop 与 CLI 的最低运行时基线是 glibc 2.28。兼容性是发布属性，不是“能在 CI runner 运行”的推断。

### 3.1 基线镜像

- 维护专用 OCI build/test image，用户态 glibc 固定为 2.28；Dockerfile、基础镜像 digest、编译器和系统包版本进入版本控制和评审。
- release job 必须按 image digest 使用，不使用移动 tag。镜像重建视为构建基础设施变更，先产出非发布候选并比较二进制/符号证据。
- Linux CLI 和可控 native addon 在相同或更低基线中构建。AppImage 打包过程不得从较新 runner 混入未审计系统库。
- Electron 自带二进制仍需在实际支持的 glibc 2.28 目标环境进行启动测试；仅检查应用 JS bundle 不足以证明 Electron 兼容。

### 3.2 原生二进制审计

构建后递归枚举 AppImage、archive、CLI 包及 Electron resources 中的 ELF 文件和 `.node` addon，记录文件 hash、架构、解释器、`NEEDED` 动态库和 RPATH/RUNPATH。出现以下情况阻断发布：

- 未在 SBOM/version manifest 证据中归属的 ELF 或下载后二进制。
- 架构与产物不一致、绝对构建路径 RPATH、依赖未允许系统库，或捆绑冲突的 glibc。
- native addon 未同时验证 Electron ABI 与独立 CLI 的 Node.js ABI。
- 安装脚本在构建后从网络取得未锁定/未校验内容。

### 3.3 Runtime symbol inspection

对每个 ELF 使用 `readelf --version-info`、`objdump -T` 或经批准的等价工具，提取 `GLIBC_*`、`GLIBCXX_*`、`CXXABI_*` 要求。自动规则拒绝任何高于批准基线的 GLIBC 符号；C++ runtime 上限由基线镜像的兼容清单固定。还应在基线容器用动态加载器实际执行，捕获静态扫描遗漏的 `dlopen` 插件。

符号检查命令、工具版本、原始输出摘要、最高符号和 ELF hash 都写入 `compatibility-evidence/linux/<release>/symbols.json`（或等价不可变 CI artifact），不可只保留绿色状态。

### 3.4 运行验证

每个 Linux 候选至少完成：

1. 在 glibc 2.28 基线环境运行独立 CLI `--version`、`--help` 和合成夹具只读 `scan --json`，确认不加载 Electron。
2. 在目标 Linux VM 启动 archive 中的 Electron，等待主窗口 ready，执行只读 scan smoke 并正常退出。
3. 对 AppImage 重复启动、扫描和退出；记录 FUSE/fallback、sandbox 和权限结果。
4. 运行一个会加载 SQLite/native addon/文件监听路径的 smoke，避免只测试惰性加载前的 `--version`。
5. 保存镜像 digest、发行版、kernel、架构、glibc 实际版本、命令退出码、日志脱敏结果和产物 SHA-256。

每版都必须保留上述证据，保留期不得短于该版本支持期。证据缺失等价于兼容性未验证。

## 4. 版本模型

### 4.1 产品 SemVer

desktop 与 CLI 默认共享产品 SemVer：

- `MAJOR`：公开 CLI/JSON/IPC 行为、持久化或用户配置出现需要显式迁移的破坏性变化。
- `MINOR`：向后兼容的新能力、新工具/资源支持或可选 Schema 字段。
- `PATCH`：保持兼容的缺陷、安全或打包修复。

预发布使用 `-alpha.N`、`-beta.N`、`-rc.N`。同一版本号不可重新发布不同字节；修复必须增加版本。release notes 需分别说明 desktop、CLI、adapter、Schema 和平台影响。

### 4.2 独立版本轴

- `databaseSchemaVersion`：Drizzle migration 的单调整数；数据库记录应用过的 migration 和创建/最后升级产品版本。
- `assetSchemaVersion`：统一 Asset/EffectiveConfig 规范化表示版本，类型是 SemVer 字符串（例如 `"3.0.0"`）；读取方必须显式升级旧表示或返回不支持错误。
- `adapterApiVersion`：编译时适配器契约的整数主版本，MVP 固定为数值 `1`；注册表拒绝不匹配实现。它不是 SemVer，也不能与 `adapterVersion` 混用。
- adapter version：每个工具适配器独立 SemVer，写入扫描、诊断和 deployment 历史，用于解释行为差异。
- 外部工具支持范围：适配器声明经过测试的工具版本区间；未知更高版本产生保守诊断，不能伪装为完全支持。

这些版本全部写入 version manifest 和相关记录。产品版本不能替代 Schema/adapter 版本，也不能从当前代码推测历史记录当时使用的适配器。

## 5. 升级、回滚与降级政策

### 5.1 支持升级路径

- 每个正式版声明可直接升级的最老产品版本和 DB Schema。超出跨度时提供分段升级路径，例如 `N-2 → N-1 → N`，不得让用户试错。
- 启动时先读取 manifest/DB metadata，确认应用、数据库和资产 Schema 可兼容，再创建备份并运行 migration。
- migration 在业务读写前完成；失败时保持/恢复原 DB，应用进入可诊断的只读恢复状态，禁止部署。
- 迁移测试使用每个受支持旧版本生成的真实结构化测试库，不使用当前 Schema 伪造旧版本。
- 文件配置是事实来源。索引可重建，但 deployment 历史、备份关联和用户设置在迁移前必须备份并校验。

### 5.2 应用回滚兼容

发布前为前一受支持版本执行“升级到候选后再回退应用”的测试，并据此在 manifest 标记：

- `rollbackSafe`：旧应用可以安全读取当前 DB/asset 版本；允许应用二进制回退。
- `requiresDatabaseRestore`：必须恢复升级前数据库备份后才能启动旧应用。
- `notSupported`：存在不可逆用户操作或格式变化；只能前进修复，release notes 必须显著说明。

应用回滚与配置 deployment 回滚是两个不同流程。卸载/安装旧应用不得自动删除数据库、配置或备份；恢复动作必须先预览目标和将丢失的较新记录。

### 5.3 禁止不兼容降级

若应用检测到数据库、asset Schema、adapter record 或设置版本高于其支持上限，必须在任何写入前停止，返回稳定错误 `INCOMPATIBLE_DOWNGRADE`，显示：当前版本、发现的版本、最低可用应用版本、可用升级/数据库恢复路径和备份位置。禁止：

- 自动“尽力”删除未知列/字段后继续。
- 用较旧 migration 覆盖较新数据库。
- 为了启动而重建数据库并静默丢失 deployment/backup 历史。
- 在用户未确认和未验证备份时替换数据库。

只读导出若能证明不会改变文件、DB、WAL 或设置，可由专门恢复模式提供；普通应用/CLI 启动不得绕过降级保护。

## 6. 发布撤回与 hotfix

发现安装失败、签名撤销、glibc 基线违反、迁移损坏、秘密泄漏或无法可靠回滚时，立即停止下载晋升并标记 release withdrawn。发布页保留原因与受影响 hash，不用同版本覆盖文件。hotfix 从已知 commit 建新 PATCH 版本，重跑全部发布门禁；仅修改 JS 也不能跳过安装、迁移和 glibc 证据。

若问题发生在发布后，支持指引必须区分：卸载/回退应用、恢复应用 DB、回滚某次配置 deployment、重建索引。任何建议执行前先精确预览和验证现有备份，禁止建议用户直接删除数据库或备份目录。

## 7. 每版证据清单

- 受保护 commit/tag、审批记录、CI run、工具链和 runner/image digest。
- `pnpm-lock.yaml` hash、SBOM、许可证与依赖/native audit。
- unit/contract/integration/IPC/E2E/安装/迁移/回滚/秘密脱敏结果。
- 各产物文件、大小、平台/架构、SHA-256、签名/notarization 状态。
- Linux ELF 清单、runtime symbol inspection、glibc 2.28 CLI smoke、Electron AppImage/archive 启动证据。
- version manifest Schema 校验结果、release notes 和 `SHA256SUMS` 二次下载校验。
- 发布后 smoke 或撤回记录。证据必须应用与产品日志相同的敏感字段 allowlist。
