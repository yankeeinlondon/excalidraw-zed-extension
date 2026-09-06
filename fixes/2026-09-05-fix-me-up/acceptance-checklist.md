# Acceptance checklist — Cmd+S silence, library drag twins, plain-JSON color-mode loss

## Release-readiness statement (Phase 9, 2026-09-06)

> **Not ready to publish.** The code is complete, reviewed and green on every
> automated gate; the **human acceptance half of this entry has not been
> performed on any platform**, and that — not a known defect — is what gates the
> release.

**What is verified, and by what.** All three reported defects have a fix, a root
cause traced to specific vendored behavior, and regression coverage that uses the
original failing input where one exists:

| Defect | Fix | Verified by |
|---|---|---|
| Plain `.excalidraw` loses the document color mode (D1) | `serializeSceneForDisk` injects `appState.exportWithDarkMode` at **both** plain-JSON write sites; `reattachRawColorMode` restores it on load (upstream strips it both ways — finding N2) | Injector unit suite (byte-stability, idempotence, adversarial strings, malformed-input refusals), POST-body suites for both write sites, `restore()`/`loadFromBlob` proxies against the **real vendored 0.18.1**, a repeated read/write/read round trip on a shipped example, and a passive corpus over every shipped `docs/examples/*.excalidraw` |
| One library drag drops two copies (D3) | One choke point, `dedupeLibraryItems`, wired into all four flows; installs merge+dedupe inside a single atomic `updateLibrary`; corrupted files healed on load | 34 pure-module cases incl. all §3.5.2 interleavings and an 8-seed × 40-step interleaving driver; 11 cases against the **real vendored** `mergeLibraryItems`/`restoreLibraryItems` that reproduce the twin and then heal it; a fixture that is a **verbatim slice of the reporting setup's own corrupted library**. Plus one field observation: that live file self-healed 216 entries / 29 duplicated ids → **187 / 0**, survivors exactly per D3's rule |
| A save gesture can be completely silent (D2) | `SAVE_MENU_SCRIPT` falls back to `__excalidrawSaveUnavailable`, registered at module scope on every load path; `doSave`'s no-API return routes there too; `--version` added so build identity can be checked at all (finding N1) | 19 notice-routing cases, two `main.rs` dispatch-script tests, two artifact-level tests (embedded bundle **and** the bundle the real binary *serves* to a scene-less `.excalidraw.svg`), four `--version` tests through the real binary |

**On which build.** `excalidraw-preview 0.6.0`, embedding webview bundle
`assets/index-BzutzBzW.js`, on macOS 27.0 (`26A5425a`), Zed 1.18.1
(`20260904.150309`); extension `0.6.0` / `BINARY_VERSION` `0.6.0`, `extension/`
diff empty for this entry. Full rows below.

**Automated gates, this build:** `cargo nextest run` **132 passed / 0 failed / 1
skipped** (the by-design `#[ignore]`d smoke test, covered separately by
`just smoke` 5/5), `tsc --noEmit` clean, `vitest run` **263 passed (14 files) / 0
failed**, `just lint` (clippy `-D warnings` + `cargo fmt --check`) exit 0. Against
the Phase 1 baseline: **+8 nextest, +119 vitest, zero new failures, zero new
skips.**

**The honest outstanding gaps that gate publishing.** In priority order:

1. **No human has run the macOS GUI matrix (Phase 7 is open).** All 8 live D2
   cells, all 8 §3.6 library criteria and all 3 §4.6 color-mode criteria are
   `not performed — no human operator in the Phase 7 automated session`. The
   house rule is that a synthetic test may be *cited* beside a cell and may never
   *set* one, and it was not bent: nothing here was ticked from a passing test.
   Two of those cells carry weight beyond their own row — the *clean editable ×
   Cmd+S* cell settles spec §2.2's unconfirmed clean-scene-silence sub-claim, and
   the read-only cells are the only human confirmation that the D2 remedy renders
   at all (the tests prove the gesture reaches code that shows a notice, not that
   a notice appeared on screen).
