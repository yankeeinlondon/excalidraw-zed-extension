// The disk-sync controller: one place owns how the viewer speaks about the
// disk file as the persisted interchange (fixes/2026-09-05-lsp-strategy §5).
//
// Responsibilities:
// - Reconciliation: SSE `reload` / reconnect / `editor-closed` events trigger a
//   fetch of bytes + revision *together*, a parse, and a decision taken against
//   the LIVE dirty/editing/saving state re-checked *after* the awaits.
// - Conditional viewer writes: every canonical save goes through
//   `attemptViewerWrite`, which refuses to write while a conflict is pending,
//   pauses automatic writes after "Keep my changes", and turns a 412 into a
//   pending conflict instead of a silent overwrite.
// - Conflict lifecycle: one pending-conflict state object with the disk revision
//   and the reason it surfaced; "Reload from disk" / "Keep my changes"
//   resolutions; at most one escalation modal per unresolved revision.
//
// The controller is deliberately framework-free and takes all I/O as injected
// dependencies so the full concurrency/conflict behavior is unit-testable.

import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { RevisionTracker } from "./dirty-state";

/** Why a pending conflict surfaced. */
export type ConflictReason = "watcher" | "save-412" | "editor-closed";

/** A disk revision the user must decide about. */
export interface PendingConflict {
  /** Opaque strong ETag of the disk revision awaiting a decision. */
  revision: string;
  reason: ConflictReason;
}

/** Retryable sync error kinds surfaced in the UI. */
export type SyncErrorKind = "unavailable" | "parse-failed" | "fetch-failed";

export interface SyncError {
  kind: SyncErrorKind;
  message: string;
}

/** One `GET /data` result: bytes and revision fetched together, or a status. */
export type SnapshotResult =
  | { ok: true; revision: string; bytes: ArrayBuffer }
  | { ok: false; status: number };

/** What a canonical `POST /data` resolved to, pre-interpretation. */
export type SendWriteResult =
  | { kind: "ok"; etag: string }
  | { kind: "conflict"; etag: string }
  | {
      kind: "error";
      message: string;
      /** 428 Precondition Required — a programming error on our side. */
      preconditionRequired?: boolean;
    };

/** The write-request shape handed to the injected sender. */
export interface SendWriteRequest {
  ifMatch: string;
  body: BodyInit;
  contentType: string;
  reason: string;
}

/** Outcome of {@link SyncController.attemptViewerWrite}. */
export type ViewerWriteOutcome =
  | { kind: "ok"; etag: string }
  | {
      kind: "blocked";
      reason: "conflict-pending" | "automatic-paused" | "applying";
    }
  | { kind: "conflict"; etag: string; error: string }
  | { kind: "error"; error: string };

/**
 * Reasons whose writes are *automatic* (not an explicit user save gesture).
 * While a "Keep my changes" acknowledgment is pending, only an explicit save
 * may replace the disk version; automatic flushes stay paused until one
 * succeeds.
 */
const AUTOMATIC_WRITE_REASONS = new Set([
  "autosave",
  "maxwait",
  "flush",
  "blur",
  "pointerup",
  "bootstrap",
]);

/** Live viewer state the controller re-reads at decision time. */
export interface SyncControllerDeps {
  /** `GET /data` — must pair the bytes with their ETag in one round trip. */
  fetchSnapshot(): Promise<SnapshotResult>;
  /**
   * Parses disk bytes into scene data. Rejects on invalid data — a revision
   * that cannot be parsed is never applied and never offered as a resolution.
   */
  parseSnapshot(bytes: ArrayBuffer): Promise<ExcalidrawInitialDataState>;
  /** Whether the scene has unsaved edits — re-read after every await. */
  isDirty(): boolean;
  /** Whether the user is mid-text-edit — re-read after every await. */
  isEditing(): boolean;
  /** Whether a viewer write is currently in flight. */
  isSaving(): boolean;
  /**
   * Applies an external scene through the guarded reload path (viewport/theme
   * preserving, dirty bookkeeping re-baselined). Returns `"skipped-editing"`
   * when the user is mid-text-edit and the apply must be retried later.
   */
  applyExternalScene(
    data: ExcalidrawInitialDataState,
  ): "applied" | "skipped-editing";
}

