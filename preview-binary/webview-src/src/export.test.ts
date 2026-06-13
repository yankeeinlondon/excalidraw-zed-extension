import { describe, it, expect, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  exportToSvg: vi.fn(async () => ({ outerHTML: "<svg>mock</svg>" })),
  exportToBlob: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
  serializeAsJSON: vi.fn(() => '{"type":"excalidraw"}'),
}));

import { exportFilename, postExport, type ExportKind } from "./export";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const fakeApi = {
  getSceneElements: () => [],
  getAppState: () => ({}),
  getFiles: () => ({}),
} as unknown as ExcalidrawImperativeAPI;

function fetchStub(status: number, text = "") {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  })) as unknown as typeof fetch;
}

describe("exportFilename", () => {
  it.each<[ExportKind, string]>([
    ["png", "diagram.png"],
    ["png2x", "diagram.png"],
    ["svg", "diagram.svg"],
    ["scene", "diagram.excalidraw"],
  ])("maps %s to %s", (kind, expected) => {
    expect(exportFilename("diagram", kind)).toBe(expected);
  });
});

describe("postExport", () => {
  it("POSTs SVG markup with the svg mime type and returns the written path", async () => {
    const fetchFn = fetchStub(200, "/home/user/diagram.svg");
    const result = await postExport(fakeApi, "diagram", "svg", fetchFn);
    expect(result).toBe("/home/user/diagram.svg");
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/export?name=diagram.svg");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/svg+xml");
    expect(init.body).toBe("<svg>mock</svg>");
  });

  it("returns null when the server reports the dialog was cancelled (204)", async () => {
    const result = await postExport(fakeApi, "diagram", "png", fetchStub(204));
    expect(result).toBeNull();
  });

  it("throws on a server error", async () => {
    await expect(postExport(fakeApi, "diagram", "scene", fetchStub(500))).rejects.toThrow(
      /Export failed: 500/,
    );
  });
});
