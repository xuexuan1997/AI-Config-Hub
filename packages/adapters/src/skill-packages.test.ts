import type { AdapterReadApi, ParseContext } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ContentHashSchema,
  ToolInstallationIdSchema,
  type AbsolutePath,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import {
  enumerateSkillPackageSourceFiles,
  parseSkillPackage,
  SKILL_PACKAGE_MAX_BYTES,
  SKILL_PACKAGE_MAX_ENTRIES,
  SKILL_PACKAGE_MAX_FILE_BYTES,
  SKILL_PACKAGE_MAX_FILES,
} from "./skill-packages.js";
import { memoryReadApi, neverCancelled } from "./test-support.js";

const packageRoot = AbsolutePathSchema.parse("/skills/example");
const skillPrimaryPath = AbsolutePathSchema.parse("/skills/example/SKILL.md");

describe("Skill package source-file enumeration", () => {
  it("ignores reserved names consistently even when an entry is a regular file", async () => {
    const read = memoryReadApi({
      "/skills/example/SKILL.md": "# Example\n",
      "/skills/example/.git": "regular file, not a directory\n",
      "/skills/example/dist": "regular file, not a directory\n",
      "/skills/example/node_modules": "regular file, not a directory\n",
      "/skills/example/target": "regular file, not a directory\n",
      "/skills/example/references/guide.md": "Guide\n",
      "/skills/example/references/dist": "also ignored by basename\n",
    });

    const result = await enumerateSkillPackageSourceFiles({
      packageRoot,
      read: withReverseListings(read),
      signal: neverCancelled,
    });
    const baseline = await enumerateSkillPackageSourceFiles({
      packageRoot,
      read: memoryReadApi({
        "/skills/example/SKILL.md": "# Example\n",
        "/skills/example/references/guide.md": "Guide\n",
      }),
      signal: neverCancelled,
    });

    expect(result).toMatchObject({
      status: "complete",
      truncated: false,
      overflows: [],
      contentHash: baseline.contentHash,
    });
    expect(result.sourceFiles.map(({ relativePath }) => relativePath)).toEqual([
      "SKILL.md",
      "references/guide.md",
    ]);
  });

  it("visits each canonical directory once when an internal symlink points to an ancestor", async () => {
    const read = memoryReadApi({
      "/skills/example/SKILL.md": "# Example\n",
      "/skills/example/references/guide.md": "Guide\n",
    });

    const result = await enumerateSkillPackageSourceFiles({
      packageRoot,
      read: withCanonicalDirectoryCycle(read),
      signal: neverCancelled,
    });

    expect(result).toMatchObject({
      status: "complete",
      truncated: false,
      overflows: [],
    });
    expect(result.sourceFiles.map(({ relativePath }) => relativePath)).toEqual([
      "SKILL.md",
      "references/guide.md",
    ]);
  });

  it("includes a canonical file only once when a package symlink aliases SKILL.md", async () => {
    const read = memoryReadApi({
      [skillPrimaryPath]: "# Example\n",
    });
    const aliasedRead: AdapterReadApi = Object.freeze({
      ...read,
      async list(path: AbsolutePath) {
        const children = await read.list(path);
        return path === packageRoot ? [...children, skillPrimaryPath] : children;
      },
    });

    const result = await enumerateSkillPackageSourceFiles({
      packageRoot,
      read: aliasedRead,
      signal: neverCancelled,
    });

    expect(result.status).toBe("complete");
    expect(result.sourceFiles.map(({ relativePath, role }) => [relativePath, role])).toEqual([
      ["SKILL.md", "primary"],
    ]);
  });

  it("stops the whole traversal at exactly 500 files and reports a clear overflow", async () => {
    const files: Record<string, string> = {
      "/skills/example/SKILL.md": "# Example\n",
    };
    for (let index = 0; index < SKILL_PACKAGE_MAX_FILES + 25; index += 1) {
      files[`/skills/example/support/file-${String(index).padStart(4, "0")}.txt`] = `${index}\n`;
    }

    const result = await enumerateSkillPackageSourceFiles({
      packageRoot,
      read: memoryReadApi(files),
      signal: neverCancelled,
    });

    expect(result.status).toBe("limit-exceeded");
    expect(result.truncated).toBe(true);
    expect(result.sourceFiles).toHaveLength(SKILL_PACKAGE_MAX_FILES);
    expect(result.sourceFiles[0]?.relativePath).toBe("SKILL.md");
    expect(result.overflows).toEqual([
      {
        kind: "file-count",
        limit: SKILL_PACKAGE_MAX_FILES,
        observedAtLeast: SKILL_PACKAGE_MAX_FILES + 1,
      },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SKILL_PACKAGE_TOO_MANY_FILES", blocking: true }),
    ]);
  });

  it("reports per-file and aggregate package byte limits in the shared result", async () => {
    const files: Record<string, string> = {
      "/skills/example/SKILL.md": "# Example\n",
    };
    const reportedSizes = new Map<string, number>([
      ["/skills/example/SKILL.md", SKILL_PACKAGE_MAX_FILE_BYTES + 1],
    ]);
    for (let index = 0; index < 10; index += 1) {
      const path = `/skills/example/support/file-${index}.txt`;
      files[path] = `${index}\n`;
      reportedSizes.set(path, SKILL_PACKAGE_MAX_FILE_BYTES);
    }
    const snapshotCalls: string[] = [];
    const read = withReportedSizes(
      withSnapshotCalls(memoryReadApi(files), snapshotCalls),
      reportedSizes,
    );

    const result = await enumerateSkillPackageSourceFiles({
      packageRoot,
      read,
      signal: neverCancelled,
    });

    expect(result.status).toBe("limit-exceeded");
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(SKILL_PACKAGE_MAX_BYTES + SKILL_PACKAGE_MAX_FILE_BYTES + 1);
    expect(result.overflows).toEqual([
      {
        kind: "file-size",
        relativePath: "SKILL.md",
        limit: SKILL_PACKAGE_MAX_FILE_BYTES,
        observed: SKILL_PACKAGE_MAX_FILE_BYTES + 1,
      },
      {
        kind: "package-size",
        limit: SKILL_PACKAGE_MAX_BYTES,
        observedAtLeast: SKILL_PACKAGE_MAX_BYTES + SKILL_PACKAGE_MAX_FILE_BYTES + 1,
      },
    ]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "SKILL_PRIMARY_FILE_TOO_LARGE",
      "SKILL_PACKAGE_TOO_LARGE",
    ]);
    expect(snapshotCalls).toEqual(
      Array.from({ length: 8 }, (_, index) => `/skills/example/support/file-${String(index)}.txt`),
    );
  });

  it("does not snapshot an oversized file and continues hashing later bounded files", async () => {
    const largePath = "/skills/example/assets/large.bin";
    const smallPath = "/skills/example/references/guide.md";
    const snapshotCalls: string[] = [];
    const read = withReportedSizes(
      withSnapshotCalls(
        memoryReadApi({
          "/skills/example/SKILL.md": "# Example\n",
          [largePath]: "test double for a very large file",
          [smallPath]: "Guide\n",
        }),
        snapshotCalls,
      ),
      new Map([[largePath, SKILL_PACKAGE_MAX_FILE_BYTES + 1]]),
    );

    const result = await enumerateSkillPackageSourceFiles({
      packageRoot,
      read,
      signal: neverCancelled,
    });

    expect(result.status).toBe("limit-exceeded");
    expect(result.overflows).toEqual([
      {
        kind: "file-size",
        relativePath: "assets/large.bin",
        limit: SKILL_PACKAGE_MAX_FILE_BYTES,
        observed: SKILL_PACKAGE_MAX_FILE_BYTES + 1,
      },
    ]);
    expect(snapshotCalls).toEqual(["/skills/example/SKILL.md", smallPath]);
    expect(result.sourceFiles.map(({ relativePath }) => relativePath)).toEqual([
      "SKILL.md",
      "references/guide.md",
    ]);
  });

  it("stops at the package entry budget even when entries are ignored", async () => {
    const read = memoryReadApi({
      "/skills/example/SKILL.md": "# Example\n",
    });
    const repeatedIgnoredEntry = AbsolutePathSchema.parse("/skills/example/.git");
    const boundedRead: AdapterReadApi = Object.freeze({
      ...read,
      list: (path: AbsolutePath) =>
        Promise.resolve(
          path === packageRoot
            ? Array.from({ length: SKILL_PACKAGE_MAX_ENTRIES + 1 }, () => repeatedIgnoredEntry)
            : [],
        ),
    });

    const result = await enumerateSkillPackageSourceFiles({
      packageRoot,
      read: boundedRead,
      signal: neverCancelled,
    });

    expect(result).toMatchObject({
      status: "limit-exceeded",
      truncated: true,
      overflows: [
        {
          kind: "entry-count",
          limit: SKILL_PACKAGE_MAX_ENTRIES,
          observedAtLeast: SKILL_PACKAGE_MAX_ENTRIES + 1,
        },
      ],
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SKILL_PACKAGE_TOO_MANY_ENTRIES", blocking: true }),
    ]);
  });

  it("rejects package-boundary entries before stat or snapshot reads", async () => {
    const read = memoryReadApi({
      "/skills/example/SKILL.md": "# Example\n",
      "/skills/sibling/secret.md": "secret\n",
    });
    const external = AbsolutePathSchema.parse("/skills/sibling/secret.md");
    const statCalls: AbsolutePath[] = [];
    const snapshotCalls: AbsolutePath[] = [];
    const boundaryRead: AdapterReadApi = Object.freeze({
      ...read,
      async list(path: AbsolutePath) {
        const children = await read.list(path);
        return path === packageRoot ? [...children, external] : children;
      },
      async stat(path: AbsolutePath) {
        statCalls.push(path);
        return read.stat(path);
      },
      async snapshotFile(path: AbsolutePath) {
        snapshotCalls.push(path);
        return read.snapshotFile(path);
      },
    });

    const result = await enumerateSkillPackageSourceFiles({
      packageRoot,
      read: boundaryRead,
      signal: neverCancelled,
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "SKILL_SUPPORT_ENTRY_OUTSIDE_PACKAGE",
        blocking: true,
      }),
    ]);
    expect(statCalls).not.toContain(external);
    expect(snapshotCalls).not.toContain(external);
    expect(result.status).toBe("rejected");
    expect(result.sourceFiles.map(({ relativePath }) => relativePath)).toEqual(["SKILL.md"]);
  });

  it("returns a structured rejection when the Skill primary is missing during package parsing", async () => {
    const read = memoryReadApi({
      "/skills/example/references/guide.md": "Guide\n",
    });

    const result = await parseSkillPackage(parseContext(read));

    expect(result).toMatchObject({
      status: "rejected",
      assets: [],
      diagnostics: [
        expect.objectContaining({
          code: "SKILL_PRIMARY_FILE_MISSING",
          blocking: true,
          evidence: expect.objectContaining({ relativePath: "SKILL.md" }) as unknown,
        }),
      ],
    });
  });

  it("returns a structured rejection instead of parsing an oversized Skill primary", async () => {
    const read = withReportedSizes(
      memoryReadApi({
        [skillPrimaryPath]: "# Example\n",
      }),
      new Map([[skillPrimaryPath, SKILL_PACKAGE_MAX_FILE_BYTES + 1]]),
    );

    const result = await parseSkillPackage(parseContext(read));

    expect(result).toMatchObject({
      status: "rejected",
      assets: [],
      diagnostics: [
        expect.objectContaining({
          code: "SKILL_PRIMARY_FILE_TOO_LARGE",
          blocking: true,
          evidence: expect.objectContaining({
            relativePath: "SKILL.md",
            limitBytes: SKILL_PACKAGE_MAX_FILE_BYTES,
            observedBytes: SKILL_PACKAGE_MAX_FILE_BYTES + 1,
          }) as unknown,
        }),
      ],
    });
  });

  it("rejects a Skill whose primary changed between the scan snapshot and package enumeration", async () => {
    const read = memoryReadApi({
      [skillPrimaryPath]: "# New instructions\n",
    });

    const result = await parseSkillPackage(parseContext(read, "# Old instructions\n"));

    expect(result).toMatchObject({
      status: "rejected",
      assets: [],
      diagnostics: [
        expect.objectContaining({
          code: "SKILL_PRIMARY_CHANGED_DURING_SCAN",
          blocking: true,
          evidence: expect.objectContaining({
            relativePath: "SKILL.md",
            initialContentHash: hashText("# Old instructions\n"),
            enumeratedContentHash: hashText("# New instructions\n"),
          }) as unknown,
        }),
      ],
    });
  });
});

