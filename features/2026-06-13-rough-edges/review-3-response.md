# Review 3 — Response

Resolutions for every finding in [`review-3.md`](./review-3.md).

## 1. Blocking — packaged extension still downloads the old preview binary (FIXED)

`BINARY_VERSION` in `extension/src/lib.rs` is bumped `0.3.0` → `0.4.0` so the
release download path (`releases/download/v{BINARY_VERSION}`) fetches the binary
that matches the shipped manifest.

To stop the version from drifting again, a unit test now asserts the constant
tracks the manifest. `manifest_version()` parses the top-level `version` out of
`include_str!("../extension.toml")` (stopping at the first `[table]` so
`schema_version` and nested-table keys can't be picked up), and
`test_binary_version_matches_manifest` fails the build if it ever diverges from
`BINARY_VERSION`. Bumping one without the other now breaks `cargo test`.

- Tests: `test_binary_version_matches_manifest` (extension crate, 8 unit tests).

## 2. Major — external reloads not reconciled with the dirty baseline (FIXED)

SSE reload is now a first-class **clean baseline transition** rather than a blind
`updateScene`. The logic is extracted to the pure `applyExternalReload()` helper
in `dirty-state.ts`, which the component's `reloadScene` callback drives through
the relevant refs/`reportDirty`:

1. **Skips mid-text-edit** (unchanged guard) so the editor isn't clobbered.
2. **Applies persisted/visual appState from disk** — only the
   `PERSISTED_APP_STATE_KEYS` subset (background, grid, export settings) via the
   new `pickPersistedAppState()` picker — so a `viewBackgroundColor` change on
   disk is reflected, while viewport pan/zoom, selection, and theme are never
   touched.
3. **Re-baselines dirty bookkeeping:** sets `prevHashRef` to the fingerprint of
   the freshly-applied live scene (so the `onChange` the reload triggers no-ops),
   clears `dirtyRef`/`firstDirtyAt`, cancels any pending auto-save timer, and
   `reportDirty(false, false)`. `lastSavedAt` is deliberately left unset — an
   external change is not a save by this WebView, so the last-save timestamp must
   not move.

This closes the auto-save echo: previously the reloaded scene read as a fresh
edit and, under auto-save, was written straight back over the just-accepted
external change; even without auto-save it produced a spurious dirty close prompt.

- Tests (`dirty-state.test.ts`): `applyExternalReload` harness — re-baseline then
  a simulated `onChange` proves **no dirty/auto-save transition** for the accepted
  disk scene; persisted appState applied but viewport/zoom dropped; mid-text-edit
  skip; appState patch omitted when disk has no persisted keys.
- Tests (`scene-fingerprint.test.ts`): `pickPersistedAppState` — keeps
  persisted/visual keys, drops viewport/selection/theme, omits `undefined`, and
  stays consistent with the appState fingerprint.

## Testing gaps (addressed)

- **Extension release/download version** is now covered by
  `test_binary_version_matches_manifest`, which is exactly what would have caught
  the `0.3.0`/`0.4.0` drift.
- **External SSE reload behavior** now has frontend coverage proving an accepted
  reload neither marks the scene dirty nor schedules an auto-save echo.
- The native close/save state machine and macOS `Cmd+S` / Dock / external-link /
  SVG-font items remain WebView-only manual steps in
  [`manual-checklist.md`](./manual-checklist.md).

## Verification performed

- `cargo test -p excalidraw-preview`: 8 unit tests pass (was 7).
- `cargo clippy -p excalidraw-preview --all-targets -- -D warnings`: clean.
- `npm run typecheck && npm test -- --run` in `preview-binary/webview-src`:
  38 Vitest tests pass (was 30).