2. **The Windows column was never reachable (Phase 8 is open).** `build-win-native`
   is powered off and its hypervisor cannot start it without cluster quorum; no
   binary was deployed and no identity captured. The spec §6.4 escalation rule was
   evaluated and **does not fire** — macOS triage classified candidate 1 (stale
   PATH) and eliminated the muda delivery failure with positive proof — so this is
   an honest recorded gap rather than a blocker *of its own*. Two caveats belong
   with that: the "macOS was clean" evidence is the triage's, not a human-run
   matrix (see gap 1), and the Windows-only parts of the path
   (`menu.init_for_hwnd`, WebView2) are exercised by nothing but a compile check.
3. **The one-time excalidraw.com round-trip (§6.3c) has not been run on a file
   saved by the new build.** Its criterion was re-scoped by the D1 re-litigation:
   opens cleanly / zero page errors / no data loss. The toggle is **not** expected
   to pre-seed — current excalidraw.com strips the key on load by design, which is
   recorded upstream behavior and not a failure of this fix.
4. **This entry's work is uncommitted.** No tag, Release asset or CI artifact is
   this build, which is also why the Windows runbook deploys source rather than a
   binary.

**What a release reviewer must believe, on evidence.** That the three defects are
fixed *in code* — that is supported by the table above and by
[`review-1.md`](./review-1.md), which found and fixed two further defects at
closure and cleared the rest. That the fixes behave correctly *in front of a
human* is **not yet supported by anything**, on any platform, and no cell in this
file claims otherwise.

---

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

## Phase 7 status — 2026-09-06

**Executed:** the build-identity capture (below) — its three guard commands are
non-interactive, so that half of Phase 7 ran to completion and the table is
filled with verified values.

**Not performed, and why:** every remaining Phase 7 item is a pixel observation,
and Phase 7 ran in an **automated, non-interactive session with no human at the
GUI**. The house rule above is not a formality here: a synthetic driver on this
host is both dishonest *and* intrusive — during Phase 5 a synthesized `Cmd+S`
landed in an unrelated application's prompt and two region screenshots captured
unrelated desktop content on a second display (decision log, Phase 5 checkpoint).
So the macOS D2 matrix, the §3.6 library criteria and the §4.6 color-mode
criteria are all recorded `not performed — no human operator in the Phase 7
automated session`, which is one of the four honest values. **Nothing was
ticked, and nothing was inferred from a passing test.**

Everything that *can* be prepared for the sitting has been: identity captured,
the operator runbook written (see the end of this file), and the one
precondition that had silently expired since Phase 4 found and given a restore
procedure (§3.6, the self-healed library — read that note before running the
library criteria, or that item is unrunnable).

## Phase 8 status — 2026-09-06

**Not performed, and why:** the Windows host is **down**. `build-win-native`
(`192.168.100.64:2222`) does not answer; a neighbour on the same L2 segment
cannot even ARP it; the guest (`build-win`, VMID 701) is listed `stopped` on its
hypervisor; and it cannot be started because that Proxmox cluster has
`Quorate: No` / `Activity blocked` (2 of 4 votes). Restoring cluster quorum is
the user's infrastructure step, not a Phase 8 step, so nothing was forced. Full
probe-by-probe evidence, including the two controls that rule out "wrong
network", is in
[`evidence/phase8-windows-host/reachability.md`](./evidence/phase8-windows-host/reachability.md);
[`win-preflight.sh --lan-probe`](./evidence/phase8-windows-host/win-preflight.sh)
reproduces the whole chain in one command and captures the identity rows by
itself once the host answers.

So **both halves** of the Windows column are `not performed`: the GUI cells
(which always needed an interactive Windows session and a human — spec §6.4) and
the SSH half that *was* in reach (deployment + `--version` identity capture).

