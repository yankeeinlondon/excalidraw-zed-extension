---
reviewed: true
reviewed_by: "codex/default"
reviewed_on: "2026-09-05"
---

# Spec: LSP event strategy & language restructure

Date: 2026-09-05
Status: proposed
Scope: `extension/` (language registration), `preview-binary/` (LSP event handling,
conflict detection), `preview-binary/webview-src/` (reload guard, conflict UX)

## 1. Background: the regression

Click-to-preview stopped working for `.excalidraw.svg` in Zed (bare `.excalidraw`
kept working). Investigation against Zed `1.18.0+stable.351` (commit
`49448afcab82f219b0ef4c58471cf81d23412475`) established:

### Findings reported by the investigation

The session counts and installed-language audit below are supplied investigation
evidence, not reproduced by this document review. The upstream cause and proposed
single-suffix workaround still require the real-Zed acceptance test in §7.

1. **The binary side is fully functional.** Driving `excalidraw-preview --lsp`
   manually over stdio with `initialize` + `textDocument/didOpen` for the exact
   real file (`…/getting-started/compose-pipeline.excalidraw.svg`) spawns the
   preview correctly: lock file written, `/ping` 200, `/config` reports
   `image/svg+xml`. The `is_excalidraw_path` guard (main.rs) passes all three
   suffixes and has unit coverage.
2. **Zed attaches the Excalidraw language to `.excalidraw.svg` files.** The
   status bar shows "Excalidraw" and the buffer opens with SVG source text.
3. **Zed never sends `didOpen` for compound-suffix matches.** An interposed
   logging wrapper (`~/.local/bin/excalidraw-preview` → tee script) captured a
   full session: after `initialize`/`initialized`/`didChangeConfiguration`,
   every click on `lifecycle.excalidraw` produced `didOpen`+`didClose`
   (7 for 7), while clicks on `compose-pipeline.excalidraw.svg` opened the
   buffer (proven by the `didClose` of the displaced preview-tab buffer) but
   produced **zero** `didOpen` notifications (0 for 7).
4. **Single-segment suffixes route fine.** The `excalidraw` suffix (no dots)
   goes through an exact-match code path (`find_by_name_or_extension`,
   `available_languages.rs:186`: `suffix == string`) that demonstrably
   delivers `didOpen`. The full matcher (`find_for_file`) *also* matches
   compound suffixes via the filename candidate — which is why the language
   attaches — but that match never translates into buffer registration with
   the language server. The exact diverging call site upstream is not yet
   pinned (hypothesis: the buffer-subscription path uses the exact-match
   lookup, or the async language-load race skips
   `set_language_for_buffer` → `register_buffer_with_language_servers`).
5. **Zed tears the language server down ~3 s after the last Excalidraw
   buffer closes** ("stopping language server excalidraw-preview"), and
   restarts it on demand when the next matching buffer opens (it replays
   `didOpen` for open buffers on restart — observed at session restore).
6. **Zed's built-in image viewer claims `*.png` before any buffer exists.**
   `is_image_file` (`crates/project/src/image_store.rs`, at our build's
   commit): `Img::extensions().contains(&ext) && !ext.contains("svg")` —
   PNGs open as image items (no buffer, no language, no LSP events); SVG is
   explicitly excluded, so SVG always gets a text buffer.
7. No installed extension or Zed built-in claims a plain `svg` or `png`
   language suffix (audited all installed language configs + Zed built-ins).

### Upstream bug

Compound `path_suffixes` (e.g. `"excalidraw.svg"`) attach the language but
did not route `didOpen` in the reported Zed build/session. Treat this as a suspected
Zed regression to report
upstream with a minimal repro (language with compound suffix + dummy LSP +
traffic dump). This spec works around it rather than waiting on it.

## 2. Decision: keep the LSP transport

We provide no language-server features, but we keep the `--lsp` process,
because it is the available integration used by this repository for spawning a
native process in response to text-buffer events:

