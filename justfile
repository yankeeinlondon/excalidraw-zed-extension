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

# Build the release binary. Depends on `ui` because the webview bundle is
# embedded (rust-embed) at compile time and is not committed, so the UI must be
# built first or the binary embeds nothing.
build: ui
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

# Full release: UI + binary + extension WASM. `build` already depends on `ui`
# (just runs each dependency once per invocation), so listing it here would be
# redundant.
release: build build-ext

# Bump the version everywhere and commit it as `chore: release vX.Y.Z`. Updates
# all four sites the release depends on — extension.toml, both [package] versions,
# and BINARY_VERSION — plus the two workspace entries in Cargo.lock, then commits.
# Run on a clean `main` (commit feature work first); follow with `just publish`.
#
# Usage: just bump 0.5.2
bump version:
    #!/usr/bin/env bash
    set -euo pipefail

    bold=$(tput bold 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)
    green=$(tput setaf 2 2>/dev/null || true); red=$(tput setaf 1 2>/dev/null || true)
    die() { echo "${red}✗ $1${reset}" >&2; exit 1; }

    version="{{version}}"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || die "'$version' is not a valid version (expected X.Y.Z)"

    # A release commit must contain *only* the version bump, so require a clean tree.
    [ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit feature work first"
    [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "not on main"
    current=$(grep -E '^version[[:space:]]*=' extension/extension.toml | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
    [ "$version" != "$current" ] || die "version is already $version"

    echo "${bold}▶ Bumping $current → $version${reset}"

    # The single `[package]` version in each manifest is the only line that begins
    # with `version = "` (dependency versions are inline or indented), so an
    # anchored replace is unambiguous. perl -i is portable across macOS/Linux.
    perl -i -pe 's/^version = "[^"]*"/version = "'"$version"'"/' \
        extension/extension.toml extension/Cargo.toml preview-binary/Cargo.toml
    perl -i -pe 's/(const BINARY_VERSION: &str = ")[^"]*(")/${1}'"$version"'${2}/' \
        extension/src/lib.rs
    # Cargo.lock: update only the two workspace members (slurp the file so the
    # name→version line pair can be matched together).
    perl -0777 -i -pe 's/(name = "excalidraw-preview"\nversion = ")[^"]*(")/${1}'"$version"'${2}/' Cargo.lock
    perl -0777 -i -pe 's/(name = "excalidraw-preview-binary"\nversion = ")[^"]*(")/${1}'"$version"'${2}/' Cargo.lock

    # Verify every site landed on the new version before committing.
    grep -q "^version = \"$version\"\$" extension/extension.toml   || die "extension.toml not updated"
    grep -q "^version = \"$version\"\$" extension/Cargo.toml       || die "extension/Cargo.toml not updated"
    grep -q "^version = \"$version\"\$" preview-binary/Cargo.toml  || die "preview-binary/Cargo.toml not updated"
    grep -q "const BINARY_VERSION: &str = \"$version\""            extension/src/lib.rs || die "lib.rs not updated"
    grep -A1 '^name = "excalidraw-preview"$'        Cargo.lock | grep -q "version = \"$version\"" || die "Cargo.lock (extension) not updated"
    grep -A1 '^name = "excalidraw-preview-binary"$' Cargo.lock | grep -q "version = \"$version\"" || die "Cargo.lock (binary) not updated"

    git add extension/extension.toml extension/Cargo.toml preview-binary/Cargo.toml extension/src/lib.rs Cargo.lock
    git commit -q -m "chore: release v${version}"

    echo
    echo "${green}✓ Committed chore: release v${version}.${reset}"
    echo "  Review:  git show HEAD"
    echo "  Publish: just publish"

# Publish the release: push main and an annotated `v{version}` tag (version read
# from extension.toml). Pushing the tag triggers the `Release` GitHub Actions
# workflow, which builds the per-platform binaries and creates the GitHub release
# with notes. Run this *after* `just bump` (or a manual `chore: release` commit).
#
# Prerequisites: clean working tree, on `main`, and the version not already tagged.
publish:
    #!/usr/bin/env bash
    set -euo pipefail

    bold=$(tput bold 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)
    green=$(tput setaf 2 2>/dev/null || true); red=$(tput setaf 1 2>/dev/null || true)
    die() { echo "${red}✗ $1${reset}" >&2; exit 1; }

    version=$(grep -E '^version[[:space:]]*=' extension/extension.toml | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
    [ -n "$version" ] || die "could not read version from extension.toml"
    tag="v${version}"

    # Safety checks: a release tags exactly what is committed on main.
    [ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit or stash first"
    branch=$(git rev-parse --abbrev-ref HEAD)
    [ "$branch" = "main" ] || die "not on main (on '$branch')"
    if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
        die "tag ${tag} already exists locally — bump the version first"
    fi

    echo "${bold}▶ Publishing ${tag}${reset}"
    git push origin main
    # Annotated tag *with* a message (-m) so git never opens an editor and never
    # aborts on an empty message.
    git tag -a "${tag}" -m "Release ${tag}"
    git push origin "${tag}"

    echo
    echo "${green}✓ Pushed ${tag}.${reset} The Release workflow is building binaries for every platform."
    echo "  Watch:   gh run watch \$(gh run list --workflow=release.yml -L1 --json databaseId --jq '.[0].databaseId')"
    echo "  Release: https://github.com/yankeeinlondon/excalidraw-zed-extension/releases/tag/${tag}"

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

    step "Building the webview UI + release binary (npm install + vite build, then cargo)"
    just build
    ok "UI built → preview-binary/assets/ and binary built → {{release}}"

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
