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

---

## Don't read your own SHA from `HEAD` after a parallel-subagent commit

- The commit orchestrator dispatches subagents in **parallel** against the
  same worktree. Between the moment your `git commit` returns and the
  moment you re-read the branch with `git log -1` (or `git rev-parse HEAD`),
  another subagent's commit can land on top.
- Symptom: `git log -1` shows a *different* author's commit at HEAD right
  after your commit. Easy to misread as "my commit failed" or "I committed
  to the wrong branch."
- Fix: capture your own commit SHA **from the commit-tool's output** (e.g.
  the line `1 file changed, N insertions(+), N deletions(-)` is followed
  by `[branch SHA] message` in `git commit`'s stdout when `-v`/`--status`
  is off, or just have the subagent run `git rev-parse HEAD` *before*
  returning and echo the SHA it got back). Compare against that captured
  value, not against a subsequent `HEAD` read.
- Also: if you must verify with `git log`, pass an explicit ref like
  `git log -1 --format=%H <branch>` immediately after the commit, *before*
  the next subagent lands — but the captured-from-output approach is
  race-free.