function parseContext(read: AdapterReadApi, text = "# Example\n"): ParseContext {
  return {
    tool: {
      toolId: "codex",
      installationId: ToolInstallationIdSchema.parse("codex-test"),
      configRoots: [AbsolutePathSchema.parse("/skills")],
      evidence: {},
    },
    candidate: {
      toolId: "codex",
      sourcePath: skillPrimaryPath,
      sourceFormat: "yaml-frontmatter-markdown",
      resourceKindHint: "skill",
      scope: {
        kind: "project",
        canonicalRootPath: AbsolutePathSchema.parse("/skills"),
        projectRoot: AbsolutePathSchema.parse("/skills"),
        depth: 0,
        precedence: 100,
      },
    },
    snapshot: {
      canonicalPath: skillPrimaryPath,
      text,
      contentHash: hashText(text),
      modifiedAt: "2026-06-21T08:00:00.000Z",
      size: 10,
    },
    read,
    signal: neverCancelled,
  };
}

function hashText(text: string) {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(text).digest("hex")}`);
}

function withCanonicalDirectoryCycle(read: AdapterReadApi): AdapterReadApi {
  return Object.freeze({
    ...read,
    async list(path: AbsolutePath) {
      const children = await read.list(path);
      return path === packageRoot ? [packageRoot, ...children] : children;
    },
  });
}

function withReportedSizes(
  read: AdapterReadApi,
  reportedSizes: ReadonlyMap<string, number>,
): AdapterReadApi {
  return Object.freeze({
    ...read,
    async stat(path: AbsolutePath) {
      const result = await read.stat(path);
      return { ...result, size: reportedSizes.get(path) ?? result.size };
    },
    async snapshotFile(path: AbsolutePath) {
      const result = await read.snapshotFile(path);
      return result === undefined
        ? undefined
        : { ...result, size: reportedSizes.get(path) ?? result.size };
    },
  });
}

function withSnapshotCalls(read: AdapterReadApi, calls: string[]): AdapterReadApi {
  return Object.freeze({
    ...read,
    async snapshotFile(path: AbsolutePath) {
      calls.push(path);
      return read.snapshotFile(path);
    },
  });
}

function withReverseListings(read: AdapterReadApi): AdapterReadApi {
  return Object.freeze({
    ...read,
    async list(path: AbsolutePath) {
      return [...(await read.list(path))].reverse();
    },
  });
}
import { createHash } from "node:crypto";
