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
          </li>
        ))}
      </ul>
    </>
  );
}
