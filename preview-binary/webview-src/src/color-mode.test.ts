import { describe, it, expect } from "vitest";
import {
  EXCALIDRAW_DARK_SVG_FILTER,
  svgBytesColorMode,
  resolveDocumentColorMode,
  rawJsonExportWithDarkMode,
  reattachRawColorMode,
} from "./color-mode";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

const encode = (s: string) => new TextEncoder().encode(s).buffer;

describe("svgBytesColorMode", () => {
  it("detects a dark-mode export by excalidraw's root filter", () => {
    const dark = `<svg version="1.1" filter="${EXCALIDRAW_DARK_SVG_FILTER}"><!-- svg-source:excalidraw --></svg>`;
    expect(svgBytesColorMode(encode(dark))).toBe(true);
  });

  it("treats a light-mode export (no filter) as not dark", () => {
    const light = `<svg version="1.1"><!-- svg-source:excalidraw --><rect/></svg>`;
    expect(svgBytesColorMode(encode(light))).toBe(false);
  });

  it("is null for empty bytes (a brand-new file has no baked rendering)", () => {
    expect(svgBytesColorMode(new ArrayBuffer(0))).toBe(null);
  });

  // Review-1 finding 1: the declared content type comes from the file *name*,
  // so a `.excalidraw.svg` may actually hold scene JSON (the fallback chain
  // documents and supports this). Answering `false` there out-ranked the
  // appState key the same bytes state and reopened a dark document light.
  it("is null for scene-JSON bytes declared as SVG (no baked rendering)", () => {
    const sceneJson = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: { exportWithDarkMode: true },
      files: {},
    });
    expect(svgBytesColorMode(encode(sceneJson))).toBe(null);
  });

  it("is null for a PNG-ish binary payload and for arbitrary garbage", () => {
    expect(svgBytesColorMode(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBe(
      null,
    );
    expect(svgBytesColorMode(encode("not markup at all"))).toBe(null);
  });

  it("still reads an SVG that only names the filter in a nested element", () => {
    // The marker is on the root in practice, but the check is a substring one:
    // pin that an SVG payload always answers a boolean, never null.
    const svg = `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><g filter="${EXCALIDRAW_DARK_SVG_FILTER}"/></svg>`;
    expect(svgBytesColorMode(encode(svg))).toBe(true);
  });
});

describe("resolveDocumentColorMode (the documented priority chain)", () => {
  it("takes the baked rendering first, even against a contrary scene key", () => {
    expect(resolveDocumentColorMode(true, { exportWithDarkMode: false }, false)).toBe(
      true,
    );
    expect(resolveDocumentColorMode(false, { exportWithDarkMode: true }, true)).toBe(
      false,
    );
  });

  it("falls to the scene's appState key when there is no baked rendering", () => {
    expect(resolveDocumentColorMode(null, { exportWithDarkMode: true }, false)).toBe(
      true,
    );
    expect(resolveDocumentColorMode(null, { exportWithDarkMode: false }, true)).toBe(
      false,
    );
  });

  it("falls to the OS/config theme for a scene that states no mode", () => {
    expect(resolveDocumentColorMode(null, {}, true)).toBe(true);
    expect(resolveDocumentColorMode(null, {}, false)).toBe(false);
    expect(resolveDocumentColorMode(null, undefined, true)).toBe(true);
    expect(resolveDocumentColorMode(null, null, false)).toBe(false);
  });

  it("ignores a non-boolean key rather than coercing it", () => {
    // An external hand-edit could write "true"; a truthy string must not be
    // read as a stated mode, or the theme fallback becomes unreachable.
    expect(resolveDocumentColorMode(null, { exportWithDarkMode: "true" }, false)).toBe(
      false,
    );
    expect(resolveDocumentColorMode(null, { exportWithDarkMode: 1 }, true)).toBe(true);
  });

  // The end-to-end shape of review-1 finding 1, asserted on the chain itself:
  // dark scene JSON in a file named `.excalidraw.svg`, opened under a light
  // OS theme, must resolve dark.
  it("resolves dark for dark scene JSON misdeclared as SVG under a light theme", () => {
    const sceneJson = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: { exportWithDarkMode: true },
      files: {},
    });
    const baked = svgBytesColorMode(encode(sceneJson)); // declared image/svg+xml
    const reattached = reattachRawColorMode(
      { appState: {} } as ExcalidrawInitialDataState,
      encode(sceneJson),
    );
    expect(resolveDocumentColorMode(baked, reattached.appState, false)).toBe(true);
  });

  it("resolves light for the same file saved light, under a dark theme", () => {
    const sceneJson = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: { exportWithDarkMode: false },
      files: {},
    });
    const reattached = reattachRawColorMode(
      { appState: {} } as ExcalidrawInitialDataState,
      encode(sceneJson),
    );
    expect(
      resolveDocumentColorMode(svgBytesColorMode(encode(sceneJson)), reattached.appState, true),
    ).toBe(false);
  });

  it("leaves a keyless file on the theme, whatever its declared type", () => {
    const keyless = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: {},
    });
    const reattached = reattachRawColorMode(
      { appState: {} } as ExcalidrawInitialDataState,
      encode(keyless),
    );
    expect(
      resolveDocumentColorMode(svgBytesColorMode(encode(keyless)), reattached.appState, true),
    ).toBe(true);
  });

  it("keeps a real dark SVG export winning over the scene it embeds", () => {
    // The `.svg`/`.png` recovery path is unchanged by the fix: a genuine SVG
    // payload still answers a boolean, so the baked rendering stays first.
    const darkSvg = `<svg version="1.1" filter="${EXCALIDRAW_DARK_SVG_FILTER}"><!-- svg-source:excalidraw --></svg>`;
    expect(
      resolveDocumentColorMode(svgBytesColorMode(encode(darkSvg)), { exportWithDarkMode: false }, false),
    ).toBe(true);
  });
});

