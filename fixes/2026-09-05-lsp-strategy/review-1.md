---
$schema: "../../.claudine/schemas/feature-review.yaml"
ready: false
reviewed_by: "opencode/zai-coding-plan/glm-5.3"
created: "2026-09-06T01:29:27-07:00"
spec: "2026-09-05-lsp-strategy/spec.md"
implemented: true
description: "A **fix** review of `2026-09-05-lsp-strategy/spec.md`"
fix: "2026-09-05-lsp-strategy/review-1.md"
next: "2026-09-05-lsp-strategy/review-2.md"
review_iterations: 1
---

# Review 1 — LSP event strategy & language restructure

Reviewed against [`spec.md`](./spec.md) (all sections), the implementation as
committed on `main` (`31f18a2`, `d561bdb`, `1b4b1a7`), and a fresh execution of
the full validation sweep on this machine.

## Verification performed (not just read)

| Gate | Result |
|---|---|
| `just test` (cargo nextest + `tsc --noEmit` + vitest) | **116 nextest passed, 1 skipped** (display-gated smoke, by design) · typecheck clean · **137 vitest passed** |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| Embedded assets freshness | `assets/assets/index-*.js` contains the `If-Match` client and `editor-closed` dispatch — the committed bundle matches the new protocol (the D7/D11 staleness was resolved by the Phase 9 `just ui && just build`) |
| Extension corpus tests | `extension/src/lib.rs` pins `languages = ["Excalidraw","SVG"]`, single-segment `path_suffixes` only, grammar-less SVG, and no `png`/`json` claims, parsing the *shipped* TOML artifacts |

## Spec-to-implementation map (verified)

- **§3 Registration** — `extension/languages/excalidraw/config.toml` claims
  exactly `["excalidraw"]`; new grammar-less `languages/svg/config.toml` claims
  `["svg"]`; `extension.toml` maps the server to both languages; no PNG/JSON
  language. Enforced by corpus tests so the strategy cannot silently regress.
- **§4 Event semantics** — `didOpen` spawns (guarded, dedups via lock/`/focus`),
  `didSave` reopens only when not live (`preview_is_live`), `didChange`
  deliberately unhandled, `didClose` is an attention signal. All eight planned
  LSP integration cases exist and pass through a shared stdio `Lsp` harness,
  including the slow-endpoint/prompt-`shutdown` proof (<400 ms behind a wedged
  forward) and subscribe-before-close SSE assertions.
- **§5 Revision contract** — `GET /data` ETag + `no-store`, 404 +
  `ETag: "absent"`; `POST /data` 428/412/200 with `save_mutex`-serialized
  re-read-compare-write and `last_written_revision` recorded *inside* the lock;
  comma-separated `If-Match` lists accepted, `*` and weak forms rejected. Unit
  coverage is exhaustive (including the root-bypass skip guard on the 500-path
  test) and `post_data_writes_scene_to_disk` drives the real binary.
- **§5 Watcher** — parent-directory non-recursive watch filtered to the
  canonical target; trailing reconciliation (80 ms quiet / 500 ms forced) with
  unit tests proving the final event of a burst is never dropped; revision-only
  echo suppression; deletion broadcasts immediately; bounded 25/50/100 ms
  backoff on transient errors. Integration coverage: rename-over, rapid-write
  convergence via bounded ETag polling (no fixed-sleep assertions), delete /
  recreate per transition, echo-suppression with an external-write positive
  control.
- **§5 didClose forwarding** — dedicated thread owns all HTTP (never the stdio
  path), dedupe by canonical path, cap 16 drop-oldest, 500 ms client timeout,
  lock-neutral reads only, no drain on shutdown. Unit + integration coverage
  present.
- **§5 Webview** — `RevisionTracker` / `SaveQueue` / `AutoSaveScheduler` /
  `SyncController` implement the deferred-vs-conflict decision with the
  post-await dirty guard, conditional writes, 412→conflict (including the
  no-watcher-event path), both resolutions, second-revision-after-Keep
  rejection, editor-closed escalation with one-modal-per-revision and
  native-close deferral, and conditional save-and-close. The Vite mock reaches
  contract parity (FIPS-vector-verified SHA-256 matching the Rust ETag form,
  per-file revision isolation). Every scenario listed in spec §7's vitest
  bullet list has a corresponding passing test.
