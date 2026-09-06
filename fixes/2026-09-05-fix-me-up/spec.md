---
reviewed: false
clarified: "opencode/glm-5.3"
---

# Spec: Cmd+S silence, library drag twins, plain-JSON color-mode loss

Date: 2026-09-06
Status: draft — decisions ratified; open-item resolution approaches decided
(§6), executions pending
Scope: `preview-binary/webview-src/` (save serialization, library merge/persist),
`preview-binary/src/main.rs` (save-path diagnosis; native changes only as D2
outcomes require), `docs/` + this directory's records. No `extension/` changes.

## 1. Background and purpose

This fixes-dir entry covers three reported defects in the preview WebView UX.
The original report, preserved verbatim:

> 1. the CTRL+S key binding correctly saves the file when working with the UI,
>    however, CMD+S on a mac is also supposed to do the same thing and does nothing
> 2. when a library asset is dragged onto the canvas it shows up as two identical
>    images (side-by side: left and right)
> 3. the light/dark mode state is saved correctly into the file when the
>    `*.excalidraw.svg` file format is used but forgotten on reload when using the
>    `*.excalidraw` file format

Three decisions were ratified in clarification and are recorded here as frozen,
not as open questions. Their numbering was fixed by the clarification round and
differs from the report order; sections below follow report order.

| Report bullet | Section | Decision |
|---|---|---|
| 1 — Cmd+S does nothing (macOS) | §2 | D2 — verification matrix + observability |
| 2 — library drag duplicates | §3 | D3 — insertion contract, our data layer first |
| 3 — color mode lost in plain `.excalidraw` | §4 | D1 — inject `exportWithDarkMode` (reversal of record) |

Evidence note: file:line citations were re-verified against the working tree on
2026-09-06 (vendored package citations against the installed
`@excalidraw/excalidraw` `0.18.1` dev dist). Where a supplied claim did not
survive verification it is labeled below as unconfirmed rather than repeated.

## 2. Defect A — Cmd+S on macOS does nothing

### 2.1 Reported symptom (verbatim)

> the CTRL+S key binding correctly saves the file when working with the UI,
> however, CMD+S on a mac is also supposed to do the same thing and does nothing

### 2.2 Evidence and candidate root causes

**Proven (source and history, verified 2026-09-06):**

- The `CmdOrCtrl+S` menu accelerator exists and has since 2026-06-14 (commit
  `8f8326c`, "feat: add native menu, close-confirm, library flows"). It is
  registered in `build_menu` (`main.rs:1876-1879`) precisely because AppKit
  consumes `Cmd+S` before it reaches WKWebView — the accelerator is the
  intended delivery path on macOS.
- The extension resolves the companion binary PATH-first
  (`extension/src/lib.rs:24-28`), so a stale pre-`8f8326c` binary on PATH is
  silently preferred over the shipped/downloaded one.
- Menu dispatch no-ops when the React bridge is absent: `menu_event_script`
  emits `window.__excalidrawSave && window.__excalidrawSave(…)`
  (`main.rs:1940-1942`), so in a read-only image preview (no React app
  mounted) menu Save is a complete silent no-op.
- Automated coverage cannot distinguish the remaining candidates: the smoke
  test drives the real WebView but cannot synthesize native key equivalents,
  and CI runs Linux, which has no native menu by design.

**Likely (unresolved — the controlled repro in §2.3 is the blocking input that
classifies among them):**

1. **Stale PATH binary.** The reporting session ran a binary predating the
   accelerator. Mechanism proven (PATH preference above); whether the
   reporting machine was affected is unverified.
2. **muda accelerator→MenuEvent delivery failure on macOS.** The accelerator
   is registered but its MenuEvent never fires (or fires without reaching the
   dispatch closure). No automated coverage exists either way.
