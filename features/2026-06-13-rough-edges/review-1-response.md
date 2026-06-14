# Review 1 — Response

Resolutions for every finding in [`review-1.md`](./review-1.md).

## 1. Blocking — auto-selected ports race (FIXED)

`main.rs` now **binds first**: it binds `127.0.0.1:0` (or the requested `--port`),
reads the assigned port back via `local_addr().port()`, and only then writes the
lock file. The OS hands out the ephemeral port atomically, so there is no
time-of-check/time-of-use window. `find_available_port()` (the probe-then-drop
helper) and its test were removed. An occupied `--port` now fails cleanly at bind.

- Regression test: `concurrent_previews_bind_distinct_ports_and_serve` (integration)
  starts five previews at once and asserts distinct ports + all serving.

## 2. Blocking — stale save clears dirty state (FIXED)

`doSave()` now captures `savedHash = computeSceneHash(...)` for the exact snapshot
it posts. On a successful response it only clears dirty state when the latest
observed hash (`prevHashRef.current`) still equals `savedHash`. If newer edits
arrived mid-flight it stays dirty (and, under auto-save, reschedules a save and
restarts the max-wait window). Decision extracted to the pure
`resolveDirtyAfterSave()` helper.

- Tests: `dirty-state.test.ts` (covers match, mismatch manual, mismatch auto-save,
  null-current).

## 3. Blocking — native library export can export empty library (FIXED)

`libraryItemsRef` is now seeded from `initialData.libraryItems` on mount via
`initialLibraryItems()`, so an Export Library… before any `onLibraryChange` writes
the saved items. Added an "Imported N library item(s)" success toast on import.

- Tests: `initialLibraryItems` in `dirty-state.test.ts`; manual export-before-edit
  step in `manual-checklist.md`.

## 4. Major — dirty fingerprint incomplete (FIXED)

`computeSceneHash` moved to `scene-fingerprint.ts` and enriched:
- **Files:** each file fingerprinted by `id : mimeType : dataURL.length : fnv1a(dataURL)`
  so data populated/replaced under an existing id is detected (not just id set changes).
- **AppState:** an explicit `PERSISTED_APP_STATE_KEYS` list covering background,
  grid, and export settings (`exportBackground/EmbedScene/Scale/WithDarkMode`,
  `name`, `frameRendering`), each JSON-stringified. Viewport/selection still excluded.

- Tests: `scene-fingerprint.test.ts` (15 cases incl. "data populated under existing
  id", export-setting changes, nested `frameRendering`, viewport-ignored).

## 5. Major — close-save timeout leaks pending-action entries (FIXED)

`CloseFlow::Waiting` now carries its `request_id`. `poll_close_flow()` takes
`&PendingActions` and evicts the entry when the flow ends by timeout or channel
drop (a normal `/native-action-result` already removes it).

- Tests: `test_poll_close_flow_evicts_pending_entry_on_timeout`,
  `…_on_channel_drop`, and `…_still_waiting_keeps_entry`.

## 6. Major — default integration command unreliable (FIXED)

With the bind-first fix, `cargo test -p excalidraw-preview-binary` passes under the
default threaded runner (35→37 unit + 11 integration, all green). The
`serial-integration` test-group workaround was removed from `.config/nextest.toml`;
nextest now runs the integration suite fully parallel (48 tests passing).

## 7. Minor — embedded SVG example not re-exported (FOLLOW-UP)

`docs/architecture.excalidraw.svg` already inlines its fonts as a base64
`data:font/woff2` `@font-face` `src`, so it renders standalone today. Re-exporting
to pick up the full hand-drawn font set requires the GUI (the Excalidraw client-side
exporter), which can't run in this headless pass. Tracked as a follow-up:

> **Follow-up:** open `docs/architecture.excalidraw.svg` in the built preview and
> re-export via **File → Export SVG** so the embedded fonts come from the fixed
> `/assets/fonts/**` path, then commit the regenerated file.

## Testing gaps

Added focused coverage by extracting pure helpers (`scene-fingerprint.ts`,
`dirty-state.ts`) — see the new Vitest files (25 webview tests total) and the Rust
close-flow tests. WebView-only native paths (menus, dialogs, external links, font
rendering) are captured in [`manual-checklist.md`](./manual-checklist.md).
