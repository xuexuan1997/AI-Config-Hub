# Tool asset definitions and migration review

Status: research note  
Last verified: 2026-07-04  
Scope: the built-in adapters in this repository: Claude Code, Codex, Cursor, and
OpenCode.

This document records how each supported tool defines its main reusable assets,
then reviews the current asset discovery, diagnosis, and migration design against
those native definitions. It intentionally focuses on product-facing behavior:
what a user expects to be preserved when AI Config Hub audits or migrates assets.

## Sources

Official documentation checked for this review:

- Claude Code: [skills](https://code.claude.com/docs/en/skills),
  [subagents](https://code.claude.com/docs/en/sub-agents),
  [memory and rules](https://code.claude.com/docs/en/memory),
  [MCP](https://code.claude.com/docs/en/mcp).
- Codex: [skills](https://developers.openai.com/codex/skills),
  [AGENTS.md](https://developers.openai.com/codex/guides/agents-md),
  [subagents](https://developers.openai.com/codex/subagents),
  [MCP](https://developers.openai.com/codex/mcp),
  [config basics](https://developers.openai.com/codex/config-basic).
- Cursor: [skills](https://cursor.com/docs/skills.md),
  [rules](https://cursor.com/docs/rules.md),
  [subagents](https://cursor.com/docs/subagents.md),
  [MCP](https://cursor.com/docs/mcp.md).
- OpenCode: [skills](https://opencode.ai/docs/skills.md),
  [rules](https://opencode.ai/docs/rules.md),
  [agents](https://opencode.ai/docs/agents.md),
  [MCP servers](https://opencode.ai/docs/mcp-servers/).

## Shared vocabulary

The repository currently normalizes four resource kinds in
`packages/core/src/domain/resource.ts`: `rule`, `agent`, `skill`, and `mcp`.
Those four names are useful, but they are not equivalent across tools.

Rule-like assets are persistent instructions. They can be plain markdown,
frontmatter-driven rule files, hierarchical instruction chains, path-scoped
rules, imported references, or generated/managed policy text depending on the
tool.

Agent-like assets define a specialized assistant or subagent. They usually have
a prompt body, a description used for routing, model selection, tool or
permission controls, and sometimes lifecycle options such as background mode,
memory, nested skills, MCP access, and hooks.

Skill-like assets are not only a name. In the current tools they are directory
packages centered on a `SKILL.md` file. The package can contain metadata,
instructions, scripts, references, assets/templates, dependency metadata, and
tool-specific activation controls. Some tools require the skill name to match the
parent directory.

MCP assets define external tool servers. Every supported tool can express local
stdio servers and remote HTTP-style servers, but each has its own scope,
precedence, authentication, interpolation, and per-agent/tool gating semantics.

Several official asset families are outside the current normalized model, such
as hooks, commands, plugins, policies, memories, and external references. If they
remain out of scope, the product should state that explicitly during audit and
migration.

## Claude Code

### Rules and memory

Claude Code uses `CLAUDE.md` files for durable instructions. Supported scopes
include managed, user, project, and local files. Project instructions can live at
`./CLAUDE.md` or `./.claude/CLAUDE.md`; local personal project preferences use
`./CLAUDE.local.md`. Claude loads the hierarchy above the working directory at
launch and can load subdirectory instructions on demand.

Large projects can use `.claude/rules/**/*.md`. Rules may have YAML frontmatter
with `paths` globs for path-specific activation. Rules without `paths` load
unconditionally. Claude also supports imports from `CLAUDE.md` using `@path`,
with recursive import behavior.

### Agents

Claude Code subagents are markdown files with YAML frontmatter and a markdown
prompt body. Project subagents live under `.claude/agents/`; user subagents live
under `~/.claude/agents/`; managed settings, CLI `--agents`, and plugin agents
are also supported. Claude scans `.claude/agents/` recursively. Within normal
project/user scopes, the subagent identity is the frontmatter `name`, not the
filename or subdirectory.

Supported subagent metadata is broader than `name`, `model`, and `tools`.
Official fields include `description`, `prompt` or markdown body, `tools`,
`disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`,
`skills`, `initialPrompt`, `memory`, `effort`, `background`, `isolation`, and
`color`.

### Skills

Claude Code skills are skill directories. The command users type comes from the
directory name, and each directory contains a required `SKILL.md`. The file uses
YAML frontmatter plus a markdown body. The frontmatter may include `name`,
`description`, `when_to_use`, `argument-hint`, `arguments`,
`disable-model-invocation`, `user-invocable`, and `paths`.

The skill directory can include additional files such as `reference.md`,
`examples.md`, `scripts/`, and other helpers. `SKILL.md` should point to those
files so Claude can load or execute them when needed. Claude supports
substitutions such as `${CLAUDE_SKILL_DIR}` and `${CLAUDE_PROJECT_DIR}` inside
skills.

Skill scope and precedence are tool-specific: enterprise, personal, project, and
plugin skills can all exist. Nested `.claude/skills` directories are discovered
relative to where Claude is working; nested project skills can appear with
directory-qualified names.

### MCP

Claude Code supports local, project, user, plugin-provided, and connector MCP
servers. Project MCP is stored in `.mcp.json` at the project root with
`mcpServers`; local and user scopes are stored in `~/.claude.json`. If duplicate
server names exist across local, project, and user scopes, the highest
precedence entire server entry wins rather than merging fields.

Project `.mcp.json` supports environment expansion in `command`, `args`, `env`,
`url`, and `headers`. Missing required variables fail config parsing.

## Codex

### Rules and project guidance

Codex uses `AGENTS.md` for persistent guidance. Global guidance lives in the
Codex home directory; project guidance is discovered from the project root down
to the current working directory. In each directory, Codex checks
`AGENTS.override.md`, then `AGENTS.md`, then configured fallback names. At most
one file per directory is included. Files closer to the working directory appear
later and therefore override earlier prompt guidance. Empty files are skipped,
and `project_doc_max_bytes` caps total loaded guidance.

Codex also has layered `config.toml` files. User config is at
`~/.codex/config.toml`; project-scoped `.codex/config.toml` files are loaded only
for trusted projects and resolve from the project root down to the current
directory.

### Agents

Codex custom agents are standalone TOML files under `~/.codex/agents/` or
`.codex/agents/`. Each file defines one agent. Required fields are `name`,
`description`, and `developer_instructions`. Optional fields include
`nickname_candidates`, `model`, `model_reasoning_effort`, `sandbox_mode`,
`mcp_servers`, and `skills.config`, and custom agents can override supported
session configuration.

### Skills

Codex skills use the open Agent Skills package shape. A skill is a directory
with required `SKILL.md` plus optional `scripts/`, `references/`, `assets/`, and
`agents/openai.yaml` metadata. The `SKILL.md` file must include `name` and
`description`. Codex uses progressive disclosure: the skill list exposes name,
description, and path; full instructions load only when Codex selects the skill.

Repository skills are discovered from `.agents/skills` directories on the path
from the current working directory to the repo root. User, admin, and bundled
system skills can also be available. Duplicate skill names are not merged; both
can appear in skill selectors.

### MCP

Codex stores MCP config in `config.toml` under `[mcp_servers.<name>]`. User
config lives at `~/.codex/config.toml`; trusted project config can live at
`.codex/config.toml`. Stdio servers support `command`, `args`, `env`,
`env_vars`, `cwd`, and remote execution settings. Streamable HTTP servers
support `url`, bearer-token environment variables, static headers, environment
headers, OAuth, and timeouts. Servers can also be enabled, required, or filtered
by enabled/disabled tool lists and approval rules.

## Cursor

### Rules

Cursor project rules are `.mdc` files under `.cursor/rules`. A plain `.md` file
in that directory is ignored by the rule system. Rule frontmatter controls how a
rule is included using `alwaysApply`, `description`, and `globs`:
always-on, model-selected, file-pattern selected, or manual `@` invocation.

Cursor also supports `AGENTS.md` as a simple markdown alternative. `AGENTS.md`
files can live in the project root and subdirectories; nested instructions are
combined with parents, and more specific instructions take precedence.

### Agents

Cursor subagents are markdown files with YAML frontmatter and a prompt body.
Project files can live under `.cursor/agents/`, with compatibility reads from
`.claude/agents/` and `.codex/agents/`; user-level equivalents are also
supported. Project subagents take precedence when names conflict, and `.cursor/`
takes precedence over compatibility directories.

Official Cursor subagent fields include `name`, `description`, `model`,
`readonly`, and `is_background`. The `name` can be derived from filename, but
descriptions drive automatic delegation.

### Skills

Cursor Agent Skills are open-standard skill packages. Supported project
locations include `.agents/skills/` and `.cursor/skills/`, with user-level
equivalents and compatibility directories for Claude and Codex skills. Each
skill is a folder containing `SKILL.md`; optional `scripts/`, `references/`, and
`assets/` directories are part of the package.

`SKILL.md` frontmatter requires `name` and `description`. Cursor additionally
requires `name` to use lowercase letters, numbers, and hyphens and to match the
parent folder. `paths` scopes a skill to matching files, and
`disable-model-invocation` prevents automatic model selection. Cursor discovers
nested skill roots inside repositories and scopes nested project skills to the
directory where they live.

### MCP

Cursor MCP config uses `mcp.json` with top-level `mcpServers`. Project config is
`.cursor/mcp.json`; global config is `~/.cursor/mcp.json`. Cursor supports stdio,
SSE, and Streamable HTTP transports, plus protocol capabilities such as tools,
prompts, resources, roots, elicitation, and apps.

Stdio config includes `type`, `command`, `args`, `env`, and `envFile`; remote
servers use `url`, `headers`, OAuth/static auth, and interpolation. Supported
interpolation includes environment variables, user home, workspace folder,
workspace basename, and path separator variables.

## OpenCode

### Rules

OpenCode uses `AGENTS.md` for project rules and can fall back to Claude Code
`CLAUDE.md` conventions. It reads local files by walking up from the current
directory, then reads global `~/.config/opencode/AGENTS.md`, then
`~/.claude/CLAUDE.md` unless Claude compatibility is disabled. In each category,
the first matching file wins; if both `AGENTS.md` and `CLAUDE.md` exist in the
same location, `AGENTS.md` wins.

OpenCode also supports `instructions` in `opencode.json` or global config.
Instruction entries may point to local files, globs, or remote URLs. Those
instructions are combined with `AGENTS.md`-style rules. OpenCode does not
automatically parse `@file` references in `AGENTS.md`; users must either use the
`instructions` field or tell the agent to load referenced files.

### Agents

OpenCode agents can be configured in `opencode.json` under `agent`, or as
markdown files in `~/.config/opencode/agents/` and `.opencode/agents/`. JSON and
markdown agents support `description`, `mode`, `model`, prompt content,
permissions, deprecated `tools`, `steps`, `disable`, `hidden`, task permissions,
color, sampling fields, and provider-specific options. For markdown agents, the
filename becomes the agent name.

### Skills

OpenCode skills are directories with `SKILL.md`. Project locations include
`.opencode/skills`, `.claude/skills`, and `.agents/skills`; global equivalents
are also scanned. For project-local paths, OpenCode walks up from the current
directory to the git worktree root and loads matching skill directories along the
way.

`SKILL.md` frontmatter must include `name` and `description`. Recognized optional
fields are `license`, `compatibility`, and string-map `metadata`; unknown
frontmatter fields are ignored. `name` must be 1-64 characters, lowercase
alphanumeric with single hyphen separators, and must match the directory name.
OpenCode exposes skills through a native `skill` tool, and skill visibility can
be controlled globally or per agent via permissions.

### MCP

OpenCode config uses `mcp` entries in `opencode.json` or `opencode.jsonc`.
Local servers use `type: "local"`, a command array, optional `cwd`,
`environment`, `enabled`, and `timeout`. Remote servers use `type: "remote"`,
`url`, `headers`, `oauth`, `enabled`, and `timeout`. MCPs can be enabled or
disabled globally, hidden through tool permissions, or enabled per agent.

## Current implementation review

The current normalized resource model is too shallow for several official asset
definitions. The most important gap is that Skill is modeled as fields from one
`SKILL.md` file:

- `packages/core/src/domain/resource.ts` stores `SkillResourceData` as `name`,
  optional `description`, `instructions`, `references`, and `extensions`.
- `packages/adapters/src/markdown-assets.ts` infers the name from frontmatter or
  directory, reads only frontmatter/body, and stores `references` only when a
  frontmatter field exists.
- `packages/adapters/src/conversion.ts` renders every skill migration as one new
  `SKILL.md` file under a target skill directory.

This loses the package nature of skills. Official skills can include scripts,
references, assets, provider metadata, path activation rules, invocation
controls, and dependencies. Because support files are not part of the parsed
asset or its content hash, changing `scripts/deploy.sh`, `references/API.md`, or
`assets/template.json` will not be represented as a changed Skill asset. A
migration can therefore be marked complete even when the runnable parts of the
skill were never copied.

### Audit findings

1. Skill package completeness is not audited.

   Audit currently sees only the parsed `SKILL.md`. It does not verify required
   tool-specific fields, folder/name consistency, optional package directories,
   referenced scripts/assets, nested scope behavior, or support-file hashes. This
   affects all four tools.

2. Skill reference diagnostics are semantically wrong.

   `BaseToolAdapter.diagnose` checks skill `references` against the set of
   parsed asset paths. Official support files are usually not separate assets, so
   a valid `reference.md` beside `SKILL.md` can be reported unresolved, while
   links inside the markdown body are not checked at all.

3. Skill identity and scope are flattened.

   Claude Code uses the skill directory as the command name; Cursor and OpenCode
   require `name` to match the parent directory; Codex can surface duplicate
   skill names without merging. Current parsing uses a generic locator
   `skill:<name>` and only partially special-cases resolution later. It does not
   validate name/directory rules or preserve directory-qualified/nested scope
   behavior consistently.

4. Rule discovery and precedence are incomplete.

   Claude Code discovery misses `CLAUDE.local.md`, `.claude/rules`, imports, and
   full hierarchy/on-demand semantics. Codex discovery only handles a root-like
   subset of `AGENTS.override.md`, `AGENTS.md`, `.codex/config.toml`, and
   `.agents/skills`; it does not model the full root-to-current-directory chain,
   fallback filenames, or size cap. Cursor rule parsing preserves some
   frontmatter as generic extensions but does not normalize rule types from
   `alwaysApply`, `description`, and `globs`. OpenCode ignores remote
   `instructions` URLs during discovery, even though official config supports
   them.

5. Agent schemas are reduced to a small common subset.

   The generic markdown parser keeps `name`, body instructions, optional
   `model`, and `tools`/`allowedTools`. Tool-specific fields such as Claude
   `disallowedTools`, `permissionMode`, `mcpServers`, `hooks`, `skills`,
   `memory`, `background`, and Cursor/OpenCode permission fields are not
   semantically modeled. Codex agents require `description`, but current Codex
   parsing and rendering do not preserve it as a first-class field; rendering a
   Codex agent writes `description` from the resource name.

6. MCP schemas are lossy and inconsistent.

   Claude local/user scope in `~/.claude.json`, project approval, and env
   expansion are not modeled. Codex parsing handles `env_vars` but not the
   documented full shape of `env`, `cwd`, required/enabled flags, tool filters,
   OAuth, or approvals. Cursor MCP does not model `type: "stdio"` as required,
   `envFile`, static OAuth auth, interpolation, extension API registration, or
   global config. OpenCode MCP parsing covers core local/remote entries but does
   not preserve all OAuth, timeout, per-agent permission, or remote default
   behavior as deployable semantics.

7. Diagnostics are generic rather than tool-schema aware.

   The base adapter diagnoses duplicate locators, resources outside config
   roots, blank instructions, non-deployable MCP secrets, literal secret risk,
   and the current skill-reference check. It does not validate native required
   fields, deprecations, ignored files, precedence conflicts, package
   completeness, unsupported official fields, or fields that will be lost during
   migration.

### Migration findings

1. Skill migration drops package files.

   The converter emits only `SKILL.md`; it never plans copy or symlink
   operations for `scripts/`, `references/`, `assets/`, or tool-specific metadata
   files. The deployment model can represent copy/symlink operations, but the
   built-in conversions do not use them for skill packages.

2. Conversion quality is measured after normalization loss.

   `droppedFields` only reports modeled fields such as `/data/extensions`,
   `/data/globs`, and Codex agent `/data/allowedTools`. If discovery already
   omitted support files, imports, nested scope, or required native metadata, a
   conversion can be reported as full fidelity even though native behavior is
   lost.

3. Rule migration collapses hierarchical semantics.

   Non-Cursor rule output is a single `CLAUDE.md` or `AGENTS.md`. That cannot
   faithfully represent `.claude/rules` path activation, Codex root-to-current
   layering, Cursor manual/model-selected/file-scoped rule types, OpenCode
   `instructions` globs/URLs, or `CLAUDE.local.md` personal behavior.

4. Agent migration loses routing and safety controls.

   Rendering agents only writes a small frontmatter subset or a minimal Codex
   TOML file. Descriptions, permission models, task visibility, background mode,
   hooks, MCP server bindings, skill bindings, and provider-specific options are
   either lost or demoted to generic extensions.

5. MCP migration rewrites native configuration too narrowly.

   Current rendering emits one JSON/TOML config fragment per MCP. It does not
   preserve scope and precedence decisions, remote OAuth setup, env-file
   behavior, interpolation syntax, per-agent enabling, required-server
   semantics, or approval/tool-filter policies.

6. The migration UI/API assumes one resource kind at a time.

   `apps/desktop/src/renderer/model.ts` and `apps/cli/src/app-services.ts`
   require selected migration sources to share one resource kind. That works for
   flat assets, but official skill packages can depend on scripts, assets,
   references, agents metadata, permissions, hooks, or MCPs. Those dependencies
   need package-level planning rather than single-kind conversion.

## Recommended design direction

1. Make native packages first-class.

   Introduce a package/content graph for assets whose source is a directory or a
   config entry with dependent files. At minimum, Skill assets need support-file
   entries, file hashes, relative paths, media types, and explicit reference
   edges. The asset content hash should include the package graph, not only
   `SKILL.md`.

2. Keep a normalized core plus native metadata.

   Preserve common fields for cross-tool comparison, but add tool-specific
   schemas for required metadata, activation rules, precedence keys, and
   migration constraints. Native schema-aware validation should happen before
   generic diagnostics.

3. Split identity from display metadata.

   Model `nativeId`, `displayName`, `directoryName`, `locator`, and
   `invocationName` separately. Skills and agents use those differently across
   tools, and migration should warn when a target requires them to match.

4. Add schema-aware diagnostics.

   Each adapter should report missing required fields, ignored official files,
   unsupported official fields, precedence collisions, invalid name formats,
   package support files that cannot be migrated, and target-specific lossy
   conversions.

5. Upgrade migration planning from file generation to package operations.

   Skill migration should plan directory creation plus copy/symlink/generated
   file operations, with conflict detection for every package member. Rule and
   MCP migration should preserve native scope when possible and otherwise emit an
   explicit partial-conversion warning.

6. Expand tests around native examples.

   Add fixtures with multi-file skills, nested skill roots, path-scoped rules,
   duplicate/precedence cases, Codex directory-chain `AGENTS.md`, Cursor `.mdc`
   rule types, OpenCode `instructions`, and MCP fields such as `envFile`,
   `env`, `cwd`, OAuth, and per-agent permissions.

## Implemented source-graph status

The source-graph repair implements the first package-aware subset of the design
above:

- Skill package parsing is implemented for the built-in adapters. `SKILL.md` is
  the primary source file, package members are stored in `Asset.sourceFiles`,
  and tool-native identity is stored in `Asset.nativeIdentity`.
- Binary and text support files are included in package hashes and incremental
  invalidation. Built-in Skill conversion emits them as `copy` source outputs
  during migration. Generated `SKILL.md` outputs remain semantic text outputs.
- Skill package disablement moves and restores the package directory for
  directory-shaped skills rather than only moving the primary `SKILL.md` file.
- Incremental scans reparse the owning Skill when a support or metadata file
  changes, and diagnostics located on support files roll up to the owning Skill
  asset.
- Native field diagnostics and partial conversion warnings are implemented for
  unsupported Skill/Agent/Rule/MCP fields, target-specific Skill name rules,
  missing target-required descriptions, Cursor rule activation metadata, and
  MCP fields that cannot be represented in the target format.

Remaining phase 1 limits are intentional: rule hierarchy and MCP scope
migration remain narrower than native tools, and cross-resource package
dependencies such as Skill-to-agent/MCP relationships still require future
package-level planning.
