import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  Asset,
  AssetDisablementMethod,
  AssetDisablementRecord,
  IndexRepository,
  Scope,
  ToolInstallation,
} from "@ai-config-hub/core";
import { AssetDisablementMethodSchema } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AppError,
  ToolInstallationIdSchema,
  type AbsolutePath,
  type AssetId,
  type IsoDateTime,
} from "@ai-config-hub/shared";

export interface AssetDisablementServiceOptions {
  readonly indexRepository: IndexRepository;
  readonly disabledAssetsRoot: AbsolutePath;
  readonly now: () => IsoDateTime;
}

export interface DisableAssetRequest {
  readonly assetId: AssetId;
  readonly method: AssetDisablementMethod;
}

export interface EnableAssetRequest {
  readonly assetId: AssetId;
}

function appError(
  code: "VALIDATION_FAILED" | "NOT_FOUND" | "CONFLICT" | "STALE_INDEX" | "INTERNAL_ERROR",
  message: string,
  retryable = false,
): AppError {
  return new AppError({
    code,
    message,
    retryable,
    suggestedActions: ["Refresh asset scan results and retry"],
  });
}

function safeSegment(input: string): string {
  const unsafeCharacters = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  return [...input]
    .map((character) =>
      unsafeCharacters.has(character) || character.charCodeAt(0) < 32 ? "-" : character,
    )
    .join("");
}

function locatorName(asset: Asset, prefix: string): string {
  if (!asset.locator.startsWith(prefix)) {
    throw appError("VALIDATION_FAILED", `Asset locator is not a ${prefix} locator`);
  }
  return asset.locator.slice(prefix.length);
}

function isOpenCodeConfigAsset(asset: Asset): boolean {
  return (
    asset.toolId === "opencode" &&
    (asset.resource.kind === "agent" || asset.resource.kind === "mcp") &&
    basename(asset.canonicalSourcePath).startsWith("opencode.json")
  );
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (inString) {
      result += current;
      escaped = current === "\\" ? !escaped : false;
      if (current === '"' && !escaped) inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    result += current;
  }
  return result;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value = JSON.parse(stripJsonComments(text)) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw appError("VALIDATION_FAILED", "Configuration root must be an object");
  }
  return value as Record<string, unknown>;
}

