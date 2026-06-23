import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CORE_COMMAND_NAMES,
  type CoreUseCases,
  type UseCaseContractMap,
} from "../use-cases/contracts.js";
import type { AdapterReadApi, ToolAdapter } from "./adapter.js";
import type { LocalGitPort } from "./git.js";

describe("ToolAdapter contract", () => {
  it("contains every approved semantic capability", () => {
    expectTypeOf<ToolAdapter>().toHaveProperty("detect");
    expectTypeOf<ToolAdapter>().toHaveProperty("discover");
    expectTypeOf<ToolAdapter>().toHaveProperty("parse");
    expectTypeOf<ToolAdapter>().toHaveProperty("resolveEffective");
    expectTypeOf<ToolAdapter>().toHaveProperty("diagnose");
    expectTypeOf<ToolAdapter>().toHaveProperty("convert");
    expectTypeOf<ToolAdapter>().toHaveProperty("planDeployment");
    expectTypeOf<ToolAdapter>().toHaveProperty("verify");
  });

  it("gives adapters only a narrow read API", () => {
    expectTypeOf<keyof AdapterReadApi>().toEqualTypeOf<"realpath" | "stat" | "list" | "readText">();
  });
});

describe("LocalGitPort", () => {
  it("does not expose a generic shell command", () => {
    expectTypeOf<keyof LocalGitPort>().not.toEqualTypeOf<"exec">();
  });

  it("does not expose remote repository operations", () => {
    expectTypeOf<keyof LocalGitPort>().not.toEqualTypeOf<"clone" | "pull" | "push">();
  });
});

describe("core use cases", () => {
  it("publishes exactly the approved command catalog", () => {
    expect(CORE_COMMAND_NAMES).toEqual([
      "scan.start",
      "scan.status",
      "scan.cancel",
      "assets.list",
      "assets.get",
      "effective.resolve",
      "diagnostics.list",
      "migration.preview",
      "deployment.execute",
      "deployment.rollback",
      "history.list",
      "settings.get",
      "settings.update",
    ]);
    expectTypeOf<keyof CoreUseCases>().toEqualTypeOf<(typeof CORE_COMMAND_NAMES)[number]>();
  });

  it("requires a process-local confirmation grant for write use cases", () => {
    expectTypeOf<UseCaseContractMap["deployment.execute"]["input"]>().toHaveProperty(
      "confirmationGrant",
    );
    expectTypeOf<UseCaseContractMap["deployment.rollback"]["input"]>().toHaveProperty(
      "confirmationGrant",
    );
  });
});
