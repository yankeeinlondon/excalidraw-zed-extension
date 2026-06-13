binary  := "excalidraw-preview"
release := "target/release/" + binary
debug   := "target/debug/" + binary
webview := "preview-binary/webview-src"
dev_file := env_var_or_default("DEV_FILE", "preview-binary/test.excalidraw")

# Default: build UI + release binary
default: ui build

# Build the release binary (embeds current assets/)
build:
    cargo build -p excalidraw-preview-binary --release

# Build the debug binary
build-debug:
    cargo build -p excalidraw-preview-binary

# Build the Zed extension WASM
build-ext:
    cargo build -p excalidraw-preview --release --target wasm32-wasip1

# Build the webview (npm install + vite build → assets/)
ui:
    cd {{webview}} && npm install && npm run build

# Full release: UI + binary + extension WASM
release: ui build build-ext

# Run all tests (nextest + webview)
test:
    cargo nextest run
    cd {{webview}} && npm test --if-present

# Symlink ~/.local/bin/excalidraw-preview → target/release (one-time setup)
symlink:
    mkdir -p {{home_directory()}}/.local/bin
    ln -sf {{justfile_directory()}}/{{release}} {{home_directory()}}/.local/bin/{{binary}}
    @echo "Symlinked ~/.local/bin/{{binary}} → {{justfile_directory()}}/{{release}}"

# Start Vite dev server (set DEV_FILE=path/to/file.excalidraw to change target)
dev-ui:
    cd {{webview}} && DEV_FILE={{justfile_directory()}}/{{dev_file}} npm run dev

# Open WebView pointed at the Vite dev server (run `just dev-ui` first)
dev-window:
    GDK_BACKEND=wayland {{debug}} --dev

# Full dev mode: Vite server + WebView in parallel
dev: build-debug
    #!/usr/bin/env bash
    trap 'kill 0' INT
    just dev-ui &
    sleep 2 && GDK_BACKEND=wayland {{debug}} --dev
    wait

# Clean build artifacts (keeps assets/ so the extension still works)
clean:
    cargo clean
