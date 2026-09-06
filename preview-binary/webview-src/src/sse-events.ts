// Explicit SSE event dispatch.
//
// The server's SSE stream is an *invalidation hint*, not durable state, and its
// message names are a protocol: `reload` (disk changed), `library` (a "Browse
// libraries" install landed), `editor-closed` (the LSP forwarded a
// `textDocument/didClose` attention signal). Clients must dispatch explicitly
// and ignore unknown names — never fall through an `if/else` that treats every
// unrecognized frame as a reload.

export type SseEventName = "reload" | "library" | "editor-closed";

/** Handlers for the known SSE event names. */
export interface SseHandlers {
  onReload(): void;
  onLibrary(): void;
  onEditorClosed(): void;
}

/**
 * Dispatches one SSE frame by its exact `data:` name.
 *
 * ## Returns
 * `true` when the name was known and dispatched; `false` for unknown names,
 * which are deliberately ignored (a future server may add events this client
 * predates).
 */
export function dispatchSseEvent(name: string, handlers: SseHandlers): boolean {
  switch (name) {
    case "reload":
      handlers.onReload();
      return true;
    case "library":
      handlers.onLibrary();
      return true;
    case "editor-closed":
      handlers.onEditorClosed();
      return true;
    default:
      return false;
  }
}

/**
 * The full-app SSE handler (editor path): routes `reload` to a disk
 * reconciliation, `library` to the pending-libraries drain, and
 * `editor-closed` to the attention-signal path.
 */
export function createAppSseHandler(handlers: SseHandlers): (data: string) => void {
  return (data: string) => {
    dispatchSseEvent(data, handlers);
  };
}

/**
 * The read-only image preview's SSE handler: it handles `reload` only (refetch
 * the raw image) and ignores everything else — in particular it never reacts to
 * `editor-closed` and never shows a conflict dialog, because a read-only
 * preview has no scene to conflict.
 */
export function createReadonlySseHandler(handlers: {
  onReload(): void;
}): (data: string) => void {
  return (data: string) => {
    dispatchSseEvent(data, {
      onReload: handlers.onReload,
      onLibrary: () => {},
      onEditorClosed: () => {},
    });
  };
}
