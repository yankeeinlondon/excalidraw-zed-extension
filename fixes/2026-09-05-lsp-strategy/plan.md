---
total_phases: 9
created: 2026-09-05
phase: 9
agent: "claude/opus"
yolo: "true"
source_files_during_phase_1:
  - preview-binary/src/main.rs
  - preview-binary/tests/integration.rs
docs_updated_during_phase_1: []
docs_created_during_phase_1:
  - fixes/2026-09-05-lsp-strategy/decision-log.md
  - fixes/2026-09-05-lsp-strategy/acceptance-checklist.md
  - fixes/2026-09-05-lsp-strategy/zed-compound-suffix-repro.md
skills_files_updated_during_phase_1: []
packages:
  - preview-binary
source_files_during_phase_2:
  - extension/extension.toml
  - extension/languages/excalidraw/config.toml
  - extension/languages/svg/config.toml
  - extension/src/lib.rs
  - extension/Cargo.toml
  - Cargo.lock
docs_updated_during_phase_2:
  - fixes/2026-09-05-lsp-strategy/decision-log.md
docs_created_during_phase_2: []
skills_files_updated_during_phase_2: []
source_files_during_phase_3:
  - preview-binary/src/main.rs
  - preview-binary/tests/integration.rs
docs_updated_during_phase_3:
  - fixes/2026-09-05-lsp-strategy/decision-log.md
docs_created_during_phase_3: []
skills_files_updated_during_phase_3: []
source_files_during_phase_4:
  - preview-binary/src/main.rs
  - preview-binary/tests/integration.rs
docs_updated_during_phase_4:
  - fixes/2026-09-05-lsp-strategy/decision-log.md
docs_created_during_phase_4: []
skills_files_updated_during_phase_4: []
source_files_during_phase_5:
  - preview-binary/src/main.rs
  - preview-binary/tests/integration.rs
docs_updated_during_phase_5:
  - fixes/2026-09-05-lsp-strategy/decision-log.md
docs_created_during_phase_5: []
skills_files_updated_during_phase_5: []
# Phase 6 was not present in the working tree when Phase 7 was dispatched and
# is a strict prerequisite (P6 → P7), so it was implemented in the same pass.
source_files_during_phase_6:
  - preview-binary/webview-src/src/dirty-state.ts
  - preview-binary/webview-src/src/dirty-state.test.ts
  - preview-binary/webview-src/src/sse-events.ts
  - preview-binary/webview-src/src/sse-events.test.ts
  - preview-binary/webview-src/src/sync-controller.ts
  - preview-binary/webview-src/src/sync-controller.test.ts
  - preview-binary/webview-src/src/mock-server-core.ts
  - preview-binary/webview-src/src/mock-server-core.test.ts
  - preview-binary/webview-src/src/App.tsx
  - preview-binary/webview-src/src/main.tsx
  - preview-binary/webview-src/vite.config.ts
docs_updated_during_phase_6:
  - fixes/2026-09-05-lsp-strategy/decision-log.md
docs_created_during_phase_6: []
skills_files_updated_during_phase_6: []
source_files_during_phase_7:
  - preview-binary/webview-src/src/sync-controller.ts
  - preview-binary/webview-src/src/sync-controller.test.ts
  - preview-binary/webview-src/src/conflict-ui.tsx
  - preview-binary/webview-src/src/conflict-ui.test.tsx
  - preview-binary/webview-src/src/App.tsx
  - preview-binary/webview-src/src/main.tsx
  - preview-binary/webview-src/src/dirty-state.ts
docs_updated_during_phase_7:
  - fixes/2026-09-05-lsp-strategy/decision-log.md
docs_created_during_phase_7: []
skills_files_updated_during_phase_7: []
source_files_during_phase_8: []
docs_updated_during_phase_8:
  - AGENT.md
  - README.md
  - docs/PRD.md
  - fixes/2026-09-05-lsp-strategy/decision-log.md
docs_created_during_phase_8: []
skills_files_updated_during_phase_8: []
source_files_during_phase_9:
  - preview-binary/src/main.rs
  - justfile
docs_updated_during_phase_9:
  - AGENT.md
  - fixes/2026-09-05-lsp-strategy/acceptance-checklist.md
docs_created_during_phase_9: []
skills_files_updated_during_phase_9: []
packages:
  - preview-binary
source_code:
  - preview-binary/src/main.rs
  - preview-binary/tests/integration.rs
  - extension/extension.toml
  - extension/languages/excalidraw/config.toml
  - extension/languages/svg/config.toml
  - extension/src/lib.rs
  - extension/Cargo.toml
  - Cargo.lock
  - preview-binary/webview-src/src/dirty-state.ts
  - preview-binary/webview-src/src/dirty-state.test.ts
  - preview-binary/webview-src/src/sse-events.ts
  - preview-binary/webview-src/src/sse-events.test.ts
  - preview-binary/webview-src/src/sync-controller.ts
  - preview-binary/webview-src/src/sync-controller.test.ts
  - preview-binary/webview-src/src/mock-server-core.ts
  - preview-binary/webview-src/src/mock-server-core.test.ts
  - preview-binary/webview-src/src/conflict-ui.tsx
  - preview-binary/webview-src/src/conflict-ui.test.tsx
  - preview-binary/webview-src/src/App.tsx
  - preview-binary/webview-src/src/main.tsx
  - preview-binary/webview-src/vite.config.ts
  - justfile
