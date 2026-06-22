# Secure Electron Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the functional Electron/React desktop manager with a strictly constrained preload API and five complete workspaces.

**Architecture:** Electron main owns all privileged services and registers validated business IPC handlers. Preload exposes a frozen named API built on `packages/api`; the React renderer is browser-only and renders overview, assets, migration/deployment, and history workflows.

**Tech Stack:** Electron 42.4.1, React 19.2.7, Vite 8.0.16, TypeScript, Playwright 1.61.0, Vitest

---

### Task 1: Add desktop toolchain and build boundaries

**Files:**
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/tsconfig.renderer.json`
- Modify: `apps/desktop/tsconfig.build.json`
- Modify: `pnpm-lock.yaml`
- Modify: `dependency-cruiser.mjs`

- [ ] **Step 1: Write failing workspace boundary tests**

Extend `tests/tooling/workspace.test.mjs` to require exact desktop versions, main/preload/renderer scripts, and forbid renderer imports from Node built-ins, Electron, storage, deployer, scanner, adapters, or git packages.

Run: `node --test tests/tooling/workspace.test.mjs`

Expected: FAIL because desktop dependencies and scripts are missing.

- [ ] **Step 2: Pin the toolchain**

Add exact dependencies: `react@19.2.7`, `react-dom@19.2.7`; exact dev dependencies: `electron@42.4.1`, `electron-builder@26.15.3`, `vite@8.0.16`, `@vitejs/plugin-react@6.0.2`, `@types/react@19.2.17`, and `@types/react-dom@19.2.3`. Add scripts `dev`, `build:main`, `build:renderer`, `build`, `test`, `test:e2e`, and `package:linux`.

- [ ] **Step 3: Configure build separation and commit**

Main/preload compile to `dist/main`; renderer Vite output goes to `dist/renderer`. Add dependency-cruiser rules matching `apps/desktop/src/renderer/**` against privileged modules.

Run: `pnpm install && node --test tests/tooling/workspace.test.mjs && pnpm typecheck && pnpm lint`

Expected: all checks pass.

Commit:

```bash
git add apps/desktop package.json pnpm-lock.yaml dependency-cruiser.mjs tests/tooling/workspace.test.mjs
git commit -m "build(desktop): add secure Electron React toolchain"
```

### Task 2: Implement Electron main and constrained preload

**Files:**
- Create: `apps/desktop/src/main/main.ts`
- Create: `apps/desktop/src/main/composition.ts`
- Create: `apps/desktop/src/main/ipc.ts`
- Create: `apps/desktop/src/preload/preload.ts`
- Create: `apps/desktop/src/preload/api.ts`
- Create: `apps/desktop/src/preload/api.test.ts`
- Delete: `apps/desktop/src/index.ts`

- [ ] **Step 1: Write failing security contract tests**

Mock only Electron boundary objects. Assert BrowserWindow receives `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, an explicit preload path, denied navigation/window opening, no shell exposure, and exactly the named API methods. Assert malformed IPC requests never reach application services and task unsubscribe removes listeners.

Run: `pnpm --filter @ai-config-hub/desktop test`

Expected: FAIL because main/preload modules are absent.

- [ ] **Step 2: Implement named desktop API**

Expose this frozen renderer shape:

```ts
export interface DesktopApi {
  invoke<Name extends ApiCommandName>(name: Name, payload: CommandRequest<Name>): Promise<ApiResponse<CommandResponse<Name>>>;
  subscribeTask(taskId: string, afterSequence: number, listener: (event: TaskEvent) => void): () => void;
  selectProjectRoot(): Promise<string | undefined>;
  appVersion(): Promise<string>;
}
```

`selectProjectRoot` is the only native dialog and returns one validated absolute directory selected by the user. Do not expose `ipcRenderer`, channel strings, filesystem paths other than selected roots, or Electron objects.

- [ ] **Step 3: Compose main services**

Open the SQLite database under `app.getPath("userData")`, run migrations before handlers, create adapter registry/scanner/deployer/local history/application services, register exact command channels, request a single-instance lock, and close watchers/database during `before-quit`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @ai-config-hub/desktop test && pnpm typecheck && pnpm lint`

Expected: security contracts and static boundaries pass.

Commit:

```bash
git add apps/desktop
git commit -m "feat(desktop): add secure main and preload boundaries"
```

### Task 3: Build the five-workspace React UI

**Files:**
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/main.tsx`
- Create: `apps/desktop/src/renderer/app.tsx`
- Create: `apps/desktop/src/renderer/model.ts`
- Create: `apps/desktop/src/renderer/components/app-shell.tsx`
- Create: `apps/desktop/src/renderer/views/overview.tsx`
- Create: `apps/desktop/src/renderer/views/assets.tsx`
- Create: `apps/desktop/src/renderer/views/migration.tsx`
- Create: `apps/desktop/src/renderer/views/deployment.tsx`
- Create: `apps/desktop/src/renderer/views/history.tsx`
- Create: `apps/desktop/src/renderer/styles.css`
- Create: `apps/desktop/src/renderer/app.test.tsx`

- [ ] **Step 1: Write failing renderer workflow tests**

Test empty/loading/partial/error/recovery states; project selection and scan progress; tool/resource filters; asset detail and provenance; conversion compatibility and diff; required confirmations; deployment result; history diff; rollback preview. Use a fake `DesktopApi`, not Electron or filesystem mocks.

Run: `pnpm --filter @ai-config-hub/desktop test`

Expected: FAIL because renderer components are absent.

- [ ] **Step 2: Implement state model and shell**

Create one reducer-based model containing route, selected root/tool/resource, request states, active task, fresh preview, confirmations, and recovery lock. The app shell provides left navigation, filter header, task drawer, status banner, and content outlet. Disable deployment unless preview plan hash is present and every required confirmation is checked.

- [ ] **Step 3: Implement workspaces**

Each view calls only `DesktopApi`. Use semantic HTML tables, buttons, dialogs, details, and code blocks; keyboard focus returns to the triggering control after dialogs; diagnostics show severity/code/action; secrets render `••••` plus reference kind; unified diffs are bounded and horizontally scrollable.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @ai-config-hub/desktop test && pnpm --filter @ai-config-hub/desktop build && pnpm typecheck && pnpm lint`

Expected: renderer tests/build and repository boundaries pass.

Commit:

```bash
git add apps/desktop
git commit -m "feat(desktop): implement configuration manager workspaces"
```

### Task 4: Add Electron end-to-end workflows

**Files:**
- Create: `tests/e2e/desktop.spec.ts`
- Create: `tests/e2e/fixtures/claude/CLAUDE.md`
- Create: `tests/e2e/fixtures/cursor/.cursor/rules/project.mdc`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Write E2E test against a packaged-like build**

Launch Electron with isolated `AI_CONFIG_HUB_E2E_ROOT` and `AI_CONFIG_HUB_USER_DATA`. Exercise first scan, asset/provenance inspection, Claude-to-Cursor preview, confirmation, deployment verification, history entry, rollback preview, rollback, and restored fixture bytes. Assert generic navigation and new windows are denied.

- [ ] **Step 2: Run E2E and fix only observed failures**

Run: `pnpm --filter @ai-config-hub/desktop build && pnpm test:e2e`

Expected: desktop E2E passes on Linux with a virtual display and leaves source fixtures unchanged.

- [ ] **Step 3: Run full gate and commit**

Run: `pnpm test && pnpm test:integration && pnpm test:e2e && pnpm typecheck && pnpm lint && pnpm build`

Expected: every command exits 0.

Commit:

```bash
git add tests/e2e playwright.config.ts
git commit -m "test(desktop): verify scan deploy and rollback flows"
```
