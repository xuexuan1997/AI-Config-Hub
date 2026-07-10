import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AbsolutePathSchema } from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createNodeFileAccess,
  MAX_DIRECTORY_LIST_ENTRIES,
  MAX_SOURCE_SNAPSHOT_BYTES,
  type FileSnapshotLimitError,
} from "./file-reader.js";

const absolute = (path: string) => AbsolutePathSchema.parse(resolve(path));
const canonicalAbsolute = async (path: string) => AbsolutePathSchema.parse(await realpath(path));

describe("root-confined file access", () => {
  it("allows internal files and rejects outside paths and escaping symlinks", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ai-config-hub-reader-"));
    const root = join(sandbox, "allowed");
    const internal = join(root, "internal");
    const outside = join(sandbox, "outside");
    await mkdir(root);
    await mkdir(internal);
    await mkdir(outside);
    await writeFile(join(internal, "inside.md"), "inside", "utf8");
    await writeFile(join(outside, "secret.md"), "outside", "utf8");
    await symlink(internal, join(root, "inside-link"), "junction");
    await symlink(outside, join(root, "escape-link"), "junction");

    const { read } = await createNodeFileAccess({ allowedRoots: [absolute(root)] });

    await expect(read.readText(absolute(join(internal, "inside.md")))).resolves.toBe("inside");
    await expect(read.realpath(absolute(join(root, "inside-link", "inside.md")))).resolves.toBe(
      await canonicalAbsolute(join(internal, "inside.md")),
    );
    await expect(read.readText(absolute(join(outside, "secret.md")))).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ALLOWED_ROOT",
    });
    await expect(
      read.readText(absolute(join(root, "escape-link", "secret.md"))),
    ).rejects.toMatchObject({
      code: "SYMLINK_ESCAPE",
    });
    expect(Object.keys(read).sort()).toEqual([
      "list",
      "readText",
      "realpath",
      "snapshotFile",
      "stat",
    ]);
  });

  it("returns sorted children, metadata and stable SHA-256 snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-snapshot-"));
    await writeFile(join(root, "b.md"), "beta", "utf8");
    await writeFile(join(root, "a.md"), "alpha", "utf8");
    const { read, snapshots } = await createNodeFileAccess({ allowedRoots: [absolute(root)] });

    await expect(read.list(absolute(root))).resolves.toEqual([
      await canonicalAbsolute(join(root, "a.md")),
      await canonicalAbsolute(join(root, "b.md")),
    ]);
    await expect(read.stat(absolute(join(root, "a.md")))).resolves.toMatchObject({
      kind: "file",
      size: 5,
    });
    await expect(read.stat(absolute(join(root, "missing.md")))).resolves.toMatchObject({
      kind: "missing",
      size: 0,
    });
    await expect(
      snapshots.snapshot({ path: absolute(join(root, "a.md")), allowedRoots: [absolute(root)] }),
    ).resolves.toMatchObject({
      text: "alpha",
      contentHash: `sha256:${"8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8"}`,
      size: 5,
    });
    await expect(
      snapshots.snapshot({
        path: absolute(join(root, "missing.md")),
        allowedRoots: [absolute(root)],
      }),
    ).resolves.toBeUndefined();
    await expect(read.readText(absolute(join(root, "missing.md")))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns binary-aware read snapshots for UTF-8 and non-UTF-8 files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-binary-snapshot-"));
    const textPath = join(root, "skill.md");
    const binaryPath = join(root, "image.bin");
    await writeFile(textPath, "alpha", "utf8");
    await writeFile(binaryPath, Buffer.from([0xff, 0xfe, 0xfd]));
    const { read } = await createNodeFileAccess({ allowedRoots: [absolute(root)] });

    await expect(read.snapshotFile(absolute(textPath))).resolves.toMatchObject({
      canonicalPath: await canonicalAbsolute(textPath),
      isText: true,
      text: "alpha",
      contentHash: hash(Buffer.from("alpha", "utf8")),
      size: 5,
    });
    const binary = await read.snapshotFile(absolute(binaryPath));

    expect(binary).toMatchObject({
      canonicalPath: await canonicalAbsolute(binaryPath),
      isText: false,
      contentHash: hash(Buffer.from([0xff, 0xfe, 0xfd])),
      size: 3,
    });
    expect(binary).not.toHaveProperty("text");
  });

  it("rejects a file that changes while its snapshot is being read", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-torn-"));
    const target = join(root, "changing.md");
    await writeFile(target, "before", "utf8");
    const { snapshots } = await createNodeFileAccess({
      allowedRoots: [absolute(root)],
      beforeFinalStat: async () => writeFile(target, "after-with-different-size", "utf8"),
    });

    await expect(
      snapshots.snapshot({ path: absolute(target), allowedRoots: [absolute(root)] }),
    ).rejects.toMatchObject({ code: "STALE_INDEX" });
  });

  it("rejects a file that disappears while its snapshot is being read", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-disappearing-"));
    const target = join(root, "changing.md");
    await writeFile(target, "before", "utf8");
    const { read } = await createNodeFileAccess({
      allowedRoots: [absolute(root)],
      beforeFinalStat: async () => unlink(target),
    });

    await expect(read.snapshotFile(absolute(target))).rejects.toMatchObject({
      code: "STALE_INDEX",
    });
  });

  it("keeps FileSnapshotPort text-only and readText rejects non-text files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-text-only-"));
    const binaryPath = join(root, "image.bin");
    await writeFile(binaryPath, Buffer.from([0xff, 0xfe, 0xfd]));
    const { read, snapshots } = await createNodeFileAccess({ allowedRoots: [absolute(root)] });

    await expect(read.readText(absolute(binaryPath))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      snapshots.snapshot({ path: absolute(binaryPath), allowedRoots: [absolute(root)] }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("honors a narrower root supplied to an individual snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-narrow-root-"));
    const narrow = join(root, "narrow");
    await mkdir(narrow);
    const sibling = join(root, "sibling.md");
    await writeFile(sibling, "outside the request root", "utf8");
    const { snapshots } = await createNodeFileAccess({ allowedRoots: [absolute(root)] });

    await expect(
      snapshots.snapshot({ path: absolute(sibling), allowedRoots: [absolute(narrow)] }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
  });

  it("rejects an oversized snapshot before allocating file contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-snapshot-limit-"));
    const target = join(root, "SKILL.md");
    await writeFile(target, Buffer.alloc(32));
    const readFile = vi.fn<(path: ReturnType<typeof absolute>) => Promise<Buffer>>(() =>
      Promise.reject(new Error("Oversized files must not be read")),
    );
    const { read } = await createNodeFileAccess({
      allowedRoots: [absolute(root)],
      maxSnapshotBytes: 16,
      readFile,
    });

    await expect(read.snapshotFile(absolute(target))).rejects.toMatchObject({
      name: "FileSnapshotLimitError",
      code: "FILE_SNAPSHOT_TOO_LARGE",
      limit: 16,
      observed: 32,
    } satisfies Partial<FileSnapshotLimitError>);
    expect(readFile).not.toHaveBeenCalled();
    expect(MAX_SOURCE_SNAPSHOT_BYTES).toBe(5 * 1024 * 1024);
  });

  it("rejects a snapshot when the bytes read exceed the preflight size", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-snapshot-growth-"));
    const target = join(root, "SKILL.md");
    await writeFile(target, "x", "utf8");
    const readFile = vi.fn(() => Promise.resolve(Buffer.alloc(32)));
    const { read } = await createNodeFileAccess({
      allowedRoots: [absolute(root)],
      maxSnapshotBytes: 16,
      readFile,
    });

    await expect(read.snapshotFile(absolute(target))).rejects.toMatchObject({
      code: "FILE_SNAPSHOT_TOO_LARGE",
      limit: 16,
      observed: 32,
    });
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("streams directory listings into a fixed entry budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-directory-limit-"));
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(root, `file-${String(index)}.md`), "x", "utf8");
    }
    const { read } = await createNodeFileAccess({
      allowedRoots: [absolute(root)],
      maxDirectoryEntries: 3,
    });

    await expect(read.list(absolute(root))).rejects.toMatchObject({
      name: "AdapterDiscoveryLimitError",
      code: "ADAPTER_DISCOVERY_LIMIT_EXCEEDED",
      limit: 3,
      observedAtLeast: 4,
    });
    expect(MAX_DIRECTORY_LIST_ENTRIES).toBe(10_000);
  });
});

function hash(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
