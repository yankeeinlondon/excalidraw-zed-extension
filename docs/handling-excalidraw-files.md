# How Excalidraw files are handled

How a `.excalidraw`, `.excalidraw.svg`, or `.excalidraw.png` file travels from a click
in Zed to a live drawing surface, and how the editor pane and the preview window stay
in step afterwards.

This is a behaviour reference. It records *what happens and why*, not the shape of the
code — read `preview-binary/src/main.rs` and `preview-binary/webview-src/src/` for
that, and `AGENT.md` for the decisions that must not be reversed silently.

---

## 1. The three formats

All three are Excalidraw *scenes*. They differ only in the container the scene is
persisted in, which the preview detects **from the file name alone** — never by
sniffing bytes (`detect_content_type`, `main.rs`).

| File | Served MIME | What is on disk | Editable in the viewer |
|---|---|---|---|
| `*.excalidraw` | `application/json` | The scene JSON itself | Always |
| `*.excalidraw.svg` | `image/svg+xml` | A rendered SVG **plus** the scene embedded in it | Only if the scene is embedded |
| `*.excalidraw.png` | `image/png` | A rendered PNG **plus** the scene embedded in it | Only if the scene is embedded |

The extension is authoritative because it is what the *user* declared the file to be;
if the bytes disagree, the client's fallback chain (§6) sorts it out rather than the
server guessing.

For the two image formats, "the scene is embedded" is the load-bearing property. An
SVG or PNG exported *without* it is just a picture: the viewer opens it read-only with
a banner rather than erroring (§6). This is why every canonical save of those formats
passes `exportEmbedScene: true` (§7) — without it, saving would quietly destroy the
file's editability.

Anything else — a plain `.svg`, a plain `.png`, a `.json` — is not an Excalidraw file
here. The guard is a filename check on those three suffixes
(`is_excalidraw_path`), applied at every LSP entry point.

---

## 2. The moving parts

Three processes, and disk between them.

```
      Zed                       preview binary                  preview binary
 ┌──────────────┐   stdio   ┌─────────────────────┐  spawn   ┌────────────────────┐
 │ editor pane  │◀─JSON-RPC▶│  --lsp  (one per    │─────────▶│ one per file:      │
 │ project panel│           │  Zed project)       │          │ axum server + wry  │
 └──────┬───────┘           └─────────────────────┘          │ WebView window     │
        │                                                    └─────────┬──────────┘
        │  read / write                                                │ HTTP + SSE
        ▼                                                              ▼
   ╔═══════════════════════════════════════════════════════════════════════════╗
   ║                        the file on disk (the interchange)                 ║
   ╚═══════════════════════════════════════════════════════════════════════════╝
```

- **The Zed extension** (`extension/`, `wasm32-wasip1`) does one job: find the
  companion binary and start it with `--lsp`. It holds no per-file state and never
  sees a file's contents.
- **`excalidraw-preview --lsp`** is a language server that provides no language
  features. It exists because LSP notifications are the only hook Zed gives an
  extension for "the user opened this file" (§3). One instance serves the whole Zed
  project.
- **`excalidraw-preview <file>`** is the viewer: an axum server bound to loopback plus
  a native WebView window running the React/Excalidraw UI. One instance per file.

The two preview roles are the same binary. The LSP process starts viewer processes and
then forgets about them — it never owns their lifetime, and killing Zed does not close
a preview window.

**They share the file, not a buffer.** There is no live channel between Zed's text
buffer and the canvas. Zed edits text and writes it; the viewer edits a scene and
writes it; each observes the other's writes through the file system. Everything in
§8–§10 exists to make that safe.

---

## 3. How each format reaches the viewer

Zed only delivers `textDocument/*` notifications for a buffer whose language declares
our language server. So the route into the viewer differs per format, and one format
has no route at all.

