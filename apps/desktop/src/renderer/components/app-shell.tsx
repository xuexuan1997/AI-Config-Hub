import { useEffect, useRef, type ReactNode } from "react";

import { localeForState, t } from "../i18n.js";
import type { AppState, LanguageSetting, Route, ThemeSetting } from "../model.js";

const routes: { readonly route: Route; readonly label: string }[] = [
  { route: "assets", label: "Asset Review" },
  { route: "migration", label: "Asset Migration" },
  { route: "settings", label: "Settings" },
];

export function AppShell(props: {
  readonly state: AppState;
  readonly onRoute: (route: Route) => void;
  readonly children: ReactNode;
}) {
  const mainRef = useRef<HTMLElement | null>(null);
  const locale = localeForState(props.state);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0 });
  }, [props.state.route]);

  return (
    <div
      className="app-shell"
      data-language={props.state.settings.values.language}
      data-theme={themeAttribute(props.state.settings.values.theme)}
      lang={languageAttribute(props.state.settings.values.language)}
    >
      <aside className="sidebar">
        <div>
          <div className="brand">
            <strong>AI Config Hub</strong>
            <span>{t(locale, "Configuration asset workbench")}</span>
          </div>
          <nav aria-label={t(locale, "Workspaces")}>
            {routes.map(({ route, label }) => (
              <button
                className={props.state.route === route ? "active" : ""}
                key={route}
                type="button"
                onClick={() => props.onRoute(route)}
              >
                {t(locale, label)}
              </button>
            ))}
          </nav>
        </div>
      </aside>
      <main data-route={props.state.route} key={props.state.route} ref={mainRef}>
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
