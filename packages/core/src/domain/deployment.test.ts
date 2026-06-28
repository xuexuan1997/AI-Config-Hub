import { describe, expect, it } from "vitest";

import {
  DeploymentOperationSchema,
  DeploymentPlanSchema,
  DeploymentRecordSchema,
} from "./deployment.js";

const operation = {
  kind: "replace",
  targetPath: "/workspace/.cursor/rules/generated.mdc",
  nextText: "Use strict TypeScript",
  expectedTargetHash: `sha256:${"a".repeat(64)}`,
} as const;

const validPlan = {
  deploymentPlanId: "plan-1",
  conversionResultIds: ["conversion-1"],
  operations: [operation],
  diffs: [
    {
      targetPath: operation.targetPath,
      summary: "Replace one rule",
      unifiedText: "-old\n+new",
    },
  ],
  expectedSourceHashes: { "asset-1": `sha256:${"b".repeat(64)}` },
  expectedTargetHashes: { [operation.targetPath]: operation.expectedTargetHash },
  backupPolicy: { mode: "required", backupRoot: "/backups" },
  verificationStrategy: { kind: "adapter", description: "Parse the written target" },
  requiredConfirmations: ["overwrite"],
  warnings: [],
  planHash: `sha256:${"c".repeat(64)}`,
  adapterId: "cursor.builtin",
  adapterVersion: "1.0.0",
  createdAt: "2026-06-21T10:00:00Z",
} as const;

const validSucceededRecord = {
  deploymentRecordId: "deployment-1",
  deploymentPlanId: "plan-1",
  confirmedPlanHash: validPlan.planHash,
  status: "succeeded",
  operations: [operation],
  backupLocations: { [operation.targetPath]: "/backups/deployment-1/generated.mdc" },
  resultingHashes: { [operation.targetPath]: `sha256:${"d".repeat(64)}` },
  verificationResult: {
    status: "passed",
    verifiedHashes: { [operation.targetPath]: `sha256:${"d".repeat(64)}` },
    diagnostics: [],
  },
  rollbackResults: [],
  adapterId: "cursor.builtin",
  adapterVersion: "1.0.0",
  normalizedSchemaVersion: "1.0.0",
  createdAt: "2026-06-21T10:00:00Z",
  confirmedAt: "2026-06-21T10:01:00Z",
  startedAt: "2026-06-21T10:02:00Z",
  finishedAt: "2026-06-21T10:03:00Z",
  correlationId: "correlation-1",
  diagnostics: [],
} as const;

describe("DeploymentPlanSchema", () => {
  it("parses an immutable deployment preview", () => {
    expect(DeploymentPlanSchema.safeParse(validPlan).success).toBe(true);
  });

  it("rejects duplicate target operations", () => {
    expect(
      DeploymentPlanSchema.safeParse({ ...validPlan, operations: [operation, operation] }).success,
    ).toBe(false);
  });
});

describe("DeploymentOperationSchema", () => {
  it("accepts explicit PRD deployment operation types", () => {
    for (const deploymentType of ["copy", "symlink", "generated_file"] as const) {
      expect(DeploymentOperationSchema.parse({ ...operation, deploymentType })).toMatchObject({
        deploymentType,
      });
    }
  });

  it("defaults legacy operations to generated_file metadata", () => {
    expect(DeploymentOperationSchema.parse(operation)).toMatchObject({
      deploymentType: "generated_file",
    });
  });

  it("rejects unknown deployment operation types", () => {
    expect(
      DeploymentOperationSchema.safeParse({ ...operation, deploymentType: "hardlink" }).success,
    ).toBe(false);
  });
});

describe("DeploymentRecordSchema", () => {
  it("rejects succeeded without passed verification", () => {
    expect(
      DeploymentRecordSchema.safeParse({
        ...validSucceededRecord,
        verificationResult: { status: "not_started", diagnostics: [] },
      }).success,
    ).toBe(false);
  });

  it("requires a backup association for every successful target", () => {
    expect(
      DeploymentRecordSchema.safeParse({
        ...validSucceededRecord,
        backupLocations: {},
      }).success,
    ).toBe(false);
  });

  it("requires startedAt after writing begins", () => {
    expect(
      DeploymentRecordSchema.safeParse({
        ...validSucceededRecord,
        status: "writing",
        startedAt: undefined,
        finishedAt: undefined,
      }).success,
    ).toBe(false);
  });

  it("requires verified compensation for rolled_back", () => {
    expect(
      DeploymentRecordSchema.safeParse({ ...validSucceededRecord, status: "rolled_back" }).success,
    ).toBe(false);
  });
});
