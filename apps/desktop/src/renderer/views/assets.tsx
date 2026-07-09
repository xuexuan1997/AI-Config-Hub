import { useEffect, useMemo, useState } from "react";

import { localeForState, localizeUiMessage, t, type DesktopLocale } from "../i18n.js";
import type { AppState, AssetDisablementMethod } from "../model.js";
import { ScanTaskModal, ScanTaskPanel } from "./scan-task-panel.js";

type AssetSourceSummary = AppState["assets"][number]["sourceSummary"];

export function AssetsView(props: {
  readonly state: AppState;
  readonly initialDiagnosticSeverity?: DiagnosticSeverityFilter;
  readonly initialDiagnosticCode?: string;
  readonly onRefresh?: () => void;
  readonly onInspect: (assetId: AppState["assets"][number]["id"]) => void;
  readonly onLoadEffective: () => void;
  readonly onOpenSource: () => void;
  readonly onToggleAssetStatus: (
    assetId: AppState["assets"][number]["id"],
    nextStatus: AssetStatus,
    disablementMethod?: AssetDisablementMethod,
  ) => void;
  readonly onRescanAfterEdit?: () => void;
  readonly onCloseInspect: () => void;
  readonly onLocateDiagnostic: (assetId: AppState["assets"][number]["id"]) => void;
  readonly onSelectProject?: () => void;
  readonly onUseProjectPath?: (path: string) => void;
  readonly onScan?: () => void;
}) {
  const locale = localeForState(props.state);
  const detail = props.state.assetDetail;
  const diagnosticScope = diagnosticScopeFor(locale, detail);
  const activeTask = props.state.activeTask;
  const scanTask =
    activeTask?.taskKind === "scan" &&
    (activeTask.scanScope === undefined || activeTask.scanScope === "asset-review")
      ? activeTask
      : undefined;
  const scanMessage =
    props.state.scanStatus === "error" &&
    (props.state.scanScope === undefined || props.state.scanScope === "asset-review")
      ? props.state.message
      : undefined;
  const assetsById = new Map(props.state.assets.map((asset) => [asset.id, asset]));
  const [selectedToolKey, setSelectedToolKey] = useState(DEFAULT_TOOL_KEY);
  const toolOptions = useMemo(() => assetToolOptions(props.state.assets), [props.state.assets]);
  const visibleAssets = useMemo(
    () => props.state.assets.filter((asset) => asset.toolKey === selectedToolKey),
    [props.state.assets, selectedToolKey],
  );
  const assetGroups = useMemo(() => assetGroupsByResourceType(visibleAssets), [visibleAssets]);
  const firstResourceType = assetGroups[0]?.resourceType;
  const [selectedResourceType, setSelectedResourceType] = useState(firstResourceType);
  const [selectedDiagnosticSeverity, setSelectedDiagnosticSeverity] =
    useState<DiagnosticSeverityFilter>(props.initialDiagnosticSeverity ?? "all");
  const [selectedDiagnosticCode, setSelectedDiagnosticCode] = useState(
    props.initialDiagnosticCode ?? ALL_DIAGNOSTIC_CODES,
  );
  const activeResourceType =
    selectedResourceType !== undefined &&
    assetGroups.some((group) => group.resourceType === selectedResourceType)
      ? selectedResourceType
      : firstResourceType;
  const diagnosticsInSeverity = useMemo(
    () => diagnosticsForSeverity(props.state.diagnostics, selectedDiagnosticSeverity),
    [props.state.diagnostics, selectedDiagnosticSeverity],
  );
  const diagnosticCodeOptions = useMemo(
    () => diagnosticCodesFor(diagnosticsInSeverity),
    [diagnosticsInSeverity],
  );
  const activeDiagnosticCode = diagnosticCodeOptions.includes(selectedDiagnosticCode)
    ? selectedDiagnosticCode
    : ALL_DIAGNOSTIC_CODES;
  const visibleDiagnostics = useMemo(
    () => diagnosticsForCode(diagnosticsInSeverity, activeDiagnosticCode),
    [diagnosticsInSeverity, activeDiagnosticCode],
  );

  useEffect(() => {
    if (
      firstResourceType !== undefined &&
      !assetGroups.some((group) => group.resourceType === selectedResourceType)
    ) {
      setSelectedResourceType(firstResourceType);
    }
  }, [assetGroups, firstResourceType, selectedResourceType]);

  useEffect(() => {
    if (selectedDiagnosticCode !== activeDiagnosticCode) {
      setSelectedDiagnosticCode(activeDiagnosticCode);
    }
  }, [activeDiagnosticCode, selectedDiagnosticCode]);

  return (
    <>
      <ScanTaskModal heading={t(locale, "Scanning assets")} locale={locale} task={scanTask} />
      <section className="page-heading">
        <div>
          <h1>{t(locale, "Asset Review")}</h1>
          <p>
            {t(
              locale,
              "Inspect one current project without implying that it is a migration source.",
            )}
          </p>
        </div>
      </section>
      <section className="review-project-card">
        <div className="review-project-summary">
          <span>{t(locale, "Current project")}</span>
          <strong title={props.state.projectRoot}>
            {props.state.projectRoot ?? t(locale, "No folder selected yet")}
          </strong>
          <small>{t(locale, "Scans automatically after project selection.")}</small>
        </div>
        <div className="review-project-actions">
          <button type="button" onClick={props.onSelectProject}>
            {t(locale, "Choose project")}
          </button>
        </div>
      </section>
      <ScanTaskPanel
        ariaLabel={t(locale, "Scan status")}
        heading={t(locale, "Scanning assets")}
        locale={locale}
        message={scanMessage}
        task={scanTask}
      />
      <section className="review-workspace">
        <aside className="review-filters">
          <h2>{t(locale, "Review filters")}</h2>
          <ToolFilterList
            activeToolKey={selectedToolKey}
            locale={locale}
            tools={toolOptions}
            onSelectToolKey={setSelectedToolKey}
          />
          <p className="diagnostic-scope-label">{diagnosticScope.summary}</p>
          <div className="cards compact" aria-label={diagnosticScope.cardsLabel}>
            <article>
              <span>{diagnosticScope.diagnosticsLabel}</span>
              <strong>{formatErrorCount(locale, props.state.diagnosticCounts.error)}</strong>
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
        </aside>
        <section className="review-list-panel">
          {props.state.assets.length === 0 ? (
            <p className="empty-state">{t(locale, "No assets indexed yet.")}</p>
          ) : assetGroups.length === 0 ? (
            <p className="empty-state">{t(locale, "No assets match the selected tool.")}</p>
          ) : (
            <AssetTypeTabs
              activeResourceType={activeResourceType}
              groups={assetGroups}
              locale={locale}
              onInspect={props.onInspect}
              onSelectResourceType={setSelectedResourceType}
            />
          )}
        </section>
        <aside className="review-detail-panel">
          <h2>{t(locale, "Asset detail")}</h2>
          {detail === undefined ? (
            <p>
              {t(locale, "Select an asset to inspect its source, problems, and effective config.")}
            </p>
          ) : (
            <dl>
              <dt>{t(locale, "Logical key")}</dt>
              <dd>{detail.asset.logicalKey}</dd>
              <dt>{t(locale, "Tool")}</dt>
              <dd>{toolLabel(detail.asset.toolKey)}</dd>
              <dt>{t(locale, "Resource")}</dt>
              <dd>{resourceTypeLabel(locale, detail.asset.resourceType)}</dd>
              <dt>{t(locale, "Source")}</dt>
              <dd>{detail.source.pathDisplay}</dd>
            </dl>
          )}
        </aside>
      </section>
      {detail === undefined ? null : (
        <AssetDetailDialog
          detail={detail}
          summary={assetsById.get(detail.asset.id)}
          diagnostics={props.state.diagnostics}
          locale={locale}
          message={props.state.message}
          onOpenSource={props.onOpenSource}
          onToggleAssetStatus={props.onToggleAssetStatus}
          onCloseInspect={props.onCloseInspect}
          onLocateDiagnostic={props.onLocateDiagnostic}
        />
      )}
      {detail !== undefined || props.state.diagnostics.length === 0 ? null : (
        <section className="detail-panel diagnostic-panel" aria-label={diagnosticScope.panelLabel}>
          <header className="diagnostic-panel-header">
            <div>
              <h2>{diagnosticScope.panelHeading}</h2>
              <span className="diagnostic-result-summary">
                {formatDiagnosticResultSummary(
                  locale,
                  visibleDiagnostics.length,
                  props.state.diagnostics.length,
                )}
              </span>
            </div>
          </header>
          <WorkspaceDiagnosticFilters
            activeCode={activeDiagnosticCode}
            activeSeverity={selectedDiagnosticSeverity}
            codeOptions={diagnosticCodeOptions}
            diagnostics={props.state.diagnostics}
            locale={locale}
            onCodeChange={setSelectedDiagnosticCode}
            onSeverityChange={setSelectedDiagnosticSeverity}
          />
          {visibleDiagnostics.length === 0 ? (
            <p className="empty-state">{t(locale, "No diagnostics match the current filters.")}</p>
          ) : (
            <DiagnosticList
              diagnostics={visibleDiagnostics}
              locale={locale}
              onLocateDiagnostic={props.onLocateDiagnostic}
            />
          )}
        </section>
      )}
    </>
  );
}

