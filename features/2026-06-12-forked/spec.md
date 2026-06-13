# Spec: Project Takeover & Hardening — Excalidraw Preview for Zed

**Date:** 2026-06-12
**Status:** Approved design, awaiting implementation plan

## Context

This repo is owned by me but I just forked it from `arindampradhan/excalidraw-zed-extension`, which works to a large degree but has annoying bugs and appears to be unmaintained. The intention is to take over the implementation.

The fork is hosted at `https://github.com/yankeeinlondon/excalidraw-zed-extension`.

### Current state (verified by code review)

Already working in the upstream code:

- Companion native binary (`preview-binary/`): axum HTTP server + wry WebView, SSE live-reload on external file change, manual save (Ctrl+S / Cmd+S) and `--auto-save` mode, lock-file based instance reuse with `/focus` + `/ping`, LSP mode (`--lsp`) that auto-opens previews on `textDocument/didOpen`.
- Zed extension (`extension/`): `/preview-excalidraw` slash command, language-server registration, binary resolution (PATH → cached → GitHub release download).
- All three file formats: `.excalidraw` (JSON), `.excalidraw.svg`, `.excalidraw.png`, with a load-time fallback chain.
- Multi-platform release workflow (`.github/workflows/release.yml`).

Broken or missing:

- **Exports do nothing.** `App.tsx` uses Excalidraw's stock `SaveAsImage`/`Export` menu items, which save via browser download APIs. wry WebViews (WKWebView, WebKitGTK, WebView2) have no download handler wired, so exports silently vanish.
- **Binary downloads point at upstream.** `extension/src/lib.rs` downloads release binaries from `arindampradhan`'s repo.
- **No way to create a new drawing from within Zed.**
- **Library ("clipart") items don't persist.** `App.tsx` wires neither `initialData.libraryItems` nor `onLibraryChange`, so library panel additions are lost between sessions. The "Browse libraries" excalidraw.com round-trip is also dead in a WebView.
- **Windows is untested.** Known code-review issue: the extension backgrounds the binary via `sh -c "nohup … &"`, and `sh` does not exist on Windows.
- **Instance-reuse double mechanism.** The extension derives a port by hashing the file path (`20000 + hash % 10000`) — two files can collide and the port may already be in use — while the binary separately maintains lock files. Two overlapping mechanisms, one of them buggy.

## Goals

1. Full takeover: rebrand, release pipeline under this fork, publish to the Zed extension registry.
2. Fix exports (the one confirmed reproducible breakage).
3. Add "new Excalidraw drawing" creation flows.
4. Fix instance-reuse port collision; fix Windows spawn at code-review level.
5. Persist the user's shape library across sessions and diagrams.
6. Replace the Makefile with a `justfile`.

## Non-goals

- Structural refactor of `preview-binary/src/main.rs` (954-line monolith stays until a change forces a split).
- "Browse libraries" integration with excalidraw.com (documented known limitation).
- Fully verified Windows support (best-effort: CI builds + code-review fixes; verification deferred until a Windows machine is in the loop).
- Real-time collaboration, browser-tab preview, or in-editor panes (per PRD).

---

## 1. Takeover & Infrastructure

### 1.1 Rebrand

- `extension/extension.toml`: set `authors` to Ken Snyder, `repository` to `https://github.com/yankeeinlondon/excalidraw-zed-extension`.
- `extension/src/lib.rs`: change the release-download URL to `https://github.com/yankeeinlondon/excalidraw-zed-extension/releases/download/...`.
- Update `README.md` and `AGENT.md` references to the upstream repo.
- Extension id stays `excalidraw-preview` (complies with Zed naming rules; not registered upstream, so no conflict).

### 1.2 Release pipeline