documentation:
  - AGENT.md
  - README.md
  - docs/PRD.md
  - fixes/2026-09-05-lsp-strategy/decision-log.md
  - fixes/2026-09-05-lsp-strategy/acceptance-checklist.md
  - fixes/2026-09-05-lsp-strategy/zed-compound-suffix-repro.md
  - fixes/2026-09-05-lsp-strategy/plan.md
---

# Execution Plan: LSP event strategy & language restructure

Source spec: [`spec.md`](./spec.md) (reviewed 2026-09-05 by codex/default)

## Overview

Two independent workstreams, one shared release gate:

| Stream | Goal | Files |
|---|---|---|
| **A — Registration** | Restore click-to-preview for `.excalidraw.svg` by claiming only single-segment `path_suffixes` and filtering inside the LSP. | `extension/extension.toml`, `extension/languages/**` |
| **B — Conflict model** | Make disk the persisted interchange: content revisions, conditional writes, watcher reconciliation, `didClose` attention signal, conflict UX. | `preview-binary/src/main.rs`, `preview-binary/webview-src/**` |

Stream A is small and unblocks the only test that can actually prove the fix (real Zed).
Stream B is the bulk of the work. They share Phase 9.

### Dependency graph

```
P1 (preflight/decisions)
 ├─► P2 (extension registration) ─────────────────────────┐
 └─► P3 (rust revision contract)                          │
      ├─► P4 (rust watcher reconciliation)                │
      ├─► P5 (rust didClose → /editor-closed)  ‖ P4       │
      └─► P6 (webview data layer + vite mock)             │
           └─► P7 (webview conflict UX + close flow)      │
                └─► P8 (docs)  ‖ P2                       │
                     └─► P9 (build + full validation + real-Zed acceptance) ◄┘
```

`‖` = safe to run in parallel.

### Parallelization notes

- **P2 is fully parallel with P3–P7** — no shared files. Assign it first so the real-Zed
  acceptance environment can be prepared early.
- **P4 ‖ P5** are parallelizable in principle but both edit `preview-binary/src/main.rs`
  (4032 lines, monolith). If run concurrently, use separate worktrees and merge P5 last —
  P5 only touches the LSP loop (`run_lsp_server`, ~line 2691+) and adds one route +
  one `PreviewEvent` variant; P4 touches `main()`'s watcher thread (~line 390) and
  `serve_data`. Otherwise run them sequentially; the serial cost is low.
- **P8 (docs) is parallel with everything after P5**, as long as the API decisions from
  P3/P5 are frozen.
- Within P6/P7 the vitest suites can be written in parallel with the implementation by a
  second agent, since `dirty-state.ts` exports are pure functions with a defined contract.

### Validation checkpoints

Every phase ends with a **✅ Checkpoint** block. Do not start the next phase until it
passes. `just test` = `cargo nextest run` + `npm run typecheck` + `vitest run`.

---

## Phase 1 — Preflight, decisions, environment hygiene

Goal: a clean, trustworthy baseline and a frozen answer to the spec's open question.

- [x] **Resolve §10 open question and record it.** Append a "Decisions" section to
      `spec.md` (or a new `decision-log.md` in this directory) selecting
      **Option 1 — revision checks with the documented narrow race** (the spec's own
      recommendation). Rationale to record: arbitrary external writers (Zed, git, CLI)
      cannot be made to cooperate with a lock protocol, and Options 2/3 add
      retention/recovery-UI scope not requested here. State explicitly that
      "preserve every competing write" is **not** an acceptance requirement, so no
      reviewer later reads the narrow race as a defect.
- [x] Capture the baseline: run `just test` on a clean tree and record pass/fail counts
      in the decision log. Any pre-existing failure must be noted now, not discovered
      in Phase 9.
- [x] Confirm `git status` is clean apart from `.claudine/memory/commits.md`; stash or
      commit unrelated work before touching source.
- [x] Create `fixes/2026-09-05-lsp-strategy/acceptance-checklist.md` with the §7
      real-Zed checklist items as unchecked boxes plus a header for build identity
      (Zed version + commit, extension version, OS). Phase 9 fills it in.
- [x] **Preserve the investigation evidence before deleting it (§9).** Copy a sanitized
      minimal trace (the `didOpen` 7/7 vs 0/7 capture, paths scrubbed) into
      `fixes/2026-09-05-lsp-strategy/zed-compound-suffix-repro.md`, plus the minimal
      upstream repro recipe (language with compound suffix + dummy LSP + traffic dump).
- [x] Inspect `~/.local/bin/excalidraw-preview` with `readlink -f`. **Only if** it points
      at `target/release/ep-lsp-logger.sh` (the debug wrapper), restore it with
      `just symlink` and delete the wrapper script. Do not touch it if it already points
      at the release binary.
