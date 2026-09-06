// Shared types for the narrow WebView↔Rust bridge.
//
// Native code (menu Save, close-confirm, library import/export) drives the
// frontend by calling these globals via `evaluate_script`. Each returns a
// promise so the native side can wait for completion, and each reports its
// outcome to `POST /native-action-result` keyed by `requestId`.

/** Options passed to a native-triggered save. */
export interface NativeSaveOptions {
  /** Why the save was triggered (e.g. "menu", "keyboard", "close"). For logging. */
  reason?: string;
  /** Correlation id echoed back to `/native-action-result`; generated when omitted. */
  requestId?: string;
}

/** Result of a native-triggered save. */
export interface NativeSaveResult {
  ok: boolean;
  error?: string;
  /**
   * Set when `ok` is false *only* because newer edits landed while the POST was
   * in flight — the write itself succeeded, the scene is just dirty again. A
   * close-and-save flow uses this to retry (rather than abort) so it never
   * closes over an unsaved edit. Absent on hard failures (HTTP/network errors).
   */
  pendingNewerEdits?: boolean;
}

/** Options passed to a native-triggered library import/export. */
export interface NativeLibraryOptions {
  /** Correlation id echoed back to `/native-action-result`; generated when omitted. */
  requestId?: string;
}

declare global {
  interface Window {
    /**
     * Serializes and saves the current scene, then reports the outcome to
     * `/native-action-result`. Resolves with the save result. Present only
     * while the React app is mounted.
     */
    __excalidrawSave?: (opts?: NativeSaveOptions) => Promise<NativeSaveResult>;
    /**
     * Shows a transient in-page notice explaining why a save gesture had
     * nothing to save. Unlike every other global here it is registered at
     * module scope by `main.tsx` — i.e. it is present on *every* load path,
     * including the ones where the React app never mounts (read-only image
     * preview, load failure, pre-mount). The native File → Save script calls it
     * when `__excalidrawSave` is absent so the gesture is never silent
     * (spec §2.3; see `save-notice.ts`).
     */
    __excalidrawSaveUnavailable?: (source?: string) => void;
    /**
     * Triggers an export (png / png2x / svg / scene) through the same native
     * save-dialog path as the in-WebView menu. Driven by the native File menu
     * on the tao path. Present only while the React app is mounted.
     */
    __excalidrawExport?: (kind: string) => void;
    /**
     * Drains the server's queued "Browse libraries" installs (`GET
     * /pending-library`) and merges each raw `.excalidrawlib` document into the
     * panel via Excalidraw's own parser (handles both the v1 `library` and v2
     * `libraryItems` shapes). Invoked by the SSE `library` event. Present only
     * while the React app is mounted.
     */
    __excalidrawApplyPendingLibraries?: () => Promise<void>;
    /**
     * Reports the WebView's *live* dirty state to `/native-action-result`
     * (`ok: true` ⇒ no unsaved changes ⇒ safe to close). The native close flow
     * dispatches this first so its decision reflects the current scene rather
     * than a possibly-stale `POST /dirty`. Present only while the app is mounted.
     */
    __excalidrawPrepareClose?: (
      opts?: NativeSaveOptions,
    ) => Promise<NativeSaveResult>;
    /**
     * Asks Rust to show a native open dialog filtered to `.excalidrawlib`,
     * validates the chosen file, and merges its items into the library panel.
     * Reports the outcome to `/native-action-result`. Present only while the
     * React app is mounted.
     */
    __excalidrawImportLibrary?: (
      opts?: NativeLibraryOptions,
    ) => Promise<NativeSaveResult>;
    /**
     * Serializes the current library and POSTs it to Rust's export-dialog path
     * so the user can write a `.excalidrawlib` file. Reports the outcome to
     * `/native-action-result`. Present only while the React app is mounted.
     */
    __excalidrawExportLibrary?: (
      opts?: NativeLibraryOptions,
    ) => Promise<NativeSaveResult>;
  }
}
