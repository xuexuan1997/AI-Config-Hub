import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStorageRepositories,
  initialMigration,
  migration,
  openDatabase,
} from "@ai-config-hub/storage";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("storage recovery boundary", () => {
  it("keeps the pre-upgrade database readable and rejects writes after migration failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-config-hub-recovery-"));
    directories.push(directory);
    const path = join(directory, "index.sqlite");
    const initial = await openDatabase({ path, appVersion: "0.1.0" });
    initial.database.close();

    const broken = migration(2, "broken_upgrade", "CREATE TABLE broken(id TEXT); INVALID SQL;");
    const recovery = await openDatabase({
      path,
      appVersion: "0.2.0",
      migrations: [initialMigration, broken],
    });
    expect(recovery).toMatchObject({ mode: "read_only_recovery", reason: "MIGRATION_FAILED" });
    expect(recovery.database.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    const repositories = createStorageRepositories(recovery);
    const current = await repositories.settings.getPublic();
    await expect(
      repositories.settings.updatePublic({
        expectedRevision: current.revision,
        settings: current.settings,
      }),
    ).rejects.toMatchObject({ code: "READ_ONLY_RECOVERY" });
    recovery.database.close();
  });
});
