use anyhow::Result;
use axum::{
    extract::State,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use clap::Parser;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use rust_embed::RustEmbed;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::{broadcast, watch};
use tracing::info;

/// A request from the HTTP layer to show a native save dialog and write export bytes.
/// Processed on the platform UI thread (tao event loop / GTK main context).
struct ExportRequest {
    bytes: Vec<u8>,
    suggested_name: String,
    default_dir: PathBuf,
    /// `Some(path)` once written, `None` if the user cancelled the dialog.
    reply: tokio::sync::oneshot::Sender<Option<PathBuf>>,
}

/// A request from the HTTP layer to show a native *open* dialog filtered to
/// `.excalidrawlib` and return the chosen file's bytes. Processed on the
/// platform UI thread, mirroring the `ExportRequest` flow.
struct LibraryOpenRequest {
    default_dir: PathBuf,
    /// `Some(bytes)` once a file is read, `None` if the user cancelled the dialog.
    reply: tokio::sync::oneshot::Sender<Option<Vec<u8>>>,
}

/// Tracks the WebView's save state so native code (close-confirm, menu Save) can
/// decide whether a save is needed. Mirrors what the frontend POSTs to `/dirty`.
#[derive(Clone, Debug, Default)]
struct DirtyState {
    /// The scene has unsaved edits relative to the file on disk.
    dirty: bool,
    /// A debounced auto-save is queued but has not completed yet.
    pending_save: bool,
    /// Unix-epoch millis of the last successful save, if any.
    last_saved_at: Option<u64>,
}

/// The resolved outcome of a native-triggered JS action (e.g. "save and close").
/// Sent back over the correlation channel when `/native-action-result` arrives.
///
/// The fields are read by the close-after-save flow wired in a later phase; for
/// now they are only populated, so silence the dead-code lint here.
#[derive(Clone, Debug)]
#[allow(dead_code)]
struct NativeActionResult {
    /// The action name echoed back by the frontend (e.g. `"save"`).
    action: String,
    /// Whether the action succeeded.
    ok: bool,
    /// Failure detail, when `ok` is false.
    error: Option<String>,
}

/// Correlation table: maps a request id issued by native code to the one-shot
/// channel that a waiting flow (e.g. close-after-save) is blocked on. The
/// `/native-action-result` handler removes and fulfils the matching entry.
type PendingActions = Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<NativeActionResult>>>>;

/// An event pushed to the WebView over the `/events` SSE stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PreviewEvent {
    /// The scene file changed on disk — reload the drawing.
    Reload,
    /// The shared shape library changed (e.g. a "Browse libraries" install) —
    /// reload the library panel.
    Library,
}

impl PreviewEvent {
    /// The SSE `data:` payload the WebView switches on.
    fn as_sse_data(self) -> &'static str {
        match self {
            PreviewEvent::Reload => "reload",
            PreviewEvent::Library => "library",
        }
    }
}

#[derive(Clone)]
struct AppState {
    file_path: PathBuf,
    lock_path: PathBuf,
    content_type: String,
    file_name: String,
    auto_save: bool,
    broadcast_tx: broadcast::Sender<PreviewEvent>,
    /// Sends `true` to signal the webview window to focus.
    focus_tx: Arc<watch::Sender<bool>>,
    /// Sends export requests to the UI thread for the native save dialog.
    export_tx: std::sync::mpsc::Sender<ExportRequest>,
    /// Sends library-open requests to the UI thread for the native `.excalidrawlib` open dialog.
    library_open_tx: std::sync::mpsc::Sender<LibraryOpenRequest>,
    /// When set (--export-dir), exports bypass the dialog and write here.
    export_dir: Option<PathBuf>,
    /// Shared WebView save state, updated by `POST /dirty`.
    dirty: Arc<RwLock<DirtyState>>,
    /// Pending native-action correlation table, resolved by `POST /native-action-result`.
    pending_actions: PendingActions,
    /// Raw `.excalidrawlib` documents fetched by a "Browse libraries" install and
    /// not yet pulled into the editor. `POST /install-library` pushes; the WebView
    /// drains them via `GET /pending-library` after the `library` SSE event.
    pending_libraries: Arc<Mutex<Vec<String>>>,
}

/// Everything the WebView event loop needs to run the unsaved-changes close
/// flow: the shared dirty state, the correlation table for the save-and-close
/// JS round-trip, whether auto-save is on, and the lock file to clean up on exit.
///
/// In `--dev` mode a default (not-dirty, no-lock) context is used, so the window
/// always closes immediately.
#[derive(Clone)]
struct CloseContext {
    /// Shared WebView dirty state (mirrors `POST /dirty`).
    dirty: Arc<RwLock<DirtyState>>,
    /// Correlation table resolved by `POST /native-action-result`.
    pending_actions: PendingActions,
    /// Whether auto-save is enabled (decides silent-save vs. confirm dialog).
    auto_save: bool,
    /// Lock file removed before the process exits. `None` in dev mode.
    lock_path: Option<PathBuf>,
    /// When true (`--smoke`), the event loop runs [`SmokeDriver`] against the real
    /// WebView, prints a report, and exits instead of waiting for the user.
    smoke: bool,
    /// Window-title text *without* the dirty marker: `"{repo}({branch}) | {file}"`
    /// inside a git repo, else just `"{file}"`. The live `*` marker is appended by
    /// [`CloseContext::window_title`] from the current dirty state.
    title_base: String,
}

impl CloseContext {
    /// A no-op context for `--dev`: never dirty, nothing to clean up.
    fn dev() -> Self {
        Self {
            dirty: Arc::new(RwLock::new(DirtyState::default())),
            pending_actions: Arc::new(Mutex::new(HashMap::new())),
            auto_save: false,
            lock_path: None,
            smoke: false,
            title_base: "Excalidraw Preview".to_string(),
        }
    }

    /// The full window title for the current dirty state: `title_base` with a
    /// trailing `*` when the scene has unsaved edits. Called on each event-loop
    /// tick so the marker tracks edits and saves live.
    fn window_title(&self) -> String {
        let dirty = self.dirty.read().map(|d| d.dirty).unwrap_or(false);
        if dirty {
            format!("{}*", self.title_base)
        } else {
            self.title_base.clone()
        }
    }

    /// Removes the lock file (if any) so it doesn't outlive the process. The tao
    /// event loop calls this just before exiting because `EventLoop::run` never
    /// returns to `main` on macOS/Windows; the GTK path returns normally and
    /// `main` cleans up too, but calling here as well is idempotent.
    fn cleanup_lock(&self) {
        if let Some(path) = &self.lock_path {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(RustEmbed)]
#[folder = "assets/"]
struct Assets;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigResponse {
    content_type: String,
    name: String,
    theme: String,
    auto_save: bool,
}

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
    if let Some(dir) = &args.export_dir {
        cmd.arg("--export-dir").arg(dir);
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

/// Entry point. Keeps the main thread free for the native event loop (required on macOS).
fn main() -> Result<()> {
    let args = CliArgs::parse();

    if args.lsp {
        return run_lsp_server();
    }

    if args.debug {
        tracing_subscriber::fmt()
            .with_env_filter("excalidraw_preview=debug")
            .init();
    }

    // --dev / --dev-server: open the WebView on the Vite dev server instead of the
    // embedded assets.  Run `npm run dev` in webview-src first.
    let dev_url = args.dev_server.as_deref()
        .or_else(|| args.dev.then_some("http://localhost:5173"));
    if let Some(dev_url) = dev_url {
        eprintln!("[dev] Opening WebView at {dev_url}");
        eprintln!("[dev] Make sure `npm run dev` is running in preview-binary/webview-src/");
        let (_focus_tx, focus_rx) = watch::channel(false);
        let (_export_tx, export_rx) = std::sync::mpsc::channel();
        let (_library_open_tx, library_open_rx) = std::sync::mpsc::channel();
        if let Err(e) =
            run_webview_url(dev_url, focus_rx, export_rx, library_open_rx, CloseContext::dev())
        {
            eprintln!("WebView error: {e}");
        }
        return Ok(());
    }

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

    let file_path = PathBuf::from(&file);
    if !file_path.exists() {
        anyhow::bail!("File not found: {}", file_path.display());
    }

    // Detach from the parent so callers (Zed extension, terminals) return
    // immediately. `--smoke` must stay attached so its report and exit code reach
    // the caller, so it implies foreground.
    if !args.foreground && !args.smoke {
        return daemonize(&file, &args);
    }

    let content_type = detect_content_type(&file_path);
    let file_name = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "diagram".to_string());

    let canonical_path = std::fs::canonicalize(&file_path)?;

    if bootstrap_if_empty(&canonical_path)? {
        info!("Bootstrapped empty file with a blank scene");
    }

    let lock_path = get_lock_path(&canonical_path);

    // Build a multi-thread runtime; main thread is reserved for the WebView event loop.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    // If another instance is already serving this file, focus it and exit.
    if let Ok(port) = rt.block_on(check_existing_instance(&lock_path)) {
        info!("Found existing instance on port {}, focusing window", port);
        let client = reqwest::Client::new();
        let _ = rt.block_on(
            client
                .get(format!("http://127.0.0.1:{}/focus", port))
                .send(),
        );
        return Ok(());
    }

    let (broadcast_tx, _) = broadcast::channel::<PreviewEvent>(16);
    let (focus_tx, focus_rx) = watch::channel(false);
    let focus_tx = Arc::new(focus_tx);
    let (export_tx, export_rx) = std::sync::mpsc::channel::<ExportRequest>();
    let (library_open_tx, library_open_rx) = std::sync::mpsc::channel::<LibraryOpenRequest>();

    // Bind first, then learn the actual port from the bound socket. Binding to
    // port 0 lets the OS hand out a free ephemeral port atomically, eliminating
    // the time-of-check/time-of-use race that a "probe then bind" scheme has when
    // several previews start concurrently. With `--port`, an occupied port now
    // fails cleanly here instead of silently after the lock file is written.
    let requested_port = args.port.unwrap_or(0);
    let addr = SocketAddr::from(([127, 0, 0, 1], requested_port));
    let listener = rt
        .block_on(tokio::net::TcpListener::bind(addr))
        .map_err(|e| anyhow::anyhow!("failed to bind 127.0.0.1:{requested_port}: {e}"))?;
    let port = listener.local_addr()?.port();
    info!("Server listening on http://127.0.0.1:{}", port);

    let state = Arc::new(AppState {
        file_path: canonical_path.clone(),
        lock_path: lock_path.clone(),
        content_type,
        file_name,
        auto_save: args.auto_save,
        broadcast_tx: broadcast_tx.clone(),
        focus_tx: focus_tx.clone(),
        export_tx,
        library_open_tx,
        export_dir: args.export_dir.clone(),
        dirty: Arc::new(RwLock::new(DirtyState::default())),
        pending_actions: Arc::new(Mutex::new(HashMap::new())),
        pending_libraries: Arc::new(Mutex::new(Vec::new())),
    });

    // Only now that the port is bound and known do we publish it to the lock file.
    std::fs::write(&lock_path, port.to_string())?;

    let app = Router::new()
        .route("/", get(serve_index))
        .route("/config", get(serve_config))
        .route("/data", get(serve_data).post(receive_data))
        .route("/library", get(serve_library).post(receive_library))
        .route("/library-install", get(serve_library_install))
        .route("/install-library", axum::routing::post(install_library))
        .route("/pending-library", get(drain_pending_libraries))
        .route("/copy-clipboard", axum::routing::post(copy_to_clipboard))
        .route("/events", get(serve_events))
        .route("/focus", get(handle_focus))
        .route("/shutdown", get(handle_shutdown))
        .route("/ping", get(ping))
        .route("/export", axum::routing::post(handle_export))
        .route(
            "/native-library-request",
            axum::routing::post(receive_library_request),
        )
        .route("/dirty", axum::routing::post(receive_dirty))
        .route(
            "/native-action-result",
            axum::routing::post(receive_native_action_result),
        )
        .route("/assets/{*path}", get(serve_assets))
        .with_state(state.clone());

    // Spawn file watcher — uses a std::sync::mpsc channel so no nested async runtime is needed.
    let watcher_broadcast = broadcast_tx.clone();
    let (watcher_event_tx, watcher_event_rx) = std::sync::mpsc::channel();
    let mut fs_watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = watcher_event_tx.send(event);
            }
        },
        Config::default(),
    )?;
    fs_watcher.watch(canonical_path.as_path(), RecursiveMode::NonRecursive)?;

    std::thread::spawn(move || {
        // Keep `fs_watcher` alive for the duration of this thread.
        let _watcher = fs_watcher;
        let debounce = std::time::Duration::from_millis(80);
        let mut last_sent = std::time::Instant::now()
            .checked_sub(debounce * 2)
            .unwrap_or_else(std::time::Instant::now);

        for event in watcher_event_rx {
            match event.kind {
                notify::EventKind::Modify(_) | notify::EventKind::Create(_) => {
                    let now = std::time::Instant::now();
                    if now.duration_since(last_sent) >= debounce {
                        last_sent = now;
                        info!("File changed, sending reload event");
                        let _ = watcher_broadcast.send(PreviewEvent::Reload);
                    }
                }
                _ => {}
            }
        }
    });

    // Spawn the HTTP server as a background task with graceful shutdown.
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    rt.spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("HTTP server failed");
    });

    // Run the WebView event loop on the main thread (required on macOS / some Linux WMs).
    // `--smoke` needs a real window to test, so it overrides `--headless`.
    if args.headless && !args.smoke {
        info!("Headless mode: serving without a window until /shutdown or kill");
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    }

    // Title bar: "{Repo Title Case}({branch}) | {path-from-repo-root}" when the
    // file lives in a git repo, else the file's path (home-relative via `~`, or
    // absolute when outside home). The live "*" dirty marker is appended per-tick
    // by CloseContext::window_title. Computed once here (branch/repo are resolved
    // at launch; only the dirty marker updates while the window is open).
    let title_base = match git_repo_label(&canonical_path) {
        Some((repo_label, repo_relative_path)) => {
            // U+2503 (heavy vertical) separates repo info from the path — a
            // full-height rule that reads more clearly than an ASCII `|`.
            format!("{repo_label} ┃ {repo_relative_path}")
        }
        None => display_path(&canonical_path),
    };
    let close_ctx = CloseContext {
        dirty: state.dirty.clone(),
        pending_actions: state.pending_actions.clone(),
        auto_save: args.auto_save,
        lock_path: Some(lock_path.clone()),
        smoke: args.smoke,
        title_base,
    };
    if let Err(e) = run_webview(port, focus_rx, export_rx, library_open_rx, close_ctx) {
        eprintln!(
            "WebView error: {}. Server running at http://127.0.0.1:{}",
            e, port
        );
        eprintln!("(WebView not available in this environment)");
        // Keep server running briefly so user can test
        std::thread::sleep(std::time::Duration::from_secs(60));
    }

    // Webview closed — tear down server and remove lock file.
    let _ = shutdown_tx.send(());
    rt.shutdown_timeout(std::time::Duration::from_secs(5));
    let _ = std::fs::remove_file(&lock_path);
    info!("Shutdown complete");

    Ok(())
}

/// Determine MIME type from the file name (extension is authoritative; no byte sniffing).
fn detect_content_type(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    if name.ends_with(".excalidraw.svg") {
        "image/svg+xml".to_string()
    } else if name.ends_with(".excalidraw.png") {
        "image/png".to_string()
    } else {
        "application/json".to_string()
    }
}

