import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Asset, DeploymentRecord, GitCommitSummary, LocalGitPort } from "@ai-config-hub/core";
import type { AbsolutePath, ContentHash, IsoDateTime } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { ConfinedSnapshotFileWriter, LocalHistoryService } from "./snapshot-service.js";

const now: IsoDateTime = "2026-06-22T12:00:00Z";
const hashA = `sha256:${"a".repeat(64)}` as ContentHash;
const hashB = `sha256:${"b".repeat(64)}` as ContentHash;
const hashC = `sha256:${"c".repeat(64)}` as ContentHash;

describe("LocalHistoryService", () => {
  it("writes sanitized deterministic asset and deployment snapshots", async () => {
    const root = await tempRoot();
    const git = new RecordingGit();
    const service = new LocalHistoryService({ git, now: () => now });
    const deployment = deploymentRecord();
    const first = await service.recordDeployment({
      root,
      assets: [mcpAsset(), ruleAsset()],
      deployment,
    });
    const assetText = await readFile(join(root, "assets/asset-mcp.json"), "utf8");
    const deploymentText = await readFile(join(root, "deployments/deployment-1.json"), "utf8");

    expect(first.subject).toBe("record deployment deployment-1");
    expect(git.snapshots[0]?.paths).toEqual([
      "assets/asset-mcp.json",
      "assets/asset-rule.json",
      "deployments/deployment-1.json",
    ]);
    expect(assetText).toContain('"kind": "literal"');
    expect(assetText).toContain('"kind": "reference"');
    expect(assetText).toContain('"deployable": true');
    expect(assetText).not.toContain("token-secret");
    expect(assetText).not.toContain("${TOKEN}");
    expect(assetText).not.toContain("/Users/xuexuan");
    expect(deploymentText).toContain('"targetPathDigest"');
    expect(deploymentText).toContain('"nextTextHash"');
    expect(deploymentText).not.toContain("/Users/xuexuan");
    expect(deploymentText).not.toContain("Use strict TypeScript");

    const second = await service.recordDeployment({
      root,
      assets: [ruleAsset(), mcpAsset()],
      deployment,
    });
    expect(second.commitId).toBe("commit-2");
    expect(await readFile(join(root, "assets/asset-mcp.json"), "utf8")).toBe(assetText);
    expect(await readFile(join(root, "deployments/deployment-1.json"), "utf8")).toBe(
      deploymentText,
    );
  });

  it("proxies history list and diff through the local git port", async () => {
    const root = await tempRoot();
    const git = new RecordingGit();
    const service = new LocalHistoryService({ git, now: () => now });

    expect(await service.list(root, 10, "cursor-1")).toEqual([
      { commitId: "history-1", subject: "old", authoredAt: now },
    ]);
    expect(await service.diff(root, "a", "b")).toBe("diff:a:b");
  });

  it("confines snapshot writes to assets and deployments", async () => {
    const root = await tempRoot();
    const writer = new ConfinedSnapshotFileWriter();

    await expect(writer.writeText(root, "../escape.json", "{}\n")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ALLOWED_ROOT",
    });
    await expect(writer.writeText(root, ".git/config.json", "{}\n")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ALLOWED_ROOT",
    });
  });
});

class RecordingGit implements LocalGitPort {
  readonly snapshots: {
    readonly root: AbsolutePath;
    readonly paths: readonly string[];
    readonly message: string;
    readonly authoredAt: IsoDateTime;
  }[] = [];

  async initialize(): Promise<void> {}

  snapshot(input: {
    readonly root: AbsolutePath;
    readonly paths: readonly string[];
    readonly message: string;
    readonly authoredAt: IsoDateTime;
  }): Promise<GitCommitSummary> {
    this.snapshots.push(input);
    return Promise.resolve({
      commitId: `commit-${String(this.snapshots.length)}`,
      subject: input.message,
      authoredAt: input.authoredAt,
    });
  }

  diff(input: { readonly from?: string; readonly to?: string }): Promise<string> {
    return Promise.resolve(`diff:${input.from ?? ""}:${input.to ?? ""}`);
  }

  history(): Promise<readonly GitCommitSummary[]> {
    return Promise.resolve([{ commitId: "history-1", subject: "old", authoredAt: now }]);
  }
}

