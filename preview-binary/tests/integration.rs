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

/// POST a JSON body and return the status code.
fn http_post_json(url: &str, body: &str) -> u16 {
    reqwest::blocking::Client::new()
        .post(url)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .timeout(Duration::from_secs(3))
        .send()
        .expect("POST request failed")
        .status()
        .as_u16()
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
fn concurrent_previews_bind_distinct_ports_and_serve() {
    // Regression for the port time-of-check/time-of-use race: start several
    // previews for different files at once and assert each binds its own port
    // and serves. With the old "probe then bind" scheme these raced for the same
    // free port and all but one failed with "Address already in use".
    let dir = tempfile::tempdir().unwrap();
    let mut previews = Vec::new();
    for i in 0..5 {
        let file = dir.path().join(format!("concurrent-{i}.excalidraw"));
        std::fs::write(&file, BLANK_SCENE).unwrap();
        previews.push(Preview::spawn(&file, &[]));
    }

    // All ports must be distinct.
    let mut ports: Vec<u16> = previews.iter().map(|p| p.port).collect();
    ports.sort_unstable();
    let unique = {
        let mut p = ports.clone();
        p.dedup();
        p.len()
    };
    assert_eq!(unique, ports.len(), "previews must bind distinct ports: {ports:?}");

    // And every instance must actually be serving.
    for preview in &previews {
        let (status, body) = http_get(&preview.url("/ping"));
        assert_eq!(status, 200, "preview on port {} not serving", preview.port);
        assert_eq!(body, "OK");
    }
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

#[test]
fn post_dirty_accepts_valid_payload_and_rejects_malformed() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();

    let preview = Preview::spawn(&file, &[]);

    // Well-formed payload → 200.
    let status = http_post_json(
        &preview.url("/dirty"),
        r#"{"dirty":true,"pendingSave":false,"lastSavedAt":null}"#,
    );
    assert_eq!(status, 200, "valid /dirty payload should be accepted");

    // A clean-state transition → 200.
    let status = http_post_json(
        &preview.url("/dirty"),
        r#"{"dirty":false,"pendingSave":false,"lastSavedAt":1717000000000}"#,
    );
    assert_eq!(status, 200, "clean /dirty payload should be accepted");

    // Malformed body → 4xx (axum's Json rejection).
    let status = http_post_json(&preview.url("/dirty"), r#"{"dirty":"nope"}"#);
    assert!((400..500).contains(&status), "malformed /dirty body should be a 4xx, got {status}");
}

#[test]
fn post_native_action_result_accepts_valid_payload() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();

    let preview = Preview::spawn(&file, &[]);

    // Unknown request id is a no-op but still acknowledged with 200.
    let status = http_post_json(
        &preview.url("/native-action-result"),
        r#"{"id":"no-such-request","action":"save","ok":true,"error":null}"#,
    );
    assert_eq!(status, 200, "valid /native-action-result payload should be accepted");

    // Malformed body → 4xx.
    let status = http_post_json(&preview.url("/native-action-result"), r#"{"id":"x"}"#);
    assert!(
        (400..500).contains(&status),
        "malformed /native-action-result body should be a 4xx, got {status}"
    );
}

/// Drives the `--lsp` server over stdin/stdout: sends an `initialize` request and
/// asserts the advertised `textDocumentSync` capability is the object form with
/// `save: true` (the Phase 2 reopen-on-save change).
#[test]
fn lsp_initialize_advertises_save_capability() {
    use std::io::{BufRead, BufReader, Write};

    let mut child = std::process::Command::new(binary())
        .arg("--lsp")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn --lsp");

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    let req = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
    write!(stdin, "Content-Length: {}\r\n\r\n{}", req.len(), req).unwrap();
    stdin.flush().unwrap();

    // Read the Content-Length framed response header(s).
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        stdout.read_line(&mut line).expect("LSP server closed stdout early");
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(val) = trimmed.strip_prefix("Content-Length: ") {
            content_length = val.trim().parse().unwrap();
        }
    }
    assert!(content_length > 0, "no Content-Length in LSP response");

    let mut body = vec![0u8; content_length];
    std::io::Read::read_exact(&mut stdout, &mut body).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    let sync = &json["result"]["capabilities"]["textDocumentSync"];
    assert!(sync.is_object(), "textDocumentSync should be the object form, got: {sync}");
    assert_eq!(sync["openClose"], serde_json::Value::Bool(true));
    assert_eq!(sync["save"], serde_json::Value::Bool(true));

    // Tell the server to exit, then reap it.
    let exit = r#"{"jsonrpc":"2.0","method":"exit"}"#;
    let _ = write!(stdin, "Content-Length: {}\r\n\r\n{}", exit.len(), exit);
    let _ = stdin.flush();
    drop(stdin);
    let _ = child.wait();
}

/// Writes one Content-Length–framed LSP message to the server's stdin.
fn lsp_write(stdin: &mut impl std::io::Write, msg: &str) {
    write!(stdin, "Content-Length: {}\r\n\r\n{}", msg.len(), msg).unwrap();
    stdin.flush().unwrap();
}

/// Reads one Content-Length–framed LSP message body from the server's stdout.
fn lsp_read(stdout: &mut impl std::io::BufRead) -> serde_json::Value {
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        stdout.read_line(&mut line).expect("LSP server closed stdout early");
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(val) = trimmed.strip_prefix("Content-Length: ") {
            content_length = val.trim().parse().unwrap();
        }
    }
    assert!(content_length > 0, "no Content-Length in LSP response");
    let mut body = vec![0u8; content_length];
    std::io::Read::read_exact(stdout, &mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

/// Drives the `--lsp` server through `textDocument/didSave`: a save with no live
/// preview must spawn one (item 9 reopen-on-save), and a second save while that
/// preview is live must NOT spawn a duplicate — the same lock port stays serving.
///
/// `EXCALIDRAW_PREVIEW_HEADLESS=true` is set on the LSP process so the previews
/// it spawns inherit it and come up windowless.
#[test]
fn lsp_did_save_spawns_preview_then_reuses_live_instance() {
    use std::io::{BufReader, Write};

    let dir = tempfile::tempdir().unwrap();
    // A space in the name forces the URI to be percent-encoded, exercising the
    // full file:// decode path (finding 1) end-to-end, not just the host shape.
    let file = dir.path().join("save target.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let canonical = std::fs::canonicalize(&file).unwrap();
    let lock = lock_path_for(&canonical);
    let _ = std::fs::remove_file(&lock);

    let mut child = std::process::Command::new(binary())
        .arg("--lsp")
        .env("EXCALIDRAW_PREVIEW_HEADLESS", "true")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn --lsp");

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    // Handshake so we know the loop is running before we send notifications.
    lsp_write(&mut stdin, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#);
    let _ = lsp_read(&mut stdout);

    // Percent-encode spaces the way a real LSP client (Zed) would.
    let uri = format!("file://{}", canonical.display()).replace(' ', "%20");
    let did_save = format!(
        r#"{{"jsonrpc":"2.0","method":"textDocument/didSave","params":{{"textDocument":{{"uri":"{uri}"}}}}}}"#
    );

    // First save: no live preview → the server must spawn one. Wait for its lock.
    lsp_write(&mut stdin, &did_save);
    let deadline = Instant::now() + Duration::from_secs(10);
    let port = loop {
        if let Ok(s) = std::fs::read_to_string(&lock) {
            if let Ok(p) = s.trim().parse::<u16>() {
                break p;
            }
        }
        assert!(
            Instant::now() < deadline,
            "didSave never spawned a preview (no lock file at {})",
            lock.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    };

    let (status, body) = http_get(&format!("http://127.0.0.1:{port}/ping"));
    assert_eq!(status, 200, "spawned preview not serving");
    assert_eq!(body, "OK");

    // Second save while the preview is live: must be a no-op (no duplicate), so
    // the lock port is unchanged and the same instance keeps serving.
    lsp_write(&mut stdin, &did_save);
    std::thread::sleep(Duration::from_millis(500));
    let lock_port: u16 = std::fs::read_to_string(&lock).unwrap().trim().parse().unwrap();
    assert_eq!(lock_port, port, "second didSave must not respawn on a new port");
    let (status, _) = http_get(&format!("http://127.0.0.1:{port}/ping"));
    assert_eq!(status, 200, "live preview must still be serving after the second didSave");

    // Tear down the detached preview, then the LSP server.
    let _ = http_get(&format!("http://127.0.0.1:{port}/shutdown"));
    std::thread::sleep(Duration::from_millis(300));
    let _ = std::fs::remove_file(&lock);

    let exit = r#"{"jsonrpc":"2.0","method":"exit"}"#;
    let _ = write!(stdin, "Content-Length: {}\r\n\r\n{}", exit.len(), exit);
    let _ = stdin.flush();
    drop(stdin);
    let _ = child.wait();
}

/// Walks `preview-binary/assets/fonts` and returns every embedded drawing-font
/// woff2 as the `/assets/...` URL path the Excalidraw runtime fetches it at.
fn embedded_font_routes() -> Vec<String> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("woff2") {
                    out.push(path);
                }
            }
        }
    }
    let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    let mut files = Vec::new();
    walk(&assets.join("fonts"), &mut files);
    files
        .iter()
        .map(|p| {
            // Build the URL with `/` separators regardless of host OS so the test
            // exercises the same browser-style path the Excalidraw runtime fetches
            // (`/assets/fonts/<Family>/<file>.woff2`) on Windows as on Unix.
            let rel = p.strip_prefix(&assets).unwrap();
            let url_path = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            format!("/assets/{url_path}")
        })
        .collect()
}

/// The embedded UI must serve its index, JS/CSS bundle, and — critically — the
/// hand-drawn font woff2 files. Missing fonts were the originally reported bug:
/// every runtime font fetch 404'd and exported SVGs referenced absent fonts. This
/// proves the rust-embed → `GET /assets/fonts/**` path resolves for the real
/// embedded assets, automating the "fonts resolve, no 404s" manual-checklist item.
#[test]
fn embedded_assets_serve_index_bundle_and_drawing_fonts() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();

    let preview = Preview::spawn(&file, &[]);

    // index.html at the root.
    let (status, index) = http_get(&preview.url("/"));
    assert_eq!(status, 200, "GET / must serve the embedded index.html");
    assert!(
        index.contains("EXCALIDRAW_ASSET_PATH"),
        "index.html must set the asset path before the module loads; got: {index}"
    );

    // Every JS/CSS bundle the index references must resolve.
    for asset in index
        .match_indices("/assets/assets/")
        .filter_map(|(i, _)| index[i..].split(['"', '\'']).next())
    {
        let (status, body) = http_get(&preview.url(asset));
        assert_eq!(status, 200, "bundle asset {asset} must serve (got {status})");
        assert!(!body.is_empty(), "bundle asset {asset} was empty");
    }

    // The drawing fonts must be present and served — the regression that
    // motivated this whole pass. Sample one woff2 per family so a single missing
    // family is caught without fetching all 234 files over HTTP.
    let routes = embedded_font_routes();
    assert!(
        routes.len() >= 9,
        "expected the copied font families' woff2 files to be embedded, found {} files",
        routes.len()
    );
    let mut families_checked = std::collections::HashSet::new();
    for route in &routes {
        // /assets/fonts/<Family>/<file>.woff2 → key on <Family>, one probe each.
        let family = route.split('/').nth(3).unwrap_or("").to_string();
        if !families_checked.insert(family) {
            continue;
        }
        let resp = reqwest::blocking::Client::new()
            .get(preview.url(route))
            .timeout(Duration::from_secs(3))
            .send()
            .expect("font request failed");
        assert_eq!(resp.status().as_u16(), 200, "font {route} must serve, not 404");
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = resp.bytes().expect("font body");
        assert!(!bytes.is_empty(), "font {route} served an empty body");
        assert!(
            ct.contains("woff2") || ct.contains("octet-stream"),
            "font {route} served unexpected content-type {ct}"
        );
    }
    assert!(
        families_checked.len() >= 9,
        "expected ≥9 font families, checked {}",
        families_checked.len()
    );
}

/// End-to-end self-test of the native shell against a *real* WebView: runs the
/// binary in `--smoke` mode and asserts a clean (exit 0) report. This exercises
/// the OS-specific paths unit tests cannot — actual `wry` window creation, React
/// mount + asset/font fetch, `evaluate_script` delivery, the
/// `/native-action-result` round-trip, and the close-interception state machine.
///
/// `#[ignore]` because it opens a real window and so needs a display; CI/headless
/// runs skip it. Run it on a desktop with `just smoke` or
/// `cargo nextest run --run-ignored ignored-only smoke_self_test`.
#[test]
#[ignore = "opens a real WebView window; needs a display. Run via `just smoke`."]
fn smoke_self_test_reports_all_checks_passing() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("smoke.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let lock = lock_path_for(&std::fs::canonicalize(&file).unwrap());
    let _ = std::fs::remove_file(&lock);

    let status = std::process::Command::new(binary())
        .arg(&file)
        .arg("--smoke")
        .status()
        .expect("failed to spawn --smoke");
    let _ = std::fs::remove_file(&lock);

    assert!(
        status.success(),
        "--smoke reported a failing check (exit {:?})",
        status.code()
    );
}
