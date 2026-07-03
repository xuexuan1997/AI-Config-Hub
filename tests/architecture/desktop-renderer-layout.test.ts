import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop renderer layout scrolling", () => {
  it("keeps document scrolling disabled and scrolls the active app route instead", async () => {
    const [css, appShell] = await Promise.all([
      readFile(new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8"),
      readFile(
        new URL("../../apps/desktop/src/renderer/components/app-shell.tsx", import.meta.url),
        "utf8",
      ),
    ]);

    expect(css).toMatch(/html,\s*body,\s*#root\s*{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.app-shell\s*{[^}]*height:\s*100vh;/s);
    expect(css).toMatch(/main\s*{[^}]*overflow:\s*auto;/s);
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