- **§6/§8/§9** — docs rewritten (AGENT.md/README/PRD); upstream issue filed
  (zed#63831); investigation artifacts cleaned up with evidence preserved
  (decision-log D4); automated smoke (macOS) 5/5 including the new
  save-and-close-under-conflict stage (`begin_conflict`, same-tick determinism
  trick).

## Findings

### 1. BLOCKER (process, not code): the fix's central hypothesis is still unverified in real Zed

The entire workaround rests on findings 3/4 — that single-segment suffixes
route `didOpen` while compound ones do not. Spec §7 states "A synthetic
`didOpen` test cannot validate Zed suffix matching or prove the workaround",
and the plan's Checkpoint 9 release gate requires the `.excalidraw.svg`
click-to-preview regression to be confirmed **in real Zed**. Every real-Zed
checklist item is honestly annotated **not performed** (non-interactive
session; Zed 1.18.1 has no CLI dev-extension install). The risk-register's own
fallback for "the workaround doesn't actually fix routing" is reopening the
investigation — which cannot be ruled out until the interactive run happens.

**Verdict impact: this alone keeps the feature non-production-ready**, exactly
as `acceptance-checklist.md` already records ("outstanding human steps before
publishing"). Required before `ready: true`:

- [ ] Interactive dev-extension install + the click-through regression items in
      `acceptance-checklist.md` (grammar-less SVG packaging, both language
      mappings, `.excalidraw.svg`/`.excalidraw` fresh-buffer → viewer, focus
      dedup, reopen-on-save, preview-tab replacement, LSP teardown/restart,
      plain-`.svg` no-op, PNG image pane, coexistence, Zed auto-save).
- [ ] Commit (currently deferred by instruction) and `just bump` on clean
      `main`, still gated on the above.

### 2. MINOR (spec gap): SSE broadcast-lag reconcile is not implemented

Spec §5: "On initial subscription, reconnect, **and broadcast lag**, reconcile
again so a missed event cannot leave the view silently stale."
`serve_events` (main.rs:1106) swallows `RecvError::Lagged` with `continue` —
missed frames are dropped with no replacement hint, and the client only
reconciles on `onopen`/`reload`/`editor-closed`. If the sole subscriber falls
>16 events behind, the view can go silently stale until the next event or
reconnect. Probability is low (one subscriber, low event rate), but this is a
literal deviation with zero coverage. Suggested fix: on `Lagged`, yield a
`reload` frame (an invalidation hint is idempotent — a clean client no-ops on a
known revision) or document the accepted deviation in the spec.

### 3. MINOR (doc drift): `is_excalidraw_path` doc comment describes the removed registration

`preview-binary/src/main.rs:3485-3493` still says the server is attached to the
"Excalidraw" language with "path suffixes `excalidraw`, `excalidraw.svg`,
`excalidraw.png`" and that plain `.svg`/`.png` are "MIME-detected as JSON".
After this fix the attachment is `Excalidraw` (`excalidraw`) + `SVG` (`svg`),
and plain `.svg` is detected as `image/svg+xml`. The guard's *purpose* is
unchanged but the comment now teaches the wrong model — the exact thing the
Phase 2 config comments and corpus tests were written to prevent. One-paragraph
fix.

### 4. MINOR (drift): LSP `serverInfo` version is hardcoded `"0.1.0"`

`run_lsp_server`'s `initialize` response (main.rs:3322) reports version
`0.1.0` while crate and manifest are `0.6.0`. Use
`env!("CARGO_PKG_VERSION")` so it can't drift again. Cosmetic (nothing keys
off it today), but it is user-visible in editors that surface server info.

### 5. MINOR (test accuracy): the "duplicate closes coalesce" integration claim overstates what is pinned

In `lsp_did_close_forwards_editor_closed_to_live_preview`
(tests/integration.rs:1335-1339) only **one** `didClose` is ever sent; the
assertion proves no *spurious* duplicate frames arrive for a single close.
Decision-log D9.2's claim "exactly one SSE frame per close, none for a
duplicate" is therefore pinned only by the `enqueue_closed_path` unit test
(queued-dedupe), not end-to-end — and two *sequential* closes with an empty
queue between forwards would legitimately each produce a frame (harmless
client-side: modal dedupe is revision-based). Either send a second `didClose`
in the integration test to pin the wire behavior you actually want, or soften
the D9 wording. Low impact because the client-side guarantee ("duplicate closes
never stack prompts") *is* covered by vitest.

### 6. MINOR (OS parity): the 500 write-failure path has no Windows coverage

`test_post_data_write_failure_is_500_and_last_written_revision_unchanged` is
`#[cfg(unix)]` (chmod `0o444`). Windows has a portable equivalent
(`std::fs::Permissions::set_readonly(true)`), so the I/O-error branch of
`receive_data` would simply have no coverage on a Windows host. Acceptable
while Windows builds/CI are milestone M7, but since a portable variant exists,
prefer it (or add a `#[cfg(windows)]` twin) so each OS exercises the same
branch. Otherwise OS-specific handling in this changeset is exemplary:
`#[cfg(windows)]` URI tests (drive-letter, UNC) mirror the POSIX ones, and the
reviewer confirmed no un-gated Unix assumptions in the new code.

DECISION: have `#cfg(windows)` tests which mirror the test _goals_ of the Linux/macOS ones
but that use Windows semantics.

### 7. NIT: unbounded mpsc between the notify callback and the watcher loop

`main.rs:599` uses an unbounded `std::sync::mpsc::channel`; a pathological FS
event storm in the watched directory buffers without limit until the loop
drains. Practical risk is negligible (the loop filters promptly and the 500 ms
forced reconcile bounds staleness), but a bounded `sync_channel` with
drop-on-full would be equally correct *because* reconciliation is
hint-driven. Optional.

### 8. NIT: `renderReadonlyImage`'s reload closure is untested

`main.tsx:107-121` — the read-only image refetch/object-URL-swap logic is
covered only indirectly via `createReadonlySseHandler` dispatch tests; the
fetch-and-refresh body itself has no test. Small and read-only, hence a nit,
but spec §7 lists "initial read-only image reload" among the vitest
expectations.

## Things explicitly checked and found *fine*

- `If-Match` semantics vs RFC 9110 (strong-only, list form, wildcard rejection
  is a deliberate contract decision recorded in D6) — implemented and tested
  identically in Rust and the TS mock, with FIPS vectors proving ETag parity.
- The accepted narrow cross-process write race (§10 / D1) is *not* re-litigated
  here; it is accepted by decision.
- macOS close-dialog re-entrancy and Edit-menu constraints are untouched.
- nextest "2 leaky" annotations recurred on random tests this run
  (`embedded_assets…`, `delete_then_recreate…`) with all tests passing —
  consistent with D12's evidence that the leak heuristic fires under parallel
  load, not a real leak.
- The `just smoke` mktemp hygiene fix and the conflict-stage automation are
  real and well-designed (same-tick If-Match capture is a sound determinism
  trick).

## Verdict

**Not production ready** — `ready: false`.

The engineering is genuinely strong: the spec is implemented faithfully, the
test discipline (bounded deadlines instead of sleeps, shipped-artifact corpus
tests, injected-I/O controllers, cross-language contract parity) is well above
average, and every automatable gate is green on a fresh run. But by the spec's
own release gate, the core workaround is an unproven hypothesis until the
real-Zed walk-through passes, and the release mechanics (commit, `just bump`)
are deliberately deferred. Findings 2–6 are small, well-bounded fixes worth
folding in before or alongside the acceptance run; none of them block it.

Recommended path to `ready: true`:

1. Fix findings 3, 4 (doc/version drift) and optionally 2, 5, 6, 8.
2. Perform the interactive real-Zed acceptance items in
   `acceptance-checklist.md`; record build identity.
3. Commit on clean `main`, run `just bump`, publish separately.

## Implementation record (2026-09-06)

Findings **2–8 implemented** on the working tree (not committed); see
`decision-log.md` D14 for the per-finding details and the re-run gates
(nextest 118 passed / 1 skipped, vitest 144 passed, clippy + fmt clean).
Finding **1 remains open** — it is the interactive real-Zed acceptance gate,
a process step that no code change can satisfy, so `ready` stays `false`.

| Finding | Status | Where |
|---|---|---|
| 1 BLOCKER real-Zed acceptance | **open** (process) | `acceptance-checklist.md` |
| 2 SSE lag → reload | done + unit test | `next_sse_payload`, `test_next_sse_payload_yields_reload_on_lag` |
| 3 `is_excalidraw_path` doc | done | `main.rs` doc comment |
| 4 `serverInfo.version` | done + integration assertion | `env!("CARGO_PKG_VERSION")`, `lsp_initialize_advertises_save_capability` |
| 5 didClose test accuracy | done (second sequential close pinned; D9.2 softened) | `lsp_did_close_forwards_editor_closed_to_live_preview` |
| 6 Windows 500-path twin | done, compiled only on non-Windows (cross-check blocked by `aws-lc-sys`) | `#[cfg(windows)] test_post_data_write_failure_is_500_and_last_written_revision_unchanged` |
| 7 bounded watcher channel | done + overflow flag + unit test | `WATCHER_QUEUE_CAPACITY`, `WatcherContext::overflow`, `test_watcher_overflow_flag_forces_reconcile` |
| 8 read-only image reload test | done (7 vitest cases) | `readonly-image.ts` / `.test.ts` |
