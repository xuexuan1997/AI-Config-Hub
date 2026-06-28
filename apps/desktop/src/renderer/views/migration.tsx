import {
  MIGRATION_CONFLICT_POLICY_OPTIONS,
  MIGRATION_TARGET_TOOL_OPTIONS,
  migrationHashRowsForPreview,
  migrationPreviewBlockersForState,
  migrationSourceDriftRowsForState,
  type AppState,
  type MigrationConflictPolicy,
  type MigrationTargetToolKey,
} from "../model.js";

export function MigrationView(props: {
  readonly state: AppState;
  readonly onPreview: () => void;
  readonly onToggleSource: (assetId: AppState["assets"][number]["id"], selected: boolean) => void;
  readonly onTargetTool: (targetToolKey: MigrationTargetToolKey) => void;
  readonly onConflictPolicy: (conflictPolicy: MigrationConflictPolicy) => void;
}) {
  const previewBlockers = migrationPreviewBlockersForState(props.state);
  const driftRows = migrationSourceDriftRowsForState(props.state).filter(
    (row) => row.status !== "current",
  );
  return (
    <>
      <h1>Migration preview</h1>
      <p>Preview cross-tool changes before anything writes to disk.</p>
      <section className="migration-form" aria-label="Migration settings">
        <div className="field">
          <label htmlFor="migration-target">Target tool</label>
          <select
            id="migration-target"
            value={props.state.migration.targetToolKey}
            onChange={(event) =>
              props.onTargetTool(event.currentTarget.value as MigrationTargetToolKey)
            }
          >
            {MIGRATION_TARGET_TOOL_OPTIONS.map((target) => (
              <option key={target} value={target}>
                {target}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="migration-conflict">Existing target files</label>
          <select
            id="migration-conflict"
            value={props.state.migration.conflictPolicy}
            onChange={(event) =>
              props.onConflictPolicy(event.currentTarget.value as MigrationConflictPolicy)
            }
          >
            {MIGRATION_CONFLICT_POLICY_OPTIONS.map((policy) => (
              <option key={policy} value={policy}>
                {policy === "merge" ? "merge (not supported yet)" : policy}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="asset-picker">
          <legend>Source assets</legend>
          {props.state.assets.length === 0 ? (
            <p>Scan a project before creating a migration preview.</p>
          ) : (
            props.state.assets.map((asset) => (
              <label key={asset.id} className="asset-option">
                <input
                  type="checkbox"
                  checked={props.state.migration.sourceAssetIds.includes(asset.id)}
                  onChange={(event) => props.onToggleSource(asset.id, event.currentTarget.checked)}
                />
                <span>{asset.logicalKey}</span>
                <small>
                  {asset.toolKey} / {asset.resourceType}
                </small>
              </label>
            ))
          )}
        </fieldset>
      </section>
      <button type="button" disabled={previewBlockers.length > 0} onClick={props.onPreview}>
        Preview migration
      </button>
      {previewBlockers.length === 0 ? null : (
        <ul className="migration-blockers">
          {previewBlockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
      {props.state.preview === undefined ? null : (
        <div className="diff-card">
          <header className="preview-summary">
            <strong>Plan {props.state.preview.planId}</strong>
            <span>Hash: {props.state.preview.planHash}</span>
            <span>Compatibility: {props.state.preview.compatibility}</span>
            <span>
              Confirmations:{" "}
              {props.state.preview.requiredConfirmations.length === 0
                ? "none"
                : props.state.preview.requiredConfirmations.join(", ")}
            </span>
            <span>Expires: {props.state.preview.expiresAt}</span>
          </header>
          {props.state.preview.warnings.length === 0 ? null : (
            <ul className="warning-list">
              {props.state.preview.warnings.map((warning) => (
                <li key={warning.id}>{warning.message}</li>
              ))}
            </ul>
          )}
          {driftRows.length === 0 ? null : (
            <section className="drift-panel" aria-label="Source drift warnings">
              <h2>Source drift</h2>
              <p>Refresh the scan and create a fresh preview before deploying.</p>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col">Status</th>
                    <th scope="col">Expected hash</th>
                    <th scope="col">Current hash</th>
                  </tr>
                </thead>
                <tbody>
                  {driftRows.map((row) => (
                    <tr key={row.assetId}>
                      <td>{row.assetId}</td>
                      <td>{row.status}</td>
                      <td>{row.expectedHash}</td>
                      <td>{row.currentHash ?? "missing"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <section className="hash-snapshot" aria-label="Migration hash snapshot">
            <h2>Hash snapshot</h2>
            <table>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Item</th>
                  <th scope="col">Expected hash</th>
                </tr>
              </thead>
              <tbody>
                {migrationHashRowsForPreview(props.state.preview).map((row) => (
                  <tr key={`${row.kind}:${row.label}`}>
                    <td>{row.kind}</td>
                    <td>{row.label}</td>
                    <td>{row.hash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {props.state.preview.changes.map((change) => (
            <section key={change.pathDisplay} className="planned-change">
              <h2>
                {change.operation} {change.pathDisplay}
              </h2>
              <dl>
                <dt>Before</dt>
                <dd>{change.beforeHash ?? "absent"}</dd>
                <dt>After</dt>
                <dd>{change.afterHash ?? "absent"}</dd>
              </dl>
              <pre>{change.diff}</pre>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
