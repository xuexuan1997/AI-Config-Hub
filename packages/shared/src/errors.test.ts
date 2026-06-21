import { describe, expect, it } from "vitest";

import { AppError } from "./errors.js";

describe("AppError", () => {
  it("serializes only explicitly allowlisted safe context", () => {
    const error = new AppError({
      code: "VALIDATION_FAILED",
      message: "Configuration could not be parsed",
      retryable: false,
      suggestedActions: ["Fix the reported location"],
      safeContext: { assetId: "asset-1" },
      cause: new Error("token=secret"),
    });

    expect(error.toJSON()).toEqual({
      code: "VALIDATION_FAILED",
      message: "Configuration could not be parsed",
      retryable: false,
      suggestedActions: ["Fix the reported location"],
      safeContext: { assetId: "asset-1" },
    });
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it("rejects unstable lowercase error codes", () => {
    expect(
      () =>
        new AppError({
          // @ts-expect-error exercising the runtime boundary
          code: "validation_failed",
          message: "Invalid code",
          retryable: false,
          suggestedActions: ["Use a stable code"],
        }),
    ).toThrow(/error code/i);
  });
});
