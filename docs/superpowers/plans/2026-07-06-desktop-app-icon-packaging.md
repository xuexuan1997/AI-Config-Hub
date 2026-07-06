# Desktop App Icon Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the approved desktop icon as real Electron packaging assets for Linux, Windows, and macOS.

**Architecture:** Keep `apps/desktop/resources/icon.svg` as the editable source. Generate platform assets beside it, and make `apps/desktop/electron-builder.yml` reference each platform icon explicitly. Extend the existing packaging contract test so future config changes cannot silently drop icon wiring.

**Tech Stack:** Electron Builder 26, Node 24, macOS `sips`/`iconutil`, Node `node:test` packaging contracts.

---

### Task 1: Add Failing Packaging Contract

**Files:**
- Modify: `tests/packaging/config.test.mjs`

- [ ] **Step 1: Add assertions before implementation**

Add checks that `apps/desktop/electron-builder.yml` contains top-level and per-platform icon references, and that the generated icon files exist:

```js
assert.match(config, /^icon: resources\/icon\.png$/m);
assert.match(config, /linux:[\s\S]*icon: resources\/icon\.png/);
assert.match(config, /win:[\s\S]*icon: resources\/icon\.ico/);
assert.match(config, /mac:[\s\S]*icon: resources\/icon\.icns/);
```

Use `stat` from `node:fs/promises` to assert:

```js
for (const iconPath of [
  "apps/desktop/resources/icon.svg",
  "apps/desktop/resources/icon.png",
  "apps/desktop/resources/icon.ico",
  "apps/desktop/resources/icon.icns",
]) {
  assert.ok((await stat(iconPath)).size > 0, `${iconPath} should be present`);
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```sh
eval "$(fnm env --use-on-cd)" && fnm use 24 && node --test tests/packaging/config.test.mjs
```

Expected: FAIL because the config does not yet reference icon paths and generated `icon.png`, `icon.ico`, and `icon.icns` are absent.

### Task 2: Implement Icon Source and Builder Config

**Files:**
- Modify: `apps/desktop/resources/icon.svg`
- Modify: `apps/desktop/electron-builder.yml`

- [ ] **Step 1: Update the SVG source**

Keep the approved dark rounded-square base and teal-to-blue config hub mark, adding small connection nodes for the hub concept while preserving small-size legibility.

- [ ] **Step 2: Wire Electron Builder icons**

Add:

```yml
icon: resources/icon.png
```

Add under platform sections:

```yml
linux:
  icon: resources/icon.png
win:
  icon: resources/icon.ico
mac:
  icon: resources/icon.icns
```

### Task 3: Generate Platform Assets

**Files:**
- Create: `apps/desktop/resources/icon.png`
- Create: `apps/desktop/resources/icon.ico`
- Create: `apps/desktop/resources/icon.icns`

- [ ] **Step 1: Generate PNG sizes from SVG**

Use `sips` to render the SVG into 16, 32, 64, 128, 256, 512, and 1024 px PNGs.

- [ ] **Step 2: Generate ICNS**

Use `iconutil -c icns` with a temporary `.iconset` containing `icon_16x16.png`, `icon_16x16@2x.png`, `icon_32x32.png`, `icon_32x32@2x.png`, `icon_128x128.png`, `icon_128x128@2x.png`, `icon_256x256.png`, `icon_256x256@2x.png`, `icon_512x512.png`, and `icon_512x512@2x.png`.

- [ ] **Step 3: Generate ICO**

Use a Node script snippet to write a standard ICO file containing PNG frames at 16, 32, 48, 64, 128, and 256 px.

### Task 4: Verify and Commit

**Files:**
- Verify: `tests/packaging/config.test.mjs`
- Verify: `apps/desktop/resources/icon.svg`
- Verify: `apps/desktop/electron-builder.yml`

- [ ] **Step 1: Run focused packaging tests**

```sh
eval "$(fnm env --use-on-cd)" && fnm use 24 && node --test tests/packaging/config.test.mjs
```

- [ ] **Step 2: Inspect asset files**

```sh
file apps/desktop/resources/icon.svg apps/desktop/resources/icon.png apps/desktop/resources/icon.ico apps/desktop/resources/icon.icns
```

- [ ] **Step 3: Commit**

```sh
git add tests/packaging/config.test.mjs apps/desktop/electron-builder.yml apps/desktop/resources/icon.svg apps/desktop/resources/icon.png apps/desktop/resources/icon.ico apps/desktop/resources/icon.icns docs/superpowers/plans/2026-07-06-desktop-app-icon-packaging.md
git commit -m "feat: add desktop app icons"
```
