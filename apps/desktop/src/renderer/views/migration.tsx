import { useEffect, useMemo, useState } from "react";

import { localeForState, localizeUiMessage, t, type DesktopLocale } from "../i18n.js";
import {
  deploymentBlockersForState,
  deploymentConfirmationLabel,
  migrationAssetDifferencesForState,
  MIGRATION_CONFLICT_POLICY_OPTIONS,
  MIGRATION_TARGET_TOOL_OPTIONS,
  migrationDifferenceSummaryForState,
  migrationHashRowsForPreview,
  migrationPreviewBlockersForState,
  migrationSourceDriftRowsForState,
  type AppState,
  type DeploymentConfirmation,
  type MigrationConflictPolicy,
  type MigrationTargetToolKey,
} from "../model.js";
import { ScanTaskPanel } from "./scan-task-panel.js";

export function MigrationView(props: {
  readonly state: AppState;
  readonly onPreview: () => void;
  readonly onToggleSource: (assetId: AppState["assets"][number]["id"], selected: boolean) => void;
  readonly onTargetTool: (targetToolKey: MigrationTargetToolKey) => void;
  readonly onConflictPolicy: (conflictPolicy: MigrationConflictPolicy) => void;
  readonly onConfirmMigration: (confirmed: boolean) => void;
  readonly onConfirmRequirement: (confirmation: DeploymentConfirmation, granted: boolean) => void;
  readonly onExecuteMigration: () => void;
  readonly onSelectSourceProject?: () => void;
  readonly onSelectTargetProject?: () => void;
  readonly onSwapProjects?: () => void;
}) {
  const locale = localeForState(props.state);
  const preview = props.state.preview;
  const previewBlockers = migrationPreviewBlockersForState(props.state);
  const driftRows = migrationSourceDriftRowsForState(props.state).filter(
    (row) => row.status !== "current",
  );
  const assetLabels = new Map(
    props.state.migrationSourceAssets.map((asset) => [asset.id, asset.logicalKey]),
  );
  const assetGroups = useMemo(
    () => assetGroupsByResourceType(props.state.migrationSourceAssets),
    [props.state.migrationSourceAssets],
  );
  const firstResourceType =
    assetGroups.find((group) => group.assets.length > 0)?.resourceType ??
    assetGroups[0]?.resourceType;
  const [selectedResourceType, setSelectedResourceType] = useState(firstResourceType);
  const activeResourceType =
    selectedResourceType !== undefined &&
    assetGroups.some((group) => group.resourceType === selectedResourceType)
      ? selectedResourceType
      : firstResourceType;
  const activeGroup =
    assetGroups.find((group) => group.resourceType === activeResourceType) ?? assetGroups[0];
  const summary = migrationDifferenceSummaryForState(props.state);
  const deploymentBlockers = deploymentBlockersForState(props.state);
  const requiredConfirmations = preview?.requiredConfirmations ?? [];
  const grantedConfirmations = new Set(props.state.deploymentConfirmationGrants);
  const stateActiveTask = props.state.activeTask;
  const activeTask = stateActiveTask?.taskKind === "deployment" ? stateActiveTask : undefined;
  const scanTask = stateActiveTask?.taskKind === "scan" ? stateActiveTask : undefined;
  const targetRows = useMemo(
    () => targetRowsForState(props.state, activeResourceType),
    [props.state, activeResourceType],
  );

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
          onChoose={props.onSelectSourceProject}
        />
        <button
          className="migration-swap-projects"
          aria-label={t(locale, "Swap source and target")}
          title={t(locale, "Swap source and target")}
          type="button"
          onClick={props.onSwapProjects}
        >
          ⇄
        </button>
        <ProjectCard
          className="target"
          label={t(locale, "Target project")}
          value={props.state.migration.targetScopeId}
          placeholder={t(locale, "Target project path")}
          chooseLabel={t(locale, "Choose")}
          onChoose={props.onSelectTargetProject}
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
              <strong>{resourceTypeLabel(locale, group.resourceType)}</strong>
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
          <ScanTaskPanel
            ariaLabel={t(locale, "Source scan status")}
            heading={t(locale, "Source scan")}
            locale={locale}
            message={props.state.scanStatus === "error" ? props.state.message : undefined}
            task={scanTask}
          />
          <div className="migration-asset-list">
            {activeGroup === undefined ? (
              <p>{t(locale, "Scan a source project before creating a migration preview.")}</p>
            ) : activeGroup.assets.length === 0 ? (
              <p>{t(locale, "No differences for this asset type.")}</p>
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
                    {toolLabel(asset.toolKey)} / {resourceTypeLabel(locale, asset.resourceType)}
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
            <span>
              {t(locale, preview === undefined ? "Target-only kept" : "Unchanged planned outputs")}
            </span>
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
                <li key={blocker}>{localizeUiMessage(locale, blocker)}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="migration-target-panel panel">
          <header className="panel-title">
            <strong>{t(locale, "Target assets")}</strong>
            <span>{formatAssetCount(locale, targetRows.length)}</span>
          </header>
          <dl className="target-context">
            <dt>{t(locale, "Target project")}</dt>
            <dd>{props.state.migration.targetScopeId || t(locale, "Target project path")}</dd>
            <dt>{t(locale, "Target tool")}</dt>
            <dd>{targetToolLabel(props.state.migration.targetToolKey)}</dd>
          </dl>
          <div className="migration-asset-list">
            {props.state.migration.targetScopeId === undefined ? (
              <p>{t(locale, "Choose a target project to see target assets.")}</p>
            ) : targetRows.length === 0 ? (
              <p>{t(locale, "No target assets for this tool and type.")}</p>
            ) : (
              targetRows.map((row) =>
                row.kind === "asset" ? (
                  <TargetAssetRow
                    key={row.asset.id}
                    asset={row.asset}
                    change={row.change}
                    liveDifference={row.liveDifference}
                    locale={locale}
                    sourceAssetSummary={sourceAssetSummaryForPreview(preview, assetLabels)}
                    targetProject={props.state.migration.targetScopeId}
                    targetTool={targetToolLabel(props.state.migration.targetToolKey)}
                  />
                ) : row.kind === "preview" ? (
                  <PreviewTargetRow
                    key={row.group.groupId}
                    group={row.group}
                    locale={locale}
                    sourceAssetSummary={sourceAssetSummaryForPreview(preview, assetLabels)}
                    targetProject={props.state.migration.targetScopeId}
                    targetTool={targetToolLabel(props.state.migration.targetToolKey)}
                  />
                ) : (
                  <SourceOnlyTargetRow
                    key={`source-only:${row.difference.sourceAsset?.id ?? row.difference.logicalKey}`}
                    difference={row.difference}
                    locale={locale}
                    targetProject={props.state.migration.targetScopeId}
                    targetTool={targetToolLabel(props.state.migration.targetToolKey)}
                  />
                ),
              )
            )}
          </div>
        </section>
      </section>

      {preview === undefined && activeTask === undefined ? null : (
        <section className="migration-preview-details">
          <MigrationExecutionPanel
            activeTask={activeTask}
            deploymentBlockers={deploymentBlockers}
            deploymentConfirmed={props.state.deploymentConfirmed}
            grantedConfirmations={grantedConfirmations}
            locale={locale}
            preview={preview}
            requiredConfirmations={requiredConfirmations}
            onConfirmMigration={props.onConfirmMigration}
            onConfirmRequirement={props.onConfirmRequirement}
            onExecuteMigration={props.onExecuteMigration}
          />
          {preview === undefined ? null : (
            <>
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
              {changeGroupsForPreview(preview).map((group) => (
                <section key={group.groupId} className="planned-change">
                  <div className="planned-change-summary">
                    <h2>
                      {groupOperationLabel(locale, group.operation)} {group.targetRootRelativePath}
                    </h2>
                    <span>{formatFileCount(locale, group.changedTargetCount)}</span>
                  </div>
                  <details className="planned-change-details">
                    <summary>{t(locale, "Show diff and hashes")}</summary>
                    {preview.changes
                      .filter((change) => changeGroupId(change) === group.groupId)
                      .map((change) => (
                        <div className="planned-change-file" key={change.pathDisplay}>
                          <h3>
                            {changeOperationLabel(locale, change.operation)} {change.pathDisplay}
                          </h3>
                          <dl>
                            <dt>{t(locale, "Deployment")}</dt>
                            <dd>{deploymentTypeLabel(locale, change.deploymentType)}</dd>
                            {change.sourcePathDisplay === undefined ? null : (
                              <>
                                <dt>{t(locale, "Source file")}</dt>
                                <dd>{change.sourcePathDisplay}</dd>
                              </>
                            )}
                            <dt>{t(locale, "Before")}</dt>
                            <dd>{change.beforeHash ?? t(locale, "absent")}</dd>
                            <dt>{t(locale, "After")}</dt>
                            <dd>{change.afterHash ?? t(locale, "absent")}</dd>
                          </dl>
                          <pre>{change.diff}</pre>
                        </div>
                      ))}
                    {group.detailsTruncated ? (
                      <p>
                        {t(locale, "File details are truncated to {count}.", {
                          count: group.visibleDetailCount,
                        })}
                      </p>
                    ) : null}
                  </details>
                </section>
              ))}
            </>
          )}
        </section>
      )}
    </>
  );
}

type MigrationAssetSummary = AppState["assets"][number];
type MigrationPreviewChange = NonNullable<AppState["preview"]>["changes"][number];
type MigrationPreviewGroup = NonNullable<AppState["preview"]>["changeGroups"][number];
type MigrationAssetDifference = ReturnType<typeof migrationAssetDifferencesForState>[number];
type MigrationTargetRow =
  | {
      readonly kind: "asset";
      readonly asset: MigrationAssetSummary;
      readonly change: MigrationPreviewChange | undefined;
      readonly liveDifference: MigrationAssetDifference | undefined;
    }
  | { readonly kind: "preview"; readonly group: MigrationPreviewGroup }
  | { readonly kind: "source-only"; readonly difference: MigrationAssetDifference };

function changeGroupsForPreview(
  preview: NonNullable<AppState["preview"]>,
): readonly MigrationPreviewGroup[] {
  const previewWithOptionalGroups = preview as NonNullable<AppState["preview"]> & {
    readonly changeGroups?: readonly MigrationPreviewGroup[];
  };
  if (previewWithOptionalGroups.changeGroups !== undefined) {
    return previewWithOptionalGroups.changeGroups;
  }
  return preview.changes.map((change) => {
    const groupId = changeGroupId(change);
    return {
      groupId,
      operation: change.operation,
      targetRootPathDisplay: change.pathDisplay,
      targetRootRelativePath: change.pathDisplay,
      operationCount: 1,
      createCount: change.operation === "create" ? 1 : 0,
      replaceCount: change.operation === "replace" ? 1 : 0,
      deleteCount: change.operation === "delete" ? 1 : 0,
      generatedFileCount: change.deploymentType === "generated_file" ? 1 : 0,
      copyCount: change.deploymentType === "copy" ? 1 : 0,
      symlinkCount: change.deploymentType === "symlink" ? 1 : 0,
      changedTargetCount: 1,
      targetPathSample: [change.pathDisplay],
      visibleDetailCount: 1,
      detailsTruncated: false,
    };
  });
}

function changeGroupId(change: MigrationPreviewChange): string {
  return (
    (change as MigrationPreviewChange & { readonly groupId?: string }).groupId ?? change.pathDisplay
  );
}

function TargetAssetRow(props: {
  readonly asset: MigrationAssetSummary;
  readonly change: MigrationPreviewChange | undefined;
  readonly liveDifference: MigrationAssetDifference | undefined;
  readonly locale: DesktopLocale;
  readonly sourceAssetSummary: string;
  readonly targetProject: string | undefined;
  readonly targetTool: string;
}) {
  const statusLabel =
    props.change === undefined
      ? liveDifferenceStatusLabel(props.locale, props.liveDifference)
      : targetChangeStatusLabel(props.locale, props.change.operation);
  return (
    <div
      className={`target-change-row ${
        props.change === undefined
          ? liveDifferenceTone(props.liveDifference)
          : targetChangeTone(props.change.operation)
      }`}
    >
      <div className="target-change-heading">
        <strong>{props.asset.logicalKey}</strong>
        <span>{statusLabel}</span>
      </div>
      <p className="target-change-meta">
        <span>{props.targetTool}</span>
        <span>{resourceTypeLabel(props.locale, props.asset.resourceType)}</span>
        <span>
          {props.change === undefined
            ? liveHashChangeCompactLabel(props.asset.contentHash, props.liveDifference?.sourceAsset)
            : deploymentTypeLabel(props.locale, props.change.deploymentType)}
        </span>
      </p>
      <details className="target-change-details">
        <summary>{t(props.locale, "Details")}</summary>
        <dl>
          <dt>{t(props.locale, "Target project")}</dt>
          <dd>{props.targetProject}</dd>
          <dt>{t(props.locale, "Target tool")}</dt>
          <dd>{props.targetTool}</dd>
          <dt>{t(props.locale, "Asset type")}</dt>
          <dd>{resourceTypeLabel(props.locale, props.asset.resourceType)}</dd>
          <dt>{t(props.locale, "Target directory")}</dt>
          <dd>{props.asset.sourceDirectory ?? t(props.locale, "unknown")}</dd>
          <dt>{t(props.locale, "Content hash")}</dt>
          <dd>{props.asset.contentHash}</dd>
          {props.change !== undefined ? (
            <>
              <dt>{t(props.locale, "Source asset")}</dt>
              <dd>{props.sourceAssetSummary}</dd>
              <dt>{t(props.locale, "Preview target file")}</dt>
              <dd>{props.change.pathDisplay}</dd>
              <dt>{t(props.locale, "Deployment")}</dt>
              <dd>{deploymentTypeLabel(props.locale, props.change.deploymentType)}</dd>
              {props.change.sourcePathDisplay === undefined ? null : (
                <>
                  <dt>{t(props.locale, "Source file")}</dt>
                  <dd>{props.change.sourcePathDisplay}</dd>
                </>
              )}
              <dt>{t(props.locale, "Hash change")}</dt>
              <dd>{hashChangeLabel(props.locale, props.change)}</dd>
            </>
          ) : props.liveDifference?.sourceAsset === undefined ? null : (
            <>
              <dt>{t(props.locale, "Source asset")}</dt>
              <dd>{props.liveDifference.sourceAsset.logicalKey}</dd>
              <dt>{t(props.locale, "Hash change")}</dt>
              <dd>{liveHashChangeLabel(props.liveDifference)}</dd>
            </>
          )}
        </dl>
      </details>
    </div>
  );
}

function PreviewTargetRow(props: {
  readonly group: MigrationPreviewGroup;
  readonly locale: DesktopLocale;
  readonly sourceAssetSummary: string;
  readonly targetProject: string | undefined;
  readonly targetTool: string;
}) {
  return (
    <div className={`target-change-row ${targetChangeTone(props.group.operation)}`}>
      <div className="target-change-heading">
        <strong>{props.group.targetRootRelativePath}</strong>
        <span>{targetChangeStatusLabel(props.locale, props.group.operation)}</span>
      </div>
      <p className="target-change-meta">
        <span>{props.targetTool}</span>
        {props.group.resourceType === undefined ? null : (
          <span>{resourceTypeLabel(props.locale, props.group.resourceType)}</span>
        )}
        <span>{formatFileCount(props.locale, props.group.changedTargetCount)}</span>
      </p>
      <details className="target-change-details">
        <summary>{t(props.locale, "Details")}</summary>
        <dl>
          <dt>{t(props.locale, "Target project")}</dt>
          <dd>{props.targetProject}</dd>
          <dt>{t(props.locale, "Target tool")}</dt>
          <dd>{props.targetTool}</dd>
          <dt>{t(props.locale, "Source asset")}</dt>
          <dd>{props.sourceAssetSummary}</dd>
          <dt>{t(props.locale, "Preview target folder")}</dt>
          <dd>{props.group.targetRootRelativePath}</dd>
          <dt>{t(props.locale, "Changed files")}</dt>
          <dd>{formatFileCount(props.locale, props.group.changedTargetCount)}</dd>
          <dt>{t(props.locale, "Preview target files")}</dt>
          <dd>{props.group.targetPathSample.join(", ")}</dd>
        </dl>
      </details>
    </div>
  );
}

function SourceOnlyTargetRow(props: {
  readonly difference: MigrationAssetDifference;
  readonly locale: DesktopLocale;
  readonly targetProject: string | undefined;
  readonly targetTool: string;
}) {
  const sourceAsset = props.difference.sourceAsset;
  if (sourceAsset === undefined) return null;
  return (
    <div className="target-change-row is-create">
      <div className="target-change-heading">
        <strong>{sourceAsset.logicalKey}</strong>
        <span>{targetChangeStatusLabel(props.locale, "create")}</span>
      </div>
      <p className="target-change-meta">
        <span>{props.targetTool}</span>
        <span>{resourceTypeLabel(props.locale, sourceAsset.resourceType)}</span>
        <span>{shortHash(sourceAsset.contentHash)}</span>
      </p>
      <details className="target-change-details">
        <summary>{t(props.locale, "Details")}</summary>
        <dl>
          <dt>{t(props.locale, "Target project")}</dt>
          <dd>{props.targetProject}</dd>
          <dt>{t(props.locale, "Target tool")}</dt>
          <dd>{props.targetTool}</dd>
          <dt>{t(props.locale, "Asset type")}</dt>
          <dd>{resourceTypeLabel(props.locale, sourceAsset.resourceType)}</dd>
          <dt>{t(props.locale, "Source asset")}</dt>
          <dd>{sourceAsset.logicalKey}</dd>
          <dt>{t(props.locale, "Content hash")}</dt>
          <dd>{sourceAsset.contentHash}</dd>
        </dl>
      </details>
    </div>
  );
}

function targetRowsForState(
  state: AppState,
  resourceType: string | undefined,
): readonly MigrationTargetRow[] {
  const targetAssets = state.migrationTargetAssets
    .filter(
      (asset) =>
        asset.toolKey === state.migration.targetToolKey &&
        (resourceType === undefined || asset.resourceType === resourceType),
    )
    .sort((left, right) => left.logicalKey.localeCompare(right.logicalKey));
  if (state.preview === undefined) {
    return liveTargetRowsForState(state, targetAssets, resourceType);
  }
  return changeGroupsForPreview(state.preview)
    .filter(
      (group) =>
        resourceType === undefined ||
        group.resourceType === undefined ||
        group.resourceType === resourceType,
    )
    .map(
      (group): MigrationTargetRow => ({
        kind: "preview",
        group,
      }),
    );
}

function liveTargetRowsForState(
  state: AppState,
  targetAssets: readonly MigrationAssetSummary[],
  resourceType: string | undefined,
): readonly MigrationTargetRow[] {
  const liveDifferences = migrationAssetDifferencesForState(state).filter(
    (difference) => resourceType === undefined || difference.resourceType === resourceType,
  );
  const liveDifferenceByTargetId = new Map(
    liveDifferences
      .filter(
        (
          difference,
        ): difference is MigrationAssetDifference & {
          readonly targetAsset: MigrationAssetSummary;
        } => difference.targetAsset !== undefined,
      )
      .map((difference) => [difference.targetAsset.id, difference]),
  );
  const assetRows = targetAssets.map(
    (asset): MigrationTargetRow => ({
      kind: "asset",
      asset,
      change: undefined,
      liveDifference: liveDifferenceByTargetId.get(asset.id),
    }),
  );
  const sourceOnlyRows = liveDifferences
    .filter((difference) => difference.operation === "create")
    .map((difference): MigrationTargetRow => ({ kind: "source-only", difference }));
  return [...assetRows, ...sourceOnlyRows].sort(compareLiveTargetRows);
}

function compareLiveTargetRows(left: MigrationTargetRow, right: MigrationTargetRow): number {
  return targetRowLabel(left).localeCompare(targetRowLabel(right));
}

function targetRowLabel(row: MigrationTargetRow): string {
  switch (row.kind) {
    case "asset":
      return row.asset.logicalKey;
    case "preview":
      return row.group.targetRootRelativePath;
    case "source-only":
      return row.difference.sourceAsset?.logicalKey ?? row.difference.logicalKey;
  }
}

function hashChangeLabel(locale: DesktopLocale, change: MigrationPreviewChange): string {
  return `${change.beforeHash === null ? t(locale, "absent") : change.beforeHash} -> ${
    change.afterHash === null ? t(locale, "absent") : change.afterHash
  }`;
}

function liveHashChangeLabel(difference: MigrationAssetDifference): string {
  return `${difference.sourceAsset?.contentHash ?? "absent"} -> ${
    difference.targetAsset?.contentHash ?? "absent"
  }`;
}

function liveHashChangeCompactLabel(
  targetHash: string,
  sourceAsset: MigrationAssetSummary | undefined,
): string {
  return `${sourceAsset === undefined ? "absent" : shortHash(sourceAsset.contentHash)} -> ${shortHash(
    targetHash,
  )}`;
}

function shortHash(hash: string): string {
  const prefix = "sha256:";
  return hash.startsWith(prefix)
    ? `${prefix}${hash.slice(prefix.length, prefix.length + 8)}`
    : hash;
}

function targetChangeStatusLabel(
  locale: DesktopLocale,
  operation:
    | MigrationPreviewChange["operation"]
    | NonNullable<AppState["preview"]>["changeGroups"][number]["operation"],
): string {
  switch (operation) {
    case "create":
      return t(locale, "Will create");
    case "replace":
      return t(locale, "Will overwrite");
    case "delete":
      return t(locale, "Will delete");
    case "mixed":
      return t(locale, "Will change");
  }
}

function liveDifferenceStatusLabel(
  locale: DesktopLocale,
  difference: MigrationAssetDifference | undefined,
): string {
  switch (difference?.operation) {
    case "replace":
      return t(locale, "Changed");
    case "target-only":
      return t(locale, "Target-only kept");
    case "unchanged":
      return t(locale, "Current");
    case "create":
      return targetChangeStatusLabel(locale, "create");
    case undefined:
      return t(locale, "Target asset");
  }
}

function liveDifferenceTone(difference: MigrationAssetDifference | undefined): string {
  switch (difference?.operation) {
    case "create":
      return "is-create";
    case "replace":
      return "is-replace";
    case "target-only":
    case "unchanged":
    case undefined:
      return "is-existing";
  }
}

type MigrationAssetGroup = {
  readonly resourceType: string;
  readonly assets: readonly MigrationAssetSummary[];
};

function MigrationExecutionPanel(props: {
  readonly activeTask: NonNullable<AppState["activeTask"]> | undefined;
  readonly deploymentBlockers: readonly string[];
  readonly deploymentConfirmed: boolean;
  readonly grantedConfirmations: ReadonlySet<DeploymentConfirmation>;
  readonly locale: DesktopLocale;
  readonly preview: AppState["preview"];
  readonly requiredConfirmations: readonly DeploymentConfirmation[];
  readonly onConfirmMigration: (confirmed: boolean) => void;
  readonly onConfirmRequirement: (confirmation: DeploymentConfirmation, granted: boolean) => void;
  readonly onExecuteMigration: () => void;
}) {
  return (
    <section className="migration-execution-panel" aria-label={t(props.locale, "Migration run")}>
      <header className="migration-execution-heading">
        <div>
          <span className="eyebrow">{t(props.locale, "Migration run")}</span>
          <h2>{t(props.locale, "Run migration")}</h2>
          <p>
            {t(props.locale, "Confirm the fresh preview, then execute the write from this page.")}
          </p>
        </div>
        {props.preview === undefined ? null : (
          <dl className="migration-run-plan">
            <dt>{t(props.locale, "Plan")}</dt>
            <dd>{displayIdentifier(props.preview.planId)}</dd>
            <dt>{t(props.locale, "Compatibility")}</dt>
            <dd>{compatibilityLabel(props.locale, props.preview.compatibility)}</dd>
            <dt>{t(props.locale, "Expires")}</dt>
            <dd>{formatTimestamp(props.preview.expiresAt)}</dd>
          </dl>
        )}
      </header>
      {props.activeTask === undefined ? null : (
        <section className="migration-run-status" aria-label={t(props.locale, "Migration status")}>
          <h3>{t(props.locale, "Migration status")}</h3>
          <p className="task-status-summary">
            <span>
              {t(props.locale, "Status: {status}", {
                status: phaseLabel(props.locale, props.activeTask.phase),
              })}
            </span>
            {props.activeTask.progress === undefined ? null : (
              <span>{progressLabel(props.activeTask)}</span>
            )}
          </p>
          {props.activeTask.message === undefined ? null : (
            <p>{localizeUiMessage(props.locale, props.activeTask.message)}</p>
          )}
          {props.activeTask.recoveryLock ? (
            <div className="recovery-lock">
              <p>{t(props.locale, "Recovery lock active. Resolve it before retrying.")}</p>
            </div>
          ) : null}
        </section>
      )}
      <section
        className="migration-confirmation-panel"
        aria-label={t(props.locale, "Migration confirmations")}
      >
        <label className="confirmation-item">
          <input
            checked={props.deploymentConfirmed}
            type="checkbox"
            onChange={(event) => props.onConfirmMigration(event.currentTarget.checked)}
          />
          <span>{t(props.locale, "I understand this writes verified config files.")}</span>
        </label>
        {props.requiredConfirmations.length === 0 ? null : (
          <fieldset className="confirmation-list">
            <legend>{t(props.locale, "Required confirmations")}</legend>
            {props.requiredConfirmations.map((confirmation) => (
              <label key={confirmation} className="confirmation-item">
                <input
                  checked={props.grantedConfirmations.has(confirmation)}
                  type="checkbox"
                  onChange={(event) =>
                    props.onConfirmRequirement(confirmation, event.currentTarget.checked)
                  }
                />
                <span>{t(props.locale, deploymentConfirmationLabel(confirmation))}</span>
              </label>
            ))}
          </fieldset>
        )}
      </section>
      <div className="migration-action-row">
        <button
          type="button"
          disabled={props.deploymentBlockers.length > 0}
          onClick={props.onExecuteMigration}
        >
          {t(props.locale, "Execute migration")}
        </button>
      </div>
      {props.deploymentBlockers.length === 0 ? null : (
        <ul className="blocker-panel">
          {props.deploymentBlockers.map((blocker) => (
            <li key={blocker}>
              {localizeDeploymentBlocker(
                props.locale,
                blocker,
                missingConfirmationLabels(props.requiredConfirmations, props.grantedConfirmations),
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectCard(props: {
  readonly className: "source" | "target";
  readonly label: string;
  readonly value: string | undefined;
  readonly placeholder: string;
  readonly chooseLabel: string;
  readonly onChoose?: (() => void) | undefined;
}) {
  const inputId = `migration-${props.className}-project`;
  return (
    <div className={`migration-project-card ${props.className}`}>
      <div className="migration-project-copy">
        <span id={inputId}>{props.label}</span>
        <strong aria-labelledby={inputId} title={props.value}>
          {props.value ?? props.placeholder}
        </strong>
      </div>
      <div className="migration-project-actions">
        <button type="button" onClick={props.onChoose}>
          {props.chooseLabel}
        </button>
      </div>
    </div>
  );
}

function missingConfirmationLabels(
  requiredConfirmations: readonly DeploymentConfirmation[],
  grantedConfirmations: ReadonlySet<DeploymentConfirmation>,
): readonly string[] {
  return requiredConfirmations
    .filter((confirmation) => !grantedConfirmations.has(confirmation))
    .map(deploymentConfirmationLabel);
}

function localizeDeploymentBlocker(
  locale: DesktopLocale,
  blocker: string,
  missingConfirmations: readonly string[],
): string {
  if (blocker.startsWith("Confirm required migration actions:")) {
    return `${t(locale, "Confirm required migration actions:")} ${missingConfirmations
      .map((confirmation) => t(locale, confirmation))
      .join(" ")}`;
  }
  return t(locale, blocker);
}

function phaseLabel(
  locale: DesktopLocale,
  phase: NonNullable<AppState["activeTask"]>["phase"],
): string {
  switch (phase) {
    case "queued":
      return t(locale, "Queued");
    case "discovering":
      return t(locale, "Discovering");
    case "reading":
      return t(locale, "Reading");
    case "parsing":
      return t(locale, "Parsing");
    case "validating":
      return t(locale, "Validating");
    case "committing":
      return t(locale, "Committing");
    case "preflight":
      return t(locale, "Preflight");
    case "backing_up":
      return t(locale, "Backing up");
    case "writing":
      return t(locale, "Writing");
    case "verifying":
      return t(locale, "Verifying");
    case "restoring":
      return t(locale, "Restoring");
    case "rolling_back":
      return t(locale, "Rolling back");
    case "completed":
      return t(locale, "Completed");
  }
}

function progressLabel(task: NonNullable<AppState["activeTask"]>): string {
  const progress = task.progress;
  if (progress === undefined) return "";
  return progress.total === null
    ? `${progress.completed} ${progress.unit}`
    : `${progress.completed}/${progress.total} ${progress.unit}`;
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
      <p>{t(props.locale, "Refresh the scan and create a fresh preview before migrating.")}</p>
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
  const hashRows = migrationHashRowsForPreview(props.preview);
  const visibleRows = hashRows.slice(0, HASH_SAMPLE_LIMIT);
  return (
    <details className="hash-snapshot" aria-label={t(props.locale, "Migration hash snapshot")}>
      <summary>
        {t(props.locale, "Hash snapshot")}{" "}
        {t(props.locale, "{visible} shown of {total}", {
          visible: visibleRows.length,
          total: hashRows.length,
        })}
      </summary>
      <table>
        <thead>
          <tr>
            <th scope="col">{t(props.locale, "Kind")}</th>
            <th scope="col">{t(props.locale, "Item")}</th>
            <th scope="col">{t(props.locale, "Expected hash")}</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row) => (
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
      {hashRows.length > visibleRows.length ? (
        <p>
          {t(props.locale, "Hash rows are truncated to {count}.", {
            count: visibleRows.length,
          })}
        </p>
      ) : null}
    </details>
  );
}

function assetGroupsByResourceType(
  assets: readonly MigrationAssetSummary[],
): MigrationAssetGroup[] {
  const groups = new Map<string, MigrationAssetSummary[]>();
  for (const resourceType of KNOWN_MIGRATION_RESOURCE_TYPES) {
    groups.set(resourceType, []);
  }
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

const KNOWN_MIGRATION_RESOURCE_TYPES = ["rule", "agent", "skill", "mcp"] as const;
const HASH_SAMPLE_LIMIT = 20;

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
  if (preview === undefined) {
    return migrationAssetDifferencesForState(state).filter(
      (difference) =>
        difference.resourceType === group.resourceType && difference.operation !== "unchanged",
    ).length;
  }
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

function formatFileCount(locale: DesktopLocale, count: number): string {
  if (locale === "zh-CN") return `${count} 个文件`;
  return `${count} ${count === 1 ? "file" : "files"}`;
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

function resourceTypeLabel(locale: DesktopLocale, resourceType: string): string {
  if (resourceType.toLowerCase() === "mcp") return "MCP";
  return t(locale, titleizeIdentifier(resourceType));
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

function groupOperationLabel(
  locale: DesktopLocale,
  operation: NonNullable<AppState["preview"]>["changeGroups"][number]["operation"],
): string {
  switch (operation) {
    case "create":
      return t(locale, "Create files");
    case "replace":
      return t(locale, "Replace files");
    case "delete":
      return t(locale, "Delete files");
    case "mixed":
      return t(locale, "Change files");
  }
}

function deploymentTypeLabel(
  locale: DesktopLocale,
  deploymentType: NonNullable<AppState["preview"]>["changes"][number]["deploymentType"],
): string {
  switch (deploymentType) {
    case "generated_file":
      return t(locale, "Generated file");
    case "copy":
      return t(locale, "Copy source file");
    case "symlink":
      return t(locale, "Symlink source file");
  }
}

function targetChangeTone(
  operation: NonNullable<AppState["preview"]>["changeGroups"][number]["operation"],
): string {
  switch (operation) {
    case "create":
      return "is-create";
    case "replace":
      return "is-replace";
    case "delete":
      return "is-delete";
    case "mixed":
      return "is-replace";
  }
}

function sourceAssetSummaryForPreview(
  preview: AppState["preview"],
  assetLabels: ReadonlyMap<string, string>,
): string {
  if (preview === undefined) return "";
  return Object.keys(preview.sourceHashes)
    .sort((left, right) => left.localeCompare(right))
    .map((assetId) => assetLabel(assetId, assetLabels))
    .join(", ");
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
