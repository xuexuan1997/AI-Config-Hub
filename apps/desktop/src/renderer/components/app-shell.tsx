import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
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
      <header className="sidebar">
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
        <ShellContext state={props.state} />
      </header>
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

function ShellContext(props: { readonly state: AppState }) {
  const locale = localeForState(props.state);
  const context = shellContextFor(props.state, locale);
  return (
    <div className="shell-context" title={`${context.label}: ${context.tooltip}`}>
      <FolderOpenIcon aria-hidden="true" size={17} weight="regular" />
      <span>
        <small>{context.label}</small>
        <strong>{context.value}</strong>
      </span>
    </div>
  );
}

function shellContextFor(
  state: AppState,
  locale: ReturnType<typeof localeForState>,
): { readonly label: string; readonly tooltip: string; readonly value: string } {
  if (state.route === "migration") {
    const source = state.migration.sourceProjectRoot ?? "—";
    const target = state.migration.targetScopeId ?? "—";
    return {
      label: `${t(locale, "Source project")} / ${t(locale, "Target project")}`,
      tooltip: `${source} / ${target}`,
      value: `${shortPath(source)} / ${shortPath(target)}`,
    };
  }
  if (state.route === "settings") {
    const value = t(locale, "Configuration asset workbench");
    return {
      label: t(locale, "General"),
      tooltip: value,
      value,
    };
  }
  const fallback = t(locale, "No folder selected yet");
  return {
    label: t(locale, "Current project"),
    tooltip: state.projectRoot ?? fallback,
    value: shortPath(state.projectRoot, fallback),
  };
}

function shortPath(path: string | undefined, fallback = "—"): string {
  if (path === undefined || path.trim().length === 0) return fallback;
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

function themeAttribute(theme: ThemeSetting): "light" | "dark" | "system" {
  return theme;
}
