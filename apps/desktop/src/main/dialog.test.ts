import { describe, expect, it, vi } from "vitest";

import { createProjectDialogPort, preferGtkFileChooser } from "./dialog.js";

describe("Linux project directory dialog compatibility", () => {
  it("prefers GTK file chooser for Linux AppImage compatibility", () => {
    const env: NodeJS.ProcessEnv = { GTK_USE_PORTAL: "1" };

    preferGtkFileChooser(env, "linux");

    expect(env.GTK_USE_PORTAL).toBe("0");
  });

  it("lets users explicitly opt back into portal file chooser", () => {
    const env: NodeJS.ProcessEnv = {
      AI_CONFIG_HUB_USE_PORTAL_FILE_CHOOSER: "1",
      GTK_USE_PORTAL: "1",
    };

    preferGtkFileChooser(env, "linux");

    expect(env.GTK_USE_PORTAL).toBe("1");
  });

  it("falls back to GTK when an opted-in portal file chooser is unavailable", async () => {
    const env: NodeJS.ProcessEnv = {
      AI_CONFIG_HUB_USE_PORTAL_FILE_CHOOSER: "1",
      GTK_USE_PORTAL: "1",
    };
    const showOpenDialog = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("No such interface “org.freedesktop.portal.FileChooser” on object"),
      )
      .mockResolvedValueOnce({ canceled: false, filePaths: ["/workspace/project"] });
    const port = createProjectDialogPort({
      dialog: { showOpenDialog },
      env,
      getMainWindow: () => undefined,
      platform: "linux",
    });

    await expect(port.selectDirectory()).resolves.toBe("/workspace/project");
    expect(env.GTK_USE_PORTAL).toBe("0");
    expect(showOpenDialog).toHaveBeenCalledTimes(2);
  });
});
