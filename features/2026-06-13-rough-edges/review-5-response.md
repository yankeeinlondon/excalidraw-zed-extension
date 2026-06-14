# Review 5 — Response

Resolutions for every finding in [`review-5.md`](./review-5.md).

## 1. Library import/edit persistence acknowledged before it is written (FIXED)

Library persistence is now explicit and flushable instead of relying solely on
the debounced `onLibraryChange` write.

- **`persistLibrary(items)`** (`App.tsx`) does the actual `POST /library` and
  returns a promise; it clears `libraryDirtyRef` up front so a concurrent flush
  can't double-write. Never rejects (a dead server is a no-op).
- **`handleLibraryChange`** still debounces ordinary panel edits
  (`LIBRARY_SAVE_DEBOUNCE_MS = 600`), but now sets `libraryDirtyRef` and routes
  through `persistLibrary`.
- **Native import** no longer depends on the debounced echo. `api.updateLibrary({
  merge: true })` resolves with the merged item list, so the handler mirrors it
  into `libraryItemsRef` and **awaits `persistLibrary(merged)` before reporting
  `ok: true`**. The success toast now follows a durable write.
- **Close flow** flushes any pending library write before the window exits:
  `window.__excalidrawSave({ reason: "close" })` awaits `flushLibrary()` after the
  scene save, and `window.__excalidrawPrepareClose` awaits it even when the scene
  itself is clean.
- **Unmount** runs a best-effort `flushLibrary()` in an effect cleanup (can't
  await on teardown, but fires the write).

The flush decision is extracted to the pure **`flushPendingLibrary(timer, dirty,
persist)`** helper in `dirty-state.ts` (cancels the debounce; persists only when
dirty), so the close/unmount behaviour is unit-tested without a DOM.

- Tests (`dirty-state.test.ts`): `flushPendingLibrary` — persists pending edits +
  cancels the timer; no-op-but-clears-timer when clean; resolves immediately with
  no timer and a clean library.
- Manual: import a valid `.excalidrawlib`, close immediately, reopen, verify the
  imported items remain (added to [`manual-checklist.md`](./manual-checklist.md)).

## 2. `window.__excalidrawSave` did not flush the auto-save debounce (FIXED)

The bridge now owns the flush so every caller — native menu Save, keyboard, and
the close flow — gets identical semantics. At the top of `window.__excalidrawSave`
it calls the new **`flushPendingSave(saveTimer)`** helper and, when a timer was
actually pending, `reportDirty(dirtyRef.current, false)` so Rust's `/dirty` state
stops advertising `pendingSave` before the immediate, authoritative save runs.

`flushPendingSave` (in `dirty-state.ts`, returns whether a timer was pending) now
also backs the keyboard handler's fallback, the pointer/blur flush, and the
close-retry loop, removing the duplicated `clearTimeout`/null dance.

- Tests (`dirty-state.test.ts`): `flushPendingSave` — clears a pending timer and
  reports `true`; no-op returning `false` when nothing is pending.

## 3. Reopen-on-save only tested at capability-advertisement level (FIXED)

New framed-LSP integration test
`lsp_did_save_spawns_preview_then_reuses_live_instance`
(`preview-binary/tests/integration.rs`) drives the `--lsp` server through behaviour,
not just `initialize`:

1. `initialize` handshake, then `textDocument/didSave` for a temp `.excalidraw`
   file with **no live lock** → asserts a preview is spawned (waits for the lock
   file) and `GET /ping` returns `200 OK`.
2. A **second** `textDocument/didSave` while the preview is live → asserts the
   lock port is unchanged and the same instance keeps serving (no duplicate).

To keep this windowless, the `--headless` flag now also reads
`EXCALIDRAW_PREVIEW_HEADLESS` (`#[arg(long, env = ...)]`, requires clap's `env`
feature). The test sets `EXCALIDRAW_PREVIEW_HEADLESS=true` on the LSP process; the
previews it spawns inherit the env and come up without a WebView window. Extracted
`lsp_write` / `lsp_read` framing helpers are shared with the existing
capability test.

## Verification performed

- `cargo nextest run -p excalidraw-preview-binary`: 54 tests pass (was 53).
- `cargo clippy -p excalidraw-preview-binary --tests`: clean.
- `npm test` in `preview-binary/webview-src`: 43 Vitest tests pass (was 37).
- `npm run typecheck` and `npm run build` in `preview-binary/webview-src`: clean
  (production `assets/` rebuilt to embed the `App.tsx` changes).
