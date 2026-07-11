# Desktop Editorial Matrix — Final Design QA

## Comparison target

- Source visual truth: `docs/design-reference/desktop-editorial-matrix.png`
- Final Assets, matched viewport: `test-results/wrap-audit-final2/06-assets-populated-zh-1536.png`
- Final Assets, minimum desktop: `test-results/wrap-audit-final2/07-assets-populated-zh-1024.png`
- Final Assets, long-title detail: `test-results/wrap-audit-final2/08-asset-detail-zh-1024.png`
- Final active scan modal: `test-results/wrap-audit-final2/05-assets-scan-modal-zh-1024.png`
- Final Migration, matched viewport: `test-results/wrap-audit-final2/11-migration-populated-zh-1536.png`
- Final Migration, minimum desktop: `test-results/wrap-audit-final2/12-migration-populated-zh-1024.png`
- Final Migration preview, blocked: `test-results/wrap-audit-final2/13-migration-preview-blocked-zh-1024.png`
- Final Migration preview, ready: `test-results/wrap-audit-final2/14-migration-preview-ready-zh-1024.png`
- Final Migration target details: `test-results/wrap-audit-final2/15-migration-target-details-zh-1024.png`
- Final Settings, matched viewport: `test-results/wrap-audit-final2/16-settings-top-zh-1536.png`
- Final Settings, English minimum desktop: `test-results/wrap-audit-final2/18-settings-top-en-1024.png`
- Final Settings, English lower content: `test-results/wrap-audit-final2/19-settings-bottom-en-1024.png`
- Final English Assets and long-title detail: `test-results/wrap-audit-final2/20-assets-populated-en-1024.png`, `test-results/wrap-audit-final2/21-asset-detail-en-1024.png`
- Final English Migration preview: `test-results/wrap-audit-final2/22-migration-preview-en-1024.png`
- Geometry and renderer-health report: `test-results/wrap-audit-final2/report.json`
- Viewports: 1536 × 1025 and 1024 × 700 CSS pixels.
- Theme and state: light theme, Simplified Chinese and English, real Electron renderer, isolated local projects, empty/populated pages, active scans, a deliberately long logical key, completed source/target scans, blocked/ready previews, and target details.

## Findings

- No actionable P0, P1, or P2 findings remain.
- The final automated typography pass inspected 22 live Electron states. It measured text line rectangles, scroll/client geometry, deliberate ellipsis contracts, document overflow, and compact-preview clipping for every navigation item, button, tab, badge, table header/cell, summary metric, project label, settings token, dialog heading, and confirmation item in scope. The final report contains zero unexpected wraps, zero unhandled overflows, and zero compact-panel clipping findings.
- A persistent Playwright/Electron regression now repeats the critical 1024 × 700 checks through Assets, asset detail, Migration empty/blocked/ready/completed/failed states, and Settings top/bottom. It measures actual rendered text lines and rejects unapproved overflow or compact-panel clipping.
- The document root has zero vertical overflow at both viewports. Long collections scroll only inside their bounded list regions.
- At 1024 × 700, Assets shows six complete asset rows and two complete diagnostic rows. Migration keeps source, summary, and target columns in the same viewport, including the target list.
- The blocked migration preview shows both confirmation controls, the complete validation message, and the disabled execution button. The ready state shrinks to a 78 px execution strip and exposes an enabled execution button without cropped content. Scrolling the local preview region moves the execution strip away and reveals warnings, field-loss, hashes, and diffs.
- The final renderer captures emitted no page errors and no console errors.
- Long identifiers now remain one line in summary, preview, scan-modal, table, and drawer contexts. Full values remain available through `title` where visual ellipsis is used; complete paths continue to wrap in dedicated detail surfaces where wrapping is intentional.

## Full-view comparison evidence

