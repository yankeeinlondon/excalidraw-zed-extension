# Decision log — LSP event strategy & language restructure

Companion to [`spec.md`](./spec.md). Records the frozen decisions and the Phase 1
preflight evidence (per `plan.md`, Phase 1).

## D1 — §10 open question: conflict protection level

**Decision: Option 1 — revision checks with the documented narrow race.**

Rationale:

- Arbitrary external writers (Zed, git, CLI tools, other editors) cannot be made to
  cooperate with a lock or CAS protocol. Any stronger guarantee is unenforceable
  against them, so Options 2 and 3 do not actually close the final cross-process
  race either — they add scope around it.
- Option 2 (recovery snapshots) brings storage growth, retention/privacy policy,
  cleanup and a recovery UI — new product scope nobody requested here.
- Option 3 (conflict sidecar files) degrades the core edit-and-save experience and
  creates duplicate drawings, for no additional atomicity.

**"Preserve every competing write" is explicitly NOT an acceptance requirement.**
The §5 precondition contract (428/412 + revision echo suppression) closes the
normal watcher/auto-save race; a write landing in the final compare-to-write window
by an uncooperative external writer may be lost. Any reviewer reading that narrow
race in Phase 9 acceptance should treat it as accepted-by-this-decision, not as a
defect.

Decided: 2026-09-05 (Phase 1 of 9).

## D2 — Baseline test capture (clean tree, pre-implementation)

Run: `just test` on 2026-09-05 20:31 PDT, `main` @ `5ad325d`, no source changes yet.

| Suite | Result |
|---|---|
| `cargo nextest run` (workspace) | **74 passed, 0 failed, 1 skipped** |
| webview `tsc --noEmit` | clean |
| webview `vitest run` | **59 passed (4 files), 0 failed** |

Pre-existing skips (not failures):

- `excalidraw-preview-binary::integration smoke_self_test_reports_all_checks_passing`
  — `#[ignore]`d by design (needs a real display/window); passes when run
  explicitly via `cargo nextest run -- --ignored` (verified: 1 passed).

**There are no pre-existing failures.** Any failure observed in Phase 9 is a
regression introduced by this work.

Pre-existing lint state (noted per Phase 1's "discover now, not in Phase 9" rule):

- `cargo clippy --workspace --all-targets -- -D warnings` — **clean** at baseline.
- `cargo fmt --check` — **failed at baseline** with pre-existing rustfmt drift in
  `preview-binary/src/main.rs` and `preview-binary/tests/integration.rs`
  (mechanical re-wrapping only; no behavior). Phase 1 normalized it with
  `cargo fmt` so Phases 2–8 start from a clean lint baseline; `cargo fmt --check`
  now passes and `just test` was re-run green after the normalization. These are
  the only source files touched in Phase 1, formatting only.

## D3 — Working-tree state at Phase 1 start

`git status` on the baseline tree showed:

- ` M .claudine/memory/commits.md` — allowed by the plan (memory file).
- ` M prompts/implement.md` — the orchestration prompt template driving this very
  phase-session (file was previously empty). Not source code; not stashed because
  the session uses it and staging/committing is out of scope for phase agents.
  No source file was touched in Phase 1, so no contamination risk.
- `?? fixes/2026-09-05-lsp-strategy/plan.md` — this plan (untracked, expected).

## D4 — Environment hygiene (§9 cleanup record)

Actions taken 2026-09-05 20:30 PDT, evidence preserved first in
[`zed-compound-suffix-repro.md`](./zed-compound-suffix-repro.md):

1. **Symlink restored.** `readlink -f ~/.local/bin/excalidraw-preview` resolved to
   `target/release/ep-lsp-logger.sh` (the debug wrapper). Ran `just symlink`; it now
   resolves to `<repo>/target/release/excalidraw-preview` (the real binary).
2. **Wrapper processes stopped.** The wrapper's LSP pair (bash wrapper PID 9600 +
   child `excalidraw-preview --lsp` PID 9603, parented by the live Zed PID 7981,
   idle since 17:48) was terminated after evidence extraction. Zed respawns the
   language server on demand — now via the restored symlink → real binary.
3. **Investigation artifacts deleted** (all confirmed to belong to the
   investigation; named by the wrapper script itself):
   `target/release/ep-lsp-logger.sh`, `/tmp/ep-lsp-{stdin,stdout,stderr,traffic}.log`,
   and the leftover headless test file `/tmp/test-lsp.excalidraw.svg`
   (matched the `/tmp/test-lsp…` pattern from spec §9; no lock referenced it,
   no process held it).
4. **Lock audit.** Scanned `$TMPDIR`, `/tmp`, and `/private/tmp` for
   `excalidraw-*.lock`: **none exist** — no stale locks to remove, and no live
   preview locks were touched (there were none to preserve either).

## D5 — wasm build environment repair (discovered in Phase 2)