describe("rawJsonExportWithDarkMode", () => {
  const scene = (appState: unknown) =>
    encode(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [],
        appState,
        files: {},
      }),
    );

  it("reads a dark-mode file's key", () => {
    expect(rawJsonExportWithDarkMode(scene({ exportWithDarkMode: true }))).toBe(true);
  });

  it("reads a light-mode file's key", () => {
    expect(rawJsonExportWithDarkMode(scene({ exportWithDarkMode: false }))).toBe(false);
  });

  it("returns undefined for a keyless file (the pre-D1 shape)", () => {
    expect(
      rawJsonExportWithDarkMode(scene({ gridSize: null, viewBackgroundColor: "#fff" })),
    ).toBeUndefined();
  });

  it("returns undefined when appState is absent or not an object", () => {
    expect(
      rawJsonExportWithDarkMode(
        encode(JSON.stringify({ type: "excalidraw", version: 2, elements: [] })),
      ),
    ).toBeUndefined();
    expect(rawJsonExportWithDarkMode(scene(null))).toBeUndefined();
  });

  it("returns undefined for non-boolean values (never coerces)", () => {
    expect(rawJsonExportWithDarkMode(scene({ exportWithDarkMode: "true" }))).toBeUndefined();
    expect(rawJsonExportWithDarkMode(scene({ exportWithDarkMode: 1 }))).toBeUndefined();
  });

  it("ignores the key nested deeper than appState (only the exact path counts)", () => {
    expect(
      rawJsonExportWithDarkMode(
        scene({ frameRendering: { exportWithDarkMode: true } }),
      ),
    ).toBeUndefined();
  });

  it("never throws: non-JSON bytes (SVG/PNG payloads) and empty input yield undefined", () => {
    expect(
      rawJsonExportWithDarkMode(encode(`<svg xmlns="http://www.w3.org/2000/svg"/>`)),
    ).toBeUndefined();
    expect(rawJsonExportWithDarkMode(encode("not json at all"))).toBeUndefined();
    expect(rawJsonExportWithDarkMode(new ArrayBuffer(0))).toBeUndefined();
  });
});

describe("reattachRawColorMode", () => {
  const loaded = (appState: Record<string, unknown>): ExcalidrawInitialDataState => ({
    elements: [],
    appState,
    files: {},
  });
  const bytes = (appState: unknown) =>
    encode(JSON.stringify({ appState, elements: [], files: {} }));

  it("re-attaches the file-stated mode onto loadFromBlob's stripped result", () => {
    // What loadFromBlob returns for a dark file: appState without the key.
    const data = loaded({ gridSize: null });
    const repaired = reattachRawColorMode(data, bytes({ exportWithDarkMode: true }));
    expect(repaired.appState).toEqual({ gridSize: null, exportWithDarkMode: true });
    // Elements and files pass through; the input is never mutated.
    expect(repaired.elements).toBe(data.elements);
    expect(data.appState).toEqual({ gridSize: null });
  });

  it("re-attaches light mode as a real false, distinct from keyless", () => {
    const repaired = reattachRawColorMode(
      loaded({}),
      bytes({ exportWithDarkMode: false }),
    );
    expect(repaired.appState?.exportWithDarkMode).toBe(false);
  });

  it("returns the SAME object for keyless files — behavior provably unchanged", () => {
    const data = loaded({ gridSize: null });
    expect(reattachRawColorMode(data, bytes({ gridSize: null }))).toBe(data);
  });

  it("returns the SAME object for non-JSON payloads (SVG/PNG bytes)", () => {
    const data = loaded({ gridSize: null });
    expect(reattachRawColorMode(data, encode("<svg/>"))).toBe(data);
  });

  it("returns the SAME object when the file's value is not a boolean", () => {
    const data = loaded({});
    expect(reattachRawColorMode(data, bytes({ exportWithDarkMode: "dark" }))).toBe(data);
  });
});
