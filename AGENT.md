# AGENT.md — Excalidraw Preview for Zed

> Source of truth for AI agents working on this repo. `CLAUDE.md` is a symlink to it.
> This file records only what is **not derivable from the code**: intent, decisions and
> their reasons, platform traps, and where the deeper records live. Read the code for
> structure, routes, flags, and dependencies — they are the authority.

## What this is

A Zed extension that previews `.excalidraw`, `.excalidraw.svg`, and `.excalidraw.png`
files in a native WebView window (`wry`), live-reloading on save. Offline, no browser
tabs, no in-editor panes. Adapted from the VS Code extension vendored as the
`refs/excalidraw-vscode/` submodule.

Two components in one Cargo workspace:

- `extension/` — the Zed extension (`wasm32-wasip1`). Its only job is to find the
  companion binary (PATH first, then a cached/fresh GitHub Release download pinned by
  `BINARY_VERSION`) and spawn it with `--lsp`. It keeps no per-file state.
- `preview-binary/` — the native companion. One `main.rs` monolith holds the CLI, the
  axum server, the file watcher, the LSP loop, and the WebView; `webview-src/` is the
  React/Vite UI, whose build output is embedded at compile time.

Deeper records: `docs/handling-excalidraw-files.md` (how the three formats travel from
a click in Zed to the canvas, and how the editor pane and the viewer stay in step),
`docs/PRD.md` (requirements), `fixes/*/` and `features/*/` (dated
spec → plan → decision-log → reviews for each change; the newest decision-log is the
best "why is it like this" reference), `CONTRIBUTING.md` (dev loop).

## Decisions you must not silently reverse

**Language registration (Zed 1.18 compound-suffix bug).** Zed attaches a language
registered with a compound `path_suffixes` entry (`excalidraw.svg`) to the buffer but
never routes `textDocument/didOpen` to its server; only single-segment suffixes take the
exact-match path that delivers buffer events. So the extension claims `excalidraw`
("Excalidraw" language) and `svg` ("SVG" language), and the LSP filters
by filename (`is_excalidraw_path`) so plain `.svg` buffers are an idle no-op. Cost
accepted: plain `.svg` shows an attached idle server. Never reintroduce compound
suffixes; never attach the built-in JSON language (it would spawn the server for
every JSON file). `.excalidraw.png` is CLI-only inside Zed because the image pane
claims `*.png` before any buffer exists. This is unreachability, not a gap:
`is_image_file` (`crates/project/src/image_store.rs`) keys on the extension
alone; `ProjectItemRegistry::open_path` resolves last-registered-first and the
image viewer is registered after the editor, so **no buffer is created**;
`register_project_item` is not in `zed_extension_api`; and a task cannot
substitute because `ZED_FILE` is only populated from an active `Editor` item.
Do not re-litigate this without an upstream Zed change — the four gates are
recorded as finding 8 in `fixes/2026-09-05-lsp-strategy/spec.md`.
Corpus tests in `extension/src/lib.rs` parse the shipped TOML and pin all of this.
Evidence and repro: `fixes/2026-09-05-lsp-strategy/zed-compound-suffix-repro.md`;
upstream issue zed-industries/zed#63831.

**Highlighting comes from two bundled grammars, not from a language server.**
Each language pins a grammar in `extension.toml` (`json` for `Excalidraw`, `xml` for
`SVG`) with query files vendored beside its config at the same rev. Both must move
together — the registry packager rejects a language whose grammar is undeclared, and
it equally rejects pointing at another installed extension's grammar, which is why
`xml` is bundled here rather than borrowed from the XML extension. This buys syntax
colouring and visible parse errors only: nothing validates the *scene* schema, since
no JSON language server is attached (attaching one would mean claiming the built-in
JSON language, which the decision above forbids).