/// For a file inside a git repo, returns `(repo_label, repo_relative_path)` where
/// `repo_label` is `"{Repo Title Case}({branch})"` and `repo_relative_path` is the
/// file's path from the work-tree root (forward-slashed). Returns `None` when the
/// file is not in a (non-bare) git repo, so the caller falls back to the display
/// path.
///
/// `path` must be absolute/canonical; the working dir is canonicalized too so the
/// relative-path strip is robust against symlinked repo roots.
fn git_repo_label(path: &Path) -> Option<(String, String)> {
    // `gix::discover` walks *up* from a directory; handed a file path it errors
    // ("not a directory") and we'd fall back to the plain path. Start from the
    // file's parent directory so discovery actually runs (this also resolves
    // linked worktrees, whose `.git` is a gitdir-pointer file).
    let start = path.parent().unwrap_or(path);
    let repo = gix::discover(start).ok()?;

    // The repo *name* comes from the main repository, not the work tree: for a
    // linked worktree `work_dir()` is the worktree's own directory (e.g.
    // `claudine`), whereas `common_dir()` points at the main repo's `.git` (e.g.
    // `…/rusty-biscuit/.git`), whose parent is the project root. For a normal
    // checkout the two coincide.
    let repo_name = main_repo_name(repo.common_dir())?;

    // The relative path stays anchored at the current work tree (the worktree
    // root for a linked worktree), forward-slashed and never absolute.
    let workdir = std::fs::canonicalize(repo.work_dir()?).ok()?;
    let relative = path
        .strip_prefix(&workdir)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    Some((
        format!("{}({})", title_case(&repo_name), git_branch(&repo)),
        relative,
    ))
}

/// The project name for a repository, derived from its common git dir
/// (`gix::Repository::common_dir`). For the usual `<root>/.git` layout this is
/// `<root>`'s directory name; a bare-style `<name>.git` falls back to `<name>`.
/// Returns `None` only if the path has no usable final component.
fn main_repo_name(common_dir: &Path) -> Option<String> {
    // Best-effort canonicalize: normalizes any `..`/trailing slash so the `.git`
    // suffix check is reliable, but a non-canonicalizable path still works as-is.
    let canon = std::fs::canonicalize(common_dir).unwrap_or_else(|_| common_dir.to_path_buf());
    let last = canon.file_name()?.to_string_lossy().to_string();
    if last == ".git" {
        // `<root>/.git` → the project is the parent directory.
        return Some(canon.parent()?.file_name()?.to_string_lossy().to_string());
    }
    // Bare repo like `<name>.git` → strip the suffix.
    Some(last.strip_suffix(".git").unwrap_or(&last).to_string())
}

/// Converts a repo directory name into a Title Case label: word separators
/// (`-`, `_`, space) collapse into single spaces and each word's first letter is
/// uppercased, e.g. `excalidraw-zed-extension` → `Excalidraw Zed Extension`. The
/// rest of each word is left untouched so acronyms (`my-API-tool` → `My API Tool`)
/// survive.
fn title_case(name: &str) -> String {
    name.split(['-', '_', ' '])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Renders an absolute path for the title bar of a file that is *not* in a git
/// repo: paths under the user's home directory use the `~` alias (`~` for the home
/// dir itself, `~/rel/path` beneath it); everything else is shown in full. Output
/// is forward-slashed for consistency with the repo-relative path.
fn display_path(path: &Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(rest) = path.strip_prefix(&home) {
            let rest = rest.to_string_lossy().replace('\\', "/");
            return if rest.is_empty() {
                "~".to_string()
            } else {
                format!("~/{rest}")
            };
        }
    }
    path.to_string_lossy().replace('\\', "/")
}

/// Short name of the repo's current branch (e.g. `main`), or the short commit id
/// when HEAD is detached, or `?` if it can't be determined.
fn git_branch(repo: &gix::Repository) -> String {
    if let Ok(Some(name)) = repo.head_name() {
        return name.shorten().to_string();
    }
    repo.head_id()
        .map(|id| id.to_hex_with_len(7).to_string())
        .unwrap_or_else(|_| "?".to_string())
}

/// A minimal valid Excalidraw scene, written into empty `.excalidraw` files.
const BLANK_SCENE_JSON: &str = r##"{
  "type": "excalidraw",
  "version": 2,
  "source": "excalidraw-zed-preview",
  "elements": [],
  "appState": { "gridSize": null, "viewBackgroundColor": "#ffffff" },
  "files": {}
}"##;

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

/// Returns the path of the per-file lock file stored in the system temp directory.
fn get_lock_path(canonical_path: &Path) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(canonical_path.to_string_lossy().as_bytes());
    let hash: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    let tmpdir = std::env::var("TMPDIR")
        .or_else(|_| std::env::var("TEMP"))
        .unwrap_or_else(|_| "/tmp".to_string());

    PathBuf::from(tmpdir).join(format!("excalidraw-{}.lock", &hash[..16]))
}

/// Checks whether a lock file points to a live server instance.
/// Returns the port on success, or an error if the lock is stale / missing.
async fn check_existing_instance(lock_path: &PathBuf) -> Result<u16> {
    let port_str = std::fs::read_to_string(lock_path)?;
    let port: u16 = port_str.trim().parse()?;

    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://127.0.0.1:{}/ping", port))
        .timeout(std::time::Duration::from_secs(1))
        .send()
        .await?;

    if response.status().is_success() {
        Ok(port)
    } else {
        std::fs::remove_file(lock_path).ok();
        anyhow::bail!("Stale lock file")
    }
}

// ── Route handlers ──────────────────────────────────────────────────────────

async fn serve_index() -> Response {
    match Assets::get("index.html") {
        Some(content) => (
            axum::http::StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
            content.data.to_vec(),
        )
            .into_response(),
        None => (axum::http::StatusCode::NOT_FOUND, "index.html not found").into_response(),
    }
}

async fn serve_config(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let config = ConfigResponse {
        content_type: state.content_type.clone(),
        name: state.file_name.clone(),
        theme: "auto".to_string(),
        auto_save: state.auto_save,
    };
    axum::Json(config)
}

async fn serve_data(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match std::fs::read(&state.file_path) {
        Ok(data) => (
            axum::http::StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, state.content_type.clone())],
            data,
        )
            .into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Receives edited scene data from the WebView and writes it back to disk.
/// The file watcher will fire after this write; the client suppresses that SSE event.
async fn receive_data(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    match std::fs::write(&state.file_path, &body) {
        Ok(_) => axum::http::StatusCode::OK.into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn serve_events(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    use axum::response::sse::{Event, Sse};

    let mut rx = state.broadcast_tx.subscribe();

    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    yield Ok::<Event, Infallible>(Event::default().data(event.as_sse_data()))
                }
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
            }
        }
    };

    Sse::new(stream)
}

async fn handle_focus(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let _ = state.focus_tx.send(true);
    "OK"
}

async fn handle_shutdown(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let lock_path = state.lock_path.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let _ = std::fs::remove_file(&lock_path);
        std::process::exit(0);
    });
    "OK"
}

async fn ping() -> impl IntoResponse {
    "OK"
}

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

/// Default window size (logical px) when nothing has been remembered yet.
const DEFAULT_WINDOW_SIZE: (f64, f64) = (1200.0, 800.0);
/// Floor for a remembered/clamped window size so a corrupt or tiny value can
/// never open an unusably small window.
const MIN_WINDOW_SIZE: (f64, f64) = (400.0, 300.0);

/// Path of the persisted window size: one global value shared by every diagram
/// and session. `EXCALIDRAW_ZED_CONFIG_DIR` overrides the platform config dir.
fn window_state_path() -> Option<PathBuf> {
    let base = std::env::var("EXCALIDRAW_ZED_CONFIG_DIR")
        .map(PathBuf::from)
        .ok()
        .or_else(dirs::config_dir)?;
    Some(base.join("excalidraw-zed").join("window.json"))
}

/// The last persisted window size in logical pixels, if present and sane.
/// Corrupt, non-finite, or below-minimum values are rejected (→ `None`).
fn load_window_size() -> Option<(f64, f64)> {
    let text = std::fs::read_to_string(window_state_path()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let w = v.get("width")?.as_f64()?;
    let h = v.get("height")?.as_f64()?;
    if w.is_finite() && h.is_finite() && w >= MIN_WINDOW_SIZE.0 && h >= MIN_WINDOW_SIZE.1 {
        Some((w, h))
    } else {
        None
    }
}

/// Persists the window size (logical pixels) for next launch. Best-effort: any
/// I/O error is ignored (a missing remembered size just falls back to default).
fn save_window_size(width: f64, height: f64) {
    let Some(path) = window_state_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = serde_json::json!({ "width": width, "height": height }).to_string();
    let _ = std::fs::write(path, body);
}

/// Clamps a desired logical window size so it never exceeds the monitor's
/// logical size (a size remembered from a larger display can't open off-screen)
/// while staying at or above [`MIN_WINDOW_SIZE`]. `None` monitor → size unchanged
/// (apart from the minimum floor).
fn clamp_window_size(size: (f64, f64), monitor_logical: Option<(f64, f64)>) -> (f64, f64) {
    let (mut w, mut h) = size;
    if let Some((mw, mh)) = monitor_logical {
        w = w.min(mw);
        h = h.min(mh);
    }
    (w.max(MIN_WINDOW_SIZE.0), h.max(MIN_WINDOW_SIZE.1))
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

/// Landing page for the "Browse libraries" install round-trip.
///
/// `libraryReturnUrl` points the libraries.excalidraw.com "Add to Excalidraw"
/// button back here as `…/library-install#addLibrary=<libraryUrl>&token=<token>`.
/// The click happens in the *system browser* (the libraries site opens there),
/// and the `addLibrary` value rides in the URL fragment — which is never sent to
/// the server — so this tiny page reads it client-side and hands the library URL
/// to `POST /install-library`. The server then fetches + merges + persists it and
/// notifies the live WebView over SSE, so the items appear back in the editor.
const LIBRARY_INSTALL_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Add to Excalidraw</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font: 16px/1.5 system-ui, -apple-system, sans-serif; background: #1e1e1e; color: #e6e6e6; }
  .card { max-width: 420px; padding: 32px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { margin: 8px 0; color: #b8b8b8; }
  .ok { color: #6ee7a8; }
  .err { color: #ff8a8a; }
</style>
</head>
<body>
  <div class="card">
    <h1 id="title">Adding library…</h1>
    <p id="status">Contacting the Excalidraw preview…</p>
  </div>
<script>
  (function () {
    var title = document.getElementById("title");
    var status = document.getElementById("status");
    function params(s) { try { return new URLSearchParams(s); } catch (e) { return new URLSearchParams(); } }
    // useHash=true puts addLibrary in the fragment; fall back to the query string.
    var hash = params(location.hash.replace(/^#/, ""));
    var search = params(location.search.replace(/^\?/, ""));
    var libraryUrl = hash.get("addLibrary") || search.get("addLibrary");
    if (!libraryUrl) {
      title.textContent = "No library to add";
      title.className = "err";
      status.textContent = "This page is opened automatically when you click “Add to Excalidraw”.";
      return;
    }
    fetch("/install-library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ libraryUrl: libraryUrl }),
    })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, text: t }; }); })
      .then(function (res) {
        if (res.ok) {
          title.textContent = "Library added ✓";
          title.className = "ok";
          status.textContent = "Switch back to the Excalidraw window — the shapes are in your library panel. You can close this tab.";
        } else {
          title.textContent = "Could not add library";
          title.className = "err";
          status.textContent = res.text || "The preview rejected the install.";
        }
      })
      .catch(function () {
        title.textContent = "Could not add library";
        title.className = "err";
        status.textContent = "The Excalidraw preview is no longer running. Reopen the file and try again.";
      });
  })();
</script>
</body>
</html>"#;

/// Serves the static "Add to Excalidraw" landing page (see [`LIBRARY_INSTALL_HTML`]).
async fn serve_library_install() -> impl IntoResponse {
    axum::response::Html(LIBRARY_INSTALL_HTML)
}

/// Request body for [`install_library`].
#[derive(serde::Deserialize)]
struct InstallLibraryRequest {
    #[serde(rename = "libraryUrl")]
    library_url: String,
}

/// Whether a library URL is safe for the server to fetch. Guards against SSRF:
/// only `https` URLs on Excalidraw's libraries host or the GitHub raw/gist hosts
/// those libraries are published from are allowed.
fn is_allowed_library_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    matches!(
        parsed.host_str(),
        Some(
            "libraries.excalidraw.com"
                | "excalidraw.com"
                | "raw.githubusercontent.com"
                | "gist.githubusercontent.com"
        )
    )
}

/// Fetches the `.excalidrawlib` the user picked on libraries.excalidraw.com and
/// queues it for the open editor. Called by the `/library-install` landing page.
///
/// The server (not the browser) does the fetch — sidestepping CORS and confining
/// it to allow-listed hosts — then validates the bytes are an Excalidraw library
/// and parks the raw document in `pending_libraries`. A `PreviewEvent::Library`
/// broadcast wakes the WebView, which drains [`drain_pending_libraries`] and hands
/// each document to Excalidraw's own `updateLibrary` (it parses both the legacy
/// `library` v1 and the `libraryItems` v2 shapes, so no migration lives here).
async fn install_library(
    State(state): State<Arc<AppState>>,
    axum::Json(req): axum::Json<InstallLibraryRequest>,
) -> Response {
    use axum::http::StatusCode;

    if !is_allowed_library_url(&req.library_url) {
        return (
            StatusCode::BAD_REQUEST,
            "Library URL is not an allowed https Excalidraw/GitHub source",
        )
            .into_response();
    }

    // Fetch the raw library document from the chosen source.
    let body = match reqwest::get(&req.library_url).await {
        Ok(resp) if resp.status().is_success() => match resp.text().await {
            Ok(t) => t,
            Err(e) => {
                return (StatusCode::BAD_GATEWAY, format!("Could not read library: {e}"))
                    .into_response();
            }
        },
        Ok(resp) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Library source returned HTTP {}", resp.status()),
            )
                .into_response();
        }
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("Could not fetch library: {e}"))
                .into_response();
        }
    };

    // Validate it's actually an Excalidraw library (either format) before queuing,
    // so a wrong URL can't park garbage for the editor to choke on.
    if !is_excalidraw_library(&body) {
        return (StatusCode::BAD_REQUEST, "Not an Excalidraw library file").into_response();
    }

    if let Ok(mut pending) = state.pending_libraries.lock() {
        pending.push(body);
    }
    let _ = state.broadcast_tx.send(PreviewEvent::Library);
    (StatusCode::OK, "Library queued for the editor").into_response()
}

/// Whether `body` parses as an Excalidraw library document — `type` is
/// `"excalidrawlib"` and it carries either a v2 `libraryItems` array or a legacy
/// v1 `library` array.
fn is_excalidraw_library(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    let is_lib_type = value.get("type").and_then(|t| t.as_str()) == Some("excalidrawlib");
    let has_items = value.get("libraryItems").is_some_and(|v| v.is_array())
        || value.get("library").is_some_and(|v| v.is_array());
    is_lib_type && has_items
}

/// Drains the queued "Browse libraries" installs, returning the raw documents for
/// the WebView to feed to `updateLibrary`. Returns `{ "libraries": [...] }`;
/// empties the queue so each document is applied once.
async fn drain_pending_libraries(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let libraries: Vec<String> = state
        .pending_libraries
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default();
    axum::Json(serde_json::json!({ "libraries": libraries }))
}

/// Writes the request body to the system clipboard as text.
///
/// The WebView posts here from "Copy SVG to clipboard" instead of using the
/// page's `navigator.clipboard`: WKWebView rejects an async clipboard write once
/// the SVG has been generated (the `await` drops the transient user-activation),
/// which is why Excalidraw's built-in "Copy to clipboard as SVG" fails in the
/// embedded window. Going through the OS clipboard here sidesteps that entirely.
/// Runs on a blocking thread since `arboard` is synchronous.
async fn copy_to_clipboard(body: axum::body::Bytes) -> Response {
    use axum::http::StatusCode;
    let text = String::from_utf8_lossy(&body).into_owned();
    let result = tokio::task::spawn_blocking(move || {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(text))
            .map_err(|e| e.to_string())
    })
    .await;
    match result {
        Ok(Ok(())) => StatusCode::OK.into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

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

/// Fronts the native `.excalidrawlib` open dialog for `window.__excalidrawImportLibrary`.
///
/// Marshals a `LibraryOpenRequest` to the UI thread, waits for the user's choice,
/// and returns the chosen file's bytes as JSON (the frontend validates the shape).
/// A cancelled dialog returns `204 No Content`; the frontend treats that as a
/// silent no-op.
async fn receive_library_request(State(state): State<Arc<AppState>>) -> Response {
    let default_dir = state
        .file_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    let request = LibraryOpenRequest {
        default_dir,
        reply: reply_tx,
    };
    if state.library_open_tx.send(request).is_err() {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "library dialog channel closed (no window?)",
        )
            .into_response();
    }
    match reply_rx.await {
        Ok(Some(bytes)) => (
            axum::http::StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            bytes,
        )
            .into_response(),
        Ok(None) => axum::http::StatusCode::NO_CONTENT.into_response(),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "library dialog failed",
        )
            .into_response(),
    }
}