/** The controller's UI-visible state snapshot. */
export interface SyncUiState {
  /** A conflict awaiting the user's decision; the banner shows while set. */
  conflict: PendingConflict | null;
  /** "Keep my changes" acknowledged: next explicit save replaces disk. */
  keepNotice: boolean;
  /** Retryable error (file unavailable / unparsable / fetch failed). */
  error: SyncError | null;
  /**
   * Revision whose conflict has been escalated to the accessible modal
   * (`editor-closed` attention). Null when no modal should show.
   */
  modalRevision: string | null;
}

/**
 * What a reconcile should do with an observed-but-unaccepted disk revision,
 * decided against the live (post-await) viewer state.
 */
export type ReconcileAction = "apply" | "defer" | "conflict";

/**
 * The pure reconcile decision. Transient states defer first — never clobber a
 * text edit, and never raise a conflict an in-flight write will answer (its own
 * 412 raises the conflict with fresher information). A durably dirty viewer
 * means competing work: surface a conflict. Only a clean, idle viewer applies.
 */
export function decideReconcileAction(input: {
  dirty: boolean;
  editing: boolean;
  saving: boolean;
}): ReconcileAction {
  if (input.editing || input.saving) return "defer";
  return input.dirty ? "conflict" : "apply";
}

/**
 * Owns disk reconciliation, conditional writes, and the conflict lifecycle.
 * See the module comment for the contract summary.
 */
export class SyncController {
  private readonly tracker = new RevisionTracker();
  private ui: SyncUiState = {
    conflict: null,
    keepNotice: false,
    error: null,
    modalRevision: null,
  };
  private readonly listeners = new Set<(state: SyncUiState) => void>();

  /** Monotonic id per reconcile/resolve attempt; supersedes stale async work. */
  private reconcileSeq = 0;
  private inFlightReconcile: Promise<void> | null = null;
  private rerunReconcile = false;
  /** Newest revision retained because a transient state (editing/saving) deferred it. */
  private deferredRevision: string | null = null;
  /** Revision already escalated to a modal (one modal per unresolved revision). */
  private escalatedRevision: string | null = null;
  /** Revision whose modal the user dismissed — never re-prompted for it. */
  private modalDismissedRevision: string | null = null;
  /** A native close-confirmation flow is active; defer modal escalation. */
  private nativeCloseFlowActive = false;
  private escalationDeferred = false;
  /** A "Reload from disk" resolution is applying; block writes meanwhile. */
  private applying = false;

  constructor(private readonly deps: SyncControllerDeps) {}

  // ── State exposure ────────────────────────────────────────────────────────

  /** The current UI snapshot (also delivered via {@link subscribe}). */
  snapshot(): SyncUiState {
    return this.ui;
  }

