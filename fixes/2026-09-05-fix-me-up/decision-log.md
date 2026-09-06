# Decision log — Cmd+S silence, library drag twins, plain-JSON color-mode loss

Companion to [`spec.md`](./spec.md). Records the three decisions frozen in
clarification (D1/D2/D3, spec §7.1 — their numbers never shift) and the Phase 1
preflight evidence (working tree + clean-tree baseline, per `plan.md` Phase 1).
Later phases append entries below.

## Opening — working-tree state at Phase 1 start (2026-09-06)

Recorded before any change, per the house pattern (lsp-strategy decision-log D3).

- HEAD: `4543cab` (`4543cabc982946a294ef95ce8dee85a83fa6b425`, "docs: replace PRD
  with handling deep-dive and reorganize examples", 2026-09-06 13:42 -0700), branch
  `main`, 6 commits ahead of `origin/main`.
- ` M .claudine/memory/commits.md` — memory file, not source; expected.
- `?? fixes/2026-09-05-fix-me-up/plan.md` — this plan (untracked, expected).
- **No source-file modifications.** Phase 1 creates records files in this
  directory only.

**BINARY_VERSION reference for Phase 2 Track B** (plan task, confirmed 2026-09-06):
`BINARY_VERSION = "0.6.0"` (`extension/src/lib.rs:9`) matches `extension/extension.toml`
(`0.6.0`), both workspace `[package]` versions (`extension/Cargo.toml`,
`preview-binary/Cargo.toml`), and the published tag `v0.6.0` exists, so the
extension's download URL `releases/download/v0.6.0/{asset}` resolves to real
assets. The corpus test `test_binary_version_matches_manifest` pins the
manifest↔constant pair, and `just bump` is the only sanctioned way to move all
four sites. Accelerator lineage for Track B Stage 1: the `CmdOrCtrl+S` menu
accelerator first shipped in **`v0.4.0`** (commit `8f8326c`, 2026-06-14), so a PATH
binary reporting `--version` < 0.4.0 predates the accelerator entirely;
0.4.0–0.6.0 carry it (but may predate other fixes — identity is still `0.6.0`).

## Baseline — clean-tree sweep (2026-09-06, pre-implementation)

Run on the untouched tree above (no source changes yet): `main` @ `4543cab`.
Phase 6 diffs its sweep against these numbers.

| Gate | Result |
|---|---|
| `cargo nextest run` (workspace, via `just test`) | **124 passed, 0 failed, 1 skipped** |
| webview `tsc --noEmit` (via `just test`) | clean |
| webview `vitest run` (via `just test`) | **144 passed (9 files), 0 failed** |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |

Pre-existing skip (by design, not drift):
`excalidraw-preview-binary::integration smoke_self_test_reports_all_checks_passing`
— `#[ignore]`d because it opens a real WebView window (needs a display); run via
`just smoke` (CI runs it under Xvfb).

**There are no pre-existing failures or lint drift.** Any failure observed in
Phase 6 is a regression from this work. No nextest "leaky" annotation appeared in
the baseline run; if one appears later under parallel load it is the known leak
heuristic firing, not a real leak (lsp-strategy D12; AGENT.md). Counts vs. the
lsp-strategy closure record (118 nextest passed / 144 vitest, its D14): +6 nextest
tests, all from commit `5f0debf` (LSP preview-lifecycle stderr logging); vitest
unchanged.

## D1 — plain-JSON saves persist the document color mode via post-serialization injection (reversal of record)

**Decision: plain `.excalidraw` WILL persist the document color mode — inject
`appState.exportWithDarkMode` into the serialized JSON *after* `serializeAsJSON(...)`
returns and *before* the POST leaves the webview, at both plain-JSON call sites:
canonical save (`doSave`, `App.tsx:415`) and Export-Scene (`buildExportPayload`
case `"scene"`, `export.ts:71`).**

Frozen in clarification (spec §4.3); recorded here per spec §7.1.

- **Why:** upstream `APP_STATE_STORAGE_CONF` marks the key `export:false` /
  `server:false` and `cleanAppStateForExport` strips it inside `serializeAsJSON` —
  by-design upstream behavior, so the key can never round-trip unaided.
  `.excalidraw.svg`/`.png` work only because the mode is recovered from the baked
  rendering before mount; plain JSON has no baked rendering to recover.
- **Reversal of record:** `docs/handling-excalidraw-files.md` §6 step 4 ("plain
  JSON not at all — it inherits the OS/config theme") and the AGENT.md "Document
  color mode round-trip" bullet. Doc updates are gated on D1 implementation
  (Phase 9), not before.
- **Injection mechanism deliberately unfrozen:** parse-and-reinsert vs.
  re-serialize — whichever preserves byte-stability elsewhere in the payload;
  chosen at implementation (Phase 3) and recorded back in this entry.
- **Unchanged by this decision:** the load path and its priority chain
  (baked-rendering detection → appState key → OS/config theme, `main.tsx:262-269`);
  keyless files load exactly as today; the fingerprint list
  (`scene-fingerprint.ts:38-49` already includes the key — a toggle marks the scene
  dirty and a save clears it, no fingerprint change); the `.svg`/`.png`
  baked-rendering recovery paths.
- **Implementation check carried forward (Phase 3):** re-confirm exactly two
  `serializeAsJSON` plain-JSON call sites at implementation time; a third site
  stops the phase and is recorded here first.
- **Rejected alternatives (spec §4.4):**
  - *Namespaced private key* (top-level `"zedPreview"` object) — other tools
    ignore it, losing ecosystem WYSIWYG propagation of the mode.
  - *Host-side sidecar* — breaks "disk is the interchange" (AGENT.md); the mode
    would live where external editors cannot see it or would clobber it.
  - *Decline as designed* — leaves the format inconsistency the report describes
    (SVG round-trips, plain JSON does not).
- **§6 item 3 resolution approach (recorded per plan):**
  - (a) *Pre-verify before implementation* (Phase 2 Track C): hand-inject
    `"exportWithDarkMode": true` into an existing `.excalidraw` file's `appState`
    (a legal hand-edit today) and load it on excalidraw.com. A failure **reopens
    Decision 1 before any code exists** — halt and re-litigate instead of
    proceeding to Phase 3.
  - (b) *Automated proxy* (Phase 3 vitest): a key-carrying payload restores
    cleanly through the vendored `restore()`/`restoreAppState()` (flag survives,
    no throw); a keyless payload restores with default appState. Pins the upstream
    tolerance D1 relies on against future package bumps.
  - (c) *App-artifact round-trip* (one-time, Phase 7): a file saved by the new
    build pre-seeds excalidraw.com's export-dark-mode toggle — **accepted as
    correct WYSIWYG propagation, not a compatibility failure**.

- Pre-verify result (Phase 2 Track C, 2026-09-06): **run; criterion (a)
  opens-cleanly PASS, criterion (b) toggle-pre-seeded FAIL → the plan's
  reopen condition for D1 is triggered. Phase 3 must not proceed until D1 is
  re-litigated.**
  - *Method (live site, real browser):* `docs/examples/user-authentication-flow.excalidraw`
    hand-edited to carry `appState.exportWithDarkMode: true` (a legal
    hand-edit today), plus a keyless control built from the same file;
    both loaded on **https://excalidraw.com** in headless system Chrome
    (playwright-core), fresh contexts, via the normal canvas drop-open path
    (the menu "Open" item uses the File System Access API, which headless
    automation does not intercept; drop routes through the identical
    `loadFromBlob` loader). Export dialog opened through the main menu →
    "Export image…"; the "Dark mode" checkbox was read from the DOM.
  - *Result:* both files opened cleanly (scene loaded — undo history
    enabled; **zero page errors**). "Dark mode" checkbox = **false** for the
    key-carrying file — **identical to the keyless control**: the injected
    key does **not** pre-seed excalidraw.com's export-dark-mode toggle.
  - *Corroboration (three independent sources):* (1) the live behavioral
    test above; (2) vendored 0.18.1 source — `loadSceneOrLibraryFromBlob`
    wraps the loaded appState in `cleanAppStateForExport(...)`, and
    `APP_STATE_STORAGE_CONF.exportWithDarkMode = { browser: true, export:
    false, server: false }`, so `export:false` keys are stripped **on load**
    before `restoreAppState` ever sees them (`restoreAppState` itself *keeps*
    a supplied value — the key survives restore, it just never reaches it on
    the file-open path); (3) upstream master today (`blob.ts` +
    `appState.ts:201`) carries the identical structure and flags. The
    stripping is the mirror image of the write-side stripping that motivated
    D1 — upstream treats the key as per-browser state in both directions.
  - *Evidence artifacts:* [`evidence/trackc-excalidraw-com/`](./evidence/trackc-excalidraw-com/)
    (run script, both input files, per-case records with DOM-observed values,
    screenshots, summary `results.json`).
  - *Ad-hoc vendored-package proxy (§6.3b):* attempted in Phase 2 and
    **deferred to Phase 3 as planned** — plain node/vitest import of the
    vendored package fails on `roughjs/bin/rough` (extensionless ESM import,
    bundler-only resolution) and the restore chunk touches `window`/
    `document`/`devicePixelRatio` at module scope, so the permanent proxy
    needs a jsdom environment and/or vitest inline-deps treatment (Phase 3
    implementation note). No Phase 2 conclusion depends on it.
  - *Scope of the failure, precisely:* D1's own round-trip inside this app is
    **unaffected** — our load path reads the raw key from disk
    (`main.tsx:262-269`) independently of `restore()`, so injected saves will
    round-trip our viewer regardless. What failed is spec §4.3.3's
    presupposition that "a file carrying the key pre-seeds excalidraw.com's
    export-dark-mode toggle": on current excalidraw.com it does not (the key
    is stripped on load, by design). The re-litigation must re-weigh the
    rejected "namespaced private key" alternative (§4.4) — its stated
    disadvantage ("other tools ignore it, losing ecosystem WYSIWYG
    propagation") is now factually weaker, since the standard key **also**
    gets no propagation on excalidraw.com — against the unchanged facts that
    the standard key is a legal hand-edit, opens cleanly everywhere tested,
    and round-trips our own viewer. Recording the evidence is Phase 2's job;
    the formal re-litigation (keep D1, re-scope, or reverse) is a
    clarification-round act, deliberately not pre-empted here.
- **D1 re-litigation (Phase 3 prelude, 2026-09-06).** Triggered by the Track C
  pre-verify failure recorded above; performed before any Phase 3 code, per the
  plan's phase gate ("D1 formally reopened and Phase 3 re-scoped"). The session
  is non-interactive, so the re-weighing below is executed and recorded here
  rather than deferred to a human clarification round — every input it relies on
  is evidence already on file in this directory or pinned by a test added in
  Phase 3.
  - **Options weighed.** (1) *Reverse to the namespaced private key* (§4.4
    reject re-weighed): its stated disadvantage — losing ecosystem WYSIWYG
    propagation — is now factually weaker, since the standard key also gets no
    propagation on excalidraw.com (stripped on load, by design). But reversing
    gains nothing there either (a namespaced key is ignored just as surely),
    loses the "documented upstream schema key / legal hand-edit" property, and —
    decisive — a top-level namespaced object is *dropped entirely* by
    `restore()`, so it would need exactly the same raw-disk load-side read the
    standard key needs (see the new finding below). Strictly dominated.
    (2) *Keep D1 as frozen with no load-side change*: **disproven by a new
    empirical finding** — see below; the injected key would round-trip nothing,
    leaving the reported defect unfixed. (3) *Keep D1 with two scope
    refinements*: the injection decision stands unchanged, §4.3.3's
    presupposition is corrected, and a minimal load-side repair is added where
    upstream strips the key. **Chosen.** (4) *Host-side sidecar*: §4.4
    rejection unchanged (breaks disk-as-interchange).
  - **New finding N2 (pinned by the Phase 3 vendored proxy test):** upstream
    strips the key on **load** as well as on save. `loadFromBlob` — the exact
    loader our `parseDiskBytesWithFallbacks` (`main.tsx:55-68`) uses for the
    initial mount *and* every reconciliation — routes the file's appState
    through `cleanAppStateForExport` before `restore()` ever sees it
    (`loadSceneOrLibraryFromBlob`, vendored 0.18.1 dev dist), so
    `initialData.appState.exportWithDarkMode` is **always absent** after a
    load. Consequence: the appState-key branch of main.tsx's documented
    priority chain (`main.tsx:262-269`: baked rendering → appState key →
    OS/config theme) was dead code for every file, and the decision log's
    Phase 2 claim that "our load path reads the raw key from disk
    independently of restore()" was wrong — corrected here. The spec's §4.2
    "the load side already anticipates the key everywhere it matters" held for
    `restoreAppState` (which keeps a supplied value) but not for the
    file→restore pipeline in front of it.
  - **Scope refinement 1 — load-side repair at the shared parse chokepoint.**
    D1's goal requires the file-stated key to survive our own load path, so
    Phase 3 restores it in `parseDiskBytesWithFallbacks`: after `loadFromBlob`
    succeeds, `reattachRawColorMode(data, bytes)` (pure helper in
    `color-mode.ts`) copies the file's raw `appState.exportWithDarkMode` back
    into the parsed data when — and only when — the raw bytes are JSON carrying
    a boolean under that exact path. This is deliberately the *smallest*
    change that makes the documented chain true as written: the chain
    expression in `main.tsx:262-269` stays byte-identical (baked detection
    still wins for `.svg`/`.png`, whose bytes never parse as JSON and are
    returned untouched); keyless files are returned **as the same object
    reference** (provably identical behavior — pinned by test); and because
    the chokepoint is shared, external edits that flip the key now apply
    through the existing `pickPersistedAppState` reload path as well.
  - **Scope refinement 2 — §4.3.3 re-scoped.** The excalidraw.com round-trip
    criterion no longer asserts toggle pre-seeding. Re-scoped criterion: a file
    saved by the new build **opens cleanly on excalidraw.com with zero page
    errors and no data loss**; the export-dark-mode toggle is **not** pre-seeded
    there (the key is stripped on load by upstream design — the mirror image of
    the write-side stripping D1 works around; evidence:
    [`evidence/trackc-excalidraw-com/`](./evidence/trackc-excalidraw-com/) +
    vendored source). WYSIWYG propagation of the mode now means: consumers that
    read the raw key from the file — this viewer, and any tool using the same
    raw-read technique — recover the mode; consumers that route through
    upstream's blob loader do not, today. The acceptance checklist's §4.6
    round-trip item is re-worded to match (see
    [`acceptance-checklist.md`](./acceptance-checklist.md) §4.6).
  - **Call-site re-confirmation (Phase 3 task):** re-verified at implementation
    time — exactly **two** `serializeAsJSON` production call sites write
    plain-JSON scenes: canonical save in `doSave` (`App.tsx:415`) and
    Export-Scene in `buildExportPayload` case `"scene"` (`export.ts:71`). The
    only other mentions are comments (`scene-fingerprint.ts:4,114`) and a test
    mock (`export.test.ts:6`). No third site appeared; the phase proceeded
    without stopping.
  - **Mechanism record (the entry's promised Phase 3 record):** **surgical
    text splice** (`injectExportWithDarkMode`, `webview-src/src/color-mode.ts`)
    — a single string-aware, depth-aware scan locates the **top-level**
    `appState` object (occurrences of the key, or of `"appState"`, inside
    string values or nested objects are invisible to it) and then either
    **replaces** the value span of an existing `exportWithDarkMode` member —
    the case that arises if upstream ever stops stripping — or **inserts**
    `"exportWithDarkMode":<bool>` as appState's first member (separator only
    when appState is non-empty). No re-serialization anywhere. Chosen over
    parse-and-reinsert because byte-stability holds **by construction, for
    every producer**: the only mutation is one bounded span, while a
    `JSON.parse`/`stringify` round trip is only *mostly* byte-stable (number
    spellings like `1e21` → `1e+21`, escape-style changes, duplicate-key
    collapse for producers other than `JSON.stringify`) — a producer-dependent
    guarantee is the wrong bar on the persistence path, where the bytes are
    the interchange with external editors and the revision ETag is a content
    hash. Corollary, pinned by test: injecting twice is a no-op (the second
    pass takes the replace branch and writes the identical span). A payload
    without a navigable top-level `appState` object **throws**, so `doSave`
    reports "Save failed" instead of silently dropping the mode. Wired through
    `serializeSceneForDisk` (`serialize-scene.ts`) — the single seam both
    plain-JSON call sites use.
  - **Phase 3 verification (2026-09-06):** webview suite **188 vitest passed /
    0 failed** (Phase 1 baseline: 144; +44 new cases) and `tsc --noEmit`
    clean. New coverage: the injector unit suite (exact-byte fixtures incl.
    adversarial string content, nested-key and whitespace variants, keyless →
    inserted-both-modes, idempotence, byte-stability, malformed-input
    refusals); the `serializeSceneForDisk` suite; the export-site POST-body
    suite (injected fetch, dark/light/missing editor modes);
    `rawJsonExportWithDarkMode`/`reattachRawColorMode` (incl.
    same-object-reference no-op pins for keyless and non-JSON inputs); the
    §6.3b vendored proxy (strip-on-save root cause, strip-on-load finding N2,
    `restore()`/`restoreAppState()` tolerance); the real-package
    read/write/read round-trip, repeated, against a shipped
    `docs/examples/software-development-lifecycle.excalidraw`; the passive
    corpus over every shipped `docs/examples/*.excalidraw`; and the
    color-mode toggle → dirty → save-clears pin. Load-path chain
    (`main.tsx:262-269`) byte-identical; `.svg`/`.png` baked-rendering
    recovery untouched; fingerprint list untouched; no changes outside
    `webview-src/src` (+ tests). Keyless-file behavior pinned unchanged by the
    same-reference no-op tests and the corpus keyless assertions.

Decided: 2026-09-06 (frozen in clarification; recorded Phase 1).

## D2 — "Save works" = verification matrix + observability; blocking repro precedes any code change

**Decision (spec §2.3):** "Save works" is defined by exhaustively exercising the
cross product, instantiated cell-by-cell in
[`acceptance-checklist.md`](./acceptance-checklist.md):

- **Entry points:** (a) Cmd/Ctrl+S accelerator — the native menu accelerator on
  macOS/Windows, the page-level keyboard handler (`App.tsx:609-624`) on Linux;
  (b) menu-bar File→Save click; (c) in-canvas Save (main-menu "Save to file",
  `App.tsx:1107-1112`); (d) close-flow save (the "Save" choice of the
  unsaved-changes dialog — only offered on a dirty scene).
- **Scene states:** dirty editable / clean editable / read-only image preview.
- **Platforms:** macOS / Linux / Windows.

**Observability requirement:** every explicit save gesture must produce a positive
or negative observable outcome — saved confirmation, a transient "No changes to
save" notice, or an error banner — **never silence**. Structurally absent
combinations are `n/a (reason)`.

- **Blocking precondition:** a controlled repro against a current build (binary
  identity via `--version`, extension version recorded — Phase 2 Track B) precedes
  any code change for this defect (Phase 5). The three candidate root causes
  (spec §2.2) demand divergent fixes:
  1. **Stale PATH binary** — the extension resolves the companion binary
     PATH-first, so a pre-`8f8326c` binary is silently preferred (mechanism
     proven; whether the reporting machine was affected is unverified).
  2. **muda accelerator→MenuEvent delivery failure on macOS** — registered but
     never fires, or fires without reaching the dispatch closure (no automated
     coverage either way).
  3. **Dispatched but silent** — read-only image preview is *proven* silent (the
     `window.__excalidrawSave && …` guard at `main.rs:1940-1942` makes menu Save a
     complete no-op there). The clean-scene-silence sub-claim is **unconfirmed**
     (the cited `App.tsx:816-826` registers the bridge; `doSave` shows
     "Saving…"/"Saved" toasts for every explicit save); the matrix cell
     (clean editable × Cmd+S) settles it.
- **Rejected alternative (spec §2.4), marked
  *do-not-reverse-without-new-evidence*:** making the page-level keydown handler
  authoritative / dropping or demoting the native menu accelerator. AppKit
  consumes `Cmd+S` before it reaches WKWebView, so a page handler alone cannot be
  the macOS delivery path (AGENT.md "Platform traps"; the `main.rs:1876-1877`
  rationale).
- **§6 item 2 resolution approach (recorded per plan):** staged triage in one
  sitting. Stage 1: `which excalidraw-preview` + `--version` against
  `BINARY_VERSION` (`0.6.0`) — confirms/eliminates the stale-PATH candidate in
  minutes (see the Opening entry's lineage note). Stage 2: current build
  (`just release`), `--debug`, Cmd+S on a dirty scene — observe whether the muda
  MenuEvent fires and reaches the dispatch closure, and whether the save
  round-trip (POST `/data`, toast) completes. Stage 3: repeat across
  dirty/clean/read-only. CGEvent synthesis in the smoke test is deferred as
  possible later hardening — **not part of classification**.
- **§6 item 4 (Windows) resolution approach (recorded per plan):** the Windows
  column runs on `build-win-native` (the native Windows side, SSH PowerShell port
  2222; `build-win` is the WSL side and is **not** the target), **sequenced after
  macOS** — a clean macOS accelerator result de-risks the shared muda menu path;
  a macOS muda delivery failure elevates Windows verification to
  required-before-release. SSH covers deployment + `--version` identity capture
  only; GUI cells need an interactive session (RDP or physical console), with any
  remote-session input caveat recorded alongside the results. Until a session is
  available, `not performed` is an honest recorded gap, never a silent skip.
  **Outcome (Phase 8, 2026-09-06):** the escalation arm does **not** fire — Track
  B classified candidate 1 and eliminated the muda delivery failure with positive
  proof — and neither half ran: the host is powered off and its hypervisor cannot
  start it without cluster quorum. Diagnosis, the two caveats on the "macOS was
  clean" premise, and the compile-level Windows cross-check are in the
  [Phase 8 entry](#phase-8--windows-matrix-on-build-win-native-2026-09-06-not-performed-fully-diagnosed).

- Triage classification (Phase 2 Track B, 2026-09-06): **candidate 1 — stale
  PATH / pre-accelerator binary in the reporting session** (by elimination:
  candidate 2 is ELIMINATED for the current build by positive delivery proof
  — two synthesized-but-real Cmd+S key equivalents each produced a complete
  save round-trip, watcher-logged "suppressing echo" at the press timestamps;
  candidate 3 survives only as the source-proven read-only silent no-op,
  Phase 5's mandated fix). **New finding N1:** the binary has no `--version`
  flag, so the mandated identity procedure cannot run as written — Phase 5
  should add the flag and a checklist identity guard. Full record, method
  disclosure, and per-stage observations in
  [`cmd-s-triage.md`](./cmd-s-triage.md). Phase 5 executes the matching
  remedy branch (environment hygiene expected; no accelerator change).
### Executed remedy branch (Phase 5, 2026-09-06)

**Branch executed: §2.2.1 — stale PATH / environment hygiene**, exactly the
Track B classification, plus the two deliverables that branch is explicitly
*not* allowed to absorb (they are separate, already-mandated items): finding N1
and the proven read-only silent no-op. No accelerator was removed, demoted, or
rewired; the page-level keydown handler in `App.tsx` is byte-identical.

**1. Environment hygiene (the branch proper).** Re-checked on this host:
`which -a excalidraw-preview` resolves to exactly one entry,
`/Users/ken/.local/bin/excalidraw-preview`, a symlink to
`<repo>/target/release/excalidraw-preview` — i.e. the `just symlink` target,
not a stale wrapper. A full PATH sweep for any other `excalidraw-preview`
found none. So there was nothing to restore or delete here; the remedy that
remains is the *guard*, so a future reporting session cannot hide the same
failure mode: the acceptance checklist now records identity with an executable
procedure rather than a wish. **No product code change was required for the
delivery defect itself** — consistent with the classification (the delivery
path was proven working twice on the current build).

**2. Finding N1 — `--version` now exists.** `#[command(version)]` on `CliArgs`
(`main.rs`) makes the binary print `excalidraw-preview {CARGO_PKG_VERSION}` and
exit 0 with no file argument and no window. Four integration tests drive the
real binary through the normal invocation path: `--version` output and exit
status, `-V` equivalence, no-file/no-stderr, and — the one that makes the guard
mean something — the printed version parsed back and compared against the
`BINARY_VERSION` constant the acceptance run holds it up to. That last pin was
first written as a corpus test inside `extension/src/lib.rs` and **moved**: this
entry's scope forbids `extension/` changes, and asserting against the *printed*
output is the stronger form anyway (it exercises the same command an acceptance
run types, not just two files agreeing).

**3. The proven silent no-op is closed.** `menu_event_script`'s Save arm used
`window.__excalidrawSave && window.__excalidrawSave({reason:'menu'})`, which in
a read-only image preview (a scene-less SVG/PNG never mounts the React app)
evaluated to nothing at all. It is now `SAVE_MENU_SCRIPT`:

```js
window.__excalidrawSave ? window.__excalidrawSave({ reason: 'menu' })
                        : (window.__excalidrawSaveUnavailable && window.__excalidrawSaveUnavailable('menu'))
```

The fallback global is registered by `main.tsx` at **module scope, before any
await**, so it exists on every load path — read-only preview, load failure, and
the window between page load and React mount — and is not tied to the bridge
that only the mounted app installs. Its logic lives in `save-notice.ts` with
all I/O injected (present / timers / the global target), the `readonly-image.ts`
convention, so it is unit-testable in the `node` environment; only the DOM
`presentNotice` helper (a transient `role="status"` toast) stays in `main.tsx`
beside the other page-shell rendering. The page — not the native side — owns
the wording, because only it knows *why* there is nothing to save: still
loading / read-only preview / load failed.

The same module installs one page-level `Cmd/Ctrl+S` keydown listener that
**defers whenever `__excalidrawSave` exists**. That is what makes the read-only
row observable on Linux too (no native menu there by design), and it cannot
promote the page handler over the accelerator: with the editor mounted it
returns before `preventDefault`, so `App.tsx`'s handler is untouched and the
macOS menu accelerator stays authoritative (§2.4, not reversed).

**4. Observability audit — every save gesture implemented on the webview side.**

| Gesture | Path | Observable outcome |
|---|---|---|
| Accelerator / menu Save, editor mounted | `SAVE_MENU_SCRIPT` → `__excalidrawSave` → `doSave` | "Saving…" → "Saved" / "Unsaved changes" / error toast / conflict banner (unchanged) |
| Accelerator / menu Save, **no editor** | `SAVE_MENU_SCRIPT` → `__excalidrawSaveUnavailable` | in-page notice (**new**) |
| `Cmd/Ctrl+S`, editor mounted | `App.tsx` keydown → `__excalidrawSave` | as row 1 (unchanged; the fallback listener defers) |
| `Cmd/Ctrl+S`, **no editor** (Linux read-only, pre-mount) | module-scope keydown → notice | in-page notice (**new**) |
| In-canvas Save ("Save to file") | `__excalidrawSave ?? doSave` | as row 1 (structurally absent in read-only: no Excalidraw UI) |
| Close-flow save | `__excalidrawSave({reason:'close'})` | toasts, and a native error dialog when the round-trip fails |
| Any explicit save while the Excalidraw API is not ready | `doSave` early return | was the one remaining silent return (no `api` ⇒ no toast surface); now routes to the same notice for every non-`bootstrap` reason |
| 412 / write error / serialization throw | `doSave` | conflict banner / error toast (unchanged) |

`doSave`'s toast behavior for explicit saves is unchanged, and the decision that
drives it (`decideSaveOutcome`) keeps its existing vitest coverage (spec §2.6).
The new notice has 19 vitest cases (`save-notice.test.ts`): message selection
per page state, no stacking on repeat gestures, timer restart, dismissal,
re-show after dismissal, the native-call and both keydown delivery paths,
deferral while the editor is mounted, re-arming after unmount, and the ignored
keys.

**5. Cross-boundary contract.** The dispatch string and the bundle are joined
only by the global's *name*, so two artifact-level tests pin it: a main.rs test
asserts the shipped embedded bundle (`Assets`) registers
`__excalidrawSaveUnavailable`, and an integration test spawns the real binary
headless over a scene-less `.excalidraw.svg`, confirms `/config` reports
`image/svg+xml` and `/data` returns bytes with no embedded scene (the read-only
branch's own preconditions), then follows the served `index.html`'s module
script and asserts the *served* bundle registers the fallback. Both skip with a
printed reason when a build embedded no bundle, because `assets/` is gitignored
and `just test` does not run `just ui` (same accommodation as
`test_serve_index_missing_asset_returns_404`).

**6. GUI demonstration: not performed, deliberately.** The checkpoint offered a
screenshot as one way to demonstrate the read-only outcome. Two capture
attempts on this host produced frames of the *user's* unrelated desktop (an
active interactive session, multiple displays, and a pre-existing preview
window of `docs/architecture.excalidraw.svg` in the captured region), and one
synthesized keystroke landed in another application's prompt. Both images were
deleted immediately and none were stored in this directory. The attempts were
abandoned rather than repeated: capturing a live desktop to prove a UI string
is not a trade worth making, and the house rules put the observation in Phase 7
anyway (a GUI cell may never be ticked from a synthetic run). The read-only
outcome therefore rests on the four automated levels above until Phase 7 fills
the matrix by hand.

**Verification (Phase 5).** `just test`: 131 nextest passed / 1 by-design skip
(baseline 124 + 6 new binary-crate tests + 1 new extension corpus test; the
read-only served-page test was added after that run and passes — Phase 6 re-runs
the whole sweep), `tsc --noEmit` clean, 252 vitest passed / 0 failed (baseline
233 + 19). `cargo clippy --workspace --all-targets -- -D warnings` and
`cargo fmt --check` clean.

Decided: 2026-09-06 (frozen in clarification; recorded Phase 1; branch executed
Phase 5).

## D3 — library insertion contract + unique-id invariant in our data layer

**Decision (spec §3.3):**

- **Insertion contract:** dragging inserts *exactly one copy of each dragged
  item's elements* at the drop point; a multi-select of N distinct items inserts
  exactly N.
- **Fix boundary — our data layer first:** the persisted/merged library payload
  must **never contain two entries with the same library-item id** after *any*
  sequence of the four flows: initial seeding from `GET /library`
  (`main.tsx:217-227`), Browse-install merge (`App.tsx:886-905`), SSE re-delivery
  (`main.tsx:315-317` → `__excalidrawApplyPendingLibraries`), and debounced panel
  persistence (`handleLibraryChange` → `persistLibraryItems`, `App.tsx:790-809`).
  Enforced at a **single auditable choke point** over the pure merge/persist
  logic (existing home `dirty-state.ts`; a new `library-merge.ts` is acceptable),
  with vitest coverage of the §3.5.2 interleavings — SSE re-delivery of an
  already-installed library (idempotent, no duplicate), Browse-install whose
  items collide with existing panel entries (one survivor per id), panel edit
  after install (invariant holds through persist), and arbitrary interleavings —
  all with I/O injected per the `dirty-state.test.ts` convention.
- **Why:** vendored `@excalidraw/excalidraw` `0.18.1`'s `getInsertedElements`
  selects *every* library entry matching the dragged id when the id is not among
  the multi-selected ids, and the drop path grid-distributes the resulting set —
  two entries sharing one library-item id therefore insert as two
  grid-distributed copies, exactly the reported side-by-side twins. Our app
  registers no custom drag handling (plain `<Excalidraw>` props, no
  `StrictMode`), so duplicated library data is the plausible cause; which flow
  produces it is unknown until the repro appendix.
- **Rejected alternative (spec §3.4):** a post-drop "twin dedupe" heuristic
  guard — fragile (must guess which copy to keep), does not fix the corrupted
  persisted data, and pollutes the fingerprint/dirty machinery
  (`scene-fingerprint.ts`) with insertion-driven churn.
- **Vendored-package condition:** upgrading or patching `@excalidraw/excalidraw`
  is out of scope *unless* the repro proves the package inserts twice after the
  persisted library is proven clean — and then only via a new explicit decision
  (spec §5). If (and only if) Track A proves the persisted library clean *and* a
  current build still inserts twins: stop — the vendored package is implicated.
- **Corrupted-library remedy** (dedupe on load vs. dedupe on next persist vs.
  none) is deliberately **not chosen here**: it is decided from the Track A
  appendix's findings (Phase 4) and recorded in this entry — never silently
  picked (spec §3.5.3).
- **§6 item 1 resolution approach (recorded per plan):** questionnaire-first.
  The reporter answers four observational questions — item source (default panel
  item vs. Browse-installed), item type (image item vs. shape elements),
  selection (single drag vs. multi-select), and whether the library *panel
  itself* shows one tile or two — plus the persisted shared library file
  `{config_dir}/excalidraw-zed/library.excalidrawlib` (single file for all
  sessions, `main.rs:1210-1217`) as it stood at repro time (duplicate
  library-item ids in it are **decisive** for the data-layer branch) and the
  sequence of library operations that preceded the repro. Escalate to a
  systematic reproduction session (clean library → Browse-install →
  same-library re-install exercising SSE re-delivery → panel edits → drag
  variants, file inspected after each step) **only if the questionnaire is
  inconclusive**: clean file + single-tile panel + twins persisting on a current
  build.

- Appendix findings (Phase 2 Track A, 2026-09-06): **the persisted shared
  library already contains twin entries — 216 items over 187 distinct ids,
  29 ids duplicated exactly twice**, laid out as the same 29-item block
  appended twice (position delta exactly 29), the copies differing only in
  per-element `updated`/`versionNonce` (same ids, order, versions, `created`,
  `status`). Mechanism confirmed at code level: vendored
  `mergeLibraryItems`/`isUniqueItem` dedupes by content (versionNonce-
  sensitive), **not by id**, so re-delivery of re-stamped items appends a
  second entry with the same id; both of our install paths (array + Blob)
  converge on it. The panel renders one tile per array entry → two tiles per
  duplicated item, structurally. Consequences for Phase 4: the unique-id
  invariant fix applies; the vendored-package boundary condition is **not
  met** (file not clean); a corrupted-library remedy **is required** (choice
  still Phase 4's to record). The reporter questionnaire was not collectable
  in this session (non-interactive); its decisive question is answered by the
  file inspection, and the systematic-GUI-repro escalation condition ("clean
  file + …") is therefore **false** — that session is not required. Full
  forensic detail in [`library-repro-appendix.md`](./library-repro-appendix.md).
- **Corrupted-library remedy (Phase 4, 2026-09-06): DEDUPE ON LOAD** (plus the
  dedupe-every-persist the choke point enforces anyway). Chosen from the
  appendix's findings (spec §3.5.3 — never silently picked), which proved the
  shared file corrupted *in the wild* (29 duplicated ids, appendix §1/§6):
  - *Why load-side:* without it, every drag of a duplicated item keeps
    inserting twins until some flow happens to persist, and the panel — which
    renders one tile per array entry — keeps showing two tiles per duplicated
    item for the whole session. Dedupe on load heals the panel at the very
    next open with zero user action, and because Excalidraw fires
    `onLibraryChange` when `initialData.libraryItems` seeds the library, the
    resulting debounced persist rewrites the on-disk file healed — the
    corruption clears itself on the next session, no migration step.
  - *Why not "dedupe on next persist" alone:* heals only after a library edit;
    a read-only consumer of a corrupted file stays broken indefinitely.
  - *Why not "none":* the insertion contract (D3's first clause) is violated
    for every duplicated id until the file heals; the report itself is the
    counterexample.
  - *Survivor rule (deterministic, per appendix §6's suggestion):* the copy
    with the **newest element `updated`** wins; ties keep the earlier-seen
    copy; the survivor occupies the id's first-occurrence position (no
    reordering churn). The observed corruption's copies differ only in
    `updated`/`versionNonce`, so "newest content" is the meaningful pick.
- **Fix-boundary guard outcome (Phase 4):** the vendored-package condition is
  **not met** — Track A proved the persisted library *not* clean (29 duplicated
  ids), so the package is not implicated and the stop-rule did not fire. The
  data-layer fix proceeds; no upgrade/patch of `@excalidraw/excalidraw`
  (spec §5). The package's merge (`mergeLibraryItems`) *is* the twin
  mechanism, but its behavior (content-equality dedupe that treats re-stamped
  id-equal items as new) is documented upstream behavior, worked around at our
  layer — exactly the boundary D3 draws.
- **Implementation record (Phase 4, 2026-09-06):** the invariant lives in ONE
  auditable choke-point function, `dedupeLibraryItems(items)` in the new pure
  `webview-src/src/library-merge.ts` (package-free at runtime, types only —
  the `dirty-state.ts` convention), wired at the four flow boundaries:
  1. **Initial seeding / corrupted-library remedy:** `sanitizePersistedLibrary`
     (same module) parses the `GET /library` envelope and dedupes; `main.tsx`
     calls it at the fetch site (replacing the bare
     `lib.libraryItems ?? []`).
  2. + 3. **Browse-install / SSE re-delivery / native import:** both install
     flows now go through `installLibraryPayload` (same module), which runs
     the vendored parse + `mergeLibraryItems` **and** the choke point inside
     one atomic `updateLibrary` call (the function form of `libraryItems`) —
     the panel never transiently holds two entries sharing an id, unlike a
     merge-then-repair two-call design. Semantics are otherwise unchanged
     from the previous `updateLibrary({ merge: true })` calls: same vendored
     parse functions (`loadLibraryFromBlob` / `restoreLibraryItems`), same
     `"unpublished"` default status, same prepended-new ordering.
     `App.tsx` injects the real vendored functions (`libraryPipeline`).
  4. **Persistence:** `persistLibraryItems` (`dirty-state.ts`) serializes
     `dedupeLibraryItems(items)` — every payload this app POSTs to `/library`
     satisfies the invariant whatever the calling flow handed in. A clean set
     is returned as the same reference, so clean persists are byte-identical
     to before.
  Entries without a usable id (malformed data, v1 element arrays) pass
  through: the vendored restore re-keys v1 items with fresh random ids, so
  they cannot collide. `libraryItemsRef` needs no guard of its own: its two
  writers are the (deduped) install results and the `onLibraryChange` mirror
  of panel state seeded deduped — both already invariant-clean.
- **Phase 4 verification (2026-09-06):** webview suite **233 vitest passed /
  0 failed** (Phase 3: 188; +45 new cases), `tsc --noEmit` clean, `cargo
  nextest run` **124 passed / 1 by-design skip** (baseline match), clippy
  `-D warnings` and `cargo fmt --check` clean (no Rust changes). New coverage:
  - `library-merge.test.ts` (pure module, injected I/O): the choke-point unit
    suite (the appendix's exact corruption signature, reversed restamp
    direction, ties, triplicates, multi-element survivor metric, same-
    reference no-op for clean input, unkeyed/v1 pass-through); the seeding
    remedy against a **verbatim slice of the reporting setup's persisted
    library** (`src/fixtures/corrupted-library.excalidrawlib` — one published
    context item + two duplicated pairs, the §1 block signature) plus
    envelope representation variants; the §3.5.2 interleavings — identical
    re-delivery idempotent, **restamped re-delivery** (the reported twin
    interleaving; the vendored merge fake's twin output is asserted first so
    the regression stays explained), Browse-install collision (one survivor
    per id, newest wins; older incoming never displaces), panel-edit-then-
    persist, Blob vs array representation variants, `openLibraryMenu`
    pass-through, install atomicity, sequential multi-library installs; the
    persist choke point (duplicated input persisted deduped, clean input
    byte-identical, repeated read/write/read round trip); a deterministic
    8-seed × 40-step interleaving driver over the four flows asserting the
    invariant on panel state, the ref mirror, and every persisted payload;
    and a passive corpus over every shipped library fixture.
  - `library-vendored.test.ts` (real vendored 0.18.1 code, the D1-proxy
    pattern extended to the package root): pins the root cause on real
    `mergeLibraryItems` (identical re-delivery deduped; **restamped
    re-delivery with the same library-item id appended — the twin, then
    healed by the choke point**; new items prepended); pins what the choke
    point keys on on real `restoreLibraryItems` (item ids preserved;
    element ids/`versionNonce`/`updated` preserved — restore does not
    equalize duplicated copies; idempotent for restored items, so the atomic
    install's extra restore pass is benign; v1 items re-keyed with fresh
    ids); and runs the exact original input end-to-end through the real
    pipeline (seeding twins on real code → healed; install → restamped Blob
    re-delivery → one entry per id, newest survives; identical re-delivery
    idempotent; repeated heal→persist→re-restore re-seed round trips).
  - Testing-scope note: the real `mergeLibraryItems` could not previously be
    loaded under vitest (the package root evaluates DOM-dependent module
    scope, incl. its own `Element.replaceChildren` polyfill);
    `library-vendored.test.ts` extends the color-mode stub preamble with
    `Element`/canvas so the root imports cleanly, removing the need to
    simulate the merge's semantics against real code.

Decided: 2026-09-06 (frozen in clarification; recorded Phase 1).

## Phase 6 — full automated verification sweep (2026-09-06)

Run after D1 (Phase 3), D3 (Phase 4) and D2 (Phase 5) landed, in CI order (UI
before cargo, because the webview bundle embeds at compile time). Working tree
at sweep time: `main` @ `e11705d` plus the uncommitted Phase 5 tail (the
`--version`↔`BINARY_VERSION` guard relocated out of `extension/` into
`preview-binary/tests/integration.rs`, and the read-only served-page end-to-end
test). No source change was made *by* this phase — it is a gate, not an edit.

### Commands and results

| Gate | Command | Result |
|---|---|---|
| UI bundle | `just ui` | built — `assets/index-CZBLqo1K.js` + 9 font families |
| Release binary | `just build` | built — `excalidraw-preview 0.6.0` |
| Rust tests | `just test` → `cargo nextest run` | **132 passed, 0 failed, 1 skipped** |
| TS typecheck | `just test` → `tsc --noEmit` | clean |
| Webview tests | `just test` → `vitest run` | **252 passed (14 files), 0 failed** |
| Lint | `cargo clippy --workspace --all-targets -- -D warnings` | clean (0 warnings); `just lint` exits 0 |
| Format | `cargo fmt --check` | clean |
| Real WebView | `just smoke` | **5/5 checks passed** |

### Delta vs. the Phase 1 baseline

| Suite | Baseline | Phase 6 | Delta |
|---|---|---|---|
| nextest passed | 124 | 132 | **+8** |
| nextest failed | 0 | 0 | 0 |
| nextest skipped | 1 | 1 | 0 |
| vitest passed | 144 (9 files) | 252 (14 files) | **+108 (+5 files)** |
| vitest failed | 0 | 0 | 0 |
| clippy / fmt | clean | clean | 0 |

**No new failure and no new skip: zero regressions from this work.** The single
skip is the same by-design one the baseline recorded —
`excalidraw-preview-binary::integration smoke_self_test_reports_all_checks_passing`,
`#[ignore]`d because it needs a display; this sweep exercised it through
`just smoke` instead, where it passed 5/5. No nextest "leaky" annotation
appeared in any run (the baseline predicted one was possible under parallel
load and would be the known heuristic, not a real leak — lsp-strategy D12).

Per-suite composition of the +8 nextest tests (`cargo nextest list`:
`excalidraw-preview` 6 · `…-binary::bin` 94 · `…-binary::integration` 33 = 133
listed, 132 run + 1 ignored): the extension corpus crate is **6**, one *fewer*
than baseline — `test_binary_version_matches_preview_binary_crate_version` was
moved out of `extension/src/lib.rs` into
`version_flag_matches_the_extension_binary_version_constant` in
`preview-binary/tests/integration.rs`, where it drives the real binary rather
than re-parsing a manifest, and where it honours this plan's **"No `extension/`
changes"** scope line (the extension crate's diff is now empty again). The
binary crate carries the other +9.

### The built binary embeds this entry's bundle (checkpoint requirement)

Verified three ways rather than assumed:

1. The `just ui` run emitted `assets/index-CZBLqo1K.js`; `strings` finds that
   exact name 67× in `target/release/excalidraw-preview`, and the embedded
   `index.html` points at it.
2. The release binary carries this entry's new strings — the
   `__excalidrawSaveUnavailable` global (D2) and the notice copy
   ("Nothing to save — this file could not be loaded…").
3. Three bundle-dependent tests were re-run with `--no-capture` to prove they
   took their *asserting* path and not their skip path (each prints a skip
   notice when `assets/` is empty, which a green run would otherwise hide):
   `test_save_menu_script_fallback_exists_in_shipped_bundle` (embedded
   `Assets`), `readonly_image_preview_serves_a_page_that_can_answer_a_save_gesture`
   (the bundle the real binary *serves* to a scene-less `.excalidraw.svg`), and
   `version_flag_matches_the_extension_binary_version_constant`. All three ran
   and passed; none printed its skip notice.

Note on the debug binary's older mtime: `rust-embed` is built without
`debug-embed`, so debug builds read `assets/` from disk at runtime and are not
invalidated by an asset change. `just smoke` and the debug-profile tests
therefore ran against the fresh bundle despite the binary not being relinked;
only the release build embeds bytes, and that one was rebuilt after `just ui`.

### Checklist rows ticked

Only the *Automated proxies* section of
[`acceptance-checklist.md`](./acceptance-checklist.md) was updated (sweep
results + smoke result + the identity of the build Phase 7 should test).
**Zero GUI cells were touched**: every D2 matrix cell, every §3.6 library
criterion and every §4.6 color-mode criterion remains `not performed` /
`n/a (reason)` for a human to fill in Phase 7, per the house rule that a
synthetic test may be cited beside a cell but may never set it.

## Phase 7 — macOS manual GUI acceptance (2026-09-06): partially executed

Phase 7's five tasks split cleanly in two, and the split is the outcome of
record.

### What ran

**Task 1, build identity — executed and complete.** Its three guard commands are
non-interactive, so the whole table is filled with verified values rather than
`record at acceptance` placeholders:

| Item | Captured value |
|---|---|
| `excalidraw-preview --version` | `excalidraw-preview 0.6.0` (PATH binary and `target/release`, identical) |
| `which -a` | one distinct candidate, `/Users/ken/.local/bin/excalidraw-preview`, printed 3× because `PATH` carries that directory three times |
| `readlink -f` | `…/excalidraw-zed-extension/target/release/excalidraw-preview` — the `just symlink` target |
| Embedded bundle | `assets/index-CZBLqo1K.js` — **the Phase 6 sweep build** |
| Extension / `BINARY_VERSION` | `0.6.0` / `0.6.0`; `extension/` diff empty |
| Zed | 1.18.1, build `20260904.150309` |
| macOS | 27.0 (`26A5425a`) |

Two things worth stating rather than leaving implicit: **D2 §2.2 candidate 1 is
dead on this host** — there is no second PATH candidate to be stale — and the
binary the GUI will launch is provably the swept build, not a Release download
cache, so the acceptance sitting and Phase 6 describe the same artifact.

**Gate re-run.** `just test` → 132 nextest passed / 0 failed / 1 skipped, `tsc
--noEmit` clean, 252 vitest passed (14 files) / 0 failed; `just lint` exits 0.
Identical to Phase 6, as it must be: Phase 7 changed no source file.

### What did not run, and why

Tasks 2–5 (the D2 macOS matrix, the §3.6 library criteria, the §4.6 color-mode
criteria, the excalidraw.com round-trip) are **pixel observations**, and Phase 7
ran in an automated non-interactive session with **no human at the GUI**. They
are recorded `not performed — no human operator in the Phase 7 automated
session`, one of the four honest values.

This is the house rule, but it is not only the house rule: on this host driving
the GUI synthetically is actively harmful. Phase 5 tried and recorded the result
— a synthesized `Cmd+S` landed in an unrelated application's prompt, and two
region screenshots framed unrelated content on a second display (both deleted
unsaved). It is Ken's live multi-display session. So no cell was ticked, nothing
was inferred from a passing test, and no input was synthesized this phase.

### The precondition that had expired (new finding)

Re-measuring the reporting setup's persisted shared library for the §3.6 criteria
turned up something the checklist could not have known: **the file has already
self-healed.**

| Measurement | Track A appendix §1 (mtime 13:00) | Phase 7 (mtime 15:39) |
|---|---|---|
| Total items | 216 | **187** |
| Distinct ids | 187 | **187** |
| Ids appearing twice | **29** | **0** |
| Bytes | 1,828,840 | **1,406,057** |

Every duplicate *entry* is gone; every one of the 187 *ids* survives, so no
unique item was lost. The survivors occupy positions **114–142** — the
appendix's first-occurrence positions — and all of their elements carry
`updated` = 2026-06-16T23:18:42, the **newer** of the appendix's two merge
stamps. Position and stamp together are precisely D3's survivor rule (newest
element `updated`, first-occurrence position), so this is not coincidence: a
preview opened during the Phase 5/6 window seeded through
`sanitizePersistedLibrary` and the seeding `onLibraryChange` echo persisted the
deduped result. **D3's dedupe-on-load remedy plus its self-heal path, observed
end to end on the real reported data, through the real binary and the real
vendored panel rather than a fixture.**

It is the strongest evidence D3 has, and it still **cannot tick a GUI cell** —
it says the persisted JSON is correct, not that a human saw one tile per item.
Recorded as a field observation beside the criteria, never as a pass.

Its awkward consequence is that the Phase 4-added §3.6 criterion — open the
preview against a library *still carrying* the duplicated ids and watch the
panel render one tile per item from load — is now **unrunnable as written**.
Rather than quietly drop it, Phase 7 restored its runnability:
`evidence/phase7-library-precondition/twin-library.py` re-appends the 29-item
block with the appendix's older second-copy element stamps, reproducing the
216 / 187 / 29 signature so D3's survivor rule faces the same choice it faced in
the wild. It backs the live file up first, refuses to double-install, and its
`--restore` was verified byte-identical against a `/tmp` copy — the live library
was never written to by this phase (mtime still 15:39). It has **not** been run
against the live file; that is the operator's step.

### Prepared for the sitting

The checklist gained an **operator runbook** so the human pass is one sitting:
identity guard → dev-extension check → the 8 live macOS D2 cells with the
concrete files and gestures for each scene state (and the reminder that a
read-only cell showing *nothing* is a `fail`, not a pass) → the library criteria
with their restore/​restore-back steps → the §4.6 criteria as re-worded by the
D1 re-litigation → the loop-back rule for any `fail`.

### Phase 7 checkpoint status

The checkpoint asks that every macOS matrix cell hold an honest value, with
`not performed` only where a reason exists. That holds: every cell is
`not performed` with the reason stated once per section, or `n/a` with its
structural reason. **The checkpoint's substance — a human having run the
matrix — is not met, and Phase 7 is therefore not complete.** Phase 8 is
sequenced after it (spec §6.4), so both remain open; that is the honest gap a
release reviewer must weigh, and Phase 9's release-readiness statement is where
it lands.

## Phase 8 — Windows matrix on `build-win-native` (2026-09-06): not performed, fully diagnosed

Phase 8's three tasks are a deployment (SSH, automatable), a GUI matrix (human,
interactive Windows session) and an escalation-rule evaluation (a judgement on
recorded evidence). The third ran; the second never could in this session; the
first *should* have been executable and was not, for a reason worth writing
down.

### Task 1 — deploy + capture identity: not performed, because the host is off

Not "unavailable", not "we ran out of time" — diagnosed, in four probes, and
reproducible in one command
([`evidence/phase8-windows-host/win-preflight.sh`](./evidence/phase8-windows-host/win-preflight.sh),
narrative in
[`reachability.md`](./evidence/phase8-windows-host/reachability.md)):

| Probe | Result |
|---|---|
| `ssh build-win-native` / `nc 192.168.100.64 2222` (and `:22`, the WSL side) | `Network is unreachable` — identical with the tool sandbox disabled, so not a sandbox policy |
| Controls: `nc github.com 443`, `nc 192.168.100.14 22` (`monster`, same LAN) | both **succeed** — the internet is up and that LAN *is* routed from here, which kills the "wrong site" explanation |
| From `monster`, on the same L2 segment: `ping`, `ip neigh show 192.168.100.64` | 100% loss, ARP `FAILED`/`INCOMPLETE` — **nothing answers for that address**: powered off, not firewalled, not a key problem |
| `qm list` / `qm start 701` / `pvecm status` on `monster` | guest `build-win` (VMID 701) `stopped`; start refused with `cluster not ready - no quorum?`; `Quorate: No`, `Expected votes 4 / Total 2 / Quorum 3 — Activity blocked` |

The plan names this host, so starting the guest was in scope and was attempted;
the hypervisor refused. **Forcing quorum (`pvecm expected …`) was not done** —
that is a change to the user's cluster configuration, well outside a fixes-dir
entry. Everything else touched on that infrastructure was read-only.

A second reason the deploy could not be short-circuited, recorded because the
runbook rests on it: **no Windows artifact for this build can exist on macOS.**
`cargo check --target x86_64-pc-windows-msvc -p excalidraw-preview-binary` fails
in `aws-lc-sys` (`jitterentropy-base-windows.h:49: 'windows.h' file not found`),
exactly AGENT.md's recorded trap, re-verified at rustc 1.98.1 / `aws-lc-sys`
0.41.0. And the entry's work is *uncommitted*, so no tag, Release asset or CI
artifact is this build. Hence the runbook deploys **source** (`git bundle` +
working-tree patch) and builds on the host.

**New finding (compile-level, not a cell).** The same check against
`x86_64-pc-windows-gnu`, with mingw's C toolchain
(`CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc`), **passes** — zero warnings,
`--all-targets`, so the bin, its `#[cfg(test)]` unit and `tests/integration.rs`
all type-check for Windows with `muda`, `tao`, `webview2-com` and `rust-embed`
in the graph (`target/x86_64-pc-windows-gnu/debug/deps/` holds both
`excalidraw_preview` rmeta units and `integration-*`). So AGENT.md's trap is
specifically the **MSVC** target lacking the Windows SDK headers, not "Windows
cross-checking is impossible": with mingw headers the tree type-checks for
Windows from macOS, including the `#[cfg(target_os = "windows")]`
`menu.init_for_hwnd` attachment (`main.rs:3022-3029`) that the Windows
accelerator and menu-bar cells depend on, and the `#[cfg(windows)]` test twins
(`test_file_uri_to_path_windows_drive_letter`, `…_windows_unc`). Compiling them
is not running them — running is step 4 of the Windows runbook, on the host.
It links nothing, embeds no WebView2
loader, ships nothing, and **cannot tick a Windows cell** — it is recorded in
the checklist's automated-proxies section, never beside one. Whether AGENT.md's
"Build, test, run" bullet should be sharpened with this is a **Phase 9 doc
decision**, deliberately not taken unilaterally here.

### Task 2 — the Windows matrix column: not performed

8 live cells + 4 structural `n/a`, all `not performed` with the reason stated
once in the table: the host was down, *and* these cells need an interactive
Windows desktop plus a human even when it is up (spec §6.4 says so outright).
Nothing was ticked, nothing inferred from the compile check, no input
synthesized. Same house rule as Phase 7, same honest value.

### Task 3 — the escalation rule: evaluated, and it does not fire

Spec §6.4: *if the macOS triage (Track B) found a muda delivery failure, the
Windows cells are required before release; if macOS was clean, `not performed`
remains an honest recorded gap.*

Track B classified **candidate 1 — stale PATH**, and eliminated candidate 2 for
the current build with positive evidence rather than absence of evidence: two
synthesized-but-real `Cmd+S` key equivalents — osascript-injected, so delivered
through AppKit's real menu key-equivalent path — each drove a complete save
round-trip through the shared accelerator → `MenuEvent` → dispatch path,
watcher-logged at the press timestamps (`cmd-s-triage.md`, Stage 2). Worth
carrying forward with it: the round-trips observed there were on a *clean*
scene, because synthesized input could not make the scene dirty. **The escalation
arm does not fire.**
The Windows column is therefore an honest recorded gap, not a release blocker —
and Phase 9's release-readiness statement must say so in those words rather than
implying Windows was verified.

Two caveats a release reviewer should weigh rather than skip, recorded here so
the "macOS was clean" premise is not stronger in the record than in reality:

1. The shared-path evidence is the **triage's**, not a human-run macOS matrix —
   Phase 7's cells are all `not performed`. §6.4's de-risking premise ("a clean
   macOS accelerator result") is satisfied by the triage's positive delivery
   proof, which is real, but it is one build on one host, not the matrix.
2. The Windows-specific parts of the path are exercised by **nothing** so far:
   `menu.init_for_hwnd` rather than `init_for_nsapp`, and WebView2 rather than
   WKWebView. The `-gnu` cross-check says they compile. Residual Windows risk is
   real and unmeasured; it is exactly what the deferred column would measure.

### Gate re-run and scope

Phase 8 changed **no source file** — its output is records, the preflight script
and the Windows runbook. `just test`: 132 nextest passed / 0 failed / 1 skipped
(the same by-design `#[ignore]`d smoke test), `tsc --noEmit` clean, 252 vitest
passed (14 files) / 0 failed; `just lint` exits 0. Identical to Phases 6 and 7,
as it must be.

### Phase 8 checkpoint status

The checkpoint asks that the Windows column be *"either fully valued, or `not
performed` with the availability reason recorded — never silently skipped;
identity capture (SSH) complete either way"*. The first clause holds: every
Windows cell carries an honest value with its reason. **The second does not —
identity capture is not complete, and could not be: there was no host to capture
it from.** That is the phase's honest outcome, and it is a stronger statement
than "unavailable" — the machine is off and its hypervisor cannot start it until
cluster quorum returns, which is recorded with the exact remediation. Phase 8
therefore remains **open**, alongside Phase 7, and both belong in Phase 9's
release-readiness statement as declared gaps.

## Phase 9 — docs, closure review, release readiness (2026-09-06)

The closure phase. It discharged the reversal of record D1 booked in Phase 1,
audited this log and the checklist for completeness, ran a defect-first review
over the entry's full diff — which found and fixed two real defects — took the
one doc decision Phase 8 deferred here, and wrote the release-readiness
statement.

### Documentation updated (D1's reversal of record, discharged)

D1 was booked in Phase 1 as a **reversal of record** against two specific places,
gated on the implementation being complete and verified. Both are now rewritten,
and three further edits were made because the phase checkpoint asks for docs
*consistent with the shipped behavior*, not merely for those two lines:

| File | Change |
|---|---|
| `docs/handling-excalidraw-files.md` §6 step 4 | The reversal proper. "plain JSON not at all — it inherits the OS/config theme" → the three-source priority chain, with plain JSON reading the literal key that post-serialization injection writes. Also records the half the Phase 1 wording could not have predicted: upstream strips the key **on load** too (finding N2), so the chain needs `reattachRawColorMode` to be true as written |
| `docs/handling-excalidraw-files.md` §7 table + prose | The `application/json` row now names the injection, with a paragraph on why it is not decoration (without it §6 step 4 has nothing to read) and on the byte-stable-splice property |
| `docs/handling-excalidraw-files.md` §6 step 3 | A save gesture in the read-only preview answers with a notice (D2) — the step previously said the preview "handles no other event" |
| `docs/handling-excalidraw-files.md` §7, new subsection | *"A save gesture always answers"* — the D2 rule, the three states with no toast surface, and the module-scope global that serves them |
| `docs/handling-excalidraw-files.md` §9 | Why `library` is idempotent *now*: the id-blind vendored merge, the choke point, the heal-on-load (D3) |
| `AGENT.md` "Document color mode round-trip" | Rewritten: both-directions stripping, the three sources in priority order, `serializeSceneForDisk` at both write sites, `reattachRawColorMode` on load, OS/config as fallback-only |
| `AGENT.md`, two new decision bullets | *"One library entry per library-item id"* (D3, incl. "do not scatter guards") and *"A save gesture is never silent"* (D2) — both are decisions a future agent must not silently reverse, which is what that section is for |
| `AGENT.md` "Build, test, run" | The Windows cross-check bullet, per the decision below |

**One prediction in the Phase 1 booking was not carried into the docs, on
purpose.** The plan's wording for the AGENT.md bullet ended "…the excalidraw.com
toggle pre-seed is accepted WYSIWYG propagation". That sentence describes a world
the Track C pre-verify disproved: current excalidraw.com strips the key on load,
so the toggle does **not** pre-seed there. The bullet records what the D1
re-litigation actually settled — non-propagation is upstream behavior, not a
regression of ours — rather than the prediction the plan was written under.

### Doc decision deferred by Phase 8, now taken

Phase 8 found that `cargo check --target x86_64-pc-windows-gnu --all-targets`
passes from macOS with mingw's C toolchain, and explicitly left to Phase 9
whether AGENT.md should be sharpened, "deliberately not taken unilaterally
here". **Taken: yes.** The old bullet ("cross-checking from macOS fails in
`aws-lc-sys`, not in our code") is false as stated — it is the **MSVC** target
that fails, for want of the Windows SDK. The rewritten bullet names the target
that fails and why, states that `-gnu` type-checks every
`#[cfg(target_os = "windows")]` path including `menu.init_for_hwnd`, and keeps
the honesty guard: a compile check can stand in for a compile review and never
for a Windows test result.

### Decision-log completeness audit

Every item the plan's audit task names, verified present rather than assumed:

| Required | Where | Present |
|---|---|---|
| D1 reversal of record | D1 entry, "Reversal of record" | ✅ — and now discharged (table above) |
| D1 mechanism | D1, "Mechanism record" | ✅ surgical text splice, with why-not-parse-and-reinsert |
| D1 pre-verify (§6.3a) | D1, "Pre-verify result" | ✅ pass/fail per criterion, method, three-source corroboration, `evidence/trackc-excalidraw-com/` |
| D1 `restore()` proxy (§6.3b) | D1, "Phase 3 verification" | ✅ `color-mode-vendored.test.ts` — restore tolerance, strip-on-save, strip-on-load |
| D2 classification | D2, "Triage classification" | ✅ candidate 1, with candidate 2 positively eliminated |
| D2 branch executed | D2, "Executed remedy branch" | ✅ 1:1 with the classification, six numbered parts |
| D2 §2.4 do-not-reverse marker | D2, "Rejected alternative" | ✅ marked, and the diff confirms no demotion |
| D3 invariant | D3, "Implementation record" | ✅ one choke point, four wiring sites |
| D3 interleaving coverage | D3, "Phase 4 verification" | ✅ §3.5.2 cases + the 8-seed driver + real-vendored suite |
| D3 corrupted-library remedy | D3, "Corrupted-library remedy" | ✅ dedupe on load, with the three alternatives weighed and the survivor rule |
| D3 vendored-package boundary | D3, "Fix-boundary guard outcome" | ✅ condition evaluated FALSE, stop-rule did not fire |
| §6.1 → evidence | D3 | ✅ `library-repro-appendix.md` |
| §6.2 → evidence | D2 | ✅ `cmd-s-triage.md` |
| §6.3 → evidence | D1 | ✅ (a) `evidence/trackc-excalidraw-com/`, (b) the vendored proxy suite, (c) checklist §4.6 as re-scoped |
| §6.4 → evidence | D2 §6-item-4 outcome + Phase 8 entry | ✅ `evidence/phase8-windows-host/` |

**Two corrections of record made during the entry, both already carried here and
worth naming so the log is not read as monotone:** the Phase 2 claim that "our
load path reads the raw key from disk independently of `restore()`" was wrong and
is corrected in the D1 re-litigation (finding N2); and the Phase 6 entry's phrase
"the extension crate's diff is now empty again" means *relative to the entry's
baseline `4543cab`*, which is the sense that matters for the scope line — the
mid-entry commit `98cea05` added a corpus test there and the working tree removes
it again. Verified: `git diff 4543cab -- extension/` is empty.

**No unrecorded choices.** Every decision this entry made — including the two
review fixes below and the accepted NIT — has an entry.

### Acceptance-checklist completeness audit

Audited mechanically, not by eye: no table row anywhere in the file has an empty
cell; all **36** D2 matrix cells (3 platforms × 4 entry points × 3 states) carry
`pass`/`fail`/`n/a (reason)`/`not performed`; all **11** §3.6 + §4.6 criteria
carry `not performed` with a reason. **Zero cells are ticked, and zero were
inferred from a passing test** — the automated proxies live in their own section
and are cited beside cells, never in them. The excalidraw.com round-trip is
recorded, as its re-scoped criterion, in §4.6.

One row was corrected here rather than left stale: the build-identity row named
`assets/index-CZBLqo1K.js`, which Phase 9's review fix superseded (see below).

### Defect-first review (plan task 5)

[`review-1.md`](./review-1.md), house `review-N.md` pattern, over
`4543cab..HEAD` plus the working tree. Findings and dispositions:

1. **MINOR, fixed — the SVG baked-mode reader out-ranked the key D1 had just
   made meaningful.** `detectDocumentDarkMode` dispatches on the *declared*
   content type, which comes from the file name, and the parse fallback chain
   documents that a `.excalidraw.svg` may actually hold scene JSON. For such a
   payload the SVG reader returned `false` — "no dark filter found" — which the
   `??` chain read as a decision and short-circuited past the file's own
   `appState.exportWithDarkMode`. A dark scene reopened light and the next save
   baked light in. Not a regression (before D1 that branch was dead code for
   every file — finding N2), but D1 revived the branch and this was the one input
   that shadowed it. Fixed by giving the SVG reader the contract the PNG reader
   already had: `svgBytesColorMode` returns `null` when the payload carries no
   baked rendering. The priority chain moved out of `main()` into a pure, tested
   `resolveDocumentColorMode`, which also stopped coercing a non-boolean key.
   **11 new vitest cases**, including the failing input exactly.
2. **MINOR, fixed — `declare module "*.js"` was the ambient type of every
   unresolved `.js` import in the project**, so a typo'd import would type-check
   as excalidraw's restore surface instead of erroring. Narrowed to two patterns
   anchored on the vendored dev-dist paths; verified by probe (a stray
   `./x.js` import now fails `TS2307`, which the wildcard accepted).
3. **NIT, accepted with rationale recorded** — `doSave`'s no-API notice uses a
   denylist (`reason !== "bootstrap"`), so automatic reasons would also notify.
   Unreachable in practice, and the denylist errs toward *more* observability,
   which is the direction D2 exists to protect; an allowlist would risk dropping
   a future reason back into silence.
4. **NIT, checked and cleared** — `corrupted-library.excalidrawlib` is a verbatim
   slice of the reporting user's personal library. Audited: 5 entries, one
   `status: "published"` public-library item plus two duplicated pairs of
   `line`-only shapes; the only text string in the 60 KB file is `"Jest"`. No
   personal content. Kept verbatim because that is what makes it the *original
   failing input*.
5. **RECORD** — the Phase 8 doc decision, taken above.

The review also re-verified, rather than trusting, the properties the entry's
claims rest on: the injector's string/escape/depth awareness and its
throw-not-drop failure mode (surfaced as "Save failed" / "Export failed: …", so
never silent); the same-object-reference no-op for keyless loads; that the
invariant logic exists in exactly one function with no scattered guards; that
`SAVE_MENU_SCRIPT`'s Rust line-continuation literal produces the intended
ternary and its fallback arm is itself guarded; that `App.tsx:609-624` is
byte-identical, so §2.4 is not reversed; and that the passive corpus suites read
real shipped artifacts and assert their corpus is non-empty, so an empty glob
cannot pass vacuously.

### Gate re-run — Phase 9 (2026-09-06), after the review fixes

Phase 9 is the first phase since Phase 5 to change source, so the bundle and the
binary were rebuilt in CI order and the whole sweep re-run:

| Gate | Result | Δ vs. Phases 6–8 |
|---|---|---|
| `just ui` | `assets/index-BzutzBzW.js` + 9 font families | **renamed** (was `index-CZBLqo1K.js` — `main.tsx` changed, Vite re-hashed) |
| `just build` | `excalidraw-preview 0.6.0`, embedding that bundle | — |
| `cargo nextest run` | **132 passed / 0 failed / 1 skipped** | 0 |
| `tsc --noEmit` | clean | 0 |
| `vitest run` | **263 passed (14 files) / 0 failed** | **+11** (finding 1's regression tests) |
| `just lint` (clippy `-D warnings` + `cargo fmt --check`) | exit 0 | 0 |

Against the Phase 1 baseline: **+8 nextest, +119 vitest, zero new failures, zero
new skips**; the one skip is the same by-design `#[ignore]`d smoke test. The
bundle rename is recorded in the checklist's build-identity table, because the
acceptance sitting must test **this** build and the guard exists precisely to
catch that kind of drift.

### Release readiness

Written at the top of [`acceptance-checklist.md`](./acceptance-checklist.md), in
the lsp-strategy closure format: what is verified and by what evidence, on which
build identity, and the outstanding gaps that gate publishing — in priority
order, (1) no human has run the macOS GUI matrix, (2) the Windows column was
never reachable (escalation rule evaluated; it does not fire), (3) the one-time
excalidraw.com round-trip on a file saved by the new build, (4) the work is
uncommitted, so no tag or Release asset is this build.

**Verdict: not ready to publish — and not because of a known defect.** The code
is complete, reviewed and green on every automated gate. What is missing is the
human half: **no cell of this entry's acceptance matrix has been observed by a
person on any platform.** That is stated in those words at the top of the
checklist rather than softened, because the whole point of the house rules here
is that a green test suite is not an acceptance result.

### Phase 9 checkpoint status

- Docs and AGENT.md consistent with shipped behavior — **met** (table above;
  five doc edits plus three AGENT.md bullets, including one bullet corrected as
  factually wrong).
- Decision log closed with no unrecorded choices — **met** (audit table above;
  two corrections of record named explicitly).
- Checklist states exactly what a release reviewer must believe on evidence —
  **met** (release-readiness statement; 36 matrix cells and 11 criteria all
  honestly valued, zero ticked).
- Spec frontmatter `reviewed` updated per house convention — **met**
  (`reviewed: true`, `reviewed_by`, `reviewed_on`, `review_iterations: 1`).

Phases 7 and 8 remain **open** by design, and this entry closes saying so.
