# Excalidraw Preview for Zed

> Source Repository: <https://github.com/yankeeinlondon/excalidraw-zed-extension>

![architecture](./docs/examples/architecture.excalidraw.svg)


A Zed editor extension that previews [Excalidraw](https://github.com/excalidraw/excalidraw) files in a native WebView window:

- Live reloads on file save
- No browser tabs
- Pure offline
- Near zero latency diagram preview
- Supports `.excalidraw` (JSON), `.excalidraw.svg`, and `.excalidraw.png` file formats


> `Extension Status`: **submitted to the official registry** 
>
> This extension has been submitted to the [Zed extension registry](https://github.com/zed-industries/extensions/pull/6468). Once that PR is merged, you'll be able to install it directly from Zed's **Extensions** panel (search for *Excalidraw Preview*). Until then, install it locally from source using the steps below.


## Installation

### Install from Zed (once published)

> ⏳ available after [registry PR #6468](https://github.com/zed-industries/extensions/pull/6468) is merged.

Open the command palette → **`zed: extensions`** → search for **Excalidraw Preview** → **Install**.

That's the whole install once it's in the registry — no Rust, Node, or build step required; the companion binary is downloaded automatically on first use. Until the PR lands, use the local install below.

### Install Locally

```bash
# clone repo
git clone https://github.com/yankeeinlondon/excalidraw-zed-extension.git
# move into repo
cd excalidraw-zed-extension
# use the `just` install recipe 
just install-locally
```

You do need to have `just` installed (available through most OS level package managers) but once `just` installed just run `just install-locally` and the recipe will:

- check all prerequisities
- adds a WASM target for Rust
- builds the UI and release binary
- symlinks the binary onto your PATH

Once this recipe has complete the only thing left to do is open the _command palette_ in Zed and search for "zed: install dev extension". You'll then navigate and select the `./extension` directory of the locally cloned repo.

### Prerequisites

- **Rust** (via `rustup`) + **Cargo**
- **Node.js** (for building the webview)
- **[`just`](https://github.com/casey/just)** — the command runner that drives the build (`cargo install just`, `brew install just`, or see its README)
- **macOS**: WebKit (built-in)
- **Linux**: `sudo apt install libwebkit2gtk-4.1-dev`
- **Windows**: WebView2 (built-in on Win11)

### Build from source (manual steps)

`just install-locally` (above) runs all of these for you. Use the granular recipes if you
want to run a single step:

```bash
# clone the repository
git clone https://github.com/yankeeinlondon/excalidraw-zed-extension.git
cd excalidraw-zed-extension

rustup target add wasm32-wasip1   # one-time: install WASM target
just ui build                     # build UI + release binary
just symlink                      # one-time: symlink binary onto PATH
```

Run `just` on its own to list every available recipe.

### Install the extension locally

In Zed: command palette → **"zed: install dev extension"** → select the `./extension`
directory (inside the cloned repo).

This installs the extension straight from your local clone — no registry needed. To pick
up new changes later, `git pull`, re-run `just install-locally`, then re-run
**"zed: install dev extension"**.

## Usage



https://github.com/user-attachments/assets/af3cd686-56b8-413c-9012-0f1c75e5f6c9



1. Open a `.excalidraw` or `.excalidraw.svg` file in Zed.
2. A native window opens automatically with the rendered diagram — the extension's
   language server launches the preview when the file opens (`didOpen`). No command
   to run.
3. Save the file in Zed — the preview live-reloads. Edit in the preview and press
   Ctrl/Cmd+S — it writes back to the file on disk.

`.excalidraw.png` files open in Zed's built-in image viewer instead (a read-only
render) — Zed's image pane claims PNGs before the extension can see them. For the
editable preview of a `.excalidraw.png`, use the CLI:

```bash
excalidraw-preview ./path/to/diagram.excalidraw.png
```

Opening the same file again focuses the existing window instead of opening a new one.
If you close the preview, saving the file in Zed reopens it.

### Language registration notes

The extension registers two languages with Zed — **Excalidraw**
(`.excalidraw` files) and **SVG** (`.svg` files, so that
`.excalidraw.svg` gets the preview; plain `.svg` files show "SVG" in the
status bar and start an idle language server — no preview, no error).

Both languages ship a bundled tree-sitter grammar, so the buffer behind a
preview is syntax-highlighted: `.excalidraw` as JSON (its scene format) and
`.svg`/`.excalidraw.svg` as XML. Highlighting also makes a broken hand-edit
visible — an unparseable region is highlighted as an error — but there is no
schema validation of the scene itself.

- Selecting a different language for a file (via the status bar or a
  `file_types` override) detaches the preview's language server, which may
  disable the automatic preview for that file. The CLI
  (`excalidraw-preview <file>`) always works regardless of language selection.
- The extension never rewrites your `file_types` settings or any other user
  configuration.

### Seeing what the extension is doing

The language server logs each preview's life, and Zed shows it: click
`excalidraw-preview` in the status bar → **View Logs**, or run
`dev: open language server logs` from the command palette.

```
INFO excalidraw-preview 0.6.0 ready as a language server
INFO editor opened ~/notes/architecture.excalidraw
INFO preview window opened for ~/notes/architecture.excalidraw
INFO preview window closed for ~/notes/architecture.excalidraw
```

Dispatch detail (a save while the preview is already open, `didClose` forwarding)
is logged at `debug`: set `RUST_LOG=excalidraw_preview=debug` in the environment
Zed is launched from to see it. The preview window is a separate, detached
process — its own logging never reaches Zed, so run the binary from a terminal
with `--debug` for that.

### Auto-save

Debounced auto-save (300 ms after you stop changing the scene, with a 2 s max-wait
so continuous drawing still flushes periodically) is available when you launch the
binary directly:

```
excalidraw-preview ./path/to/diagram.excalidraw --auto-save
```

It isn't exposed through the Zed extension, which spawns the preview in manual-save
mode (Ctrl/Cmd+S in the preview window).

### Run Without Zed

```bash
./target/release/excalidraw-preview ./path/to/diagram.excalidraw --debug
./target/release/excalidraw-preview ./path/to/diagram.excalidraw.svg
```

## Creating a new drawing

Two ways, pick your favorite:

1. **Project panel (recommended):** right-click → *New File* → name it `whiteboard.excalidraw`.
   The extension detects the empty file, writes a valid blank scene into it, and opens
   the preview on an empty canvas.
2. **Terminal:** `excalidraw-preview --new path/to/drawing.excalidraw`

Want a command-palette entry? Zed extensions can't register palette actions yet
(zed-industries/zed#8441), but you can wire a Zed task to the CLI. Add to your `tasks.json`:

```json
{
  "label": "new excalidraw drawing",
  "command": "excalidraw-preview",
  "args": ["--new", "$ZED_WORKTREE_ROOT/untitled.excalidraw"]
}
```

then run it via `task: spawn` in the command palette.

## Known limitations

- **No command-palette / context-menu entries.** Zed's extension API has no UI
  contribution points (tracked upstream: zed-industries/zed#8441, #18043). If Zed ships
  extension-registered actions, a *New Excalidraw Drawing* palette action will become the
  primary creation flow (it's a thin wrapper over `--new`).
- **"Browse libraries" opens in your system browser**, not inside the preview
  window — the excalidraw.com round-trip needs a real browser, so the preview routes
  that link (and Help / docs links) out through `open` instead of navigating away.
  Library items you add locally persist in
  `<config-dir>/excalidraw-zed/library.excalidrawlib` and are shared across all diagrams;
  use **Library → Import/Export Library…** for native `.excalidrawlib` round-trips.
- **`.excalidraw.png` opens in Zed's image viewer, not the editable preview.**
  Zed's built-in image pane claims `*.png` before any extension can observe the
  open — it matches on the extension alone, it is registered ahead of the text
  editor, and *no buffer is ever created*, so there is no file-open event for an
  extension to receive. No language registration, `file_types` override, task, or
  setting changes this; it would take an upstream change in Zed. If you want an
  image format that opens from a Zed click, use `.excalidraw.svg` — SVG is
  explicitly exempted from that check, and it embeds the scene exactly as PNG
  does.

  The PNG format itself is still fully editable — launch the viewer with
  `excalidraw-preview <file>.excalidraw.png` and it decodes the embedded
  scene, lets you edit it, and re-embeds the scene on save so the file stays a
  valid Excalidraw PNG. The same embedded-scene round-trip applies to
  `.excalidraw.svg`. Starting a *new* `.excalidraw.png` works the same way:
  `excalidraw-preview --new diagram.excalidraw.png` opens a blank editable
  canvas and the first save writes a real PNG with the scene embedded.
  (Clicking an empty one in Zed only hands it to the image pane, which has
  nothing to decode.)
- **Plain `.svg` files show "SVG" in the status bar** and start an idle
  language server (part of how `.excalidraw.svg` gets its preview — Zed only
  delivers file-open events for single-segment suffixes). It's a no-op: no
  preview spawns, nothing errors. Selecting a different language for a file
  may disable its automatic preview — the CLI remains available. User
  `file_types` settings are never rewritten by the extension.