/// Body of `POST /dirty`: the WebView's current save state.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirtyPayload {
    dirty: bool,
    pending_save: bool,
    last_saved_at: Option<u64>,
}

/// Body of `POST /native-action-result`: the outcome of a native-triggered JS action.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeActionResultPayload {
    id: String,
    action: String,
    ok: bool,
    error: Option<String>,
}

/// Updates the shared dirty state from a frontend report.
async fn receive_dirty(
    State(state): State<Arc<AppState>>,
    axum::Json(payload): axum::Json<DirtyPayload>,
) -> impl IntoResponse {
    if let Ok(mut dirty) = state.dirty.write() {
        dirty.dirty = payload.dirty;
        dirty.pending_save = payload.pending_save;
        if let Some(ts) = payload.last_saved_at {
            dirty.last_saved_at = Some(ts);
        }
    }
    axum::http::StatusCode::OK
}

/// Resolves a pending native action by its correlation id, unblocking any flow
/// (e.g. close-after-save) waiting on the result. Unknown ids are a no-op so a
/// late/duplicate report cannot error.
async fn receive_native_action_result(
    State(state): State<Arc<AppState>>,
    axum::Json(payload): axum::Json<NativeActionResultPayload>,
) -> impl IntoResponse {
    if let Ok(mut pending) = state.pending_actions.lock() {
        if let Some(tx) = pending.remove(&payload.id) {
            let _ = tx.send(NativeActionResult {
                action: payload.action,
                ok: payload.ok,
                error: payload.error,
            });
        }
    }
    axum::http::StatusCode::OK
}

async fn serve_assets(axum::extract::Path(path): axum::extract::Path<String>) -> impl IntoResponse {
    let path = path.strip_prefix("/").unwrap_or(&path);
    match Assets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string();
            (
                axum::http::StatusCode::OK,
                [(axum::http::header::CONTENT_TYPE, mime)],
                content.data.to_vec(),
            )
                .into_response()
        }
        None => (axum::http::StatusCode::NOT_FOUND, "Asset not found").into_response(),
    }
}

// ── WebView ──────────────────────────────────────────────────────────────────

/// Decides whether a navigation / new-window target should stay inside the WebView.
///
/// Loopback hosts (the embedded server and the Vite dev server) plus the non-HTTP
/// schemes the editor relies on (`data:`, `blob:`, `about:`) are internal; every
/// other `http`/`https` host (docs links, `libraries.excalidraw.com`, GitHub) is
/// external and is opened in the system browser instead.
fn is_internal_url(url: &str) -> bool {
    if url.starts_with("data:") || url.starts_with("blob:") || url.starts_with("about:") {
        return true;
    }
    if let Some(rest) = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    {
        let host = rest.split(['/', ':', '?', '#']).next().unwrap_or("");
        return host == "127.0.0.1" || host == "localhost" || host == "[::1]";
    }
    // Unknown schemes are not navigated inside the editor.
    false
}

/// Opens `url` in the system browser, best-effort. Detached so it never blocks
/// the UI thread, and never panics — failures are logged and swallowed.
fn open_external(url: &str) {
    if let Err(e) = open::that_detached(url) {
        tracing::warn!("failed to open external url {url}: {e}");
    }
}

/// `with_navigation_handler` callback shared by both WebView builders. Allows
/// internal navigation; routes external `http(s)` links to the system browser
/// and blocks the in-WebView navigation. Returns `true` to allow, `false` to block.
fn allow_navigation(url: String) -> bool {
    if is_internal_url(&url) {
        return true;
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        open_external(&url);
    }
    false
}

/// The app/window icon, embedded at compile time (1024×1024 RGBA PNG).
const APP_ICON_PNG: &[u8] = include_bytes!("../icon.png");

/// Decodes the embedded icon PNG to raw RGBA8 bytes plus its dimensions.
///
/// Returns `None` if decoding fails — the window then keeps the platform default
/// icon rather than erroring. Only used on the tao path (macOS / Windows); the
/// GTK path loads the PNG straight into a `Pixbuf`.
#[cfg(not(target_os = "linux"))]
fn decode_icon_rgba() -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory(APP_ICON_PNG).ok()?.into_rgba8();
    let (w, h) = img.dimensions();
    Some((img.into_raw(), w, h))
}

/// Sets the macOS Dock tile to the embedded icon and promotes the bare binary to
/// a regular (Dock-owning) app. No-op if not on the main thread or if the PNG
/// fails to decode. MUST be called on the main thread.
#[cfg(target_os = "macos")]
fn set_macos_app_icon() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBitmapImageRep, NSDeviceRGBColorSpace,
        NSImage,
    };
    use objc2_foundation::NSSize;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };

    // Build the Dock image from raw RGBA8 pixels, NOT from the PNG bytes. Handing
    // `NSImage::initWithData` a PNG is known to leave the Dock tile blank/generic
    // for an un-bundled binary, so we decode to RGBA ourselves and back the image
    // with an explicit `NSBitmapImageRep`.
    let Some((rgba, w, h)) = decode_icon_rgba() else {
        return;
    };
    let row_bytes = (w as isize) * 4;

    // `planes = null` tells AppKit to allocate its own pixel storage; we then copy
    // our RGBA into it so the image owns the bytes (our `rgba` Vec can drop).
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            w as isize,
            h as isize,
            8, // bits per sample
            4, // samples per pixel (RGBA)
            true,
            false,
            NSDeviceRGBColorSpace,
            row_bytes,
            32, // bits per pixel
        )
    };
    let Some(rep) = rep else {
        return;
    };
    // SAFETY: the rep was allocated with the dimensions above, so `bitmapData`
    // points at `h * row_bytes` writable bytes — exactly `rgba.len()`.
    unsafe {
        let dst = rep.bitmapData();
        if dst.is_null() {
            return;
        }
        std::ptr::copy_nonoverlapping(rgba.as_ptr(), dst, rgba.len());
    }

    let image = NSImage::initWithSize(NSImage::alloc(), NSSize::new(w as f64, h as f64));
    image.addRepresentation(&rep);

    let app = NSApplication::sharedApplication(mtm);
    // A bare (un-bundled) binary needs Regular policy to own a Dock tile.
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    // SAFETY: `image` is a valid NSImage and we are on the main thread.
    unsafe { app.setApplicationIconImage(Some(&image)) };
}

/// Keeps `--smoke` runs from stealing the user's foreground app. `Accessory`
/// policy means no Dock tile and the app never becomes active, so the (hidden)
/// smoke window can't grab focus — which would make any concurrent work flaky.
/// Used instead of [`set_macos_app_icon`] in smoke mode.
#[cfg(target_os = "macos")]
fn set_macos_background_activation() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
}

/// The `MenuId`s of the native menu items, captured so the event loop can map a
/// `muda::MenuEvent` back to the JS bridge call it should dispatch.
#[cfg(not(target_os = "linux"))]
struct MenuIds {
    save: muda::MenuId,
    export_png: muda::MenuId,
    export_png2x: muda::MenuId,
    export_svg: muda::MenuId,
    export_scene: muda::MenuId,
    import_library: muda::MenuId,
    export_library: muda::MenuId,
}

/// Builds the native menu bar for the tao path (macOS / Windows).
///
/// File → Save (`Cmd+S`/`Ctrl+S`), Export PNG / PNG 2× / SVG / Scene;
/// Library → Import / Export. Help links stay in the in-WebView menu (they are
/// external links handled by the navigation handler). Returns the menu (kept
/// alive for the event loop) and the item ids for event dispatch.
#[cfg(not(target_os = "linux"))]
fn build_menu() -> Result<(muda::Menu, MenuIds), Box<dyn std::error::Error>> {
    use muda::{accelerator::Accelerator, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let menu = Menu::new();

    // macOS shows the first submenu as the application menu; it needs at least a
    // Quit item for the standard window shortcuts to behave.
    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::new("Excalidraw Preview", true);
        app_menu.append(&PredefinedMenuItem::quit(None))?;
        menu.append(&app_menu)?;
    }

    // `Cmd+S` on macOS, `Ctrl+S` elsewhere. This is the fix for AppKit consuming
    // `Cmd+S` before it reaches WKWebView — the accelerator now drives the save.
    let save_accel = "CmdOrCtrl+S".parse::<Accelerator>().ok();
    let save = MenuItem::new("Save", true, save_accel);
    let export_png = MenuItem::new("Export PNG", true, None);
    let export_png2x = MenuItem::new("Export PNG (2x)", true, None);
    let export_svg = MenuItem::new("Export SVG", true, None);
    let export_scene = MenuItem::new("Export Scene", true, None);

    let file_menu = Submenu::new("File", true);
    file_menu.append_items(&[
        &save,
        &PredefinedMenuItem::separator(),
        &export_png,
        &export_png2x,
        &export_svg,
        &export_scene,
    ])?;
    menu.append(&file_menu)?;

    // Edit menu with the standard system items (Undo/Redo/Cut/Copy/Paste/Select
    // All). On macOS, AppKit only delivers the `Cmd+C`/`Cmd+V`/`Cmd+X`/`Cmd+A`/
    // `Cmd+Z` key equivalents to the focused WKWebView when the menu bar contains
    // items wired to the standard `copy:`/`paste:`/… selectors — without this
    // menu those shortcuts are swallowed and Excalidraw's clipboard handlers
    // never fire (only the WebView's right-click context menu worked). These
    // predefined items carry the conventional accelerators automatically and are
    // dispatched natively, so they need no `MenuId` handling. Harmless on Windows
    // (WebView2 already handles the shortcuts natively).
    let edit_menu = Submenu::new("Edit", true);
    edit_menu.append_items(&[
        &PredefinedMenuItem::undo(None),
        &PredefinedMenuItem::redo(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::cut(None),
        &PredefinedMenuItem::copy(None),
        &PredefinedMenuItem::paste(None),
        &PredefinedMenuItem::select_all(None),
    ])?;
    menu.append(&edit_menu)?;

    let import_library = MenuItem::new("Import Library…", true, None);
    let export_library = MenuItem::new("Export Library…", true, None);
    let library_menu = Submenu::new("Library", true);
    library_menu.append_items(&[&import_library, &export_library])?;
    menu.append(&library_menu)?;

    let ids = MenuIds {
        save: save.id().clone(),
        export_png: export_png.id().clone(),
        export_png2x: export_png2x.id().clone(),
        export_svg: export_svg.id().clone(),
        export_scene: export_scene.id().clone(),
        import_library: import_library.id().clone(),
        export_library: export_library.id().clone(),
    };
    Ok((menu, ids))
}

/// Maps a fired `MenuId` to the JS bridge expression that services it, or `None`
/// if the id is not one of ours. The bridge globals are registered by the React
/// app (see `native-bridge.ts`); the `&&` guard makes the call a no-op if the app
/// has not mounted yet.
#[cfg(not(target_os = "linux"))]
fn menu_event_script(id: &muda::MenuId, ids: &MenuIds) -> Option<&'static str> {
    if *id == ids.save {
        Some("window.__excalidrawSave && window.__excalidrawSave({ reason: 'menu' })")
    } else if *id == ids.export_png {
        Some("window.__excalidrawExport && window.__excalidrawExport('png')")
    } else if *id == ids.export_png2x {
        Some("window.__excalidrawExport && window.__excalidrawExport('png2x')")
    } else if *id == ids.export_svg {
        Some("window.__excalidrawExport && window.__excalidrawExport('svg')")
    } else if *id == ids.export_scene {
        Some("window.__excalidrawExport && window.__excalidrawExport('scene')")
    } else if *id == ids.import_library {
        Some("window.__excalidrawImportLibrary && window.__excalidrawImportLibrary({})")
    } else if *id == ids.export_library {
        Some("window.__excalidrawExportLibrary && window.__excalidrawExportLibrary({})")
    } else {
        None
    }
}

/// Maps a file extension to a human label and filter spec for the native dialog.
/// Returns `None` for extensions we don't want to constrain the dialog to.
fn dialog_filter_for(ext: &str) -> Option<(&'static str, [&str; 1])> {
    match ext {
        "excalidrawlib" => Some(("Excalidraw Library", ["excalidrawlib"])),
        "excalidraw" => Some(("Excalidraw Scene", ["excalidraw"])),
        "png" => Some(("PNG Image", ["png"])),
        "svg" => Some(("SVG Image", ["svg"])),
        _ => None,
    }
}

/// Shows the native save dialog for `req` and writes the bytes on confirm.
/// MUST be called on the platform UI thread.
fn handle_export_request(req: ExportRequest) {
    let mut dialog = rfd::FileDialog::new()
        .set_directory(&req.default_dir)
        .set_file_name(&req.suggested_name);
    // Constrain the save dialog (and suggest the right extension) for known
    // formats — notably `.excalidrawlib` for library export.
    if let Some(ext) = Path::new(&req.suggested_name)
        .extension()
        .and_then(|e| e.to_str())
    {
        if let Some((label, exts)) = dialog_filter_for(ext) {
            dialog = dialog.add_filter(label, &exts);
        }
    }
    let picked = dialog.save_file();
    let result = picked.and_then(|p| std::fs::write(&p, &req.bytes).ok().map(|_| p));
    let _ = req.reply.send(result);
}

/// Shows the native open dialog for a `.excalidrawlib` file and returns its
/// bytes (or `None` on cancel) over the reply channel. MUST be called on the
/// platform UI thread.
fn handle_library_open_request(req: LibraryOpenRequest) {
    let picked = rfd::FileDialog::new()
        .add_filter("Excalidraw Library", &["excalidrawlib"])
        .set_directory(&req.default_dir)
        .pick_file();
    let result = picked.and_then(|p| std::fs::read(&p).ok());
    let _ = req.reply.send(result);
}

/// Opens the WebView at the given URL. Blocks until the window is closed.
fn run_webview(
    port: u16,
    focus_rx: watch::Receiver<bool>,
    export_rx: std::sync::mpsc::Receiver<ExportRequest>,
    library_open_rx: std::sync::mpsc::Receiver<LibraryOpenRequest>,
    close_ctx: CloseContext,
) -> Result<(), Box<dyn std::error::Error>> {
    // Load the WebView from `localhost`, not the literal `127.0.0.1`. WebKit
    // (WKWebView on macOS, WebKitGTK on Linux) only treats the *hostname*
    // `localhost` as a secure context — a bare loopback IP is considered
    // insecure, which leaves `window.isSecureContext` false and
    // `navigator.clipboard` undefined, silently breaking Excalidraw copy/paste.
    // Chromium treats both as secure, which is why this only bites the packaged
    // WebKit window and not dev-mode testing. The server binds 127.0.0.1 and the
    // OS resolves `localhost` to it (/etc/hosts), so the connection is identical.
    run_webview_url(
        &format!("http://localhost:{}", port),
        focus_rx,
        export_rx,
        library_open_rx,
        close_ctx,
    )
}

/// State machine for an in-flight unsaved-changes close.
///
/// A close always starts by *querying* the WebView for its live dirty state
/// (rather than trusting the last `POST /dirty`, which can lag a just-made edit
/// — finding 2). When that query resolves the event loop decides what to do:
/// close immediately (clean), or transition to `Waiting` on a
/// `__excalidrawSave({ reason: 'close' })` round-trip (dirty + save chosen).
enum CloseFlow {
    Idle,
    /// Awaiting `__excalidrawPrepareClose` — the live dirty-state query.
    Querying {
        rx: tokio::sync::oneshot::Receiver<NativeActionResult>,
        deadline: std::time::Instant,
        request_id: String,
    },
    /// Awaiting `__excalidrawSave({ reason: 'close' })` — the save round-trip.
    Waiting {
        rx: tokio::sync::oneshot::Receiver<NativeActionResult>,
        deadline: std::time::Instant,
        /// Correlation id registered in `pending_actions`. Kept so the flow can
        /// evict its own entry if it ends by timeout / channel drop rather than
        /// by a `/native-action-result` (which would remove it).
        request_id: String,
    },
}

