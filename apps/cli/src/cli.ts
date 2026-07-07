import {
  API_COMMAND_NAMES,
  type ApiError,
  type ApiCommandName,
  type CommandServiceMap,
  createCommandHandlers,
} from "@ai-config-hub/api";
import { CorrelationIdSchema, type ErrorCode } from "@ai-config-hub/shared";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { createInterface } from "node:readline/promises";

export interface CliProgramOptions {
  readonly services: CommandServiceMap;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly confirm?: (message: string) => Promise<boolean>;
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
  readonly source?: string[];
  readonly asset?: string[];
  readonly target?: string;
  readonly to?: string;
  readonly scope?: string;
  readonly conflict?: "fail" | "replace" | "merge";
}

interface DeployOptions extends GlobalOptions {
  readonly plan?: string;
  readonly planHash?: string;
  readonly confirm?: string[];
  readonly yes?: boolean;
}

interface RollbackOptions extends GlobalOptions {
  readonly yes?: boolean;
}

interface InvokeOptions extends GlobalOptions {
  readonly payload?: string;
}

type CommandResult<Name extends ApiCommandName = ApiCommandName> = Awaited<
  ReturnType<ReturnType<typeof createCommandHandlers>[Name]>
>;

type ApiResponseFor<Name extends ApiCommandName> = CommandResult<Name>;

interface CliJsonEnvelope {
  readonly schemaVersion: 1;
  readonly command: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: ApiError;
  readonly meta: {
    readonly generatedAt: string;
    readonly partialSuccess: boolean;
  };
}

