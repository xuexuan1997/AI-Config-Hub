# Desktop App Icon Design

## Goal

Give the Electron desktop app a recognizable, production-ready application icon for macOS, Windows, and Linux. The icon should look like a serious developer tool, remain readable at Dock/taskbar sizes, and fit the existing AI Config Hub UI palette.

## Chosen Direction

Use the first visual direction approved during brainstorming: a dark rounded-square base with a teal-to-blue gradient configuration hub mark.

The icon represents AI Config Hub as a local configuration asset workbench:

- A central configuration document or hub shape communicates config assets.
- Small connected nodes communicate multiple AI coding tools converging into one hub.
- Subtle glow/highlight treatment hints at AI assistance without turning the icon into a chip, bot, or generic model graphic.
- The palette stays close to the existing product UI: dark navy base, teal accent, blue accent, and light foreground details.

## Visual Requirements

- Base: rounded square suitable for app icons, using the existing dark navy family.
- Primary mark: bold geometric hub/configuration shape using a teal-to-blue gradient.
- Detail marks: one or two light horizontal config lines and small connection nodes.
- Small-size legibility: the silhouette must still read at 16, 32, and 64 px.
- No text inside the icon.
- No mascot, robot face, generic sparkle-only mark, or detailed network mesh.
- No one-note purple/purple-blue gradient treatment.

## Asset Requirements

The repository should keep an editable source icon under `apps/desktop/resources/icon.svg`.

Packaging should also have platform-friendly generated outputs:

- `apps/desktop/resources/icon.png` as the high-resolution PNG source for Linux and conversion tooling.
- `apps/desktop/resources/icon.icns` for macOS packaging.
- `apps/desktop/resources/icon.ico` for Windows packaging.

`apps/desktop/electron-builder.yml` should explicitly reference the icon so packagers do not depend on implicit discovery.

## Verification

Implementation should verify:

- The SVG is valid and renders without external dependencies.
- PNG/ICO/ICNS assets are generated from the same source.
- Electron Builder config includes icon paths for Linux, Windows, and macOS.
- Existing packaging configuration tests still pass.
