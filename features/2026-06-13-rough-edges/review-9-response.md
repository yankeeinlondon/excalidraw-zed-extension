# Review 9 — Response

Response to the single finding in [`review-9.md`](./review-9.md): the native /
WebView behavior had no completed end-to-end verification, and the suggested fix
was to (a) run and record the manual checklist and (b) *if possible* add a small
platform smoke harness for the parts that can be automated.

## What was done

Both halves of the suggested fix are addressed, with the honest caveat that a
fully interactive GUI pass (clicking native dialogs, pressing real OS keystrokes,
eyeballing rendering) is not something this automated change can tick off — see
"Residual manual surface" below.

### 1. A real-WebView smoke harness (`--smoke`) — the automatable core

New `--smoke` mode opens a **real `wry` WebView** and drives the native shell
through its actual code paths, then prints a PASS/FAIL report and exits non-zero
on any failure. Implemented in `preview-binary/src/main.rs`:

- `SmokeDriver` (a state machine advanced one step per event-loop tick, mirroring
  the existing close flow so it never blocks the UI thread) runs three checks:
  1. **webview-mount + native save round-trip** — dispatches `window.__excalidrawSave`
     (the same bridge global the File-menu Save item and the `Cmd/Ctrl+S`
     accelerator dispatch into) and awaits its `/native-action-result`. A pass
     proves the React app mounted (so assets/fonts loaded), the IPC round-trip
     works, and the scene was written to disk via `POST /data`. A missing bridge
     fails fast via an inline fallback POST instead of timing out.
  2. **close-interception dirty-state query** — dispatches `window.__excalidrawPrepareClose`
     (the first step of every native close) and awaits its response.
  3. **external-link routing** — asserts `is_internal_url` classifies
     `libraries.excalidraw.com` external (handler blocks in-editor nav, routes to
     the system browser) and loopback internal.
- Wired into **both** event loops (tao for macOS/Windows, GTK for Linux); on
  completion `finish_smoke_and_exit` prints the report and exits 0/1.
- **Does not steal focus.** A smoke run must not pop a window over — or grab focus
  from — whatever the user is doing, or results go flaky. So in smoke mode the tao
  window is created hidden + unfocused (`with_visible(false)`, `with_focused(false)`)
  and the macOS app stays an `Accessory` (background, no Dock tile) app via the new
  `set_macos_background_activation` instead of promoting to `Regular`; the GTK
  window sets `focus_on_map(false)` / `accept_focus(false)` / `skip_taskbar_hint`.
  WebKit still loads and runs JS in a hidden window, so the round-trips work.
- Run it with **`just smoke`** (new recipe) or
  `cargo nextest run --run-ignored ignored-only smoke_self_test`.

**Verified on macOS, 2026-06-14:** `just smoke` and the integration test both
report **4/4 checks passing**, exit 0, with no window appearing and no focus
change.

### 2. Headless asset/font regression test — runs in the normal suite

New integration test `embedded_assets_serve_index_bundle_and_drawing_fonts`
(`preview-binary/tests/integration.rs`) boots the binary headless and asserts the
embedded `index.html`, every JS/CSS bundle it references, and one woff2 per
drawing-font family all serve over `GET /assets/**` with non-empty bodies. This
**automates the originally-reported regression** (missing fonts → 404s → broken
exported SVGs) so it can never silently regress, and it runs in CI without a
display. Passes (covers all 9 families).

### 3. Recorded coverage in the checklist + docs

- `manual-checklist.md` gained an **"Automated coverage"** section recording the
  macOS smoke + asset-test results and explicitly delineating what the automation
  does *not* prove. Items the harness covers programmatically are annotated
  _(smoke-covered)_.
- `AGENT.md` documents the `--smoke` flag and the `just smoke` recipe.

## Test results (macOS, 2026-06-14)

- `cargo nextest run` — 70 passed, 1 skipped (the display-gated smoke test).
- `cargo nextest run --run-ignored all` — **71 passed, 0 skipped** (smoke included).
- `cargo clippy -p excalidraw-preview-binary --all-targets` — clean.
- `cargo build -p excalidraw-preview-binary --release` — clean.
- `cargo build -p excalidraw-preview --release --target wasm32-wasip1` — clean.
- `just smoke` (release binary) — 4/4 PASS, exit 0, no focus steal.

## Residual manual surface (still requires a human)

The smoke harness deliberately exercises the *programmatic* core; it cannot prove
the parts that need OS input injection, a human eye, or dialog interaction. These
remain unchecked in `manual-checklist.md` and should be run on macOS and Linux
before release:

- Literal AppKit `Cmd+S` / WebKitGTK `Ctrl+S` key delivery and native File-menu
  clicks (the bridge they drive is smoke-covered; the key/menu delivery is not).
- The `rfd` 3-way close dialog and its Save / Don't Save / Cancel buttons.
- Native save/import/export file dialogs.
- The actual system-browser launch for external links (classification is covered).
- Dock/taskbar tile rendering and in-canvas / exported-SVG font rendering.
- **Linux (WebKitGTK):** `just smoke` has not yet been run there — do so before
  release.