The source visual truth and representative final Assets, long-title detail, Migration, preview, and Settings screenshots from `wrap-audit-final2` were opened together in one comparison input after the last code change. The final implementation retains the source's editorial desktop composition: top navigation, restrained porcelain surfaces, cobalt active states, flat dense rows, semantic status color, compact resource switching, and high information density.

Assets now gives the table and diagnostic band the same visual priority as the source. The former project-selection content row and successful-scan status row no longer displace content. Project context remains once in the global header; refresh, scan, and folder selection sit in a compact upper-right icon toolbar. The empty wide-screen inspector collapses until requested, while the existing rich detail drawer remains functional.

Migration uses the same hierarchy and visual language. Its project picker is a compact 52–54 px row, its resource tabs share the same type markers as Assets, and its comparison body remains a three-column matrix down to 1024 px. Preview controls are a bounded execution strip rather than a tall card stack.

## Focused-region comparison evidence

- Header and project actions: folder selection is a neutral icon-only action, scan is the cobalt primary action, and refresh remains secondary. Localized `aria-label` and `title` values preserve meaning without visible button text.
- Resource identity: Rule, Agent, Skill, MCP, and Settings use the same bordered color-token marker in tabs and rows. Icons come from the installed Phosphor library; no custom SVG, CSS drawing, emoji, or text glyph substitutes were introduced.
- Asset rows: enabled-state duplication was removed; disabled remains explicitly visible. Diagnostic counts use semantic icons, singular/plural accessible titles, and an em dash for zero diagnostics.
- Diagnostic band: filters and two 46 px result rows are fully visible at the minimum viewport, including the final fractional-pixel correction from 139 px to 140 px.
- Migration summary: `全部资源类型` explicitly states why totals can differ from the active resource tab.
- Migration target rows: type icon, logical key, status, compact metadata, and details affordance fit in flat 50 px rows rather than stretched or stacked cards.
- Preview execution: `13-migration-preview-blocked-zh-1024.png` and `14-migration-preview-ready-zh-1024.png` verify both state treatments; `15-migration-target-details-zh-1024.png` verifies expanded target detail. Active-task and recovery-lock states continue to use the expanded layout instead of compact clipping rules.
- Detail drawer: `08-asset-detail-zh-1024.png` and `21-asset-detail-en-1024.png` show the existing inspect workflow with a deliberately long title fully inside the content viewport.
- Single-line controls: the current screenshots verify that navigation, toolbar actions, tabs, table headers, metric labels, plan metadata, settings tokens, dialog titles, and execution confirmations never split internally. At constrained widths the complete control moves or its dynamic value ellipsizes as one token.
- Long-title behavior: the audit fixture `rule:this-is-a-very-long-project-rule-name-that-must-stay-on-one-line` remains a single row and a single drawer-title line. The table keeps its scope metadata visible without the previous double-ellipsis artifact.
- Active scan behavior: the queue task identifier is a deliberate single-line ellipsis inside the modal; status, heading, and cancel action remain fully visible, and the dialog gains a bounded internal scroll region for low-height failure content.

## Required fidelity surfaces

- Fonts and typography: the existing system/Inter stack is retained. Title, navigation, table, metadata, and diagnostic weights preserve the source hierarchy. Long paths and identifiers truncate in rows and wrap only in detail surfaces.
- Spacing and layout rhythm: flat borders, low radii, compact 36–54 px controls, 46 px source rows, bounded diagnostic rows, and consistent page margins replace the earlier stacked-card density. No persistent control is hidden by viewport overflow.
- Colors and visual tokens: existing background, border, text, cobalt, teal, orange, warning, danger, and focus tokens are reused. Resource markers add restrained semantic tint while remaining compatible with the existing light/dark token system. Light-theme muted text now measures 4.95:1 against the soft panel surface.
- Image quality and asset fidelity: the product brand asset remains unchanged and sharp. All new visible symbols are library icons sized to their measured slots. No raster placeholder or generated image was needed.
- Copy and content: duplicated project paths, redundant success summaries, repeated diagnostic totals, and repeated enabled state were removed. Existing app-specific behavior copy and localized accessibility labels remain intact.
- Icons and affordances: tool/resource markers, severity icons, folder controls, swap, preview, inspect, refresh, and scan share a single stroke family and consistent optical alignment.
- Accessibility: semantic tabs, tables, buttons, labels, fieldsets, dialogs, disabled states, focus behavior, and localized accessible names remain in place. Each compact diagnostic number now exposes its severity and count through `aria-label`; muted small text meets WCAG AA contrast. The detail drawer opens and closes through the existing dialog workflow.