- [x] List `/tmp/ep-lsp-*` logs and `$TMPDIR/excalidraw-*.lock`. For each lock, read the
      port and probe `GET /ping` — remove **only** locks that are stale (no response) and
      whose recorded path is under `/tmp/test-lsp…` or the feat-unifi worktree. Never
      glob-delete; a live preview's lock must survive. Stop only identified test
      processes, then remove their locks.

**✅ Checkpoint 1:** decision recorded; baseline test result recorded; `readlink -f
~/.local/bin/excalidraw-preview` resolves to the real release binary; no stale test locks;
repro evidence committed.

---

## Phase 2 — Extension language registration (§3) · parallel with P3–P7

Goal: single-segment suffixes only, both languages mapped to the server.

- [x] `extension/languages/excalidraw/config.toml` — set `path_suffixes = ["excalidraw"]`
      (drop `"excalidraw.svg"` and `"excalidraw.png"`). Rewrite the comment to explain
      *why*: Zed 1.18 attaches a compound-suffix language but never routes `didOpen`
      for it (spec finding 3/4), so compound suffixes are handled by the `SVG` language
      plus the in-LSP `is_excalidraw_path` filter instead.
- [x] Create `extension/languages/svg/config.toml`:
      `name = "SVG"`, `path_suffixes = ["svg"]`,
      `language_servers = ["excalidraw-preview"]`, **no grammar key**. Comment it with
      the §3 trade-off: every `.svg` buffer attaches the server, and the LSP guard makes
      that an idle no-op for non-Excalidraw SVGs.
- [x] `extension/extension.toml` — under `[language_servers.excalidraw-preview]`, replace
      `language = "Excalidraw"` + `languages = []` with
      `languages = ["Excalidraw", "SVG"]`. Do not rely on the language configs' own
      `language_servers` key as the sole association.
- [x] Do **not** add a PNG language (finding 6: Zed's image pane claims `*.png` before a
      buffer exists, so no language could ever attach).
- [x] Do **not** attach to the built-in JSON language (would spawn the server for every
      JSON file the user opens).
- [x] Update `extension/src/lib.rs` doc comments only if they name the old suffix list;
      no behavioral change belongs here. (No doc comment named the suffix list; only
      manifest-corpus tests were added to the `tests` module.)
- [x] Build the extension: `just build-ext` (target `wasm32-wasip1`) and confirm it
      compiles with the new manifest.

**✅ Checkpoint 2:** `just build-ext` succeeds; `grep -r path_suffixes extension/` shows
exactly `["excalidraw"]` and `["svg"]`; `extension.toml` lists both languages. (Real Zed
verification is deliberately deferred to Phase 9 — a synthetic test cannot validate Zed's
suffix matching.)

---

## Phase 3 — Rust: content revision & conditional-save contract (§5)

Goal: `GET /data` publishes a revision; `POST /data` refuses to overwrite an unseen one.
All work in `preview-binary/src/main.rs`. `sha2 = "0.11"` is already a dependency.

- [x] Add a revision helper: `fn content_revision(bytes: &[u8]) -> String` returning a
      strong ETag value, e.g. `"\"sha256-<hex>\""`. Keep it opaque to the client — the
      frontend must never parse it. Unit-test determinism and that different bytes differ.
- [x] Extend `AppState` with:
      - `save_mutex: Arc<tokio::sync::Mutex<()>>` — per-file (per-process) write serialization.
      - `last_written_revision: Arc<RwLock<Option<String>>>` — the revision of the most
        recent successful viewer write, set **before** the save mutex is released so the
        watcher thread can never mislabel our own write as external.
      Update `make_state` in the `tests` module and every construction site.
- [x] `serve_data`: keep the raw body and existing `Content-Type`; add
      `ETag: <revision>` and `Cache-Control: no-store`. Map `ErrorKind::NotFound` to
      **404** (today every error is 500) so the client can distinguish "file unavailable"
      from "read failed" — deletion is not an empty drawing.
- [x] `receive_data`: accept `If-Match`. Behavior:
      1. Missing `If-Match` → **428 Precondition Required**, no write.
      2. Acquire `save_mutex`.
      3. Re-read the file from disk *inside* the lock and compute its current revision.
         Treat a missing file as a distinct "absent" revision so a first write to a
         deleted file is still a decision the client had to make.
      4. `If-Match` value ≠ current revision → **412 Precondition Failed**, no write,
         with the current `ETag` on the response so the client knows what it is racing.
      5. Match → write, compute the written revision, store it in `last_written_revision`,
         then release the lock. Respond **200** with `ETag: <written revision>`.
      6. Any I/O error → 500, and **neither** baseline advances.
      Accept multiple comma-separated `If-Match` values (the "Keep my changes" case sends
      the acknowledged overwrite revision), but never accept `*`.
      (Implementation notes: the absent state is the constant `ABSENT_REVISION`
      `"\"absent\""` — ETag-shaped so it round-trips through `If-Match` and can never
      collide with a `sha256-…` value; the 404 from `GET /data` publishes it so a client
      can deliberately acknowledge deletion. `if_match_allows` implements the
      comma-separated list with wildcard rejection and RFC 9110 weak-ETag non-matching.)