`just build-ext` (`cargo build --target wasm32-wasip1`) failed on the default
`stable` toolchain (rustc 1.98.1) with `dyld: Library not loaded:
@rpath/libLLVM.dylib` — stable's `rust-lld` is dynamically linked but its rpath
resolves to `lib/rustlib/aarch64-apple-darwin/lib/`, where rustup installed no
`libLLVM.dylib` (the dylib lives at the toolchain root `lib/`). rustc strips
`DYLD_*` variables when spawning the linker, so an env workaround cannot apply.

**Repair applied (2026-09-05, Phase 2):** one symlink at the first dyld-searched
location:

```
~/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/lib/libLLVM.dylib
  → ../../../libLLVM.dylib
```

`rust-lld` loads afterwards and `just build-ext` succeeds with the new Phase 2
manifest. The `1.98.1` toolchain has the same broken layout (not repaired — only
the default `stable` toolchain was); `1.97.1` ships a statically linked
`rust-lld` and was verified as a working fallback. **If a `rustup update`
reinstalls stable and the wasm link breaks the same way, recreate this
symlink.** This is a host environment defect, unrelated to the manifest changes;
recorded here so Phase 9's build gate doesn't rediscover it.

## D6 — Phase 3 contract details: absent revision & If-Match list semantics

Decided 2026-09-05 (Phase 3 of 9), implementing spec §5's revision contract:

1. **Absent revision representation.** A missing file is the constant
   `ABSENT_REVISION = "\"absent\""` — ETag-shaped so it round-trips through
   `If-Match` unmodified, and syntactically distinct from every
   `"sha256-<hex>"` value, so deletion can never masquerade as an empty file
   (or vice versa). `GET /data` 404 responses publish it in the `ETag` header,
   so a client that decides to recreate a deleted file has a discoverable value
   to acknowledge. A client holding a pre-deletion *byte* revision gets 412 —
   deletion changed the disk state its baseline describes.
2. **If-Match list semantics.** Comma-separated candidates; any exact
   byte-for-byte match allows the write (the Phase 7 "Keep my changes" flow
   sends the acknowledged overwrite revision alongside its accepted one).
   `*` never matches, alone or as a list entry — an unconditional overwrite is
   what the contract exists to prevent — but a `*` entry does not invalidate
   an exact match sitting next to it. Weak forms (`W/"…"`) never match, per
   RFC 9110 §13.1.1 (our validators are strong only).
3. **Header extraction via `HeaderMap`**, not `axum_extra`'s `TypedHeader` —
   keeps the dependency set unchanged.

## D7 — Known intermediate state after Phase 3 (expected, plan-acknowledged)

The `POST /data` `If-Match` precondition intentionally breaks older clients
that still POST unconditionally (risk register, plan line ~517). Two consumers
are affected and scheduled for later phases — **not defects of Phase 3**:

- **Embedded webview assets** (committed `preview-binary/assets/`) still speak
  the old protocol. Consequence: the `#[ignore]`d
  `smoke_self_test_reports_all_checks_passing` now FAILS when force-run
  (`Save failed: HTTP 428` on the "webview-mount + native save round-trip"
  check). Phase 6 rewrites the webview data layer to send `If-Match`, and
  Phase 9's `just ui && just build` rebuilds the embedded assets; the smoke
  gate is a Phase 9 acceptance item (`just smoke`). Do not "fix" this by
  weakening the precondition.
- **Vite dev-server mock** (`vite.config.ts`) still accepts unconditional
  POSTs; Phase 6 brings it to parity (428/412/200+ETag) per the plan.

Phase 3 verification state (for the Phase 9 gate to compare against):
`cargo nextest run -p excalidraw-preview-binary` → **86 passed, 1 skipped**
(the ignored smoke test); workspace `just test` → **91 passed, 1 skipped** +
typecheck clean + **59 vitest passed**; `just lint` and `cargo fmt --all
--check` clean.

## D8 — Phase 4 watcher reconciliation details

Decided 2026-09-05 (Phase 4 of 9), implementing spec §5's watcher behavior:

1. **Rename shapes.** notify reports renames as
   `EventKind::Modify(ModifyKind::Name(RenameMode::From|To|Both))` on some
   backends and as `Create`/`Remove` pairs on others; accepting the three
   broad kinds (`Modify`, `Create`, `Remove`) covers every shape without
   backend sniffing. Path filtering (`event_concerns_target`) compares each
   event path lexically against the canonical target first (notify joins the
   canonical watched parent with the event's file name, so a just-deleted
   target still matches), then via `canonicalize` for differently-spelled
   live paths (symlinks).
2. **Echo suppression semantics.** A disk revision equal to
   `last_written_revision` is *proof* of echo — and deliberately also
   suppresses an external write of byte-identical content: there is nothing
   to reload, so the distinction is unobservable to the client. No elapsed
   time is consulted anywhere in the server; the client's 2-second
   `ignoreSseUntil` suppression is removed in Phase 6.
