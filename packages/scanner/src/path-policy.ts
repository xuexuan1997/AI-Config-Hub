import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { CanonicalPath, PathPolicyPort } from "@ai-config-hub/core";
import { AbsolutePathSchema, AppError, type AbsolutePath } from "@ai-config-hub/shared";

export interface NodePathPolicyOptions {
  readonly allowedRoots: readonly AbsolutePath[];
  readonly platform?: NodeJS.Platform;
}

function comparisonKey(path: string, platform: NodeJS.Platform): string {
  const normalized = path.endsWith(sep) && path.length > 1 ? path.slice(0, -1) : path;
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function contains(root: string, target: string, platform: NodeJS.Platform): boolean {
  const rootKey = comparisonKey(root, platform);
  const targetKey = comparisonKey(target, platform);
  const pathFromRoot = relative(rootKey, targetKey);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
  );
}

function pathError(code: "PATH_OUTSIDE_ALLOWED_ROOT" | "SYMLINK_ESCAPE", message: string) {
  return new AppError({
    code,
    message,
    retryable: false,
    suggestedActions: ["Choose a path inside a registered configuration root"],
  });
}

async function realpathThroughExistingAncestor(path: string): Promise<string> {
  let cursor = path;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...missingSegments.reverse());
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

export class NodePathPolicy implements PathPolicyPort {
  readonly #platform: NodeJS.Platform;
  readonly #lexicalRoots: readonly AbsolutePath[];
  readonly #canonicalRoots: readonly AbsolutePath[];

  private constructor(options: {
    readonly platform: NodeJS.Platform;
    readonly lexicalRoots: readonly AbsolutePath[];
    readonly canonicalRoots: readonly AbsolutePath[];
  }) {
    this.#platform = options.platform;
    this.#lexicalRoots = options.lexicalRoots;
    this.#canonicalRoots = options.canonicalRoots;
  }

  static async create(options: NodePathPolicyOptions): Promise<NodePathPolicy> {
    if (options.allowedRoots.length === 0)
      throw new TypeError("At least one allowed root is required");
    const platform = options.platform ?? process.platform;
    const lexicalRoots = options.allowedRoots.map((root) =>
      AbsolutePathSchema.parse(resolve(root)),
    );
    const canonicalRoots = await Promise.all(
      lexicalRoots.map(async (root) => AbsolutePathSchema.parse(await realpath(root))),
    );
    return new NodePathPolicy({
      platform,
      lexicalRoots: Object.freeze([...new Set([...lexicalRoots, ...canonicalRoots])]),
      canonicalRoots: Object.freeze(canonicalRoots),
    });
  }

  async canonicalize(input: {
    readonly path: string;
    readonly basePath?: AbsolutePath;
    readonly allowedRoots: readonly AbsolutePath[];
    readonly intent: "read" | "write";
  }): Promise<CanonicalPath> {
    if (input.path.includes("\0")) throw pathError("PATH_OUTSIDE_ALLOWED_ROOT", "Path is invalid");
    const resolved = resolve(input.basePath ?? process.cwd(), input.path);
    if (!isAbsolute(resolved))
      throw pathError("PATH_OUTSIDE_ALLOWED_ROOT", "Path must be absolute");
    const requestedRoots = input.allowedRoots.map((root) => resolve(root));
    if (
      requestedRoots.length === 0 ||
      requestedRoots.some(
        (requestedRoot) =>
          !this.#lexicalRoots.some((root) => contains(root, requestedRoot, this.#platform)),
      )
    ) {
      throw pathError("PATH_OUTSIDE_ALLOWED_ROOT", "Path is outside registered roots");
    }
    const requestedCanonicalRoots = await Promise.all(
      requestedRoots.map(realpathThroughExistingAncestor),
    );
    if (
      ![...requestedRoots, ...requestedCanonicalRoots].some((root) =>
        contains(root, resolved, this.#platform),
      )
    ) {
      throw pathError("PATH_OUTSIDE_ALLOWED_ROOT", "Path is outside registered roots");
    }
    if (
      requestedCanonicalRoots.some(
        (requestedRoot) =>
          !this.#canonicalRoots.some((root) => contains(root, requestedRoot, this.#platform)),
      )
    ) {
      throw pathError("SYMLINK_ESCAPE", "A registered sub-root escapes its capability root");
    }

    let canonical: string;
    try {
      canonical = await realpath(resolved);
    } catch (error) {
      if (
        input.intent === "read" &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        canonical = await realpathThroughExistingAncestor(resolved);
      } else {
        throw error;
      }
    }
    if (!requestedCanonicalRoots.some((root) => contains(root, canonical, this.#platform))) {
      throw pathError("SYMLINK_ESCAPE", "A symbolic link escapes the registered root");
    }
    const path = AbsolutePathSchema.parse(canonical);
    return {
      path,
      comparisonKey: comparisonKey(path, this.#platform),
      displayPath: input.path,
    };
  }
}
