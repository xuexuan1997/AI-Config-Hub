# Desktop Minimum Window Layout Design

## Context

The desktop app is an Electron React interface with dense operational pages for asset review, asset migration, and settings. The current renderer already uses grid layouts and some overflow controls, but the whole desktop experience needs a consistent minimum usable canvas and clearer local overflow ownership.

## Goals

- Prevent the desktop window from being resized below a usable minimum.
- Make the renderer fill the available UI area at and above that minimum size.
- Keep long paths, long asset names, dense lists, tables, diagnostics, code blocks, and dialogs from expanding the global layout.
- Prefer truncation, wrapping, horizontal scrolling, and local vertical scrolling at the content region where overflow occurs.
- Cover the entire desktop renderer, not only one page.

## Non-Goals

- Redesigning the visual language, navigation model, or information architecture.
- Changing scan, migration, settings, deployment, or update behavior.
- Adding new user-facing controls.

## Design

### Electron Window Constraints

The Electron `BrowserWindow` should set a minimum width and height so the OS window cannot be resized below the smallest supported desktop canvas. The target minimum is `1024px` wide by `680px` high unless existing window tests show a nearby project convention that should be preserved.

This is the primary guardrail for tiny windows. Renderer CSS can still define matching minimums for layout stability, but the app should not rely on CSS alone to make an unusably small window behave well.

### Renderer Layout Baseline

The renderer root should treat the minimum desktop canvas as the base layout surface. `html`, `body`, `#root`, `.app-shell`, `main`, and `.workspace` should consistently use `min-width: 0`, `min-height: 0`, and height rules that allow children to fill available space without pushing the whole application larger than intended.

At normal desktop sizes, `.app-shell` fills the viewport, the sidebar keeps a stable width, and the main workspace consumes the rest. The main workspace should be a constrained grid/flex surface where route content can declare its own scroll areas.

### Page-Level Overflow Ownership

Asset review should keep its three-column workbench. The filter panel, central asset list, and detail panel should fill the available route height. The central asset list owns scrolling for tabs, grouped tables, and empty states. Tool/resource tabs can scroll horizontally. Long asset keys, paths, source cells, and status labels should truncate or wrap inside their cells without widening the page.

Asset migration should keep the source, summary, and target comparison layout. Source and target asset lists should scroll inside their panels. The summary column should stay bounded and scroll locally when preview metadata, blockers, confirmations, or controls exceed available height. Preview details, plan hashes, drift tables, and planned changes should use local scrolling or horizontal table overflow instead of expanding the page.

Settings should fill the main workspace without pretending to be a full-width dashboard. Its panel can keep a readable maximum width, while update actions, local data rows, result messages, and long explanatory text should wrap or truncate within the panel.

Asset detail dialogs should remain viewport-bounded. The dialog header stays visible, and the dialog body owns scrolling. Code blocks, diagnostics, definition lists, and status controls should not expand the dialog beyond its max dimensions.

### Responsive Behavior

Below wide desktop breakpoints, existing single-column fallbacks should remain intact. Because Electron now prevents resizing below the supported minimum canvas, the renderer only needs to remain stable at that minimum and larger sizes. The web build can keep existing responsive behavior.

## Testing

- Add or update Electron main-window tests to verify the configured minimum width and height.
- Add or update renderer layout tests for route structure and overflow-critical class contracts.
- Run the focused desktop tests with Node 24.
- Verify representative desktop pages visually at the minimum window size and at a normal desktop size.

## Acceptance Criteria

- The Electron desktop window cannot be resized smaller than the agreed minimum size.
- The desktop app fills the UI at the minimum size with no blank layout gaps caused by under-sized route containers.
- Asset review, asset migration, settings, and asset detail dialog content does not push the whole app wider or taller when local content is long.
- Dense local content uses truncation, wrapping, or local scrollbars according to the content type.
- Existing core desktop behavior and route navigation remain unchanged.
