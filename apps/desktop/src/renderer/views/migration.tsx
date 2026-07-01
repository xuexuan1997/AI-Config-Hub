import { localeForState, t, type DesktopLocale } from "../i18n.js";
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
  readonly onTargetProject: (targetScopeId: string) => void;
  readonly onConflictPolicy: (conflictPolicy: MigrationConflictPolicy) => void;
}) {
  const locale = localeForState(props.state);
  const preview = props.state.preview;
  const previewBlockers = migrationPreviewBlockersForState(props.state);
  const driftRows = migrationSourceDriftRowsForState(props.state).filter(
    (row) => row.status !== "current",
  );
  const assetLabels = new Map(props.state.assets.map((asset) => [asset.id, asset.logicalKey]));
  return (
    <>
      <h1>{t(locale, "Migration preview")}</h1>
      <p>{t(locale, "Preview cross-tool changes before anything writes to disk.")}</p>
      <div
        className={
          preview === undefined
            ? "migration-preview-layout"
            : "migration-preview-layout with-preview"
        }
      >
        <div className="migration-control-panel">
          <section className="migration-form" aria-label={t(locale, "Migration settings")}>
            <div className="field">
              <label htmlFor="migration-target">{t(locale, "Target tool")}</label>
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
              <label htmlFor="migration-target-project">{t(locale, "Target project folder")}</label>
              <input
                id="migration-target-project"
                type="text"
                value={props.state.migration.targetScopeId ?? ""}
                placeholder={props.state.projectRoot ?? t(locale, "Target project path")}
                onChange={(event) => props.onTargetProject(event.currentTarget.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="migration-conflict">{t(locale, "Existing target files")}</label>
              <select
                id="migration-conflict"
                value={props.state.migration.conflictPolicy}
                onChange={(event) =>
                  props.onConflictPolicy(event.currentTarget.value as MigrationConflictPolicy)
                }
              >
                {MIGRATION_CONFLICT_POLICY_OPTIONS.map((policy) => (
                  <option key={policy} value={policy}>
                    {conflictPolicyLabel(locale, policy)}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="asset-picker">
              <legend>{t(locale, "Source assets")}</legend>
              {props.state.assets.length === 0 ? (
                <p>{t(locale, "Scan a project before creating a migration preview.")}</p>
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
            {t(locale, "Preview migration")}
          </button>
          {previewBlockers.length === 0 ? null : (
            <ul className="migration-blockers">
              {previewBlockers.map((blocker) => (
                <li key={blocker}>{t(locale, blocker)}</li>
              ))}
            </ul>
          )}
        </div>
        {preview === undefined ? null : (
          <div className="diff-card migration-result-panel">
            <header className="preview-summary">
              <strong>
                {t(locale, "Plan {plan}", { plan: displayIdentifier(preview.planId) })}
              </strong>
              <span>{t(locale, "Plan hash: {hash}", { hash: preview.planHash })}</span>
              <span>
                {t(locale, "Compatibility: {compatibility}", {
                  compatibility: compatibilityLabel(locale, preview.compatibility),
                })}
              </span>
              <span>
                {t(locale, "Confirmations: {confirmations}", {
                  confirmations:
                    preview.requiredConfirmations.length === 0
                      ? t(locale, "none")
                      : preview.requiredConfirmations
                          .map((confirmation) =>
                            t(locale, deploymentConfirmationLabel(confirmation)),
                          )
                          .join(" "),
                })}
              </span>
              <span>
                {t(locale, "Expires: {expires}", { expires: formatTimestamp(preview.expiresAt) })}
              </span>
            </header>
            {preview.warnings.length === 0 ? null : (
              <ul className="warning-list">
                {preview.warnings.map((warning) => (
                  <li key={warning.id}>{warning.message}</li>
                ))}
              </ul>
            )}
            {preview.fieldLosses.length === 0 ? null : (
              <section className="field-loss-panel" aria-label={t(locale, "Field loss details")}>
                <h2>{t(locale, "Field loss")}</h2>
                {preview.fieldLosses.map((loss) => (
                  <div key={loss.assetId} className="field-loss-detail">
                    <h3>{assetLabel(loss.assetId, assetLabels)}</h3>
                    <dl>
                      <dt>{t(locale, "Dropped")}</dt>
                      <dd>
                        {loss.droppedFields.length === 0
                          ? t(locale, "none")
                          : loss.droppedFields.join(", ")}
                      </dd>
                      <dt>{t(locale, "Retained")}</dt>
                      <dd>
                        {loss.retainedFields.length === 0
                          ? t(locale, "none")
                          : loss.retainedFields.join(", ")}
                      </dd>
                      <dt>{t(locale, "Transformed")}</dt>
                      <dd>
                        {loss.transformedFields.length === 0
                          ? t(locale, "none")
                          : loss.transformedFields
                              .map(
                                (field) =>
                                  `${field.sourceField} -> ${field.targetField}: ${field.reason}`,
                              )
                              .join("; ")}
                      </dd>
                      <dt>{t(locale, "Warnings")}</dt>
                      <dd>
                        {loss.warnings.length === 0 ? t(locale, "none") : loss.warnings.join("; ")}
                      </dd>
                    </dl>
                  </div>
                ))}
              </section>
            )}
            {driftRows.length === 0 ? null : (
              <section className="drift-panel" aria-label={t(locale, "Source drift warnings")}>
                <h2>{t(locale, "Source drift")}</h2>
                <p>{t(locale, "Refresh the scan and create a fresh preview before deploying.")}</p>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t(locale, "Asset")}</th>
                      <th scope="col">{t(locale, "Status")}</th>
                      <th scope="col">{t(locale, "Expected hash")}</th>
                      <th scope="col">{t(locale, "Current hash")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {driftRows.map((row) => (
                      <tr key={row.assetId}>
                        <td>{assetLabel(row.assetId, assetLabels)}</td>
                        <td>{driftStatusLabel(locale, row.status)}</td>
                        <td>{row.expectedHash}</td>
                        <td>{row.currentHash ?? t(locale, "missing")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
            <section className="hash-snapshot" aria-label={t(locale, "Migration hash snapshot")}>
              <h2>{t(locale, "Hash snapshot")}</h2>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t(locale, "Kind")}</th>
                    <th scope="col">{t(locale, "Item")}</th>
                    <th scope="col">{t(locale, "Expected hash")}</th>
                  </tr>
                </thead>
                <tbody>
                  {migrationHashRowsForPreview(preview).map((row) => (
                    <tr key={`${row.kind}:${row.label}`}>
                      <td>{hashRowKindLabel(locale, row.kind)}</td>
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
                  {changeOperationLabel(locale, change.operation)} {change.pathDisplay}
                </h2>
                <dl>
                  <dt>{t(locale, "Before")}</dt>
                  <dd>{change.beforeHash ?? t(locale, "absent")}</dd>
                  <dt>{t(locale, "After")}</dt>
                  <dd>{change.afterHash ?? t(locale, "absent")}</dd>
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

function conflictPolicyLabel(locale: DesktopLocale, policy: MigrationConflictPolicy): string {
  switch (policy) {
    case "replace":
      return t(locale, "Replace existing files");
    case "fail":
      return t(locale, "Stop on conflicts");
    case "merge":
      return t(locale, "Merge (not supported yet)");
  }
}

function compatibilityLabel(
  locale: DesktopLocale,
  compatibility: NonNullable<AppState["preview"]>["compatibility"],
): string {
  switch (compatibility) {
    case "full":
      return t(locale, "Full");
    case "partial":
      return t(locale, "Partial");
  }
}

function hashRowKindLabel(
  locale: DesktopLocale,
  kind: ReturnType<typeof migrationHashRowsForPreview>[number]["kind"],
): string {
  switch (kind) {
    case "source":
      return t(locale, "Source");
    case "target":
      return t(locale, "Target");
  }
}

function driftStatusLabel(
  locale: DesktopLocale,
  status: ReturnType<typeof migrationSourceDriftRowsForState>[number]["status"],
): string {
  switch (status) {
    case "current":
      return t(locale, "Current");
    case "changed":
      return t(locale, "Changed");
    case "missing":
      return t(locale, "Missing");
  }
}

function changeOperationLabel(
  locale: DesktopLocale,
  operation: NonNullable<AppState["preview"]>["changes"][number]["operation"],
): string {
  switch (operation) {
    case "create":
      return t(locale, "Create file");
    case "replace":
      return t(locale, "Replace file");
    case "delete":
      return t(locale, "Delete file");
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