**Escalation rule, resolved (spec §6.4, plan Phase 8 task 3):** the macOS triage
(Phase 2 Track B) classified **candidate 1 — stale PATH**, *not* a muda
accelerator delivery failure; candidate 2 was eliminated for the current build by
positive delivery proof (two synthesized-but-real `Cmd+S` key equivalents —
osascript-injected, so delivered through AppKit's real menu key-equivalent path —
each produced a complete, watcher-logged save round-trip through the shared
accelerator → `MenuEvent` → dispatch path). The rule's "elevated to
required-before-release" arm therefore does **not** fire, and this `not
performed` Windows column stands as an honest recorded gap. Two caveats a
release reviewer must weigh, not skip: the shared-path evidence comes from the
triage, not from a human-run macOS matrix (Phase 7 is also open), and the
Windows-specific parts of the path — `menu.init_for_hwnd` instead of
`init_for_nsapp`, WebView2 instead of WKWebView — are not exercised by any macOS
result.

**Prepared for the sitting:** the preflight/identity script above, and the
Windows operator runbook at the end of this file. One thing was verifiable from
here and is recorded as an automated proxy rather than a cell: at this commit the
whole `preview-binary` crate — bin, unit-test unit and `tests/integration.rs`,
so every `#[cfg(target_os = "windows")]` twin including the `init_for_hwnd` menu
attachment — **type-checks for `x86_64-pc-windows-gnu`** from macOS. It compiles;
it says nothing about pixels.

## Build identity (record FIRST, before any matrix row)

**Guard procedure** (added Phase 5; run these three commands and paste their
output into the table before touching a single cell — the stale-PATH failure
mode, D2 §2.2 candidate 1, is invisible without them):

```sh
which -a excalidraw-preview          # every candidate on PATH, in resolution order
readlink -f "$(which excalidraw-preview)"   # what the first one actually is
excalidraw-preview --version         # → "excalidraw-preview X.Y.Z"
```

The third command exists as of this entry (finding N1: the binary had no
`--version`, so the identity precondition of spec §2.3 could not be executed on
any build, including released ones). The number it prints is the binary crate's
version, which `just bump` keeps equal to `BINARY_VERSION` and to the two
manifest versions; `version_flag_matches_the_extension_binary_version_constant`
(which runs the command above and compares its output to `BINARY_VERSION`) and
`test_binary_version_matches_manifest` fail the build if they drift, so the
comparison below is meaningful. If `--version` errors, the binary under test
**predates this entry** — record that fact and stop: whatever it is, it is not
the build these cells describe.

Identity below was **captured 2026-09-06 by the Phase 7 automated session** (the
three commands are non-interactive, so this half of Phase 7 is executable
without a human). It describes the machine the macOS acceptance sitting will run
on. Re-run the guard at the sitting anyway and correct any row that has moved —
the whole point of the guard is that the binary the GUI actually launches may
not be the one recorded here.

