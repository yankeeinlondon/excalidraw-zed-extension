---
ready: true
---

# Review 5

## Findings

1. **Library import/edit persistence can still be acknowledged before it is written.**

   Suggested fix: make library persistence immediate or flushable for native import, close, and unmount.

   The native import flow validates the selected `.excalidrawlib` and calls `api.updateLibrary({ libraryItems, merge: true })` in `preview-binary/webview-src/src/App.tsx:580`, then reports `ok: true` to Rust at `preview-binary/webview-src/src/App.tsx:595`. The actual `/library` write is only scheduled later by the debounced `onLibraryChange` handler in `preview-binary/webview-src/src/App.tsx:477`. That timer is never awaited by the import action, never flushed by the close flow, and never flushed on component unmount.

   This leaves a concrete data-loss case: import a library, receive the success toast, close the preview within the 600 ms debounce window, and the imported items may not be saved to the shared `library.excalidrawlib`. Ordinary library panel edits have the same risk.

   A good fix is to extract a `persistLibrary(items, { immediate })` helper that writes the payload and returns a promise. `onLibraryChange` can still debounce normal edits, but native import should either persist immediately after the merged library state is available or wait for the `onLibraryChange` round trip to complete before reporting success. The native close path should also flush any pending library write before allowing the window to exit.

   Add coverage for the persistence helper and a manual check: import a valid `.excalidrawlib`, close immediately, reopen, and verify the imported items are still present.

2. **`window.__excalidrawSave` does not flush an existing auto-save debounce before saving.**

   Suggested fix: clear `saveTimer.current`, set it to `null`, and report no pending save at the start of `window.__excalidrawSave`, before calling `doSave`.

   The bridge contract in the spec says `window.__excalidrawSave({ reason, requestId }?)` flushes any pending debounce and performs the same save path as the in-canvas Save item. The keyboard fallback clears `saveTimer.current` before calling the bridge in `preview-binary/webview-src/src/App.tsx:382`, and pointer/blur flush does the same in `preview-binary/webview-src/src/App.tsx:440`. The bridge itself starts with `let result = await doSave(opts)` in `preview-binary/webview-src/src/App.tsx:499` and only clears `saveTimer.current` inside the close retry loop at `preview-binary/webview-src/src/App.tsx:515`.

   That means a native menu Save or close-triggered first save can leave the old debounce timer alive. The immediate save writes the latest scene, but the stale timer can fire afterward and perform a redundant save; more importantly, the implementation does not satisfy the bridge contract and can leave Rust's `/dirty` state believing `pendingSave` is still true until the immediate save completes. Make the bridge itself own the flush so every caller, including native menu dispatch from Rust, gets identical behavior.

   Add a small frontend test around a save-bridge helper or extracted timer-flush function so this does not regress.

3. **Reopen-on-save is still only tested at the capability-advertisement level.**

   Suggested fix: add an integration test that drives the LSP server through `textDocument/didSave`.

   `preview-binary/src/main.rs:1807` advertises object-form `textDocumentSync` with `save: true`, and `preview-binary/src/main.rs:1837` implements `textDocument/didSave`. The current integration test at `preview-binary/tests/integration.rs:379` only asserts the initialize response. It does not prove that saving a still-open Zed buffer re-spawns a preview when the lock is gone, or that saving while a preview is already live does not create a second instance.

   Add a framed-LSP integration test that sends `initialize`, sends `textDocument/didSave` for a temp `.excalidraw` file, waits for the lock file, verifies `/ping`, sends a second `didSave`, and confirms the same lock port remains live. That directly covers item 9's intended behavior.

## Checks Run

- `cargo test -p excalidraw-preview-binary`
- `npm test` in `preview-binary/webview-src`
- `npm run typecheck` in `preview-binary/webview-src`
- `npm run build` in `preview-binary/webview-src`

All commands passed.

## Production Readiness

Not production ready.

The main implementation is substantial and the automated checks pass, but the library import/edit flow still has an acknowledged-success-before-persistence window that can lose user data on a quick close. The native save bridge also misses an explicit contract requirement around flushing pending debounce timers, and item 9 still lacks behavioral integration coverage. I would not ship this spec until the library persistence path is made durable and the bridge/test gaps above are closed.
