import type { AppState } from "../model.js";

export function HistoryView(props: { readonly state: AppState; readonly onRefresh: () => void }) {
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
          </li>
        ))}
      </ul>
    </>
  );
}

function snapshotLabel(snapshot: NonNullable<AppState["history"][number]["snapshot"]>): string {
  if (snapshot.status === "recorded") return `snapshot ${snapshot.commitId.slice(0, 12)}`;
  if (snapshot.status === "missing") return "snapshot missing";
  return `snapshot ${snapshot.status} ${snapshot.error.code}`;
}