type AssetSummary = AppState["assets"][number];
type AssetLoadStateSource = {
  readonly status?: string | undefined;
  readonly loadState?: AssetLoadState | undefined;
  readonly coveredByLogicalKey?: string | undefined;
};
type AssetStatus = "enabled" | "disabled";
type AssetLoadState = "loaded" | "covered" | "disabled";
type DiagnosticSummary = AppState["diagnostics"][number];
type DiagnosticSeverityFilter = "all" | DiagnosticSummary["severity"];

const DEFAULT_TOOL_KEY = "claude-code";
const ALL_DIAGNOSTIC_CODES = "__all__";
const DIAGNOSTIC_SEVERITY_FILTERS: readonly DiagnosticSeverityFilter[] = [
  "all",
  "error",
  "warning",
  "info",
];

function assetToolOptions(assets: readonly AssetSummary[]): readonly string[] {
  return [...new Set([DEFAULT_TOOL_KEY, ...assets.map((asset) => asset.toolKey)])].sort(
    compareToolKeys,
  );
}

function compareToolKeys(left: string, right: string): number {
  const leftPriority = toolPriority(left);
  const rightPriority = toolPriority(right);
  return leftPriority === rightPriority ? left.localeCompare(right) : leftPriority - rightPriority;
}

function toolPriority(toolKey: string): number {
  switch (toolKey) {
    case "claude-code":
      return 0;
    case "codex":
      return 1;
    case "cursor":
      return 2;
    case "opencode":
      return 3;
    default:
      return 10;
  }
}

function ToolFilterList(props: {
  readonly tools: readonly string[];
  readonly activeToolKey: string;
  readonly locale: DesktopLocale;
  readonly onSelectToolKey: (toolKey: string) => void;
}) {
  return (
    <div className="tool-filter-list" aria-label={t(props.locale, "Tool filters")}>
      {props.tools.map((toolKey) => (
        <button
          aria-pressed={toolKey === props.activeToolKey}
          className="tool-filter-button"
          key={toolKey}
          type="button"
          onClick={() => props.onSelectToolKey(toolKey)}
        >
          {toolLabel(toolKey)}
        </button>
      ))}
    </div>
  );
}

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
  readonly locale: DesktopLocale;
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
      <div
        className="asset-tab-list"
        role="tablist"
        aria-label={t(props.locale, "Asset resource types")}
      >
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
              <strong>{resourceTypeLabel(props.locale, group.resourceType)}</strong>
              <span>{formatAssetCount(props.locale, group.assets.length)}</span>
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
        <AssetTypeTable group={activeGroup} locale={props.locale} onInspect={props.onInspect} />
      </section>
    </div>
  );
}

