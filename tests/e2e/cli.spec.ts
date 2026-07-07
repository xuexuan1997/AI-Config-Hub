import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);
const cliEntry = join(process.cwd(), "apps/cli/dist/index.js");

interface CliJsonResponse {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: unknown;
}

interface AssetSummary {
  readonly id: string;
  readonly toolKey: string;
  readonly resourceType: string;
  readonly logicalKey: string;
}

interface MigrationPreviewData {
  readonly planId: string;
  readonly planHash: string;
  readonly requiredConfirmations: readonly string[];
  readonly changeGroups: readonly {
    readonly groupId: string;
    readonly operation: string;
    readonly targetRootRelativePath: string;
    readonly changedTargetCount: number;
  }[];
  readonly differenceSummary: {
    readonly changedGroupCount: number;
    readonly changedFileCount: number;
  };
  readonly changes: readonly {
    readonly groupId: string;
    readonly operation: string;
    readonly pathDisplay: string;
  }[];
  readonly changesTruncated: boolean;
  readonly changeDetailLimit: number;
}

interface DeploymentData {
  readonly deploymentId: string;
}

interface RollbackData {
  readonly rollbackId: string;
}

interface HistoryItem {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
}

test.setTimeout(120_000);

test.beforeAll(async ({ browserName }, testInfo) => {
  testInfo.annotations.push({ type: "browser", description: browserName });
  testInfo.setTimeout(120_000);
  await execFileAsync("pnpm", ["--filter", "@ai-config-hub/cli...", "build"], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
});

test.describe("CLI end to end", () => {
  test("scans a project without an explicit tool filter", async () => {
    const workspace = await createFixtureWorkspace();
    try {
      const scan = await runCli(workspace.userData, ["scan", workspace.projectRoot, "--json"]);
      expect(scan.exitCode).toBe(0);
      expect(scan.json.ok).toBe(true);
      expect(readDataRecord(scan.json)["status"]).toBe("succeeded");

      const assets = await runCli(workspace.userData, ["assets", "list", "--json"]);
      expect(assets.exitCode).toBe(0);
      expect(readAssetItems(assets.json).length).toBeGreaterThan(0);
    } finally {
      await workspace.dispose();
    }
  });

  test("applies the scan --tool filter before indexing assets", async () => {
    const workspace = await createFixtureWorkspace();
    try {
      const scan = await runCli(workspace.userData, [
        "scan",
        workspace.projectRoot,
        "--tool",
        "codex",
        "--json",
      ]);
      expect(scan.exitCode).toBe(0);
      expect(scan.json.ok).toBe(true);
      expect(readDataRecord(scan.json)["status"]).toBe("succeeded");

      const assets = await runCli(workspace.userData, ["assets", "list", "--json"]);
      expect(assets.exitCode).toBe(0);
      expect(readAssetItems(assets.json).map((item) => item.toolKey)).toEqual(["codex"]);
    } finally {
      await workspace.dispose();
    }
  });

  test("previews, deploys, records, and rolls back a real migration", async () => {
    const workspace = await createFixtureWorkspace();
    const cursorRulePath = join(workspace.projectRoot, ".cursor", "rules", "agents.mdc");
    const canonicalCursorRulePath = join(
      await realpath(workspace.projectRoot),
      ".cursor",
      "rules",
      "agents.mdc",
    );
    try {
      const scan = await runCli(workspace.userData, ["scan", workspace.projectRoot, "--json"]);
      expect(scan.exitCode).toBe(0);
      expect(scan.json.ok).toBe(true);

      const assets = await runCli(workspace.userData, ["assets", "list", "--json"]);
      const source = readAssetItems(assets.json).find(
        (asset) =>
          asset.toolKey === "codex" &&
          asset.resourceType === "rule" &&
          asset.logicalKey.includes("AGENTS"),
      );
      expect(source).toBeDefined();
      if (source === undefined) throw new Error("Expected scanned Codex AGENTS asset");

      const preview = await runCli(workspace.userData, [
        "migrate",
        "--dry-run",
        "--source",
        source.id,
        "--target",
        "cursor",
        "--scope",
        workspace.projectRoot,
        "--conflict",
        "replace",
        "--json",
      ]);
      const plan = readMigrationPreviewData(preview.json);
      expect(preview.exitCode).toBe(0);
      expect(plan.requiredConfirmations).toContain("overwrite");
      expect(plan.changeGroups).toEqual([
        expect.objectContaining({
          groupId: expect.any(String),
          operation: "replace",
          targetRootRelativePath: ".cursor/rules/agents.mdc",
          changedTargetCount: 1,
        }),
      ]);
      expect(plan.differenceSummary).toMatchObject({
        changedGroupCount: 1,
        changedFileCount: 1,
      });
      expect(plan.changesTruncated).toBe(false);
      expect(plan.changeDetailLimit).toBe(50);
      expect(plan.changes).toEqual([
        expect.objectContaining({
          groupId: plan.changeGroups[0]?.groupId,
          operation: "replace",
          pathDisplay: canonicalCursorRulePath,
        }),
      ]);

      const deploy = await runCli(workspace.userData, [
        "deploy",
        plan.planId,
        "--plan-hash",
        plan.planHash,
        "--confirm",
        "overwrite",
        "--yes",
        "--json",
      ]);
      const deployment = readDeploymentData(deploy.json);
      expect(deploy.exitCode).toBe(0);
      await expect.poll(() => existsSync(cursorRulePath)).toBe(true);
      expect(await readFile(cursorRulePath, "utf8")).toContain("Use local TypeScript conventions.");
      expect(await readFile(cursorRulePath, "utf8")).not.toContain("Existing Cursor rule.");

      const history = await runCli(workspace.userData, ["history", "--json"]);
      expect(readHistoryItems(history.json)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: deployment.deploymentId,
            kind: "deployment",
            status: "succeeded",
          }),
        ]),
      );

      const rollback = await runCli(workspace.userData, [
        "rollback",
        deployment.deploymentId,
        "--yes",
        "--json",
      ]);
      const rollbackRecord = readRollbackData(rollback.json);
      expect(rollback.exitCode).toBe(0);
      expect(rollbackRecord.rollbackId).toMatch(/^rollback-record:/);
      expect(await readFile(cursorRulePath, "utf8")).toBe("Existing Cursor rule.\n");
    } finally {
      await workspace.dispose();
    }
  });
});

