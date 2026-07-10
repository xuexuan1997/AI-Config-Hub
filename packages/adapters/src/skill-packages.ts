import { basename, dirname } from "node:path";

import {
  NormalizedResourceSchema,
  type AdapterReadApi,
  type AdapterDiagnostic,
  type AssetSourceFile,
  type CancellationSignal,
  type ParseContext,
} from "@ai-config-hub/core";
import type { AbsolutePath, ContentHash } from "@ai-config-hub/shared";

import { parseFrontmatter } from "./frontmatter.js";
import { AdapterDiscoveryLimitError } from "./discovery.js";
import { nativeDiagnostic } from "./native-diagnostics.js";
import {
  mediaTypeFromPath,
  nativeIdentity,
  packageContentHash,
  safeRelativePath,
  sourceFile,
} from "./source-files.js";
import { redactStructuredValue } from "./secrets.js";
import { stringValue, withoutKeys } from "./markdown-assets.js";

const IGNORED_PACKAGE_ENTRY_NAMES = new Set([".git", "node_modules", "dist", "target"]);
export const SKILL_PACKAGE_MAX_FILES = 500;
export const SKILL_PACKAGE_MAX_ENTRIES = 2_000;
export const SKILL_PACKAGE_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SKILL_PACKAGE_MAX_BYTES = 50 * 1024 * 1024;
const LOWER_HYPHEN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillPackageOverflow =
  | {
      readonly kind: "entry-count";
      readonly limit: number;
      readonly observedAtLeast: number;
    }
  | {
      readonly kind: "file-count";
      readonly limit: number;
      readonly observedAtLeast: number;
    }
  | {
      readonly kind: "file-size";
      readonly relativePath: string;
      readonly limit: number;
      readonly observed: number;
    }
  | {
      readonly kind: "package-size";
      readonly limit: number;
      readonly observedAtLeast: number;
    };

export interface SkillPackageSourceFilesResult {
  readonly status: "complete" | "limit-exceeded" | "rejected";
  readonly packageRoot: AbsolutePath;
  readonly sourceFiles: readonly AssetSourceFile[];
  readonly contentHash: ContentHash;
  readonly totalBytes: number;
  /** True only when enumeration stopped before visiting every package entry. */
  readonly truncated: boolean;
  readonly overflows: readonly SkillPackageOverflow[];
  readonly diagnostics: readonly AdapterDiagnostic[];
}

export interface EnumerateSkillPackageSourceFilesInput {
  readonly packageRoot: AbsolutePath;
  readonly read: AdapterReadApi;
  readonly signal: CancellationSignal;
  /** Location used for diagnostics; defaults to the canonical package root. */
  readonly diagnosticPath?: AbsolutePath;
}

const SKILL_EXTENSION_KEYS = [
  "when_to_use",
  "argument-hint",
  "arguments",
  "disable-model-invocation",
  "user-invocable",
  "paths",
  "license",
  "compatibility",
  "metadata",
] as const;

