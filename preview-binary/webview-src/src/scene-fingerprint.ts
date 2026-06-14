// Pure helpers for the scene "dirty" fingerprint.
//
// A change is "real" (and so marks the scene dirty / triggers an auto-save) when
// it alters anything `serializeAsJSON(elements, appState, files, "local")` would
// write to disk: the element graph, the embedded file registry (including a file
// entry whose data is populated under an existing id), and the persisted /
// export-related appState. Viewport pan/zoom and selection are deliberately
// excluded so navigating around never reports the scene as dirty.

import { hashElementsVersion } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState as ExcalidrawAppState,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

/**
 * FNV-1a 32-bit hash of a string, returned as zero-padded hex. Cheap and
 * dependency-free — used to fingerprint large file data URLs without keeping the
 * full base64 payload in the hash.
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The appState keys that are persisted to disk or affect exports, and therefore
 * count toward dirtiness. Mirrors the export-relevant subset of Excalidraw's
 * `cleanAppStateForExport`; kept explicit so a viewport/selection change never
 * leaks in. Update this list if a new persisted/export setting is added.
 */
export const PERSISTED_APP_STATE_KEYS = [
  "viewBackgroundColor",
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "exportBackground",
  "exportEmbedScene",
  "exportScale",
  "exportWithDarkMode",
  "name",
  "frameRendering",
] as const;

/**
 * Extracts only the persisted/export-relevant appState keys from a scene loaded
 * from disk, as a partial appState patch. Used by the external-reload path to
 * apply visual settings that changed on disk (e.g. `viewBackgroundColor`, grid,
 * export options) via `updateScene` while leaving viewport pan/zoom, selection,
 * and theme — none of which appear here — untouched.
 */
export function pickPersistedAppState(
  appState: Partial<ExcalidrawAppState> | null | undefined,
): Partial<ExcalidrawAppState> {
  const patch: Record<string, unknown> = {};
  if (!appState) return patch as Partial<ExcalidrawAppState>;
  for (const key of PERSISTED_APP_STATE_KEYS) {
    const value = (appState as Record<string, unknown>)[key];
    if (value !== undefined) patch[key] = value;
  }
  return patch as Partial<ExcalidrawAppState>;
}

/** Stable fingerprint of the persisted/export-relevant appState keys. */
export function computeAppStateFingerprint(
  appState: Partial<ExcalidrawAppState> | null | undefined,
): string {
  if (!appState) return "";
  const parts: string[] = [];
  for (const key of PERSISTED_APP_STATE_KEYS) {
    const value = (appState as Record<string, unknown>)[key];
    if (value === undefined) continue;
    // `frameRendering` (and any future object setting) is stringified so nested
    // changes are captured; primitives stringify to themselves.
    parts.push(`${key}=${JSON.stringify(value)}`);
  }
  return parts.join("&");
}

/**
 * Stable fingerprint of the embedded file registry. Includes each file's id,
 * mime type, and a hash of its data URL so that *populating* or *replacing* the
 * data under an existing id is detected — not just adding/removing ids.
 */
export function computeFilesFingerprint(
  files: BinaryFiles | null | undefined,
): string {
  if (!files) return "";
  const ids = Object.keys(files).sort();
  const parts: string[] = [];
  for (const id of ids) {
    const file = files[id] as
      | { dataURL?: string; mimeType?: string }
      | undefined;
    const dataUrl = file?.dataURL ?? "";
    const mime = file?.mimeType ?? "";
    parts.push(`${id}:${mime}:${dataUrl.length}:${fnv1a(dataUrl)}`);
  }
  return parts.join(",");
}

/**
 * Fingerprint of the parts of the scene that constitute a "real" change for
 * dirty-tracking: the element graph, the embedded files, and the persisted /
 * export-related appState. Excludes viewport pan/zoom and selection.
 */
export function computeSceneHash(
  elements: readonly ExcalidrawElement[],
  appState: Partial<ExcalidrawAppState> | null | undefined,
  files: BinaryFiles | null | undefined,
): string {
  const elementsHash = hashElementsVersion(elements);
  const filesKey = computeFilesFingerprint(files);
  const appStateKey = computeAppStateFingerprint(appState);
  return `${elementsHash}|${filesKey}|${appStateKey}`;
}
