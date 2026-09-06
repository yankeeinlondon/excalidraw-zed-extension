// Pure helpers for save/dirty bookkeeping, extracted so the tricky concurrency
// decisions (a save that resolves after newer edits arrived, and out-of-order
// completion of overlapping saves) are unit-testable without a DOM or a live
// Excalidraw instance.

import type {
  ExcalidrawInitialDataState,
  ExcalidrawImperativeAPI,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { computeSceneHash, pickPersistedAppState } from "./scene-fingerprint";

/** What the caller should do with dirty state once a `POST /data` resolves. */
export interface SaveDecision {
  /**
   * This response belongs to a save that was superseded by a newer save which
   * has *already completed*. Its dirty effects must be ignored entirely so a
   * late-arriving older response can't re-dirty (or wrongly clean) the scene.
   */
  superseded: boolean;
  /** Clear the dirty flag — the saved snapshot is still the latest scene. */
  clearDirty: boolean;
  /** Schedule another save — newer edits arrived while the save was in flight. */
  rescheduleSave: boolean;
  /**
   * Whether, as far as this save can tell, the file on disk now matches the
   * latest observed scene. Drives the `ok` reported to a waiting native
   * close-and-save flow: it is only safe to close when the scene is clean.
   */
  isClean: boolean;
}

/** Inputs to {@link decideSaveOutcome}. */
export interface SaveOutcomeInput {
  /** Scene fingerprint captured *before* the POST that just resolved. */
  savedHash: string;
  /** Latest fingerprint observed by `onChange` (null before the first edit). */
  currentHash: string | null;
  /** Whether auto-save is enabled (decides whether a mismatch reschedules). */
  autoSave: boolean;
  /** Monotonic id of the save whose response this is. */
  mySeq: number;
  /** Highest save id that has already *completed* (resolved its response). */
  lastCompletedSeq: number;
}

/**
 * Decides how to update dirty state after a successful `POST /data`.
 *
 * Two races are handled together:
 *
 * 1. **Stale save (finding 2):** if the scene changed while the POST was in
 *    flight (`savedHash !== currentHash`), a "saved" response must NOT mark the
 *    newer scene clean — that could silently drop the new edit on close. The
 *    scene stays dirty and, under auto-save, another save is scheduled.
 *
 * 2. **Out-of-order completion (finding 5):** when saves A and B overlap and B
 *    (the newer one) completes first, A's late response must not touch dirty
 *    state at all — otherwise A's stale snapshot would re-dirty an already-clean
 *    scene. `mySeq < lastCompletedSeq` marks A as superseded.
 */
export function decideSaveOutcome({
  savedHash,
  currentHash,
  autoSave,
  mySeq,
  lastCompletedSeq,
}: SaveOutcomeInput): SaveDecision {
  const matches = currentHash === savedHash;
  if (mySeq < lastCompletedSeq) {
    // A newer save already resolved; leave dirty state to it. `isClean` reflects
    // only whether this (older) snapshot happened to match — the caller falls
    // back to the live dirty flag when deciding whether a close is safe.
    return {
      superseded: true,
      clearDirty: false,
      rescheduleSave: false,
      isClean: matches,
    };
  }
  if (matches) {
    return {
      superseded: false,
      clearDirty: true,
      rescheduleSave: false,
      isClean: true,
    };
  }
  return {
    superseded: false,
    clearDirty: false,
    rescheduleSave: autoSave,
    isClean: false,
  };
}

/** A mutable timer slot, structurally matching a React `useRef` of a timeout. */
export interface TimerRef {
  current: ReturnType<typeof setTimeout> | null;
}

/** Mutable max-wait / in-flight bookkeeping for the auto-save scheduler. */
export interface AutoSaveState {
  /** Timestamp (ms) the scene first became dirty since the last save, or null. */
  firstDirtyAt: number | null;
  /** True while a max-wait flush is in flight; suppresses duplicate flushes. */
  maxWaitSaveInFlight: boolean;
}

/** What `handleChange` should do for an auto-save-relevant (dirtying) edit. */
export type AutoSaveSchedule = "flush-maxwait" | "debounce";

/**
 * Decides whether a dirtying edit should trigger an immediate bounded flush or
 * (re)arm the debounce, and mutates {@link AutoSaveState} to match.
 *
 * The max-wait exists so a long continuous gesture — where the debounce keeps
 * getting reset and would otherwise starve the save — still produces an
 * intermediate checkpoint. Naively flushing whenever `now - firstDirtyAt >=
 * maxWaitMs` fires a fresh save on *every* `onChange` after the threshold,
 * flooding `/data` with overlapping writes (review 6, finding 2). This guards
 * against that two ways:
 *
 * 1. **Restart the window.** On a max-wait flush, `firstDirtyAt` is reset to
 *    `now`, so the next flush can't fire until another `maxWaitMs` of continuous
 *    dirtying elapses — a checkpoint about every `maxWaitMs`, not per frame.
 * 2. **In-flight guard.** While a max-wait flush is still in flight,
 *    `maxWaitSaveInFlight` keeps subsequent edits on the debounce path instead
 *    of launching another overlapping save.
 *
 * The caller must clear `maxWaitSaveInFlight` when the dispatched flush settles.
 */
export function decideAutoSaveSchedule(
  now: number,
  maxWaitMs: number,
  state: AutoSaveState,
): AutoSaveSchedule {
  if (state.firstDirtyAt === null) state.firstDirtyAt = now;
  if (now - state.firstDirtyAt >= maxWaitMs && !state.maxWaitSaveInFlight) {
    state.firstDirtyAt = now;
    state.maxWaitSaveInFlight = true;
    return "flush-maxwait";
  }
  return "debounce";
}

/**
 * Cancels a pending debounced save so an immediate save becomes the single
 * authoritative write. Clears the timer and nulls the slot.
 *
 * Returns `true` when a timer was actually pending (and has now been cancelled),
 * so the caller can tell Rust that `pendingSave` is no longer true. Centralising
 * this lets every save entry point — keyboard, pointer/blur flush, native menu,
 * and the close flow — share identical flush semantics (review 5, finding 2).
 */
export function flushPendingSave(timer: TimerRef): boolean {
  if (timer.current === null) return false;
  clearTimeout(timer.current);
  timer.current = null;
  return true;
}

/**
 * Flushes a debounced library write: cancels any pending timer and, when there
 * are unpersisted edits (`dirty.current`), invokes `persist` and returns its
 * promise; otherwise resolves to `true` (already durable). The native
 * close/unmount flows await this so an acknowledged import/edit is durable
 * before the window exits (review 5, finding 1).
 *
 * Resolves to whether the library is now durably persisted: `true` when nothing
 * was pending or the write confirmed success, `false` when the write failed so a
 * waiting close flow can keep the window open rather than dropping the edit
 * (review 6, finding 1). `persist` is responsible for clearing `dirty.current`
 * only on a confirmed success.
 */
export function flushPendingLibrary(
  timer: TimerRef,
  dirty: { current: boolean },
  persist: () => Promise<boolean>,
): Promise<boolean> {
  if (timer.current !== null) {
    clearTimeout(timer.current);
    timer.current = null;
  }
  return dirty.current ? persist() : Promise.resolve(true);
}

/**
 * Writes library items to `POST /library` and reports whether the write was
 * durably persisted. Clears `dirty.current` **only** on a confirmed `2xx` — a
 * non-2xx status or a rejected fetch leaves the dirty flag set so the edit is
 * retried by a later flush rather than acknowledged and lost (review 6,
 * finding 1).
 *
 * Extracted (and parameterised on `fetchFn`) so the failure paths are unit
 * testable without a DOM or a live server.
 *
 * ## Returns
 * `true` when the server confirmed the write; `false` on any HTTP error or
 * network failure.
 */
export async function persistLibraryItems(
  items: LibraryItems,
  dirty: { current: boolean },
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn("/library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "excalidrawlib",
        version: 2,
        libraryItems: items,
      }),
    });
    if (res.ok) {
      dirty.current = false;
      return true;
    }
    // Non-2xx (e.g. Rust returns 500 when there is no config dir or the write
    // fails): keep the edit dirty so a later flush retries it.
    return false;
  } catch {
    // Server gone / network error: keep dirty so close/unmount can retry.
    return false;
  }
}

