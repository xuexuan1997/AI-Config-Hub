# Asset Review Diagnostic Code Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add workspace diagnostic filters in Asset Review so users can narrow diagnostics by severity type and diagnostic code.

**Architecture:** Keep filtering local to the desktop renderer because `AssetsView` already receives diagnostic `severity` and `code` fields. Add focused helper functions and one small filter component inside `apps/desktop/src/renderer/views/assets.tsx`, then cover behavior through renderer static-markup tests.

**Tech Stack:** React 19, TypeScript, Vitest, React DOM server rendering, existing desktop CSS and i18n helpers.

---

### Task 1: Add Failing Renderer Tests

**Files:**
- Modify: `apps/desktop/src/renderer/views/assets.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests in the `AssetsView` describe block:

```ts
  it("renders workspace diagnostic filters by severity and diagnostic code", () => {
    const html = renderAssets({
      diagnostics: [
        diagnosticFixture("diagnostic-warning", "SCAN_READ_FAILED", "warning"),
        diagnosticFixture("diagnostic-error", "MCP_LITERAL_SECRET_RISK", "error"),
      ],
      diagnosticCounts: { info: 0, warning: 1, error: 1 },
    });

    expect(html).toContain('class="diagnostic-filter-bar"');
    expect(html).toContain('aria-label="Diagnostic severity filters"');
    expect(html).toContain(">All diagnostics</button>");
    expect(html).toContain(">Errors 1</button>");
    expect(html).toContain(">Warnings 1</button>");
    expect(html).toContain('aria-label="Diagnostic code filter"');
    expect(html).toContain('<option selected="" value="__all__">All diagnostic codes</option>');
    expect(html).toContain('<option value="MCP_LITERAL_SECRET_RISK">MCP_LITERAL_SECRET_RISK</option>');
    expect(html).toContain('<option value="SCAN_READ_FAILED">SCAN_READ_FAILED</option>');
  });

  it("filters workspace diagnostics by warning severity", () => {
    const html = renderAssets(
      {
        diagnostics: [
          diagnosticFixture("diagnostic-warning", "SCAN_READ_FAILED", "warning"),
          diagnosticFixture("diagnostic-error", "MCP_LITERAL_SECRET_RISK", "error"),
        ],
        diagnosticCounts: { info: 0, warning: 1, error: 1 },
      },
      { initialDiagnosticSeverity: "warning" },
    );

    expect(html).toContain("<strong>Warning: Scan read failed</strong>");
    expect(html).not.toContain("<strong>Error: Mcp literal secret risk</strong>");
  });

  it("filters workspace diagnostics by diagnostic code", () => {
    const html = renderAssets(
      {
        diagnostics: [
          diagnosticFixture("diagnostic-warning", "SCAN_READ_FAILED", "warning"),
          diagnosticFixture("diagnostic-error", "MCP_LITERAL_SECRET_RISK", "error"),
        ],
        diagnosticCounts: { info: 0, warning: 1, error: 1 },
      },
      { initialDiagnosticCode: "MCP_LITERAL_SECRET_RISK" },
    );

    expect(html).toContain("<strong>Error: Mcp literal secret risk</strong>");
    expect(html).not.toContain("<strong>Warning: Scan read failed</strong>");
  });

  it("resets a stale diagnostic code when the selected severity excludes it", () => {
    const html = renderAssets(
      {
        diagnostics: [
          diagnosticFixture("diagnostic-warning", "SCAN_READ_FAILED", "warning"),
          diagnosticFixture("diagnostic-error", "MCP_LITERAL_SECRET_RISK", "error"),
        ],
        diagnosticCounts: { info: 0, warning: 1, error: 1 },
      },
      { initialDiagnosticSeverity: "warning", initialDiagnosticCode: "MCP_LITERAL_SECRET_RISK" },
    );

    expect(html).toContain('<option selected="" value="__all__">All diagnostic codes</option>');
    expect(html).toContain("<strong>Warning: Scan read failed</strong>");
    expect(html).not.toContain("<strong>Error: Mcp literal secret risk</strong>");
  });

  it("shows a localized empty state when workspace diagnostic filters have no matches", () => {
    const html = renderAssets(
      {
        settings: {
          ...initialState.settings,
          values: { ...initialState.settings.values, language: "zh-CN" },
        },
        diagnostics: [diagnosticFixture("diagnostic-warning", "SCAN_READ_FAILED", "warning")],
        diagnosticCounts: { info: 0, warning: 1, error: 0 },
      },
      { initialDiagnosticSeverity: "error" },
    );

    expect(html).toContain("没有匹配当前筛选的诊断。");
    expect(html).not.toContain("扫描读取失败");
  });
```

Add helper support below `renderAssets`:

```ts
function renderAssets(
  statePatch: Partial<AppState>,
  propsPatch: Pick<
    Parameters<typeof AssetsView>[0],
    "initialDiagnosticSeverity" | "initialDiagnosticCode"
  > = {},
): string {
  return renderToStaticMarkup(
    createElement(AssetsView, {
      state: { ...initialState, ...statePatch },
      initialDiagnosticSeverity: propsPatch.initialDiagnosticSeverity,
      initialDiagnosticCode: propsPatch.initialDiagnosticCode,
      onRefresh: vi.fn(),
      onInspect: vi.fn(),
      onLoadEffective: vi.fn(),
      onOpenSource: vi.fn(),
      onToggleAssetStatus: vi.fn(),
      onRescanAfterEdit: vi.fn(),
      onCloseInspect: vi.fn(),
      onLocateDiagnostic: vi.fn(),
    }),
  );
}

