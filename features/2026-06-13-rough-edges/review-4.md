---
ready: false
---

# Review 4

## Findings

1. **Library imports and library edits can be lost on close.**

   Suggested fix: make library persistence explicit and flushable instead of relying only on the 600 ms debounced `onLibraryChange` write in `preview-binary/webview-src/src/App.tsx:477`.

   The spec requires native import to merge the chosen `.excalidrawlib` and persist it via the existing `/library` path. The implementation calls `api.updateLibrary({ merge: true })` in `preview-binary/webview-src/src/App.tsx:580`, reports native success at `preview-binary/webview-src/src/App.tsx:595`, and depends on a later `onLibraryChange` callback to POST `/library`. That callback is debounced for 600 ms and is not flushed during close, unmount, native action completion, or library export. A user can import a library, see the success toast, close the window quickly, and lose the imported items. The same risk exists for ordinary library panel edits.

   A robust fix would extract a `persistLibrary(items, { immediate })` helper, clear/flush `libraryTimer` on close/unmount, and have native import wait until the merged library has actually been POSTed before reporting `ok: true`. If Excalidraw's `updateLibrary` does not expose the merged item list directly, use `onLibraryChange` as the source of truth but make the native import wait for that callback and persistence before completing, with a timeout/error path.

   Add a frontend unit test around the library persistence helper and a manual check: import a valid `.excalidrawlib`, close immediately, reopen, and verify the imported items remain.

2. **The reopen-on-save behavior is only partially tested.**

   Suggested fix: add an integration test that drives `--lsp` through `didSave`, not just `initialize`.

   `preview-binary/src/main.rs:1807` correctly advertises object-form `textDocumentSync` with `save: true`, and `preview-binary/src/main.rs:1837` implements `textDocument/didSave`. The current integration coverage only asserts the advertised capability in `preview-binary/tests/integration.rs:379`; it does not prove that `didSave` spawns a preview when no live lock exists, or that it does not spawn/focus a duplicate when one is already live.

   Add a framed-LSP integration test that sends `initialize`, then `textDocument/didSave` for a temp `.excalidraw` file, waits for the lock file, verifies `/ping`, sends a second `didSave`, and confirms the same port remains live. This directly covers item 9's acceptance behavior.

## Checks Run

- `cargo test -p excalidraw-preview-binary`
- `npm test` in `preview-binary/webview-src`
- `npm run typecheck` in `preview-binary/webview-src`
- `npm run build` in `preview-binary/webview-src`

All commands passed.

## Production Readiness

Not production ready yet.

Most of the rough-edge work is implemented and covered by useful unit/integration tests, but library import/edit persistence can still acknowledge success before data is durably written. That is a user-visible data-loss path, so I would not ship this pass until library persistence is flushed or awaited and the reopen-on-save behavior has direct integration coverage.