async function createFixtureWorkspace(): Promise<{
  readonly projectRoot: string;
  readonly userData: string;
  readonly dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ai-config-hub-e2e-"));
  const projectRoot = join(root, "project");
  const userData = join(root, "user-data");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(projectRoot, ".cursor", "rules"), { recursive: true });
  await writeFile(join(projectRoot, "AGENTS.md"), "Use local TypeScript conventions.\n", {
    encoding: "utf8",
    flag: "wx",
  });
  await writeFile(join(projectRoot, ".cursor", "rules", "agents.mdc"), "Existing Cursor rule.\n", {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    projectRoot,
    userData,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

async function runCli(
  userData: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly json: CliJsonResponse; readonly stderr: string }> {
  const result = await execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, AI_CONFIG_HUB_USER_DATA: userData },
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "stdout" in error) {
      return {
        stdout: String(error.stdout),
        stderr: "stderr" in error ? String(error.stderr) : "",
        exitCode: "code" in error && typeof error.code === "number" ? error.code : 1,
      };
    }
    throw error;
  });
  return {
    exitCode: "exitCode" in result ? result.exitCode : 0,
    json: parseJsonResponse(result.stdout),
    stderr: result.stderr,
  };
}

function parseJsonResponse(text: string): CliJsonResponse {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("CLI output must be an API response object");
  }
  const record = parsed as Record<string, unknown>;
  const ok = record["ok"];
  if (typeof ok !== "boolean") {
    throw new TypeError("CLI output must be an API response object");
  }
  return { ok, data: record["data"], error: record["error"] };
}

function readDataRecord(response: CliJsonResponse): Record<string, unknown> {
  if (typeof response.data !== "object" || response.data === null || Array.isArray(response.data)) {
    throw new TypeError("CLI response data must be an object");
  }
  return response.data as Record<string, unknown>;
}

function readAssetItems(response: CliJsonResponse): readonly AssetSummary[] {
  const data = readDataRecord(response);
  const items = data["items"];
  if (!Array.isArray(items)) throw new TypeError("Assets response must contain items");
  return (items as unknown[]).map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TypeError("Asset item must be an object");
    }
    const record = item as Record<string, unknown>;
    const id = record["id"];
    const toolKey = record["toolKey"];
    const resourceType = record["resourceType"];
    const logicalKey = record["logicalKey"];
    if (typeof id !== "string") throw new TypeError("Asset item must contain an id");
    if (typeof toolKey !== "string") throw new TypeError("Asset item must contain a toolKey");
    if (typeof resourceType !== "string") {
      throw new TypeError("Asset item must contain a resourceType");
    }
    if (typeof logicalKey !== "string") {
      throw new TypeError("Asset item must contain a logicalKey");
    }
    return { id, toolKey, resourceType, logicalKey };
  });
}

