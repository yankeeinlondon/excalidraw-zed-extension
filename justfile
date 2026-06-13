binary  := "excalidraw-preview"
release := "target/release/" + binary
debug   := "target/debug/" + binary
webview := justfile_directory() / "preview-binary/webview-src"
dev_file := env_var_or_default("DEV_FILE", "preview-binary/test.excalidraw")

default:
    @echo
    @echo "excalidraw-preview"
    @echo "------------------"
    @just --list | grep -v 'default'
    @echo

# Build the release binary (embeds current assets/)
build:
    cargo build -p excalidraw-preview-binary --release

# Build the debug binary
build-debug:
    cargo build -p excalidraw-preview-binary

# Build the Zed extension WASM
build-ext:
    cargo build -p excalidraw-preview --release --target wasm32-wasip1

commit:
    claudine compose @.claudine/prompts/commit.md -y

# Build the webview (npm install + vite build → assets/)
ui:
    cd {{webview}} && npm install && npm run build

# Full release: UI + binary + extension WASM
release: ui build build-ext

# Add a new feature
feature name:
    @echo

# Run all tests (nextest + webview typecheck + vitest)
test:
    cargo nextest run
    cd {{webview}} && npm run typecheck && npm test --if-present

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

# chooses a spec or design file to identify the feature
_choose_feature_or_fix feat="":
    #!/usr/bin/env bash
    set -euo pipefail
    file="$(fd -g '*{spec,design}*\.md' --exclude '_completed' | {{ if feat == "" { "cat" } else { "rg " + feat } }} |  fzf --height=15 --border --border-label 'Choose a spec or design file')"
    echo "${file}"
