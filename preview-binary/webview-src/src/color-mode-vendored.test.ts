// The §6.3b restore() proxy: pins the VENDORED @excalidraw/excalidraw
// behavior D1 depends on, against future package bumps.
//
// This file deliberately imports the real package code instead of mocking it
// like the other suites. Consequences, by design:
//
// - The chunk import goes through a relative path into node_modules (the
//   package's `exports` field blocks subpath specifiers) and the chunk file
//   name is a build artifact: a package bump renames it and this file fails
//   loudly at import time — exactly the tripwire the proxy exists to be.
// - The chunk (and the package root) read browser globals at module scope
//   (navigator, window, location, document, devicePixelRatio, FileReader), so
//   minimal stubs are installed FIRST and every package-touching import is a
//   dynamic import AFTER the stubs — static imports would hoist evaluation
//   ahead of them. vitest.config.ts inlines the package (`server.deps.inline`)
//   so vite's resolver handles its bundler-only extensionless imports
//   (`roughjs/bin/rough`).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
// color-mode.ts is deliberately package-free (type-only import), so it can be
// imported statically — only the vendored chunk below needs the stubs first.
import {
  injectExportWithDarkMode,
  rawJsonExportWithDarkMode,
  reattachRawColorMode,
} from "./color-mode";

// ── Minimal browser-global stubs (set before any package code evaluates) ────
const g = globalThis as unknown as Record<string, unknown>;
if (!g.window) g.window = g;
if (!g.location) g.location = { origin: "http://localhost:5173" };
if (!g.navigator)
  g.navigator = { platform: "MacIntel", userAgent: "vitest", language: "en" };
if (!g.document)
  g.document = {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    documentElement: { style: {} },
    body: {},
    addEventListener() {},
    removeEventListener() {},
  };
if (!("devicePixelRatio" in g)) g.devicePixelRatio = 1;
if (!g.FileReader)
  g.FileReader = class FileReader {
    static DONE = 2;
    readyState = 0;
    result: string | ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsText(blob: Blob) {
      void blob.text().then((text) => {
        this.result = text;
        this.readyState = 2;
        this.onloadend?.();
      });
    }
  };

// ── Real-code imports (after the stubs) ──────────────────────────────────────
const chunk = await import(
  "../../node_modules/@excalidraw/excalidraw/dist/dev/chunk-4FTI6OG3.js"
);

const bytesOf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("vendored @excalidraw/excalidraw 0.18.1 behavior D1 relies on", () => {
  it("restoreAppState KEEPS a supplied exportWithDarkMode (true and false)", () => {
    const dark = chunk.restoreAppState({ exportWithDarkMode: true });
    expect((dark as { exportWithDarkMode?: boolean }).exportWithDarkMode).toBe(true);
    const light = chunk.restoreAppState({ exportWithDarkMode: false });
    expect((light as { exportWithDarkMode?: boolean }).exportWithDarkMode).toBe(false);
  });

  it("restore() keeps a key-carrying payload's flag and defaults a keyless one", () => {
    const restored = chunk.restore(
      { elements: [], appState: { exportWithDarkMode: true }, files: {} },
      null,
      null,
    ) as { appState: { exportWithDarkMode?: boolean } };
    expect(restored.appState.exportWithDarkMode).toBe(true);

    const keyless = chunk.restore(
      { elements: [], appState: {}, files: {} },
      null,
      null,
    ) as { appState: { exportWithDarkMode?: boolean } };
    expect(keyless.appState.exportWithDarkMode).toBe(false);
  });

  it("serializeAsJSON strips the key — the root cause D1's injection undoes", () => {
    const json = chunk.serializeAsJSON(
      [],
      { exportWithDarkMode: true } as never,
      {} as never,
      "local",
    );
    expect(JSON.parse(json).appState.exportWithDarkMode).toBeUndefined();
  });

  it("loadFromBlob ALSO strips the key (decision-log finding N2) — the load-side repair's reason", async () => {
    const file = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "excalidraw-zed-preview",
      elements: [],
      appState: { exportWithDarkMode: true, viewBackgroundColor: "#ffffff" },
      files: {},
    });
    const data = (await chunk.loadFromBlob(
      new Blob([file], { type: "application/json" }),
      null,
      null,
    )) as { appState: { exportWithDarkMode?: boolean } };
    expect(data.appState.exportWithDarkMode).toBe(false); // upstream default
  });
});

