import type { AbsolutePath, ContentHash, IsoDateTime } from "@ai-config-hub/shared";

export interface CanonicalPath {
  readonly path: AbsolutePath;
  readonly comparisonKey: string;
  readonly displayPath: string;
}

export interface FileSnapshot {
  readonly canonicalPath: AbsolutePath;
  readonly text: string;
  readonly contentHash: ContentHash;
  readonly modifiedAt: IsoDateTime;
  readonly size: number;
}

export interface PathPolicyPort {
  canonicalize(input: {
    readonly path: string;
    readonly basePath?: AbsolutePath;
    readonly allowedRoots: readonly AbsolutePath[];
    readonly intent: "read" | "write";
  }): Promise<CanonicalPath>;
}

export interface FileSnapshotPort {
  /**
   * Returns undefined only when the target is absent at the initial identity check.
   * Implementations must reject when a target disappears or changes after that check.
   */
  snapshot(input: {
    readonly path: AbsolutePath;
    readonly allowedRoots: readonly AbsolutePath[];
  }): Promise<FileSnapshot | undefined>;
}

export interface DeploymentFilePort {
  createBackup(input: {
    readonly source: AbsolutePath;
    readonly destination: AbsolutePath;
    readonly expectedHash: ContentHash;
  }): Promise<{ readonly backupPath: AbsolutePath; readonly backupHash: ContentHash }>;
  atomicReplace(input: {
    readonly target: AbsolutePath;
    readonly text: string;
    readonly expectedHash: ContentHash | "absent";
  }): Promise<{ readonly resultingHash: ContentHash }>;
  copy(input: {
    readonly source: AbsolutePath;
    readonly target: AbsolutePath;
    readonly expectedSourceHash: ContentHash;
    readonly expectedHash: ContentHash | "absent";
  }): Promise<{ readonly resultingHash: ContentHash }>;
  createSymlink(input: {
    readonly source: AbsolutePath;
    readonly target: AbsolutePath;
    readonly expectedSourceHash: ContentHash;
    readonly expectedHash: ContentHash | "absent";
  }): Promise<{ readonly resultingHash: ContentHash }>;
  remove(input: {
    readonly target: AbsolutePath;
    readonly expectedHash: ContentHash;
  }): Promise<void>;
}
