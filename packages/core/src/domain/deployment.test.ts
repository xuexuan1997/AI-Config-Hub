import { describe, expect, it } from "vitest";
import { AssetIdSchema } from "@ai-config-hub/shared";

import {
  DeploymentOperationSchema,
  DeploymentPlanSchema,
  DeploymentRecordSchema,
  PACKAGE_PATH_SAMPLE_LIMIT,
  operationGroupsForPlan,
  type DeploymentOperation,
  type DeploymentOperationGroup,
} from "./deployment.js";

const operation = DeploymentOperationSchema.parse({
  deploymentType: "generated_file",
  kind: "replace",
  targetPath: "/workspace/.cursor/rules/generated.mdc",
  nextText: "Use strict TypeScript",
  expectedTargetHash: `sha256:${"a".repeat(64)}`,
});

const createOperation = DeploymentOperationSchema.parse({
  deploymentType: "generated_file",
  kind: "create",
  targetPath: "/workspace/.cursor/rules/new.mdc",
  nextText: "Create strict TypeScript guidance",
  expectedTargetHash: "absent",
});

const copyOperation = DeploymentOperationSchema.parse({
  deploymentType: "copy",
  kind: "create",
  targetPath: "/workspace/.cursor/assets/logo.png",
  expectedTargetHash: "absent",
  sourcePath: "/workspace/.codex/skills/release/assets/logo.png",
  sourceHash: `sha256:${"e".repeat(64)}`,
});
const validPlan = DeploymentPlanSchema.parse({
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
});

const validSucceededRecord = DeploymentRecordSchema.parse({
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
});

