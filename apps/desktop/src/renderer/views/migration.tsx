import type { AppState } from "../model.js";

export function MigrationView(props: { readonly state: AppState; readonly onPreview: () => void }) {
  return (
    <>
      <h1>Migration preview</h1>
      <p>Preview cross-tool changes before anything writes to disk.</p>
      <button type="button" onClick={props.onPreview}>
        Preview Codex → Cursor
      </button>
      {props.state.preview === undefined ? null : (
        <div className="diff-card">
          <strong>Plan {props.state.preview.planId}</strong>
          {props.state.preview.changes.map((change) => (
            <pre key={change.pathDisplay}>{change.diff}</pre>
          ))}
        </div>
      )}
    </>
  );
}
