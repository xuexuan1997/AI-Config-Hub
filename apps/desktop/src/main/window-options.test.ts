import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  applyDesktopDockIcon,
  createSecureWindowOptions,
  resolveDesktopWindowIconPath,
} from "./window-options.js";

describe("desktop window options", () => {
  it("assigns the runtime app icon to the BrowserWindow", () => {
    const iconPath = "/app/resources/icon.png";

    const options = createSecureWindowOptions("/app/preload.cjs", iconPath);

    expect(options.icon).toBe(iconPath);
  });

  it("resolves the icon path from the compiled main module directory", () => {
    const mainModuleDirectory = resolve("/app", "dist/main/main");

    expect(resolveDesktopWindowIconPath(mainModuleDirectory)).toBe(
      resolve("/app", "resources/icon.png"),
    );
  });

  it("applies the app icon to the macOS Dock in runtime launches", () => {
    const dock = { setIcon: vi.fn() };

    applyDesktopDockIcon({ dock, iconPath: "/app/resources/icon.png", platform: "darwin" });

    expect(dock.setIcon).toHaveBeenCalledWith("/app/resources/icon.png");
  });

  it("does not require a Dock icon outside macOS", () => {
    const dock = { setIcon: vi.fn() };

    applyDesktopDockIcon({ dock, iconPath: "/app/resources/icon.png", platform: "linux" });

    expect(dock.setIcon).not.toHaveBeenCalled();
  });
});
