# 工具资产定义与迁移评审

状态：调研记录  
最后核验日期：2026-07-04  
范围：本仓库内置适配器：Claude Code、Codex、Cursor、OpenCode。

本文档记录各支持工具对主要可复用资产的原生定义，并基于这些定义评审
AI Config Hub 当前资产发现、诊断和迁移设计。重点放在产品行为上：当用户
审查或迁移资产时，哪些原生语义理应被保留。

## 资料来源

本次评审核验的官方文档：

- Claude Code：[skills](https://code.claude.com/docs/en/skills)、
  [subagents](https://code.claude.com/docs/en/sub-agents)、
  [memory and rules](https://code.claude.com/docs/en/memory)、
  [MCP](https://code.claude.com/docs/en/mcp)。
- Codex：[skills](https://developers.openai.com/codex/skills)、
  [AGENTS.md](https://developers.openai.com/codex/guides/agents-md)、
  [subagents](https://developers.openai.com/codex/subagents)、
  [MCP](https://developers.openai.com/codex/mcp)、
  [config basics](https://developers.openai.com/codex/config-basic)。
- Cursor：[skills](https://cursor.com/docs/skills.md)、
  [rules](https://cursor.com/docs/rules.md)、
  [subagents](https://cursor.com/docs/subagents.md)、
  [MCP](https://cursor.com/docs/mcp.md)。
- OpenCode：[skills](https://opencode.ai/docs/skills.md)、
  [rules](https://opencode.ai/docs/rules.md)、
  [agents](https://opencode.ai/docs/agents.md)、
  [MCP servers](https://opencode.ai/docs/mcp-servers/)。

## 统一词汇

仓库当前在 `packages/core/src/domain/resource.ts` 中归一化了四类资源：
`rule`、`agent`、`skill` 和 `mcp`。这四个名称有助于跨工具比较，但它们并
不等同于各工具的原生资产定义。

Rule 类资产表示持久化指令。取决于工具，它可能是普通 Markdown、带
frontmatter 的规则文件、层级化指令链、按路径触发的规则、导入引用，或受
管理策略生成的文本。

Agent 类资产定义一个专门助手或子代理。它通常包含提示词正文、用于路由的
描述、模型选择、工具或权限控制，有时还包含后台模式、记忆、嵌套 Skill、
MCP 访问和 Hook 等生命周期选项。

Skill 类资产不只是一个名称。在当前几个工具中，Skill 都是以 `SKILL.md` 为
中心的目录包。这个包可以包含元数据、指令、脚本、参考资料、资源或模板、
依赖元数据，以及工具特有的激活控制。有些工具还要求 Skill 名称必须与父目
录一致。

MCP 类资产定义外部工具服务器。所有支持工具都能表达本地 stdio 服务器和远
程 HTTP 风格服务器，但每个工具都有自己的作用域、优先级、认证、变量插值
和按 Agent 或工具维度的开关语义。

还有一些官方资产家族目前不在归一化模型中，例如 Hook、命令、插件、策略、
记忆和外部引用。如果这些内容继续保持不支持，产品应在审查和迁移时明确说
明。

## Claude Code

### 规则与记忆

Claude Code 使用 `CLAUDE.md` 文件承载持久化指令。支持的作用域包括受管
理、用户、项目和本地文件。项目指令可以放在 `./CLAUDE.md` 或
`./.claude/CLAUDE.md`；个人项目偏好使用 `./CLAUDE.local.md`。Claude 在
启动时加载工作目录上方的层级文件，并可以按需加载子目录中的指令。

大型项目可以使用 `.claude/rules/**/*.md`。规则可以带 YAML frontmatter，
通过 `paths` glob 控制路径级激活。没有 `paths` 的规则会无条件加载。
Claude 还支持在 `CLAUDE.md` 中通过 `@path` 导入其他文件，并支持递归导入。

### Agent

Claude Code 子代理是带 YAML frontmatter 和 Markdown 提示词正文的
Markdown 文件。项目子代理位于 `.claude/agents/`；用户子代理位于
`~/.claude/agents/`；受管理设置、CLI `--agents` 和插件 Agent 也受支持。
Claude 会递归扫描 `.claude/agents/`。在普通项目和用户作用域中，子代理身
份来自 frontmatter 的 `name`，而不是文件名或子目录。

官方支持的子代理元数据远多于 `name`、`model` 和 `tools`。字段包括
`description`、`prompt` 或 Markdown 正文、`tools`、`disallowedTools`、
`model`、`permissionMode`、`mcpServers`、`hooks`、`maxTurns`、`skills`、
`initialPrompt`、`memory`、`effort`、`background`、`isolation` 和
`color`。

### Skill

Claude Code Skill 是 Skill 目录。用户输入的命令来自目录名，每个目录内包
含一个必需的 `SKILL.md`。该文件由 YAML frontmatter 和 Markdown 正文组
成。frontmatter 可以包含 `name`、`description`、`when_to_use`、
`argument-hint`、`arguments`、`disable-model-invocation`、
`user-invocable` 和 `paths`。

Skill 目录可以包含其他文件，例如 `reference.md`、`examples.md`、
`scripts/` 和其他辅助文件。`SKILL.md` 应该引用这些文件，让 Claude 知道
何时加载或执行它们。Claude 在 Skill 内支持 `${CLAUDE_SKILL_DIR}` 和
`${CLAUDE_PROJECT_DIR}` 等替换变量。

Skill 的作用域和优先级是工具特有语义：企业、个人、项目和插件 Skill 可以
同时存在。嵌套 `.claude/skills` 目录会根据 Claude 当前工作位置被发现；嵌
套项目 Skill 可能以带目录限定的名称出现。

### MCP

Claude Code 支持本地、项目、用户、插件提供和连接器 MCP 服务器。项目 MCP
存储在项目根目录的 `.mcp.json`，顶层为 `mcpServers`；本地和用户作用域存
储在 `~/.claude.json`。如果本地、项目和用户作用域中出现同名服务器，
Claude 使用最高优先级来源的完整服务器条目，而不是合并字段。

项目 `.mcp.json` 支持在 `command`、`args`、`env`、`url` 和 `headers` 中
做环境变量展开。缺少必需变量会导致配置解析失败。

## Codex

### 规则与项目指引

Codex 使用 `AGENTS.md` 承载持久化指引。全局指引位于 Codex home 目录；项
目指引会从项目根目录向当前工作目录查找。每个目录中，Codex 依次检查
`AGENTS.override.md`、`AGENTS.md`，再检查配置的 fallback 文件名。每个目
录最多加载一个文件。距离当前工作目录更近的文件出现在合并提示词的后面，
因此可以覆盖更早的指引。空文件会被跳过，`project_doc_max_bytes` 控制总
加载大小。

Codex 也有分层 `config.toml`。用户配置位于 `~/.codex/config.toml`；项目
作用域的 `.codex/config.toml` 只会在受信任项目中加载，并按项目根到当前目
录的路径解析。

### Agent

Codex 自定义 Agent 是位于 `~/.codex/agents/` 或 `.codex/agents/` 下的独
立 TOML 文件。每个文件定义一个 Agent。必需字段是 `name`、`description`
和 `developer_instructions`。可选字段包括 `nickname_candidates`、`model`、
`model_reasoning_effort`、`sandbox_mode`、`mcp_servers` 和
`skills.config`，自定义 Agent 还能覆盖支持的会话配置。

### Skill

Codex Skill 使用开放 Agent Skills 包结构。一个 Skill 是包含必需
`SKILL.md` 的目录，并可带有 `scripts/`、`references/`、`assets/` 和
`agents/openai.yaml` 元数据。`SKILL.md` 必须包含 `name` 和 `description`。
Codex 使用渐进式披露：Skill 列表只暴露名称、描述和路径；只有当 Codex 选
择某个 Skill 时，才加载完整指令。

仓库 Skill 从当前工作目录到仓库根目录路径上的 `.agents/skills` 目录中发
现。用户、管理员和系统内置 Skill 也可能可用。重名 Skill 不会合并；两者
都可能出现在 Skill 选择器中。

### MCP

Codex 将 MCP 配置存储在 `config.toml` 的 `[mcp_servers.<name>]` 下。用户
配置位于 `~/.codex/config.toml`；受信任项目可以使用 `.codex/config.toml`。
stdio 服务器支持 `command`、`args`、`env`、`env_vars`、`cwd` 和远程执行
设置。Streamable HTTP 服务器支持 `url`、Bearer token 环境变量、静态
header、环境变量 header、OAuth 和超时。服务器还可以设置启用、必需、按工
具启用或禁用，以及审批规则。

## Cursor

### 规则

Cursor 项目规则是 `.cursor/rules` 下的 `.mdc` 文件。该目录中的普通 `.md`
文件会被规则系统忽略。规则 frontmatter 通过 `alwaysApply`、`description`
和 `globs` 控制加载方式：始终加载、模型判断加载、按文件模式加载，或手动
`@` 调用。

Cursor 也支持 `AGENTS.md` 作为简单 Markdown 替代方案。`AGENTS.md` 可以放
在项目根目录和子目录；嵌套指令会与父级合并，更具体的指令拥有更高优先级。

### Agent

Cursor 子代理是带 YAML frontmatter 和提示词正文的 Markdown 文件。项目文
件可位于 `.cursor/agents/`，并兼容读取 `.claude/agents/` 和
`.codex/agents/`；也支持用户级等价目录。项目子代理在名称冲突时优先，且
`.cursor/` 优先于兼容目录。

Cursor 官方子代理字段包括 `name`、`description`、`model`、`readonly` 和
`is_background`。`name` 可以从文件名推导，但 `description` 才是自动委派
的主要信号。

### Skill

Cursor Agent Skills 是开放标准 Skill 包。项目位置包括 `.agents/skills/`
和 `.cursor/skills/`，也支持用户级等价目录，以及 Claude 和 Codex Skill
兼容目录。每个 Skill 是包含 `SKILL.md` 的文件夹；可选的 `scripts/`、
`references/` 和 `assets/` 目录都是包的一部分。

`SKILL.md` frontmatter 必须包含 `name` 和 `description`。Cursor 还要求
`name` 只能使用小写字母、数字和连字符，并且必须与父目录匹配。`paths` 可
将 Skill 限定到匹配文件，`disable-model-invocation` 会阻止模型自动选择该
Skill。Cursor 会发现仓库内的嵌套 Skill root，并将嵌套项目 Skill 限定到
其所在目录。

### MCP

Cursor MCP 配置使用顶层 `mcpServers` 的 `mcp.json`。项目配置是
`.cursor/mcp.json`；全局配置是 `~/.cursor/mcp.json`。Cursor 支持 stdio、
SSE 和 Streamable HTTP transport，也支持工具、prompt、resource、root、
elicitation 和 app 等协议能力。

stdio 配置包括 `type`、`command`、`args`、`env` 和 `envFile`；远程服务器
使用 `url`、`headers`、OAuth 或静态 auth，以及插值。支持的插值包括环境
变量、用户 home、workspace folder、workspace basename 和路径分隔符变量。

## OpenCode

### 规则

OpenCode 使用 `AGENTS.md` 作为项目规则，并可回退到 Claude Code 的
`CLAUDE.md` 约定。它会从当前目录向上遍历读取本地文件，然后读取全局
`~/.config/opencode/AGENTS.md`，再读取 `~/.claude/CLAUDE.md`，除非禁用了
Claude 兼容。在每一类中，第一个匹配文件获胜；如果同一位置同时存在
`AGENTS.md` 和 `CLAUDE.md`，则 `AGENTS.md` 获胜。

OpenCode 还支持在 `opencode.json` 或全局配置中使用 `instructions`。指令
条目可以指向本地文件、glob 或远程 URL。这些指令会与 `AGENTS.md` 风格规
则合并。OpenCode 不会自动解析 `AGENTS.md` 中的 `@file` 引用；用户要么使
用 `instructions` 字段，要么明确指示 Agent 读取引用文件。

### Agent

OpenCode Agent 可以在 `opencode.json` 的 `agent` 下配置，也可以定义为
`~/.config/opencode/agents/` 和 `.opencode/agents/` 中的 Markdown 文件。
JSON 和 Markdown Agent 支持 `description`、`mode`、`model`、提示词内容、
权限、已废弃的 `tools`、`steps`、`disable`、`hidden`、任务权限、颜色、
采样字段和 provider 特定选项。对 Markdown Agent 来说，文件名就是 Agent
名称。

### Skill

OpenCode Skill 是包含 `SKILL.md` 的目录。项目位置包括 `.opencode/skills`、
`.claude/skills` 和 `.agents/skills`；也会扫描全局等价目录。对于项目本地
路径，OpenCode 会从当前目录向上走到 git worktree 根目录，并加载沿途匹配
的 Skill 目录。

`SKILL.md` frontmatter 必须包含 `name` 和 `description`。识别的可选字段
是 `license`、`compatibility` 和字符串映射 `metadata`；未知 frontmatter
字段会被忽略。`name` 必须是 1 到 64 个字符、由小写字母数字和单连字符分
隔，并且必须与目录名匹配。OpenCode 通过原生 `skill` 工具暴露 Skill，且可
以通过全局或按 Agent 的权限控制 Skill 可见性。

### MCP

OpenCode 配置在 `opencode.json` 或 `opencode.jsonc` 中使用 `mcp` 条目。本
地服务器使用 `type: "local"`、命令数组、可选 `cwd`、`environment`、
`enabled` 和 `timeout`。远程服务器使用 `type: "remote"`、`url`、`headers`、
`oauth`、`enabled` 和 `timeout`。MCP 可以全局启用或禁用，也可以通过工具
权限隐藏，或按 Agent 启用。

## 当前实现评审

当前归一化资源模型对多个官方资产定义来说过浅。最重要的差距是：Skill 被
建模为单个 `SKILL.md` 文件中的字段：

- `packages/core/src/domain/resource.ts` 将 `SkillResourceData` 存为
  `name`、可选 `description`、`instructions`、`references` 和
  `extensions`。
- `packages/adapters/src/markdown-assets.ts` 从 frontmatter 或目录推导名
  称，只读取 frontmatter 和正文，并且只在存在 frontmatter `references` 字
  段时记录引用。
- `packages/adapters/src/conversion.ts` 会把每次 Skill 迁移渲染成目标
  Skill 目录下的一个新 `SKILL.md`。

这会丢失 Skill 的包语义。官方 Skill 可以包含脚本、参考资料、资源、
provider 元数据、路径激活规则、调用控制和依赖。由于支持文件既不是已解析
资产的一部分，也不进入内容哈希，修改 `scripts/deploy.sh`、
`references/API.md` 或 `assets/template.json` 不会表现为 Skill 资产变更。
因此，即使 Skill 中真正可执行的部分从未被复制，迁移也可能被标记为完成。

### 审查问题

1. 没有审查 Skill 包完整性。

   当前审查只能看到已解析的 `SKILL.md`。它不会验证工具特有的必需字段、文
   件夹和名称一致性、可选包目录、被引用的脚本或资源、嵌套作用域行为，也
   不会计算支持文件哈希。这个问题影响四个工具。

2. Skill 引用诊断的语义不正确。

   `BaseToolAdapter.diagnose` 会把 Skill 的 `references` 与已解析资产路径
   集合比较。官方支持文件通常不是独立资产，所以与 `SKILL.md` 同级的合法
   `reference.md` 可能被误报为 unresolved；而 Markdown 正文中的链接又完全
   没有检查。

3. Skill 身份和作用域被扁平化。

   Claude Code 使用 Skill 目录作为命令名；Cursor 和 OpenCode 要求 `name`
   与父目录匹配；Codex 可以展示重名 Skill 且不合并。当前解析使用通用
   locator `skill:<name>`，之后只做了部分解析特例。它没有验证名称和目录规
   则，也没有一致保留带目录限定或嵌套作用域的行为。

4. Rule 发现和优先级不完整。

   Claude Code 发现过程遗漏 `CLAUDE.local.md`、`.claude/rules`、导入，以
   及完整层级和按需加载语义。Codex 只处理类似根目录的
   `AGENTS.override.md`、`AGENTS.md`、`.codex/config.toml` 和
   `.agents/skills` 子集；没有建模完整的 root 到 current directory 链、备
   选文件名和大小上限。Cursor 规则解析把部分 frontmatter 保存在通用
   extensions 中，但没有从 `alwaysApply`、`description` 和 `globs` 归一化
   规则类型。OpenCode 官方支持远程 `instructions` URL，但当前发现阶段会忽
   略它们。

5. Agent schema 被压缩成很小的公共子集。

   通用 Markdown 解析器只保留 `name`、正文指令、可选 `model` 和
   `tools`/`allowedTools`。Claude 的 `disallowedTools`、`permissionMode`、
   `mcpServers`、`hooks`、`skills`、`memory`、`background`，以及
   Cursor/OpenCode 权限字段等工具特定字段都没有语义化建模。Codex Agent 要
   求 `description`，但当前 Codex 解析和渲染没有把它作为一等字段保留；渲
   染 Codex Agent 时会用资源名写入 `description`。

6. MCP schema 有损且不一致。

   Claude 的 `~/.claude.json` 本地或用户作用域、项目审批和环境变量展开没
   有建模。Codex 解析处理了 `env_vars`，但没有覆盖官方完整的 `env`、
   `cwd`、required/enabled 标志、工具过滤、OAuth 或审批。Cursor MCP 没有
   建模必需的 `type: "stdio"`、`envFile`、静态 OAuth auth、插值、扩展 API
   注册或全局配置。OpenCode MCP 解析覆盖核心本地和远程条目，但没有把所有
   OAuth、timeout、按 Agent 权限或远程默认行为作为可部署语义保留。

7. 诊断是通用诊断，不是工具 schema 感知诊断。

   基础适配器会诊断重复 locator、配置根之外的资源、空指令、不可部署的
   MCP secret、字面 secret 风险，以及当前的 Skill 引用检查。它不会验证原
   生必需字段、废弃字段、被忽略文件、优先级冲突、包完整性、不支持的官方
   字段，或迁移时会丢失的字段。

### 迁移问题

1. Skill 迁移会丢弃包文件。

   转换器只输出 `SKILL.md`；它从不为 `scripts/`、`references/`、`assets/`
   或工具特定元数据文件规划 copy 或 symlink 操作。部署模型可以表示
   copy/symlink 操作，但内置转换没有把这些操作用于 Skill 包。

2. 转换质量是在归一化损失之后计算的。

   `droppedFields` 只报告已经建模的字段，例如 `/data/extensions`、
   `/data/globs` 和 Codex Agent 的 `/data/allowedTools`。如果发现阶段已经
   遗漏支持文件、导入、嵌套作用域或必需原生元数据，转换仍可能被报告为完
   整保真，尽管原生行为已经丢失。

3. Rule 迁移会折叠层级语义。

   非 Cursor 规则输出是单个 `CLAUDE.md` 或 `AGENTS.md`。这无法忠实表达
   `.claude/rules` 路径激活、Codex 根到当前目录分层、Cursor 手动/模型选
   择/文件作用域规则类型、OpenCode `instructions` glob 或 URL，以及
   `CLAUDE.local.md` 的个人行为。

4. Agent 迁移会丢失路由和安全控制。

   渲染 Agent 时只写一个很小的 frontmatter 子集或最小 Codex TOML 文件。
   描述、权限模型、任务可见性、后台模式、Hook、MCP server 绑定、Skill 绑
   定和 provider 特定选项要么丢失，要么退化为通用 extensions。

5. MCP 迁移对原生配置的重写过窄。

   当前渲染每个 MCP 输出一个 JSON/TOML 配置片段。它不保留作用域和优先级
   决策、远程 OAuth 设置、env-file 行为、插值语法、按 Agent 启用、必需服
   务器语义或审批/工具过滤策略。

6. 迁移 UI/API 假设一次只处理一种资源类型。

   `apps/desktop/src/renderer/model.ts` 和 `apps/cli/src/app-services.ts`
   要求选中的迁移来源拥有同一种资源类型。这对扁平资产可行，但官方 Skill
   包可能依赖脚本、资源、引用、Agent 元数据、权限、Hook 或 MCP。这些依赖
   需要包级规划，而不是单一类型转换。

## 建议设计方向

1. 将原生包作为一等概念。

   为来源是目录或带依赖文件配置项的资产引入 package/content graph。至少
   对 Skill 资产，需要支持文件条目、文件哈希、相对路径、媒体类型和显式引
   用边。资产内容哈希应包含包图，而不只是 `SKILL.md`。

2. 保留归一化核心，同时保留原生元数据。

   保留用于跨工具比较的公共字段，但为必需元数据、激活规则、优先级 key 和
   迁移约束增加工具特定 schema。原生 schema 感知验证应先于通用诊断执行。

3. 分离身份和展示元数据。

   分别建模 `nativeId`、`displayName`、`directoryName`、`locator` 和
   `invocationName`。Skill 和 Agent 在不同工具中使用这些字段的方式不同，
   当目标工具要求它们匹配时，迁移应给出警告。

4. 增加 schema 感知诊断。

   每个适配器应报告缺失必需字段、被忽略的官方文件、不支持的官方字段、优
   先级冲突、无效名称格式、无法迁移的包支持文件，以及目标特定的有损转
   换。

5. 将迁移规划从文件生成升级为包操作。

   Skill 迁移应规划目录创建，以及 copy、symlink 或 generated file 操作，
   并对包内每个成员做冲突检测。Rule 和 MCP 迁移应尽量保留原生作用域；无
   法保留时，应输出明确的部分转换警告。

6. 扩展基于原生示例的测试。

   增加多文件 Skill、嵌套 Skill root、路径作用域规则、重复和优先级案例、
   Codex 目录链 `AGENTS.md`、Cursor `.mdc` 规则类型、OpenCode
   `instructions`，以及 `envFile`、`env`、`cwd`、OAuth、按 Agent 权限等
   MCP 字段的 fixture。
