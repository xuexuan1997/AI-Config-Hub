/* global process */
import { readFile, writeFile } from "node:fs/promises";

const output = process.argv[2] ?? "release/linux-x64/sbom.cdx.json";
const rootPackage = JSON.parse(await readFile("package.json", "utf8"));

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000200",
  version: 1,
  metadata: {
    timestamp: new Date(0).toISOString(),
    component: {
      type: "application",
      name: rootPackage.name,
      version: rootPackage.version,
      purl: `pkg:generic/${rootPackage.name}@${rootPackage.version}`,
    },
  },
  components: Object.entries(rootPackage.devDependencies ?? {})
    .filter(([, version]) => !String(version).startsWith("workspace:"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => ({
      type: "library",
      name,
      version,
      scope: "optional",
    })),
};

await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`);