describe("D1 round-trip against the real vendored package (read/write/read, repeated)", () => {
  const EXAMPLES_DIR = fileURLToPath(
    new URL("../../../docs/examples/", import.meta.url),
  );
  const exampleText = readFileSync(
    `${EXAMPLES_DIR}/software-development-lifecycle.excalidraw`,
    "utf8",
  );

  /** The exact composition serializeSceneForDisk performs, on real exports. */
  const serializeForDisk = (data: {
    elements: readonly unknown[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
  }) =>
    injectExportWithDarkMode(
      chunk.serializeAsJSON(data.elements, data.appState, data.files, "local"),
      Boolean(data.appState.exportWithDarkMode),
    );

  /** One full disk cycle: parse (with the D1 load repair) → serialize (with the D1 injection). */
  async function cycle(
    fileText: string,
  ): Promise<{ mode: boolean; file: string }> {
    const loaded = (await chunk.loadFromBlob(
      new Blob([fileText], { type: "application/json" }),
      null,
      null,
    )) as unknown as ExcalidrawInitialDataState;
    const repaired = reattachRawColorMode(loaded, bytesOf(fileText)) as {
      elements: readonly unknown[];
      appState: Record<string, unknown>;
      files: Record<string, unknown>;
    };
    const mode = Boolean(repaired.appState.exportWithDarkMode);
    return { mode, file: serializeForDisk(repaired) };
  }

  it("a shipped example reopens with no stated mode; a dark save reopens dark across repeated cycles", async () => {
    // Read the shipped artifact as-is: keyless → no stated mode.
    const first = await cycle(exampleText);
    expect(first.mode).toBe(false);

    // Toggle dark + save (the D1 write), then read → write → read, twice.
    let file = injectExportWithDarkMode(first.file, true);
    for (let round = 1; round <= 2; round++) {
      const out = await cycle(file);
      expect(out.mode, `round ${round}: reopened dark`).toBe(true);
      expect(
        JSON.parse(out.file).appState.exportWithDarkMode,
        `round ${round}: re-saved dark`,
      ).toBe(true);
      file = out.file;
    }

    // The raw key is what our own load path reads off disk.
    expect(rawJsonExportWithDarkMode(bytesOf(file))).toBe(true);
  });

  it("toggling back to light round-trips as light (value replaced, never duplicated)", async () => {
    let file = injectExportWithDarkMode(
      chunk.serializeAsJSON([], { exportWithDarkMode: true } as never, {} as never, "local"),
      true,
    );
    file = injectExportWithDarkMode(file, false); // toggle light + save
    const out = await cycle(file);
    expect(out.mode).toBe(false);
    const keys = Object.keys(JSON.parse(out.file).appState);
    expect(keys.filter((k) => k === "exportWithDarkMode")).toHaveLength(1);
  });
});

describe("passive corpus: every shipped plain-JSON example survives D1 injection", () => {
  const examplesDir = fileURLToPath(
    new URL("../../../docs/examples/", import.meta.url),
  );
  const files = readdirSync(examplesDir).filter((f) => f.endsWith(".excalidraw"));

  it("found the shipped examples (corpus is non-empty)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s injects cleanly and reads the mode back", (name) => {
    const text = readFileSync(`${examplesDir}/${name}`, "utf8");
    const original: Record<string, unknown> = JSON.parse(text);

    for (const mode of [true, false]) {
      const injected = injectExportWithDarkMode(text, mode);
      // The injected file is valid JSON, deep-equal to the original except the key.
      const expected = JSON.parse(
        JSON.stringify({
          ...original,
          appState: {
            ...(original.appState as object),
            exportWithDarkMode: mode,
          },
        }),
      );
      expect(JSON.parse(injected)).toEqual(expected);
      // And our raw-disk reader observes the stated mode.
      expect(rawJsonExportWithDarkMode(bytesOf(injected))).toBe(mode);
    }

    // Keyless originals state no mode through the raw reader.
    expect(rawJsonExportWithDarkMode(bytesOf(text))).toBeUndefined();
  });
});
