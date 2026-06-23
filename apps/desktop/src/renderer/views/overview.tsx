import type { AppState } from "../model.js";

export function OverviewView(props: { readonly state: AppState; readonly onScan: () => void }) {
  return (
    <>
      <h1>Configuration manager overview</h1>
      <p>
        Scan AI tool configuration, inspect normalized assets, preview conversions, deploy with
        confirmation, and roll back verified changes.
      </p>
      <div className="cards">
        <article>
          <span>Scan</span>
          <strong>{props.state.scanStatus}</strong>
        </article>
        <article>
          <span>Assets</span>
          <strong>{props.state.assets.length}</strong>
        </article>
        <article>
          <span>History</span>
          <strong>{props.state.history.length}</strong>
        </article>
      </div>
      <button type="button" onClick={props.onScan}>
        Start scan
      </button>
    </>
  );
}
