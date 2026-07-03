import { useEffect, useMemo, useState } from "react";

import { localeForState, t, type DesktopLocale } from "../i18n.js";
import type { AppState } from "../model.js";

export function AssetsView(props: {
  readonly state: AppState;
  readonly onRefresh?: () => void;
  readonly onInspect: (assetId: AppState["assets"][number]["id"]) => void;
  readonly onLoadEffective: () => void;
  readonly onOpenSource: () => void;
  readonly onToggleAssetStatus: (
    assetId: AppState["assets"][number]["id"],
    nextStatus: AssetStatus,
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
  const effective = props.state.effective;
  const diagnosticScope = diagnosticScopeFor(locale, detail);
  const assetLabels = new Map(props.state.assets.map((asset) => [asset.id, asset.logicalKey]));
  const [selectedToolKey, setSelectedToolKey] = useState(DEFAULT_TOOL_KEY);
  const toolOptions = useMemo(() => assetToolOptions(props.state.assets), [props.state.assets]);
  const visibleAssets = useMemo(
    () => props.state.assets.filter((asset) => asset.toolKey === selectedToolKey),
    [props.state.assets, selectedToolKey],
  );
  const assetGroups = useMemo(() => assetGroupsByResourceType(visibleAssets), [visibleAssets]);
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
          effective={effective}
          diagnostics={props.state.diagnostics}
          assetLabels={assetLabels}
          locale={locale}
          onOpenSource={props.onOpenSource}
          onToggleAssetStatus={props.onToggleAssetStatus}
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
            locale={locale}
            onLocateDiagnostic={props.onLocateDiagnostic}
          />
        </section>
      )}
    </>
  );
}

type AssetSummary = AppState["assets"][number];
type AssetStatus = "enabled" | "disabled";
type AssetLoadState = "loaded" | "covered" | "disabled";

const DEFAULT_TOOL_KEY = "claude-code";

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
            <th>{t(props.locale, "Source directory")}</th>
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
              <td className="asset-source-cell" title={sourceDirectoryLabel(props.locale, asset)}>
                {sourceDirectoryLabel(props.locale, asset)}
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

function assetStatusFor(asset: { readonly status?: string }): AssetStatus {
  return asset.status === "disabled" ? "disabled" : "enabled";
}

function assetStatusLabel(locale: DesktopLocale, status: AssetStatus): string {
  return status === "disabled" ? t(locale, "Disabled") : t(locale, "Enabled");
}

function nextAssetStatus(status: AssetStatus): AssetStatus {
  return status === "disabled" ? "enabled" : "disabled";
}

function assetStatusActionLabel(locale: DesktopLocale, status: AssetStatus): string {
  return status === "disabled" ? t(locale, "Enable asset") : t(locale, "Disable asset");
}

function assetLoadStateFor(asset: AssetSummary): AssetLoadState {
  if (assetStatusFor(asset) === "disabled") return "disabled";
  return asset.loadState ?? "loaded";
}

function sourceDirectoryLabel(locale: DesktopLocale, asset: AssetSummary): string {
  return asset.sourceDirectory ?? t(locale, "Unknown source");
}

function loadStateLabel(locale: DesktopLocale, asset: AssetSummary): string {
  const state = assetLoadStateFor(asset);
  if (state === "disabled") return t(locale, "No, disabled");
  if (state === "covered") {
    return asset.coveredByLogicalKey === undefined
      ? t(locale, "No, covered")
      : t(locale, "No, covered by {asset}", { asset: asset.coveredByLogicalKey });
  }
  return t(locale, "Yes");
}

