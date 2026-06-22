import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

if (process.platform === "linux") {
  const outputDirectory = fileURLToPath(new URL("../dist/native", import.meta.url));
  const source = fileURLToPath(new URL("../native/deployment-file-helper.c", import.meta.url));
  const output = `${outputDirectory}/deployment-file-helper`;
  const compiler = process.env["AICH_NATIVE_CC"] ?? process.env["CC"] ?? "cc";
  const compilerArguments =
    process.env["AICH_NATIVE_CFLAGS_JSON"] === undefined
      ? ["-std=c11", "-O2", "-D_GNU_SOURCE", "-Wall", "-Wextra", "-Werror"]
      : JSON.parse(process.env["AICH_NATIVE_CFLAGS_JSON"]);
  if (
    !Array.isArray(compilerArguments) ||
    !compilerArguments.every((value) => typeof value === "string")
  ) {
    throw new TypeError("AICH_NATIVE_CFLAGS_JSON must be a JSON array of compiler arguments");
  }
  await mkdir(outputDirectory, { recursive: true });
  await execute(compiler, [...compilerArguments, "-o", output, source], { cwd: packageRoot });
}
