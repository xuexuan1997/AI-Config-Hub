import { useEffect, useMemo, useState } from "react";

import { localeForState, t, type DesktopLocale } from "../i18n.js";
import {
  deploymentConfirmationLabel,
  MIGRATION_CONFLICT_POLICY_OPTIONS,
  MIGRATION_TARGET_TOOL_OPTIONS,
  migrationDifferenceSummaryForState,
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
  readonly onSourceProject?: (sourceProjectRoot: string) => void;
  readonly onSelectSourceProject?: () => void;
  readonly onSelectTargetProject?: () => void;
  readonly onSwapProjects?: () => void;
  readonly onScanSource?: () => void;
}) {
  const locale = localeForState(props.state);
  const preview = props.state.preview;
  const previewBlockers = migrationPreviewBlockersForState(props.state);
  const driftRows = migrationSourceDriftRowsForState(props.state).filter(
    (row) => row.status !== "current",
  );
  const assetLabels = new Map(props.state.assets.map((asset) => [asset.id, asset.logicalKey]));
  const assetGroups = useMemo(
    () => assetGroupsByResourceType(props.state.assets),
    [props.state.assets],
  );
  const firstResourceType = assetGroups[0]?.resourceType;
  const [selectedResourceType, setSelectedResourceType] = useState(firstResourceType);
  const activeResourceType =
    selectedResourceType !== undefined &&
    assetGroups.some((group) => group.resourceType === selectedResourceType)
      ? selectedResourceType
      : firstResourceType;
  const activeGroup =
    assetGroups.find((group) => group.resourceType === activeResourceType) ?? assetGroups[0];
  const summary = migrationDifferenceSummaryForState(props.state);

  useEffect(() => {
    if (
      firstResourceType !== undefined &&
      !assetGroups.some((group) => group.resourceType === selectedResourceType)
    ) {
      setSelectedResourceType(firstResourceType);
    }
  }, [assetGroups, firstResourceType, selectedResourceType]);

  return (
    <>
      <section className="page-heading">
        <div>
          <h1>{t(locale, "Asset Migration")}</h1>
          <p>{t(locale, "Choose source and target projects independently before writing.")}</p>
        </div>
        <button type="button" disabled={previewBlockers.length > 0} onClick={props.onPreview}>
          {t(locale, "Preview writes")}
        </button>
      </section>

      <section className="migration-project-picker">
        <ProjectCard
          className="source"
          label={t(locale, "Source project")}
          value={props.state.migration.sourceProjectRoot}
          placeholder={t(locale, "Source project path")}
          chooseLabel={t(locale, "Choose")}
          scanLabel={t(locale, "Scan source")}
          onChoose={props.onSelectSourceProject}
          onChange={props.onSourceProject}
          onScan={props.onScanSource}
        />
        <button
          className="migration-swap-projects"
          title={t(locale, "Swap source and target")}
          type="button"
          onClick={props.onSwapProjects}
        >
          {t(locale, "Swap source and target")}
        </button>
        <ProjectCard
          className="target"
          label={t(locale, "Target project")}
          value={props.state.migration.targetScopeId}
          placeholder={t(locale, "Target project path")}
          chooseLabel={t(locale, "Choose")}
          onChoose={props.onSelectTargetProject}
          onChange={props.onTargetProject}
        />
      </section>

      <div
        className="asset-tab-list migration-tabs"
        role="tablist"
        aria-label={t(locale, "Asset resource types")}
      >
        {assetGroups.map((group) => {
          const selected = group.resourceType === activeGroup?.resourceType;
          return (
            <button
              aria-selected={selected}
              className="asset-type-tab"
              key={group.resourceType}
              role="tab"
              type="button"
              onClick={() => setSelectedResourceType(group.resourceType)}
            >
              <strong>{resourceTypeLabel(group.resourceType)}</strong>
              <span>
                {formatDifferenceCount(locale, differenceCountForGroup(props.state, group))}
              </span>
            </button>
          );
        })}
      </div>

      <section className="migration-comparison-body">
        <section className="migration-source-panel panel">
          <header className="panel-title">
            <strong>{t(locale, "Source assets")}</strong>
            <span>{formatAssetCount(locale, activeGroup?.assets.length ?? 0)}</span>
          </header>
          <div className="migration-asset-list">
            {activeGroup === undefined ? (
              <p>{t(locale, "Scan a source project before creating a migration preview.")}</p>
            ) : (
              activeGroup.assets.map((asset) => (
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
          </div>
        </section>

        <section className="migration-difference-summary">
          <h2>{t(locale, "Difference summary")}</h2>
          <div className="summary-card">
            <span>{t(locale, "Added to target")}</span>
            <strong>{summary.addedToTarget}</strong>
          </div>
          <div className="summary-card">
            <span>{t(locale, "Overwritten in target")}</span>
            <strong>{summary.overwrittenInTarget}</strong>
          </div>
          <div className="summary-card">
            <span>{t(locale, "Target-only kept")}</span>
            <strong>{summary.targetOnlyKept}</strong>
          </div>
          <div className="summary-card">
            <span>{t(locale, "Conflicts or warnings")}</span>
            <strong>{summary.conflictsOrWarnings}</strong>
          </div>
          <div className="field compact">
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
          <div className="field compact">
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
          {preview === undefined ? null : (
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
          )}
          {previewBlockers.length === 0 ? null : (
            <ul className="migration-blockers">
              {previewBlockers.map((blocker) => (
                <li key={blocker}>{t(locale, blocker)}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="migration-target-panel panel">
          <header className="panel-title">
            <strong>{t(locale, "Target impact")}</strong>
            <span>{formatAssetCount(locale, preview?.changes.length ?? 0)}</span>
          </header>
          <div className="migration-asset-list">
            {preview === undefined ? (
              <p>{t(locale, "Preview writes to see target impact.")}</p>
            ) : (
              preview.changes.map((change) => (
                <div key={change.pathDisplay} className="target-change-row">
                  <strong>
                    {changeOperationLabel(locale, change.operation)} {change.pathDisplay}
                  </strong>
                  <span>
                    {change.beforeHash === null ? t(locale, "absent") : change.beforeHash} {" -> "}
                    {change.afterHash === null ? t(locale, "absent") : change.afterHash}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </section>

      {preview === undefined ? null : (
        <section className="migration-preview-details">
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
                <FieldLossDetail
                  key={loss.assetId}
                  assetLabels={assetLabels}
                  locale={locale}
                  loss={loss}
                />
              ))}
            </section>
          )}
          {driftRows.length === 0 ? null : (
            <DriftPanel assetLabels={assetLabels} driftRows={driftRows} locale={locale} />
          )}
          <HashSnapshot assetLabels={assetLabels} locale={locale} preview={preview} />
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
        </section>
      )}
    </>
  );
}

type MigrationAssetSummary = AppState["assets"][number];
type MigrationAssetGroup = {
  readonly resourceType: string;
  readonly assets: readonly MigrationAssetSummary[];
};

function ProjectCard(props: {
  readonly className: "source" | "target";
  readonly label: string;
  readonly value: string | undefined;
  readonly placeholder: string;
  readonly chooseLabel: string;
  readonly scanLabel?: string | undefined;
  readonly onChoose?: (() => void) | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly onScan?: (() => void) | undefined;
}) {
  const inputId = `migration-${props.className}-project`;
  return (
    <div className={`migration-project-card ${props.className}`}>
      <div className="migration-project-copy">
        <label htmlFor={inputId}>{props.label}</label>
        <input
          id={inputId}
          placeholder={props.placeholder}
          type="text"
          value={props.value ?? ""}
          onChange={(event) => props.onChange?.(event.currentTarget.value)}
        />
      </div>
      <div className="migration-project-actions">
        <button type="button" onClick={props.onChoose}>
          {props.chooseLabel}
        </button>
        {props.scanLabel === undefined ? null : (
          <button type="button" onClick={props.onScan}>
            {props.scanLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function FieldLossDetail(props: {
  readonly assetLabels: ReadonlyMap<string, string>;
  readonly locale: DesktopLocale;
  readonly loss: NonNullable<AppState["preview"]>["fieldLosses"][number];
}) {
  const loss = props.loss;
  return (
    <div className="field-loss-detail">
      <h3>{assetLabel(loss.assetId, props.assetLabels)}</h3>
      <dl>
        <dt>{t(props.locale, "Dropped")}</dt>
        <dd>
          {loss.droppedFields.length === 0
            ? t(props.locale, "none")
            : loss.droppedFields.join(", ")}
        </dd>
        <dt>{t(props.locale, "Retained")}</dt>
        <dd>
          {loss.retainedFields.length === 0
            ? t(props.locale, "none")
            : loss.retainedFields.join(", ")}
        </dd>
        <dt>{t(props.locale, "Transformed")}</dt>
        <dd>
          {loss.transformedFields.length === 0
            ? t(props.locale, "none")
            : loss.transformedFields
                .map((field) => `${field.sourceField} -> ${field.targetField}: ${field.reason}`)
                .join("; ")}
        </dd>
        <dt>{t(props.locale, "Warnings")}</dt>
        <dd>{loss.warnings.length === 0 ? t(props.locale, "none") : loss.warnings.join("; ")}</dd>
      </dl>
    </div>
  );
}

function DriftPanel(props: {
  readonly assetLabels: ReadonlyMap<string, string>;
  readonly driftRows: readonly ReturnType<typeof migrationSourceDriftRowsForState>[number][];
  readonly locale: DesktopLocale;
}) {
  return (
    <section className="drift-panel" aria-label={t(props.locale, "Source drift warnings")}>
      <h2>{t(props.locale, "Source drift")}</h2>
      <p>{t(props.locale, "Refresh the scan and create a fresh preview before deploying.")}</p>
      <table>
        <thead>
          <tr>
            <th scope="col">{t(props.locale, "Asset")}</th>
            <th scope="col">{t(props.locale, "Status")}</th>
            <th scope="col">{t(props.locale, "Expected hash")}</th>
            <th scope="col">{t(props.locale, "Current hash")}</th>
          </tr>
        </thead>
        <tbody>
          {props.driftRows.map((row) => (
            <tr key={row.assetId}>
              <td>{assetLabel(row.assetId, props.assetLabels)}</td>
              <td>{driftStatusLabel(props.locale, row.status)}</td>
              <td>{row.expectedHash}</td>
              <td>{row.currentHash ?? t(props.locale, "missing")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function HashSnapshot(props: {
  readonly assetLabels: ReadonlyMap<string, string>;
  readonly locale: DesktopLocale;
  readonly preview: NonNullable<AppState["preview"]>;
}) {
  return (
    <section className="hash-snapshot" aria-label={t(props.locale, "Migration hash snapshot")}>
      <h2>{t(props.locale, "Hash snapshot")}</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">{t(props.locale, "Kind")}</th>
            <th scope="col">{t(props.locale, "Item")}</th>
            <th scope="col">{t(props.locale, "Expected hash")}</th>
          </tr>
        </thead>
        <tbody>
          {migrationHashRowsForPreview(props.preview).map((row) => (
            <tr key={`${row.kind}:${row.label}`}>
              <td>{hashRowKindLabel(props.locale, row.kind)}</td>
              <td>
                {row.kind === "source" ? assetLabel(row.label, props.assetLabels) : row.label}
              </td>
              <td>{row.hash}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function assetGroupsByResourceType(
  assets: readonly MigrationAssetSummary[],
): MigrationAssetGroup[] {
  const groups = new Map<string, MigrationAssetSummary[]>();
  for (const asset of assets) {
    const group = groups.get(asset.resourceType);
    if (group === undefined) groups.set(asset.resourceType, [asset]);
    else group.push(asset);
  }
  return Array.from(groups, ([resourceType, groupAssets]) => ({
    resourceType,
    assets: groupAssets,
  })).sort(compareAssetGroups);
}

function compareAssetGroups(left: MigrationAssetGroup, right: MigrationAssetGroup): number {
  const leftPriority = resourceTypePriority(left.resourceType);
  const rightPriority = resourceTypePriority(right.resourceType);
  return leftPriority === rightPriority
    ? left.resourceType.localeCompare(right.resourceType)
    : leftPriority - rightPriority;
}

function resourceTypePriority(resourceType: string): number {
  switch (resourceType) {
    case "rule":
      return 0;
    case "agent":
      return 1;
    case "skill":
      return 2;
    case "mcp":
      return 3;
    default:
      return 10;
  }
}

function differenceCountForGroup(state: AppState, group: MigrationAssetGroup): number {
  const preview = state.preview;
  if (preview === undefined) return 0;
  const groupAssetIds = new Set<string>(group.assets.map((asset) => asset.id));
  return Object.keys(preview.sourceHashes).filter((assetId) => groupAssetIds.has(assetId)).length;
}

function formatDifferenceCount(locale: DesktopLocale, count: number): string {
  if (locale === "zh-CN") return `${count} 项差异`;
  return `${count} ${count === 1 ? "difference" : "differences"}`;
}

function formatAssetCount(locale: DesktopLocale, count: number): string {
  if (locale === "zh-CN") return `${count} 个资产`;
  return `${count} ${count === 1 ? "asset" : "assets"}`;
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