## Runtime measurements

| Surface                    |     1536 × 1025 |      1024 × 700 |
| -------------------------- | --------------: | --------------: |
| Assets page header         |        78.46 px |        61.86 px |
| Assets review stage        |       806.22 px |       534.15 px |
| Fully visible asset rows   |              12 |               6 |
| Diagnostic panel           | 140 px / 2 rows | 140 px / 2 rows |
| Migration project picker   |        52.18 px |        53.59 px |
| Migration resource tabs    |        38.65 px |           39 px |
| Migration comparison stage |       685.64 px |       418.56 px |
| Migration preview, blocked |               — |          104 px |
| Migration preview, ready   |               — |           78 px |
| Migration target row       |           50 px |           50 px |
| Muted text contrast        |          4.95:1 |          4.95:1 |
| Document root overflow     |            0 px |            0 px |

## Primary interactions tested

1. Chose an Assets project through the native folder control and waited for the real scan to complete.
2. Opened the first asset detail drawer, verified its bounds, and closed it.
3. Navigated to Migration, independently chose source and target projects, and waited for both scans and target rows.
4. Created a migration preview at 1024 × 700.
5. Verified the blocked state, selected every required confirmation, and asserted that `执行迁移` became enabled.
6. Scrolled the compact preview region and asserted that the warning became fully visible with a non-zero local scroll offset.
7. Verified active-task and recovery-lock markup selects the expanded execution layout.
8. Checked renderer page errors and console errors across the full sequence; both arrays were empty.

## Comparison history