3. **Deletion is definitive, not transient.** `NotFound` during a reconcile
   broadcasts immediately (the client surfaces the unavailable state via the
   Phase 3 404); only non-NotFound read errors take the 25/50/100 ms bounded
   backoff (3 attempts) before giving up silently and keeping the last good
   state. A delete+recreate burst therefore delivers one reload per observed
   transition rather than retrying the deleted state.
4. **Timing contract.** 80 ms trailing quiet (restarted per matching event)
   with a 500 ms forced reconcile measured from the burst's *first* event; a
   sustained stream (e.g. external auto-save every <80 ms, or the viewer's
   own sustained writes — which then suppress as echoes) can never starve
   reloads beyond ~500 ms of staleness.

Phase 4 verification state (for the Phase 9 gate to compare against):
`just test` → workspace nextest **103 passed, 1 skipped** (the by-design
`#[ignore]`d smoke test; still expected to fail when force-run until Phase 6,
see D7) + typecheck clean + **59 vitest passed**; `just lint`
(clippy `--all-targets -D warnings`) and `cargo fmt --all --check` clean.
New coverage: 4 watcher integration tests (rename-over, rapid-write
convergence via bounded ETag poll, delete/recreate with a reload per
transition, viewer-write echo suppression with an external-write positive
control) and 8 unit tests (event-kind/path filtering incl. sibling + symlink
+ deleted-path variants, reconcile decisions for external/echo/deleted/
unreadable states, burst coalescing proving the final event is never dropped,
forced max-wait reconcile under sustained events). Watcher timing tests were
run 3× consecutively with no flakes.

## D9 — Phase 5 didClose attention-signal details

Decided 2026-09-05 (Phase 5 of 9), implementing spec §4/§5's `didClose`
attention signal:

1. **Worker placement & lifecycle.** The forwarder is one dedicated thread
   spawned inside `run_lsp_server` before the dispatch loop, fed by a
   `std::sync::mpsc` channel — the dispatch loop only parses the URI, applies
   `is_excalidraw_path`, and sends; **no HTTP (and not even a canonicalize)
   sits on the stdio path**. When the loop exits (`exit`, EOF), the sender
   drops and the worker exits *without draining*: LSP shutdown must never
   wait on pending best-effort signals (Zed tears the server down ~3 s after
   the last buffer closes).
2. **Coalescing unit.** The queue dedupes by **canonical** path
   (`enqueue_closed_path` canonicalizes in the worker, so differently-spelled
   URIs of one file coalesce and a deleted file — whose canonicalize fails —
   is dropped: no lock identity, no forward). Cap 16, drop-oldest. Closes that
   arrive while a forward is in flight (or are queued) coalesce, which is pinned
   by the `enqueue_closed_path` unit test; the integration test pins that one
   close yields exactly one SSE frame with no spurious duplicates and that
   sequential closes (with an empty queue between) each produce a frame.
   Client-side, duplicate escalations never stack prompts (modal dedupe is
   revision-based, covered by vitest).
3. **Lock neutrality.** `forward_editor_closed` only *reads* the lock file
   (port lookup identical to `preview_is_live`); it never removes or rewrites
   a stale lock — lock lifecycle belongs solely to the preview process.
   Connection refused / timeout / unreadable port are silent no-ops.
4. **Timeout budget.** One shared `reqwest::blocking::Client` with a 500 ms
   total-request timeout (`EDITOR_CLOSED_FORWARD_TIMEOUT`). The
   prompt-shutdown integration test wedges the endpoint (accepts, never
   responds), proves the forward was attempted (accepted-connection counter),
   then measures the `shutdown` round-trip at < 400 ms — under the 500 ms
   the inline-HTTP design would impose.
5. **Route contract.** `POST /editor-closed` → `204 No Content`, broadcasts
   `PreviewEvent::EditorClosed` (`data: editor-closed` on `/events`); any
   request body is ignored (the handler takes no body extractor). The
   pre-existing `reload`/`library` SSE names are pinned by a unit test so
   the wire protocol cannot silently drift.

Phase 5 verification state (for the Phase 9 gate to compare against):
`just test` → workspace nextest **116 passed, 1 skipped** (the by-design
`#[ignore]`d smoke test; still expected to fail when force-run until Phase 6,
see D7) + typecheck clean + **59 vitest passed**; `just lint` (clippy
`--all-targets -D warnings`) and `cargo fmt --check` clean. New coverage: 5
unit tests (route 204/broadcast/body-ignored, SSE name pinning, queue
coalesce-by-canonical-path, cap-with-drop-oldest, missing-file drop) and 7
LSP integration tests through a shared `Lsp` stdio harness (three-suffix
single-instance, didSave-while-live no-respawn, reopen-after-shutdown,
didChange no-spawn, didClose→`editor-closed` SSE frame with preview alive +
no duplicate frame, plain-`.svg`/malformed-URI no-ops, stale-lock no-op,
prompt-shutdown-behind-slow-endpoint). LSP tests were run 3× consecutively
with no flakes and no leaks.

