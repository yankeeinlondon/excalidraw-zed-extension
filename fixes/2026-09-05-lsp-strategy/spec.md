# Spec: LSP event strategy & language restructure

Date: 2026-09-05
Status: proposed
Scope: `extension/` (language registration), `preview-binary/` (LSP event handling,
conflict detection), `preview-binary/webview-src/` (reload guard, conflict UX)

## 1. Background: the regression

Click-to-preview stopped working for `.excalidraw.svg` in Zed (bare `.excalidraw`
kept working). Investigation against Zed `1.18.0+stable.351` (commit
`49448afcab82f219b0ef4c58471cf81d23412475`) established:

### Facts (verified empirically)

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
never route `didOpen` in Zed 1.18. This is a Zed regression to report
upstream with a minimal repro (language with compound suffix + dummy LSP +
traffic dump). This spec works around it rather than waiting on it.

## 2. Decision: keep the LSP transport

We provide no language-server features, but we keep the `--lsp` process,
because it is the **only** Zed extension hook that both spawns a native
process and receives file events:

| Hook | Verdict |
|---|---|
| `didOpen` / `didSave` / `didChange` / `didClose` | LSP-only. Our transport. |
| Slash commands | Blocked — Zed reserves the command registry (extensions#6468) |
| MCP / context server | Agent-invoked tools; not click-driven |
| Extension file-open callback | Does not exist in the extension API |
| FS-watching daemon | Detects changes, never "user opened file" |

The LSP loop stays minimal (initialize / initialized / didOpen / didSave /
didClose / shutdown / exit + method-not-found for unknown requests).

## 3. Language registration design

Workaround for finding 3/4: claim only **single-segment suffixes**, which use
the exact-match path that works, and filter by filename inside the LSP.

| Language | `path_suffixes` | Grammar | Attach server | Effect |
|---|---|---|---|---|
| `Excalidraw` (existing) | `["excalidraw"]` only — drop the two compound entries | none (as today) | `excalidraw-preview` | bare `.excalidraw`: buffer + didOpen → viewer |
| `SVG` (**new**) | `["svg"]` | none initially (see §8) | `excalidraw-preview` | every `.svg` buffer attaches our server; guard passes only `*.excalidraw.svg` |
| PNG | — none — | — | — | Zed's image pane owns `*.png` clicks before buffers exist (finding 6); a PNG language could never attach. Not registered. |

Notes:

- The didOpen/didSave handlers already filter with `is_excalidraw_path`
  (exact filename ends-with checks for `.excalidraw`, `.excalidraw.svg`,
  `.excalidraw.png`), so plain `.svg` buffers are silently ignored — the LSP
  spawn for a plain `.svg` is an idle no-op loop.
- Plain `.svg` files currently get no language (plain text); claiming `svg`
  changes nothing user-visible in the editor.
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

## 5. Conflict model: file on disk is the single source of truth

Two independent editors can touch one file: the Excalidraw viewer (saves via
`POST /data`) and Zed's text editor (saves the buffer). Neither listens to
the other's *keystrokes*; both reconcile through the file on disk.

### State tracked

- **Viewer side** (already implemented): dirty flag with baseline hash
  (`prevHashRef`), `lastSavedAt` bookkeeping, `POST /dirty` reports every
  transition to Rust; the viewer window's own close flow intercepts with a
  native 3-way dialog.
- **Rust side** (new): remember the exact bytes the viewer last wrote
  (`POST /data` body). An **external change** = current disk bytes ≠ last
  bytes written by the viewer. This is the "snapshot at our last save point"
  comparison, and it correctly classifies git checkouts, CLI edits, and Zed
  text saves identically.

### Synchronization flows

1. **Viewer saves** → disk updated → Zed auto-reloads its clean buffer
   (Zed prompts if the Zed buffer is dirty — Zed owns that conflict UX).
2. **Zed text edit + save** → watcher fires → SSE `reload`:
   - viewer clean → auto-reload (existing behavior; keep mid-edit skip and
     the 2 s post-save echo suppression).
   - viewer **dirty** → **do not clobber** (today `reloadScene`,
     App.tsx:218, silently applies the disk version and clears the dirty
     flag — the gap this spec closes). Instead record a *pending conflict*:
     Rust flags external-change; the viewer shows a non-blocking banner
     ("File changed on disk — Reload / Keep my changes").
3. **didClose escalation**: when the LSP forwards didClose and a pending
   conflict exists, the banner escalates to a modal dialog with the choice:
   - **Keep my changes** — stay dirty; the next viewer save overwrites the
     disk version (this is the explicit meaning of the choice).
   - **Take theirs** — apply the external reload, drop viewer edits, clear
     dirty (current `reloadScene` semantics).
   Escalating on didClose is well-timed even though didClose also fires on
   browse-away: the user has just left the text side, so the prompt is not an
   interruption of active editing. No dialog when the viewer is dirty but the
   disk matches the last viewer save (nothing to reconcile — the window's own
   close flow still guards those edits).

### Plumbing sketch

LSP `didClose` → (lock file → port) → `POST /editor-closed` on the preview
server → new `PreviewEvent::EditorClosed` on the SSE broadcast → webview
escalates pending conflict. External-change detection stays in Rust (bytes
comparison) so the webview only reacts to a flag; exact endpoint/route names
are implementation detail.

## 6. Implementation plan

1. `extension/languages/excalidraw/config.toml` — `path_suffixes =
   ["excalidraw"]` only; update the explanatory comment.
2. `extension/languages/svg/config.toml` — new: `name = "SVG"`,
   `path_suffixes = ["svg"]`, `language_servers = ["excalidraw-preview"]`,
   no grammar.
3. `preview-binary/src/main.rs` — `didClose` handler: forward to the live
   preview server (no-op when none). Add `/editor-closed` route +
   `PreviewEvent::EditorClosed`; track last-written-by-viewer bytes for
   external-change detection; include the flag in the SSE reload event (or a
   dedicated event).
4. `preview-binary/webview-src/src/App.tsx` / `main.tsx` — `reloadScene`
   gains the dirty guard + pending-conflict state; banner UI; dialog on
   `editor-closed` escalation; "Take theirs" reuses the existing reload path,
   "Keep my changes" just dismisses and stays dirty.
5. `AGENT.md` — rewrite the "Language registration" section and the
   didClose note in the LSP section to match this spec; note the Zed 1.18
   compound-suffix bug and the PNG/image-pane limitation.
6. Version bump + `just bump` (repo convention).

## 7. Testing plan

- Rust unit: language config contents (suffix lists), didClose forwarding
  (headless: spawn LSP, drive didOpen + didClose, assert `/editor-closed`
  observed on the preview server), external-change classification
  (disk-vs-last-write bytes: equal / viewer-echo / external).
- Vitest: `reloadScene` dirty guard (clean → applies; dirty → defers, banner
  state set), escalation on `editor-closed` event, both dialog outcomes.
- Integration (existing headless harness): didOpen for all three suffixes
  through the new SVG language path; plain `.svg` didOpen spawns nothing.
- Manual checklist (append to this dir): fresh click `.excalidraw.svg` →
  viewer opens; second click → focuses; Zed text edit + save with clean
  viewer → live reload; same with dirty viewer → banner, didClose → dialog;
  keep-mine/take-theirs outcomes; plain `.excalidraw.png` click → Zed image
  pane (no viewer, no crash).

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

- `~/.local/bin/excalidraw-preview` currently points at the debug wrapper
  (`target/release/ep-lsp-logger.sh`) — restore with `just symlink`, delete
  the wrapper script and `/tmp/ep-lsp-*` logs.
- Remove the leftover headless test instance locks created during the
  investigation (`$TMPDIR/excalidraw-*.lock` for files under
  `/tmp/test-lsp…` and the feat-unifi worktree, if present).
