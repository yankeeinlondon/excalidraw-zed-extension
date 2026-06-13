# Excalidraw Preview for Zed

A Zed editor extension that previews `.excalidraw` files in a native WebView window. Live-reloads on file save. No browser tabs. Pure offline, near-zero-latency diagram preview.

Supports `.excalidraw` (JSON), `.excalidraw.svg`, and `.excalidraw.png`.

## Installation

### Prerequisites

- **Rust** (via `rustup`) + **Cargo**
- **Node.js** (for building the webview)
- **macOS**: WebKit (built-in)
- **Linux**: `sudo apt install libwebkit2gtk-4.1-dev`
- **Windows**: WebView2 (built-in on Win11)

### Build

```bash
# one-time: install WASM target
rustup target add wasm32-wasip1

# build UI + release binary
just

# one-time: symlink binary to PATH
just symlink
```

### Install Extension

In Zed: command palette → **"zed: install dev extension"** → select the `./extension` directory.

## Usage



https://github.com/user-attachments/assets/af3cd686-56b8-413c-9012-0f1c75e5f6c9



1. Open any `.excalidraw`, `.excalidraw.svg`, or `.excalidraw.png` file in Zed.
2. Run `/preview-excalidraw` from the command palette.
3. A native window opens with the rendered diagram.
4. Save the file in Zed — preview updates automatically.

Re-running the command focuses the existing window instead of opening a new one.

### Auto-save

Pass `--auto-save` to enable debounced auto-save (600 ms after every change):

```
/preview-excalidraw --auto-save
```

### Run Without Zed

```bash
./target/release/excalidraw-preview ./path/to/diagram.excalidraw --debug
./target/release/excalidraw-preview ./path/to/diagram.excalidraw.svg
```

## Creating a new drawing

Three ways, pick your favorite:

1. **Project panel (recommended):** right-click → *New File* → name it `whiteboard.excalidraw`.
   The extension detects the empty file, writes a valid blank scene into it, and opens
   the preview on an empty canvas.
2. **Assistant panel:** `/new-excalidraw [name]` creates `name.excalidraw` (or
   `untitled-N.excalidraw`) in the workspace root and opens the preview.
3. **Terminal:** `excalidraw-preview --new path/to/drawing.excalidraw`

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
- **"Browse libraries" doesn't work** inside the preview window — the excalidraw.com
  round-trip needs a browser. Library items you add locally persist in
  `<config-dir>/excalidraw-zed/library.excalidrawlib` and are shared across all diagrams.
- **`.excalidraw.png` click-to-open:** _record Task 13 outcome here — auto-opens, or use
  `/preview-excalidraw` as the entry point._
