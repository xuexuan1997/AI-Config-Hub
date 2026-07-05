import { localeForState, t } from "../i18n.js";
import type { AppState, LanguageSetting, ThemeSetting } from "../model.js";
import { LANGUAGE_SETTING_OPTIONS, THEME_SETTING_OPTIONS } from "../model.js";
import type { DesktopApi } from "../../preload/api.js";

type UpdateStatus = Awaited<ReturnType<DesktopApi["updateStatus"]>>;

export function SettingsView(props: {
  readonly state: AppState;
  readonly updateStatus?: UpdateStatus;
  readonly onThemeChange: (theme: ThemeSetting) => void;
  readonly onLanguageChange: (language: LanguageSetting) => void;
  readonly onReload: () => void;
  readonly onCheckUpdates?: () => void;
  readonly onDownloadUpdate?: () => void;
  readonly onInstallUpdate?: () => void;
}) {
  const locale = localeForState(props.state);
  const disabled =
    props.state.settings.status === "loading" ||
    props.state.settings.status === "saving" ||
    props.state.settings.readOnlyRecovery;

  return (
    <section className="settings-panel">
      <div className="settings-heading">
        <div>
          <p className="eyebrow">{t(locale, "General")}</p>
          <h1>{t(locale, "Settings")}</h1>
        </div>
        <button type="button" onClick={props.onReload}>
          {t(locale, "Reload")}
        </button>
      </div>
      <div className="settings-grid">
        <div className="field">
          <label htmlFor="settings-theme">{t(locale, "Theme")}</label>
          <select
            disabled={disabled}
            id="settings-theme"
            value={props.state.settings.values.theme}
            onChange={(event) => props.onThemeChange(event.currentTarget.value as ThemeSetting)}
          >
            {THEME_SETTING_OPTIONS.map((theme) => (
              <option key={theme} value={theme}>
                {themeLabel(locale, theme)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="settings-language">{t(locale, "Language")}</label>
          <select
            disabled={disabled}
            id="settings-language"
            value={props.state.settings.values.language}
            onChange={(event) =>
              props.onLanguageChange(event.currentTarget.value as LanguageSetting)
            }
          >
            {LANGUAGE_SETTING_OPTIONS.map((language) => (
              <option key={language} value={language}>
                {languageLabel(locale, language)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="settings-meta">
        <span>{settingsStatusLabel(locale, props.state.settings.status)}</span>
        <span>{t(locale, "Revision {revision}", { revision: props.state.settings.revision })}</span>
        {props.state.settings.requiresRestart ? <span>{t(locale, "Restart required")}</span> : null}
        {props.state.settings.readOnlyRecovery ? <span>{t(locale, "Recovery mode")}</span> : null}
      </div>
      {props.updateStatus === undefined ? null : (
        <section className="settings-update-panel">
          <div>
            <p className="eyebrow">{t(locale, "Software updates")}</p>
            <h2>{updateHeading(locale, props.updateStatus)}</h2>
            <p>{updateDescription(locale, props.updateStatus)}</p>
          </div>
          <div className="settings-update-actions">
            <button
              type="button"
              disabled={
                !props.updateStatus.enabled ||
                props.updateStatus.status === "checking" ||
                props.updateStatus.status === "downloading"
              }
              onClick={props.onCheckUpdates}
            >
              {t(locale, "Check for updates")}
            </button>
            {props.updateStatus.enabled && props.updateStatus.status === "available" ? (
              <button type="button" onClick={props.onDownloadUpdate}>
                {t(locale, "Download update")}
              </button>
            ) : null}
            {props.updateStatus.enabled && props.updateStatus.status === "downloaded" ? (
              <button type="button" onClick={props.onInstallUpdate}>
                {t(locale, "Restart and install")}
              </button>
            ) : null}
          </div>
        </section>
      )}
    </section>
  );
}

function themeLabel(locale: ReturnType<typeof localeForState>, theme: ThemeSetting): string {
  switch (theme) {
    case "system":
      return t(locale, "System");
    case "light":
      return t(locale, "Light");
    case "dark":
      return t(locale, "Dark");
  }
}

function languageLabel(
  locale: ReturnType<typeof localeForState>,
  language: LanguageSetting,
): string {
  switch (language) {
    case "system":
      return t(locale, "System");
    case "en":
      return t(locale, "English");
    case "zh-CN":
      return t(locale, "Simplified Chinese");
  }
}

function settingsStatusLabel(
  locale: ReturnType<typeof localeForState>,
  status: AppState["settings"]["status"],
): string {
  switch (status) {
    case "idle":
      return t(locale, "Not loaded");
    case "loading":
      return t(locale, "Loading");
    case "ready":
      return t(locale, "Ready");
    case "saving":
      return t(locale, "Saving");
    case "error":
      return t(locale, "Error");
  }
}

function updateHeading(locale: ReturnType<typeof localeForState>, status: UpdateStatus): string {
  return t(locale, "Current version {version}", { version: status.currentVersion });
}

function updateDescription(
  locale: ReturnType<typeof localeForState>,
  status: UpdateStatus,
): string {
  if (!status.enabled) return t(locale, status.reason);
  switch (status.status) {
    case "idle":
      return t(locale, "Updates are ready to check.");
    case "checking":
      return t(locale, "Checking for updates.");
    case "not-available":
      return t(locale, "You are on the latest version.");
    case "available":
      return t(locale, "Version {version} is available.", { version: status.updateVersion });
    case "downloading":
      return t(locale, "Downloading update: {percent}%.", {
        percent: Math.round(status.percent),
      });
    case "downloaded":
      return t(locale, "Version {version} is ready to install.", {
        version: status.updateVersion,
      });
    case "error":
      return t(locale, "Update failed: {message}", { message: status.message });
  }
}