| File | Zed language | How the viewer opens |
|---|---|---|
| `*.excalidraw` | `Excalidraw` (claims suffix `excalidraw`) | `didOpen` → spawn |
| `*.excalidraw.svg` | `SVG` (claims suffix `svg`) | `didOpen` → spawn, after the filename guard |
| `*.excalidraw.png` | — none — | **CLI only** |

### Why `.excalidraw.svg` is handled by a language called "SVG"

The obvious registration — a `path_suffixes` entry of `"excalidraw.svg"` — does not
work. Zed 1.18 *attaches* a compound-suffix language to the buffer (the status bar even
says so) but never routes `textDocument/didOpen` to that language's server; only
single-segment suffixes take the exact-match path that delivers buffer events. In the
captured session, 7 clicks on a `.excalidraw` file produced 7 `didOpen`s and 7 clicks
on a `.excalidraw.svg` produced 0.

So the extension claims the single-segment `svg` suffix instead and filters by filename
*inside* the LSP. The cost is accepted deliberately: every `.svg` buffer attaches our
server, and for a plain `.svg` that server is an idle no-op — `is_excalidraw_path`
rejects it, nothing spawns, nothing errors. The alternative (claiming the built-in JSON
language for `.excalidraw`) would spawn our server for every JSON file the user ever
opens, which is worse.

Evidence and repro: `fixes/2026-09-05-lsp-strategy/zed-compound-suffix-repro.md`;
upstream zed-industries/zed#63831. Corpus tests in `extension/src/lib.rs` parse the
shipped TOML so this cannot regress silently.

### Why `.excalidraw.png` has no route

Because Zed never creates a buffer for it, so there is no event to hook. This is
structural, not an omission — four independent gates, each read out of Zed's source:

1. **The image pane claims the file.** `ImageItem::try_open`
   (`crates/project/src/image_store.rs`) returns `Some` when `is_image_file` does, and
   that is `Img::extensions().contains(&ext) && !ext.contains("svg")` against
   `Path::extension()` — `png` for `architecture.excalidraw.png`. It reads the
   extension and nothing else: not language registration, not the user's `file_types`.
2. **The image pane outranks the editor.** `ProjectItemRegistry::open_path`
   (`crates/workspace/src/workspace.rs`) iterates its registrations **in reverse**
   (`.iter().rev()`) and takes the first `Some` — last registered wins — and
   `image_viewer::init` runs after editor setup in `crates/zed/src/zed.rs`. So the
   image item wins and **no buffer is created**, which is why there is no `didOpen` to
   filter rather than one we choose to ignore.
3. **Extensions cannot enter that registry.** `register_project_item` is a Rust API in
   the `workspace` crate; `zed_extension_api` offers languages, language servers,
   themes, context servers and debuggers, and nothing that registers a project-item
   type.
4. **A task cannot stand in for it either.** In `task_contexts`
   (`crates/tasks_ui/src/tasks_ui.rs`), `ZED_FILE` and the other file-scoped variables
   come only from `active_item.act_as::<Editor>(cx)`. An image item is not an `Editor`,
   so a task fired over a `.excalidraw.png` gets worktree-level variables and never
   learns the file name.

There is no setting that turns the image viewer off, either. Clicking a
`.excalidraw.png` in Zed therefore gives you Zed's read-only image render — a fine
preview, but not the editor — and no extension change can alter that. It would take an
upstream change in Zed: an extension-registrable project item, or `is_image_file`
honouring a `file_types` override.

The editable viewer is one command away:

```bash
excalidraw-preview path/to/diagram.excalidraw.png
```

Starting a new one, in any of the three formats, is `--new` (it refuses to overwrite an
existing file):

```bash
excalidraw-preview --new path/to/diagram.excalidraw.png
```

### Syntax highlighting is a separate concern

Both registered languages bundle a tree-sitter grammar — `json` for `Excalidraw`, `xml`
for `SVG` — so the *buffer* behind a preview is highlighted and a broken hand-edit shows
up as a parse error. That is cosmetic and independent of everything below: no grammar
influences whether a preview opens, and nothing validates the scene against Excalidraw's
schema.

