# Commit Lessons Learned

Permanent memory of non-obvious things future commits in this repo should know
about. Add a new entry below for each new lesson; keep entries short and
self-contained.

---

## Lock-path helpers are hand-duplicated and must stay in sync

- `preview-binary/src/main.rs::get_lock_path` (binary) and
  `preview-binary/tests/integration.rs::lock_path_for` (tests) are
  **intentionally** two copies of the same algorithm. The test process
  re-implements the hash so it can compute the same
  `$TMPDIR/excalidraw-{sha256}.lock` filename the binary writes.
- Any change to lock-path formatting on the binary side **MUST** be mirrored
  in the test helper in the same commit. If they drift, the dedup
  integration tests silently stop finding the lock file (no panic, no
  clear error — the test just hangs or asserts on a different path).
- Concrete example: the sha2 0.10 -> 0.11 bump required changing
  `format!("{:x}", hasher.finalize())` to a per-byte `format!("{:02x}", b)`
  iterator in **both** functions.
