import { basename, dirname } from "node:path";

import {
  NormalizedResourceSchema,
  type AdapterDiagnostic,
  type ParseContext,
} from "@ai-config-hub/core";
import type { AbsolutePath } from "@ai-config-hub/shared";

import { parseFrontmatter } from "./frontmatter.js";
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

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "target"]);
const MAX_PACKAGE_FILES = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const LOWER_HYPHEN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  const files = await enumeratePackageFiles(context, packageRoot, diagnostics);
  const primary = files.find((file) => file.relativePath === "SKILL.md");
  const skillText =
    primary?.isText === true ? await context.read.readText(primary.path) : context.snapshot.text;
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
        contentHash: packageContentHash(files),
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

async function enumeratePackageFiles(
  context: ParseContext,
  packageRoot: AbsolutePath,
  diagnostics: AdapterDiagnostic[],
) {
  const files = [];
  const stack = [packageRoot];
  let totalBytes = 0;

  while (stack.length > 0) {
    context.signal.throwIfAborted();
    const directory = stack.pop();
    if (directory === undefined) break;
    for (const child of await context.read.list(directory)) {
      const name = basename(child);
      if (IGNORED_DIRECTORIES.has(name)) continue;
      const stat = await context.read.stat(child);
      if (stat.kind === "directory") {
        stack.push(child);
        continue;
      }
      if (stat.kind !== "file") continue;
      const snapshot = await context.read.snapshotFile(child);
      if (snapshot === undefined) continue;
      const relativePath = safeRelativePath(packageRoot, snapshot.canonicalPath);
      if (relativePath === undefined) {
        diagnostics.push(
          skillDiagnostic(context, "SKILL_SUPPORT_FILE_OUTSIDE_PACKAGE", true, {
            relativePath: name,
          }),
        );
        continue;
      }
      if (snapshot.size > MAX_FILE_BYTES) {
        diagnostics.push(
          skillDiagnostic(context, "SKILL_SUPPORT_FILE_TOO_LARGE", true, { relativePath }),
        );
      }
      totalBytes += snapshot.size;
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
      if (files.length > MAX_PACKAGE_FILES) {
        diagnostics.push(skillDiagnostic(context, "SKILL_PACKAGE_TOO_MANY_FILES", true, {}));
        break;
      }
    }
  }

  if (totalBytes > MAX_PACKAGE_BYTES) {
    diagnostics.push(skillDiagnostic(context, "SKILL_PACKAGE_TOO_LARGE", true, {}));
  }

  return files.sort((left, right) => {
    const role = roleOrder(left.role) - roleOrder(right.role);
    return role === 0 ? left.relativePath.localeCompare(right.relativePath) : role;
  });
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
  const relativePath =
    typeof evidence["relativePath"] === "string" ? evidence["relativePath"] : "SKILL.md";
  return nativeDiagnostic({
    code,
    blocking,
    message: `${code} in Skill package`,
    location: { path: context.snapshot.canonicalPath },
    evidence: { relativePath, ...evidence },
  });
}
