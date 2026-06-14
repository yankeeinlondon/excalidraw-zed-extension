---
ready: false
---

# Review 1

## Findings

### 1. Blocking: auto-selected ports race under concurrent starts

`preview-binary/src/main.rs:283` calls `find_available_port()`, then writes the chosen port to the lock file before actually binding it at `preview-binary/src/main.rs:300-303`. `find_available_port()` itself only probes by binding and immediately dropping the listener (`preview-binary/src/main.rs:525-529`).

This is a time-of-check/time-of-use race. When several preview instances start at once for different files, they can all choose the same free port and then all but one fail with `Address already in use`. This also breaks the spec's verification command: `cargo test -p excalidraw-preview-binary` failed in the integration suite with port conflicts and connection resets. The same suite only passed when forced serial with `--test-threads=1`.

Suggested fix: bind first and keep the `TcpListener`, then get `local_addr().port()` from the bound listener and only then write the lock file. For `--port`, use the same single bind path and fail cleanly if the requested port is occupied. In integration tests, either pass unique `--port` values or rely on the fixed bind-first implementation.

### 2. Blocking: a stale save response can clear dirty state after newer edits

`doSave()` snapshots the scene at `preview-binary/webview-src/src/App.tsx:221-223`, posts it, and on any successful response unconditionally clears `dirtyRef`, `firstDirtyAt`, and Rust's dirty state at `preview-binary/webview-src/src/App.tsx:259-263`.

If the user edits while that save is in flight, `handleChange()` records the newer hash at `preview-binary/webview-src/src/App.tsx:328-335`, but the older save response can still arrive afterward and mark the scene clean. Closing the window after that can skip the unsaved-changes dialog and lose the newer edit. This is especially relevant because the spec explicitly added close-confirm and auto-save reliability.

Suggested fix: track the hash or monotonically increasing revision that was saved. Only clear dirty state if the current scene hash/revision still matches the saved snapshot when the POST resolves. Otherwise leave `dirtyRef` true, keep/report pending state, and schedule another save when auto-save is enabled.

### 3. Blocking: native library export can export an empty library

The app loads persisted library items in `preview-binary/webview-src/src/main.tsx:65-72` and passes them through `initialData` at `preview-binary/webview-src/src/main.tsx:116-119`, but `libraryItemsRef` is initialized to an empty array in `preview-binary/webview-src/src/App.tsx:143-145`. It is only updated from `onLibraryChange()` at `preview-binary/webview-src/src/App.tsx:399-403`.

If the user opens the preview and immediately chooses native `Export Library...`, the exported payload at `preview-binary/webview-src/src/App.tsx:490-494` can contain `libraryItems: []` even though the library panel was initialized with saved items. That violates the spec's native export requirement.

Suggested fix: seed `libraryItemsRef` from `initialData.libraryItems` on mount, and add a frontend unit test for exporting before any `onLibraryChange` event. Also consider showing a toast after import success so the user gets feedback.

### 4. Major: file and app-state dirty tracking is still incomplete

`computeSceneHash()` only includes element versions, file keys, `viewBackgroundColor`, and `gridSize` (`preview-binary/webview-src/src/App.tsx:89-98`). The spec called out tracking elements, app state, and files, including image/file registry updates and export settings. Hashing only file IDs misses changes where a file entry is populated or updated under an existing ID. Hashing only two app-state fields misses export-related state and any other persisted app-state changes that `serializeAsJSON()` writes.

Suggested fix: build the dirty fingerprint from the serialized persisted scene shape, or from a stable subset that matches what `serializeAsJSON(elements, appState, files, "local")` will write. At minimum, include file metadata/data hashes and all persisted app-state keys relevant to Excalidraw saves and exports.

### 5. Major: close-save timeout leaves stale pending-action entries

`begin_save_close()` inserts a request ID into `pending_actions` at `preview-binary/src/main.rs:1104-1108`, but `poll_close_flow()` does not remove that entry on timeout or channel drop. A timed-out close attempt keeps the old sender in the map until a late `/native-action-result` arrives, and repeated close attempts can accumulate stale entries.

Suggested fix: store the request ID in `CloseFlow::Waiting` and remove it from `pending_actions` whenever the flow finishes without being resolved by `/native-action-result`.

### 6. Major: default integration test command is not reliable

The spec's verification checklist says `cargo test -p excalidraw-preview-binary`. Running that command failed: 35 unit tests passed, then 5 of 10 integration tests failed due concurrent preview children racing for ports. Running `cargo test -p excalidraw-preview-binary --test integration -- --test-threads=1` passed.

Suggested fix: fix the port race in production code as above, and keep integration tests safe under Cargo's default parallel execution. Do not rely on serial test execution unless the test command is explicitly changed and documented.

### 7. Minor: embedded SVG example was not re-exported

The spec says to re-export `docs/architecture.excalidraw.svg` after fixing font assets. The implementation copied fonts into embedded assets, but there is no modified `docs/architecture.excalidraw.svg` in the worktree.

Suggested fix: re-export that SVG with the fixed build path or mark this as an explicit follow-up outside the production-ready scope.

## Testing Gaps

The current tests cover the new Rust HTTP routes, LSP initialize capability, and basic export routing. They do not cover the highest-risk user-facing paths:

- autosave max-wait behavior and dirty-state races while a save is in flight
- dirty detection for file payload changes and persisted app-state/export settings
- native close-confirm save/cancel/failure paths
- native menu `Cmd+S` dispatch into `window.__excalidrawSave`
- native library import/export behavior in the React bridge
- external-link behavior in an actual WebView
- font fetches and exported SVG font inlining

Suggested fix: add focused Vitest coverage for the save/dirty/library bridge logic by extracting pure helpers where needed, and add at least one end-to-end/manual checklist artifact for the WebView-only native paths.

## Verification Performed

- `npm run typecheck && npm test -- --run` in `preview-binary/webview-src`: passed.
- `cargo test -p excalidraw-preview-binary`: failed in integration tests under default parallel execution due port conflicts.
- `cargo test -p excalidraw-preview-binary --test integration -- --test-threads=1`: passed.

## Production Readiness

Decision: not production ready.

The implementation has meaningful progress, but the save/dirty path still has a data-loss race, native library export can write the wrong contents, and default Rust verification is failing because concurrent preview startup is not safe. Those are core correctness issues for a feature pass whose main goals are reliable save behavior and native-window polish. The native/WebView portions also need more direct coverage before this should be treated as ready.
