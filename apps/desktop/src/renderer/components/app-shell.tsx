import { useEffect, useRef, type ReactNode } from "react";

import type { AppState, LanguageSetting, Route, ThemeSetting } from "../model.js";

const routes: { readonly route: Route; readonly label: string }[] = [
  { route: "overview", label: "Overview" },
  { route: "assets", label: "Assets" },
  { route: "migration", label: "Migration" },
  { route: "deployment", label: "Deployment" },
  { route: "history", label: "History" },
  { route: "settings", label: "Settings" },
];

export function AppShell(props: {
  readonly state: AppState;
  readonly onRoute: (route: Route) => void;
  readonly onSelectProject: () => void;
  readonly onUseProjectPath: (path: string) => void;
  readonly children: ReactNode;
}) {
  const mainRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0 });
    window.scrollTo({ top: 0, left: 0 });
  }, [props.state.route]);

  return (
    <div
      className="app-shell"
      data-language={props.state.settings.values.language}
      data-theme={themeAttribute(props.state.settings.values.theme)}
      lang={languageAttribute(props.state.settings.values.language)}
    >
      <aside className="sidebar">
        <div className="brand">AI Config Hub</div>
        <nav aria-label="Workspaces">
          {routes.map(({ route, label }) => (
            <button
              className={props.state.route === route ? "active" : ""}
              key={route}
              type="button"
              onClick={() => props.onRoute(route)}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main data-route={props.state.route} key={props.state.route} ref={mainRef}>
        <header className="topbar">
          <div className="project-topbar-main">
            <div className="project-summary">
              <p className="eyebrow">Project setup</p>
              <p className="project-guidance">
                Choose the project folder to scan before reviewing assets.
              </p>
              <span className="project-root-label">Selected project folder</span>
              <strong className="project-root-value" title={props.state.projectRoot}>
                {props.state.projectRoot ?? "No folder selected yet"}
              </strong>
            </div>
            <div className="project-picker-action">
              <button type="button" onClick={props.onSelectProject}>
                Browse folder
              </button>
              <span>Opens your system folder picker.</span>
            </div>
          </div>
          <form
            className="project-path-editor"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const formData = new FormData(form);
              const projectPath = formData.get("projectPath");
              props.onUseProjectPath(typeof projectPath === "string" ? projectPath : "");
              form.reset();
            }}
          >
            <label className="project-path-field">
              <span>Manual path fallback</span>
              <input
                aria-label="Project path"
                name="projectPath"
                placeholder="/Users/you/project"
              />
            </label>
            <span className="project-path-help">
              Paste a folder path only if the picker is unavailable.
            </span>
            <button className="project-path-submit" type="submit">
              Use typed path
            </button>
          </form>
        </header>
        {props.state.message === undefined ? null : (
          <div className="status-banner">{props.state.message}</div>
        )}
        <section className="workspace" data-route={props.state.route}>
          {props.children}
        </section>
      </main>
    </div>
  );
}

function themeAttribute(theme: ThemeSetting): "light" | "dark" | "system" {
  return theme;
}

function languageAttribute(language: LanguageSetting): "en" | "zh-CN" | undefined {
  switch (language) {
    case "en":
      return "en";
    case "zh-CN":
      return "zh-CN";
    case "system":
      return undefined;
  }
}