function diagnosticFixture(
  id: string,
  code: string,
  severity: AppState["diagnostics"][number]["severity"],
): AppState["diagnostics"][number] {
  return {
    id: DiagnosticIdSchema.parse(id),
    code,
    severity,
    assetId: AssetIdSchema.parse("asset-1"),
    message:
      code === "SCAN_READ_FAILED"
        ? "The configuration file could not be read safely"
        : "MCP configuration appears to contain a literal secret; prefer an environment reference",
    suggestedAction:
      code === "SCAN_READ_FAILED"
        ? "Check file permissions and retry the scan"
        : "Review the source configuration and scan again",
    blocking: severity === "error",
  };
}
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```sh
eval "$(fnm env)" && fnm use 24 && pnpm --filter @ai-config-hub/desktop exec vitest run --root ../.. apps/desktop/src/renderer/views/assets.test.ts
```

Expected: FAIL because `AssetsView` props and diagnostic filter markup do not exist yet.

### Task 2: Implement Renderer Filtering

**Files:**
- Modify: `apps/desktop/src/renderer/views/assets.tsx`
- Modify: `apps/desktop/src/renderer/i18n.ts`
- Modify: `apps/desktop/src/renderer/styles.css`

- [ ] **Step 1: Add AssetsView test-only initial filter props**

Extend the `AssetsView` props object:

```ts
  readonly initialDiagnosticSeverity?: DiagnosticSeverityFilter;
  readonly initialDiagnosticCode?: string;
```

- [ ] **Step 2: Add state and derived filtering**

Inside `AssetsView`, add:

```ts
  const [selectedDiagnosticSeverity, setSelectedDiagnosticSeverity] =
    useState<DiagnosticSeverityFilter>(props.initialDiagnosticSeverity ?? "all");
  const [selectedDiagnosticCode, setSelectedDiagnosticCode] = useState(
    props.initialDiagnosticCode ?? ALL_DIAGNOSTIC_CODES,
  );
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
    if (selectedDiagnosticCode !== activeDiagnosticCode) {
      setSelectedDiagnosticCode(activeDiagnosticCode);
    }
  }, [activeDiagnosticCode, selectedDiagnosticCode]);
```

- [ ] **Step 3: Render filter bar above workspace diagnostics**

Replace the workspace diagnostic `DiagnosticList` call with:

```tsx
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
```

- [ ] **Step 4: Add helper types and component**

Add below the existing type aliases:

```ts
type DiagnosticSummary = AppState["diagnostics"][number];
type DiagnosticSeverityFilter = "all" | DiagnosticSummary["severity"];

const ALL_DIAGNOSTIC_CODES = "__all__";
const DIAGNOSTIC_SEVERITY_FILTERS: readonly DiagnosticSeverityFilter[] = [
  "all",
  "error",
  "warning",
  "info",
];
```

Add helper functions and `WorkspaceDiagnosticFilters` near `DiagnosticList`:

```tsx
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
    <div className="diagnostic-filter-bar">
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
```

Also add `diagnosticsForSeverity`, `diagnosticsForCode`, `diagnosticCodesFor`, `diagnosticCountsFor`, and `diagnosticSeverityFilterLabel` using straightforward array filters and existing `t`.

- [ ] **Step 5: Add i18n strings**

Add Simplified Chinese translations for:

```ts
  "All diagnostics": "全部诊断",
  "All diagnostic codes": "全部诊断码",
  "Diagnostic code": "诊断码",
  "Diagnostic code filter": "诊断码筛选",
  "Diagnostic severity filters": "诊断严重程度筛选",
  "Errors {count}": "错误 {count}",
  "Warnings {count}": "警告 {count}",
  "Info {count}": "信息 {count}",
  "No diagnostics match the current filters.": "没有匹配当前筛选的诊断。",
```

- [ ] **Step 6: Add CSS**

Add styles near `.diagnostic-list`:

```css
.diagnostic-filter-bar {
  align-items: end;
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
  margin: 0.75rem 0 1rem;
}

.diagnostic-severity-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.diagnostic-severity-filter button {
  background: var(--soft-panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  color: var(--text);
  padding: 0.45rem 0.7rem;
}

.diagnostic-severity-filter button[aria-pressed="true"] {
  background: var(--active-bg);
  border-color: var(--button-bg);
  color: var(--strong-text);
}

.diagnostic-code-filter {
  display: grid;
  gap: 0.25rem;
}

.diagnostic-code-filter span {
  color: var(--muted-text);
  font-size: 0.85rem;
}

.diagnostic-code-filter select {
  min-width: min(320px, 100%);
}
```

- [ ] **Step 7: Run tests to verify GREEN**

Run the same command as Task 1 Step 2.

Expected: PASS.

### Task 3: Verify and Capture Screenshot

**Files:**
- No direct code edits expected.

- [ ] **Step 1: Run targeted desktop renderer tests**

Run:

```sh
eval "$(fnm env)" && fnm use 24 && pnpm --filter @ai-config-hub/desktop exec vitest run --root ../.. apps/desktop/src/renderer/views/assets.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run desktop typecheck**

Run:

```sh
eval "$(fnm env)" && fnm use 24 && pnpm --filter @ai-config-hub/desktop typecheck
```

Expected: PASS.

- [ ] **Step 3: Start renderer dev server**

Run:

```sh
eval "$(fnm env)" && fnm use 24 && pnpm --filter @ai-config-hub/desktop dev -- --host 127.0.0.1
```

Expected: Vite serves a local URL.

- [ ] **Step 4: Capture screenshot**

Open the local URL in the in-app browser, navigate to Asset Review if needed, and save a screenshot showing the diagnostic filter controls.

- [ ] **Step 5: Summarize changed files and verification**

Report modified files, test commands, and the screenshot path.