3. **Dispatched but silent.** The menu event fires and the bridge call runs,
   but the user perceives nothing. The read-only case is proven silent
   (`main.rs:1940-1942` guard). The clarification-round evidence also claimed
   a clean-scene save gives no feedback citing `App.tsx:816-826`; that
   citation did not verify —
   those lines register the bridge, and `doSave` shows a "Saving…" toast for
   every explicit save and a "Saved" toast regardless of prior dirty state
   (`App.tsx:362-368`, `App.tsx:539-541`), with no silent clean-scene skip.
   Treat the clean-scene-silence sub-claim as unconfirmed; the matrix cell
   (clean editable × Cmd+S) settles it.

### 2.3 Ratified decision (D2): define "Save works" by a verification matrix + observability

"Save works" is defined by exhaustively exercising the cross product:

- **Entry points:** (a) Cmd/Ctrl+S accelerator — the menu accelerator on
  macOS/Windows, the page-level keyboard handler (`App.tsx:609-624`) on Linux,
  (b) menu-bar File→Save click, (c) in-canvas Save control (main-menu
  "Save to file" item, `App.tsx:1107-1112`), (d) close-flow save
  (save-and-close on a dirty scene).
- **Platforms:** macOS, Linux, Windows.
- **Scene states:** dirty editable, clean editable, read-only image preview.

**Observability requirement:** every explicit save gesture must produce a
positive or negative observable outcome — saved confirmation, a transient
"No changes to save" notice, or an error banner — never silence. Cells where
the combination is structurally absent are marked n/a with a reason (e.g.
Linux has no native menu bar by design; read-only preview has no in-canvas
Save control and no close-flow save).

**Blocking precondition:** a controlled repro against a current build — binary
identity confirmed via `--version`, extension version recorded — precedes any
code change for this defect. The accelerator has existed since June; the
plausible root causes (§2.2) demand divergent fixes, and which one applies is
exactly what the repro establishes.

### 2.4 Rejected alternative

**Making the page-level keydown handler authoritative / dropping the menu
accelerator.** REJECTED, and marked *do-not-reverse-without-new-evidence*: it
contradicts the recorded platform decision that macOS key equivalents need
native menu wiring (AGENT.md "Platform traps"; the `main.rs:1876-1877`
rationale — AppKit consumes `Cmd+S` before WKWebView, so a page handler alone
cannot be the delivery path on macOS).

### 2.5 Requirements

1. Run the controlled repro (blocking) and record the build identity and the
   root-cause classification (§2.2 candidates 1–3, or a new finding) in this
   directory before any code change.
2. Remedy whatever defect the repro identifies such that the observability
   requirement holds for every applicable matrix cell, including: a
   distinguishable outcome for save gestures in read-only preview (today a
   proven silent no-op, `main.rs:1940-1942`).
3. Do not remove or demote the native menu accelerator (§2.4).
4. No requirement may be added beyond the matrix + observability definition
   until the repro classifies the root cause.

### 2.6 Acceptance criteria

- The full matrix (12 entry-point × scene-state rows × 3 platforms) is
  instantiated in this directory's acceptance checklist with an honest result
  per cell — `pass`, `fail`, `n/a (reason)`, or **not performed** — following
  the repo's acceptance-checklist pattern. All cells default to *not
  performed* until run; Windows cells require a Windows host.
- Manual-only: every non-n/a cell shows an observable outcome per §2.3. These
  are GUI cells; no automated test substitutes for them, and the checklist
  must say so rather than tick from synthetic tests.
- Automatable (vitest, existing injected-I/O convention): any webview-side
  change to save outcomes keeps `doSave` toast behavior for explicit saves
  covered by tests.

## 3. Defect B — library drag inserts twins

### 3.1 Reported symptom (verbatim)

> when a library asset is dragged onto the canvas it shows up as two identical
> images (side-by side: left and right)

### 3.2 Evidence and root-cause analysis

**Proven (verified 2026-09-06):**