function AssetLoadBadge(props: { readonly asset: AssetSummary; readonly locale: DesktopLocale }) {
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

function diagnosticLabel(
  locale: DesktopLocale,
  diagnostic: AppState["diagnostics"][number],
): string {
  return `${severityLabel(locale, diagnostic.severity)}: ${diagnosticCodeLabel(
    locale,
    diagnostic.code,
  )}`;
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
  if (locale === "zh-CN" && isResourceKeyword(resourceType)) {
    return resourceKeywordLabel(resourceType);
  }
  if (resourceType.toLowerCase() === "mcp") return "MCP";
  return t(locale, titleizeIdentifier(resourceType));
}

function isResourceKeyword(resourceType: string): boolean {
  return ["agent", "mcp", "rule", "skill"].includes(resourceType.toLowerCase());
}

function resourceKeywordLabel(resourceType: string): string {
  return resourceType.toLowerCase() === "mcp" ? "MCP" : resourceType;
}

function scopeKindLabel(locale: DesktopLocale, scopeKind: string): string {
  const label = titleizeIdentifier(scopeKind);
  if (locale === "zh-CN") return t(locale, "{scope} scope", { scope: t(locale, label) });
  return `${label} scope`;
}

function assetLabel(assetId: string, assetLabels: ReadonlyMap<string, string>): string {
  return assetLabels.get(assetId) ?? displayIdentifier(assetId);
}

function contributionLabel(locale: DesktopLocale, action: string, reasonCode: string): string {
  const reason = reasonLabel(locale, reasonCode);
  switch (action) {
    case "inherit":
      return t(locale, "Inherited from {reason}.", { reason });
    case "merge":
      return t(locale, "Merged because {reason}.", { reason });
    case "override":
      return t(locale, "Overrode lower-priority values because {reason}.", { reason });
    default:
      return t(locale, "{action} because {reason}.", {
        action: sentenceCaseIdentifier(action),
        reason,
      });
  }
}

function reasonLabel(locale: DesktopLocale, reasonCode: string): string {
  return t(locale, lowerFirst(sentenceCaseIdentifier(reasonCode)));
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

const ZH_DIAGNOSTIC_CODE_LABELS: Readonly<Record<string, string>> = {
  ADAPTER_DIAGNOSTIC: "适配器诊断",
  ADAPTER_PARSE_INVALID: "配置解析失败",
  ADAPTER_WRITE_CAPABILITY_UNAVAILABLE: "适配器写入能力不可用",
  CURSOR_LEGACY_RULE_FORMAT: "Cursor 旧版规则格式",
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
  UNRESOLVED_SKILL_REFERENCE: "技能引用未解析",
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
  "Skill reference could not be resolved": "技能引用无法解析。",
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
    return `无法从 ${unresolvedSkill[1] ?? ""} 解析技能引用。`;
  }

  const emptyInstructions = /^(.+) resource has empty instructions after trimming whitespace$/.exec(
    text,
  );
  if (emptyInstructions !== null) {
    return `${emptyInstructions[1] ?? ""} 资源去除空白后指令为空。`;
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

function DiagnosticList(props: {
  readonly diagnostics: AppState["diagnostics"];
  readonly locale: DesktopLocale;
  readonly onLocateDiagnostic?: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  return (
    <ul className="diagnostic-list">
      {props.diagnostics.map((diagnostic) => (
        <li key={diagnostic.id}>
          <strong>{diagnosticLabel(props.locale, diagnostic)}</strong>
          <span>{diagnosticText(props.locale, diagnostic.message)}</span>
          {diagnostic.location === undefined ? null : (
            <small>
              {diagnostic.location.pathDisplay}
              {diagnostic.location.line === undefined ? "" : `:${diagnostic.location.line}`}
              {diagnostic.location.column === undefined ? "" : `:${diagnostic.location.column}`}
            </small>
          )}
          <small>{diagnosticText(props.locale, diagnostic.suggestedAction)}</small>
          {diagnostic.assetId === undefined || props.onLocateDiagnostic === undefined ? null : (
            <LocateDiagnosticButton
              assetId={diagnostic.assetId}
              locale={props.locale}
              onLocate={props.onLocateDiagnostic}
            />
          )}
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

function AssetDetailDialog(props: {
  readonly detail: NonNullable<AppState["assetDetail"]>;
  readonly effective: AppState["effective"];
  readonly diagnostics: AppState["diagnostics"];
  readonly assetLabels: ReadonlyMap<string, string>;
  readonly locale: DesktopLocale;
  readonly onOpenSource: () => void;
  readonly onToggleAssetStatus: (
    assetId: AppState["assets"][number]["id"],
    nextStatus: AssetStatus,
  ) => void;
  readonly onLoadEffective: () => void;
  readonly onCloseInspect: () => void;
  readonly onLocateDiagnostic: (assetId: AppState["assets"][number]["id"]) => void;
}) {
  const detail = props.detail;
  const effective = props.effective;
  const status = assetStatusFor(detail.asset);
  const targetStatus = nextAssetStatus(status);
  const disablementOptions = detail.asset.disablementOptions ?? [];
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
            <button
              type="button"
              onClick={() => props.onToggleAssetStatus(detail.asset.id, targetStatus)}
            >
              {assetStatusActionLabel(props.locale, status)}
            </button>
            <button type="button" onClick={props.onLoadEffective}>
              {t(props.locale, "Load effective configuration")}
            </button>
          </div>
          <dl>
            <dt>{t(props.locale, "Tool")}</dt>
            <dd>{toolLabel(detail.asset.toolKey)}</dd>
            <dt>{t(props.locale, "Resource")}</dt>
            <dd>{resourceTypeLabel(props.locale, detail.asset.resourceType)}</dd>
            <dt>{t(props.locale, "Status")}</dt>
            <dd>{assetStatusLabel(props.locale, status)}</dd>
            <dt>{t(props.locale, "Scope")}</dt>
            <dd>{detail.asset.scopeId}</dd>
            <dt>{t(props.locale, "Source")}</dt>
            <dd>{detail.source.pathDisplay}</dd>
            <dt>{t(props.locale, "Observed")}</dt>
            <dd>{formatTimestamp(detail.source.observedAt)}</dd>
          </dl>
          {disablementOptions.length === 0 ? null : (
            <section className="disable-methods">
              <h3>{t(props.locale, "Disable methods")}</h3>
              <ul>
                {disablementOptions.map((option) => (
                  <li key={option.method}>
                    <strong>{option.label}</strong>
                    {option.recommended ? (
                      <span className="method-recommended">{t(props.locale, "Recommended")}</span>
                    ) : null}
                    <span>{option.description}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
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
          {effective === undefined ? null : (
            <>
              <h3>{t(props.locale, "Effective configuration")}</h3>
              <pre>{JSON.stringify(effective.effective, null, 2)}</pre>
              <h3>{t(props.locale, "Contributors")}</h3>
              {effective.contributors.length === 0 ? (
                <p>{t(props.locale, "No contributing assets.")}</p>
              ) : (
                <ul>
                  {effective.contributors.map((contributor) => (
                    <li
                      key={`${contributor.assetId}:${contributor.action}:${contributor.reasonCode}`}
                    >
                      <strong>{assetLabel(contributor.assetId, props.assetLabels)}</strong>{" "}
                      <span>
                        {contributionLabel(
                          props.locale,
                          contributor.action,
                          contributor.reasonCode,
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <h3>{t(props.locale, "Ignored assets")}</h3>
              {effective.ignored.length === 0 ? (
                <p>{t(props.locale, "No ignored assets.")}</p>
              ) : (
                <ul>
                  {effective.ignored.map((ignored) => (
                    <li key={`${ignored.assetId}:${ignored.reasonCode}`}>
                      <strong>{assetLabel(ignored.assetId, props.assetLabels)}</strong>{" "}
                      <span>
                        {t(props.locale, "Ignored because {reason}.", {
                          reason: reasonLabel(props.locale, ignored.reasonCode),
                        })}
                        {ignored.coveredByAssetId === undefined
                          ? null
                          : ` ${t(props.locale, "Covered by {asset}.", {
                              asset: assetLabel(ignored.coveredByAssetId, props.assetLabels),
                            })}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <h3>{t(props.locale, "Effective diagnostics")}</h3>
              {effective.diagnostics.length === 0 ? (
                <p>{t(props.locale, "No effective diagnostics.")}</p>
              ) : (
                <ul className="diagnostic-list">
                  {effective.diagnostics.map((diagnostic) => (
                    <li key={diagnostic.id}>
                      <strong>{diagnosticLabel(props.locale, diagnostic)}</strong>
                      <span>{diagnosticText(props.locale, diagnostic.message)}</span>
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
