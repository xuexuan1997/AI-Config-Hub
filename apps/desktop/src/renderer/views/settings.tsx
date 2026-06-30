import type { AppState, LanguageSetting, ThemeSetting } from "../model.js";
import { LANGUAGE_SETTING_OPTIONS, THEME_SETTING_OPTIONS } from "../model.js";

export function SettingsView(props: {
  readonly state: AppState;
  readonly onThemeChange: (theme: ThemeSetting) => void;
  readonly onLanguageChange: (language: LanguageSetting) => void;
  readonly onReload: () => void;
}) {
  const disabled =
    props.state.settings.status === "loading" ||
    props.state.settings.status === "saving" ||
    props.state.settings.readOnlyRecovery;

  return (
    <section className="settings-panel">
      <div className="settings-heading">
        <div>
          <p className="eyebrow">General</p>
          <h1>Settings</h1>
        </div>
        <button type="button" onClick={props.onReload}>
          Reload
        </button>
      </div>
      <div className="settings-grid">
        <div className="field">
          <label htmlFor="settings-theme">Theme</label>
          <select
            disabled={disabled}
            id="settings-theme"
            value={props.state.settings.values.theme}
            onChange={(event) => props.onThemeChange(event.currentTarget.value as ThemeSetting)}
          >
            {THEME_SETTING_OPTIONS.map((theme) => (
              <option key={theme} value={theme}>
                {themeLabel(theme)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="settings-language">Language</label>
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
                {languageLabel(language)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="settings-meta">
        <span>{settingsStatusLabel(props.state.settings.status)}</span>
        <span>Revision {props.state.settings.revision}</span>
        {props.state.settings.requiresRestart ? <span>Restart required</span> : null}
        {props.state.settings.readOnlyRecovery ? <span>Recovery mode</span> : null}
      </div>
    </section>
  );
}

function themeLabel(theme: ThemeSetting): string {
  switch (theme) {
    case "system":
      return "System";
    case "light":
      return "Light";
    case "dark":
      return "Dark";
  }
}

function languageLabel(language: LanguageSetting): string {
  switch (language) {
    case "system":
      return "System";
    case "en":
      return "English";
    case "zh-CN":
      return "Simplified Chinese";
  }
}

function settingsStatusLabel(status: AppState["settings"]["status"]): string {
  switch (status) {
    case "idle":
      return "Not loaded";
    case "loading":
      return "Loading";
    case "ready":
      return "Ready";
    case "saving":
      return "Saving";
    case "error":
      return "Error";
  }
}
