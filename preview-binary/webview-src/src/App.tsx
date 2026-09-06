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
  decideSaveOutcome,
  flushPendingLibrary,
  initialLibraryItems,
  persistLibraryItems,
  seedHashFromInitialData,
  AutoSaveScheduler,
  SaveQueue,
} from "./dirty-state";
import {
  SyncController,
  type ConflictReason,
  type SnapshotResult,
  type SyncUiState,
} from "./sync-controller";
import { ConflictBanner, ConflictModal } from "./conflict-ui";
import type {
  NativeLibraryOptions,
  NativeSaveOptions,
  NativeSaveResult,
} from "./native-bridge";

/** The disk-sync surface main.tsx drives from the SSE stream. */
export interface SyncHooks {
  /** Reconcile disk now (SSE `reload`, (re)connection, broadcast lag). */
  reconcile(reason: ConflictReason): void;
  /** The `editor-closed` attention signal: reconcile first, then escalate. */
  editorClosed(): void;
}

interface AppProps {
  initialData: ExcalidrawInitialDataState;
  name: string;
  contentType: string;
  /** When true, saves to disk after every element change (debounced 300 ms). */
  autoSave: boolean;
  /** When true (empty file on disk), write the blank scene in the declared format once on mount. */
  bootstrapSave: boolean;
  /**
   * The ETag of the initial `GET /data` response — the accepted disk revision
   * the viewer starts from (empty files included).
   */
  initialRevision: string;
  /**
   * The URL of the canonical file endpoint (`/data`, plus the dev-mode `?file=`
   * param). Every canonical GET/POST of scene data goes through it.
   */
  dataUrl: string;
  /**
   * Parses disk bytes into scene data using the declared format first and the
   * other two as fallbacks. Shared with main.tsx's initial load.
   */
  parseDiskBytes(bytes: ArrayBuffer): Promise<ExcalidrawInitialDataState>;
  onApiReady: (api: ExcalidrawImperativeAPI) => void;
  /** Called once with the SSE-facing sync hooks once the controller exists. */
  onSyncReady: (hooks: SyncHooks) => void;
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
  name,
  contentType,
  autoSave,
  bootstrapSave,
  initialRevision,
  dataUrl,
  parseDiskBytes,
  onApiReady,
  onSyncReady,
}: AppProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  // The document's color mode: a single flag that drives the editor canvas
  // theme, the baked rendering of the saved .excalidraw.svg/.png, and every
  // export (it IS appState.exportWithDarkMode, which image exports and the
  // right-click "Copy as SVG" already read). Seeded from the loaded scene —
  // main.tsx resolves it from the file's baked mode / OS theme before mount —
  // and kept in sync by handleChange and the toggle.
  const [exportDarkMode, setExportDarkMode] = useState<boolean>(() =>
    Boolean(
      (initialData.appState as { exportWithDarkMode?: boolean } | undefined)
        ?.exportWithDarkMode,
    ),
  );
  // Fingerprint of the last-observed scene (elements + files + meaningful
  // appState). Used to ignore viewport-only / selection-only onChange events.
  // Strictly a *scene* concept — never a disk revision (see SyncController).
  //
  // Seeded synchronously from the initial scene during the first render — before
  // any onChange can fire — so the initial onChange Excalidraw emits with the
  // unchanged loaded scene isn't mistaken for a real edit. (A useEffect would
  // race that first onChange; finding 6.)
  const prevHashRef = useRef<string | null>(null);
  if (prevHashRef.current === null) {
    // Seed WITH the `name` prop: it lands in `appState.name` (a fingerprinted
    // key) before the first onChange, so omitting it here would falsely mark a
    // just-opened, unedited scene as dirty.
    prevHashRef.current = seedHashFromInitialData(initialData, name);
  }
  // Whether the scene has unsaved edits relative to disk. Mirrored to Rust via
  // POST /dirty on every transition so native code can decide on close/save.
  // /dirty reports are advisory only — never load-bearing for protecting
  // edits or gating writes.
  const dirtyRef = useRef<boolean>(false);
  // Number of serialized save operations currently executing (queue → export →
  // conditional POST). The sync controller reads it as its live `isSaving`.
  const savingCountRef = useRef<number>(0);
  // Monotonic id assigned to each save when it starts, and the highest id that
  // has already *completed*. Together they let an out-of-order save response
  // recognise it was superseded by a newer save and leave dirty state alone
  // (finding 5).
  const saveSeqRef = useRef<number>(0);
  const lastCompletedSaveSeqRef = useRef<number>(0);
  // True on the onChange after a text edit ended; drives the deferred-reload
  // retry (a reload deferred mid-edit is re-decided, never discarded).
  const wasEditingRef = useRef<boolean>(false);

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
  const libraryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  /** Reports the current dirty state to Rust. Fire-and-forget, advisory. */
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

  // doSave is referenced by the scheduler before its declaration completes;
  // indirection through a ref keeps the wiring acyclic.
  const doSaveRef = useRef<
    (opts?: NativeSaveOptions) => Promise<NativeSaveResult>
  >(() => Promise.resolve({ ok: false, error: "save not ready" }));

  // The pause-aware auto-save scheduler. Paused while a conflict is pending or
  // a "Keep my changes" acknowledgment awaits its explicit save — no debounce,
  // max-wait, pointer-up or blur flush fires while paused.
  const schedulerRef = useRef<AutoSaveScheduler | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = new AutoSaveScheduler({
      debounceMs: SAVE_DEBOUNCE_MS,
      maxWaitMs: SAVE_MAX_WAIT_MS,
      save: (reason) => {
        void doSaveRef.current({ reason });
      },
    });
  }

  // The disk-sync controller: revision tracking, reconciliation, conditional
  // writes and the conflict lifecycle. All I/O injected; see sync-controller.ts.
  const controllerRef = useRef<SyncController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new SyncController({
      fetchSnapshot: async (): Promise<SnapshotResult> => {
        try {
          const res = await fetch(dataUrl);
          if (!res.ok) return { ok: false, status: res.status };
          const revision = res.headers.get("ETag");
          if (!revision) {
            // The contract pairs bytes with their ETag; a 200 without one is a
            // broken server, not an empty drawing.
            return { ok: false, status: 0 };
          }
          return { ok: true, revision, bytes: await res.arrayBuffer() };
        } catch {
          return { ok: false, status: 0 };
        }
      },
      parseSnapshot: (bytes) => parseDiskBytes(bytes),
      isDirty: () => dirtyRef.current,
      isEditing: () =>
        Boolean(apiRef.current?.getAppState().editingTextElement),
      isSaving: () => savingCountRef.current > 0,
      applyExternalScene: (data) => {
        const api = apiRef.current;
        if (!api) return "skipped-editing";
        return applyExternalReload(api, data, {
          setBaselineHash: (hash) => {
            prevHashRef.current = hash;
          },
          clearDirty: () => {
            dirtyRef.current = false;
            schedulerRef.current?.noteClean();
            schedulerRef.current?.cancelPending();
          },
          // Leave lastSavedAt unset — this is an external change, not a save by
          // this WebView, so the last-save timestamp must not move.
          reportClean: () => reportDirty(false, false),
        });
      },
    });
    controllerRef.current.seedAccepted(initialRevision);
  }

  // UI-facing mirror of the controller state (banner / modal / error).
  const [syncUi, setSyncUi] = useState<SyncUiState>(() =>
    controllerRef.current!.snapshot(),
  );
  useEffect(() => controllerRef.current!.subscribe(setSyncUi), []);

  // Serialize saves through one queue so the async export + conditional POST
  // of one save can never land after a newer save's.
  const saveQueueRef = useRef<SaveQueue | null>(null);
  if (saveQueueRef.current === null) {
    saveQueueRef.current = new SaveQueue();
  }

  // Pause every automatic write while a conflict is pending or a "Keep my
  // changes" acknowledgment is active; resume (and re-arm a follow-up if edits
  // landed while paused) once neither applies.
  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (!scheduler) return;
    if (syncUi.conflict !== null || syncUi.keepNotice) {
      scheduler.pause();
    } else if (scheduler.isPaused()) {
      scheduler.resume();
      if (autoSave && dirtyRef.current) scheduler.armFollowUp();
    }
  }, [syncUi.conflict, syncUi.keepNotice, autoSave]);

  useEffect(() => {
    onSyncReady({
      reconcile: (reason: ConflictReason) => {
        void controllerRef.current?.reconcile(reason);
      },
      editorClosed: () => {
        void controllerRef.current?.editorClosed();
      },
    });
  }, [onSyncReady]);

  /**
   * Serializes the current scene and conditionally POSTs it to /data through
   * the save queue. Every canonical write carries `If-Match` with the accepted
   * (or Keep-authorized) revision, read at write time — after export — so a
   * queued follow-up save always speaks the revision its predecessor
   * acknowledged. Returns the outcome so native callers (menu Save,
   * close-confirm) can react; on success the dirty flag clears and Rust is
   * told. On a 412 the controller raises the pending conflict, dirty state is
   * left untouched, and the failure is reported (a close flow keeps the
   * window open instead of overwriting the newer disk version).
   */
  const doSave = useCallback(
    async (opts?: NativeSaveOptions): Promise<NativeSaveResult> => {
      const api = apiRef.current;
      if (!api) return { ok: false, error: "Editor not ready" };
      const controller = controllerRef.current!;

      // Tag this save so an out-of-order response can tell whether a newer save
      // has completed in the meantime (finding 5).
      const mySeq = ++saveSeqRef.current;
      // Compact, non-modal save indicator. Skipped for the one-time bootstrap
      // write and for automatic writes paused by a pending decision.
      const showIndicator = opts?.reason !== "bootstrap";

      try {
        return await saveQueueRef.current!.enqueue(
          async (): Promise<NativeSaveResult> => {
            savingCountRef.current += 1;
            try {
              if (showIndicator) {
                api.setToast({
                  message: "Saving…",
                  duration: 60000,
                  closable: false,
                });
              }

              const elements = api.getSceneElements();
              const appState = api.getAppState();
              const files = api.getFiles();
              // Fingerprint of exactly what we're about to persist. Compared
              // against the latest observed hash when the POST resolves so a
              // save that finishes *after* newer edits arrived can't mark the
              // scene clean and drop them.
              const savedHash = computeSceneHash(elements, appState, files);

              let body: BodyInit;
              let contentTypeHeader: string;

              if (contentType === "image/svg+xml") {
                const nonDeleted = elements.filter((e) => !e.isDeleted);
                // exportEmbedScene: true writes the scene JSON into the file so
                // it can be re-opened and edited. Without it, saving an
                // .excalidraw.svg strips the scene and the file becomes an
                // unloadable plain image.
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
                  // Embed the scene so the .excalidraw.png round-trips back
                  // into the editor.
                  appState: { ...appState, exportEmbedScene: true },
                  files,
                  getDimensions(width: number, height: number) {
                    const scale =
                      (appState as { exportScale?: number }).exportScale ?? 2;
                    return { width: width * scale, height: height * scale, scale };
                  },
                });
                if (!blob) {
                  return { ok: false, error: "PNG export produced no data" };
                }
                body = await blob.arrayBuffer();
                contentTypeHeader = "image/png";
              } else {
                body = serializeAsJSON(elements, appState, files, "local");
                contentTypeHeader = "application/json";
              }

              const write = await controller.attemptViewerWrite({
                body,
                contentType: contentTypeHeader,
                reason: opts?.reason ?? "manual",
                send: async ({ ifMatch, body: outgoing, contentType: ct }) => {
                  try {
                    const res = await fetch(dataUrl, {
                      method: "POST",
                      headers: { "Content-Type": ct, "If-Match": ifMatch },
                      body: outgoing,
                    });
                    if (res.ok) {
                      const etag = res.headers.get("ETag");
                      return etag
                        ? { kind: "ok", etag }
                        : {
                            kind: "error",
                            message:
                              "Save succeeded but the server sent no revision — not advancing the accepted baseline",
                          };
                    }
                    if (res.status === 412) {
                      return {
                        kind: "conflict",
                        etag: res.headers.get("ETag") ?? "",
                      };
                    }
                    if (res.status === 428) {
                      return {
                        kind: "error",
                        message: "Save failed (HTTP 428: missing If-Match)",
                        preconditionRequired: true,
                      };
                    }
                    return {
                      kind: "error",
                      message: `Save failed: HTTP ${res.status}`,
                    };
                  } catch (e) {
                    return {
                      kind: "error",
                      message: e instanceof Error ? e.message : String(e),
                    };
                  }
                },
              });

              if (write.kind !== "ok") {
                if (write.kind === "blocked") {
                  if (write.reason === "conflict-pending") {
                    // Nothing writes while a conflict is pending — the user
                    // must resolve it first. Report failure so a close flow
                    // keeps the window open and the conflict stays surfaced.
                    if (showIndicator) {
                      api.setToast({
                        message: "Resolve the file conflict before saving",
                        duration: 4000,
                      });
                    }
                    return { ok: false, error: "file conflict pending" };
                  }
                  if (write.reason === "automatic-paused") {
                    // Automatic flush while a Keep acknowledgment is active:
                    // expected — stay quiet unless an indicator is showing.
                    if (showIndicator) {
                      api.setToast({ message: "Save paused — next save replaces the disk version", duration: 3000 });
                    }
                    return { ok: false, error: "automatic saves paused" };
                  }
                  return { ok: false, error: write.reason };
                }
                if (write.kind === "conflict") {
                  if (showIndicator) {
                    api.setToast({
                      message:
                        "File changed on disk — Reload it or keep your changes",
                      duration: 5000,
                    });
                  }
                  return { ok: false, error: write.error };
                }
                if (showIndicator) {
                  api.setToast({ message: write.error, duration: 5000 });
                }
                return { ok: false, error: write.error };
              }

              // Decide dirty bookkeeping *before* the toast: the write
              // succeeded, but if newer edits landed mid-flight the latest
              // scene is still dirty, so a "Saved" status would mislead about
              // a stale snapshot (review 6, finding 3). Only report "Saved"
              // when this response leaves the scene actually clean.
              const decision = decideSaveOutcome({
                savedHash,
                currentHash: prevHashRef.current,
                autoSave,
                mySeq,
                lastCompletedSeq: lastCompletedSaveSeqRef.current,
              });

              if (decision.superseded) {
                // A newer save already resolved and owns the dirty state —
                // don't touch it. Report cleanliness from the live flag so a
                // waiting close flow still gets an accurate answer.
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
                schedulerRef.current?.noteClean();
                reportDirty(false, false, Date.now());
                if (showIndicator) {
                  api.setToast({ message: "Saved", duration: 1200 });
                }
                return { ok: true };
              }

              // Newer edits landed mid-flight — stay dirty so close-confirm
              // still fires, and restart the max-wait window from now.
              schedulerRef.current?.markDirtyNow();
              reportDirty(true, decision.rescheduleSave, Date.now());
              if (decision.rescheduleSave) {
                schedulerRef.current?.armFollowUp();
              }
              // The snapshot reached disk, but the live scene has moved on —
              // keep the indicator honest rather than flashing "Saved" for a
              // stale write. The follow-up auto-save (or close retry) reports
              // the final success.
              if (showIndicator) {
                api.setToast({ message: "Unsaved changes", duration: 1500 });
              }
              // Not safe to close: the latest scene is not yet on disk.
              // Reported as a non-fatal "pending" so a close-and-save flow
              // retries rather than closing over the unsaved edit (findings
              // 1 + 2).
              return {
                ok: false,
                error: "newer edits pending",
                pendingNewerEdits: true,
              };
            } finally {
              savingCountRef.current -= 1;
              // Retry a reload deferred while this save was in flight.
              controllerRef.current?.saveSettled();
              if (opts?.reason === "maxwait") {
                schedulerRef.current?.clearMaxWaitInFlight();
              }
            }
          },
        );
      } catch (e) {
        // Export/serialization threw, or the queue op rejected outside the
        // handled paths. The scene stays dirty so the edit isn't silently lost.
        const error = e instanceof Error ? e.message : String(e);
        if (showIndicator) {
          apiRef.current?.setToast({ message: "Save failed", duration: 5000 });
        }
        return { ok: false, error };
      }
    },
    [autoSave, contentType, dataUrl, reportDirty],
  );

  useEffect(() => {
    doSaveRef.current = doSave;
  }, [doSave]);

  // New empty file: persist a valid blank scene in the declared format (JSON
  // files are already bootstrapped server-side; this covers .excalidraw.svg /
  // .excalidraw.png). The conditional write matches the empty-file revision
  // the initial GET accepted.
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
        // Flush here too so the doSave fallback (bridge not yet registered)
        // still cancels the debounce; the bridge flushes itself otherwise.
        schedulerRef.current?.cancelPending();
        void (window.__excalidrawSave ?? doSave)({ reason: "keyboard" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [doSave]);

  /**
   * onChange — tracks dirty state across elements, appState, and files, and
   * (when auto-save is enabled) debounces a save through the pause-aware
   * scheduler. No-ops on viewport / selection-only events because those don't
   * alter the scene hash. Also detects the end of a text edit so a reload
   * deferred mid-edit is retried.
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

      // Keep the menu toggle's label in step with the live export-dark-mode
      // flag (it's part of the persisted appState, so it only changes on a
      // real edit — here, past the no-op hash guard). setState bails out when
      // unchanged.
      const liveExportDark = Boolean(
        (appState as { exportWithDarkMode?: boolean }).exportWithDarkMode,
      );
      setExportDarkMode((prev) => (prev === liveExportDark ? prev : liveExportDark));

      if (!dirtyRef.current) {
        dirtyRef.current = true;
        reportDirty(true, autoSave);
      }

      // A reload deferred while the user was mid-text-edit is re-decided now
      // (never discarded).
      const editing = Boolean(appState.editingTextElement);
      if (wasEditingRef.current && !editing) {
        controllerRef.current?.editingEnded();
      }
      wasEditingRef.current = editing;

      if (!autoSave) return;
      schedulerRef.current?.noteEdit();
    },
    [autoSave, reportDirty],
  );

  // Auto-save flush triggers: end of a draw stroke (pointerup) and the user
  // switching away (window blur). Both clear any pending debounce and save
  // immediately when the scene is dirty, so edits aren't left unsaved at a
  // natural stopping point. Blocked while the scheduler is paused (a conflict
  // is pending or a Keep acknowledgment is active). No-op when auto-save is
  // off.
  useEffect(() => {
    if (!autoSave) return;
    const flush = () => {
      const scheduler = schedulerRef.current;
      if (!scheduler || !scheduler.shouldFlush()) return;
      if (!dirtyRef.current) return;
      scheduler.cancelPending();
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
   * Flips the document's color mode (appState.exportWithDarkMode) — the single
   * flag driving the editor canvas theme, the baked rendering of the saved
   * .excalidraw.svg/.png, every image/SVG export, and the right-click "Copy as
   * SVG". Applied via updateScene (a real appState edit), so it persists with
   * the scene, re-themes the canvas, and saves like any other edit.
   */
  const toggleExportDarkMode = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const next = !api.getAppState().exportWithDarkMode;
    api.updateScene({ appState: { exportWithDarkMode: next } });
    api.setToast({
      message: `Color mode: ${next ? "Dark" : "Light"}`,
      duration: 1500,
    });
  }, []);

  /**
   * Copies the current scene as an SVG to the system clipboard, honoring the
   * export color mode (appState.exportWithDarkMode). Routes the SVG to Rust's
   * `POST /copy-clipboard` (native OS clipboard) instead of `navigator.clipboard`
   * because WKWebView rejects the page's async clipboard write once the SVG has
   * been generated — the same limitation that breaks Excalidraw's built-in
   * "Copy to clipboard as SVG" in the embedded window.
   */
  const handleCopySvgToClipboard = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    const appState = api.getAppState();
    try {
      const elements = api.getSceneElements().filter((e) => !e.isDeleted);
      if (elements.length === 0) {
        api.setToast({ message: "Nothing to copy", duration: 1500 });
        return;
      }
      const svg = await exportToSvg({ elements, appState, files: api.getFiles() });
      const res = await fetch("/copy-clipboard", {
        method: "POST",
        headers: { "Content-Type": "image/svg+xml" },
        body: svg.outerHTML,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      api.setToast({
        message: `Copied SVG to clipboard (${appState.exportWithDarkMode ? "dark" : "light"})`,
        duration: 2000,
      });
    } catch (e) {
      api.setToast({
        message: `Copy to clipboard failed: ${e instanceof Error ? e.message : String(e)}`,
        duration: 4000,
      });
    }
  }, []);

  /**
   * Writes the given library items to the shared library file and resolves to
   * whether the write durably succeeded. The dirty flag is cleared **only** on
   * a confirmed `2xx` — a `500` or rejected fetch leaves it set so the edit is
   * retried by a later flush rather than acknowledged and lost (review 6,
   * finding 1).
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
      if (schedulerRef.current?.cancelPending()) {
        reportDirty(dirtyRef.current, false);
      }

      // The close flow is a native confirmation flow: while it runs, the sync
      // controller defers any conflict-modal escalation so two prompts never
      // fight for the keyboard. The save itself is conditional; on a 412 it
      // reports failure (window stays open) with the conflict surfaced.
      const isClose = opts?.reason === "close";
      if (isClose) controllerRef.current?.notifyNativeCloseFlow(true);
      let result: NativeSaveResult;
      try {
        result = await doSave(opts);
        if (isClose) {
          let attempts = 0;
          let current = result;
          // Close-and-save must not report success while the scene is still
          // dirty from edits that landed mid-save. Re-save (bounded) so the
          // very latest scene reaches disk before the window is allowed to
          // close (findings 1+2). A 412 conflict is NOT retried — it is a hard
          // failure that leaves the window open for the user to resolve.
          while (
            !current.ok &&
            current.pendingNewerEdits &&
            attempts < CLOSE_SAVE_MAX_RETRIES
          ) {
            attempts++;
            // Drop any debounced auto-save so the retry is the authoritative save.
            schedulerRef.current?.cancelPending();
            current = await doSave(opts);
          }
          // Make any pending library edit/import durable before the window
          // exits. A failed library write must block a clean close just like
          // an unsaved scene would, so the user isn't told "saved" over a lost
          // library (review 6, finding 1).
          const libraryPersisted = await flushLibrary();
          if (current.ok && !libraryPersisted) {
            current = { ok: false, error: "Library write failed" };
          }
          result = current;
        }
      } finally {
        if (isClose) controllerRef.current?.notifyNativeCloseFlow(false);
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

    // Apply queued "Browse libraries" installs. Fired by the SSE `library` event
    // after the user clicked "Add to Excalidraw" on libraries.excalidraw.com: the
    // server fetched the raw document(s) and parked them, and we now merge each
    // into the panel. Excalidraw's updateLibrary parses a Blob in either the v1
    // (`library`) or v2 (`libraryItems`) shape, so no format handling lives here.
    // The resulting onLibraryChange persists the merged set via handleLibraryChange.
    window.__excalidrawApplyPendingLibraries = async (): Promise<void> => {
      const api = apiRef.current;
      if (!api) return;
      try {
        const res = await fetch("/pending-library");
        if (!res.ok) return;
        const { libraries } = (await res.json()) as { libraries?: unknown };
        if (!Array.isArray(libraries) || libraries.length === 0) return;
        for (const raw of libraries as string[]) {
          const merged = await api.updateLibrary({
            libraryItems: new Blob([raw], { type: "application/json" }),
            merge: true,
            openLibraryMenu: true,
          });
          libraryItemsRef.current = merged;
        }
      } catch {
        // server gone / malformed library — leave the panel as-is
      }
    };

    // Live dirty-state query for the native close flow. Reports the *current*
    // dirtyRef (ok:true ⇒ no unsaved changes ⇒ safe to close) so native code
    // decides from truth rather than a possibly-stale POST /dirty (finding 2).
    // Runs while the native close-confirmation flow is active.
    window.__excalidrawPrepareClose = async (
      opts?: NativeSaveOptions,
    ): Promise<NativeSaveResult> => {
      controllerRef.current?.notifyNativeCloseFlow(true);
      let result: NativeSaveResult;
      try {
        // Flush any pending library edit/import before the window is allowed
        // to close, even when the scene itself is clean (review 5, finding 1).
        // A failed library write keeps the window open — report not-clean so
        // the edit isn't silently dropped (review 6, finding 1).
        const libraryPersisted = await flushLibrary();
        result = {
          ok: !dirtyRef.current && libraryPersisted,
          ...(libraryPersisted ? {} : { error: "Library write failed" }),
        };
      } finally {
        controllerRef.current?.notifyNativeCloseFlow(false);
      }
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
            // `/library` write must report `ok: false` (and keep the merged
            // items dirty for a later flush) rather than claim success over a
            // lost write (review 6, finding 1).
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
      delete window.__excalidrawApplyPendingLibraries;
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
      <ConflictBanner
        state={syncUi}
        onReloadFromDisk={() => void controllerRef.current?.resolveReload()}
        onKeepMyChanges={() => controllerRef.current?.resolveKeep()}
        onRetryError={() => controllerRef.current?.retryError()}
      />
      <ConflictModal
        open={syncUi.modalRevision !== null}
        onKeep={() => controllerRef.current?.resolveKeep()}
        onReload={() => void controllerRef.current?.resolveReload()}
        onDismiss={() => controllerRef.current?.dismissModal()}
      />
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
          onApiReady(api);
        }}
        initialData={{ ...initialData, scrollToContent: true }}
        // Editor canvas follows the document's color mode (WYSIWYG): a dark
        // document opens on a dark canvas, matching how the saved file renders.
        theme={exportDarkMode ? "dark" : "light"}
        name={name}
        // Point the built-in "Browse libraries" round-trip at our server's
        // landing page instead of excalidraw.com. The libraries site opens in
        // the system browser and its "Add to Excalidraw" button returns here as
        // `…/library-install#addLibrary=<url>`; that page hands the URL to the
        // server, which fetches it and pushes it back over SSE (the `library`
        // event runs __excalidrawApplyPendingLibraries below).
        libraryReturnUrl={`${window.location.origin}/library-install`}
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
          <MainMenu.Item onSelect={() => void handleExport("svg-scene")}>
            Export editable SVG (.excalidraw.svg)
          </MainMenu.Item>
          <MainMenu.Item onSelect={() => void handleExport("scene")}>
            Export scene (.excalidraw)
          </MainMenu.Item>
          <MainMenu.Item onSelect={toggleExportDarkMode}>
            {`Color mode: ${exportDarkMode ? "Dark" : "Light"}`}
          </MainMenu.Item>
          <MainMenu.Item onSelect={() => void handleCopySvgToClipboard()}>
            Copy SVG to clipboard
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
