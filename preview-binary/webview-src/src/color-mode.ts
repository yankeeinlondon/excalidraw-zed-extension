// Document color-mode detection helpers.
//
// Excalidraw strips `appState.exportWithDarkMode` from the scene it embeds in an
// exported SVG/PNG (its storage config marks the key `export: false`), so the
// mode can't round-trip on its own. On load we recover it from the file's baked
// rendering instead. For SVG that's an exact signal: excalidraw stamps a
// dark-mode export's root element with `<svg filter="invert(93%)
// hue-rotate(180deg)">`.

/** The CSS filter excalidraw applies to a dark-mode SVG export's root `<svg>`. */
export const EXCALIDRAW_DARK_SVG_FILTER = "invert(93%) hue-rotate(180deg)";

/**
 * Whether an exported `.excalidraw.svg`'s raw bytes carry excalidraw's dark-mode
 * marker. Decodes as UTF-8 and checks for {@link EXCALIDRAW_DARK_SVG_FILTER};
 * a light-mode export omits the filter entirely.
 */
export function svgBytesAreDarkMode(bytes: ArrayBuffer): boolean {
  return new TextDecoder().decode(bytes).includes(EXCALIDRAW_DARK_SVG_FILTER);
}
