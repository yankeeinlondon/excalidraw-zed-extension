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
- Executed remedy branch (Phase 5): *pending.*

Decided: 2026-09-06 (frozen in clarification; recorded Phase 1).

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