---

## 4. The LSP event contract

The server implements the lifecycle and nothing else: `initialize`, `initialized`, the
four `textDocument` notifications, `shutdown`, `exit`, and `-32601 Method not found`
for any other *request*. Notifications never get a response, and stdout carries framed
JSON-RPC exclusively.

It advertises `textDocumentSync = { openClose: true, change: 1, save: true }`.

| Event | What it does | Why |
|---|---|---|
| `didOpen` | Spawn a detached preview for the file. | Zed fires it once per buffer creation. A live instance is focused rather than duplicated (§5). |
| `didSave` | Spawn **only if no preview is live**. | The one way back after the user closes a preview window — Zed never re-sends `didOpen` for a buffer that is already open. May also come from auto-save, so it is not proof of a deliberate gesture. |
| `didChange` | **Ignored.** | Typing must never open or resurrect a viewer. The viewer follows disk, so text edits appear after a save. |
| `didClose` | Forward an attention signal to the live preview (§10). | Emphatically *not* teardown. Zed reuses one preview tab for single-clicked files and sends `didClose` every time you browse away; tearing the window down here made previews flicker shut. |

`didOpen`'s text payload is deliberately unused — the preview displays disk, including
when Zed restores an unsaved buffer.

Two lifecycle facts the design has to tolerate: Zed stops the language server roughly
3 s after the last matching buffer closes, and restarts it on demand — replaying
`didOpen` for buffers that are still open. Every forward is therefore fire-and-forget
and idempotent.

### Work that must not block the dispatch loop

Two dedicated threads sit behind channels so no HTTP ever runs on the stdio path:

- **The `didClose` forwarder** — a bounded, coalescing queue that POSTs to
  `/editor-closed` with a ≤500 ms timeout. Stale locks, dead servers and unparseable
  URIs are silent no-ops. LSP `shutdown`/`exit` deliberately does **not** drain it.
- **The preview tracker** — window open/close is not observable from the LSP process,
  so this thread follows the per-file lock of each preview it asked for: the lock
  appearing means the window is up, its removal means it is gone. It blocks entirely
  while nothing is tracked and gives up after 15 s if no lock ever appears.

### Where the log goes

Zed files a language server's **stderr** under that server's *Server Logs*, so stderr is
this extension's only channel into the editor's UI — it has no notifications and no
palette entry. `--lsp` therefore installs its tracing subscriber unconditionally at
`info` (`--debug` or `RUST_LOG` raises it), unlike the viewer process where tracing is
behind `--debug`. The writer must stay `std::io::stderr`: tracing's default is
*stdout*, which is the JSON-RPC stream.

Reach it in Zed with: click `excalidraw-preview` in the status bar → **View Logs**.

The spawned viewer's own stderr is discarded on purpose — piping it back would tie the
detached window's lifetime to the editor's, which is exactly what detaching prevents.

---

## 5. Opening, deduplicating, and initialising

`spawn_preview` starts the binary detached, in its own process group (immune to
`SIGHUP`), with all three stdio streams null. From there the new process handles
everything itself:

1. **Daemonize** and return, so the caller — Zed or a terminal — is never blocked.
2. **Bootstrap an empty file.** A blank `.excalidraw` is given a blank scene JSON on
   disk (`bootstrap_if_empty`). The image formats are left as zero bytes and are
   bootstrapped by the frontend on its first save instead, because a valid empty PNG or
   SVG can only be produced by rendering one.
3. **Dedup through the lock file.** `$TMPDIR/excalidraw-{sha256(canonical path)}.lock`
   holds the live port. If it exists and `/ping` answers, the new process calls
   `/focus` on the existing one and exits — so re-clicking a file raises its window
   rather than opening a second copy. A stale lock is harmless: the probe fails and the
   lock is replaced.
