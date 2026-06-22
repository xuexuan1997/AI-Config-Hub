import { z } from "zod";

const StableIdSchema = z.string().trim().min(1).max(200);

export const ToolIdSchema = z.enum(["claude-code", "cursor", "codex", "opencode"]);
export type ToolId = z.infer<typeof ToolIdSchema>;

export const AdapterIdSchema = StableIdSchema.brand<"AdapterId">();
export type AdapterId = z.infer<typeof AdapterIdSchema>;

export const AssetIdSchema = StableIdSchema.brand<"AssetId">();
export type AssetId = z.infer<typeof AssetIdSchema>;

export const ScopeIdSchema = StableIdSchema.brand<"ScopeId">();
export type ScopeId = z.infer<typeof ScopeIdSchema>;

export const ProjectIdSchema = StableIdSchema.brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectIdSchema>;

export const ToolInstallationIdSchema = StableIdSchema.brand<"ToolInstallationId">();
export type ToolInstallationId = z.infer<typeof ToolInstallationIdSchema>;

export const EffectiveConfigIdSchema = StableIdSchema.brand<"EffectiveConfigId">();
export type EffectiveConfigId = z.infer<typeof EffectiveConfigIdSchema>;

export const ConversionResultIdSchema = StableIdSchema.brand<"ConversionResultId">();
export type ConversionResultId = z.infer<typeof ConversionResultIdSchema>;

export const DeploymentPlanIdSchema = StableIdSchema.brand<"DeploymentPlanId">();
export type DeploymentPlanId = z.infer<typeof DeploymentPlanIdSchema>;

export const DeploymentRecordIdSchema = StableIdSchema.brand<"DeploymentRecordId">();
export type DeploymentRecordId = z.infer<typeof DeploymentRecordIdSchema>;

export const DiagnosticIdSchema = StableIdSchema.brand<"DiagnosticId">();
export type DiagnosticId = z.infer<typeof DiagnosticIdSchema>;

export const TaskIdSchema = StableIdSchema.brand<"TaskId">();
export type TaskId = z.infer<typeof TaskIdSchema>;

export const ScanRunIdSchema = StableIdSchema.brand<"ScanRunId">();
export type ScanRunId = z.infer<typeof ScanRunIdSchema>;

export const CorrelationIdSchema = StableIdSchema.brand<"CorrelationId">();
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;

export const RequestIdSchema = StableIdSchema.brand<"RequestId">();
export type RequestId = z.infer<typeof RequestIdSchema>;

export const PaginationCursorSchema = StableIdSchema.brand<"PaginationCursor">();
export type PaginationCursor = z.infer<typeof PaginationCursorSchema>;

export const AbsolutePathSchema = z
  .string()
  .min(1)
  .regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/, "Expected an absolute path");
export type AbsolutePath = z.infer<typeof AbsolutePathSchema>;

export const ContentHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Expected a prefixed SHA-256 hash")
  .brand<"ContentHash">();
export type ContentHash = z.infer<typeof ContentHashSchema>;

export const SemVerSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "Expected a semantic version",
  );
export type SemVer = z.infer<typeof SemVerSchema>;

export const SemVerRangeSchema = z.string().trim().min(1).max(200);
export type SemVerRange = z.infer<typeof SemVerRangeSchema>;

export const JsonPointerSchema = z
  .string()
  .regex(/^(?:|\/(?:[^~/]|~[01])*)*$/, "Expected an RFC 6901 JSON pointer");
export type JsonPointer = z.infer<typeof JsonPointerSchema>;

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const ResourceKindSchema = z.enum(["rule", "agent", "skill", "mcp"]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

export const ScopeKindSchema = z.enum(["user", "project", "directory"]);
export type ScopeKind = z.infer<typeof ScopeKindSchema>;

export const CompatibilityLevelSchema = z.enum(["full", "partial", "unsupported"]);
export type CompatibilityLevel = z.infer<typeof CompatibilityLevelSchema>;

export const DiagnosticSeveritySchema = z.enum(["info", "warning", "error"]);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;
