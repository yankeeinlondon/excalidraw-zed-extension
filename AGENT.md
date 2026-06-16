# AGENT.md — Excalidraw Preview for Zed

> This file is the source of truth for AI agents working on this repo.
> `CLAUDE.md` is a symlink to this file.

## Project Purpose

A Zed editor extension that previews `.excalidraw` files in a native WebView window (powered by `wry`). The preview live-reloads on file save. No browser tabs. No in-editor UI panes. Pure offline, near-zero-latency diagram preview.

Supports all three Excalidraw file formats: `.excalidraw` (JSON), `.excalidraw.svg`, `.excalidraw.png`.

See [`docs/PRD.md`](docs/PRD.md) for the full product requirements.
See [`refs/excalidraw-vscode/`](refs/excalidraw-vscode/) (git submodule) for the reference implementation this is adapted from.

---

## Repository Layout

```
excalidraw-zed-extension/
│
├── AGENT.md                        ← you are here (source of truth)
├── CLAUDE.md                       ← symlink → AGENT.md
├── docs/
│   └── PRD.md                      ← full product requirements doc
│
├── extension/                      ← Zed extension (Rust → WASM)
│   ├── Cargo.toml
│   ├── src/
│   │   └── lib.rs                  ← language server: download + spawn binary (--lsp)
│   └── extension.toml              ← Zed extension manifest
│
├── preview-binary/                 ← companion native binary
│   ├── Cargo.toml
│   ├── src/
│   │   └── main.rs                 ← CLI entry, all routes, file watcher, WebView (monolith)
│   ├── tests/                      ← Rust integration tests (spawn binary, hit routes)
│   ├── webview-src/                ← React + Vite source (npm project)
│   │   ├── package.json            ← @excalidraw/excalidraw ^0.18, react ^18, vite
│   │   ├── vite.config.ts          ← prod: assets only; dev: mock API plugin for any file
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx            ← fetch /config + /data → loadFromBlob → render, SSE
│   │       ├── App.tsx             ← <Excalidraw> editor, Ctrl+S / auto-save, SSE reload
│   │       └── export.ts           ← client-side export helpers → POST /export
│   └── assets/                     ← Vite build output; committed; embedded at compile time
│       ├── index.html              ← served at GET /
│       └── assets/
│           ├── index-[hash].js     ← React + Excalidraw bundle
│           ├── index-[hash].css
│           └── *.woff2, *.wasm     ← Excalidraw runtime assets (GET /assets/*)
│
├── refs/
│   └── excalidraw-vscode/          ← git submodule: VS Code reference implementation
│
├── .claude/
│   └── skills/
│       └── zed-extension/
│           └── SKILL.md            ← Zed extension scaffolding skill
│
├── .config/
│   └── nextest.toml                ← nextest profiles (default + ci)
│
├── justfile                        ← build/dev/test recipes (replaces Makefile)
└── Cargo.toml                      ← workspace root
```

---

## Workspace Cargo.toml (root)

```toml
[workspace]
members = [
    "extension",
    "preview-binary",
]
resolver = "2"
```

---

## Component 1 — Zed Extension (`extension/`)

**Target:** `wasm32-wasip1`
**Crate type:** `cdylib`

### extension.toml

```toml
id = "excalidraw-preview"
name = "Excalidraw Preview"
version = "0.1.0"
schema_version = 1
authors = ["you"]
description = "Preview .excalidraw files in a native window"
repository = "https://github.com/you/excalidraw-zed-extension"

[language_servers.excalidraw-preview]
name = "Excalidraw Preview"
language = "Excalidraw"
languages = []
```

