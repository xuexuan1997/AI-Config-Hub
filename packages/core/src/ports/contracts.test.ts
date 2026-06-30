import { describe, expect, expectTypeOf, it } from "vitest";

import type { AssetId } from "@ai-config-hub/shared";

import {
  CORE_COMMAND_NAMES,
  type CoreUseCases,
  type UseCaseContractMap,
} from "../use-cases/contracts.js";
import type { AdapterReadApi, ToolAdapter } from "./adapter.js";
import type { AssetRepositoryGitPort, LocalGitPort } from "./git.js";

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
    expectTypeOf<keyof LocalGitPort>().not.toEqualTypeOf<"clone" | "pull" | "push" | "tag">();
  });
});

describe("AssetRepositoryGitPort", () => {
  it("exposes remote asset-library workflow operations separately from LocalGitPort", () => {
    expectTypeOf<AssetRepositoryGitPort>().toHaveProperty("clone");
    expectTypeOf<AssetRepositoryGitPort>().toHaveProperty("pull");
    expectTypeOf<AssetRepositoryGitPort>().toHaveProperty("status");
    expectTypeOf<AssetRepositoryGitPort>().toHaveProperty("diff");
    expectTypeOf<AssetRepositoryGitPort>().toHaveProperty("commit");
    expectTypeOf<AssetRepositoryGitPort>().toHaveProperty("push");
    expectTypeOf<AssetRepositoryGitPort>().toHaveProperty("tag");
    expectTypeOf<AssetRepositoryGitPort>().toHaveProperty("restore");
    expectTypeOf<AssetRepositoryGitPort>().toHaveProperty("history");
    expectTypeOf<keyof LocalGitPort>().not.toEqualTypeOf<keyof AssetRepositoryGitPort>();
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
      "assets.openSource",
      "assets.disable",
      "assets.enable",
      "effective.resolve",
      "diagnostics.list",
      "diagnostics.export",
      "migration.preview",
      "deployment.execute",
      "deployment.rollback",
      "history.list",
      "history.get",
      "settings.get",
      "settings.update",
    ]);
    expectTypeOf<keyof CoreUseCases>().toEqualTypeOf<(typeof CORE_COMMAND_NAMES)[number]>();
    expectTypeOf<UseCaseContractMap["assets.openSource"]["input"]>().toEqualTypeOf<{
      readonly assetId: AssetId;
    }>();
    expectTypeOf<UseCaseContractMap["assets.openSource"]["output"]>().toEqualTypeOf<{
      readonly assetId: AssetId;
      readonly opened: true;
    }>();
    expectTypeOf<UseCaseContractMap["assets.disable"]["input"]>().toEqualTypeOf<{
      readonly assetId: AssetId;
    }>();
    expectTypeOf<UseCaseContractMap["assets.disable"]["output"]>().toEqualTypeOf<{
      readonly assetId: AssetId;
      readonly status: "disabled";
    }>();
    expectTypeOf<UseCaseContractMap["assets.enable"]["input"]>().toEqualTypeOf<{
      readonly assetId: AssetId;
    }>();
    expectTypeOf<UseCaseContractMap["assets.enable"]["output"]>().toEqualTypeOf<{
      readonly assetId: AssetId;
      readonly status: "enabled";
    }>();
    expectTypeOf<UseCaseContractMap["history.get"]["output"]>().toHaveProperty("entry");
    expectTypeOf<UseCaseContractMap["history.get"]["output"]>().toHaveProperty("plan");
    expectTypeOf<UseCaseContractMap["history.get"]["output"]>().toHaveProperty("changes");
  });

  it("requires preview hash confirmation for deployment execution", () => {
    expectTypeOf<UseCaseContractMap["deployment.execute"]["input"]>().toHaveProperty(
      "confirmedPlanHash",
    );
    expectTypeOf<UseCaseContractMap["deployment.rollback"]["input"]>().toHaveProperty(
      "deploymentRecordId",
    );
  });
});
