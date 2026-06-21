import type { AbsolutePath, IsoDateTime } from "@ai-config-hub/shared";

export interface GitRepositoryRef {
  readonly workingTree: AbsolutePath;
  readonly remoteName: string;
  readonly branch: string;
}

export interface GitStatusEntry {
  readonly path: string;
  readonly index: "unmodified" | "added" | "modified" | "deleted" | "renamed" | "unmerged";
  readonly workingTree: "unmodified" | "added" | "modified" | "deleted" | "renamed" | "unmerged";
}

export interface GitCommitSummary {
  readonly commitId: string;
  readonly subject: string;
  readonly authoredAt: IsoDateTime;
}

export interface GitPort {
  initialize(input: {
    readonly workingTree: AbsolutePath;
    readonly defaultBranch: string;
  }): Promise<void>;
  clone(input: {
    readonly remote: string;
    readonly destination: AbsolutePath;
  }): Promise<GitRepositoryRef>;
  status(repository: GitRepositoryRef): Promise<readonly GitStatusEntry[]>;
  pull(input: {
    readonly repository: GitRepositoryRef;
    readonly strategy: "fast-forward-only";
  }): Promise<void>;
  diff(input: {
    readonly repository: GitRepositoryRef;
    readonly paths: readonly string[];
    readonly staged: boolean;
  }): Promise<string>;
  commit(input: {
    readonly repository: GitRepositoryRef;
    readonly paths: readonly string[];
    readonly message: string;
  }): Promise<GitCommitSummary>;
  push(input: {
    readonly repository: GitRepositoryRef;
    readonly expectedRemoteHead?: string;
  }): Promise<void>;
  history(input: {
    readonly repository: GitRepositoryRef;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<readonly GitCommitSummary[]>;
}
