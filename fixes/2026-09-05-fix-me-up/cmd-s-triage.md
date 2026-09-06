# Cmd+S triage record — Track B (Phase 2, 2026-09-06)

macOS staged triage per spec §6.2 / plan Phase 2 Track B. Classifies the
§2.2 candidates for the "Cmd+S does nothing on macOS" report. Companion
records: [`decision-log.md`](./decision-log.md) (D2), [`spec.md`](./spec.md) §2.

## Build identity

| Field | Value |
|---|---|
| Binary under test | `target/release/excalidraw-preview`, rebuilt via `just release` (ui + cargo) during this triage, 2026-09-06 14:04–14:07 |
| Version | **0.6.0** (embedded `CARGO_PKG_VERSION`, `strings`; also `extension.toml`, both `[package]`s, `BINARY_VERSION` at `extension/src/lib.rs:9`) |
| Menu strings present in binary | `CmdOrCtrl+S`, `Save`, `Export PNG`, `Export PNG (2x)`, `Export SVG`, `Export Scene`, `Import Library…` — the full `build_menu` set (`main.rs:1862-1933`), accelerator included (lineage: first shipped `v0.4.0` / `8f8326c`, 2026-06-14) |
| OS | macOS (this host, arm64) |

### New finding N1 — the binary has no `--version` flag

`excalidraw-preview --version` **errors** ("unexpected argument '--version'"):
`CliArgs` (`main.rs:3171-3224`) defines no version argument and the clap
`#[command]` derive carries no `version` attribute, so clap does not generate
one. The mandated identity procedure (spec §2.3 blocking precondition:
"binary identity confirmed via `--version`") **cannot run as written** — on
any build, including the release artifacts. Identity was established here via
embedded strings + manifest cross-check instead. The D2 remedy phase should
add the flag (and the checklist's build-identity guard should record how
identity is captured until then); this is recorded as a new finding, not
silently worked around.

## Stage 1 — PATH binary identity (stale-PATH candidate §2.2.1)

- `which -a excalidraw-preview` → `/Users/ken/.local/bin/excalidraw-preview`
  (only entry), a **symlink →
  `/Volumes/coding/forks/excalidraw-zed-extension/target/release/excalidraw-preview`**,
  created 2026-09-06 13:07 (i.e. *today*, post-dating the report).
- The symlink target is the current 0.6.0 build with the accelerator (above).
  **The PATH binary as it stands now is not stale.**
- The PATH state *at report time* is not recoverable from this host: no
  `excalidraw-preview`/`just symlink` trace exists in shell history, and the
  symlink's creation today means the pre-report PATH state is unknown (could
  have been absent — in which case the extension's PATH-first resolution fell
  through to the cached v0.6.0 download, which also has the accelerator — or
  could have pointed at an older build).

## Stage 2 — current build, `--debug`, Cmd+S observation

**Method disclosure.** Cmd+S was delivered by System Events keystroke
synthesis (`osascript 'keystroke "s" using command down'`) targeted at the
frontmost preview window of the PID under test — a real key-equivalent
through the window server into AppKit's menu system, i.e. the exact delivery
path under classification. The plan's exclusion ("CGEvent synthesis is not
part of classification") defers building synthesis into the *smoke test* as
automated hardening; no smoke-test automation was added or used here. The
observation below is a live app run, not a synthetic test.

