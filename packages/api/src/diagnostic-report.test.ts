import { DiagnosticIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { createDiagnosticReport } from "./diagnostic-report.js";

describe("createDiagnosticReport", () => {
  it("shortens known and external paths and redacts secrets across exported fields", () => {
    const home = "/var/folders/test/home";
    const privateHome = "/private/var/folders/test/home";
    const source = `${privateHome}/sk-live-secret/project/AGENTS.md`;
    const project = `${privateHome}/sk-live-secret/project`;
    const appData = `${home}/Library/Application Support/AI Config Hub`;
    const backup = `${appData}/backups/deployments`;
    const external = "/private/tmp/outside/plain-secret/config.json";

    const report = createDiagnosticReport({
      format: "markdown",
      generatedAt: "2026-06-28T08:00:00.000Z",
      filters: {},
      homeDirectory: home,
      pathRoots: [
        { label: "<project>", path: project },
        { label: "<backup-root>", path: backup },
        { label: "<app-data>", path: appData },
      ],
      items: [
        {
          id: DiagnosticIdSchema.parse("diagnostic-1"),
          code: "MISSING_REFERENCE",
          severity: "warning",
          message: `Missing ${source} with TOKEN=top-secret-canary and Authorization: top-secret-canary`,
          suggestedAction: `Open ${backup}/snapshot.txt or ${external} apiKey=plain-secret`,
          blocking: false,
          location: { pathDisplay: source, line: 1 },
        },
      ],
    });

    expect(report.content).toContain("<project>/AGENTS.md");
    const item = report.items[0];
    if (item === undefined) throw new Error("Expected exported diagnostic item");
    expect(item.suggestedAction).toContain("<backup-root>/snapshot.txt");
    expect(item.suggestedAction).toContain("<external>/config.json#");
    expect(JSON.stringify(report.items)).not.toContain(privateHome);
    expect(JSON.stringify(report.items)).not.toContain(appData);
    expect(JSON.stringify(report.items)).not.toContain("/private/tmp/outside");
    expect(JSON.stringify(report.items)).not.toContain("sk-live-secret");
    expect(JSON.stringify(report.items)).not.toContain("top-secret-canary");
    expect(JSON.stringify(report.items)).not.toContain("plain-secret");
    expect(item.message).toContain("TOKEN=[REDACTED]");
    expect(item.message).toContain("Authorization: [REDACTED]");
    expect(item.suggestedAction).toContain("apiKey=[REDACTED]");
    expect(report.redactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pointer: "/items/0/message", reason: "path" }),
        expect.objectContaining({ pointer: "/items/0/message", reason: "secret" }),
        expect.objectContaining({ pointer: "/items/0/location/pathDisplay", reason: "path" }),
      ]),
    );
  });
});
