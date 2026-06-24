import type { BrowserWindow, Dialog, OpenDialogOptions, OpenDialogReturnValue } from "electron";

const USE_PORTAL_FILE_CHOOSER = "AI_CONFIG_HUB_USE_PORTAL_FILE_CHOOSER";

export interface ProjectDialogPortInput {
  readonly dialog: Pick<Dialog, "showOpenDialog">;
  readonly env: NodeJS.ProcessEnv;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly platform: NodeJS.Platform;
}

export function createProjectDialogPort(input: ProjectDialogPortInput): {
  readonly selectDirectory: () => Promise<string | undefined>;
} {
  return {
    async selectDirectory() {
      const options: OpenDialogOptions = {
        title: "Select AI Config Hub project",
        properties: ["openDirectory"],
      };
      preferGtkFileChooser(input.env, input.platform);
      try {
        return selectedPath(await showDirectoryDialog(input, options));
      } catch (error) {
        if (!isPortalFileChooserError(error) || input.platform !== "linux") throw error;
        input.env.GTK_USE_PORTAL = "0";
        return selectedPath(await showDirectoryDialog(input, options));
      }
    },
  };
}

export function preferGtkFileChooser(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  if (platform !== "linux") return;
  if (env[USE_PORTAL_FILE_CHOOSER] === "1") return;
  env.GTK_USE_PORTAL = "0";
}

export function isPortalFileChooserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("org.freedesktop.portal.FileChooser");
}

async function showDirectoryDialog(
  input: ProjectDialogPortInput,
  options: OpenDialogOptions,
): Promise<OpenDialogReturnValue> {
  const mainWindow = input.getMainWindow();
  return mainWindow === undefined
    ? await input.dialog.showOpenDialog(options)
    : await input.dialog.showOpenDialog(mainWindow, options);
}

function selectedPath(result: OpenDialogReturnValue): string | undefined {
  return result.canceled ? undefined : result.filePaths[0];
}
