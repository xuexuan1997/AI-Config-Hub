/* global process */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const directory = process.argv[2] ?? "release/linux-x64";
const target = resolveTarget(directory, process.argv[3], process.argv[4]);
const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const expectedNames = expectedPublishableNames(rootPackage.version, target);
const directoryEntries = new Set(await readdir(directory));

for (const requiredName of expectedNames.required) {
  if (!directoryEntries.has(requiredName)) {
    throw new Error(
      `Missing release artifact for ${target.platform}-${target.architecture}: ${requiredName}`,
    );
  }
}

const publishableNames = expectedNames.all.filter((file) => directoryEntries.has(file)).sort();
const artifacts = [];
for (const file of publishableNames) {
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

const manifest = {
  schemaVersion: 1,
  packageName: rootPackage.name,
  version: rootPackage.version,
  platform: target.platform,
  architecture: target.architecture,
  ...(target.platform === "linux" ? { glibcBaseline: "2.28" } : {}),
  generatedAt: new Date(0).toISOString(),
  artifacts,
};

await writeFile(join(directory, "version-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

function resolveTarget(directoryName, platformArg, architectureArg) {
  const directoryTarget = /^(linux|windows|macos)-(x64|arm64)$/.exec(
    basename(directoryName.replace(/[\\/]+$/, "")),
  );
  const platform = platformArg ?? directoryTarget?.[1] ?? "linux";
  const architecture = architectureArg ?? directoryTarget?.[2] ?? "x64";

  if (!["linux", "windows", "macos"].includes(platform)) {
    throw new Error(`Unsupported release platform: ${platform}`);
  }
  if (!["x64", "arm64"].includes(architecture)) {
    throw new Error(`Unsupported release architecture: ${architecture}`);
  }
  if (platform === "windows" && architecture !== "x64") {
    throw new Error("Windows release packaging only supports x64");
  }
  if (platform === "linux" && architecture !== "x64") {
    throw new Error("Linux release packaging only supports x64");
  }

  return { platform, architecture };
}

function expectedPublishableNames(version, target) {
  const key = `${target.platform}-${target.architecture}`;
  const installerByTarget = {
    "linux-x64": `AI-Config-Hub-${version}-x86_64.AppImage`,
    "windows-x64": `AI-Config-Hub-${version}-windows-x64.exe`,
    "macos-x64": `AI-Config-Hub-${version}-macos-x64.dmg`,
    "macos-arm64": `AI-Config-Hub-${version}-macos-arm64.dmg`,
  };
  const installer = installerByTarget[key];
  if (!installer) throw new Error(`Unsupported release target: ${key}`);

  const required = [installer, "sbom.cdx.json"];
  const all = target.platform === "linux" ? [...required, "elf-compatibility.json"] : required;
  return { required, all };
}