function objectMember(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw appError("VALIDATION_FAILED", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function renderJsonConfig(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function jsonMcpEntryMatchesAsset(entry: Record<string, unknown>, asset: Asset): boolean {
  if (asset.resource.kind !== "mcp") return false;
  const transport = asset.resource.data.transport;
  if (transport.kind === "stdio") {
    const command = entry["command"];
    const expectedArgs = comparableSecretAwareStrings(transport.args);
    if (
      expectedArgs === undefined ||
      Object.keys(transport.env).length > 0 ||
      hasObjectEntries(entry["env"]) ||
      hasObjectEntries(entry["headers"]) ||
      hasObjectEntries(entry["query"]) ||
      entry["userInfo"] !== undefined
    ) {
      return false;
    }
    if (Array.isArray(command)) {
      if (entry["args"] !== undefined) return false;
      return stableJson(command) === stableJson([transport.command, ...expectedArgs]);
    }
    if (typeof command === "string") {
      const args = stringListValue(entry["args"]);
      return (
        command === transport.command &&
        args !== undefined &&
        stableJson(args) === stableJson(expectedArgs)
      );
    }
    return false;
  }
  const endpoint =
    transport.kind === "http" || transport.kind === "sse" ? transport.endpoint : undefined;
  if (
    endpoint === undefined ||
    Object.keys(endpoint.query).length > 0 ||
    endpoint.userInfo !== undefined ||
    Object.keys(transport.headers).length > 0 ||
    hasObjectEntries(entry["env"]) ||
    hasObjectEntries(entry["headers"]) ||
    hasObjectEntries(entry["query"]) ||
    entry["userInfo"] !== undefined
  ) {
    return false;
  }
  const url = entry["url"];
  return (
    typeof url === "string" &&
    endpoint?.baseUrl.kind === "literal" &&
    endpoint.baseUrl.value === url
  );
}

function hasObjectEntries(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function recoveryPersistenceError(input: {
  readonly restoreError: unknown;
  readonly saveError?: unknown;
  readonly statusError?: unknown;
}): AppError {
  return new AppError({
    code: "INTERNAL_ERROR",
    message:
      "Failed to restore disabled asset after persistence failed, and failed to persist recovery metadata",
    retryable: true,
    suggestedActions: [
      "Resolve storage issues, inspect the disabled asset backup, refresh scan results, and retry",
    ],
    safeContext: {
      restoreError: errorSummary(input.restoreError),
      ...(input.saveError === undefined ? {} : { saveError: errorSummary(input.saveError) }),
      ...(input.statusError === undefined ? {} : { statusError: errorSummary(input.statusError) }),
    },
    cause: input.restoreError,
  });
}

function comparableSecretAwareStrings(
  items: readonly {
    readonly kind: string;
    readonly value?: string;
    readonly expression?: string;
  }[],
): readonly string[] | undefined {
  const result: string[] = [];
  for (const item of items) {
    if (item.kind === "literal" && item.value !== undefined) {
      result.push(item.value);
    } else if (item.kind === "reference" && item.expression !== undefined) {
      result.push(item.expression);
    } else {
      return undefined;
    }
  }
  return result;
}

function stringListValue(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? value : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function assertMissing(path: AbsolutePath, message: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw appError("CONFLICT", message, true);
}

async function copyThenRemove(input: {
  readonly source: AbsolutePath;
  readonly target: AbsolutePath;
}): Promise<void> {
  await mkdir(dirname(input.target), { recursive: true, mode: 0o700 });
  await copyFile(input.source, input.target, constants.COPYFILE_EXCL);
  try {
    await unlink(input.source);
  } catch (error) {
    await unlink(input.target).catch((cleanupError: unknown) => {
      if (!isMissing(cleanupError)) throw cleanupError;
    });
    throw error;
  }
}

function tomlTablePattern(tableName: string): RegExp {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`^\[mcp_servers\.("?${escaped}"?)\]\r?\n[\s\S]*?(?=^\[|\s*$)`, "m");
}

function removeTomlTable(
  text: string,
  tableName: string,
): {
  readonly nextText: string;
  readonly removedText: string;
} {
  const pattern = tomlTablePattern(tableName);
  const match = pattern.exec(text);
  if (match === null) {
    throw appError("VALIDATION_FAILED", "Configuration entry was not found");
  }
  const removedText = `${match[0].trimEnd()}\n`;
  const next = text.replace(pattern, "");
  return { nextText: next.trimEnd() === "" ? "" : `${next.trimEnd()}\n`, removedText };
}

function hasTomlTable(text: string, tableName: string): boolean {
  return tomlTablePattern(tableName).test(text);
}

function toolForScope(asset: Asset, scope: Scope): ToolInstallation {
  const evidenceInstallation = scope.discoveryEvidence["installationId"];
  const installationId =
    typeof evidenceInstallation === "string"
      ? evidenceInstallation
      : `${asset.toolId}:${scope.canonicalRootPath}`;
  return {
    toolId: asset.toolId,
    installationId: ToolInstallationIdSchema.parse(installationId),
    configRoots: [scope.canonicalRootPath],
    evidence: { ...scope.discoveryEvidence, restoredFromDisablementRecord: true },
  };
}

function restoreRecord(input: {
  readonly asset: Asset;
  readonly scope: Scope;
  readonly method: AssetDisablementMethod;
  readonly disabledAt: IsoDateTime;
  readonly movedPath?: AbsolutePath;
  readonly originalText?: string;
  readonly originalEntry?: unknown;
  readonly sectionKey?: string;
  readonly nativeField?: string;
  readonly nativeHadValue?: boolean;
  readonly nativePreviousValue?: unknown;
}): AssetDisablementRecord {
  return {
    assetId: input.asset.assetId,
    method: input.method,
    disabledAt: input.disabledAt,
    asset: { ...input.asset, status: "disabled" },
    scope: input.scope,
    tool: toolForScope(input.asset, input.scope),
    restore: {
      sourcePath: input.asset.canonicalSourcePath,
      ...(input.movedPath === undefined ? {} : { movedPath: input.movedPath }),
      ...(input.originalText === undefined ? {} : { originalText: input.originalText }),
      ...(input.originalEntry === undefined ? {} : { originalEntry: input.originalEntry }),
      ...(input.sectionKey === undefined ? {} : { sectionKey: input.sectionKey }),
      ...(input.nativeField === undefined ? {} : { nativeField: input.nativeField }),
      ...(input.nativeHadValue === undefined ? {} : { nativeHadValue: input.nativeHadValue }),
      ...(input.nativePreviousValue === undefined
        ? {}
        : { nativePreviousValue: input.nativePreviousValue }),
    },
  };
}

export class AssetDisablementService {
  constructor(private readonly options: AssetDisablementServiceOptions) {}

  async disable(
    request: DisableAssetRequest,
  ): Promise<{ readonly assetId: AssetId; readonly status: "disabled" }> {
    const method = AssetDisablementMethodSchema.parse(request.method);
    const existingRecord = await this.options.indexRepository.getAssetDisablement(request.assetId);
    if (existingRecord !== undefined) {
      const result = await this.options.indexRepository.setAssetStatus(request.assetId, "disabled");
      return { assetId: result.assetId, status: "disabled" };
    }

    const asset = await this.options.indexRepository.getAsset(request.assetId);
    if (asset === undefined) throw appError("NOT_FOUND", "Asset not found");
    const scope = (await this.options.indexRepository.listScopes()).find(
      ({ scopeId }) => scopeId === asset.scopeId,
    );
    if (scope === undefined) throw appError("NOT_FOUND", "Asset scope not found");

    const disabledAt = this.options.now();
    let record: AssetDisablementRecord;
    let mutatedToolState = false;
    if (method === "hub_ignore") {
      record = restoreRecord({ asset, scope, method, disabledAt });
    } else if (method === "move_file") {
      record = await this.disableByMovingFile(asset, scope, disabledAt);
      mutatedToolState = true;
    } else if (method === "native") {
      record = await this.disableNatively(asset, scope, disabledAt);
      mutatedToolState = true;
    } else {
      record = await this.disableByRemovingConfigEntry(asset, scope, disabledAt);
      mutatedToolState = true;
    }

    try {
      await this.options.indexRepository.saveAssetDisablement(record);
      const result = await this.options.indexRepository.setAssetStatus(request.assetId, "disabled");
      return { assetId: result.assetId, status: "disabled" };
    } catch (error) {
      if (mutatedToolState) {
        try {
          await this.restore(record);
        } catch (restoreError) {
          let saveError: unknown;
          let statusError: unknown;
          try {
            await this.options.indexRepository.saveAssetDisablement(record);
          } catch (error_) {
            saveError = error_;
          }
          try {
            await this.options.indexRepository.setAssetStatus(request.assetId, "disabled");
          } catch (error_) {
            statusError = error_;
          }
          if (saveError !== undefined || statusError !== undefined) {
            throw recoveryPersistenceError({ restoreError, saveError, statusError });
          }
          throw restoreError;
        }
      }
      throw error;
    }
  }

  async enable(
    request: EnableAssetRequest,
  ): Promise<{ readonly assetId: AssetId; readonly status: "enabled" }> {
    const record = await this.options.indexRepository.getAssetDisablement(request.assetId);
    if (record !== undefined) {
      const result = await this.options.indexRepository.setAssetStatus(request.assetId, "enabled");
      try {
        await this.restore(record);
        await this.options.indexRepository.clearAssetDisablement(request.assetId);
        return { assetId: result.assetId, status: "enabled" };
      } catch (error) {
        await this.options.indexRepository
          .setAssetStatus(request.assetId, "disabled")
          .catch(() => undefined);
        throw error;
      }
    } else {
      const asset = await this.options.indexRepository.getAsset(request.assetId);
      if (asset !== undefined && asset.status === "disabled" && isOpenCodeConfigAsset(asset)) {
        const result = await this.options.indexRepository.setAssetStatus(
          request.assetId,
          "enabled",
        );
        try {
          await this.enableNativeAsset(asset);
          return { assetId: result.assetId, status: "enabled" };
        } catch (error) {
          await this.options.indexRepository
            .setAssetStatus(request.assetId, "disabled")
            .catch(() => undefined);
          throw error;
        }
      }
    }
    const result = await this.options.indexRepository.setAssetStatus(request.assetId, "enabled");
    await this.options.indexRepository.clearAssetDisablement(request.assetId);
    return { assetId: result.assetId, status: "enabled" };
  }

  private async disableByMovingFile(
    asset: Asset,
    scope: Scope,
    disabledAt: IsoDateTime,
  ): Promise<AssetDisablementRecord> {
    if (asset.resource.kind === "mcp") {
      throw appError("VALIDATION_FAILED", "MCP assets are disabled by editing configuration");
    }
    if (isOpenCodeConfigAsset(asset)) {
      throw appError("VALIDATION_FAILED", "OpenCode config assets use native disablement");
    }
    const directory = join(this.options.disabledAssetsRoot, safeSegment(asset.assetId));
    const movedPath = AbsolutePathSchema.parse(
      join(directory, basename(asset.canonicalSourcePath)),
    );
    await copyThenRemove({ source: asset.canonicalSourcePath, target: movedPath });
    return restoreRecord({
      asset,
      scope,
      method: "move_file",
      disabledAt,
      movedPath,
    });
  }

  private async disableNatively(
    asset: Asset,
    scope: Scope,
    disabledAt: IsoDateTime,
  ): Promise<AssetDisablementRecord> {
    if (!isOpenCodeConfigAsset(asset)) {
      throw appError("VALIDATION_FAILED", "Native disablement is not available for this asset");
    }
    const originalText = await readFile(asset.canonicalSourcePath, "utf8");
    const document = parseJsonObject(originalText);
    const sectionName = asset.resource.kind === "agent" ? "agent" : "mcp";
    const section = objectMember(document[sectionName], sectionName);
    const entryName = locatorName(asset, `${asset.resource.kind}:`);
    const entry = objectMember(section[entryName], entryName);
    const nativeField = asset.resource.kind === "agent" ? "disable" : "enabled";
    const nativeHadValue = Object.hasOwn(entry, nativeField);
    const nativePreviousValue = entry[nativeField];
    if (asset.resource.kind === "agent") entry[nativeField] = true;
    else entry[nativeField] = false;
    await writeFile(asset.canonicalSourcePath, renderJsonConfig(document), "utf8");
    return restoreRecord({
      asset,
      scope,
      method: "native",
      disabledAt,
      nativeField,
      nativeHadValue,
      ...(nativeHadValue ? { nativePreviousValue } : {}),
    });
  }

  private async disableByRemovingConfigEntry(
    asset: Asset,
    scope: Scope,
    disabledAt: IsoDateTime,
  ): Promise<AssetDisablementRecord> {
    if (asset.resource.kind !== "mcp") {
      throw appError("VALIDATION_FAILED", "Only configuration entries can be removed");
    }
    const originalText = await readFile(asset.canonicalSourcePath, "utf8");
    let nextText: string;
    let originalTextForRecord: string | undefined;
    let originalEntry: unknown;
    let sectionKeyForRecord: string | undefined;
    if (asset.sourceFormat === "toml" || asset.canonicalSourcePath.endsWith("config.toml")) {
      const removed = removeTomlTable(originalText, locatorName(asset, "mcp:"));
      nextText = removed.nextText;
      originalTextForRecord = removed.removedText;
    } else {
      const document = parseJsonObject(originalText);
      const sectionKey =
        asset.resource.kind === "mcp"
          ? document["mcpServers"] === undefined
            ? "mcp"
            : "mcpServers"
          : "agent";
      const section = objectMember(document[sectionKey], sectionKey);
      const entryName = locatorName(asset, `${asset.resource.kind}:`);
      if (!Object.hasOwn(section, entryName)) {
        throw appError("VALIDATION_FAILED", "Configuration entry was not found");
      }
      originalEntry = section[entryName];
      const entry = objectMember(originalEntry, entryName);
      if (!jsonMcpEntryMatchesAsset(entry, asset)) {
        throw appError(
          "STALE_INDEX",
          "Configuration entry no longer matches the scanned asset",
          true,
        );
      }
      sectionKeyForRecord = sectionKey;
      delete section[entryName];
      nextText = renderJsonConfig(document);
    }
    await writeFile(asset.canonicalSourcePath, nextText, "utf8");
    return restoreRecord({
      asset,
      scope,
      method: "remove_config_entry",
      disabledAt,
      ...(originalTextForRecord === undefined ? {} : { originalText: originalTextForRecord }),
      ...(originalEntry === undefined ? {} : { originalEntry }),
      ...(sectionKeyForRecord === undefined ? {} : { sectionKey: sectionKeyForRecord }),
    });
  }

  private async restore(record: AssetDisablementRecord): Promise<void> {
    if (record.method === "hub_ignore") return;
    if (record.method === "move_file") {
      if (record.restore.movedPath === undefined) {
        throw appError("INTERNAL_ERROR", "Moved asset restore path is missing");
      }
      await assertMissing(
        record.restore.sourcePath,
        "Cannot restore disabled asset because a file already exists at the original path",
      );
      await copyThenRemove({
        source: record.restore.movedPath,
        target: record.restore.sourcePath,
      });
      return;
    }
    if (record.method === "native") {
      await this.restoreNativeRecord(record);
      return;
    }
    if (record.method === "remove_config_entry") {
      await this.restoreRemovedConfigEntry(record);
      return;
    }
  }

  private async enableNativeAsset(asset: Asset): Promise<void> {
    if (!isOpenCodeConfigAsset(asset)) {
      throw appError("VALIDATION_FAILED", "Native enablement is not available for this asset");
    }
    const text = await readFile(asset.canonicalSourcePath, "utf8");
    const document = parseJsonObject(text);
    const sectionName = asset.resource.kind === "agent" ? "agent" : "mcp";
    const section = objectMember(document[sectionName], sectionName);
    const entryName = locatorName(asset, `${asset.resource.kind}:`);
    const entry = objectMember(section[entryName], entryName);
    if (asset.resource.kind === "agent") entry["disable"] = false;
    else entry["enabled"] = true;
    await writeFile(asset.canonicalSourcePath, renderJsonConfig(document), "utf8");
  }

  private async restoreNativeRecord(record: AssetDisablementRecord): Promise<void> {
    const nativeField = record.restore.nativeField;
    if (nativeField === undefined) {
      throw appError("INTERNAL_ERROR", "Native restore field is missing");
    }
    const text = await readFile(record.restore.sourcePath, "utf8");
    const document = parseJsonObject(text);
    const sectionName = record.asset.resource.kind === "agent" ? "agent" : "mcp";
    const section = objectMember(document[sectionName], sectionName);
    const entryName = locatorName(record.asset, `${record.asset.resource.kind}:`);
    const entry = objectMember(section[entryName], entryName);
    if (record.restore.nativeHadValue === true) {
      entry[nativeField] = record.restore.nativePreviousValue;
    } else {
      delete entry[nativeField];
    }
    await writeFile(record.restore.sourcePath, renderJsonConfig(document), "utf8");
  }

  private async restoreRemovedConfigEntry(record: AssetDisablementRecord): Promise<void> {
    const entryName = locatorName(record.asset, "mcp:");
    const text = await readFile(record.restore.sourcePath, "utf8");
    if (record.asset.sourceFormat === "toml" || record.restore.sourcePath.endsWith("config.toml")) {
      if (record.restore.originalText === undefined) {
        throw appError("INTERNAL_ERROR", "TOML restore text is missing");
      }
      if (hasTomlTable(text, entryName)) {
        throw appError("CONFLICT", "Cannot restore MCP entry because it already exists", true);
      }
      const nextText =
        text.trimEnd() === ""
          ? record.restore.originalText
          : `${text.trimEnd()}\n\n${record.restore.originalText}`;
      await writeFile(record.restore.sourcePath, nextText, "utf8");
      return;
    }
    if (record.restore.sectionKey === undefined || record.restore.originalEntry === undefined) {
      throw appError("INTERNAL_ERROR", "JSON restore entry metadata is missing");
    }
    const document = parseJsonObject(text);
    const section = objectMember(
      (document[record.restore.sectionKey] ??= {}),
      record.restore.sectionKey,
    );
    if (Object.hasOwn(section, entryName)) {
      throw appError("CONFLICT", "Cannot restore MCP entry because it already exists", true);
    }
    section[entryName] = record.restore.originalEntry;
    await writeFile(record.restore.sourcePath, renderJsonConfig(document), "utf8");
  }
}