async function tempRoot(): Promise<AbsolutePath> {
  return await mkdtemp(join(tmpdir(), "aich-history-"));
}

function mcpAsset(): Asset {
  return {
    assetId: typedId<Asset["assetId"]>("asset-mcp"),
    toolId: "codex",
    resource: {
      kind: "mcp",
      data: {
        name: "search",
        transport: {
          kind: "stdio",
          command: "node",
          args: [{ kind: "literal", value: "token-secret", deployable: true }],
          env: {
            TOKEN: { kind: "reference", expression: "${TOKEN}", deployable: true },
            STORED: { kind: "redacted", digest: hashC, deployable: false },
          },
        },
        extensions: {},
      },
    },
    scopeId: typedId<Asset["scopeId"]>("scope-1"),
    canonicalSourcePath: "/Users/xuexuan/.codex/config.toml",
    locator: "/mcp/search",
    sourceFormat: "toml",
    contentHash: hashA,
    sourceFiles: [
      {
        path: "/Users/xuexuan/.codex/config.toml",
        relativePath: "config.toml",
        role: "primary",
        mediaType: "application/toml",
        isText: true,
        contentHash: hashA,
      },
    ],
    nativeIdentity: { nativeId: "mcp:search", displayName: "search" },
    normalizedSchemaVersion: "1.0.0",
    adapterId: typedId<Asset["adapterId"]>("codex.builtin"),
    adapterVersion: "1.0.0",
    discoveredAt: now,
    references: ["${TOKEN}"],
    status: "enabled",
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  };
}

function ruleAsset(): Asset {
  return {
    assetId: typedId<Asset["assetId"]>("asset-rule"),
    toolId: "cursor",
    resource: {
      kind: "rule",
      data: {
        name: "strict",
        instructions: "Use strict TypeScript",
        globs: ["**/*.ts"],
        extensions: {},
      },
    },
    scopeId: typedId<Asset["scopeId"]>("scope-2"),
    canonicalSourcePath: "/Users/xuexuan/project/.cursor/rules/project.mdc",
    locator: "/rule/strict",
    sourceFormat: "markdown",
    contentHash: hashB,
    sourceFiles: [
      {
        path: "/Users/xuexuan/project/.cursor/rules/project.mdc",
        relativePath: "project.mdc",
        role: "primary",
        mediaType: "text/markdown",
        isText: true,
        contentHash: hashB,
      },
    ],
    nativeIdentity: { nativeId: "rule:strict", displayName: "strict" },
    normalizedSchemaVersion: "1.0.0",
    adapterId: typedId<Asset["adapterId"]>("cursor.builtin"),
    adapterVersion: "1.0.0",
    discoveredAt: now,
    references: [],
    status: "enabled",
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  };
}

function deploymentRecord(): DeploymentRecord {
  return {
    deploymentRecordId: typedId<DeploymentRecord["deploymentRecordId"]>("deployment-1"),
    deploymentPlanId: typedId<DeploymentRecord["deploymentPlanId"]>("plan-1"),
    confirmedPlanHash: hashA,
    status: "succeeded",
    operations: [
      {
        kind: "replace",
        targetPath: "/Users/xuexuan/project/.cursor/rules/project.mdc",
        nextText: "Use strict TypeScript",
        expectedTargetHash: hashB,
        deploymentType: "generated_file",
      },
    ],
    backupLocations: {
      "/Users/xuexuan/project/.cursor/rules/project.mdc":
        "/Users/xuexuan/Library/Application Support/AI Config Hub/backups/project.mdc",
    },
    resultingHashes: { "/Users/xuexuan/project/.cursor/rules/project.mdc": hashC },
    verificationResult: { status: "passed", verifiedHashes: {}, diagnostics: [] },
    rollbackResults: [],
    adapterId: typedId<DeploymentRecord["adapterId"]>("cursor.builtin"),
    adapterVersion: "1.0.0",
    normalizedSchemaVersion: "1.0.0",
    createdAt: now,
    confirmedAt: now,
    startedAt: now,
    finishedAt: now,
    correlationId: typedId<DeploymentRecord["correlationId"]>("corr-1"),
    diagnostics: [],
  };
}

function typedId<T extends string>(value: string): T {
  return value as T;
}
