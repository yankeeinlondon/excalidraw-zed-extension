// The D3 vendored-package proxy: pins the REAL @excalidraw/excalidraw 0.18.1
// behavior the unique-id invariant relies on (and works around), against
// future package bumps.
//
// Like `color-mode-vendored.test.ts`, this file deliberately imports the real
// package code instead of mocking it (the pure-module fakes in
// `library-merge.test.ts` mirror the behavior pinned here):
//
// - The package ROOT is imported (not just the restore chunk) because the
//   root-cause function `mergeLibraryItems` lives only there. The root reads
//   browser globals at module scope and runs its own polyfill
//   (`Element.replaceChildren`), so minimal stubs are installed FIRST and the
//   import is dynamic AFTER them. vitest.config.ts inlines the package so
//   vite's resolver handles its bundler-only extensionless imports.
// - Unlike the chunk's hashed filename, `dist/dev/index.js` is a stable name:
//   a package bump will not break the import itself — it must break these
//   behavior pins instead, which is exactly what the proxy is for.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  LibraryItem,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
// library-merge.ts is package-free (type-only import), so it can be imported
// statically — only the vendored package below needs the stubs first.
import { dedupeLibraryItems, installLibraryPayload, type LibraryPipeline } from "./library-merge";

// ── Minimal browser-global stubs (set before any package code evaluates) ────
const g = globalThis as unknown as Record<string, unknown>;
if (!g.window) g.window = g;
if (!g.location) g.location = { origin: "http://localhost:5173" };
if (!g.navigator)
  g.navigator = { platform: "MacIntel", userAgent: "vitest", language: "en" };