- Our app registers no custom drag handling: the `<Excalidraw>` props are
  plain (`App.tsx:1086-1105`) and there is no `StrictMode` (`main.tsx:282-297`
  renders `<App>` directly), so no double-invocation from our side.
- The drag/insert flow is entirely inside vendored `@excalidraw/excalidraw`
  `0.18.1`. Its `getInsertedElements` selects *every* library entry matching
  the dragged id when the id is not among the multi-selected ids
  (`dist/dev/index.js:11423-11443`), and the drop path grid-distributes the
  resulting set (`dist/dev/index.js:28805-28816`). Two entries sharing one
  library-item id therefore insert as two grid-distributed copies — exactly
  the reported side-by-side twins.

**Likely (working hypothesis, to be confirmed by the repro appendix):**

- The persisted/merged library payload we own contains two entries with the
  same library-item id, produced by some sequence of Browse-install
  (`App.tsx:886-905`), SSE re-delivery (`main.tsx:315-317` →
  `__excalidrawApplyPendingLibraries`), panel edits (debounced persist,
  `App.tsx:790-809`), or initial seeding (`main.tsx:217-227`). Given the
  proven vendored behavior above, duplicated library data is the most
  plausible cause of twins; which sequence produces it is unknown.

### 3.3 Ratified decision (D3): insertion contract; fix our data layer first

- **Insertion contract:** dragging inserts *exactly one copy of each dragged
  item's elements* at the drop point; a multi-select of N distinct items
  inserts exactly N.
- **Fix boundary:** our data layer first. The persisted/merged library payload
  must never contain two entries with the same library-item id after *any*
  sequence of Browse-install, SSE re-delivery, and panel edits. Enforced with
  vitest coverage on the pure merge/persist logic, with I/O injected per the
  repo convention (existing home: `dirty-state.ts` `persistLibraryItems` /
  `flushPendingLibrary`, already tested this way in `dirty-state.test.ts`).
- **Repro appendix is a blocking input** for implementation (§6): the fix must
  not be written against the hypothesis alone.
- **Vendored package:** upgrading or patching `@excalidraw/excalidraw` is out
  of scope *unless* the repro proves the package inserts twice after the
  persisted library is proven clean — and then only via a new explicit
  decision (§5).

### 3.4 Rejected alternative

**A post-drop "twin dedupe" heuristic guard.** REJECTED: fragile (must guess
which copy to keep), does not fix the corrupted persisted data, and pollutes
the fingerprint/dirty machinery (`scene-fingerprint.ts`) with
insertion-driven churn.

### 3.5 Requirements

1. Repro appendix completed first (blocking; see §6 for the required answers).
2. The library merge/persist logic guarantees the unique-id invariant over
   arbitrary interleavings of the four flows in §3.2, with vitest coverage of
   the interleavings (including SSE re-delivery of an already-installed
   library and Browse-install of a library whose items collide with existing
   panel entries).
3. A remedy for already-corrupted persisted libraries (e.g. dedupe on load or
   next persist) is *not* specified by the ratified decision; whether it is
   needed depends on the repro's findings — record the choice in the decision
   log rather than silently picking one.

### 3.6 Acceptance criteria

- Automatable (vitest): unique-id invariant tests over the pure merge/persist
  module(s), injected I/O, covering the interleavings of §3.5.2.
- Manual-GUI (checklist, default *not performed*): drag one library item →
  exactly one copy at the drop point; multi-select N distinct items → exactly
  N; repeat after each of Browse-install, SSE re-delivery, and a panel edit;
  the library panel itself shows one tile per item before and after.
- Manual-GUI: the reported twin repro, replayed per the appendix answers,
  no longer duplicates.

## 4. Defect C — plain `.excalidraw` forgets the document color mode

### 4.1 Reported symptom (verbatim)

> the light/dark mode state is saved correctly into the file when the
> `*.excalidraw.svg` file format is used but forgotten on reload when using the
> `*.excalidraw` file format

