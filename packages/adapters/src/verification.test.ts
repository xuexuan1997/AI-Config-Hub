import { createHash } from "node:crypto";

import { DeploymentRecordSchema } from "@ai-config-hub/core";
import type { DeploymentRecord, DeploymentTarget } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ContentHashSchema,
  CorrelationIdSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  ToolInstallationIdSchema,
  type ContentHash,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { codexRegistration } from "./codex.js";
import { memoryReadApi, neverCancelled } from "./test-support.js";

const target = AbsolutePathSchema.parse("/project/AGENTS.md");

describe("adapter deployment verification", () => {
  it("passes when written targets match deployment result hashes", async () => {
    const text = "Use local TypeScript conventions.\n";
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.verify({
      deployment: record({
        operations: [
          {
            kind: "create",
            targetPath: target,
            expectedTargetHash: "absent",
            nextText: text,
          },
        ],
        resultingHashes: { [target]: hash(text) },
      }),
      target: deploymentTarget(),
      read: memoryReadApi({ [target]: text }),
      signal: neverCancelled,
    });

    expect(result.status).toBe("passed");
    expect(result.verifiedHashes[target]).toBe(hash(text));
    expect(result.diagnostics).toEqual([]);
  });

  it("fails when written target content drifts after deployment", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.verify({
      deployment: record({
        operations: [
          {
            kind: "replace",
            targetPath: target,
            expectedTargetHash: hash("old\n"),
            nextText: "new\n",
          },
        ],
        resultingHashes: { [target]: hash("new\n") },
      }),
      target: deploymentTarget(),
      read: memoryReadApi({ [target]: "edited outside deployer\n" }),
      signal: neverCancelled,
    });

    expect(result.status).toBe("failed");
    expect(result.verifiedHashes[target]).toBe(hash("edited outside deployer\n"));
    expect(result.diagnostics).toMatchObject([
      {
        code: "DEPLOYMENT_TARGET_HASH_MISMATCH",
        blocking: true,
      },
    ]);
  });

  it("passes deleted targets only when the target is absent", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.verify({
      deployment: record({
        operations: [
          {
            kind: "delete",
            targetPath: target,
            expectedTargetHash: hash("remove me\n"),
          },
        ],
        resultingHashes: {},
      }),
      target: deploymentTarget(),
      read: memoryReadApi({}),
      signal: neverCancelled,
    });

    expect(result.status).toBe("passed");
    expect(result.verifiedHashes).toEqual({});
    expect(result.diagnostics).toEqual([]);
  });
});

function record(input: {
  readonly operations: DeploymentRecord["operations"];
  readonly resultingHashes: DeploymentRecord["resultingHashes"];
}): DeploymentRecord {
  return DeploymentRecordSchema.parse({
    deploymentRecordId: DeploymentRecordIdSchema.parse("deployment-record:test"),
    deploymentPlanId: DeploymentPlanIdSchema.parse("deployment-plan:test"),
    status: "verifying",
    operations: input.operations,
    backupLocations: Object.fromEntries(
      input.operations.map((operation) => [operation.targetPath, "previously-absent"]),
    ),
    resultingHashes: input.resultingHashes,
    verificationResult: { status: "not_started", diagnostics: [] },
    rollbackResults: [],
    adapterId: codexRegistration.adapterId,
    adapterVersion: codexRegistration.adapterVersion,
    normalizedSchemaVersion: "1.0.0",
    createdAt: "2026-06-21T08:00:00.000Z",
    confirmedAt: "2026-06-21T08:00:01.000Z",
    confirmedPlanHash: hash("plan"),
    startedAt: "2026-06-21T08:00:02.000Z",
    correlationId: CorrelationIdSchema.parse("correlation:test"),
    diagnostics: [],
  });
}

function deploymentTarget(): DeploymentTarget {
  return {
    tool: {
      toolId: "codex" as const,
      installationId: ToolInstallationIdSchema.parse("codex:/project"),
      configRoots: [AbsolutePathSchema.parse("/project")],
      evidence: {},
    },
    scope: {
      kind: "project" as const,
      canonicalRootPath: AbsolutePathSchema.parse("/project"),
      depth: 0,
      precedence: 0,
    },
    canonicalRootPath: AbsolutePathSchema.parse("/project"),
  };
}

function hash(text: string): ContentHash {
  return ContentHashSchema.parse(
    `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
  );
}
