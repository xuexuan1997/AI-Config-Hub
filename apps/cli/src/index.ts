#!/usr/bin/env node
import { createCliCommandServices } from "./app-services.js";
import { createCliProgram, runCli } from "./cli.js";

const runtime = await createCliCommandServices();
try {
  const result = await runCli(
    createCliProgram({
      services: runtime.services,
    }),
    process.argv.slice(2),
  );
  process.exitCode = result.exitCode;
} finally {
  runtime.close();
}