The extension does **not** register slash commands. An earlier version exposed
`/preview-excalidraw` and `/new-excalidraw`, but Zed reserves the slash-command API
for agent use and won't accept extension-provided commands into the registry yet
(see PR zed-industries/extensions#6468). The preview is driven entirely through the
language server instead — opening a `.excalidraw*` file auto-spawns the preview.

### extension/src/lib.rs — responsibilities

1. Implement `zed_extension_api::Extension` trait.
2. In `language_server_command`, resolve the companion binary and spawn it as the
   language server with `--lsp`. Binary resolution order: `PATH` (dev / `just symlink`)
   → cached download → fresh download from GitHub Releases `v{BINARY_VERSION}`.
3. That's it for the extension. The `--lsp` server *inside the binary* owns the rest:
   `didOpen`/`didSave` spawn the detached preview, which self-daemonizes and dedups via
   its lock file (focusing an existing window rather than opening a duplicate). The
   extension keeps no per-file state and issues no HTTP pings.

**Key constraint:** WASM extensions cannot open sockets or use `std::process`.
Use `zed_extension_api::process::Command` and `zed::http_client_get` only.

### Language registration (`extension/languages/excalidraw/config.toml`)

Registers the "Excalidraw" language (grammar `json`, language server `excalidraw-preview`)
with `path_suffixes = ["excalidraw", "excalidraw.svg", "excalidraw.png"]`. Zed matches path
*endings*, so all three Excalidraw variants get the language server (and its `didOpen`
auto-preview) while plain `.svg`/`.png` files are unaffected. Trade-off: `.excalidraw.svg`
opens in Zed's text buffer with the JSON grammar rather than XML.

---

## Component 2 — Companion Binary (`preview-binary/`)

**Target:** native (x86_64/aarch64, macOS/Linux/Windows)

**Note:** all server, watcher, webview, and asset logic lives in a single `main.rs` (monolith); the AGENT.md originally described separate files that were never split out.

### CLI

```
excalidraw-preview <file-path> [--port <port>] [--auto-save] [--debug]
excalidraw-preview --new <path> [--auto-save] [--debug]
excalidraw-preview --lsp
excalidraw-preview --dev
excalidraw-preview --dev-server <url>
```

Additional flags:

| Flag | Description |
|---|---|
| `--new <path>` | Create `<path>` as a new blank drawing (format from extension) and open the preview. Fails if the file already exists. Conflicts with the positional file arg. |
| `--foreground` | Internal: run in the foreground without self-detaching. Set automatically on re-spawn (hidden). |
| `--headless` | Run the HTTP server without opening a WebView window (tests / headless environments). Also enabled by `EXCALIDRAW_PREVIEW_HEADLESS=true`, which propagates to LSP-spawned previews so `didOpen`/`didSave` can be integration-tested windowless. |
| `--export-dir <dir>` | Write exports directly into `<dir>` instead of showing a native save dialog. Intended for tests and headless use. |
| `--smoke` | Open a real WebView and run an automated self-test: drive the native→JS bridge (save, close-interception query) and external-link classification, print a PASS/FAIL report, then exit (0 = all passed, 1 = any failed). Implies `--foreground`, overrides `--headless` (needs a window). Run via `just smoke`. See `features/2026-06-13-rough-edges/manual-checklist.md`. |

### Startup sequence

1. Parse args with `clap`.
2. If `--lsp`: run JSON-RPC LSP server loop (Zed language server integration).
3. If `--dev` / `--dev-server`: open WebView at the Vite dev server URL directly.
4. Otherwise: detect file format from extension → MIME type string.
5. Check lock file `$TMPDIR/excalidraw-{sha256(canonical_path)}.lock`.
   - If live (`GET /ping` succeeds) → send `GET /focus` and exit.
   - If stale → remove and continue.
6. Bind axum server on ephemeral port (or `--port`).
7. Write port to lock file.
8. Spawn file watcher thread (notify v6, 80 ms debounce → broadcast channel).
9. Open WebView window at `http://localhost:{port}` (the server binds `127.0.0.1`;
   the WebView uses the `localhost` *hostname* deliberately — WebKit only treats
   `localhost` as a secure context, and a bare loopback IP leaves
   `navigator.clipboard` undefined, breaking Excalidraw copy/paste).
10. On window close: remove lock file, shut down server.

### HTTP Routes

| Route | Description |
|---|---|
| `GET /` | Serve embedded `index.html` |
| `GET /config` | JSON: `{ contentType, name, theme, autoSave }` |
| `GET /data` | Read file from disk, return bytes with correct `Content-Type` |
| `POST /data` | Write request body back to disk (save from WebView) |
| `GET /library` | Read the shared library file; return its `.excalidrawlib` JSON |
| `POST /library` | Persist library items to the shared library file |
| `GET /library-install` | Landing page for the "Browse libraries" round-trip (`libraryReturnUrl`); reads `#addLibrary=<url>` and POSTs it to `/install-library` |
| `POST /install-library` | `{ libraryUrl }`: server-side fetch (allow-listed https hosts) of the chosen `.excalidrawlib`, validate, queue it, broadcast `library` |
| `GET /pending-library` | Drain queued installs as `{ libraries: [rawDoc, …] }` for the WebView to feed to `updateLibrary` |
| `POST /export` | Receive exported bytes; write via native save dialog (or `--export-dir`) |
| `GET /events` | SSE stream; emit `data: reload` on file change, `data: library` after a "Browse libraries" install |
| `GET /focus` | Signal WebView window to call `window.set_focus()` |
| `GET /ping` | 200 OK liveness probe |
| `GET /shutdown` | Graceful shutdown (window close, or test teardown) |
| `GET /assets/*` | Serve embedded assets (rust-embed, MIME via mime_guess) |

### AppState fields

```rust
struct AppState {
    file_path: PathBuf,
    lock_path: PathBuf,
    content_type: String,   // MIME string
    file_name: String,
    auto_save: bool,        // forwarded to /config → frontend
    broadcast_tx: broadcast::Sender<PreviewEvent>,      // SSE: Reload (file) / Library (install)
    focus_tx: Arc<watch::Sender<bool>>,
    export_tx: std::sync::mpsc::Sender<ExportRequest>, // POST /export → UI-thread dialog
    export_dir: Option<PathBuf>,                        // --export-dir: bypass dialog
    pending_libraries: Arc<Mutex<Vec<String>>>,         // queued "Browse libraries" installs
}
```

Library browse/install flow (offline-friendly, since the click lands in the system
browser, not the WebView):

1. `<Excalidraw libraryReturnUrl={origin + "/library-install"}>` — the built-in
   "Browse libraries" button opens libraries.excalidraw.com in the system browser
   with this return URL.
2. "Add to Excalidraw" there redirects the browser to `…/library-install#addLibrary=<url>`.
3. `GET /library-install` serves a tiny page that reads the fragment and `POST`s the
   URL to `/install-library`.
4. The server fetches the raw `.excalidrawlib` (allow-listed https hosts only — SSRF
   guard), validates it, queues it, and broadcasts `PreviewEvent::Library`.
5. The WebView's SSE handler runs `window.__excalidrawApplyPendingLibraries`, which
   drains `GET /pending-library` and feeds each raw doc to `updateLibrary` as a Blob
   (Excalidraw parses both v1 `library` and v2 `libraryItems`); `onLibraryChange`
   then persists the merged set via `POST /library`.
```

### ConfigResponse (camelCase via serde)

```json
{ "contentType": "application/json", "name": "diagram", "theme": "auto", "autoSave": false }
```

### LSP server

Implements a minimal JSON-RPC LSP so Zed can invoke the binary as a language server for `.excalidraw` files:
- `textDocument/didOpen` → spawns `excalidraw-preview <path>` as a detached process
- `textDocument/didClose` → **no-op.** The preview persists until the user closes its
  window. Zed reuses one "preview tab" for single-clicked files and sends `didClose`
  whenever you browse to another file, so tearing the window down here made previews
  flicker shut while navigating. The window owns its own teardown (close button → lock
  cleanup + server shutdown).
- `textDocument/didSave` → reopens a preview the user closed (spawns only if no live
  instance). This is the way to bring back a preview after closing its window, since
  Zed does not re-send `didOpen` for an already-open buffer.
- `initialize` / `shutdown` / `exit` handled normally

---

## Component 3 — Web UI (`preview-binary/webview-src/`)

### vite.config.ts

Uses Vite's function-form config to split prod vs dev cleanly:

- **Production build** (`vite build`): only the React plugin runs. No file watchers, no mock server, no `execSync`. Build exits immediately.
- **Dev server** (`vite dev`): a `mockApiPlugin()` is activated that implements the full API (`/config`, `/data`, `/events`) using the local filesystem, mirroring the Rust server.

### Dev server — any file via `?file=` param

In dev mode, open any excalidraw file without restarting the server:

```
http://localhost:5173?file=/absolute/path/to/diagram.excalidraw
http://localhost:5173?file=/absolute/path/to/other.excalidraw.svg
```

Multiple tabs work independently — each `?file=` gets its own SSE client set and `fs.watch` handle. Defaults to `DEV_FILE` env var or `preview-binary/test.excalidraw` if no param is given.

### main.tsx — startup sequence

```ts
// ?file= query param forwarded to all API calls in dev; ignored (absent) in prod.
const fileParam = new URLSearchParams(window.location.search).get("file");
function apiUrl(path) { return fileParam ? `${path}?file=${encodeURIComponent(fileParam)}` : path; }

const config = await fetch(apiUrl('/config')).then(r => r.json());
// config: { contentType, name, theme, autoSave }

// Resolve "auto" theme once before React mounts (avoids matchMedia issues in WebKitGTK).
if (config.theme === "auto") config.theme = window.matchMedia(...).matches ? "dark" : "light";

const bytes = await fetch(apiUrl('/data')).then(r => r.arrayBuffer());

// Format fallback chain: try declared type first, then the other two.
for (const type of reorderFallbacks(config.contentType)) { ... }

// If every fallback fails AND the file is image/svg+xml or image/png, the scene
// can't be reconstructed (the image was exported without an embedded scene).
// renderReadonlyImage() then shows the raw image read-only with a banner instead
// of erroring, so the user still gets a preview (editing is disabled).

// SSE live reload — calls reloadScene() provided by App.
const es = new EventSource(apiUrl('/events'));
es.onmessage = debounce(async () => {
  const newData = await loadFromBlob(...);
  reloadScene?.(newData);   // skips if editingElement is active; never resets viewport/theme
}, 150);
```

### App.tsx — save modes

**Manual save (default):** Ctrl+S / Cmd+S or "Save to file" menu item → `POST /data`.

**`.excalidraw.svg` / `.excalidraw.png` saves embed the scene.** The canonical-file save
path passes `appState.exportEmbedScene: true` to `exportToSvg` / `exportToBlob`, so the
written file carries the recoverable scene JSON and round-trips back into the editor.
Without it, saving an image-format file strips the scene and the file becomes an
unloadable plain image. (The plain "Export PNG/SVG" menu items in `export.ts`
deliberately do *not* embed — those are clean shareable images written to a different
filename.)

**Export menu — converting a `.excalidraw` to `.excalidraw.svg`.** The "Export editable
SVG (.excalidraw.svg)" menu item (`ExportKind` `"svg-scene"`) writes a scene-embedded SVG
via the native save dialog, giving a graceful conversion path from a JSON scene to an
editable `.excalidraw.svg`. Equivalently, copy/paste between two preview windows works now
that the WebView loads from a secure-context `localhost` origin (see startup step 9).

**Auto-save:** when `autoSave` prop is `true` (set from `config.autoSave`), `onChange` is wired to a debounced save (600 ms). Only fires when element hash changes (not on viewport/selection events).

**SSE reload (`reloadScene`):**
- Passed to `main.tsx` via `onReloadReady` callback.
- Skips update if `api.getAppState().editingElement` is non-null (user is typing).
- Calls `api.updateScene({ elements, files })` only — never passes `appState`, so viewport position and theme are never reset.

### window.EXCALIDRAW_ASSET_PATH

Set in `index.html` before the module script loads:
```html
<script>
  window.EXCALIDRAW_ASSET_PATH = "/assets/";
  window.EXCALIDRAW_EXPORT_SOURCE = "excalidraw-zed-preview";
</script>
```

---

## Key Dependencies

### extension/Cargo.toml

```toml
[dependencies]
zed_extension_api = "0.1"
```

### preview-binary/Cargo.toml

```toml
[dependencies]
wry        = "0.55"
tao        = "0.35"
axum       = { version = "0.8", features = ["tokio", "macros"] }
tokio      = { version = "1", features = ["full"] }
notify     = "8"
serde      = { version = "1", features = ["derive"] }
serde_json = "1"
clap       = { version = "4", features = ["derive", "env"] }   # env: EXCALIDRAW_PREVIEW_HEADLESS
anyhow     = "1"
sha2       = "0.11"          # for lock file path hashing
rust-embed = "8"             # for embedding assets/ directory
reqwest    = { version = "0.13", features = ["json", "blocking"] }
rfd        = "0.17"          # native save dialog
tracing    = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

### preview-binary/webview-src/package.json

```json
{
  "dependencies": {
    "@excalidraw/excalidraw": "^0.18.1",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^6.0.2",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "typescript": "^6.0.3",
    "vite": "^8.0.16",
    "vitest": "^4.1.8"
  },
  "overrides": {
    "vite": "^8.0.16"
  },
  "scripts": {
    "build": "vite build",
    "dev": "vite"
  }
}
```

---

## Coding Conventions

- Use `anyhow::Result` for error propagation in the binary; no `unwrap` in prod paths.
- `tracing` for structured logs; gated behind `--debug` flag in release builds.
- No `unsafe` unless required by `wry`/`tao` platform calls.
- Format with `rustfmt` defaults; lint with `clippy -- -D warnings`.
- All public items must have doc comments.
- TypeScript strict mode in webview; no `any` types.

---

## Build & Run

```bash
# 0. One-time: install WASM target + symlink binary to PATH
rustup target add wasm32-wasip1
just symlink   # ~/.local/bin/excalidraw-preview → target/release (run once)

# 1. Normal build (UI + release binary)
just

# 2. Full release (UI + binary + extension WASM)
just release

# 3. Run binary directly for testing
./target/release/excalidraw-preview ./path/to/file.excalidraw --debug

# 4. Install extension into Zed (dev mode)
# In Zed: open the command palette → "zed: install dev extension" → select the ./extension directory
```

### justfile recipes

| Recipe | Description |
|---|---|
| `just` | Default: list all available recipes |
| `just build` | Release binary only (no UI rebuild) |
| `just build-debug` | Debug binary |
| `just build-ext` | Zed extension WASM (`wasm32-wasip1`) |
| `just ui` | Vite build only (`npm install` + `vite build`: `webview-src/` → `assets/`) |
| `just release` | UI + binary + extension WASM |
| `just install-locally` | One-shot local install: prereq checks + `ui` + `build` + `symlink`, with progress feedback |
| `just test` | `cargo nextest run` + webview `typecheck` (`tsc --noEmit`) + vitest |
| `just smoke` | Automated real-WebView self-test (`--smoke`): native↔JS bridge + external-link routing, PASS/FAIL report. Needs a display. |
| `just symlink` | One-time: symlink `~/.local/bin/excalidraw-preview` → `target/release` |
| `just dev` | Debug build + Vite dev server + WebView window in parallel |
| `just dev-ui` | Vite dev server only |
| `just dev-window` | WebView pointed at the Vite dev server (run `just dev-ui` first) |
| `just clean` | `cargo clean` (keeps `assets/`) |

### Dev workflow

```bash
# Start dev server + WebView (default file or DEV_FILE env var)
just dev DEV_FILE=docs/examples/system-architecture.excalidraw

# Or open any file in the browser without restarting:
# http://localhost:5173?file=/absolute/path/to/diagram.excalidraw
```

Vite HMR updates the WebView on every `App.tsx` save — no Rust rebuild needed during UI development.
After UI changes are done: `just ui && just build` to bake them into the release binary.

---

## Testing Strategy

- **Unit**: debounce logic in `watcher.rs`; route handlers in `server.rs` via `axum::test`.
- **Integration**: spawn binary against a temp `.excalidraw` file; assert `GET /data` returns valid JSON; assert `GET /config` returns correct `contentType`; mutate file; assert SSE fires within 150 ms.
- **Format tests**: test all three content types + fallback chain in `main.tsx` with vitest.
- **Manual**: run against real Zed + `diagram.excalidraw`; measure reload latency with WebView DevTools.

---

## Milestones

| Phase | Deliverable | Done? |
| ----- | ---------------------------------------- | ----- |
| M1    | Rust binary opens wry window + serves static index.html | ✓ |
| M2    | `webview-src/` scaffolded; Vite builds; `<Excalidraw>` renders from `/data` | ✓ |
| M3    | File watcher + SSE + `updateScene` live reload | ✓ |
| M4    | Zed extension spawns binary as language server; auto-preview on open | ✓ |
| M5    | Process reuse: lock file + `/focus` + `/ping` | ✓ |
| M6    | All three file formats + fallback chain | ✓ |
| M7    | Cross-platform CI + prebuilt binary download | [ ] |

---

## Constraints & Gotchas

- **WASM sandbox**: extension runs in `wasm32-wasip1`; use `zed_extension_api::process::Command` (not `std::process`) and `zed::http_client_get` (not raw sockets).
- **`window.EXCALIDRAW_ASSET_PATH`**: must be set in a `<script>` block *before* the module script loads, or Excalidraw will fail to fetch fonts/wasm.
- **assets/ directory**: Vite outputs `assets/assets/main-[hash].js` (nested). The outer `assets/` is the root served at `/`; the inner `assets/` is the JS/CSS/font dir served at `/assets/`. Ensure `assets.rs` handles both `index.html` (at root) and everything under `assets/`.
- **Linux WebKitGTK**: require `libwebkit2gtk-4.1-dev` or `libwebkit2gtk-4.0-dev`. Print a clear error if the library is missing at startup.
- **macOS notarization**: companion binary must be codesigned + notarized for non-dev distribution.
- **Windows WebView2**: bundled in Win11; older Win10 needs the runtime bootstrapper.
- **Lock file cleanup**: always remove `$TMPDIR/excalidraw-{sha256}.lock` on exit. Use a `Drop` impl to handle panics and signals.
- **Format detection**: detect by file *extension*, not by sniffing bytes. Extension is authoritative; fallback chain handles mismatches.
- **`scrollToContent: true`**: must be set on `initialData` passed to `<Excalidraw>` so the diagram auto-fits the window on first load.
- **macOS close dialog re-entrancy**: the tao close flow's `confirm_close_dialog()` is a *blocking* `NSAlert.runModal()` that pumps the run loop and re-enters the event-loop closure on the 100 ms tick. The `CloseFlow` must be moved out of `Querying` (→ `Idle`) **before** the dialog is shown, or the re-entrant tick re-polls the consumed oneshot, falls back to the cached (still-dirty) state, and reopens the dialog — making "Don't Save" loop forever. The Linux path sidesteps this with an async dialog; both must leave `Querying` before prompting.
- **macOS clipboard keyboard shortcuts need an Edit menu**: AppKit only delivers `Cmd+C`/`Cmd+V`/`Cmd+X`/`Cmd+A`/`Cmd+Z` to the focused WKWebView when the menu bar has an Edit menu wired to the standard `copy:`/`paste:`/… selectors. `build_menu()` therefore includes an Edit submenu of `PredefinedMenuItem`s (Undo/Redo/Cut/Copy/Paste/Select All); without it those shortcuts are swallowed and only the WebView's right-click context menu can copy/paste. Linux/WebKitGTK delivers them to web content natively, so its in-WebView menu needs no Edit entries. (`Cmd+S` is handled separately by the File → Save accelerator.)
