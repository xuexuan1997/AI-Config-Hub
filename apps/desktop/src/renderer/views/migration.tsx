import {
  deploymentConfirmationLabel,
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
  const preview = props.state.preview;
  const previewBlockers = migrationPreviewBlockersForState(props.state);
  const driftRows = migrationSourceDriftRowsForState(props.state).filter(
    (row) => row.status !== "current",
  );
  const assetLabels = new Map(props.state.assets.map((asset) => [asset.id, asset.logicalKey]));
  return (
    <>
      <h1>Migration preview</h1>
      <p>Preview cross-tool changes before anything writes to disk.</p>
      <div
        className={
          preview === undefined
            ? "migration-preview-layout"
            : "migration-preview-layout with-preview"
        }
      >
        <div className="migration-control-panel">
          <section className="migration-form" aria-label="Migration settings">
            <div className="field">
              <label htmlFor="migration-target">Target tool</label>
              <select
                id="migration-target"
                value={props.state.migration.targetToolKey}
                onChange={(event) => props.onTargetTool(event.currentTarget.value)}
              >
                {MIGRATION_TARGET_TOOL_OPTIONS.map((target) => (
                  <option key={target} value={target}>
                    {targetToolLabel(target)}
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
                    {conflictPolicyLabel(policy)}
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
                      onChange={(event) =>
                        props.onToggleSource(asset.id, event.currentTarget.checked)
                      }
                    />
                    <span>{asset.logicalKey}</span>
                    <small>
                      {toolLabel(asset.toolKey)} / {resourceTypeLabel(asset.resourceType)}
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
        </div>
        {preview === undefined ? null : (
          <div className="diff-card migration-result-panel">
            <header className="preview-summary">
              <strong>Plan {displayIdentifier(preview.planId)}</strong>
              <span>Plan hash: {preview.planHash}</span>
              <span>Compatibility: {compatibilityLabel(preview.compatibility)}</span>
              <span>
                Confirmations:{" "}
                {preview.requiredConfirmations.length === 0
                  ? "none"
                  : preview.requiredConfirmations.map(deploymentConfirmationLabel).join(" ")}
              </span>
              <span>Expires: {formatTimestamp(preview.expiresAt)}</span>
            </header>
            {preview.warnings.length === 0 ? null : (
              <ul className="warning-list">
                {preview.warnings.map((warning) => (
                  <li key={warning.id}>{warning.message}</li>
                ))}
              </ul>
            )}
            {preview.fieldLosses.length === 0 ? null : (
              <section className="field-loss-panel" aria-label="Field loss details">
                <h2>Field loss</h2>
                {preview.fieldLosses.map((loss) => (
                  <div key={loss.assetId} className="field-loss-detail">
                    <h3>{assetLabel(loss.assetId, assetLabels)}</h3>
                    <dl>
                      <dt>Dropped</dt>
                      <dd>
                        {loss.droppedFields.length === 0 ? "none" : loss.droppedFields.join(", ")}
                      </dd>
                      <dt>Retained</dt>
                      <dd>
                        {loss.retainedFields.length === 0 ? "none" : loss.retainedFields.join(", ")}
                      </dd>
                      <dt>Transformed</dt>
                      <dd>
                        {loss.transformedFields.length === 0
                          ? "none"
                          : loss.transformedFields
                              .map(
                                (field) =>
                                  `${field.sourceField} -> ${field.targetField}: ${field.reason}`,
                              )
                              .join("; ")}
                      </dd>
                      <dt>Warnings</dt>
                      <dd>{loss.warnings.length === 0 ? "none" : loss.warnings.join("; ")}</dd>
                    </dl>
                  </div>
                ))}
              </section>
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
                        <td>{assetLabel(row.assetId, assetLabels)}</td>
                        <td>{driftStatusLabel(row.status)}</td>
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
                  {migrationHashRowsForPreview(preview).map((row) => (
                    <tr key={`${row.kind}:${row.label}`}>
                      <td>{hashRowKindLabel(row.kind)}</td>
                      <td>
                        {row.kind === "source" ? assetLabel(row.label, assetLabels) : row.label}
                      </td>
                      <td>{row.hash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            {preview.changes.map((change) => (
              <section key={change.pathDisplay} className="planned-change">
                <h2>
                  {changeOperationLabel(change.operation)} {change.pathDisplay}
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
      </div>
    </>
  );
}

function targetToolLabel(targetTool: MigrationTargetToolKey): string {
  return toolLabel(targetTool);
}

function toolLabel(toolKey: string): string {
  switch (toolKey) {
    case "claude-code":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    default:
      return titleizeIdentifier(toolKey);
  }
}

function resourceTypeLabel(resourceType: string): string {
  return titleizeIdentifier(resourceType);
}

function conflictPolicyLabel(policy: MigrationConflictPolicy): string {
  switch (policy) {
    case "replace":
      return "Replace existing files";
    case "fail":
      return "Stop on conflicts";
    case "merge":
      return "Merge (not supported yet)";
  }
}

function compatibilityLabel(
  compatibility: NonNullable<AppState["preview"]>["compatibility"],
): string {
  switch (compatibility) {
    case "full":
      return "Full";
    case "partial":
      return "Partial";
  }
}

function hashRowKindLabel(
  kind: ReturnType<typeof migrationHashRowsForPreview>[number]["kind"],
): string {
  switch (kind) {
    case "source":
      return "Source";
    case "target":
      return "Target";
  }
}

function driftStatusLabel(
  status: ReturnType<typeof migrationSourceDriftRowsForState>[number]["status"],
): string {
  switch (status) {
    case "current":
      return "Current";
    case "changed":
      return "Changed";
    case "missing":
      return "Missing";
  }
}

function changeOperationLabel(
  operation: NonNullable<AppState["preview"]>["changes"][number]["operation"],
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

function assetLabel(assetId: string, assetLabels: ReadonlyMap<string, string>): string {
  return assetLabels.get(assetId) ?? displayIdentifier(assetId);
}

function displayIdentifier(identifier: string): string {
  const delimiterIndex = identifier.indexOf(":");
  return delimiterIndex === -1 ? identifier : identifier.slice(delimiterIndex + 1);
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

function titleizeIdentifier(identifier: string): string {
  const words = identifier
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase());
  return words.length === 0 ? identifier : words.join(" ");
}
