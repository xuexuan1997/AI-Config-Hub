import { useEffect, useMemo, useState } from "react";

import type { AppState } from "../model.js";

export function AssetsView(props: {
  readonly state: AppState;
  readonly onRefresh: () => void;
  readonly onInspect: (assetId: AppState["assets"][number]["id"]) => void;
  readonly onLoadEffective: () => void;
  readonly onOpenSource: () => void;
  readonly onToggleAssetStatus: (
    assetId: AppState["assets"][number]["id"],
    nextStatus: AssetStatus,
  ) => void;
  readonly onRescanAfterEdit: () => void;
  readonly onCloseInspect: () => void;
  readonly onLocateDiagnostic: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  const detail = props.state.assetDetail;
  const effective = props.state.effective;
  const diagnosticScope = diagnosticScopeFor(detail);
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
      <h1>Assets</h1>
      <button type="button" onClick={props.onRefresh}>
        Refresh assets
      </button>
      <p className="diagnostic-scope-label">{diagnosticScope.summary}</p>
      <div className="cards" aria-label={diagnosticScope.cardsLabel}>
        <article>
          <span>{diagnosticScope.diagnosticsLabel}</span>
          <strong>{formatErrorCount(props.state.diagnosticCounts.error)}</strong>
        </article>
        <article>
          <span>{diagnosticScope.warningsLabel}</span>
          <strong>{props.state.diagnosticCounts.warning}</strong>
        </article>
        <article>
          <span>{diagnosticScope.infoLabel}</span>
          <strong>{props.state.diagnosticCounts.info}</strong>
        </article>
      </div>
      {assetGroups.length === 0 ? (
        <p className="empty-state">No assets indexed yet.</p>
      ) : (
        <AssetTypeTabs
          activeResourceType={activeResourceType}
          groups={assetGroups}
          onInspect={props.onInspect}
          onSelectResourceType={setSelectedResourceType}
        />
      )}
      {detail === undefined ? null : (
        <AssetDetailDialog
          detail={detail}
          effective={effective}
          diagnostics={props.state.diagnostics}
          assetLabels={assetLabels}
          onOpenSource={props.onOpenSource}
          onToggleAssetStatus={props.onToggleAssetStatus}
          onRescanAfterEdit={props.onRescanAfterEdit}
          onLoadEffective={props.onLoadEffective}
          onCloseInspect={props.onCloseInspect}
          onLocateDiagnostic={props.onLocateDiagnostic}
        />
      )}
      {detail !== undefined || props.state.diagnostics.length === 0 ? null : (
        <section className="detail-panel" aria-label={diagnosticScope.panelLabel}>
          <h2>{diagnosticScope.panelHeading}</h2>
          <DiagnosticList
            diagnostics={props.state.diagnostics}
            onLocateDiagnostic={props.onLocateDiagnostic}
          />
        </section>
      )}
    </>
  );
}

type AssetSummary = AppState["assets"][number];
type AssetStatus = "enabled" | "disabled";

function assetGroupsByResourceType(assets: readonly AssetSummary[]) {
  const groups = new Map<string, AssetSummary[]>();
  for (const asset of assets) {
    const group = groups.get(asset.resourceType);
    if (group === undefined) {
      groups.set(asset.resourceType, [asset]);
    } else {
      group.push(asset);
    }
  }
  return Array.from(groups, ([resourceType, groupAssets]) => ({
    resourceType,
    assets: groupAssets,
  })).sort(compareAssetGroups);
}

