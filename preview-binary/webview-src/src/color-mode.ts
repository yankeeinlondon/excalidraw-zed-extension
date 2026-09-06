// Document color-mode detection and persistence helpers.
//
// Excalidraw strips `appState.exportWithDarkMode` from the scene it embeds in an
// exported SVG/PNG (its storage config marks the key `export: false`), so the
// mode can't round-trip on its own. On load we recover it from the file's baked
// rendering instead. For SVG that's an exact signal: excalidraw stamps a
// dark-mode export's root element with `<svg filter="invert(93%)
// hue-rotate(180deg)">`.
//
// Plain `.excalidraw` JSON has no baked rendering, so the mode travels as the
// literal `appState.exportWithDarkMode` key — written on save by the
// post-serialization injection (`injectExportWithDarkMode`, D1; wired into both
// plain-JSON write sites by `serialize-scene.ts`) and re-attached on load by
// `reattachRawColorMode`, because upstream's `loadFromBlob` strips the key on
// load exactly as `serializeAsJSON` strips it on save.
//
// This module stays free of value imports from @excalidraw/excalidraw so the
// vendored-package proxy test (color-mode-vendored.test.ts) can use it without
// evaluating the whole package.

import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

/** The CSS filter excalidraw applies to a dark-mode SVG export's root `<svg>`. */
export const EXCALIDRAW_DARK_SVG_FILTER = "invert(93%) hue-rotate(180deg)";

/**
 * The colour mode baked into an exported `.excalidraw.svg`'s raw bytes, or
 * `null` when the payload carries no baked rendering to read. Decodes as UTF-8
 * and checks for {@link EXCALIDRAW_DARK_SVG_FILTER}; a light-mode export omits
 * the filter entirely.
 *
 * ## Notes
 *
 * The `null` case is load-bearing, not defensive. The declared content type
 * comes from the file *name* and the client's fallback chain absorbs a
 * mismatch, so bytes handed here may be scene JSON in a file called
 * `.excalidraw.svg`. Those bytes have no baked rendering, and answering
 * `false` for them would out-rank — and silently discard — the
 * `appState.exportWithDarkMode` key the same bytes state, forcing a dark
 * document to reopen light. `null` instead lets the resolution chain fall
 * through to that key, exactly as it already does for a non-PNG payload
 * declared `image/png` (`detectPngDarkMode` returns `null` when it cannot
 * decode). Empty bytes — a brand-new file — are likewise no rendering.
 */
export function svgBytesColorMode(bytes: ArrayBuffer): boolean | null {
  const text = new TextDecoder().decode(bytes);
  if (!text.includes("<svg")) return null;
  return text.includes(EXCALIDRAW_DARK_SVG_FILTER);
}

/**
 * Resolves the document colour mode a file should open in, from the three
 * sources in their documented priority order: the file's baked rendering, then
 * the `appState.exportWithDarkMode` key the scene states, then the resolved
 * OS/config theme.
 *
 * Each source yields only when it has nothing to say — `null` for a payload
 * with no readable baked rendering, an absent (or non-boolean) key for a scene
 * that states no mode — so a file written by an older build, or by another
 * tool, still lands on the theme fallback.
 *
 * ## Examples
 *
 * ```ts
 * resolveDocumentColorMode(true, { exportWithDarkMode: false }, false); // true
 * resolveDocumentColorMode(null, { exportWithDarkMode: true }, false); // true
 * resolveDocumentColorMode(null, {}, true); // true — theme fallback
 * ```
 */
export function resolveDocumentColorMode(
  bakedMode: boolean | null,
  sceneAppState: { exportWithDarkMode?: unknown } | undefined | null,
  themeIsDark: boolean,
): boolean {
  if (bakedMode !== null) return bakedMode;
  const stated = sceneAppState?.exportWithDarkMode;
  if (typeof stated === "boolean") return stated;
  return themeIsDark;
}

/**
 * The document color mode stated by raw plain-JSON scene bytes, read directly
 * off the disk payload — *not* through `loadFromBlob`, which strips the key on
 * load (upstream marks it per-browser state in both directions). Returns the
 * file's `appState.exportWithDarkMode` when the bytes are JSON carrying a
 * boolean under exactly that path, else `undefined`. Never throws: bytes that
 * are not JSON (SVG/PNG payloads, garbage), lack an appState object, or carry a
 * non-boolean value are simply files that state no mode.
 */
export function rawJsonExportWithDarkMode(bytes: ArrayBuffer): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const appState = (parsed as { appState?: unknown }).appState;
    if (typeof appState !== "object" || appState === null) return undefined;
    const value = (appState as { exportWithDarkMode?: unknown })
      .exportWithDarkMode;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load-side repair for D1: re-attaches the color mode the raw bytes state onto
 * scene data that came back from `loadFromBlob`, which strips
 * `appState.exportWithDarkMode` before `restore()` ever sees it. Applied at the
 * one parse chokepoint shared by the initial load and every disk
 * reconciliation, so the documented resolution chain (baked rendering →
 * appState key → OS/config theme) reads the file-stated mode as written.
 *
 * When the bytes state no mode — keyless files, non-JSON payloads — the input
 * is returned **unchanged, as the same object reference**, so keyless-file
 * behavior is provably identical to before D1. Otherwise returns a shallow
 * copy with the mode folded into `appState`; the input is never mutated.
 */
export function reattachRawColorMode(
  data: ExcalidrawInitialDataState,
  bytes: ArrayBuffer,
): ExcalidrawInitialDataState {
  const raw = rawJsonExportWithDarkMode(bytes);
  if (raw === undefined) return data;
  return {
    ...data,
    appState: { ...data.appState, exportWithDarkMode: raw },
  };
}

