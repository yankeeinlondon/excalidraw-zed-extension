---
ready: false
---

# Review 7

## Findings

1. **Major: LSP file URI parsing breaks Windows auto-open and save-triggered reopen.**

   Suggested fix: replace the hand-rolled `file_uri_to_path` with a real file-URI parser, e.g. `url::Url::parse(uri).ok()?.to_file_path().ok()?`, and return a `PathBuf` instead of a `String`. Add unit tests for at least `file:///Users/me/a%20b.excalidraw`, `file:///C:/Users/me/a.excalidraw`, and a UNC-style Windows path if supported by Zed.

   `textDocument/didOpen` and `textDocument/didSave` both depend on `file_uri_to_path` before spawning or re-spawning previews (`preview-binary/src/main.rs:1824`, `preview-binary/src/main.rs:1840`). The converter only strips the literal `file://` prefix and percent-decodes the rest (`preview-binary/src/main.rs:1970`). That works for macOS/Linux paths such as `file:///tmp/a.excalidraw`, but a normal Windows URI like `file:///C:/Users/me/a.excalidraw` becomes `/C:/Users/me/a.excalidraw`, which is not the intended Windows path. As a result, the LSP-driven auto-open and the item 9 save-triggered reopen can silently fail on Windows.

   This is also a missing test case. The current integration test for `didSave` only exercises the host platform path shape, so it does not catch the Windows URI form.

2. **Major: close-save failures and native bridge timeouts can leave the window open without the required error feedback.**

   Suggested fix: when `poll_close_flow` returns a terminal non-exit result, surface an error dialog or dispatch a small JS toast explaining that the save/close action failed. Preserve the lower-level error text from `NativeActionResult.error` instead of reducing the result to a bare `bool`, so native code can distinguish save failure, library write failure, and timeout. Add unit coverage for `ActionOutcome::Lost` and `ok: false` close results producing an error-notification path.

   The spec says close-dependent native flows must wait for `/native-action-result` or time out with an error dialog, and that close save failures should keep the window open and show the error. The implementation keeps the window open, but it drops the reason. `poll_action_result` converts a successful action result into `Resolved(result.ok)` and discards `result.error` (`preview-binary/src/main.rs:1261`). `poll_close_flow` then returns only `(should_exit, finished)` (`preview-binary/src/main.rs:1286`), and the tao event loop resets the flow to idle on failure/timeout without showing anything (`preview-binary/src/main.rs:1665`). The GTK path has the same pattern in its tick handler (`preview-binary/src/main.rs:1492`).

   The frontend does show save HTTP/network failures from `doSave`, but not every native-close failure goes through that visible path. For example, a bridge timeout, an unmounted bridge, or a close-time library persistence failure can simply leave the window open with no native error dialog. That makes the close behavior look broken and does not meet the spec's failure-feedback requirement.

## Checks Run

- `cargo test -p excalidraw-preview-binary` passed: 42 unit tests and 12 integration tests.
- `npm test -- --run` in `preview-binary/webview-src` passed: 3 test files, 52 tests.

## Production Readiness

Decision: not production ready.

The main save/dirty architecture is substantially covered and the automated tests are passing, but I would not call the spec production ready while one advertised path is likely broken on Windows and close-save failures can be silent. Item 9 is explicitly about reliable re-opening through LSP notifications, and the current URI parser is not cross-platform enough for that. The close flow also needs clear failure feedback before this is safe to ship as a polish pass.
