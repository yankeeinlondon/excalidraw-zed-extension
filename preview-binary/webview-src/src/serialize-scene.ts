// Plain-JSON scene serialization for canonical writes (D1).
//
// Upstream Excalidraw marks `appState.exportWithDarkMode` as per-browser state
// (`APP_STATE_STORAGE_CONF`: `export: false`) and `cleanAppStateForExport`
// strips it inside `serializeAsJSON` — so a plain `.excalidraw` file can never
// round-trip the document's color mode unaided (the reported defect). This
// module is the single seam both plain-JSON write sites share — canonical save
// (`doSave` in `App.tsx`) and Export-Scene (`buildExportPayload` case `"scene"`
// in `export.ts`) — so every `.excalidraw` body this app POSTs carries the
// mode. The injection itself is a byte-stable text splice living in
// `color-mode.ts` (kept package-free so the vendored proxy test can use it);
// the companion load-side repair (`reattachRawColorMode`) lives there too,
// because upstream strips the key on load through `loadFromBlob` just as it
// does on save.
//
// See fixes/2026-09-05-fix-me-up/decision-log.md, entry D1.

import { serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState as ExcalidrawAppState,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import { injectExportWithDarkMode } from "./color-mode";

/**
 * Serializes a scene for a plain-JSON canonical write: `serializeAsJSON` under
 * `local` export settings, then the document color mode injected per D1. The
 * single seam for both plain-JSON write sites, so every `.excalidraw` body
 * this app POSTs carries `appState.exportWithDarkMode` equal to the editor's
 * mode at save time.
 */
export function serializeSceneForDisk(
  elements: readonly ExcalidrawElement[],
  appState: Partial<ExcalidrawAppState>,
  files: BinaryFiles,
): string {
  return injectExportWithDarkMode(
    serializeAsJSON(elements, appState, files, "local"),
    Boolean(appState?.exportWithDarkMode),
  );
}
