# Zed compound-suffix `didOpen` bug — sanitized repro & evidence

Evidence backing spec findings 3/4 (`fixes/2026-09-05-lsp-strategy/spec.md` §1).
Paths are scrubbed (`<WORKTREE>` = the git worktree root; usernames and absolute
home paths removed). Captured 2026-09-05 17:03–17:48 PDT via an interposed logging
wrapper. This file is the durable copy — the raw logs and the wrapper were deleted
after extraction (see `decision-log.md` D4).

## Environment

| Item | Value |
|---|---|
| Zed | `1.18.0+stable.351` |
| Zed commit | `49448afcab82f219b0ef4c58471cf81d23412475` |
| Extension language config | `path_suffixes = ["excalidraw", "excalidraw.svg", "excalidraw.png"]` (pre-fix) |
| LSP | `excalidraw-preview --lsp` (this repo's binary) |
| OS | macOS (Apple Silicon) |

## Capture method

`~/.local/bin/excalidraw-preview` was temporarily replaced by a symlink to this
wrapper, so every Zed→LSP byte was teed to `/tmp/ep-lsp-*.log`:

```bash
#!/bin/bash
# ep-lsp-logger.sh — investigation wrapper (deleted after evidence extraction)
REAL="<repo>/target/release/excalidraw-preview"
if [ "$1" = "--lsp" ]; then
  echo "=== $(date '+%H:%M:%S') LSP wrapper started (ppid=$PPID)" >> /tmp/ep-lsp-traffic.log
  tee -a -i /tmp/ep-lsp-stdin.log <&0 | "$REAL" --lsp 2>>/tmp/ep-lsp-stderr.log | tee -a -i /tmp/ep-lsp-stdout.log
  exit
fi
exec "$REAL" "$@"
```

## Session timeline (sanitized)

Protocol method counts over the whole session (46 framed messages):

```
 1  initialize
 1  initialized
 5  workspace/didChangeConfiguration
 8  textDocument/didClose
 8  textDocument/didOpen
```

Ordered timeline (`text` bodies elided):

```
[ 0] initialize              (processId <zed>, rootUri file://<WORKTREE>)
[ 1] initialized
[ 2] workspace/didChangeConfiguration
[ 3] didOpen   <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[ 4] didClose  <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[ 5] didOpen   <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[ 6] didClose  <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[ 7] didOpen   <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[ 8] didClose  <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[ 9] didOpen   <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[10] didClose  <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[11] didOpen   <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[12] didClose  <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[13] didOpen   <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[14] didClose  <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[15] didOpen   <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[16] didClose  <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[17] didOpen   <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[18] didClose  <WORKTREE>/docs/getting-started/lifecycle.excalidraw
[19] workspace/didChangeConfiguration
[20] workspace/didChangeConfiguration
[21] workspace/didChangeConfiguration
[22] workspace/didChangeConfiguration
```

The user alternated: 7 clicks on `lifecycle.excalidraw` and 7 clicks on
`compose-pipeline.excalidraw.svg` (both under `<WORKTREE>/docs/getting-started/`,
same session; the 8th `didOpen` at index 3 includes the initial open).

**The observation:**

- Every click on `lifecycle.excalidraw` (single-segment suffix) produced a
  `textDocument/didOpen` — **7 for 7 user clicks**.
- Every click on `compose-pipeline.excalidraw.svg` (compound suffix) produced
  **zero** `didOpen` — **0 for 7 user clicks** — while the buffer demonstrably
  opened: each `.svg` click displaced the previously focused preview-tab buffer,
  which is exactly what the interleaved `didClose` of `lifecycle.excalidraw`
  records. No message in the entire session names the `.excalidraw.svg` URI.
- The status bar showed language "Excalidraw" for the `.excalidraw.svg` buffer,
  so the *language attached* — only `didOpen` routing to the language server was
  missing.

Representative sanitized frames:

```jsonc
// request: initialize (abridged)
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{
  "processId":<zed-pid>,"rootUri":"file://<WORKTREE>",
  "capabilities":{"workspace":{"applyEdit":true,"didChangeConfiguration":{"dynamicRegistration":true},"didChangeWatchedFiles":{"dynamicRegistration":true}, …}}}}

// notification: textDocument/didOpen (text elided)
{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{
  "uri":"file://<WORKTREE>/docs/getting-started/lifecycle.excalidraw",
  "languageId":"excalidraw","version":0,"text":"<…scene JSON elided…>"}}}

// response on stdout: initialize result
{"id":0,"jsonrpc":"2.0","result":{"capabilities":{"textDocumentSync":{"change":1,"openClose":true,"save":true}},"serverInfo":{"name":"excalidraw-preview","version":"0.1.0"}}}
```

## Interpretation (per spec findings 3–4)

- Single-segment suffixes route through an exact-match path
  (`find_by_name_or_extension`, `available_languages.rs:186`: `suffix == string`)
  that demonstrably delivers `didOpen`.
- The full matcher (`find_for_file`) *also* matches compound suffixes via the
  filename candidate — which is why the language attaches to `.excalidraw.svg` —
  but that match never translates into buffer registration with the language
  server. The exact diverging call site upstream is not pinned (hypothesis: the
  buffer-subscription path uses the exact-match lookup, or the async language-load
  race skips `set_language_for_buffer` → `register_buffer_with_language_servers`).
- This remains a *suspected* Zed regression until confirmed upstream; the spec's
  workaround (single-segment `path_suffixes` only) does not depend on the
  root-cause pin.

## Minimal upstream repro recipe

Independent of this repo's extension:

1. **Extension.** Scaffold a minimal Zed extension with two languages:
   - language `compound-repro-a`: `path_suffixes = ["repro"]`
   - language `compound-repro-b`: `path_suffixes = ["repro.svg"]`
   - a language server `[language_servers.repro-dummy]` mapped to both languages;
     the server binary can be any program that reads LSP frames on stdin and
     answers `initialize` with minimal capabilities (`openClose: true`).
2. **Install.** Zed → command palette → `zed: install dev extension` → select the
   extension directory.
3. **Interpose the traffic dump.** Point the language-server command at a wrapper
   like the one above (tee stdin to a log, pipe to the real dummy server).
4. **Reproduce.** In a workspace, create `a.repro` and `b.repro.svg`. Single-click
   each file several times in turn.
5. **Expected (buggy) behavior.** `a.repro` clicks produce `textDocument/didOpen`
   every time; `b.repro.svg` clicks produce none (buffer opens — visible via the
   `didClose` of the displaced preview-tab buffer — but no `didOpen` is ever sent,
   and no message names the `b.repro.svg` URI).
6. **Control.** Repeat with `path_suffixes = ["svg"]`-style single-segment suffixes
   for both languages — `didOpen` is delivered for both.

## Upstream filing

Phase 9 files the Zed issue with this document attached and links the issue URL in
[`acceptance-checklist.md`](./acceptance-checklist.md). Intent (spec §8): report
the compound-suffix `didOpen` non-delivery, and longer-term request a real
extension event API for file opens so the fake-LSP transport can retire.