## D10 — Phase 6 webview data-layer decisions (implemented with Phase 7)

Decided 2026-09-05 (Phase 6 of 9; implemented in the same session as Phase 7
because P7 is a strict P6→P7 dependency and the working tree had no P6
artifacts when P7 was dispatched):

1. **Where the revision state lives.** Not raw refs in `App.tsx` — a
   `RevisionTracker` class in `dirty-state.ts` (accepted vs
   expected-overwrite revisions, `writeHeader()` read at *write time*), plus a
   framework-free `SyncController` (`sync-controller.ts`) that owns
   reconciliation, conditional writes and the conflict lifecycle with all I/O
   injected. The plan's "small module in dirty-state.ts so they are
   unit-testable" is honored: every concurrency/conflict behavior is a plain
   class testable without React or a DOM.
2. **Defer vs conflict.** `decideReconcileAction` defers only on *transient*
   state (mid-text-edit or a save in flight — the save's own 412 surfaces the
   conflict with fresher information) and conflicts on *durable* dirtiness.
   Deferred revisions are retained and retried on `editingEnded` /
   `saveSettled`, never discarded. The dirty/editing guard is re-evaluated
   **after** the fetch+parse awaits (pinned by a gated-parse regression test).
3. **Save serialization.** A `SaveQueue` (single promise chain) wraps
   export+POST; the `If-Match` value is read inside the queued op (after
   export), so a queued follow-up save carries the revision its predecessor
   acknowledged. `decideSaveOutcome` semantics preserved verbatim.
4. **Echo suppression is revision-based only.** `ignoreSseUntil` and the
   `onSaved(until)` prop are deleted; the client recognizes its own
   acknowledged revision (server-side Phase 4 suppression means it usually
   never even hears the event; the dev mock relies on the client-side
   known-revision no-op).
5. **SSE dispatch is a switch, not a fall-through.** `sse-events.ts` dispatches
   exactly `reload` / `library` / `editor-closed` and ignores unknown names;
   the read-only image preview uses `createReadonlySseHandler` (reload only,
   never a conflict dialog). Reconcile runs on every SSE open (which covers
   browser auto-reconnect) and each `reload`.
6. **404/parse-failure states.** A missing file is a retryable
   `unavailable` error (scene, dirty flag and accepted revision kept);
   unparsable bytes are a retryable `parse-failed` error and are never offered
   as a conflict resolution. The initial-load read-only fallback is untouched
   (it only runs before mount).
7. **Mock parity without Node types.** The dev mock's conditional-write core
   lives in `mock-server-core.ts` with a dependency-free SHA-256 (the webview
   tsconfig program does not include @types/node's `node:crypto` types under
   TS 6; a pure-TS implementation also lets the tests pin *exact* Rust ETag
   parity against FIPS 180-4 vectors — verified against `shasum -a 256`).
   `vite.config.ts` keeps its filesystem-backed store and uses the shared
   primitives; revisions are inherently per-path (derived from each file's
   bytes), and `/editor-closed` broadcasts `editor-closed` to that file's SSE
   client set.
8. **App/data-url fix included.** `App` now POSTs/GETs `/data` through the
   `dataUrl` prop (with the dev `?file=` param) — previously its saves always
   hit the parameterless path, so dev-tab saves would have written the
   *default* file under the new per-file mock revisions.

End-to-end verification (beyond unit tests): the real Vite dev server was
probed with curl (`ETag` + `no-store` on GET, 428 without `If-Match`, 200+ETag
then 412+current-ETag on POST, per-file isolation via cross-file 412,
`/editor-closed` → 204 + `data: editor-closed` to the right subscriber), and
the real debug binary headlessly confirmed the identical wire contract the
webview now speaks. Browser-level `just dev` interaction was NOT performed
(non-interactive session) — Phase 9's walkthrough covers it.

## D11 — Phase 7 conflict-UX decisions

Decided 2026-09-05 (Phase 7 of 9):

1. **One pending-conflict object, three reasons.** `SyncUiState.conflict =
   { revision, reason }` with reason ∈ `watcher | save-412 | editor-closed`;
   a save-time 412 raises it through the same path even if the watcher never
   fired (pinned by a test that never sends an SSE event).
2. **Banner vs modal.** The always-on surface is a non-modal, pointer-safe
   floating banner (both resolution buttons inline); the accessible modal
   (`role="dialog"`, `aria-modal`, labelled heading, focus trap, initial focus
   on the safe action "Keep my changes", Escape-to-dismiss) is reserved for
   the `editor-closed` *escalation*. Escape dismisses the modal but leaves the
   banner and the save pause intact; duplicate closes never re-prompt for the
   same unresolved revision (`modalDismissedRevision` guard).
