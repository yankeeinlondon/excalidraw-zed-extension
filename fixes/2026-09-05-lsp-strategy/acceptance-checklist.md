# Acceptance checklist — LSP event strategy & language restructure

Filled in during **Phase 9** (real-Zed acceptance). Do not tick boxes from
synthetic tests — a synthetic `didOpen` test does not satisfy this gate
(plan Phase 9 / spec §7).

> **Phase 9 status (2026-09-05):** the automated half of this gate is complete
> and green (builds, full test sweep, clippy/fmt, real-WebView smoke including
> save-and-close-under-conflict, upstream issue filed). The interactive
> real-Zed walk-through items below are annotated **not performed** — they
> require driving the Zed GUI (dev-extension install via the command palette
> and click-through verification), which cannot be done from this non-interactive
> session (Zed 1.18.1's CLI has no `--install-dev-extension`). They remain the
> outstanding human steps before publishing; everything else is done.

## Build identity (Phase 9 fills in)

| Item | Value |
|---|---|
| Zed version | `1.18.1` (stable, build `20260904.150309`) — installed on this machine; **acceptance run not yet performed** |
| Zed commit | not exposed by the stable bundle (Info.plist carries no git commit); record from `zed: about` during the interactive run |
| Extension version (`extension/extension.toml`) | `0.6.0` |
| Preview binary version | `0.6.0` (`preview-binary/Cargo.toml`) |
| OS / platform | macOS aarch64 (Apple Silicon) |
| Date of acceptance run | automated half: 2026-09-05 · interactive real-Zed run: **pending** |

## Packaging / registration

- [ ] **not performed (GUI install required).** The grammar-less `SVG` language
      loads and packages without a "grammar not found" rejection (upstream docs
      describe a grammar as required — risk item; **if this fails, Stream A is
      blocked — report before anything else**). Mitigating precedent: the
      existing grammar-less `Excalidraw` language installs and runs, and
      `just build-ext` compiles the WASM with both languages declared.
- [ ] **not performed (GUI required).** Both manifest language mappings are
      active (status bar shows Excalidraw / SVG where appropriate).

## Click-to-preview regression (the fix under test)

- [ ] **not performed (GUI required).** Fresh `.excalidraw.svg` buffer → viewer
      opens. **This is the regression test.** Automated proxies: the LSP
      integration harness (`lsp_did_open_spawns_one_instance_per_guarded_suffix`)
      proves the guarded suffix spawns a preview when Zed *does* deliver
      `didOpen`; only real Zed can prove suffix routing itself.
- [ ] **not performed (GUI required).** Fresh `.excalidraw` buffer → viewer
      opens. (Same automated proxy as above.)

## Buffer lifecycle behavior

- [ ] **not performed (GUI required).** Close and reopen the Zed buffer while
      the viewer is live → focus, exactly one instance.
- [ ] **not performed (GUI required).** Re-click an already-open tab → no event
      promised, no focus (documented behavior).
- [ ] **not performed (GUI required).** Close the viewer window, then save in
      Zed → viewer reopens. (Automated proxy:
      `lsp_did_save_reopens_preview_after_window_close`.)
- [ ] **not performed (GUI required).** Preview-tab replacement (single-click
      browsing between files) → viewer does **not** flicker shut. (Automated
      proxy: `lsp_did_close_keeps_preview_alive` — `didClose` broadcasts
      `editor-closed` and never tears the preview down.)
- [ ] **not performed (GUI required).** LSP teardown ~3 s after the last
      matching buffer closes, then restart with `didOpen` replayed → exactly one
      preview instance, no duplicates. (Lock-file dedup is covered by
      `lsp_did_save_while_live_spawns_no_second_instance`.)
- [ ] **not performed (GUI required).** Plain `.svg` file → no viewer spawns,
      no error. (Automated proxy: `lsp_ignores_plain_svg_and_malformed_uris`.)
- [ ] **not performed (GUI required).** `.excalidraw.png` → Zed's image pane
      renders it (expected limitation; viewer via CLI only).

## Conflict model (clean and dirty external saves)

- [ ] **not performed (GUI required).** External save from Zed with a
      **clean** viewer → silent reload, viewport preserved. (Automated proxies:
      `sse_fires_when_file_changes_on_disk`,
      `viewer_write_is_not_echoed_as_reload_but_external_write_is`, and the
      vitest `SyncController` reconcile suites.)
- [ ] **not performed (GUI required).** External save from Zed with a
      **dirty** viewer → conflict banner; both resolutions tested (Reload from
      disk / Keep my changes). (Automated proxies: vitest
      `conflict-ui.test.tsx` + `sync-controller.test.ts` cover both
      resolutions, the second-revision 412, and the paused writes; only the
      real Zed→disk→SSE path needs eyes.)
- [ ] **not performed (GUI required).** Zed auto-save enabled → no spurious
      conflicts, no lost viewer work.

## Coexistence & overhead

- [ ] **not performed (GUI required).** Coexistence with any installed XML/SVG
      extension and with user `file_types` overrides → no crash, user settings
      untouched.
- [x] Ordinary `.svg` open overhead measured (server startup cost): **median
      5.3 ms** — `excalidraw-preview --lsp` spawn + `initialize` round-trip,
      7 runs (4.8–9.6 ms), release binary on macOS aarch64. (For reference:
      headless preview-server spawn → `/ping` median 14.9 ms.) The LSP is an
      idle no-op for plain `.svg`, so this one-time spawn is the entire cost.

## Native / platform checks (record any not performed + reason)

- [x] `just smoke` PASS on macOS (real WebView, display available) — 5/5
      checks: webview-mount + native save round-trip; close-interception
      dirty-state query; **save-and-close under conflict fails cleanly**
      (external disk edit forces the conditional save to 412; the bridge must
      report failure so the window stays open — automated this phase, see
      `SmokeDriver::begin_conflict`); external link routed out of editor;
      loopback navigation kept in editor. Also green via the ignored
      integration test `smoke_self_test_reports_all_checks_passing`.
- [x] Manual native-bridge check: Save-and-close under conflict — performed as
      an **automated real-WebView check** (`just smoke`, see above): the
      close-save raced an external edit and reported `ok:false` ("File changed
      on disk") — the exact result the native close flow maps to
      `CloseOutcome::Failed` → error dialog + window kept open. The
      dirty-viewer *GUI* variant (human draws an element, external edit, then
      closes the window) was **not performed** (non-interactive session); its
      logic is covered by vitest (`SyncController — save-and-close under
      conflict`, conflict-pending blocks all writes).
- [ ] Linux equivalents **not performed** — this session ran on macOS only
      (no Linux display available). The GTK code path compiles
      (`--all-targets`) but its smoke run remains to be executed on a Linux
      desktop.

## Full validation sweep

- [x] `just ui` → `just build` (UI **before** binary so embedded assets speak
      the same protocol) → `just build-ext`. All three green; the release
      binary was rebuilt after the final source change.
- [x] `just test` green — 116 nextest passed (1 skipped = the display-gated
      smoke self-test, green when run explicitly), webview `tsc --noEmit`
      clean, 137 vitest passed.
- [x] `cargo clippy --workspace --all-targets -- -D warnings` and
      `cargo fmt --check` clean.

## Upstream & release

- [x] Upstream Zed issue filed for the compound-suffix `didOpen` bug, based on
      [`zed-compound-suffix-repro.md`](./zed-compound-suffix-repro.md); issue
      URL: **https://github.com/zed-industries/zed/issues/63831**
- [ ] Implementation committed; `just bump <version>` run on clean `main`;
      publishing performed only after acceptance passes — **deferred**: this
      phase was executed under an explicit "do not commit or stage" instruction
      (commit is a separate process). `just bump 0.7.0` (or the chosen next
      version) must run on a clean `main` *after* that commit and after the
      interactive real-Zed items above pass; publishing stays gated on
      acceptance.