- [x] Leave `POST /export`, `POST /library`, `POST /copy-clipboard` contracts untouched.
- [x] Doc-comment the route contract on `receive_data` per the repo's Rust doc conventions
      (`## Returns`, `## Errors`).
- [x] **Tests** (`#[cfg(test)] mod tests` in `main.rs`, axum `oneshot`):
      - `GET /data` returns an ETag before any save has occurred, including for an empty file.
      - Round trip: `GET` ETag → `POST` with that `If-Match` → 200 + a *new* ETag.
      - `POST` with no `If-Match` → 428 and disk bytes unchanged.
      - `POST` with a stale `If-Match` → 412, disk bytes unchanged, response carries the
        current ETag.
      - Write failure (e.g. read-only path) → 500 and `last_written_revision` unchanged.
      - External edit landing *between* a `GET` and a `POST` → 412.
      - Repeat the happy path for all three formats (`application/json`, `image/svg+xml`,
        `image/png`) via `make_state`.
      (Additional coverage beyond the plan list: wildcard `*` rejected; multi-valued
      `If-Match` accepted — the "Keep my changes" case; absent-file recreation vs stale
      byte revision; `Cache-Control: no-store`; read/write/read round trip re-read in the
      same test; `content_revision`/`if_match_allows` unit tests. The end-to-end gate is
      `post_data_writes_scene_to_disk` in `preview-binary/tests/integration.rs`, which now
      drives GET ETag → 428 without If-Match → 200 conditional write → 412 replay against
      the real spawned binary.)

**✅ Checkpoint 3:** `cargo nextest run` green; new route tests present and passing;
`cargo clippy -- -D warnings` clean.

---

## Phase 4 — Rust: watcher reconciliation (§5) · may run parallel with P5

Goal: no dropped final event, no time-based echo suppression, correct delete/recreate.

- [x] Replace `fs_watcher.watch(canonical_path, …)` with a watch on the **parent
      directory** (`RecursiveMode::NonRecursive`) and filter events to the canonical
      target path. This is what makes atomic replacement (temp file + rename) and
      delete/recreate observable at all.
- [x] Handle `Modify`, `Create`, `Remove` and `Rename` (both `From`/`To` where notify
      reports them). Deletion broadcasts `Reload` like any other change; the client then
      sees 404 from `GET /data` and shows an unavailable state. Never auto-recreate.
      (notify reports renames as `Modify(ModifyKind::Name(From|To|Both))` or as
      `Create`/`Remove` pairs depending on backend, so the three broad kinds cover
      every shape — see decision-log D8.)
- [x] Replace the leading-edge 80 ms throttle with **trailing reconciliation plus a
      bounded max wait**: restart a ~80 ms quiet timer on each event, but force a
      reconcile if ~500 ms have elapsed since the burst began. The final event of a
      write burst must never be the one that gets dropped.
- [x] On reconcile, read the file and compute its revision:
      - Read error / partial write → retry with bounded backoff (e.g. 3 attempts,
        25/50/100 ms). On exhaustion, do nothing and keep the last good state — never
        broadcast a state that would blank the scene.
      - Revision equals `last_written_revision` → **proven viewer echo**, skip the
        broadcast. This replaces the 2-second time-based suppression entirely; no elapsed
        time is ever consulted.
      - Otherwise broadcast `PreviewEvent::Reload`.
      (`reconcile_disk_state`; deletion is definitive — broadcasts immediately, only
      non-NotFound read errors retry.)
- [x] Keep the watcher thread free of blocking HTTP and panics; log decisions at `debug`.
- [x] **Tests** (`preview-binary/tests/integration.rs`, headless preview):
      - Temp-file rename over the target → SSE `reload` fires.
      - Rapid successive writes ending in a *different* final version → the client-visible
        revision converges on the final bytes (poll `GET /data` ETag with a bounded
        deadline; do **not** use fixed sleeps as the assertion).
      - Delete then recreate → `GET /data` yields 404 then 200 with a new ETag; a reload
        event is delivered for each transition.
      - A viewer write via `POST /data` does **not** produce a `reload` SSE event (echo
        suppression), while an external write to the same file does.
      (All four were written first and verified failing against the old leading-edge
      throttle — rapid-writes, delete/recreate, and echo-suppression failed; rename-over
      passes on macOS FSEvents (path-based) and guards Linux inode-based watches. Unit
      coverage adds event-kind/path filtering variants (sibling, symlink, deleted path),
      reconcile decisions, burst coalescing, and the forced max-wait bound.)

**✅ Checkpoint 4:** `cargo nextest run` green including the four watcher scenarios; no
test relies on a bare `sleep` for its assertion; clippy clean.

---

## Phase 5 — Rust: `didClose` attention signal & `/editor-closed` (§4, §5) · may run parallel with P4

Goal: `didClose` becomes a best-effort nudge to a live preview. It must never spawn,
focus, shut down, or discard anything.

- [x] Add `PreviewEvent::EditorClosed` with `as_sse_data() == "editor-closed"`. Keep
      `Reload` and `Library` unchanged.
- [x] Add `POST /editor-closed` to the router: returns **204 No Content** and broadcasts
      `PreviewEvent::EditorClosed`. No body required; ignore any body sent.