// ── Save-side injection (D1) ─────────────────────────────────────────────────

/** The appState key carrying the document color mode between sessions. */
const COLOR_MODE_KEY = '"exportWithDarkMode"';

function isWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

function skipWs(s: string, i: number): number {
  while (i < s.length && isWs(s[i])) i++;
  return i;
}

/**
 * Returns the index just past the JSON string token starting at `i` (which must
 * be the opening quote). Escape-aware: `\"` inside the string never terminates
 * it.
 */
function scanStringEnd(s: string, i: number): number {
  i++; // opening quote
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  throw new Error(
    "unterminated string while scanning the serialized scene — refusing to inject",
  );
}

/**
 * Returns the index just past the JSON value starting at `i`. Objects and
 * arrays are matched bracket-by-bracket with string awareness; primitives scan
 * to the next delimiter.
 */
function scanValueEnd(s: string, i: number): number {
  const ch = s[i];
  if (ch === '"') return scanStringEnd(s, i);
  if (ch === "{" || ch === "[") {
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '"') {
        i = scanStringEnd(s, i);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    throw new Error(
      "unbalanced braces while scanning the serialized scene — refusing to inject",
    );
  }
  // Primitive (number / boolean / null): runs until a value delimiter.
  while (i < s.length && !isWs(s[i]) && s[i] !== "," && s[i] !== "}" && s[i] !== "]") {
    i++;
  }
  return i;
}

/**
 * Injects `appState.exportWithDarkMode` into an already-serialized scene
 * string. Pure: no I/O, no parsing of the scene's meaning — a single
 * string-aware, depth-aware scan locates the *top-level* `appState` object and
 * either replaces the value of an existing `exportWithDarkMode` key inside it
 * or inserts the key as its first member. Every byte outside the injected (or
 * replaced) key is preserved verbatim, whatever producer emitted the string —
 * the byte-stability property D1 requires (a parse-and-re-serialize round trip
 * is only *mostly* byte-stable, and producer-independent guarantees beat
 * probabilistic ones on the persistence path).
 *
 * Throws when the payload has no top-level `appState` object or its structure
 * cannot be navigated — a save must fail loudly rather than silently drop the
 * document's color mode.
 */
export function injectExportWithDarkMode(json: string, darkMode: boolean): string {
  let i = skipWs(json, 0);
  if (json[i] !== "{") {
    throw new Error(
      "serialized scene is not a JSON object — cannot inject exportWithDarkMode",
    );
  }
  i++;
  let expectKey = true;
  while (true) {
    i = skipWs(json, i);
    const ch = json[i];
    if (ch === undefined) {
      throw new Error("truncated serialized scene — cannot inject exportWithDarkMode");
    }
    if (expectKey) {
      if (ch === "}") break; // end of the root object; appState never found
      if (ch !== '"') {
        throw new Error(
          "malformed serialized scene (expected an object key) — refusing to inject",
        );
      }
      const keyStart = i;
      const keyEnd = scanStringEnd(json, i);
      const key = json.slice(keyStart, keyEnd);
      i = skipWs(json, keyEnd);
      if (json[i] !== ":") {
        throw new Error(
          "malformed serialized scene (key without a colon) — refusing to inject",
        );
      }
      i = skipWs(json, i + 1);
      const valueEnd = scanValueEnd(json, i);
      if (key === '"appState"') {
        return spliceAppState(json, i, darkMode);
      }
      i = valueEnd;
      expectKey = false;
    } else {
      if (ch === ",") {
        i++;
        expectKey = true;
      } else if (ch === "}") {
        break;
      } else {
        throw new Error(
          "malformed serialized scene (expected , or }) — refusing to inject",
        );
      }
    }
  }
  throw new Error(
    "serialized scene has no top-level appState object — cannot inject exportWithDarkMode",
  );
}

/** Splices the color-mode key into the appState object starting at `start`. */
function spliceAppState(
  json: string,
  start: number,
  darkMode: boolean,
): string {
  if (json[start] !== "{") {
    throw new Error(
      "appState is not a JSON object — cannot inject exportWithDarkMode",
    );
  }
  // Walk appState's own top-level members looking for the key.
  let i = start + 1;
  let expectKey = true;
  while (true) {
    i = skipWs(json, i);
    const ch = json[i];
    if (ch === undefined) {
      throw new Error("truncated appState — refusing to inject");
    }
    if (expectKey) {
      if (ch === "}") break; // key not present → insert below
      if (ch !== '"') {
        throw new Error("malformed appState object — refusing to inject");
      }
      const keyStart = i;
      const keyEnd = scanStringEnd(json, i);
      const key = json.slice(keyStart, keyEnd);
      i = skipWs(json, keyEnd);
      if (json[i] !== ":") {
        throw new Error("malformed appState object — refusing to inject");
      }
      i = skipWs(json, i + 1);
      const valueEnd = scanValueEnd(json, i);
      if (key === COLOR_MODE_KEY) {
        // Replace only this value's span; everything else is byte-identical.
        return json.slice(0, i) + String(darkMode) + json.slice(valueEnd);
      }
      i = valueEnd;
      expectKey = false;
    } else {
      if (ch === ",") {
        i++;
        expectKey = true;
      } else if (ch === "}") {
        break;
      } else {
        throw new Error("malformed appState object — refusing to inject");
      }
    }
  }
  // Key absent: insert it as the first member of appState.
  const afterBrace = start + 1;
  const next = json[skipWs(json, afterBrace)];
  const member = `${COLOR_MODE_KEY}:${darkMode}`;
  // Empty (or whitespace-only) appState takes the member alone; a populated
  // one needs a separator after it.
  const insert = next === "}" ? member : `${member},`;
  return json.slice(0, afterBrace) + insert + json.slice(afterBrace);
}
