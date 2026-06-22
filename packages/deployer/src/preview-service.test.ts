import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { AdapterRegistry } from "@ai-config-hub/adapters";
import {
  codexRegistration,
  createAdapterRegistry,
  cursorRegistration,
} from "@ai-config-hub/adapters";
import {
  AssetSchema,
  type DeploymentPlan,
  type DeploymentRecord,
  type DeploymentRepository,
  type FileSnapshotPort,
  type NormalizedResource,
  type PathPolicyPort,
  type ToolAdapter,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ContentHashSchema,
  ConversionResultIdSchema,
  CorrelationIdSchema,
  IsoDateTimeSchema,
  type ContentHash,
} from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import { DeploymentPreviewService, type PreviewRequest } from "./preview-service.js";

const NOW = IsoDateTimeSchema.parse("2026-06-22T08:00:00.000Z");
const ROOT = AbsolutePathSchema.parse("/target");
const BACKUP_ROOT = AbsolutePathSchema.parse("/backups");

function hash(text: string): ContentHash {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(text).digest("hex")}`);
}

function asset(
  id: string,
  resource: NormalizedResource = {
    kind: "rule",
    data: { name: id, instructions: `Instruction for ${id}.`, globs: [], extensions: {} },
  },
) {
  return AssetSchema.parse({
    assetId: id,
    toolId: "claude-code",
    resource,
    scopeId: "scope-project",
    canonicalSourcePath: `/source/${id}.md`,
    locator: `rule:${id}`,
    sourceFormat: "markdown",
    contentHash: hash(`source:${id}`),
    normalizedSchemaVersion: "1.0.0",
    adapterId: "fixture-adapter",
    adapterVersion: "1.0.0",
    discoveredAt: NOW,
    references: [],
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  });
}

class MemoryDeploymentRepository implements DeploymentRepository {
  readonly savePlanAndRecord = vi.fn(
    (input: { readonly plan: DeploymentPlan; readonly record: DeploymentRecord }) => {
      this.plan = structuredClone(input.plan);
      this.record = structuredClone(input.record);
      return Promise.resolve();
    },
  );
  plan?: DeploymentPlan;
  record?: DeploymentRecord;

  getPlan(): Promise<DeploymentPlan | undefined> {
    return Promise.resolve(this.plan);
  }
  getRecord(): Promise<DeploymentRecord | undefined> {
    return Promise.resolve(this.record);
  }
  compareAndSetRecord(): Promise<boolean> {
    throw new Error("Preview must not update records");
  }
  listRecords(): never {
    throw new Error("Preview must not list records");
  }
}

function fixture(
  current: Readonly<Record<string, string>> = {},
  options: {
    readonly registry?: AdapterRegistry;
    readonly snapshot?: FileSnapshotPort["snapshot"];
  } = {},
) {
  const repository = new MemoryDeploymentRepository();
  const snapshot = vi.fn<FileSnapshotPort["snapshot"]>(
    options.snapshot ??
      (({ path }) => {
        const text = current[path];
        if (text === undefined) return Promise.resolve(undefined);
        return Promise.resolve({
          canonicalPath: path,
          text,
          contentHash: hash(text),
          modifiedAt: NOW,
          size: Buffer.byteLength(text),
        });
      }),
  );
  const canonicalize = vi.fn<PathPolicyPort["canonicalize"]>(({ path, allowedRoots }) => {
    const resolved = posix.resolve(path);
    const allowed = allowedRoots.some((root) => {
      const relative = posix.relative(root, resolved);
      return relative === "" || (!relative.startsWith("../") && relative !== "..");
    });
    if (!allowed)
      throw Object.assign(new Error("outside root"), { code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    const absolute = AbsolutePathSchema.parse(resolved);
    return Promise.resolve({ path: absolute, comparisonKey: absolute, displayPath: path });
  });
  const service = new DeploymentPreviewService({
    registry: options.registry ?? createAdapterRegistry([codexRegistration, cursorRegistration]),
    snapshots: { snapshot },
    pathPolicy: { canonicalize },
    deploymentRepository: repository,
  });
  return { service, repository, snapshot, canonicalize };
}

function registryWithConversion(
  convert: ToolAdapter["convert"],
  toolId: "codex" | "cursor" = "codex",
): AdapterRegistry {
  const base = createAdapterRegistry([toolId === "codex" ? codexRegistration : cursorRegistration]);
  return {
    ...base,
    create(requestedToolId, logger) {
      const adapter = base.create(requestedToolId, logger);
      Object.defineProperty(adapter, "convert", { value: convert });
      return adapter;
    },
  };
}

function request(assets: readonly ReturnType<typeof asset>[], targetRoot = ROOT): PreviewRequest {
  return {
    assets,
    target: { toolId: "codex", resourceKind: "rule", targetSchemaVersion: "1.0.0" },
    targetRoot,
    backupRoot: BACKUP_ROOT,
    allowedRoots: [ROOT],
    now: NOW,
    correlationId: CorrelationIdSchema.parse("correlation-preview"),
    signal: new AbortController().signal,
  };
}

describe("DeploymentPreviewService", () => {
  it("creates an immutable plan with deterministic identities and exact source/target hashes", async () => {
    const first = fixture();
    const source = asset("asset-create");
    const result = await first.service.preview(request([source]));
    const second = await fixture().service.preview(request([source]));

    expect(result.plan).toMatchObject({
      deploymentPlanId: second.plan.deploymentPlanId,
      planHash: second.plan.planHash,
      expectedSourceHashes: { "asset-create": source.contentHash },
      expectedTargetHashes: { "/target/AGENTS.md": "absent" },
      operations: [
        { kind: "create", targetPath: "/target/AGENTS.md", expectedTargetHash: "absent" },
      ],
      requiredConfirmations: [],
      createdAt: NOW,
    });
    expect(result.record).toMatchObject({
      deploymentPlanId: result.plan.deploymentPlanId,
      deploymentRecordId: second.record.deploymentRecordId,
      status: "planned",
      operations: result.plan.operations,
      verificationResult: { status: "not_started", diagnostics: [] },
    });
    expect(first.repository.savePlanAndRecord).toHaveBeenCalledTimes(1);
    expect(first.repository.plan).toEqual(result.plan);
    expect(first.repository.record).toEqual(result.record);
  });

  it("creates a replace operation with overwrite confirmation, exact target hash, and a bounded diff", async () => {
    const existing = "Old instruction.\n";
    const large = asset("asset-replace", {
      kind: "rule",
      data: { name: "large", instructions: "x".repeat(300 * 1024), globs: [], extensions: {} },
    });
    const { service } = fixture({ "/target/AGENTS.md": existing });

    const { plan, conversions } = await service.preview(request([large]));

    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: "replace",
        targetPath: "/target/AGENTS.md",
        expectedTargetHash: hash(existing),
        nextText: conversions[0]?.level === "unsupported" ? "" : conversions[0]?.outputs[0]?.text,
      }),
    ]);
    expect(plan.expectedTargetHashes).toEqual({ "/target/AGENTS.md": hash(existing) });
    expect(plan.requiredConfirmations).toContain("overwrite");
    expect(Buffer.byteLength(plan.diffs[0]?.unifiedText ?? "", "utf8")).toBeLessThanOrEqual(
      200 * 1024,
    );
  });

  it("omits byte-identical targets while retaining changed outputs and performs no file writes", async () => {
    const unchanged = asset("asset-unchanged", {
      kind: "agent",
      data: {
        name: "asset-unchanged",
        instructions: "Instruction for asset-unchanged.",
        allowedTools: [],
        extensions: {},
      },
    });
    const changed = asset("asset-changed", {
      kind: "agent",
      data: {
        name: "changed",
        instructions: "Run checks.",
        allowedTools: [],
        extensions: {},
      },
    });
    const unchangedText = "---\nname: asset-unchanged\n---\nInstruction for asset-unchanged.\n";
    const { service, snapshot } = fixture({
      "/target/.cursor/agents/asset-unchanged.md": unchangedText,
    });
    const mixedRequest = {
      ...request([unchanged, changed]),
      target: { toolId: "cursor", resourceKind: "agent", targetSchemaVersion: "1.0.0" } as const,
    };

    const result = await service.preview(mixedRequest);

    expect(result.plan.operations).toHaveLength(1);
    expect(result.plan.operations[0]?.targetPath).toBe("/target/.cursor/agents/changed.md");
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(result.record.backupLocations).toEqual({});
    expect(result.record.resultingHashes).toEqual({});
  });

  it("requires partial-conversion confirmation and records adapter warnings", async () => {
    const partial = asset("asset-partial", {
      kind: "rule",
      data: {
        name: "partial",
        instructions: "Keep the supported portion.",
        globs: [],
        extensions: { vendorFlag: true },
      },
    });

    const result = await fixture().service.preview(request([partial]));

    expect(result.conversions[0]?.level).toBe("partial");
    expect(result.plan.requiredConfirmations).toContain("partial_conversion");
    expect(result.plan.warnings).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it("rejects redacted MCP values before persistence", async () => {
    const redacted = asset("asset-redacted", {
      kind: "mcp",
      data: {
        name: "private",
        transport: {
          kind: "stdio",
          command: "node",
          args: [{ kind: "redacted", digest: hash("secret"), deployable: false }],
          env: {},
        },
        extensions: {},
      },
    });
    const context = fixture();

    await expect(
      context.service.preview({
        ...request([redacted]),
        target: { toolId: "codex", resourceKind: "mcp", targetSchemaVersion: "1.0.0" },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CONVERSION" });
    expect(context.snapshot).not.toHaveBeenCalled();
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects targets outside authorized roots before reading or persistence", async () => {
    const context = fixture();

    await expect(
      context.service.preview(
        request([asset("asset-outside")], AbsolutePathSchema.parse("/other")),
      ),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    expect(context.snapshot).not.toHaveBeenCalled();
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects duplicate source asset identities before conversion or persistence", async () => {
    const source = asset("asset-duplicate");
    const convert = vi.fn<ToolAdapter["convert"]>();
    const context = fixture({}, { registry: registryWithConversion(convert) });

    await expect(context.service.preview(request([source, source]))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(convert).not.toHaveBeenCalled();
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects conversion results that are not bound to their source, target, or adapter", async () => {
    const source = asset("asset-untrusted");
    const trustedAdapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const valid = await trustedAdapter.convert({
      asset: source,
      target: request([source]).target,
      signal: new AbortController().signal,
    });
    const mismatches = [
      { sourceAssetId: "different-asset" },
      { sourceContentHash: hash("different-source") },
      { targetToolId: "cursor" },
      { targetResourceKind: "agent" },
      { targetSchemaVersion: "2.0.0" },
      { adapterId: "different-adapter" },
      { adapterVersion: "2.0.0" },
    ] as const;

    for (const mismatch of mismatches) {
      const context = fixture(
        {},
        {
          registry: registryWithConversion(() =>
            Promise.resolve({ ...valid, ...mismatch } as typeof valid),
          ),
        },
      );
      await expect(context.service.preview(request([source]))).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
    }
  });

  it("rejects duplicate conversion result identities", async () => {
    const first = asset("first", {
      kind: "agent",
      data: { name: "first", instructions: "First.", allowedTools: [], extensions: {} },
    });
    const second = asset("second", {
      kind: "agent",
      data: { name: "second", instructions: "Second.", allowedTools: [], extensions: {} },
    });
    const adapter = cursorRegistration.create({ logger: { debug() {}, warn() {} } });
    const convert: ToolAdapter["convert"] = async (context) => {
      const converted = await adapter.convert(context);
      return {
        ...converted,
        conversionResultId: ConversionResultIdSchema.parse("duplicate-conversion"),
      };
    };
    const context = fixture({}, { registry: registryWithConversion(convert, "cursor") });

    await expect(
      context.service.preview({
        ...request([first, second]),
        target: { toolId: "cursor", resourceKind: "agent", targetSchemaVersion: "1.0.0" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("does not persist when cancellation happens while awaiting a target snapshot", async () => {
    const controller = new AbortController();
    const context = fixture(
      {},
      {
        snapshot: () => {
          controller.abort();
          return Promise.resolve(undefined);
        },
      },
    );

    await expect(
      context.service.preview({ ...request([asset("cancelled")]), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rechecks cancellation immediately before persistence", async () => {
    let checks = 0;
    const signal = new AbortController().signal;
    Object.defineProperty(signal, "throwIfAborted", {
      value() {
        checks += 1;
        if (checks === 6) throw new DOMException("Preview cancelled", "AbortError");
      },
    });
    const context = fixture();

    await expect(
      context.service.preview({ ...request([asset("cancelled-before-save")]), signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("emits semantically accurate newline markers in unified diffs", async () => {
    const source = asset("newline", {
      kind: "rule",
      data: { name: "newline", instructions: "new", globs: [], extensions: {} },
    });
    const result = await fixture({ "/target/AGENTS.md": "old" }).service.preview(request([source]));

    expect(result.plan.diffs[0]?.unifiedText).toBe(
      "--- /target/AGENTS.md\n" +
        "+++ /target/AGENTS.md\n" +
        "@@ -1,1 +1,1 @@\n" +
        "-old\n" +
        "\\ No newline at end of file\n" +
        "+new",
    );
  });

  it("truncates ASCII and multibyte diffs at line boundaries with an explicit honest marker", async () => {
    for (const content of ["ascii\n".repeat(80_000), "你好世界\n".repeat(40_000)]) {
      const source = asset(`large-${content.charCodeAt(0)}`, {
        kind: "rule",
        data: { name: "large", instructions: content, globs: [], extensions: {} },
      });
      const result = await fixture({ "/target/AGENTS.md": "old\n" }).service.preview(
        request([source]),
      );
      const diff = result.plan.diffs[0]?.unifiedText ?? "";
      const header = diff.match(/@@ -1,(\d+) \+1,(\d+) @@/);
      const displayedOld = diff.split("\n").filter((line) => line.startsWith("-")).length - 1;
      const displayedNew = diff.split("\n").filter((line) => line.startsWith("+")).length - 1;

      expect(Buffer.byteLength(diff, "utf8")).toBeLessThanOrEqual(200 * 1024);
      expect(diff).toContain("# AI Config Hub: diff truncated");
      expect(header?.[1]).toBe(String(displayedOld));
      expect(header?.[2]).toBe(String(displayedNew));
      expect(diff).not.toContain("�");
    }
  });
});