4. **Bind, then publish.** The server binds port 0 and learns its port from the bound
   socket *before* writing the lock file, so concurrent launches cannot race for the
   same port.
5. **Open the window** on `http://localhost:{port}` — the `localhost` hostname, not
   `127.0.0.1`, because WebKit treats only the former as a secure context and
   `navigator.clipboard` is undefined otherwise.

The lock must be removed on every exit path (window close, `/shutdown`). Its lifecycle
belongs to the viewer process alone — the LSP only ever *reads* it.

---

## 6. Loading a file into the UI

On boot the frontend (`main.tsx`) fetches `/config` (MIME, display name, theme,
auto-save) and then `/data`, which returns the raw bytes, a strong `ETag` content
revision, and `cache-control: no-store`. That first ETag is the viewer's **accepted
revision** — the baseline every later write is conditional on (§7), and it exists even
for an empty file.

Then, in order:

1. **Empty file?** Start from a blank scene and mark the first save as a bootstrap
   write. This is what makes `excalidraw-preview --new diagram.excalidraw.png` produce
   a real PNG.
2. **Otherwise parse**, trying the declared format first and then the other two
   (`parseDiskBytesWithFallbacks`). The extension is authoritative but the chain
   absorbs a mismatch — a file named `.excalidraw.svg` that actually contains scene
   JSON still opens.
3. **All three failed?** For `image/svg+xml` and `image/png` this means a rendered
   image with no embedded scene, so the UI falls back to a **read-only image preview**:
   the raw image centred in the window under the banner *"Read-only preview — no
   embedded Excalidraw scene. Re-export with 'Embed scene' enabled to edit."* It still
   live-reloads on `reload`, and it handles no other event — a read-only preview has no
   scene, so it can never conflict and never shows a conflict dialog. A save gesture
   here answers with a transient notice rather than nothing (§7). For
   `application/json` there is nothing to show, so it errors.
4. **Recover the document's colour mode** before React mounts, so the canvas, the
   toggle and the next save agree from the first frame. Excalidraw strips
   `appState.exportWithDarkMode` in *both* directions — out of the scene it embeds on
   export, and out of the scene `loadFromBlob` hands back on load — so the key cannot
   round-trip unaided. Three sources, in priority order: SVG is detected exactly
   (excalidraw marks a dark export with a root `invert(93%) hue-rotate(180deg)`
   filter), PNG best-effort by sampling a corner pixel's luminance, and plain JSON
   from the literal `appState.exportWithDarkMode` key — which this app writes on every
   plain-JSON save by post-serialization injection (§7) and re-attaches from the raw
   bytes inside `parseDiskBytesWithFallbacks`, because `loadFromBlob` would otherwise
   have dropped it before the chain could read it. A file that states no mode — one
   written before this existed, or by another tool — still falls through to the
   OS/config theme, byte-for-byte as before.

---

## 7. Saving

Saving is always a **whole-file write in the file's own format**, and always
conditional.

| Format | What gets written |
|---|---|
| `application/json` | `serializeAsJSON(...)`, then `appState.exportWithDarkMode` injected back into the serialized text (`serializeSceneForDisk`) |
| `image/svg+xml` | `exportToSvg` with `exportEmbedScene: true` |
| `image/png` | `exportToBlob` with `exportEmbedScene: true`, at `appState.exportScale` (default 2×) |

The injection on the JSON path is not decoration: `serializeAsJSON` strips
`exportWithDarkMode` (upstream marks it per-browser state), so without it a plain
`.excalidraw` could not carry the document's colour mode at all, and §6 step 4 would
have nothing to read. It is a byte-stable text splice — every byte outside the
injected key is the serializer's own output — and it runs at the one seam both
plain-JSON writers share, canonical save and **Export Scene**, so no plain-JSON body
this app writes can miss it.

`exportEmbedScene` is not optional for these two paths — omitting it turns the file
into a plain image that can never be reopened for editing. The **Export PNG/SVG** menu
items deliberately do *not* embed: those write a shareable image to a different
filename. **Export editable SVG (.excalidraw.svg)** does embed, and names its output
`.excalidraw.svg` so the preview treats it as a scene.

