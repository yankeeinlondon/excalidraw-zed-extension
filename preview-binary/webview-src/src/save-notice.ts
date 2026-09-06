// The "why nothing was saved" notice, for every page state in which the React
// app — and therefore `window.__excalidrawSave` and Excalidraw's own toast —
// does not exist: the read-only image preview (an SVG/PNG with no embedded
// scene never mounts the editor), a failed load, and the pre-mount window.
//
// Before this existed, the native File → Save item and its `Cmd/Ctrl+S`
// accelerator dispatched `window.__excalidrawSave && …`, which in those states
// evaluated to nothing at all: the gesture was a complete silent no-op
// (main.rs `SAVE_MENU_SCRIPT`; spec §2.3 forbids silence — every explicit save
// gesture must produce a positive or negative observable outcome).
//
// All I/O is injected (presentation, timers, the global target) so the routing
// is unit-testable without a DOM, mirroring `readonly-image.ts` and
// `sync-controller.ts`. The DOM implementation of `present` lives in
// `main.tsx`, next to the other page-shell rendering.

/** How long the notice stays up before it dismisses itself. */
export const SAVE_NOTICE_DURATION_MS = 4000;

/** Message shown before the drawing has finished loading (nothing to save yet). */
export const SAVE_NOTICE_LOADING =
  "Nothing to save yet — the drawing is still loading.";

/** Message shown in the read-only image preview (no scene to save). */
export const SAVE_NOTICE_READONLY =
  'Read-only preview — no embedded scene to save. Re-export with "Embed scene" enabled to edit.';

/** Message shown when the file could not be loaded at all. */
export const SAVE_NOTICE_LOAD_FAILED =
  "Nothing to save — this file could not be loaded.";

/** Injected I/O for {@link createSaveUnavailableNotice}. */
export interface SaveNoticeDeps {
  /**
   * Displays `message` to the user and returns the function that removes it
   * again. Called once per visible notice; a `notify` while one is already up
   * updates nothing but restarts the dismissal timer.
   */
  present(message: string): () => void;
  /** `window.setTimeout` */
  setTimer(fn: () => void, ms: number): number;
  /** `window.clearTimeout` */
  clearTimer(id: number): void;
  /** Initial message; defaults to {@link SAVE_NOTICE_LOADING}. */
  message?: string;
  /** Visible duration in ms; defaults to {@link SAVE_NOTICE_DURATION_MS}. */
  durationMs?: number;
}

/** The transient notice shown for save gestures that have nothing to save. */
export interface SaveUnavailableNotice {
  /**
   * Shows the notice (or restarts its timer if it is already up). `source` is
   * the gesture that triggered it ("menu", "keyboard", …) and is accepted only
   * so native callers can pass one; it does not change the message.
   */
  notify(source?: string): void;
  /**
   * Replaces the message used by subsequent {@link notify} calls — the page
   * knows *why* saving is unavailable (still loading vs. read-only vs. load
   * failed), the native side does not.
   */
  setMessage(message: string): void;
  /** The message the next {@link notify} would show. */
  currentMessage(): string;
  /** Removes a visible notice and cancels its timer. */
  dismiss(): void;
}

/**
 * Creates the notice used by every save gesture that reaches a page with no
 * editor behind it. Repeated gestures never stack notices: the visible one is
 * kept and its dismissal timer restarted.
 *
 * ## Examples
 *
 * ```ts
 * const notice = createSaveUnavailableNotice({ present, setTimer, clearTimer });
 * notice.setMessage(SAVE_NOTICE_READONLY);
 * notice.notify("menu"); // → present(SAVE_NOTICE_READONLY)
 * ```
 */
export function createSaveUnavailableNotice(
  deps: SaveNoticeDeps,
): SaveUnavailableNotice {
  let message = deps.message ?? SAVE_NOTICE_LOADING;
  const duration = deps.durationMs ?? SAVE_NOTICE_DURATION_MS;
  let remove: (() => void) | null = null;
  let timer: number | null = null;

  const dismiss = () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
    if (remove) {
      remove();
      remove = null;
    }
  };

  return {
    notify() {
      if (timer !== null) {
        deps.clearTimer(timer);
        timer = null;
      }
      if (!remove) remove = deps.present(message);
      timer = deps.setTimer(() => {
        timer = null;
        if (remove) {
          remove();
          remove = null;
        }
      }, duration);
    },
    setMessage(next: string) {
      message = next;
    },
    currentMessage: () => message,
    dismiss,
  };
}

/**
 * The window surface {@link installSaveUnavailableBridge} touches. Kept
 * structural so tests can pass a plain object instead of a DOM window.
 */
export interface SaveNoticeTarget {
  /** Present only while the React app is mounted (see `native-bridge.ts`). */
  __excalidrawSave?: unknown;
  /** Installed by {@link installSaveUnavailableBridge}. */
  __excalidrawSaveUnavailable?: (source?: string) => void;
  addEventListener(
    type: "keydown",
    handler: (event: SaveNoticeKeyEvent) => void,
  ): void;
}

/** The subset of `KeyboardEvent` the fallback handler reads. */
export interface SaveNoticeKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
}

/**
 * Registers the notice as the save fallback for both delivery paths that can
 * reach a page without an editor:
 *
 * - `window.__excalidrawSaveUnavailable`, which the native File → Save script
 *   calls when `__excalidrawSave` is absent (macOS/Windows menu + accelerator);
 * - a page-level `Cmd/Ctrl+S` keydown listener, which is the delivery path on
 *   Linux (no native menu) and the pre-mount path everywhere.
 *
 * The keydown listener defers to the editor whenever `__excalidrawSave` exists,
 * so it never double-saves and never competes with `App.tsx`'s own handler —
 * the menu accelerator stays authoritative on macOS (spec §2.4, not reversed).
 */
export function installSaveUnavailableBridge(
  target: SaveNoticeTarget,
  notice: SaveUnavailableNotice,
): void {
  target.__excalidrawSaveUnavailable = (source?: string) => notice.notify(source);
  target.addEventListener("keydown", (event: SaveNoticeKeyEvent) => {
    if (event.key !== "s" || !(event.ctrlKey || event.metaKey)) return;
    // The editor owns the gesture whenever it is mounted.
    if (target.__excalidrawSave) return;
    event.preventDefault();
    notice.notify("keyboard");
  });
}