- [x] In `run_lsp_server`, build a **bounded, coalescing forwarding worker** before the
      dispatch loop:
      - A `std::sync::mpsc` channel to one dedicated thread, so no HTTP ever happens
        inside the stdio read/dispatch path.
      - The worker dedupes by canonical path and caps its queue (e.g. 16 entries, drop
        oldest) — coalescing repeated closes of the same file.
      - A `reqwest::blocking::Client` with a **≤500 ms** timeout per request.
      - Resolve the target the same way `preview_is_live` does: canonicalize → `get_lock_path`
        → read port → `POST http://127.0.0.1:{port}/editor-closed`. A missing/stale lock,
        an unreadable port, or a refused connection is a silent no-op.
- [x] Change the `textDocument/didClose` arm from a pure no-op to: parse the URI via
      `file_uri_to_path`, guard with `is_excalidraw_path`, and enqueue the path. Invalid
      or non-`file:` URIs are no-ops. Keep the existing comment explaining why this is
      *not* teardown and *not* a veto, and extend it with the new attention-signal role.
- [x] Leave `didOpen`, `didSave`, `didChange` (unhandled → no spawn), `initialize`
      capabilities (`openClose`/`change:1`/`save:true`), `shutdown` and `exit` exactly as
      they are. LSP `shutdown`/`exit` must **not** drain the forwarding queue — the loop
      exits promptly and the worker is dropped.
- [x] **Tests** (`preview-binary/tests/integration.rs`, all with
      `EXCALIDRAW_PREVIEW_HEADLESS=true`):
      - Feed `didOpen` for each of the three guarded suffixes → exactly one preview
        instance per file (assert the lock file and `/ping`).
      - `didSave` while a preview is live → no second instance.
      - Close the preview (`GET /shutdown`), then `didSave` → the preview reopens.
      - `didChange` → no spawn.
      - **Subscribe to `/events` before sending `didClose`**, then assert an
        `editor-closed` frame arrives and the preview is still alive afterwards.
      - Plain `.svg` and malformed / non-`file:` URIs → no spawn, no forward, no crash.
      - A stale lock file pointing at a dead port → `didClose` is a harmless no-op.
      - A deliberately slow endpoint (bind a listener that never responds and write its
        port into a lock file) → the LSP still answers `shutdown` promptly, proving the
        forwarding is off the dispatch path.

**✅ Checkpoint 5:** `cargo nextest run` green; the LSP harness covers all eight cases
above; clippy clean. If P4 and P5 ran in parallel, merge and re-run `just test` here.

---

## Phase 6 — Webview: revision-aware data layer, save queue, SSE dispatch (§5)

Goal: the frontend speaks the new protocol correctly *before* any UI exists for conflicts.
Files: `main.tsx`, `App.tsx`, `dirty-state.ts`, `vite.config.ts`.

- [x] **Revision state.** Introduce two refs (or a small module in `dirty-state.ts` so
      they are unit-testable):
      - `acceptedRevision` — seeded from the initial `GET /data` ETag (including for an
        empty file). Advances **only** after a successful reload application or a
        successful viewer write.
      - `expectedOverwriteRevision` — set only by "Keep my changes" (Phase 7), cleared
        after the write it authorizes.
      Keep `prevHashRef` (scene fingerprint) strictly separate — it is not a disk revision.
- [x] **Conditional writes.** Every canonical `POST /data` — bootstrap, auto-save,
      keyboard save, native menu save, save-and-close — sends
      `If-Match: <expectedOverwriteRevision ?? acceptedRevision>`. On 200, set
      `acceptedRevision` from the response `ETag` and clear
      `expectedOverwriteRevision`. On **412**, do not clear dirty, do not advance any
      baseline, and raise the pending-conflict state (Phase 7 renders it). On **428**,
      treat as a programming error: log loudly and surface a save failure.