1. P1 — Assets retained a completed successful scan row and showed only four rows at 1024 × 700. Fixed by removing non-actionable success persistence and reassigning height to the review stage. Post-fix evidence: `full-row-audit-round1/02-assets-1024x700.png`.
2. P1 — Assets reserved roughly one-third of the minimum viewport for an empty detail rail; tool filters also expanded to full-width blocks. Fixed by collapsing the empty rail and explicitly sizing tool controls. Post-fix evidence: final Assets screenshots.
3. P1 — Migration changed to two columns at 1024 px, pushing Target Assets below the viewport. Fixed by retaining a responsive three-column grid with bounded inner scrollers. Post-fix evidence: `full-row-audit-round1/04-migration-1024x700.png` and the final equivalent.
4. P1 — Migration preview used a tall nested-scroll layout that hid confirmations and the execution CTA. Fixed with a compact execution strip, then iterated to keep the validation message fully visible. Post-fix evidence: the final blocked and ready preview screenshots.
5. P2 — Assets duplicated filter hierarchy, diagnostic totals, enabled state, and a wide empty inspector. Fixed by flattening the hierarchy, using one diagnostic control surface, showing only exceptional disabled state, and collapsing the empty rail.
6. P2 — Project selection was visually primary while scan was visually quiet. Fixed by making scan cobalt-primary and folder selection neutral, keeping both icon-only.
7. P2 — Resource identity used inconsistent naked icons and Migration target rows lacked matching markers. Fixed with one bordered, color-tokenized Phosphor marker system across both pages.
8. P2 — Migration summary totals appeared to conflict with the active tab. Fixed by labeling the summary scope `全部资源类型`.
9. P2 — Migration target rows were tall card stacks. Fixed by flattening their surfaces, compacting metadata, and aligning type/status/detail affordances.
10. P2 — The first compact preview pass exposed only the top edge of validation or supplemental content. Fixed by allocating 104 px while blocked and 78 px when ready, with the execution panel exactly filling the visible strip.
11. P1 — A final code audit found that making the execution strip sticky would cover the warning, field-loss, hash, and diff content during local scrolling, and compact overflow rules could clip recovery status. Fixed by making the compact strip static and scoping every compact rule to `data-layout="compact"`; active-task and recovery-lock states now select `expanded`. Post-fix evidence: the scrolled-details screenshot and layout assertions.
12. P2 — CSS Grid stretched one or six target rows to fill all remaining height. Fixed with `align-content: start` and `grid-auto-rows: max-content`; both viewports now measure every target row at 50 px.
13. P2 — Diagnostic counts depended on `title` for their severity name, and muted 0.62–0.8 rem text had sub-AA contrast. Fixed with explicit diagnostic `aria-label` values and a `#666b75` muted token that measures 4.95:1 on the soft panel.
14. Final post-fix comparison found no remaining actionable P0, P1, or P2 issue.
15. P1 — `未变化的计划输出` wrapped at 1024 px; all four English summary labels wrapped by two or three lines. Fixed with a single-line metric contract, deliberate ellipsis, and full-value tooltips.
16. P1 — Plan ID, plan hash, and confirmation metadata wrapped into two to four lines, consuming the narrow summary column. Fixed with one-line truncation and full-value `title` attributes.
17. P1 — English confirmation items inherited a 40 px input minimum, pushing required confirmations outside the fixed 76 px execution strip. Fixed by restoring the compact 15 px checkbox minimum, keeping each confirmation atomic, and allowing confirmation items—not their text—to wrap.
18. P2 — Long asset names produced a double ellipsis and raised the detail title; scan queue IDs also split mid-identifier. Fixed with a flex-bounded primary cell, one deliberate ellipsis per value, a one-line drawer title, and a one-line modal task detail.
19. P2 — Independent final review found the compact confirmation-group legend was removed with `display: none`. Fixed with a standard visually-hidden treatment so the fieldset keeps its accessible name without consuming layout space. The same review prompted full-path hover text for the abbreviated global project context.
20. Final post-fix geometry audit across 22 states reported zero unexpected wraps/overflows, zero renderer errors, and zero console errors; the subsequent accessibility-only change does not alter geometry or screenshots.
21. The final test audit found stale E2E expectations for full visible paths and removed scan-completion copy. Fixed by asserting the new basename plus full-path tooltip contract and waiting on indexed content. The complete desktop E2E suite now passes with the runtime single-line checks enabled.

## Open questions

- None blocking. The source image uses a persistent populated inspector; this product intentionally keeps its richer existing drawer interaction. Collapsing the empty rail preserves that functionality while prioritizing density.

## Implementation checklist

- [x] Compact and relocate project actions without removing behavior.
- [x] Preserve all core Assets interactions and diagnostics.
- [x] Keep Migration source, summary, and target visible at 1024 × 700.
- [x] Keep confirmation, validation, and execution controls fully visible.
- [x] Use one icon family and one resource marker system.
- [x] Verify blocked, ready, scrolled-detail, active-task, and recovery preview states, root overflow, row height, contrast, drawer bounds, tests, build, and console output.
- [x] Verify all three routes in Chinese and English at 1024 × 700, plus representative 1536 × 1025 states.
- [x] Verify active scan, long logical key, long plan/hash, blocked/ready confirmation, and Settings top/bottom states with runtime line and overflow measurements.
- [x] Keep the minimum-window text-line, overflow, tooltip, and compact-preview checks in the persistent desktop E2E suite.

## Follow-up polish

- P3: native title tooltips remain intentional until the product adopts a global custom-tooltip component.

final result: passed
