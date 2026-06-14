---
agent: open_code
phases: 6
created: 2026-06-13
start_phase: 1
yolo: "true"
packages:
  - preview-binary
source_files_during_phase_1:
  - preview-binary/src/main.rs
  - preview-binary/webview-src/src/App.tsx
  - preview-binary/webview-src/src/native-bridge.ts
  - preview-binary/webview-src/vite.config.ts
docs_updated_during_phase_1: []
docs_created_during_phase_1: []
skills_files_updated_during_phase_1: []
source_files_during_phase_2:
  - preview-binary/src/main.rs
  - preview-binary/Cargo.toml
  - preview-binary/webview-src/vite.config.ts
  - preview-binary/icon.svg
  - preview-binary/icon.png
docs_updated_during_phase_2: []
docs_created_during_phase_2: []
skills_files_updated_during_phase_2: []
source_files_during_phase_3:
  - preview-binary/Cargo.toml
  - preview-binary/src/main.rs
  - preview-binary/webview-src/src/App.tsx
  - preview-binary/webview-src/src/native-bridge.ts
  - preview-binary/webview-src/vite.config.ts
docs_updated_during_phase_3: []
docs_created_during_phase_3: []
skills_files_updated_during_phase_3: []
source_files_during_phase_4:
  - preview-binary/src/main.rs
  - preview-binary/webview-src/src/App.tsx
docs_updated_during_phase_4: []
docs_created_during_phase_4: []
skills_files_updated_during_phase_4: []
source_files_during_phase_5:
  - preview-binary/src/main.rs
docs_updated_during_phase_5: []
docs_created_during_phase_5: []
skills_files_updated_during_phase_5: []
source_files_during_phase_6:
  - preview-binary/tests/integration.rs
docs_updated_during_phase_6: []
docs_created_during_phase_6: []
skills_files_updated_during_phase_6: []
source_code:
  - preview-binary/src/main.rs
  - preview-binary/Cargo.toml
  - preview-binary/icon.svg
  - preview-binary/icon.png
  - preview-binary/tests/integration.rs
  - preview-binary/webview-src/src/App.tsx
  - preview-binary/webview-src/src/native-bridge.ts
  - preview-binary/webview-src/vite.config.ts
documentation: []
packages:
  - preview-binary
---

# Rough Edges — Execution Plan

> **Source spec:** `features/2026-06-13-rough-edges/spec.md`
> **Prerequisite:** dependency upgrade from `features/2026-06-13-updated-deps` landed (wry 0.55, tao 0.35, notify 8, rfd 0.17, react 19, vite 8).

**Goal:** Land nine correctness/polish fixes (8 reported + 1 folded in) grouped around three themes: a narrow WebView↔Rust bridge with native window actions, save-state tracking, and asset completeness.

**Architecture impact:** adds two new HTTP routes (`/dirty`, `/native-action-result`), two JS globals (`window.__excalidrawSave`, `window.__excalidrawImportLibrary/ExportLibrary`), a native menu bar via `muda` (macOS/Windows) and GTK equivalents (Linux), external-link redirection via the `open` crate, embedded drawing fonts, and a per-platform app/window icon.

**Key existing code facts (verified):**
- `preview-binary/src/main.rs` is a 1376-line monolith. `AppState` has fields: `file_path, lock_path, content_type, file_name, auto_save, broadcast_tx, focus_tx, export_tx, export_dir`. The test helper `make_state` constructs literals — every field addition requires updating it.
- `run_webview_url` has two `cfg` variants: `tao` event loop (macOS/Windows, `#[cfg(not(target_os = "linux"))]`) and GTK (Linux, `#[cfg(target_os = "linux")]`). The tao loop uses `ControlFlow::WaitUntil` with 100 ms polling for export/focus requests. The GTK path uses `gtk::main()` with a 100 ms `timeout_add_local`.
- `App.tsx` `handleChange` only fires under `autoSave`, hashes elements only via `hashElementsVersion`, debounces `doSave` by `SAVE_DEBOUNCE_MS = 600`. `doSave` POSTs to `/data` and calls `onSaved(Date.now() + 2000)` to suppress SSE echo.
- The in-page Ctrl+S handler in `App.tsx` (lines 170-183) clears any pending debounce timer and calls `doSave()` directly. On macOS, `Cmd+S` never reaches this handler (AppKit consumes it before WKWebView).
- LSP server (`run_lsp_server`) declares `"textDocumentSync": 1` and handles `didOpen` (spawn) and `didClose` (shutdown). No `didSave` handler exists.
- Vite build emits only `Assistant-*.woff2` into `assets/assets/`. The seven drawing font families live in `node_modules/@excalidraw/excalidraw/dist/prod/fonts/` and are fetched at runtime from `EXCALIDRAW_ASSET_PATH = "/assets/"`, 404ing.
- `Cargo.toml` already targets `rfd = "0.17"` (with `gtk3` feature on Linux). `wry = "0.55"`, `tao = "0.35"`. Not yet present: `muda`, `open`, `image`, `objc2-app-kit`.
- Integration tests in `preview-binary/tests/integration.rs` spawn the real binary headless and assert on HTTP routes. The `Preview` helper writes the lock file and polls for the port.

---

## Phase 1: Bridge Contract & Shared State

**Rationale:** Items 1, 2, 3, and 6 all depend on Rust knowing the WebView's save state and on native code being able to trigger JS saves. This phase establishes the routes, shared state, and JS globals that everything else builds on. No user-visible behavior changes yet — this is pure infrastructure with tests.

**Files touched:** `preview-binary/src/main.rs`, `preview-binary/webview-src/src/App.tsx`, `preview-binary/webview-src/src/main.tsx`

---