export async function parseSkillPackage(context: ParseContext) {
  const packageRoot = await context.read.realpath(dirname(context.snapshot.canonicalPath));
  const diagnostics: AdapterDiagnostic[] = [];
  const enumeration = await enumerateSkillPackageSourceFiles({
    packageRoot,
    read: context.read,
    signal: context.signal,
    diagnosticPath: context.snapshot.canonicalPath,
  });
  const files = enumeration.sourceFiles;
  diagnostics.push(...enumeration.diagnostics);
  const primary = files.find((file) => file.relativePath === "SKILL.md");
  if (primary === undefined) {
    if (!diagnostics.some(({ code }) => code === "SKILL_PRIMARY_FILE_TOO_LARGE")) {
      diagnostics.push(
        packageDiagnostic(context.snapshot.canonicalPath, "SKILL_PRIMARY_FILE_MISSING", {
          relativePath: "SKILL.md",
        }),
      );
    }
    return { status: "rejected" as const, assets: [] as const, diagnostics };
  }
  if (primary.contentHash !== context.snapshot.contentHash) {
    diagnostics.push(
      packageDiagnostic(context.snapshot.canonicalPath, "SKILL_PRIMARY_CHANGED_DURING_SCAN", {
        relativePath: "SKILL.md",
        initialContentHash: context.snapshot.contentHash,
        enumeratedContentHash: primary.contentHash,
      }),
    );
    return { status: "rejected" as const, assets: [] as const, diagnostics };
  }
  if (
    enumeration.status === "limit-exceeded" ||
    enumeration.diagnostics.some(({ blocking }) => blocking)
  ) {
    return { status: "rejected" as const, assets: [] as const, diagnostics };
  }
  const skillText = context.snapshot.text;
  const parsed = parseFrontmatter(skillText);
  const directoryName = basename(packageRoot);
  const frontmatterName = stringValue(parsed.attributes["name"]);
  const description = stringValue(parsed.attributes["description"]);
  const displayName = frontmatterName ?? directoryName;
  const packagePath = packageRelativeLocator(context, packageRoot, directoryName);
  const identity = nativeIdentity({
    nativeId: `skill:${packagePath}`,
    displayName,
    directoryName,
    invocationName: context.tool.toolId === "claude-code" ? directoryName : displayName,
  });
  diagnostics.push(
    ...skillMetadataDiagnostics(context, frontmatterName, description, directoryName),
  );
  diagnostics.push(...markdownLinkDiagnostics(context, parsed.body, files));
  diagnostics.push(...unsupportedFieldDiagnostics(context, parsed.attributes));

  const extensions = redactStructuredValue(
    withoutKeys(parsed.attributes, ["name", "description", "references"]),
  ) as Readonly<Record<string, unknown>>;
  const resource = NormalizedResourceSchema.parse({
    kind: "skill",
    data: {
      name: displayName,
      ...(description === undefined ? {} : { description }),
      instructions: parsed.body.trim() === "" ? skillText.trim() : parsed.body.trim(),
      references: [],
      extensions,
    },
  });

  return {
    status: "parsed" as const,
    assets: [
      {
        toolId: context.candidate.toolId,
        canonicalSourcePath: context.snapshot.canonicalPath,
        locator: `skill:${packagePath}`,
        scope: context.candidate.scope,
        sourceFormat: context.candidate.sourceFormat,
        sourceContentHash: context.snapshot.contentHash,
        contentHash: enumeration.contentHash,
        sourceFiles: files,
        nativeIdentity: identity,
        resource,
        references: [],
        extensions: {},
      },
    ],
    diagnostics,
  };
}

/**
 * Enumerates and hashes a Skill package with the exact policy used by parsing.
 * Callers that validate live source drift should reuse this result instead of
 * independently walking the directory.
 */
