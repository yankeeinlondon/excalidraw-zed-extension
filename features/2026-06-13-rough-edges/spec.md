---
status: ready for planning
reviewed: true
depends-on: ../2026-06-13-updated-deps/spec.md
---

# Rough Edges — Bug-fix & Polish Pass

> Created 2026-06-13. Follows the dependency upgrade in
> `features/2026-06-13-updated-deps/spec.md`.

A batch of correctness and polish fixes found in real use of the preview window. The pass covers
nine items (8 reported + 1 folded in). Several share the same root cause, so the design groups
them around native-window capabilities, save-state tracking, and asset completeness.

---

## Cross-cutting architecture change

Three bugs (Cmd+S, close-confirm, external links) cannot be fixed with the current pure-HTTP
design, where the WebView and the Rust process only communicate through existing
`127.0.0.1` routes. This pass adds two native capabilities in `preview-binary/src/main.rs`:

1. **Native window actions**: Save, export, library import/export, and close actions should be
   available from the native window surface where the platform supports it.
   - On macOS/Windows, use `muda` with the existing `tao` event loop.
   - On Linux, the current implementation uses a direct GTK window path rather than `tao`.
     Either wire equivalent GTK menu/accelerator handling or explicitly limit the native menu to
     non-Linux and keep Linux on the in-WebView menu. Do not assume the `muda`/`tao` integration
     covers the Linux code path without changing `run_webview_url`.
2. **A narrow WebView <-> Rust bridge**:
   - Rust -> WebView: `WebView::evaluate_script(...)` for commands such as save, import library,
     and export.
   - WebView -> Rust: small HTTP routes for state and command completion, reusing the existing
     Axum server instead of introducing a full IPC protocol.

**Reader's note:** the bridge is deliberately hybrid. A native menu can trigger JS only through
the WebView object, but JS state already fits the existing local HTTP server model. A full IPC
protocol would be more flexible, but this pass needs only state updates and command
acknowledgements.

### Bridge contract

Add explicit routes and JS globals rather than one-off ad hoc calls:

- `POST /dirty` receives `{ dirty: boolean, pendingSave: boolean, lastSavedAt?: number }`.
  Rust stores this in shared state for close-confirm logic.
- `POST /native-action-result` receives `{ id: string, action: string, ok: boolean, error?: string }`.
  Rust uses this to finish close-after-save flows and to surface command failures.
- `window.__excalidrawSave({ reason, requestId }?)` flushes any pending debounce and performs the
  same save path as the in-canvas Save item.
- `window.__excalidrawImportLibrary({ requestId }?)` and
  `window.__excalidrawExportLibrary({ requestId }?)` may be added if the native menu owns library
  actions.

`evaluate_script` is fire-and-forget for this use case. Any native flow that depends on success
(notably "Save and close") must wait for `/native-action-result` or time out with an error dialog;
it must not assume that script evaluation means the save completed.

---

## 1. Auto-save unreliable

**Symptom:** With `--auto-save`, changes are not reliably persisted unless the debounce interval
is set quite high.

**Current behavior** (`webview-src/src/App.tsx`): `onChange` -> `handleChange` gates on
`autoSave`, hashes only elements (`hashElementsVersion`), and debounces `doSave` by
`SAVE_DEBOUNCE_MS = 600`. After a successful POST `/data`, `onSaved(now + 2000)` suppresses the
echoing SSE reload for 2 seconds.

**Likely mechanisms to verify:**

- **Continuous-change debounce starvation:** while actively drawing, the element hash can change
  every frame, so the debounce timer resets until the user pauses.
- **Incomplete change detection:** the current hash ignores app-state and file changes. Background
  changes, view export settings, and image/file registry updates can be missed or saved before the
  file data is fully registered.
- **Echo/reload race:** if a save POST and the file-watcher SSE reload interleave outside the
  suppression window, an `updateScene` can fight the in-flight edit.
- **No visible save status:** a working save, a pending save, and a failed save look identical.

**Design decision:** keep debounce, but add bounded flushing and explicit save state.

