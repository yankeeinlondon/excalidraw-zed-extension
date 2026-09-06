import { describe, it, expect } from "vitest";
import {
  EXCALIDRAW_DARK_SVG_FILTER,
  svgBytesAreDarkMode,
  rawJsonExportWithDarkMode,
  reattachRawColorMode,
} from "./color-mode";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

const encode = (s: string) => new TextEncoder().encode(s).buffer;

describe("svgBytesAreDarkMode", () => {
  it("detects a dark-mode export by excalidraw's root filter", () => {
    const dark = `<svg version="1.1" filter="${EXCALIDRAW_DARK_SVG_FILTER}"><!-- svg-source:excalidraw --></svg>`;
    expect(svgBytesAreDarkMode(encode(dark))).toBe(true);
  });

  it("treats a light-mode export (no filter) as not dark", () => {
    const light = `<svg version="1.1"><!-- svg-source:excalidraw --><rect/></svg>`;
    expect(svgBytesAreDarkMode(encode(light))).toBe(false);
  });

  it("is false for empty bytes (a brand-new file)", () => {
    expect(svgBytesAreDarkMode(new ArrayBuffer(0))).toBe(false);
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
