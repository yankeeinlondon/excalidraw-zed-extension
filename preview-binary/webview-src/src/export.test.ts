import { describe, it, expect, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  exportToSvg: vi.fn(async () => ({ outerHTML: "<svg>mock</svg>" })),
  exportToBlob: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
  serializeAsJSON: vi.fn(
    () =>
      '{"type":"excalidraw","version":2,"source":"excalidraw-zed-preview",' +
      '"elements":[],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"},"files":{}}',
  ),
}));

import { exportFilename, postExport, type ExportKind } from "./export";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const fakeApi = {
  getSceneElements: () => [],
  getAppState: () => ({}),
  getFiles: () => ({}),
} as unknown as ExcalidrawImperativeAPI;

const apiWithColorMode = (mode: boolean | undefined) =>
  ({
    getSceneElements: () => [],
    getAppState: () =>
      mode === undefined ? {} : { exportWithDarkMode: mode },
    getFiles: () => ({}),
  }) as unknown as ExcalidrawImperativeAPI;

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
    ["svg-scene", "diagram.excalidraw.svg"],
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

  it("embeds the scene for an editable svg-scene export", async () => {
    const { exportToSvg } = await import("@excalidraw/excalidraw");
    (exportToSvg as ReturnType<typeof vi.fn>).mockClear();
    const fetchFn = fetchStub(200, "/home/user/diagram.excalidraw.svg");
    const result = await postExport(fakeApi, "diagram", "svg-scene", fetchFn);
    expect(result).toBe("/home/user/diagram.excalidraw.svg");
    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("/export?name=diagram.excalidraw.svg");
    const svgArgs = (exportToSvg as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      appState: { exportEmbedScene?: boolean };
    };
    expect(svgArgs.appState.exportEmbedScene).toBe(true);
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

describe("postExport scene payload carries the document color mode (D1)", () => {
  async function postedBody(mode: boolean | undefined): Promise<string> {
    const fetchFn = fetchStub(200, "/home/user/diagram.excalidraw");
    await postExport(apiWithColorMode(mode), "diagram", "scene", fetchFn);
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    return init.body as string;
  }

  it("POSTs appState.exportWithDarkMode true when the editor is dark", async () => {
    const appState = JSON.parse(await postedBody(true)).appState;
    expect(appState.exportWithDarkMode).toBe(true);
    // Upstream-stripped keys the serializer did emit survive alongside.
    expect(appState.gridSize).toBeNull();
  });

  it("POSTs appState.exportWithDarkMode false when the editor is light", async () => {
    expect(JSON.parse(await postedBody(false)).appState.exportWithDarkMode).toBe(false);
  });

  it("POSTs false when the editor appState carries no mode", async () => {
    expect(JSON.parse(await postedBody(undefined)).appState.exportWithDarkMode).toBe(false);
  });
});