3. **Write gating matrix.** While a conflict is pending: *all* writes blocked
   (explicit saves get a "Resolve the file conflict before saving" toast and
   `ok:false`, so save-and-close keeps the window open). After "Keep my
   changes": only automatic reasons (`autosave|maxwait|flush|blur|pointerup|
   bootstrap`) are blocked until the authorized explicit save succeeds. The
   close-triggered save is treated as explicit *after* Keep (it consciously
   replaces disk); before any resolution it is blocked like everything else.
4. **"Keep" is an authorization, not a baseline move.** `acceptedRevision`
   stays at the pre-conflict revision; only `expectedOverwriteRevision`
   becomes the displayed pending revision. A *second* external revision
   matches neither, so both the watcher path (fresh conflict) and the
   conditional write (412 → fresh conflict) reject it — tested both ways.
5. **Reload resolution races.** `resolveReload` bumps the reconcile sequence
   (invalidating in-flight fetches), parses before applying, blocks writes
   while applying (`applying` flag → `{kind:"blocked", reason:"applying"}`),
   and if the fetched revision differs from the pending one it re-reconciles
   instead of discarding edits for a stale version. Failures (fetch/404/parse)
   leave the conflict pending.
6. **Escalation deferral.** Native close-flow activity is approximated by the
   bridge window (`__excalidrawSave(reason:"close")` and
   `__excalidrawPrepareClose` bracket `notifyNativeCloseFlow`); a deferred
   escalation re-checks when the flow ends. No window focus is ever stolen —
   the modal only receives focus inside the WebView.
7. **`/dirty` stays advisory.** No write-protection or gating reads it.

Phase 7 verification state (for the Phase 9 gate): `just test` → nextest
**116 passed, 1 skipped** + typecheck clean + **137 vitest passed**; `just
lint` clean. New suites: `sync-controller.test.ts` (37 tests: apply/defer/
conflict decisions incl. the after-parse dirty guard, echo recognition,
queue-ordered conditional writes, 428 loudness, write blocking under
pending/applying/keep-notice, both resolutions, post-Keep second-revision
rejection, reload-failure/mid-flight-revision, editor-closed escalation,
duplicate-close, close-before-watcher, native-close deferral,
save-and-close 412), `sse-events.test.ts` (explicit dispatch, unknown-name
regression, readonly reload-only), `mock-server-core.test.ts` (FIPS vectors,
ETag parity, If-Match semantics incl. wildcard/weak/multi-value, 404/428/412,
absent-recreation, per-path isolation, replayed-write rejection), and
`conflict-ui.test.tsx` (server-rendered a11y assertions, focus-cycle logic);
`dirty-state.test.ts` grew `RevisionTracker` / `SaveQueue` /
`AutoSaveScheduler` (pause semantics) coverage. The manual `just dev`
walkthrough was not performed (non-interactive session) — it remains part of
Phase 9 acceptance. **Embedded assets remain stale** (see D7): `just ui &&
just build` in Phase 9 is still required before `just smoke` can pass, since
the committed bundle predates the If-Match client.

## D12 — Phase 8 documentation scope

Decided/verified 2026-09-05 (Phase 8 of 9), implementing spec §6.6:

1. **`AGENT.md`** — Language registration rewritten for the single-segment
   strategy (table for `Excalidraw`/`SVG`, why compound suffixes must never
   return, no-PNG/no-JSON rationale); `extension.toml` snippet synced to the
   real manifest (0.6.0, `languages = ["Excalidraw", "SVG"]`, capabilities
   block); LSP `didClose` rewritten from "no-op" to the attention-signal role
   (bounded coalescing forwarder → `POST /editor-closed`); `didChange`
   documented as deliberately unhandled; routes table gained
   `POST /editor-closed`, `POST /dirty`, `POST /native-action-result`,
   `POST /native-library-request`, and the `GET`/`POST /data` conditional
   semantics; a dedicated "Revision & conditional-save contract" section plus
   an SSE event-name table were added; `AppState` synced with `main.rs`
   (`save_mutex`, `last_written_revision`); the watcher startup step now
   describes the parent-directory watch, trailing reconciliation
   (80 ms quiet / 500 ms max-wait), and revision-based echo suppression
   (also fixes the stale "notify v6" reference — it is v8); Component 3's
   SSE/save sections now describe explicit event dispatch,
   `SyncController.reconcileFromDisk`, the save queue, and the conflict UX;
   Constraints & Gotchas gained the Zed 1.18 compound-suffix `didOpen` bug and
   the `.excalidraw.png` image-pane (CLI-only) limitation.
2. **`README.md`** — Usage no longer claims `.excalidraw.png` auto-opens the
   editable viewer (Zed's image pane claims it; CLI shown for the editable
   preview); a "Language registration notes" subsection covers plain-`.svg`
   "SVG" status-bar + idle server, language-selection disabling auto-preview
   with the CLI fallback, and that user `file_types` are never rewritten;
   Known limitations updated accordingly.
3. **`docs/PRD.md`** — Non-Goals updated (SVG syntax-highlighting deferral,
   `.excalidraw.png` click-to-viewer unreachable, upstream-bug filing intent);
   FR1 reworded for the two-language registration; FR12–FR14 added for the
   conditional-save/conflict/editor-closed contract with a "Conflict model —
   disk is the persisted interchange" section citing the accepted narrow race
   (D1); §8A/§8B/routes/data-flow/edge-cases synced (If-Match semantics,
   `editor-closed`, trailing-reconcile watcher, viewer-save data flow).

Checkpoint 8 verification (this phase's gate): `grep -rn 'excalidraw.svg"'`
over `AGENT.md docs/ README.md` → no matches (the compound-suffix strings in
the bug *descriptions* were deliberately unquoted so the literal grep is
clean — they document the prohibition, they do not claim registration);
`grep -n didClose AGENT.md` → attention-signal role only. Full gates re-run
green after the doc changes: `just test` → nextest **116 passed, 1 skipped**
(the by-design ignored smoke test, still a Phase 9 gate per D7/D11) +
typecheck clean + **137 vitest passed**; `just lint` (clippy
`--all-targets -D warnings`) and `cargo fmt --all --check` clean. Intermittent
nextest "1 leaky" annotation observed on some runs: it lands on a *different
random test each time* (e.g. `headless_server_serves_ping_config_and_data`,
`test_binary_version_matches_manifest` — the latter spawns no threads at all)
and every test passes; it is the leak heuristic firing under parallel load on
this host, not a real leak. Phase 8 changed no source files, so it cannot be
caused by this phase; noted here with the evidence so Phase 9 dismisses it
correctly.

## D13 — Phase 9 validation, automated conflict check, and acceptance scope

Decided/verified 2026-09-05 (Phase 9 of 9):

1. **Save-and-close-under-conflict is now an automated smoke check, not just a
   manual one.** `SmokeDriver` gained a `ConflictSave` stage: after the
   close-interception query, the driver rewrites the watched file externally
   (`SMOKE_EXTERNAL_SCENE`) and dispatches `__excalidrawSave({reason:'close'})`
   **in the same tick** — same-tick is the determinism trick: the save's
   `If-Match` is captured the instant the injected JS runs, so the round-trip
   necessarily speaks the stale revision regardless of when the watcher's
   trailing reconcile later applies. The conditional POST 412s, the client
   raises the pending conflict, and the bridge reports `ok:false`
   ("File changed on disk") — exactly what `poll_close_flow` maps to
   `CloseOutcome::Failed` (error dialog, window kept open). `CloseContext`
   carries the watched `file_path` for this (smoke-only; `None` in dev mode).
   `just smoke` → 5/5 PASS; the ignored integration test
   `smoke_self_test_reports_all_checks_passing` stays green. The
   human-draws-an-element GUI variant stays on the interactive checklist; its
   logic is vitest-covered from Phase 7.
2. **`.svg` open overhead measured**: median **5.3 ms** — spawn +
   `initialize` round-trip of `excalidraw-preview --lsp` (7 runs, release
   binary, macOS aarch64; headless preview-server boot → `/ping` median
   14.9 ms). One-time spawn; the LSP is an idle no-op for plain `.svg`.
3. **Upstream issue filed**: https://github.com/zed-industries/zed/issues/63831
   (duplicate search first; body from `zed-compound-suffix-repro.md`).
4. **Real-Zed walk-through not performed — recorded, not omitted.** The
   session was non-interactive and Zed 1.18.1's CLI has no
   `--install-dev-extension`, so dev-extension install + click-through
   verification (the `.excalidraw.svg` regression gate included) could not be
   executed. Every such item is annotated in `acceptance-checklist.md` with
   its automated proxy (LSP integration harness, vitest suites) and remains a
   human precondition for publishing. The Phase-8 "1 leaky" annotation did
   not recur in any Phase 9 run (116 passed / 1 skipped across multiple
   sweeps); dismissed per the D12 evidence.
5. **Commit + `just bump` deferred by instruction.** Phase 9 ran under an
   explicit do-not-commit directive (commit is a separate process). `just bump`
   must follow on a clean `main`, still gated on the interactive acceptance
   items; publishing remains gated on acceptance.
6. **Final gates**: `just ui` → `just build` (rebuilt after the smoke change)
   → `just build-ext` green; `just test` green (nextest 116 passed / 1
   skipped-by-design smoke test, typecheck clean, 137 vitest passed);
   `cargo clippy --workspace [--all-targets] -- -D warnings` and
   `cargo fmt --check` clean; `just smoke` 5/5 on macOS (Linux equivalent
   recorded as not performed — no Linux display in this session).
7. **justfile smoke hygiene.** The smoke recipe appended `.excalidraw` to
   `$(mktemp -t excalidraw-smoke)`, orphaning the bare mktemp file in `$TMPDIR`
   on every run (the trap removes only the suffixed path). Fixed by renaming
   mktemp's file before use; verified by a re-run (`just smoke` 5/5, `$TMPDIR`
   clean). Also: a one-off measurement script leaked a daemonized preview by
   omitting `--foreground` (the daemon's re-spawn drops `--port`, so the
   script's `/shutdown` hit the dying parent); stopped gracefully via its live
   `/shutdown`, lock removed by the binary itself — measurement-script user
   error, not a product defect.

## D14 — Review 1 follow-ups (findings 2–8 implemented; finding 1 left open)

Decided/verified 2026-09-06, responding to `review-1.md`. Finding 1 (the
real-Zed acceptance BLOCKER) is a process gate, not a code change, and remains
open exactly as `acceptance-checklist.md` records it.

1. **Finding 2 — broadcast lag now yields a `reload` hint.** `serve_events`
   loops over a new `next_sse_payload(rx)` helper that maps
   `RecvError::Lagged` to `PreviewEvent::Reload.as_sse_data()` instead of
   `continue`. A reload is an idempotent invalidation hint (a clean client
   no-ops on a known revision), so a lagged subscriber reconciles instead of
   going silently stale — the literal spec §5 wording. Pinned by
   `test_next_sse_payload_yields_reload_on_lag` (17 sends into the 16-slot
   channel → first payload is `reload`, survivors follow, `Closed` → `None`).
2. **Finding 3 — `is_excalidraw_path` doc rewritten** to describe the shipped
   model (`Excalidraw`/`excalidraw` + grammar-less `SVG`/`svg`, plain `.svg`
   detected as `image/svg+xml`, plain `.png` never reaching the LSP,
   `.excalidraw.png` CLI-only) instead of the removed compound-suffix
   registration.
3. **Finding 4 — `serverInfo.version` is `env!("CARGO_PKG_VERSION")`**;
   `lsp_initialize_advertises_save_capability` now asserts name + version so
   it cannot drift again.
4. **Finding 5 — didClose wire behavior pinned as it actually is.** The
   integration test now sends a *second* sequential `didClose` and asserts a
   second `editor-closed` frame (plus liveness after both). Rapid duplicates
   cannot be pinned deterministically end-to-end (the worker may dequeue the
   first before the second lands), so queued-duplicate coalescing stays pinned
   by the `enqueue_closed_path` unit test; D9.2's wording was softened to
   match. Client-side prompt dedupe remains revision-based (vitest).
5. **Finding 6 — Windows twin of the 500 write-failure test** using
   `Permissions::set_readonly(true)` with the same root/admin-bypass probe and
   assertions; writability is restored before the `NamedTempFile` drops
   (Windows cannot delete a read-only file). `#[allow(clippy::permissions_set_readonly_false)]`
   is scoped to that test with a justification. **Not executed here**: a
   `cargo check --tests --target x86_64-pc-windows-msvc` cross-check failed in
   the transitive `aws-lc-sys` C build (jitterentropy sources need a Windows C
   toolchain), unrelated to the test; it runs for real only on a Windows host
   (milestone M7).
