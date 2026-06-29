import { deploymentConfirmationLabel, type AppState } from "../model.js";

export function HistoryView(props: {
  readonly state: AppState;
  readonly onRefresh: () => void;
  readonly onLoadDetail: (id: AppState["history"][number]["id"]) => void;
}) {
  const detail = props.state.historyDetail;
  return (
    <>
      <h1>History</h1>
      <button type="button" onClick={props.onRefresh}>
        Refresh history
      </button>
      {props.state.history.length === 0 ? (
        <section className="empty-state" aria-label="No history records">
          <strong>No deployment history yet.</strong>
          <p>Completed deployments and rollback records will appear here.</p>
        </section>
      ) : (
        <ul className="history-list">
          {props.state.history.map((entry) => (
            <li key={entry.id} className="history-entry">
              <div className="history-entry-main">
                <strong>{historyKindLabel(entry.kind)}</strong>
                <span>{historyStatusLabel(entry.status)}</span>
              </div>
              <div className="history-entry-meta">
                <span>Created: {formatTimestamp(entry.createdAt)}</span>
                {entry.finishedAt === undefined ? null : (
                  <span>Finished: {formatTimestamp(entry.finishedAt)}</span>
                )}
                {entry.phase === undefined ? null : (
                  <span>Phase: {historyPhaseLabel(entry.phase)}</span>
                )}
                {entry.progress === undefined ? null : (
                  <span>
                    {entry.progress.completed}/{entry.progress.total ?? "?"} {entry.progress.unit}
                  </span>
                )}
                {entry.cancellable === undefined ? null : (
                  <span>{entry.cancellable ? "Cancellable" : "Finalized"}</span>
                )}
                {entry.snapshot === undefined ? null : <span>{snapshotLabel(entry.snapshot)}</span>}
              </div>
              <button type="button" onClick={() => props.onLoadDetail(entry.id)}>
                Details
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail === undefined ? null : (
        <section className="detail-panel" aria-label="History detail">
          <h2>{historyKindLabel(detail.entry.kind)} detail</h2>
          <dl>
            <dt>Record ID</dt>
            <dd>{displayIdentifier(detail.entry.id)}</dd>
            <dt>Status</dt>
            <dd>{historyStatusLabel(detail.entry.status)}</dd>
            <dt>Plan</dt>
            <dd>{displayIdentifier(detail.plan.planId)}</dd>
            <dt>Plan hash</dt>
            <dd>{detail.plan.planHash}</dd>
            <dt>Required confirmations</dt>
            <dd>
              {detail.plan.requiredConfirmations.length === 0
                ? "none"
                : detail.plan.requiredConfirmations.map(deploymentConfirmationLabel).join(" ")}
            </dd>
          </dl>
          <h3>Changes</h3>
          <ul className="history-list">
            {detail.changes.map((change) => (
              <li key={`${change.operation}:${change.pathDisplay}`} className="history-change">
                <div className="history-entry-main">
                  <strong>{changeOperationLabel(change.operation)}</strong>
                  <span>{change.pathDisplay}</span>
                </div>
                <small className="history-change-hashes">
                  <span>Before {change.beforeHash ?? "absent"}</span>
                  <span>After {change.afterHash ?? "absent"}</span>
                </small>
                <pre>{change.diff}</pre>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function historyKindLabel(kind: AppState["history"][number]["kind"]): string {
  switch (kind) {
    case "scan":
      return "Scan";
    case "preview":
      return "Preview";
    case "deployment":
      return "Deployment";
    case "rollback":
      return "Rollback";
  }
}

function historyStatusLabel(status: AppState["history"][number]["status"]): string {
  switch (status) {
    case "succeeded":
      return "Succeeded";
    case "partially_succeeded":
      return "Partially succeeded";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    case "rolled_back":
      return "Rolled back";
    default:
      return titleizeIdentifier(status);
  }
}

function historyPhaseLabel(phase: NonNullable<AppState["history"][number]["phase"]>): string {
  switch (phase) {
    case "queued":
      return "Queued";
    case "discovering":
      return "Discovering";
    case "reading":
      return "Reading";
    case "parsing":
      return "Parsing";
    case "validating":
      return "Validating";
    case "committing":
      return "Committing";
    case "preflight":
      return "Preflight";
    case "backing_up":
      return "Backing up";
    case "writing":
      return "Writing";
    case "restoring":
      return "Restoring";
    case "verifying":
      return "Verifying";
    case "rolling_back":
      return "Rolling back";
    case "completed":
      return "Completed";
  }
}

function changeOperationLabel(
  operation: NonNullable<AppState["historyDetail"]>["changes"][number]["operation"],
): string {
  switch (operation) {
    case "create":
      return "Create file";
    case "replace":
      return "Replace file";
    case "delete":
      return "Delete file";
  }
}

function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp;
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(
    date.getUTCHours(),
  )}:${pad2(date.getUTCMinutes())} UTC`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function displayIdentifier(identifier: string): string {
  const delimiterIndex = identifier.indexOf(":");
  return delimiterIndex === -1 ? identifier : identifier.slice(delimiterIndex + 1);
}

function titleizeIdentifier(identifier: string): string {
  const words = identifier
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase());
  return words.length === 0 ? identifier : words.join(" ");
}

function snapshotLabel(snapshot: NonNullable<AppState["history"][number]["snapshot"]>): string {
  if (snapshot.status === "recorded") return `Snapshot ${snapshot.commitId.slice(0, 12)}`;
  if (snapshot.status === "missing") return "Snapshot missing";
  return `Snapshot ${historyStatusLabel(snapshot.status)} ${snapshot.error.code}`;
}
