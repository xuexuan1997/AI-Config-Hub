import type { AppState } from "../model.js";

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
      <ul className="history-list">
        {props.state.history.map((entry) => (
          <li key={entry.id}>
            <strong>{entry.kind}</strong> {entry.status} <span>{entry.createdAt}</span>
            {entry.phase === undefined ? null : <span> phase {entry.phase}</span>}
            {entry.progress === undefined ? null : (
              <span>
                {" "}
                {entry.progress.completed}/{entry.progress.total ?? "?"} {entry.progress.unit}
              </span>
            )}
            {entry.cancellable === undefined ? null : (
              <span> {entry.cancellable ? "cancellable" : "not cancellable"}</span>
            )}
            {entry.snapshot === undefined ? null : <span> {snapshotLabel(entry.snapshot)}</span>}
            <button type="button" onClick={() => props.onLoadDetail(entry.id)}>
              Details
            </button>
          </li>
        ))}
      </ul>
      {detail === undefined ? null : (
        <section className="detail-panel" aria-label="History detail">
          <h2>{detail.entry.kind} detail</h2>
          <dl>
            <dt>Record</dt>
            <dd>{detail.entry.id}</dd>
            <dt>Status</dt>
            <dd>{detail.entry.status}</dd>
            <dt>Plan</dt>
            <dd>{detail.plan.planId}</dd>
            <dt>Plan hash</dt>
            <dd>{detail.plan.planHash}</dd>
            <dt>Required confirmations</dt>
            <dd>
              {detail.plan.requiredConfirmations.length === 0
                ? "none"
                : detail.plan.requiredConfirmations.join(", ")}
            </dd>
          </dl>
          <h3>Changes</h3>
          <ul className="history-list">
            {detail.changes.map((change) => (
              <li key={`${change.operation}:${change.pathDisplay}`}>
                <strong>{change.operation}</strong> {change.pathDisplay}
                <small>
                  before {change.beforeHash ?? "absent"} after {change.afterHash ?? "absent"}
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

function snapshotLabel(snapshot: NonNullable<AppState["history"][number]["snapshot"]>): string {
  if (snapshot.status === "recorded") return `snapshot ${snapshot.commitId.slice(0, 12)}`;
  if (snapshot.status === "missing") return "snapshot missing";
  return `snapshot ${snapshot.status} ${snapshot.error.code}`;
}