export function createCliProgram(options: CliProgramOptions): Command {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const confirm = options.confirm ?? defaultConfirm;
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

  const scan = program
    .command("scan")
    .argument("[roots...]", "authorized roots to scan")
    .option("--mode <mode>", "scan mode", parseChoice(["full", "incremental"]), "full")
    .option("--tool <tool>", "tool key to include", collect, [])
    .option("--changed-path <path>", "changed path for incremental scans", collect, [])
    .option("--json", "print a CLI JSON envelope")
    .action(async (roots: string[], flags: ScanOptions) => {
      const started = await callApi(
        "scan.start",
        compact({
          mode: flags.mode ?? "full",
          roots,
          changedPaths: flags.changedPath,
          toolKeys: flags.tool,
        }),
      );
      if (!started.ok) return finishResponse("scan", "scan.start", started, flags);
      const status = await callApi("scan.status", { taskId: started.data.taskId });
      return finishResponse("scan", "scan.status", status, flags);
    });
  scan
    .command("status")
    .argument("<task-id>", "scan task id")
    .option("--json", "print a CLI JSON envelope")
    .action(async (taskId: string, flags: GlobalOptions, command: Command) => {
      const outputFlags = withInheritedJson(flags, command);
      const response = await callApi("scan.status", { taskId });
      return finishResponse("scan.status", "scan.status", response, outputFlags);
    });
  scan
    .command("cancel")
    .argument("<task-id>", "scan task id")
    .option("--json", "print a CLI JSON envelope")
    .action(async (taskId: string, flags: GlobalOptions, command: Command) => {
      const outputFlags = withInheritedJson(flags, command);
      const status = await callApi("scan.status", { taskId });
      if (!status.ok) return finishResponse("scan.cancel", "scan.status", status, outputFlags);
      if (status.data.cancellable === false) {
        return finishLocalError(
          "scan.cancel",
          localError(
            "TASK_NOT_CANCELLABLE",
            "Scan task is already terminal and cannot be cancelled",
            "Start a new scan if fresh results are needed",
          ),
          outputFlags,
        );
      }
      const response = await callApi("scan.cancel", { taskId });
      return finishResponse("scan.cancel", "scan.cancel", response, outputFlags);
    });

  const assets = program.command("assets").description("Query indexed assets.");
  addAssetListOptions(assets).action(async (flags: ListOptions) => {
    const response = await callApi("assets.list", assetListPayload(flags));
    return finishResponse("assets.list", "assets.list", response, flags);
  });
  addAssetListOptions(assets.command("list")).action(
    async (flags: ListOptions, command: Command) => {
      const outputFlags = inheritListOptions(flags, command);
      const response = await callApi("assets.list", assetListPayload(outputFlags));
      return finishResponse("assets.list", "assets.list", response, outputFlags);
    },
  );
  assets
    .command("get")
    .argument("<asset-id>", "asset id")
    .option("--include <part>", "include normalized, references, or diagnostics", collect, [])
    .option("--json", "print a CLI JSON envelope")
    .action(
      async (
        assetId: string,
        flags: { readonly include?: string[] } & GlobalOptions,
        command: Command,
      ) => {
        const outputFlags = withInheritedJson(flags, command);
        const response = await callApi("assets.get", compact({ assetId, include: flags.include }));
        return finishResponse("assets.get", "assets.get", response, outputFlags);
      },
    );
  assets
    .command("disable")
    .argument("<asset-id>", "asset id")
    .requiredOption(
      "--method <method>",
      "disable method: native, move_file, remove_config_entry, or hub_ignore",
    )
    .option("--json", "print a CLI JSON envelope")
    .action(
      async (
        assetId: string,
        flags: { readonly method: string } & GlobalOptions,
        command: Command,
      ) => {
        const outputFlags = withInheritedJson(flags, command);
        const response = await callApi("assets.disable", { assetId, method: flags.method });
        return finishResponse("assets.disable", "assets.disable", response, outputFlags);
      },
    );
  assets
    .command("enable")
    .argument("<asset-id>", "asset id")
    .option("--json", "print a CLI JSON envelope")
    .action(async (assetId: string, flags: GlobalOptions, command: Command) => {
      const outputFlags = withInheritedJson(flags, command);
      const response = await callApi("assets.enable", { assetId });
      return finishResponse("assets.enable", "assets.enable", response, outputFlags);
    });

  const effective = program.command("effective").description("Resolve effective configuration.");
  addEffectiveOptions(effective).action(async (flags: EffectiveOptions) => {
    const response = await callApi("effective.resolve", effectivePayload(flags));
    return finishResponse("effective", "effective.resolve", response, flags);
  });
  addEffectiveOptions(effective.command("resolve")).action(
    async (flags: EffectiveOptions, command: Command) => {
      const outputFlags = inheritEffectiveOptions(flags, command);
      const response = await callApi("effective.resolve", effectivePayload(outputFlags));
      return finishResponse("effective", "effective.resolve", response, outputFlags);
    },
  );

  const diagnose = program
    .command("diagnose")
    .description("List diagnostics from the current index.")
    .option("--tool <tool>", "tool key to include", collect, [])
    .option("--severity <severity>", "diagnostic severity filter", collect, [])
    .option("--code <code>", "diagnostic code filter", collect, [])
    .option("--cursor <cursor>", "pagination cursor")
    .option("--limit <count>", "page size", parsePositiveInteger)
    .option("--json", "print a CLI JSON envelope")
    .action(async (flags: ListOptions & { readonly code?: string[] }) => {
      const response = await callApi(
        "diagnostics.list",
        compact({
          toolKeys: flags.tool,
          severities: flags.severity,
          codes: flags.code,
          cursor: flags.cursor,
          limit: flags.limit,
        }),
      );
      return finishResponse("diagnose", "diagnostics.list", response, flags);
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
    .option("--json", "print a CLI JSON envelope")
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
        const response = await callApi(
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
        );
        return finishResponse("diagnose.export", "diagnostics.export", response, outputFlags);
      },
    );

  program
    .command("migrate")
    .description("Preview a migration plan.")
    .option("--dry-run", "preview only")
    .option("--source <asset-id>", "source asset id", collect, [])
    .option("--asset <asset-id>", "source asset id", collect, [])
    .option("--target <tool>", "target tool key")
    .option("--to <tool>", "target tool key")
    .option("--scope <scope-id>", "target scope id")
    .option(
      "--conflict <policy>",
      "conflict policy",
      parseChoice(["fail", "replace", "merge"]),
      "fail",
    )
    .option("--json", "print a CLI JSON envelope")
    .action(async (flags: MigrateOptions) => {
      if (flags.dryRun !== true) {
        return finishLocalError(
          "migrate",
          localError(
            "VALIDATION_FAILED",
            "Migration previews require --dry-run",
            "Run migrate with --dry-run and deploy the resulting plan explicitly",
          ),
          flags,
        );
      }
      const sourceAssetIds = [...(flags.source ?? []), ...(flags.asset ?? [])];
      const targetToolKey = flags.target ?? flags.to;
      if (sourceAssetIds.length === 0 || targetToolKey === undefined || flags.scope === undefined) {
        return finishLocalError(
          "migrate",
          localError(
            "VALIDATION_FAILED",
            "Migration preview requires source asset, target tool, and target scope",
            "Provide --asset, --to, and --scope",
          ),
          flags,
        );
      }
      const response = await callApi("migration.preview", {
        sourceAssetIds,
        targetToolKey,
        targetScopeId: flags.scope,
        conflictPolicy: flags.conflict ?? "fail",
      });
      return finishResponse("migrate", "migration.preview", response, flags);
    });

  program
    .command("deploy")
    .argument("[plan-id]", "deployment plan id")
    .option("--plan <plan-id>", "deployment plan id")
    .option("--plan-hash <hash>", "preview plan hash to confirm")
    .option("--confirm <confirmation>", "required confirmation to grant", collect, [])
    .option("--yes", "confirm deployment execution")
    .option("--json", "print a CLI JSON envelope")
    .action(async (planIdArgument: string | undefined, flags: DeployOptions) => {
      const planId = flags.plan ?? planIdArgument;
      if (planId === undefined || flags.planHash === undefined) {
        return finishLocalError(
          "deploy",
          localError(
            "VALIDATION_FAILED",
            "Deployment requires --plan and --plan-hash",
            "Run migrate --dry-run and pass its plan id and plan hash",
          ),
          flags,
        );
      }
      if (!(await confirmed(flags.yes, confirm, `Deploy plan ${planId}?`))) {
        return finishLocalError(
          "deploy",
          localError(
            "USER_CANCELLED",
            "Deployment requires explicit confirmation",
            "Retry with --yes",
          ),
          flags,
        );
      }
      const response = await callApi("deployment.execute", {
        planId,
        confirmedPlanHash: flags.planHash,
        confirmations: flags.confirm ?? [],
      });
      if (!response.ok) return finishResponse("deploy", "deployment.execute", response, flags);
      const detail = await callApi("history.get", { id: response.data.deploymentId });
      return finishResponse("deploy", "history.get", detail, flags);
    });

  program
    .command("rollback")
    .argument("<deployment-id>", "deployment record id")
    .option("--yes", "confirm rollback execution")
    .option("--json", "print a CLI JSON envelope")
    .action(async (deploymentId: string, flags: RollbackOptions) => {
      if (!(await confirmed(flags.yes, confirm, `Roll back deployment ${deploymentId}?`))) {
        return finishLocalError(
          "rollback",
          localError(
            "USER_CANCELLED",
            "Rollback requires explicit confirmation",
            "Retry with --yes",
          ),
          flags,
        );
      }
      const response = await callApi("deployment.rollback", { deploymentId });
      if (!response.ok) return finishResponse("rollback", "deployment.rollback", response, flags);
      const detail = await callApi("history.get", { id: response.data.rollbackId });
      return finishResponse("rollback", "history.get", detail, flags);
    });

  program
    .command("history")
    .description("List deployment and rollback history.")
    .option("--kind <kind>", "history kind to include", collect, [])
    .option("--status <status>", "history status to include", collect, [])
    .option("--from <iso-date-time>", "created-at lower bound")
    .option("--to <iso-date-time>", "created-at upper bound")
    .option("--cursor <cursor>", "pagination cursor")
    .option("--limit <count>", "page size", parsePositiveInteger)
    .option("--json", "print a CLI JSON envelope")
    .action(async (flags: ListOptions) => {
      const response = await callApi("history.list", historyPayload(flags));
      return finishResponse("history", "history.list", response, flags);
    });

  program
    .command("invoke")
    .description("Invoke a raw API command for debugging.")
    .argument("<command>", "stable API command name")
    .option("--payload <json>", "JSON command payload")
    .option("--json", "print a CLI JSON envelope")
    .action(async (name: string, flags: InvokeOptions) => {
      if (!isApiCommandName(name)) {
        return finishLocalError(
          "invoke",
          localError(
            "VALIDATION_FAILED",
            `Unknown command: ${name}`,
            "Use a stable API command name",
          ),
          { ...flags, json: true },
        );
      }
      const parsed = parseJsonPayload(flags.payload);
      if (!parsed.ok) return finishLocalError("invoke", parsed.error, { ...flags, json: true });
      const response = await callApi(name, parsed.payload);
      return finishResponse("invoke", name, response, { ...flags, json: true });
    });

  async function callApi<Name extends ApiCommandName>(
    name: Name,
    payload: unknown,
  ): Promise<ApiResponseFor<Name>> {
    return (await handlers[name]({
      apiVersion: 1,
      requestId: requestId(name),
      payload,
    })) as ApiResponseFor<Name>;
  }

  function finishResponse<Name extends ApiCommandName>(
    command: string,
    apiName: Name,
    response: ApiResponseFor<Name>,
    flags: GlobalOptions,
  ): void {
    if (flags.json === true) {
      stdout(`${JSON.stringify(cliEnvelope(command, response), null, 2)}\n`);
    } else {
      const text = renderText(apiName, response, command);
      if (response.ok) stdout(text);
      else stderr(text);
    }
    if (!response.ok) {
      throw new CommanderError(
        exitCodeForError(response.error.code),
        response.error.code,
        response.error.message,
      );
    }
    const code = isPartialSuccess(response.data) ? 3 : 0;
    if (code !== 0)
      throw new CommanderError(code, "PARTIAL_SUCCESS", "Command completed partially");
  }

  function finishLocalError(command: string, error: ApiError, flags: GlobalOptions): void {
    const envelope = cliErrorEnvelope(command, error);
    if (flags.json === true) {
      stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      stderr(`Error ${error.code}: ${error.message}\n`);
    }
    throw new CommanderError(exitCodeForError(error.code), error.code, error.message);
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

function withInheritedJson<T extends GlobalOptions>(flags: T, command: Command): T {
  const inherited = command.parent?.opts<GlobalOptions>();
  return { ...flags, json: flags.json ?? inherited?.json };
}

function inheritListOptions(flags: ListOptions, command: Command): ListOptions {
  const inherited = command.parent?.opts<ListOptions>();
  return compact({
    ...flags,
    json: flags.json ?? inherited?.json,
    tool: optionList(flags.tool, inherited?.tool),
    resource: optionList(flags.resource, inherited?.resource),
    scopeKind: optionList(flags.scopeKind, inherited?.scopeKind),
    kind: optionList(flags.kind, inherited?.kind),
    status: optionList(flags.status, inherited?.status),
    severity: flags.severity ?? inherited?.severity,
    query: flags.query ?? inherited?.query,
    cursor: flags.cursor ?? inherited?.cursor,
    limit: flags.limit ?? inherited?.limit,
    from: flags.from ?? inherited?.from,
    to: flags.to ?? inherited?.to,
  }) as ListOptions;
}

function inheritEffectiveOptions(flags: EffectiveOptions, command: Command): EffectiveOptions {
  const inherited = command.parent?.opts<EffectiveOptions>();
  return compact({
    ...flags,
    json: flags.json ?? inherited?.json,
    tool: flags.tool ?? inherited?.tool,
    project: flags.project ?? inherited?.project,
    scope: flags.scope ?? inherited?.scope,
    resource: optionList(flags.resource, inherited?.resource),
  }) as EffectiveOptions;
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

function addAssetListOptions(command: Command): Command {
  return command
    .option("--tool <tool>", "tool key to include", collect, [])
    .option("--resource <kind>", "resource kind to include", collect, [])
    .option("--scope-kind <kind>", "scope kind to include", collect, [])
    .option("--severity <severity>", "diagnostic severity filter")
    .option("--query <text>", "text search")
    .option("--cursor <cursor>", "pagination cursor")
    .option("--limit <count>", "page size", parsePositiveInteger)
    .option("--json", "print a CLI JSON envelope");
}

function addEffectiveOptions(command: Command): Command {
  return command
    .requiredOption("--tool <tool>", "tool key")
    .requiredOption("--project <project-id>", "project id")
    .requiredOption("--scope <scope-id>", "target scope id")
    .option("--resource <kind>", "resource kind to include", collect, [])
    .option("--json", "print a CLI JSON envelope");
}

function assetListPayload(flags: ListOptions): Record<string, unknown> {
  return compact({
    toolKeys: flags.tool,
    resourceTypes: flags.resource,
    scopeKinds: flags.scopeKind,
    diagnosticSeverity: flags.severity,
    query: flags.query,
    cursor: flags.cursor,
    limit: flags.limit,
  });
}

function effectivePayload(flags: EffectiveOptions): Record<string, unknown> {
  return compact({
    toolKey: flags.tool,
    projectId: flags.project,
    targetScopeId: flags.scope,
    resourceTypes: flags.resource,
  });
}

function historyPayload(flags: ListOptions): Record<string, unknown> {
  return compact({
    kinds: flags.kind,
    statuses: flags.status,
    from: flags.from,
    to: flags.to,
    cursor: flags.cursor,
    limit: flags.limit,
  });
}

function parseJsonPayload(
  value: string | undefined,
):
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly error: ApiError } {
  if (value === undefined) return { ok: true, payload: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return {
      ok: false,
      error: localError(
        "VALIDATION_FAILED",
        "Payload must be valid JSON",
        "Pass --payload as a JSON object string",
      ),
    };
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return { ok: true, payload: parsed as Record<string, unknown> };
  }
  return {
    ok: false,
    error: localError("VALIDATION_FAILED", "Payload must be a JSON object", "Review the payload"),
  };
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

function cliEnvelope<Name extends ApiCommandName>(
  command: string,
  response: ApiResponseFor<Name>,
): CliJsonEnvelope {
  return response.ok
    ? {
        schemaVersion: 1,
        command,
        ok: true,
        data: response.data,
        meta: {
          generatedAt: new Date().toISOString(),
          partialSuccess: isPartialSuccess(response.data),
        },
      }
    : cliErrorEnvelope(command, response.error);
}

function cliErrorEnvelope(command: string, error: ApiError): CliJsonEnvelope {
  return {
    schemaVersion: 1,
    command,
    ok: false,
    error,
    meta: { generatedAt: new Date().toISOString(), partialSuccess: false },
  };
}

function localError(code: ErrorCode, message: string, action: string): ApiError {
  return {
    code,
    message,
    retryable: false,
    action,
    correlationId: CorrelationIdSchema.parse("correlation:cli"),
  };
}

function exitCodeForError(code: string): number {
  if (code === "VALIDATION_FAILED" || code === "API_VERSION_UNSUPPORTED") return 2;
  if (
    [
      "CONFLICT",
      "STALE_INDEX",
      "STALE_PREVIEW",
      "STALE_TARGET",
      "TARGET_CONFLICT",
      "TARGET_LOCKED",
      "FENCE_REJECTED",
      "TASK_NOT_CANCELLABLE",
      "USER_CANCELLED",
    ].includes(code)
  ) {
    return 4;
  }
  if (["PATH_OUTSIDE_ALLOWED_ROOT", "SYMLINK_ESCAPE", "PERMISSION_DENIED"].includes(code)) return 5;
  if (code === "READ_ONLY_RECOVERY") return 7;
  if (["BACKUP_MISSING", "BACKUP_HASH_MISMATCH"].includes(code)) return 6;
  return 10;
}

function isPartialSuccess(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  return (data as { readonly status?: unknown }).status === "partially_succeeded";
}

async function confirmed(
  yes: boolean | undefined,
  confirm: (message: string) => Promise<boolean>,
  message: string,
): Promise<boolean> {
  if (yes === true) return true;
  return confirm(message);
}

async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`${message} Type yes to continue: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}

function renderText<Name extends ApiCommandName>(
  name: Name,
  response: ApiResponseFor<Name>,
  command: string,
): string {
  if (!response.ok) return `Error ${response.error.code}: ${response.error.message}\n`;
  const data = response.data as Record<string, unknown>;
  if (name === "scan.status") return renderScanStatus(data);
  if (name === "assets.list" && "items" in data && Array.isArray(data.items)) {
    return renderAssets(data.items);
  }
  if (name === "diagnostics.list" && "items" in data && Array.isArray(data.items)) {
    return renderDiagnostics(data.items, data.countsBySeverity);
  }
  if (name === "effective.resolve") return renderEffective(data);
  if (name === "history.list" && "items" in data && Array.isArray(data.items)) {
    return renderHistory(data.items);
  }
  if (name === "history.get" && typeof data.entry === "object" && data.entry !== null) {
    return renderHistoryDetail(data);
  }
  if (name === "diagnostics.export" && typeof data.content === "string") {
    return data.content.endsWith("\n") ? data.content : `${data.content}\n`;
  }
  if (name === "migration.preview") return renderMigrationPreview(data);
  if ("items" in data && Array.isArray(data.items))
    return `${command}: ${data.items.length} item(s)\n`;
  if ("taskId" in data) return `${command}: task ${String(data.taskId)} accepted\n`;
  if (name === "assets.get" && typeof data.asset === "object" && data.asset !== null) {
    const asset = data.asset as { readonly id?: unknown; readonly logicalKey?: unknown };
    const id = typeof asset.id === "string" ? asset.id : "";
    const logicalKey = typeof asset.logicalKey === "string" ? asset.logicalKey : "";
    return `${id} ${logicalKey}\n`;
  }
  if (
    (name === "assets.disable" || name === "assets.enable") &&
    typeof data.assetId === "string" &&
    typeof data.status === "string"
  ) {
    return `${data.assetId} ${data.status}\n`;
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

  const differenceSummary =
    typeof data.differenceSummary === "object" && data.differenceSummary !== null
      ? (data.differenceSummary as Record<string, unknown>)
      : undefined;
  if (differenceSummary !== undefined) {
    lines.push(
      `Groups: ${numberValue(differenceSummary.changedGroupCount)}`,
      `Files: ${numberValue(differenceSummary.changedFileCount)}`,
      `Added: ${numberValue(differenceSummary.addedToTarget)}`,
      `Overwritten: ${numberValue(differenceSummary.overwrittenInTarget)}`,
      `Unchanged planned outputs: ${numberValue(differenceSummary.unchangedPlannedTargetOutputs)}`,
      `Conflicts or warnings: ${numberValue(differenceSummary.conflictsOrWarnings)}`,
    );
  }

  const changes = arrayValue(data.changes).filter(
    (change): change is Record<string, unknown> => typeof change === "object" && change !== null,
  );
  for (const group of arrayValue(data.changeGroups)) {
    if (typeof group !== "object" || group === null) continue;
    const row = group as Record<string, unknown>;
    const groupId = stringValue(row.groupId);
    lines.push(
      `${stringValue(row.operation)} ${stringValue(row.targetRootRelativePath)} (${formatFileCount(
        numberValue(row.changedTargetCount),
      )})`,
    );
    for (const change of changes.filter((item) => stringValue(item.groupId) === groupId)) {
      lines.push(
        `  ${stringValue(change.operation)} ${stringValue(change.pathDisplay)}`,
        `    before: ${nullableHash(change.beforeHash)}`,
        `    after: ${nullableHash(change.afterHash)}`,
      );
      const diff = stringValue(change.diff);
      if (diff.length > 0) lines.push(diff);
    }
    if (row.detailsTruncated === true) {
      lines.push(`  details truncated to ${numberValue(row.visibleDetailCount)} file(s)`);
    }
  }
  if (data.changesTruncated === true) {
    lines.push(`File details truncated to ${numberValue(data.changeDetailLimit)} item(s)`);
  }

  if (arrayValue(data.changeGroups).length === 0) {
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
  }

  lines.push(`Source hashes (${hashRowCount(data.sourceHashes)}):`);
  appendHashRows(lines, data.sourceHashes);
  lines.push(`Target hashes (${hashRowCount(data.targetHashes)}):`);
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

  return `${lines.join("\n")}\n`;
}

function renderScanStatus(data: Record<string, unknown>): string {
  const taskId = stringValue(data.taskId);
  const status = stringValue(data.status);
  const phase = stringValue(data.phase);
  const summary =
    typeof data.resultSummary === "object" && data.resultSummary !== null
      ? (data.resultSummary as Record<string, unknown>)
      : undefined;
  const lines = [`Scan ${taskId}`, `Status: ${status}`, `Phase: ${phase}`];
  if (summary !== undefined) {
    lines.push(
      `Succeeded: ${numberValue(summary.succeededCount)}`,
      `Failed: ${numberValue(summary.failedCount)}`,
      `Skipped: ${numberValue(summary.skippedCount)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderAssets(items: readonly unknown[]): string {
  if (items.length === 0) return "assets.list: no assets found\n";
  return items
    .map((item) => {
      if (typeof item !== "object" || item === null) return "";
      const row = item as Record<string, unknown>;
      const counts =
        typeof row.diagnosticCounts === "object" && row.diagnosticCounts !== null
          ? (row.diagnosticCounts as Record<string, unknown>)
          : {};
      return [
        stringValue(row.id),
        stringValue(row.toolKey),
        stringValue(row.resourceType),
        stringValue(row.scopeKind),
        stringValue(row.logicalKey),
        stringValue(row.status),
        `errors:${numberValue(counts.error)}`,
        `warnings:${numberValue(counts.warning)}`,
      ]
        .filter((part) => part.length > 0)
        .join(" ");
    })
    .filter((line) => line.length > 0)
    .join("\n")
    .concat("\n");
}

function renderDiagnostics(items: readonly unknown[], countsBySeverity: unknown): string {
  if (items.length === 0) return "diagnose: no diagnostics found\n";
  const lines = items
    .map((item) => {
      if (typeof item !== "object" || item === null) return "";
      const row = item as Record<string, unknown>;
      const location =
        typeof row.location === "object" && row.location !== null
          ? renderLocation(row.location as Record<string, unknown>)
          : "";
      return [
        stringValue(row.severity).toUpperCase(),
        stringValue(row.code),
        location,
        stringValue(row.message),
        stringValue(row.suggestedAction),
      ]
        .filter((part) => part.length > 0)
        .join(" ");
    })
    .filter((line) => line.length > 0);
  if (typeof countsBySeverity === "object" && countsBySeverity !== null) {
    const counts = countsBySeverity as Record<string, unknown>;
    lines.push(
      `Counts: error=${numberValue(counts.error)} warning=${numberValue(counts.warning)} info=${numberValue(counts.info)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderEffective(data: Record<string, unknown>): string {
  const effective = data.effective;
  const contributors = arrayValue(data.contributors);
  const ignored = arrayValue(data.ignored);
  const diagnostics = arrayValue(data.diagnostics);
  const covered = ignored.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const ignoredItem = item as Record<string, unknown>;
    if (ignoredItem.coveredByAssetId === undefined) return [];
    return [`${stringValue(ignoredItem.assetId)} -> ${stringValue(ignoredItem.coveredByAssetId)}`];
  });
  return [
    `Effective resources: ${renderJsonSummary(effective)}`,
    `Contributors: ${contributors.length}`,
    `Ignored: ${ignored.length}`,
    ...(covered.length === 0 ? [] : [`Covered: ${covered.join(", ")}`]),
    `Diagnostics: ${diagnostics.length}`,
    `Snapshot: ${stringValue(data.snapshotRevision)}`,
  ]
    .join("\n")
    .concat("\n");
}

function renderHistoryDetail(data: Record<string, unknown>): string {
  const entry = data.entry as Record<string, unknown>;
  const changes = arrayValue(data.changes);
  const differenceSummary =
    typeof data.differenceSummary === "object" && data.differenceSummary !== null
      ? (data.differenceSummary as Record<string, unknown>)
      : undefined;
  const lines = [
    `${stringValue(entry.kind)} ${stringValue(entry.id)} ${stringValue(entry.status)}`,
    differenceSummary === undefined
      ? `Changes: ${changes.length}`
      : `Changes: ${numberValue(differenceSummary.changedGroupCount)} group(s), ${numberValue(
          differenceSummary.changedFileCount,
        )} file(s)`,
  ];
  for (const group of arrayValue(data.changeGroups)) {
    if (typeof group !== "object" || group === null) continue;
    const row = group as Record<string, unknown>;
    lines.push(
      `${stringValue(row.operation)} ${stringValue(row.targetRootRelativePath)} (${formatFileCount(
        numberValue(row.changedTargetCount),
      )})`,
    );
  }
  if (data.changesTruncated === true) {
    lines.push(`File details truncated to ${numberValue(data.changeDetailLimit)} item(s)`);
  }
  return `${lines.join("\n")}\n`;
}

function appendHashRows(lines: string[], hashes: unknown, limit = 20): void {
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
  for (const [label, hash] of entries.slice(0, limit)) {
    lines.push(`  ${label}: ${nullableHash(hash)}`);
  }
  if (entries.length > limit) lines.push(`  ... ${entries.length - limit} more`);
}

function hashRowCount(hashes: unknown): number {
  if (typeof hashes !== "object" || hashes === null || Array.isArray(hashes)) return 0;
  return Object.keys(hashes).length;
}

function formatFileCount(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
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

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function renderLocation(location: Record<string, unknown>): string {
  const path = stringValue(location.pathDisplay);
  const line = numberValue(location.line);
  const column = numberValue(location.column);
  if (path.length === 0) return "";
  if (line === 0) return path;
  return column === 0 ? `${path}:${line}` : `${path}:${line}:${column}`;
}

function renderJsonSummary(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (typeof value === "object" && value !== null) return `${Object.keys(value).length} field(s)`;
  return "0 item(s)";
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
