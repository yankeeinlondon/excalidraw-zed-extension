---
$schema: "feature-review.yaml"
ready: false
reviewed_by: "opencode/zai-coding-plan/glm-5.3"
created: "2026-09-06T03:24:15-07:00"
spec: "2026-09-05-lsp-strategy/spec.md"
implemented: false
description: "A **fix** review of `2026-09-05-lsp-strategy/spec.md`"
fix: "2026-09-05-lsp-strategy/review-2.md"
previous: "2026-09-05-lsp-strategy/review-1.md"
review_iterations: 2
---

# Review 2 — LSP event strategy & language restructure

Second-iteration review. Review 1's findings 2–8 were claimed implemented
(commit `58ec62d`, decision-log D14); finding 1 (real-Zed acceptance) was left
open as a process gate. This review (a) independently verifies each follow-up
claim against the code, (b) re-runs the full validation sweep, and (c) reviews
the substantial **uncommitted** batch that now sits on top of the fix's surface.

## Scope note: what was reviewed

The working tree, i.e. HEAD (`58646a5`) **plus** an uncommitted batch touching
`extension/extension.toml`, both language configs, `extension/src/lib.rs` (60
lines), `preview-binary/src/main.rs` (479 lines), and
`preview-binary/tests/integration.rs` (100 lines), plus five new vendored
`.scm` query files and `features/2026-09-06-editor-not-preview/spec.md` (a
15-line stub for an unrelated nomenclature feature). The uncommitted batch
contains two coherent pieces of work, neither of which has a fix/feature
record or decision-log entry:

1. **Grammar bundling** — `Excalidraw` pins `grammar = "json"`, `SVG` pins
   `grammar = "xml"`, both declared in `extension.toml` at pinned revs with
   vendored queries; the grammar-less corpus assertions were *rewritten* to
   pin the grammars instead.
2. **LSP observability** — an `init_lsp_logging` stderr sink (info,
   unconditional in `--lsp` mode) plus a preview-lifecycle tracker thread
   (lock-presence state machine: `AlreadyOpen`/`Opened`/`Closed`/`NeverOpened`)
   and per-event logging in the dispatch loop.

## Verification performed (not just read)

| Gate | Result |
|---|---|
| `cargo nextest run` | **124 passed, 1 skipped** (display-gated smoke, by design) — 118 binary + 6 extension corpus tests; up from 118 in D14, the delta being the new tracker unit tests and the stderr lifecycle integration test |
| webview `tsc --noEmit` | clean |
| webview `vitest run` | **144 passed** (9 files) |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| `cargo build -p excalidraw-preview --release --target wasm32-wasip1` | green |

## Review-1 follow-ups: every claim independently verified

| Finding | Claim (D14) | Verified |
|---|---|---|
| 2 SSE lag → reload | `next_sse_payload` maps `RecvError::Lagged` to a `reload` frame | ✅ `main.rs:1148-1164`, used by `serve_events`; `test_next_sse_payload_yields_reload_on_lag` (17 sends into the 16-slot channel, then `Closed → None`) |
| 3 `is_excalidraw_path` doc | rewritten to the shipped model | ✅ `main.rs:3836-3848` — **but see Finding 3 below**: the uncommitted grammar batch made it stale again |
| 4 `serverInfo.version` | `env!("CARGO_PKG_VERSION")` + asserted in integration | ✅ `main.rs:3637`; asserted in `lsp_initialize_advertises_save_capability` |
| 5 didClose wire behavior | second sequential close pinned | ✅ `lsp_did_close_forwards_editor_closed_to_live_preview` now sends a second `didClose` and asserts a second `editor-closed` frame plus liveness after both; no-duplicate-frame window also asserted |
| 6 Windows 500-path twin | `set_readonly(true)` variant with writability restored before drop | ✅ `#[cfg(windows)]` twin at `main.rs:4751-4797`, same root/admin-bypass skip guard and identical assertions |
| 7 bounded watcher queue | `sync_channel(256)` + overflow flag forcing reconcile | ✅ `WATCHER_QUEUE_CAPACITY`/`WatcherContext::overflow`, checked at loop top and after each burst; `test_watcher_overflow_flag_forces_reconcile` proves a reload with **no** queued event and that a consumed flag stops firing |
| 8 read-only image reload | extracted + unit-tested | ✅ `readonly-image.ts` (63 lines, I/O injected) + 7 vitest cases |

The engineering quality of these follow-ups is good; none require rework.

## The new uncommitted batch: reviewed findings

The batch itself is *well built* — the tracker is off the stdio dispatch path,
blocks while idle, gives up after a bounded 15 s grace, and is tested both as
an injected-I/O state machine and end-to-end (`lsp_logs_preview_lifecycle_to_stderr`
asserts on real stderr, which would catch the sink being wired to stdout,
silenced, or never installed; it pins `RUST_LOG` so an inherited env var cannot
mask it). `spawn_preview` was refactored to report spawn success, warn on
failure, and share one `Command` build across the `process_group`/plain paths —
a Windows-safety improvement. The stderr-not-stdout rationale is documented
wherever it matters. But the batch has real problems as *process*:

### 1. BLOCKER (carried from review 1): the real-Zed acceptance gate is still open

`acceptance-checklist.md` is unchanged since 2026-09-05: every interactive
item — including the `.excalidraw.svg` click-to-preview **regression test that
is the entire point of this fix** — remains annotated *not performed*. Spec §7
is explicit that "a synthetic `didOpen` test cannot validate Zed suffix
matching or prove the workaround." The commit/`just bump` release mechanics
also remain deferred. Nothing in the intervening work changes this: **the fix's
central hypothesis is still unverified in real Zed, so the feature is not
production ready.**

### 2. MAJOR (process/record): the grammar bundling silently reverses a spec'd design decision, with no record

Spec §3 ships SVG as grammar-less ("none initially") and §8 lists SVG syntax
highlighting as a **deferred non-goal**; the acceptance checklist carries a
dedicated packaging risk item premised on the grammar-less design ("if this
fails, Stream A is blocked"). The uncommitted batch implements the non-goal
early — which is defensible *if* the registry-packager risk materialized in
real Zed — but:

- there is no fix/feature record, no decision-log entry, and no checklist
  update explaining **why** the deferral was reversed or whether the
  grammar-less packaging risk was ever actually hit;
- the corpus test that pinned grammar-less SVG was **rewritten in place**
  (`svg_language_is_registered_grammarless` →
  `svg_language_is_registered_with_the_xml_grammar`), so the git history no
  longer shows a decision being changed — it shows the old assertion simply
  ceasing to exist;
- the interactive acceptance items now describe an artifact that no longer
  exists (see Finding 4).

This repo's own convention (AGENT.md: every change gets a dated
spec → plan → decision-log → reviews record, and "decisions you must not
silently reverse" are recorded precisely so they don't drift) exists to
prevent exactly this. Required before closure: record the grammar decision
(new feature dir or a D15 entry in this fix's decision-log) stating the
motivation and whether real-Zed packaging evidence exists, and update the
acceptance checklist to gate the grammar-ful artifact.

### 3. MINOR: doc drift reintroduced one commit after it was fixed

`is_excalidraw_path`'s doc comment (rewritten by `58ec62d` to close review-1
finding 3) says the server attaches to "a grammar-less `SVG` language"
(`main.rs:3840`), while the working tree's `extension/languages/svg/config.toml`
now sets `grammar = "xml"`. Same drift class, same file, reintroduced by the
uncommitted batch. One-word fix plus the §3/spec table annotation.

### 4. MINOR: the acceptance checklist's packaging item is stale/moot

"The grammar-less `SVG` language loads and packages without a 'grammar not
found' rejection" no longer describes anything shippable. Before the
interactive run it must be rewritten to gate what will actually be installed:
json + xml grammars compile/load at their pinned revs, the vendored
highlights/indents/brackets queries are accepted, and (per the AGENT.md note)
pointing at another extension's grammar remains forbidden. Otherwise the human
will tick a box that verifies nothing.

### 5. NIT: the grammar corpus test does not pin the `path = "xml"` subkey

`every_language_grammar_is_bundled_and_has_queries` asserts `repository` and
`rev` but not the monorepo subpath `path = "xml"` that tree-sitter-xml
requires; a typo there passes every automated gate and fails only at
GUI-gated packaging. One extra assertion (or an explicit decision to leave it
to the packaging gate) closes it.

### 6. NIT: the tracker can mislabel a sub-500 ms window lifecycle as `NeverOpened`

A preview whose lock appears and disappears between two 500 ms polls is
indistinguishable from one that never started; after the 15 s grace it logs
`NeverOpened`. Log-line-only impact, pathological timing, and consistent with
the batch's documented lock-presence trade-offs — recording it so the log
reading in the acceptance run isn't misinterpreted. No code change requested.

## Things explicitly checked and found *fine*

- Tracker correctness: `BTreeMap` keyed by canonical path (differently-spelled
  URIs coalesce; unresolvable paths are skipped at debug); `retain`-based
  state machine reports each terminal transition exactly once and drops the
  entry so a later `didSave` re-registers cleanly; thread blocks on `recv()`
  while idle and exits on sender drop without draining (mirrors the forwarder
  contract).
- `init_lsp_logging`: filter target `excalidraw_preview` matches
  `module_path!` (hyphens normalize to underscores), `with_writer(stderr)`
  keeps the JSON-RPC stdout clean, ANSI off, `RUST_LOG`/`--debug` escalation
  and the fallback on a malformed `RUST_LOG` are all sound.
- The tracker unit tests never touch the filesystem for their `/tmp/...`
  fixtures — `get_lock_path` only hashes the path string, so they are
  OS-portable as written; the integration lifecycle test uses tempdir +
  `/shutdown` and is equally portable.
- didSave-while-live now also *tracks* the preview (first contact for a
  CLI-started or replayed window) — a sensible touch that costs one map entry.
- Embedded-assets freshness is unaffected by the batch (no `webview-src/`
  changes); the `just test` sweep includes the extension corpus tests.
- All watcher/SSE/route/vitest coverage verified present in review 1 was
  re-confirmed by name in this tree and passes.

## Verdict

**Not production ready** — `ready: false`.

Findings 2–8 from review 1 are genuinely and verifiably implemented, and the
new observability/grammar work is individually well-crafted with fresh green
gates. But the two blockers are unchanged in kind: (1) the real-Zed
acceptance run that *this spec defines as its own release gate* has still
never been performed or recorded, and (2) the repo now carries a large,
record-less, uncommitted batch that rewrites a spec'd decision — leaving the
review record and the acceptance checklist describing an artifact that is not
the one in the tree.

Recommended path to `ready: true`:

1. Record the grammar decision and the LSP-logging/tracker work (feature dir
   or decision-log entries), and commit.
2. Fix the Finding 3 doc drift and rewrite the checklist packaging item
   (Findings 4, optionally 5).
3. Perform and record the interactive real-Zed acceptance items against the
   grammar-ful build.
4. Commit on clean `main`, `just bump`, publish separately (unchanged from
   review 1).

---

## Addendum — 2026-09-06 (author response, not a re-review)

Appended after the review, in response to it and to a user report that
`.excalidraw.png` still did not open from Zed. The reviewer's findings are left
verbatim above; `ready:` is unchanged (**`false`** — finding 1 still gates it).
The reviewer has not re-verified any of the claims below.

### What the PNG investigation changed

The user's report prompted checking Zed's source rather than re-asserting spec
finding 6. Four independent gates were read out of `zed-industries/zed` `main`
(fetched 2026-09-06; the installed build is 1.18.1, so line numbers are locators,
not pins), and all are closed:

1. `is_image_file` matches on `Path::extension()` alone — never language
   registration, never `file_types`.
2. `ProjectItemRegistry::open_path` resolves **last-registered-first**
   (`.iter().rev()`) and `image_viewer::init` runs after editor setup, so the
   image item wins and **no buffer is created**.
3. `register_project_item` is a `workspace`-crate Rust API, absent from
   `zed_extension_api` — a WASM extension cannot enter that registry.
4. `ZED_FILE` is populated only from `active_item.act_as::<Editor>(cx)`, so the
   task/keybinding fallback cannot learn the file name either.

Gate 2 is the substantive correction to the record: there is no `didOpen` that we
filter out, there is no `didOpen`. Recorded as spec **finding 8** and decision-log
**D16**, and propagated to §3, §8, `AGENT.md`, `README.md`, and
`docs/handling-excalidraw-files.md`. This does not affect any finding in this
review; it retires a line of future work the spec had left open.

### Disposition of this review's findings

| # | Severity | State |
|---|---|---|
| 1 | BLOCKER | **Open, unchanged.** The interactive real-Zed run has still not been performed. Two checklist items moved, neither in a way that weakens the gate: the packaging item was rewritten (see 4) and a highlighting-is-applied item was added; the PNG item was marked not-applicable with its reasoning, since a GUI run cannot change a Zed-side outcome. |
| 2 | MAJOR | **Addressed, pending commit.** `decision-log.md` **D15** records the grammar decision: what prompted it (a direct user request, twice), that the grammar-less packaging risk was *never hit* so the deferral was reversed on product grounds, why bundling satisfies rather than circumvents §8's stated constraint, the highlighting-only blast radius, the one-line rollback, and the verification performed. Spec §3/§8 now show the reversal in place rather than silently. The reviewer's point about the corpus assertion being rewritten in place stands — the history shows the old assertion ceasing to exist, and D15 is the compensating record. |
| 3 | MINOR | **Fixed.** `is_excalidraw_path`'s doc comment no longer says "grammar-less `SVG` language"; it notes both bundled grammars, states that highlighting has no bearing on the guard or on routing, and its `.png` paragraph was rewritten to the finding-8 reasoning. |
| 4 | MINOR | **Fixed.** The checklist packaging item was rewritten to gate the artifact that will actually be installed — both grammars at their pinned revs, tree-sitter-xml's `path = "xml"` subpath called out, the vendored query files, and the still-forbidden cross-extension grammar reference — with the original wording preserved inline so the change is visible, plus the rollback and the first-install network requirement. |
| 5 | NIT | **Fixed.** `every_language_grammar_is_bundled_and_has_queries` now asserts the subpath exactly: `Some("xml")` for `xml`, and `None` for any other grammar (tree-sitter-json is at its repo root and must not set `path`). A typo or omission now fails in CI instead of at GUI-gated packaging. |
| 6 | NIT | **Acknowledged, no change**, as the reviewer requested. |

### Gates re-run after these edits

`cargo test -p excalidraw-preview` (extension corpus) **6 passed**, including the
tightened subpath assertion; `cargo fmt --check` clean. The doc-comment and
record changes are non-functional. The full sweep (`just test`, clippy, WASM
build) last ran green earlier the same day and is unaffected by anything in this
addendum; it should be re-run as part of the commit in step 1 of the recommended
path, which is otherwise unchanged.
