import { describe, expect, it } from "vitest";

import { createSecureWindowOptions, DESKTOP_MINIMUM_WINDOW_SIZE } from "./window-options.js";

describe("secure desktop window options", () => {
  it("sets the Electron desktop minimum window size", () => {
    const options = createSecureWindowOptions("/tmp/preload.cjs");

    expect(DESKTOP_MINIMUM_WINDOW_SIZE).toEqual({ width: 1024, height: 700 });
    expect(options.minWidth).toBe(DESKTOP_MINIMUM_WINDOW_SIZE.width);
    expect(options.minHeight).toBe(DESKTOP_MINIMUM_WINDOW_SIZE.height);
    expect(options.width).toBeGreaterThanOrEqual(DESKTOP_MINIMUM_WINDOW_SIZE.width);
    expect(options.height).toBeGreaterThanOrEqual(DESKTOP_MINIMUM_WINDOW_SIZE.height);
  });

  it("keeps secure renderer process defaults enabled", () => {
    const options = createSecureWindowOptions("/tmp/preload.cjs");

    expect(options.show).toBe(false);
    expect(options.webPreferences).toMatchObject({
      preload: "/tmp/preload.cjs",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    });
  });
});
