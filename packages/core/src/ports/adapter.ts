import type {
  AbsolutePath,
  AdapterId,
  AssetId,
  ContentHash,
  IsoDateTime,
  JsonPointer,
  ResourceKind,
  ScopeKind,
  SemVer,
  SemVerRange,
  ToolId,
  ToolInstallationId,
} from "@ai-config-hub/shared";

import type { Asset } from "../domain/asset.js";
import type { ConversionResult, DeployableConversionResult } from "../domain/conversion.js";
import type { DeploymentOperation, DeploymentRecord } from "../domain/deployment.js";
import type { NormalizedResource } from "../domain/resource.js";
import type { ScopeCandidate } from "../domain/scope.js";
import type { FileSnapshot } from "./files.js";

export interface CancellationSignal {
  readonly aborted: boolean;
  throwIfAborted(): void;
}

export interface AdapterLogger {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface FileStat {
  readonly kind: "file" | "directory" | "missing";
  readonly size: number;
  readonly modifiedAt: IsoDateTime;
}

export interface AdapterReadApi {
  realpath(path: AbsolutePath): Promise<AbsolutePath>;
  stat(path: AbsolutePath): Promise<FileStat>;
  list(path: AbsolutePath): Promise<readonly AbsolutePath[]>;
  readText(path: AbsolutePath): Promise<string>;
}

export interface AdapterSourceLocation {
  readonly path: AbsolutePath;
  readonly line?: number;
  readonly column?: number;
  readonly pointer?: JsonPointer;
}

export interface AdapterDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly location?: AdapterSourceLocation;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly suggestedActions: readonly string[];
  readonly blocking: boolean;
}

