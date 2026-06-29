import type { AppState } from "../model.js";

export function AssetsView(props: {
  readonly state: AppState;
  readonly onRefresh: () => void;
  readonly onInspect: (assetId: AppState["assets"][number]["id"]) => void;
  readonly onLoadEffective: () => void;
  readonly onOpenSource: () => void;
  readonly onRescanAfterEdit: () => void;
  readonly onLocateDiagnostic: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  const detail = props.state.assetDetail;
  const effective = props.state.effective;
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
          <div className="detail-actions">
            <button type="button" onClick={props.onOpenSource}>
              Open source
            </button>
            <button type="button" onClick={props.onRescanAfterEdit}>
              Rescan after edit
            </button>
            <button type="button" onClick={props.onLoadEffective}>
              Load effective configuration
            </button>
          </div>
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
          {effective === undefined ? null : (
            <>
              <h3>Effective configuration</h3>
              <pre>{JSON.stringify(effective.effective, null, 2)}</pre>
              <h3>Contributors</h3>
              {effective.contributors.length === 0 ? (
                <p>No contributing assets.</p>
              ) : (
                <ul>
                  {effective.contributors.map((contributor) => (
                    <li
                      key={`${contributor.assetId}:${contributor.action}:${contributor.reasonCode}`}
                    >
                      {contributor.assetId} {contributor.action} {contributor.reasonCode}
                    </li>
                  ))}
                </ul>
              )}
              <h3>Ignored assets</h3>
              {effective.ignored.length === 0 ? (
                <p>No ignored assets.</p>
              ) : (
                <ul>
                  {effective.ignored.map((ignored) => (
                    <li key={`${ignored.assetId}:${ignored.reasonCode}`}>
                      {ignored.assetId} {ignored.reasonCode}
                    </li>
                  ))}
                </ul>
              )}
              <h3>Effective diagnostics</h3>
              {effective.diagnostics.length === 0 ? (
                <p>No effective diagnostics.</p>
              ) : (
                <ul className="diagnostic-list">
                  {effective.diagnostics.map((diagnostic) => (
                    <li key={diagnostic.id}>
                      <strong>
                        {diagnostic.severity} {diagnostic.code}
                      </strong>
                      <span>{diagnostic.message}</span>
                    </li>
                  ))}
                </ul>
              )}
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
                {diagnostic.location === undefined ? null : (
                  <small>
                    {diagnostic.location.pathDisplay}
                    {diagnostic.location.line === undefined ? "" : `:${diagnostic.location.line}`}
                    {diagnostic.location.column === undefined
                      ? ""
                      : `:${diagnostic.location.column}`}
                  </small>
                )}
                <small>{diagnostic.suggestedAction}</small>
                {diagnostic.assetId === undefined ? null : (
                  <LocateDiagnosticButton
                    assetId={diagnostic.assetId}
                    onLocate={props.onLocateDiagnostic}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function LocateDiagnosticButton(props: {
  readonly assetId: AppState["assets"][number]["id"];
  readonly onLocate: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  return (
    <button type="button" onClick={() => props.onLocate(props.assetId)}>
      Locate
    </button>
  );
}
