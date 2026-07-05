import { createHash } from "node:crypto";

import {
  AssetNativeIdentitySchema,
  AssetSourceFileSchema,
  type AssetNativeIdentity,
  type AssetSourceFile,
  type AssetSourceFileRole,
} from "@ai-config-hub/core";
import { ContentHashSchema, type AbsolutePath, type ContentHash } from "@ai-config-hub/shared";

export function sourceFile(input: {
  readonly path: AbsolutePath;
  readonly relativePath: string;
  readonly role: AssetSourceFileRole;
  readonly mediaType: string;
  readonly isText: boolean;
  readonly contentHash: ContentHash;
}): AssetSourceFile {
  return AssetSourceFileSchema.parse(input);
}

export function singleSourceFile(input: {
  readonly path: AbsolutePath;
  readonly relativePath?: string;
  readonly sourceFormat: string;
  readonly contentHash: ContentHash;
}): AssetSourceFile {
  return sourceFile({
    path: input.path,
    relativePath: input.relativePath ?? "source",
    role: "primary",
    mediaType: mediaTypeFromSourceFormat(input.sourceFormat),
    isText: true,
    contentHash: input.contentHash,
  });
}

export function nativeIdentity(input: {
  readonly nativeId: string;
  readonly displayName: string;
  readonly directoryName?: string;
  readonly invocationName?: string;
}): AssetNativeIdentity {
  return AssetNativeIdentitySchema.parse(input);
}

export function packageContentHash(files: readonly AssetSourceFile[]): ContentHash {
  const tuples = files
    .map((file) => [
      file.relativePath,
      file.role,
      file.mediaType,
      file.isText ? "text" : "binary",
      file.contentHash,
    ])
    .sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return ContentHashSchema.parse(
    `sha256:${createHash("sha256").update(JSON.stringify(tuples), "utf8").digest("hex")}`,
  );
}

export function mediaTypeFromPath(path: string, isText: boolean): string {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower.endsWith(".md") || lower.endsWith(".mdc")) return "text/markdown";
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "application/json";
  if (lower.endsWith(".toml")) return "application/toml";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (lower.endsWith(".sh")) return "text/x-shellscript";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs"))
    return "text/javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts"))
    return "text/typescript";
  if (lower.endsWith(".txt")) return "text/plain";
  return isText ? "text/plain" : "application/octet-stream";
}

export function mediaTypeFromSourceFormat(sourceFormat: string): string {
  const normalized = sourceFormat.trim().toLocaleLowerCase("en-US");
  if (normalized === "markdown" || normalized === "md" || normalized === "mdc")
    return "text/markdown";
  if (normalized === "json" || normalized === "jsonc") return "application/json";
  if (normalized === "toml") return "application/toml";
  if (normalized === "yaml" || normalized === "yml") return "application/yaml";
  return "text/plain";
}

export function safeRelativePath(root: AbsolutePath, path: AbsolutePath): string | undefined {
  const normalizedRoot = stripTrailingSlash(toSlash(root));
  const normalizedPath = stripTrailingSlash(toSlash(path));
  const rootPrefix = `${normalizedRoot}/`;
  if (normalizedPath === normalizedRoot) return undefined;
  if (!normalizedPath.startsWith(rootPrefix)) return undefined;

  const relativePath = normalizedPath.slice(rootPrefix.length);
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return relativePath;
}

function toSlash(path: string): string {
  return path.replace(/\\/g, "/");
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
