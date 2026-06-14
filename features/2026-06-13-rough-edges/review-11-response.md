# Review 11 — Response

Response to the single finding in [`review-11.md`](./review-11.md): production
readiness still depended on (a) an unrun Linux/WebKitGTK smoke pass and (b) the
real native-interaction checks the smoke harness explicitly excludes.

The review confirms the code is otherwise in good shape — review 10's Windows
URL-construction issue is fixed, and the automated coverage (real-WebView smoke
harness + embedded-font asset test) is strong and green. The remaining gap is
"release confidence on the exact platform behaviors," not code shape.

## What was done

### 1. Linux/WebKitGTK smoke is now automated in CI (closes finding 1, half a)

Rather than run `just smoke` on Linux once by hand and tick a box that silently
rots, the smoke harness now runs **on every push** against real WebKitGTK:

- New **`smoke-linux`** job in `.github/workflows/test.yml`. It installs
  `libwebkit2gtk-4.1-dev` + the GTK/ATK/GLib dev libs and `xvfb`, then runs the
  otherwise-`#[ignore]`d `smoke_self_test_reports_all_checks_passing` under a
  virtual X display:

  ```
  xvfb-run -a --server-args="-screen 0 1280x1024x24" \
    cargo nextest run --profile ci --run-ignored ignored-only smoke_self_test
  ```

  This exercises the Linux-specific paths the prior macOS-only run could not
  prove: real `wry`/WebKitGTK window creation, React mount + asset/font fetch
  over WebKitGTK, `evaluate_script` delivery, the `/native-action-result`
  round-trip, the close-interception state machine, and external-link routing.

- `manual-checklist.md` updated: the Linux smoke line no longer says "not yet
  run." It now points at the `smoke-linux` CI job and instructs gating the
  release on that job's first green run.

The nextest filter and the workflow YAML were both validated locally
(`cargo nextest list --run-ignored ignored-only smoke_self_test` resolves to
exactly that one test; the YAML parses).

### 2. macOS smoke re-confirmed today

`just smoke` re-run on macOS (arm64, 2026-06-14): **4/4 checks pass**, exit 0,
no window appears, no focus steal.

## Honest residual — the human-interactive checks (finding 1, half b)

The rest of finding 1 is a set of checks that, by construction, require a human
at the machine (real OS key injection, clicking native modal dialog buttons,
watching a browser launch, eyeballing icon/font rendering). An automated agent
cannot tick these without fabricating a result, and the smoke harness states
these exclusions deliberately. They remain unchecked in `manual-checklist.md`
and must be run by a person on macOS and Linux before release:

- Literal AppKit `Cmd+S` / WebKitGTK `Ctrl+S` key delivery and native File-menu
  clicks (the save **bridge** they drive is smoke-covered; the OS key/menu
  delivery is not).
- The `rfd` 3-way close dialog and its Save / Don't Save / Cancel buttons.
- Native save / import / export file dialogs and their filters.
- The actual system-browser launch for external links (URL **classification**
  is smoke-covered; the launch is not).
- Dock/taskbar tile rendering and in-canvas / exported-SVG font rendering.

Note: the Linux smoke run that review 11 called for is now mechanized; what
genuinely cannot be mechanized here is the list above.

## Test results (macOS, 2026-06-14)

- `cargo nextest run --run-ignored all -p excalidraw-preview-binary` — **63
  passed, 0 skipped** (the real-WebView smoke test included).
- `cargo clippy -p excalidraw-preview-binary --all-targets -- -D warnings` — clean.
- `cargo clippy -p excalidraw-preview --target wasm32-wasip1 -- -D warnings` — clean.
- `npm run typecheck` (webview) — clean.
- `npx vitest run` (webview) — 52 passed.
- `just smoke` (real WebView) — 4/4 PASS, exit 0, no focus steal.
