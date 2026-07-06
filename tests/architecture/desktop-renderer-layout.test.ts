import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop renderer layout scrolling", () => {
  it("keeps document and main scrolling disabled so route panels own overflow", async () => {
    const [css, appShell] = await Promise.all([
      readFile(new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8"),
      readFile(
        new URL("../../apps/desktop/src/renderer/components/app-shell.tsx", import.meta.url),
        "utf8",
      ),
    ]);

    expect(css).toMatch(/html,\s*body,\s*#root\s*{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.app-shell\s*{[^}]*height:\s*100vh;/s);
    expect(css).toMatch(/main\s*{[^}]*overflow:\s*hidden;/s);
    expect(appShell).toMatch(/mainRef\.current\?\.scrollTo/);
    expect(appShell).not.toMatch(/window\.scrollTo/);
  });

  it("defines the desktop minimum canvas and fill-height workspace contracts", async () => {
    const css = await readFile(
      new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(/--desktop-min-width:\s*1024px;/);
    expect(css).toMatch(/--desktop-min-height:\s*700px;/);
    expect(css).toMatch(
      /\.app-shell\s*{[^}]*min-width:\s*var\(--desktop-min-width\);[^}]*min-height:\s*var\(--desktop-min-height\);[^}]*}/s,
    );
    expect(css).toMatch(
      /main\s*{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;[^}]*}/s,
    );
    expect(css).toMatch(
      /\.workspace\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;[^}]*}/s,
    );
  });

  it("bounds desktop route panels with local scrolling", async () => {
    const css = await readFile(
      new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(
      /\.review-workspace\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;[^}]*}/s,
    );
    expect(css).toMatch(
      /\.review-list-panel\s*{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;[^}]*}/s,
    );
    expect(css).toMatch(
      /\.asset-type-panel\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;[^}]*}/s,
    );
    expect(css).toMatch(
      /\.migration-comparison-body\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;[^}]*}/s,
    );
    expect(css).toMatch(
      /\.migration-source-panel,\s*\.migration-target-panel\s*{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\);[^}]*}/s,
    );
    expect(css).toMatch(
      /\.migration-asset-list\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;[^}]*}/s,
    );
  });

  it("contains long desktop content with truncation and local table overflow", async () => {
    const css = await readFile(
      new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(/\.table-scroll\s*{[^}]*overflow:\s*auto;[^}]*}/s);
    expect(css).toMatch(
      /\.asset-primary-cell strong,\s*\.asset-option span,\s*\.target-change-heading strong\s*{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*}/s,
    );
    expect(css).toMatch(/pre\s*{[^}]*max-height:\s*min\(360px,\s*45vh\);[^}]*overflow:\s*auto;[^}]*}/s);
    expect(css).toMatch(
      /\.asset-detail-dialog\s*{[^}]*min-width:\s*min\(720px,\s*calc\(100vw - 2rem\)\);[^}]*}/s,
    );
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