/// How long to wait for the save-and-close JS round-trip before giving up and
/// keeping the window open.
const CLOSE_SAVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How long to wait for the live dirty-state query before falling back to the
/// last reported (cached) dirty state. Short because it is a single read of a
/// ref in the already-mounted WebView, not a serialize-and-POST.
const CLOSE_QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Dispatches `window.__excalidrawPrepareClose({ requestId })` — which reports
/// the WebView's *live* dirty state to `/native-action-result` (`ok: true` ⇒
/// clean ⇒ safe to close) — and registers a correlation entry to await it.
///
/// The `&&` guard makes the call a no-op if the React app hasn't mounted yet; the
/// query then times out and the loop falls back to the cached dirty state.
fn begin_query_close(
    webview: &wry::WebView,
    pending_actions: &PendingActions,
    seq: u64,
) -> CloseFlow {
    let request_id = format!("query-{seq}");
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Ok(mut pending) = pending_actions.lock() {
        pending.insert(request_id.clone(), tx);
    }
    let id_json =
        serde_json::to_string(&request_id).unwrap_or_else(|_| "\"query\"".to_string());
    let script = format!(
        "window.__excalidrawPrepareClose && window.__excalidrawPrepareClose({{ requestId: {id_json} }})"
    );
    let _ = webview.evaluate_script(&script);
    CloseFlow::Querying {
        rx,
        deadline: std::time::Instant::now() + CLOSE_QUERY_TIMEOUT,
        request_id,
    }
}

/// Dispatches `window.__excalidrawSave({ reason: 'close', requestId })` and
/// registers a correlation entry so the event loop can await the result.
///
/// `seq` is a per-window monotonic counter used only to make the request id
/// unique. Returns the `Waiting` state to install. The `&&` guard makes the
/// call a no-op (and the wait a timeout) if the React app hasn't mounted yet.
fn begin_save_close(
    webview: &wry::WebView,
    pending_actions: &PendingActions,
    seq: u64,
) -> CloseFlow {
    let request_id = format!("close-{seq}");
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Ok(mut pending) = pending_actions.lock() {
        pending.insert(request_id.clone(), tx);
    }
    let id_json =
        serde_json::to_string(&request_id).unwrap_or_else(|_| "\"close\"".to_string());
    let script = format!(
        "window.__excalidrawSave && window.__excalidrawSave({{ reason: 'close', requestId: {id_json} }})"
    );
    let _ = webview.evaluate_script(&script);
    CloseFlow::Waiting {
        rx,
        deadline: std::time::Instant::now() + CLOSE_SAVE_TIMEOUT,
        request_id,
    }
}

/// The user's answer to the unsaved-changes confirmation dialog.
enum CloseChoice {
    Save,
    DontSave,
    Cancel,
}

/// Shows the synchronous 3-way "unsaved changes" dialog (tao path: macOS/Windows).
fn confirm_close_dialog() -> CloseChoice {
    use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
    let result = MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title("Unsaved changes")
        .set_description("This drawing has unsaved changes. Save before closing?")
        .set_buttons(MessageButtons::YesNoCancelCustom(
            "Save".to_owned(),
            "Don't Save".to_owned(),
            "Cancel".to_owned(),
        ))
        .show();
    match result {
        MessageDialogResult::Custom(label) if label == "Save" => CloseChoice::Save,
        MessageDialogResult::Custom(label) if label == "Don't Save" => CloseChoice::DontSave,
        MessageDialogResult::Yes => CloseChoice::Save,
        MessageDialogResult::No => CloseChoice::DontSave,
        _ => CloseChoice::Cancel,
    }
}

/// Shows a blocking "save failed" error dialog (tao path: macOS/Windows) when a
/// close-time save or other native round-trip fails or times out. Without this
/// the window would stay open with no explanation, which reads as broken.
#[cfg(not(target_os = "linux"))]
fn show_close_error_dialog(detail: Option<&str>) {
    use rfd::{MessageButtons, MessageDialog, MessageLevel};
    MessageDialog::new()
        .set_level(MessageLevel::Error)
        .set_title("Save failed")
        .set_description(close_error_message(detail))
        .set_buttons(MessageButtons::Ok)
        .show();
}

/// Spawns an async "save failed" error dialog on the glib main context (Linux).
/// Async (like the close-confirm dialog) to avoid a re-entrant GTK main loop
/// from inside the tick.
#[cfg(target_os = "linux")]
fn spawn_gtk_error_dialog(detail: Option<String>) {
    gtk::glib::MainContext::default().spawn_local(async move {
        use rfd::{AsyncMessageDialog, MessageButtons, MessageLevel};
        let _ = AsyncMessageDialog::new()
            .set_level(MessageLevel::Error)
            .set_title("Save failed")
            .set_description(close_error_message(detail.as_deref()))
            .set_buttons(MessageButtons::Ok)
            .show()
            .await;
    });
}

/// The result of polling a pending native-action round-trip once.
enum ActionOutcome {
    /// No result yet and the deadline has not passed.
    Pending,
    /// The frontend reported a result, carrying its success flag and any error
    /// detail (preserved so close-time failures can be surfaced to the user
    /// rather than reduced to a bare `bool`).
    Resolved(NativeActionResult),
    /// The deadline passed or the channel dropped with no result.
    Lost,
}

/// Polls a single pending native-action oneshot with a deadline. On any terminal
/// outcome (resolved, timed out, or channel closed) the correlation entry is
/// evicted if still present — a resolving `/native-action-result` already
/// removed it, but a timeout/drop must clean up its own stale entry so a late
/// result can't resurrect the flow.
fn poll_action_result(
    rx: &mut tokio::sync::oneshot::Receiver<NativeActionResult>,
    deadline: std::time::Instant,
    request_id: &str,
    pending_actions: &PendingActions,
) -> ActionOutcome {
    use tokio::sync::oneshot::error::TryRecvError;
    match rx.try_recv() {
        Ok(result) => ActionOutcome::Resolved(result),
        Err(TryRecvError::Empty) => {
            if std::time::Instant::now() >= deadline {
                if let Ok(mut pending) = pending_actions.lock() {
                    pending.remove(request_id);
                }
                ActionOutcome::Lost
            } else {
                ActionOutcome::Pending
            }
        }
        Err(TryRecvError::Closed) => {
            if let Ok(mut pending) = pending_actions.lock() {
                pending.remove(request_id);
            }
            ActionOutcome::Lost
        }
    }
}

/// The outcome of polling an in-flight save-and-close (`CloseFlow::Waiting`).
enum CloseOutcome {
    /// No result yet — keep the window open and keep polling.
    Pending,
    /// The save succeeded; the window may close now.
    Exit,
    /// The flow ended without closing — the window stays open and the user must
    /// be told why. `Some` carries the frontend's error text (save failure,
    /// library write failure, …); `None` means the round-trip was lost to a
    /// timeout, an unmounted bridge, or a dropped channel with no detail.
    Failed(Option<String>),
}

/// Polls an in-flight save-and-close (`CloseFlow::Waiting`) once.
///
/// A bare `bool` would hide *why* a close failed; the spec requires close-save
/// failures to keep the window open *and* show an error, so this preserves the
/// frontend's error text (and distinguishes a true failure from a lost
/// round-trip) for the caller to surface in a dialog.
fn poll_close_flow(flow: &mut CloseFlow, pending_actions: &PendingActions) -> CloseOutcome {
    if let CloseFlow::Waiting {
        rx,
        deadline,
        request_id,
    } = flow
    {
        match poll_action_result(rx, *deadline, request_id, pending_actions) {
            ActionOutcome::Resolved(result) if result.ok => CloseOutcome::Exit,
            ActionOutcome::Resolved(result) => CloseOutcome::Failed(result.error),
            ActionOutcome::Lost => CloseOutcome::Failed(None),
            ActionOutcome::Pending => CloseOutcome::Pending,
        }
    } else {
        CloseOutcome::Pending
    }
}

/// Builds the user-facing message shown when a close-time save (or other native
/// round-trip) fails or times out. `detail` is the frontend's error text when
/// present; `None` covers a timeout / unmounted bridge / dropped channel.
fn close_error_message(detail: Option<&str>) -> String {
    match detail {
        Some(d) if !d.trim().is_empty() => {
            format!("Could not save before closing: {d}\n\nThe window has been kept open.")
        }
        _ => "Could not save before closing — the editor did not respond in time.\n\n\
              The window has been kept open."
            .to_string(),
    }
}

/// Polls an in-flight dirty-state query (`CloseFlow::Querying`) once.
///
/// Returns `Some(is_clean)` once the query resolves (or is lost): `true` means
/// the WebView reports no unsaved changes (safe to close), `false` means dirty
/// (the caller must save or confirm). On a lost query (timeout / channel drop)
/// the caller's `cached_dirty` is used as the answer, so an unresponsive or
/// not-yet-mounted WebView falls back to the last reported state. Returns `None`
/// while the query is still pending.
fn poll_query_flow(
    flow: &mut CloseFlow,
    pending_actions: &PendingActions,
    cached_dirty: bool,
) -> Option<bool> {
    if let CloseFlow::Querying {
        rx,
        deadline,
        request_id,
    } = flow
    {
        match poll_action_result(rx, *deadline, request_id, pending_actions) {
            ActionOutcome::Resolved(result) => Some(result.ok),
            ActionOutcome::Lost => Some(!cached_dirty),
            ActionOutcome::Pending => None,
        }
    } else {
        None
    }
}

// ── --smoke: automated real-WebView self-test ─────────────────────────────────

/// One automated check produced by [`SmokeDriver`].
struct SmokeCheck {
    /// Short identifier shown in the report.
    name: &'static str,
    /// Whether the check passed.
    ok: bool,
    /// Human-readable outcome (success summary or failure reason).
    detail: String,
}

/// How long to let the React app mount and fetch its assets/fonts before the
/// smoke driver starts probing the bridge.
const SMOKE_SETTLE: std::time::Duration = std::time::Duration::from_secs(2);

/// How long to wait for each native→JS bridge round-trip in smoke mode before
/// declaring it lost (a missing bridge fails fast via the inline fallback POST;
/// this only bounds a genuinely hung round-trip).
const SMOKE_ROUNDTRIP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Sequential stages the smoke driver advances through, one transition per tick.
enum SmokeStage {
    /// Waiting for the React app to mount and load its assets/fonts.
    Settle { until: std::time::Instant },
    /// Awaiting the save round-trip (`window.__excalidrawSave`) — the same bridge
    /// global the native File-menu "Save" item and the `Cmd/Ctrl+S` accelerator
    /// dispatch into.
    Save {
        rx: tokio::sync::oneshot::Receiver<NativeActionResult>,
        deadline: std::time::Instant,
        request_id: String,
    },
    /// Awaiting the close-interception dirty-state query
    /// (`window.__excalidrawPrepareClose`), the first step of every native close.
    Query {
        rx: tokio::sync::oneshot::Receiver<NativeActionResult>,
        deadline: std::time::Instant,
        request_id: String,
    },
    /// Round-trips done; run the synchronous external-link classification checks.
    Finish,
}

/// Drives `--smoke`: an automated self-test that runs against a *real* WebView so
/// it exercises the OS-specific shell paths unit tests cannot — actual `wry`
/// window creation, React mount + asset/font fetch, `evaluate_script` delivery to
/// the mounted app, the `/native-action-result` IPC round-trip, and the close
/// state machine. Advanced one step per event-loop tick (mirroring the close
/// flow) so it never blocks the UI thread; on completion the event loop prints a
/// report and exits with a non-zero code if any check failed.
///
/// What it deliberately does *not* prove (and so stays on the manual checklist):
/// literal AppKit `Cmd+S` key delivery, `rfd` dialog button behavior, the actual
/// system-browser launch, and Dock/taskbar tile rendering — none can be observed
/// without a human or input injection.
struct SmokeDriver {
    stage: SmokeStage,
    checks: Vec<SmokeCheck>,
}

/// Builds the JS that invokes a bridge global by `request_id`, falling back to a
/// direct `/native-action-result` failure POST when the global is absent so a
/// failed React mount / asset load fails the check immediately instead of waiting
/// out the full timeout.
fn smoke_bridge_script(global: &str, action: &str, call: &str, request_id: &str) -> String {
    format!(
        "(function(){{ if (window.{global}) {{ window.{global}({call}); }} else {{ \
         fetch('/native-action-result', {{ method: 'POST', \
         headers: {{ 'Content-Type': 'application/json' }}, \
         body: JSON.stringify({{ id: '{request_id}', action: '{action}', ok: false, \
         error: 'bridge global {global} missing (React app did not mount — asset/font load may have failed)' }}) }}); }} }})()"
    )
}

impl SmokeDriver {
    fn new() -> Self {
        Self {
            stage: SmokeStage::Settle {
                until: std::time::Instant::now() + SMOKE_SETTLE,
            },
            checks: Vec::new(),
        }
    }

    /// Registers a pending correlation entry and dispatches `script` into the
    /// WebView, returning the receiver the next stage awaits.
    fn dispatch(
        webview: &wry::WebView,
        pending: &PendingActions,
        request_id: &str,
        script: &str,
    ) -> tokio::sync::oneshot::Receiver<NativeActionResult> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut p) = pending.lock() {
            p.insert(request_id.to_string(), tx);
        }
        let _ = webview.evaluate_script(script);
        rx
    }

    /// Advances the smoke run by one tick. Returns `Some(checks)` once complete.
    fn tick(
        &mut self,
        webview: &wry::WebView,
        pending: &PendingActions,
    ) -> Option<Vec<SmokeCheck>> {
        match &mut self.stage {
            SmokeStage::Settle { until } => {
                if std::time::Instant::now() >= *until {
                    let request_id = "smoke-save".to_string();
                    let script = smoke_bridge_script(
                        "__excalidrawSave",
                        "save",
                        "{ reason: 'smoke', requestId: 'smoke-save' }",
                        &request_id,
                    );
                    let rx = Self::dispatch(webview, pending, &request_id, &script);
                    self.stage = SmokeStage::Save {
                        rx,
                        deadline: std::time::Instant::now() + SMOKE_ROUNDTRIP_TIMEOUT,
                        request_id,
                    };
                }
                None
            }
            SmokeStage::Save {
                rx,
                deadline,
                request_id,
            } => match poll_action_result(rx, *deadline, request_id, pending) {
                ActionOutcome::Pending => None,
                ActionOutcome::Resolved(result) if result.ok => {
                    self.checks.push(SmokeCheck {
                        name: "webview-mount + native save round-trip",
                        ok: true,
                        detail: "React app mounted and window.__excalidrawSave saved to disk via POST /data".to_string(),
                    });
                    self.begin_query(webview, pending);
                    None
                }
                ActionOutcome::Resolved(result) => {
                    self.checks.push(SmokeCheck {
                        name: "webview-mount + native save round-trip",
                        ok: false,
                        detail: result
                            .error
                            .unwrap_or_else(|| "save reported failure".to_string()),
                    });
                    self.begin_query(webview, pending);
                    None
                }
                ActionOutcome::Lost => {
                    self.checks.push(SmokeCheck {
                        name: "webview-mount + native save round-trip",
                        ok: false,
                        detail: "no /native-action-result within 5s — the React app likely never mounted (asset/font load failed?)".to_string(),
                    });
                    self.begin_query(webview, pending);
                    None
                }
            },
            SmokeStage::Query {
                rx,
                deadline,
                request_id,
            } => match poll_action_result(rx, *deadline, request_id, pending) {
                ActionOutcome::Pending => None,
                ActionOutcome::Resolved(result) => {
                    self.checks.push(SmokeCheck {
                        name: "close-interception dirty-state query",
                        ok: true,
                        detail: format!(
                            "window.__excalidrawPrepareClose responded (scene reported {})",
                            if result.ok { "clean — safe to close" } else { "dirty/blocked" }
                        ),
                    });
                    self.stage = SmokeStage::Finish;
                    self.finish()
                }
                ActionOutcome::Lost => {
                    self.checks.push(SmokeCheck {
                        name: "close-interception dirty-state query",
                        ok: false,
                        detail: "window.__excalidrawPrepareClose did not respond within 5s".to_string(),
                    });
                    self.stage = SmokeStage::Finish;
                    self.finish()
                }
            },
            SmokeStage::Finish => self.finish(),
        }
    }

    /// Dispatches the close-interception dirty-state query and moves to `Query`.
    fn begin_query(&mut self, webview: &wry::WebView, pending: &PendingActions) {
        let request_id = "smoke-close".to_string();
        let script = smoke_bridge_script(
            "__excalidrawPrepareClose",
            "prepareClose",
            "{ requestId: 'smoke-close' }",
            &request_id,
        );
        let rx = Self::dispatch(webview, pending, &request_id, &script);
        self.stage = SmokeStage::Query {
            rx,
            deadline: std::time::Instant::now() + SMOKE_ROUNDTRIP_TIMEOUT,
            request_id,
        };
    }

    /// Runs the synchronous external-link classification checks (the logic that
    /// drives `with_navigation_handler` / `with_new_window_req_handler`) and
    /// returns the full check list. Does not call `open_external`, so no real
    /// browser is launched — that observation stays on the manual checklist.
    fn finish(&mut self) -> Option<Vec<SmokeCheck>> {
        let external = "https://libraries.excalidraw.com/";
        self.checks.push(SmokeCheck {
            name: "external link routed out of editor",
            ok: !is_internal_url(external),
            detail: format!("{external} classified external ⇒ navigation handler blocks in-editor nav and opens the system browser"),
        });
        let loopback = "http://127.0.0.1:5173/";
        self.checks.push(SmokeCheck {
            name: "loopback navigation kept in editor",
            ok: is_internal_url(loopback),
            detail: format!("{loopback} classified internal ⇒ editor navigation allowed"),
        });
        Some(std::mem::take(&mut self.checks))
    }
}

