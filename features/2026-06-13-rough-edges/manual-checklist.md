# Manual / WebView-only verification checklist

These paths run inside a real `wry` WebView with native menus and dialogs, so
they cannot be exercised by the headless Rust suite or jsdom-less Vitest. Run
through this list against a real build (`just build && ./target/release/excalidraw-preview <file>`)
on macOS, and on Linux (WebKitGTK) where noted. Check each box per platform.

## Save / dirty

- [ ] Edit the scene, press `Cmd+S` / `Ctrl+S` → "Saved" toast; file on disk updates.
- [ ] Edit, then trigger Save from the **native File menu** → saves (covers AppKit
      consuming `Cmd+S` before WKWebView).
- [ ] Edit, then Save from the in-canvas **MainMenu → "Save to file"** → saves.
- [ ] `--auto-save`: draw a continuous 10 s stroke → at least one intermediate save
      lands (max-wait flush), and a final save after `pointerup`.
- [ ] `--auto-save`: switch to another app mid-edit (window blur) → pending edit flushes.
- [ ] **Stale-save race:** with auto-save on a large scene, keep editing while a save
      is in flight, then immediately close → unsaved-changes is respected (no silent
      loss). Covered logically by `dirty-state.test.ts`, but confirm end-to-end.

## Close confirmation

- [ ] Auto-save **off**, dirty scene, close window → 3-way "Unsaved changes" dialog.
  - [ ] "Save" → saves then closes.
  - [ ] "Don't Save" → closes without saving.
  - [ ] "Cancel" → window stays open.
- [ ] Auto-save **on**, dirty scene, close → silent save then close (no dialog).
- [ ] Close while a save-and-close is already in flight → repeat close is ignored.
- [ ] Trigger a save-and-close whose JS round-trip never resolves (e.g. kill the
      React app) → after the 5 s timeout the window stays open and the
      `pending_actions` entry is evicted (regression for finding 5; unit-tested by
      `test_poll_close_flow_evicts_pending_entry_on_timeout`).

## Library import / export (native dialogs)

- [ ] **Export before any edit:** open a file that already has a saved shared
      library, immediately choose **Library → Export Library…**, save → the written
      `.excalidrawlib` contains the seeded items, NOT an empty list (regression for
      finding 3; logic unit-tested by `initialLibraryItems`).
- [ ] Add a shape to the library, Export Library… → file contains the new item.
- [ ] **Library → Import Library…**, pick a valid `.excalidrawlib` → items merge in
      and an "Imported N library item(s)" toast appears.
- [ ] Import a non-library file (e.g. a `.excalidraw` scene) → "Not a valid library
      file" toast; library unchanged.
- [ ] Cancel the import dialog → silent no-op.
- [ ] **Import-then-quick-close durability:** Import Library… a valid
      `.excalidrawlib`, see the "Imported N…" toast, then **close the window
      immediately** (within ~600 ms). Reopen the file → the imported items are
      still present (regression for review 5, finding 1; the import now awaits the
      `/library` write and the close flow flushes any pending library write).

## Export (PNG / PNG 2× / SVG / scene)

- [ ] Each native File-menu export item opens a save dialog with the right filter
      and writes a correct file. SVG fonts render (see font note below).
- [ ] Cancelling an export dialog is a silent no-op.

## External links & fonts

- [ ] Click Help / "Browse libraries" / any docs link → opens in the **system
      browser**, not inside the editor; the editor does not navigate away.
- [ ] Hand-drawn fonts (Excalifont etc.) render in-canvas and in exported SVG —
      confirms `/assets/fonts/**` resolve (no 404s in WebView devtools).

## Concurrency (covered by automated tests, spot-check manually)

- [ ] Open previews for several different files at once → each gets its own window
      and port; none fails with "Address already in use" (regression for finding 1,
      automated by `concurrent_previews_bind_distinct_ports_and_serve`).
