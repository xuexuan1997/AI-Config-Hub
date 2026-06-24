import type { ReactNode } from "react";

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
      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">Project</p>
            <strong>{props.state.projectRoot ?? "No project selected"}</strong>
          </div>
          <div className="project-actions">
            <button type="button" onClick={props.onSelectProject}>
              Select project
            </button>
            <form
              className="project-path-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const projectPath = form.get("projectPath");
                props.onUseProjectPath(typeof projectPath === "string" ? projectPath : "");
              }}
            >
              <input
                aria-label="Project path"
                defaultValue={props.state.projectRoot ?? ""}
                key={props.state.projectRoot ?? "empty-project"}
                name="projectPath"
                placeholder="/path/to/project"
              />
              <button type="submit">Use path</button>
            </form>
          </div>
        </header>
        {props.state.message === undefined ? null : (
          <div className="status-banner">{props.state.message}</div>
        )}
        <section className="workspace">{props.children}</section>
      </main>
    </div>
  );
}
