import type { AbsolutePath, IsoDateTime } from "@ai-config-hub/shared";

export interface GitCommitSummary {
  readonly commitId: string;
  readonly subject: string;
  readonly authoredAt: IsoDateTime;
}

export interface LocalGitPort {
  initialize(root: AbsolutePath): Promise<void>;
  snapshot(input: {
    readonly root: AbsolutePath;
    readonly paths: readonly string[];
    readonly message: string;
    readonly authoredAt: IsoDateTime;
  }): Promise<GitCommitSummary>;
  diff(input: {
    readonly root: AbsolutePath;
    readonly from?: string;
    readonly to?: string;
  }): Promise<string>;
  history(input: {
    readonly root: AbsolutePath;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<readonly GitCommitSummary[]>;
}

export type AssetRepositoryGitStatusState =
  | "clean"
  | "dirty"
  | "conflicted"
  | "ahead"
  | "behind"
  | "diverged";

export interface AssetRepositoryGitStatus {
  readonly state: AssetRepositoryGitStatusState;
  readonly ahead: number;
  readonly behind: number;
  readonly hasUncommittedChanges: boolean;
  readonly conflictedPaths: readonly string[];
  readonly recoveryGuidance: readonly string[];
}

export interface AssetRepositoryGitPort {
  clone(input: {
    readonly remoteUrl: string;
    readonly parentRoot: AbsolutePath;
    readonly targetRoot: AbsolutePath;
  }): Promise<void>;
  pull(input: {
    readonly root: AbsolutePath;
    readonly remote: string;
    readonly branch: string;
  }): Promise<void>;
  status(input: { readonly root: AbsolutePath }): Promise<AssetRepositoryGitStatus>;
  diff(input: {
    readonly root: AbsolutePath;
    readonly from?: string;
    readonly to?: string;
  }): Promise<string>;
  commit(input: {
    readonly root: AbsolutePath;
    readonly paths: readonly string[];
    readonly message: string;
    readonly authoredAt: IsoDateTime;
  }): Promise<GitCommitSummary>;
  push(input: {
    readonly root: AbsolutePath;
    readonly remote: string;
    readonly branch: string;
  }): Promise<void>;
  tag(input: {
    readonly root: AbsolutePath;
    readonly name: string;
    readonly message: string;
  }): Promise<void>;
  restore(input: { readonly root: AbsolutePath; readonly paths: readonly string[] }): Promise<void>;
  history(input: {
    readonly root: AbsolutePath;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<readonly GitCommitSummary[]>;
}