/// Prints the smoke report, removes the lock file, and exits the process with
/// code 0 (all checks passed) or 1 (any failed). Called from inside the event
/// loop because the tao event loop never returns to `main` on macOS/Windows.
fn finish_smoke_and_exit(checks: Vec<SmokeCheck>, ctx: &CloseContext) -> ! {
    let failed = checks.iter().filter(|c| !c.ok).count();
    eprintln!("\n── excalidraw-preview --smoke report ──");
    for check in &checks {
        eprintln!(
            "  {} {}\n      {}",
            if check.ok { "PASS" } else { "FAIL" },
            check.name,
            check.detail
        );
    }
    eprintln!(
        "── {}/{} checks passed ──\n",
        checks.len() - failed,
        checks.len()
    );
    ctx.cleanup_lock();
    std::process::exit(if failed == 0 { 0 } else { 1 });
}

/// Spawns the async 3-way "unsaved changes" dialog on the glib main context
/// (Linux). `rfd::AsyncMessageDialog` avoids the re-entrant GTK main loop a
/// *synchronous* dialog would trigger from inside the tick. On "Save" it installs
/// a save-and-close `CloseFlow` (driven by the tick); "Don't Save" quits;
/// "Cancel" leaves the window open.
#[cfg(target_os = "linux")]
fn spawn_gtk_close_dialog(
    webview: std::rc::Rc<wry::WebView>,
    flow: std::rc::Rc<std::cell::RefCell<CloseFlow>>,
    ctx: CloseContext,
    counter: std::rc::Rc<std::cell::Cell<u64>>,
) {
    gtk::glib::MainContext::default().spawn_local(async move {
        use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
        let result = AsyncMessageDialog::new()
            .set_level(MessageLevel::Warning)
            .set_title("Unsaved changes")
            .set_description("This drawing has unsaved changes. Save before closing?")
            .set_buttons(MessageButtons::YesNoCancelCustom(
                "Save".to_owned(),
                "Don't Save".to_owned(),
                "Cancel".to_owned(),
            ))
            .show()
            .await;
        let save = matches!(&result, MessageDialogResult::Yes)
            || matches!(&result, MessageDialogResult::Custom(l) if l == "Save");
        let dont_save = matches!(&result, MessageDialogResult::No)
            || matches!(&result, MessageDialogResult::Custom(l) if l == "Don't Save");
        if save {
            let seq = counter.get() + 1;
            counter.set(seq);
            *flow.borrow_mut() = begin_save_close(&webview, &ctx.pending_actions, seq);
        } else if dont_save {
            ctx.cleanup_lock();
            gtk::main_quit();
        }
        // Cancel (or any other result) keeps the window open.
    });
}

/// Opens the WebView at an arbitrary URL. Used both for the normal server and
/// for `--dev` / `--dev-server` mode (pointing at the Vite dev server).
#[cfg(target_os = "linux")]
fn run_webview_url(
    url: &str,
    focus_rx: watch::Receiver<bool>,
    export_rx: std::sync::mpsc::Receiver<ExportRequest>,
    library_open_rx: std::sync::mpsc::Receiver<LibraryOpenRequest>,
    close_ctx: CloseContext,
) -> Result<(), Box<dyn std::error::Error>> {
    use gtk::glib::Propagation;
    use gtk::prelude::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use wry::WebViewBuilderExtUnix;

    // Native menu decision (spec leaves this open — option (b)): Linux keeps the
    // in-WebView `MainMenu` plus the page's `Ctrl+S` keydown handler. WebKitGTK
    // *does* deliver `Ctrl+S` to web content (unlike AppKit on macOS, which is why
    // the tao path adds a `muda` menu with an accelerator), so the existing web
    // handler already saves correctly here. No GTK `GtkMenuBar`/`AccelGroup` is
    // wired this pass; if added later, it belongs in this function.
    gtk::init().map_err(|e| format!("Failed to init GTK: {}", e))?;

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title(&close_ctx.window_title());
    window.set_default_size(1200, 800);

    // --smoke runs as a background self-test: don't let the window grab focus when
    // it maps, or an automated run would steal focus from the user (flaky results).
    // WebKitGTK still needs the window realized (`show_all`) to load and run JS.
    if close_ctx.smoke {
        window.set_focus_on_map(false);
        window.set_accept_focus(false);
        window.set_skip_taskbar_hint(true);
    }

    // Window / taskbar icon: load the embedded PNG straight into a Pixbuf.
    {
        let loader = gtk::gdk_pixbuf::PixbufLoader::new();
        if loader.write(APP_ICON_PNG).is_ok() && loader.close().is_ok() {
            if let Some(pixbuf) = loader.pixbuf() {
                window.set_icon(Some(&pixbuf));
            }
        }
    }

    // Shared with the delete handler and the tick so both can call
    // `evaluate_script` for the save-and-close flow. Rc (single-threaded GTK).
    let webview = Rc::new(
        wry::WebViewBuilder::new()
            .with_url(url)
            // Enable clipboard access (copy/cut/paste) for the page. Required on
            // Linux/WebKitGTK so Excalidraw's clipboard shortcuts reach web content.
            .with_clipboard(true)
            // External links (Help/docs, Browse libraries) open in the system browser
            // instead of navigating away from — or spawning a popup inside — the editor.
            .with_navigation_handler(allow_navigation)
            .with_new_window_req_handler(|url, _features| {
                if (url.starts_with("http://") || url.starts_with("https://"))
                    && !is_internal_url(&url)
                {
                    open_external(&url);
                }
                wry::NewWindowResponse::Deny
            })
            .build_gtk(&window)
            .map_err(|e| format!("Failed to create WebView: {}", e))?,
    );

    window.show_all();

    // Unsaved-changes close flow, shared between the delete handler (which starts
    // it) and the 100 ms tick (which polls it to completion). A monotonically
    // increasing counter generates correlation ids for the JS round-trip.
    let close_flow = Rc::new(RefCell::new(CloseFlow::Idle));
    let close_counter = Rc::new(Cell::new(0u64));

    let window_for_tick = window.clone();
    let close_flow_tick = close_flow.clone();
    let close_ctx_tick = close_ctx.clone();
    let webview_tick = webview.clone();
    let close_counter_tick = close_counter.clone();
    let mut focus_rx = focus_rx;
    // --smoke: an automated self-test driven one step per tick against this real
    // WebView. `None` in normal runs.
    let mut smoke_driver = close_ctx.smoke.then(SmokeDriver::new);
    // Last dirty value reflected in the title bar (see the tao path for rationale).
    let mut last_title_dirty = false;
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
        // --smoke: advance the self-test; print the report and exit when it ends.
        if let Some(driver) = smoke_driver.as_mut() {
            if let Some(checks) = driver.tick(&webview_tick, &close_ctx_tick.pending_actions) {
                finish_smoke_and_exit(checks, &close_ctx_tick);
            }
        }
        while let Ok(req) = export_rx.try_recv() {
            handle_export_request(req);
        }
        while let Ok(req) = library_open_rx.try_recv() {
            handle_library_open_request(req);
        }
        if focus_rx.has_changed().unwrap_or(false) {
            let _ = focus_rx.borrow_and_update();
            window_for_tick.present();
        }
        // Drive the in-flight close flow started by the delete handler: first the
        // live dirty-state query, then (if dirty) the save-and-close round-trip.
        let mut should_exit = false;
        {
            let mut flow = close_flow_tick.borrow_mut();
            if matches!(&*flow, CloseFlow::Querying { .. }) {
                let cached_dirty =
                    close_ctx_tick.dirty.read().map(|d| d.dirty).unwrap_or(false);
                if let Some(is_clean) =
                    poll_query_flow(&mut flow, &close_ctx_tick.pending_actions, cached_dirty)
                {
                    if is_clean {
                        should_exit = true; // no unsaved changes → close now
                    } else if close_ctx_tick.auto_save {
                        let seq = close_counter_tick.get() + 1;
                        close_counter_tick.set(seq);
                        *flow = begin_save_close(
                            &webview_tick,
                            &close_ctx_tick.pending_actions,
                            seq,
                        );
                    } else {
                        // Dirty + auto-save off → async 3-way dialog (no nested loop).
                        *flow = CloseFlow::Idle;
                        spawn_gtk_close_dialog(
                            webview_tick.clone(),
                            close_flow_tick.clone(),
                            close_ctx_tick.clone(),
                            close_counter_tick.clone(),
                        );
                    }
                }
            } else if matches!(&*flow, CloseFlow::Waiting { .. }) {
                // RefMut derefs to CloseFlow for the call below.
                match poll_close_flow(&mut flow, &close_ctx_tick.pending_actions) {
                    CloseOutcome::Exit => should_exit = true,
                    CloseOutcome::Failed(detail) => {
                        // Keep the window open and show why (spec requirement).
                        *flow = CloseFlow::Idle;
                        spawn_gtk_error_dialog(detail);
                    }
                    CloseOutcome::Pending => {}
                }
            }
        }
        if should_exit {
            close_ctx_tick.cleanup_lock();
            gtk::main_quit();
            return gtk::glib::ControlFlow::Break;
        }

        // Refresh the title's "*" dirty marker when the scene's dirty state flips.
        let dirty_now = close_ctx_tick.dirty.read().map(|d| d.dirty).unwrap_or(false);
        if dirty_now != last_title_dirty {
            last_title_dirty = dirty_now;
            window_for_tick.set_title(&close_ctx_tick.window_title());
        }

        gtk::glib::ControlFlow::Continue
    });

    // Unsaved-changes confirmation on close. Rather than trust the cached
    // `POST /dirty` value (which can lag a just-made edit — finding 2), the
    // delete handler starts a live dirty-state query and vetoes the close
    // (`Stop`); the tick decides (close / save / async confirm dialog) once the
    // query resolves and calls `main_quit` when it's time to exit.
    let webview_del = webview.clone();
    let close_flow_del = close_flow.clone();
    let close_ctx_del = close_ctx.clone();
    let counter_del = close_counter.clone();
    window.connect_delete_event(move |_, _| {
        if matches!(&*close_flow_del.borrow(), CloseFlow::Idle) {
            let seq = counter_del.get() + 1;
            counter_del.set(seq);
            *close_flow_del.borrow_mut() =
                begin_query_close(&webview_del, &close_ctx_del.pending_actions, seq);
        }
        // A query or save-and-close is already in flight — veto and let the tick
        // drive it to completion.
        Propagation::Stop
    });

    gtk::main();

    Ok(())
}