export async function enumerateSkillPackageSourceFiles(
  input: EnumerateSkillPackageSourceFilesInput,
): Promise<SkillPackageSourceFilesResult> {
  const packageRoot = await input.read.realpath(input.packageRoot);
  const diagnosticPath = input.diagnosticPath ?? packageRoot;
  const files: AssetSourceFile[] = [];
  const diagnostics: AdapterDiagnostic[] = [];
  const overflows: SkillPackageOverflow[] = [];
  const visitedDirectories = new Set<AbsolutePath>();
  const visitedFiles = new Set<AbsolutePath>();
  let visitedEntryCount = 0;
  let visitedFileCount = 0;
  let totalBytes = 0;
  let truncated = false;
  let packageLimitExceeded = false;

  async function visit(directory: AbsolutePath): Promise<void> {
    input.signal.throwIfAborted();
    const canonicalDirectory = await input.read.realpath(directory);
    if (visitedDirectories.has(canonicalDirectory)) return;
    if (
      canonicalDirectory !== packageRoot &&
      safeRelativePath(packageRoot, canonicalDirectory) === undefined
    ) {
      diagnostics.push(
        packageDiagnostic(diagnosticPath, "SKILL_SUPPORT_DIRECTORY_OUTSIDE_PACKAGE", {
          relativePath: basename(directory),
        }),
      );
      return;
    }
    visitedDirectories.add(canonicalDirectory);
    const children = [...(await input.read.list(canonicalDirectory))].sort(compareStrings);
    for (const child of children) {
      input.signal.throwIfAborted();
      visitedEntryCount += 1;
      if (visitedEntryCount > SKILL_PACKAGE_MAX_ENTRIES) {
        throw new AdapterDiscoveryLimitError(
          packageRoot,
          SKILL_PACKAGE_MAX_ENTRIES,
          visitedEntryCount,
        );
      }
      const name = basename(child);
      // The policy is name-based, not kind-based. A regular file named `dist`
      // is ignored just like a directory with that name.
      if (IGNORED_PACKAGE_ENTRY_NAMES.has(name)) continue;
      const canonicalChild = await input.read.realpath(child);
      if (canonicalChild === packageRoot) continue;
      const relativeChildPath = safeRelativePath(packageRoot, canonicalChild);
      if (relativeChildPath === undefined) {
        diagnostics.push(
          packageDiagnostic(diagnosticPath, "SKILL_SUPPORT_ENTRY_OUTSIDE_PACKAGE", {
            relativePath: name,
          }),
        );
        continue;
      }
      const stat = await input.read.stat(canonicalChild);
      if (stat.kind === "directory") {
        await visit(canonicalChild);
        if (truncated) return;
        continue;
      }
      if (stat.kind !== "file") continue;
      if (visitedFiles.has(canonicalChild)) continue;
      visitedFiles.add(canonicalChild);

      if (visitedFileCount === SKILL_PACKAGE_MAX_FILES) {
        truncated = true;
        overflows.push({
          kind: "file-count",
          limit: SKILL_PACKAGE_MAX_FILES,
          observedAtLeast: SKILL_PACKAGE_MAX_FILES + 1,
        });
        diagnostics.push(
          packageDiagnostic(diagnosticPath, "SKILL_PACKAGE_TOO_MANY_FILES", {
            limitFiles: SKILL_PACKAGE_MAX_FILES,
            observedFilesAtLeast: SKILL_PACKAGE_MAX_FILES + 1,
          }),
        );
        return;
      }
      visitedFileCount += 1;
      totalBytes += stat.size;

      const fileLimitExceeded = stat.size > SKILL_PACKAGE_MAX_FILE_BYTES;
      if (fileLimitExceeded) {
        const code =
          relativeChildPath === "SKILL.md"
            ? "SKILL_PRIMARY_FILE_TOO_LARGE"
            : "SKILL_SUPPORT_FILE_TOO_LARGE";
        overflows.push({
          kind: "file-size",
          relativePath: relativeChildPath,
          limit: SKILL_PACKAGE_MAX_FILE_BYTES,
          observed: stat.size,
        });
        diagnostics.push(
          packageDiagnostic(diagnosticPath, code, {
            relativePath: relativeChildPath,
            limitBytes: SKILL_PACKAGE_MAX_FILE_BYTES,
            observedBytes: stat.size,
          }),
        );
      }
      if (totalBytes > SKILL_PACKAGE_MAX_BYTES) packageLimitExceeded = true;
      if (fileLimitExceeded || packageLimitExceeded) continue;

      const snapshot = await input.read.snapshotFile(canonicalChild);
      if (snapshot === undefined) {
        totalBytes -= stat.size;
        continue;
      }
      totalBytes += snapshot.size - stat.size;
      const relativePath = safeRelativePath(packageRoot, snapshot.canonicalPath);
      if (relativePath === undefined) {
        diagnostics.push(
          packageDiagnostic(diagnosticPath, "SKILL_SUPPORT_FILE_OUTSIDE_PACKAGE", {
            relativePath: name,
          }),
        );
        continue;
      }
      if (snapshot.size > SKILL_PACKAGE_MAX_FILE_BYTES) {
        const code =
          relativePath === "SKILL.md"
            ? "SKILL_PRIMARY_FILE_TOO_LARGE"
            : "SKILL_SUPPORT_FILE_TOO_LARGE";
        overflows.push({
          kind: "file-size",
          relativePath,
          limit: SKILL_PACKAGE_MAX_FILE_BYTES,
          observed: snapshot.size,
        });
        diagnostics.push(
          packageDiagnostic(diagnosticPath, code, {
            relativePath,
            limitBytes: SKILL_PACKAGE_MAX_FILE_BYTES,
            observedBytes: snapshot.size,
          }),
        );
        continue;
      }
      if (totalBytes > SKILL_PACKAGE_MAX_BYTES) {
        packageLimitExceeded = true;
        continue;
      }
      files.push(
        sourceFile({
          path: snapshot.canonicalPath,
          relativePath,
          role: sourceRole(relativePath),
          mediaType: mediaTypeFromPath(relativePath, snapshot.isText),
          isText: snapshot.isText,
          contentHash: snapshot.contentHash,
        }),
      );
    }
  }

  try {
    await visit(packageRoot);
  } catch (error) {
    if (!(error instanceof AdapterDiscoveryLimitError)) throw error;
    truncated = true;
    overflows.push({
      kind: "entry-count",
      limit: error.limit,
      observedAtLeast: error.observedAtLeast,
    });
    diagnostics.push(
      packageDiagnostic(diagnosticPath, "SKILL_PACKAGE_TOO_MANY_ENTRIES", {
        limitEntries: error.limit,
        observedEntriesAtLeast: error.observedAtLeast,
      }),
    );
  }

  if (packageLimitExceeded) {
    overflows.push({
      kind: "package-size",
      limit: SKILL_PACKAGE_MAX_BYTES,
      observedAtLeast: totalBytes,
    });
    diagnostics.push(
      packageDiagnostic(diagnosticPath, "SKILL_PACKAGE_TOO_LARGE", {
        limitBytes: SKILL_PACKAGE_MAX_BYTES,
        observedBytesAtLeast: totalBytes,
      }),
    );
  }

  const sourceFiles = Object.freeze(
    files.sort((left, right) => {
      const role = roleOrder(left.role) - roleOrder(right.role);
      return role === 0 ? compareStrings(left.relativePath, right.relativePath) : role;
    }),
  );
  const frozenOverflows = Object.freeze(overflows);
  const status =
    frozenOverflows.length > 0
      ? ("limit-exceeded" as const)
      : diagnostics.some(({ blocking }) => blocking)
        ? ("rejected" as const)
        : ("complete" as const);
  return Object.freeze({
    status,
    packageRoot,
    sourceFiles,
    contentHash: packageContentHash(sourceFiles),
    totalBytes,
    truncated,
    overflows: frozenOverflows,
    diagnostics: Object.freeze(diagnostics),
  });
}