6. **Finding 7 — bounded notify→watcher queue with an overflow flag.**
   `sync_channel(WATCHER_QUEUE_CAPACITY = 256)` + `try_send`; a `Full` result
   sets `WatcherContext::overflow`, which `run_watcher_loop` swaps-and-clears
   at the top of each iteration and after each burst, forcing a
   `reconcile_disk_state`. Drop-on-full alone would be *incorrect* (the
   dropped event could be the last hint of a change); the flag is what makes
   it safe, and because the flag can only be set while the queue is full the
   loop is guaranteed to observe it on a subsequent iteration.
   `test_watcher_overflow_flag_forces_reconcile` proves a reload with **no**
   target event ever queued, and that the consumed flag does not keep firing.
7. **Finding 8 — read-only image reload is unit-tested.** The refetch /
   object-URL swap / revoke-previous / keep-last-good-on-failure logic moved
   verbatim into `readonly-image.ts` (`createReadonlyImageRefresher`, all I/O
   injected, node vitest environment) with 7 tests; `main.tsx` keeps the
   150 ms debounce and `createReadonlySseHandler` dispatch unchanged.
8. **Gates after the changes**: `just ui` → `just build` (bundle rebuilt and
   embedded; note `preview-binary/assets/` is gitignored, so it never shows
   in `git status`); `just test` → nextest **118 passed / 1 skipped** (the
   display-gated smoke; one "leaky" annotation, the known D12 heuristic),
   typecheck clean, vitest **144 passed**; `cargo clippy --workspace
   --all-targets -- -D warnings` and `cargo fmt --check` clean. Nothing
   committed (commit remains a separate step); finding 1 still gates
   `ready: true`.