- Lower the default debounce to about 300 ms.
- Add a max-wait checkpoint of about 2 seconds so long continuous edits save periodically.
- Flush pending saves on pointer-up, window blur, native Save, and close.
- Track dirty state for elements, app state, and files. Use Excalidraw's full `onChange`
  signature, not only the element array.
- Keep a save-state indicator inside the preview: saving, saved, and error. It should be small and
  non-modal; Excalidraw toast or a compact overlay is sufficient.
- Confirm `--auto-save` is actually passed in the user's reproduction path:
  extension slash-command plumbing -> `/config.autoSave` -> `App` prop.

**Acceptance notes:**

- A 10-second continuous drawing gesture should produce at least one intermediate save before the
  gesture ends.
- A changed canvas background or image file addition should mark the scene dirty and save.
- Failed saves should keep the scene dirty and show an error state.

---

## 2. `Cmd+S` does not save on macOS; `Ctrl+S` works

**Root cause:** On macOS, `Cmd`-modified keys are dispatched through AppKit's
`performKeyEquivalent:` menu path before they reach WKWebView web content as `keydown`. wry does
not bridge these, so the JS handler in `App.tsx` never sees `Cmd+S`.

**Fix:** Add a native **Save** action with platform accelerators:

- macOS: `Cmd+S`.
- Windows/Linux: `Ctrl+S`, where native accelerator support is wired. The existing web handler can
  remain as a fallback.

On activation, Rust calls:

```rust
webview.evaluate_script("window.__excalidrawSave && window.__excalidrawSave({ reason: 'menu' })")
```

Expose `window.__excalidrawSave` in `App.tsx` so native Save, the in-canvas MainMenu item, and
the existing in-page keyboard handler converge on one save path.

**Implementation notes:**

- Add `muda` for the macOS/Windows `tao` path and route `MenuEvent`s into the event loop.
- If Linux native menu support is included in this pass, implement it in the GTK path separately.
  Otherwise document that Linux keeps the in-WebView menu and `Ctrl+S` fallback for now.
- The MainMenu shortcut label should be platform-aware; showing only `Ctrl+S` on macOS is
  misleading once `Cmd+S` is supported natively.

---

## 3. Unsaved changes confirmation on window close

**Symptom:** Closing the WebView with unsaved changes silently discards them.

**Fix:** Intercept close requests and consult Rust's dirty state.

- macOS/Windows `tao`: handle `WindowEvent::CloseRequested`. tao has no `veto()`; keep the
  window alive by not setting `ControlFlow::Exit`.
- Linux GTK: in `connect_delete_event`, return `Propagation::Stop` while a confirmation/save flow
  is pending, and quit only after the chosen action completes.

**Design decision:** use a 3-way dialog when auto-save is off; flush silently when auto-save is on.

- Auto-save on:
  - If a save is pending, trigger `window.__excalidrawSave({ reason: 'close', requestId })`.
  - Wait for `/native-action-result`.
  - Close on success. On failure, keep the window open and show the error.
- Auto-save off and dirty:
  - Show **Save / Don't Save / Cancel**.
  - Save triggers `__excalidrawSave` and closes only after success.
  - Don't Save exits without saving.
  - Cancel keeps the window open.
- Not dirty: close immediately.

**Dialog implementation notes:**

- `rfd::MessageDialog` is enough for blocking macOS/Windows confirmation.
- On Linux, prefer `rfd::AsyncMessageDialog` or a GTK-native async dialog to avoid re-entrant
  nested GTK loops.
- Existing `Drop`-based lock-file cleanup still runs when the event loop exits.

---

## 4. Generic `exec` Dock/app icon

**Symptom:** The preview window shows a generic executable icon on macOS.

**Root cause:** The preview is a bare binary, not an `.app` bundle. `tao::Window::set_window_icon`
does not affect the macOS Dock tile because the Dock icon is owned by `NSApplication`.

**Fix by platform:**

- **macOS:** at startup on the main thread, call `NSApplication::setApplicationIconImage_` via
  `objc2-app-kit`. Build the `NSImage` from raw RGBA bytes (via `NSBitmapImageRep`), not by
  passing PNG data, to avoid known PNG decoding issues in this path. Call
  `setActivationPolicy(.Regular)` so the bare binary owns a Dock tile.
