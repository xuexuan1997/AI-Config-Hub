import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AbsolutePathSchema, ContentHashSchema, type AbsolutePath } from "@ai-config-hub/shared";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  CommittedButDurabilityUncertainError,
  createNodeDeploymentFilePortForTest,
  MutationOutcomeUncertainError,
  NodeDeploymentFilePort,
  shouldIgnoreDirectorySyncError,
  type NodeDeploymentFilePortOptions,
} from "./file-port.js";
import { PathLockManager } from "./path-locks.js";

const temporaryDirectories: string[] = [];

function absolute(path: string): AbsolutePath {
  return AbsolutePathSchema.parse(path);
}

function hash(text: string) {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(text).digest("hex")}`);
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "ai-config-hub-deployer-"));
  temporaryDirectories.push(base);
  const allowedRoot = join(base, "allowed");
  const backupRoot = join(base, "backups");
  const outsideRoot = join(base, "outside");
  await Promise.all([mkdir(allowedRoot), mkdir(backupRoot), mkdir(outsideRoot)]);
  return {
    allowedRoot,
    backupRoot,
    outsideRoot,
    port: new NodeDeploymentFilePort({
      allowedRoots: [absolute(allowedRoot)],
      backupRoot: absolute(backupRoot),
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("NodeDeploymentFilePort confinement", () => {
  it("keeps the public options contract limited to roots", () => {
    expectTypeOf<NodeDeploymentFilePortOptions>().toEqualTypeOf<{
      readonly allowedRoots: readonly AbsolutePath[];
      readonly backupRoot: AbsolutePath;
    }>();
  });

  it("allows a child whose name starts with two dots", async () => {
    const { allowedRoot, port } = await fixture();
    const target = join(allowedRoot, "..config", "created.txt");

    await expect(
      port.atomicReplace({ target: absolute(target), text: "new", expectedHash: "absent" }),
    ).resolves.toEqual({ resultingHash: hash("new") });
    await expect(readFile(target, "utf8")).resolves.toBe("new");
  });

  it("rejects create outside an allowed root", async () => {
    const { outsideRoot, port } = await fixture();
    const target = join(outsideRoot, "created.txt");

    await expect(
      port.atomicReplace({ target: absolute(target), text: "new", expectedHash: "absent" }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects replace outside an allowed root without changing the file", async () => {
    const { outsideRoot, port } = await fixture();
    const target = join(outsideRoot, "existing.txt");
    await writeFile(target, "outside");

    await expect(
      port.atomicReplace({
        target: absolute(target),
        text: "changed",
        expectedHash: hash("outside"),
      }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(readFile(target, "utf8")).resolves.toBe("outside");
  });

  it("rejects delete outside an allowed root without removing the file", async () => {
    const { outsideRoot, port } = await fixture();
    const target = join(outsideRoot, "existing.txt");
    await writeFile(target, "outside");

    await expect(
      port.remove({ target: absolute(target), expectedHash: hash("outside") }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(readFile(target, "utf8")).resolves.toBe("outside");
    await expect(lstat(target)).resolves.toBeDefined();
  });

  it("rejects create through a symlink escaping an allowed root", async () => {
    const { allowedRoot, outsideRoot, port } = await fixture();
    const link = join(allowedRoot, "escape");
    const target = join(link, "created.txt");
    await symlink(outsideRoot, link);

    await expect(
      port.atomicReplace({ target: absolute(target), text: "new", expectedHash: "absent" }),
    ).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    await expect(lstat(join(outsideRoot, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects replace and delete through symlinks escaping an allowed root", async () => {
    const { allowedRoot, outsideRoot, port } = await fixture();
    const outsideFile = join(outsideRoot, "config.txt");
    const link = join(allowedRoot, "config.txt");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, link);

    await expect(
      port.atomicReplace({
        target: absolute(link),
        text: "changed",
        expectedHash: hash("outside"),
      }),
    ).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    await expect(
      port.remove({ target: absolute(link), expectedHash: hash("outside") }),
    ).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside");
    await expect(lstat(link)).resolves.toBeDefined();
  });

  it("rejects backup destinations outside the backup root", async () => {
    const { allowedRoot, outsideRoot, port } = await fixture();
    const source = join(allowedRoot, "source.txt");
    const destination = join(outsideRoot, "backup.txt");
    await writeFile(source, "source");

    await expect(
      port.createBackup({
        source: absolute(source),
        destination: absolute(destination),
        expectedHash: hash("source"),
      }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies a confined source to a confined target with hash drift checks", async () => {
    const { allowedRoot, port } = await fixture();
    const source = join(allowedRoot, "source.txt");
    const target = join(allowedRoot, "copied.txt");
    await writeFile(source, "source contents");

    await expect(
      port.copy({
        source: absolute(source),
        target: absolute(target),
        expectedSourceHash: hash("source contents"),
        expectedHash: "absent",
      }),
    ).resolves.toEqual({ resultingHash: hash("source contents") });
    await expect(readFile(target, "utf8")).resolves.toBe("source contents");

    await writeFile(source, "changed source");
    await expect(
      port.copy({
        source: absolute(source),
        target: absolute(target),
        expectedSourceHash: hash("source contents"),
        expectedHash: hash("source contents"),
      }),
    ).rejects.toMatchObject({ code: "STALE_TARGET" });
  });

  it("creates a confined symlink and rejects escaping link sources", async () => {
    const { allowedRoot, outsideRoot, port } = await fixture();
    const source = join(allowedRoot, "source.txt");
    const target = join(allowedRoot, "linked.txt");
    const outside = join(outsideRoot, "outside.txt");
    await writeFile(source, "linked contents");
    await writeFile(outside, "outside");

    await expect(
      port.createSymlink({
        source: absolute(source),
        target: absolute(target),
        expectedSourceHash: hash("linked contents"),
        expectedHash: "absent",
      }),
    ).resolves.toEqual({ resultingHash: hash("linked contents") });
    await expect(readFile(target, "utf8")).resolves.toBe("linked contents");

    await expect(
      port.createSymlink({
        source: absolute(outside),
        target: absolute(join(allowedRoot, "outside-link.txt")),
        expectedSourceHash: hash("outside"),
        expectedHash: "absent",
      }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
  });
});

describe("NodeDeploymentFilePort optimistic concurrency", () => {
  it("rejects stale replace without mutating the target", async () => {
    const { allowedRoot, port } = await fixture();
    const target = join(allowedRoot, "target.txt");
    await writeFile(target, "current");

    await expect(
      port.atomicReplace({ target: absolute(target), text: "new", expectedHash: hash("stale") }),
    ).rejects.toMatchObject({ code: "STALE_TARGET" });
    await expect(readFile(target, "utf8")).resolves.toBe("current");
  });

  it("rejects stale delete without mutating the target", async () => {
    const { allowedRoot, port } = await fixture();
    const target = join(allowedRoot, "target.txt");
    await writeFile(target, "current");

    await expect(
      port.remove({ target: absolute(target), expectedHash: hash("stale") }),
    ).rejects.toMatchObject({
      code: "STALE_TARGET",
    });
    await expect(readFile(target, "utf8")).resolves.toBe("current");
  });

  it("rejects stale backup without mutating an existing destination", async () => {
    const { allowedRoot, backupRoot, port } = await fixture();
    const source = join(allowedRoot, "source.txt");
    const destination = join(backupRoot, "backup.txt");
    await writeFile(source, "current");
    await writeFile(destination, "keep");

    await expect(
      port.createBackup({
        source: absolute(source),
        destination: absolute(destination),
        expectedHash: hash("stale"),
      }),
    ).rejects.toMatchObject({ code: "STALE_TARGET" });
    await expect(readFile(destination, "utf8")).resolves.toBe("keep");
  });

  it("rejects stale backup before creating a missing backup root", async () => {
    const base = await mkdtemp(join(tmpdir(), "ai-config-hub-deployer-stale-backup-"));
    temporaryDirectories.push(base);
    const allowedRoot = join(base, "allowed");
    const backupRoot = join(base, "missing", "backups");
    const source = join(allowedRoot, "source.txt");
    await mkdir(allowedRoot);
    await writeFile(source, "current");
    const port = new NodeDeploymentFilePort({
      allowedRoots: [absolute(allowedRoot)],
      backupRoot: absolute(backupRoot),
    });

    await expect(
      port.createBackup({
        source: absolute(source),
        destination: absolute(join(backupRoot, "backup.txt")),
        expectedHash: hash("stale"),
      }),
    ).rejects.toMatchObject({ code: "STALE_TARGET" });
    await expect(lstat(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("NodeDeploymentFilePort writes", () => {
  it.runIf(process.platform === "linux")(
    "keeps replacement confined when the lexical parent is swapped after opening",
    async () => {
      const { allowedRoot, outsideRoot, port } = await fixture();
      const parent = join(allowedRoot, "parent");
      const movedParent = join(allowedRoot, "original-parent");
      const target = join(parent, "target.txt");
      const marker = join(allowedRoot, "native-pause");
      await mkdir(parent);
      process.env["AICH_TEST_PAUSE_BEFORE_COMMIT"] = marker;
      try {
        const replacement = port.atomicReplace({
          target: absolute(target),
          text: "confined",
          expectedHash: "absent",
        });
        await waitForPath(marker);
        await rename(parent, movedParent);
        await symlink(outsideRoot, parent);
        await writeFile(`${marker}.continue`, "continue");

        await expect(replacement).resolves.toEqual({ resultingHash: hash("confined") });
        await expect(readFile(join(movedParent, "target.txt"), "utf8")).resolves.toBe("confined");
        await expect(lstat(join(outsideRoot, "target.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        delete process.env["AICH_TEST_PAUSE_BEFORE_COMMIT"];
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects when target identity changes after native hash verification",
    async () => {
      const { allowedRoot, port } = await fixture();
      const target = join(allowedRoot, "target.txt");
      const changed = join(allowedRoot, "changed.txt");
      const marker = join(allowedRoot, "native-identity-pause");
      await writeFile(target, "expected");
      process.env["AICH_TEST_PAUSE_BEFORE_COMMIT"] = marker;
      try {
        const replacement = port.atomicReplace({
          target: absolute(target),
          text: "replacement",
          expectedHash: hash("expected"),
        });
        await waitForPath(marker);
        await writeFile(changed, "external change");
        await rename(changed, target);
        await writeFile(`${marker}.continue`, "continue");

        await expect(replacement).rejects.toMatchObject({ code: "STALE_TARGET" });
        await expect(readFile(target, "utf8")).resolves.toBe("external change");
      } finally {
        delete process.env["AICH_TEST_PAUSE_BEFORE_COMMIT"];
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "fails closed when the native helper is missing",
    async () => {
      const { allowedRoot, port } = await fixture();
      const target = join(allowedRoot, "target.txt");
      const helper = process.env["AI_CONFIG_HUB_DEPLOYMENT_HELPER"];
      process.env["AI_CONFIG_HUB_DEPLOYMENT_HELPER"] = join(allowedRoot, "missing-helper");
      try {
        await expect(
          port.atomicReplace({ target: absolute(target), text: "unsafe", expectedHash: "absent" }),
        ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
        await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (helper === undefined) delete process.env["AI_CONFIG_HUB_DEPLOYMENT_HELPER"];
        else process.env["AI_CONFIG_HUB_DEPLOYMENT_HELPER"] = helper;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "reports an uncertain outcome when the native helper is killed",
    async () => {
      const { allowedRoot, port } = await fixture();
      const target = join(allowedRoot, "target.txt");
      const fakeHelper = join(allowedRoot, "killed-helper");
      const helper = process.env["AI_CONFIG_HUB_DEPLOYMENT_HELPER"];
      await writeFile(fakeHelper, "#!/bin/sh\nkill -KILL $$\n");
      await chmod(fakeHelper, 0o700);
      process.env["AI_CONFIG_HUB_DEPLOYMENT_HELPER"] = fakeHelper;
      try {
        await expect(
          port.atomicReplace({ target: absolute(target), text: "unknown", expectedHash: "absent" }),
        ).rejects.toBeInstanceOf(MutationOutcomeUncertainError);
      } finally {
        if (helper === undefined) delete process.env["AI_CONFIG_HUB_DEPLOYMENT_HELPER"];
        else process.env["AI_CONFIG_HUB_DEPLOYMENT_HELPER"] = helper;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps backup confined when its destination parent is swapped",
    async () => {
      const { allowedRoot, backupRoot, outsideRoot, port } = await fixture();
      const source = join(allowedRoot, "source.txt");
      const parent = join(backupRoot, "parent");
      const movedParent = join(backupRoot, "original-parent");
      const destination = join(parent, "backup.txt");
      const marker = join(allowedRoot, "native-backup-pause");
      await writeFile(source, "source");
      await mkdir(parent);
      process.env["AICH_TEST_PAUSE_BEFORE_COMMIT"] = marker;
      try {
        const backup = port.createBackup({
          source: absolute(source),
          destination: absolute(destination),
          expectedHash: hash("source"),
        });
        await waitForPath(marker);
        await rename(parent, movedParent);
        await symlink(outsideRoot, parent);
        await writeFile(`${marker}.continue`, "continue");

        await expect(backup).resolves.toMatchObject({ backupHash: hash("source") });
        await expect(readFile(join(movedParent, "backup.txt"), "utf8")).resolves.toBe("source");
        await expect(lstat(join(outsideRoot, "backup.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        delete process.env["AICH_TEST_PAUSE_BEFORE_COMMIT"];
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects remove when target identity changes after hash verification",
    async () => {
      const { allowedRoot, port } = await fixture();
      const target = join(allowedRoot, "target.txt");
      const changed = join(allowedRoot, "changed.txt");
      const marker = join(allowedRoot, "native-remove-pause");
      await writeFile(target, "expected");
      process.env["AICH_TEST_PAUSE_BEFORE_COMMIT"] = marker;
      try {
        const removal = port.remove({ target: absolute(target), expectedHash: hash("expected") });
        await waitForPath(marker);
        await writeFile(changed, "external change");
        await rename(changed, target);
        await writeFile(`${marker}.continue`, "continue");

        await expect(removal).rejects.toMatchObject({ code: "STALE_TARGET" });
        await expect(readFile(target, "utf8")).resolves.toBe("external change");
      } finally {
        delete process.env["AICH_TEST_PAUSE_BEFORE_COMMIT"];
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "uses no-replace link fallback and cleans temporary files",
    async () => {
      const { allowedRoot, port } = await fixture();
      const target = join(allowedRoot, "target.txt");
      process.env["AICH_TEST_FORCE_RENAMEAT2_UNSUPPORTED"] = "1";
      try {
        await expect(
          port.atomicReplace({ target: absolute(target), text: "created", expectedHash: "absent" }),
        ).resolves.toEqual({ resultingHash: hash("created") });
        await expect(
          port.atomicReplace({
            target: absolute(target),
            text: "conflict",
            expectedHash: "absent",
          }),
        ).rejects.toMatchObject({ code: "STALE_TARGET" });
        expect((await readdir(allowedRoot)).filter((name) => name.startsWith(".aich-"))).toEqual(
          [],
        );
      } finally {
        delete process.env["AICH_TEST_FORCE_RENAMEAT2_UNSUPPORTED"];
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "reports uncertain durability when a newly created directory cannot be synced",
    async () => {
      const { allowedRoot, port } = await fixture();
      const target = join(allowedRoot, "new-parent", "target.txt");
      process.env["AICH_TEST_FAIL_MKDIR_FSYNC"] = "1";
      try {
        await expect(
          port.atomicReplace({ target: absolute(target), text: "value", expectedHash: "absent" }),
        ).rejects.toBeInstanceOf(CommittedButDurabilityUncertainError);
        await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        delete process.env["AICH_TEST_FAIL_MKDIR_FSYNC"];
      }
    },
  );

  it("creates and confines a backup root that does not exist yet", async () => {
    const base = await mkdtemp(join(tmpdir(), "ai-config-hub-deployer-missing-backup-"));
    temporaryDirectories.push(base);
    const allowedRoot = join(base, "allowed");
    const backupRoot = join(base, "missing", "backups");
    const source = join(allowedRoot, "source.txt");
    const destination = join(backupRoot, "backup.txt");
    await mkdir(allowedRoot);
    await writeFile(source, "backup contents");
    const port = new NodeDeploymentFilePort({
      allowedRoots: [absolute(allowedRoot)],
      backupRoot: absolute(backupRoot),
    });

    await expect(
      port.createBackup({
        source: absolute(source),
        destination: absolute(destination),
        expectedHash: hash("backup contents"),
      }),
    ).resolves.toEqual({
      backupPath: absolute(destination),
      backupHash: hash("backup contents"),
    });
    await expect(readFile(destination, "utf8")).resolves.toBe("backup contents");
  });

  it("creates a backup preserving bytes and file mode", async () => {
    const { allowedRoot, backupRoot, port } = await fixture();
    const source = join(allowedRoot, "source.txt");
    const destination = join(backupRoot, "nested", "backup.txt");
    await writeFile(source, "backup contents");
    await chmod(source, 0o640);

    const result = await port.createBackup({
      source: absolute(source),
      destination: absolute(destination),
      expectedHash: hash("backup contents"),
    });

    expect(result).toEqual({
      backupPath: absolute(destination),
      backupHash: hash("backup contents"),
    });
    await expect(readFile(destination, "utf8")).resolves.toBe("backup contents");
    expect((await stat(destination)).mode & 0o777).toBe(0o640);
  });

  it("atomically creates and replaces with mode 0600 and returns SHA-256", async () => {
    const { allowedRoot, port } = await fixture();
    const target = join(allowedRoot, "target.txt");

    await expect(
      port.atomicReplace({ target: absolute(target), text: "first", expectedHash: "absent" }),
    ).resolves.toEqual({ resultingHash: hash("first") });
    expect((await stat(target)).mode & 0o777).toBe(0o600);

    await expect(
      port.atomicReplace({ target: absolute(target), text: "second", expectedHash: hash("first") }),
    ).resolves.toEqual({ resultingHash: hash("second") });
    await expect(readFile(target, "utf8")).resolves.toBe("second");
  });

  it("removes a file when its hash matches", async () => {
    const { allowedRoot, port } = await fixture();
    const target = join(allowedRoot, "target.txt");
    await writeFile(target, "current");

    await port.remove({ target: absolute(target), expectedHash: hash("current") });

    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports when replacement committed but parent durability is uncertain", async () => {
    const { allowedRoot, backupRoot } = await fixture();
    const target = join(allowedRoot, "target.txt");
    const port = createNodeDeploymentFilePortForTest(
      {
        allowedRoots: [absolute(allowedRoot)],
        backupRoot: absolute(backupRoot),
      },
      { beforeParentSync: () => Promise.reject(new Error("simulated fsync failure")) },
    );
    if (process.platform === "linux") process.env["AICH_TEST_FAIL_PARENT_FSYNC"] = "1";
    const error = await port
      .atomicReplace({ target: absolute(target), text: "committed", expectedHash: "absent" })
      .catch((cause: unknown) => cause)
      .finally(() => {
        delete process.env["AICH_TEST_FAIL_PARENT_FSYNC"];
      });

    expect(error).toBeInstanceOf(CommittedButDurabilityUncertainError);
    expect(error).toMatchObject({ committed: true, durabilityUncertain: true });
    await expect(readFile(target, "utf8")).resolves.toBe("committed");
  });

  it("ignores Windows directory fsync permission failures", () => {
    expect(
      shouldIgnoreDirectorySyncError(
        Object.assign(new Error("denied"), { code: "EPERM" }),
        "win32",
      ),
    ).toBe(true);
    expect(
      shouldIgnoreDirectorySyncError(
        Object.assign(new Error("denied"), { code: "EPERM" }),
        "darwin",
      ),
    ).toBe(false);
  });
});

describe("PathLockManager", () => {
  it("never overlaps callbacks for the same path", async () => {
    const manager = new PathLockManager();
    const target = absolute("/target");
    let active = 0;
    let maximumActive = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        manager.withPaths([target], async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );

    expect(maximumActive).toBe(1);
  });

  it("deduplicates and sorts multi-path locks without deadlock", async () => {
    const manager = new PathLockManager();
    const first = absolute("/first");
    const second = absolute("/second");
    const order: string[] = [];

    const operations = Promise.all([
      manager.withPaths([second, first, second], async () => {
        order.push("one:start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("one:end");
      }),
      manager.withPaths([first, second], async () => {
        order.push("two:start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("two:end");
      }),
    ]);

    await expect(
      Promise.race([
        operations,
        new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock")), 500)),
      ]),
    ).resolves.toBeDefined();
    expect(order).toEqual(["one:start", "one:end", "two:start", "two:end"]);
  });
});
