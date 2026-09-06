# Acceptance checklist — Cmd+S silence, library drag twins, plain-JSON color-mode loss

Filled in during **Phase 7** (macOS manual GUI acceptance) and **Phase 8**
(Windows matrix on `build-win-native`). House rules, enforced throughout:

- **GUI cells must never be ticked from synthetic tests.** A vitest suite,
  headless harness, or smoke run may be cited as an *automated proxy* beside a
  cell, but only a human driving the real GUI can set `pass` or `fail`
  (spec §2.6, §3.6; lsp-strategy checklist precedent).
- The only honest cell values are `pass`, `fail`, `n/a (reason)`, and
  `not performed` (with a reason whenever one exists). Zero cells left blank.
- Every acceptance run records the build-identity table **first** — the
  stale-PATH failure mode (D2 §2.2 candidate 1) is invisible without it.
- The macOS menu accelerator stays authoritative (spec §2.4,
  do-not-reverse-without-new-evidence); nothing in this checklist may be
  satisfied by removing or demoting it.

## Build identity (record FIRST, before any matrix row)

| Item | Value |
|---|---|
| Preview binary `--version` | *record at acceptance* |
| Resolved binary path (`which excalidraw-preview` / release path) | *record at acceptance* |
| Extension version (`extension/extension.toml`) | `0.6.0` at Phase 1 (re-record at acceptance) |
| Zed version / build | *record at acceptance* (`zed: about`) |
| macOS version | *record at acceptance* |
| Windows host + OS version (Phase 8, `build-win-native`) | *record at acceptance* |
| Date(s) of acceptance runs | macOS: *pending* · Windows: *pending* |

Reference for the identity check: `BINARY_VERSION = 0.6.0`
(`extension/src/lib.rs:9`), all four version sites in agreement, tag `v0.6.0`
published; the menu accelerator first shipped in `v0.4.0` (`8f8326c`) — see the
decision log's Opening entry.

## D2 save matrix — 4 entry points × 3 scene states × 3 platforms

Entry points and their delivery paths:

- **accelerator** — Cmd+S via the native menu accelerator on macOS/Windows;
  Ctrl+S via the page-level keyboard handler (`App.tsx:609-624`) on Linux.
- **menu-bar File→Save** — click on the native menu bar (macOS/Windows only).
- **in-canvas Save** — the main-menu "Save to file" item inside the Excalidraw
  UI (`App.tsx:1107-1112`); exists on every platform.
- **close-flow save** — the "Save" choice of the unsaved-changes dialog; only
  offered on a dirty scene (spec §2.3 defines the cell as "save-and-close on a
  dirty scene"; a clean scene closes directly and a read-only preview has no
  bridge, so both are structurally absent).

Observable outcome to record per cell: saved-confirmation toast, "No changes to
save"-style notice, or error banner — **never silence** (spec §2.3).

### macOS (Phase 7)

| Entry point | Dirty editable | Clean editable | Read-only image preview |
|---|---|---|---|
| Cmd+S (menu accelerator) | not performed | not performed | not performed (today a proven silent no-op — the fix under test) |
| Menu-bar File→Save | not performed | not performed | not performed (today a proven silent no-op) |
| In-canvas Save | not performed | not performed | n/a (read-only preview has no Excalidraw UI, hence no in-canvas Save) |
| Close-flow save | not performed | n/a (clean close resolves the dirty-query and closes directly; no save is offered) | n/a (no React bridge; close falls back to cached not-dirty and closes directly) |

### Linux (needs a Linux desktop; CI platform)

| Entry point | Dirty editable | Clean editable | Read-only image preview |
|---|---|---|---|
| Ctrl+S (page-level keyboard handler) | not performed | not performed | not performed (no handler is mounted in the read-only preview) |
| Menu-bar File→Save | n/a (Linux has no native menu bar by design — `build_menu` is `#[cfg(not(target_os = "linux"))]`) | n/a (same) | n/a (same) |
| In-canvas Save | not performed | not performed | n/a (read-only preview has no in-canvas Save) |
| Close-flow save | not performed | n/a (clean close: no save offered) | n/a (no bridge; direct close) |