/**
 * The minimal Excalidraw imperative-API surface the external-reload path needs.
 * A `Pick` of the real API so the component passes `apiRef.current` with no cast;
 * tests supply a structural fake via `as unknown as ReloadSceneApi`.
 */
export type ReloadSceneApi = Pick<
  ExcalidrawImperativeAPI,
  "getAppState" | "addFiles" | "updateScene" | "getSceneElements" | "getFiles"
>;

/**
 * Side-effecting hooks the reload uses to re-baseline dirty bookkeeping. In the
 * component these wrap the relevant refs and `reportDirty`; in tests they record
 * the transitions so the no-dirty invariant can be asserted.
 */
export interface ReloadBookkeeping {
  /** Record the accepted scene's fingerprint as the new clean baseline. */
  setBaselineHash(hash: string): void;
  /** Clear the dirty flag, reset the max-wait clock, and cancel pending saves. */
  clearDirty(): void;
  /** Report a clean, no-pending-save state to Rust (lastSavedAt untouched). */
  reportClean(): void;
}

/** Outcome of {@link applyExternalReload}. */
export type ReloadOutcome = "skipped-editing" | "applied";

/**
 * Applies an externally-changed scene (from `GET /data` after an SSE event) as a
 * clean baseline transition rather than a user edit (review 3, finding 2).
 *
 * Steps:
 * 1. Bail out while the user is mid-text-edit so the editor isn't clobbered.
 * 2. Register embedded files, then `updateScene` the elements plus only the
 *    persisted/visual appState from disk — never viewport pan/zoom or theme.
 * 3. Re-baseline: fingerprint the live post-update scene as the new clean
 *    baseline (so the onChange this triggers no-ops), clear dirty/timers, and
 *    report clean. This prevents the reloaded scene from being seen as a fresh
 *    edit and, under auto-save, written straight back over the external change.
 */
