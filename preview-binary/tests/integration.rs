//! Integration tests: spawn the real binary headless against temp files.
//! Each test runs in its own process under nextest, so env/port state is isolated.

use sha2::{Digest, Sha256};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const BLANK_SCENE: &str =
    r#"{"type":"excalidraw","version":2,"source":"test","elements":[],"appState":{},"files":{}}"#;

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
            assert!(
                Instant::now() < deadline,
                "lock file never appeared at {}",
                lock.display()
            );
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

/// GETs `/data` and returns `(status, ETag header, body)`.
fn http_get_data(url: &str) -> (u16, Option<String>, String) {
    let resp = reqwest::blocking::Client::new()
        .get(url)
        .timeout(Duration::from_secs(3))
        .send()
        .expect("GET /data failed");
    let status = resp.status().as_u16();
    let etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = resp.text().unwrap_or_default();
    (status, etag, body)
}

/// The strong ETag the server publishes for these exact bytes
/// (`"sha256-<hex>"`), mirroring `content_revision` in main.rs.
fn etag_for(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    format!("\"sha256-{hex}\"")
}

/// Subscribes to the `/events` SSE stream and returns a channel receiving
/// every non-empty line. `send()` returning proves the server-side
/// `broadcast_tx.subscribe()` has already run (it happens in the handler
/// before the response starts), so events broadcast after this call cannot
/// be missed.
fn subscribe_events(url: &str) -> std::sync::mpsc::Receiver<String> {
    let resp = reqwest::blocking::Client::new()
        .get(url.to_string())
        .timeout(Duration::from_secs(60))
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
    line_rx
}

/// Waits for the next SSE line containing `needle`, with a bounded deadline
/// (never a bare sleep).
fn expect_sse(lines: &std::sync::mpsc::Receiver<String>, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::ZERO);
        let line = lines
            .recv_timeout(remaining.max(Duration::from_millis(1)))
            .unwrap_or_else(|e| {
                panic!("no SSE line within deadline while waiting for {needle:?}: {e}")
            });
        if line.contains(needle) {
            return line;
        }
    }
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
    assert!(
        body.contains(r#""contentType":"application/json""#),
        "config was: {body}"
    );

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
fn sse_fires_when_file_is_atomically_replaced_by_rename() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();

    let preview = Preview::spawn(&file, &[]);
    let (status, _) = http_get(&preview.url("/ping"));
    assert_eq!(status, 200);

    let lines = subscribe_events(&preview.url("/events"));

    // Atomic replacement — how editors and git save: write a sibling temp
    // file, then rename it over the target. A watch registered on the file
    // itself follows the *old* inode and never sees the new bytes.
    let tmp = dir.path().join("test.excalidraw.tmp");
    std::fs::write(&tmp, BLANK_SCENE.replace("test", "renamed-over")).unwrap();
    std::fs::rename(&tmp, &file).unwrap();

    let line = expect_sse(&lines, "reload");
    assert!(line.contains("reload"), "unexpected SSE line: {line}");

    // The replaced bytes must be what the client converges on.
    let (status, etag, body) = http_get_data(&preview.url("/data"));
    assert_eq!(status, 200);
    assert_eq!(body, BLANK_SCENE.replace("test", "renamed-over"));
    assert_eq!(etag.as_deref(), Some(etag_for(body.as_bytes()).as_str()));
}

#[test]
fn rapid_writes_converge_on_final_version_with_trailing_reload() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    let v1 = BLANK_SCENE.replace("test", "v1");
    std::fs::write(&file, &v1).unwrap();

    let preview = Preview::spawn(&file, &[]);
    let lines = subscribe_events(&preview.url("/events"));

    // First change: establishes the baseline reload event.
    std::fs::write(&file, &v1).unwrap();
    let first = expect_sse(&lines, "reload");
    assert!(first.contains("reload"), "unexpected SSE line: {first}");
    let (status, etag, body) = http_get_data(&preview.url("/data"));
    assert_eq!((status, body.as_str()), (200, v1.as_str()));
    assert_eq!(etag.as_deref(), Some(etag_for(v1.as_bytes()).as_str()));

    // Immediately burst two more writes, both landing well inside the 80 ms
    // debounce window of the first reload. A leading-edge throttle drops the
    // trailing events and never re-fires; only trailing reconciliation
    // guarantees the *final* version its own reload.
    let v2 = BLANK_SCENE.replace("test", "v2");
    let v3 = BLANK_SCENE.replace("test", "v3");
    std::fs::write(&file, &v2).unwrap();
    std::fs::write(&file, &v3).unwrap();

    let second = expect_sse(&lines, "reload");
    assert!(second.contains("reload"), "unexpected SSE line: {second}");

    // The client-visible revision converges on the final bytes (bounded poll
    // of the published ETag — no fixed sleep anywhere in the assertion).
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (status, etag, body) = http_get_data(&preview.url("/data"));
        if status == 200 && body == v3 && etag.as_deref() == Some(etag_for(v3.as_bytes()).as_str())
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "revision never converged on the final bytes; last saw status={status} etag={etag:?} body={body}"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn delete_then_recreate_yields_reload_for_each_transition() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();

    let preview = Preview::spawn(&file, &[]);
    let lines = subscribe_events(&preview.url("/events"));

    // Deletion is a change like any other: a reload must be broadcast (the
    // client then sees 404 from GET /data — deletion is not an empty drawing).
    std::fs::remove_file(&file).unwrap();
    let deleted = expect_sse(&lines, "reload");
    assert!(deleted.contains("reload"), "unexpected SSE line: {deleted}");
    let (status, etag, _) = http_get_data(&preview.url("/data"));
    assert_eq!(status, 404, "deleted file must read as unavailable");
    assert_eq!(etag.as_deref(), Some("\"absent\""));

    // Recreation with different bytes: another reload, then a 200 publishing
    // the new revision. The server must never auto-recreate on its own.
    let recreated = BLANK_SCENE.replace("test", "recreated");
    std::fs::write(&file, &recreated).unwrap();
    let recreated_line = expect_sse(&lines, "reload");
    assert!(
        recreated_line.contains("reload"),
        "unexpected SSE line: {recreated_line}"
    );
    let (status, etag, body) = http_get_data(&preview.url("/data"));
    assert_eq!(status, 200);
    assert_eq!(body, recreated);
    assert_eq!(
        etag.as_deref(),
        Some(etag_for(recreated.as_bytes()).as_str()),
        "recreated file must publish a fresh revision"
    );
}