**No slash commands.** Zed reserves the slash-command API for agents and rejects
extension-provided commands (zed-industries/extensions#6468). The preview is driven
entirely by LSP notifications.

**LSP event semantics.** `didOpen` spawns a detached preview (which self-daemonizes
and dedups through a per-file lock; a live instance is focused instead). `didSave`
reopens a preview the user closed — Zed never re-sends `didOpen` for an open buffer, so
this is the only way back. `didChange` is deliberately ignored: typing must never open
or resurrect a viewer; the viewer follows disk. `didClose` is an **attention signal,
not teardown**: Zed reuses one preview tab for single-clicked files and sends
`didClose` whenever you browse away, so tearing the window down here made previews
flicker shut. The window owns its own lifecycle. The forward runs on a dedicated,
bounded, coalescing thread so no HTTP ever sits on the stdio dispatch path, and LSP
`shutdown`/`exit` never drains it.

**LSP logging is on stderr, always at info.** Zed files a language server's
stderr under that server's *Server Logs* (`crates/project/src/lsp_store/log_store.rs`
maps `IoKind::StdErr` to a log entry, same store as `window/logMessage`), so stderr
is this extension's only channel into the editor's UI — it has no notifications and
no palette. `--lsp` therefore installs its subscriber unconditionally at `info`
(`--debug` and `RUST_LOG` raise it), unlike the preview process where tracing is
behind `--debug`. The writer must stay `std::io::stderr`: tracing's default fmt
writer is *stdout*, which carries the JSON-RPC stream, so pointing it there corrupts
the protocol. Window open/close is not observable from the LSP process, so a
tracker thread follows the per-file locks of previews it asked for — presence means
the window is up, removal means it is gone. It polls off the dispatch path, blocks
entirely while nothing is tracked, and gives up after 15 s if no lock appears. A
preview killed without lock cleanup reports no close; accepted, because pinging
every tracked port twice a second is the worse trade. The spawned preview's own
stderr stays discarded: piping it back would tie the detached window's lifetime to
the editor's, which is exactly what detaching prevents.

**Disk is the interchange; saves are conditional.** The viewer and external editors
(Zed, git, CLI tools) share the file, so every write is `POST /data` with `If-Match`
carrying a strong content-hash ETag; the server re-reads inside a per-file mutex and
answers 412 on mismatch, 428 without the header. A missing file has the distinct
revision `"absent"` so a client can knowingly recreate it. This is optimistic
protection, **not** an atomic compare-and-swap: an uncooperative writer can still land
between the locked re-read and the write. That race is accepted by decision
(`fixes/2026-09-05-lsp-strategy/decision-log.md`, D1). The ETag is opaque — the
frontend echoes it byte-for-byte and never parses it.

**Echo suppression is by revision, never by time.** The watcher compares the disk
revision with the last revision the server itself wrote; equality *proves* an echo. An
elapsed-time window cannot tell a fast external edit from an echo, so the spec forbids
one.

