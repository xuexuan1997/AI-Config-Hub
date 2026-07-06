# Desktop Minimum Window Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the Electron desktop window has a locked minimum size and the full renderer uses bounded, fill-height layouts with local overflow handling.

**Architecture:** Keep the existing Electron and React structure. Export a small desktop minimum window size constant from the main window options module, verify `BrowserWindow` options use it, then strengthen renderer CSS so route workspaces own their own scroll regions instead of expanding the whole app.

**Tech Stack:** Electron, React, TypeScript, Vitest, CSS grid/flex layouts, Node 24 via `fnm`.

---

## File Structure

- Modify `apps/desktop/src/main/window-options.ts`
  - Responsibility: define secure `BrowserWindow` defaults, including named desktop minimum size constants.
- Create `apps/desktop/src/main/window-options.test.ts`
  - Responsibility: verify the Electron window size and security options stay locked.
- Modify `apps/desktop/src/renderer/styles.css`
  - Responsibility: apply root minimum canvas, fill-height route layout, panel scroll boundaries, text truncation, and table/code overflow containment.
- Modify `tests/architecture/desktop-renderer-layout.test.ts`
  - Responsibility: lock layout-critical CSS contracts with focused string tests.

## Task 1: Lock Electron Minimum Window Size

**Files:**
- Modify: `apps/desktop/src/main/window-options.ts`
- Create: `apps/desktop/src/main/window-options.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/window-options.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createSecureWindowOptions, DESKTOP_MINIMUM_WINDOW_SIZE } from "./window-options.js";

describe("secure desktop window options", () => {
  it("sets the Electron desktop minimum window size", () => {
    const options = createSecureWindowOptions("/tmp/preload.cjs");

    expect(DESKTOP_MINIMUM_WINDOW_SIZE).toEqual({ width: 1024, height: 700 });
    expect(options.minWidth).toBe(DESKTOP_MINIMUM_WINDOW_SIZE.width);
    expect(options.minHeight).toBe(DESKTOP_MINIMUM_WINDOW_SIZE.height);
    expect(options.width).toBeGreaterThanOrEqual(DESKTOP_MINIMUM_WINDOW_SIZE.width);
    expect(options.height).toBeGreaterThanOrEqual(DESKTOP_MINIMUM_WINDOW_SIZE.height);
  });

  it("keeps secure renderer process defaults enabled", () => {
    const options = createSecureWindowOptions("/tmp/preload.cjs");

    expect(options.show).toBe(false);
    expect(options.webPreferences).toMatchObject({
      preload: "/tmp/preload.cjs",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
fnm use 24
pnpm vitest run apps/desktop/src/main/window-options.test.ts
```

Expected: FAIL because `DESKTOP_MINIMUM_WINDOW_SIZE` is not exported from `window-options.ts`.

- [ ] **Step 3: Write the minimal implementation**

Update `apps/desktop/src/main/window-options.ts`:

```ts
import type { BrowserWindowConstructorOptions } from "electron";

export const DESKTOP_MINIMUM_WINDOW_SIZE = {
  width: 1024,
  height: 700,
} as const;

export function createSecureWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: DESKTOP_MINIMUM_WINDOW_SIZE.width,
    minHeight: DESKTOP_MINIMUM_WINDOW_SIZE.height,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
fnm use 24
pnpm vitest run apps/desktop/src/main/window-options.test.ts
```

Expected: PASS.

## Task 2: Add Renderer Layout Contract Tests

**Files:**
- Modify: `tests/architecture/desktop-renderer-layout.test.ts`

- [ ] **Step 1: Write failing layout contract tests**

Append these tests to `tests/architecture/desktop-renderer-layout.test.ts`:

```ts
  it("defines the desktop minimum canvas and fill-height workspace contracts", async () => {
    const css = await readFile(
      new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(/--desktop-min-width:\s*1024px;/);
    expect(css).toMatch(/--desktop-min-height:\s*700px;/);
    expect(css).toMatch(/\.app-shell\s*{[^}]*min-width:\s*var\(--desktop-min-width\);[^}]*min-height:\s*var\(--desktop-min-height\);[^}]*}/s);
    expect(css).toMatch(/main\s*{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;[^}]*}/s);
    expect(css).toMatch(/\.workspace\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;[^}]*}/s);
  });

  it("bounds desktop route panels with local scrolling", async () => {
    const css = await readFile(
      new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(/\.review-workspace\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;[^}]*}/s);
    expect(css).toMatch(/\.review-list-panel\s*{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;[^}]*}/s);
    expect(css).toMatch(/\.asset-type-panel\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;[^}]*}/s);
    expect(css).toMatch(/\.migration-comparison-body\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;[^}]*}/s);
    expect(css).toMatch(/\.migration-source-panel,\s*\.migration-target-panel\s*{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\);[^}]*}/s);
    expect(css).toMatch(/\.migration-asset-list\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;[^}]*}/s);
  });

  it("contains long desktop content with truncation and local table overflow", async () => {
    const css = await readFile(
      new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(/\.table-scroll\s*{[^}]*overflow:\s*auto;[^}]*}/s);
    expect(css).toMatch(/\.asset-primary-cell strong,\s*\.asset-option span,\s*\.target-change-heading strong\s*{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*}/s);
    expect(css).toMatch(/pre\s*{[^}]*max-height:\s*min\(360px,\s*45vh\);[^}]*overflow:\s*auto;[^}]*}/s);
    expect(css).toMatch(/\.asset-detail-dialog\s*{[^}]*min-width:\s*min\(720px,\s*calc\(100vw - 2rem\)\);[^}]*}/s);
  });
```