#[test]
fn viewer_write_is_not_echoed_as_reload_but_external_write_is() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();

    let preview = Preview::spawn(&file, &[]);
    let lines = subscribe_events(&preview.url("/events"));

    // A save through the viewer's own write API (conditional POST /data).
    let (status, etag, _) = http_get_data(&preview.url("/data"));
    assert_eq!(status, 200);
    let saved = BLANK_SCENE.replace("test", "viewer-save");
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(preview.url("/data"))
        .header("Content-Type", "application/json")
        .header("If-Match", etag.as_deref().expect("baseline revision"))
        .body(saved.clone())
        .timeout(Duration::from_secs(3))
        .send()
        .expect("POST /data failed");
    assert_eq!(resp.status().as_u16(), 200);

    // Echo suppression: our own write must NOT be broadcast back as a reload.
    // A buggy echo would surface within the quiet window plus the forced
    // max-wait horizon (≤ ~600 ms after the write); wait well past it. This
    // negative wait is the bounded check itself, not a sleep before an
    // assertion.
    let echo = lines.recv_timeout(Duration::from_millis(1500));
    assert!(
        echo.is_err(),
        "viewer save was echoed as an SSE event: {echo:?}"
    );

    // Positive control on the same file: an external write DOES reload.
    std::fs::write(&file, BLANK_SCENE.replace("test", "external")).unwrap();
    let external = expect_sse(&lines, "reload");
    assert!(
        external.contains("reload"),
        "unexpected SSE line: {external}"
    );
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
        assert!(
            Instant::now() < deadline,
            "daemonized child never wrote lock file"
        );
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
    assert_eq!(
        std::fs::read(&written).unwrap(),
        vec![0x89u8, 0x50, 0x4E, 0x47]
    );
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

    let client = reqwest::blocking::Client::new();

    // Read the current revision from the running server.
    let get = client
        .get(preview.url("/data"))
        .timeout(Duration::from_secs(3))
        .send()
        .expect("GET /data failed");
    assert_eq!(get.status().as_u16(), 200);
    let etag = get
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .expect("GET /data must publish an ETag")
        .to_string();
    assert!(etag.starts_with("\"sha256-"), "unexpected revision: {etag}");

    // A save without If-Match is refused outright and disk is untouched.
    let refused = client
        .post(preview.url("/data"))
        .header("Content-Type", "application/json")
        .body(updated.clone())
        .timeout(Duration::from_secs(3))
        .send()
        .expect("POST /data failed");
    assert_eq!(refused.status().as_u16(), 428);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), BLANK_SCENE);

    // The conditional save with the fresh revision succeeds.
    let resp = client
        .post(preview.url("/data"))
        .header("Content-Type", "application/json")
        .header("If-Match", &etag)
        .body(updated.clone())
        .timeout(Duration::from_secs(3))
        .send()
        .expect("POST /data failed");
    assert_eq!(resp.status().as_u16(), 200);
    let new_etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .expect("POST /data must return the written revision");
    assert_ne!(new_etag, etag);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), updated);

    // The old revision is now stale: a replayed save must be refused (412)
    // rather than silently overwriting the newer disk version.
    let stale = client
        .post(preview.url("/data"))
        .header("Content-Type", "application/json")
        .header("If-Match", &etag)
        .body(BLANK_SCENE)
        .timeout(Duration::from_secs(3))
        .send()
        .expect("POST /data failed");
    assert_eq!(stale.status().as_u16(), 412);
    assert_eq!(
        stale.headers().get("etag").and_then(|v| v.to_str().ok()),
        Some(new_etag),
        "412 must name the revision the client is racing"
    );
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
    assert_eq!(
        unique,
        ports.len(),
        "previews must bind distinct ports: {ports:?}"
    );

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
    assert_eq!(
        lock_port, first_port,
        "second instance must not steal the lock"
    );

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
    assert!(
        (400..500).contains(&status),
        "malformed /dirty body should be a 4xx, got {status}"
    );
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
    assert_eq!(
        status, 200,
        "valid /native-action-result payload should be accepted"
    );

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
        stdout
            .read_line(&mut line)
            .expect("LSP server closed stdout early");
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
    assert!(
        sync.is_object(),
        "textDocumentSync should be the object form, got: {sync}"
    );
    assert_eq!(sync["openClose"], serde_json::Value::Bool(true));
    assert_eq!(sync["save"], serde_json::Value::Bool(true));

    // serverInfo must reflect the crate version, not a hardcoded string.
    let server_info = &json["result"]["serverInfo"];
    assert_eq!(
        server_info["name"],
        serde_json::Value::String("excalidraw-preview".to_string())
    );
    assert_eq!(
        server_info["version"],
        serde_json::Value::String(env!("CARGO_PKG_VERSION").to_string()),
        "serverInfo.version must match CARGO_PKG_VERSION"
    );

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
        stdout
            .read_line(&mut line)
            .expect("LSP server closed stdout early");
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
    lsp_write(
        &mut stdin,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
    );
    let _ = lsp_read(&mut stdout);

    // Build the URI the way a real LSP client (Zed) does: a platform-correct,
    // percent-encoded file:// URI. `format!("file://{path}")` only happens to be
    // valid on POSIX — on Windows it yields `file://C:\…`, which never decodes
    // back to a path, so the spawn never fires.
    let uri = url::Url::from_file_path(&canonical).unwrap().to_string();
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
    let lock_port: u16 = std::fs::read_to_string(&lock)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(
        lock_port, port,
        "second didSave must not respawn on a new port"
    );
    let (status, _) = http_get(&format!("http://127.0.0.1:{port}/ping"));
    assert_eq!(
        status, 200,
        "live preview must still be serving after the second didSave"
    );

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