- **Windows/Linux:** use `tao::Window::set_window_icon()` for the `tao` path and GTK icon APIs for
  the GTK path.
- Decode an embedded icon asset at runtime with the `image` crate.

**Icon asset decision:** create an original Excalidraw-flavored preview icon and embed it with
`rust-embed`. Do not copy Excalidraw's brand mark unless its license/brand terms are explicitly
confirmed. Defer `.app` bundling and notarization to the later distribution milestone.

---

## 5. Hand-drawn / drawing fonts not rendering

**Symptom:** Text renders with a wrong fallback font in the live preview and in exported
`.excalidraw.svg` files viewed elsewhere.

**Root cause:** The Vite build only emits `Assistant-*.woff2` into `assets/assets/`. Excalidraw's
drawing fonts (`Excalifont`, `Nunito`, `ComicShanns`, `Lilita`, `Cascadia`, `Virgil`, and CJK
`Xiaolai`) are fetched on demand from `EXCALIDRAW_ASSET_PATH` and are not in Vite's module graph,
so they are not copied into the embedded assets. Runtime fetches 404 and offline CDN fallback is
not available.

**Fix:**

- Copy `@excalidraw/excalidraw/dist/prod/fonts/` into the served assets at `assets/fonts/`,
  preserving the `fonts/<Family>/<hashed-file>.woff2` structure.
- With `EXCALIDRAW_ASSET_PATH = "/assets/"`, Excalidraw fetches
  `/assets/fonts/<Family>/...`, which the existing `rust-embed` `GET /assets/*` handler serves.
  `mime_guess` handles `.woff2`.
- Use `vite-plugin-static-copy` or an explicit `fs.cpSync` build step in the UI recipe. Prefer the
  plugin if it keeps the asset copy inside Vite's build graph.
- Do not set `skipInliningFonts: true`. `exportToSvg` inlines fonts by fetching these URLs; once
  the URLs work, exported SVGs become portable.
- Re-export `docs/architecture.excalidraw.svg` after the fix.

**Design decision:** include all drawing fonts, including `Xiaolai`, unless binary size becomes a
measured distribution blocker. Correct offline rendering is the goal of this pass, and silent CJK
font degradation is harder for non-CJK reviewers to notice.

---

## 6. Library panel: "Browse libraries" and unfiltered "Open"

**Symptoms:**

- **Browse libraries** does nothing.
- The overflow menu's **Open** is visually subtle and redundant with our desired import flow.
- Its file picker accepts any file type; library files are `.excalidrawlib`.

**Root causes:**

- Browse libraries is an `<a target="_blank">` to `libraries.excalidraw.com`, which the current
  chrome-less WebView drops. The external-link handler in item 8 fixes this.
- Excalidraw's built-in library Open uses upstream `fileOpen` with intentionally no `accept`
  filter for WebKit/iOS compatibility. It is not prop-configurable, and there is no public API to
  hide just that menu item.

**Design decision:** add native filtered import/export and leave the built-in Open as a fallback.

- Browse libraries opens in the system browser via the external-link handler.
- Native Import Library:
  - Use `rfd` with a `.excalidrawlib` filter.
  - Validate parsed JSON has `type === "excalidrawlib"` and a `libraryItems` array.
  - Load via `excalidrawAPI.updateLibrary({ libraryItems, merge: true })`.
  - Persist via the existing `/library` POST and `onLibraryChange` round trip.
- Native Export Library:
  - Save the current library as `{ type: "excalidrawlib", version: 2, libraryItems }`.
  - Use a `.excalidrawlib` save filter.
- Leave Excalidraw's built-in Open visible. Avoid injected CSS DOM hacks unless users report
  persistent confusion after the native path exists.

---

## 7. "Set of indexed file names" reclassified

**Resolution:** This was not files written to disk. Zed showed only the single target file; the
"multiple indexed names" appeared inside Excalidraw, likely in a transient library or image/file
registry view. The reporter could not re-verify because of item 9.

**Action:** Deferred. Re-verify after item 9 is addressed. If it reappears, capture the exact
Excalidraw panel and create a follow-up issue. No code fix is planned in this pass.

