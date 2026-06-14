---
ready: false
---

# Review 9

## Findings

1. **Major: the core native/WebView behavior still has no completed end-to-end verification.**

   Suggested fix: run and record the manual checklist in `features/2026-06-13-rough-edges/manual-checklist.md` on the supported platforms before release, at least macOS and Linux. If possible, add a small platform smoke harness for the parts that can be automated: launch the real WebView, trigger `Cmd+S` / `Ctrl+S`, exercise close interception, and confirm one external `target="_blank"` link opens through the handler without navigating the editor.

   The implementation now wires the high-risk flows: Linux GTK close interception and external-link handlers are in `preview-binary/src/main.rs:1480` and `preview-binary/src/main.rs:1585`; macOS/Windows native menu, new-window handling, and close flow are in `preview-binary/src/main.rs:1636` and `preview-binary/src/main.rs:1677`; the frontend bridge for save, close preparation, and library import/export is in `preview-binary/webview-src/src/App.tsx:565`. But the checklist that covers these exact behaviors is still completely unchecked: `Cmd+S`/native menu save, auto-save during real drawing gestures, close dialog Save / Don't Save / Cancel, native library dialogs, export dialogs, external links, and SVG font rendering are all still marked `[ ]` in `features/2026-06-13-rough-edges/manual-checklist.md:10`.

   The automated coverage is good for the pure logic and HTTP routes, but it cannot prove the OS-specific parts this spec was mostly about: AppKit key-equivalent dispatch, `muda` accelerator delivery, `rfd` dialog behavior, WebKitGTK delete-event vetoing, Dock/taskbar icon rendering, external browser launch, or actual Excalidraw font fetch/inlining inside a real WebView. Shipping without this pass risks declaring the feature fixed while the originally reported rough edges still fail in the native shell.

## Coverage Notes

I ran:

- `cargo test -p excalidraw-preview-binary` - passed, 49 unit tests and 12 integration tests.
- `npm test` in `preview-binary/webview-src` - passed, 52 tests.
- `npm run typecheck` in `preview-binary/webview-src` - passed.
- `npm run build` in `preview-binary/webview-src` - passed and copied 9 font families into `assets/fonts`.
- `cargo test` - passed after the UI build completed, covering both workspace packages.
- `cargo build -p excalidraw-preview --release --target wasm32-wasip1` - passed.

One note: running `cargo test` concurrently with `npm run build` can fail because Vite's `emptyOutDir` temporarily removes `preview-binary/assets`, and `rust-embed` requires that directory during compilation. This is not a product bug if CI runs build/test steps sequentially, but it is worth keeping in mind for parallel job design.

## Production Readiness

**Verdict: not production ready yet.**

The implementation is close and the previous review's concrete issues appear addressed: README behavior is now aligned, the font-copy build fails loudly if assets are missing, LSP save notifications are tested, and the save/dirty/library race logic has meaningful unit and integration coverage. I would not call this production ready until the native checklist is actually executed and recorded. The remaining unverified surface is exactly the user-visible purpose of this spec, so passing headless tests alone is not enough confidence for release.
