/* global process */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const directories = process.argv.slice(2);
if (directories.length === 0) directories.push("release/linux-x64");

for (const directory of directories) {
  await verifyDirectory(directory);
}

async function verifyDirectory(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "version-manifest.json"), "utf8"));
  const checksums = await readFile(join(directory, "SHA256SUMS"), "utf8");
  const checksumLines = new Set(checksums.trim().split(/\r?\n/).filter(Boolean));

  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(join(directory, artifact.name));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) {
      throw new Error(`Checksum mismatch in ${directory}: ${artifact.name}`);
    }
    if (!checksumLines.has(`${sha256}  ${artifact.name}`)) {
      throw new Error(`SHA256SUMS missing in ${directory}: ${artifact.name}`);
    }
  }
}
