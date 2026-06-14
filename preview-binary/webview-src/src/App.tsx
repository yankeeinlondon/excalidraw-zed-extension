import { useState, useEffect, useCallback, useRef } from "react";
import {
  Excalidraw,
  MainMenu,
  serializeAsJSON,
  exportToSvg,
  exportToBlob,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type {
  ExcalidrawInitialDataState,
  ExcalidrawImperativeAPI,
  AppState as ExcalidrawAppState,
  BinaryFiles,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { postExport, type ExportKind } from "./export";
import { computeSceneHash } from "./scene-fingerprint";
import {
  applyExternalReload,
  decideAutoSaveSchedule,
  decideSaveOutcome,
  flushPendingLibrary,
  flushPendingSave,
  initialLibraryItems,
  persistLibraryItems,
  seedHashFromInitialData,
  type AutoSaveState,
} from "./dirty-state";
import type {
  NativeLibraryOptions,
  NativeSaveOptions,
  NativeSaveResult,
} from "./native-bridge";

interface AppProps {
  initialData: ExcalidrawInitialDataState;
  theme: string;
  name: string;
  contentType: string;
  /** When true, saves to disk after every element change (debounced 300 ms). */
  autoSave: boolean;
  /** When true (empty file on disk), write the blank scene in the declared format once on mount. */
  bootstrapSave: boolean;
  onApiReady: (api: ExcalidrawImperativeAPI) => void;
  /** Called after a successful save so the SSE listener can suppress the echo. */
  onSaved: (suppressUntil: number) => void;
  /**
   * Called once with a stable `reloadScene` function that the SSE handler can
   * call when an external file change arrives.  The function skips the update
   * when the user is actively editing a text element (prevents mid-edit
   * disruption) and only passes elements + files to updateScene so the
   * current viewport position and theme are never reset.
   */
  onReloadReady: (reload: (data: ExcalidrawInitialDataState) => void) => void;
}

function useOsTheme(preference: "auto" | "light" | "dark"): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (preference !== "auto") return preference;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  useEffect(() => {
    if (preference !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) =>
      setTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preference]);

  return theme;
}

const SAVE_DEBOUNCE_MS = 300;
/**
 * Hard ceiling for a deferred auto-save: during a long continuous gesture the
 * debounce timer keeps getting reset, which would starve the save indefinitely.
 * Once the scene has been dirty for this long, flush immediately even mid-edit
 * so a 10-second drawing produces at least one intermediate save.
 */
const SAVE_MAX_WAIT_MS = 2000;

/**
 * Upper bound on consecutive re-saves a close-and-save flow will attempt when
 * edits keep landing while each save is in flight. Bounds the (pathological)
 * case of the user drawing continuously through a close request so the flow
 * can't spin forever; in practice input has stopped by the time close fires, so
 * one retry converges.
 */
const CLOSE_SAVE_MAX_RETRIES = 5;

/**
 * Debounce for persisting ordinary library-panel edits to the shared
 * `.excalidrawlib`. Native import and the close/unmount flows bypass this and
 * flush immediately so an acknowledged import can't be lost to a quick close
 * (review 5, finding 1).
 */
const LIBRARY_SAVE_DEBOUNCE_MS = 600;

/** macOS uses Cmd; everyone else uses Ctrl. Drives the menu shortcut label. */
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const SAVE_SHORTCUT = IS_MAC ? "Cmd+S" : "Ctrl+S";

/** Best-effort unique id for correlating a native action result. */
function generateRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function App({
  initialData,
  theme,
  name,
  contentType,
  autoSave,
  bootstrapSave,
  onApiReady,
  onSaved,
  onReloadReady,
}: AppProps) {
  const resolvedTheme = useOsTheme(theme as "auto" | "light" | "dark");
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const libraryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fingerprint of the last-observed scene (elements + files + meaningful
  // appState). Used to ignore viewport-only / selection-only onChange events.
  //
  // Seeded synchronously from the initial scene during the first render — before
  // any onChange can fire — so the initial onChange Excalidraw emits with the
  // unchanged loaded scene isn't mistaken for a real edit. (A useEffect would
  // race that first onChange; finding 6.)
  const prevHashRef = useRef<string | null>(null);
  if (prevHashRef.current === null) {
    prevHashRef.current = seedHashFromInitialData(initialData);
  }
  // Whether the scene has unsaved edits relative to disk. Mirrored to Rust via
  // POST /dirty on every transition so native code can decide on close/save.
  const dirtyRef = useRef<boolean>(false);
  // Max-wait / in-flight bookkeeping for the auto-save scheduler. `firstDirtyAt`
  // is the timestamp (ms) of the edit that first made the scene dirty since the
  // last save; `maxWaitSaveInFlight` suppresses overlapping max-wait flushes
  // during a long continuous gesture (review 6, finding 2).
  const autoSaveState = useRef<AutoSaveState>({
    firstDirtyAt: null,
    maxWaitSaveInFlight: false,
  });
  // Monotonic id assigned to each save when it starts, and the highest id that
  // has already *completed*. Together they let an out-of-order save response
  // recognise it was superseded by a newer save and leave dirty state alone
  // (finding 5).
  const saveSeqRef = useRef<number>(0);
  const lastCompletedSaveSeqRef = useRef<number>(0);

  // Latest library items, mirrored from onLibraryChange so the native
  // "Export Library…" action can serialize them without a getter on the API.
  // Seeded from the persisted library passed in initialData so an export that
  // happens before any onLibraryChange event still writes the saved items
  // (not an empty list).
  const libraryItemsRef = useRef<LibraryItems>(
    initialLibraryItems(initialData),
  );
  // True when libraryItemsRef holds edits not yet POSTed to /library (a debounce
  // is pending). Lets the close/unmount flush skip a redundant write when the
  // library is already persisted.
  const libraryDirtyRef = useRef<boolean>(false);

  /**
   * Reports the outcome of a native-triggered action to Rust so a waiting
   * native flow (e.g. save-and-close) can proceed. Fire-and-forget.
   */
  const reportActionResult = useCallback(
    (id: string, action: string, result: NativeSaveResult) =>
      fetch("/native-action-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          action,
          ok: result.ok,
          error: result.error ?? null,
        }),
      }).catch(() => {
        // server gone — native side will time out on its own
      }),
    [],
  );

  /** Reports the current dirty state to Rust. Fire-and-forget. */
  const reportDirty = useCallback(
    (dirty: boolean, pendingSave: boolean, lastSavedAt?: number) => {
      fetch("/dirty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dirty,
          pendingSave,
          lastSavedAt: lastSavedAt ?? null,
        }),
      }).catch(() => {
        // server gone — nothing actionable from the webview
      });
    },
    [],
  );

  // Stable reload function handed to the SSE handler in main.tsx. An external
  // file change (edit in Zed, git checkout, etc.) is applied as a *clean*
  // baseline transition, not a user edit:
  // - Skips if the user is mid-text-edit (prevents text-editor disruption).
  // - Applies persisted/visual appState (background, grid, export settings) from
  //   disk, but never viewport pan/zoom or theme, so the current view is kept.
  // - Re-baselines dirty bookkeeping to the accepted scene: sets prevHashRef so
  //   the onChange this triggers no-ops, clears the dirty flag, cancels any
  //   pending auto-save, and reports clean to Rust. Without this the reloaded
  //   scene would read as a fresh edit and, under auto-save, be written straight
  //   back to disk — overwriting the external change that was just accepted
  //   (review 3, finding 2).
  const reloadScene = useCallback(
    (newData: ExcalidrawInitialDataState) => {
      const api = apiRef.current;
      if (!api) return;
      applyExternalReload(api, newData, {
        setBaselineHash: (hash) => {
          prevHashRef.current = hash;
        },
        clearDirty: () => {
          dirtyRef.current = false;
          autoSaveState.current.firstDirtyAt = null;
          if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
          }
        },
        // Leave lastSavedAt unset — this is an external change, not a save by
        // this WebView, so the last-save timestamp must not move.
        reportClean: () => reportDirty(false, false),
      });
    },
    [reportDirty],
  );

  useEffect(() => {
    onReloadReady(reloadScene);
  }, [onReloadReady, reloadScene]);

  /**
   * Serializes the current scene and POSTs it to /data.
   * Returns the outcome so native callers (menu Save, close-confirm) can react.
   * On success, clears the dirty flag and reports it to Rust.
   */
  const doSave = useCallback(
    async (opts?: NativeSaveOptions): Promise<NativeSaveResult> => {
      const api = apiRef.current;
      if (!api) return { ok: false, error: "Editor not ready" };

      // Tag this save so an out-of-order response can tell whether a newer save
      // has completed in the meantime (finding 5).
      const mySeq = ++saveSeqRef.current;

      // Compact, non-modal save indicator. Skipped for the one-time bootstrap
      // write so opening a fresh file doesn't flash a toast.
      const showIndicator = opts?.reason !== "bootstrap";
      if (showIndicator) {
        api.setToast({ message: "Saving…", duration: 60000, closable: false });
      }

      const elements = api.getSceneElements();
      const appState = api.getAppState();
      const files = api.getFiles();
      // Fingerprint of exactly what we're about to persist. Compared against the
      // latest observed hash when the POST resolves so a save that finishes
      // *after* newer edits arrived can't mark the scene clean and drop them.
      const savedHash = computeSceneHash(elements, appState, files);

      try {
        let body: BodyInit;
        let contentTypeHeader: string;

        if (contentType === "image/svg+xml") {
          const nonDeleted = elements.filter((e) => !e.isDeleted);
          // exportEmbedScene: true writes the scene JSON into the file so it can
          // be re-opened and edited. Without it, saving an .excalidraw.svg strips
          // the scene and the file becomes an unloadable plain image.
          const svg = await exportToSvg({
            elements: nonDeleted,
            appState: { ...appState, exportEmbedScene: true },
            files,
          });
          body = svg.outerHTML;
          contentTypeHeader = "image/svg+xml";
        } else if (contentType === "image/png") {
          const nonDeleted = elements.filter((e) => !e.isDeleted);
          const blob = await exportToBlob({
            elements: nonDeleted,
            // Embed the scene so the .excalidraw.png round-trips back into the editor.
            appState: { ...appState, exportEmbedScene: true },
            files,
            getDimensions(width: number, height: number) {
              const scale =
                (appState as { exportScale?: number }).exportScale ?? 2;
              return { width: width * scale, height: height * scale, scale };
            },
          });
          if (!blob) return { ok: false, error: "PNG export produced no data" };
          body = await blob.arrayBuffer();
          contentTypeHeader = "image/png";
        } else {
          body = serializeAsJSON(elements, appState, files, "local");
          contentTypeHeader = "application/json";
        }

        const res = await fetch("/data", {
          method: "POST",
          headers: { "Content-Type": contentTypeHeader },
          body,
        });
        if (res.ok) {
          onSaved(Date.now() + 2000);

          // Decide dirty bookkeeping *before* the toast: the write succeeded,
          // but if newer edits landed mid-flight the latest scene is still
          // dirty, so a "Saved" status would mislead about a stale snapshot
          // (review 6, finding 3). Only report "Saved" when this response leaves
          // the scene actually clean.
          const decision = decideSaveOutcome({
            savedHash,
            currentHash: prevHashRef.current,
            autoSave,
            mySeq,
            lastCompletedSeq: lastCompletedSaveSeqRef.current,
          });

          if (decision.superseded) {
            // A newer save already resolved and owns the dirty state — don't
            // touch it. Report cleanliness from the live flag so a waiting close
            // flow still gets an accurate answer.
            if (showIndicator) {
              api.setToast(
                dirtyRef.current
                  ? { message: "Unsaved changes", duration: 1500 }
                  : { message: "Saved", duration: 1200 },
              );
            }
            return { ok: !dirtyRef.current };
          }

          lastCompletedSaveSeqRef.current = mySeq;

          if (decision.clearDirty) {
            dirtyRef.current = false;
            autoSaveState.current.firstDirtyAt = null;
            reportDirty(false, false, Date.now());
            if (showIndicator) api.setToast({ message: "Saved", duration: 1200 });
            return { ok: true };
          }

          // Newer edits landed mid-flight — stay dirty so close-confirm still
          // fires, and restart the max-wait window from now.
          autoSaveState.current.firstDirtyAt = Date.now();
          reportDirty(true, decision.rescheduleSave, Date.now());
          if (decision.rescheduleSave) {
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(
              () => void doSave({ reason: "autosave" }),
              SAVE_DEBOUNCE_MS,
            );
          }
          // The snapshot reached disk, but the live scene has moved on — keep the
          // indicator honest rather than flashing "Saved" for a stale write. The
          // follow-up auto-save (or close retry) reports the final success.
          if (showIndicator) {
            api.setToast({ message: "Unsaved changes", duration: 1500 });
          }
          // Not safe to close: the latest scene is not yet on disk. Reported as
          // a non-fatal "pending" so a close-and-save flow retries rather than
          // closing over the unsaved edit (findings 1 + 2).
          return {
            ok: false,
            error: "newer edits pending",
            pendingNewerEdits: true,
          };
        }
        if (showIndicator) {
          api.setToast({
            message: `Save failed (HTTP ${res.status})`,
            duration: 5000,
          });
        }
        return { ok: false, error: `Save failed: HTTP ${res.status}` };
      } catch (e) {
        // Network errors (preview server may have shut down) surface to the
        // caller; the scene stays dirty so the edit isn't silently lost.
        const error = e instanceof Error ? e.message : String(e);
        if (showIndicator) {
          apiRef.current?.setToast({ message: "Save failed", duration: 5000 });
        }
        return { ok: false, error };
      }
    },
    [autoSave, contentType, onSaved, reportDirty],
  );

  // New empty file: persist a valid blank scene in the declared format (JSON files are
  // already bootstrapped server-side; this covers .excalidraw.svg / .excalidraw.png).
  useEffect(() => {
    if (bootstrapSave) {
      void doSave({ reason: "bootstrap" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Ctrl+S / Cmd+S — always triggers an immediate save. Routes through the
   * native bridge (window.__excalidrawSave) so keyboard, native menu, and the
   * canvas menu all converge on one save path. Falls back to doSave directly
   * if the bridge hasn't registered yet.
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        // Flush here too so the doSave fallback (bridge not yet registered) still
        // cancels the debounce; the bridge flushes itself otherwise.
        flushPendingSave(saveTimer);
        void (window.__excalidrawSave ?? doSave)({ reason: "keyboard" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [doSave]);

  /**
   * onChange — tracks dirty state across elements, appState, and files, and
   * (when autoSave is enabled) debounces a save. No-ops on viewport /
   * selection-only events because those don't alter the scene hash.
   */
  const handleChange = useCallback(
    (
      elements: readonly ExcalidrawElement[],
      appState: ExcalidrawAppState,
      files: BinaryFiles,
    ) => {
      const hash = computeSceneHash(elements, appState, files);
      if (hash === prevHashRef.current) return;
      prevHashRef.current = hash;

      if (!dirtyRef.current) {
        dirtyRef.current = true;
        reportDirty(true, autoSave);
      }

      if (!autoSave) return;
      const schedule = decideAutoSaveSchedule(
        Date.now(),
        SAVE_MAX_WAIT_MS,
        autoSaveState.current,
      );
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (schedule === "flush-maxwait") {
        // Debounce starvation guard: edits have been streaming in past the max
        // wait, so flush now instead of resetting the timer yet again. The
        // scheduler restarted the window and set the in-flight guard; clear that
        // guard once the save settles so the *next* checkpoint can fire (review
        // 6, finding 2).
        saveTimer.current = null;
        void doSave({ reason: "maxwait" }).finally(() => {
          autoSaveState.current.maxWaitSaveInFlight = false;
        });
      } else {
        saveTimer.current = setTimeout(
          () => void doSave({ reason: "autosave" }),
          SAVE_DEBOUNCE_MS,
        );
      }
    },
    [autoSave, doSave, reportDirty],
  );

  // Auto-save flush triggers: end of a draw stroke (pointerup) and the user
  // switching away (window blur). Both clear any pending debounce and save
  // immediately when the scene is dirty, so edits aren't left unsaved at a
  // natural stopping point. No-op when auto-save is off.
  useEffect(() => {
    if (!autoSave) return;
    const flush = () => {
      if (!dirtyRef.current) return;
      flushPendingSave(saveTimer);
      void doSave({ reason: "flush" });
    };
    window.addEventListener("pointerup", flush);
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("pointerup", flush);
      window.removeEventListener("blur", flush);
    };
  }, [autoSave, doSave]);

  /** Exports via the Rust server's native save dialog; shows the outcome in a toast. */
  const handleExport = useCallback(
    async (kind: ExportKind) => {
      const api = apiRef.current;
      if (!api) return;
      try {
        const savedPath = await postExport(api, name, kind);
        if (savedPath) {
          api.setToast({ message: `Exported to ${savedPath}`, duration: 3000 });
        }
        // null = user cancelled the dialog — stay silent.
      } catch (e) {
        api.setToast({
          message: `Export failed: ${e instanceof Error ? e.message : String(e)}`,
          duration: 5000,
        });
      }
    },
    [name],
  );

  /**
   * Writes the given library items to the shared library file and resolves to
   * whether the write durably succeeded. The dirty flag is cleared **only** on a
   * confirmed `2xx`; a `500` or rejected fetch leaves it set so the edit is
   * retried rather than acknowledged and lost (review 6, finding 1). Never
   * rejects — a dead server resolves to `false`.
   */
  const persistLibrary = useCallback(
    (items: LibraryItems): Promise<boolean> =>
      persistLibraryItems(items, libraryDirtyRef),
    [],
  );

  /**
   * Immediately persists any pending library edit, cancelling the debounce.
   * Returns a promise the close/unmount flows await so an acknowledged import or
   * panel edit is durable before the window exits (review 5, finding 1).
   * Resolves to `false` when the write failed so a close flow can keep the
   * window open instead of dropping the edit (review 6, finding 1).
   */
  const flushLibrary = useCallback((): Promise<boolean> => {
    return flushPendingLibrary(libraryTimer, libraryDirtyRef, () =>
      persistLibrary(libraryItemsRef.current),
    );
  }, [persistLibrary]);

  /** Persists library panel changes to the shared library file (debounced). */
  const handleLibraryChange = useCallback(
    (items: LibraryItems) => {
      // Mirror the latest items so the native "Export Library…" action can read them.
      libraryItemsRef.current = items;
      libraryDirtyRef.current = true;
      if (libraryTimer.current) clearTimeout(libraryTimer.current);
      libraryTimer.current = setTimeout(() => {
        libraryTimer.current = null;
        void persistLibrary(items);
      }, LIBRARY_SAVE_DEBOUNCE_MS);
    },
    [persistLibrary],
  );

  // Expose the narrow native bridge: Save, Export, and library Import/Export.
  // Native menu items (Phase 3) dispatch into these globals via evaluate_script;
  // each reports its outcome to /native-action-result so a waiting native flow
  // can proceed. Registered together (and after the callbacks they depend on) so
  // the whole bridge appears and disappears atomically with the React app.
  useEffect(() => {
    window.__excalidrawSave = async (
      opts?: NativeSaveOptions,
    ): Promise<NativeSaveResult> => {
      // The bridge owns the debounce flush so every caller — native menu Save,
      // keyboard, and the close flow — gets identical semantics: cancel any
      // pending auto-save and tell Rust the scheduled save is gone before
      // performing the immediate, authoritative save (review 5, finding 2).
      if (flushPendingSave(saveTimer)) reportDirty(dirtyRef.current, false);

      let result = await doSave(opts);
      // Close-and-save must not report success while the scene is still dirty
      // from edits that landed mid-save. Re-save (bounded) so the very latest
      // scene reaches disk before the window is allowed to close (findings 1+2).
      if (opts?.reason === "close") {
        let attempts = 0;
        while (
          !result.ok &&
          result.pendingNewerEdits &&
          attempts < CLOSE_SAVE_MAX_RETRIES
        ) {
          attempts++;
          // Drop any debounced auto-save so the retry is the authoritative save.
          flushPendingSave(saveTimer);
          result = await doSave(opts);
        }
        // Make any pending library edit/import durable before the window exits.
        // A failed library write must block a clean close just like an unsaved
        // scene would, so the user isn't told "saved" over a lost library
        // (review 6, finding 1).
        const libraryPersisted = await flushLibrary();
        if (result.ok && !libraryPersisted) {
          result = { ok: false, error: "Library write failed" };
        }
      }
      await reportActionResult(
        opts?.requestId ?? generateRequestId(),
        "save",
        result,
      );
      return result;
    };

    window.__excalidrawExport = (kind: string) => {
      void handleExport(kind as ExportKind);
    };

    // Live dirty-state query for the native close flow. Reports the *current*
    // dirtyRef (ok:true ⇒ no unsaved changes ⇒ safe to close) so native code
    // decides from truth rather than a possibly-stale POST /dirty (finding 2).
    window.__excalidrawPrepareClose = async (
      opts?: NativeSaveOptions,
    ): Promise<NativeSaveResult> => {
      // Flush any pending library edit/import before the window is allowed to
      // close, even when the scene itself is clean (review 5, finding 1). A
      // failed library write keeps the window open — report not-clean so the
      // edit isn't silently dropped (review 6, finding 1).
      const libraryPersisted = await flushLibrary();
      const result: NativeSaveResult = {
        ok: !dirtyRef.current && libraryPersisted,
        ...(libraryPersisted ? {} : { error: "Library write failed" }),
      };
      await reportActionResult(
        opts?.requestId ?? generateRequestId(),
        "prepareClose",
        result,
      );
      return result;
    };

    // Import: Rust shows a native .excalidrawlib open dialog and returns the
    // chosen file's bytes (204 = cancelled). We validate the shape before
    // merging so a mis-picked scene file can't corrupt the library panel.
    window.__excalidrawImportLibrary = async (
      opts?: NativeLibraryOptions,
    ): Promise<NativeSaveResult> => {
      const api = apiRef.current;
      const id = opts?.requestId ?? generateRequestId();
      let result: NativeSaveResult;
      try {
        const res = await fetch("/native-library-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (res.status === 204) {
          result = { ok: true }; // user cancelled — silent no-op
        } else if (!res.ok) {
          result = { ok: false, error: `Import failed: HTTP ${res.status}` };
        } else {
          const parsed: unknown = JSON.parse(await res.text());
          const lib = parsed as {
            type?: unknown;
            libraryItems?: unknown;
          };
          if (lib.type !== "excalidrawlib" || !Array.isArray(lib.libraryItems)) {
            api?.setToast({ message: "Not a valid library file", duration: 4000 });
            result = { ok: false, error: "Not a valid library file" };
          } else if (!api) {
            result = { ok: false, error: "Editor not ready" };
          } else {
            // updateLibrary resolves with the merged item list. Persist it
            // immediately and await the write before reporting success, so a
            // close within the debounce window can't drop the import (review 5,
            // finding 1) — we don't rely on the debounced onLibraryChange echo.
            const merged = await api.updateLibrary({
              libraryItems: lib.libraryItems as LibraryItems,
              merge: true,
            });
            libraryItemsRef.current = merged;
            // Only acknowledge the import once the write is durable. A failed
            // `/library` write must report `ok: false` (and keep the merged items
            // dirty for a later flush) rather than claim success over a lost
            // write (review 6, finding 1).
            const persisted = await persistLibrary(merged);
            if (persisted) {
              const count = (lib.libraryItems as LibraryItems).length;
              api.setToast({
                message: `Imported ${count} library item${count === 1 ? "" : "s"}`,
                duration: 3000,
              });
              result = { ok: true };
            } else {
              api.setToast({
                message: "Import failed to save to library",
                duration: 5000,
              });
              result = { ok: false, error: "Library write failed" };
            }
          }
        }
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      await reportActionResult(id, "importLibrary", result);
      return result;
    };

    // Export: serialize the current library and POST it to the existing export
    // dialog path so the user can write a .excalidrawlib file (204 = cancelled).
    window.__excalidrawExportLibrary = async (
      opts?: NativeLibraryOptions,
    ): Promise<NativeSaveResult> => {
      const id = opts?.requestId ?? generateRequestId();
      let result: NativeSaveResult;
      try {
        const payload = JSON.stringify({
          type: "excalidrawlib",
          version: 2,
          libraryItems: libraryItemsRef.current,
        });
        const res = await fetch(
          `/export?name=${encodeURIComponent(`${name}.excalidrawlib`)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
          },
        );
        if (res.status === 204) {
          result = { ok: true }; // user cancelled — silent no-op
        } else if (!res.ok) {
          result = { ok: false, error: `Export failed: HTTP ${res.status}` };
        } else {
          const savedPath = await res.text();
          apiRef.current?.setToast({
            message: `Library exported to ${savedPath}`,
            duration: 3000,
          });
          result = { ok: true };
        }
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      await reportActionResult(id, "exportLibrary", result);
      return result;
    };

    return () => {
      delete window.__excalidrawSave;
      delete window.__excalidrawExport;
      delete window.__excalidrawPrepareClose;
      delete window.__excalidrawImportLibrary;
      delete window.__excalidrawExportLibrary;
    };
  }, [
    doSave,
    handleExport,
    name,
    reportActionResult,
    reportDirty,
    persistLibrary,
    flushLibrary,
  ]);

  // Best-effort: persist any pending library edit when the app unmounts, so a
  // teardown outside the native close flow still flushes the debounce. Fire-and
  // -forget — unmount can't await (review 5, finding 1).
  useEffect(() => {
    return () => {
      void flushLibrary();
    };
  }, [flushLibrary]);

  return (
    <div style={{ height: "100%" }}>
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
          onApiReady(api);
        }}
        initialData={{ ...initialData, scrollToContent: true }}
        theme={resolvedTheme}
        name={name}
        onChange={handleChange}
        onLibraryChange={handleLibraryChange}
      >
        <MainMenu>
          <MainMenu.Item
            onSelect={() => void (window.__excalidrawSave ?? doSave)({ reason: "menu" })}
            shortcut={SAVE_SHORTCUT}
          >
            Save to file
          </MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.Item onSelect={() => void handleExport("png")}>Export PNG</MainMenu.Item>
          <MainMenu.Item onSelect={() => void handleExport("png2x")}>Export PNG (2x)</MainMenu.Item>
          <MainMenu.Item onSelect={() => void handleExport("svg")}>Export SVG</MainMenu.Item>
          <MainMenu.Item onSelect={() => void handleExport("scene")}>
            Export scene (.excalidraw)
          </MainMenu.Item>
          <MainMenu.Separator />
          {/*
            In-WebView library import/export. These call the same native bridge
            globals the macOS/Windows native menu dispatches to, but rendered in
            the canvas menu they are the *only* filtered library entry point on
            Linux (which has no native menu bar); on macOS/Windows they harmlessly
            duplicate the native Library menu. Guarded with `?.` so they no-op
            before the bridge registers.
          */}
          <MainMenu.Item
            onSelect={() => void window.__excalidrawImportLibrary?.({})}
          >
            Import Library…
          </MainMenu.Item>
          <MainMenu.Item
            onSelect={() => void window.__excalidrawExportLibrary?.({})}
          >
            Export Library…
          </MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
