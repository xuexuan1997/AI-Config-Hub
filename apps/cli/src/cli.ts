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
}

interface ListOptions extends GlobalOptions {
  readonly tool?: string[];
  readonly resource?: string[];
  readonly scopeKind?: string[];
  readonly severity?: string;
  readonly query?: string;
  readonly cursor?: string;
  readonly limit?: number;
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
    .option("--json", "print a JSON API envelope")
    .action(async (roots: string[], flags: ScanOptions) => {
      await invoke(
        "scan.start",
        compact({ mode: flags.mode ?? "full", roots, toolKeys: flags.tool }),
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

  program
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
    .option("--json", "print a JSON API envelope")
    .action(async (planId: string, flags: GlobalOptions) => {
      await invoke("deployment.execute", { planId }, flags);
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
    .option("--cursor <cursor>", "pagination cursor")
    .option("--limit <count>", "page size", parsePositiveInteger)
    .option("--json", "print a JSON API envelope")
    .action(async (flags: ListOptions) => {
      await invoke("history.list", compact({ cursor: flags.cursor, limit: flags.limit }), flags);
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
