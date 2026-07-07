import type { AppState, LanguageSetting } from "./model.js";

export type DesktopLocale = "en" | "zh-CN";

const ZH_CN: Partial<Record<string, string>> = {
  Assets: "资产",
  "Asset Migration": "资产迁移",
  "Asset Review": "资产审查",
  Agent: "代理",
  "All diagnostics": "全部诊断",
  "All diagnostic codes": "全部诊断码",
  "Asset detail": "资产详情",
  "Asset detail is unavailable.": "资产详情不可用。",
  "Asset resource types": "资产资源类型",
  "Completed deployments and rollback records will appear here.":
    "已完成的部署和回滚记录会显示在这里。",
  "Confirm that this writes verified config files.": "确认这会写入已验证的配置文件。",
  "Confirmations: {confirmations}": "确认项：{confirmations}",
  "Confirm required migration actions:": "确认必需的迁移动作：",
  "Confirm the fresh preview, then execute the write from this page.":
    "确认最新预览后，直接在此页面执行写入。",
  "Create a migration preview before migrating.": "请先创建迁移预览再迁移。",
  "Deploy only from a fresh preview plan hash with explicit confirmation.":
    "仅从新的预览计划哈希部署，并需要明确确认。",
  "Create a fresh migration preview; the current plan has expired.":
    "请创建新的迁移预览；当前计划已过期。",
  "Browse folder": "浏览文件夹",
  Choose: "选择",
  "Choose a source project before creating a migration preview.": "请先选择源项目再创建迁移预览。",
  "Choose a source project before scanning migration assets.": "请先选择源项目再扫描迁移资产。",
  "Choose project": "选择项目",
  "Choose source and target projects independently before writing.":
    "写入前独立选择源项目和目标项目。",
  Dark: "深色",
  English: "英语",
  "Choose the project folder to scan before reviewing assets.":
    "请先选择要扫描的项目文件夹，然后再查看资产。",
  Close: "关闭",
  "Configuration manager overview": "配置管理总览",
  "Configuration asset workbench": "配置资产工作台",
  "Counts reflect every indexed asset in this project.": "计数包含此项目中所有已索引资产。",
  "Counts reflect only the inspected asset.": "计数仅包含当前检查的资产。",
  "Deploy with confirmation": "确认后部署",
  Deployment: "部署",
  "Deployment status": "部署状态",
  Detail: "详情",
  Details: "详情",
  Diagnostics: "诊断",
  "Difference summary": "差异摘要",
  "Added to target": "新增到目标",
  "Overwritten in target": "覆盖目标",
  "Target-only kept": "目标独有保留",
  "Unchanged planned outputs": "未变化的计划输出",
  "Changed files": "变更文件",
  "Preview target files": "预览目标文件",
  "Preview target folder": "预览目标文件夹",
  "Create files": "创建文件",
  "Replace files": "替换文件",
  "Delete files": "删除文件",
  "Change files": "变更文件",
  "Will change": "将变更",
  "File details are truncated to {count}.": "文件详情已截断为 {count} 项。",
  "Hash rows are truncated to {count}.": "哈希行已截断为 {count} 项。",
  "Conflicts or warnings": "冲突或警告",
  Error: "错误",
  "Diagnostic summary for {asset}": "{asset} 的诊断摘要",
  "Diagnostic asset is unavailable.": "诊断资产不可用。",
  "Diagnostic code": "诊断码",
  "Diagnostic code filter": "诊断码筛选",
  "Diagnostic severity filters": "诊断严重程度筛选",
  "Diagnostics for {asset}": "{asset} 的诊断",
  "Enter a project path first.": "请先输入项目路径。",
  "Errors {count}": "错误 {count}",
  General: "常规",
  History: "历史",
  "History detail": "历史详情",
  Language: "语言",
  Light: "浅色",
  "Load effective configuration": "加载有效配置",
  "Load result": "加载结果",
  "Load settings": "加载设置",
  Loading: "正在加载",
  "Logical key": "逻辑键",
  "Manual path fallback": "手动路径备用",
  Migration: "迁移",
  "Migration preview": "迁移预览",
  "Migration settings": "迁移设置",
  "No assets indexed yet.": "尚未索引资产。",
  "No assets match the selected tool.": "没有匹配所选工具的资产。",
  "No differences for this asset type.": "此资产类型没有差异。",
  "No diagnostics": "正常",
  "No diagnostics for this asset.": "此资产没有诊断。",
  "No diagnostics match the current filters.": "没有匹配当前筛选的诊断。",
  "No contributing assets.": "无贡献资产。",
  "No deployment history yet.": "暂无部署历史。",
  "No effective diagnostics.": "无有效诊断。",
  "No succeeded deployment is available to roll back.": "没有可回滚的成功部署。",
  "No history records": "没有历史记录",
  "No ignored assets.": "无已忽略资产。",
  "No folder selected yet": "尚未选择文件夹",
  "Not loaded": "未加载",
  "Opens your system folder picker.": "打开系统文件夹选择器。",
  Overview: "总览",
  "Problems first": "问题优先",
  "Paste a folder path only if the picker is unavailable.": "仅在选择器不可用时粘贴文件夹路径。",
  "Project path": "项目路径",
  "Project setup": "项目设置",
  Project: "项目",
  "Queued {taskId}": "已加入队列 {taskId}",
  Ready: "就绪",
  "Recovery mode": "恢复模式",
  "Recovery lock active. Review history before retrying.": "恢复锁已激活。重试前请查看历史。",
  Reload: "重新加载",
  "Refresh assets": "刷新资产",
  "Refresh diagnostics": "刷新诊断",
  "Refresh history": "刷新历史",
  "Rescan after edit": "编辑后重新扫描",
  Resource: "资源",
  References: "引用",
  "Review filters": "审查筛选",
  "Review and migration are sibling workflows.": "审查和迁移是平级功能。",
  Rule: "规则",
  "{resource} assets": "{resource}资产",
  "{visible} shown of {total}": "显示 {visible} / {total}",
  "Restart required": "需要重启",
  "Revision {revision}": "修订版本 {revision}",
  Saving: "正在保存",
  Scan: "扫描",
  "Scan source": "扫描源项目",
  "Scan AI tool configuration, inspect normalized assets, preview conversions, deploy with confirmation, and roll back verified changes.":
    "扫描 AI 工具配置，检查标准化资产，预览转换，确认后部署，并回滚已验证的更改。",
  "Scan a project before creating a migration preview.": "请先扫描项目再创建迁移预览。",
  "Scan a source project before creating a migration preview.": "请先扫描源项目再创建迁移预览。",
  "Scan current project": "扫描当前项目",
  "Scan failure details": "扫描失败详情",
  "Scan progress": "扫描进度",
  "Scan status": "扫描状态",
  "Scans automatically after project selection.": "选择项目后自动扫描。",
  "Scanning assets": "正在扫描资产",
  Settings: "设置",
  "Selected project folder": "已选择的项目文件夹",
  "Select an asset to inspect its source, problems, and effective config.":
    "选择资产以查看来源、问题和有效配置。",
  "Select a project before creating a migration preview.": "请先选择项目再创建迁移预览。",
  "Select at least one source asset.": "请选择至少一个源资产。",
  "Select a project and scan at least one asset first.": "请先选择项目并至少扫描一个资产。",
  "Select source assets from one resource type.": "请选择同一种资源类型的源资产。",
  "Select project": "选择项目",
  "Select migration source project": "选择迁移源项目",
  "Select migration target project": "选择迁移目标项目",
  "Selected migration sources changed after the rescan; create a new preview.":
    "重新扫描后，已选择的迁移来源发生变化；请创建新的预览。",
  "Selected asset diagnostics": "已选资产诊断",
  "Selected asset info": "已选资产信息",
  "Selected asset warnings": "已选资产警告",
  Source: "来源",
  "Source assets": "源资产",
  "Source directory": "来源目录",
  "Source package summary": "来源包摘要",
  "Source package files": "来源包文件",
  "Source project": "源项目",
  "Source project path": "源项目路径",
  "Source scan": "源扫描",
  "Source scan status": "源扫描状态",
  "Open source": "打开来源",
  "Source file opened.": "来源文件已打开。",
  "Source package folder": "来源包文件夹",
  "Package root": "包根目录",
  Files: "文件",
  Folders: "文件夹",
  "Text files": "文本文件",
  "Binary files": "二进制文件",
  "Inspect asset": "检查资产",
  Inspect: "检查",
  "Inspect one current project without implying that it is a migration source.":
    "只审查一个当前项目，不暗示它会成为迁移来源。",
  "Inspect an asset before opening its source file.": "请先检查资产，再打开其来源文件。",
  "Inspect an asset with a selected project before rescanning after edit.":
    "请先在已选择项目中检查资产，再在编辑后重新扫描。",
  "Inspect an asset with a selected project before resolving effective configuration.":
    "请先在已选择项目中检查资产，再解析有效配置。",
  Enabled: "已启用",
  Disabled: "已禁用",
  "Enable asset": "启用资产",
  "Disable asset": "禁用资产",
  "Asset enabled.": "\u8d44\u4ea7\u5df2\u542f\u7528\u3002",
  "Asset disabled.": "\u8d44\u4ea7\u5df2\u7981\u7528\u3002",
  "Asset status action": "\u8d44\u4ea7\u72b6\u6001\u64cd\u4f5c",
  "Asset is disabled": "\u8d44\u4ea7\u5df2\u7981\u7528",
  "Enable it to include it again in review, effective configuration, and migration.":
    "\u542f\u7528\u540e\uff0c\u5b83\u4f1a\u91cd\u65b0\u53c2\u4e0e\u5ba1\u67e5\u3001\u6709\u6548\u914d\u7f6e\u548c\u8fc1\u79fb\u3002",
  "Cannot restore disabled asset because a file already exists at the original path":
    "\u65e0\u6cd5\u6062\u590d\u8be5\u8d44\u4ea7\uff1a\u539f\u8def\u5f84\u5df2\u6709\u6587\u4ef6\u3002",
  "Disable impact": "禁用影响",
  "Disable method": "禁用方式",
  "Disable methods": "禁用方式",
  "Choose how far this disable action should go.": "选择这次禁用会影响到哪里。",
  "Use the tool's native disable switch": "使用工具原生禁用开关",
  "Keeps the asset in place and asks the AI tool to stop loading it.":
    "保留资产位置，并让 AI 工具停止加载它。",
  "Also disables it in the AI tool": "也在 AI 工具中禁用",
  "Moves the source out of the active load path so the tool itself stops loading it.":
    "会把来源移出当前加载路径，因此该 AI 工具也不会再加载它。",
  "Remove it from the tool configuration": "从工具配置中移除",
  "Updates the tool configuration so this asset is no longer referenced.":
    "会更新工具配置，使它不再引用这个资产。",
  "Only hide it in AI Config Hub": "仅在 AI Config Hub 中隐藏",
  "Leaves the tool configuration untouched; AI Config Hub will ignore it for review and migration.":
    "不会修改工具配置；AI Config Hub 会在审查和迁移时忽略它。",
  Recommended: "推荐",
  Status: "状态",
  Scope: "范围",
  Observed: "观察时间",
  Skill: "技能",
  Tool: "工具",
  User: "用户",
  Global: "全局",
  "{scope} scope": "{scope}范围",
  Normalized: "标准化",
  "Effective configuration": "有效配置",
  Contributors: "贡献者",
  "Ignored assets": "已忽略资产",
  "Effective diagnostics": "有效诊断",
  Info: "信息",
  Locate: "定位",
  "Locate diagnostic": "定位诊断",
  Warning: "警告",
  "Inherited from {reason}.": "继承自{reason}。",
  "Merged because {reason}.": "由于{reason}而合并。",
  "Overrode lower-priority values because {reason}.": "由于{reason}而覆盖低优先级值。",
  "{action} because {reason}.": "由于{reason}而{action}。",
  "Ignored because {reason}.": "由于{reason}而忽略。",
  "Covered by {asset}.": "被 {asset} 覆盖。",
  "highest priority scope": "最高优先级范围",
  "target conflict": "目标冲突",
  "Enter a target project folder.": "请输入目标项目文件夹。",
  "Simplified Chinese": "简体中文",
  "Start scan": "开始扫描",
  "Start source scan": "开始扫描源项目",
  "Start target scan": "开始扫描目标项目",
  System: "跟随系统",
  "Target project folder": "目标项目文件夹",
  "Target project": "目标项目",
  "Target project path": "目标项目路径",
  "Target impact": "目标影响",
  "Target assets": "\u76ee\u6807\u8d44\u4ea7",
  "Target tool": "目标工具",
  "Target asset": "\u76ee\u6807\u8d44\u4ea7",
  "Asset type": "\u8d44\u4ea7\u7c7b\u578b",
  "Target directory": "\u76ee\u6807\u76ee\u5f55",
  "Content hash": "\u5185\u5bb9\u54c8\u5e0c",
  "Preview target file": "\u9884\u89c8\u76ee\u6807\u6587\u4ef6",
  "Choose a target project to see target assets.":
    "\u8bf7\u5148\u9009\u62e9\u76ee\u6807\u9879\u76ee\u4ee5\u67e5\u770b\u76ee\u6807\u8d44\u4ea7\u3002",
  "No target assets for this tool and type.":
    "\u6b64\u76ee\u6807\u5de5\u5177\u548c\u7c7b\u578b\u6ca1\u6709\u76ee\u6807\u8d44\u4ea7\u3002",
  "Will create": "\u5f85\u65b0\u589e",
  "Will overwrite": "\u5f85\u8986\u76d6",
  "Will delete": "\u5f85\u5220\u9664",
  unknown: "\u672a\u77e5",
  "Source asset": "\u6e90\u8d44\u4ea7",
  "Hash change": "\u54c8\u5e0c\u53d8\u5316",
  Theme: "主题",
  "Existing target files": "现有目标文件",
  "Execute deployment": "执行部署",
  "Execute migration": "执行迁移",
  "Execute rollback": "执行回滚",
  "I understand this writes verified config files.": "我确认这会写入已验证的配置文件。",
  "Refresh the scan and create a fresh migration preview before migrating.":
    "请刷新扫描并创建新的迁移预览后再迁移。",
  "Review history": "查看历史",
  Rollback: "回滚",
  "Rollback status": "回滚状态",
  "Preview cross-tool changes before anything writes to disk.": "在写入磁盘之前预览跨工具变更。",
  "Preview migration": "预览迁移",
  "Preview writes": "预览写入",
  "Preview writes to see target impact.": "预览写入后查看目标影响。",
  "Plan {plan}": "计划 {plan}",
  Plan: "计划",
  "Plan hash": "计划哈希",
  "Record ID": "记录 ID",
  "{kind} detail": "{kind}详情",
  "Plan hash: {hash}": "计划哈希：{hash}",
  "Compatibility: {compatibility}": "兼容性：{compatibility}",
  Compatibility: "兼容性",
  "Expires: {expires}": "过期时间：{expires}",
  Expires: "过期时间",
  "Overwrite existing target files.": "覆盖现有目标文件。",
  "Deploy a partial conversion with documented warnings.": "部署包含警告的部分转换。",
  "Delete target files listed in the preview.": "删除预览中列出的目标文件。",
  none: "无",
  Full: "完整",
  Partial: "部分",
  "Field loss": "字段丢失",
  "Field loss details": "字段丢失详情",
  Dropped: "已丢弃",
  Retained: "已保留",
  Transformed: "已转换",
  Warnings: "警告",
  "Source drift": "源漂移",
  "Source drift warnings": "源漂移警告",
  "Refresh the scan and create a fresh preview before migrating.":
    "请刷新扫描并创建新的预览后再迁移。",
  Asset: "资产",
  "Expected hash": "预期哈希",
  "Current hash": "当前哈希",
  "Generated file": "生成文件",
  "Copy source file": "复制源文件",
  "Symlink source file": "软链接源文件",
  "Hash snapshot": "哈希快照",
  "Migration hash snapshot": "迁移哈希快照",
  "Show diff and hashes": "显示差异和哈希",
  Kind: "类型",
  Item: "项目",
  Before: "之前",
  After: "之后",
  Target: "目标",
  Current: "当前",
  Changed: "已更改",
  Missing: "缺失",
  missing: "缺失",
  absent: "不存在",
  "Create file": "创建文件",
  "Replace file": "替换文件",
  "Delete file": "删除文件",
  "Status: {status}": "状态：{status}",
  "Created: {created}": "创建时间：{created}",
  "Finished: {finished}": "完成时间：{finished}",
  "Phase: {phase}": "阶段：{phase}",
  Cancellable: "可取消",
  Finalized: "已完成",
  Succeeded: "成功",
  "Partially succeeded": "部分成功",
  Cancelled: "已取消",
  Failed: "失败",
  "Rolled back": "已回滚",
  Changes: "变更",
  Queued: "已排队",
  Running: "运行中",
  Discovering: "正在发现",
  Reading: "正在读取",
  Parsing: "正在解析",
  Validating: "正在验证",
  Committing: "正在提交",
  Preflight: "预检",
  "Backing up": "正在备份",
  Writing: "正在写入",
  Verifying: "正在校验",
  Restoring: "正在恢复",
  "Rolling back": "正在回滚",
  Completed: "已完成",
  "Error code": "错误代码",
  "Failed items": "失败项",
  "Not retryable": "不可重试",
  Retry: "重试",
  Retryable: "可重试",
  "Replace existing files": "替换现有文件",
  "Deployment confirmations": "部署确认",
  "Migration confirmations": "迁移确认",
  "Migration run": "迁移执行",
  "Migration status": "迁移状态",
  "Recovery lock active. Resolve it before retrying.": "恢复锁已激活。请先解决后再重试。",
  "Resolve the active recovery lock before migrating.": "请先解决当前恢复锁再迁移。",
  "Resolve effective configuration": "解析有效配置",
  "Required confirmations": "必需确认",
  "Run migration": "执行迁移",
  "Stop on conflicts": "遇到冲突时停止",
  "Merge (not supported yet)": "合并（暂不支持）",
  "Use typed path": "使用输入路径",
  All: "全部",
  "Current project": "当前项目",
  "Navigation model": "导航关系",
  "Swap source and target": "交换源和目标",
  Workspaces: "工作区",
  "Workspace diagnostic summary": "工作区诊断摘要",
  "Workspace diagnostics": "工作区诊断",
  "Workspace info": "工作区信息",
  "Workspace warnings": "工作区警告",
  "Warnings {count}": "警告 {count}",
  "Info {count}": "信息 {count}",
  "Will load": "是否加载",
  "Tool filters": "工具筛选",
  "Unknown source": "未知来源",
  Yes: "是",
  "No, disabled": "否，已禁用",
  "No, covered": "否，已被覆盖",
  "No, covered by {asset}": "否，已被 {asset} 覆盖",
  "Scan cache": "扫描缓存",
  "Settings preferences": "设置偏好",
  "Cache and persisted data": "缓存和持久化数据",
  "Local data": "本地数据",
  "Clear local data": "清理本地数据",
  "Clear selected data": "清理所选数据",
  Clearing: "正在清理",
  "Cleared selected local data ({count} records).": "已清理所选本地数据（{count} 条记录）。",
  "Last cleared {count} records": "上次清理 {count} 条记录",
  "Clear local copies stored by AI Config Hub. Project configuration files are not deleted.":
    "清理 AI Config Hub 保存的本地副本，不会删除项目配置文件。",
  "Rebuildable asset index, diagnostics, and scan task records.":
    "可重新生成的资产索引、诊断和扫描任务记录。",
  "Deployment history": "部署历史",
  "Deployment records and local Git history snapshots when safe.":
    "在安全时清理部署记录和本地 Git 历史快照。",
  "Theme and language preferences stored in this app.": "保存在此应用中的主题和语言偏好。",
  "I understand this clears selected local data.": "我理解这会清理所选本地数据。",
  "Database migration backups, deployment backups, and disabled asset recovery files are retained.":
    "数据库迁移备份、部署备份和已禁用资产恢复文件会被保留。",
  "Select local data and confirm clearing before continuing.": "请选择本地数据并确认后再继续清理。",
  "{action} failed: {detail}": "{action}失败：{detail}",
  "{action} failed: the system file chooser is unavailable; check desktop file picker permissions and try again. ({detail})":
    "{action}失败：系统文件选择器不可用；请检查桌面文件选择权限后重试。（{detail}）",
};

