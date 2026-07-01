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
});
