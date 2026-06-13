import { exportToSvg, exportToBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type ExportKind = "png" | "png2x" | "svg" | "scene";

/** Maps an export kind to the suggested file name shown in the native save dialog. */
export function exportFilename(baseName: string, kind: ExportKind): string {
  switch (kind) {
    case "png":
    case "png2x":
      return `${baseName}.png`;
    case "svg":
      return `${baseName}.svg`;
    case "scene":
      return `${baseName}.excalidraw`;
  }
}

interface ExportPayload {
  body: BodyInit;
  mime: string;
}

async function buildExportPayload(
  api: ExcalidrawImperativeAPI,
  kind: ExportKind,
): Promise<ExportPayload> {
  const elements = api.getSceneElements();
  const appState = api.getAppState();
  const files = api.getFiles();

  switch (kind) {
    case "svg": {
      const svg = await exportToSvg({ elements, appState, files });
      return { body: svg.outerHTML, mime: "image/svg+xml" };
    }
    case "png":
    case "png2x": {
      const scale = kind === "png2x" ? 2 : 1;
      const blob = await exportToBlob({
        elements,
        appState,
        files,
        getDimensions: (width: number, height: number) => ({
          width: width * scale,
          height: height * scale,
          scale,
        }),
      });
      if (!blob) throw new Error("PNG export produced no data");
      return { body: await blob.arrayBuffer(), mime: "image/png" };
    }
    case "scene":
      return { body: serializeAsJSON(elements, appState, files, "local"), mime: "application/json" };
  }
}

/**
 * Exports the scene and POSTs it to the Rust server, which shows a native save dialog.
 * Returns the written path, or null if the user cancelled the dialog.
 */
export async function postExport(
  api: ExcalidrawImperativeAPI,
  baseName: string,
  kind: ExportKind,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const { body, mime } = await buildExportPayload(api, kind);
  const res = await fetchFn(`/export?name=${encodeURIComponent(exportFilename(baseName, kind))}`, {
    method: "POST",
    headers: { "Content-Type": mime },
    body,
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  return await res.text();
}