export function localeForState(state: AppState): DesktopLocale {
  return localeForLanguageSetting(state.settings.values.language);
}

export function localeForLanguageSetting(
  language: LanguageSetting,
  preferredLanguages = systemPreferredLanguages(),
): DesktopLocale {
  if (language === "zh-CN") return "zh-CN";
  if (language === "en") return "en";
  return preferredLanguages.some((preferred) => preferred.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : "en";
}

export function t(
  locale: DesktopLocale,
  text: string,
  replacements: Record<string, string | number> = {},
): string {
  const template = locale === "zh-CN" ? (ZH_CN[text] ?? text) : text;
  return Object.entries(replacements).reduce(
    (current, [key, value]) => current.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export function formatLocalizedUiError(
  locale: DesktopLocale,
  error: unknown,
  action: string,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  const localizedAction = t(locale, action);
  const lowerDetail = detail.toLowerCase();
  if (lowerDetail.includes("filechooser") || lowerDetail.includes("file chooser")) {
    return t(
      locale,
      "{action} failed: the system file chooser is unavailable; check desktop file picker permissions and try again. ({detail})",
      { action: localizedAction, detail },
    );
  }
  return t(locale, "{action} failed: {detail}", {
    action: localizedAction,
    detail: localizeUiMessage(locale, detail),
  });
}

export function localizeUiMessage(locale: DesktopLocale, message: string): string {
  if (locale !== "zh-CN") return message;

  const exact = ZH_CN[message];
  if (exact !== undefined) return exact;

  const queued = /^Queued (.+)$/.exec(message);
  if (queued !== null) return `已加入队列 ${queued[1]}`;

  const completion =
    /^(Scan|Deployment|Rollback) (complete|partially complete|failed|cancelled|rolled back)(?:: (.*))?\.$/.exec(
      message,
    );
  if (completion !== null) {
    const taskKind = taskKindMessageLabel(locale, completion[1] ?? "");
    const status = completionStatusMessageLabel(completion[2] ?? "");
    const counts =
      completion[3] === undefined ? "" : `：${localizeCompletionCounts(completion[3])}`;
    return `${taskKind}${status}${counts}。`;
  }

  const snapshot = /^(scan|deployment|rollback) ([a-z_]+): restored from event snapshot\.$/.exec(
    message,
  );
  if (snapshot !== null) {
    const taskKind = taskKindMessageLabel(locale, snapshot[1] ?? "");
    const status = taskStatusMessageLabel(locale, snapshot[2] ?? "");
    return `${taskKind}${status}：已从事件快照恢复。`;
  }

  const progress =
    /^(scan|deployment|rollback) ([a-z_]+): (\d+\/(?:\d+|\?)) (files|operations|items)$/.exec(
      message,
    );
  if (progress !== null) {
    const taskKind = taskKindMessageLabel(locale, progress[1] ?? "");
    const phase = taskStatusMessageLabel(locale, progress[2] ?? "");
    const amount = progress[3] ?? "";
    const unit = progressUnitLabel(progress[4] ?? "");
    return `${taskKind}${phase}：${amount} ${unit}`;
  }

  const failed = /^(scan|deployment|rollback) failed: (.+)$/.exec(message);
  if (failed !== null) {
    const taskKind = taskKindMessageLabel(locale, failed[1] ?? "");
    return `${taskKind}失败：${failed[2]}`;
  }

  return message;
}

function localizeCompletionCounts(counts: string): string {
  return counts
    .split(", ")
    .map((count) => {
      const match = /^(\d+) (succeeded|failed|skipped)$/.exec(count);
      if (match === null) return count;
      const amount = match[1] ?? "0";
      switch (match[2]) {
        case "succeeded":
          return `${amount} 项成功`;
        case "failed":
          return `${amount} 项失败`;
        case "skipped":
          return `${amount} 项跳过`;
        default:
          return count;
      }
    })
    .join("，");
}

function taskKindMessageLabel(locale: DesktopLocale, taskKind: string): string {
  switch (taskKind.toLowerCase()) {
    case "scan":
      return t(locale, "Scan");
    case "deployment":
      return t(locale, "Deployment");
    case "rollback":
      return t(locale, "Rollback");
    default:
      return taskKind;
  }
}

function completionStatusMessageLabel(status: string): string {
  switch (status) {
    case "complete":
      return "已完成";
    case "partially complete":
      return "部分完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "rolled back":
      return "已回滚";
    default:
      return status;
  }
}

function taskStatusMessageLabel(locale: DesktopLocale, status: string): string {
  switch (status) {
    case "running":
      return "运行中";
    case "succeeded":
      return t(locale, "Succeeded");
    case "partially_succeeded":
      return t(locale, "Partially succeeded");
    case "cancelled":
      return t(locale, "Cancelled");
    case "failed":
      return t(locale, "Failed");
    case "rolled_back":
      return t(locale, "Rolled back");
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
    default:
      return status;
  }
}

function progressUnitLabel(unit: string): string {
  switch (unit) {
    case "files":
      return "个文件";
    case "operations":
      return "项操作";
    case "items":
      return "项";
    default:
      return unit;
  }
}

function systemPreferredLanguages(): readonly string[] {
  if (typeof window === "undefined") return [];
  const navigatorLanguages = globalThis.navigator?.languages;
  if (navigatorLanguages !== undefined && navigatorLanguages.length > 0) {
    return Array.from(navigatorLanguages);
  }
  const navigatorLanguage = globalThis.navigator?.language;
  return navigatorLanguage === undefined ? [] : [navigatorLanguage];
}