export function applyExternalReload(
  api: ReloadSceneApi,
  newData: ExcalidrawInitialDataState,
  book: ReloadBookkeeping,
): ReloadOutcome {
  if (api.getAppState().editingTextElement) return "skipped-editing";

  if (newData.files) api.addFiles(Object.values(newData.files));

  const appStatePatch = pickPersistedAppState(newData.appState);
  // The literal is cast to updateScene's (generic) param type: a Partial appState
  // is a deliberate subset and Excalidraw merges it over the live appState.
  api.updateScene({
    elements: newData.elements,
    ...(Object.keys(appStatePatch).length > 0
      ? { appState: appStatePatch }
      : {}),
  } as Parameters<ReloadSceneApi["updateScene"]>[0]);

  book.setBaselineHash(
    computeSceneHash(api.getSceneElements(), api.getAppState(), api.getFiles()),
  );
  book.clearDirty();
  book.reportClean();
  return "applied";
}

/**
 * The library items to seed the panel (and the native "Export Library…" mirror)
 * with on mount. Returns the persisted items from `initialData` when present,
 * else an empty list — so exporting before any `onLibraryChange` still writes the
 * saved library rather than an empty one.
 */
export function initialLibraryItems(
  initialData: ExcalidrawInitialDataState | null | undefined,
): LibraryItems {
  const items = initialData?.libraryItems;
  return Array.isArray(items) ? (items as LibraryItems) : [];
}

// ── Disk revision tracking (conditional-save contract) ───────────────────────
//
// The disk file is the persisted interchange between this viewer and every
// external editor (Zed, git, CLI tools). The viewer speaks about disk in
// *revisions* — opaque strong ETag strings it echoes byte-for-byte in
// `If-Match` and never parses or computes locally.