Every canonical write — bootstrap, auto-save, menu Save, Cmd+S, save-and-close — goes
through one `SaveQueue`, so an older serialised scene can never land after a newer one
(SVG and PNG serialisation are `await`ed, so this is a real risk without the queue).

The wire contract on `POST /data`:

- `If-Match` carries the accepted revision. Missing → **428**.
- The server takes a per-file mutex, **re-reads disk inside it**, and compares. Mismatch
  → **412**, with the current `ETag`, and nothing is written.
- On success the file is written, the new revision is recorded as
  `last_written_revision` *before the mutex is released* (§8 depends on this ordering),
  and returned as the response `ETag`.
- A missing file has the distinct revision `"absent"`, so a client can knowingly
  recreate one.

This is optimistic protection, **not** an atomic compare-and-swap: an uncooperative
external writer can still land between the locked re-read and the write. That residual
race is an accepted decision (`fixes/2026-09-05-lsp-strategy/decision-log.md`, D1). The
ETag is opaque — the frontend echoes it byte-for-byte and never parses it.

### A save gesture always answers

An explicit save shows a *Saving…* / *Saved* toast, or an error banner, or a conflict
banner. The states with no React app behind them — the read-only image preview, a
failed load, the window between page load and mount — have no toast surface at all, so
they get a transient in-page notice instead (*"Read-only preview — no embedded scene to
save…"*). `main.tsx` registers `window.__excalidrawSaveUnavailable` at module scope on
every load path; the native File → Save script calls it whenever
`window.__excalidrawSave` is absent, and `doSave` calls it on its own no-API early
return. **Nothing at all in response to a save gesture is a defect**, not an acceptable
no-op (`fixes/2026-09-05-fix-me-up/decision-log.md`, D2).

---

## 8. Noticing that the file changed underneath

The watch is registered on the file's **parent directory**, filtered to the canonical
target. Watching the file itself would follow the old inode and miss the two things
that matter most: atomic replace (temp file + rename, which is how many editors save)
and delete/recreate.

- Events **coalesce with trailing reconciliation** — a quiet window plus a forced
  deadline measured from the burst's first event — so the last event of a write burst is
  never dropped.
- The notify→loop channel is bounded; a dropped event sets an overflow flag that forces
  a reconcile, which is what makes dropping safe.
- A transient unreadable/partial read is retried with bounded backoff, keeping the last
  good scene.
- **Deletion is an "unavailable" state.** Never an empty drawing, and never a licence to
  recreate the file.

**Echo suppression is by revision, never by time.** On each reconcile the server hashes
what is on disk and compares it with the last revision it wrote itself; equality
*proves* this is our own write coming back and the event is dropped. An elapsed-time
window could not tell a fast external edit from an echo, so it is forbidden by spec.

Anything else broadcasts `reload` over SSE.

---

## 9. SSE: a hint, never state

`/events` carries exactly three message names, and clients dispatch on them
**explicitly** and ignore anything unknown (`sse-events.ts`):

| Event | Meaning |
|---|---|
| `reload` | Disk changed — go re-read it. |
| `library` | A "Browse libraries" install landed; reload the library panel only. Never touches the scene. |
| `editor-closed` | The editor's buffer for this file closed (§10). |

A subscriber that falls behind receives a `reload` in place of the frames it missed —
idempotent invalidation, so lag can never leave the view stale. The event itself carries
no data: the client always re-fetches bytes and ETag *together*, and re-checks live
dirty/editing state **after** the awaits, immediately before applying.

`library` is idempotent in the same spirit, but that had to be *made* true: the vendored
merge dedupes by element content rather than by id, so re-delivering an already-installed
library appended a second entry under the same library-item id, and dragging that item
then dropped two copies. Every flow that touches the library payload now passes through
one choke point that guarantees at most one entry per id, installs merge-and-dedupe
inside a single atomic `updateLibrary`, and a library already corrupted on disk is healed
on load (`library-merge.ts`; `fixes/2026-09-05-fix-me-up/decision-log.md`, D3).

---

## 10. Reconciling, and the conflict UX

When a `reload` arrives, the client fetches the new revision, parses it, and only then
decides what to do — against the viewer's state *at that moment*, not at fetch time
(`decideReconcileAction`):

| Viewer state | Action |
|---|---|
| Mid-text-edit, or a write in flight | **defer** — hold the revision and retry when editing ends or the save settles. Never clobber a half-typed label; never raise a conflict that the in-flight write's own 412 will raise with fresher information. |
| Clean and idle | **apply** — load it through the guarded reload path, preserving viewport and theme, then advance the accepted revision. An external reload is never counted as a viewer save. |
| Dirty | **conflict** — the viewer and disk both hold work. |

A deferred reload is retried, never discarded. A parse failure or read error keeps the
scene, the dirty state and the accepted revision, and shows a retryable error — a dirty
editor is never dropped into read-only image mode because a parse failed.

### The conflict banner

A conflict — from the watcher *or* from a 412 on save, which enters the same state even
if the watcher never fired — raises a non-modal banner: **File changed on disk —
Reload from disk / Keep my changes**. While it is pending, queued auto-save timers are
cancelled and every automatic flush (max-wait, pointer-up, blur, close) is paused.

- **Reload from disk** fetches and parses successfully *before* discarding viewer edits.
  A failed reload leaves the conflict pending.
- **Keep my changes** acknowledges only the displayed revision as an expected overwrite
  for the next write. The scene stays dirty, the accepted baseline does not move, and
  the notice becomes *"Next save replaces the disk version"*. Dismissal never saves.
  With auto-save on, writes stay paused until an explicit Save succeeds. A **second**
  external revision must 412 rather than overwrite — it is a new decision.
- Escape/Cancel closes the modal but leaves the banner and the pause in place.

### `didClose` as an attention signal

Closing the buffer in Zed is the moment the user is most likely to walk away from
unreconciled work, so the LSP forwards it (off the dispatch loop) to `POST
/editor-closed`, which returns 204 and emits the `editor-closed` SSE event.

The viewer **reconciles disk first, then checks for a conflict** — which is what makes
close-before-watcher ordering safe. If a conflict is already pending, it escalates to a
modal, at most once per unresolved revision, so browsing across files does not stack
prompts. If there is nothing to reconcile, nothing happens at all. It never spawns,
focuses, shuts down, or discards anything, and it never steals window focus. If a native
close-confirmation dialog is already up, escalation waits for it to finish.

Save-and-close uses the same conditional save and reports a conflict through
`/native-action-result`, keeping the window open rather than overwriting a newer disk
version. An explicit "Don't Save" still closes and discards.

---

## 11. What is deliberately not connected

- **No in-editor pane.** The preview is a separate native window; Zed extensions cannot
  render into the workspace.
- **No slash commands.** Zed reserves the command registry for agents and rejects
  extension-provided commands (zed-industries/extensions#6468). Everything is driven by
  LSP notifications.
- **No buffer↔canvas live link.** `didChange` is ignored; disk is the only interchange.
- **No scene schema validation.** The bundled grammars highlight syntax; nothing checks
  the scene's shape. That would need a JSON language server, which would mean claiming
  the built-in JSON language — see §3.
- **`.excalidraw.png` click-to-viewer inside Zed** — not deferred, *unreachable*, for
  the four reasons in §3. Revisit only if Zed makes project items
  extension-registrable or lets `file_types` override `is_image_file`. If you want an
  image format that opens from a Zed click, that format is `.excalidraw.svg`: SVG is
  explicitly exempted from `is_image_file`, so it always gets a text buffer, and it
  embeds the scene exactly as PNG does.
