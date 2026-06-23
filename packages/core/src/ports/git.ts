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
