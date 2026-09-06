import { describe, it, expect, vi } from "vitest";

// hashElementsVersion is the only piece pulled from the heavy package; stub it
// with a deterministic length-based hash so the fingerprint logic is testable
// in isolation (mirrors export.test.ts's approach).
vi.mock("@excalidraw/excalidraw", () => ({
  hashElementsVersion: vi.fn(
    (elements: readonly unknown[]) => `v${elements.length}`,
  ),
}));

import {
  fnv1a,
  computeAppStateFingerprint,
  computeFilesFingerprint,
  computeSceneHash,
  pickPersistedAppState,
} from "./scene-fingerprint";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState as ExcalidrawAppState,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

const els = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i}` })) as unknown as readonly ExcalidrawElement[];

const appState = (o: Record<string, unknown>) =>
  o as unknown as Partial<ExcalidrawAppState>;

const filesOf = (entries: Record<string, { dataURL: string; mimeType?: string }>) =>
  entries as unknown as BinaryFiles;

describe("fnv1a", () => {
  it("is deterministic and changes with input", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
    expect(fnv1a("hello")).not.toBe(fnv1a("hellp"));
  });

  it("returns zero-padded 8-char hex", () => {
    expect(fnv1a("")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("a")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("computeAppStateFingerprint", () => {
  it("ignores viewport/selection-only fields", () => {
    const a = computeAppStateFingerprint(
      appState({ scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} }),
    );
    const b = computeAppStateFingerprint(
      appState({ scrollX: 999, scrollY: -50, zoom: { value: 2 }, selectedElementIds: { e1: true } }),
    );
    expect(a).toBe(b);
    expect(a).toBe("");
  });

  it("changes when a persisted key changes", () => {
    const a = computeAppStateFingerprint(appState({ viewBackgroundColor: "#fff" }));
    const b = computeAppStateFingerprint(appState({ viewBackgroundColor: "#000" }));
    expect(a).not.toBe(b);
  });

  it("captures export-related settings", () => {
    const a = computeAppStateFingerprint(appState({ exportScale: 1 }));
    const b = computeAppStateFingerprint(appState({ exportScale: 2 }));
    expect(a).not.toBe(b);

    const c = computeAppStateFingerprint(appState({ exportWithDarkMode: false }));
    const d = computeAppStateFingerprint(appState({ exportWithDarkMode: true }));
    expect(c).not.toBe(d);
  });

  it("captures nested object settings like frameRendering", () => {
    const a = computeAppStateFingerprint(appState({ frameRendering: { enabled: true, name: false } }));
    const b = computeAppStateFingerprint(appState({ frameRendering: { enabled: true, name: true } }));
    expect(a).not.toBe(b);
  });
});

describe("computeFilesFingerprint", () => {
  it("is empty for no files and order-independent", () => {
    expect(computeFilesFingerprint(null)).toBe("");
    const a = computeFilesFingerprint(
      filesOf({ a: { dataURL: "AAA" }, b: { dataURL: "BBB" } }),
    );
    const b = computeFilesFingerprint(
      filesOf({ b: { dataURL: "BBB" }, a: { dataURL: "AAA" } }),
    );
    expect(a).toBe(b);
  });

  it("detects data populated under an existing id", () => {
    // The bug finding 4 calls out: same id, but the data URL is filled in later.
    const before = computeFilesFingerprint(filesOf({ img1: { dataURL: "" } }));
    const after = computeFilesFingerprint(
      filesOf({ img1: { dataURL: "data:image/png;base64,iVBORw0KGgo=" } }),
    );
    expect(before).not.toBe(after);
  });

  it("detects a replaced data URL under the same id", () => {
    const a = computeFilesFingerprint(filesOf({ img1: { dataURL: "data:1" } }));
    const b = computeFilesFingerprint(filesOf({ img1: { dataURL: "data:2" } }));
    expect(a).not.toBe(b);
  });
});

describe("pickPersistedAppState", () => {
  it("returns an empty patch for null/undefined", () => {
    expect(pickPersistedAppState(null)).toEqual({});
    expect(pickPersistedAppState(undefined)).toEqual({});
  });

  it("keeps persisted/visual keys and drops viewport, selection, and theme", () => {
    const patch = pickPersistedAppState(
      appState({
        viewBackgroundColor: "#abcdef",
        gridSize: 20,
        exportScale: 2,
        exportWithDarkMode: true,
        // none of these are persisted — must not leak into the reload patch:
        scrollX: 999,
        scrollY: -12,
        zoom: { value: 3 },
        selectedElementIds: { e1: true },
        theme: "dark",
        editingTextElement: { id: "x" },
      }),
    );
    expect(patch).toEqual({
      viewBackgroundColor: "#abcdef",
      gridSize: 20,
      exportScale: 2,
      // The document color mode travels with an external reload's appState —
      // with D1's load-side repair a key-carrying file's mode re-themes the
      // live editor through exactly this path.
      exportWithDarkMode: true,
    });
  });

  it("omits keys whose value is undefined", () => {
    const patch = pickPersistedAppState(
      appState({ viewBackgroundColor: undefined, gridSize: 10 }),
    );
    expect(patch).toEqual({ gridSize: 10 });
    expect("viewBackgroundColor" in patch).toBe(false);
  });

  it("produces a patch consistent with the appState fingerprint", () => {
    // The picked patch carries exactly the keys that move the dirty fingerprint,
    // so applying it on reload and re-hashing yields a stable baseline.
    const full = appState({
      viewBackgroundColor: "#000",
      gridSize: 20,
      scrollX: 500,
    });
    expect(computeAppStateFingerprint(pickPersistedAppState(full))).toBe(
      computeAppStateFingerprint(full),
    );
  });
});

describe("computeSceneHash", () => {
  it("combines elements, files, and appState", () => {
    const base = computeSceneHash(els(2), appState({ viewBackgroundColor: "#fff" }), filesOf({}));

    // Element change.
    expect(computeSceneHash(els(3), appState({ viewBackgroundColor: "#fff" }), filesOf({}))).not.toBe(base);
    // File data change under existing id.
    expect(
      computeSceneHash(els(2), appState({ viewBackgroundColor: "#fff" }), filesOf({ x: { dataURL: "Z" } })),
    ).not.toBe(base);
    // appState change.
    expect(computeSceneHash(els(2), appState({ viewBackgroundColor: "#000" }), filesOf({}))).not.toBe(base);
  });

  it("is stable for an unchanged scene", () => {
    const a = computeSceneHash(els(2), appState({ gridSize: 20 }), filesOf({ x: { dataURL: "Z" } }));
    const b = computeSceneHash(els(2), appState({ gridSize: 20 }), filesOf({ x: { dataURL: "Z" } }));
    expect(a).toBe(b);
  });

  it("ignores viewport-only changes", () => {
    const a = computeSceneHash(els(1), appState({ scrollX: 0, gridSize: 20 }), filesOf({}));
    const b = computeSceneHash(els(1), appState({ scrollX: 500, gridSize: 20 }), filesOf({}));
    expect(a).toBe(b);
  });

  it("ignores deleted elements so onChange (incl. deleted) matches the saved scene", () => {
    // onChange reports elements *including* deleted ones; the save path
    // fingerprints getSceneElements() (non-deleted only). Both must hash equal
    // for the same live scene, else a saved scene reads as dirty forever
    // ("Unsaved changes" after Ctrl+S).
    const withDeleted = [
      { id: "a" },
      { id: "b", isDeleted: true },
    ] as unknown as readonly ExcalidrawElement[];
    const nonDeletedOnly = [{ id: "a" }] as unknown as readonly ExcalidrawElement[];

    expect(
      computeSceneHash(withDeleted, appState({ gridSize: 20 }), filesOf({})),
    ).toBe(computeSceneHash(nonDeletedOnly, appState({ gridSize: 20 }), filesOf({})));
  });
});