  /** Subscribes to UI-state changes. Returns an unsubscribe function. */
  subscribe(listener: (state: SyncUiState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The accepted disk revision (seeded from the initial `GET /data` ETag). */
  acceptedRevision(): string | null {
    return this.tracker.acceptedRevision();
  }

  /** Seeds the accepted revision from the initial load (empty files included). */
  seedAccepted(revision: string): void {
    this.tracker.seed(revision);
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  /**
   * Reconciles the viewer with disk: fetch bytes + revision together, parse,
   * then decide against the *live* state. Concurrent calls coalesce into one
   * request (with a single re-run afterwards when more arrived mid-flight);
   * superseded async results are discarded by sequence number.
   */
  reconcile(reason: ConflictReason): Promise<void> {
    if (this.inFlightReconcile) {
      this.rerunReconcile = true;
      return this.inFlightReconcile;
    }
    const run = this.runReconcile(reason).finally(() => {
      this.inFlightReconcile = null;
      if (this.rerunReconcile) {
        this.rerunReconcile = false;
        void this.reconcile(reason);
      }
    });
    this.inFlightReconcile = run;
    return run;
  }

  private async runReconcile(reason: ConflictReason): Promise<void> {
    const seq = ++this.reconcileSeq;

    let snapshot: SnapshotResult;
    try {
      snapshot = await this.deps.fetchSnapshot();
    } catch {
      if (seq !== this.reconcileSeq) return;
      this.setError({
        kind: "fetch-failed",
        message: "Could not read the file from the preview server.",
      });
      return;
    }
    if (seq !== this.reconcileSeq) return;

    if (!snapshot.ok) {
      // 404 = the file is unavailable (deleted). Deletion is a disk state in
      // its own right: keep the scene, dirty flag and accepted revision
      // intact and surface a retryable error — never blank the scene.
      this.setError(
        snapshot.status === 404
          ? {
              kind: "unavailable",
              message: "The file is no longer on disk.",
            }
          : {
              kind: "fetch-failed",
              message: `Reading the file failed (HTTP ${snapshot.status}).`,
            },
      );
      return;
    }

    if (this.tracker.isKnown(snapshot.revision)) {
      // Proven viewer echo or an already-accepted/acknowledged revision:
      // nothing to reconcile. (This replaces time-based echo suppression —
      // no clock is ever consulted.)
      this.deferredRevision = null;
      this.setError(null);
      return;
    }

    // Parse BEFORE deciding: an unparsable revision is surfaced as a
    // retryable error, never applied and never offered as a conflict choice.
    let data: ExcalidrawInitialDataState;
    try {
      data = await this.deps.parseSnapshot(snapshot.bytes);
    } catch {
      if (seq !== this.reconcileSeq) return;
      this.setError({
        kind: "parse-failed",
        message:
          "The file on disk could not be read as an Excalidraw scene. Your edits are untouched.",
      });
      return;
    }
    if (seq !== this.reconcileSeq) return;

    // Re-check the LIVE state after the awaits — never the state observed
    // before them. This is the guard that keeps a scene that became dirty (or
    // an edit that began) during the fetch+parse from being clobbered.
    const action = decideReconcileAction({
      dirty: this.deps.isDirty(),
      editing: this.deps.isEditing(),
      saving: this.deps.isSaving(),
    });

    switch (action) {
      case "apply":
        this.applySnapshot(snapshot.revision, data);
        break;
      case "defer":
        // Retain the newest pending revision; retried when editing ends or
        // the in-flight save settles — never discarded.
        this.deferredRevision = snapshot.revision;
        break;
      case "conflict":
        this.deferredRevision = null;
        this.raiseConflict(snapshot.revision, reason);
        break;
    }

    // `editor-closed` is an attention signal: after reconciling (which covers
    // close-before-watcher ordering — the fetch itself observes the new disk
    // state), surface a pending conflict as a modal. When there is nothing to
    // reconcile, nothing happens at all.
    if (reason === "editor-closed" && this.ui.conflict) {
      this.maybeEscalate(this.ui.conflict.revision);
    }
  }

  private applySnapshot(
    revision: string,
    data: ExcalidrawInitialDataState,
  ): void {
    const outcome = this.deps.applyExternalScene(data);
    if (outcome === "skipped-editing") {
      // An edit began during fetch+parse; keep the revision pending for retry.
      this.deferredRevision = revision;
      return;
    }
    // Advance the accepted revision ONLY after application succeeded. This is
    // an external reload, never a viewer save — no save bookkeeping runs.
    this.tracker.acceptedFromReload(revision);
    this.deferredRevision = null;
    this.escalatedRevision = null;
    this.ui = {
      ...this.ui,
      conflict: null,
      keepNotice: false,
      modalRevision: null,
      error: null,
    };
    this.emit();
  }

  private raiseConflict(revision: string, reason: ConflictReason): void {
    if (this.ui.conflict?.revision === revision) {
      // Same unresolved revision: never stack a second prompt or banner.
      return;
    }
    this.ui = {
      ...this.ui,
      conflict: { revision, reason },
      keepNotice: false,
      error: null,
    };
    this.modalDismissedRevision = null;
    this.emit();
  }

  /**
   * Shows the conflict modal for `revision`, at most once per unresolved
   * revision. Deferred while a native close-confirmation flow is active and
   * re-checked when that flow ends. Never steals window focus — the modal only
   * receives focus inside the WebView.
   */
  private maybeEscalate(revision: string): void {
    if (this.ui.conflict?.revision !== revision) return;
    if (this.escalatedRevision === revision) return;
    if (this.modalDismissedRevision === revision) return;
    if (this.nativeCloseFlowActive) {
      this.escalationDeferred = true;
      return;
    }
    this.escalatedRevision = revision;
    this.ui = { ...this.ui, modalRevision: revision };
    this.emit();
  }

  /** SSE `editor-closed`: reconcile disk FIRST, then check for a conflict. */
  editorClosed(): Promise<void> {
    return this.reconcile("editor-closed");
  }

  /** The user finished a text edit: retry a deferred reconciliation. */
  editingEnded(): Promise<void> {
    return this.retryDeferred();
  }

  /** A viewer write settled: retry a deferred reconciliation. */
  saveSettled(): Promise<void> {
    return this.retryDeferred();
  }

  private retryDeferred(): Promise<void> {
    if (this.deferredRevision === null) return Promise.resolve();
    return this.reconcile("watcher");
  }

  /** Retry after a sync error: clear it and reconcile again. */
  retryError(): void {
    this.setError(null);
    void this.reconcile("watcher");
  }

  // ── Conditional viewer writes ─────────────────────────────────────────────

  /**
   * Performs one canonical conditional write.
   *
   * Refuses to write at all while a conflict is pending (nothing writes to
   * disk until the user resolves) or while a reload-discard is applying, and
   * pauses automatic-reason writes while a "Keep my changes" acknowledgment
   * awaits its explicit save. The `If-Match` header is read at call time —
   * after export, inside the serialized save queue — so a queued follow-up
   * write carries the revision acknowledged by its predecessor.
   *
   * On 200 the server's ETag becomes the accepted revision and the authorized
   * overwrite (if this was it) is consumed. On 412 nothing advances: the
   * current ETag becomes a pending conflict (reason `save-412`), dirty state
   * is left alone, and the caller reports the save failure. A 428 is a
   * programming error (we always send `If-Match`) and is logged loudly.
   */
  async attemptViewerWrite(input: {
    body: BodyInit;
    contentType: string;
    reason: string;
    send: (req: SendWriteRequest) => Promise<SendWriteResult>;
  }): Promise<ViewerWriteOutcome> {
    if (this.applying) {
      return { kind: "blocked", reason: "applying" };
    }
    if (this.ui.conflict) {
      return { kind: "blocked", reason: "conflict-pending" };
    }
    if (
      this.ui.keepNotice &&
      AUTOMATIC_WRITE_REASONS.has(input.reason)
    ) {
      return { kind: "blocked", reason: "automatic-paused" };
    }

    const ifMatch = this.tracker.writeHeader();
    if (ifMatch === null) {
      // The contract requires every canonical write to carry the revision it
      // accepts; having none means the wiring is broken. Say it loudly, then
      // let the server's 428 refuse the write.
      console.error(
        "[sync] programming error: no accepted revision available for If-Match",
      );
    }

    const result = await input.send({
      ifMatch: ifMatch ?? "",
      body: input.body,
      contentType: input.contentType,
      reason: input.reason,
    });

    switch (result.kind) {
      case "ok": {
        this.tracker.writeAccepted(result.etag);
        // If this was the write "Keep my changes" authorized, the decision is
        // now spent and normal (automatic) saving may resume.
        this.ui = { ...this.ui, keepNotice: false, error: null };
        this.emit();
        void this.saveSettled();
        return { kind: "ok", etag: result.etag };
      }
      case "conflict": {
        // 412: disk moved past every revision we could speak for. Surface the
        // conflict; do not clear dirty, do not advance any baseline, and let
        // no automatic retry overwrite the newer disk version.
        this.raiseConflict(result.etag, "save-412");
        return {
          kind: "conflict",
          etag: result.etag,
          error: "File changed on disk",
        };
      }
      case "error": {
        if (result.preconditionRequired) {
          console.error(
            "[sync] programming error: server required If-Match (428). " +
              "Every canonical save must send the accepted revision.",
          );
        }
        return { kind: "error", error: result.message };
      }
    }
  }

  // ── Conflict resolution ───────────────────────────────────────────────────

  /**
   * "Reload from disk": fetch the latest revision and parse it successfully
   * BEFORE dropping viewer edits through the guarded reload path. While
   * applying, writes are blocked and stale in-flight completions are
   * invalidated; a newer revision arriving mid-flight re-reconciles instead of
   * applying the stale one. A failed reload leaves the conflict pending.
   */
  async resolveReload(): Promise<void> {
    const pending = this.ui.conflict;
    if (!pending || this.applying) return;

    this.applying = true;
    try {
      // Bump the sequence so any in-flight reconcile is discarded; this
      // resolution is now the authoritative async operation.
      const seq = ++this.reconcileSeq;

      let snapshot: SnapshotResult;
      try {
        snapshot = await this.deps.fetchSnapshot();
      } catch {
        this.setError({
          kind: "fetch-failed",
          message: "Could not read the file from the preview server.",
        });
        return; // conflict stays pending
      }
      if (seq !== this.reconcileSeq) return;

      if (!snapshot.ok) {
        this.setError(
          snapshot.status === 404
            ? { kind: "unavailable", message: "The file is no longer on disk." }
            : {
                kind: "fetch-failed",
                message: `Reading the file failed (HTTP ${snapshot.status}).`,
              },
        );
        return; // conflict stays pending
      }

      if (snapshot.revision !== pending.revision) {
        // A newer revision arrived mid-flight: reconcile again rather than
        // applying the stale one (which would discard edits for nothing).
        void this.reconcile("watcher");
        return;
      }

      let data: ExcalidrawInitialDataState;
      try {
        data = await this.deps.parseSnapshot(snapshot.bytes);
      } catch {
        if (seq !== this.reconcileSeq) return;
        this.setError({
          kind: "parse-failed",
          message:
            "The file on disk could not be read as an Excalidraw scene. Your edits are untouched.",
        });
        return; // conflict stays pending
      }
      if (seq !== this.reconcileSeq) return;

      const outcome = this.deps.applyExternalScene(data);
      if (outcome === "skipped-editing") {
        // An edit began mid-flight; the conflict stays pending for a retry.
        return;
      }

      this.tracker.acceptedFromReload(snapshot.revision);
      this.deferredRevision = null;
      this.escalatedRevision = null;
      this.ui = {
        ...this.ui,
        conflict: null,
        keepNotice: false,
        modalRevision: null,
        error: null,
      };
      this.emit();
    } finally {
      this.applying = false;
    }
  }

  /**
   * "Keep my changes": authorize exactly the displayed pending revision to be
   * replaced by the next explicit write. The accepted baseline does NOT move,
   * the scene stays dirty, nothing is written now, and every automatic flush
   * stays paused until an explicit save succeeds. A *second* external revision
   * arriving afterwards is a fresh conflict: it matches neither the accepted
   * baseline nor this authorization, so the conditional write must fail rather
   * than overwrite it.
   */
  resolveKeep(): void {
    const pending = this.ui.conflict;
    if (!pending) return;
    this.tracker.authorizeOverwrite(pending.revision);
    // The decision resolved this conflict; a future revision escalates fresh.
    this.escalatedRevision = null;
    this.ui = {
      ...this.ui,
      conflict: null,
      keepNotice: true,
      modalRevision: null,
    };
    this.emit();
  }

  /**
   * Escape / Cancel on the modal: hide it but leave the banner and the save
   * pause intact — the conflict itself stays unresolved.
   */
  dismissModal(): void {
    if (this.ui.modalRevision === null) return;
    this.modalDismissedRevision = this.ui.modalRevision;
    this.ui = { ...this.ui, modalRevision: null };
    this.emit();
  }

  /**
   * Tracks whether a native close-confirmation flow is active so modal
   * escalation can defer until it ends (two stacked prompts would fight for
   * the same keyboard).
   */
  notifyNativeCloseFlow(active: boolean): void {
    this.nativeCloseFlowActive = active;
    if (!active && this.escalationDeferred) {
      this.escalationDeferred = false;
      if (this.ui.conflict) {
        this.maybeEscalate(this.ui.conflict.revision);
      }
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private setError(error: SyncError | null): void {
    if (this.ui.error === null && error === null) return;
    this.ui = { ...this.ui, error };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.ui);
  }
}