export interface ToolInstallation {
  readonly toolId: ToolId;
  readonly installationId: ToolInstallationId;
  readonly detectedVersion?: SemVer;
  readonly configRoots: readonly AbsolutePath[];
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface DiscoveredResource {
  readonly toolId: ToolId;
  readonly sourcePath: AbsolutePath;
  readonly sourceFormat: string;
  readonly resourceKindHint?: ResourceKind;
  readonly locatorHint?: string;
  readonly scope: ScopeCandidate;
}

export interface ParsedAsset {
  readonly toolId: ToolId;
  readonly canonicalSourcePath: AbsolutePath;
  readonly locator: string;
  readonly scope: ScopeCandidate;
  readonly sourceFormat: string;
  readonly sourceContentHash: ContentHash;
  readonly resource: NormalizedResource;
  readonly references: readonly string[];
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface EffectiveConfigStepDraft {
  readonly action: "inherit" | "merge" | "override" | "ignore";
  readonly assetId: AssetId;
  readonly reason: string;
}

export interface AdapterEffectiveConfigDraft {
  readonly canonicalTargetPath: AbsolutePath;
  readonly resourceKinds: readonly ResourceKind[];
  readonly resolvedResources: readonly NormalizedResource[];
  readonly contributingAssetIds: readonly AssetId[];
  readonly ignoredAssetIds: readonly AssetId[];
  readonly steps: readonly EffectiveConfigStepDraft[];
  readonly resolutionInputHash: ContentHash;
}

export interface ConversionTarget {
  readonly toolId: ToolId;
  readonly resourceKind: ResourceKind;
  readonly targetSchemaVersion: SemVer;
}

export interface DeploymentTarget {
  readonly tool: ToolInstallation;
  readonly scope: ScopeCandidate;
  readonly canonicalRootPath: AbsolutePath;
}

export interface AdapterDeploymentDiff {
  readonly targetPath: AbsolutePath;
  readonly summary: string;
  readonly unifiedText: string;
}

export interface AdapterDeploymentDraft {
  readonly targetToolId: ToolId;
  readonly operations: readonly DeploymentOperation[];
  readonly diffs: readonly AdapterDeploymentDiff[];
  readonly verificationStrategy: string;
  readonly adapterId: AdapterId;
  readonly adapterVersion: SemVer;
}

export interface DetectionContext {
  readonly platform: "win32" | "darwin" | "linux";
  readonly homeDirectory: AbsolutePath;
  readonly candidateRoots: readonly AbsolutePath[];
  readonly read: AdapterReadApi;
  readonly signal: CancellationSignal;
}

export interface DiscoveryContext {
  readonly tool: ToolInstallation;
  readonly allowedRoots: readonly AbsolutePath[];
  readonly read: AdapterReadApi;
  readonly signal: CancellationSignal;
}

export interface ParseContext {
  readonly tool: ToolInstallation;
  readonly candidate: DiscoveredResource;
  readonly snapshot: FileSnapshot;
  readonly signal: CancellationSignal;
}

export interface ResolutionContext {
  readonly tool: ToolInstallation;
  readonly targetPath: AbsolutePath;
  readonly assets: readonly Asset[];
  readonly signal: CancellationSignal;
}

export interface DiagnosticContext {
  readonly tool: ToolInstallation;
  readonly assets: readonly Asset[];
  readonly effectiveConfigDraft?: AdapterEffectiveConfigDraft;
  readonly signal: CancellationSignal;
}

export interface ConversionContext {
  readonly asset: Asset;
  readonly target: ConversionTarget;
  readonly signal: CancellationSignal;
}

export interface DeploymentPlanningContext {
  readonly conversion: DeployableConversionResult;
  readonly target: DeploymentTarget;
  readonly currentTargetSnapshots: ReadonlyMap<AbsolutePath, FileSnapshot>;
  readonly signal: CancellationSignal;
}

export interface VerificationContext {
  readonly deployment: DeploymentRecord;
  readonly target: DeploymentTarget;
  readonly read: AdapterReadApi;
  readonly signal: CancellationSignal;
}

export interface DetectionResult {
  readonly installations: readonly ToolInstallation[];
  readonly diagnostics: readonly AdapterDiagnostic[];
}

export interface DiscoveryResult {
  readonly candidates: readonly DiscoveredResource[];
  readonly diagnostics: readonly AdapterDiagnostic[];
}

export type ParseResult =
  | {
      readonly status: "parsed";
      readonly assets: readonly ParsedAsset[];
      readonly diagnostics: readonly AdapterDiagnostic[];
    }
  | {
      readonly status: "rejected";
      readonly assets: readonly [];
      readonly diagnostics: readonly AdapterDiagnostic[];
    };

export interface ResolutionResult {
  readonly draft: AdapterEffectiveConfigDraft;
  readonly diagnostics: readonly AdapterDiagnostic[];
}

export interface DiagnosticResult {
  readonly diagnostics: readonly AdapterDiagnostic[];
}

export interface DeploymentPlanningResult {
  readonly draft: AdapterDeploymentDraft;
  readonly diagnostics: readonly AdapterDiagnostic[];
}

export type VerificationResult =
  | {
      readonly status: "passed";
      readonly verifiedHashes: Readonly<Record<AbsolutePath, ContentHash>>;
      readonly diagnostics: readonly AdapterDiagnostic[];
    }
  | {
      readonly status: "failed";
      readonly verifiedHashes: Readonly<Record<AbsolutePath, ContentHash>>;
      readonly diagnostics: readonly AdapterDiagnostic[];
    };

export interface ConversionCapability {
  readonly resourceKind: ResourceKind;
  readonly targets: readonly ToolId[];
}

export interface AdapterCapabilities {
  readonly supportedToolVersions: SemVerRange;
  readonly testedToolVersions: readonly SemVer[];
  readonly readableSchemaVersions: readonly SemVerRange[];
  readonly writtenSchemaVersion: SemVer;
  readonly resourceKinds: readonly ResourceKind[];
  readonly scopeKinds: readonly ScopeKind[];
  readonly supportsNestedScopes: boolean;
  readonly conversions: readonly ConversionCapability[];
}

export interface AdapterFactoryContext {
  readonly logger: AdapterLogger;
}

export interface AdapterRegistration {
  readonly contractVersion: 1;
  readonly adapterId: AdapterId;
  readonly adapterVersion: SemVer;
  readonly toolId: ToolId;
  readonly capabilities: AdapterCapabilities;
  readonly create: (context: AdapterFactoryContext) => ToolAdapter;
}

export interface ToolAdapter {
  readonly adapterId: AdapterId;
  readonly adapterVersion: SemVer;
  readonly toolId: ToolId;
  readonly capabilities: AdapterCapabilities;
  detect(context: DetectionContext): Promise<DetectionResult>;
  discover(context: DiscoveryContext): Promise<DiscoveryResult>;
  parse(context: ParseContext): Promise<ParseResult>;
  resolveEffective(context: ResolutionContext): Promise<ResolutionResult>;
  diagnose(context: DiagnosticContext): Promise<DiagnosticResult>;
  convert(context: ConversionContext): Promise<ConversionResult>;
  planDeployment(context: DeploymentPlanningContext): Promise<DeploymentPlanningResult>;
  verify(context: VerificationContext): Promise<VerificationResult>;
}
