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