### Windows (Phase 8, `build-win-native`; interactive session required)

| Entry point | Dirty editable | Clean editable | Read-only image preview |
|---|---|---|---|
| Ctrl+S (menu accelerator) | not performed | not performed | not performed (today a proven silent no-op) |
| Menu-bar File→Save | not performed | not performed | not performed (today a proven silent no-op) |
| In-canvas Save | not performed | not performed | n/a (read-only preview has no in-canvas Save) |
| Close-flow save | not performed | n/a (clean close: no save offered) | n/a (no bridge; direct close) |

Escalation rule (spec §6.4): if the macOS triage (Track B) finds a muda
delivery failure, these Windows cells are **required before release**; if macOS
was clean, `not performed` remains an honest recorded gap until a session is
available. Record any remote-session input caveat alongside the results.

## §3.6 library manual criteria (GUI; Phase 7)

Automated proxy (context only, cannot tick these): the Phase 4 vitest
interleaving suites over the pure merge/persist module.

- [ ] **not performed.** Drag one library item onto the canvas → exactly **one**
      copy at the drop point.
- [ ] **not performed.** Multi-select N distinct items → exactly **N** copies.
- [ ] **not performed.** Repeat both immediately after a **Browse-install**.
- [ ] **not performed.** Repeat both after **SSE re-delivery** of an
      already-installed library (same-library re-install via Browse).
- [ ] **not performed.** Repeat both after a **panel edit** (add/rename an item
      in the library panel).
- [ ] **not performed.** The library panel itself shows **one tile per item**,
      before and after each step above.
- [ ] **not performed** *(added Phase 4 — the repro revealed this observable
      step: the reporting setup's persisted library is corrupted with 29
      duplicated ids, and the panel structurally rendered two tiles per
      duplicated item, appendix §2/§6).* Open the preview against the
      reporting setup's persisted shared library (`{config_dir}/excalidraw-zed/
      library.excalidrawlib` as it stands, still carrying the duplicated ids):
      the panel shows **one tile per item from load** (D3's dedupe-on-load
      remedy), and after any subsequent library edit persists, re-opening
      shows the file itself healed (one entry per id in the persisted JSON).
- [ ] **not performed.** The original twin repro, replayed per the
      [`library-repro-appendix.md`](./library-repro-appendix.md) answers →
      no duplication.

## §4.6 color-mode manual criteria (GUI; Phase 7)

Automated proxy (context only): the Phase 3 vitest injection-body tests, the
`restore()` proxy test, and the dirty-toggle pin.

- [ ] **not performed.** Toggle dark mode → save a plain `.excalidraw` → close
      the preview → reopen: canvas, toggle, and (on next save) the file **agree
      from frame one**.
- [ ] **not performed.** Re-open the same file after an **external edit** of
      `appState.exportWithDarkMode` → the edited value is respected.
- [ ] **not performed (one-time, pre-release gate; criterion re-scoped by the
      D1 re-litigation, decision-log entry D1).** excalidraw.com round-trip of
      a file saved by the new build: the file **opens cleanly — zero page
      errors, no data loss, scene fully editable**. The export-dark-mode toggle
      is **not** expected to pre-seed: current excalidraw.com strips the key on
      load by design (the mirror of the write-side stripping D1 works around;
      Track C evidence), so non-propagation there is recorded upstream
      behavior, not a failure of this fix.

## Automated proxies (record-keeping only — never tick a GUI cell above)

- `just test` full sweep (nextest + `tsc --noEmit` + vitest) — Phase 6 diffed
  against the Phase 1 baseline (124 nextest passed / 1 by-design skip, 144
  vitest passed, lints clean; see the decision log's Baseline entry).
- `just smoke` (real WebView, programmatic): save round-trip, close-interception
  query, save-and-close under conflict, link routing. It drives the JS bridge —
  it cannot synthesize native key equivalents, so it is never a substitute for
  the accelerator or menu-bar cells.
