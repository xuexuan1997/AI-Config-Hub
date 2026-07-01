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
});