/// Opens the WebView at an arbitrary URL. Used both for the normal server and
/// for `--dev` / `--dev-server` mode (pointing at the Vite dev server).
#[cfg(not(target_os = "linux"))]
#[allow(unreachable_code)]
fn run_webview_url(
    url: &str,
    mut focus_rx: watch::Receiver<bool>,
    export_rx: std::sync::mpsc::Receiver<ExportRequest>,
    library_open_rx: std::sync::mpsc::Receiver<LibraryOpenRequest>,
    close_ctx: CloseContext,
) -> Result<(), Box<dyn std::error::Error>> {
    use tao::{
        event_loop::{ControlFlow, EventLoop},
        window::WindowBuilder,
    };
    use wry::WebViewBuilder;

    let event_loop = EventLoop::new();

    // Reopen at the last remembered size (global, all diagrams share one), clamped
    // so a size saved on a larger display never opens off-screen on a smaller one.
    let monitor_logical = event_loop.primary_monitor().map(|m| {
        let sf = m.scale_factor();
        let phys = m.size();
        (phys.width as f64 / sf, phys.height as f64 / sf)
    });
    let (win_w, win_h) =
        clamp_window_size(load_window_size().unwrap_or(DEFAULT_WINDOW_SIZE), monitor_logical);

    let window = WindowBuilder::new()
        .with_title(close_ctx.window_title())
        .with_inner_size(tao::dpi::LogicalSize::new(win_w, win_h))
        // --smoke runs headlessly as far as the user is concerned: keep the window
        // hidden and unfocused so an automated run can't pop up over — or steal
        // focus from — whatever the user is doing (which would make results flaky).
        .with_visible(!close_ctx.smoke)
        .with_focused(!close_ctx.smoke)
        .build(&event_loop)
        .map_err(|e| format!("Failed to create window: {}", e))?;

    // Window / taskbar icon (Windows). On macOS this is a no-op — the Dock tile is
    // set via `set_macos_app_icon` below — but it is harmless to call.
    if let Some((rgba, w, h)) = decode_icon_rgba() {
        if let Ok(icon) = tao::window::Icon::from_rgba(rgba, w, h) {
            window.set_window_icon(Some(icon));
        }
    }
    // In smoke mode, stay an `Accessory` (background, no Dock tile) app so the
    // window never becomes active and can't steal the user's foreground.
    #[cfg(target_os = "macos")]
    if close_ctx.smoke {
        set_macos_background_activation();
    } else {
        set_macos_app_icon();
    }

    let webview = WebViewBuilder::new()
        .with_url(url)
        // Enable clipboard access (copy/cut/paste) for the page. Required on
        // Windows so Excalidraw's clipboard shortcuts reach web content; a no-op
        // on macOS where WKWebView grants clipboard access from a secure context.
        .with_clipboard(true)
        // External links (Help/docs, Browse libraries) open in the system browser
        // instead of navigating away from — or spawning a popup inside — the editor.
        .with_navigation_handler(allow_navigation)
        .with_new_window_req_handler(|url, _features| {
            if (url.starts_with("http://") || url.starts_with("https://")) && !is_internal_url(&url)
            {
                open_external(&url);
            }
            wry::NewWindowResponse::Deny
        })
        .build(&window)
        .map_err(|e| format!("Failed to create WebView: {}", e))?;

    // Native menu bar. Built after the window so it can attach to it, and held
    // alive for the whole event loop. Menu clicks/accelerators arrive on the
    // global `MenuEvent` channel and are dispatched into the JS bridge below.
    let (menu, menu_ids) = build_menu()?;
    #[cfg(target_os = "macos")]
    menu.init_for_nsapp();
    #[cfg(target_os = "windows")]
    {
        use tao::platform::windows::WindowExtWindows;
        // SAFETY: `window.hwnd()` returns the live HWND owned by the window we
        // just built; it stays valid for the menu's lifetime (both are held by
        // the event loop below).
        let _ = unsafe { menu.init_for_hwnd(window.hwnd() as isize) };
    }
    let menu_channel = muda::MenuEvent::receiver();

    // Unsaved-changes close flow state, owned by the event loop.
    let mut close_flow = CloseFlow::Idle;
    let mut close_counter: u64 = 0;

    // --smoke: an automated self-test driven one step per tick against this real
    // WebView. `None` in normal runs.
    let mut smoke_driver = close_ctx.smoke.then(SmokeDriver::new);

    // Last dirty value reflected in the title bar, so the "*" marker is only
    // re-applied when the scene's dirty state actually flips (not every tick).
    let mut last_title_dirty = false;

    // Latest logical window size, tracked on every resize and persisted on exit
    // so the next launch reopens at this size. Seeded with the size we opened at.
    let mut last_logical_size = (win_w, win_h);

    event_loop.run(move |event, _, control_flow| {
        // Keep the menu alive for the lifetime of the event loop.
        let _ = &menu;
        // Wake at least every 100 ms so export/focus/menu requests are handled
        // promptly even when no OS events arrive (ControlFlow::Wait would starve them).
        *control_flow = ControlFlow::WaitUntil(
            std::time::Instant::now() + std::time::Duration::from_millis(100),
        );

        // Track resizes so the size is remembered, and persist on loop teardown.
        // (`event_loop.run` never returns on macOS, so saving after it is dead
        // code — `LoopDestroyed` is the one place that runs on every exit path.)
        if let tao::event::Event::WindowEvent {
            event: tao::event::WindowEvent::Resized(size),
            ..
        } = &event
        {
            // Ignore a zeroed size (minimize) so a restored window never reopens
            // collapsed. Convert physical → logical with the live scale factor.
            if size.width > 0 && size.height > 0 {
                let sf = window.scale_factor();
                last_logical_size = (size.width as f64 / sf, size.height as f64 / sf);
            }
        }
        if matches!(&event, tao::event::Event::LoopDestroyed) && !close_ctx.smoke {
            save_window_size(last_logical_size.0, last_logical_size.1);
        }

        if let tao::event::Event::WindowEvent {
            event: tao::event::WindowEvent::CloseRequested,
            ..
        } = &event
        {
            // tao has no veto: to keep the window alive we simply do NOT set
            // ControlFlow::Exit, and instead drive a query → decide → save flow,
            // exiting only once it resolves. The flow always *starts* by asking
            // the WebView for its live dirty state (finding 2) rather than
            // trusting the possibly-stale cached `POST /dirty` value.
            if matches!(close_flow, CloseFlow::Idle) {
                close_counter += 1;
                close_flow =
                    begin_query_close(&webview, &close_ctx.pending_actions, close_counter);
            }
            // else: a query or save-and-close is already in flight — ignore the repeat.
        }

        // Drive an in-flight close flow: first the live dirty-state query, then
        // (if dirty) the save-and-close round-trip.
        if matches!(close_flow, CloseFlow::Querying { .. }) {
            let cached_dirty = close_ctx.dirty.read().map(|d| d.dirty).unwrap_or(false);
            if let Some(is_clean) =
                poll_query_flow(&mut close_flow, &close_ctx.pending_actions, cached_dirty)
            {
                // Leave `Querying` the instant the query resolves. `poll_query_flow`
                // reads but never clears the flow, and `confirm_close_dialog()` below
                // is a *blocking* `NSAlert.runModal()` that pumps the run loop — which
                // re-enters this closure on the 100 ms tick. If the flow were still
                // `Querying` then, the re-entrant poll would hit the already-consumed
                // oneshot, fall back to the (still-dirty) cached state, and pop the
                // dialog a second time — so "Don't Save" just reopened the prompt
                // forever. Resetting to `Idle` first makes the re-entrant tick a
                // no-op; the Save branch re-assigns to `Waiting` as needed. (The Linux
                // path already does this before its async dialog.)
                close_flow = CloseFlow::Idle;
                if is_clean {
                    // Live state says no unsaved changes → close now.
                    close_ctx.cleanup_lock();
                    *control_flow = ControlFlow::Exit;
                } else if close_ctx.auto_save {
                    // Dirty + auto-save on: save silently, then close when it completes.
                    close_counter += 1;
                    close_flow =
                        begin_save_close(&webview, &close_ctx.pending_actions, close_counter);
                } else {
                    // Dirty + auto-save off: ask the user.
                    match confirm_close_dialog() {
                        CloseChoice::Save => {
                            close_counter += 1;
                            close_flow = begin_save_close(
                                &webview,
                                &close_ctx.pending_actions,
                                close_counter,
                            );
                        }
                        CloseChoice::DontSave => {
                            close_ctx.cleanup_lock();
                            *control_flow = ControlFlow::Exit;
                        }
                        CloseChoice::Cancel => close_flow = CloseFlow::Idle,
                    }
                }
            }
        } else if matches!(close_flow, CloseFlow::Waiting { .. }) {
            match poll_close_flow(&mut close_flow, &close_ctx.pending_actions) {
                CloseOutcome::Exit => {
                    close_ctx.cleanup_lock();
                    *control_flow = ControlFlow::Exit;
                }
                CloseOutcome::Failed(detail) => {
                    // Save/library write failed or the round-trip was lost: keep
                    // the window open and tell the user why (spec requirement).
                    close_flow = CloseFlow::Idle;
                    show_close_error_dialog(detail.as_deref());
                }
                CloseOutcome::Pending => {}
            }
        }

        // Dispatch native menu clicks / accelerators (e.g. Cmd+S) into the JS bridge.
        while let Ok(menu_event) = menu_channel.try_recv() {
            if let Some(script) = menu_event_script(&menu_event.id, &menu_ids) {
                let _ = webview.evaluate_script(script);
            }
        }

        while let Ok(req) = export_rx.try_recv() {
            handle_export_request(req);
        }

        while let Ok(req) = library_open_rx.try_recv() {
            handle_library_open_request(req);
        }

        if focus_rx.has_changed().unwrap_or(false) {
            let _ = focus_rx.borrow_and_update();
            window.set_focus();
        }

        // Refresh the title's "*" dirty marker when the scene's dirty state flips.
        let dirty_now = close_ctx.dirty.read().map(|d| d.dirty).unwrap_or(false);
        if dirty_now != last_title_dirty {
            last_title_dirty = dirty_now;
            window.set_title(&close_ctx.window_title());
        }

        // --smoke: advance the self-test; print the report and exit when it ends.
        if let Some(driver) = smoke_driver.as_mut() {
            if let Some(checks) = driver.tick(&webview, &close_ctx.pending_actions) {
                finish_smoke_and_exit(checks, &close_ctx);
            }
        }
    });

    Ok(())
}

// ── CLI ──────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(name = "excalidraw-preview")]
#[command(about = "Preview Excalidraw files in a native window")]
struct CliArgs {
    /// Path to the .excalidraw, .excalidraw.svg, or .excalidraw.png file to preview.
    /// Not required when running as an LSP server (--lsp).
    file: Option<String>,
    /// Create <PATH> as a new blank drawing and open the preview.
    /// Fails if the file already exists.
    #[arg(long, value_name = "PATH", conflicts_with = "file")]
    new: Option<String>,
    /// Bind the HTTP server to this port (default: auto-selected).
    #[arg(long)]
    port: Option<u16>,
    /// Enable debug logging.
    #[arg(long)]
    debug: bool,
    /// Run as a minimal LSP server for Zed integration.
    /// Zed will call this automatically when a .excalidraw file is opened.
    #[arg(long)]
    lsp: bool,
    /// Dev shorthand: open the WebView at http://localhost:5173 (the Vite dev server).
    /// Run `npm run dev` in preview-binary/webview-src/ first.
    #[arg(long)]
    dev: bool,
    /// Open the WebView at a custom URL instead of the embedded server.
    /// Useful for pointing at a running Vite dev server on a non-default port.
    /// e.g. --dev-server http://localhost:5173
    #[arg(long, value_name = "URL")]
    dev_server: Option<String>,
    /// Automatically save the diagram back to disk after every change (debounced 300 ms).
    /// Default: off — use Ctrl+S to save manually.
    #[arg(long)]
    auto_save: bool,
    /// Internal: run in the foreground (do not detach). Set automatically on re-spawn.
    #[arg(long, hide = true)]
    foreground: bool,
    /// Run the server without opening a WebView window (tests / headless environments).
    /// Also enabled by setting `EXCALIDRAW_PREVIEW_HEADLESS=true`, which propagates to
    /// previews the LSP server spawns (so integration tests can drive `didOpen` /
    /// `didSave` without opening real windows).
    #[arg(long, env = "EXCALIDRAW_PREVIEW_HEADLESS")]
    headless: bool,
    /// Write exports directly into this directory instead of showing a save dialog.
    /// Intended for tests and headless use.
    #[arg(long, value_name = "DIR")]
    export_dir: Option<PathBuf>,
    /// Run an automated self-test against a real WebView, then exit. Drives the
    /// native→JS bridge (save, close-interception query) and external-link
    /// classification, prints a PASS/FAIL report, and exits non-zero on any
    /// failure. See `features/2026-06-13-rough-edges/manual-checklist.md`.
    #[arg(long)]
    smoke: bool,
}

// ── LSP server ───────────────────────────────────────────────────────────────

/// Minimal JSON-RPC LSP server.
///
/// Zed starts this when a `.excalidraw` file is opened (via `language_server_command`).
/// On `textDocument/didOpen` it spawns the preview window for that file and exits
/// the notification without blocking the LSP loop.
fn run_lsp_server() -> Result<()> {
    use std::io::{BufRead, BufReader, Read};

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    let exe = std::env::current_exe()?;

    loop {
        // ── Read headers ────────────────────────────────────────────────────
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line)?;
            if n == 0 {
                return Ok(()); // EOF — Zed closed stdin
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                break; // blank line separates headers from body
            }
            if let Some(val) = trimmed.strip_prefix("Content-Length: ") {
                content_length = val.trim().parse().ok();
            }
        }

        let len = match content_length {
            Some(l) if l > 0 => l,
            _ => continue,
        };

        // ── Read body ────────────────────────────────────────────────────────
        let mut body = vec![0u8; len];
        reader.read_exact(&mut body)?;

        let msg: serde_json::Value =
            serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
        let method = msg["method"].as_str().unwrap_or("");
        let id = msg.get("id").cloned();

        // ── Dispatch ─────────────────────────────────────────────────────────
        match method {
            "initialize" => {
                let response = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "capabilities": {
                            // openClose → didOpen/didClose; change:1 = Full sync;
                            // save:true → Zed sends textDocument/didSave (reopen-on-save).
                            "textDocumentSync": {
                                "openClose": true,
                                "change": 1,
                                "save": true
                            }
                        },
                        "serverInfo": { "name": "excalidraw-preview", "version": "0.1.0" }
                    }
                });
                lsp_send(&mut writer, &response)?;
            }

            "initialized" => { /* notification — no response required */ }

            "textDocument/didOpen" => {
                if let Some(uri) = msg["params"]["textDocument"]["uri"].as_str() {
                    if let Some(path) = file_uri_to_path(uri) {
                        // Only real Excalidraw files get a preview; Zed may attach
                        // this server to plain .svg/.png too (see is_excalidraw_path).
                        if is_excalidraw_path(&path) {
                            spawn_preview(&exe, &path);
                        }
                    }
                }
            }

            "textDocument/didClose" => {
                // Intentionally a no-op: the preview window persists until the user
                // closes it. Zed reuses one "preview tab" for single-clicked files,
                // so it sends didClose whenever you browse to another file — tearing
                // the window down here made previews flicker shut while navigating.
                // The window owns its own lifecycle (close button → lock cleanup +
                // server shutdown); reopening a closed preview is handled by didSave.
            }

            "textDocument/didSave" => {
                // Saving a buffer reopens a preview the user deliberately closed.
                // This is acceptable: a save is explicit and low-frequency. We do
                // NOT spawn on didChange — typing must never resurrect a closed
                // preview. If a live instance already exists, this is a no-op.
                if let Some(uri) = msg["params"]["textDocument"]["uri"].as_str() {
                    if let Some(path) = file_uri_to_path(uri) {
                        if is_excalidraw_path(&path) && !preview_is_live(&path) {
                            spawn_preview(&exe, &path);
                        }
                    }
                }
            }

            "shutdown" => {
                lsp_send(
                    &mut writer,
                    &serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null }),
                )?;
            }

            "exit" => break,

            _ => {
                // Respond to unknown *requests* with "method not found".
                // Notifications (no id) are silently ignored.
                if let Some(id) = id {
                    lsp_send(
                        &mut writer,
                        &serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32601, "message": "Method not found" }
                        }),
                    )?;
                }
            }
        }
    }

    Ok(())
}

/// Writes a single LSP message to `writer` (Content-Length framing).
fn lsp_send(writer: &mut impl std::io::Write, msg: &serde_json::Value) -> Result<()> {
    let body = serde_json::to_string(msg)?;
    write!(writer, "Content-Length: {}\r\n\r\n{}", body.len(), body)?;
    writer.flush()?;
    Ok(())
}