function packageDiagnostic(
  locationPath: AbsolutePath,
  code: string,
  evidence: Readonly<Record<string, unknown>>,
): AdapterDiagnostic {
  const relativePath =
    typeof evidence["relativePath"] === "string" ? evidence["relativePath"] : "SKILL.md";
  return nativeDiagnostic({
    code,
    blocking: true,
    message: `${code} in Skill package`,
    location: { path: locationPath },
    evidence: { relativePath, ...evidence },
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceRole(relativePath: string) {
  if (relativePath === "SKILL.md") return "primary" as const;
  if (relativePath === "agents/openai.yaml") return "metadata" as const;
  return "support" as const;
}

function roleOrder(role: "primary" | "metadata" | "support") {
  return role === "primary" ? 0 : role === "metadata" ? 1 : 2;
}

function packageRelativeLocator(
  context: ParseContext,
  packageRoot: AbsolutePath,
  directoryName: string,
): string {
  for (const root of context.tool.configRoots) {
    const relativePath = safeRelativePath(root, packageRoot);
    if (relativePath !== undefined) return relativePath;
  }
  return directoryName;
}

function skillMetadataDiagnostics(
  context: ParseContext,
  name: string | undefined,
  description: string | undefined,
  directoryName: string,
) {
  const diagnostics = [];
  const requiresName = context.tool.toolId !== "claude-code";
  const requiresDescription = context.tool.toolId !== "claude-code";
  const requiresNameMatch = context.tool.toolId === "cursor" || context.tool.toolId === "opencode";
  const requiresLowerHyphen =
    context.tool.toolId === "cursor" || context.tool.toolId === "opencode";

  if (requiresName && name === undefined) {
    diagnostics.push(skillDiagnostic(context, "SKILL_NAME_REQUIRED", true, { field: "name" }));
  }
  if (requiresDescription && description === undefined) {
    diagnostics.push(
      skillDiagnostic(context, "SKILL_DESCRIPTION_REQUIRED", true, { field: "description" }),
    );
  }
  if (name !== undefined && requiresLowerHyphen) {
    const validFormat = LOWER_HYPHEN_NAME.test(name);
    const validLength = context.tool.toolId !== "opencode" || name.length <= 64;
    if (!validFormat || !validLength) {
      diagnostics.push(skillDiagnostic(context, "SKILL_NAME_INVALID", true, { field: "name" }));
    }
  }
  if (name !== undefined && requiresNameMatch && name !== directoryName) {
    diagnostics.push(
      skillDiagnostic(context, "SKILL_NAME_DIRECTORY_MISMATCH", true, { field: "name" }),
    );
  }

  return diagnostics;
}

function markdownLinkDiagnostics(
  context: ParseContext,
  body: string,
  files: readonly { readonly relativePath: string }[],
) {
  const diagnostics = [];
  const relativePaths = new Set(files.map((file) => file.relativePath));
  for (const link of markdownLinks(body)) {
    const relativePath = normalizeMarkdownLink(link);
    if (relativePath === undefined) continue;
    if (!relativePaths.has(relativePath)) {
      diagnostics.push(
        skillDiagnostic(context, "SKILL_MARKDOWN_LINK_UNRESOLVED", true, { relativePath }),
      );
    }
  }
  return diagnostics;
}

function unsupportedFieldDiagnostics(
  context: ParseContext,
  attributes: Readonly<Record<string, unknown>>,
) {
  return SKILL_EXTENSION_KEYS.filter((key) => Object.hasOwn(attributes, key)).map((field) =>
    skillDiagnostic(context, "SKILL_UNSUPPORTED_NATIVE_FIELD", false, { field }),
  );
}

function markdownLinks(body: string): readonly string[] {
  return [...body.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1]?.trim())
    .filter((link): link is string => link !== undefined && link !== "");
}

function normalizeMarkdownLink(link: string): string | undefined {
  if (URL.canParse(link) || link.startsWith("#")) return undefined;
  const [withoutQuery] = link.split(/[?#]/, 1);
  if (withoutQuery === undefined || withoutQuery === "") return undefined;
  const normalized = withoutQuery.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return normalized;
  }
  return normalized;
}

function skillDiagnostic(
  context: ParseContext,
  code: string,
  blocking: boolean,
  evidence: Readonly<Record<string, unknown>>,
) {
  if (blocking) return packageDiagnostic(context.snapshot.canonicalPath, code, evidence);
  const relativePath =
    typeof evidence["relativePath"] === "string" ? evidence["relativePath"] : "SKILL.md";
  return nativeDiagnostic({
    code,
    blocking: false,
    message: `${code} in Skill package`,
    location: { path: context.snapshot.canonicalPath },
    evidence: { relativePath, ...evidence },
  });
}
