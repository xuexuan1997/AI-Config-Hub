import { createHash } from "node:crypto";

import type {
  AdapterCapabilities,
  AdapterDiagnostic,
  AdapterLogger,
  ConversionContext,
  ConversionResult,
  DeploymentPlanningContext,
  DeploymentPlanningResult,
  DiagnosticContext,
  DiagnosticResult,
  ResolutionContext,
  ResolutionResult,
  ToolAdapter,
  VerificationContext,
  VerificationResult,
} from "@ai-config-hub/core";
import {
  ContentHashSchema,
  type AbsolutePath,
  type AdapterId,
  type ContentHash,
  type SemVer,
  type ToolId,
} from "@ai-config-hub/shared";

import { convertAsset } from "./conversion.js";
import { resolveAssetsByScope } from "./resolution.js";

export abstract class BaseToolAdapter implements ToolAdapter {
  abstract readonly adapterId: AdapterId;
  abstract readonly adapterVersion: SemVer;
  abstract readonly toolId: ToolId;
  abstract readonly capabilities: AdapterCapabilities;
  protected readonly logger: AdapterLogger;

  constructor(logger: AdapterLogger) {
    this.logger = logger;
  }

  abstract detect(context: Parameters<ToolAdapter["detect"]>[0]): ReturnType<ToolAdapter["detect"]>;
  abstract discover(
    context: Parameters<ToolAdapter["discover"]>[0],
  ): ReturnType<ToolAdapter["discover"]>;
  abstract parse(context: Parameters<ToolAdapter["parse"]>[0]): ReturnType<ToolAdapter["parse"]>;

  resolveEffective(context: ResolutionContext): Promise<ResolutionResult> {
    return Promise.resolve({
      draft: resolveAssetsByScope(context),
      diagnostics: [],
    });
  }

  diagnose(context: DiagnosticContext): Promise<DiagnosticResult> {
    context.signal.throwIfAborted();
    return Promise.resolve({ diagnostics: [] });
  }

  convert(context: ConversionContext): Promise<ConversionResult> {
    return Promise.resolve(convertAsset(context, this.adapterId, this.adapterVersion, this.toolId));
  }

  planDeployment(context: DeploymentPlanningContext): Promise<DeploymentPlanningResult> {
    context.signal.throwIfAborted();
    return Promise.resolve({
      draft: {
        targetToolId: this.toolId,
        operations: [],
        diffs: [],
        verificationStrategy: "Read-only adapter validation",
        adapterId: this.adapterId,
        adapterVersion: this.adapterVersion,
      },
      diagnostics: [
        adapterDiagnostic(
          "ADAPTER_WRITE_CAPABILITY_UNAVAILABLE",
          "error",
          "This adapter does not yet declare a deployable write path",
          true,
        ),
      ],
    });
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    context.signal.throwIfAborted();
    const verifiedHashes = {} as Record<AbsolutePath, ContentHash>;
    const diagnostics: AdapterDiagnostic[] = [];

    for (const operation of context.deployment.operations) {
      context.signal.throwIfAborted();
      if (operation.kind === "delete") {
        const stat = await context.read.stat(operation.targetPath);
        if (stat.kind !== "missing") {
          diagnostics.push(
            verificationDiagnostic(
              "DEPLOYMENT_DELETE_NOT_APPLIED",
              `Deployment expected ${operation.targetPath} to be deleted`,
              operation.targetPath,
            ),
          );
        }
        continue;
      }

      try {
        const stat = await context.read.stat(operation.targetPath);
        if (stat.kind !== "file") {
          diagnostics.push(
            verificationDiagnostic(
              "DEPLOYMENT_TARGET_MISSING",
              `Deployment target is not a file: ${operation.targetPath}`,
              operation.targetPath,
            ),
          );
          continue;
        }
        const actualHash = hash(await context.read.readText(operation.targetPath));
        verifiedHashes[operation.targetPath] = actualHash;
        const expectedHash = context.deployment.resultingHashes[operation.targetPath];
        if (expectedHash === undefined) {
          diagnostics.push(
            verificationDiagnostic(
              "DEPLOYMENT_RESULT_HASH_MISSING",
              `Deployment result hash is missing for ${operation.targetPath}`,
              operation.targetPath,
            ),
          );
        } else if (actualHash !== expectedHash) {
          diagnostics.push(
            verificationDiagnostic(
              "DEPLOYMENT_TARGET_HASH_MISMATCH",
              `Deployment target hash does not match the recorded write: ${operation.targetPath}`,
              operation.targetPath,
            ),
          );
        }
      } catch (error) {
        diagnostics.push(
          verificationDiagnostic(
            "DEPLOYMENT_TARGET_UNREADABLE",
            error instanceof Error ? error.message : `Unable to read ${operation.targetPath}`,
            operation.targetPath,
          ),
        );
      }
    }

    return {
      status: diagnostics.some((diagnostic) => diagnostic.blocking) ? "failed" : "passed",
      verifiedHashes,
      diagnostics,
    };
  }
}

export function adapterDiagnostic(
  code: string,
  severity: AdapterDiagnostic["severity"],
  message: string,
  blocking: boolean,
  location?: AdapterDiagnostic["location"],
): AdapterDiagnostic {
  return {
    code,
    severity,
    message,
    ...(location === undefined ? {} : { location }),
    evidence: {},
    suggestedActions: ["Review the source configuration and scan again"],
    blocking,
  };
}

function hash(text: string): ContentHash {
  return ContentHashSchema.parse(
    `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
  );
}

function verificationDiagnostic(
  code: string,
  message: string,
  path: AbsolutePath,
): AdapterDiagnostic {
  return adapterDiagnostic(code, "error", message, true, { path });
}
