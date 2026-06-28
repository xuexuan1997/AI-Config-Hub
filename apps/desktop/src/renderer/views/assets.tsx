import type { AppState } from "../model.js";

export function AssetsView(props: {
  readonly state: AppState;
  readonly onRefresh: () => void;
  readonly onInspect: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  const detail = props.state.assetDetail;
  return (
    <>
      <h1>Assets</h1>
      <button type="button" onClick={props.onRefresh}>
        Refresh assets
      </button>
      <div className="cards">
        <article>
          <span>Diagnostics</span>
          <strong>{props.state.diagnosticCounts.error} errors</strong>
        </article>
        <article>
          <span>Warnings</span>
          <strong>{props.state.diagnosticCounts.warning}</strong>
        </article>
        <article>
          <span>Info</span>
          <strong>{props.state.diagnosticCounts.info}</strong>
        </article>
      </div>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Type</th>
            <th>Logical key</th>
            <th>Diagnostics</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {props.state.assets.map((asset) => (
            <tr key={asset.id}>
              <td>{asset.toolKey}</td>
              <td>{asset.resourceType}</td>
              <td>{asset.logicalKey}</td>
              <td>{asset.diagnosticCounts.error} errors</td>
              <td>
                <button type="button" onClick={() => props.onInspect(asset.id)}>
                  Inspect
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {detail === undefined ? null : (
        <section className="detail-panel" aria-label="Asset detail">
          <h2>{detail.asset.logicalKey}</h2>
          <dl>
            <dt>Tool</dt>
            <dd>{detail.asset.toolKey}</dd>
            <dt>Resource</dt>
            <dd>{detail.asset.resourceType}</dd>
            <dt>Scope</dt>
            <dd>{detail.asset.scopeId}</dd>
            <dt>Source</dt>
            <dd>{detail.source.pathDisplay}</dd>
            <dt>Observed</dt>
            <dd>{detail.source.observedAt}</dd>
          </dl>
          {detail.asset.references === undefined || detail.asset.references.length === 0 ? null : (
            <>
              <h3>References</h3>
              <ul>
                {detail.asset.references.map((reference) => (
                  <li key={reference}>{reference}</li>
                ))}
              </ul>
            </>
          )}
          {detail.asset.normalized === undefined ? null : (
            <>
              <h3>Normalized</h3>
              <pre>{JSON.stringify(detail.asset.normalized, null, 2)}</pre>
            </>
          )}
        </section>
      )}
      {props.state.diagnostics.length === 0 ? null : (
        <section className="detail-panel" aria-label="Diagnostics">
          <h2>Diagnostics</h2>
          <ul className="diagnostic-list">
            {props.state.diagnostics.map((diagnostic) => (
              <li key={diagnostic.id}>
                <strong>
                  {diagnostic.severity} {diagnostic.code}
                </strong>
                <span>{diagnostic.message}</span>
                <small>{diagnostic.suggestedAction}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
