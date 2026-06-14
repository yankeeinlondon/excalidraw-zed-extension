---
ready: false
---

# Review 8

## Findings

1. **Major: the release-facing documentation still contradicts the implemented behavior.**

   Suggested fix: update `README.md` before shipping: change the auto-save interval from 600 ms to the implemented 300 ms plus 2 s max-wait behavior, remove the known-limitation claim that "Browse libraries" does not work, and replace the `.excalidraw.png` placeholder with the actual supported behavior.

   The implementation now sets `SAVE_DEBOUNCE_MS = 300` and `SAVE_MAX_WAIT_MS = 2000` in `preview-binary/webview-src/src/App.tsx:79`, and both WebView builders route external links through `with_new_window_req_handler` / `with_navigation_handler` in `preview-binary/src/main.rs:1485` and `preview-binary/src/main.rs:1640`. But the README still says auto-save is "600 ms after every change" at `README.md:104`, still says "Browse libraries doesn't work" at `README.md:147`, and still contains a placeholder for `.excalidraw.png` behavior at `README.md:150`. That will send users and reviewers down the wrong path when validating this polish pass.

2. **Major: the highest-risk native GUI flows are implemented but still not actually verified interactively.**

   Suggested fix: run and record the manual checklist on each supported platform before release. At minimum, verify macOS `Cmd+S`, native File-menu Save, close-confirm Save / Don't Save / Cancel, close-with-auto-save, external Help / Browse Libraries browser launch, native library import/export dialogs, and exported SVG font rendering. For Linux, add a CI or manual GTK smoke that at least compiles and opens the GTK WebView path, exercises close interception, and confirms external link handling.

   The spec's core fixes depend on OS/WebView behavior that unit tests cannot prove: AppKit key-equivalent dispatch, `muda` menu events, `rfd` dialogs, Dock icon rendering, WebKitGTK delete-event interception, popup/new-window behavior, and actual Excalidraw font fetch/inlining. The repository has a detailed checklist in `features/2026-06-13-rough-edges/manual-checklist.md:10`, but every item remains unchecked. The plan also states that live GUI keypresses, Dock tile rendering, browser launch, drawing-gesture timing, close dialogs, native library dialogs, and in-canvas/exported-SVG rendering were not observed (`features/2026-06-13-rough-edges/plan.md:441`). Linux is explicitly called out as not compiled or run in this review environment (`features/2026-06-13-rough-edges/plan.md:452`). Given this feature is mostly native-window polish, this is a production-readiness gap even though the non-GUI logic has good automated coverage.

3. **Minor: the font-copy build step silently succeeds when the Excalidraw font source is missing.**

   Suggested fix: make `copyDrawingFontsPlugin` fail the production build if `node_modules/@excalidraw/excalidraw/dist/prod/fonts` is missing or if the expected font family directories are not copied. A warning is acceptable in dev, but not in the release build that embeds assets.

   `preview-binary/webview-src/vite.config.ts:55` currently only logs a warning and returns when the font source directory is missing. Item 5 is a release requirement, and missing fonts caused the original bug. A successful `npm run build` without fonts can produce a broken binary while looking green in CI unless a separate asset smoke runs every time.

## Coverage Notes

I ran:

- `cargo test -p excalidraw-preview-binary` - passed, 49 unit tests and 12 integration tests.
- `npm test --prefix preview-binary/webview-src -- --run` - passed, 52 tests.
- `cargo test -p excalidraw-preview` - passed, 8 extension tests.

I also accidentally tried `cargo test -p excalidraw-zed-extension`; that package name does not exist in this workspace.

## Production Readiness

**Verdict: not production ready yet.**

The implementation is close: the bridge routes, dirty/save race handling, LSP `didSave` reopen behavior, library persistence, external-link classification, and asset-copy mechanics all have meaningful automated coverage, and the current automated suites pass. I would not ship it as production-ready until the README is corrected and the native GUI checklist is actually run. The remaining unverified areas are not incidental; they are the main user-visible features in this spec.