- [ ] **Step 2: Run the layout tests to verify they fail**

Run:

```bash
fnm use 24
pnpm vitest run tests/architecture/desktop-renderer-layout.test.ts
```

Expected: FAIL because the new CSS contracts do not exist yet.

## Task 3: Implement Renderer Layout and Overflow CSS

**Files:**
- Modify: `apps/desktop/src/renderer/styles.css`

- [ ] **Step 1: Add root desktop minimum variables**

Add to the `:root` block in `apps/desktop/src/renderer/styles.css`:

```css
  --desktop-min-height: 700px;
  --desktop-min-width: 1024px;
```

- [ ] **Step 2: Strengthen root and shell sizing**

Update the existing root and `.app-shell` rules so they include:

```css
html,
body,
#root {
  height: 100%;
  min-height: var(--desktop-min-height);
  min-width: var(--desktop-min-width);
  overflow: hidden;
}

.app-shell {
  background: var(--app-bg);
  color: var(--text);
  display: grid;
  grid-template-columns: 260px 1fr;
  height: 100vh;
  min-height: var(--desktop-min-height);
  min-width: var(--desktop-min-width);
  overflow: hidden;
}
```

Preserve later `.app-shell` column overrides.

- [ ] **Step 3: Make `main` and `.workspace` fill and contain route content**

Update the later `main` and `.workspace` rules:

```css
main {
  background: var(--app-bg);
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  padding: 0;
}

.workspace {
  display: grid;
  gap: 1rem;
  grid-auto-rows: min-content;
  max-width: none;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  padding: 1.1rem;
}

.workspace[data-route="assets"],
.workspace[data-route="migration"] {
  grid-template-rows: auto auto minmax(0, 1fr) auto;
}

.workspace[data-route="settings"] {
  align-content: start;
  overflow: auto;
}
```

- [ ] **Step 4: Bound asset review panels**

Add or update these rules:

```css
.review-workspace {
  min-height: 0;
  overflow: hidden;
}

.review-filters,
.review-detail-panel {
  min-height: 0;
  overflow: auto;
}

.review-list-panel {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
  overflow: hidden;
}

.asset-type-tabs {
  min-height: 0;
  overflow: hidden;
}

.asset-type-panel {
  min-height: 0;
  overflow: auto;
}
```

- [ ] **Step 5: Bound migration panels**

Add or update these rules:

```css
.migration-comparison-body {
  min-height: 0;
  overflow: hidden;
}

.migration-source-panel,
.migration-target-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.migration-difference-summary {
  max-height: 100%;
  overflow: auto;
}

.migration-asset-list {
  min-height: 0;
  overflow: auto;
}

.migration-preview-details {
  min-height: 0;
  overflow: auto;
}
```

- [ ] **Step 6: Contain long content, tables, and dialogs**

Add these rules:

```css
.table-scroll {
  min-width: 0;
  overflow: auto;
}

.asset-primary-cell strong,
.asset-option span,
.target-change-heading strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

pre {
  max-height: min(360px, 45vh);
  overflow: auto;
}

.asset-detail-dialog {
  min-width: min(720px, calc(100vw - 2rem));
}
```

- [ ] **Step 7: Run layout tests to verify CSS passes**

Run:

```bash
fnm use 24
pnpm vitest run tests/architecture/desktop-renderer-layout.test.ts
```

Expected: PASS.

## Task 4: Final Focused Verification

**Files:**
- No code changes.

- [ ] **Step 1: Run focused desktop window test**

Run:

```bash
fnm use 24
pnpm vitest run apps/desktop/src/main/window-options.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused renderer layout test**

Run:

```bash
fnm use 24
pnpm vitest run tests/architecture/desktop-renderer-layout.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run desktop renderer unit tests**

Run:

```bash
fnm use 24
pnpm --filter @ai-config-hub/desktop test -- --run
```

Expected: PASS.

- [ ] **Step 4: Review changed files**

Run:

```bash
git diff -- apps/desktop/src/main/window-options.ts apps/desktop/src/main/window-options.test.ts apps/desktop/src/renderer/styles.css tests/architecture/desktop-renderer-layout.test.ts
```

Expected: Diff only includes the minimum window constant/test and renderer layout CSS/test changes described in this plan.

## Self-Review

- Spec coverage: Electron minimum window size is covered in Task 1. Renderer fill-height baseline is covered in Tasks 2 and 3. Asset review, migration, settings, dialogs, truncation, and local scrolling are covered in Task 3. Verification is covered in Task 4.
- Placeholder scan: The plan contains no unresolved markers, vague instructions, or unnamed follow-up work.
- Type consistency: `DESKTOP_MINIMUM_WINDOW_SIZE`, `createSecureWindowOptions`, and CSS selectors match the current codebase naming.
