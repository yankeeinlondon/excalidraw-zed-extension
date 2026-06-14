---
ready: false
---

# Review 2

## Findings

### 1. Blocking: save-and-close can close after a stale save

`doSave()` correctly detects when newer edits arrived while the POST was in flight, but it still returns `{ ok: true }` in that case. The mismatch path at `preview-binary/webview-src/src/App.tsx:253-276` leaves the scene dirty and reports `dirty: true`, then returns success anyway. The native close flow treats any successful native action result as permission to exit at `preview-binary/src/main.rs:1173-1176`, and both event loops close immediately on that result (`preview-binary/src/main.rs:1294-1297`, `preview-binary/src/main.rs:1492-1494`).

That means a user can close a dirty auto-save window, make another edit while the close-triggered save is in flight, and still lose the newer edit when the old save reports success. The same issue applies to the "Save" choice in the close-confirm dialog if the user can modify the still-open window before the save result returns.

Suggested fix: make the native close action succeed only when the saved snapshot is still current. Either return `{ ok: false, error: "newer edits pending" }` from `__excalidrawSave({ reason: "close" })` when `clearDirty` is false, or have Rust re-check `DirtyState` after the action result before exiting. For auto-save, schedule/await the follow-up save instead of closing on the stale result.

### 2. Blocking: close-confirm relies on an asynchronous dirty report that can lose very recent edits

The frontend marks local dirty state and then fire-and-forget posts `/dirty` from `handleChange()` (`preview-binary/webview-src/src/App.tsx:339-346`, `preview-binary/webview-src/src/App.tsx:156-170`). Native close handling consults only Rust's last received dirty state (`preview-binary/src/main.rs:1312-1316`, `preview-binary/src/main.rs:1457-1460`). If the user edits and immediately closes before that HTTP request is delivered and processed, Rust still sees `dirty == false` and exits without save or confirmation.

This is a data-loss race in the feature's central close-confirm path. It is not covered by the current tests because they validate the `/dirty` endpoint in isolation, not the ordering between webview edits and native close.

Suggested fix: make close ask the webview for the current scene state when in doubt, or pessimistically route close through a JS close/check action that flushes current dirty state and returns the result via `/native-action-result`. At minimum, treat a missing/unknown dirty report after the app has mounted as not safe to close silently.

### 3. Major: Linux has no filtered library import/export path

The spec calls for native filtered Import Library and Export Library actions using `.excalidrawlib` filters. The implementation wires those only through the non-Linux `muda` native menu (`preview-binary/src/main.rs:974-978`, `preview-binary/src/main.rs:1008-1012`). The Linux GTK path explicitly keeps only the in-WebView menu and key handler (`preview-binary/src/main.rs:1217-1222`), but the in-WebView menu rendered in `App.tsx` does not expose custom Import Library or Export Library actions (`preview-binary/webview-src/src/App.tsx:559-580`).

As a result, Linux users still only have Excalidraw's built-in unfiltered Open fallback and no custom export-library action, so item 6 is not implemented on that platform.

Suggested fix: either add GTK menu/accelerator entries for Import Library and Export Library, or add in-WebView menu items that call `window.__excalidrawImportLibrary` / `window.__excalidrawExportLibrary` on Linux.

### 4. Major: macOS icon implementation contradicts the required raw-RGBA path

The spec explicitly requires building the macOS `NSImage` from raw RGBA bytes and says not to pass PNG data because of known decoding issues in this path. The implementation embeds a PNG and uses `NSImage::initWithData` on that PNG at `preview-binary/src/main.rs:897-917`.

This may still leave the Dock icon generic or flaky on macOS, which is the exact bug item 4 was meant to fix.

Suggested fix: reuse `decode_icon_rgba()` and construct the AppKit image through an `NSBitmapImageRep`/RGBA-backed representation before calling `setApplicationIconImage`.

### 5. Major: out-of-order save responses can re-dirty an already-saved scene

The stale-save fix compares each saved snapshot against `prevHashRef.current`, but it does not track save ordering. If save A starts, then save B starts for a newer scene, B finishes first and clears dirty, then A finishes later, A's mismatch path marks the scene dirty again (`preview-binary/webview-src/src/App.tsx:253-267`). With manual save it will stay falsely dirty; with auto-save it schedules an unnecessary extra save.

This is no longer direct data loss, but it produces incorrect close prompts and misleading save state after overlapping saves.

Suggested fix: add a monotonically increasing save revision/request id in the frontend. Only the latest completed save should be allowed to transition dirty state, and older responses should be ignored unless they exactly match the current hash and no newer save has completed.

### 6. Minor: initial dirty seeding can race the first Excalidraw onChange

The comment says Excalidraw fires an initial `onChange`, and the code tries to avoid marking the loaded scene dirty by seeding `prevHashRef` in a parent `useEffect` (`preview-binary/webview-src/src/App.tsx:116-124`). If Excalidraw fires its initial callback before that effect runs, `handleChange()` sees `prevHashRef.current === null` and marks the file dirty (`preview-binary/webview-src/src/App.tsx:339-346`) even though nothing changed.

Suggested fix: initialize `prevHashRef` with a `useRef` initializer from `initialData` instead of setting it in an effect, and add a component-level test or harness around the first `onChange` behavior.

## Testing Gaps

The added unit and integration tests cover many pure helpers and HTTP routes, but the riskiest user-facing behavior is still only in the manual checklist:

- native close/save flows do not have an automated test for stale save results, late `/dirty` delivery, or overlapping saves
- Linux library import/export availability is not covered
- macOS Dock icon behavior is not covered, and the implementation does not follow the specified construction path
- native menu `Cmd+S`, WebView external-link handling, and exported SVG font inlining remain manual-only

## Verification Performed

- `cargo test -p excalidraw-preview-binary`: passed, 37 unit tests and 11 integration tests.
- `npm run typecheck && npm test -- --run` in `preview-binary/webview-src`: passed, 25 Vitest tests.

## Production Readiness

Decision: not production ready.

The implementation is much closer than review 1, and the automated suite now passes under the default commands. However, the close-confirm/save path still has two data-loss races, and the Linux library workflow and macOS icon fix do not fully satisfy the spec. Those are core requirements of this rough-edges pass, so I would not ship this as production ready until the close flow is made robust and the platform gaps are either fixed or explicitly scoped out.