/**
 * Tracks the two disk revisions the conditional-save contract needs:
 *
 * - `accepted` — the revision of the snapshot the viewer last *accepted* (the
 *   initial `GET /data`, including an empty file, or the revision produced by a
 *   successful reload application or viewer write). This is the viewer's
 *   baseline; it advances only on confirmed success, never speculatively.
 * - `expectedOverwrite` — set only by an explicit "Keep my changes" decision,
 *   authorizing exactly one subsequent write to replace that disk revision.
 *   It is consumed by the write it authorizes and never outlives it.
 *
 * This is strictly disk bookkeeping; the scene fingerprint (`prevHashRef`)
 * remains a separate concept and must never be conflated with a revision.
 */
export class RevisionTracker {
  private acceptedRevisionValue: string | null = null;
  private expectedOverwriteValue: string | null = null;

  /** Seeds the accepted revision from the initial `GET /data` ETag. */
  seed(revision: string): void {
    this.acceptedRevisionValue = revision;
  }

  /** The revision of the last snapshot the viewer accepted, if any yet. */
  acceptedRevision(): string | null {
    return this.acceptedRevisionValue;
  }

  /** The revision a "Keep my changes" decision authorized overwriting, if any. */
  expectedOverwriteRevision(): string | null {
    return this.expectedOverwriteValue;
  }

  /**
   * The `If-Match` header value for the next canonical write: the authorized
   * overwrite revision when one is pending, else the accepted revision. Read at
   * write time (after export) so a queued follow-up write always carries the
   * revision acknowledged by the write that preceded it.
   */
  writeHeader(): string | null {
    return this.expectedOverwriteValue ?? this.acceptedRevisionValue;
  }

  /**
   * Whether `revision` is one this viewer has already accepted or explicitly
   * authorized — i.e. observing it on disk demands no fresh decision. This is
   * what replaces time-based echo suppression: a viewer write's own revision is
   * *proven* known the moment it is acknowledged.
   */
  isKnown(revision: string): boolean {
    return (
      revision === this.acceptedRevisionValue ||
      revision === this.expectedOverwriteValue
    );
  }

  /**
   * A viewer write succeeded and the server returned the written revision:
   * adopt it as the new accepted revision. The authorized overwrite (if this
   * write was the one "Keep my changes" authorized) is consumed.
   */
  writeAccepted(revision: string): void {
    this.acceptedRevisionValue = revision;
    this.expectedOverwriteValue = null;
  }

  /**
   * An external snapshot was successfully applied through the guarded reload
   * path: its revision becomes the accepted baseline. Any pending "Keep my
   * changes" authorization is invalidated — it spoke about a disk version that
   * no longer exists.
   */
  acceptedFromReload(revision: string): void {
    this.acceptedRevisionValue = revision;
    this.expectedOverwriteValue = null;
  }

  /**
   * "Keep my changes": authorize exactly one future write to replace
   * `revision`. The accepted baseline deliberately does **not** move — the
   * viewer still holds unsaved work against the older baseline, and a *second*
   * external revision landing afterwards must produce a fresh conflict rather
   * than be overwritten.
   */
  authorizeOverwrite(revision: string): void {
    this.expectedOverwriteValue = revision;
  }
}

/**
 * Serializes viewer saves through a single promise chain so the async
 * export + conditional POST of one save can never interleave with (or land
 * after) a newer save's. Operations run strictly in enqueue order; a rejected
 * operation never poisons the queue for the ones behind it.
 */
export class SaveQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(op: () => Promise<T>): Promise<T> {
    // `then(op, op)`: run after the predecessor settles, success or failure.
    const run = this.tail.then(op, op);
    // Swallow the outcome for chaining purposes only; `run` still rejects for
    // the actual caller.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Pause-aware wrapper around the auto-save scheduling rules. While paused
 * (a conflict is pending, or "Keep my changes" is awaiting an explicit save)
 * no automatic flush of any kind fires: the debounce is cancelled, new edits
 * do not schedule, and interactive flushes (pointer-up / blur) are told not
 * to proceed. Resuming does not fire a save by itself — the next edit or the
 * follow-up logic after a successful explicit save drives that.
 */
export class AutoSaveScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly state: AutoSaveState = {
    firstDirtyAt: null,
    maxWaitSaveInFlight: false,
  };
  private pausedValue = false;