if (!g.Element) g.Element = class Element {};
if (!g.document)
  g.document = {
    createElement: () => ({
      style: {},
      setAttribute() {},
      appendChild() {},
      getContext: () => ({ measureText: () => ({ width: 0 }) }),
    }),
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

// ── Real-code import (after the stubs) ───────────────────────────────────────
// The relative .js import resolves to the ambient `*.js` wildcard module
// (vendored-chunk.d.ts), so cast to the precise — and real, per
// dist/types/excalidraw/data/{library,blob}.d.ts — surface this suite uses.
interface VendoredLibraryModule {
  /** Upstream content-equality library merge; id-blind (the D3 root cause). */
  mergeLibraryItems(
    localItems: LibraryItems,
    otherItems: LibraryItems,
  ): LibraryItems;
  /** Normalizes library items; preserves ids and content stamps. */
  restoreLibraryItems(
    libraryItems?: unknown,
    defaultStatus?: LibraryItem["status"],
  ): LibraryItem[];
  /** Parses a .excalidrawlib Blob (v1 or v2) into normalized items. */
  loadLibraryFromBlob(
    blob: Blob,
    defaultStatus?: LibraryItem["status"],
  ): Promise<LibraryItem[]>;
}
const pkg = (await import(
  "../../node_modules/@excalidraw/excalidraw/dist/dev/index.js"
)) as unknown as VendoredLibraryModule;

// ── The exact original failing input, verbatim ───────────────────────────────
const FIXTURE_TEXT = readFileSync(
  fileURLToPath(
    new URL("./fixtures/corrupted-library.excalidrawlib", import.meta.url),
  ),
  "utf8",
);
const FIXTURE_ITEMS = (JSON.parse(FIXTURE_TEXT) as { libraryItems: LibraryItems })
  .libraryItems;

const idsOf = (items: readonly { id: string }[]) => items.map((it) => it.id);
const expectUnique = (items: readonly { id: string }[]) =>
  expect(new Set(idsOf(items)).size, JSON.stringify(idsOf(items))).toBe(
    items.length,
  );

/** Content-only restamp, simulating an edit between two installs. */
const restamp = (items: LibraryItems, nonce: number, updated: number) =>
  items.map((it) => ({
    ...it,
    elements: it.elements.map((e) => ({
      ...e,
      versionNonce: nonce,
      updated,
    })),
  })) as LibraryItems;

/** Two elements are content-equal in the vendored merge's sense. */
const sameContent = (
  a: readonly { elements: readonly { id: string; versionNonce: number }[] }[],
  b: readonly { elements: readonly { id: string; versionNonce: number }[] }[],
) =>
  a.length === b.length &&
  a.every(
    (item, i) =>
      item.elements.length === b[i]!.elements.length &&
      item.elements.every(
        (e, j) =>
          e.id === b[i]!.elements[j]!.id &&
          e.versionNonce === b[i]!.elements[j]!.versionNonce,
      ),
  );

describe("vendored mergeLibraryItems — the twin root cause (0.18.1)", () => {
  it("re-delivery of IDENTICAL content is deduped by content equality (no twin)", () => {
    const lib = pkg.restoreLibraryItems(FIXTURE_ITEMS.slice(0, 3));
    const merged = pkg.mergeLibraryItems(lib, lib);
    expect(merged).toHaveLength(3);
    expectUnique(merged);
  });

  it("re-delivery of RE-STAMPED content with the SAME library-item id is APPENDED — the reported twin", () => {
    const lib = pkg.restoreLibraryItems(FIXTURE_ITEMS.slice(0, 3));
    // Simulate the reporting setup's sequence: the same library merged again
    // after its elements were re-stamped (updated/versionNonce changed).
    const restamped = restamp(lib, 424242, 1781659999999);
    const merged = pkg.mergeLibraryItems(lib, restamped);
    expect(merged).toHaveLength(6); // ← every id now appears twice
    expect(new Set(idsOf(merged)).size).toBe(3);
    // …and the D3 choke point collapses exactly this output:
    const healed = dedupeLibraryItems(merged as LibraryItems);
    expect(healed).toHaveLength(3);
    expectUnique(healed);
    expect(
      sameContent(
        healed as never,
        pkg.restoreLibraryItems(healed as LibraryItems) as never,
      ),
    ).toBe(true);
  });

  it("brand-new items are prepended (install ordering the choke point preserves)", () => {
    const existing = pkg.restoreLibraryItems(FIXTURE_ITEMS.slice(0, 1));
    const incoming = pkg.restoreLibraryItems(FIXTURE_ITEMS.slice(1, 3));
    const merged = pkg.mergeLibraryItems(existing, incoming);
    expect(idsOf(merged)).toEqual([
      ...idsOf(incoming),
      ...idsOf(existing),
    ]);
  });
});

describe("vendored restoreLibraryItems — what the choke point keys on", () => {
  it("PRESERVES library-item ids (the dedupe key) through restore", () => {
    const restored = pkg.restoreLibraryItems(FIXTURE_ITEMS);
    expect(idsOf(restored)).toEqual(idsOf(FIXTURE_ITEMS));
  });

  it("PRESERVES element ids, versionNonce and updated — restore does not equalize duplicated copies", () => {
    // If restore normalized the nonces, the corrupted file's copies would
    // collapse on their own; it doesn't, which is why duplicates stay
    // content-different and keep being appended by the merge.
    const restored = pkg.restoreLibraryItems(FIXTURE_ITEMS);
    const first = restored[1]!; // first copy of duplicated id #1
    const second = restored[3]!; // second copy of the same id
    expect(first.id).toBe(second.id);
    expect(first.elements[0]!.updated).not.toBe(second.elements[0]!.updated);
    expect(first.elements[0]!.versionNonce).not.toBe(
      second.elements[0]!.versionNonce,
    );
    // And the differences are exactly the input's (restore is faithful).
    expect(first.elements[0]!.updated).toBe(
      FIXTURE_ITEMS[1]!.elements[0]!.updated,
    );
    expect(second.elements[0]!.updated).toBe(
      FIXTURE_ITEMS[3]!.elements[0]!.updated,
    );
  });

  it("is idempotent for restored items (the choke point's extra restore pass is benign)", () => {
    // installLibraryPayload's result passes through restoreLibraryItems once
    // more inside updateLibrary; a second pass must not change content.
    const once = pkg.restoreLibraryItems(FIXTURE_ITEMS);
    const twice = pkg.restoreLibraryItems(once as LibraryItems);
    expect(sameContent(once as never, twice as never)).toBe(true);
    expect(idsOf(twice)).toEqual(idsOf(once));
  });

  it("v1 (bare element array) items are keyed with fresh random ids — they cannot collide", () => {
    const v1 = [
      [{ id: "e1", type: "rectangle", version: 1, versionNonce: 1, updated: 1 }],
      [{ id: "e2", type: "rectangle", version: 1, versionNonce: 1, updated: 1 }],
    ];
    const restored = pkg.restoreLibraryItems(v1 as never);
    expect(restored).toHaveLength(2);
    expect(restored[0]!.id).not.toBe(restored[1]!.id);
    expect(typeof restored[0]!.id).toBe("string");
  });
});

describe("the real vendored pipeline end-to-end against the exact original input", () => {
  /** The REAL pipeline, exactly as App.tsx wires it. */
  const realPipeline: LibraryPipeline = {
    mergeItems: (existing, incoming) =>
      pkg.mergeLibraryItems(existing, incoming) as LibraryItems,
    parseBlob: async (blob) =>
      pkg.loadLibraryFromBlob(blob, "unpublished") as Promise<LibraryItems>,
    restoreItems: (items) =>
      pkg.restoreLibraryItems(items, "unpublished") as LibraryItems,
  };

  /** Faithful fake of updateLibrary's function form (see library-merge.test.ts). */
  function makeUpdateLibrary() {
    const state = { items: [] as LibraryItems };
    const updateLibrary = async (opts: {
      libraryItems: (current: LibraryItems) => Promise<LibraryItems>;
    }): Promise<LibraryItems> => {
      // The vendored function form re-restores the updater's result; use the
      // real restore for full fidelity.
      const next = await opts.libraryItems(state.items);
      state.items = pkg.restoreLibraryItems(
        next as LibraryItems,
      ) as LibraryItems;
      return state.items;
    };
    return { state, updateLibrary };
  }

  it("the corrupted fixture seeds twins through the real restore; the choke point heals them", () => {
    // What Excalidraw's own seeding (initialData.libraryItems →
    // updateLibrary({merge:true}) against an empty library) does with the
    // corrupted file: restore preserves both copies, merge prepends both.
    const seeded = pkg.mergeLibraryItems(
      [],
      pkg.restoreLibraryItems(FIXTURE_ITEMS, "unpublished"),
    );
    expect(seeded).toHaveLength(5);
    expect(new Set(idsOf(seeded)).size).toBe(3); // the twins, on real code

    // The D3 remedy at the seeding boundary (main.tsx): dedupe on load.
    const healed = dedupeLibraryItems(seeded as LibraryItems);
    expect(healed).toHaveLength(3);
    expectUnique(healed);
  });

  it("install → restamped re-delivery through the REAL pipeline leaves one entry per id", async () => {
    const { state, updateLibrary } = makeUpdateLibrary();
    const lib: LibraryItems = pkg.restoreLibraryItems(
      FIXTURE_ITEMS.slice(1, 3),
      "unpublished",
    ) as LibraryItems;

    await installLibraryPayload(realPipeline, updateLibrary, lib);
    expect(state.items).toHaveLength(2);

    // The reporting interleaving: the same library re-delivered after a
    // restamp — via a Blob (the SSE path).
    const restamped = restamp(lib, 31337, 1781659911111);
    const blob = new Blob(
      [
        JSON.stringify({
          type: "excalidrawlib",
          version: 2,
          libraryItems: restamped,
        }),
      ],
      { type: "application/json" },
    );
    await installLibraryPayload(realPipeline, updateLibrary, blob);
    expect(state.items).toHaveLength(2); // NOT 4
    expectUnique(state.items);
    // The survivor is the re-stamped (newer) copy.
    expect(state.items[0]!.elements[0]!.updated).toBe(1781659911111);
  });

  it("identical re-delivery through the real pipeline is idempotent (vendored content dedupe)", async () => {
    const { state, updateLibrary } = makeUpdateLibrary();
    const lib: LibraryItems = pkg.restoreLibraryItems(
      FIXTURE_ITEMS.slice(1, 3),
      "unpublished",
    ) as LibraryItems;
    await installLibraryPayload(realPipeline, updateLibrary, lib);
    const again = await installLibraryPayload(realPipeline, updateLibrary, lib);
    expect(again).toHaveLength(2);
    expect(state.items).toHaveLength(2);
    expectUnique(state.items);
  });

  it("repeated read/write/read round trip: heal → persist → real-restore re-seed stays unique", async () => {
    // The on-disk interchange loop: the persisted body is what GET /library
    // returns next session; seeding restores it. Repeat the full cycle.
    let current: LibraryItems = dedupeLibraryItems(
      pkg.mergeLibraryItems(
        [],
        pkg.restoreLibraryItems(FIXTURE_ITEMS, "unpublished"),
      ) as LibraryItems,
    );
    for (let round = 1; round <= 3; round++) {
      const body = JSON.stringify({
        type: "excalidrawlib",
        version: 2,
        libraryItems: current,
      });
      // Next session's seed: parse + restore + (choke point) dedupe.
      const reseeded = dedupeLibraryItems(
        pkg.restoreLibraryItems(
          (JSON.parse(body) as { libraryItems: LibraryItems }).libraryItems,
          "unpublished",
        ) as LibraryItems,
      );
      expect(reseeded).toHaveLength(3);
      expectUnique(reseeded);
      expect(sameContent(reseeded as never, current as never)).toBe(true);
      current = reseeded;
    }
  });
});
