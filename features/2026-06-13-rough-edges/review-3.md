---
ready: false
---

# Review 3

## Findings

### 1. Blocking: packaged extension still downloads the old preview binary

The extension manifest and crates are now at `0.4.0`, but the Zed extension's release download constant is still `0.3.0` at `extension/src/lib.rs:11`. In a normal installed-extension path, `get_binary_path()` prefers a PATH binary only for local dev, then downloads from `releases/download/v{BINARY_VERSION}` at `extension/src/lib.rs:100-105`. That means users without a local symlink will run the `0.3.0` preview binary, not the implementation reviewed here.

This makes the release path miss the rough-edges fixes entirely: native close/save handling, font assets, external-link handling, library import/export, and reopen-on-save all depend on the new binary.

Suggested fix: set `BINARY_VERSION` to `0.4.0` before release, or better, derive/check it against `extension/extension.toml` / crate metadata so this cannot drift again. Add a small extension unit test or release check that asserts the download tag version matches the manifest version.

### 2. Major: external reloads are not reconciled with the dirty baseline

The SSE reload path parses the changed file and calls `reloadScene?.(newData)` from `preview-binary/webview-src/src/main.tsx:139-150`. The reload function then only adds files and updates elements (`preview-binary/webview-src/src/App.tsx:195-202`); it never updates the dirty baseline (`prevHashRef`), clears `dirtyRef`, reports clean state to Rust, or applies persisted app-state fields such as `viewBackgroundColor`.

The dirty handler treats any later hash mismatch as a user edit and, when auto-save is enabled, schedules a write (`preview-binary/webview-src/src/App.tsx:383-405`). A programmatic reload that triggers `onChange`, or the next local edit after a reload, can therefore operate from an old baseline. In the auto-save case this can write the reloaded scene back with stale app-state and can overwrite external changes that were just accepted from disk. Even without auto-save, the preview can show a dirty close prompt after a clean external reload.

Suggested fix: make reload a first-class baseline transition. After loading external data, update the editor with persisted app-state fields that should be reflected visually, preserve only viewport/session-only state, set `prevHashRef.current` to the hash of the accepted reloaded scene, clear `dirtyRef` if there are no local unsaved edits, cancel obsolete save timers, and `reportDirty(false, false, ...)`. Add a test or harness that simulates an external reload followed by an `onChange` and proves no auto-save/dirty transition is produced for the accepted disk state.

## Testing Gaps

- The extension release/download version is not tested, which is why the `0.3.0` drift survived while the manifest moved to `0.4.0`.
- The close/save state machine has good unit coverage for polling helpers, but there is still no end-to-end WebView test for native close querying live dirty state, retrying a stale close save, and keeping the window open on hard save failure.
- External SSE reload behavior is only covered at the server event level. There is no frontend test for applying an external reload without marking the scene dirty or overwriting app-state under auto-save.
- Manual-only coverage remains for macOS `Cmd+S`, Dock icon behavior, external links opening in the system browser, and SVG font inlining.

## Verification Performed

- `cargo test -p excalidraw-preview-binary`: passed, 42 unit tests and 11 integration tests.
- `npm run typecheck && npm test -- --run` in `preview-binary/webview-src`: passed, 30 Vitest tests.
- `cargo test -p excalidraw-preview`: passed, 7 extension unit tests.
- `cargo test -p excalidraw-preview-extension`: not a valid package name; the extension crate is `excalidraw-preview`.

## Production Readiness

Decision: not production ready.

The implementation is substantially improved from review 2 and the main automated suites pass. However, the installed extension would still fetch the old `0.3.0` binary, so the production release path would not actually deliver this implementation. There is also an unresolved dirty/baseline gap around external reloads that can produce incorrect dirty state and risks overwriting accepted disk changes under auto-save. Those are release-blocking for a feature set focused on persistence correctness and native-window rough edges.