  constructor(
    private readonly opts: {
      debounceMs: number;
      maxWaitMs: number;
      save: (reason: "autosave" | "maxwait") => void;
    },
  ) {}

  /** Pause every automatic flush and cancel any pending debounce timer. */
  pause(): void {
    this.pausedValue = true;
    this.cancelPendingTimer();
    this.state.firstDirtyAt = null;
  }

  /** Resume automatic flushes after the pause reason cleared. */
  resume(): void {
    this.pausedValue = false;
  }

  isPaused(): boolean {
    return this.pausedValue;
  }

  /** Whether an interactive flush (pointer-up / blur / close) should run now. */
  shouldFlush(): boolean {
    return !this.pausedValue;
  }

  /**
   * A dirtying edit arrived. Applies the debounce / bounded max-wait rules
   * ({@link decideAutoSaveSchedule}); a no-op while paused.
   */
  noteEdit(now: number = Date.now()): void {
    if (this.pausedValue) return;
    const schedule = decideAutoSaveSchedule(now, this.opts.maxWaitMs, this.state);
    this.cancelPendingTimer();
    if (schedule === "flush-maxwait") {
      this.opts.save("maxwait");
    } else {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.opts.save("autosave");
      }, this.opts.debounceMs);
    }
  }

  /**
   * Arms a one-shot follow-up debounce (used after a save that finished with
   * newer edits already pending). Replaces any pending timer.
   */
  armFollowUp(): void {
    if (this.pausedValue) return;
    this.cancelPendingTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.opts.save("autosave");
    }, this.opts.debounceMs);
  }

  /** Cancels the pending debounce timer; returns whether one was pending. */
  cancelPending(): boolean {
    if (this.timer === null) return false;
    this.cancelPendingTimer();
    return true;
  }

  /** Clears the max-wait in-flight guard once a dispatched flush settles. */
  clearMaxWaitInFlight(): void {
    this.state.maxWaitSaveInFlight = false;
  }

  /**
   * The scene became clean (a save matched the latest edits, or an external
   * reload was applied): reset the max-wait clock. Does not touch the pause.
   */
  noteClean(): void {
    this.state.firstDirtyAt = null;
  }

  /**
   * The scene is dirty as of `now` (e.g. newer edits landed while a save was
   * in flight): restart the max-wait window from this moment.
   */
  markDirtyNow(now: number = Date.now()): void {
    this.state.firstDirtyAt = now;
  }

  /** Whether a debounce timer is currently armed. */
  isPending(): boolean {
    return this.timer !== null;
  }

  private cancelPendingTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * The scene fingerprint to seed `prevHashRef` with on mount, so the first
 * `onChange` Excalidraw fires immediately (with the unchanged loaded scene)
 * isn't mistaken for a real edit. Computed synchronously from `initialData` —
 * during the first render, before any `onChange` can run — to avoid the effect
 * vs. first-`onChange` ordering race (finding 6).
 */
export function seedHashFromInitialData(
  initialData: ExcalidrawInitialDataState | null | undefined,
  name?: string,
): string {
  // `<Excalidraw name={name}>` injects `appState.name`, which is a persisted key
  // in the fingerprint. `initialData` (from loadFromBlob) carries no such name,
  // so unless we fold the prop in here the very first `onChange` — emitted with
  // `name` already set — hashes differently from the seed and the scene reads as
  // dirty the instant it opens, with zero edits. Merge it so the seed matches.
  const appState =
    name === undefined
      ? initialData?.appState
      : { ...(initialData?.appState ?? {}), name };
  return computeSceneHash(
    (initialData?.elements ?? []) as readonly ExcalidrawElement[],
    appState,
    initialData?.files,
  );
}