| Hook | Verdict |
|---|---|
| `didOpen` / `didSave` / `didChange` / `didClose` | LSP-only. Our transport. |
| Slash commands | Blocked — Zed reserves the command registry (extensions#6468) |
| MCP / context server | Agent-invoked tools; not click-driven |
| Extension file-open callback | Does not exist in the extension API |
| FS-watching daemon | Detects changes, never "user opened file" |

The LSP loop stays minimal (initialize / initialized / didOpen / didSave /
didClose / shutdown / exit + method-not-found for unknown requests). Notifications
never receive responses; stdout remains exclusively framed JSON-RPC. Retain the
existing `textDocumentSync = { openClose: true, change: 1, save: true }` for this
fix; reducing unused full-text change traffic is a separately measured optimization.
`didOpen` text is deliberately unused: the preview displays disk, including when
Zed restores an unsaved buffer. Save events may also originate from Zed auto-save;
reopening is save-triggered, not guaranteed to reflect an explicit user gesture.

## 3. Language registration design

Workaround for finding 3/4: claim only **single-segment suffixes**, which use
the exact-match path that works, and filter by filename inside the LSP.

| Language | `path_suffixes` | Grammar | Attach server | Effect |
|---|---|---|---|---|
| `Excalidraw` (existing) | `["excalidraw"]` only — drop the two compound entries | none (as today) | `excalidraw-preview` | bare `.excalidraw`: buffer + didOpen → viewer |
| `SVG` (**new**) | `["svg"]` | none initially (see §8) | `excalidraw-preview` | every `.svg` buffer attaches our server; guard passes only `*.excalidraw.svg` |
| PNG | — none — | — | — | Zed's image pane owns `*.png` clicks before buffers exist (finding 6); a PNG language could never attach. Not registered. |

The manifest must also map the server to both languages. In
`extension/extension.toml`, replace `language = "Excalidraw"` plus `languages = []`
with `languages = ["Excalidraw", "SVG"]` under
`[language_servers.excalidraw-preview]`. Do not rely on the existing
`language_servers` key in language config files as the sole association.

Notes:

- The didOpen/didSave handlers already filter with `is_excalidraw_path`
  (exact filename ends-with checks for `.excalidraw`, `.excalidraw.svg`,
  `.excalidraw.png`), so plain `.svg` buffers are silently ignored — the LSP
  spawn for a plain `.svg` is an idle no-op loop.
- In the audited installation, plain `.svg` files were plain text. Registering
  `SVG` intentionally changes the status-bar language, language-specific settings,
  server startup cost, and potentially selection precedence with XML/SVG extensions
  or user `file_types` overrides. Test coexistence; never rewrite user settings.
  Document that selecting another language may disable automatic preview and that
  CLI remains available. Grammar-less registration works in the existing repo;
  verify packaging/loading for the new language as well (current upstream language
  documentation describes a grammar as required).
- We do **not** attach to the built-in JSON language for bare `.excalidraw`
  (would spawn our server for every JSON file in the user's life). The
  dedicated `Excalidraw` language already works (7/7 delivery).
- `.excalidraw.png`: the click lands in Zed's image pane, which renders the
  PNG — a desirable read-only preview. The Excalidraw viewer for these files
  remains reachable via CLI (`excalidraw-preview <file>`). Documented as a
  Zed limitation; revisit if Zed ever exposes item-open events to extensions.

## 4. Event semantics

| Event | Semantics |
|---|---|
| `didOpen` | Open the viewer for the file. If a live instance exists (lock file + `/ping`), **focus** it instead of reopening (existing lock/`/focus` dedup). Zed fires this once per buffer creation; re-clicking an already-open tab does not refire. |
| `didSave` | Reopen a viewer the user deliberately closed, but only if none is live (`is_excalidraw_path && !preview_is_live`, existing). Never spawns on didChange. |
| `didChange` | Ignored, deliberately: typing in Zed must never open or resurrect a viewer. Viewer updates flow from the file on disk (§5), so text edits appear after save. |
| `didClose` | Not a veto (LSP notifications are post-hoc; the tab is already closed) and not teardown (Zed sends didClose on preview-tab *replacement* during normal browsing — killing the viewer here made previews flicker shut; historical bug). New role: an **attention signal**. The LSP forwards it to the live preview server, which escalates a *pending conflict dialog* (§5) if one exists. No dialog when there is nothing to reconcile. |

Zed server-lifecycle notes that the design must tolerate (findings 5): the
LSP may be torn down ~3 s after the last matching buffer closes and respawned
later with `didOpen` replayed for open buffers. All forwarding must therefore
be fire-and-forget and idempotent.

## 5. Conflict model: disk is the persisted interchange

Disk is the shared persisted version; a dirty viewer and a dirty Zed buffer each
retain independent unsaved work. This feature must protect viewer work without
silently authorizing overwrites of newer disk content. Zed owns its buffer conflict
UX; verify its actual reload/prompt behavior rather than assuming it always prompts.

> **Reader's note:** comparing only against the last viewer write leaves no baseline
> before the first save, and keeps flagging an external version even after the viewer
> accepts it. The original two-second suppression also hides genuine external saves.
> Use revisions of bytes read/accepted and conditional writes instead. This intentionally
> extends the local HTTP contract so auto-save cannot bypass the conflict banner.

### Revision and save contract

- Rust computes an opaque content revision (SHA-256 of exact bytes; reuse the existing
  hashing dependency) for each disk snapshot. `GET /data` retains its raw format body
  and MIME type and adds a strong `ETag` for those same bytes; disable caching.
  The viewer's accepted revision starts with the initial response, including an empty
  file. It advances only after a successful reload or successful viewer write.
  `prevHashRef` is the last-observed scene fingerprint, not a disk revision; keep the
  existing scene dirty/save-outcome bookkeeping separate.
- Every canonical `POST /data`, including bootstrap, auto-save, native Save and
  Save-and-close, supplies `If-Match` with its accepted revision (or the specific overwrite
  revision acknowledged by Keep my changes). Rust re-reads disk
  immediately before writing under a per-file save mutex. Missing precondition returns
  428; mismatched revision returns 412 without writing, with the current ETag.
  Success returns the written revision. I/O errors never advance either baseline.
  Update existing route tests and the Vite mock along with this intentional API change.
  Export and shared-library writes keep their existing contracts.
- Serialize viewer saves through one queue, including asynchronous SVG/PNG export;
  an older serialized scene must not arrive after a newer one and overwrite it.
  Preserve the existing rule that edits made during a save remain dirty. Queue follow-up
  saves against the acknowledged revision, not a stale revision captured before export.
- Suppress only proven viewer echoes by revision, never by elapsed time. Track successful
  writes before releasing the server save mutex so watcher observations cannot mislabel
  them. A successful write revision and the accepted revision suffice; retaining an
  unbounded history or a second copy of large PNG bytes is unnecessary.
- This is optimistic protection, not an atomic compare-and-swap against arbitrary
  external editors: an external write can still race between the final read and write.
  No cross-process lock protocol is introduced. See §10 before claiming stronger safety.

### Watcher and reload behavior

Watch the parent directory and filter to the target path, covering modify, create,
rename/atomic replacement, deletion and recreation. Replace the current leading-edge
80 ms throttle with trailing reconciliation plus a bounded maximum wait; never drop
only the final event of a write burst. Retry transient unreadable/partial writes with
bounded backoff and retain the last good scene on failure. Deletion is an unavailable
file state, not an empty drawing and not permission to recreate it automatically.

SSE is an invalidation hint, not durable conflict state. Keep existing `reload` and
`library` messages and add `editor-closed`; clients must dispatch explicitly and ignore
unknown events. On reload, fetch bytes + revision together. On initial subscription,
reconnect, and broadcast lag, reconcile again so a missed event cannot leave the view
silently stale. Coalesce reload requests and discard superseded asynchronous results.

- Clean and idle: parse, then apply through `applyExternalReload` in `dirty-state.ts`,
  preserving viewport/theme and existing persisted-app-state rules. Advance the accepted
  revision only after application. Do not mark an external reload as a viewer save.
- Dirty, saving, or mid-text-edit: retain the latest pending disk revision. Recheck live
  dirty/edit state **after** fetch/parse, immediately before applying. A skipped reload
  is deferred and retried when editing ends, never discarded.
- Dirty with a different revision: show “File changed on disk — Reload from disk /
  Keep my changes”. Cancel queued auto-save timers and pause every automatic flush
  (max-wait, pointer-up, blur, close) until resolution. A save-time 412 enters the same
  state even if the watcher has not fired. Rust `/dirty` reports are advisory; do not
  depend on their arrival order to protect scene edits or disk writes.
- Invalid external data or read failure: keep the scene, dirty state and accepted
  revision; show a retryable error. Never clear edits or switch a dirty editor into
  read-only image mode because parsing failed. Existing initially read-only image
  previews remain read-only and handle only reload events, with no conflict dialog.

### Resolution and close behavior

**Reload from disk** fetches the latest revision and parses successfully before dropping
viewer edits through the guarded reload path. While applying an explicit discard,
block edits/save actions briefly and invalidate stale fetch/save completions. If a
newer revision arrives, reconcile it again. Failed reload leaves the conflict pending.

**Keep my changes** acknowledges only the displayed pending revision as a separate expected
overwrite revision for the next write; do not change the accepted scene baseline; keep the scene dirty and display “Next save replaces the
disk version”. Do not save on dismissal. With auto-save enabled, remain paused until
an explicit Save succeeds; then resume normal auto-save. A subsequent external version
requires a new decision (the conditional write must fail rather than overwrite it).
Escape/Cancel closes the modal but leaves the unresolved banner and save pause.

`didClose` is optional attention only: never spawn, focus, shut down or discard a
viewer because of it. Forward a valid, guarded file URI to the existing live preview's
`POST /editor-closed`, using canonical lock-path identity and bounded HTTP timeouts
(≤500 ms per request) outside the stdio dispatch loop. Use a bounded/coalesced worker
queue; stale locks, invalid URIs and unavailable servers are harmless no-ops. LSP
shutdown need not drain this best-effort queue.

The endpoint returns 204 and emits `editor-closed`. The viewer reconciles disk before
checking conflict, so close-before-watcher ordering is covered. Show at most one
accessible in-webview modal per unresolved revision; duplicate closes do not stack
prompts. No automatic window focus stealing. If native close confirmation is active,
defer escalation until that flow ends. Save-and-close uses the same conditional save
and reports failure via `/native-action-result` on conflict, keeping the window open;
never acknowledge save success merely because a conflict dialog was displayed.
Existing explicit “Don't Save” still closes and discards viewer edits.

## 6. Implementation plan

1. `extension/languages/excalidraw/config.toml` — `path_suffixes =
   ["excalidraw"]` only; update the explanatory comment.
2. `extension/languages/svg/config.toml` — new: `name = "SVG"`,
   `path_suffixes = ["svg"]`, `language_servers = ["excalidraw-preview"]`,
   no grammar.
3. `extension/extension.toml` — associate the server with both languages as in §3.
4. `preview-binary/src/main.rs` — `didClose` handler: forward to the live
   preview server (no-op when none). Add `/editor-closed` route +
   `PreviewEvent::EditorClosed`; implement the revision/precondition contract, watcher reconciliation and bounded
   forwarding worker from §5; retain explicit SSE message dispatch.
5. `preview-binary/webview-src/src/App.tsx` / `main.tsx` / `dirty-state.ts` — `reloadScene`
   gains the dirty guard + pending-conflict state; banner UI; dialog on
   `editor-closed` escalation; "Reload from disk" uses the guarded reload path,
   "Keep my changes" acknowledges one revision and pauses auto-save until explicit Save.
   Update `vite.config.ts` mocks and all canonical data clients to match §5.
6. `AGENT.md`, `README.md`, `docs/PRD.md` — rewrite the "Language registration" section and the
   didClose note in the LSP section to match this spec; note the Zed 1.18
   compound-suffix bug and the PNG/image-pane limitation.
7. Build the UI before the native binary so embedded assets implement the same HTTP
   protocol; build the WASM extension and validate registration in Zed. Release only
   after acceptance. `just bump <version>` itself updates all version sites and makes
   a release commit; run on clean `main` after implementation is committed, not after
   manually bumping versions. Publishing remains a separate release operation.

## 7. Testing plan

- Rust route/unit tests: initial revision before any save, conditional success, 428/412,
  unchanged disk on rejection, write failure, accepted external baseline, own echoes,
  and a real external edit immediately after a viewer save. Exercise all three formats.
- Headless LSP harness (`preview-binary/tests/integration.rs`): feed all three guarded
  suffixes directly; assert one preview instance, didSave no-op while live, reopen after
  shutdown, didChange no spawn, and didClose delivery without shutdown. Include plain
  SVG and malformed/non-file URI no-ops, stale locks and a slow forwarding endpoint
  without delayed LSP shutdown. Subscribe to SSE before sending the close notification.
- Watcher integration: temp-file rename over target, rapid writes with a final different
  version, delete/recreate, missed events/reconnect. Wait for observable revisions with
  bounded deadlines rather than relying on fixed sleeps.
- Vitest: dirty guard after asynchronous parse, deferred mid-edit reload, save queue
  ordering, edit-during-save, auto-save/blur/native-close blocked on 412, both resolution
  outcomes, second external revision after Keep, invalid data, duplicate escalation,
  close-before-reload, explicit event dispatch and independent library events. Cover
  initial read-only image reload and Vite per-file revision isolation.
- Run `just test`, UI production build, native build and extension WASM build. Use
  existing native bridge smoke/manual checks for Save-and-close on macOS and Linux
  when a display is available; record any platform checks not performed.
- Real-Zed acceptance (append results/build identity to a checklist in this directory):
  load the packaged extension, verify grammar-less SVG loads and both manifest
  language mappings work; fresh `.excalidraw.svg` and `.excalidraw` buffer → viewer;
  close/reopen the Zed buffer with viewer live → focus, one instance; re-click an
  already-open tab → no promised event/focus; close viewer then save → reopen.
  Test dirty/clean viewer external saves, both resolutions, Zed auto-save, preview-tab
  replacement, LSP teardown/restart, plain SVG no viewer, PNG image pane, and coexistence
  with XML/SVG extensions/user file associations. Measure ordinary SVG startup overhead.
  A synthetic didOpen test cannot validate Zed suffix matching or prove the workaround.

## 8. Non-goals / deferred

- **SVG syntax highlighting**: the SVG language ships grammar-less (plain
  text — identical to today's rendering of both plain `.svg` and
  `.excalidraw.svg`). Highlighting requires bundling an XML grammar in the
  extension (the registry packager rejects referencing another extension's
  grammar). Deferred.
- **`.excalidraw.png` click-to-viewer**: unreachable through any extension
  hook (finding 6). Zed's image pane is the click experience; viewer via CLI.
- **Upstream Zed fixes**: file the compound-suffix didOpen bug (with the
  wrapper-capture repro) and, longer-term, request a real extension event
  API for file opens so the fake-LSP transport can retire.

## 9. Cleanup from the investigation

- The investigation reports `~/.local/bin/excalidraw-preview` points at the debug wrapper
  (`target/release/ep-lsp-logger.sh`) — restore with `just symlink`, delete
  the wrapper script and only `/tmp/ep-lsp-*` logs confirmed to belong to this
  investigation. Preserve a sanitized minimal trace/repro here before deleting evidence.
- Remove the leftover headless test instance locks created during the
  investigation (`$TMPDIR/excalidraw-*.lock` for files under
  `/tmp/test-lsp…` and the feat-unifi worktree, if present).

Cleanup is implementation follow-through, not part of this document review. Verify
symlink targets and recorded test paths first. Stop only identified test processes,
then remove their locks; never glob-delete live preview locks or unrelated temp files.

## 10. Open Questions

### Is optimistic conflict protection sufficient for simultaneous external writes?

The §5 precondition closes the normal watcher/auto-save race, but an uncooperative
writer can still modify disk between comparison and replacement. Decide before
implementation if preserving every competing write is an acceptance requirement.

1. **Revision checks with the documented narrow race (recommended).** Pros: works with
   Zed, CLI tools and git without new user workflows; bounded memory and disk cost.
   Cons: cannot guarantee no lost write in that final cross-process race. Recommended
   for the current local editor scope because stronger coordination is unavailable
   from arbitrary external writers.
2. **Add recovery snapshots of overwritten disk and viewer versions.** Pros: permits
   recovery from more races and mistaken choices. Cons: storage growth, retention and
   privacy policy, cleanup and recovery UI become new scope; still cannot capture an
   unseen write landing in the final race. Choose if recovery is a product requirement.
3. **Write conflicts to a separate file and require explicit reconciliation.** Pros:
   avoids automatic replacement of the canonical file during detected conflicts.
   Cons: creates duplicate drawings and a less ergonomic merge workflow; does not make
   undetected external races atomic. Appropriate if conservative persistence outweighs
   the existing edit-and-save experience.

## 11. Review references

Repository contracts checked: `extension/extension.toml`, language config,
`preview-binary/src/main.rs` (LSP, routes, watcher and native close), `App.tsx`,
`main.tsx`, `dirty-state.ts`, existing tests, `AGENT.md`, and `justfile`.
Earlier feature specs are historical context, not declared dependencies of this spec.

[Zed language extension documentation](https://zed.dev/docs/extensions/languages)
describes suffix configuration and grammar packaging. Its grammar requirement differs
from the repository's existing grammar-less configuration; packaging acceptance must
resolve that difference for the targeted build rather than assuming portability.
[LSP 3.17 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
is the protocol reference for synchronization notifications and lifecycle handling.
The supplied upstream regression diagnosis remains a hypothesis until reproduced.
