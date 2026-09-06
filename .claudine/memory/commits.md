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

---

## `git commit -- path1 path2 dir/` accepts directories, not just files

- When committing a whole newly-added asset tree (e.g. 234 woff2 fonts under
  `preview-binary/assets/fonts/`), pass the directory path on the command line
  *with a trailing slash* and git will include every staged file under it —
  no need to enumerate hundreds of paths.
- Example from a 2026-06-13 commit: `git commit --only -F - -- preview-binary/assets/index.html preview-binary/assets/fonts/`
  commits 235 files (1 modified `index.html` + 234 staged woff2 fonts) in one
  call, scoped exactly to the assignment.
- This is race-free in the same way pathspecs are: it commits *only* what's
  staged under the listed paths, never anything else.
- Crucial: do **not** add a bare `.` or `--all` — that would scoop up other
  in-flight staged files from sibling subagents. Keep the pathspec explicit.
- For very small sets (≤ ~5 files), listing the files explicitly is still
  preferred because the resulting `git show --stat` is more readable and
  reviews can quickly eyeball the inclusion set.

---

## In a single-quoted heredoc, do NOT backslash-escape `$` or backticks

- The `'COMMIT_MSG'` delimiter being single-quoted **already** disables all
  shell expansion — command substitution, parameter expansion, everything.
- Adding defensive backslashes anyway (`\$schema`, `` \`- [ ]\` ``) does not
  get stripped: the backslashes are written **literally** into the commit
  message body. Observed on a 2026-09-05 commit: bullets read `\$schema` and
  `` \`- [ ]\` `` instead of `$schema` and `` `- [ ]` ``.
- Rule: inside the heredoc body, type the message exactly as it should appear
  — plain `$`, plain backticks, no escapes. The quoting of the *delimiter*
  is the only protection needed.
- If the mangled commit is not HEAD, prefer leaving it (message is cosmetic)
  over rewriting history in a worktree where other agents/devs are active.
