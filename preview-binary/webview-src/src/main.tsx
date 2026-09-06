import ReactDOM from "react-dom/client";
import { loadFromBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import App, { type SyncHooks } from "./App";
import { svgBytesAreDarkMode } from "./color-mode";
import { createAppSseHandler, createReadonlySseHandler } from "./sse-events";

interface Config {
  contentType: string;
  name: string;
  theme: string;
  autoSave: boolean;
}

function showError(message: string) {
  const el = document.getElementById("error");
  if (el) {
    el.textContent = message;
    el.style.display = "block";
  }
}

function reorderFallbacks(primary: string): string[] {
  const all = ["application/json", "image/svg+xml", "image/png"];
  return [primary, ...all.filter((t) => t !== primary)];
}

function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let id: ReturnType<typeof setTimeout>;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
}

// In dev mode (Vite), a ?file=/path/to/diagram.excalidraw query param can be
// passed in the browser URL to preview any local file without restarting the
// dev server.  In production the Rust server already knows the file, so this
// param is never present and the plain paths are used.
const fileParam = new URLSearchParams(window.location.search).get("file");
function apiUrl(path: string): string {
  return fileParam ? `${path}?file=${encodeURIComponent(fileParam)}` : path;
}

/**
 * Parses disk bytes into scene data: the declared format first, then the other
 * two as fallbacks (extension is authoritative; the chain handles mismatches).
 * Rejects when every fallback fails. Shared by the initial load and every
 * disk reconciliation so both speak the same parsing rules.
 */