- Keep the existing `release.yml` matrix (macOS arm64 + x64, Linux x64, Windows x64); verify it runs green on this fork.
- Add a test CI workflow (currently none exists): on push/PR, install nextest from prebuilt binary and run `cargo nextest run --profile ci` plus the webview vitest suite. The `ci` nextest profile emits JUnit XML.
- Release assets must match the naming convention `lib.rs` expects: `excalidraw-preview-{arch}-{os}[.exe]` (e.g. `excalidraw-preview-aarch64-apple-darwin`).
- First release under new ownership is tagged `v0.2.0`; `BINARY_VERSION` in `lib.rs`, `version` in `extension.toml`, and `version` in `extension/Cargo.toml` must all be `0.2.0`.

### 1.3 Zed registry publishing

- Move/copy the `LICENSE` so it exists at the repo root (currently only in `extension/`).
- Fork `zed-industries/extensions` (personal account), add this repo as a git submodule under `extensions/excalidraw-preview`, add the `extensions.toml` entry, run `pnpm sort-extensions`, open the PR.
- Publishing happens after the export fix and rebrand ship (users installing from the registry must get working binaries from this fork).

### 1.4 justfile

- Replace `Makefile` with a `justfile` carrying over all targets with the same semantics: `build` (default: UI + release binary), `build-debug`, `ui`, `release`, `symlink`, `dev`, `dev-ui`, `dev-window`, `clean`.
- Delete the Makefile; update `AGENT.md`, `README.md`, and CI references from `make` to `just`.
- New `test` recipe: `cargo nextest run` followed by `cargo test --doc` (nextest doesn't run doctests).

### 1.5 Test runner: nextest

- Add `.config/nextest.toml` with `default` and `ci` profiles (`inherits = "default"`). Rationale: the §5 integration tests spawn child processes, bind ports, and write lock files — nextest's process-per-test isolation, `leak-timeout` (catches orphaned preview processes, one of the bug categories this spec fixes), and `slow-timeout` directly target their failure modes.
- `ci` profile: bounded retries (≤3) for timing-sensitive tests, `fail-fast = false`, JUnit output, `slow-timeout` with termination so hung SSE/watcher tests can't wedge CI.
- Local `default` profile: no retries (flakes stay visible during development).

### 1.6 Documentation

- README gains a "Creating a new drawing" section: right-click in the project panel → New File → name it `whiteboard.excalidraw` → blank canvas preview opens (the §3.1 bootstrap flow). Include a copy-paste `tasks.json` snippet wiring Zed's `task: spawn` to `excalidraw-preview --new` for users who want a palette-adjacent entry point.
- README documents the known Zed extension-API limitations that shape this design: extensions cannot add command-palette actions, context-menu items, or custom editor panes (tracked upstream in zed-industries/zed#8441 and #18043). If Zed ships extension-registered actions, a `new excalidraw drawing` palette action becomes the primary creation entry point — it would be a thin wrapper over the `--new` flag, which is built in §3.3.

---

## 2. Export Fix

**Design principle:** route exports through the Rust server using the same pattern as the already-working save path (`POST /data`), and show a native OS save dialog.

### 2.1 Server: `POST /export`

- New axum route. Request body = exported bytes. Suggested filename and MIME type passed via query params or headers.
- Handler opens a native save dialog via the `rfd` crate (new dependency), defaulting to the source file's directory and a suggested name derived from the diagram (`diagram.png`, `diagram.svg`, `diagram.excalidraw`).
- On confirm: write bytes to the chosen path, return 200 with the written path. On cancel: return 204. On write error: 500 with message.
- **Platform constraint:** native dialogs must run on the platform UI thread — the tao event loop (via event-loop proxy) on macOS/Windows, the GTK main context on Linux (the binary already uses a GTK window there, see `docs/CHALLENGES.md`). The handler must marshal the dialog call there rather than calling `rfd` from a tokio worker thread.

### 2.2 WebView: custom export menu

- In `App.tsx`, remove `MainMenu.DefaultItems.SaveAsImage` and `MainMenu.DefaultItems.Export` (dead UI).
- Add custom menu items that generate bytes client-side with the already-imported `exportToSvg` / `exportToBlob` / `serializeAsJSON` and `POST /export`:
  - Export PNG (1x and 2x scale)
  - Export SVG
  - Export scene (`.excalidraw` JSON)
- Show a toast/notification with the written path on success, or the error message on failure.

### 2.3 Testability

- A `--export-dir <dir>` debug/test flag bypasses the dialog and writes exports directly into `<dir>`, so integration tests can exercise the full route without a UI.

---

## 3. New Drawing Creation

Blank-scene generation lives in exactly one place: the Rust binary. A blank scene is:

```json
{ "type": "excalidraw", "version": 2, "source": "excalidraw-zed-preview", "elements": [], "appState": { "gridSize": null, "viewBackgroundColor": "#ffffff" }, "files": {} }
```

For `.excalidraw.svg` / `.excalidraw.png` targets, the binary writes the equivalent blank scene exported in that format (with embedded scene data).

Three entry points, all in scope:

### 3.1 Empty-file bootstrap (primary flow)

- When the preview binary opens a target file that is empty (0 bytes) or whitespace-only, it writes the blank scene to disk before serving it.
- Combined with the existing LSP `didOpen` hook, Zed's native "new file → save as `foo.excalidraw`" flow opens a blank-canvas preview with no extra commands.

### 3.2 Slash command

- New `[slash_commands.new-excalidraw]` in `extension.toml`, `requires_argument = false`.
- `/new-excalidraw [name]` creates `name.excalidraw` (default `untitled-N.excalidraw`, first N that doesn't exist) in the worktree root, then spawns the preview on it.
- Errors if the named file already exists. Delegates file creation to the binary via `--new`.

### 3.3 CLI flag

- `excalidraw-preview --new <path>`: create `<path>` with a blank scene (format chosen by extension) and open the preview window.
- Errors if `<path>` already exists.

---

## 4. Bug Fixes

### 4.1 Instance reuse: single mechanism, no port hashing

- The extension stops choosing ports. Remove `port_for_path`, the `--port` argument from the spawn, and the in-memory `process_map`.
- The extension always just spawns the binary. The binary's existing lock-file check (`$TMPDIR/excalidraw-{sha256(path)}.lock`) handles dedup: if a live instance exists (`/ping` succeeds), it sends `/focus` and exits; if stale, it removes the lock and starts fresh on an ephemeral port written to the lock file.
- Result: one mechanism, no collisions, no fixed-port conflicts.

### 4.2 Windows spawn (best-effort)

- Replace the `sh -c "nohup … &"` spawn with a cross-platform approach: the binary detaches itself from the parent (daemonize on Unix; `CREATE_NEW_PROCESS_GROUP`/`DETACHED_PROCESS` flags or equivalent self-detach on Windows), so the extension can use `zed_extension_api::process::Command` directly with no shell.
- CI builds and releases Windows binaries. Full Windows verification is deferred (no test machine); any further Windows fixes land in a follow-up.

### 4.3 Library ("clipart") persistence

- `App.tsx`: pass `initialData.libraryItems`, wire `onLibraryChange` to a debounced `POST /library`.
- Server: `GET /library` / `POST /library` routes backed by a single shared file at `{dirs::config_dir()}/excalidraw-zed/library.excalidrawlib` (so `~/.config/excalidraw-zed/…` on Linux, `~/Library/Application Support/excalidraw-zed/…` on macOS), so the library follows the user across diagrams and sessions.
- Known limitation (documented in README): the "Browse libraries" button's excalidraw.com round-trip does not work inside the WebView.

### 4.4 Click-to-preview for `.excalidraw.svg` / `.excalidraw.png`

- Today only plain `.excalidraw` files are registered to the "Excalidraw" language, so only they auto-open a preview on click; the SVG/PNG variants fall through to Zed's normal SVG/image handling.
- Fix: extend `extension/languages/excalidraw/config.toml` to `path_suffixes = ["excalidraw", "excalidraw.svg", "excalidraw.png"]`. Zed matches path endings, so plain `.svg`/`.png` files are unaffected.
- **Must be verified empirically for PNG:** it is unknown whether Zed's built-in image viewer takes precedence over the language registration for `.excalidraw.png`. If the image viewer wins (no `didOpen` → no auto-preview), document the slash command as the entry point for PNGs and note it as a known limitation.
- Side effect (accepted): `.excalidraw.svg` opens in Zed's text buffer with the JSON grammar rather than XML — a fair trade since exported SVGs are rarely hand-edited.

### 4.5 Image insert/paste — verification only

- Spec'd as test cases, not feature work: insert image via toolbar file picker; paste image from clipboard; confirm base64 data lands in the scene's `files` object and survives save → reload. Fix only if verification fails.

---

## 5. Testing

- **Rust unit tests:** blank-scene bootstrap (all three formats; empty vs whitespace vs non-empty files), `POST /export` handler with `--export-dir` (status codes, bytes written), lock-file dedup logic.
- **Vitest (webview):** export menu items POST correct bytes/MIME to `/export` (mocked fetch); existing format-fallback-chain tests keep passing.
- **Integration script:** spawn the binary against a temp `.excalidraw` file → assert `/ping` 200, `/config` content type, `/data` round-trip, SSE fires within 150 ms of file mutation, `POST /export` writes bytes under `--export-dir`.
- **Manual checklist (per platform — macOS now, Linux now, Windows best-effort/deferred):**
  - Open each of the three formats; edit; Ctrl+S persists to disk; external edit in Zed live-reloads without resetting viewport.
  - Click each of the three formats in the project panel → preview auto-opens (PNG outcome recorded per §4.4; document fallback if the image viewer wins). Plain `.svg`/`.png` files do NOT trigger the Excalidraw language.
  - Export PNG (1x, 2x), SVG, and scene JSON via the new menu; files land where chosen.
  - New drawing via: empty-file save-as, `/new-excalidraw`, and `--new`.
  - Add a library item; restart preview; item is still present.
  - Insert and paste images; save; reload; images intact.
  - Invoke preview twice on the same file → second invocation focuses the existing window.

## Acceptance criteria

1. A fresh Zed install with this extension (no PATH binary) downloads the binary from `yankeeinlondon`'s releases and opens previews on all three formats.
2. Export PNG/SVG/scene produces a file on disk via a native save dialog on macOS and Linux.
3. Saving a new empty `foo.excalidraw` in Zed opens a blank, editable canvas whose content is a valid Excalidraw scene on disk.
4. `/new-excalidraw` and `excalidraw-preview --new` both create and open blank drawings; both refuse to overwrite existing files.
5. Two different files preview simultaneously without port conflicts; re-invoking on an open file focuses its window.
6. Library items persist across preview restarts and are shared between different diagram files.
7. `just` replaces `make` for every documented workflow; CI is green; `v0.2.0` release assets exist for all four targets.
8. Extension is submitted to the Zed extension registry.
9. Clicking a `.excalidraw` or `.excalidraw.svg` file auto-opens the preview; `.excalidraw.png` does too if the language registration beats the image viewer (else documented limitation). Ordinary `.svg`/`.png` files are unaffected.

## Milestones

| # | Deliverable |
|---|---|
| T1 | Rebrand + repoint downloads + justfile + CI green on fork |
| T2 | Export fix (`POST /export` + rfd dialog + custom menu) |
| T3 | New-drawing flows (`--new`, empty-file bootstrap, slash command) |
| T4 | Instance-reuse fix + Windows spawn fix |
| T5 | Library persistence + image-import verification |
| T6 | `v0.2.0` release + Zed registry submission |