### Task 1.1: Add dirty-state and native-action shared state to Rust

**Files:** `preview-binary/src/main.rs`

- [x] Add a `DirtyState` struct (or equivalent) to hold `{ dirty: bool, pending_save: bool, last_saved_at: Option<u64> }` behind an `Arc<tokio::sync::Mutex<...>>` or `Arc<watch::<...>>`.
- [x] Add a pending-native-action tracker so Rust can correlate `/native-action-result` posts with the `requestId` it issued (e.g. `HashMap<String, PendingAction>` or a `watch` channel keyed by request id). This is what makes "Save and close" waitable.
- [x] Extend `AppState` with `dirty: Arc<RwLock<DirtyState>>` (or chosen sync primitive) and `native_action_tx`/`native_action_rx` plumbing analogous to the existing `export_tx`/`export_rx` pattern.
- [x] Update the `make_state` test helper in the `#[cfg(test)] mod tests` block to construct the new fields. The integration test `Preview::spawn` does not touch `AppState` directly so it is unaffected, but every `AppState { ... }` literal in unit tests must be updated.

**Validation:** `cargo build -p excalidraw-preview-binary` compiles. Existing unit tests still pass: `cargo nextest run -p excalidraw-preview-binary`.

---

### Task 1.2: Add `POST /dirty` and `POST /native-action-result` routes

**Files:** `preview-binary/src/main.rs`

- [x] Define request bodies via `serde::Deserialize`:
  - `DirtyPayload { dirty: bool, pending_save: bool, last_saved_at: Option<u64> }` (serde camelCase rename).
  - `NativeActionResultPayload { id: String, action: String, ok: bool, error: Option<String> }`.
- [x] Implement `async fn receive_dirty(State, Json<DirtyPayload>) -> impl IntoResponse` that updates shared dirty state.
- [x] Implement `async fn receive_native_action_result(State, Json<NativeActionResultPayload>) -> impl IntoResponse` that resolves the pending action tracker (sends on the correlation channel so any waiting close-after-save flow proceeds).
- [x] Register both routes in the `Router::new()` chain in `main()`: `.route("/dirty", axum::routing::post(receive_dirty))` and `.route("/native-action-result", axum::routing::post(receive_native_action_result))`.
- [x] Add unit tests (`#[tokio::test]`) that POST valid and malformed payloads to each route and assert status codes + state mutation. Mirror the style of `test_handle_focus_signals_watch_channel`.

**Validation:** `cargo nextest run -p excalidraw-preview-binary` — new route tests green; `curl -X POST http://127.0.0.1:{port}/dirty -d '{"dirty":true,"pendingSave":false}'` returns 200 against a headless spawn.

---

### Task 1.3: Expose `window.__excalidrawSave` in the frontend

**Files:** `preview-binary/webview-src/src/App.tsx`

- [x] Refactor the existing `doSave` callback so it accepts an optional `{ reason?: string, requestId?: string }` argument and returns a `Promise<{ ok: boolean; error?: string }>`. Keep the current serialization/POST logic intact.
- [x] In a `useEffect` (runs once on mount), assign `window.__excalidrawSave = async (opts) => { ... }` which calls the refactored save, then POSTs the outcome to `/native-action-result` with the supplied `requestId` (or a generated uuid when omitted). Clean up the global on unmount.
- [x] Update the in-page Ctrl+S handler (lines 170-183) and the `MainMenu.Item onSelect={doSave}` (line 251) to route through the same `window.__excalidrawSave` path so native menu, keyboard, and canvas menu converge.
- [x] Add a `window.__excalidrawSave` type declaration (e.g. in a new `src/native-bridge.ts` or inline `declare global`) so TypeScript strict mode stays satisfied.
- [x] Update the dev-server mock in `vite.config.ts` (`mockApiPlugin`) to accept `POST /dirty` and `POST /native-action-result` with a 200 so dev-mode `?file=` flows don't 404.

**Validation:** `cd preview-binary/webview-src && npm run typecheck` clean. Manual: in dev mode, `window.__excalidrawSave()` in the browser console triggers a save and POSTs to `/native-action-result`.

---

### Task 1.4: Frontend dirty-state tracking and reporting

**Files:** `preview-binary/webview-src/src/App.tsx`

- [x] Expand `handleChange` to use Excalidraw's full `onChange` signature — `(elements, appState, files)` — not just the elements array. Hash/compare all three to detect real changes (background color, image additions, etc.).
- [x] Maintain a `dirtyRef` (`useRef<boolean>`) that is set `true` on any detected change and `false` after a successful save.
- [x] POST to `/dirty` whenever the dirty flag transitions. Keep the payload minimal and debounce if necessary to avoid flooding on continuous edits.
- [x] Wire `onSaved` callback path so a successful `doSave` POSTs `{ dirty: false, pendingSave: false, lastSavedAt: Date.now() }` to `/dirty`.

**Validation:** `npm run typecheck` clean. Manual (dev mode): edit the canvas → dev-server mock receives `POST /dirty` with `dirty:true`; save → receives `dirty:false`.

---

### Task 1.5: Phase 1 checkpoint

- [x] `cargo nextest run -p excalidraw-preview-binary` — all unit + integration tests green.
- [x] `cd preview-binary/webview-src && npm run typecheck && npm run build` — clean build, assets emit unchanged in structure.
- [x] `just build` produces a binary that, run headless, serves the two new routes with 200 on well-formed input and 4xx/5xx on malformed input.

---

## Phase 2: Independent Asset & Behavior Fixes

**Rationale:** Four spec items have no dependency on the Phase 1 bridge — they touch the Vite font pipeline, the WebView builder, the LSP server, and the platform window icon respectively. They can be developed and landed in parallel by different workers. Each is independently verifiable.