async function parseDiskBytesWithFallbacks(
  bytes: ArrayBuffer,
  contentType: string,
): Promise<ExcalidrawInitialDataState> {
  let lastError: unknown = new Error("no fallback attempted");
  for (const type of reorderFallbacks(contentType)) {
    try {
      return await loadFromBlob(new Blob([bytes], { type }), null, null);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * Read-only preview for an SVG/PNG that has no embedded Excalidraw scene.
 * Renders the raw image centered in the window with a small banner, and live-
 * reloads the image when the file changes on disk (via the same SSE stream).
 * The SSE handler responds to `reload` only — every other event name
 * (including `editor-closed`) is ignored; a read-only preview has no scene to
 * conflict and never shows a conflict dialog.
 */
function renderReadonlyImage(
  bytes: ArrayBuffer,
  type: string,
  theme: string,
  dataUrl: string,
  eventsUrl: string,
): void {
  const root = document.getElementById("root");
  if (!root) return;

  const dark = theme === "dark";
  const wrap = document.createElement("div");
  wrap.style.cssText = `position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:${dark ? "#121212" : "#ffffff"};`;

  const img = document.createElement("img");
  img.alt = "Excalidraw image preview (read-only)";
  img.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;display:block;";
  let currentUrl = URL.createObjectURL(new Blob([bytes], { type }));
  img.src = currentUrl;
  wrap.appendChild(img);
  root.appendChild(wrap);

  const banner = document.createElement("div");
  banner.textContent =
    'Read-only preview — no embedded Excalidraw scene. Re-export with "Embed scene" enabled to edit.';
  banner.style.cssText = `position:fixed;top:0;left:0;right:0;padding:6px 12px;font:13px/1.4 system-ui,-apple-system,sans-serif;background:${dark ? "#3a3413" : "#fff8c5"};color:${dark ? "#e8d98a" : "#4d3800"};border-bottom:1px solid ${dark ? "#5c5320" : "#e6d27a"};z-index:10;`;
  document.body.appendChild(banner);

  // Live-reload the image on external file changes.
  const es = new EventSource(eventsUrl);
  const readonlyHandler = createReadonlySseHandler({
    onReload: debounce(async () => {
      try {
        const res = await fetch(dataUrl);
        if (!res.ok) return;
        const next = await res.arrayBuffer();
        const nextUrl = URL.createObjectURL(new Blob([next], { type }));
        img.src = nextUrl;
        URL.revokeObjectURL(currentUrl);
        currentUrl = nextUrl;
      } catch {
        // transient fetch failure; keep showing the last good image
      }
    }, 150),
  });
  es.onmessage = (event: MessageEvent<string>) => readonlyHandler(event.data);
}

/** Loads an object-URL into an HTMLImageElement, resolving once decoded. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Best-effort detection of a PNG's baked color mode by sampling its background.
 * Excalidraw bakes dark mode into PNG pixels (a canvas filter), leaving no
 * metadata, so we read a near-corner pixel — the export background — and treat a
 * dark, opaque pixel as dark mode. Returns null when it can't tell (transparent
 * background or decode failure), so the caller falls back to another signal.
 */
async function detectPngDarkMode(bytes: ArrayBuffer): Promise<boolean | null> {
  try {
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    try {
      const img = await loadImage(url);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || 1;
      canvas.height = img.naturalHeight || 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0);
      const [r, g, b, a] = ctx.getImageData(1, 1, 1, 1).data;
      if (a < 16) return null; // transparent background — mode is unknowable
      // Rec. 709 luminance; a dark background means the scene was exported dark.
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

/**
 * Detects the color mode baked into a viewable Excalidraw file, so reopening it
 * restores the document's mode instead of resetting to light (excalidraw strips
 * `exportWithDarkMode` from the embedded scene, so it can't round-trip on its
 * own). Returns null for formats with no baked rendering (plain `.excalidraw`
 * JSON) or when the mode can't be determined.
 *
 * - SVG: excalidraw marks a dark export with a root `<svg filter="invert(93%)
 *   hue-rotate(180deg)">`, so the substring's presence is an exact signal.
 * - PNG: sampled from pixels (see {@link detectPngDarkMode}).
 */
async function detectDocumentDarkMode(
  bytes: ArrayBuffer,
  contentType: string,
): Promise<boolean | null> {
  if (contentType === "image/svg+xml") {
    return svgBytesAreDarkMode(bytes);
  }
  if (contentType === "image/png") {
    return detectPngDarkMode(bytes);
  }
  return null;
}

async function main() {
  try {
    const configRes = await fetch(apiUrl("/config"));
    if (!configRes.ok)
      throw new Error(`Failed to fetch config: ${configRes.status}`);
    const config: Config = await configRes.json();

    // Resolve "auto" to a concrete value once, here, before React mounts.
    // This prevents useOsTheme from re-calling matchMedia on HMR remounts,
    // which returns false in WebKitGTK (no system dark-mode wiring).
    if (config.theme === "auto") {
      config.theme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }

    const dataUrl = apiUrl("/data");
    const dataRes = await fetch(dataUrl);
    if (!dataRes.ok) throw new Error(`Failed to fetch data: ${dataRes.status}`);
    // The accepted disk revision this viewer starts from — including for an
    // empty file. Every conditional save sends it (or a later acknowledged
    // revision) as `If-Match`; it is opaque and echoed byte-for-byte.
    const initialRevision = dataRes.headers.get("ETag") ?? "";
    const bytes = await dataRes.arrayBuffer();

    // Shared shape library — failure is non-fatal (e.g. dev-mode mock has no /library).
    let libraryItems: unknown[] = [];
    try {
      const libRes = await fetch(apiUrl("/library"));
      if (libRes.ok) {
        const lib = (await libRes.json()) as { libraryItems?: unknown[] };
        libraryItems = lib.libraryItems ?? [];
      }
    } catch {
      // library persistence unavailable; start with an empty panel
    }

    const parseDiskBytes = (diskBytes: ArrayBuffer) =>
      parseDiskBytesWithFallbacks(diskBytes, config.contentType);

    let initialData: ExcalidrawInitialDataState | null = null;
    // Empty file (new .excalidraw.svg/.excalidraw.png drawing): start with a blank
    // scene and let App write the proper format to disk on its bootstrap save.
    const isEmptyFile = bytes.byteLength === 0 ||
      new TextDecoder().decode(bytes).trim().length === 0;

    if (isEmptyFile) {
      initialData = { elements: [], appState: {}, files: {} };
    } else {
      initialData = await parseDiskBytes(bytes).catch(() => null);
    }

    if (!initialData) {
      // No embedded Excalidraw scene (e.g. an SVG/PNG exported without "Embed
      // scene"). Rather than erroring, fall back to a read-only static preview of
      // the raw image so the user still sees something. Editing is unavailable
      // because there is no scene to reconstruct.
      if (config.contentType === "image/svg+xml" || config.contentType === "image/png") {
        renderReadonlyImage(bytes, config.contentType, config.theme, dataUrl, apiUrl("/events"));
        return;
      }
      showError("Failed to load file: all format fallbacks failed");
      return;
    }

    // Resolve the document's color mode and bake it into appState BEFORE mount,
    // so the editor canvas, the toggle, and the next save all agree from frame
    // one (and the dirty seed matches). Priority: the file's baked mode → any
    // mode the embedded scene carried → the resolved OS/config theme. An empty
    // (new) file has no baked mode, so it inherits the OS/config theme.
    const detectedDark = isEmptyFile
      ? null
      : await detectDocumentDarkMode(bytes, config.contentType);
    const documentDark =
      detectedDark ??
      (initialData.appState as { exportWithDarkMode?: boolean } | undefined)
        ?.exportWithDarkMode ??
      config.theme === "dark";
    initialData = {
      ...initialData,
      appState: { ...initialData.appState, exportWithDarkMode: documentDark },
    };

    // The disk-sync hooks App's controller exposes: reconciliation on SSE
    // events and (re)connection, plus the `editor-closed` attention signal.
    let syncHooks: SyncHooks | null = null;

    const root = document.getElementById("root");
    if (!root) return;

    ReactDOM.createRoot(root).render(
      <App
        initialData={{ ...initialData, libraryItems: libraryItems as ExcalidrawInitialDataState["libraryItems"] }}
        name={config.name}
        contentType={config.contentType}
        autoSave={config.autoSave}
        bootstrapSave={isEmptyFile}
        initialRevision={initialRevision}
        dataUrl={dataUrl}
        parseDiskBytes={parseDiskBytes}
        onApiReady={() => {}}
        onSyncReady={(hooks) => {
          syncHooks = hooks;
        }}
      />,
    );

    // SSE live reload. Events are dispatched explicitly by name — unknown
    // names are ignored, `library` never touches the scene, `reload` triggers
    // a reconciliation (bytes + revision fetched together), and
    // `editor-closed` reconciles first and then escalates any pending
    // conflict. Echoes of the viewer's own writes are suppressed by revision
    // (the controller recognizes the acknowledged revision), never by a clock.
    // The browser reconnects the EventSource automatically; every (re)open
    // reconciles, so a missed event can't leave the view silently stale.
    const es = new EventSource(apiUrl("/events"));
    es.onopen = () => {
      syncHooks?.reconcile("watcher");
    };
    const appHandler = createAppSseHandler({
      onReload: () => {
        syncHooks?.reconcile("watcher");
      },
      onLibrary: () => {
        void window.__excalidrawApplyPendingLibraries?.();
      },
      onEditorClosed: () => {
        syncHooks?.editorClosed();
      },
    });
    es.onmessage = (event: MessageEvent<string>) => appHandler(event.data);
  } catch (e) {
    showError(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main();