/// Spawns `excalidraw-preview <path>` as a fully detached process so that
/// closing the LSP server (when Zed shuts down the language server) does not
/// kill the preview window.
fn spawn_preview(exe: &std::path::Path, path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        let _ = std::process::Command::new(exe)
            .arg(path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0) // new process group → immune to SIGHUP
            .spawn();
    }
    #[cfg(not(unix))]
    {
        let _ = std::process::Command::new(exe)
            .arg(path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

/// Returns `true` if a live preview server is already serving `path`.
///
/// Reads the per-file lock file and probes `GET /ping`. Uses a blocking client,
/// so it is safe to call from the synchronous LSP loop. A missing/stale lock or a
/// failed ping reports "not live" so the caller can spawn a fresh instance.
fn preview_is_live(path: &std::path::Path) -> bool {
    let Ok(canonical) = std::fs::canonicalize(path) else {
        return false;
    };
    let lock_path = get_lock_path(&canonical);
    let Ok(port_str) = std::fs::read_to_string(&lock_path) else {
        return false;
    };
    let Ok(port) = port_str.trim().parse::<u16>() else {
        return false;
    };
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(1))
        .build()
    else {
        return false;
    };
    client
        .get(format!("http://127.0.0.1:{}/ping", port))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Converts a `file://` URI to an absolute filesystem path.
///
/// Delegates to a real URL parser so percent-encoding and platform-specific path
/// shapes resolve correctly — not just POSIX `file:///tmp/a.excalidraw`, but also
/// Windows drive-letter URIs (`file:///C:/Users/me/a.excalidraw`) and UNC paths
/// (`file://server/share/a.excalidraw`). The hand-rolled prefix-strip it replaces
/// turned `file:///C:/...` into `/C:/...`, silently breaking the LSP-driven
/// auto-open and save-triggered reopen on Windows.
fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    url::Url::parse(uri).ok()?.to_file_path().ok()
}

/// Whether `path` is a file the preview actually handles: `.excalidraw`,
/// `.excalidraw.svg`, or `.excalidraw.png`.
///
/// The language server is attached to the "Excalidraw" language (path suffixes
/// `excalidraw`, `excalidraw.svg`, `excalidraw.png`), but Zed's suffix matching
/// also fires the server for plain `.svg`/`.png` files. Gating `didOpen`/`didSave`
/// on this keeps a plain image from spawning a preview that can only fail — a
/// plain `.svg`/`.png` has no embedded Excalidraw scene and is MIME-detected as
/// JSON, so every format fallback errors out ("all format fallbacks failed").
fn is_excalidraw_path(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.ends_with(".excalidraw")
                || name.ends_with(".excalidraw.svg")
                || name.ends_with(".excalidraw.png")
        })
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt; // for `oneshot`

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn make_state(file: &std::path::Path, content_type: &str) -> Arc<AppState> {
        let (broadcast_tx, _) = broadcast::channel(16);
        let (focus_tx, _) = watch::channel(false);
        let (export_tx, _) = std::sync::mpsc::channel();
        let (library_open_tx, _) = std::sync::mpsc::channel();
        Arc::new(AppState {
            file_path: file.to_path_buf(),
            lock_path: std::env::temp_dir().join("excalidraw-test.lock"),
            content_type: content_type.to_string(),
            file_name: file
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            auto_save: false,
            broadcast_tx,
            focus_tx: Arc::new(focus_tx),
            export_tx,
            library_open_tx,
            export_dir: None,
            dirty: Arc::new(RwLock::new(DirtyState::default())),
            pending_actions: Arc::new(Mutex::new(HashMap::new())),
            pending_libraries: Arc::new(Mutex::new(Vec::new())),
        })
    }

    fn json_app(state: Arc<AppState>) -> Router {
        Router::new()
            .route("/config", get(serve_config))
            .route("/data", get(serve_data))
            .route("/focus", get(handle_focus))
            .route("/ping", get(ping))
            .with_state(state)
    }

    // ── Unit tests ───────────────────────────────────────────────────────────

    #[test]
    fn test_detect_content_type_json() {
        assert_eq!(
            detect_content_type(&PathBuf::from("diagram.excalidraw")),
            "application/json"
        );
    }

    #[test]
    fn test_is_allowed_library_url() {
        // Allowed: https on Excalidraw / GitHub-raw hosts.
        assert!(is_allowed_library_url(
            "https://libraries.excalidraw.com/libraries/youritjang/software-architecture.excalidrawlib"
        ));
        assert!(is_allowed_library_url(
            "https://raw.githubusercontent.com/someone/repo/main/shapes.excalidrawlib"
        ));
        // Rejected: non-https, and arbitrary/SSRF-prone hosts.
        assert!(!is_allowed_library_url(
            "http://libraries.excalidraw.com/x.excalidrawlib"
        ));
        assert!(!is_allowed_library_url("https://evil.example.com/x.excalidrawlib"));
        assert!(!is_allowed_library_url("file:///etc/passwd"));
        assert!(!is_allowed_library_url("http://169.254.169.254/latest/meta-data"));
        assert!(!is_allowed_library_url("not a url"));
    }

    #[test]
    fn test_is_excalidraw_library() {
        // v2 (libraryItems) and v1 (library) shapes both accepted.
        assert!(is_excalidraw_library(
            r#"{"type":"excalidrawlib","version":2,"libraryItems":[]}"#
        ));
        assert!(is_excalidraw_library(
            r#"{"type":"excalidrawlib","version":1,"library":[[]]}"#
        ));
        // Rejected: wrong type, missing items array, scene file, or non-JSON.
        assert!(!is_excalidraw_library(
            r#"{"type":"excalidraw","elements":[]}"#
        ));
        assert!(!is_excalidraw_library(r#"{"type":"excalidrawlib"}"#));
        assert!(!is_excalidraw_library("not json"));
    }

    #[test]
    fn test_detect_content_type_svg() {
        assert_eq!(
            detect_content_type(&PathBuf::from("diagram.excalidraw.svg")),
            "image/svg+xml"
        );
    }

    #[test]
    fn test_detect_content_type_png() {
        assert_eq!(
            detect_content_type(&PathBuf::from("diagram.excalidraw.png")),
            "image/png"
        );
    }

    #[test]
    fn test_detect_content_type_unknown_falls_back_to_json() {
        // A plain ".svg" file (without the .excalidraw prefix) still defaults to json.
        assert_eq!(
            detect_content_type(&PathBuf::from("diagram.svg")),
            "application/json"
        );
    }

    #[test]
    fn test_get_lock_path_is_deterministic() {
        let path = PathBuf::from("/tmp/test.excalidraw");
        assert_eq!(get_lock_path(&path), get_lock_path(&path));
    }

    #[test]
    fn test_get_lock_path_differs_for_different_files() {
        let a = PathBuf::from("/tmp/a.excalidraw");
        let b = PathBuf::from("/tmp/b.excalidraw");
        assert_ne!(get_lock_path(&a), get_lock_path(&b));
    }

    #[test]
    fn test_get_lock_path_filename_format() {
        let path = PathBuf::from("/tmp/test.excalidraw");
        let lock = get_lock_path(&path);
        let name = lock.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with("excalidraw-"), "got: {name}");
        assert!(name.ends_with(".lock"), "got: {name}");
    }

    #[test]
    fn test_is_internal_url_classifies_hosts_and_schemes() {
        // Loopback hosts and editor schemes stay inside the WebView.
        assert!(is_internal_url("http://127.0.0.1:18733/assets/x.js"));
        assert!(is_internal_url("http://localhost:5173/"));
        assert!(is_internal_url("https://localhost/data"));
        assert!(is_internal_url("data:image/png;base64,AAAA"));
        assert!(is_internal_url("blob:http://127.0.0.1/abc"));
        assert!(is_internal_url("about:blank"));
        // External hosts and unknown schemes are not internal.
        assert!(!is_internal_url("https://libraries.excalidraw.com/"));
        assert!(!is_internal_url("https://github.com/excalidraw/excalidraw"));
        assert!(!is_internal_url("http://example.com:8080/path"));
        assert!(!is_internal_url("mailto:hi@example.com"));
    }

    // ── Route tests ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_ping_returns_200() {
        let app = Router::new().route("/ping", get(ping));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/ping")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_serve_config_returns_correct_json() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let state = make_state(tmp.path(), "application/json");
        let app = json_app(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/config")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["contentType"], "application/json");
        assert_eq!(json["theme"], "auto");
        assert_eq!(json["autoSave"], false);
    }

    #[tokio::test]
    async fn test_serve_config_svg() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let state = make_state(tmp.path(), "image/svg+xml");
        let app = json_app(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/config")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["contentType"], "image/svg+xml");
    }

    #[tokio::test]
    async fn test_serve_data_returns_file_contents() {
        use std::io::Write;
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        let payload = r#"{"type":"excalidraw","version":2,"elements":[]}"#;
        tmp.write_all(payload.as_bytes()).unwrap();

        let state = make_state(tmp.path(), "application/json");
        let app = json_app(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/data")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), payload.as_bytes());
    }

    #[tokio::test]
    async fn test_serve_data_missing_file_returns_500() {
        let state = make_state(
            std::path::Path::new("/nonexistent/path/that/does/not/exist.excalidraw"),
            "application/json",
        );
        let app = json_app(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/data")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn test_handle_focus_signals_watch_channel() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let (broadcast_tx, _) = broadcast::channel(16);
        let (focus_tx, _focus_rx) = watch::channel(false);
        let focus_tx = Arc::new(focus_tx);
        let (export_tx, _) = std::sync::mpsc::channel();
        let (library_open_tx, _) = std::sync::mpsc::channel();

        let state = Arc::new(AppState {
            file_path: tmp.path().to_path_buf(),
            lock_path: std::env::temp_dir().join("excalidraw-test-focus.lock"),
            content_type: "application/json".to_string(),
            file_name: "test".to_string(),
            auto_save: false,
            broadcast_tx,
            focus_tx,
            export_tx,
            library_open_tx,
            export_dir: None,
            dirty: Arc::new(RwLock::new(DirtyState::default())),
            pending_actions: Arc::new(Mutex::new(HashMap::new())),
            pending_libraries: Arc::new(Mutex::new(Vec::new())),
        });

        let app = Router::new()
            .route("/focus", get(handle_focus))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/focus")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        // The watch channel value should have been updated to `true`.
        // Note: This test only verifies the endpoint responds; the watch channel
        // behavior is verified in integration tests that run the full event loop.
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), b"OK");
    }

    // ── /dirty and /native-action-result ───────────────────────────────────────

    fn bridge_app(state: Arc<AppState>) -> Router {
        Router::new()
            .route("/dirty", axum::routing::post(receive_dirty))
            .route(
                "/native-action-result",
                axum::routing::post(receive_native_action_result),
            )
            .with_state(state)
    }

    fn post_json(uri: &str, body: &str) -> Request<axum::body::Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn test_receive_dirty_updates_shared_state() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let state = make_state(tmp.path(), "application/json");
        let app = bridge_app(state.clone());

        let response = app
            .oneshot(post_json(
                "/dirty",
                r#"{"dirty":true,"pendingSave":true,"lastSavedAt":1717000000000}"#,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let dirty = state.dirty.read().unwrap();
        assert!(dirty.dirty);
        assert!(dirty.pending_save);
        assert_eq!(dirty.last_saved_at, Some(1717000000000));
    }

    #[tokio::test]
    async fn test_receive_dirty_accepts_null_last_saved_at() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let state = make_state(tmp.path(), "application/json");
        let app = bridge_app(state.clone());

        let response = app
            .oneshot(post_json(
                "/dirty",
                r#"{"dirty":false,"pendingSave":false,"lastSavedAt":null}"#,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let dirty = state.dirty.read().unwrap();
        assert!(!dirty.dirty);
        assert!(!dirty.pending_save);
    }

    #[tokio::test]
    async fn test_receive_dirty_rejects_malformed_body() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let state = make_state(tmp.path(), "application/json");
        let app = bridge_app(state);

        let response = app
            .oneshot(post_json("/dirty", r#"{"dirty":"not-a-bool"}"#))
            .await
            .unwrap();
        assert!(
            response.status().is_client_error(),
            "expected 4xx, got {}",
            response.status()
        );
    }

    #[tokio::test]
    async fn test_native_action_result_resolves_pending() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let state = make_state(tmp.path(), "application/json");

        // Register a pending action keyed by id, mirroring what native dispatch will do.
        let (tx, rx) = tokio::sync::oneshot::channel();
        state
            .pending_actions
            .lock()
            .unwrap()
            .insert("req-1".to_string(), tx);

        let app = bridge_app(state.clone());
        let response = app
            .oneshot(post_json(
                "/native-action-result",
                r#"{"id":"req-1","action":"save","ok":true,"error":null}"#,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let result = rx.await.expect("pending action should be resolved");
        assert_eq!(result.action, "save");
        assert!(result.ok);
        assert!(result.error.is_none());
        // The entry must have been removed from the table.
        assert!(state.pending_actions.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_native_action_result_unknown_id_is_noop() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let state = make_state(tmp.path(), "application/json");
        let app = bridge_app(state);

        let response = app
            .oneshot(post_json(
                "/native-action-result",
                r#"{"id":"missing","action":"save","ok":false,"error":"boom"}"#,
            ))
            .await
            .unwrap();
        // Unknown ids are accepted (no waiter) — must not error.
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_native_action_result_rejects_malformed_body() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let state = make_state(tmp.path(), "application/json");
        let app = bridge_app(state);

        let response = app
            .oneshot(post_json("/native-action-result", r#"{"id":"x"}"#))
            .await
            .unwrap();
        assert!(
            response.status().is_client_error(),
            "expected 4xx, got {}",
            response.status()
        );
    }

    // ── Close-flow cleanup ──────────────────────────────────────────────────────

    #[test]
    fn test_poll_close_flow_evicts_pending_entry_on_timeout() {
        // A Waiting flow whose deadline has already passed must drop its
        // correlation entry so a late /native-action-result can't resurrect it.
        let pending: PendingActions = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = tokio::sync::oneshot::channel();
        pending.lock().unwrap().insert("close-1".to_string(), tx);

        let mut flow = CloseFlow::Waiting {
            rx,
            deadline: std::time::Instant::now() - std::time::Duration::from_secs(1),
            request_id: "close-1".to_string(),
        };

        let outcome = poll_close_flow(&mut flow, &pending);
        // A timeout with no frontend detail → Failed(None): keep the window open
        // and surface a generic error.
        assert!(
            matches!(outcome, CloseOutcome::Failed(None)),
            "a timeout must end the flow as Failed(None), not close the window"
        );
        assert!(
            pending.lock().unwrap().is_empty(),
            "stale pending entry must be evicted on timeout"
        );
    }

    #[test]
    fn test_poll_close_flow_evicts_pending_entry_on_channel_drop() {
        // If the sender is dropped without a result, the flow finishes and must
        // also clear its correlation entry.
        let pending: PendingActions = Arc::new(Mutex::new(HashMap::new()));
        // The flow's own channel, closed by dropping its sender.
        let (tx, rx) = tokio::sync::oneshot::channel::<NativeActionResult>();
        drop(tx); // close the channel → rx.try_recv() yields Closed
        // A still-registered correlation entry under the same id (a stray sender
        // that no resolving result will ever remove).
        let (placeholder_tx, _placeholder_rx) = tokio::sync::oneshot::channel::<NativeActionResult>();
        pending
            .lock()
            .unwrap()
            .insert("close-2".to_string(), placeholder_tx);

        let mut flow = CloseFlow::Waiting {
            rx,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(60),
            request_id: "close-2".to_string(),
        };

        let outcome = poll_close_flow(&mut flow, &pending);
        assert!(
            matches!(outcome, CloseOutcome::Failed(None)),
            "a closed channel ends the flow as Failed(None)"
        );
        assert!(
            pending.lock().unwrap().is_empty(),
            "stale pending entry must be evicted when the channel drops"
        );
    }

    #[test]
    fn test_poll_close_flow_still_waiting_keeps_entry() {
        // Before the deadline with no result, the flow stays pending and the
        // entry is retained.
        let pending: PendingActions = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = tokio::sync::oneshot::channel();
        pending.lock().unwrap().insert("close-3".to_string(), tx);

        let mut flow = CloseFlow::Waiting {
            rx,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(60),
            request_id: "close-3".to_string(),
        };

        let outcome = poll_close_flow(&mut flow, &pending);
        assert!(
            matches!(outcome, CloseOutcome::Pending),
            "still within the deadline → Pending"
        );
        assert_eq!(pending.lock().unwrap().len(), 1, "entry retained while waiting");
    }

    #[test]
    fn test_poll_close_flow_exits_on_successful_save() {
        // A resolved ok:true close round-trip → Exit (the window may close).
        let pending: PendingActions = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = tokio::sync::oneshot::channel();
        tx.send(NativeActionResult {
            action: "save".to_string(),
            ok: true,
            error: None,
        })
        .unwrap();
        let mut flow = CloseFlow::Waiting {
            rx,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(60),
            request_id: "close-ok".to_string(),
        };

        assert!(matches!(
            poll_close_flow(&mut flow, &pending),
            CloseOutcome::Exit
        ));
    }

    #[test]
    fn test_poll_close_flow_failed_save_preserves_error_detail() {
        // A resolved ok:false close round-trip must surface the frontend's error
        // text (not a bare bool) so the dialog can explain the failure.
        let pending: PendingActions = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = tokio::sync::oneshot::channel();
        tx.send(NativeActionResult {
            action: "save".to_string(),
            ok: false,
            error: Some("disk full".to_string()),
        })
        .unwrap();
        let mut flow = CloseFlow::Waiting {
            rx,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(60),
            request_id: "close-fail".to_string(),
        };

        match poll_close_flow(&mut flow, &pending) {
            CloseOutcome::Failed(Some(detail)) => assert_eq!(detail, "disk full"),
            CloseOutcome::Failed(None) => panic!("error detail was dropped"),
            CloseOutcome::Exit => panic!("a failed save must not close the window"),
            CloseOutcome::Pending => panic!("a resolved result must not be Pending"),
        }
    }

    #[test]
    fn test_close_error_message_uses_detail_when_present() {
        let msg = close_error_message(Some("disk full"));
        assert!(msg.contains("disk full"), "detail must appear in the message");
        assert!(msg.contains("kept open"), "must reassure the window stayed open");
    }

    #[test]
    fn test_close_error_message_falls_back_when_no_detail() {
        // Lost round-trip (timeout / unmounted bridge) → generic timeout copy.
        for detail in [None, Some(""), Some("   ")] {
            let msg = close_error_message(detail);
            assert!(msg.contains("did not respond"), "blank detail → timeout copy");
            assert!(msg.contains("kept open"));
        }
    }

    // ── Live dirty-state query (close flow, finding 2) ──────────────────────────

    /// Helper: a `Querying` flow whose result channel is held by the caller.
    fn querying_flow(
        request_id: &str,
        deadline: std::time::Instant,
    ) -> (CloseFlow, tokio::sync::oneshot::Sender<NativeActionResult>) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let flow = CloseFlow::Querying {
            rx,
            deadline,
            request_id: request_id.to_string(),
        };
        (flow, tx)
    }

    #[test]
    fn test_poll_query_flow_reports_clean_when_webview_says_not_dirty() {
        // The query resolved with ok:true (no unsaved changes) → safe to close,
        // regardless of the (here, stale) cached dirty flag.
        let pending: PendingActions = Arc::new(Mutex::new(HashMap::new()));
        let (mut flow, tx) =
            querying_flow("query-1", std::time::Instant::now() + std::time::Duration::from_secs(60));
        tx.send(NativeActionResult {
            action: "prepareClose".to_string(),
            ok: true,
            error: None,
        })
        .unwrap();

        // cached_dirty=true would have closed-without-saving under the old logic;
        // the live query overrides it.
        assert_eq!(poll_query_flow(&mut flow, &pending, true), Some(true));
    }

    #[test]
    fn test_poll_query_flow_reports_dirty_when_webview_says_dirty() {
        let pending: PendingActions = Arc::new(Mutex::new(HashMap::new()));
        let (mut flow, tx) =
            querying_flow("query-2", std::time::Instant::now() + std::time::Duration::from_secs(60));
        tx.send(NativeActionResult {
            action: "prepareClose".to_string(),
            ok: false,
            error: None,
        })
        .unwrap();

        // Live query says dirty even though the cached flag is clean (the exact
        // finding-2 race: an edit landed before its POST /dirty was delivered).
        assert_eq!(poll_query_flow(&mut flow, &pending, false), Some(false));
    }

    #[test]
    fn test_poll_query_flow_pending_before_deadline() {
        let pending: PendingActions = Arc::new(Mutex::new(HashMap::new()));
        let (mut flow, _tx) =
            querying_flow("query-3", std::time::Instant::now() + std::time::Duration::from_secs(60));
        // No result yet, deadline far off → still pending (None).
        assert_eq!(poll_query_flow(&mut flow, &pending, true), None);
    }

    #[test]
    fn test_poll_query_flow_lost_falls_back_to_cached_dirty() {
        // An unresponsive / not-yet-mounted WebView: the query times out and the
        // loop falls back to the last reported dirty state. cached_dirty=true ⇒
        // NOT clean (we must not close silently over possible unsaved changes).
        let pending: PendingActions = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = tokio::sync::oneshot::channel();
        pending.lock().unwrap().insert("query-4".to_string(), tx);
        let mut flow = CloseFlow::Querying {
            rx,
            deadline: std::time::Instant::now() - std::time::Duration::from_secs(1),
            request_id: "query-4".to_string(),
        };

        assert_eq!(poll_query_flow(&mut flow, &pending, true), Some(false));
        assert!(
            pending.lock().unwrap().is_empty(),
            "a lost query evicts its stale correlation entry"
        );
    }

    #[test]
    fn test_poll_query_flow_lost_with_clean_cache_allows_close() {
        let pending: PendingActions = Arc::new(Mutex::new(HashMap::new()));
        let (_tx, rx) = tokio::sync::oneshot::channel::<NativeActionResult>();
        let mut flow = CloseFlow::Querying {
            rx,
            deadline: std::time::Instant::now() - std::time::Duration::from_secs(1),
            request_id: "query-5".to_string(),
        };
        // No correlation entry registered; deadline passed; cached clean → close.
        assert_eq!(poll_query_flow(&mut flow, &pending, false), Some(true));
    }

    // ── /native-library-request ────────────────────────────────────────────────

    #[test]
    fn test_dialog_filter_for_known_and_unknown() {
        assert_eq!(
            dialog_filter_for("excalidrawlib").unwrap().0,
            "Excalidraw Library"
        );
        assert_eq!(dialog_filter_for("png").unwrap().0, "PNG Image");
        assert_eq!(dialog_filter_for("svg").unwrap().0, "SVG Image");
        assert!(dialog_filter_for("bin").is_none());
    }

    /// Builds an `AppState` whose library-open channel receiver is returned to the
    /// caller, so a test can stand in for the UI thread that answers the dialog.
    fn make_state_with_library(
        file: &std::path::Path,
    ) -> (Arc<AppState>, std::sync::mpsc::Receiver<LibraryOpenRequest>) {
        let (broadcast_tx, _) = broadcast::channel(16);
        let (focus_tx, _) = watch::channel(false);
        let (export_tx, _) = std::sync::mpsc::channel();
        let (library_open_tx, library_open_rx) = std::sync::mpsc::channel();
        let state = Arc::new(AppState {
            file_path: file.to_path_buf(),
            lock_path: std::env::temp_dir().join("excalidraw-test-lib.lock"),
            content_type: "application/json".to_string(),
            file_name: "test".to_string(),
            auto_save: false,
            broadcast_tx,
            focus_tx: Arc::new(focus_tx),
            export_tx,
            library_open_tx,
            export_dir: None,
            dirty: Arc::new(RwLock::new(DirtyState::default())),
            pending_actions: Arc::new(Mutex::new(HashMap::new())),
            pending_libraries: Arc::new(Mutex::new(Vec::new())),
        });
        (state, library_open_rx)
    }

    #[tokio::test]
    async fn test_receive_library_request_returns_picked_bytes() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let (state, library_open_rx) = make_state_with_library(tmp.path());

        // Stand in for the UI thread: answer the dialog with file bytes.
        std::thread::spawn(move || {
            if let Ok(req) = library_open_rx.recv() {
                let _ = req
                    .reply
                    .send(Some(br#"{"type":"excalidrawlib","libraryItems":[]}"#.to_vec()));
            }
        });

        let response = receive_library_request(State(state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["type"], "excalidrawlib");
    }

    #[tokio::test]
    async fn test_receive_library_request_cancel_returns_204() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let (state, library_open_rx) = make_state_with_library(tmp.path());

        // Stand in for the UI thread: user cancelled the dialog.
        std::thread::spawn(move || {
            if let Ok(req) = library_open_rx.recv() {
                let _ = req.reply.send(None);
            }
        });

        let response = receive_library_request(State(state)).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn test_receive_library_request_no_window_returns_500() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let (state, library_open_rx) = make_state_with_library(tmp.path());
        // Drop the receiver: no UI thread → the send fails → 500.
        drop(library_open_rx);

        let response = receive_library_request(State(state)).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn test_serve_index_missing_asset_returns_404() {
        // The assets/ folder is embedded at compile time; in a test build without
        // a real `assets/` directory this is expected to return 404.
        let app = Router::new().route("/", get(serve_index));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // Either 200 (assets present) or 404 (no assets in test build) is acceptable.
        assert!(response.status() == StatusCode::OK || response.status() == StatusCode::NOT_FOUND);
    }

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

    // ── LSP file:// URI parsing (finding 1) ─────────────────────────────────────

    /// Runs `git` in `dir`, panicking on failure. Used to build hermetic repos
    /// for the `git_repo_label` tests.
    #[cfg(unix)]
    fn git_in(dir: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            // Keep test repos isolated from the developer's global git config.
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
            .expect("spawn git");
        assert!(status.success(), "git {args:?} failed");
    }

    #[cfg(unix)]
    #[test]
    fn test_git_repo_label_for_file_in_repo() {
        // A file inside a normal checkout must resolve to
        // "(Title Case Repo(branch), repo-relative-path)". Regression guard for the
        // `gix::discover` file-vs-directory bug: handed the file path directly,
        // discover errored and the label silently fell back to the bare path.
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("my-cool-repo");
        std::fs::create_dir(&repo).unwrap();
        git_in(&repo, &["init", "-b", "main"]);

        let sub = repo.join("docs");
        std::fs::create_dir(&sub).unwrap();
        let file = sub.join("diagram.excalidraw");
        std::fs::write(&file, "{}").unwrap();
        let file = std::fs::canonicalize(&file).unwrap();

        let (label, relative) = git_repo_label(&file).expect("file in repo → Some");
        // Repo dir name is Title-Cased; branch is verbatim.
        assert_eq!(label, "My Cool Repo(main)", "label was: {label}");
        assert_eq!(relative, "docs/diagram.excalidraw");
        assert!(!relative.starts_with('/'));
    }

    #[cfg(unix)]
    #[test]
    fn test_git_repo_label_for_file_in_linked_worktree() {
        // A file inside a *linked* worktree (its `.git` is a gitdir-pointer file,
        // not a directory) must still resolve, with the worktree dir as the repo
        // root — this is the real-world case that surfaced the discover bug.
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main-repo");
        std::fs::create_dir(&main).unwrap();
        git_in(&main, &["init", "-b", "main"]);
        std::fs::write(main.join("seed"), "x").unwrap();
        git_in(&main, &["add", "."]);
        git_in(&main, &["commit", "-m", "seed"]);

        // Add a linked worktree on a new branch.
        let wt = tmp.path().join("feature-work");
        git_in(
            &main,
            &["worktree", "add", "-b", "feature", wt.to_str().unwrap()],
        );

        let file = wt.join("art.excalidraw.svg");
        std::fs::write(&file, "<svg/>").unwrap();
        let file = std::fs::canonicalize(&file).unwrap();

        let (label, relative) = git_repo_label(&file).expect("file in worktree → Some");
        // The label is the *main* repo name ("main-repo" → "Main Repo"), NOT the
        // worktree directory ("feature-work"); the branch is the worktree's branch.
        // The relative path is anchored at the worktree root.
        assert_eq!(label, "Main Repo(feature)", "label was: {label}");
        assert_eq!(relative, "art.excalidraw.svg");
    }

    #[test]
    fn test_title_case() {
        assert_eq!(
            title_case("excalidraw-zed-extension"),
            "Excalidraw Zed Extension"
        );
        assert_eq!(title_case("my_cool_repo"), "My Cool Repo");
        assert_eq!(title_case("single"), "Single");
        // Acronyms / existing capitals in the tail are preserved.
        assert_eq!(title_case("my-API-tool"), "My API Tool");
        // Leading/duplicate separators don't produce empty words.
        assert_eq!(title_case("-foo--bar-"), "Foo Bar");
    }

    #[test]
    fn test_display_path_home_alias() {
        let home = dirs::home_dir().expect("home dir");
        // A file under home collapses to `~/...`.
        let under_home = home.join("projects").join("diagram.excalidraw");
        assert_eq!(
            display_path(&under_home),
            "~/projects/diagram.excalidraw".to_string()
        );
        // The home dir itself renders as a bare `~`.
        assert_eq!(display_path(&home), "~".to_string());
    }

    #[test]
    fn test_display_path_outside_home_is_absolute() {
        // A path that cannot be under home (root-level) is shown in full.
        let outside = std::path::Path::new("/opt/diagrams/x.excalidraw");
        assert_eq!(display_path(outside), "/opt/diagrams/x.excalidraw");
    }

    #[test]
    fn test_clamp_window_size() {
        // Fits within the monitor → unchanged.
        assert_eq!(
            clamp_window_size((1000.0, 700.0), Some((1920.0, 1080.0))),
            (1000.0, 700.0)
        );
        // Larger than the monitor → clamped down to it (never opens off-screen).
        assert_eq!(
            clamp_window_size((4000.0, 3000.0), Some((1920.0, 1080.0))),
            (1920.0, 1080.0)
        );
        // Below the floor → raised to the minimum.
        assert_eq!(
            clamp_window_size((100.0, 100.0), Some((1920.0, 1080.0))),
            MIN_WINDOW_SIZE
        );
        // No monitor info → only the minimum floor applies.
        assert_eq!(clamp_window_size((1000.0, 700.0), None), (1000.0, 700.0));
    }

    #[test]
    fn test_window_size_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("EXCALIDRAW_ZED_CONFIG_DIR", dir.path());
        // Nothing remembered yet.
        assert_eq!(load_window_size(), None);
        // A saved size round-trips.
        save_window_size(1600.0, 1000.0);
        assert_eq!(load_window_size(), Some((1600.0, 1000.0)));
        // A corrupt/too-small saved value is rejected (caller falls back to default).
        save_window_size(10.0, 10.0);
        assert_eq!(load_window_size(), None);
    }

    #[test]
    fn test_is_excalidraw_path() {
        use std::path::Path;
        // Handled: the three Excalidraw variants.
        assert!(is_excalidraw_path(Path::new("/x/diagram.excalidraw")));
        assert!(is_excalidraw_path(Path::new("/x/diagram.excalidraw.svg")));
        assert!(is_excalidraw_path(Path::new("/x/diagram.excalidraw.png")));
        // Not handled: plain images (the bug — Zed attaches the server to these,
        // but spawning a preview only fails) and unrelated files.
        assert!(!is_excalidraw_path(Path::new("/x/test.svg")));
        assert!(!is_excalidraw_path(Path::new("/x/photo.png")));
        assert!(!is_excalidraw_path(Path::new("/x/notes.md")));
        // A directory named like one shouldn't matter, but the suffix still holds;
        // guard only inspects the file name, which is correct for LSP URIs.
        assert!(!is_excalidraw_path(Path::new("/x/excalidraw")));
    }

    #[cfg(unix)]
    #[test]
    fn test_file_uri_to_path_posix_percent_decoded() {
        // A normal POSIX URI with a percent-encoded space must decode to the
        // real path, not the literal `%20`. Unix-only: a driveless path like
        // `/Users/...` has no Windows equivalent, so `Url::to_file_path` rejects
        // it on Windows (drive-letter percent-decoding is covered separately).
        let path = file_uri_to_path("file:///Users/me/a%20b.excalidraw")
            .expect("POSIX file URI should parse");
        assert_eq!(path, std::path::Path::new("/Users/me/a b.excalidraw"));
    }

    #[cfg(unix)]
    #[test]
    fn test_file_uri_to_path_posix_plain() {
        let path = file_uri_to_path("file:///tmp/diagram.excalidraw")
            .expect("POSIX file URI should parse");
        assert_eq!(path, std::path::Path::new("/tmp/diagram.excalidraw"));
    }

    #[cfg(windows)]
    #[test]
    fn test_file_uri_to_path_windows_drive_letter() {
        // The regression from finding 1: the old strip-prefix turned this into
        // `/C:/Users/me/a.excalidraw`. A real parser yields the Windows path.
        let path = file_uri_to_path("file:///C:/Users/me/a.excalidraw")
            .expect("Windows drive-letter URI should parse");
        assert_eq!(path, std::path::Path::new(r"C:\Users\me\a.excalidraw"));

        // Percent-encoded space must decode here too (Windows counterpart of the
        // unix-only test_file_uri_to_path_posix_percent_decoded).
        let spaced = file_uri_to_path("file:///C:/Users/me/a%20b.excalidraw")
            .expect("Windows drive-letter URI with space should parse");
        assert_eq!(spaced, std::path::Path::new(r"C:\Users\me\a b.excalidraw"));
    }

    #[cfg(windows)]
    #[test]
    fn test_file_uri_to_path_windows_unc() {
        // UNC-style host: file://server/share/... → \\server\share\...
        let path = file_uri_to_path("file://server/share/a.excalidraw")
            .expect("UNC file URI should parse");
        assert_eq!(path, std::path::Path::new(r"\\server\share\a.excalidraw"));
    }

    #[test]
    fn test_file_uri_to_path_rejects_non_file_scheme() {
        // A non-file URI (or garbage) must not be coerced into a path.
        assert!(file_uri_to_path("https://example.com/a.excalidraw").is_none());
        assert!(file_uri_to_path("not a uri").is_none());
    }
}