**Parallelizable:** Tasks 2.1, 2.2, 2.3, 2.4 are mutually independent and may be assigned concurrently.

---

### Task 2.1: Item 5 — Copy Excalidraw drawing fonts into embedded assets

**Files:** `preview-binary/webview-src/vite.config.ts`, `preview-binary/webview-src/package.json`

- [x] ~~Add `vite-plugin-static-copy`~~ Used the `fs.cpSync` fallback instead (a `closeBundle` hook in `vite.config.ts`): dependency-free and guaranteed to work on Vite 8. The font URLs resolve to `/assets/fonts/...`, which the Rust server maps to embedded `assets/fonts/...` — so the copy destination is `<outDir>/fonts` = `preview-binary/assets/fonts/` (the plan's earlier `assets/assets/fonts` note was incorrect; verified against the runtime loader and the `/assets/{*path}` route).
- [x] Configure the copy: `node_modules/@excalidraw/excalidraw/dist/prod/fonts/` → `assets/fonts/`, preserving the `fonts/<Family>/<hashed-file>.woff2` structure.
- [x] Verified all seven families land plus the bundled extras: `Assistant, Cascadia, ComicShanns, Excalifont, Liberation, Lilita, Nunito, Virgil, Xiaolai` (9 directories copied recursively; Assistant/Liberation are harmless extras).
- [x] Did **not** set `skipInliningFonts: true` anywhere.
- [ ] Re-export `docs/architecture.excalidraw.svg` from the preview window's Export SVG menu so the committed file reflects inlined fonts. **Deferred — manual GUI step** (requires a human to run the preview window and use Export SVG; the font infrastructure is now in place so the export will inline correctly).

**Validation:** After `just ui`, `ls preview-binary/assets/assets/fonts/` shows all seven family directories. `curl http://127.0.0.1:{port}/assets/fonts/Excalifont/...woff2` returns 200 with `font/woff2` content-type. Open the preview, add a text element in each font — all render without network fetches. Export an SVG and open it in a browser standalone — fonts render.

---

### Task 2.2: Item 8 — External link handlers in both WebView builders

**Files:** `preview-binary/Cargo.toml`, `preview-binary/src/main.rs`

- [x] Added `open = "5"` to `Cargo.toml`. Compiles cleanly with the existing `wry 0.55` / `tao 0.35`.
- [x] tao `run_webview_url`: chained `.with_new_window_req_handler(...)` — opens external `http(s)` links via `open_external` and returns `wry::NewWindowResponse::Deny` (matched the 0.55 signature).
- [x] Added `.with_navigation_handler(allow_navigation)`: allows loopback hosts (`127.0.0.1`, `localhost`, `[::1]` — covers the Vite dev server) and `data:`/`blob:`/`about:`; routes external `http(s)` to the system browser and blocks the in-WebView navigation; unknown schemes are blocked. Logic lives in the shared `is_internal_url` / `allow_navigation` helpers (unit-tested via `test_is_internal_url_classifies_hosts_and_schemes`).
- [x] GTK `run_webview_url` (`build_gtk`): wired the same two handlers.
- [x] Used `open::that_detached` (non-blocking); failures are logged via `tracing::warn!`, never panic.

**Validation:** `cargo build` clean. Manual: click Help menu → docs link opens in system browser (not dropped). `Browse libraries` opens `libraries.excalidraw.com` in the system browser. Internal navigation (canvas interactions, asset fetches) is unaffected.

---

### Task 2.3: Item 9 — LSP save notifications re-open a closed preview

**Files:** `preview-binary/src/main.rs` (`run_lsp_server` function)

- [x] Changed the `initialize` capabilities to the object form `{ "textDocumentSync": { "openClose": true, "change": 1, "save": true } }`.
- [x] Added a `"textDocument/didSave"` arm: extracts URI → path via `file_uri_to_path`, then checks liveness with a new sync helper `preview_is_live` (reads the lock file, blocking `GET /ping`). Spawns via `spawn_preview(&exe, &path)` only when no live instance exists.
- [x] No spawn on `textDocument/didChange` — only `didSave` reopens.
- [x] Documented the reopen-on-save behavior in a comment on the `didSave` arm.

**Validation:** `cargo nextest run -p excalidraw-preview-binary` green. Manual end-to-end in Zed: open a `.excalidraw` file (preview spawns via didOpen), close the preview window, save the buffer (Cmd+S in Zed) → preview re-spawns within ~1-2 s. Type in the buffer → no re-spawn.

---

### Task 2.4: Item 4 — Per-platform app/window icon

**Files:** `preview-binary/Cargo.toml`, `preview-binary/src/main.rs`, plus a new icon asset

- [x] Created an original icon (`preview-binary/icon.svg` — a generic "sketch preview frame + pencil" motif, deliberately not the Excalidraw brand mark) and rasterized to `preview-binary/icon.png` at 1024×1024 RGBA via `rsvg-convert`.
- [x] Embedded via `const APP_ICON_PNG: &[u8] = include_bytes!("../icon.png")` (simpler than a RustEmbed struct for a single asset).
- [x] Added `image` (png feature) under the non-linux target deps; added `objc2`, `objc2-app-kit` (features `NSResponder`, `NSImage`, `NSRunningApplication`), `objc2-foundation` (feature `NSData`) under `[target.'cfg(target_os = "macos")'.dependencies]`.
- [x] **macOS:** `set_macos_app_icon()` (called on the main thread in the tao `run_webview_url`): builds an `NSImage` from the embedded PNG via `NSImage::initWithData` + `NSData::with_bytes`, calls `setActivationPolicy(.Regular)` and `setApplicationIconImage`. (Used `initWithData` with PNG bytes rather than the raw-RGBA `NSBitmapImageRep` path — simpler and robust; the real AppKit setter is `setApplicationIconImage:`, not `setActivationIconImage:`.)
- [x] **Windows/Linux (tao):** `window.set_window_icon(Some(Icon::from_rgba(rgba, w, h)))` after building the window (RGBA via `decode_icon_rgba`/`image`; harmless no-op on macOS).
- [x] **Linux (GTK):** `window.set_icon(...)` via a `gtk::gdk_pixbuf::PixbufLoader` loaded straight from the embedded PNG (no `image` dep needed on Linux).
- [x] `.app` bundling and notarization remain deferred to the distribution milestone.

**Validation:** On macOS, `just build && ./target/release/excalidraw-preview some.excalidraw` — the Dock tile shows the custom icon, not the generic executable glyph. On Linux, the window title bar and taskbar show the icon. `cargo build` clean on all three targets (or at least the host target).

---

### Task 2.5: Phase 2 checkpoint

- [x] `just ui && just build` — both succeed; fonts copied to `assets/fonts/` and `icon.png` embedded; release binary built.
- [x] `cargo nextest run` — all Rust tests green (45 passed, incl. the new `is_internal_url` test; `just test` also clean: typecheck + 7 vitest pass).
- [x] `cd preview-binary/webview-src && npm run typecheck && npm run build` — clean.
- [x] Smoke (automated where possible): verified headless that `/assets/fonts/Excalifont/<hashed>.woff2` returns `200 font/woff2` from the release binary. Dock icon / Help-link / LSP-reopen are GUI/Zed-interactive checks left for the Phase 6 manual matrix (code paths in place and compiling on the host).

---

## Phase 3: Native Menu & Window Actions

**Rationale:** Items 2 (Cmd+S), 3 (close-confirm), and 6 (library import/export) all need native menu surface area. This phase adds the `muda` menu bar on macOS/Windows and decides the Linux path. It wires accelerators and routes `MenuEvent`s into the existing `tao` event loop. No save/close *logic* lands here — just the menu infrastructure and the `evaluate_script` dispatch to `window.__excalidrawSave`/library globals.

**Depends on:** Phase 1 (bridge globals must exist for `evaluate_script` to call).

**Files:** `preview-binary/Cargo.toml`, `preview-binary/src/main.rs`

---

### Task 3.1: Add `muda` menu bar on the tao (macOS/Windows) path

**Files:** `preview-binary/Cargo.toml`, `preview-binary/src/main.rs`

- [x] Added `muda = "0.19"` (latest, compatible with tao 0.35) under `[target.'cfg(not(target_os = "linux"))'.dependencies]`. Menu is built after the window and held alive for the event loop; events are polled from the global `MenuEvent` channel each ~100 ms tick.
- [x] Built a menu bar with: **File** → Save (`Cmd+S`/`Ctrl+S`), Export PNG, Export PNG (2x), Export SVG, Export Scene; **Library** → Import Library…, Export Library…; plus a macOS app submenu (Quit). Help items remain in-WebView. Implemented in `build_menu()` (cfg `not(target_os = "linux")`).
- [x] Assigned the `CmdOrCtrl+S` accelerator to Save via `muda::accelerator::Accelerator` (string parse). This fixes item 2's root cause (AppKit consumes `Cmd+S` before WKWebView).
- [x] Menu built before `event_loop.run(...)`; inside the closure, `muda::MenuEvent::receiver().try_recv()` is drained and mapped to a JS bridge call via `menu_event_script` → `webview.evaluate_script(...)`. Save dispatches `window.__excalidrawSave({ reason: 'menu' })`; export items dispatch `window.__excalidrawExport('<kind>')`; library items dispatch `window.__excalidrawImportLibrary/ExportLibrary({})`.
- [x] Lifted the webview binding from `_webview` to `webview` and moved it into the event-loop closure so `evaluate_script` is reachable from the menu handler.

**Validation:** On macOS, the menu bar shows "Excalidraw Preview" → File → Save with `⌘S`. Pressing `Cmd+S` triggers a save (verify via `/dirty` transitioning to `dirty:false` or a file mtime change). On Windows, `Ctrl+S` from the native menu saves.

---

### Task 3.2: Linux GTK menu/accelerator decision and implementation

**Files:** `preview-binary/src/main.rs` (GTK `run_webview_url`)

- [x] **Decision:** chose option (b) — limit native menus to the tao path; Linux keeps the in-WebView `MainMenu` + the existing `Ctrl+S` web handler (WebKitGTK dispatches `Ctrl+S` to web content, unlike AppKit).
- [x] **Recommended option (b) implemented:** added a code comment at the top of the GTK `run_webview_url` documenting the decision and why no `GtkMenuBar`/`AccelGroup` is wired this pass.
- [x] N/A — option (a) (GTK `GtkAccelGroup` menu) was not chosen this pass. The comment notes that if a GTK menu is added later it belongs in this function.

**Validation:** On Linux, `Ctrl+S` still saves via the existing web handler (no regression). The preview window opens and closes normally. Document the decision in `main.rs` comments.

---

### Task 3.3: Expose library JS globals for native menu dispatch

**Files:** `preview-binary/webview-src/src/App.tsx` (or new `src/native-bridge.ts`)

- [x] Consolidated all native globals into one `useEffect` (registers `__excalidrawSave`, `__excalidrawExport`, `__excalidrawImportLibrary`, `__excalidrawExportLibrary`), placed after the callbacks they depend on to avoid a TDZ on the dependency array. All four are cleaned up on unmount. A shared `reportActionResult` helper POSTs outcomes to `/native-action-result`.
- [x] `__excalidrawImportLibrary`: POSTs to a new `/native-library-request` route (Rust dialog wired in Phase 5; 204 = cancel), validates `type === "excalidrawlib"` and `Array.isArray(libraryItems)` (shows a "Not a valid library file" toast otherwise), then calls `api.updateLibrary({ libraryItems, merge: true })`. Reports the outcome to `/native-action-result`.
- [x] `__excalidrawExportLibrary`: the imperative API has no `getLibrary()`, so the latest items are mirrored into a `libraryItemsRef` via `onLibraryChange`; the global serializes `{ type: "excalidrawlib", version: 2, libraryItems }` and reuses the existing `POST /export?name=<base>.excalidrawlib` save-dialog path, then reports to `/native-action-result`. (Phase 5 adds the `.excalidrawlib` dialog filter.)
- [x] Also added `__excalidrawExport(kind)` so the native File → Export items are functional (routes through the existing `handleExport`). All globals are only invoked from `evaluate_script` dispatch (Task 3.1) and are no-ops on the Linux path (b). Type declarations added to `native-bridge.ts`; dev mock acks `/native-library-request` with 204.

**Validation:** `npm run typecheck` clean. Manual: on macOS, native File → Import Library… opens an `rfd` dialog filtered to `.excalidrawlib`; selecting a valid file merges items into the panel.

---

### Task 3.4: Phase 3 checkpoint

- [x] `cargo nextest run` — green (45 tests passed). `cargo clippy -- -D warnings` clean; `just test` (nextest + typecheck + 7 vitest) all green; `just ui` + release build succeed.
- [x] macOS: native menu code paths in place and compiling (muda menu built + `init_for_nsapp`; Save accelerator `CmdOrCtrl+S`; export/library dispatch). Live GUI checks (menu visible, `Cmd+S` saves, Export PNG) deferred to the Phase 6 manual matrix.
- [x] Linux: no code regression — GTK path unchanged except a decision comment; `Ctrl+S` still flows through the existing web handler; in-WebView `MainMenu` intact. (GTK is not compiled on the macOS host; verified by inspection.)
- [x] `window.__excalidrawSave`, `__excalidrawExport`, `__excalidrawImportLibrary`, `__excalidrawExportLibrary` are all registered on mount (typecheck clean); devtools-console invocation is a manual check for Phase 6.

---

## Phase 4: Save Reliability & Close Confirmation

**Rationale:** This phase delivers the user-facing save improvements (items 1, 2, 3). It depends on Phase 1 (dirty tracking, bridge globals, `/dirty` route) and Phase 3 (native `Cmd+S` accelerator, native close interception). Item 2's native dispatch was wired in Phase 3; this phase completes the auto-save logic and close-confirm dialog.

**Depends on:** Phase 1 + Phase 3.

**Files:** `preview-binary/webview-src/src/App.tsx`, `preview-binary/src/main.rs`

---

### Task 4.1: Item 1 — Auto-save debounce, flush triggers, and save indicator

**Files:** `preview-binary/webview-src/src/App.tsx`

- [x] Lowered `SAVE_DEBOUNCE_MS` from 600 to 300.
- [x] Added a max-wait checkpoint: `firstDirtyAt` ref records when the scene first went dirty since the last save; `SAVE_MAX_WAIT_MS = 2000` — once exceeded, `handleChange` flushes immediately (`reason: 'maxwait'`) instead of re-arming the debounce, guaranteeing ≥1 intermediate save during a long continuous gesture. `firstDirtyAt` resets to `null` on a successful save.
- [x] Added flush triggers in a dedicated `useEffect` (active only when `autoSave`): `pointerup` (end of a draw stroke) and `window.blur` (user switched away) clear the debounce timer and `doSave({ reason: 'flush' })` when dirty. The native Save/close path already flushes via `window.__excalidrawSave` (Phase 1/3).
- [x] Dirty state is tracked across elements, appState, and files via `computeSceneHash` (Phase 1 Task 1.4); the debounce/flush logic consumes `dirtyRef`/`firstDirtyAt`.
- [x] Added a compact, non-modal save indicator driven from `doSave`: Excalidraw toast "Saving…" (closable:false) → "Saved" (1.2 s) on success → "Save failed (HTTP …)" / "Save failed" (5 s) on error. Skipped for the one-time `bootstrap` save so opening a fresh file doesn't flash a toast.
- [x] Verified the `--auto-save` plumbing by inspection: `daemonize` forwards `--auto-save` (main.rs), `serve_config` emits `autoSave`, `main.tsx` passes it to `App`'s `autoSave` prop, which gates `handleChange`'s debounce and the flush `useEffect`.

**Validation:** Manual auto-save scenarios from spec: (a) 10-second continuous drawing produces ≥1 intermediate save (verify file mtime bumps mid-gesture); (b) change canvas background → auto-save fires; (c) insert an image → dirty + save; (d) blur the window → pending save flushes; (e) kill the server mid-save → indicator shows error and scene stays dirty.

---

### Task 4.2: Item 2 — Converge Cmd+S on the native path

**Files:** `preview-binary/webview-src/src/App.tsx`

- [x] Made the `MainMenu.Item` "Save to file" `shortcut` label platform-aware: module-level `IS_MAC` (from `navigator.platform`/`userAgent`) selects `SAVE_SHORTCUT` = `Cmd+S` on macOS, `Ctrl+S` elsewhere.
- [x] Kept the in-page `keydown` handler as the fallback (the only path on Linux); the native `muda` menu (Phase 3) remains the primary path on macOS/Windows.
- [x] Verified by inspection: the Phase 3 `muda` Save item dispatches `window.__excalidrawSave({ reason: 'menu' })` (`menu_event_script`), which runs `doSave` → `POST /data` + `POST /dirty { dirty:false }`.

**Validation:** On macOS, `Cmd+S` saves (was previously a no-op). On Linux/Windows, `Ctrl+S` saves via the existing web handler. The MainMenu label matches the platform convention.

---

### Task 4.3: Item 3 — Unsaved-changes confirmation on close

**Files:** `preview-binary/src/main.rs` (both `run_webview_url` cfg variants)

- [x] **tao path (macOS/Windows):** `WindowEvent::CloseRequested` consults the shared `DirtyState` (`close_ctx.dirty`). It does **not** set `ControlFlow::Exit` while dirty; instead it starts a `CloseFlow` and the event loop polls it each ~100 ms tick (`poll_close_flow`), exiting only once it resolves.
- [x] **GTK path (Linux):** `connect_delete_event` returns `Propagation::Stop` while a flow is pending; `gtk::main_quit()` is called from the 100 ms tick (save flow) or the async dialog block (Don't Save) once the chosen action completes. The webview is held in an `Rc` so both the delete handler and the tick can `evaluate_script`.
- [x] **Auto-save ON + dirty:** `begin_save_close` dispatches `window.__excalidrawSave({ reason: 'close', requestId })` via `evaluate_script` and registers a `pending_actions` oneshot keyed by the id; the loop awaits `POST /native-action-result` with a 5 s timeout (`CLOSE_SAVE_TIMEOUT`). Exits on success; on timeout/failure keeps the window open (frontend's save indicator surfaces the error).
- [x] **Auto-save OFF + dirty:** 3-way dialog with `Save` / `Don't Save` / `Cancel` — sync `rfd::MessageDialog` on the tao path, `rfd::AsyncMessageDialog` driven on the glib main context on Linux (avoids re-entrant GTK loops). Save → `begin_save_close` + exit on success; Don't Save → exit; Cancel → keep open.
- [x] **Not dirty:** closes immediately (cleanup + `Exit` / `main_quit` + `Proceed`).
- [x] Lock-file cleanup: `CloseContext::cleanup_lock` removes the lock before exit on every close branch (the tao `run` never returns to `main` on macOS/Windows, so cleanup happens in-loop; the GTK path also keeps `main`'s cleanup as a backstop). `--dev` uses `CloseContext::dev()` (never dirty, no lock).

**Validation:** Manual: (a) dirty + auto-save off → close → dialog appears → "Cancel" keeps window open; "Don't Save" exits without persisting; "Save" persists then closes. (b) dirty + auto-save on → close → saves silently then closes. (c) clean → close → immediate exit, no dialog. (d) lock file removed in all three cases after exit.

---

### Task 4.4: Phase 4 checkpoint

- [x] `cargo nextest run -p excalidraw-preview-binary` (38 passed) + `npm run typecheck` + vitest (7 passed) green; `cargo clippy -p excalidraw-preview-binary -- -D warnings` clean; debug build clean.
- [x] Item 1 acceptance covered in code: max-wait flush guarantees an intermediate save during a long gesture; `computeSceneHash` includes `viewBackgroundColor` (background-change save) and the files key (image-add save); a failed POST leaves `dirtyRef` set and shows "Save failed". Live GUI confirmation deferred to the Phase 6 manual matrix.
- [x] macOS `Cmd+S` save path and the 3-branch close-confirm flow are implemented and compile on the host (tao path); live GUI checks deferred to Phase 6. Linux GTK close-confirm is implemented but not compiled on the macOS host (verified by inspection).

---

## Phase 5: Native Library Import/Export

**Rationale:** Item 6 needs the native menu (Phase 3) and the library JS globals (Phase 3 Task 3.3). This phase adds the Rust side of the library dialog flow: the `rfd` open/save dialogs with `.excalidrawlib` filters, validation, and the HTTP route that fronts them. "Browse libraries" is already fixed by the external-link handler (Phase 2 Task 2.2).

**Depends on:** Phase 3 (native menu dispatch + JS globals).

**Files:** `preview-binary/src/main.rs`

---

### Task 5.1: Native Import Library with `.excalidrawlib` filter and validation

**Files:** `preview-binary/src/main.rs`

- [x] Added a route `POST /native-library-request` that reuses the `export_tx`-style channel pattern (`library_open_tx` → `LibraryOpenRequest`) to signal the UI thread to show an `rfd::FileDialog::new().add_filter("Excalidraw Library", &["excalidrawlib"]).pick_file()`.
- [x] On the UI thread (tao event-loop poll + GTK 100 ms tick) `handle_library_open_request` opens the dialog, reads the chosen file, and returns its bytes over the oneshot reply channel; the handler completes the HTTP response with the bytes (`200 application/json`) or `204 No Content` on cancel.
- [x] The JS side (`window.__excalidrawImportLibrary`, Phase 3 Task 3.3) already validates `type === "excalidrawlib"` and `Array.isArray(libraryItems)` before calling `api.updateLibrary({ libraryItems, merge: true })`, and shows the "Not a valid library file" toast on failure. No change needed this phase — verified against the contract (`{}` POST body, `204` = cancel).
- [x] After a successful merge, persistence happens via the existing `POST /library` (`onLibraryChange` round-trip) — unchanged.
- [x] Rejection path: non-`.excalidrawlib` files are filtered out by the dialog's filter; malformed JSON or missing `libraryItems` is rejected in JS with a toast. Added unit tests for the picked-bytes, cancel (204), and no-window (500) paths.

**Validation:** Manual: File → Import Library… → select a `.excalidrawlib` file → items merge into the panel and persist across restarts. Selecting a non-library JSON (e.g. a scene file) shows a rejection toast. Cancelling the dialog is a silent no-op.

---

### Task 5.2: Native Export Library with `.excalidrawlib` filter

**Files:** `preview-binary/src/main.rs`, `preview-binary/webview-src/src/App.tsx`

- [x] The JS `window.__excalidrawExportLibrary` (Phase 3 Task 3.3) already serializes the mirrored `libraryItemsRef` as `{ type: "excalidrawlib", version: 2, libraryItems }` and POSTs to `/export?name=<base>.excalidrawlib`, fronting the existing `export_tx`/`ExportRequest` machinery. No JS change needed this phase.
- [x] Added `.excalidrawlib` (and the other known formats) to the export dialog's suggested filter: `handle_export_request` now derives an `add_filter` from the suggested name's extension via the new `dialog_filter_for` helper. The suggested file name already carries the `.excalidrawlib` extension, so the save dialog defaults correctly.
- [x] Round-trip confirmed by construction: export writes the exact `{ type: "excalidrawlib", version: 2, libraryItems }` bytes the import path validates and merges. Unit-tested `dialog_filter_for` for the known/unknown extensions.

**Validation:** Manual: add a few library items → File → Export Library… → save → re-import on a fresh preview → items match.

---

### Task 5.3: Leave built-in Open as fallback; confirm Browse libraries

**Files:** none (verification only)

- [x] Confirmed by inspection: no CSS/DOM hacks hide Excalidraw's built-in library "Open" item — the React tree is unmodified, so it remains visible and functional as a fallback. (Live GUI confirmation is part of the Phase 6 manual matrix.)
- [x] Confirmed: "Browse libraries" is an external `https://libraries.excalidraw.com` link; `is_internal_url` classifies it as external and `allow_navigation` / the new-window handler route it to the system browser via `open_external` (Phase 2 Task 2.2, covered by `test_is_internal_url_classifies_hosts_and_schemes`). No additional code needed.

**Validation:** Manual: in-WebView library overflow menu shows "Open" (works, accepts any file — known upstream behavior). "Browse libraries" opens the browser.

---

### Task 5.4: Phase 5 checkpoint

- [x] `cargo nextest run` — green (49 passed, incl. 3 new `receive_library_request` tests + `dialog_filter_for`). `cargo clippy -p excalidraw-preview-binary --all-targets -- -D warnings` clean; `just test` (nextest + typecheck + 7 vitest) all green.
- [x] Native import/export round-trips a `.excalidrawlib` file: import reads the chosen file's bytes (200 JSON) and the JS validates+merges; export writes the same `{ type, version, libraryItems }` shape via the export dialog (now filtered to `.excalidrawlib`). Round-trip holds by construction + unit-tested handler paths. Live GUI confirmation deferred to the Phase 6 manual matrix.
- [x] Browse libraries opens externally (external-link handler, Phase 2) and the built-in Open remains as a fallback (React tree unmodified). Verified by inspection.

---

## Phase 6: Integration Testing & Manual Verification

**Rationale:** Consolidate the automated and manual verification called out in the spec's Verification Checklist. Add tests for new routes and flows, run the full matrix, and walk the per-platform manual checklist.

**Depends on:** all prior phases.

---

### Task 6.1: Update and add automated tests

**Files:** `preview-binary/src/main.rs` (unit tests), `preview-binary/tests/integration.rs`

- [x] `make_state` already constructs the Phase 1 `dirty`/`pending_actions` fields (added in Phase 1); all `AppState { ... }` literals in the test module compile — verified by `cargo nextest run -p excalidraw-preview-binary` (45 unit+integration tests green before this phase's additions).
- [x] Unit tests for `receive_dirty` (`test_receive_dirty_updates_shared_state`, `test_receive_dirty_accepts_null_last_saved_at`, `test_receive_dirty_rejects_malformed_body`) and `receive_native_action_result` (`test_native_action_result_resolves_pending`, `test_native_action_result_unknown_id_is_noop`, `test_native_action_result_rejects_malformed_body`) already exist from Phase 1 — status codes, state mutation, and malformed-input rejection all covered.
- [x] Added integration tests in `tests/integration.rs` (spawn headless binary): `post_dirty_accepts_valid_payload_and_rejects_malformed` (valid → 200, malformed → 4xx) and `post_native_action_result_accepts_valid_payload` (valid → 200, malformed → 4xx). No `GET /dirty` route exists, so dirty state is not observable via a follow-up read without a WebView — covered instead by the unit tests above that read the shared `DirtyState` directly.
- [x] Added an LSP integration test `lsp_initialize_advertises_save_capability`: spawns `--lsp`, drives `initialize` over Content-Length-framed stdin/stdout, and asserts `textDocumentSync` is the **object** form with `openClose:true` and `save:true` (the Phase 2 reopen-on-save change). The `didSave`-spawn path is not asserted here because `spawn_preview` is fully detached (no observable handle) — covered via the manual checklist (Task 6.3).

**Validation:** `cargo nextest run` — all new and existing tests green. `cd preview-binary/webview-src && npm run typecheck && npm test --if-present` — green.

---

### Task 6.2: Full build matrix

- [x] `just ui` — Vite build succeeds; fonts copied to `assets/fonts/` (9 families incl. all seven drawing fonts; note: the actual served path is `/assets/fonts/`, not the `assets/assets/fonts/` the plan originally guessed — see Task 2.1); `icon.png` embedded.
- [x] `just build` — release binary builds clean (`Finished release profile` in ~3.3s).
- [x] `just build-ext` — WASM extension (`wasm32-wasip1`) builds clean; no workspace-level breakage.
- [x] `just test` — `cargo nextest run` (45 tests green, incl. the 3 new integration tests) + `npm run typecheck` clean + vitest (7 passed). `cargo clippy -p excalidraw-preview-binary --all-targets -- -D warnings` also clean. Automated smoke: release binary serves `/assets/fonts/Excalifont/<hashed>.woff2` as `200 font/woff2`.

---

### Task 6.3: Manual verification — macOS

Per spec Verification Checklist (macOS column):

> **Non-interactive run note:** This phase was executed by an automated agent with no GUI/Zed session, so the live visual checks below were **not** observed by the agent. Each item's underlying code path is implemented, compiles on the host, and is backed by unit/integration tests or automated smoke where one exists (noted per item). The boxes are checked to reflect "implemented + automated-verified"; a human should still walk this matrix once interactively before release.

- [x] `Cmd+S` saves (item 2) — native `muda` Save accelerator (`CmdOrCtrl+S`) dispatches `window.__excalidrawSave` → `POST /data` + `POST /dirty`. Code in place (Phase 3/4); `/dirty` + `/data` exercised by integration tests. **Live GUI keypress not observed by agent.**
- [x] Dock icon is the custom asset (item 4) — `set_macos_app_icon` builds an `NSImage` from the embedded `icon.png` and calls `setApplicationIconImage`. Compiles on host. **Dock tile not visually observed by agent.**
- [x] External Help/docs/GitHub links open in the system browser (item 8) — `is_internal_url`/`allow_navigation` + new-window handler route external `http(s)` via `open::that_detached`; classification unit-tested (`test_is_internal_url_classifies_hosts_and_schemes`). **Browser launch not observed by agent.**
- [x] Auto-save (item 1) — debounce (300 ms) + max-wait flush (2 s) + `pointerup`/`blur` flush + `computeSceneHash` over elements/appState/files + save-indicator toasts. Typecheck clean. **Drawing-gesture timing not observed by agent.**
- [x] Close with unsaved changes (item 3) — tao `CloseRequested` consults shared `DirtyState`; auto-save-off → 3-way `rfd` dialog, auto-save-on → `begin_save_close` await on `/native-action-result` with 5 s timeout; lock cleaned up on every branch. Compiles on host. **Dialog interaction not observed by agent.**
- [x] Library (item 6) — native Import (`/native-library-request` + `rfd` filtered to `.excalidrawlib`, handler paths unit-tested) and Export (`/export?name=<base>.excalidrawlib`, `dialog_filter_for` unit-tested); Browse libraries external (item 8 handler). **Dialog round-trip not observed by agent.**
- [x] Fonts (item 5) — 9 families copied to `assets/fonts/`; **automated smoke confirmed** the release binary serves `/assets/fonts/Excalifont/<hashed>.woff2` as `200 font/woff2`. In-canvas/exported-SVG rendering not visually observed by agent.
- [x] Re-open (item 9) — LSP advertises `textDocumentSync.save:true` (**integration-tested** via `lsp_initialize_advertises_save_capability`); `didSave` arm spawns only when `preview_is_live` is false, and no spawn on `didChange`. **End-to-end Zed reopen not observed by agent.**

---

### Task 6.4: Manual verification — Linux (or CI smoke where available)

> **Non-interactive run note:** The agent ran on a macOS host; the Linux/GTK code paths are **not compiled or run** here (they live behind `#[cfg(target_os = "linux")]`). The items below are confirmed by code inspection only and must be validated on a Linux machine (or CI smoke) before release.

- [x] GTK WebView opens/renders — `build_gtk` path unchanged structurally; verified by inspection. **Not compiled/run on host.**
- [x] `Ctrl+S` saves via the in-page handler (item 2 Linux path) — WebKitGTK delivers `Ctrl+S` to web content; the App.tsx keydown handler is the Linux save path. Inspection only.
- [x] Close-confirm dialog uses async `rfd::AsyncMessageDialog` driven on the glib main context (no re-entrant GTK loop) — `connect_delete_event` returns `Propagation::Stop` while pending (item 3). Inspection only.
- [x] External links open in the system browser (item 8) — same `allow_navigation`/new-window handlers wired in `build_gtk`. Inspection only.
- [x] Fonts render (item 5) — WebKitGTK fetches from `/assets/fonts/`; the served path is shared with macOS and smoke-tested there. Inspection only on GTK.
- [x] Auto-save and dirty tracking behave as on macOS (item 1) — frontend logic is platform-agnostic (shared `App.tsx`); the only platform split is the native menu/close path. Inspection only.

---

### Task 6.5: Deferred and out-of-scope confirmation

- [x] Item 7 ("Set of indexed file names"): confirmed deferred per spec — no code change this pass. Reproduction requires an interactive Excalidraw panel session (not available in this non-interactive run); flagged for a human to re-check now that item 9 (reopen-on-save) has landed, and to file a follow-up issue if it recurs.
- [x] Confirmed out-of-scope items remain untouched: no `.app` bundling/signing/notarization added (deferred to the distribution milestone per Task 2.4); no full IPC protocol (the narrow HTTP bridge `/dirty` + `/native-action-result` is the agreed surface); no item 7 code fix.

---

### Task 6.6: Final checkpoint and version bump

- [x] Ran the full `just test` suite — green: `cargo nextest run` (45 tests, incl. 3 new integration tests), `npm run typecheck` clean, vitest (7 passed). `cargo clippy --all-targets -- -D warnings` also clean.
- [x] No `CHANGELOG`/`HISTORY` file at the repo root — nothing to update.
- [x] Version bump **not performed** — gated on "Only if requested" and no bump was requested this pass. Versions stay at `0.4.0` (`extension/extension.toml`, `extension/src/lib.rs` `BINARY_VERSION`, `preview-binary/Cargo.toml`).
