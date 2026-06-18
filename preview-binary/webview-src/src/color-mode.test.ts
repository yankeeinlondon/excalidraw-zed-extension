import { describe, it, expect } from "vitest";
import { EXCALIDRAW_DARK_SVG_FILTER, svgBytesAreDarkMode } from "./color-mode";

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
