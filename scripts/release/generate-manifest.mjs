/* global process */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const directory = process.argv[2] ?? "release/linux-x64";
const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const publishedArtifactNames = new Set([
  `AI-Config-Hub-${rootPackage.version}-x86_64.AppImage`,
  "elf-compatibility.json",
  "sbom.cdx.json",
]);
const files = (await readdir(directory)).filter((file) => publishedArtifactNames.has(file)).sort();

const artifacts = [];
for (const file of files) {
  const path = join(directory, file);
  if (!(await stat(path)).isFile()) continue;
  const bytes = await readFile(path);
  artifacts.push({
    name: basename(file),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  });
}

await writeFile(
  join(directory, "SHA256SUMS"),
  artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n") + "\n",
);
await writeFile(
  join(directory, "version-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      packageName: rootPackage.name,
      version: rootPackage.version,
      architecture: "x86_64",
      glibcBaseline: "2.28",
      generatedAt: new Date(0).toISOString(),
      artifacts,
    },
    null,
    2,
  )}\n`,
);
