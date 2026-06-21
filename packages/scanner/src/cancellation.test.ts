import { describe, expect, it } from "vitest";

import { createCancellationController } from "./cancellation.js";

describe("cancellation controller", () => {
  it("raises a stable cancellation error after abort", () => {
    const controller = createCancellationController();
    expect(controller.signal.aborted).toBe(false);
    expect(() => controller.signal.throwIfAborted()).not.toThrow();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(() => controller.signal.throwIfAborted()).toThrowError(
      expect.objectContaining({ code: "USER_CANCELLED" }),
    );
  });
});