function readMigrationPreviewData(response: CliJsonResponse): MigrationPreviewData {
  const data = readDataRecord(response);
  const planId = data["planId"];
  const planHash = data["planHash"];
  const requiredConfirmations = data["requiredConfirmations"];
  const changeGroups = data["changeGroups"];
  const differenceSummary = data["differenceSummary"];
  const changes = data["changes"];
  const changesTruncated = data["changesTruncated"];
  const changeDetailLimit = data["changeDetailLimit"];
  if (typeof planId !== "string") throw new TypeError("Preview response must contain planId");
  if (typeof planHash !== "string") throw new TypeError("Preview response must contain planHash");
  if (!Array.isArray(requiredConfirmations)) {
    throw new TypeError("Preview response must contain requiredConfirmations");
  }
  if (!Array.isArray(changeGroups))
    throw new TypeError("Preview response must contain changeGroups");
  if (
    typeof differenceSummary !== "object" ||
    differenceSummary === null ||
    Array.isArray(differenceSummary)
  ) {
    throw new TypeError("Preview response must contain differenceSummary");
  }
  if (!Array.isArray(changes)) throw new TypeError("Preview response must contain changes");
  if (typeof changesTruncated !== "boolean") {
    throw new TypeError("Preview response must contain changesTruncated");
  }
  if (typeof changeDetailLimit !== "number") {
    throw new TypeError("Preview response must contain changeDetailLimit");
  }
  const summary = differenceSummary as Record<string, unknown>;
  const changedGroupCount = summary["changedGroupCount"];
  const changedFileCount = summary["changedFileCount"];
  if (typeof changedGroupCount !== "number") {
    throw new TypeError("Preview differenceSummary needs changedGroupCount");
  }
  if (typeof changedFileCount !== "number") {
    throw new TypeError("Preview differenceSummary needs changedFileCount");
  }
  return {
    planId,
    planHash,
    requiredConfirmations: requiredConfirmations.map((confirmation) => {
      if (typeof confirmation !== "string") {
        throw new TypeError("Preview confirmations must be strings");
      }
      return confirmation;
    }),
    changeGroups: changeGroups.map((group) => {
      if (typeof group !== "object" || group === null || Array.isArray(group)) {
        throw new TypeError("Preview change group must be an object");
      }
      const record = group as Record<string, unknown>;
      const groupId = record["groupId"];
      const operation = record["operation"];
      const targetRootRelativePath = record["targetRootRelativePath"];
      const changedTargetCount = record["changedTargetCount"];
      if (typeof groupId !== "string") throw new TypeError("Preview group needs groupId");
      if (typeof operation !== "string") throw new TypeError("Preview group needs operation");
      if (typeof targetRootRelativePath !== "string") {
        throw new TypeError("Preview group needs targetRootRelativePath");
      }
      if (typeof changedTargetCount !== "number") {
        throw new TypeError("Preview group needs changedTargetCount");
      }
      return { groupId, operation, targetRootRelativePath, changedTargetCount };
    }),
    differenceSummary: { changedGroupCount, changedFileCount },
    changes: changes.map((change) => {
      if (typeof change !== "object" || change === null || Array.isArray(change)) {
        throw new TypeError("Preview change must be an object");
      }
      const record = change as Record<string, unknown>;
      const groupId = record["groupId"];
      const operation = record["operation"];
      const pathDisplay = record["pathDisplay"];
      if (typeof groupId !== "string") throw new TypeError("Preview change needs groupId");
      if (typeof operation !== "string") throw new TypeError("Preview change needs operation");
      if (typeof pathDisplay !== "string") throw new TypeError("Preview change needs pathDisplay");
      return { groupId, operation, pathDisplay };
    }),
    changesTruncated,
    changeDetailLimit,
  };
}

function readDeploymentData(response: CliJsonResponse): DeploymentData {
  const data = readDataRecord(response);
  const entry = data["entry"];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new TypeError("Deployment response must contain a history entry");
  }
  const deploymentId = (entry as Record<string, unknown>)["id"];
  const kind = (entry as Record<string, unknown>)["kind"];
  if (typeof deploymentId !== "string") {
    throw new TypeError("Deployment response must contain deploymentId");
  }
  if (kind !== "deployment") throw new TypeError("Deployment response must be a deployment entry");
  return { deploymentId };
}

function readRollbackData(response: CliJsonResponse): RollbackData {
  const data = readDataRecord(response);
  const entry = data["entry"];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new TypeError("Rollback response must contain a history entry");
  }
  const rollbackId = (entry as Record<string, unknown>)["id"];
  const kind = (entry as Record<string, unknown>)["kind"];
  if (typeof rollbackId !== "string")
    throw new TypeError("Rollback response must contain rollbackId");
  if (kind !== "rollback") throw new TypeError("Rollback response must be a rollback entry");
  return { rollbackId };
}

function readHistoryItems(response: CliJsonResponse): readonly HistoryItem[] {
  const data = readDataRecord(response);
  const items = data["items"];
  if (!Array.isArray(items)) throw new TypeError("History response must contain items");
  return items.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TypeError("History item must be an object");
    }
    const record = item as Record<string, unknown>;
    const id = record["id"];
    const kind = record["kind"];
    const status = record["status"];
    if (typeof id !== "string") throw new TypeError("History item must contain id");
    if (typeof kind !== "string") throw new TypeError("History item must contain kind");
    if (typeof status !== "string") throw new TypeError("History item must contain status");
    return { id, kind, status };
  });
}