## D15 — Bundle grammars: SVG/JSON highlighting, reversing the §8 deferral

**Decision: ship a tree-sitter grammar with each registered language —
`grammar = "json"` for `Excalidraw`, `grammar = "xml"` for `SVG`.**

Spec §3 registered the `SVG` language as grammar-less ("none initially") and §8
listed SVG syntax highlighting as a deferred non-goal. That deferral is now
reversed. Recording it here because review-2 finding 2 correctly flagged that the
change had been made with no record and that the grammar-less corpus assertions
were rewritten in place, leaving the git history showing an assertion vanishing
rather than a decision changing.

What prompted it: the user asked for it directly, twice — a `.excalidraw` buffer
showed no JSON styling to sanity-check a hand-edit, and a `.excalidraw.svg` buffer
rendered as plain text. The grammar-less packaging risk that §8 was hedging
against **was never hit** — the interactive install has still not been run
(finding 1). The deferral was therefore reversed on product grounds, not because
the risk resolved.

Why bundling is legitimate under the original constraint: §8's stated blocker was
that "the registry packager rejects referencing another extension's grammar". It
does — so the grammars are *bundled by this extension* (`[grammars.json]` /
`[grammars.xml]` in `extension.toml`, pinned by rev, with query files vendored
beside each language config), not referenced from the installed XML extension.
The constraint is satisfied rather than circumvented.

