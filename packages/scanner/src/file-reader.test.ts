import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AbsolutePathSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { createNodeFileAccess } from "./file-reader.js";

const absolute = (path: string) => AbsolutePathSchema.parse(resolve(path));
const canonicalAbsolute = async (path: string) => AbsolutePathSchema.parse(await realpath(path));

describe("root-confined file access", () => {
  it("allows internal files and rejects outside paths and escaping symlinks", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ai-config-hub-reader-"));
    const root = join(sandbox, "allowed");
    const outside = join(sandbox, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "inside.md"), "inside", "utf8");
    await writeFile(join(outside, "secret.md"), "outside", "utf8");
    await symlink(join(root, "inside.md"), join(root, "inside-link.md"));
    await symlink(join(outside, "secret.md"), join(root, "escape-link.md"));

    const { read } = await createNodeFileAccess({ allowedRoots: [absolute(root)] });

    await expect(read.readText(absolute(join(root, "inside.md")))).resolves.toBe("inside");
    await expect(read.realpath(absolute(join(root, "inside-link.md")))).resolves.toBe(
      await canonicalAbsolute(join(root, "inside.md")),
    );
    await expect(read.readText(absolute(join(outside, "secret.md")))).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ALLOWED_ROOT",
    });
    await expect(read.readText(absolute(join(root, "escape-link.md")))).rejects.toMatchObject({
      code: "SYMLINK_ESCAPE",
    });
    expect(Object.keys(read).sort()).toEqual(["list", "readText", "realpath", "stat"]);
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
});
