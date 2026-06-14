---
ready: false
---

# Review 11

## Findings

1. **Major: production readiness still depends on unrun Linux/WebKitGTK and real native-interaction checks.**

   Suggested fix: before release, run `just smoke` on Linux/WebKitGTK and update `features/2026-06-13-rough-edges/manual-checklist.md` with the result. Then complete the manual native checks that the smoke harness explicitly excludes: real `Cmd+S` / `Ctrl+S` delivery, native File-menu save/export clicks, the `rfd` Save / Don't Save / Cancel close dialog, native library import/export dialogs, actual external-browser launch, Dock/taskbar icon rendering, and visual in-canvas/exported-SVG font rendering.

   Review 10's minor Windows URL-construction issue in the font asset test is fixed: `embedded_font_routes` now joins path components with `/`, matching browser URL paths on every host (`preview-binary/tests/integration.rs:553`). The automated coverage is otherwise strong: the real-WebView smoke harness exercises React mount, native-to-JS save, close-preparation, and external-link classification (`preview-binary/src/main.rs:1423`, `preview-binary/src/main.rs:1802`, `preview-binary/src/main.rs:1978`), and it passes locally.

   The remaining gap is not code shape; it is release confidence on the exact platform behaviors this spec targets. The checklist still records Linux smoke as not run (`features/2026-06-13-rough-edges/manual-checklist.md:27`), and the user-facing native interactions remain unchecked (`features/2026-06-13-rough-edges/manual-checklist.md:38`, `features/2026-06-13-rough-edges/manual-checklist.md:56`, `features/2026-06-13-rough-edges/manual-checklist.md:69`, `features/2026-06-13-rough-edges/manual-checklist.md:87`, `features/2026-06-13-rough-edges/manual-checklist.md:93`). The smoke harness itself states those exclusions (`preview-binary/src/main.rs:1475`). Given the spec is primarily a native-window polish pass, I would not treat those checks as optional.

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

The implementation is close: automated save/dirty/LSP/library/asset coverage is green, the macOS real-WebView smoke path passes, and the review-10 test portability issue is fixed. I still would not mark this spec production ready until Linux/WebKitGTK smoke and the remaining real native interaction checklist are completed and recorded. Those checks cover the core user-visible fixes in the spec, not peripheral polish.
