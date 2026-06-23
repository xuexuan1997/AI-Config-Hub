/* global process */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv[2] ?? "release/linux-x64";
const manifest = JSON.parse(await readFile(join(directory, "version-manifest.json"), "utf8"));
const checksums = await readFile(join(directory, "SHA256SUMS"), "utf8");

for (const artifact of manifest.artifacts) {
  const bytes = await readFile(join(directory, artifact.name));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== artifact.sha256) throw new Error(`Checksum mismatch: ${artifact.name}`);
  if (!checksums.includes(`${sha256}  ${artifact.name}`)) {
    throw new Error(`SHA256SUMS missing: ${artifact.name}`);
  }
}
