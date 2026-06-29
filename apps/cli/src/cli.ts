import {
  API_COMMAND_NAMES,
  type ApiCommandName,
  type CommandServiceMap,
  createCommandHandlers,
} from "@ai-config-hub/api";
import { Command, CommanderError, InvalidArgumentError } from "commander";

export interface CliProgramOptions {
  readonly services: CommandServiceMap;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export interface CliRunResult {
  readonly exitCode: number;
}

interface GlobalOptions {
  readonly json?: boolean;
}

interface ScanOptions extends GlobalOptions {
  readonly mode?: "full" | "incremental";
  readonly tool?: string[];
  readonly changedPath?: string[];
}

interface ListOptions extends GlobalOptions {
  readonly tool?: string[];
  readonly resource?: string[];
  readonly scopeKind?: string[];
  readonly kind?: string[];
  readonly status?: string[];
  readonly severity?: string;
  readonly query?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly from?: string;
  readonly to?: string;
}

interface DiagnoseInheritedOptions extends GlobalOptions {
  readonly tool?: string[];
  readonly severity?: string[];
  readonly from?: string;
  readonly to?: string;
}

interface EffectiveOptions extends GlobalOptions {
  readonly tool: string;
  readonly project: string;
  readonly scope: string;
  readonly resource?: string[];
}

interface MigrateOptions extends GlobalOptions {
  readonly dryRun?: boolean;
  readonly source: string[];
  readonly target: string;
  readonly scope: string;
  readonly conflict?: "fail" | "replace" | "merge";
}

interface DeployOptions extends GlobalOptions {
  readonly planHash: string;
  readonly confirm?: string[];
}

interface InvokeOptions extends GlobalOptions {
  readonly payload?: string;
}

type CommandResult<Name extends ApiCommandName = ApiCommandName> = Awaited<
  ReturnType<ReturnType<typeof createCommandHandlers>[Name]>
>;

export function createCliProgram(options: CliProgramOptions): Command {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const handlers = createCommandHandlers(options.services, {
    correlationId: () => "correlation:cli",
  });

  const program = new Command();
  program
    .name("ai-config-hub")
    .description("Inspect, diagnose, migrate, deploy, and roll back AI tool configuration.")
    .exitOverride()
    .configureOutput({
      writeOut: stdout,
      writeErr: stderr,
      outputError: (message, write) => write(message),
    })
    .showHelpAfterError();

  program
    .command("scan")
    .argument("[roots...]", "authorized roots to scan")
    .option("--mode <mode>", "scan mode", parseChoice(["full", "incremental"]), "full")
    .option("--tool <tool>", "tool key to include", collect, [])
    .option("--changed-path <path>", "changed path for incremental scans", collect, [])
    .option("--json", "print a JSON API envelope")
    .action(async (roots: string[], flags: ScanOptions) => {
      await invoke(
        "scan.start",
        compact({
          mode: flags.mode ?? "full",
          roots,
          changedPaths: flags.changedPath,
          toolKeys: flags.tool,
        }),
        flags,
      );
    });

  const assets = program.command("assets").description("Query indexed assets.");
  assets
    .command("list")
    .option("--tool <tool>", "tool key to include", collect, [])
    .option("--resource <kind>", "resource kind to include", collect, [])
    .option("--scope-kind <kind>", "scope kind to include", collect, [])
    .option("--severity <severity>", "diagnostic severity filter")
    .option("--query <text>", "text search")
    .option("--cursor <cursor>", "pagination cursor")
    .option("--limit <count>", "page size", parsePositiveInteger)
    .option("--json", "print a JSON API envelope")
    .action(async (flags: ListOptions) => {
      await invoke(
        "assets.list",
        compact({
          toolKeys: flags.tool,
          resourceTypes: flags.resource,
          scopeKinds: flags.scopeKind,
          diagnosticSeverity: flags.severity,
          query: flags.query,
          cursor: flags.cursor,
          limit: flags.limit,
        }),
        flags,
      );
    });
  assets
    .command("get")
    .argument("<asset-id>", "asset id")
    .option("--include <part>", "include normalized, references, or diagnostics", collect, [])
    .option("--json", "print a JSON API envelope")
    .action(async (assetId: string, flags: { readonly include?: string[] } & GlobalOptions) => {
      await invoke("assets.get", compact({ assetId, include: flags.include }), flags);
    });

  program
    .command("effective")
    .description("Resolve effective configuration.")
    .command("resolve")
    .requiredOption("--tool <tool>", "tool key")
    .requiredOption("--project <project-id>", "project id")
    .requiredOption("--scope <scope-id>", "target scope id")
    .option("--resource <kind>", "resource kind to include", collect, [])
    .option("--json", "print a JSON API envelope")
    .action(async (flags: EffectiveOptions) => {
      await invoke(
        "effective.resolve",
        compact({
          toolKey: flags.tool,
          projectId: flags.project,
          targetScopeId: flags.scope,
          resourceTypes: flags.resource,
        }),
        flags,
      );
    });

  const diagnose = program
    .command("diagnose")
    .description("List diagnostics from the current index.")
    .option("--tool <tool>", "tool key to include", collect, [])
    .option("--severity <severity>", "diagnostic severity filter", collect, [])
    .option("--code <code>", "diagnostic code filter", collect, [])
    .option("--cursor <cursor>", "pagination cursor")
    .option("--limit <count>", "page size", parsePositiveInteger)
    .option("--json", "print a JSON API envelope")
    .action(async (flags: ListOptions & { readonly code?: string[] }) => {
      await invoke(
        "diagnostics.list",
        compact({
          toolKeys: flags.tool,
          severities: flags.severity,
          codes: flags.code,
          cursor: flags.cursor,
          limit: flags.limit,
        }),
        flags,
      );
    });
  diagnose
    .command("export")
    .option("--format <format>", "report format", parseChoice(["json", "markdown"]), "markdown")
    .option("--task <task-id>", "scan task id")
    .option("--project <project-id>", "project id")
    .option("--tool <tool>", "tool key to include", collect, [])
    .option("--severity <severity>", "diagnostic severity filter", collect, [])
    .option("--from <iso-date-time>", "created-at lower bound")
    .option("--to <iso-date-time>", "created-at upper bound")
    .option("--json", "print a JSON API envelope")
    .action(
      async (
        flags: GlobalOptions & {
          readonly format?: "json" | "markdown";
          readonly task?: string;
          readonly project?: string;
          readonly tool?: string[];
          readonly severity?: string[];
          readonly from?: string;
          readonly to?: string;
        },
      ) => {
        const inherited: DiagnoseInheritedOptions = diagnose.opts();
        const json = flags.json ?? inherited.json;
        const outputFlags = json === undefined ? flags : { ...flags, json };
        await invoke(
          "diagnostics.export",
          compact({
            format: flags.format ?? "markdown",
            taskId: flags.task,
            projectId: flags.project,
            toolKeys: optionList(flags.tool, inherited.tool),
            severities: optionList(flags.severity, inherited.severity),
            from: flags.from ?? inherited.from,
            to: flags.to ?? inherited.to,
          }),
          outputFlags,
        );
      },
    );

  program
    .command("migrate")
    .description("Preview a migration plan.")
    .option("--dry-run", "preview only")
    .requiredOption("--source <asset-id>", "source asset id", collect, [])
    .requiredOption("--target <tool>", "target tool key")
    .requiredOption("--scope <scope-id>", "target scope id")
    .option(
      "--conflict <policy>",
      "conflict policy",
      parseChoice(["fail", "replace", "merge"]),
      "fail",
    )
    .option("--json", "print a JSON API envelope")
    .action(async (flags: MigrateOptions) => {
      await invoke(
        "migration.preview",
        {
          sourceAssetIds: flags.source,
          targetToolKey: flags.target,
          targetScopeId: flags.scope,
          conflictPolicy: flags.conflict ?? "fail",
        },
        flags,
      );
    });

  program
    .command("deploy")
    .argument("<plan-id>", "deployment plan id")
    .requiredOption("--plan-hash <hash>", "preview plan hash to confirm")
    .option("--confirm <confirmation>", "required confirmation to grant", collect, [])
    .option("--json", "print a JSON API envelope")
    .action(async (planId: string, flags: DeployOptions) => {
      await invoke(
        "deployment.execute",
        {
          planId,
          confirmedPlanHash: flags.planHash,
          confirmations: flags.confirm ?? [],
        },
        flags,
      );
    });

  program
    .command("rollback")
    .argument("<deployment-id>", "deployment record id")
    .option("--json", "print a JSON API envelope")
    .action(async (deploymentId: string, flags: GlobalOptions) => {
      await invoke("deployment.rollback", { deploymentId }, flags);
    });

  program
    .command("history")
    .description("List scan, preview, deployment, and rollback history.")
    .option("--kind <kind>", "history kind to include", collect, [])
    .option("--status <status>", "history status to include", collect, [])
    .option("--from <iso-date-time>", "created-at lower bound")
    .option("--to <iso-date-time>", "created-at upper bound")
    .option("--cursor <cursor>", "pagination cursor")
    .option("--limit <count>", "page size", parsePositiveInteger)
    .option("--json", "print a JSON API envelope")
    .action(async (flags: ListOptions) => {
      await invoke(
        "history.list",
        compact({
          kinds: flags.kind,
          statuses: flags.status,
          from: flags.from,
          to: flags.to,
          cursor: flags.cursor,
          limit: flags.limit,
        }),
        flags,
      );
    });

  program
    .command("invoke")
    .argument("<command>", "stable API command name")
    .option("--payload <json>", "JSON command payload")
    .option("--json", "print a JSON API envelope")
    .action(async (name: string, flags: InvokeOptions) => {
      if (!isApiCommandName(name)) throw new InvalidArgumentError(`Unknown command: ${name}`);
      await invoke(name, parseJsonPayload(flags.payload), { ...flags, json: true });
    });

  async function invoke<Name extends ApiCommandName>(
    name: Name,
    payload: unknown,
    flags: GlobalOptions,
  ): Promise<void> {
    const response = (await handlers[name]({
      apiVersion: 1,
      requestId: requestId(name),
      payload,
    })) as CommandResult<Name>;
    if (flags.json === true) {
      stdout(`${JSON.stringify(response, null, 2)}\n`);
    } else {
      stdout(renderText(name, response));
    }
    if (!response.ok) {
      throw new CommanderError(1, response.error.code, response.error.message);
    }
  }

  return program;
}

export async function runCli(program: Command, argv: readonly string[]): Promise<CliRunResult> {
  try {
    await program.parseAsync([...argv], { from: "user" });
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof CommanderError) return { exitCode: error.exitCode };
    throw error;
  }
}

