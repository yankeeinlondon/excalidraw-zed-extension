---
ready: false
---

# Review 6

## Findings

1. **Blocking: library persistence reports success and clears dirty state even when the write fails.**

   Suggested fix: make `persistLibrary` return a real success/failure result, check `res.ok`, and only clear `libraryDirtyRef` after a confirmed `2xx` response. Native import and close flushing should surface failures and keep the window open when the library write cannot be made durable.

   `persistLibrary` clears `libraryDirtyRef.current = false` before issuing `fetch("/library")` and then resolves regardless of HTTP status or network failure (`preview-binary/webview-src/src/App.tsx:492-503`). The Rust endpoint can return `500` when there is no config directory or the write fails (`preview-binary/src/main.rs:641-657`), but the frontend treats those cases exactly like a successful write.

   This breaks the durability guarantee added after review 5. Native import awaits `persistLibrary(merged)` and then shows an "Imported..." success toast and returns `{ ok: true }` (`preview-binary/webview-src/src/App.tsx:630-642`) even if `/library` failed. The close path also awaits `flushLibrary()` before reporting clean or before save-and-close completes (`preview-binary/webview-src/src/App.tsx:562-585`), but because the dirty flag was already cleared, a failed library write can still be followed by window exit and data loss.

   Add tests for `/library` returning `500` and rejected fetches. The expected behavior should be: dirty remains true, import reports `ok: false`, and close/prepare-close does not report success unless the pending library write was actually persisted or the user explicitly discards it.

2. **Major: auto-save max-wait can start a save on every `onChange` after the 2-second threshold.**

   Suggested fix: track an in-flight auto-save or reset the max-wait window when dispatching a max-wait save, so continuous drawing produces periodic bounded saves rather than one save per frame. A small extracted scheduler helper would make this testable without a full Excalidraw component.

   `handleChange` sets `firstDirtyAt` only when it is `null` (`preview-binary/webview-src/src/App.tsx:429-430`). Once `now - firstDirtyAt.current >= SAVE_MAX_WAIT_MS`, it cancels the debounce and calls `doSave({ reason: "maxwait" })` (`preview-binary/webview-src/src/App.tsx:431-436`). But `firstDirtyAt` remains the old timestamp until the save resolves, and no in-flight guard is set. During a long continuous gesture, every subsequent `onChange` after the 2-second mark satisfies the same condition and can launch another overlapping POST/export.

   The spec asks for a bounded flush so a 10-second drawing gesture gets at least one intermediate save. This implementation can flood `/data` with many overlapping saves during the gesture, which is especially expensive for SVG/PNG content where `doSave` exports the whole scene. The existing save ordering logic reduces data-loss risk, but the autosave behavior is still not the intended "about every 2 seconds" checkpoint.

3. **Minor: stale-save responses show a misleading "Saved" toast even when the latest scene remains dirty.**

   Suggested fix: move the success toast after `decideSaveOutcome` and only show "Saved" when `decision.clearDirty` is true or the response is superseded by a known-clean current state. If newer edits arrived mid-flight, leave the saving indicator up, show "Unsaved changes", or stay silent and let the follow-up auto-save report the final success.

   `doSave` shows "Saved" immediately after any successful `/data` response (`preview-binary/webview-src/src/App.tsx:309-313`), before checking whether that response corresponds to the current scene. If newer edits landed while the save was in flight, the code correctly keeps the scene dirty and returns `pendingNewerEdits` (`preview-binary/webview-src/src/App.tsx:339-357`), but the user has already seen a success status for a stale snapshot. This conflicts with the spec's explicit save-state indicator requirement because "saved" can mean only "an older snapshot was written."

## Checks Run

- `cargo test -p excalidraw-preview-binary` passed: 42 unit tests and 12 integration tests.
- `cargo test -p excalidraw-preview` passed: 8 unit tests.
- `npm test -- --run` in `preview-binary/webview-src` passed: 43 Vitest tests.
- `npm run typecheck` in `preview-binary/webview-src` passed.
- `npm run build` in `preview-binary/webview-src` passed and copied 9 font families into `assets/fonts/`.

## Production Readiness

Decision: not production ready.

The implementation is close and the automated test suite is green, but I would not ship this spec while library import/edit persistence can be acknowledged and marked clean after a failed `/library` write. That is a direct data-loss path in one of the feature's native-library requirements. The auto-save max-wait issue is less severe but still needs tightening because it can turn the reliability fix into excessive overlapping writes during continuous drawing. Once library writes are treated as durable only on confirmed success, and the max-wait scheduler is bounded with focused tests, this should be ready to reconsider.
