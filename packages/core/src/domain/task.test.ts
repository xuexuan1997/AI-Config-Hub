import { describe, expect, it } from "vitest";

import {
  type DeploymentStatus,
  DeploymentStatusSchema,
  isDeploymentTransitionAllowed,
  isScanTransitionAllowed,
  ScanRunSummarySchema,
  type ScanRunStatus,
  ScanRunStatusSchema,
  TaskProgressSchema,
} from "./task.js";

const expectedScanTransitions: Readonly<Record<ScanRunStatus, readonly ScanRunStatus[]>> = {
  queued: ["detecting", "cancelled"],
  detecting: ["discovering", "failed", "cancelled"],
  discovering: ["parsing", "failed", "cancelled"],
  parsing: ["resolving", "cancelled"],
  resolving: ["diagnosing", "failed"],
  diagnosing: ["indexing"],
  indexing: ["succeeded", "partially_succeeded", "failed"],
  succeeded: [],
  partially_succeeded: [],
  failed: [],
  cancelled: [],
};

const expectedDeploymentTransitions: Readonly<
  Record<DeploymentStatus, readonly DeploymentStatus[]>
> = {
  planned: ["confirmed", "failed"],
  confirmed: ["backed_up", "failed"],
  backed_up: ["writing"],
  writing: ["verifying", "rolling_back"],
  verifying: ["succeeded", "rolling_back"],
  succeeded: [],
  failed: [],
  rolling_back: ["rolled_back", "failed"],
  rolled_back: [],
};

describe("scan transitions", () => {
  it("matches every allowed and forbidden transition in the architecture state machine", () => {
    for (const from of ScanRunStatusSchema.options) {
      for (const to of ScanRunStatusSchema.options) {
        expect(isScanTransitionAllowed(from, to), `${from} -> ${to}`).toBe(
          expectedScanTransitions[from].includes(to),
        );
      }
    }
  });
});

describe("deployment transitions", () => {
  it("matches every allowed and forbidden transition in the architecture state machine", () => {
    for (const from of DeploymentStatusSchema.options) {
      for (const to of DeploymentStatusSchema.options) {
        expect(isDeploymentTransitionAllowed(from, to), `${from} -> ${to}`).toBe(
          expectedDeploymentTransitions[from].includes(to),
        );
      }
    }
  });
});

describe("task summaries", () => {
  it("requires partial success to contain both successes and failures", () => {
    const summary = {
      scanRunId: "scan-1",
      status: "partially_succeeded",
      succeededCount: 1,
      failedCount: 1,
      skippedCount: 0,
      diagnosticIds: ["diag-1"],
    } as const;

    expect(ScanRunSummarySchema.safeParse(summary).success).toBe(true);
    expect(ScanRunSummarySchema.safeParse({ ...summary, failedCount: 0 }).success).toBe(false);
    expect(ScanRunSummarySchema.safeParse({ ...summary, succeededCount: 0 }).success).toBe(false);
  });

  it("rejects progress beyond its total", () => {
    expect(
      TaskProgressSchema.safeParse({
        taskId: "task-1",
        sequence: 2,
        phase: "parsing",
        completed: 11,
        total: 10,
      }).success,
    ).toBe(false);
  });
});
