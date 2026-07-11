import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop renderer layout scrolling", () => {
  it("locks the document and app route while named work regions own scrolling", async () => {
    const [css, appShell, assetsView, migrationView] = await Promise.all([
      readFile(new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8"),
      readFile(
        new URL("../../apps/desktop/src/renderer/components/app-shell.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../apps/desktop/src/renderer/views/assets.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../apps/desktop/src/renderer/views/migration.tsx", import.meta.url),
        "utf8",
      ),
    ]);
    const fixedWindowCss = css.slice(css.lastIndexOf("/* Fixed-window workspace"));

    expect(css).toMatch(/html,\s*body,\s*#root\s*{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.app-shell\s*{[^}]*height:\s*100vh;/s);
    expect(fixedWindowCss).toMatch(/main\s*{[^}]*overflow:\s*hidden;/s);
    expect(fixedWindowCss).toMatch(/\.workspace\s*{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s);
    expect(fixedWindowCss).toMatch(
      /\.asset-type-panel,\s*\.review-detail-panel\s*{[^}]*overflow:\s*auto;/s,
    );
    expect(fixedWindowCss).toMatch(
      /\.migration-asset-list,\s*\.migration-difference-summary,\s*\.migration-preview-details\s*{[^}]*overflow:\s*auto;/s,
    );
    expect(fixedWindowCss).toMatch(
      /\.workspace\[data-route="settings"\]\s*>\s*\.settings-panel\s*{[^}]*overflow:\s*auto;/s,
    );
    expect(assetsView).toContain('className="review-stage"');
    expect(migrationView).toContain('className="migration-stage"');
    expect(appShell).toMatch(/mainRef\.current\?\.scrollTo/);
    expect(appShell).not.toMatch(/window\.scrollTo/);
  });

  it("keeps selected asset type tabs readable while hovered", async () => {
    const css = await readFile(
      new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(
      /\.asset-type-tab\[aria-selected="true"\]:hover\s*{[^}]*background:\s*var\(--active-bg\);[^}]*color:\s*var\(--strong-text\);[^}]*}/s,
    );
    expect(css).toMatch(
      /\.asset-type-tab\[aria-selected="true"\]:hover span\s*{[^}]*color:\s*var\(--strong-text\);[^}]*}/s,
    );
  });

  it("keeps component button hover colors scoped to their component styles", async () => {
    const css = await readFile(
      new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(/button:where\(:not\(:disabled\):hover\)\s*{/);
    expect(css).toMatch(
      /\.tool-filter-button:not\(:disabled\):hover\s*{[^}]*background:\s*var\(--secondary-button-bg\);[^}]*color:\s*var\(--secondary-button-text\);[^}]*}/s,
    );
    expect(css).toMatch(
      /\.tool-filter-button\[aria-pressed="true"\]:not\(:disabled\):hover\s*{[^}]*background:\s*var\(--active-bg\);[^}]*color:\s*var\(--strong-text\);[^}]*}/s,
    );
  });

  it("keeps the migration difference summary complete when source and target columns have content", async () => {
    const css = await readFile(
      new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(
      /\.migration-comparison-body\s*{[^}]*grid-template-columns:\s*minmax\(220px,\s*1fr\)\s+minmax\(260px,\s*0\.85fr\)\s+minmax\(220px,\s*1fr\);[^}]*}/s,
    );
    expect(css).toMatch(
      /\.migration-difference-summary\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[^}]*}/s,
    );
    expect(css).toMatch(
      /\.migration-difference-summary\s+h2\s*{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*}/s,
    );
    expect(css).not.toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+275px\s+minmax\(0,\s*1fr\)/,
    );
  });

  it("keeps compact control labels single-line and truncates long identifiers deliberately", async () => {
    const css = await readFile(
      new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url),
      "utf8",
    );
    const resilienceCss = css.slice(css.lastIndexOf("/* Single-line UI resilience"));
    const ellipsisRuleStart = resilienceCss.indexOf(
      ".asset-type-heading h2,\n.panel-title > strong",
    );
    const ellipsisRule = resilienceCss.slice(
      ellipsisRuleStart,
      resilienceCss.indexOf("}", ellipsisRuleStart) + 1,
    );

    expect(resilienceCss).toMatch(/button,\s*th,[^{]*{[^}]*white-space:\s*nowrap;/s);
    expect(ellipsisRule).toContain(".summary-card > span");
    expect(ellipsisRule).toContain(".preview-summary > strong");
    expect(ellipsisRule).toContain(".preview-summary > span");
    expect(ellipsisRule).toContain(".asset-detail-header h2");
    expect(ellipsisRule).toContain("overflow: hidden");
    expect(ellipsisRule).toContain("text-overflow: ellipsis");
    expect(ellipsisRule).toContain("white-space: nowrap");
    expect(resilienceCss).toMatch(
      /\.confirmation-item\s*{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/s,
    );
    expect(resilienceCss).toMatch(
      /\.confirmation-item\s+input\s*{[^}]*min-height:\s*15px;[^}]*min-width:\s*15px;/s,
    );
    expect(resilienceCss).toMatch(
      /\.asset-primary-content\s*{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/s,
    );
    expect(resilienceCss).toMatch(
      /\.scan-task-modal \.scan-task-detail\s*{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
    expect(css).toMatch(
      /\.confirmation-list\s+legend\s*{[^}]*clip-path:\s*inset\(50%\);[^}]*position:\s*absolute;[^}]*}/s,
    );
    expect(css).not.toMatch(/\.confirmation-list\s+legend\s*{[^}]*display:\s*none;[^}]*}/s);
  });

  it("does not rescan assets when only the migration target project changes", async () => {
    const source = await readFile(
      new URL("../../apps/desktop/src/renderer/app.tsx", import.meta.url),
      "utf8",
    );
    const targetSelectionStart = source.indexOf("async function selectMigrationTargetProject()");
    const nextFunctionStart = source.indexOf("async function loadSettings()", targetSelectionStart);
    const targetSelection = source.slice(targetSelectionStart, nextFunctionStart);

    expect(targetSelection).toContain('type: "migrationTargetProject"');
    expect(targetSelection).not.toContain('scanMigrationProject("target"');
  });
});