function AssetTypeTable(props: {
  readonly group: { readonly resourceType: string; readonly assets: AssetSummary[] };
  readonly locale: DesktopLocale;
  readonly onInspect: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  const groupLabel = resourceTypeLabel(props.locale, props.group.resourceType);
  return (
    <section
      className="asset-type-group"
      aria-label={t(props.locale, "{resource} assets", { resource: groupLabel })}
    >
      <header className="asset-type-heading">
        <h2>{t(props.locale, "{resource} assets", { resource: groupLabel })}</h2>
        <span>{formatAssetCount(props.locale, props.group.assets.length)}</span>
      </header>
      <table className="asset-table-compact">
        <thead>
          <tr>
            <th>{t(props.locale, "Logical key")}</th>
            <th>{t(props.locale, "Source")}</th>
            <th>{t(props.locale, "Will load")}</th>
            <th>{t(props.locale, "Diagnostics")}</th>
            <th>{t(props.locale, "Detail")}</th>
          </tr>
        </thead>
        <tbody>
          {props.group.assets.map((asset) => (
            <tr key={asset.id} className="asset-row-compact">
              <td className="asset-primary-cell">
                <strong>{asset.logicalKey}</strong>
                <span className="asset-row-meta">
                  {scopeKindLabel(props.locale, asset.scopeKind)}
                  <AssetStatusBadge locale={props.locale} status={assetStatusFor(asset)} />
                </span>
              </td>
              <td className="asset-source-cell" title={assetSourceTitle(props.locale, asset)}>
                {assetSourceLabel(props.locale, asset)}
              </td>
              <td>
                <AssetLoadBadge asset={asset} locale={props.locale} />
              </td>
              <td>{formatDiagnosticCounts(props.locale, asset.diagnosticCounts)}</td>
              <td>
                <button
                  className="asset-inspect-button"
                  type="button"
                  onClick={() => props.onInspect(asset.id)}
                >
                  {t(props.locale, "Inspect")}
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

function formatAssetCount(locale: DesktopLocale, count: number): string {
  if (locale === "zh-CN") return `${count} 个资产`;
  return `${count} ${count === 1 ? "asset" : "assets"}`;
}

function formatFileCount(locale: DesktopLocale, count: number): string {
  if (locale === "zh-CN") return `${count} 个文件`;
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function formatFolderCount(locale: DesktopLocale, count: number): string {
  if (locale === "zh-CN") return `${count} 个文件夹`;
  return `${count} ${count === 1 ? "folder" : "folders"}`;
}

function formatTextFileCount(locale: DesktopLocale, count: number): string {
  if (locale === "zh-CN") return `${count} 个文本文件`;
  return `${count} ${count === 1 ? "text file" : "text files"}`;
}

function formatBinaryFileCount(locale: DesktopLocale, count: number): string {
  if (locale === "zh-CN") return `${count} 个二进制文件`;
  return `${count} ${count === 1 ? "binary file" : "binary files"}`;
}

function packageRootLabel(summary: Extract<AssetSourceSummary, { readonly kind: "package" }>) {
  return `${summary.rootName.replace(/[\\/]+$/, "")}/`;
}

function assetStatusFor(asset: { readonly status?: string | undefined }): AssetStatus {
  return asset.status === "disabled" ? "disabled" : "enabled";
}

function assetStatusLabel(locale: DesktopLocale, status: AssetStatus): string {
  return status === "disabled" ? t(locale, "Disabled") : t(locale, "Enabled");
}

function assetLoadStateFor(asset: AssetLoadStateSource): AssetLoadState {
  if (assetStatusFor(asset) === "disabled") return "disabled";
  return asset.loadState ?? "loaded";
}

function sourceDirectoryLabel(locale: DesktopLocale, asset: AssetSummary): string {
  return asset.sourceDirectory ?? t(locale, "Unknown source");
}

function assetSourceTitle(locale: DesktopLocale, asset: AssetSummary): string {
  const summary: AssetSourceSummary | undefined = asset.sourceSummary;
  if (summary?.kind === "package") {
    return asset.sourceDirectory ?? packageRootLabel(summary);
  }
  return sourceDirectoryLabel(locale, asset);
}

function assetSourceLabel(locale: DesktopLocale, asset: AssetSummary): string {
  const summary: AssetSourceSummary | undefined = asset.sourceSummary;
  if (summary === undefined) return sourceDirectoryLabel(locale, asset);
  if (summary.kind === "file") {
    return asset.sourceDirectory ?? summary.fileName;
  }
  return [
    packageRootLabel(summary),
    formatFileCount(locale, summary.fileCount),
    formatFolderCount(locale, summary.folderCount),
  ].join(" · ");
}

function loadStateLabel(locale: DesktopLocale, asset: AssetLoadStateSource): string {
  const state = assetLoadStateFor(asset);
  if (state === "disabled") return t(locale, "No, disabled");
  if (state === "covered") {
    return asset.coveredByLogicalKey === undefined
      ? t(locale, "No, covered")
      : t(locale, "No, covered by {asset}", { asset: asset.coveredByLogicalKey });
  }
  return t(locale, "Yes");
}

function AssetLoadBadge(props: {
  readonly asset: AssetLoadStateSource;
  readonly locale: DesktopLocale;
}) {
  const state = assetLoadStateFor(props.asset);
  return (
    <span className={`asset-load-badge ${state}`}>{loadStateLabel(props.locale, props.asset)}</span>
  );
}

function formatErrorCount(locale: DesktopLocale, count: number): string {
  if (locale === "zh-CN") return `${count} 个错误`;
  return `${count} ${count === 1 ? "error" : "errors"}`;
}

function formatDiagnosticCounts(
  locale: DesktopLocale,
  counts: AppState["diagnosticCounts"],
): string {
  if (locale === "zh-CN") {
    const parts = [
      counts.error > 0 ? `${counts.error} 个错误` : undefined,
      counts.warning > 0 ? `${counts.warning} 个警告` : undefined,
      counts.info > 0 ? `${counts.info} 条信息` : undefined,
    ].filter((part) => part !== undefined);
    return parts.length === 0 ? t(locale, "No diagnostics") : parts.join("，");
  }
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

function severityLabel(
  locale: DesktopLocale,
  severity: AppState["diagnostics"][number]["severity"],
): string {
  switch (severity) {
    case "error":
      return t(locale, "Error");
    case "warning":
      return t(locale, "Warning");
    case "info":
      return t(locale, "Info");
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

function resourceTypeLabel(locale: DesktopLocale, resourceType: string): string {
  if (resourceType.toLowerCase() === "mcp") return "MCP";
  return t(locale, titleizeIdentifier(resourceType));
}

function scopeKindLabel(locale: DesktopLocale, scopeKind: string): string {
  const label = titleizeIdentifier(scopeKind);
  if (locale === "zh-CN") return t(locale, "{scope} scope", { scope: t(locale, label) });
  return `${label} scope`;
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
    .map((word) => properNounIdentifierWord(word) ?? word.toLowerCase());
  const firstWord = words[0];
  if (firstWord === undefined) return identifier;
  const remainingWords = words.slice(1);
  return [firstWord[0]?.toUpperCase() + firstWord.slice(1), ...remainingWords].join(" ");
}

function properNounIdentifierWord(word: string): string | undefined {
  switch (word.toLowerCase()) {
    case "agent":
      return "Agent";
    case "rule":
      return "Rule";
    case "mcp":
      return "MCP";
    case "skill":
      return "Skill";
    default:
      return undefined;
  }
}

const ZH_DIAGNOSTIC_CODE_LABELS: Readonly<Record<string, string>> = {
  ADAPTER_DIAGNOSTIC: "适配器诊断",
  ADAPTER_PARSE_INVALID: "配置解析失败",
  ADAPTER_WRITE_CAPABILITY_UNAVAILABLE: "适配器写入能力不可用",
  CURSOR_LEGACY_RULE_FORMAT: "Cursor 旧版 Rule 格式",
  DEPLOYMENT_DELETE_NOT_APPLIED: "部署删除未生效",
  DEPLOYMENT_TARGET_HASH_MISMATCH: "部署目标哈希不匹配",
  DEPLOYMENT_TARGET_SEMANTIC_INVALID: "部署目标语义无效",
  DEPLOYMENT_TARGET_SEMANTIC_KIND_MISMATCH: "部署目标资源类型不匹配",
  DEPLOYMENT_TARGETS_ALREADY_IDENTICAL: "部署目标已完全一致",
  DUPLICATE_RESOURCE_LOCATOR: "资源定位符重复",
  MCP_LITERAL_SECRET_RISK: "MCP 明文密钥风险",
  MCP_NON_DEPLOYABLE_SECRET: "MCP 含不可部署密钥",
  PARTIAL_CONVERSION: "部分转换",
  RESOURCE_IGNORED_BY_EFFECTIVE_CONFIG: "资源被有效配置忽略",
  RESOURCE_INSTRUCTIONS_EMPTY: "资源指令为空",
  RESOURCE_OUTSIDE_CONFIG_ROOT: "资源位于配置根目录外",
  SCAN_READ_FAILED: "扫描读取失败",
  STALE_INDEX: "索引已过期",
  UNRESOLVED_SKILL_REFERENCE: "未解析的 Skill 引用",
  VALIDATION_FAILED: "校验失败",
};

const ZH_DIAGNOSTIC_MESSAGES: Readonly<Record<string, string>> = {
  "All generated outputs are already byte-identical to their targets":
    "所有生成输出已经与目标文件字节一致。",
  "Configuration file does not exist": "配置文件不存在。",
  "Configuration file is not valid UTF-8": "配置文件不是有效的 UTF-8。",
  "File changed while it was being read": "文件在读取过程中发生变化。",
  "MCP configuration appears to contain a literal secret; prefer an environment reference":
    "MCP 配置似乎包含明文密钥；建议改用环境变量引用。",
  "MCP configuration contains non-deployable secret values": "MCP 配置包含不可部署的密钥值。",
  "Review the diagnostic": "查看此诊断。",
  "Skill reference could not be resolved": "Skill 引用无法解析。",
  "The .cursorrules format is deprecated": ".cursorrules 格式已弃用。",
  "The configuration file could not be parsed": "配置文件无法解析。",
  "The configuration file could not be read safely": "无法安全读取配置文件。",
  "The operation was cancelled": "操作已取消。",
};

const ZH_DIAGNOSTIC_ACTIONS: Readonly<Record<string, string>> = {
  "Check file permissions and retry the scan": "检查文件权限后重新扫描。",
  "Choose a path inside a registered configuration root": "选择已注册配置根目录内的路径。",
  "Create the referenced file or remove the reference": "创建被引用的文件，或移除此引用。",
  "Enable the asset before creating a migration preview": "创建迁移预览前先启用该资产。",
  "Fix the file": "修复此文件。",
  "Refresh the configuration index and try again": "刷新配置索引后重试。",
  "Refresh the deployment preview and try again": "刷新部署预览后重试。",
  "Refresh the local index and retry": "刷新本地索引后重试。",
  "Review deployment history before retrying": "重试前查看部署历史。",
  "Review rollback diagnostics before retrying": "重试前查看回滚诊断。",
  "Review the configuration and scan again": "查看配置后重新扫描。",
  "Review the diagnostic": "查看此诊断。",
  "Review the generated output before deployment": "部署前查看生成的输出。",
  "Review the generated plan before deployment": "部署前查看生成的计划。",
  "Review the preview": "查看预览。",
  "Review the source configuration and scan again": "查看源配置后重新扫描。",
  "Retry the scan after the file becomes stable": "等待文件稳定后重新扫描。",
  "Save the configuration file as UTF-8 and scan again": "将配置文件保存为 UTF-8 后重新扫描。",
  "Start the operation again when ready": "准备好后重新开始此操作。",
};

function diagnosticCodeLabel(locale: DesktopLocale, code: string): string {
  if (locale !== "zh-CN") return sentenceCaseIdentifier(code);
  return ZH_DIAGNOSTIC_CODE_LABELS[code] ?? `诊断 ${code}`;
}

function diagnosticText(locale: DesktopLocale, text: string): string {
  if (locale !== "zh-CN") return text;
  return (
    ZH_DIAGNOSTIC_MESSAGES[text] ??
    ZH_DIAGNOSTIC_ACTIONS[text] ??
    localizeDiagnosticPattern(text) ??
    text
  );
}

function localizeDiagnosticPattern(text: string): string | undefined {
  const outsideRoot = /^Resource (.+) is outside detected (.+) configuration roots$/.exec(text);
  if (outsideRoot !== null) {
    return `资源 ${outsideRoot[1] ?? ""} 位于已检测到的 ${outsideRoot[2] ?? ""} 配置根目录之外。`;
  }

  const duplicateLocator = /^Multiple (.+) resources use locator (.+)$/.exec(text);
  if (duplicateLocator !== null) {
    return `多个 ${duplicateLocator[1] ?? ""} 资源使用同一个定位符 ${duplicateLocator[2] ?? ""}。`;
  }

  const unresolvedSkill = /^Skill reference could not be resolved from (.+)$/.exec(text);
  if (unresolvedSkill !== null) {
    return `无法从 ${unresolvedSkill[1] ?? ""} 解析 Skill 引用。`;
  }

  const emptyInstructions = /^(.+) resource has empty instructions after trimming whitespace$/.exec(
    text,
  );
  if (emptyInstructions !== null) {
    return `${diagnosticResourceTypeLabel(emptyInstructions[1] ?? "")} 资源去除空白后指令为空。`;
  }

  const ignored = /^Resource (.+) is ignored by the effective configuration resolution$/.exec(text);
  if (ignored !== null) {
    return `资源 ${ignored[1] ?? ""} 被有效配置解析忽略。`;
  }

  const deleteNotApplied = /^Deployment expected (.+) to be deleted$/.exec(text);
  if (deleteNotApplied !== null) {
    return `部署预期删除 ${deleteNotApplied[1] ?? ""}，但删除未生效。`;
  }

  const disabledAsset = /^Asset is disabled and cannot be used as a migration source: (.+)$/.exec(
    text,
  );
  if (disabledAsset !== null) {
    return `资产已禁用，不能作为迁移来源：${disabledAsset[1] ?? ""}`;
  }

  const deploymentFailed = /^Deployment did not succeed: (.+)$/.exec(text);
  if (deploymentFailed !== null) {
    return `部署未成功：${deploymentFailed[1] ?? ""}`;
  }

  const rollbackFailed = /^Rollback did not succeed: (.+)$/.exec(text);
  if (rollbackFailed !== null) {
    return `回滚未成功：${rollbackFailed[1] ?? ""}`;
  }

  return undefined;
}

function diagnosticResourceTypeLabel(resourceType: string): string {
  return properNounIdentifierWord(resourceType) ?? resourceType;
}

function diagnosticScopeFor(locale: DesktopLocale, detail: AppState["assetDetail"]) {
  if (detail === undefined) {
    return {
      cardsLabel: t(locale, "Workspace diagnostic summary"),
      diagnosticsLabel: t(locale, "Workspace diagnostics"),
      warningsLabel: t(locale, "Workspace warnings"),
      infoLabel: t(locale, "Workspace info"),
      panelLabel: t(locale, "Workspace diagnostics"),
      panelHeading: t(locale, "Workspace diagnostics"),
      summary: t(locale, "Counts reflect every indexed asset in this project."),
    };
  }

  return {
    cardsLabel: t(locale, "Diagnostic summary for {asset}", { asset: detail.asset.logicalKey }),
    diagnosticsLabel: t(locale, "Selected asset diagnostics"),
    warningsLabel: t(locale, "Selected asset warnings"),
    infoLabel: t(locale, "Selected asset info"),
    panelLabel: t(locale, "Diagnostics for {asset}", { asset: detail.asset.logicalKey }),
    panelHeading: t(locale, "Diagnostics for {asset}", { asset: detail.asset.logicalKey }),
    summary: t(locale, "Counts reflect only the inspected asset."),
  };
}

function LocateDiagnosticButton(props: {
  readonly assetId: AppState["assets"][number]["id"];
  readonly locale: DesktopLocale;
  readonly onLocate: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  return (
    <button
      className="diagnostic-action"
      type="button"
      onClick={() => props.onLocate(props.assetId)}
    >
      {t(props.locale, "Locate")}
    </button>
  );
}

function WorkspaceDiagnosticFilters(props: {
  readonly activeSeverity: DiagnosticSeverityFilter;
  readonly activeCode: string;
  readonly codeOptions: readonly string[];
  readonly diagnostics: AppState["diagnostics"];
  readonly locale: DesktopLocale;
  readonly onSeverityChange: (severity: DiagnosticSeverityFilter) => void;
  readonly onCodeChange: (code: string) => void;
}) {
  const counts = diagnosticCountsFor(props.diagnostics);
  return (
    <div className="diagnostic-filter-bar diagnostic-filter-surface">
      <div
        className="diagnostic-severity-filter"
        aria-label={t(props.locale, "Diagnostic severity filters")}
      >
        {DIAGNOSTIC_SEVERITY_FILTERS.map((severity) => (
          <button
            aria-pressed={props.activeSeverity === severity}
            key={severity}
            type="button"
            onClick={() => props.onSeverityChange(severity)}
          >
            {diagnosticSeverityFilterLabel(props.locale, severity, counts)}
          </button>
        ))}
      </div>
      <label className="diagnostic-code-filter">
        <span>{t(props.locale, "Diagnostic code")}</span>
        <select
          aria-label={t(props.locale, "Diagnostic code filter")}
          value={props.activeCode}
          onChange={(event) => props.onCodeChange(event.currentTarget.value)}
        >
          <option value={ALL_DIAGNOSTIC_CODES}>{t(props.locale, "All diagnostic codes")}</option>
          {props.codeOptions.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function formatDiagnosticResultSummary(
  locale: DesktopLocale,
  visibleCount: number,
  totalCount: number,
): string {
  return t(locale, "{visible} shown of {total}", {
    visible: String(visibleCount),
    total: String(totalCount),
  });
}

function diagnosticsForSeverity(
  diagnostics: AppState["diagnostics"],
  severity: DiagnosticSeverityFilter,
): AppState["diagnostics"] {
  return severity === "all"
    ? diagnostics
    : diagnostics.filter((diagnostic) => diagnostic.severity === severity);
}

function diagnosticsForCode(
  diagnostics: AppState["diagnostics"],
  code: string,
): AppState["diagnostics"] {
  return code === ALL_DIAGNOSTIC_CODES
    ? diagnostics
    : diagnostics.filter((diagnostic) => diagnostic.code === code);
}

function diagnosticCodesFor(diagnostics: AppState["diagnostics"]): readonly string[] {
  return [...new Set(diagnostics.map((diagnostic) => diagnostic.code))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function diagnosticCountsFor(diagnostics: AppState["diagnostics"]): AppState["diagnosticCounts"] {
  const counts = { info: 0, warning: 0, error: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  return counts;
}

function diagnosticSeverityFilterLabel(
  locale: DesktopLocale,
  severity: DiagnosticSeverityFilter,
  counts: AppState["diagnosticCounts"],
): string {
  switch (severity) {
    case "all":
      return t(locale, "All diagnostics");
    case "error":
      return t(locale, "Errors {count}", { count: String(counts.error) });
    case "warning":
      return t(locale, "Warnings {count}", { count: String(counts.warning) });
    case "info":
      return t(locale, "Info {count}", { count: String(counts.info) });
  }
}

function DiagnosticList(props: {
  readonly diagnostics: AppState["diagnostics"];
  readonly locale: DesktopLocale;
  readonly onLocateDiagnostic?: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  return (
    <ul className="diagnostic-list">
      {props.diagnostics.map((diagnostic) => (
        <li key={diagnostic.id} className={`diagnostic-row ${diagnostic.severity}`}>
          <div className="diagnostic-row-main">
            <div className="diagnostic-row-title">
              <span className={`diagnostic-severity-pill ${diagnostic.severity}`}>
                {severityLabel(props.locale, diagnostic.severity)}
              </span>
              <strong>{diagnosticCodeLabel(props.locale, diagnostic.code)}</strong>
            </div>
            <span>{diagnosticText(props.locale, diagnostic.message)}</span>
            {diagnostic.location === undefined ? null : (
              <small>
                {diagnostic.location.pathDisplay}
                {diagnostic.location.line === undefined ? "" : `:${diagnostic.location.line}`}
                {diagnostic.location.column === undefined ? "" : `:${diagnostic.location.column}`}
              </small>
            )}
            <small>{diagnosticText(props.locale, diagnostic.suggestedAction)}</small>
          </div>
          <div className="diagnostic-row-action">
            {diagnostic.assetId === undefined || props.onLocateDiagnostic === undefined ? null : (
              <LocateDiagnosticButton
                assetId={diagnostic.assetId}
                locale={props.locale}
                onLocate={props.onLocateDiagnostic}
              />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function AssetStatusBadge(props: { readonly locale: DesktopLocale; readonly status: AssetStatus }) {
  return (
    <span className={`asset-status ${props.status}`}>
      {assetStatusLabel(props.locale, props.status)}
    </span>
  );
}

function selectedDefaultDisablementMethod(
  options: NonNullable<AppState["assetDetail"]>["asset"]["disablementOptions"],
): AssetDisablementMethod | undefined {
  return options.find((option) => option.recommended)?.method ?? options[0]?.method;
}

function AssetDetailDialog(props: {
  readonly detail: NonNullable<AppState["assetDetail"]>;
  readonly summary: AssetSummary | undefined;
  readonly diagnostics: AppState["diagnostics"];
  readonly locale: DesktopLocale;
  readonly message: string | undefined;
  readonly onOpenSource: () => void;
  readonly onToggleAssetStatus: (
    assetId: AppState["assets"][number]["id"],
    nextStatus: AssetStatus,
    disablementMethod?: AssetDisablementMethod,
  ) => void;
  readonly onCloseInspect: () => void;
  readonly onLocateDiagnostic: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  const detail = props.detail;
  const status = assetStatusFor(detail.asset);
  const loadStateSource = { ...props.summary, status };
  const sourceSummary: AssetSourceSummary | undefined = detail.source.sourceSummary;
  const disablementOptions = detail.asset.disablementOptions ?? [];
  const defaultDisablementMethod = selectedDefaultDisablementMethod(disablementOptions);
  const [selectedDisablementMethod, setSelectedDisablementMethod] =
    useState(defaultDisablementMethod);
  const showsDisablementOptions = status === "enabled" && disablementOptions.length > 0;

  useEffect(() => {
    setSelectedDisablementMethod(defaultDisablementMethod);
  }, [defaultDisablementMethod, detail.asset.id]);

  return (
    <div className="asset-detail-modal">
      <section
        className="asset-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(props.locale, "Asset detail")}
      >
        <header className="asset-detail-header">
          <div>
            <span className="eyebrow">{t(props.locale, "Inspect asset")}</span>
            <h2>{detail.asset.logicalKey}</h2>
          </div>
          <button className="asset-detail-close" type="button" onClick={props.onCloseInspect}>
            {t(props.locale, "Close")}
          </button>
        </header>
        <div className="asset-detail-scroll">
          <div className="detail-actions">
            <button type="button" onClick={props.onOpenSource}>
              {t(props.locale, "Open source")}
            </button>
          </div>
          {props.message === undefined ? null : (
            <div className="asset-detail-message" role="status">
              {localizeUiMessage(props.locale, props.message)}
            </div>
          )}
          <dl>
            <dt>{t(props.locale, "Tool")}</dt>
            <dd>{toolLabel(detail.asset.toolKey)}</dd>
            <dt>{t(props.locale, "Resource")}</dt>
            <dd>{resourceTypeLabel(props.locale, detail.asset.resourceType)}</dd>
            <dt>{t(props.locale, "Status")}</dt>
            <dd>{assetStatusLabel(props.locale, status)}</dd>
            <dt>{t(props.locale, "Load result")}</dt>
            <dd>
              <AssetLoadBadge asset={loadStateSource} locale={props.locale} />
            </dd>
            <dt>{t(props.locale, "Scope")}</dt>
            <dd>{detail.asset.scopeId}</dd>
            <dt>{t(props.locale, "Source")}</dt>
            <dd>{detail.source.pathDisplay}</dd>
            <dt>{t(props.locale, "Observed")}</dt>
            <dd>{formatTimestamp(detail.source.observedAt)}</dd>
          </dl>
          {sourceSummary?.kind === "package" ? (
            <AssetSourceSummaryPanel summary={sourceSummary} locale={props.locale} />
          ) : null}
          {detail.source.files.length <= 1 ? null : detail.asset.resourceType === "skill" ? (
            <AssetSourceTree detail={detail} locale={props.locale} />
          ) : (
            <section
              className="asset-source-files"
              aria-label={t(props.locale, "Source package files")}
            >
              <h3>{t(props.locale, "Source package files")}</h3>
              <table>
                <thead>
                  <tr>
                    <th>{t(props.locale, "Role")}</th>
                    <th>{t(props.locale, "Path")}</th>
                    <th>{t(props.locale, "Media")}</th>
                    <th>{t(props.locale, "Hash")}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.source.files.map((sourceFile) => (
                    <tr key={`${sourceFile.role}:${sourceFile.relativePath}`}>
                      <td>{sourceFileRoleLabel(props.locale, sourceFile.role)}</td>
                      <td title={sourceFile.pathDisplay}>{sourceFile.relativePath}</td>
                      <td>
                        {sourceFile.mediaType} /{" "}
                        {sourceFileTextLabel(props.locale, sourceFile.isText)}
                      </td>
                      <td>{sourceFile.contentHash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {status === "disabled" ? (
            <section
              aria-label={t(props.locale, "Asset status action")}
              className="asset-status-control disabled"
            >
              <div>
                <h3>{t(props.locale, "Asset is disabled")}</h3>
                <p>
                  {t(
                    props.locale,
                    "Enable it to include it again in review, effective configuration, and migration.",
                  )}
                </p>
              </div>
              <button
                className="enable-asset-primary"
                type="button"
                onClick={() => props.onToggleAssetStatus(detail.asset.id, "enabled")}
              >
                {t(props.locale, "Enable asset")}
              </button>
            </section>
          ) : null}
          {showsDisablementOptions ? (
            <fieldset className="disable-methods">
              <legend>{t(props.locale, "Disable impact")}</legend>
              <p>{t(props.locale, "Choose how far this disable action should go.")}</p>
              <div className="disable-method-list">
                {disablementOptions.map((option) => {
                  const optionCopy = disablementOptionCopy(props.locale, option);
                  return (
                    <label key={option.method} className="disable-method-option">
                      <input
                        type="radio"
                        name={`disable-method-${detail.asset.id}`}
                        value={option.method}
                        checked={selectedDisablementMethod === option.method}
                        onChange={() => setSelectedDisablementMethod(option.method)}
                      />
                      <span className="disable-method-copy">
                        <strong>{optionCopy.label}</strong>
                        <span>{optionCopy.description}</span>
                      </span>
                      {option.recommended ? (
                        <span className="method-recommended">{t(props.locale, "Recommended")}</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
              <button
                className="disable-asset-primary"
                type="button"
                onClick={() =>
                  props.onToggleAssetStatus(detail.asset.id, "disabled", selectedDisablementMethod)
                }
              >
                {t(props.locale, "Disable asset")}
              </button>
            </fieldset>
          ) : null}
          <section className="asset-detail-diagnostics">
            <h3>{t(props.locale, "Diagnostics")}</h3>
            {props.diagnostics.length === 0 ? (
              <p>{t(props.locale, "No diagnostics for this asset.")}</p>
            ) : (
              <DiagnosticList
                diagnostics={props.diagnostics}
                locale={props.locale}
                onLocateDiagnostic={props.onLocateDiagnostic}
              />
            )}
          </section>
          {detail.asset.references === undefined || detail.asset.references.length === 0 ? null : (
            <>
              <h3>{t(props.locale, "References")}</h3>
              <ul>
                {detail.asset.references.map((reference) => (
                  <li key={reference}>{reference}</li>
                ))}
              </ul>
            </>
          )}
          {detail.asset.normalized === undefined ? null : (
            <>
              <h3>{t(props.locale, "Normalized")}</h3>
              <pre>{JSON.stringify(detail.asset.normalized, null, 2)}</pre>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function AssetSourceSummaryPanel(props: {
  readonly summary: Extract<AssetSourceSummary, { readonly kind: "package" }>;
  readonly locale: DesktopLocale;
}) {
  return (
    <section
      className="asset-source-summary"
      aria-label={t(props.locale, "Source package summary")}
    >
      <h3>{t(props.locale, "Source package summary")}</h3>
      <dl>
        <dt>{t(props.locale, "Package root")}</dt>
        <dd>{packageRootLabel(props.summary)}</dd>
        <dt>{t(props.locale, "Files")}</dt>
        <dd>{formatFileCount(props.locale, props.summary.fileCount)}</dd>
        <dt>{t(props.locale, "Folders")}</dt>
        <dd>{formatFolderCount(props.locale, props.summary.folderCount)}</dd>
        <dt>{t(props.locale, "Text files")}</dt>
        <dd>{formatTextFileCount(props.locale, props.summary.textCount)}</dd>
        <dt>{t(props.locale, "Binary files")}</dt>
        <dd>{formatBinaryFileCount(props.locale, props.summary.binaryCount)}</dd>
      </dl>
    </section>
  );
}

function AssetSourceTree(props: {
  readonly detail: NonNullable<AppState["assetDetail"]>;
  readonly locale: DesktopLocale;
}) {
  const entries = sourceTreeEntries(props.detail.source.files);
  const sourceSummary: AssetSourceSummary | undefined = props.detail.source.sourceSummary;
  const rootName =
    sourceSummary?.kind === "package"
      ? packageRootLabel(sourceSummary)
      : `${sourcePackageFolderName(props.detail)}/`;
  return (
    <details className="asset-source-tree">
      <summary>{t(props.locale, "Source package files")}</summary>
      <ul>
        <li>
          <span className="source-tree-name folder">{rootName}</span>
          <ul>
            {entries.map((entry) => (
              <li className={`source-tree-entry depth-${entry.depth}`} key={entry.key}>
                <span className={`source-tree-name ${entry.kind}`} title={entry.relativePath}>
                  {entry.label}
                </span>
                {entry.file === undefined ? null : (
                  <span className="source-tree-meta">
                    {sourceFileRoleLabel(props.locale, entry.file.role)}, {entry.file.mediaType} /{" "}
                    {sourceFileTextLabel(props.locale, entry.file.isText)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </li>
      </ul>
    </details>
  );
}

function sourceTreeEntries(files: NonNullable<AppState["assetDetail"]>["source"]["files"]) {
  const directories = new Set<string>();
  const entries: Array<{
    readonly key: string;
    readonly label: string;
    readonly relativePath: string;
    readonly depth: number;
    readonly kind: "folder" | "file";
    readonly file?: (typeof files)[number];
  }> = [];

  for (const file of files) {
    const parts = file.relativePath.split("/").filter((part) => part.length > 0);
    for (let index = 0; index < parts.length - 1; index += 1) {
      const directory = parts.slice(0, index + 1).join("/");
      if (!directories.has(directory)) {
        directories.add(directory);
        entries.push({
          key: `folder:${directory}`,
          label: `${parts[index] ?? directory}/`,
          relativePath: directory,
          depth: index,
          kind: "folder",
        });
      }
    }
    entries.push({
      key: `file:${file.relativePath}`,
      label: parts.at(-1) ?? file.relativePath,
      relativePath: file.relativePath,
      depth: Math.max(0, parts.length - 1),
      kind: "file",
      file,
    });
  }

  return entries;
}

function sourcePackageFolderName(detail: NonNullable<AppState["assetDetail"]>): string {
  const primaryPath =
    detail.source.files.find((file) => file.role === "primary")?.pathDisplay ??
    detail.source.pathDisplay;
  const segments = primaryPath
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  return segments.at(-2) ?? detail.asset.logicalKey;
}

function disablementOptionCopy(
  locale: DesktopLocale,
  option: NonNullable<AppState["assetDetail"]>["asset"]["disablementOptions"][number],
): { readonly label: string; readonly description: string } {
  switch (option.method) {
    case "native":
      return {
        label: t(locale, "Use the tool's native disable switch"),
        description: t(locale, "Keeps the asset in place and asks the AI tool to stop loading it."),
      };
    case "move_file":
      return {
        label: t(locale, "Also disables it in the AI tool"),
        description: t(
          locale,
          "Moves the source out of the active load path so the tool itself stops loading it.",
        ),
      };
    case "remove_config_entry":
      return {
        label: t(locale, "Remove it from the tool configuration"),
        description: t(
          locale,
          "Updates the tool configuration so this asset is no longer referenced.",
        ),
      };
    case "hub_ignore":
      return {
        label: t(locale, "Only hide it in AI Config Hub"),
        description: t(
          locale,
          "Leaves the tool configuration untouched; AI Config Hub will ignore it for review and migration.",
        ),
      };
  }
}

function sourceFileRoleLabel(locale: DesktopLocale, role: string): string {
  switch (role) {
    case "primary":
      return t(locale, "primary");
    case "metadata":
      return t(locale, "metadata");
    case "support":
      return t(locale, "support");
    default:
      return role;
  }
}

function sourceFileTextLabel(locale: DesktopLocale, isText: boolean): string {
  return isText ? t(locale, "text") : t(locale, "binary");
}