### 4.2 Evidence and root-cause analysis

**Proven (verified 2026-09-06):**

- Upstream Excalidraw deliberately strips `appState.exportWithDarkMode` from
  everything it serializes: `APP_STATE_STORAGE_CONF` marks the key
  `export:false` / `server:false` (vendored dev dist
  `chunk-4FTI6OG3.js:540`, key at `:581`; the chunk name is a build artifact,
  treat lines as locators), and `cleanAppStateForExport` (`:658`) applies that
  conf inside `serializeAsJSON` (`:17928-17941`). The key can therefore never
  round-trip through `serializeAsJSON` unaided — this is the root cause, and
  it is by-design upstream behavior, not a bug in our save path.
- `.excalidraw.svg`/`.png` work today only because the mode is recovered from
  the *baked rendering* before mount (SVG exactly via excalidraw's root
  `invert(93%) hue-rotate(180deg)` filter marker; PNG best-effort via corner
  luminance) — `docs/handling-excalidraw-files.md` §6 step 4. Plain JSON has
  no baked rendering, so nothing to recover; `main.tsx:262-269` falls through
  to the appState key (absent, per the stripping above) and then the
  OS/config theme.
- The load side already anticipates the key everywhere it matters:
  `main.tsx:262-269` reads it in the resolution chain; `restoreAppState`
  accepts any supplied value for a default-appState key
  (`chunk-4FTI6OG3.js:20793-20812`); `scene-fingerprint.ts:38-49`
  (`PERSISTED_APP_STATE_KEYS`) already counts `exportWithDarkMode` toward
  dirtiness. No load-side change is required.

### 4.3 Ratified decision (D1): persist the key by post-serialization injection — reversal of record

Plain `.excalidraw` WILL persist the document color mode: inject
`appState.exportWithDarkMode` into the serialized JSON *after*
`serializeAsJSON(...)` returns and *before* the POST leaves the webview.

This is an **explicit reversal of record** of:

- `docs/handling-excalidraw-files.md` §6 step 4 — "plain JSON not at all — it
  inherits the OS/config theme", and
- the AGENT.md "Document color mode round-trip" decision, whose fallback-chain
  language reads plain JSON as OS/config-themed.

The reversal requires, as part of this fix:

1. **Decision-log entry** (§7) recording the reversal and its rationale.
2. **Doc updates** to `docs/handling-excalidraw-files.md` §6 (and §7's
   `application/json` row, whose written payload changes) and to AGENT.md's
   "Document color mode round-trip" bullet.
3. **One-time compatibility check:** round-trip a file carrying the key
   through excalidraw.com. A file carrying the key pre-seeds excalidraw.com's
   export-dark-mode toggle — accepted as correct WYSIWYG propagation, not a
   compatibility failure.
4. **Fallback preserved:** files from other tools that lack the key still
   resolve via the existing chain — detected dark mode from the baked
   rendering → the appState key → config/OS theme (`main.tsx:262-269`,
   unchanged).

Injection sites (both `serializeAsJSON` call sites that write plain-JSON
scenes; the decision names the save path and cites `export.ts:71`):

- canonical save → `POST /data`: inline serialization in `doSave`
  (`App.tsx:415`);
- Export-Scene-to-new-file → `POST /export`: `buildExportPayload` case
  `"scene"` (`export.ts:71`).

Implementation check: confirm no other `serializeAsJSON` call sites exist
when implementing; the mechanism of injection (parse-and-reinsert vs.
re-serialize) is not fixed by this decision — keep whatever preserves
byte-stability elsewhere in the payload, and record the choice in the
decision log.

### 4.4 Rejected alternatives (recorded briefly)

- **Namespaced private key** (e.g. a top-level `"zedPreview"` object): other
  tools ignore it, losing ecosystem WYSIWYG propagation of the mode.