function compareAssetGroups(
  left: { readonly resourceType: string },
  right: { readonly resourceType: string },
): number {
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

function AssetTypeTabs(props: {
  readonly groups: readonly { readonly resourceType: string; readonly assets: AssetSummary[] }[];
  readonly activeResourceType: string | undefined;
  readonly onInspect: (assetId: AppState["assets"][number]["id"]) => void;
  readonly onSelectResourceType: (resourceType: string) => void;
}) {
  const activeGroup =
    props.groups.find((group) => group.resourceType === props.activeResourceType) ??
    props.groups[0];
  if (activeGroup === undefined) return null;

  const activePanelId = assetTypePanelId(activeGroup.resourceType);
  return (
    <div className="asset-type-tabs">
      <div className="asset-tab-list" role="tablist" aria-label="Asset resource types">
        {props.groups.map((group) => {
          const selected = group.resourceType === activeGroup.resourceType;
          const panelId = assetTypePanelId(group.resourceType);
          const tabId = assetTypeTabId(group.resourceType);
          return (
            <button
              aria-controls={panelId}
              aria-selected={selected}
              className="asset-type-tab"
              id={tabId}
              key={group.resourceType}
              role="tab"
              type="button"
              onClick={() => props.onSelectResourceType(group.resourceType)}
            >
              <strong>{resourceTypeLabel(group.resourceType)}</strong>
              <span>{formatAssetCount(group.assets.length)}</span>
            </button>
          );
        })}
      </div>
      <section
        aria-labelledby={assetTypeTabId(activeGroup.resourceType)}
        className="asset-type-panel"
        id={activePanelId}
        role="tabpanel"
      >
        <AssetTypeTable group={activeGroup} onInspect={props.onInspect} />
      </section>
    </div>
  );
}

function AssetTypeTable(props: {
  readonly group: { readonly resourceType: string; readonly assets: AssetSummary[] };
  readonly onInspect: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  const groupLabel = resourceTypeLabel(props.group.resourceType);
  return (
    <section className="asset-type-group" aria-label={`${groupLabel} assets`}>
      <header className="asset-type-heading">
        <h2>{groupLabel} assets</h2>
        <span>{formatAssetCount(props.group.assets.length)}</span>
      </header>
      <table className="asset-table-compact">
        <thead>
          <tr>
            <th>Logical key</th>
            <th>Tool</th>
            <th>Resource</th>
            <th>Diagnostics</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {props.group.assets.map((asset) => (
            <tr key={asset.id} className="asset-row-compact">
              <td className="asset-primary-cell">
                <strong>{asset.logicalKey}</strong>
                <span className="asset-row-meta">
                  {scopeKindLabel(asset.scopeKind)}
                  <AssetStatusBadge status={assetStatusFor(asset)} />
                </span>
              </td>
              <td>{toolLabel(asset.toolKey)}</td>
              <td>{resourceTypeLabel(asset.resourceType)}</td>
              <td>{formatDiagnosticCounts(asset.diagnosticCounts)}</td>
              <td>
                <button
                  className="asset-inspect-button"
                  type="button"
                  onClick={() => props.onInspect(asset.id)}
                >
                  Inspect
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function assetTypePanelId(resourceType: string): string {
  return `asset-panel-${domIdentifier(resourceType)}`;
}

function assetTypeTabId(resourceType: string): string {
  return `asset-tab-${domIdentifier(resourceType)}`;
}

function domIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function formatAssetCount(count: number): string {
  return `${count} ${count === 1 ? "asset" : "assets"}`;
}

function assetStatusFor(asset: { readonly status?: string }): AssetStatus {
  return asset.status === "disabled" ? "disabled" : "enabled";
}

function assetStatusLabel(status: AssetStatus): string {
  return status === "disabled" ? "Disabled" : "Enabled";
}

function nextAssetStatus(status: AssetStatus): AssetStatus {
  return status === "disabled" ? "enabled" : "disabled";
}

function assetStatusActionLabel(status: AssetStatus): string {
  return status === "disabled" ? "Enable asset" : "Disable asset";
}

function formatErrorCount(count: number): string {
  return `${count} ${count === 1 ? "error" : "errors"}`;
}

function formatDiagnosticCounts(counts: AppState["diagnosticCounts"]): string {
  const parts = [
    counts.error > 0 ? formatSeverityCount(counts.error, "error") : undefined,
    counts.warning > 0 ? formatSeverityCount(counts.warning, "warning") : undefined,
    counts.info > 0 ? `${counts.info} info` : undefined,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? "No diagnostics" : parts.join(", ");
}

function formatSeverityCount(count: number, severity: "error" | "warning"): string {
  return `${count} ${count === 1 ? severity : `${severity}s`}`;
}

function diagnosticLabel(diagnostic: AppState["diagnostics"][number]): string {
  return `${severityLabel(diagnostic.severity)}: ${sentenceCaseIdentifier(diagnostic.code)}`;
}

function severityLabel(severity: AppState["diagnostics"][number]["severity"]): string {
  switch (severity) {
    case "error":
      return "Error";
    case "warning":
      return "Warning";
    case "info":
      return "Info";
  }
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
  if (resourceType.toLowerCase() === "mcp") return "MCP";
  return titleizeIdentifier(resourceType);
}

function scopeKindLabel(scopeKind: string): string {
  return `${titleizeIdentifier(scopeKind)} scope`;
}

function assetLabel(assetId: string, assetLabels: ReadonlyMap<string, string>): string {
  return assetLabels.get(assetId) ?? displayIdentifier(assetId);
}

function contributionLabel(action: string, reasonCode: string): string {
  const reason = reasonLabel(reasonCode);
  switch (action) {
    case "inherit":
      return `Inherited from ${reason}.`;
    case "merge":
      return `Merged because ${reason}.`;
    case "override":
      return `Overrode lower-priority values because ${reason}.`;
    default:
      return `${sentenceCaseIdentifier(action)} because ${reason}.`;
  }
}

function reasonLabel(reasonCode: string): string {
  return lowerFirst(sentenceCaseIdentifier(reasonCode));
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

function sentenceCaseIdentifier(identifier: string): string {
  const words = identifier
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  const firstWord = words[0];
  if (firstWord === undefined) return identifier;
  const remainingWords = words.slice(1);
  return [firstWord[0]?.toUpperCase() + firstWord.slice(1), ...remainingWords].join(" ");
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : value[0]?.toLowerCase() + value.slice(1);
}

function diagnosticScopeFor(detail: AppState["assetDetail"]) {
  if (detail === undefined) {
    return {
      cardsLabel: "Workspace diagnostic summary",
      diagnosticsLabel: "Workspace diagnostics",
      warningsLabel: "Workspace warnings",
      infoLabel: "Workspace info",
      panelLabel: "Workspace diagnostics",
      panelHeading: "Workspace diagnostics",
      summary: "Counts reflect every indexed asset in this project.",
    };
  }

  return {
    cardsLabel: `Diagnostic summary for ${detail.asset.logicalKey}`,
    diagnosticsLabel: "Selected asset diagnostics",
    warningsLabel: "Selected asset warnings",
    infoLabel: "Selected asset info",
    panelLabel: `Diagnostics for ${detail.asset.logicalKey}`,
    panelHeading: `Diagnostics for ${detail.asset.logicalKey}`,
    summary: "Counts reflect only the inspected asset.",
  };
}

function LocateDiagnosticButton(props: {
  readonly assetId: AppState["assets"][number]["id"];
  readonly onLocate: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  return (
    <button
      className="diagnostic-action"
      type="button"
      onClick={() => props.onLocate(props.assetId)}
    >
      Locate
    </button>
  );
}

function DiagnosticList(props: {
  readonly diagnostics: AppState["diagnostics"];
  readonly onLocateDiagnostic?: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  return (
    <ul className="diagnostic-list">
      {props.diagnostics.map((diagnostic) => (
        <li key={diagnostic.id}>
          <strong>{diagnosticLabel(diagnostic)}</strong>
          <span>{diagnostic.message}</span>
          {diagnostic.location === undefined ? null : (
            <small>
              {diagnostic.location.pathDisplay}
              {diagnostic.location.line === undefined ? "" : `:${diagnostic.location.line}`}
              {diagnostic.location.column === undefined ? "" : `:${diagnostic.location.column}`}
            </small>
          )}
          <small>{diagnostic.suggestedAction}</small>
          {diagnostic.assetId === undefined || props.onLocateDiagnostic === undefined ? null : (
            <LocateDiagnosticButton
              assetId={diagnostic.assetId}
              onLocate={props.onLocateDiagnostic}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function AssetStatusBadge(props: { readonly status: AssetStatus }) {
  return <span className={`asset-status ${props.status}`}>{assetStatusLabel(props.status)}</span>;
}

function AssetDetailDialog(props: {
  readonly detail: NonNullable<AppState["assetDetail"]>;
  readonly effective: AppState["effective"];
  readonly diagnostics: AppState["diagnostics"];
  readonly assetLabels: ReadonlyMap<string, string>;
  readonly onOpenSource: () => void;
  readonly onToggleAssetStatus: (
    assetId: AppState["assets"][number]["id"],
    nextStatus: AssetStatus,
  ) => void;
  readonly onRescanAfterEdit: () => void;
  readonly onLoadEffective: () => void;
  readonly onCloseInspect: () => void;
  readonly onLocateDiagnostic: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  const detail = props.detail;
  const effective = props.effective;
  const status = assetStatusFor(detail.asset);
  const targetStatus = nextAssetStatus(status);
  return (
    <div className="asset-detail-modal">
      <section
        className="asset-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Asset detail"
      >
        <header className="asset-detail-header">
          <div>
            <span className="eyebrow">Inspect asset</span>
            <h2>{detail.asset.logicalKey}</h2>
          </div>
          <button className="asset-detail-close" type="button" onClick={props.onCloseInspect}>
            Close
          </button>
        </header>
        <div className="asset-detail-scroll">
          <div className="detail-actions">
            <button type="button" onClick={props.onOpenSource}>
              Open source
            </button>
            <button
              type="button"
              onClick={() => props.onToggleAssetStatus(detail.asset.id, targetStatus)}
            >
              {assetStatusActionLabel(status)}
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
            <dd>{toolLabel(detail.asset.toolKey)}</dd>
            <dt>Resource</dt>
            <dd>{resourceTypeLabel(detail.asset.resourceType)}</dd>
            <dt>Status</dt>
            <dd>{assetStatusLabel(status)}</dd>
            <dt>Scope</dt>
            <dd>{detail.asset.scopeId}</dd>
            <dt>Source</dt>
            <dd>{detail.source.pathDisplay}</dd>
            <dt>Observed</dt>
            <dd>{formatTimestamp(detail.source.observedAt)}</dd>
          </dl>
          <section className="asset-detail-diagnostics">
            <h3>Diagnostics</h3>
            {props.diagnostics.length === 0 ? (
              <p>No diagnostics for this asset.</p>
            ) : (
              <DiagnosticList
                diagnostics={props.diagnostics}
                onLocateDiagnostic={props.onLocateDiagnostic}
              />
            )}
          </section>
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
                      <strong>{assetLabel(contributor.assetId, props.assetLabels)}</strong>{" "}
                      <span>{contributionLabel(contributor.action, contributor.reasonCode)}</span>
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
                      <strong>{assetLabel(ignored.assetId, props.assetLabels)}</strong>{" "}
                      <span>Ignored because {reasonLabel(ignored.reasonCode)}.</span>
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
                      <strong>{diagnosticLabel(diagnostic)}</strong>
                      <span>{diagnostic.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
