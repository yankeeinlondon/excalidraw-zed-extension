---
ready: false
---

# Review 10

## Findings

1. **Major: Linux/WebKitGTK and real native interaction coverage is still incomplete for the release criteria.**

   Suggested fix: run `just smoke` on Linux/WebKitGTK and record the result in `manual-checklist.md`. Also complete the remaining manual macOS/Linux checks that the harness explicitly cannot prove: real `Cmd+S` / `Ctrl+S` delivery, native File-menu clicks, the `rfd` Save / Don't Save / Cancel close dialog, native import/export/save dialogs, actual external-browser launch, Dock/taskbar icon rendering, and visual font rendering/SVG inlining.

   The new smoke harness is a real improvement: it creates a `wry` WebView and verifies the native-to-JS save bridge, close-preparation bridge, and URL classification path (`preview-binary/src/main.rs:1423`, `preview-binary/src/main.rs:1802`, `preview-binary/src/main.rs:1978`). I also ran the ignored smoke test locally and it passed 4/4. However, the checklist still says Linux `just smoke` has not been run (`features/2026-06-13-rough-edges/manual-checklist.md:27`), and every remaining human-facing native interaction is still unchecked (`features/2026-06-13-rough-edges/manual-checklist.md:38`, `features/2026-06-13-rough-edges/manual-checklist.md:56`, `features/2026-06-13-rough-edges/manual-checklist.md:69`, `features/2026-06-13-rough-edges/manual-checklist.md:87`, `features/2026-06-13-rough-edges/manual-checklist.md:93`). The harness itself documents those exclusions (`preview-binary/src/main.rs:1475`).

   This matters because the spec's fixes are mostly native shell behavior, not only bridge logic. A passing macOS hidden-WebView smoke run does not prove WebKitGTK close interception, WebKitGTK key delivery, `rfd` button mappings, platform file dialog filters, actual browser launch, or icon/rendering behavior.

2. **Minor: the embedded-font integration test constructs HTTP routes with platform-native separators.**

   Suggested fix: build asset URLs with `/` separators independent of the host OS, for example by stripping the `assets` prefix and joining `rel.components()` with `/`, or by replacing `std::path::MAIN_SEPARATOR` with `/` before prefixing `/assets/`.

   `embedded_font_routes` uses `rel.to_string_lossy()` directly inside a URL path (`preview-binary/tests/integration.rs:553`). On Windows, that can produce paths such as `/assets/fonts\Excalifont\file.woff2`, making the test exercise a non-browser URL shape or fail for the wrong reason. The runtime asset route is browser-style `/assets/fonts/<Family>/<file>.woff2`, so the regression test should construct the same path shape on every platform.

## Coverage Notes

I ran:

- `cargo test -p excalidraw-preview-binary` - passed, 49 unit tests, 13 integration tests, 1 ignored smoke test.
- `cargo test` - passed across the workspace.
- `npm test` in `preview-binary/webview-src` - passed, 52 tests.
- `npm run typecheck` in `preview-binary/webview-src` - passed.
- `cargo build -p excalidraw-preview-binary --release` - passed.
- `cargo build -p excalidraw-preview --release --target wasm32-wasip1` - passed.
- `cargo clippy -p excalidraw-preview-binary --all-targets -- -D warnings` - passed.
- `cargo clippy -p excalidraw-preview --target wasm32-wasip1 -- -D warnings` - passed.
- `cargo test -p excalidraw-preview-binary smoke_self_test_reports_all_checks_passing -- --ignored --nocapture` - passed with 4/4 smoke checks.

## Production Readiness

**Verdict: not production ready yet.**

The implementation is substantially stronger than review 9: the macOS real-WebView smoke harness passes, embedded fonts are covered by a normal integration test, and the existing save/dirty/LSP/library route tests remain green. I still would not mark this production ready until the Linux smoke run and the remaining real native interaction checklist are completed. Those are not cosmetic checks; they are the platform behaviors this spec set out to fix.