- **Host-side sidecar:** breaks "disk is the interchange" (AGENT.md) — the
  mode would live somewhere external editors cannot see or would clobber.
- **Decline as designed:** leaves the format inconsistency the report
  describes (SVG round-trips, plain JSON does not).

### 4.5 Requirements

1. Every plain-JSON scene this app writes (both §4.3 sites) carries
   `appState.exportWithDarkMode` matching the editor's document color mode at
   save time.
2. The load path and its priority chain are unchanged; keyless files load
   exactly as today (requirement 4 of §4.3).
3. Dirty/fingerprint behavior is unchanged in effect: the key already counts
   toward the fingerprint (`scene-fingerprint.ts:38-49`), so a toggle marks
   the scene dirty and a save clears it — no fingerprint-list change.
4. The `.excalidraw.svg`/`.png` recovery paths (baked-rendering detection)
   remain in place and unchanged.

### 4.6 Acceptance criteria

- Automatable (vitest, injected fetch per repo convention): the save path's
  serialized body contains `appState.exportWithDarkMode` equal to the
  editor's mode, for both injection sites; a keyless file still resolves via
  the fallback chain; the exported-scene payload carries the key.
- Automatable (vitest, restore() proxy — decided with §6 item 3): a
  key-carrying payload restores cleanly through the vendored
  `restore()`/`restoreAppState()` (flag survives, no throw); a keyless file
  restores with default appState. Pins the tolerance the D1 decision relies
  on against future package bumps.
- Automatable (regression guard): toggling the color mode marks the scene
  dirty; saving clears it (existing behavior, now pinned).
- Manual-GUI (checklist, default *not performed*): toggle dark → save plain
  `.excalidraw` → close → reopen: canvas, toggle and (on next save) the file
  agree from frame one; same file re-opened after external edit of the key
  respects the edited value.
- Manual, one-time (checklist): the excalidraw.com round-trip of §4.3.3.

## 5. Out of scope (shared)

- **Upgrading or patching the vendored `@excalidraw/excalidraw` package**,
  except through the narrow D3 condition (repro proves the package inserts
  twice after the persisted library is proven clean) and then only via a new
  explicit decision.
- **Zed-extension language registration** in any form — settled by
  `fixes/2026-09-05-lsp-strategy/` and not reopened here.
- **The `.excalidraw.png` CLI-only-inside-Zed limitation** — structural
  (finding 8 of the lsp-strategy spec); not a defect this entry addresses.
- **Any slash-command work** — blocked upstream (extensions#6468).
- **Making the page-level keydown handler the authoritative Cmd+S path**
  (§2.4) — rejected, do-not-reverse-without-new-evidence.

## 6. Open items / blocking inputs

1. **Library repro appendix (blocks §3 implementation).** Required answers:
   - item source: default panel item or Browse-installed library;
   - item type: image item vs. shape elements;
   - selection: single-item drag vs. multi-select;
   - does the library *panel itself* show one tile or two for the item?
   Plus: the persisted library file's contents at repro time (does it already
   contain the twin entry?), and the sequence of library operations that
   preceded the repro.

   *Resolution approach (decided 2026-09-06, execution pending):* reporter
   questionnaire + library file inspection first — paste
   `{config_dir}/excalidraw-zed/library.excalidrawlib` (single shared file
   for all sessions, `main.rs:1210-1217`) and answer the four observational
   questions; duplicate library-item ids in that file are decisive for the
   data-layer branch. Escalate to a systematic reproduction session (clean
   library → Browse-install → same-library re-install exercising SSE
   re-delivery → panel edits → drag variants, file inspected after each
   step) only if the questionnaire is inconclusive — clean file plus
   single-tile panel with twins persisting on a current build.