/// Drives the `--lsp` server through `textDocument/didOpen` then `didClose`: the
/// preview must keep serving after `didClose`. Zed reuses one "preview tab" and
/// sends `didClose` whenever you browse to another file, so tearing the window
/// down on `didClose` made previews flicker shut while navigating. The window now
/// owns its own lifecycle, so `didClose` is a no-op.
#[test]
fn lsp_did_close_keeps_preview_alive() {
    use std::io::{BufReader, Write};

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("persist.excalidraw");
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

    lsp_write(
        &mut stdin,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
    );
    let _ = lsp_read(&mut stdout);

    // Platform-correct file:// URI (see lsp_did_save for why format! is wrong).
    let uri = url::Url::from_file_path(&canonical).unwrap().to_string();
    let did_open = format!(
        r#"{{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{{"textDocument":{{"uri":"{uri}","languageId":"excalidraw","version":1,"text":""}}}}}}"#
    );
    let did_close = format!(
        r#"{{"jsonrpc":"2.0","method":"textDocument/didClose","params":{{"textDocument":{{"uri":"{uri}"}}}}}}"#
    );

    // didOpen → preview spawns. Wait for its lock/port.
    lsp_write(&mut stdin, &did_open);
    let deadline = Instant::now() + Duration::from_secs(10);
    let port = loop {
        if let Ok(s) = std::fs::read_to_string(&lock) {
            if let Ok(p) = s.trim().parse::<u16>() {
                break p;
            }
        }
        assert!(
            Instant::now() < deadline,
            "didOpen never spawned a preview (no lock file at {})",
            lock.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let (status, _) = http_get(&format!("http://127.0.0.1:{port}/ping"));
    assert_eq!(status, 200, "spawned preview not serving");

    // didClose must NOT tear the preview down: it keeps serving on the same port.
    lsp_write(&mut stdin, &did_close);
    std::thread::sleep(Duration::from_millis(500));
    let (status, body) = http_get(&format!("http://127.0.0.1:{port}/ping"));
    assert_eq!(
        status, 200,
        "preview must survive didClose (persist until window close)"
    );
    assert_eq!(body, "OK");
    assert!(lock.exists(), "lock file must remain after didClose");

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

/// Drives the `--lsp` server through a preview's whole life and reads its
/// **stderr**: opening the file, the window coming up, and the window going away
/// must each produce a log line. Zed files a language server's stderr under that
/// server's "Server Logs", so this is the end-to-end proof that the lifecycle is
/// visible from inside the editor — asserting on the tracker's state machine
/// alone would not catch the sink being wired to stdout, silenced, or never
/// installed.
#[test]
fn lsp_logs_preview_lifecycle_to_stderr() {
    use std::io::{BufRead, BufReader, Write};

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("lifecycle.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let canonical = std::fs::canonicalize(&file).unwrap();
    let lock = lock_path_for(&canonical);
    let _ = std::fs::remove_file(&lock);

    let mut child = std::process::Command::new(binary())
        .arg("--lsp")
        .env("EXCALIDRAW_PREVIEW_HEADLESS", "true")
        // Pin the level: a RUST_LOG inherited from the developer's shell would
        // otherwise decide whether these lines exist at all.
        .env("RUST_LOG", "excalidraw_preview=info")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("failed to spawn --lsp");

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    // Drain stderr on its own thread: a full pipe buffer would otherwise wedge
    // the server mid-notification.
    let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let collector = std::sync::Arc::clone(&log);
    let stderr = child.stderr.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            collector.lock().unwrap().push(line);
        }
    });

    lsp_write(
        &mut stdin,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
    );
    let _ = lsp_read(&mut stdout);

    let uri = file_uri(&canonical);
    let did_open = format!(
        r#"{{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{{"textDocument":{{"uri":"{uri}","languageId":"excalidraw","version":1,"text":""}}}}}}"#
    );
    lsp_write(&mut stdin, &did_open);

    let port = wait_for_lock_port(&lock);
    wait_for_log_line(&log, "editor opened");
    wait_for_log_line(&log, "preview window opened");
    assert!(
        wait_for_log_line(&log, "lifecycle.excalidraw").contains("lifecycle.excalidraw"),
        "log lines must name the file they are about"
    );

    // Close the window the way the user would (the preview removes its lock on
    // every exit path) and require the tracker to notice.
    let _ = http_get(&format!("http://127.0.0.1:{port}/shutdown"));
    wait_for_lock_removed(&lock);
    wait_for_log_line(&log, "preview window closed");

    let _ = std::fs::remove_file(&lock);
    let exit = r#"{"jsonrpc":"2.0","method":"exit"}"#;
    let _ = write!(stdin, "Content-Length: {}\r\n\r\n{}", exit.len(), exit);
    let _ = stdin.flush();
    drop(stdin);
    let _ = child.wait();
}

/// Waits (bounded) for a collected stderr line containing `needle` and returns
/// it, failing with the whole log if it never arrives.
fn wait_for_log_line(log: &std::sync::Mutex<Vec<String>>, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(line) = log
            .lock()
            .unwrap()
            .iter()
            .find(|line| line.contains(needle))
        {
            return line.clone();
        }
        assert!(
            Instant::now() < deadline,
            "no log line containing {needle:?}; got:\n{}",
            log.lock().unwrap().join("\n")
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ── LSP didClose attention-signal harness (Phase 5) ──────────────────────────

/// A driven `--lsp` child: framed JSON-RPC over piped stdio. Spawned with
/// `EXCALIDRAW_PREVIEW_HEADLESS=true` so every preview it spawns comes up
/// windowless and can be probed over HTTP.
struct Lsp {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: std::io::BufReader<std::process::ChildStdout>,
    next_id: u64,
}

impl Lsp {
    /// Spawns the server and completes the `initialize` handshake.
    fn spawn() -> Self {
        let mut child = std::process::Command::new(binary())
            .arg("--lsp")
            .env("EXCALIDRAW_PREVIEW_HEADLESS", "true")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("failed to spawn --lsp");
        let stdin = child.stdin.take().unwrap();
        let stdout = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut lsp = Self {
            child,
            stdin,
            stdout,
            next_id: 1,
        };
        let response = lsp.request("initialize", "{}");
        assert!(
            response["result"]["capabilities"]["textDocumentSync"].is_object(),
            "initialize handshake failed: {response}"
        );
        lsp
    }

    /// Sends a request and returns the parsed response.
    fn request(&mut self, method: &str, params: &str) -> serde_json::Value {
        let id = self.next_id;
        self.next_id += 1;
        let msg = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{params}}}"#);
        lsp_write(&mut self.stdin, &msg);
        lsp_read(&mut self.stdout)
    }

    /// Sends a notification (no response is expected).
    fn notify(&mut self, method: &str, params: &str) {
        let msg = format!(r#"{{"jsonrpc":"2.0","method":"{method}","params":{params}}}"#);
        lsp_write(&mut self.stdin, &msg);
    }

    /// Sends a `textDocument/*` notification carrying only a document URI.
    fn notify_document(&mut self, method: &str, uri: &str) {
        self.notify(method, &format!(r#"{{"textDocument":{{"uri":"{uri}"}}}}"#));
    }

    /// Proves the stdio dispatch loop is still alive: an unknown *request*
    /// must get a `-32601` response, not silence.
    fn assert_responsive(&mut self) {
        let response = self.request("workspace/executeCommand", "{}");
        assert_eq!(
            response["error"]["code"],
            serde_json::json!(-32601),
            "LSP dispatch loop must still answer requests, got: {response}"
        );
    }
}

impl Drop for Lsp {
    fn drop(&mut self) {
        use std::io::Write as _;
        // Graceful exit first, kill as a backstop so a wedged server can never
        // hang the test binary; either way the child is reaped.
        let exit = r#"{"jsonrpc":"2.0","method":"exit"}"#;
        let _ = write!(self.stdin, "Content-Length: {}\r\n\r\n{}", exit.len(), exit);
        let _ = self.stdin.flush();
        std::thread::sleep(Duration::from_millis(50));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Platform-correct, percent-encoded `file://` URI — the shape a real LSP
/// client (Zed) sends. `format!("file://{path}")` is only valid on POSIX.
fn file_uri(path: &Path) -> String {
    url::Url::from_file_path(path).unwrap().to_string()
}

/// Polls a preview lock file until it contains a parseable port (bounded).
fn wait_for_lock_port(lock: &Path) -> u16 {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(s) = std::fs::read_to_string(lock) {
            if let Ok(p) = s.trim().parse::<u16>() {
                return p;
            }
        }
        assert!(
            Instant::now() < deadline,
            "no preview lock appeared at {}",
            lock.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Polls until a preview lock file has been removed (bounded).
fn wait_for_lock_removed(lock: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while lock.exists() {
        assert!(
            Instant::now() < deadline,
            "lock file {} was never removed",
            lock.display()
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Gracefully shuts down an LSP-spawned (detached) preview instance and clears
/// its lock. Tests own this teardown — killing the LSP never touches previews.
/// Waits until the server is verifiably gone (lock removed *and* the port stops
/// answering) so no half-exited child outlives the test.
fn shut_down_preview(port: u16, lock: &Path) {
    let _ = http_get(&format!("http://127.0.0.1:{port}/shutdown"));
    wait_for_lock_removed(lock);
    let _ = std::fs::remove_file(lock);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let refused = reqwest::blocking::Client::new()
            .get(format!("http://127.0.0.1:{port}/ping"))
            .timeout(Duration::from_millis(300))
            .send()
            .is_err();
        if refused {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "preview on port {port} never stopped serving after /shutdown"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// A port that is (almost certainly) served by nothing: bind an ephemeral
/// listener, note its port, then drop it.
fn dead_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

/// Binds a TCP listener that accepts connections but never reads or responds.
/// Connections are parked forever, so any HTTP client blocks until its own
/// timeout. Returns the port and a counter of accepted connections.
fn slow_endpoint() -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = accepted.clone();
    std::thread::spawn(move || {
        let mut parked: Vec<std::net::TcpStream> = Vec::new();
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    parked.push(s); // hold the socket open; never respond
                }
                Err(_) => break,
            }
        }
    });
    (port, accepted)
}

/// Case 1: `didOpen` for each of the three guarded suffixes spawns exactly one
/// preview per file — lock file present, `/ping` serving, and a repeated
/// `didOpen` neither respawns nor disturbs the live instance.
#[test]
fn lsp_did_open_spawns_one_instance_per_guarded_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let files = [
        dir.path().join("bare.excalidraw"),
        dir.path().join("vector.excalidraw.svg"),
        dir.path().join("raster.excalidraw.png"),
    ];
    for f in &files {
        std::fs::write(f, BLANK_SCENE).unwrap();
    }
    let locks: Vec<PathBuf> = files
        .iter()
        .map(|f| lock_path_for(&std::fs::canonicalize(f).unwrap()))
        .collect();
    for l in &locks {
        let _ = std::fs::remove_file(l);
    }

    let mut lsp = Lsp::spawn();
    let mut ports = Vec::new();
    for (i, f) in files.iter().enumerate() {
        lsp.notify_document("textDocument/didOpen", &file_uri(f));
        let port = wait_for_lock_port(&locks[i]);
        let (status, body) = http_get(&format!("http://127.0.0.1:{port}/ping"));
        assert_eq!(
            (status, body.as_str()),
            (200, "OK"),
            "preview for {} never served /ping",
            files[i].display()
        );
        ports.push(port);
    }

    // Exactly one instance per file: a second didOpen finds the live lock,
    // focuses it, and exits — the lock keeps pointing at the same serving port.
    lsp.notify_document("textDocument/didOpen", &file_uri(&files[0]));
    std::thread::sleep(Duration::from_millis(500));
    let lock_port: u16 = std::fs::read_to_string(&locks[0])
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(
        lock_port, ports[0],
        "repeated didOpen must not respawn on a new port"
    );
    let (status, _) = http_get(&format!("http://127.0.0.1:{}/ping", ports[0]));
    assert_eq!(status, 200, "the single live instance must keep serving");

    for (port, lock) in ports.iter().zip(&locks) {
        shut_down_preview(*port, lock);
    }
}

/// Case 2: `didSave` while a preview is live must not spawn a second instance.
/// (Full coverage in `lsp_did_save_spawns_preview_then_reuses_live_instance`
/// above; repeated here through the shared harness for the Phase 5 matrix.)
#[test]
fn lsp_did_save_while_live_spawns_no_second_instance() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("live.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let lock = lock_path_for(&std::fs::canonicalize(&file).unwrap());
    let _ = std::fs::remove_file(&lock);

    let mut lsp = Lsp::spawn();
    lsp.notify_document("textDocument/didOpen", &file_uri(&file));
    let port = wait_for_lock_port(&lock);

    lsp.notify_document("textDocument/didSave", &file_uri(&file));
    std::thread::sleep(Duration::from_millis(500));
    let lock_port: u16 = std::fs::read_to_string(&lock)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(lock_port, port, "didSave while live must not respawn");
    let (status, _) = http_get(&format!("http://127.0.0.1:{port}/ping"));
    assert_eq!(status, 200, "live preview must keep serving after didSave");

    shut_down_preview(port, &lock);
}

/// Case 3: after the preview is closed (`GET /shutdown`), a `didSave` reopens
/// it — the lock file reappears and a serving instance answers `/ping`.
#[test]
fn lsp_did_save_reopens_preview_after_window_close() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("reopen.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let canonical = std::fs::canonicalize(&file).unwrap();
    let lock = lock_path_for(&canonical);
    let _ = std::fs::remove_file(&lock);

    let mut lsp = Lsp::spawn();
    lsp.notify_document("textDocument/didOpen", &file_uri(&file));
    let first_port = wait_for_lock_port(&lock);

    // Close the preview the way its window does: graceful shutdown + lock
    // cleanup. Wait until the old instance is verifiably gone.
    let _ = http_get(&format!("http://127.0.0.1:{first_port}/shutdown"));
    wait_for_lock_removed(&lock);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let refused = reqwest::blocking::Client::new()
            .get(format!("http://127.0.0.1:{first_port}/ping"))
            .timeout(Duration::from_millis(300))
            .send()
            .is_err();
        if refused {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "shut-down preview on port {first_port} is still serving"
        );
        std::thread::sleep(Duration::from_millis(25));
    }

    // didSave with nothing live → the preview reopens.
    lsp.notify_document("textDocument/didSave", &file_uri(&file));
    let second_port = wait_for_lock_port(&lock);
    let (status, body) = http_get(&format!("http://127.0.0.1:{second_port}/ping"));
    assert_eq!((status, body.as_str()), (200, "OK"));

    shut_down_preview(second_port, &lock);
}

/// Case 4: `didChange` never spawns — typing in Zed must not resurrect or
/// open a viewer. (The `didChange` arm is deliberately unhandled.)
#[test]
fn lsp_did_change_never_spawns_a_preview() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("typing.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let lock = lock_path_for(&std::fs::canonicalize(&file).unwrap());
    let _ = std::fs::remove_file(&lock);

    let mut lsp = Lsp::spawn();

    // A full-text sync change with real content, then an empty change list.
    let params = serde_json::json!({
        "textDocument": {"uri": file_uri(&file), "version": 2},
        "contentChanges": [{"text": BLANK_SCENE}]
    })
    .to_string();
    lsp.notify("textDocument/didChange", &params);
    lsp.notify(
        "textDocument/didChange",
        &format!(
            r#"{{"textDocument":{{"uri":"{}","version":3}},"contentChanges":[]}}"#,
            file_uri(&file)
        ),
    );

    // Bounded negative wait: no lock may ever appear (spawns write it within
    // ~300 ms when they do happen; well under this window).
    std::thread::sleep(Duration::from_millis(750));
    assert!(
        !lock.exists(),
        "didChange must never spawn a preview (lock appeared at {})",
        lock.display()
    );
    lsp.assert_responsive();
}

/// Case 5: `didClose` forwards an attention signal to the live preview.
/// Subscribing to `/events` *before* the close, the SSE stream must deliver an
/// `editor-closed` frame, and the preview must still be alive afterwards — the
/// signal never tears anything down.
#[test]
fn lsp_did_close_forwards_editor_closed_to_live_preview() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("forward.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let canonical = std::fs::canonicalize(&file).unwrap();
    let lock = lock_path_for(&canonical);
    let _ = std::fs::remove_file(&lock);

    let mut lsp = Lsp::spawn();
    lsp.notify_document("textDocument/didOpen", &file_uri(&file));
    let port = wait_for_lock_port(&lock);

    // Subscribe BEFORE the close so the broadcast cannot be missed.
    let lines = subscribe_events(&format!("http://127.0.0.1:{port}/events"));
    lsp.notify_document("textDocument/didClose", &file_uri(&file));

    let frame = expect_sse(&lines, "editor-closed");
    assert_eq!(
        frame, "data: editor-closed",
        "didClose must surface as exactly one editor-closed SSE frame"
    );

    // No spurious duplicate frames for one close.
    assert!(
        lines.recv_timeout(Duration::from_millis(400)).is_err(),
        "spurious duplicate editor-closed frames must not arrive for one close"
    );

    // Sequential closes each produce a frame (not deduplicated).
    lsp.notify_document("textDocument/didClose", &file_uri(&file));
    let second_frame = expect_sse(&lines, "editor-closed");
    assert_eq!(
        second_frame, "data: editor-closed",
        "sequential didClose must each produce a frame"
    );

    // The preview survives both signals.
    let (status, body) = http_get(&format!("http://127.0.0.1:{port}/ping"));
    assert_eq!((status, body.as_str()), (200, "OK"));
    assert!(lock.exists(), "lock file must survive didClose");

    // And the LSP dispatch loop is unharmed.
    lsp.assert_responsive();

    shut_down_preview(port, &lock);
}

/// Case 6: plain `.svg` files and malformed / non-`file:` URIs are no-ops —
/// no spawn, no forward, no crash; the dispatch loop keeps answering.
#[test]
fn lsp_ignores_plain_svg_and_malformed_uris() {
    let dir = tempfile::tempdir().unwrap();
    let plain = dir.path().join("plain.svg");
    std::fs::write(&plain, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").unwrap();
    let lock = lock_path_for(&std::fs::canonicalize(&plain).unwrap());
    let _ = std::fs::remove_file(&lock);

    let mut lsp = Lsp::spawn();

    // Plain .svg: the is_excalidraw_path guard must skip spawn and forward.
    lsp.notify_document("textDocument/didOpen", &file_uri(&plain));
    lsp.notify_document("textDocument/didClose", &file_uri(&plain));

    // Non-file schemes never decode to a filesystem path.
    lsp.notify_document(
        "textDocument/didOpen",
        "https://example.com/diagram.excalidraw",
    );
    lsp.notify_document(
        "textDocument/didClose",
        "https://example.com/diagram.excalidraw",
    );

    // Malformed URIs (not parseable as URLs at all).
    lsp.notify_document("textDocument/didOpen", "not a valid uri");
    lsp.notify_document("textDocument/didClose", "::%zz");

    // A file:// URI whose path does not exist: no preview instance can come
    // up for it (the spawned binary refuses a missing file before binding).
    lsp.notify_document(
        "textDocument/didClose",
        &file_uri(&dir.path().join("ghost.excalidraw")),
    );

    // Bounded negative wait: nothing above may have produced a preview.
    std::thread::sleep(Duration::from_millis(750));
    assert!(
        !lock.exists(),
        "plain .svg must never spawn a preview (lock appeared at {})",
        lock.display()
    );
    lsp.assert_responsive();
}

/// Case 7: a stale lock file pointing at a dead port makes `didClose` a
/// harmless no-op — the refused connection resolves fast, the lock is left
/// exactly as found, and the LSP keeps answering.
#[test]
fn lsp_did_close_with_stale_lock_is_harmless_noop() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("stale.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let canonical = std::fs::canonicalize(&file).unwrap();
    let lock = lock_path_for(&canonical);

    let dead = dead_port();
    std::fs::write(&lock, dead.to_string()).unwrap();

    let mut lsp = Lsp::spawn();
    lsp.notify_document("textDocument/didClose", &file_uri(&file));

    // The forward attempt (connection refused) resolves well inside this
    // window; afterwards the lock must be untouched.
    std::thread::sleep(Duration::from_millis(750));
    let still_there = std::fs::read_to_string(&lock).unwrap();
    assert_eq!(
        still_there.trim(),
        dead.to_string(),
        "the forwarder must never rewrite or remove a lock it does not own"
    );
    lsp.assert_responsive();

    let _ = std::fs::remove_file(&lock);
}

/// Case 8: with a deliberately slow `/editor-closed` endpoint wedged in front
/// of the forwarding worker, the LSP still answers `shutdown` promptly —
/// proving the HTTP never sits on the stdio dispatch path. If it did, the
/// response could not arrive before the ~500 ms forwarding timeout.
#[test]
fn lsp_shutdown_stays_prompt_behind_slow_forward_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("slow.excalidraw");
    std::fs::write(&file, BLANK_SCENE).unwrap();
    let canonical = std::fs::canonicalize(&file).unwrap();
    let lock = lock_path_for(&canonical);

    let (slow_port, accepted) = slow_endpoint();
    std::fs::write(&lock, slow_port.to_string()).unwrap();

    let mut lsp = Lsp::spawn();
    lsp.notify_document("textDocument/didClose", &file_uri(&file));

    // The forward really was attempted and is now wedged on the endpoint.
    let deadline = Instant::now() + Duration::from_secs(2);
    while accepted.load(std::sync::atomic::Ordering::SeqCst) == 0 {
        assert!(
            Instant::now() < deadline,
            "forwarder never contacted the slow endpoint"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    let started = Instant::now();
    let response = lsp.request("shutdown", "null");
    let elapsed = started.elapsed();
    assert_eq!(
        response["result"],
        serde_json::Value::Null,
        "shutdown must succeed: {response}"
    );
    assert!(
        elapsed < Duration::from_millis(400),
        "shutdown took {elapsed:?} — the in-flight forward blocked the dispatch path"
    );

    let _ = std::fs::remove_file(&lock);
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
        assert_eq!(
            status, 200,
            "bundle asset {asset} must serve (got {status})"
        );
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
        assert_eq!(
            resp.status().as_u16(),
            200,
            "font {route} must serve, not 404"
        );
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

// ── Build identity (`--version`) ─────────────────────────────────────────────

/// `--version` is the first step of every acceptance run and of the stale-PATH
/// triage (the extension prefers a PATH binary, so an old one is silently
/// preferred). It did not exist before this entry — the mandated identity
/// procedure could not run at all (fixes/2026-09-05-fix-me-up, finding N1).
/// Exercised through the real binary, the normal invocation path.
#[test]
fn version_flag_prints_the_crate_version_and_exits_zero() {
    let out = std::process::Command::new(binary())
        .arg("--version")
        .output()
        .expect("failed to spawn preview binary with --version");

    assert!(
        out.status.success(),
        "--version must exit 0, got {:?} (stderr: {})",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        stdout.trim(),
        format!("excalidraw-preview {}", env!("CARGO_PKG_VERSION")),
        "--version output is the value an acceptance run records and compares \
         against BINARY_VERSION"
    );
}

/// The acceptance guard compares `--version` against the extension's
/// `BINARY_VERSION` (the tag installed users download the binary from), so that
/// comparison is only meaningful while the two agree. `just bump` moves all four
/// version sites together; this fails the build if one is left behind. Kept on
/// this side of the workspace because this entry makes no `extension/` changes.
#[test]
fn version_flag_matches_the_extension_binary_version_constant() {
    let lib_rs = include_str!("../../extension/src/lib.rs");
    let declared = lib_rs
        .lines()
        .find_map(|l| l.trim().strip_prefix("const BINARY_VERSION: &str = "))
        .map(|rest| rest.trim().trim_end_matches(';').trim_matches('"'))
        .expect("extension/src/lib.rs must declare BINARY_VERSION");

    let out = std::process::Command::new(binary())
        .arg("--version")
        .output()
        .expect("failed to spawn preview binary with --version");
    let printed = String::from_utf8_lossy(&out.stdout);
    let printed = printed
        .trim()
        .strip_prefix("excalidraw-preview ")
        .expect("--version must print `excalidraw-preview X.Y.Z`");

    assert_eq!(
        printed, declared,
        "the binary reports {printed} but the extension downloads \
         v{declared} — use `just bump` to move every version site together, or \
         the acceptance build-identity check compares two unrelated numbers"
    );
}

/// `-V` is clap's short form; acceptance runs and scripts may use either.
#[test]
fn version_short_flag_matches_the_long_form() {
    let long = std::process::Command::new(binary())
        .arg("--version")
        .output()
        .expect("failed to spawn preview binary with --version");
    let short = std::process::Command::new(binary())
        .arg("-V")
        .output()
        .expect("failed to spawn preview binary with -V");

    assert!(short.status.success(), "-V must exit 0");
    assert_eq!(short.stdout, long.stdout);
}

/// A file argument must not be required for the identity check: the triage runs
/// `--version` with nothing else, and a binary that demanded a path (or opened
/// a window) would make the guard unusable.
#[test]
fn version_flag_needs_no_file_argument_and_opens_nothing() {
    let out = std::process::Command::new(binary())
        .arg("--version")
        .output()
        .expect("failed to spawn preview binary with --version");

    assert!(out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).is_empty(),
        "--version must not warn or error: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

// ── Read-only preview: a save gesture is never silent ────────────────────────

/// A scene-less SVG: the file the read-only preview path exists for (an image
/// exported without "Embed scene"), and the state in which no React app mounts.
const SCENE_LESS_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#eeeeee"/></svg>"##;

/// End-to-end over the real binary and the real embedded bundle: a read-only
/// image preview must serve a page that can *answer* a save gesture.
///
/// The native File → Save script (`SAVE_MENU_SCRIPT`) calls
/// `window.__excalidrawSaveUnavailable` whenever `__excalidrawSave` is absent,
/// which is always the case here — no scene means no editor. If the served
/// bundle did not register that global, menu Save would be the silent no-op of
/// spec §2.2 candidate 3 again (fixes/2026-09-05-fix-me-up, D2).
///
/// Skips when the build embedded no webview bundle (`assets/` is gitignored and
/// built by `just ui`; `just test` alone does not build it).
#[test]
fn readonly_image_preview_serves_a_page_that_can_answer_a_save_gesture() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("readonly.excalidraw.svg");
    std::fs::write(&file, SCENE_LESS_SVG).unwrap();

    let preview = Preview::spawn(&file, &[]);

    // The server classifies it as an image, and hands back bytes with no
    // embedded scene — the two facts that send the client down the read-only
    // branch (`main.tsx` renderReadonlyImage).
    let (status, config) = http_get(&preview.url("/config"));
    assert_eq!(status, 200);
    assert!(
        config.contains(r#""contentType":"image/svg+xml""#),
        "config was: {config}"
    );
    let (status, body) = http_get(&preview.url("/data"));
    assert_eq!(status, 200);
    assert_eq!(body, SCENE_LESS_SVG);
    assert!(
        !body.contains("excalidraw"),
        "fixture must carry no embedded scene"
    );

    let (status, index) = http_get(&preview.url("/"));
    if status == 404 {
        eprintln!("skipping: no webview bundle embedded in this build (run `just ui`)");
        return;
    }
    assert_eq!(status, 200);

    // Follow the page's own module script, exactly as the WebView would.
    let script = index
        .split("src=\"")
        .find(|s| s.starts_with("/assets/") && s.contains(".js"))
        .and_then(|s| s.split('"').next())
        .unwrap_or_else(|| panic!("no module script in served index.html: {index}"));
    let (status, bundle) = http_get(&preview.url(script));
    assert_eq!(status, 200, "module script {script} must be served");
    assert!(
        bundle.contains("__excalidrawSaveUnavailable"),
        "the served bundle ({script}) registers no save fallback, so a native \
         Save in this read-only preview would be silent"
    );
}
