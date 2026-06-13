# Excalidraw Zed Extension — Takeover & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take over the forked `excalidraw-zed-extension`: rebrand to `yankeeinlondon`, fix broken exports via a native save dialog, add new-drawing creation flows, consolidate instance reuse, persist the shape library, and ship `v0.2.0` with working CI under `just` + nextest.

**Architecture:** Zed WASM extension (`extension/`) spawns a self-daemonizing native companion binary (`preview-binary/`) that runs an axum HTTP server + wry WebView hosting a React/Excalidraw UI. All disk I/O (save, export, library) flows through HTTP routes on the Rust server; native dialogs are marshaled to the platform UI thread via an mpsc channel polled by the window event loop.

**Tech Stack:** Rust (axum 0.8, wry 0.43, tao 0.30/gtk 0.18, clap 4, rfd 0.15, dirs 6, notify 6), TypeScript/React 18 + `@excalidraw/excalidraw` 0.18 + Vite, `zed_extension_api` 0.1, just, cargo-nextest, vitest.

**Spec:** `features/2026-06-12-forked/spec.md`

**Key existing code facts (verified):**
- `preview-binary/src/main.rs` is a 954-line monolith: CLI parse → lock-file check → axum server → file watcher thread → WebView event loop on main thread. LSP mode (`--lsp`) spawns previews on `didOpen` (`spawn_preview`, already detached via `process_group(0)` on Unix) and shuts them down on `didClose` via the lock file.
- `extension/src/lib.rs` resolves the binary (PATH → cache → GitHub download from **arindampradhan's** releases), and backgrounds it via `sh -c "nohup … &"` with a hash-derived port (`port_for_path`) — both to be removed.
- Binary crate is `excalidraw-preview-binary`, bin name `excalidraw-preview` (so integration tests use `env!("CARGO_BIN_EXE_excalidraw-preview")`).
- `AppState` fields: `file_path, lock_path, content_type, file_name, auto_save, broadcast_tx, focus_tx`. Tests construct `AppState` literals — every task adding a field must update them.
- WebView: `run_webview_url` has two cfg variants — tao event loop (macOS/Windows) and GTK (`new_gtk`, Linux/Wayland). The tao loop uses `ControlFlow::Wait` and polls `focus_rx` only when events arrive.
- `release.yml` is broken: no `--target` passed (both mac jobs build native arch), assets uploaded without the per-target names `lib.rs` expects, no Windows job.

---

## Task 1: Replace Makefile with justfile

**Files:**
- Create: `justfile`
- Delete: `Makefile`

- [ ] **Step 1: Write the justfile**

Create `justfile` at the repo root (recipes mirror the Makefile semantics):

```just
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

# Run all tests (nextest + doctests + webview)
test:
    cargo nextest run
    cargo test --doc
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
```

- [ ] **Step 2: Verify recipes resolve**

Run: `just --list`
Expected: all 12 recipes listed, no parse errors.

Run: `just build-debug`
Expected: `cargo build -p excalidraw-preview-binary` succeeds (warm cache from earlier test run).

- [ ] **Step 3: Delete the Makefile**

```bash
git rm Makefile
```

- [ ] **Step 4: Commit**

```bash
git add justfile
git commit -m "build: replace Makefile with justfile"
```

(Doc references to `make` are updated in Task 15 alongside the other doc changes.)

---

## Task 2: nextest config + test CI workflow

**Files:**
- Create: `.config/nextest.toml`
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Write nextest config**

Create `.config/nextest.toml`:

```toml
[profile.default]
retries = 0
slow-timeout = { period = "60s", terminate-after = 2 }
# Integration tests spawn the preview binary; flag tests that leave orphans behind.
leak-timeout = "500ms"

[profile.ci]
inherits = "default"
retries = 2
fail-fast = false
failure-output = "immediate-final"

[profile.ci.junit]
path = "junit.xml"
```

- [ ] **Step 2: Install and verify nextest locally**

Run: `cargo nextest --version || cargo install --locked cargo-nextest`
Then: `cargo nextest run`
Expected: all 28 existing tests pass under nextest.

- [ ] **Step 3: Write the test CI workflow**

Create `.github/workflows/test.yml`:

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  rust:
    name: Rust (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - uses: actions/checkout@v4
      - name: Install system dependencies
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libglib2.0-dev libatk1.0-dev libgtk-3-dev
      - uses: dtolnay/rust-toolchain@stable
      - uses: taiki-e/install-action@nextest
      - run: cargo nextest run --profile ci
      - run: cargo test --doc
      - name: Upload JUnit report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: junit-${{ matrix.os }}
          path: target/nextest/ci/junit.xml

  webview:
    name: Webview (vitest)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: cd preview-binary/webview-src && npm ci && npm test --if-present
```

(`--if-present` keeps CI green until vitest lands in Task 11.)

- [ ] **Step 4: Commit**

```bash
git add .config/nextest.toml .github/workflows/test.yml
git commit -m "ci: add nextest config and test workflow"
```

---

## Task 3: Rebrand to yankeeinlondon

**Files:**
- Modify: `extension/extension.toml:5-7`
- Modify: `extension/src/lib.rs:128-131`

- [ ] **Step 1: Update extension.toml metadata**

In `extension/extension.toml` replace lines 5-7:

```toml
authors = ["Ken Snyder <ken@ken.net>"]
description = "Preview .excalidraw files in a native window"
repository = "https://github.com/yankeeinlondon/excalidraw-zed-extension"
```

- [ ] **Step 2: Repoint the binary download URL**

In `extension/src/lib.rs`, in `download_binary()`, replace the `download_url` assignment:

```rust
        let download_url = format!(
            "https://github.com/yankeeinlondon/excalidraw-zed-extension/releases/download/v{BINARY_VERSION}/{asset_name}"
        );
```

- [ ] **Step 3: Run tests**

Run: `cargo nextest run -p excalidraw-preview`
Expected: 13 tests pass.

- [ ] **Step 4: Commit**

```bash
git add extension/extension.toml extension/src/lib.rs
git commit -m "chore: rebrand extension to yankeeinlondon fork"
```

---

## Task 4: Fix release workflow (asset naming, --target, Windows)

**Files:**
- Modify: `.github/workflows/release.yml` (full rewrite)

- [ ] **Step 1: Rewrite release.yml**

The extension's `download_binary()` expects assets named `excalidraw-preview-{arch}-{os}[.exe]`, e.g. `excalidraw-preview-aarch64-apple-darwin`. The current workflow uploads a bare `excalidraw-preview` and never passes `--target`. Replace the file's `jobs:` section entirely:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    name: Release ${{ matrix.target }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
            binary: excalidraw-preview
          - os: macos-latest
            target: x86_64-apple-darwin
            binary: excalidraw-preview
          - os: macos-latest
            target: aarch64-apple-darwin
            binary: excalidraw-preview
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            binary: excalidraw-preview.exe

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Install system dependencies
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libglib2.0-dev libatk1.0-dev libgtk-3-dev

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - name: Build binary
        run: cargo build --release --target ${{ matrix.target }} -p excalidraw-preview-binary

      - name: Rename to release asset convention
        shell: bash
        run: |
          ASSET="excalidraw-preview-${{ matrix.target }}"
          if [ "${{ runner.os }}" = "Windows" ]; then ASSET="$ASSET.exe"; fi
          cp "target/${{ matrix.target }}/release/${{ matrix.binary }}" "$ASSET"
          echo "ASSET=$ASSET" >> "$GITHUB_ENV"

      - name: Upload binary
        uses: softprops/action-gh-release@v2
        with:
          files: ${{ env.ASSET }}
          generate_release_notes: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Note: the asset name `excalidraw-preview-{target-triple}` matches exactly what `lib.rs` `download_binary()` constructs (`{BINARY_NAME}-{arch_str}-{os_str}{ext}` where `arch_str-os_str` == the Rust target triple, e.g. `aarch64-apple-darwin`).

- [ ] **Step 2: Validate workflow syntax**

Run: `gh workflow list 2>/dev/null || true` (syntax is validated on push; alternatively `actionlint .github/workflows/release.yml` if installed).
Expected: no YAML errors when committed.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: fix release asset naming, add --target and Windows build"
```

---

## Task 5: Binary self-daemonizes (`--foreground`, `--headless`) + integration test scaffold

This makes the extension able to spawn the binary directly (no `sh -c nohup`, Windows-safe) and gives tests a windowless mode.

**Files:**
- Modify: `preview-binary/src/main.rs` (CliArgs, `main()`, new `daemonize` fn)
- Create: `preview-binary/tests/integration.rs`

- [ ] **Step 1: Write the failing integration test**

Create `preview-binary/tests/integration.rs`:

```rust
//! Integration tests: spawn the real binary headless against temp files.
//! Each test runs in its own process under nextest, so env/port state is isolated.

use sha2::{Digest, Sha256};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const BLANK_SCENE: &str = r#"{"type":"excalidraw","version":2,"source":"test","elements":[],"appState":{},"files":{}}"#;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_excalidraw-preview")
}

/// Mirrors `get_lock_path` in main.rs: $TMPDIR/excalidraw-{sha256(canonical)[..16]}.lock
fn lock_path_for(canonical: &Path) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let tmpdir = std::env::var("TMPDIR")
        .or_else(|_| std::env::var("TEMP"))
        .unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(tmpdir).join(format!("excalidraw-{}.lock", &hash[..16]))
}

/// Kills the child and removes the lock file even if a test panics.
struct Preview {
    child: std::process::Child,
    pub port: u16,
    lock: PathBuf,
}

impl Preview {
    fn spawn(file: &Path, extra_args: &[&str]) -> Self {
        let canonical = std::fs::canonicalize(file).expect("file must exist before spawn");
        let lock = lock_path_for(&canonical);
        let _ = std::fs::remove_file(&lock);

        let mut cmd = std::process::Command::new(binary());
        cmd.arg(file).arg("--foreground").arg("--headless");
        for a in extra_args {
            cmd.arg(a);
        }
        let child = cmd.spawn().expect("failed to spawn preview binary");

        // Poll the lock file for the bound port (≤ 5 s).
        let deadline = Instant::now() + Duration::from_secs(5);
        let port = loop {
            if let Ok(s) = std::fs::read_to_string(&lock) {
                if let Ok(p) = s.trim().parse::<u16>() {
                    break p;
                }
            }
            assert!(Instant::now() < deadline, "lock file never appeared at {}", lock.display());
            std::thread::sleep(Duration::from_millis(50));
        };
        Preview { child, port, lock }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }
}

impl Drop for Preview {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.lock);
    }
}

fn http_get(url: &str) -> (u16, String) {
    let resp = reqwest::blocking::Client::new()
        .get(url)
        .timeout(Duration::from_secs(3))
        .send()
        .expect("request failed");
    let status = resp.status().as_u16();
    let body = resp.text().unwrap_or_default();
    (status, body)
}

#[test]
fn headless_server_serves_ping_config_and_data() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();

    let preview = Preview::spawn(&file, &[]);

    let (status, body) = http_get(&preview.url("/ping"));
    assert_eq!(status, 200);
    assert_eq!(body, "OK");

    let (status, body) = http_get(&preview.url("/config"));
    assert_eq!(status, 200);
    assert!(body.contains(r#""contentType":"application/json""#), "config was: {body}");

    let (status, body) = http_get(&preview.url("/data"));
    assert_eq!(status, 200);
    assert_eq!(body, BLANK_SCENE);
}

#[test]
fn sse_fires_when_file_changes_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();

    let preview = Preview::spawn(&file, &[]);
    let (status, _) = http_get(&preview.url("/ping"));
    assert_eq!(status, 200);

    // Open the SSE stream, then mutate the file; expect a "data: reload" line within 2 s.
    let resp = reqwest::blocking::Client::new()
        .get(preview.url("/events"))
        .timeout(Duration::from_secs(10))
        .send()
        .expect("SSE connect failed");

    let (line_tx, line_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(resp);
        for line in reader.lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = line_tx.send(line);
            }
        }
    });

    std::thread::sleep(Duration::from_millis(300)); // let the subscription settle
    std::fs::write(&file, BLANK_SCENE.replace("test", "mutated")).unwrap();

    let line = line_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("no SSE event within 2 s of file change");
    assert!(line.contains("reload"), "unexpected SSE line: {line}");
}

#[test]
fn daemonize_parent_exits_and_child_serves() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let canonical = std::fs::canonicalize(&file).unwrap();
    let lock = lock_path_for(&canonical);
    let _ = std::fs::remove_file(&lock);

    // No --foreground: parent must daemonize and exit promptly.
    let status = std::process::Command::new(binary())
        .arg(&file)
        .arg("--headless")
        .status()
        .expect("spawn failed");
    assert!(status.success(), "parent exited non-zero");

    // The detached child must come up and serve /ping.
    let deadline = Instant::now() + Duration::from_secs(5);
    let port = loop {
        if let Ok(s) = std::fs::read_to_string(&lock) {
            if let Ok(p) = s.trim().parse::<u16>() {
                break p;
            }
        }
        assert!(Instant::now() < deadline, "daemonized child never wrote lock file");
        std::thread::sleep(Duration::from_millis(50));
    };

    let (status, body) = http_get(&format!("http://127.0.0.1:{port}/ping"));
    assert_eq!(status, 200);
    assert_eq!(body, "OK");

    // Tear down the detached child.
    let _ = http_get(&format!("http://127.0.0.1:{port}/shutdown"));
    std::thread::sleep(Duration::from_millis(300));
    assert!(!lock.exists(), "lock file not cleaned up after /shutdown");
}
```

Add `sha2` to dev-dependencies in `preview-binary/Cargo.toml` (it's already a regular dependency, so only the test import matters — no Cargo.toml change needed since integration tests can't see regular deps... they CAN'T, so add):

```toml
[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
tempfile = "3"
sha2 = "0.10"
reqwest = { version = "0.12", features = ["blocking"] }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo nextest run -p excalidraw-preview-binary --test integration`
Expected: FAIL — `--foreground` and `--headless` are unknown arguments (clap error), so `Preview::spawn` panics on the lock-file poll.

- [ ] **Step 3: Implement the flags and daemonize**

In `preview-binary/src/main.rs`, add to `CliArgs`:

```rust
    /// Internal: run in the foreground (do not detach). Set automatically on re-spawn.
    #[arg(long, hide = true)]
    foreground: bool,
    /// Run the server without opening a WebView window (tests / headless environments).
    #[arg(long)]
    headless: bool,
```

Add the daemonize function (above `main`):

```rust
/// Re-spawns the current executable fully detached from the parent and returns immediately.
///
/// The child re-runs with `--foreground` appended so it skips this branch. This lets
/// callers (the Zed extension, terminals, the LSP) spawn the binary without shell
/// tricks like `nohup … &`, and works on Windows where `sh` does not exist.
fn daemonize(file: &str, args: &CliArgs) -> Result<()> {
    use std::process::{Command, Stdio};
    let exe = std::env::current_exe()?;
    let mut cmd = Command::new(exe);
    cmd.arg(file).arg("--foreground");
    if let Some(port) = args.port {
        cmd.arg("--port").arg(port.to_string());
    }
    if args.auto_save {
        cmd.arg("--auto-save");
    }
    if args.debug {
        cmd.arg("--debug");
    }
    if args.headless {
        cmd.arg("--headless");
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    cmd.spawn()?;
    Ok(())
}
```

In `main()`, first change the file binding so `args` stays borrowable (the current code moves `args.file` out):

```rust
    let file = args
        .file
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Usage: excalidraw-preview <file> [--port <port>] [--debug]\n       excalidraw-preview --lsp"))?;
```

Then, after the `file_path.exists()` check (after line 78), insert:

```rust
    // Detach from the parent so callers (Zed extension, terminals) return immediately.
    if !args.foreground {
        return daemonize(&file, &args);
    }
```

At the WebView launch site (the `if let Err(e) = run_webview(port, focus_rx)` block), wrap with the headless branch:

```rust
    if args.headless {
        info!("Headless mode: serving without a window until /shutdown or kill");
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    }

    if let Err(e) = run_webview(port, focus_rx) {
        // ... existing error fallback unchanged ...
    }
```

(`/shutdown` calls `std::process::exit(0)` after removing the lock file, so the headless loop never needs to break. Unreachable code after the loop — move the existing teardown into the non-headless path only; the compiler will flag anything unreachable.)

- [ ] **Step 4: Run all tests**

Run: `cargo build -p excalidraw-preview-binary && cargo nextest run -p excalidraw-preview-binary`
Expected: 15 existing unit tests + 3 new integration tests PASS. (nextest's `leak-timeout` will flag the daemonize test if the child isn't shut down — the `/shutdown` call handles that.)

- [ ] **Step 5: Commit**

```bash
git add preview-binary/src/main.rs preview-binary/tests/integration.rs preview-binary/Cargo.toml
git commit -m "feat(binary): self-daemonize by default, add --foreground/--headless, integration tests"
```

---

## Task 6: Extension spawns binary directly (remove port hashing, process map, shell)

**Files:**
- Modify: `extension/src/lib.rs`

- [ ] **Step 1: Remove the dead mechanisms**

In `extension/src/lib.rs`:
1. Delete `port_for_path` (lines 39-45), `send_focus_request` (47-57), `ProcessInfo` (22-26), the `process_map` field and its initialization, and `shlex_quote` (267-269).
2. Delete their tests: `test_port_for_path_*` (3) and `test_shlex_quote_*` (3). Keep all `test_is_valid_extension_*` tests.
3. Remove now-unused imports: `HashMap`, `http_client`/`HttpMethod`/`HttpRequestBuilder` (no longer needed — the binary handles focus itself via its lock file).

The struct becomes:

```rust
struct ExcalidrawPreviewExtension {
    /// Cached path to the downloaded binary, so we don't re-download on every call.
    cached_binary_path: RwLock<Option<String>>,
}
```

```rust
    fn new() -> Self {
        ExcalidrawPreviewExtension {
            cached_binary_path: RwLock::new(None),
        }
    }
```

- [ ] **Step 2: Replace the spawn block**

Replace everything in the `"preview-excalidraw"` match arm from the `let port = ...` line through the `ProcessCommand::new("sh")` match with:

```rust
                // The binary self-daemonizes (re-spawns detached, parent exits instantly),
                // and self-deduplicates via its lock file: if a live instance is already
                // serving this file it focuses that window and exits. So we always just run it.
                let mut cmd = ProcessCommand::new(&binary).arg(&file_path_str);
                if auto_save {
                    cmd = cmd.arg("--auto-save");
                }
                match cmd.output() {
                    Ok(_) => Ok(SlashCommandOutput {
                        sections: vec![SlashCommandOutputSection {
                            range: Range { start: 0, end: 1 },
                            label: "Preview opened".into(),
                        }],
                        text: format!("Opened preview for {}", file_path.display()),
                    }),
                    Err(e) => Err(format!("Failed to start preview: {e}").into()),
                }
```

(If `zed_extension_api::process::Command`'s builder takes `&mut self` instead of `self`, use `let mut cmd = ProcessCommand::new(&binary); cmd.arg(&file_path_str);` form — match the existing usage pattern in this API version. `output()` returns promptly because the parent daemonizes and exits.)

- [ ] **Step 3: Run tests and lint**

Run: `cargo nextest run -p excalidraw-preview && cargo clippy -p excalidraw-preview -- -D warnings`
Expected: 7 remaining tests pass, no warnings (unused imports gone).

- [ ] **Step 4: Verify the WASM target still compiles**

Run: `cargo build -p excalidraw-preview --release --target wasm32-wasip1`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add extension/src/lib.rs
git commit -m "fix(extension): drop hash-port/process-map/shell spawn; binary self-dedups via lock file"
```

---

## Task 7: Empty-file bootstrap

Empty (0-byte or whitespace-only) target files become valid blank drawings. `.excalidraw` is bootstrapped server-side; `.excalidraw.svg`/`.excalidraw.png` are bootstrapped client-side (only Excalidraw's JS exporter can render those formats) via an initial empty scene + immediate first save.

**Files:**
- Modify: `preview-binary/src/main.rs`
- Modify: `preview-binary/webview-src/src/main.tsx`
- Modify: `preview-binary/webview-src/src/App.tsx`

- [ ] **Step 1: Write failing unit tests**

In the `tests` module of `preview-binary/src/main.rs`, add:

```rust
    #[test]
    fn test_bootstrap_writes_blank_scene_into_empty_json_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.excalidraw");
        std::fs::write(&path, "").unwrap();
        assert!(bootstrap_if_empty(&path).unwrap());
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["type"], "excalidraw");
        assert_eq!(parsed["version"], 2);
        assert!(parsed["elements"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_bootstrap_treats_whitespace_only_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.excalidraw");
        std::fs::write(&path, "  \n\t ").unwrap();
        assert!(bootstrap_if_empty(&path).unwrap());
    }

    #[test]
    fn test_bootstrap_ignores_non_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.excalidraw");
        std::fs::write(&path, r#"{"type":"excalidraw"}"#).unwrap();
        assert!(!bootstrap_if_empty(&path).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"type":"excalidraw"}"#);
    }

    #[test]
    fn test_bootstrap_leaves_empty_svg_for_client_side_handling() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.excalidraw.svg");
        std::fs::write(&path, "").unwrap();
        assert!(!bootstrap_if_empty(&path).unwrap());
        assert_eq!(std::fs::read(&path).unwrap().len(), 0);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo nextest run -p excalidraw-preview-binary 'test(/bootstrap/)'`
Expected: FAIL — `bootstrap_if_empty` not found.

- [ ] **Step 3: Implement**

Add near `detect_content_type` in `main.rs`:

```rust
/// A minimal valid Excalidraw scene, written into empty `.excalidraw` files.
const BLANK_SCENE_JSON: &str = r#"{
  "type": "excalidraw",
  "version": 2,
  "source": "excalidraw-zed-preview",
  "elements": [],
  "appState": { "gridSize": null, "viewBackgroundColor": "#ffffff" },
  "files": {}
}
"#;

/// Bootstraps an empty (0-byte or whitespace-only) `.excalidraw` file with a blank scene.
///
/// SVG/PNG variants are left untouched: only Excalidraw's JS exporter can render those
/// formats, so the webview bootstraps them client-side on first load (empty bytes →
/// empty scene → immediate save in the declared format).
///
/// ## Returns
/// `true` if the file was bootstrapped.
fn bootstrap_if_empty(path: &Path) -> Result<bool> {
    let content = std::fs::read(path)?;
    let is_blank = content.iter().all(|b| b.is_ascii_whitespace());
    if !is_blank || detect_content_type(path) != "application/json" {
        return Ok(false);
    }
    std::fs::write(path, BLANK_SCENE_JSON)?;
    Ok(true)
}
```

In `main()`, immediately after `let canonical_path = std::fs::canonicalize(&file_path)?;`:

```rust
    if bootstrap_if_empty(&canonical_path)? {
        info!("Bootstrapped empty file with a blank scene");
    }
```

- [ ] **Step 4: Run Rust tests**

Run: `cargo nextest run -p excalidraw-preview-binary`
Expected: all pass, including the 4 new bootstrap tests.

- [ ] **Step 5: Client-side bootstrap for SVG/PNG in main.tsx**

In `preview-binary/webview-src/src/main.tsx`, replace the `let initialData ... for (const type of reorderFallbacks(...)) { ... }` block (lines 66-83) with:

```ts
    let initialData: ExcalidrawInitialDataState | null = null;
    // Empty file (new .excalidraw.svg/.excalidraw.png drawing): start with a blank
    // scene and let App write the proper format to disk on its bootstrap save.
    const isEmptyFile = bytes.byteLength === 0 ||
      new TextDecoder().decode(bytes).trim().length === 0;

    if (isEmptyFile) {
      initialData = { elements: [], appState: {}, files: {} };
    } else {
      for (const type of reorderFallbacks(config.contentType)) {
        try {
          initialData = await loadFromBlob(new Blob([bytes], { type }), null, null);
          break;
        } catch {
          // try next format
        }
      }
    }

    if (!initialData) {
      showError("Failed to load file: all format fallbacks failed");
      return;
    }
```

And pass the flag into App (in the `render` call):

```tsx
        bootstrapSave={isEmptyFile}
```

- [ ] **Step 6: Bootstrap save in App.tsx**

In `App.tsx`, add to `AppProps`:

```ts
  /** When true (empty file on disk), write the blank scene in the declared format once on mount. */
  bootstrapSave: boolean;
```

Add `bootstrapSave` to the destructured props, and after the `doSave` definition add:

```ts
  // New empty file: persist a valid blank scene in the declared format (JSON files are
  // already bootstrapped server-side; this covers .excalidraw.svg / .excalidraw.png).
  useEffect(() => {
    if (bootstrapSave) {
      void doSave();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 7: Build the webview and binary**

Run: `just ui && just build-debug`
Expected: vite build succeeds with no TS errors; binary builds.

- [ ] **Step 8: Commit**

```bash
git add preview-binary/src/main.rs preview-binary/webview-src/src/main.tsx preview-binary/webview-src/src/App.tsx
git commit -m "feat: bootstrap empty files into valid blank drawings (server-side JSON, client-side SVG/PNG)"
```

---

## Task 8: `--new <path>` CLI flag

**Files:**
- Modify: `preview-binary/src/main.rs`

- [ ] **Step 1: Write failing unit tests**

Add to the `tests` module:

```rust
    #[test]
    fn test_create_new_drawing_writes_blank_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.excalidraw");
        create_new_drawing(path.to_str().unwrap()).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["type"], "excalidraw");
    }

    #[test]
    fn test_create_new_drawing_refuses_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("exists.excalidraw");
        std::fs::write(&path, "x").unwrap();
        let err = create_new_drawing(path.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("Refusing to overwrite"));
    }

    #[test]
    fn test_create_new_drawing_rejects_wrong_extension() {
        let err = create_new_drawing("/tmp/nope.txt").unwrap_err();
        assert!(err.to_string().contains(".excalidraw"));
    }

    #[test]
    fn test_create_new_drawing_svg_creates_empty_file_for_client_bootstrap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.excalidraw.svg");
        create_new_drawing(path.to_str().unwrap()).unwrap();
        assert!(path.exists());
        assert_eq!(std::fs::read(&path).unwrap().len(), 0);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo nextest run -p excalidraw-preview-binary 'test(/create_new/)'`
Expected: FAIL — `create_new_drawing` not found.

- [ ] **Step 3: Implement**

Add to `CliArgs`:

```rust
    /// Create <PATH> as a new blank drawing and open the preview.
    /// Fails if the file already exists.
    #[arg(long, value_name = "PATH", conflicts_with = "file")]
    new: Option<String>,
```

Add the function (near `bootstrap_if_empty`):

```rust
/// Creates a new blank drawing at `path_str`.
///
/// `.excalidraw` files get the blank JSON scene; `.excalidraw.svg` / `.excalidraw.png`
/// are created empty and bootstrapped client-side by the webview on first load.
///
/// ## Errors
/// Fails if the path has an unsupported extension or the file already exists.
fn create_new_drawing(path_str: &str) -> Result<()> {
    let path = Path::new(path_str);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let valid = name.ends_with(".excalidraw")
        || name.ends_with(".excalidraw.svg")
        || name.ends_with(".excalidraw.png");
    if !valid {
        anyhow::bail!("--new requires a .excalidraw, .excalidraw.svg, or .excalidraw.png path");
    }
    if path.exists() {
        anyhow::bail!("Refusing to overwrite existing file: {}", path.display());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    if detect_content_type(path) == "application/json" {
        std::fs::write(path, BLANK_SCENE_JSON)?;
    } else {
        std::fs::write(path, b"")?;
    }
    Ok(())
}
```

In `main()`, replace the `let file = args.file.ok_or_else(...)` block with:

```rust
    let file = if let Some(new_path) = &args.new {
        // Create in the parent process so errors surface to the caller, then proceed
        // (and daemonize) on the now-existing file. --new is never forwarded.
        create_new_drawing(new_path)?;
        new_path.clone()
    } else {
        args.file.clone().ok_or_else(|| {
            anyhow::anyhow!(
                "Usage: excalidraw-preview <file> [--port <port>] [--debug]\n       excalidraw-preview --new <path>\n       excalidraw-preview --lsp"
            )
        })?
    };
```

(`daemonize` already forwards only the positional file + flags, so the child opens the created file normally.)

- [ ] **Step 4: Run all tests**

Run: `cargo nextest run -p excalidraw-preview-binary`
Expected: all pass.

- [ ] **Step 5: Manual smoke test**

Run: `cargo run -p excalidraw-preview-binary -- --new /tmp/smoke-test.excalidraw --headless --foreground &` then `sleep 1 && cat /tmp/smoke-test.excalidraw && kill %1`
Expected: blank scene JSON printed.

Run: `cargo run -p excalidraw-preview-binary -- --new /tmp/smoke-test.excalidraw --foreground`
Expected: error `Refusing to overwrite existing file`. Clean up: `rm /tmp/smoke-test.excalidraw`.

- [ ] **Step 6: Commit**

```bash
git add preview-binary/src/main.rs
git commit -m "feat(binary): add --new flag to create blank drawings"
```

---

## Task 9: `/new-excalidraw` slash command

**Files:**
- Modify: `extension/extension.toml`
- Modify: `extension/src/lib.rs`

- [ ] **Step 1: Register the slash command**

In `extension/extension.toml`, after the existing `[slash_commands.preview-excalidraw]` block:

```toml
[slash_commands.new-excalidraw]
description = "Create a new blank Excalidraw drawing and open its preview"
requires_argument = false
```

- [ ] **Step 2: Implement the command branch**

In `extension/src/lib.rs` `run_slash_command`, add a match arm before the `_ =>` fallback:

```rust
            "new-excalidraw" => {
                let worktree = worktree.ok_or("No worktree available")?;
                let binary = self.get_binary_path(worktree)?;
                let root = PathBuf::from(worktree.root_path());

                let file_path = if let Some(name) = args.iter().find(|a| !a.starts_with("--")) {
                    let mut name = name.to_string();
                    if !name.ends_with(".excalidraw") {
                        name.push_str(".excalidraw");
                    }
                    root.join(name)
                } else {
                    (1..1000)
                        .map(|n| root.join(format!("untitled-{n}.excalidraw")))
                        .find(|p| !p.exists())
                        .ok_or("Could not find a free untitled-N.excalidraw name")?
                };

                if file_path.exists() {
                    return Err(format!("{} already exists", file_path.display()).into());
                }

                let file_path_str = file_path.to_string_lossy().to_string();
                match ProcessCommand::new(&binary)
                    .arg("--new")
                    .arg(&file_path_str)
                    .output()
                {
                    Ok(_) => Ok(SlashCommandOutput {
                        sections: vec![SlashCommandOutputSection {
                            range: Range { start: 0, end: 1 },
                            label: "Drawing created".into(),
                        }],
                        text: format!("Created and opened {}", file_path.display()),
                    }),
                    Err(e) => Err(format!("Failed to create drawing: {e}").into()),
                }
            }
```

(Same builder-form caveat as Task 6 Step 2. If the returned output type exposes an exit status, prefer reporting failure when the status is non-zero — `--new` exits non-zero on "already exists".)

- [ ] **Step 3: Build both targets**

Run: `cargo nextest run -p excalidraw-preview && cargo build -p excalidraw-preview --release --target wasm32-wasip1`
Expected: tests pass, WASM builds.

- [ ] **Step 4: Commit**

```bash
git add extension/extension.toml extension/src/lib.rs
git commit -m "feat(extension): add /new-excalidraw slash command"
```

---

## Task 10: Export — server route, `--export-dir`, native save dialog

**Files:**
- Modify: `preview-binary/Cargo.toml` (add `rfd`)
- Modify: `preview-binary/src/main.rs` (ExportRequest, AppState, route, CliArgs, daemonize, both `run_webview_url` variants)
- Modify: `preview-binary/tests/integration.rs` (export-dir test)

- [ ] **Step 1: Add the rfd dependency**

In `preview-binary/Cargo.toml`:

```toml
[target.'cfg(not(target_os = "linux"))'.dependencies]
rfd = "0.15"

[target.'cfg(target_os = "linux")'.dependencies]
gtk = { version = "0.18", features = ["v3_24"] }
rfd = { version = "0.15", default-features = false, features = ["gtk3"] }
```

(Move the existing `gtk` line into this shared Linux block. `gtk3` feature keeps rfd on the same GTK3 stack the window already uses, avoiding an xdg-portal runtime dependency.)

- [ ] **Step 2: Write the failing integration test**

Add to `preview-binary/tests/integration.rs`:

```rust
#[test]
fn export_dir_writes_posted_bytes_without_dialog() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let export_dir = tempfile::tempdir().unwrap();

    let export_dir_arg = format!("--export-dir={}", export_dir.path().display());
    let preview = Preview::spawn(&file, &[&export_dir_arg]);

    let resp = reqwest::blocking::Client::new()
        .post(preview.url("/export?name=out.png"))
        .header("Content-Type", "image/png")
        .body(vec![0x89u8, 0x50, 0x4E, 0x47])
        .timeout(Duration::from_secs(3))
        .send()
        .expect("export request failed");
    assert_eq!(resp.status().as_u16(), 200);

    let written = export_dir.path().join("out.png");
    assert_eq!(std::fs::read(&written).unwrap(), vec![0x89u8, 0x50, 0x4E, 0x47]);
}

#[test]
fn export_rejects_path_traversal_in_name() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let export_dir = tempfile::tempdir().unwrap();

    let export_dir_arg = format!("--export-dir={}", export_dir.path().display());
    let preview = Preview::spawn(&file, &[&export_dir_arg]);

    let resp = reqwest::blocking::Client::new()
        .post(preview.url("/export?name=..%2Fescape.png"))
        .body(vec![1u8])
        .timeout(Duration::from_secs(3))
        .send()
        .expect("export request failed");
    assert_eq!(resp.status().as_u16(), 200);
    // Only the file name survives; the write lands inside export_dir.
    assert!(export_dir.path().join("escape.png").exists());
    assert!(!dir.path().join("escape.png").exists());
}
```

Run: `cargo nextest run -p excalidraw-preview-binary 'test(/export/)'`
Expected: FAIL — unknown `--export-dir` argument.

- [ ] **Step 3: Implement the server side**

In `main.rs`:

1. Add to `CliArgs`:

```rust
    /// Write exports directly into this directory instead of showing a save dialog.
    /// Intended for tests and headless use.
    #[arg(long, value_name = "DIR")]
    export_dir: Option<PathBuf>,
```

2. Forward it in `daemonize` (add alongside the other flag forwards):

```rust
    if let Some(dir) = &args.export_dir {
        cmd.arg("--export-dir").arg(dir);
    }
```

3. Define the request type (near `AppState`):

```rust
/// A request from the HTTP layer to show a native save dialog and write export bytes.
/// Processed on the platform UI thread (tao event loop / GTK main context).
struct ExportRequest {
    bytes: Vec<u8>,
    suggested_name: String,
    default_dir: PathBuf,
    /// `Some(path)` once written, `None` if the user cancelled the dialog.
    reply: tokio::sync::oneshot::Sender<Option<PathBuf>>,
}
```

4. Add fields to `AppState`:

```rust
    /// Sends export requests to the UI thread for the native save dialog.
    export_tx: std::sync::mpsc::Sender<ExportRequest>,
    /// When set (--export-dir), exports bypass the dialog and write here.
    export_dir: Option<PathBuf>,
```

In `main()`, create the channel before building the state and keep the receiver for the WebView:

```rust
    let (export_tx, export_rx) = std::sync::mpsc::channel::<ExportRequest>();
```

…and add `export_tx, export_dir: args.export_dir.clone(),` to the `AppState` literal. **Update every `AppState` literal in the `tests` module the same way** (use `std::sync::mpsc::channel().0` for `export_tx` and `None` for `export_dir`).

5. Add the route to the router:

```rust
        .route("/export", axum::routing::post(handle_export))
```

6. Add the handler:

```rust
#[derive(serde::Deserialize)]
struct ExportParams {
    name: String,
}

/// Receives exported bytes from the WebView and writes them to disk — either directly
/// into `--export-dir`, or to a user-chosen location via a native save dialog marshaled
/// to the UI thread.
async fn handle_export(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<ExportParams>,
    body: axum::body::Bytes,
) -> Response {
    // Strip any directory components — only a bare file name is accepted.
    let name = Path::new(&params.name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "export.bin".to_string());

    if let Some(dir) = &state.export_dir {
        let target = dir.join(&name);
        return match std::fs::write(&target, &body) {
            Ok(_) => (
                axum::http::StatusCode::OK,
                target.to_string_lossy().to_string(),
            )
                .into_response(),
            Err(e) => {
                (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
            }
        };
    }

    let default_dir = state
        .file_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    let request = ExportRequest {
        bytes: body.to_vec(),
        suggested_name: name,
        default_dir,
        reply: reply_tx,
    };
    if state.export_tx.send(request).is_err() {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "export channel closed (no window?)",
        )
            .into_response();
    }
    match reply_rx.await {
        Ok(Some(path)) => (
            axum::http::StatusCode::OK,
            path.to_string_lossy().to_string(),
        )
            .into_response(),
        Ok(None) => axum::http::StatusCode::NO_CONTENT.into_response(),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "export dialog failed",
        )
            .into_response(),
    }
}
```

- [ ] **Step 4: Wire the dialog into both WebView variants**

Change signatures to accept the receiver:

```rust
fn run_webview(
    port: u16,
    focus_rx: watch::Receiver<bool>,
    export_rx: std::sync::mpsc::Receiver<ExportRequest>,
) -> Result<(), Box<dyn std::error::Error>> {
    run_webview_url(&format!("http://127.0.0.1:{}", port), focus_rx, export_rx)
}
```

Update the `--dev`/`--dev-server` call site with a dummy channel:

```rust
        let (_export_tx, export_rx) = std::sync::mpsc::channel();
        if let Err(e) = run_webview_url(&dev_url, focus_rx, export_rx) {
```

Shared dialog helper (compiled on all platforms):

```rust
/// Shows the native save dialog for `req` and writes the bytes on confirm.
/// MUST be called on the platform UI thread.
fn handle_export_request(req: ExportRequest) {
    let picked = rfd::FileDialog::new()
        .set_directory(&req.default_dir)
        .set_file_name(&req.suggested_name)
        .save_file();
    let result = picked.and_then(|p| std::fs::write(&p, &req.bytes).ok().map(|_| p));
    let _ = req.reply.send(result);
}
```

**tao variant** (`#[cfg(not(target_os = "linux"))]`): change the run loop to poll every 100 ms — this also fixes the latent focus bug where `focus_rx` was only checked when an OS event happened to arrive:

```rust
    event_loop.run(move |event, _, control_flow| {
        // Wake at least every 100 ms so export/focus requests are handled promptly
        // even when no OS events arrive (ControlFlow::Wait would starve them).
        *control_flow = ControlFlow::WaitUntil(
            std::time::Instant::now() + std::time::Duration::from_millis(100),
        );

        if let tao::event::Event::WindowEvent {
            event: tao::event::WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }

        while let Ok(req) = export_rx.try_recv() {
            handle_export_request(req);
        }

        if focus_rx.has_changed().unwrap_or(false) {
            let _ = focus_rx.borrow_and_update();
            window.set_focus();
        }
    });
```

**GTK variant** (`#[cfg(target_os = "linux")]`): after `window.show_all();`, add a 100 ms tick on the GTK main context (and fix focus on Linux, which previously ignored `focus_rx` entirely — rename the parameter from `_focus_rx` to `focus_rx`):

```rust
    let window_for_tick = window.clone();
    let mut focus_rx = focus_rx;
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
        while let Ok(req) = export_rx.try_recv() {
            handle_export_request(req);
        }
        if focus_rx.has_changed().unwrap_or(false) {
            let _ = focus_rx.borrow_and_update();
            window_for_tick.present();
        }
        gtk::glib::ControlFlow::Continue
    });
```

(If the installed glib version expects `glib::Continue(true)` instead of `ControlFlow::Continue`, use that form — check `cargo doc -p glib` for the resolved version.)

Finally, update the main `run_webview(port, focus_rx)` call site to pass `export_rx`.

- [ ] **Step 5: Run all tests**

Run: `cargo nextest run -p excalidraw-preview-binary`
Expected: all unit + integration tests pass, including the two new export tests.

- [ ] **Step 6: Commit**

```bash
git add preview-binary/Cargo.toml preview-binary/src/main.rs preview-binary/tests/integration.rs Cargo.lock
git commit -m "feat(binary): POST /export with native save dialog and --export-dir bypass"
```

---

## Task 11: Webview export menu + vitest

**Files:**
- Create: `preview-binary/webview-src/src/export.ts`
- Create: `preview-binary/webview-src/src/export.test.ts`
- Modify: `preview-binary/webview-src/src/App.tsx`
- Modify: `preview-binary/webview-src/package.json`

- [ ] **Step 1: Add vitest**

In `preview-binary/webview-src/package.json`, add to `scripts`:

```json
    "test": "vitest run"
```

and to `devDependencies`:

```json
    "vitest": "^3.0.0"
```

Run: `cd preview-binary/webview-src && npm install`

- [ ] **Step 2: Write the failing tests**

Create `preview-binary/webview-src/src/export.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  exportToSvg: vi.fn(async () => ({ outerHTML: "<svg>mock</svg>" })),
  exportToBlob: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
  serializeAsJSON: vi.fn(() => '{"type":"excalidraw"}'),
}));

import { exportFilename, postExport, type ExportKind } from "./export";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const fakeApi = {
  getSceneElements: () => [],
  getAppState: () => ({}),
  getFiles: () => ({}),
} as unknown as ExcalidrawImperativeAPI;

function fetchStub(status: number, text = "") {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  })) as unknown as typeof fetch;
}

describe("exportFilename", () => {
  it.each<[ExportKind, string]>([
    ["png", "diagram.png"],
    ["png2x", "diagram.png"],
    ["svg", "diagram.svg"],
    ["scene", "diagram.excalidraw"],
  ])("maps %s to %s", (kind, expected) => {
    expect(exportFilename("diagram", kind)).toBe(expected);
  });
});

describe("postExport", () => {
  it("POSTs SVG markup with the svg mime type and returns the written path", async () => {
    const fetchFn = fetchStub(200, "/home/user/diagram.svg");
    const result = await postExport(fakeApi, "diagram", "svg", fetchFn);
    expect(result).toBe("/home/user/diagram.svg");
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/export?name=diagram.svg");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/svg+xml");
    expect(init.body).toBe("<svg>mock</svg>");
  });

  it("returns null when the server reports the dialog was cancelled (204)", async () => {
    const result = await postExport(fakeApi, "diagram", "png", fetchStub(204));
    expect(result).toBeNull();
  });

  it("throws on a server error", async () => {
    await expect(postExport(fakeApi, "diagram", "scene", fetchStub(500))).rejects.toThrow(
      /Export failed: 500/,
    );
  });
});
```

Run: `cd preview-binary/webview-src && npm test`
Expected: FAIL — `./export` module does not exist.

- [ ] **Step 3: Implement export.ts**

Create `preview-binary/webview-src/src/export.ts`:

```ts
import { exportToSvg, exportToBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type ExportKind = "png" | "png2x" | "svg" | "scene";

/** Maps an export kind to the suggested file name shown in the native save dialog. */
export function exportFilename(baseName: string, kind: ExportKind): string {
  switch (kind) {
    case "png":
    case "png2x":
      return `${baseName}.png`;
    case "svg":
      return `${baseName}.svg`;
    case "scene":
      return `${baseName}.excalidraw`;
  }
}

interface ExportPayload {
  body: BodyInit;
  mime: string;
}

async function buildExportPayload(
  api: ExcalidrawImperativeAPI,
  kind: ExportKind,
): Promise<ExportPayload> {
  const elements = api.getSceneElements();
  const appState = api.getAppState();
  const files = api.getFiles();

  switch (kind) {
    case "svg": {
      const svg = await exportToSvg({ elements, appState, files });
      return { body: svg.outerHTML, mime: "image/svg+xml" };
    }
    case "png":
    case "png2x": {
      const scale = kind === "png2x" ? 2 : 1;
      const blob = await exportToBlob({
        elements,
        appState,
        files,
        getDimensions: (width: number, height: number) => ({
          width: width * scale,
          height: height * scale,
          scale,
        }),
      });
      if (!blob) throw new Error("PNG export produced no data");
      return { body: await blob.arrayBuffer(), mime: "image/png" };
    }
    case "scene":
      return { body: serializeAsJSON(elements, appState, files, "local"), mime: "application/json" };
  }
}

/**
 * Exports the scene and POSTs it to the Rust server, which shows a native save dialog.
 * Returns the written path, or null if the user cancelled the dialog.
 */
export async function postExport(
  api: ExcalidrawImperativeAPI,
  baseName: string,
  kind: ExportKind,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const { body, mime } = await buildExportPayload(api, kind);
  const res = await fetchFn(`/export?name=${encodeURIComponent(exportFilename(baseName, kind))}`, {
    method: "POST",
    headers: { "Content-Type": mime },
    body,
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  return await res.text();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd preview-binary/webview-src && npm test`
Expected: 6 tests PASS.

- [ ] **Step 5: Replace the dead menu items in App.tsx**

Add the import at the top of `App.tsx`:

```ts
import { postExport, type ExportKind } from "./export";
```

Add the handler after `handleChange`:

```ts
  /** Exports via the Rust server's native save dialog; shows the outcome in a toast. */
  const handleExport = useCallback(
    async (kind: ExportKind) => {
      const api = apiRef.current;
      if (!api) return;
      try {
        const savedPath = await postExport(api, name, kind);
        if (savedPath) {
          api.setToast({ message: `Exported to ${savedPath}`, duration: 3000 });
        }
        // null = user cancelled the dialog — stay silent.
      } catch (e) {
        api.setToast({
          message: `Export failed: ${e instanceof Error ? e.message : String(e)}`,
          duration: 5000,
        });
      }
    },
    [name],
  );
```

In the `<MainMenu>` block, **delete** these two lines (browser downloads are dead in wry):

```tsx
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
```

and replace them with:

```tsx
          <MainMenu.Item onSelect={() => void handleExport("png")}>Export PNG</MainMenu.Item>
          <MainMenu.Item onSelect={() => void handleExport("png2x")}>Export PNG (2x)</MainMenu.Item>
          <MainMenu.Item onSelect={() => void handleExport("svg")}>Export SVG</MainMenu.Item>
          <MainMenu.Item onSelect={() => void handleExport("scene")}>
            Export scene (.excalidraw)
          </MainMenu.Item>
```

- [ ] **Step 6: Build everything**

Run: `cd preview-binary/webview-src && npm test && npm run build` then `just build-debug`
Expected: tests pass, vite build succeeds, binary embeds the new assets.

- [ ] **Step 7: Manual verification (macOS or Linux desktop)**

Run: `just ui && just build && target/release/excalidraw-preview preview-binary/test.excalidraw`
- Menu → Export PNG → native save dialog opens, defaulting to the file's directory with `test.png` suggested → confirm → file exists, toast shows the path.
- Menu → Export SVG → cancel the dialog → no toast, no file.

- [ ] **Step 8: Commit**

```bash
git add preview-binary/webview-src/src/export.ts preview-binary/webview-src/src/export.test.ts \
        preview-binary/webview-src/src/App.tsx preview-binary/webview-src/package.json \
        preview-binary/webview-src/package-lock.json preview-binary/assets
git commit -m "feat(webview): export menu posts to /export; add vitest suite"
```

---

## Task 12: Library persistence

**Files:**
- Modify: `preview-binary/Cargo.toml` (add `dirs`)
- Modify: `preview-binary/src/main.rs` (routes + path helper)
- Modify: `preview-binary/webview-src/src/main.tsx`
- Modify: `preview-binary/webview-src/src/App.tsx`

- [ ] **Step 1: Add the dirs dependency**

In `preview-binary/Cargo.toml` `[dependencies]`:

```toml
dirs = "6"
```

- [ ] **Step 2: Write failing route tests**

Add to the `tests` module in `main.rs` (env mutation is safe because nextest runs each test in its own process):

```rust
    #[tokio::test]
    async fn test_library_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("EXCALIDRAW_ZED_CONFIG_DIR", dir.path());

        // Empty default before anything is saved.
        let resp = serve_library().await.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["type"], "excalidrawlib");
        assert!(parsed["libraryItems"].as_array().unwrap().is_empty());

        // POST then GET round-trips the payload.
        let payload = r#"{"type":"excalidrawlib","version":2,"libraryItems":[{"id":"a"}]}"#;
        let resp = receive_library(axum::body::Bytes::from(payload)).await.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);

        let resp = serve_library().await.into_response();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(std::str::from_utf8(&body).unwrap(), payload);
    }
```

Run: `cargo nextest run -p excalidraw-preview-binary 'test(library)'`
Expected: FAIL — `serve_library` not found.

- [ ] **Step 3: Implement**

Add to `main.rs`:

```rust
/// Default (empty) shape library, served when no library has been saved yet.
const EMPTY_LIBRARY: &str = r#"{"type":"excalidrawlib","version":2,"libraryItems":[]}"#;

/// Path of the shared shape library: one file for all diagrams and sessions.
/// `EXCALIDRAW_ZED_CONFIG_DIR` overrides the platform config dir (used by tests).
fn library_path() -> Option<PathBuf> {
    let base = std::env::var("EXCALIDRAW_ZED_CONFIG_DIR")
        .map(PathBuf::from)
        .ok()
        .or_else(dirs::config_dir)?;
    Some(base.join("excalidraw-zed").join("library.excalidrawlib"))
}

async fn serve_library() -> impl IntoResponse {
    let content = library_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| EMPTY_LIBRARY.to_string());
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        content,
    )
}

async fn receive_library(body: axum::body::Bytes) -> Response {
    let Some(path) = library_path() else {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "no config directory available",
        )
            .into_response();
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
        }
    }
    match std::fs::write(&path, &body) {
        Ok(_) => axum::http::StatusCode::OK.into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}
```

Add the route:

```rust
        .route("/library", get(serve_library).post(receive_library))
```

Run: `cargo nextest run -p excalidraw-preview-binary` — all pass.

- [ ] **Step 4: Load the library in main.tsx**

In `main.tsx`, after the `/data` fetch and before building `initialData`, add:

```ts
    // Shared shape library — failure is non-fatal (e.g. dev-mode mock has no /library).
    let libraryItems: unknown[] = [];
    try {
      const libRes = await fetch(apiUrl("/library"));
      if (libRes.ok) {
        const lib = (await libRes.json()) as { libraryItems?: unknown[] };
        libraryItems = lib.libraryItems ?? [];
      }
    } catch {
      // library persistence unavailable; start with an empty panel
    }
```

And merge into the data passed to App — in the `render` call change `initialData={initialData}` to:

```tsx
        initialData={{ ...initialData, libraryItems: libraryItems as ExcalidrawInitialDataState["libraryItems"] }}
```

- [ ] **Step 5: Persist changes from App.tsx**

In `App.tsx`, add a debounced library save after `handleExport`:

```ts
  const libraryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Persists library panel changes to the shared library file (debounced 600 ms). */
  const handleLibraryChange = useCallback((items: readonly unknown[]) => {
    if (libraryTimer.current) clearTimeout(libraryTimer.current);
    libraryTimer.current = setTimeout(() => {
      fetch("/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems: items }),
      }).catch(() => {
        // server gone — nothing actionable from the webview
      });
    }, 600);
  }, []);
```

Wire it on the component:

```tsx
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
          onApiReady(api);
        }}
        initialData={{ ...initialData, scrollToContent: true }}
        theme={resolvedTheme}
        name={name}
        onChange={handleChange}
        onLibraryChange={handleLibraryChange}
      >
```

(If `onLibraryChange`'s parameter type complains under strict mode, use `LibraryItems` from `@excalidraw/excalidraw/types` instead of `readonly unknown[]`.)

- [ ] **Step 6: Build and verify**

Run: `cd preview-binary/webview-src && npm test && npm run build` then `just build-debug && cargo nextest run -p excalidraw-preview-binary`
Expected: all green.

Manual check: run the preview, add a shape to the library panel, close the window, reopen — the item is still there; `~/Library/Application Support/excalidraw-zed/library.excalidrawlib` (macOS) exists.

- [ ] **Step 7: Commit**

```bash
git add preview-binary/Cargo.toml Cargo.lock preview-binary/src/main.rs \
        preview-binary/webview-src/src/main.tsx preview-binary/webview-src/src/App.tsx \
        preview-binary/assets
git commit -m "feat: persist shape library across sessions via GET/POST /library"
```

---

## Task 13: Compound path_suffixes — click-to-preview for SVG/PNG variants

**Files:**
- Modify: `extension/languages/excalidraw/config.toml:3`

- [ ] **Step 1: Extend the suffix list**

```toml
path_suffixes = ["excalidraw", "excalidraw.svg", "excalidraw.png"]
```

- [ ] **Step 2: Rebuild and reinstall the dev extension**

Run: `cargo build -p excalidraw-preview --release --target wasm32-wasip1`
In Zed: command palette → `zed: install dev extension` → select `./extension`.

- [ ] **Step 3: Empirical verification (record results in README per spec §4.4)**

With `just symlink` in place and the release binary built:
1. Click a `.excalidraw` file → preview auto-opens. Expected: works (regression check).
2. Click a `.excalidraw.svg` file → preview auto-opens; Zed pane shows raw SVG text.
3. Click a `.excalidraw.png` file → record which wins: image viewer (no preview → document slash-command fallback as a known limitation) or language registration (preview opens).
4. Click a plain `.svg` and a plain `.png` → Excalidraw must NOT activate.

- [ ] **Step 4: Commit**

```bash
git add extension/languages/excalidraw/config.toml
git commit -m "feat(extension): claim .excalidraw.svg/.excalidraw.png via compound path_suffixes"
```

---

## Task 14: Round out integration coverage (POST /data + lock-file dedup)

**Files:**
- Modify: `preview-binary/tests/integration.rs`

- [ ] **Step 1: Write the tests**

```rust
#[test]
fn post_data_writes_scene_to_disk() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();

    let preview = Preview::spawn(&file, &[]);
    let updated = BLANK_SCENE.replace(r#""elements":[]"#, r#""elements":[{"id":"x"}]"#);

    let resp = reqwest::blocking::Client::new()
        .post(preview.url("/data"))
        .header("Content-Type", "application/json")
        .body(updated.clone())
        .timeout(Duration::from_secs(3))
        .send()
        .expect("POST /data failed");
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), updated);
}

#[test]
fn second_instance_for_same_file_exits_and_first_keeps_serving() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();

    let preview = Preview::spawn(&file, &[]);
    let first_port = preview.port;

    // Second invocation (foreground) must detect the live instance and exit 0
    // without taking over the lock file.
    let status = std::process::Command::new(binary())
        .arg(&file)
        .arg("--foreground")
        .arg("--headless")
        .status()
        .expect("second spawn failed");
    assert!(status.success());

    let canonical = std::fs::canonicalize(&file).unwrap();
    let lock_port: u16 = std::fs::read_to_string(lock_path_for(&canonical))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(lock_port, first_port, "second instance must not steal the lock");

    let (status, _) = http_get(&preview.url("/ping"));
    assert_eq!(status, 200, "first instance must still be alive");
}
```

- [ ] **Step 2: Run the full suite**

Run: `cargo nextest run -p excalidraw-preview-binary`
Expected: all pass. (The dedup test exercises the exact mechanism the extension now relies on after Task 6.)

- [ ] **Step 3: Commit**

```bash
git add preview-binary/tests/integration.rs
git commit -m "test: cover POST /data write path and lock-file instance dedup"
```

---

## Task 15: Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENT.md`
- Modify: `features/2026-06-12-forked/spec.md` (§3.1 wording sync)

- [ ] **Step 1: README — Creating a new drawing**

Add a section to `README.md`:

```markdown
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
```

- [ ] **Step 2: README — Known limitations**

```markdown
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
```

- [ ] **Step 3: AGENT.md sync**

In `AGENT.md`:
- Replace the Makefile section/table with the justfile recipes (same names plus `test`).
- Replace every `make <target>` reference with `just <target>`.
- Update the `path_suffixes` description for the language registration.
- Update the repository layout tree: `Makefile` → `justfile`, add `preview-binary/tests/`, `.config/nextest.toml`, `webview-src/src/export.ts`.
- In "Component 2" CLI section, document the new flags: `--new <path>`, `--foreground`, `--headless`, `--export-dir <dir>`; add `/export` and `/library` to the HTTP routes table; add `export_tx`/`export_dir` to the AppState listing.

- [ ] **Step 4: Spec wording sync**

In `features/2026-06-12-forked/spec.md` §3 (intro paragraph), replace:

> For `.excalidraw.svg` / `.excalidraw.png` targets, the binary writes the equivalent blank scene exported in that format (with embedded scene data).

with:

> For `.excalidraw.svg` / `.excalidraw.png` targets the file is created/left empty and the webview bootstraps it on first load (empty bytes → blank scene → immediate save in the declared format) — only Excalidraw's JS exporter can render those formats.

- [ ] **Step 5: Commit**

```bash
git add README.md AGENT.md features/2026-06-12-forked/spec.md
git commit -m "docs: justfile workflows, new-drawing flows, known limitations"
```

---

## Task 16: v0.2.0 release + Zed registry submission

**Files:**
- Modify: `extension/extension.toml:3`, `extension/Cargo.toml`, `extension/src/lib.rs:13`, `preview-binary/Cargo.toml:3`
- Create: `LICENSE` (repo root)

- [ ] **Step 1: License at repo root**

```bash
cp extension/LICENSE LICENSE
git add LICENSE
```

- [ ] **Step 2: Bump all four versions to 0.2.0**

- `extension/extension.toml`: `version = "0.2.0"`
- `extension/Cargo.toml`: `version = "0.2.0"`
- `extension/src/lib.rs`: `const BINARY_VERSION: &str = "0.2.0";`
- `preview-binary/Cargo.toml`: `version = "0.2.0"`

Run: `cargo build --workspace && cargo nextest run`
Expected: green.

- [ ] **Step 3: Commit and tag**

```bash
git add -A
git commit -m "chore: release v0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

- [ ] **Step 4: Verify the release**

- Watch `gh run watch` for the Release workflow; all 4 targets must produce assets named `excalidraw-preview-{target}` (`.exe` for Windows).
- Acceptance check: on a machine (or after `rm ~/.local/bin/excalidraw-preview` temporarily), install the dev extension with no binary on PATH and confirm the extension downloads from the new release and opens a preview.

- [ ] **Step 5: Zed registry submission (manual)**

1. Fork `zed-industries/extensions` to your personal account.
2. `git submodule add https://github.com/yankeeinlondon/excalidraw-zed-extension.git extensions/excalidraw-preview`
3. Add to `extensions.toml` — the manifest lives in `extension/`, not the repo root, so use the registry's monorepo `path` field:
   ```toml
   [excalidraw-preview]
   submodule = "extensions/excalidraw-preview"
   path = "extension"
   version = "0.2.0"
   ```
4. `pnpm sort-extensions`
5. Open the PR. Checklist: id has no `zed`/`extension` ✓ (`excalidraw-preview`), LICENSE at root ✓, versions in sync ✓, binaries downloaded at runtime not bundled ✓.

Note: confirm the `path` field against the current `zed-industries/extensions` CONTRIBUTING docs when submitting; if it has been removed, move `extension/`'s contents to the repo root in a follow-up commit first (mechanical move, no logic changes). Also note the LICENSE check applies to the `path` directory — `extension/LICENSE` already exists, so both root and subdirectory are covered after Step 1.

---

## Final verification (manual checklist from spec §5)

Per platform — macOS and Linux now; Windows deferred:

- [ ] Open each of the three formats; edit; Ctrl+S persists; external edit in Zed live-reloads without resetting viewport.
- [ ] Click each format in the project panel → preview auto-opens (PNG outcome recorded); plain `.svg`/`.png` unaffected.
- [ ] Export PNG (1x, 2x), SVG, scene JSON via the menu → native dialog → files land where chosen; cancel produces no file and no toast.
- [ ] New drawing via: empty-file save-as, `/new-excalidraw`, `--new`; all three refuse/avoid overwriting.
- [ ] Add a library item; restart preview; item persists; second diagram sees the same library.
- [ ] Insert an image via toolbar and paste one from clipboard; save; reload; images intact (spec §4.5 verification — file an issue if broken).
- [ ] Invoke preview twice on one file → second invocation focuses the existing window (now ≤100 ms thanks to the polling loop).
- [ ] `just --list`, `just test`, `just release` all work; CI green on push.
