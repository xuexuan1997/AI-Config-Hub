import { useEffect, useRef, type ReactNode } from "react";

import { localeForState, localizeUiMessage, t } from "../i18n.js";
import type { AppState, Route, ThemeSetting } from "../model.js";

const routes: { readonly route: Route; readonly label: string }[] = [
  { route: "assets", label: "Asset Review" },
  { route: "migration", label: "Asset Migration" },
  { route: "settings", label: "Settings" },
];

export function AppShell(props: {
  readonly state: AppState;
  readonly onRoute: (route: Route) => void;
  readonly onDismissMessage?: () => void;
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
      lang={locale}
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
                aria-current={props.state.route === route ? "page" : undefined}
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
        <section className="workspace" data-route={props.state.route}>
          {props.state.message === undefined || props.state.assetDetail !== undefined ? null : (
            <div className="app-message" role="status" aria-live="polite">
              <span>{localizeUiMessage(locale, props.state.message)}</span>
              <button type="button" onClick={props.onDismissMessage}>
                {t(locale, "Close")}
              </button>
            </div>
          )}
          {props.children}
        </section>
      </main>
    </div>
  );
}

function themeAttribute(theme: ThemeSetting): "light" | "dark" | "system" {
  return theme;
}
