import { useEffect, useRef, type ReactNode } from "react";

import type { AppState, Route } from "../model.js";

const routes: { readonly route: Route; readonly label: string }[] = [
  { route: "overview", label: "Overview" },
  { route: "assets", label: "Assets" },
  { route: "migration", label: "Migration" },
  { route: "deployment", label: "Deployment" },
  { route: "history", label: "History" },
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
    <div className="app-shell">
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
              <p className="eyebrow">Project</p>
              <strong className="project-root-value" title={props.state.projectRoot}>
                {props.state.projectRoot ?? "No project selected"}
              </strong>
            </div>
            <button type="button" onClick={props.onSelectProject}>
              Select project
            </button>
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
            <input aria-label="Project path" name="projectPath" placeholder="/path/to/project" />
            <button className="project-path-submit" type="submit">
              Use path
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