describe("DeploymentPlanSchema", () => {
  it("parses an immutable deployment preview", () => {
    expect(DeploymentPlanSchema.safeParse(validPlan).success).toBe(true);
  });

  it("rejects duplicate target operations", () => {
    expect(
      DeploymentPlanSchema.safeParse({ ...validPlan, operations: [operation, operation] }).success,
    ).toBe(false);
  });

  it("validates operation group coverage when groups are present", () => {
    const groupedPlan = planWithGroups([
      groupFixture({
        targetPaths: [operation.targetPath],
        operationCount: 1,
        replaceCount: 1,
      }),
      groupFixture({
        groupId: "group:create",
        targetRootPath: createOperation.targetPath,
        targetRootRelativePath: ".cursor/rules/new.mdc",
        targetPaths: [createOperation.targetPath],
        operation: "create",
        operationCount: 1,
        createCount: 1,
        replaceCount: 0,
      }),
    ]);

    expect(DeploymentPlanSchema.safeParse(groupedPlan).success).toBe(true);
    expect(
      DeploymentPlanSchema.safeParse({
        ...groupedPlan,
        operationGroups: groupedPlan.operationGroups.slice(0, 1),
      }).success,
    ).toBe(false);
    expect(
      DeploymentPlanSchema.safeParse({
        ...groupedPlan,
        operationGroups: [
          groupFixture({
            targetPaths: ["/workspace/.cursor/rules/missing.mdc"],
            targetRootPath: "/workspace/.cursor/rules/missing.mdc",
          }),
          groupedPlan.operationGroups[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      DeploymentPlanSchema.safeParse({
        ...groupedPlan,
        operationGroups: [
          groupedPlan.operationGroups[0],
          groupFixture({
            groupId: "group:duplicate",
            targetPaths: [operation.targetPath],
            operationCount: 1,
            replaceCount: 1,
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("validates operation group statistics against grouped operations", () => {
    const mixedGroup = groupFixture({
      targetPaths: [operation.targetPath, createOperation.targetPath],
      operation: "mixed",
      operationCount: 2,
      createCount: 1,
      replaceCount: 1,
    });
    expect(DeploymentPlanSchema.safeParse(planWithGroups([mixedGroup])).success).toBe(true);

    for (const invalidGroup of [
      { ...mixedGroup, targetPaths: [] },
      { ...mixedGroup, operationCount: 0 },
      { ...mixedGroup, operationCount: 1 },
      { ...mixedGroup, createCount: 0 },
      { ...mixedGroup, replaceCount: 0 },
      { ...mixedGroup, deleteCount: 1 },
      { ...mixedGroup, generatedFileCount: 1 },
      { ...mixedGroup, copyCount: 1 },
      { ...mixedGroup, operation: "create" as const },
    ]) {
      expect(DeploymentPlanSchema.safeParse(planWithGroups([invalidGroup])).success).toBe(false);
    }

    const sourceDeploymentGroup = groupFixture({
      targetPaths: [operation.targetPath, copyOperation.targetPath],
      operation: "mixed",
      operationCount: 2,
      createCount: 1,
      replaceCount: 1,
      generatedFileCount: 1,
      copyCount: 1,
      targetRootPath: "/workspace/.cursor",
      targetRootRelativePath: ".cursor",
    });
    expect(
      DeploymentPlanSchema.safeParse(
        planWithGroups([sourceDeploymentGroup], [operation, copyOperation]),
      ).success,
    ).toBe(true);
    expect(
      DeploymentPlanSchema.safeParse(
        planWithGroups([{ ...sourceDeploymentGroup, copyCount: 0 }], [operation, copyOperation]),
      ).success,
    ).toBe(false);
  });

  it("validates package context metadata on operation groups", () => {
    const packageGroup = groupFixture({
      targetPaths: [operation.targetPath, createOperation.targetPath],
      operation: "mixed",
      operationCount: 2,
      createCount: 1,
      replaceCount: 1,
      targetRootPath: "/workspace/.cursor/rules",
      targetRootRelativePath: ".cursor/rules",
      packageOutputCount: 3,
      packagePathSample: [
        ".cursor/rules/generated.mdc",
        ".cursor/rules/new.mdc",
        ".cursor/rules/readme.md",
      ],
    });
    expect(DeploymentPlanSchema.safeParse(planWithGroups([packageGroup])).success).toBe(true);

    expect(
      DeploymentPlanSchema.safeParse(planWithGroups([{ ...packageGroup, packageOutputCount: 1 }]))
        .success,
    ).toBe(false);
    expect(
      DeploymentPlanSchema.safeParse(
        planWithGroups([
          { ...packageGroup, packagePathSample: packageGroup.packagePathSample?.toReversed() },
        ]),
      ).success,
    ).toBe(false);
    expect(
      DeploymentPlanSchema.safeParse(
        planWithGroups([
          {
            ...packageGroup,
            packagePathSample: [".cursor/rules/generated.mdc", ".cursor/rules/generated.mdc"],
          },
        ]),
      ).success,
    ).toBe(false);
    expect(
      DeploymentPlanSchema.safeParse(
        planWithGroups([
          {
            ...packageGroup,
            packageOutputCount: PACKAGE_PATH_SAMPLE_LIMIT + 2,
            packagePathSample: Array.from(
              { length: PACKAGE_PATH_SAMPLE_LIMIT + 1 },
              (_, index) => `.cursor/rules/${String(index).padStart(2, "0")}.md`,
            ),
          },
        ]),
      ).success,
    ).toBe(false);
  });

  it("validates persisted issue summaries while allowing legacy plans without them", () => {
    expect(DeploymentPlanSchema.safeParse(validPlan).success).toBe(true);
    expect(
      DeploymentPlanSchema.safeParse({
        ...validPlan,
        warnings: ["planning warning", "conversion warning"],
        issueSummary: {
          planWarningCount: 1,
          conversionWarningCount: 1,
          partialConversionCount: 1,
          droppedFieldCount: 2,
          transformedFieldCount: 3,
        },
      }).success,
    ).toBe(true);
    expect(
      DeploymentPlanSchema.safeParse({
        ...validPlan,
        warnings: ["planning warning", "conversion warning"],
        issueSummary: {
          planWarningCount: 2,
          conversionWarningCount: 1,
          partialConversionCount: 1,
          droppedFieldCount: 0,
          transformedFieldCount: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      DeploymentPlanSchema.safeParse({
        ...validPlan,
        warnings: ["planning warning"],
        issueSummary: {
          planWarningCount: -1,
          conversionWarningCount: 2,
          partialConversionCount: 1,
          droppedFieldCount: 0,
          transformedFieldCount: 0,
        },
      }).success,
    ).toBe(false);
  });

  it("builds deterministic one-file fallback groups for legacy and rollback plans", () => {
    const [fallbackGroup] = operationGroupsForPlan(validPlan);

    expect(fallbackGroup).toMatchObject({
      groupId: `group:operation:${encodeURIComponent(operation.targetPath)}`,
      targetRootPath: operation.targetPath,
      targetPaths: [operation.targetPath],
      operation: "replace",
      operationCount: 1,
      createCount: 0,
      replaceCount: 1,
      deleteCount: 0,
      generatedFileCount: 1,
      copyCount: 0,
      symlinkCount: 0,
    });
    expect(fallbackGroup?.targetRootRelativePath).toBeUndefined();
    expect(
      operationGroupsForPlan(
        DeploymentPlanSchema.parse(planWithGroups([groupFixture()], [operation])),
      )[0]?.groupId,
    ).toBe("group:replace");
  });
});

describe("DeploymentOperationSchema", () => {
  it("accepts explicit PRD deployment operation types", () => {
    expect(
      DeploymentOperationSchema.parse({ ...operation, deploymentType: "generated_file" }),
    ).toMatchObject({ deploymentType: "generated_file" });
  });

  it("requires source metadata for copy and symlink operations", () => {
    const sourcePath = "/central-assets/rules/generated.mdc";
    const sourceHash = `sha256:${"e".repeat(64)}`;

    for (const deploymentType of ["copy", "symlink"] as const) {
      expect(
        DeploymentOperationSchema.parse({
          deploymentType,
          kind: "replace",
          targetPath: operation.targetPath,
          expectedTargetHash: operation.expectedTargetHash,
          sourcePath,
          sourceHash,
        }),
      ).toMatchObject({ deploymentType, sourcePath, sourceHash });

      expect(DeploymentOperationSchema.safeParse({ ...operation, deploymentType }).success).toBe(
        false,
      );
    }
  });

  it("rejects generated create and replace operations without nextText", () => {
    expect(
      DeploymentOperationSchema.safeParse({
        deploymentType: "generated_file",
        kind: "create",
        targetPath: operation.targetPath,
        expectedTargetHash: "absent",
      }).success,
    ).toBe(false);
    expect(
      DeploymentOperationSchema.safeParse({
        deploymentType: "generated_file",
        kind: "replace",
        targetPath: operation.targetPath,
        expectedTargetHash: operation.expectedTargetHash,
      }).success,
    ).toBe(false);
  });

  it("rejects nextText on copy and symlink create and replace operations", () => {
    const sourcePath = "/central-assets/rules/generated.mdc";
    const sourceHash = `sha256:${"e".repeat(64)}`;

    for (const deploymentType of ["copy", "symlink"] as const) {
      expect(
        DeploymentOperationSchema.safeParse({
          deploymentType,
          kind: "create",
          targetPath: operation.targetPath,
          expectedTargetHash: "absent",
          sourcePath,
          sourceHash,
          nextText: "do not persist copied text",
        }).success,
      ).toBe(false);
      expect(
        DeploymentOperationSchema.safeParse({
          deploymentType,
          kind: "replace",
          targetPath: operation.targetPath,
          expectedTargetHash: operation.expectedTargetHash,
          sourcePath,
          sourceHash,
          nextText: "do not persist copied text",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects delete operations with copy or symlink types or source metadata", () => {
    const sourcePath = "/central-assets/rules/generated.mdc";
    const sourceHash = `sha256:${"e".repeat(64)}`;

    for (const deploymentType of ["copy", "symlink"] as const) {
      expect(
        DeploymentOperationSchema.safeParse({
          deploymentType,
          kind: "delete",
          targetPath: operation.targetPath,
          expectedTargetHash: operation.expectedTargetHash,
          sourcePath,
          sourceHash,
        }).success,
      ).toBe(false);
    }

    expect(
      DeploymentOperationSchema.safeParse({
        deploymentType: "generated_file",
        kind: "delete",
        targetPath: operation.targetPath,
        expectedTargetHash: operation.expectedTargetHash,
        sourcePath,
        sourceHash,
      }).success,
    ).toBe(false);
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

function groupFixture(overrides: Partial<DeploymentOperationGroup> = {}): DeploymentOperationGroup {
  return {
    groupId: overrides.groupId ?? "group:replace",
    sourceAssetId: overrides.sourceAssetId ?? AssetIdSchema.parse("asset-1"),
    resourceKind: overrides.resourceKind ?? "rule",
    targetRootPath: overrides.targetRootPath ?? operation.targetPath,
    targetRootRelativePath: overrides.targetRootRelativePath ?? ".cursor/rules/generated.mdc",
    operation: overrides.operation ?? "replace",
    operationCount: overrides.operationCount ?? 1,
    createCount: overrides.createCount ?? 0,
    replaceCount: overrides.replaceCount ?? 1,
    deleteCount: overrides.deleteCount ?? 0,
    generatedFileCount: overrides.generatedFileCount ?? overrides.operationCount ?? 1,
    copyCount: overrides.copyCount ?? 0,
    symlinkCount: overrides.symlinkCount ?? 0,
    targetPaths: overrides.targetPaths ?? [operation.targetPath],
    ...(overrides.packageOutputCount === undefined
      ? {}
      : { packageOutputCount: overrides.packageOutputCount }),
    ...(overrides.packagePathSample === undefined
      ? {}
      : { packagePathSample: overrides.packagePathSample }),
  };
}

function planWithGroups(
  operationGroups: readonly DeploymentOperationGroup[],
  operations: readonly DeploymentOperation[] = [operation, createOperation],
) {
  return {
    ...validPlan,
    operations,
    expectedTargetHashes: Object.fromEntries(
      operations.map((item) => [item.targetPath, item.expectedTargetHash]),
    ),
    operationGroups,
  } as const;
}
