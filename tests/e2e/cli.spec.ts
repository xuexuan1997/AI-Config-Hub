import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  readonly toolKey: string;
}

test.setTimeout(120_000);

test.beforeAll(async () => {
  await execFileAsync("pnpm", ["build"], {
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
      expect(readDataRecord(scan.json)["status"]).toBe("queued");

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
      expect(readDataRecord(scan.json)["status"]).toBe("queued");

      const assets = await runCli(workspace.userData, ["assets", "list", "--json"]);
      expect(assets.exitCode).toBe(0);
      expect(readAssetItems(assets.json).map((item) => item.toolKey)).toEqual(["codex"]);
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
  await writeFile(join(projectRoot, "AGENTS.md"), "Use local TypeScript conventions.\n", {
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
    if (typeof item !== "object" || item === null || Array.isArray(item) || !("toolKey" in item)) {
      throw new TypeError("Asset item must contain a toolKey");
    }
    const record = item as Record<string, unknown>;
    const toolKey = record["toolKey"];
    if (typeof toolKey !== "string") throw new TypeError("Asset item must contain a toolKey");
    return { toolKey };
  });
}
