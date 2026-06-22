import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AbsolutePathSchema, ContentHashSchema, type AbsolutePath } from "@ai-config-hub/shared";
import { afterEach, describe, expect, it } from "vitest";

import { NodeDeploymentFilePort } from "./file-port.js";
import { PathLockManager } from "./path-locks.js";

const temporaryDirectories: string[] = [];

function absolute(path: string): AbsolutePath {
  return AbsolutePathSchema.parse(path);
}

function hash(text: string) {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(text).digest("hex")}`);
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
});

describe("NodeDeploymentFilePort writes", () => {
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
