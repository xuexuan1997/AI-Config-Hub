import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

export default async function setup() {
  if (process.platform !== "linux") return undefined;
  const directory = await mkdtemp(join(tmpdir(), "aich-native-helper-"));
  const output = join(directory, "deployment-file-helper");
  const source = fileURLToPath(new URL("../native/deployment-file-helper.c", import.meta.url));
  await promisify(execFile)(process.env["CC"] ?? "cc", [
    "-std=c11",
    "-O2",
    "-D_GNU_SOURCE",
    "-DAICH_NATIVE_TESTING",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    output,
    source,
  ]);
  process.env["AI_CONFIG_HUB_DEPLOYMENT_HELPER"] = output;
  return async () => rm(directory, { recursive: true, force: true });
}