2. **macOS controlled-repro session (blocks §2 code changes).** Against a
   current build with `--version` recorded: which of §2.2's candidates (or
   what new finding) explains the silence. The D2 matrix + observability
   requirement stands regardless of the answer; only the remedy depends on
   it.

   *Resolution approach (decided 2026-09-06, execution pending):* staged
   triage in one sitting. Stage 1: `which excalidraw-preview` + `--version`
   against `BINARY_VERSION` (0.6.0) — confirms or eliminates the stale-PATH
   candidate in minutes. Stage 2: current build, `--debug`, Cmd+S on a dirty
   scene — observe menu dispatch and the save round-trip; each outcome maps
   to a §2.2 candidate. Stage 3: repeat across dirty/clean/read-only states.
   CGEvent synthesis in the macOS smoke test is deferred as possible later
   regression hardening once a current build is proven clean; it is not part
   of classification.

3. **excalidraw.com round-trip compatibility check (§4.3.3).** One-time,
   manual; may run after implementation but must be recorded before release.

   *Resolution approach (decided 2026-09-06, execution pending):*
   strengthened beyond the ratified timing. (a) *Pre-verify before
   implementation* — hand-inject `exportWithDarkMode` into an existing
   `.excalidraw` file and load it on excalidraw.com; a failure here reopens
   Decision 1 before code exists. (b) *Automated proxy* — a vitest asserting
   key-carrying payloads restore cleanly through the vendored
   `restore()`/`restoreAppState()` and keyless files keep defaults (added to
   §4.6 acceptance criteria). (c) The ratified app-artifact round-trip
   remains the recorded pre-release gate. The check does not depend on the
   implementation — the key is a legal hand-edit today.

4. **Windows matrix rows.** The D2 matrix defines Windows cells; performing
   them requires a Windows host (repo tests Windows only via
   Windows-compiled twins). Until then they stay *not performed* — an honest
   gap, not a pass.

   *Resolution approach (decided 2026-09-06, execution pending; host named
   2026-09-06):* run the Windows matrix column on `build-win-native` — the
   native Windows side of the build box, reachable from this host over SSH
   (PowerShell, port 2222; `build-win` is its WSL side and is *not* the
   target). Deploy the current release binary over SSH and capture
   `--version` identity there; **sequenced after item 2** — a clean macOS
   accelerator result de-risks the shared muda menu path and shrinks the
   Windows residual risk; a macOS muda delivery failure elevates Windows
   verification to required-before-release. SSH covers deployment and
   identity capture only: the GUI cells (key equivalents, menu clicks,
   toasts) still require an interactive session on that host (RDP or
   physical console); record any remote-session input caveat alongside the
   results.

## 7. Required follow-ups

1. **`decision-log.md` in this directory**, following the house numbering
   pattern: D1 (color-mode injection — the reversal of record, with the §4.4
   rejected alternatives), D2 (verification matrix + observability; the §2.4
   rejection marked do-not-reverse-without-new-evidence), D3 (insertion
   contract + unique-id invariant; the §3.4 rejection and the vendored-package
    condition). The corrupted-library-remedy choice (§3.5.3) is recorded
    there once the repro appendix settles it. The §6 open-item resolution
    approaches (questionnaire-first repro, staged Cmd+S triage, pre-verify +
    restore() proxy, Windows-after-macOS sequencing) are recorded there in
    the same entry so the execution order is auditable.
2. **Doc updates** (gated on D1 implementation, not before):
   `docs/handling-excalidraw-files.md` §6 step 4 and §7's `application/json`
   row; AGENT.md "Document color mode round-trip" bullet — rewritten to state
   that plain JSON persists the key by post-serialization injection and that
   the OS/config theme is fallback-only for keyless files.
3. **`acceptance-checklist.md` in this directory**, instantiated per the
   repo's manual-GUI pattern (build-identity table; every interactive item
   annotated *not performed* until a human runs it; no ticking from synthetic
   tests): the full D2 matrix, the §3.6 manual criteria, the §4.6 manual
   criteria including the excalidraw.com round-trip.