**Watcher design.** The watch is on the file's *parent directory*, filtered to the
canonical target, because a watch on the file itself follows the old inode and misses
atomic replace (temp + rename) and delete/recreate. Events coalesce with trailing
reconciliation (quiet window plus a forced deadline from the burst's first event) so
the last event of a burst is never dropped. The notify→loop channel is bounded; a
dropped event sets an overflow flag that forces a reconcile, which is what makes
dropping safe. Deletion is an *unavailable* state, never an empty drawing and never a
reason to recreate the file.

**SSE is a hint, not state.** `reload`, `library`, and `editor-closed` are the only
wire names; clients dispatch explicitly and ignore unknown names. A lagged subscriber
receives a `reload` in place of missed frames (idempotent invalidation), so lag cannot
leave the view stale. The client always re-fetches bytes and ETag together and
re-checks live dirty/editing state *after* the awaits before applying.

**Conflict UX.** All canonical saves go through one `SaveQueue` so an older scene can
never land after a newer one. A 412 raises a non-modal "File changed on disk" banner
(Reload from disk / Keep my changes); `editor-closed` escalates a pending conflict to a
modal at most once per revision. While a conflict is pending all writes pause; after
"Keep my changes" only automatic writes stay paused until an explicit save succeeds,
and a *second* external revision must 412 rather than overwrite.

**Image-format files embed the scene on save.** Saving `.excalidraw.svg`/`.png`
passes `exportEmbedScene: true`; without it the file becomes an unloadable plain
image. The plain "Export PNG/SVG" menu items deliberately do *not* embed — those are
shareable images written to a different filename. An image with no embedded scene is
shown read-only with a banner rather than erroring.

**Document color mode round-trip.** One flag (`appState.exportWithDarkMode`) drives
the canvas theme, the baked rendering, and exports (WYSIWYG). Excalidraw treats the
key as per-browser state and strips it *both ways* — out of the scene it embeds, and
out of what `loadFromBlob` returns — so it cannot round-trip unaided. Three sources,
in priority order: `main.tsx` recovers it from the baked rendering before mount (SVG
exactly via excalidraw's root `invert(93%) hue-rotate(180deg)` filter marker; PNG
best-effort via corner luminance), then the appState key, then the OS/config theme.
Plain `.excalidraw` persists the key itself: **both** plain-JSON write sites go
through `serializeSceneForDisk`, which injects `appState.exportWithDarkMode` back
into the serialized text (a byte-stable splice, not a re-serialize), and the load
path re-attaches it from the raw bytes inside `parseDiskBytesWithFallbacks`. The
OS/config theme is fallback-only, for files that state no mode. **Both baked-mode
readers must answer `null` — never `false` — for a payload that is not actually of
the declared format**, because the content type comes from the file *name* and the
parse fallback chain absorbs a mismatch: an SVG reader that returns "no dark filter
found" for scene JSON out-ranks the key that same file states, and reopens a dark
document light (review 1, finding 1). Current
excalidraw.com strips the key on load, so the toggle does *not* pre-seed there —
recorded upstream behavior, not a regression of ours
(`fixes/2026-09-05-fix-me-up/decision-log.md`, D1).

**One library entry per library-item id.** The vendored `mergeLibraryItems` dedupes
by element *content*, not by id, so a re-delivered library whose elements were
re-stamped appends a second entry with the same id — and the vendored drag path then
inserts every entry matching the dragged id, which is what made one drag drop two
copies. Every flow that mutates or persists the library payload (seeding from
`GET /library`, Browse-install, SSE re-delivery, native import, debounced panel
persistence) therefore runs through one choke point, `dedupeLibraryItems`
(`library-merge.ts`) — survivor is the newest element `updated` at the id's
first-occurrence position, and a clean set is returned as the same reference. Installs
merge and dedupe inside a *single* `updateLibrary` function-form call so the panel
never transiently holds twins. Libraries already corrupted on disk are healed on load
and the heal is written back by the seeding `onLibraryChange` echo. Do not scatter
guards at the call sites; keep the invariant at that one auditable place
(`fixes/2026-09-05-fix-me-up/decision-log.md`, D3).

**A save gesture is never silent.** Explicit saves show Excalidraw's toasts or an
error banner — but a read-only image preview (and a failed load, and the pre-mount
window) has no React app, so the native File → Save script's old
`window.__excalidrawSave && …` form evaluated to nothing at all. `main.tsx` registers
`window.__excalidrawSaveUnavailable` at module scope, before any await, on every load
path; `SAVE_MENU_SCRIPT` falls back to it, and `doSave`'s no-API early return calls
it too. The two sides are joined only by that string, so tests pin it against the
shipped bundle. Nothing at all in response to a save gesture is a defect, not a
no-op.

**Clipboard goes through Rust.** WKWebView rejects the page's async clipboard write
after the SVG is `await`-generated (the await drops user activation), so "Copy SVG to
clipboard" POSTs to the server for a native clipboard write.

**Library browsing is a system-browser round-trip.** "Browse libraries" opens
libraries.excalidraw.com externally with a return URL on the local server; the server
fetches the chosen `.excalidrawlib` itself from an allow-list of https hosts (SSRF
guard), queues it, and notifies the WebView over SSE.

## Platform traps

- **Use the `localhost` hostname, not `127.0.0.1`, for the WebView URL.** The server
  binds the loopback IP, but WebKit treats only `localhost` as a secure context; a bare
  IP leaves `navigator.clipboard` undefined and breaks Excalidraw copy/paste (including
  between two preview windows).
- **macOS close dialog re-entrancy.** `NSAlert.runModal()` pumps the run loop and
  re-enters the event-loop closure on its 100 ms tick. The `CloseFlow` must leave the
  `Querying` state *before* the dialog is shown, or the re-entrant tick re-polls the
  consumed oneshot, sees the cached dirty state, and reopens the dialog forever. Linux
  uses an async dialog but must satisfy the same invariant.
- **macOS needs an Edit menu for clipboard shortcuts.** AppKit only delivers
  Cmd+C/V/X/A/Z to the WKWebView when the menu bar has an Edit menu wired to the
  standard selectors; without it only the right-click menu can copy/paste. Linux
  delivers them natively, so its in-WebView menu needs none. Cmd+S is the File → Save
  accelerator.
- **Linux WebKitGTK** needs `libwebkit2gtk-4.1-dev` (or 4.0); fail with a clear
  message if it is missing.
- **`window.EXCALIDRAW_ASSET_PATH`** must be set in an inline `<script>` *before* the
  module script, or Excalidraw cannot fetch fonts/wasm.
- **Lock file** `$TMPDIR/excalidraw-{sha256(canonical path)}.lock` holds the live
  port and must be removed on every exit path (window close, `/shutdown`). A stale one
  is harmless: launch probes `/ping` and replaces it. The LSP's `didClose` forwarder
  only *reads* it — lock lifecycle belongs to the preview process alone.
- **Format is detected by extension, never by sniffing**; the client's fallback chain
  handles mismatches.
- **Window title** resolves the git repo with `gix::discover` from the file's *parent*
  directory (handing it a file path errors) and labels with the *main* repo's directory
  name so linked worktrees show the project, not the worktree dir.
- **Window size** is persisted on `LoopDestroyed` because the tao event loop never
  returns; saving "after `run`" would be dead code.

## Build, test, run

- `preview-binary/assets/` (the Vite output) is **gitignored** and embedded at compile
  time. Build order matters: `just build` runs `ui` first; a bare `cargo build` after
  `cargo clean` embeds nothing. After any webview change, `just ui && just build` or the
  shipped binary keeps the old bundle. CI does the same before cargo.
- `just` lists recipes. The ones that matter: `build`, `build-ext` (WASM), `release`,
  `test` (nextest + `tsc --noEmit` + vitest), `smoke` (real WebView self-test; needs a
  display; CI runs it under Xvfb), `dev` (Vite + WebView with HMR; `DEV_FILE=…`),
  `symlink` (one-time, puts the release binary on PATH so the extension prefers it),
  `install-locally`, and `bump <version>` → `publish` (tag-triggered release workflow;
  both require a clean `main`).
- Dev server accepts any file without restart: `http://localhost:5173?file=/abs/path`.
- Install the extension into Zed with the command palette → "zed: install dev
  extension" → `./extension`. There is no CLI for this, which is why the real-Zed
  acceptance checklist in `fixes/2026-09-05-lsp-strategy/acceptance-checklist.md` is
  still marked *not performed* and gates publishing.
- `EXCALIDRAW_PREVIEW_HEADLESS=true` (or `--headless`) runs the server without a
  window and propagates to LSP-spawned previews, so integration tests drive
  `didOpen`/`didSave` windowless. `--export-dir` bypasses the native save dialog.
- Tests avoid fixed sleeps: wait for observable revisions with bounded deadlines.
  nextest's "leaky" annotation fires under parallel load here and is not a real leak
  (decision-log D12). The Windows twins of Unix-only tests only *run* on Windows, but
  they do type-check from macOS: `cargo check --target x86_64-pc-windows-gnu -p
  excalidraw-preview-binary --all-targets` (with
  `CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc`) is clean, covering every
  `#[cfg(target_os = "windows")]` path including `menu.init_for_hwnd`. It is the
  **MSVC** target that fails, in `aws-lc-sys` for want of `windows.h` — a missing
  Windows SDK, not our code — so an MSVC artifact still has to be built on a Windows
  host. A `-gnu` check compiles; it links nothing and runs nothing, so it can stand in
  for a compile review and never for a Windows test result.

## Conventions

- `anyhow::Result` for errors; no `unwrap` on production paths; `tracing` behind
  `--debug`; no `unsafe` beyond what `wry`/`tao`/`objc2` require; `rustfmt` defaults and
  `clippy -- -D warnings` clean; doc comments on every public item using `##` sections
  (Examples, Returns, Errors, Panics, Safety, Notes).
- WASM extension code may only use `zed_extension_api::process::Command` and
  `zed::http_client_get` — no sockets, no `std::process`.
- TypeScript strict, no `any`; tested modules inject their I/O so vitest runs in the
  `node` environment.
- Version bumps touch four sites (`extension.toml`, both `[package]` versions,
  `BINARY_VERSION`) — always use `just bump`.
- Do not commit unless asked; releases are a separate, gated step.