**Setup.** Scratch scene (one rectangle) at a temp path; launched
`excalidraw-preview <scratch> --foreground --debug --port 47322` (foreground
so `--debug` stderr/stdout is capturable; the daemonizing path nulls the
child's streams, `main.rs:238-240`). The preview logs to **stdout** (tracing
default writer; the stderr-must rule is the `--lsp` mode's, `main.rs` init).

**Observations (2026-09-06 14:20–14:21 local / 21:20–21:21Z):**

1. Two Cmd+S presses at 21:21:02 and 21:21:50 produced **two complete save
   round-trips**, each logged by the watcher:
   `DEBUG … disk revision of <scratch> matches the last viewer write; suppressing echo`
   (`main.rs:448-453`) at exactly the press timestamps, and the file on disk
   was rewritten each time (md5 changed; content re-serialized with
   `"source": "excalidraw-zed-preview"`).
2. Therefore the full chain fired: key equivalent → AppKit menu → **muda
   `MenuEvent` → dispatch closure (`main.rs:3132-3136`) → JS bridge
   `window.__excalidrawSave({reason:'menu'})` → `doSave` → `POST /data` →
   server write → watcher echo-suppression**. A silent no-op would produce no
   write and no log line; two timed writes are positive delivery proof.
3. No error, no crash (no DiagnosticReports; exits observed elsewhere were
   clean `LoopDestroyed` window closes — see Stage 3 caveats).

**The scene could not be made dirty via synthesized input.** Click-at-
coordinates and editing keystrokes (Cmd+A, arrow keys, text tool) did not
reach the WKWebView content (the element never moved; no `*` dirty marker
ever appeared in the window title) — only menu-level synthesized input
reaches the app. The delivery mechanism under test (accelerator → MenuEvent →
bridge → save) is dirty-state-independent (`doSave` runs and POSTs for every
explicit save regardless of prior dirty state — spec §2.2 verified analysis),
so the classification stands; the dirty-cell *toast* observation remains a
Phase 7 manual-GUI item.

## Stage 3 — across dirty / clean / read-only (informal macOS rows)

| Scene state × Cmd+S | Result |
|---|---|
| dirty editable | **Not observed** — see Stage 2 §3 (synthesized edits don't reach the WKWebView; formal cell is Phase 7's). Mechanism identical to the observed clean-cell save. |
| clean editable | **Observed — save completes** (the 21:21:50 press was on a clean scene: file rewritten, echo-suppression logged). Also directly refutes any clean-scene *round-trip* no-op; the toast ("Saved") is GUI-visible only. The §2.2 clean-scene-silence sub-claim stays *unconfirmed* for the toast-level formal cell. |
| read-only image preview | **Not observed** — the read-only window (`readonly.excalidraw.svg`, no embedded scene) was closed from the desktop before the key press could be delivered (active interactive session on this host; two windows were closed externally during the triage — clean `LoopDestroyed` exits, `window.json` rewritten, no crashes). The silent no-op in read-only mode is already **proven from source** (`main.rs:1940-1942` guard: `window.__excalidrawSave && …` is a no-op when the React app is absent) and is Phase 5's required fix regardless of classification. |

## Classification

- **§2.2 candidate 2 (muda accelerator→MenuEvent delivery failure on macOS):
  ELIMINATED for the current build** — positive end-to-end delivery proof,
  twice (Stage 2 §1-2).
- **§2.2 candidate 3 (dispatched but silent):** holds **only** for the
  read-only image preview (source-proven, Phase 5 scope). No evidence of
  silence on editable scenes — saves complete and rewrite the file; toast
  visibility is a GUI observation deferred to Phase 7.
- **§2.2 candidate 1 (stale PATH / pre-accelerator binary in the reporting
  session): REMAINS THE CLASSIFICATION** for the reported symptom. It is the
  only candidate consistent with (a) the report ("Ctrl+S works, Cmd+S does
  nothing" — exactly the signature of a build without the menu accelerator,
  where AppKit swallows Cmd+S and the page handler only sees Ctrl+S) and (b)
  the current build's proven-working accelerator path. The reporting-time
  binary identity is unverifiable from this host (Stage 1), so the
  classification is by elimination, not by direct inspection of the
  reporter's binary — recorded as such.
- **New finding N1:** missing `--version` CLI flag (above) — the identity
  procedure needs it; recommend the Phase 5 remedy branch add the flag and a
  checklist identity guard.

## Notes for Phase 5 (remedy branch input, not decisions)

- Branch matched: **stale-PATH / environment hygiene** (§2.2.1) — no product
  code change *expected for the delivery defect itself*; the current PATH
  symlink is already correct on this host. N1 (`--version`) and the read-only
  silence fix are separate, already-mandated deliverables.
- Dev-loop caveat discovered: `--debug` output is capturable only with
  `--foreground` (daemonize nulls the child's streams). Worth remembering for
  future triage sessions; not a defect (by design for detached windows).