| Item | Value |
|---|---|
| Preview binary `--version` | **`excalidraw-preview 0.6.0`** — captured 2026-09-06 from both the PATH binary and `target/release/excalidraw-preview`; no "unexpected argument" error, so this is a post-N1 build |
| Resolved binary path (`which -a excalidraw-preview`, then `readlink -f`) | `which -a` lists **exactly one distinct candidate**, `/Users/ken/.local/bin/excalidraw-preview` (printed 3× — three duplicate `PATH` entries pointing at the same directory, not three binaries). `readlink -f` → `/Volumes/coding/forks/excalidraw-zed-extension/target/release/excalidraw-preview`, i.e. the `just symlink` target. **No stale-PATH candidate exists** (D2 §2.2.1) |
| Binary identity vs. the sweep build | **same build, rebuilt in Phase 9** — the resolved binary now embeds `assets/index-BzutzBzW.js`. Phase 7 recorded `assets/index-CZBLqo1K.js`; the rename is expected and accounted for: [`review-1.md`](./review-1.md) finding 1 changed `main.tsx` + `color-mode.ts`, so `just ui && just build` was re-run and Vite re-hashed the entry chunk. **The acceptance sitting must test the `index-BzutzBzW.js` build**, not the Phase 6/7 one — re-run the guard and check this row first |
| Extension version (`extension/extension.toml`) | `0.6.0` — unchanged since Phase 1; `BINARY_VERSION` (`extension/src/lib.rs:9`) `0.6.0`; the extension crate's diff for this entry is empty (plan scope line "No `extension/` changes") |
| Zed version / build | **1.18.1** (build `20260904.150309`, `/Applications/Zed.app`) |
| macOS version | **27.0** (build `26A5425a`) |
| Windows host + OS version (Phase 8, `build-win-native`) | **not performed — host down 2026-09-06.** `192.168.100.64:2222` unreachable; ARP fails from a neighbour on the same segment; guest `build-win` (VMID 701) `stopped`; hypervisor `Quorate: No … Activity blocked`, so it cannot be started without restoring cluster quorum. Nothing was captured because nothing answered — no version, no OS build, no `where.exe` output. Evidence + one-command re-probe: [`evidence/phase8-windows-host/`](./evidence/phase8-windows-host/) |
| Windows binary under test (Phase 8) | **none deployed.** No Windows artifact exists for this build: `cargo check --target x86_64-pc-windows-msvc` fails in `aws-lc-sys` (`windows.h` absent — AGENT.md's recorded trap, re-verified), and a `-gnu` cross-build would not be "the release binary" (releases build MSVC). The runbook therefore builds **on** the host from this working tree, which is uncommitted and so cannot be fetched from a tag or a Release asset |
| Date(s) of acceptance runs | macOS: identity captured **2026-09-06**; GUI cells **not performed** (see the Phase 7 status note above) · Windows: deployment + identity attempted and diagnosed **2026-09-06**, **not performed** (host down); GUI cells **not performed** |

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

Expected outcome in the read-only column, after the Phase 5 remedy: a transient
notice at the bottom of the window reading *"Read-only preview — no embedded
scene to save. Re-export with "Embed scene" enabled to edit."* It is the only
outcome available there — no scene means no editor, hence no Excalidraw toast —
and the native Save script now calls it explicitly instead of evaluating to
nothing. A cell that shows **nothing at all** is a `fail`, not a pass.

### macOS (Phase 7)

Every `not performed` cell in this table carries the same reason, stated once
rather than repeated eight times: **no human operator in the Phase 7 automated
session** (see the Phase 7 status note above). The build these cells are to be
run against is identified in the table above and is on `PATH` now.

| Entry point | Dirty editable | Clean editable | Read-only image preview |
|---|---|---|---|
| Cmd+S (menu accelerator) | not performed | not performed | not performed — expect the Phase 5 notice, not silence (see below) |
| Menu-bar File→Save | not performed | not performed | not performed — expect the Phase 5 notice, not silence |
| In-canvas Save | not performed | not performed | n/a (read-only preview has no Excalidraw UI, hence no in-canvas Save) |
| Close-flow save | not performed | n/a (clean close resolves the dirty-query and closes directly; no save is offered) | n/a (no React bridge; close falls back to cached not-dirty and closes directly) |

### Linux (needs a Linux desktop; CI platform)

| Entry point | Dirty editable | Clean editable | Read-only image preview |
|---|---|---|---|
| Ctrl+S (page-level keyboard handler) | not performed | not performed | not performed — expect the Phase 5 notice (the read-only page now installs its own `Ctrl/Cmd+S` listener at module scope; it defers whenever the editor is mounted) |
| Menu-bar File→Save | n/a (Linux has no native menu bar by design — `build_menu` is `#[cfg(not(target_os = "linux"))]`) | n/a (same) | n/a (same) |
| In-canvas Save | not performed | not performed | n/a (read-only preview has no in-canvas Save) |
| Close-flow save | not performed | n/a (clean close: no save offered) | n/a (no bridge; direct close) |

### Windows (Phase 8, `build-win-native`; interactive session required)

Every `not performed` cell in this table carries the same two-part reason,
stated once: **the host was down on 2026-09-06** (`build-win` VMID 701 stopped,
hypervisor without quorum — Phase 8 status above), so no binary was deployed and
no identity captured; **and** these cells need an interactive Windows desktop
plus a human even when it is up (spec §6.4). The expected outcomes below are what
the operator should look for, not results.

| Entry point | Dirty editable | Clean editable | Read-only image preview |
|---|---|---|---|
| Ctrl+S (menu accelerator) | not performed | not performed | not performed — expect the Phase 5 notice, not silence |
| Menu-bar File→Save | not performed | not performed | not performed — expect the Phase 5 notice, not silence |
| In-canvas Save | not performed | not performed | n/a (read-only preview has no in-canvas Save) |
| Close-flow save | not performed | n/a (clean close: no save offered) | n/a (no bridge; direct close) |

Escalation rule (spec §6.4): if the macOS triage (Track B) finds a muda
delivery failure, these Windows cells are **required before release**; if macOS
was clean, `not performed` remains an honest recorded gap until a session is
available. Record any remote-session input caveat alongside the results.

**Resolved 2026-09-06 (Phase 8):** Track B classified candidate 1 (stale PATH)
and *eliminated* the muda delivery failure for the current build — two
synthesized-but-real `Cmd+S` key equivalents (osascript-injected, delivered
through AppKit's menu key-equivalent path) each drove a complete, watcher-logged
save round-trip. The escalation arm does not fire, so this column is an **honest
recorded gap, not a release blocker** — with the two caveats in the Phase 8
status note above (the shared-path evidence is the triage's, not a human-run
macOS matrix, and `init_for_hwnd` + WebView2 are Windows-only and unexercised at
runtime anywhere — they have only been compile-checked).

## §3.6 library manual criteria (GUI; Phase 7)

Automated proxy (context only, cannot tick these): the Phase 4 vitest
interleaving suites over the pure merge/persist module.

All cells below: `not performed — no human operator in the Phase 7 automated
session`.

> **Precondition change found in Phase 7 — read before running these.** The
> reporting setup's persisted shared library **has already self-healed** and no
> longer carries the twins. Measured 2026-09-06 at
> `~/Library/Application Support/excalidraw-zed/library.excalidrawlib`:
> **187 entries / 187 distinct ids / 0 duplicated ids**, 1,406,057 bytes,
> mtime 15:39 — against the Track A appendix's **216 / 187 / 29** at 1,828,840
> bytes, mtime 13:00. All 29 duplicate *entries* are gone and all 187 *ids*
> survive, so no unique item was lost. The surviving copies sit at positions
> **114–142** (the appendix's first-occurrence positions) and every one of their
> elements carries `updated` = 2026-06-16T23:18:42 — the **newer** of the two
> stamps, which is exactly D3's survivor rule (newest element `updated`,
> first-occurrence position). The heal happened when a preview process opened
> during the Phase 5/6 window seeded through `sanitizePersistedLibrary` and the
> seeding `onLibraryChange` echo persisted the deduped result — the self-heal
> path D3 predicted, now observed on real data rather than a fixture.
>
> This is field evidence *for* the remedy, but it **destroys the precondition**
> of the last-but-one item below, which was written in Phase 4 against a file
> "still carrying the duplicated ids". To run that item, restore the twinned
> state first with
> [`evidence/phase7-library-precondition/twin-library.py`](./evidence/phase7-library-precondition/twin-library.py)
> (`--install` backs the live file up and re-appends the 29-item block with its
> original older element stamps; `--restore` puts the backup back). It writes no
> user library content into this repo. It has **not** been run — running it is
> the operator's step at the sitting.

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
      **Precondition expired — restore it first** (see the note above): the live
      file healed itself on 2026-09-06. The *file* half of this item is already
      satisfied on real data by that heal (216 → 187 entries, survivor rule
      observably applied), but that is a filesystem observation and cannot tick
      a GUI cell; the **one tile per item from load** half is a pixel claim and
      is what the operator must still see.
- [ ] **not performed.** The original twin repro, replayed per the
      [`library-repro-appendix.md`](./library-repro-appendix.md) answers →
      no duplication.

## §4.6 color-mode manual criteria (GUI; Phase 7)

Automated proxy (context only): the Phase 3 vitest injection-body tests, the
`restore()` proxy test, and the dirty-toggle pin.

All cells below: `not performed — no human operator in the Phase 7 automated
session`.

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

- **Phase 6 sweep — run 2026-09-06, all gates green.** `just test`: **132
  nextest passed / 0 failed / 1 skipped**, `tsc --noEmit` clean, **252 vitest
  passed (14 files) / 0 failed**; `cargo clippy --workspace --all-targets --
  -D warnings` and `cargo fmt --check` clean. Diffed against the Phase 1
  baseline (124 nextest / 1 by-design skip, 144 vitest, lints clean — decision
  log's Baseline entry): **+8 nextest, +108 vitest, zero new failures, zero new
  skips**. The one skip is the same by-design `#[ignore]`d smoke test, covered
  here by `just smoke` instead. Full delta table and per-suite composition in
  the decision log's Phase 6 entry.
- **The build the acceptance sitting must test** (superseded once by Phase 9 —
  see the build-identity table): `target/release/excalidraw-preview`, `--version`
  → `excalidraw-preview 0.6.0`, embedding webview bundle
  `assets/index-BzutzBzW.js`. Phase 6/7 recorded `assets/index-CZBLqo1K.js`;
  Phase 9's review fix touched `main.tsx`, so `just ui && just build` re-ran and
  Vite re-hashed the chunk. Re-run the guard procedure above at acceptance anyway
  — the point of it is that the binary the GUI actually launches may not be this
  one.
- **Phase 9 gate re-run — 2026-09-06, after the review fixes.** `just test`:
  **132 nextest passed / 0 failed / 1 skipped**, `tsc --noEmit` clean, **263
  vitest passed (14 files) / 0 failed**; `just lint` exits 0. Delta vs. Phases
  6–8: **+11 vitest**, the regression tests for [`review-1.md`](./review-1.md)
  finding 1 (a scene-JSON payload declared `image/svg+xml` no longer has its
  colour-mode key out-ranked by the SVG baked-mode reader). nextest and lints
  unchanged; no new failures, no new skips.
- `just smoke` (real WebView, programmatic) — **run 2026-09-06 on macOS: 5/5
  checks passed** (webview mount + native save round-trip, close-interception
  dirty query, save-and-close under conflict, external-link routing, loopback
  navigation). It drives the JS bridge — it cannot synthesize native key
  equivalents, so it is never a substitute for the accelerator or menu-bar
  cells. It runs as an AppKit `Accessory` app and cannot steal foreground focus.
- Phase 5 (D2 read-only cells), context only: `save-notice.test.ts` (19 cases
  over the notice routing with injected I/O), two main.rs tests pinning that the
  dispatch script has no silent arm, and two artifact-level tests proving the
  global it names is registered by the *shipped* bundle — one over the embedded
  `Assets`, one over the bundle served by the real binary to a read-only
  `.excalidraw.svg`. None of these can see a pixel: they prove the gesture
  reaches code that shows a notice, not that a human saw one.
- Phase 5 build-identity: `excalidraw-preview --version` now exists, pinned by
  four integration tests through the real binary — including one that compares
  the printed version against `BINARY_VERSION`.
- **Phase 7 gate re-run — 2026-09-06, unchanged from Phase 6.** `just test`:
  **132 nextest passed / 0 failed / 1 skipped**, `tsc --noEmit` clean, **252
  vitest passed (14 files) / 0 failed**; `just lint` exits 0. Phase 7 changed no
  source file, and the numbers confirm it.
- **Windows cross-check — 2026-09-06, compile level only.** At this commit
  `cargo check --target x86_64-pc-windows-gnu -p excalidraw-preview-binary
  --all-targets` (with `CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc`) is
  clean: the bin, its unit-test unit and `tests/integration.rs` all type-check
  for Windows with `muda`/`tao`/`webview2-com`/`rust-embed` in the graph, so
  every `#[cfg(target_os = "windows")]` path — including the `init_for_hwnd`
  menu attachment the Windows accelerator cells depend on — compiles. The MSVC
  target still fails in `aws-lc-sys` for want of `windows.h`, exactly as
  AGENT.md records. This links nothing and runs nothing: it cannot tick a
  Windows cell, and it is not a deployable artifact.
- **Phase 8 gate re-run — 2026-09-06, unchanged from Phases 6 and 7.**
  `just test`: **132 nextest passed / 0 failed / 1 skipped**, `tsc --noEmit`
  clean, **252 vitest passed (14 files) / 0 failed**; `just lint` exits 0.
  Phase 8 changed no source file, and the numbers confirm it.
- **Field observation, not a GUI cell — D3's self-heal on real data.** The
  reporting setup's persisted library went 216 entries / 29 duplicated ids →
  **187 / 0** during the Phase 5/6 window, all 187 ids surviving, survivors at
  the first-occurrence positions carrying the newer element stamps. That is
  D3's survivor rule applied to the exact file the Track A appendix documented,
  through the real binary and the real vendored panel rather than a fixture. It
  is strong evidence for the remedy and it is *still not a pass*: it says the
  persisted JSON is correct, not that a human saw one tile per item. See the
  precondition note in §3.6 before running those criteria.

## Operator runbook — macOS sitting (Phase 7)

Written by the Phase 7 automated session so the human pass is one sitting. It
prescribes no outcomes; record what you actually see.

1. **Identity first.** Run the three guard commands at the top of this file and
   correct the build-identity table if anything has moved from the 2026-09-06
   capture. If `--version` errors, stop — that binary predates this entry.
2. **Confirm the extension is the dev extension.** Zed command palette → "zed:
   install dev extension" → `./extension`. Nothing in `extension/` changed for
   this entry, so a previously installed dev extension is still current.
3. **D2 matrix (8 live macOS cells).** For each of the three scene states, open
   the file in Zed and drive all four entry points:
   - *dirty editable* — open `docs/examples/system-architecture.excalidraw`,
     make a visible edit, then: Cmd+S · menu bar File→Save · in-canvas main menu
     "Save to file" · close the window and choose Save.
   - *clean editable* — reopen the same file, change nothing, then Cmd+S ·
     File→Save · in-canvas Save. (Close-flow is `n/a`: a clean close offers no
     save.) These cells settle the §2.2 clean-scene-silence sub-claim.
   - *read-only image preview* — an `.excalidraw.svg`/`.png` exported **without**
     "Embed scene". Cmd+S and File→Save must each show *"Read-only preview — no
     embedded scene to save…"*. **Nothing at all is a `fail`, not a pass.**
   Record the observed outcome per cell (toast text / notice text / banner), not
   just pass-fail.
4. **§3.6 library criteria.** Read the precondition note in §3.6 first, then
   `evidence/phase7-library-precondition/twin-library.py --install`, run the
   criteria, and `--restore` afterwards. The script backs the live library up
   and its restore is byte-identical (verified 2026-09-06 against a copy).
5. **§4.6 color-mode criteria**, including the one-time excalidraw.com
   round-trip — run it as re-worded there (opens cleanly / zero page errors / no
   data loss; the toggle is **not** expected to pre-seed).
6. **Any `fail` loops back** to the owning phase (3 = color mode, 4 = library,
   5 = save) before Phase 8, per the Phase 7 validation checkpoint.

## Operator runbook — Windows sitting (Phase 8, `build-win-native`)

Written by the Phase 8 automated session, which got as far as proving the host
is off. Steps 1–4 are the deployment half (SSH, no GUI); step 5 onwards needs an
interactive desktop on that host — RDP or the physical console.

1. **Wake the host.** `qm start 701` on `monster` fails while its Proxmox
   cluster is short of quorum (`Quorate: No … Activity blocked`, 2 of 4 votes on
   2026-09-06), so bring the other cluster nodes back first. Then
   `evidence/phase8-windows-host/win-preflight.sh` — it probes, and once the host
   answers it prints the OS version, `where.exe excalidraw-preview` and
   `excalidraw-preview --version` for the build-identity table. Run it with
   `--lan-probe` if it still reports the host unreachable; that tells you whether
   the box is down or merely unroutable.
2. **Deploy the source, not a binary.** This entry's work is *uncommitted*, so
   there is no tag, Release asset or CI artifact that is this build, and no
   Windows binary can be produced on macOS (MSVC cross-build fails in
   `aws-lc-sys`; see `evidence/phase8-windows-host/reachability.md` §5). From the
   repo on macOS:

   ```sh
   git bundle create /tmp/fix-me-up.bundle main
   git diff HEAD > /tmp/fix-me-up-worktree.patch   # the uncommitted entry work
   scp /tmp/fix-me-up.bundle /tmp/fix-me-up-worktree.patch build-win-native:
   ```

   (`git diff HEAD` carries tracked modifications only. The untracked files in
   this entry are records under `fixes/`, not build inputs, so the build is
   unaffected — but copy them too if you want the checklist on the host.)

   Then in PowerShell on the host:

   ```powershell
   git clone $HOME\fix-me-up.bundle C:\src\excalidraw-zed-extension
   cd C:\src\excalidraw-zed-extension
   git apply $HOME\fix-me-up-worktree.patch
   ```

3. **Build on the host** (that is what a build box is for). Needs the MSVC Rust
   toolchain, Node/npm and the WebView2 runtime (present by default on Win11):

   ```powershell
   just ui                                              # never skip: assets embed at compile time
   cargo build -p excalidraw-preview-binary --release
   .\target\release\excalidraw-preview.exe --version     # → excalidraw-preview 0.6.0
   ```

   If `--version` errors, the binary predates this entry — stop and rebuild.
   Record the version, the OS build and `where.exe excalidraw-preview` output in
   the build-identity table before touching a cell.
4. **Sanity-check the automated gates on Windows** while you are in a shell:
   `cargo nextest run` (the Windows twins of the Unix-only tests compile only
   here, so this is the first time they *run*) and `just lint`. Any failure here
   is a finding in its own right — record it beside the matrix.
5. **D2 matrix, Windows column (8 live cells).** Zed is not required: the matrix
   is about the preview window, so launch the binary directly on a file. For each
   scene state, drive all four entry points and record the *observed* outcome
   (toast text / notice text / banner), not just pass-fail:
   - *dirty editable* — `.\target\release\excalidraw-preview.exe
     docs\examples\system-architecture.excalidraw`, make a visible edit, then:
     Ctrl+S · menu bar File→Save · in-canvas main menu "Save to file" · close the
     window and choose Save.
   - *clean editable* — reopen the same file, change nothing, then Ctrl+S ·
     File→Save · in-canvas Save. (Close-flow is `n/a`: a clean close offers no
     save.)
   - *read-only image preview* — `docs\examples\architecture.excalidraw.svg`,
     which carries **no** embedded scene. Ctrl+S and File→Save must each show
     *"Read-only preview — no embedded scene to save…"*. **Nothing at all is a
     `fail`, not a pass.**
6. **Record the remote-session input caveat** (spec §6.4 requires it). Over RDP
   some key combinations are consumed by the client rather than delivered to the
   focused window; if the accelerator cells were driven over RDP, say so beside
   them, and prefer the physical console for the Ctrl+S rows if one is available.
   A `fail` on an accelerator cell that only ever ran over RDP is a suspect
   result, not a verdict.
7. **Any `fail` loops back** to the owning phase (5 = save) before Phase 9, the
   same rule the macOS column follows.
