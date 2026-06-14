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

# One-shot local install: check prereqs, build UI + binary, symlink onto PATH
install-locally:
    #!/usr/bin/env bash
    set -euo pipefail

    bold=$(tput bold    2>/dev/null || true)
    reset=$(tput sgr0   2>/dev/null || true)
    green=$(tput setaf 2 2>/dev/null || true)
    red=$(tput setaf 1   2>/dev/null || true)
    yellow=$(tput setaf 3 2>/dev/null || true)
    blue=$(tput setaf 4  2>/dev/null || true)

    step() { echo; echo "${bold}${blue}▶ $1${reset}"; }
    ok()   { echo "  ${green}✓${reset} $1"; }
    warn() { echo "  ${yellow}!${reset} $1"; }
    die()  { echo "  ${red}✗ $1${reset}" >&2; exit 1; }

    echo
    echo "${bold}Installing Excalidraw Preview locally${reset}"

    step "Checking prerequisites"
    command -v cargo  >/dev/null || die "cargo not found — install Rust via https://rustup.rs"
    command -v rustup >/dev/null || die "rustup not found — install Rust via https://rustup.rs"
    command -v node   >/dev/null || die "node not found — install Node.js from https://nodejs.org"
    command -v npm    >/dev/null || die "npm not found — install Node.js from https://nodejs.org"
    ok "cargo $(cargo --version | awk '{print $2}')"
    ok "node $(node --version)"

    step "Ensuring the wasm32-wasip1 target is installed (needed by Zed to build the extension)"
    if rustup target list --installed | grep -qx 'wasm32-wasip1'; then
        ok "wasm32-wasip1 already installed"
    else
        rustup target add wasm32-wasip1
        ok "wasm32-wasip1 installed"
    fi

    step "Building the webview UI (npm install + vite build)"
    just ui
    ok "UI built → preview-binary/assets/"

    step "Building the release binary"
    just build
    ok "binary built → {{release}}"

    step "Linking the binary onto your PATH"
    just symlink
    case ":$PATH:" in
        *":$HOME/.local/bin:"*) ok "~/.local/bin is on your PATH" ;;
        *) warn "~/.local/bin is not on your PATH — add this to your shell profile and restart your shell:"
           echo "      export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
    esac

    echo
    echo "${bold}${green}✓ Local install complete.${reset}"
    echo
    echo "  One step left, inside Zed:"
    echo "    command palette → ${bold}\"zed: install dev extension\"${reset} → select the ${bold}./extension${reset} directory"
    echo
    echo "  Then open a .excalidraw file and run ${bold}/preview-excalidraw${reset}."
    echo

# Add a new feature
feature name:
    @echo

# Run all tests (nextest + webview typecheck + vitest)
test:
    cargo nextest run
    cd {{webview}} && npm run typecheck && npm test --if-present

# Automated real-WebView self-test: opens a window, drives the native↔JS bridge
# (save + close-interception query) and external-link routing, prints a PASS/FAIL
# report, exits non-zero on failure. Requires a display (run on a real desktop).
# Covers the programmatic core of features/2026-06-13-rough-edges/manual-checklist.md.
smoke: build-debug
    #!/usr/bin/env bash
    set -euo pipefail
    file="$(mktemp -t excalidraw-smoke).excalidraw"
    printf '{"type":"excalidraw","version":2,"source":"smoke","elements":[],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}' > "$file"
    trap 'rm -f "$file"' EXIT
    {{debug}} "$file" --smoke

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