- [x] **Serialize saves through one queue.** Today `doSave` can overlap because the
      SVG/PNG export step is `await`ed before the POST. Add a single promise chain so
      export+POST run strictly in order and an older serialized scene can never land after
      a newer one. Preserve the existing `decideSaveOutcome` semantics (edits during a save
      stay dirty; superseded responses don't touch dirty state). A queued follow-up save
      must use the revision **acknowledged by the preceding write**, not one captured
      before export began.
- [x] **Delete the time-based echo suppression.** Remove `ignoreSseUntil` and the
      `onSaved(Date.now() + 2000)` contract from `App.tsx`/`main.tsx` — the server now
      suppresses proven echoes by revision (Phase 4). Adjust the `onSaved` prop signature
      (or drop it) and every call site.
- [x] **Explicit SSE dispatch.** Replace the `if (data === "library") … else reload`
      fall-through with an explicit switch over `"reload"` / `"library"` /
      `"editor-closed"`, ignoring unknown event names. Apply the same explicit dispatch in
      `renderReadonlyImage`'s handler: it handles `reload` only, ignores everything else,
      and never shows a conflict dialog.
- [x] **Reconcile, don't just react.** Extract a `reconcileFromDisk()` that fetches
      `GET /data` and reads bytes **and** ETag together, and call it on: initial SSE
      subscription (`onopen`), reconnect (`onerror` → reopen), and every `reload` event.
      Coalesce concurrent requests and discard superseded async results (sequence number
      per request). A 404 means the file is unavailable — show a retryable error state and
      keep the current scene, dirty flag and `acceptedRevision` intact.
- [x] **Apply path.** When the revision differs from `acceptedRevision`:
      - Clean and idle → parse, then apply via `applyExternalReload` (preserving
        viewport/theme and existing persisted-app-state rules), and advance
        `acceptedRevision` **only after** application succeeds. Never mark it as a viewer save.
      - Dirty / saving / mid-text-edit → retain the newest pending revision and defer.
        **Re-check live dirty and editing state after the fetch+parse completes,**
        immediately before applying — never on the state observed before the await.
        A deferred reload is retried when editing ends, never discarded.
      - Invalid data or parse failure → keep the scene, dirty state and
        `acceptedRevision`; show a retryable error. Never clear edits and never switch a
        dirty editor into read-only image mode because parsing failed.
- [x] **Vite mock parity** (`vite.config.ts`): per-`?file=` revision tracking, `ETag` +
      `Cache-Control: no-store` on `GET /data`, `If-Match` enforcement with 428/412/200+ETag
      on `POST /data`, a `POST /editor-closed` returning 204 and broadcasting
      `editor-closed` to that file's SSE client set, and 404 for a missing file. Revisions
      must be isolated per file path — two dev tabs must not share one.
- [x] **Tests** (`dirty-state.test.ts` + new suites; `vitest run`):
      - Dirty guard re-evaluated **after** the asynchronous parse (the classic bug: state
        sampled pre-await).
      - Mid-edit reload is deferred and later applied, not dropped.
      - Save queue ordering: two saves queued back-to-back apply in order; the second uses
        the revision acknowledged by the first.
      - Edit during save leaves the scene dirty.
      - A 412 from auto-save does not clear dirty and does not advance `acceptedRevision`.
      - Explicit event dispatch: unknown SSE names are ignored; `library` events never
        touch the scene.
      - Read-only image preview reloads on `reload` and ignores `editor-closed`.
      - Vite mock: per-file revision isolation (asserted against the mock's handlers).

**✅ Checkpoint 6:** `npm run typecheck` clean (strict, no `any`); `vitest run` green;
`just dev` against a real file loads, saves, and live-reloads on an external edit —
and an external `echo >> file` produces exactly one reload while a viewer save produces none.

---

## Phase 7 — Webview: conflict UX & native close integration (§5)

Goal: the user is never silently overwritten, and never loses viewer work.

- [x] **Pending-conflict state.** One state object holding the pending disk revision and
      the reason it surfaced (watcher reconcile, save-time 412, or `editor-closed`
      escalation). A save-time 412 enters this state even if the watcher never fired.
- [x] **Banner.** When a conflict is pending, show a non-modal banner:
      *"File changed on disk — Reload from disk / Keep my changes"*. It persists until
      resolved.
- [x] **Pause all automatic writes while pending.** Cancel queued auto-save timers and
      pause every automatic flush path: debounce, max-wait, pointer-up, blur, and the
      close-triggered flush. Nothing writes to disk until the user resolves.
- [x] **Reload from disk.** Fetch the latest revision, parse it **successfully first**,
      then drop viewer edits through the guarded reload path. While applying the discard,
      block edit/save actions briefly and invalidate stale in-flight fetch/save
      completions. If a newer revision arrives mid-flight, reconcile again rather than
      applying the stale one. A failed reload leaves the conflict pending.
- [x] **Keep my changes.** Record **only the displayed pending revision** as
      `expectedOverwriteRevision` for the next write. Do **not** change
      `acceptedRevision`, do **not** save on dismissal, keep the scene dirty, and show
      *"Next save replaces the disk version"*. Under auto-save, stay paused until an
      explicit Save succeeds, then resume normal auto-save. A *second* external revision
      arriving afterwards must produce a fresh conflict — the conditional write has to
      fail rather than overwrite it.
- [x] **Escape / Cancel** closes the modal but leaves the banner and the save pause intact.
- [x] **`editor-closed` escalation.** On the SSE event: reconcile disk **first**, then
      check for a conflict — this covers close-before-watcher ordering. Show at most **one**
      modal per unresolved revision; duplicate closes must not stack prompts. No automatic
      window focus stealing. If the native close-confirmation flow is active, defer
      escalation until it ends. When there is nothing to reconcile, do nothing at all.
- [x] **Accessibility.** The modal uses `role="dialog"` + `aria-modal="true"`, a labelled
      heading, initial focus on the safe action ("Keep my changes"), a focus trap, and
      Escape-to-dismiss. Style it to match the existing banner conventions in `main.tsx`.
- [x] **Save-and-close.** Route it through the same conditional save. On 412, report
      failure via `POST /native-action-result` (`ok: false`) so the window stays open, and
      surface the conflict. Never acknowledge save success merely because a dialog was
      shown. The existing explicit **"Don't Save"** still closes and discards viewer edits —
      unchanged.
- [x] Treat `POST /dirty` reports as advisory only: never depend on their arrival order to
      protect scene edits or gate disk writes.
- [x] **Tests** (vitest):
      - Both resolution outcomes (reload / keep) from a dirty scene.
      - A second external revision after "Keep my changes" → the write 412s and a new
        conflict is raised, rather than overwriting.
      - Auto-save, blur flush, and native close are all blocked while a conflict is pending.
      - Duplicate `editor-closed` events for the same unresolved revision → one modal.
      - Close-before-reload ordering: `editor-closed` arrives before the watcher event →
        reconcile still finds and reports the conflict.
      - Invalid external data → scene, dirty flag and accepted revision all preserved;
        retryable error shown.

**✅ Checkpoint 7:** `npm run typecheck` + `vitest run` green. Manual `just dev` walk-through:
edit in the viewer, edit the same file externally, confirm the banner appears, confirm both
resolutions behave, confirm auto-save stays paused until an explicit Save.

---

## Phase 8 — Documentation (§6.6) · parallel with P2, after P5 API freeze

- [x] `AGENT.md` — rewrite the **Language registration** section for the single-segment
      suffix strategy and the new `SVG` language; update the **LSP server** section's
      `didClose` note from "no-op" to the attention-signal role; add `POST /editor-closed`
      and `editor-closed` to the HTTP routes and SSE tables; document the `GET /data`
      ETag / `POST /data` `If-Match` (428/412) contract; add the new `AppState` fields.
      (Also synced while in there: the stale `extension.toml` snippet, the repository
      layout (extension/languages/), the watcher startup step (parent-directory watch,
      trailing reconciliation, revision echo suppression), the Component 3 webview
      sections (explicit SSE dispatch, save queue, conflict UX), and previously
      undocumented routes `/dirty`, `/native-action-result`, `/native-library-request`.)
- [x] `AGENT.md` **Constraints & Gotchas** — add: (a) the Zed 1.18 compound-suffix
      `didOpen` bug and why compound `path_suffixes` must not be used; (b) the
      `.excalidraw.png` image-pane limitation (viewer reachable via CLI only).
- [x] `README.md` — user-facing notes: `.excalidraw.png` opens in Zed's image viewer (use
      the CLI for the editable preview); plain `.svg` files now show "SVG" in the status
      bar and start an idle language server; selecting a different language for a file may
      disable automatic preview, and the CLI remains available. Note that user
      `file_types` settings are never rewritten.
- [x] `docs/PRD.md` — reflect the conflict model (disk as the persisted interchange,
      optimistic revision protection with the documented narrow race per the Phase 1
      decision) and the registration change.
- [x] Record the SVG-syntax-highlighting deferral (§8) and the upstream-bug filing intent
      in the appropriate non-goals section.

**✅ Checkpoint 8:** no stale references remain — `grep -rn "excalidraw.svg\"" AGENT.md
docs/ README.md` finds no surviving compound-suffix claims, and `grep -n "didClose"
AGENT.md` reflects the new role.

---

## Phase 9 — Build, full validation, real-Zed acceptance, release readiness

Order matters here: the UI must be built **before** the native binary so the embedded
assets speak the same HTTP protocol as the server.

> **Status (2026-09-05, non-interactive session):** every automatable item below is
> done and green. The interactive real-Zed walk-through items are left unchecked and
> annotated — they require driving the Zed GUI (`zed: install dev extension` +
> click-through), and Zed 1.18.1's CLI offers no `--install-dev-extension`. Full
> per-item annotations with automated proxies live in
> [`acceptance-checklist.md`](./acceptance-checklist.md); they are the outstanding
> human steps before publishing.

- [x] `just ui` — Vite production build into `preview-binary/assets/`.
- [x] `just build` — release binary with the freshly built assets embedded.
      (Rebuilt once more after the smoke-driver change so `target/release` is
      current.)
- [x] `just build-ext` — extension WASM.
- [x] `just test` — full sweep (nextest + typecheck + vitest). All green:
      116 passed / 1 skipped (the display-gated smoke self-test — green when run
      explicitly), `tsc --noEmit` clean, 137 vitest passed.
- [x] `cargo clippy --workspace -- -D warnings` and `cargo fmt --check`.
      (Both clean; `--all-targets` also run clean.)
- [x] `just smoke` on macOS (needs a display) — native↔JS bridge and external-link
      routing PASS: **5/5 checks**, including the new save-and-close-under-conflict
      check (below). Linux equivalent **not performed** (no Linux display in this
      session) — recorded in the acceptance checklist rather than omitted.
- [x] Manual native-bridge check of **Save-and-close under conflict**: dirty viewer +
      external edit → save-and-close must fail cleanly and keep the window open.
      Automated this phase as a real-WebView smoke stage (`SmokeDriver::begin_conflict`
      in `preview-binary/src/main.rs`): the driver externally rewrites the watched
      file and dispatches `__excalidrawSave({reason:'close'})` in the same tick; the
      conditional POST 412s and the bridge reports `ok:false` ("File changed on
      disk") — the result the native close flow maps to `CloseOutcome::Failed`
      (error dialog, window kept open). Verified live: `just smoke` → PASS, and via
      the ignored integration test `smoke_self_test_reports_all_checks_passing`.
      The human-draws-an-element GUI variant remains on the interactive checklist;
      its logic is covered by vitest (`SyncController — save-and-close under
      conflict`, conflict-pending blocks all writes).
- [ ] Install the packaged extension into Zed ("zed: install dev extension" → `./extension`).
      **NOT PERFORMED — requires the Zed GUI** (no CLI install on Zed 1.18.1; this
      was a non-interactive session). Zed `1.18.1` (build `20260904.150309`) is
      installed and recorded; run the walk-through interactively before publishing.
      Then verify:
  - [ ] The grammar-less `SVG` language loads and packages without a "grammar not found"
        rejection (the upstream docs describe a grammar as required — this is the risk item;
        if it fails, that blocks Stream A and must be reported before anything else).
        *(Mitigating precedent: the grammar-less `Excalidraw` language already ships.)*
  - [ ] Both manifest language mappings are active (status bar shows Excalidraw / SVG).
  - [ ] Fresh `.excalidraw.svg` buffer → viewer opens. **This is the regression test.**
  - [ ] Fresh `.excalidraw` buffer → viewer opens.
  - [ ] Close and reopen the Zed buffer while the viewer is live → focus, exactly one instance.
  - [ ] Re-click an already-open tab → no event promised, no focus (documented behavior).
  - [ ] Close the viewer window, then save in Zed → viewer reopens.
  - [ ] External save from Zed with a **clean** viewer → silent reload, viewport preserved.
  - [ ] External save from Zed with a **dirty** viewer → conflict banner; test both resolutions.
  - [ ] Zed auto-save enabled → no spurious conflicts, no lost viewer work.
  - [ ] Preview-tab replacement (single-click browsing) → viewer does **not** flicker shut.
  - [ ] LSP teardown ~3 s after the last matching buffer closes, then restart with
        `didOpen` replayed → exactly one preview instance, no duplicates.
  - [ ] Plain `.svg` file → no viewer spawns, no error.
  - [ ] `.excalidraw.png` → Zed's image pane renders it (expected limitation).
  - [ ] Coexistence with any installed XML/SVG extension and with user `file_types`
        overrides → no crash, user settings untouched.
  - [x] Measure ordinary `.svg` open overhead (server startup cost) and record the number.
        **Median 5.3 ms** (spawn + `initialize` round-trip of `excalidraw-preview
        --lsp`, 7 runs, release binary, macOS aarch64; headless preview-server boot
        → `/ping` median 14.9 ms). The LSP is an idle no-op for plain `.svg`, so the
        one-time spawn is the entire cost.
- [x] File the upstream Zed issue for the compound-suffix `didOpen` bug, attaching
      `zed-compound-suffix-repro.md`. Link the issue URL in the acceptance checklist.
      **Filed: https://github.com/zed-industries/zed/issues/63831** (duplicate
      search ran first; URL recorded in `acceptance-checklist.md`).
- [ ] Commit the implementation. Then, on a clean `main`, run `just bump <version>` —
      it updates every version site and creates the release commit itself. Do **not**
      hand-edit versions first. Publishing is a separate operation, performed only after
      acceptance passes. **DEFERRED BY INSTRUCTION**: this phase ran under an explicit
      "do not commit or stage" directive (committing is a separate process). `just bump`
      must follow that commit on a clean `main`, still gated on the interactive
      real-Zed acceptance items above.

**✅ Checkpoint 9 (release gate):** every acceptance box is ticked or explicitly annotated
as not-performed with a reason; `just test` green; the `.excalidraw.svg` click-to-preview
regression is confirmed fixed in real Zed. A synthetic `didOpen` test does **not** satisfy
this gate.

---

## Risk register

| Risk | Phase | Mitigation |
|---|---|---|
| Zed registry packager rejects the grammar-less `SVG` language | 9 | Verified early in Ph9 as the first acceptance item; the existing `Excalidraw` language is already grammar-less, which is the precedent. If rejected, Stream A needs a bundled XML grammar (currently a §8 non-goal) — report before continuing. |
| The single-suffix workaround doesn't actually fix routing (root cause is unpinned) | 9 | The upstream diagnosis is a hypothesis. Only real-Zed acceptance proves it; that's why Ph9 refuses to accept synthetic tests. Fall back: capture a fresh wrapper trace and reopen the investigation. |
| Registering `SVG` degrades UX for every `.svg` file the user opens | 2, 9 | LSP guard makes it an idle no-op; startup overhead is measured in Ph9; coexistence with XML/SVG extensions is an explicit acceptance item. |
| P4/P5 merge conflicts in the 4032-line `main.rs` monolith | 4, 5 | Disjoint regions (watcher in `main()` vs `run_lsp_server`); run sequentially if worktrees aren't used. |
| Breaking the existing `POST /data` contract breaks route tests and the Vite mock | 3, 6 | The spec calls this an intentional API change; Ph3 updates Rust tests and Ph6 updates the mock in the same pass. |
| Conflict UX blocks saving in an edge case and silently loses work | 7 | Every pause path has a paired vitest; the native close flow reports failure rather than closing. |
| Narrow cross-process write race remains | 1 | Accepted by the Phase 1 decision (Option 1) and documented — explicitly not an acceptance requirement. |