---

## 8. External links do not open

**Symptom:** Help-menu items, docs, GitHub links, shortcuts, Browse libraries, and other
`https://` links do nothing because they are `target="_blank"` anchors or `window.open` calls that
the WebView drops.

**Fix:** Add one external-link mechanism in both WebView builders.

- Add the `open` crate.
- Use `WebViewBuilder::with_new_window_req_handler(|url, _| { ...; NewWindowResponse::Deny })`
  to catch `target="_blank"` and `window.open`.
- Use `with_navigation_handler` as defense-in-depth:
  - Open external `http`/`https` non-loopback hosts in the system browser and return `false`.
  - Allow `127.0.0.1`, `localhost`, and the configured dev-server URL in `--dev` mode.
  - Keep non-http schemes that the app needs (`data:`, `blob:`, `about:`) inside the WebView.
  - Reject or ignore unknown external schemes unless explicitly allowed.

**Implementation note:** `wry 0.55` returns `NewWindowResponse`, not `bool`, from the new-window
handler. Avoid blocking the UI path on long browser-launch work; best-effort `open::that` and
log failures.

---

## 9. Preview does not re-open when returning to the file

**Symptom:** After the WebView window is closed, navigating back to or re-focusing the
`.excalidraw` file in Zed does not re-open the preview.

**Root cause:** Auto-open is driven by LSP `textDocument/didOpen`, which Zed sends once when the
buffer first opens. Closing the WebView tears down the server and removes the lock, but the Zed
buffer stays open, so no new `didOpen` fires on re-focus. The extension API cannot observe focus
or register ordinary palette actions for this use case.

**What already works:** Re-running `/preview-excalidraw` re-spawns correctly because the lock is
gone. Closing and reopening the Zed tab also re-fires `didOpen`.

**Design decision:** support explicit slash-command re-open and deliberate save-triggered re-open.

- Keep `/preview-excalidraw` as the explicit user path.
- Enable LSP save notifications by changing initialize capabilities from numeric
  `"textDocumentSync": 1` to an object with full sync and save:

```json
{
  "textDocumentSync": {
    "openClose": true,
    "change": 1,
    "save": true
  }
}
```

- Handle `textDocument/didSave`: if the file has no live preview instance, spawn one.
- Do not spawn on `didChange`; typing should not reopen a deliberately closed preview.
- Reuse the lock/ping liveness check before spawning so saving an already-open preview focuses or
  leaves the existing instance alone.

**Reader's note:** this is an intended behavior change. A save can now reopen a preview the user
closed. The mitigation is that save is deliberate and low-frequency, while typing/focus churn does
not reopen anything.

---

## Implementation Checklist

- Add front-end dirty/save-state tracking that covers elements, app state, and files.
- Add `/dirty` and `/native-action-result` routes plus shared Rust state.
- Add native Save and close handling with platform-specific event-loop wiring.
- Add external-link handlers to both non-Linux `tao` and Linux GTK WebView builders.
- Add filtered library import/export actions.
- Copy Excalidraw fonts into embedded assets and verify SVG font inlining.
- Add icon asset loading and per-platform window/app icon wiring.
- Enable LSP save notifications and handle `textDocument/didSave`.

---

## Verification Checklist

- `cargo test -p excalidraw-preview-binary`
- UI tests/build for `preview-binary/webview-src`
- Manual macOS: `Cmd+S` saves; Dock icon is not generic; external Help links open in browser.
- Manual Linux or CI smoke where available: GTK WebView still opens; close behavior is correct;
  external links are handled.
- Manual auto-save: continuous drawing, background change, image insertion, blur, and close all
  persist correctly.
- Manual library: import rejects non-library JSON and merges a valid `.excalidrawlib`.
- Manual re-open: close preview, save the still-open Zed buffer, and confirm the preview
  re-spawns; typing alone should not re-spawn.

---

## Out of scope / follow-ups

- `.app` bundling, signing, and notarization.
- Full IPC protocol unless native/WebView interactions grow beyond command and state messages.
- Revisiting item 7 unless the indexed-name symptom can be reproduced after item 9.
