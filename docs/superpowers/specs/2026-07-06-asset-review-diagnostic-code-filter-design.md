# Asset Review Diagnostic Code Filter Design

## Context

The desktop Asset Review view already shows workspace diagnostic counts and, when no asset detail dialog is open, a workspace diagnostic list. Users can understand the list by severity, but they also need to narrow the list to specific warning or error codes because one severity can contain several distinct problems.

## Scope

This change only affects the desktop Asset Review workspace diagnostic list. It does not change asset resource-type tabs, asset detail diagnostics, migration diagnostics, diagnostic export, or CLI output.

## Behavior

The workspace diagnostic list gains a compact filter bar above the list.

- Severity filter options are All, Errors, Warnings, and Info.
- Diagnostic code filter options are derived from the diagnostics currently in the selected severity range.
- Selecting a severity filters the visible diagnostics by `severity`.
- Selecting a diagnostic code filters the visible diagnostics by `code`.
- If the active code no longer exists after a severity change, the code filter resets to All codes.
- When no diagnostics match the active filters, the panel shows an empty state instead of a blank list.

The phrase "type" in this feature means diagnostic severity: warning, error, or info. The second-level type is the stable diagnostic code, such as `SCAN_READ_FAILED` or `MCP_LITERAL_SECRET_RISK`.

## UI

The filter bar should follow the existing Asset Review style:

- Use segmented button-style controls for severity because there are only a few mutually exclusive options.
- Use a select control for diagnostic code because the set can vary by workspace.
- Show localized labels for severity and empty states.
- Keep diagnostic code values literal and stable so users can match them with reports and logs.

The asset detail dialog keeps its current behavior and shows diagnostics for the inspected asset without workspace-level filtering.

## Data Flow

`AssetsView` receives diagnostics from `AppState`. Filtering is local to the renderer:

1. Build severity counts and code options from `props.state.diagnostics`.
2. Store active severity and active diagnostic code in component state.
3. Derive visible diagnostics with `useMemo`.
4. Pass the filtered diagnostics to `DiagnosticList`.

No new API request is required for the first implementation because the current workspace list already has the fields needed for filtering.

## Testing

Renderer tests should cover:

- Rendering the workspace diagnostic filter controls.
- Filtering by warning or error severity.
- Filtering by a specific diagnostic code.
- Resetting an incompatible code selection after severity changes.
- Showing a localized empty state when filters match no diagnostics.

## Out Of Scope

- Server-side diagnostic pagination or filtering.
- Persisting filter selections across app reloads.
- Applying workspace filters inside the asset detail dialog.
- Adding diagnostic category filters.