function collect(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

function optionList(
  local: readonly string[] | undefined,
  inherited: readonly string[] | undefined,
): readonly string[] | undefined {
  if (local !== undefined && local.length > 0) return local;
  if (inherited !== undefined && inherited.length > 0) return inherited;
  return undefined;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Expected a positive integer");
  }
  return parsed;
}

function parseChoice<T extends string>(choices: readonly T[]) {
  return (value: string): T => {
    if (choices.includes(value as T)) return value as T;
    throw new InvalidArgumentError(`Expected one of: ${choices.join(", ")}`);
  };
}

function parseJsonPayload(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new InvalidArgumentError("Payload must be a JSON object");
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item === undefined) return false;
      return !Array.isArray(item) || item.length > 0;
    }),
  ) as T;
}

function requestId(name: ApiCommandName): string {
  return `request:cli:${name}`;
}

function isApiCommandName(name: string): name is ApiCommandName {
  return (API_COMMAND_NAMES as readonly string[]).includes(name);
}

function renderText<Name extends ApiCommandName>(
  name: Name,
  response: CommandResult<Name>,
): string {
  if (!response.ok) return `Error ${response.error.code}: ${response.error.message}\n`;
  const data = response.data as Record<string, unknown>;
  if (name === "history.list" && "items" in data && Array.isArray(data.items)) {
    return renderHistory(data.items);
  }
  if (name === "diagnostics.export" && typeof data.content === "string") {
    return data.content.endsWith("\n") ? data.content : `${data.content}\n`;
  }
  if (name === "migration.preview") return renderMigrationPreview(data);
  if ("items" in data && Array.isArray(data.items)) return `${data.items.length} item(s)\n`;
  if ("taskId" in data) return `Task ${String(data.taskId)} queued\n`;
  if (name === "assets.get" && typeof data.asset === "object" && data.asset !== null) {
    const asset = data.asset as { readonly id?: unknown; readonly logicalKey?: unknown };
    const id = typeof asset.id === "string" ? asset.id : "";
    const logicalKey = typeof asset.logicalKey === "string" ? asset.logicalKey : "";
    return `${id} ${logicalKey}\n`;
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

function renderMigrationPreview(data: Record<string, unknown>): string {
  const planId = stringValue(data.planId);
  const compatibility = stringValue(data.compatibility);
  const requiredConfirmations = arrayValue(data.requiredConfirmations).map(String);
  const expiresAt = stringValue(data.expiresAt);
  const planHash = stringValue(data.planHash);
  const lines = [
    `Plan ${planId}`,
    `Compatibility: ${compatibility}`,
    `Required confirmations: ${
      requiredConfirmations.length === 0 ? "none" : requiredConfirmations.join(", ")
    }`,
    `Expires: ${expiresAt}`,
    `Plan hash: ${planHash}`,
  ];

  lines.push("Source hashes:");
  appendHashRows(lines, data.sourceHashes);
  lines.push("Target hashes:");
  appendHashRows(lines, data.targetHashes);

  for (const loss of arrayValue(data.fieldLosses)) {
    if (typeof loss !== "object" || loss === null) continue;
    const row = loss as Record<string, unknown>;
    const droppedFields = arrayValue(row.droppedFields).map(String);
    lines.push(
      `Field loss ${stringValue(row.assetId)}: dropped ${
        droppedFields.length === 0 ? "none" : droppedFields.join(", ")
      }`,
    );
    const transformedFields = arrayValue(row.transformedFields);
    for (const transformed of transformedFields) {
      if (typeof transformed !== "object" || transformed === null) continue;
      const item = transformed as Record<string, unknown>;
      lines.push(
        `  transformed ${stringValue(item.sourceField)} -> ${stringValue(item.targetField)}: ${stringValue(item.reason)}`,
      );
    }
    for (const warning of arrayValue(row.warnings)) {
      lines.push(`  warning: ${String(warning)}`);
    }
  }

  for (const change of arrayValue(data.changes)) {
    if (typeof change !== "object" || change === null) continue;
    const row = change as Record<string, unknown>;
    lines.push(
      `${stringValue(row.operation)} ${stringValue(row.pathDisplay)}`,
      `  before: ${nullableHash(row.beforeHash)}`,
      `  after: ${nullableHash(row.afterHash)}`,
    );
    const diff = stringValue(row.diff);
    if (diff.length > 0) lines.push(diff);
  }

  return `${lines.join("\n")}\n`;
}

function appendHashRows(lines: string[], hashes: unknown): void {
  if (typeof hashes !== "object" || hashes === null || Array.isArray(hashes)) {
    lines.push("  none");
    return;
  }
  const entries = Object.entries(hashes as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) {
    lines.push("  none");
    return;
  }
  for (const [label, hash] of entries) {
    lines.push(`  ${label}: ${nullableHash(hash)}`);
  }
}

function renderHistory(items: readonly unknown[]): string {
  if (items.length === 0) return "0 item(s)\n";
  return items
    .map((item) => {
      if (typeof item !== "object" || item === null) return "";
      const entry = item as {
        readonly id?: unknown;
        readonly kind?: unknown;
        readonly status?: unknown;
        readonly createdAt?: unknown;
        readonly snapshot?: unknown;
      };
      const kind = typeof entry.kind === "string" ? entry.kind : "history";
      const id = typeof entry.id === "string" ? entry.id : "unknown";
      const status = typeof entry.status === "string" ? entry.status : "unknown";
      const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
      return [kind, id, status, createdAt, renderSnapshot(entry.snapshot)]
        .filter((part) => part.length > 0)
        .join(" ");
    })
    .filter((line) => line.length > 0)
    .join("\n")
    .concat("\n");
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableHash(value: unknown): string {
  return value === null ? "absent" : stringValue(value);
}

function renderSnapshot(snapshot: unknown): string {
  if (typeof snapshot !== "object" || snapshot === null || !("status" in snapshot)) return "";
  const metadata = snapshot as {
    readonly status?: unknown;
    readonly commitId?: unknown;
    readonly error?: { readonly code?: unknown };
  };
  if (metadata.status === "recorded" && typeof metadata.commitId === "string") {
    return `snapshot ${metadata.commitId}`;
  }
  if (metadata.status === "missing") return "snapshot missing";
  if (
    (metadata.status === "failed" || metadata.status === "unavailable") &&
    typeof metadata.error?.code === "string"
  ) {
    return `snapshot ${metadata.status} ${metadata.error.code}`;
  }
  return "";
}
