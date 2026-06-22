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
import type { AdapterId, SemVer, ToolId } from "@ai-config-hub/shared";

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

  verify(context: VerificationContext): Promise<VerificationResult> {
    context.signal.throwIfAborted();
    const verifiedHashes: Record<string, never> = {};
    return Promise.resolve({
      status: "failed",
      verifiedHashes,
      diagnostics: [
        adapterDiagnostic(
          "ADAPTER_VERIFICATION_CAPABILITY_UNAVAILABLE",
          "error",
          "This adapter cannot verify writes until its deployment path is enabled",
          true,
        ),
      ],
    });
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