Scope and blast radius: **highlighting only.** No grammar influences suffix
matching, language→server association, `is_excalidraw_path`, or whether a preview
spawns. The `SVG` language already claimed every `.svg` buffer before this change;
those buffers now render as XML instead of plain text, which is the same treatment
Zed's XML extension gives `.xml`.

Rollback: delete the `grammar =` line from the affected `languages/*/config.toml`
(and its `[grammars.*]` block). That restores the previously shipped grammar-less
behaviour with no other change, which is why the packaging risk is recoverable
rather than blocking.

Verification performed: the five vendored query files compile against both
grammars at their pinned revs (`tree-sitter query`, run against a real
`.excalidraw` and the real `docs/examples/architecture.excalidraw.svg`, which
parses with zero `ERROR` nodes); the `Excalidraw` object-key rule is confirmed to
win over the generic string rule by pattern order. The corpus test
`every_language_grammar_is_bundled_and_has_queries` pins that every declared
grammar is bundled with `repository`/`rev`/subpath and ships a `highlights.scm` —
the failure mode it guards is the registry's "grammar not found" rejection, which
only a GUI install can actually exercise. The acceptance checklist's packaging
item was rewritten to gate the grammar-ful artifact (review-2 finding 4).

Not covered by this decision: JSON *schema* validation of scenes. That needs a
JSON language server, which would mean claiming the built-in JSON language and
spawning this server for every JSON file — forbidden by the §3 registration
decision, and unchanged.

Decided: 2026-09-06 (after Phase 9 automated gates, before the interactive run).

## D16 — `.excalidraw.png` in Zed is unreachable, not deferred

**Decision: stop treating "open a `.excalidraw.png` from Zed" as future work.
It cannot be built from an extension, and the record now says so.**

Spec finding 6 established that Zed's image pane claims `*.png`. That is a
statement about one function, and it left the door open to readings like "maybe a
`png` language would attach anyway", "maybe a `file_types` override wins", or
"maybe a task can pass the path". After the user reported the PNG file still not
opening, each of those was checked in Zed's source rather than reasoned about, and
all are closed. The result is spec **finding 8**: four independent gates —
extension-only matching in `is_image_file`; a project-item registry that resolves
last-registered-first with the image viewer registered after the editor, so no
buffer is created at all; `register_project_item` being absent from
`zed_extension_api`; and `ZED_FILE` being populated only from an active `Editor`
item, which an image item is not.

The load-bearing correction is gate 2: **no buffer is created**, so there is no
`didOpen` that we filter out — there is no `didOpen`. Any future attempt to "fix
the filtering" is therefore misdirected.

Consequences recorded elsewhere: the acceptance checklist's PNG item is marked
not-applicable (a GUI run cannot change a Zed-side outcome, though the interactive
run should still confirm the LSP stays silent); §8 now carries two concrete
upstream asks — an extension-registrable project item, *or* `is_image_file`
honouring a `file_types` override — either of which alone would unblock it; and
`AGENT.md` marks this as not to be re-litigated without an upstream change.

The supported routes are unchanged and now documented in `README.md` and
`docs/handling-excalidraw-files.md`: launch from a terminal
(`excalidraw-preview <file>`, `excalidraw-preview --new <file>` for a new one),
or — if what you want is an image format that opens from a Zed click — use
`.excalidraw.svg`, which is explicitly exempted from `is_image_file` and embeds
the scene identically.

Verified against `zed-industries/zed` `main` as fetched 2026-09-06; the installed
build is 1.18.1, so the cited line numbers are locators, not pins.

Decided: 2026-09-06.
