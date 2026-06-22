import { describe, expect, it } from "vitest";

import * as api from "@ai-config-hub/api";
import * as core from "@ai-config-hub/core";
import * as shared from "@ai-config-hub/shared";

describe("public package exports", () => {
  it("loads all foundation packages through public entries", () => {
    expect(Object.keys(shared).length).toBeGreaterThan(0);
    expect(Object.keys(core).length).toBeGreaterThan(0);
    expect(Object.keys(api).length).toBeGreaterThan(0);
  });
});
