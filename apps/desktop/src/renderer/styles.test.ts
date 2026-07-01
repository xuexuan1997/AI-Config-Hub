import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("renderer styles", () => {
  it("keeps selected asset type tabs readable while hovered", () => {
    expect(styles).toMatch(
      /\.asset-type-tab\[aria-selected="true"\]:hover\s*{[^}]*background:\s*var\(--active-bg\);[^}]*color:\s*var\(--strong-text\);[^}]*}/s,
    );
    expect(styles).toMatch(
      /\.asset-type-tab\[aria-selected="true"\]:hover span\s*{[^}]*color:\s*var\(--strong-text\);[^}]*}/s,
    );
  });

  it("keeps the migration difference summary complete when source and target columns have content", () => {
    expect(styles).toMatch(
      /\.migration-comparison-body\s*{[^}]*grid-template-columns:\s*minmax\(220px,\s*1fr\)\s+minmax\(260px,\s*0\.85fr\)\s+minmax\(220px,\s*1fr\);[^}]*}/s,
    );
    expect(styles).toMatch(
      /\.migration-difference-summary\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[^}]*}/s,
    );
    expect(styles).toMatch(
      /\.migration-difference-summary\s+h2\s*{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*}/s,
    );
    expect(styles).not.toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+275px\s+minmax\(0,\s*1fr\)/,
    );
  });
});
