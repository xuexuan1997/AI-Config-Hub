# Desktop UX Redesign Design

## Goal

AI Config Hub desktop should feel like a focused configuration-asset workbench instead of a linear migration wizard. The redesign separates asset review from asset migration, clarifies project scope per feature, and makes asset type switching fast through page-level tabs.

## Product Model

The desktop app has two independent asset workflows:

- Asset Review: inspect one current project. Users scan a selected current project and review each asset's source, status, problems, and effective configuration. This workflow is read-oriented and does not imply migration.
- Asset Migration: compare two independently selected projects. Users choose a source project and a target project, switch asset types in sync, review the differences, optionally swap source and target, preview writes, and execute migration.

The phrase "current project" applies only to Asset Review. Asset Migration must not inherit it or imply that review selection feeds migration.

## Navigation

The left navigation should expose Asset Review and Asset Migration as sibling destinations. They are not steps in a sequence.

The main navigation set should be:

- Overview
- Asset Review
- Asset Migration
- History
- Settings

Overview may summarize recent scans and migrations, but it should not force a workflow. Asset Review and Asset Migration own their own project selectors and state.

## Asset Review

Asset Review opens with a page title and a compact project selector for the current project. The header should include:

- Current project path.
- Select project action.
- Scan current project action.
- Last scan state when available.

Below the current project controls, asset type tabs split the list:

- Skills
- Rules
- MCP
- Prompts
- Settings

Changing tabs changes the list, filters, count, and detail context to that asset type. The UI must not mix unrelated asset types into one undifferentiated table.

The review workspace uses three regions:

- Type-specific filters on the left, such as status, problem presence, source root, and sort.
- Asset list in the center, scoped to the active asset type.
- Read-only asset detail on the right.

Asset detail shows source path, parse status, detected problems, effective configuration, and source actions such as opening the file or copying the logical key. It should not include migration calls to action.

## Asset Migration

Asset Migration has independent source and target project selectors. It must not show "current project" as a global inherited setting.

The project selector row contains:

- Source project card with its path and a low-emphasis choose/change action.
- A small, low-emphasis swap control between the project cards.
- Target project card with its path and a low-emphasis choose/change action.

The swap control exchanges source and target. It is an auxiliary operation, so it should be visible but quieter than migration execution and difference review.

Asset type tabs appear below the project selector and switch both sides together:

- Skills
- Rules
- MCP
- Prompts
- Settings

Each tab label should include a compact difference count when data is available.

The migration workspace uses three regions:

- Source project asset list on the left.
- Lightweight difference summary in the center.
- Target project asset list on the right.

The center difference summary must stay simple and scannable. It should show counts and selected policy for the active asset type, such as:

- Added to target.
- Overwritten in target.
- Target-only assets kept.
- Conflicts or incompatible items.

The difference summary should not be a dense dark code panel. Detailed write previews can open from a secondary action.

## Visual Hierarchy

The design should favor an operations-tool style: calm surfaces, compact tables, clear active states, and restrained accent color. Avoid large decorative headings or heavy panels that compete with the data.

Primary emphasis goes to:

- The active workflow.
- The selected project or source/target pair.
- The selected asset type tab.
- Actual asset differences or problems.
- Final actions such as scan, preview writes, and execute migration.

Secondary controls such as choose project and swap source/target should be present but visually quieter.

## Interaction States

Asset Review states:

- No current project selected.
- Project selected but not scanned.
- Scan running.
- Scan complete with asset counts.
- Asset type selected with empty results.
- Asset selected with detail.
- Asset selected with parse or diagnostic problems.

Asset Migration states:

- Source and target missing.
- Source selected, target missing.
- Target selected, source missing.
- Both selected but not scanned/compared.
- Comparison running.
- Active asset type with no differences.
- Active asset type with differences.
- Blocking conflicts before execution.
- Preview ready.
- Migration complete.

## Responsive Behavior

Desktop is the primary target. At narrow widths, left navigation can collapse above or into a compact rail, and the three-column workspaces should stack in task order:

- Asset Review: filters, list, detail.
- Asset Migration: source, difference summary, target.

Tabs must remain horizontal and scrollable rather than wrapping into a tall control block.

## Implementation Scope

The implementation should update the existing Electron renderer structure rather than introducing a separate prototype app. It should preserve existing command behavior where possible while changing layout, labels, and state ownership.

Expected renderer changes:

- Rename or restructure routes so Asset Review and Asset Migration are sibling workflows.
- Keep current project state scoped to Asset Review.
- Introduce independent source and target project state for Asset Migration.
- Replace mixed asset lists with asset-type tabbed views.
- Replace migration's linear review dependency with side-by-side source/target comparison.
- Use a lightweight difference summary and secondary write preview.

## Testing

Tests should cover:

- Asset Review current project controls do not appear as inherited state on Asset Migration.
- Asset type tabs filter review lists by type.
- Asset type tabs switch source and target migration lists together.
- Swapping source and target exchanges the selected projects and refreshes comparison state.
- Difference summary counts are derived from source/target comparison data.
- Existing scan, asset detail, preview, deployment, and history behavior remains reachable where still applicable.

## Out Of Scope

This design does not change the underlying asset detection, parsing, or migration algorithms. It also does not define release packaging, persistence schema changes beyond necessary UI state, or visual branding beyond the desktop workflow redesign.
