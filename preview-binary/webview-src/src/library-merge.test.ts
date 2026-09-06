// D3 library unique-id invariant — the pure-module suite (spec §3.5.2 / §3.6).
//
// Everything here drives `library-merge.ts` and `persistLibraryItems` with
// injected I/O per the `dirty-state.test.ts` convention: the vendored package's
// merge/parse semantics are represented by fakes that mirror the published
// implementation (cited inline from the vendored 0.18.1 dev dist), because the
// pure modules must run without the package. The REAL vendored functions are
// pinned against the exact same scenarios by `library-vendored.test.ts`.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// dirty-state.ts transitively imports scene-fingerprint.ts, whose
// hashElementsVersion comes from the package — stub it (dirty-state.test.ts
// convention) so this suite never loads the vendored bundle.
vi.mock("@excalidraw/excalidraw", () => ({
  hashElementsVersion: vi.fn(
    (elements: readonly unknown[]) => `v${elements.length}`,
  ),
}));

import {
  dedupeLibraryItems,
  installLibraryPayload,
  sanitizePersistedLibrary,
  type LibraryPipeline,
} from "./library-merge";
import { persistLibraryItems } from "./dirty-state";
import type {
  LibraryItem,
  LibraryItems,
} from "@excalidraw/excalidraw/types";

// ── Fixture helpers ──────────────────────────────────────────────────────────

/** Minimal well-formed library item with elements carrying updated/versionNonce. */
function item(
  id: string,
  opts: {
    updated?: number;
    nonce?: number;
    elementCount?: number;
    status?: LibraryItem["status"];
    name?: string;
  } = {},
): LibraryItem {
  const n = opts.elementCount ?? 1;
  return {
    id,
    status: opts.status ?? "unpublished",
    created: 1_000,
    ...(opts.name === undefined ? {} : { name: opts.name }),
    elements: Array.from({ length: n }, (_, i) => ({
      id: `${id}-e${i}`,
      type: "rectangle",
      version: 1,
      versionNonce: opts.nonce ?? 1,
      updated: opts.updated ?? 1_000,
    })) as unknown as LibraryItem["elements"],
  };
}

/** Content-only restamp: what an edit (or any nonce-bumping pass) does. */
function restamp(items: LibraryItems, nonce: number, updated: number): LibraryItems {
  return items.map((it) => ({
    ...it,
    elements: it.elements.map((e) => ({
      ...e,
      versionNonce: nonce,
      updated,
    })) as LibraryItem["elements"],
  }));
}

/** The exact original failing input, verbatim from the reporting setup. */
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const corruptedFileText = readFileSync(
  `${FIXTURES_DIR}/corrupted-library.excalidrawlib`,
  "utf8",
);
const corruptedFile = JSON.parse(corruptedFileText) as {
  libraryItems: LibraryItems;
};

/** Asserts the D3 invariant: at most one entry per library-item id. */
function expectUniqueIds(items: readonly unknown[]): void {
  const ids = items.map((it) => (it as { id?: unknown }).id);
  expect(new Set(ids).size, `duplicate ids in: ${JSON.stringify(ids)}`).toBe(
    ids.length,
  );
}

// ── dedupeLibraryItems ───────────────────────────────────────────────────────

describe("dedupeLibraryItems — the D3 choke point", () => {
  it("heals the appendix's exact corruption signature (same block appended twice, first copies newest)", () => {
    // First copies newer (the reporting file's layout: firsts stamped later
    // than seconds), duplicated block back-to-back.
    const input: LibraryItems = [
      item("A", { updated: 2_000 }),
      item("B", { updated: 2_000 }),
      item("A", { updated: 1_000 }),
      item("B", { updated: 1_000 }),
    ];
    const out = dedupeLibraryItems(input);
    expect(out.map((it) => it.id)).toEqual(["A", "B"]);
    // Newest content survives, in the first-occurrence slots.
    expect(out[0]).toEqual(item("A", { updated: 2_000 }));
    expect(out[1]).toEqual(item("B", { updated: 2_000 }));
    expectUniqueIds(out);
  });

  it("keeps the newer copy when the second occurrence is the newer one (restamp direction reversed)", () => {
    const input: LibraryItems = [
      item("A", { updated: 1_000 }),
      item("A", { updated: 2_000 }),
    ];
    const out = dedupeLibraryItems(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(item("A", { updated: 2_000 }));
  });

  it("ties keep the earlier-seen copy (deterministic)", () => {
    const first = item("A", { updated: 1_500, nonce: 1 });
    const second = item("A", { updated: 1_500, nonce: 2 });
    const out = dedupeLibraryItems([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(first);
  });

  it("items with no usable updated values dedupe by position (both 0 → earlier wins)", () => {
    const input: LibraryItems = [
      { ...item("A"), elements: [] as LibraryItem["elements"] },
      { ...item("A"), elements: [] as LibraryItem["elements"] },
    ];
    const out = dedupeLibraryItems(input);
    expect(out).toHaveLength(1);
  });

  it("collapses triplicates to one survivor (the newest), preserving first-occurrence order", () => {
    const input: LibraryItems = [
      item("keep", { updated: 1 }),
      item("x", { updated: 1 }),
      item("y", { updated: 2 }),
      item("x", { updated: 5 }),
      item("x", { updated: 3 }),
      item("y", { updated: 9 }),
    ];
    const out = dedupeLibraryItems(input);
    expect(out.map((it) => it.id)).toEqual(["keep", "x", "y"]);
    expect(
      (out[1] as { elements: readonly { updated: number }[] }).elements[0]!
        .updated,
    ).toBe(5);
    expect(
      (out[2] as { elements: readonly { updated: number }[] }).elements[0]!
        .updated,
    ).toBe(9);
  });

  it("an already-clean input is returned as the SAME reference (no-op, byte-stable)", () => {
    const clean: LibraryItems = [item("A"), item("B", { status: "published" })];
    expect(dedupeLibraryItems(clean)).toBe(clean);
    expect(JSON.stringify(dedupeLibraryItems(clean))).toBe(
      JSON.stringify(clean),
    );
  });

  it("entries without a usable id pass through untouched and cannot collide", () => {
    const v1Style = [{ id: "e1" }, { id: "e2" }] as unknown as LibraryItem;
    const malformed = { nope: true } as unknown as LibraryItem;
    const keyed = item("A");
    const out = dedupeLibraryItems([v1Style, malformed, keyed, malformed]);
    expect(out).toEqual([v1Style, malformed, keyed, malformed]);
    expectUniqueIds(out.filter((it) => typeof (it as { id?: unknown }).id === "string"));
  });

  it("an empty input is empty", () => {
    expect(dedupeLibraryItems([])).toEqual([]);
  });

  it("survivor selection uses the NEWEST element updated across multi-element items", () => {
    const older = {
      ...item("A", { elementCount: 3, updated: 100 }),
    };
    const newer = {
      ...item("A", { elementCount: 3, updated: 90 }),
    };
    // newer's last element was touched later than any of older's.
    (newer.elements as unknown as { updated: number }[])[2]!.updated = 999;
    const out = dedupeLibraryItems([older, newer]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(newer);
  });
});

// ── sanitizePersistedLibrary (the seeding flow / corrupted-library remedy) ──

describe("sanitizePersistedLibrary — GET /library seeding (dedupe on load)", () => {
  it("heals the EXACT original failing input: the verbatim corrupted persisted file", () => {
    // The fixture is a verbatim slice of the reporting setup's
    // library.excalidrawlib: one unique published item + two id-duplicated
    // pairs (first copies newer), the appendix §1 corruption signature.
    const raw = corruptedFile.libraryItems;
    expect(raw).toHaveLength(5); // 1 unique + 2 pairs
    const ids = raw.map((it) => it.id);
    expect(new Set(ids).size).toBe(3); // exactly two duplicated ids

    const healed = sanitizePersistedLibrary(JSON.parse(corruptedFileText));
    expect(healed).toHaveLength(3);
    expectUniqueIds(healed);
    // Survivors are the first copies (newest element `updated`), positions
    // preserved; the untouched published context item stays first.
    expect(healed.map((it) => it.id)).toEqual([
      "sVymH6pRoTbKGC4NU75Kd",
      "7SNHsUd51YIGd3PHQjqFa",
      "fKO24kp2k8TL6WPetUflc",
    ]);
    expect(healed[0]!.status).toBe("published");
  });

  it("a clean envelope returns the items unchanged (same reference)", () => {
    const items: LibraryItems = [item("A"), item("B")];
    const out = sanitizePersistedLibrary({
      type: "excalidrawlib",
      version: 2,
      libraryItems: items,
    });
    expect(out).toBe(items);
  });

  it("representation variants: missing / malformed envelopes seed an empty panel", () => {
    expect(sanitizePersistedLibrary(null)).toEqual([]);
    expect(sanitizePersistedLibrary("excalidrawlib")).toEqual([]);
    expect(sanitizePersistedLibrary({})).toEqual([]);
    expect(sanitizePersistedLibrary({ libraryItems: "nope" })).toEqual([]);
    expect(sanitizePersistedLibrary({ type: "excalidrawlib", version: 2 })).toEqual([]);
  });

  it("a v1 library (bare element arrays) passes through for the vendored restore to key", () => {
    const v1 = [
      [{ id: "e1" }, { id: "e2" }],
      [{ id: "e3" }],
    ] as unknown as LibraryItems;
    const out = sanitizePersistedLibrary({ libraryItems: v1 });
    expect(out).toBe(v1);
  });
});

// ── The vendored-semantics fakes (mirroring the published 0.18.1 code) ──────

/**
 * Mirrors the vendored `mergeLibraryItems` (dist/dev/index.js:9401-9419):
 * an incoming item is "unique" unless some existing item has the same element
 * count with identical element ids in order AND identical per-element
 * `versionNonce`s; unique items are PREPENDED. Id-equal but content-differing
 * items are appended — the twin root cause.
 */
function vendoredMergeFake(
  existing: LibraryItems,
  incoming: LibraryItems,
): LibraryItems {
  const isUnique = (target: LibraryItem) =>
    !existing.some(
      (libItem) =>
        libItem.elements.length === target.elements.length &&
        libItem.elements.every(
          (el, idx) =>
            el.id === target.elements[idx]!.id &&
            el.versionNonce === target.elements[idx]!.versionNonce,
        ),
    );
  return [...incoming.filter(isUnique), ...existing];
}

/**
 * Mirrors `Library.updateLibrary`'s function-form path (index.js:9506-9575):
 * the updater receives the current items, its result is re-normalized
 * (`restoreLibraryItems`, which preserves ids and content — pinned by the
 * vendored proxy suite) and REPLACES the library; the update's return value is
 * the new state. `openLibraryMenu` is surfaced for pass-through assertions.
 */
function makeFakeUpdateLibrary() {
  const state = { items: [] as LibraryItems, openedMenuCount: 0 };
  const updateLibrary = async (opts: {
    libraryItems: (current: LibraryItems) => Promise<LibraryItems>;
    openLibraryMenu?: boolean;
  }): Promise<LibraryItems> => {
    if (opts.openLibraryMenu) state.openedMenuCount += 1;
    const next = await opts.libraryItems(state.items);
    // Simulate the vendored restore pass over the result: clone (ids and
    // content preserved).
    state.items = structuredClone(next) as LibraryItems;
    return state.items;
  };
  return { state, updateLibrary };
}

/** The fake pipeline mirrors the App wiring of the vendored functions. */
const fakePipeline: LibraryPipeline = {
  mergeItems: vendoredMergeFake,
  parseBlob: async (blob) => JSON.parse(await blob.text()).libraryItems,
  restoreItems: (items) => structuredClone(items) as LibraryItems,
};

// ── installLibraryPayload — the two install flows (§3.5.2 interleavings) ────

describe("installLibraryPayload — Browse-install / SSE re-delivery / import", () => {
  it("SSE re-delivery of an already-installed library is idempotent (identical content, no duplicate)", async () => {
    const { state, updateLibrary } = makeFakeUpdateLibrary();
    const lib: LibraryItems = [item("A"), item("B")];
    await installLibraryPayload(fakePipeline, updateLibrary, lib);
    expect(state.items.map((it) => it.id)).toEqual(["A", "B"]);

    // Re-deliver the exact same bytes (same nonces) — the vendored merge
    // itself dedupes this case by content equality; the panel must be
    // unchanged and still unique.
    await installLibraryPayload(fakePipeline, updateLibrary, lib);
    expect(state.items.map((it) => it.id)).toEqual(["A", "B"]);
    expectUniqueIds(state.items);
  });

  it("RESTAMPED re-delivery — the reported twin interleaving — leaves one entry per id (regression)", async () => {
    const { state, updateLibrary } = makeFakeUpdateLibrary();
    const lib: LibraryItems = [item("A", { nonce: 1, updated: 1_000 })];
    await installLibraryPayload(fakePipeline, updateLibrary, lib);

    // Without the choke point the vendored merge appends the re-stamped copy
    // (root cause, asserted here so the regression stays explained)…
    const restamped = restamp(lib, 2, 2_000);
    expect(vendoredMergeFake(state.items, fakePipeline.restoreItems(restamped)))
      .toHaveLength(2);

    // …with the choke point, the panel keeps exactly one entry — the newest.
    await installLibraryPayload(fakePipeline, updateLibrary, restamped);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.id).toBe("A");
    expect(
      (state.items[0]!.elements[0] as { updated: number }).updated,
    ).toBe(2_000);
    expectUniqueIds(state.items);
  });

  it("Browse-install colliding with existing panel entries: one survivor per id", async () => {
    const { state, updateLibrary } = makeFakeUpdateLibrary();
    await installLibraryPayload(fakePipeline, updateLibrary, [
      item("x", { nonce: 1, updated: 1_000 }),
      item("old", { updated: 500 }),
    ]);

    // Incoming: a NEWER copy of the colliding id + a brand-new id.
    await installLibraryPayload(
      fakePipeline,
      updateLibrary,
      [item("x", { nonce: 9, updated: 3_000 }), item("y")],
    );

    expectUniqueIds(state.items);
    expect(state.items.map((it) => it.id).sort()).toEqual(["old", "x", "y"]);
    const survivor = state.items.find((it) => it.id === "x")!;
    expect((survivor.elements[0] as { updated: number }).updated).toBe(3_000);
  });

  it("an OLDER incoming copy never displaces the newer panel entry", async () => {
    const { state, updateLibrary } = makeFakeUpdateLibrary();
    await installLibraryPayload(
      fakePipeline,
      updateLibrary,
      [item("x", { nonce: 5, updated: 5_000 })],
    );
    await installLibraryPayload(
      fakePipeline,
      updateLibrary,
      [item("x", { nonce: 1, updated: 1_000 })],
    );
    expect(state.items).toHaveLength(1);
    expect((state.items[0]!.elements[0] as { updated: number }).updated).toBe(
      5_000,
    );
  });

  it("input representation variants: Blob payloads parse through parseBlob; arrays through restoreItems", async () => {
    const blobLib = makeFakeUpdateLibrary();
    const blob = new Blob(
      [
        JSON.stringify({
          type: "excalidrawlib",
          version: 2,
          libraryItems: [item("from-blob")],
        }),
      ],
      { type: "application/json" },
    );
    const out = await installLibraryPayload(
      fakePipeline,
      blobLib.updateLibrary,
      blob,
    );
    expect(out.map((it) => it.id)).toEqual(["from-blob"]);

    const arrLib = makeFakeUpdateLibrary();
    const arr = await installLibraryPayload(
      fakePipeline,
      arrLib.updateLibrary,
      [item("from-array")],
    );
    expect(arr.map((it) => it.id)).toEqual(["from-array"]);
  });

  it("openLibraryMenu passes through to updateLibrary (SSE flow UX unchanged)", async () => {
    const { state, updateLibrary } = makeFakeUpdateLibrary();
    await installLibraryPayload(
      fakePipeline,
      updateLibrary,
      [item("A")],
      { openLibraryMenu: true },
    );
    expect(state.openedMenuCount).toBe(1);
  });

  it("the update is atomic: the panel never observes an intermediate twinned state", async () => {
    // The updater dedupes INSIDE the single updateLibrary call, so even a
    // twin-producing merge is resolved before the panel state is replaced.
    const { state, updateLibrary } = makeFakeUpdateLibrary();
    await installLibraryPayload(fakePipeline, updateLibrary, [
      item("A", { nonce: 1, updated: 1 }),
    ]);
    await installLibraryPayload(
      fakePipeline,
      updateLibrary,
      restamp([item("A", { nonce: 1, updated: 1 })], 7, 77),
    );
    expectUniqueIds(state.items);
    expect(state.items).toHaveLength(1);
  });

  it("sequential installs of several pending libraries each preserve the invariant", async () => {
    const { state, updateLibrary } = makeFakeUpdateLibrary();
    const l1: LibraryItems = [item("a1"), item("shared", { nonce: 1, updated: 10 })];
    const l2: LibraryItems = [item("b1"), item("shared", { nonce: 2, updated: 20 })];
    for (const lib of [l1, l2]) {
      await installLibraryPayload(fakePipeline, updateLibrary, lib);
      expectUniqueIds(state.items);
    }
    expect(state.items.map((it) => it.id).sort()).toEqual(["a1", "b1", "shared"]);
    expect(
      (state.items.find((it) => it.id === "shared")!.elements[0] as {
        updated: number;
      }).updated,
    ).toBe(20);
  });
});

// ── persistLibraryItems — the persistence choke point ────────────────────────

describe("persistLibraryItems — POST /library carries the invariant (D3)", () => {
  /** Captures every POST body the injected fetch receives. */
  function makeCapturingFetch(status = 200) {
    const bodies: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      bodies.push(init!.body as string);
      return new Response(null, { status });
    }) as typeof fetch;
    return { bodies, fetchFn };
  }

  it("a duplicated input is persisted deduped (the exact corrupted fixture items)", async () => {
    const { bodies, fetchFn } = makeCapturingFetch();
    const dirty = { current: true };
    const ok = await persistLibraryItems(
      corruptedFile.libraryItems,
      dirty,
      fetchFn,
    );
    expect(ok).toBe(true);
    expect(dirty.current).toBe(false);
    const persisted = JSON.parse(bodies[0]!) as {
      type: string;
      version: number;
      libraryItems: LibraryItems;
    };
    expect(persisted.type).toBe("excalidrawlib");
    expect(persisted.version).toBe(2);
    expect(persisted.libraryItems).toHaveLength(3);
    expectUniqueIds(persisted.libraryItems);
  });

  it("a clean input serializes byte-identically to before the choke point", async () => {
    const { bodies, fetchFn } = makeCapturingFetch();
    const items: LibraryItems = [item("A"), item("B", { status: "published" })];
    await persistLibraryItems(items, { current: false }, fetchFn);
    expect(bodies[0]).toBe(
      JSON.stringify({
        type: "excalidrawlib",
        version: 2,
        libraryItems: items,
      }),
    );
  });

  it("read/write/read round trip: a persisted body re-seeds to the same healed set, repeatedly", async () => {
    // Cycle: seed (sanitize) → persist (dedupe) → parse the body back →
    // seed again. Stable from the first cycle on.
    let current: LibraryItems = sanitizePersistedLibrary(
      JSON.parse(corruptedFileText),
    );
    for (let round = 1; round <= 3; round++) {
      const { bodies, fetchFn } = makeCapturingFetch();
      await persistLibraryItems(current, { current: true }, fetchFn);
      const body = JSON.parse(bodies[0]!) as { libraryItems: LibraryItems };
      const reseeded = sanitizePersistedLibrary(body);
      expect(reseeded).toHaveLength(3);
      expectUniqueIds(reseeded);
      expect(reseeded).toEqual(current);
      current = reseeded;
    }
  });
});

// ── Arbitrary interleavings of the four flows (§3.5.2) ───────────────────────

describe("arbitrary interleavings of the four flows keep the invariant (deterministic seeds)", () => {
  /** mulberry32 — tiny deterministic PRSPG so interleavings are reproducible. */
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Drives the four flows against shared fake state, exactly as the app wires
   * them: seeding (sanitizePersistedLibrary), installs
   * (installLibraryPayload), panel edits (updateLibrary function form — the
   * onLibraryChange mirror), and persistence (persistLibraryItems with an
   * injected fetch). After every step the panel state satisfies the
   * invariant; the persisted file is checked after every write.
   */
  it.each([1, 2, 3, 7, 42, 1337, 90210, 20260906])(
    "seed %d: panel and every persisted payload stay unique-ided",
    async (seed) => {
      const rand = prng(seed);
      const pick = <T,>(xs: readonly T[]): T =>
        xs[Math.floor(rand() * xs.length)]!;

      const { state: panel, updateLibrary } = makeFakeUpdateLibrary();
      let ref: LibraryItems = []; // the libraryItemsRef mirror
      const persistedBodies: string[] = [];
      const fetchFn = (async (_url: string, init?: RequestInit) => {
        persistedBodies.push(init!.body as string);
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      // A small universe of payloads, including re-stampable twins.
      const stockIds = ["p", "q", "r"];
      let nonce = 100;
      let clock = 10_000;
      const makePayload = (): LibraryItems =>
        stockIds
          .filter(() => rand() < 0.7)
          .map((id) =>
            item(id, { nonce: (nonce += 1), updated: (clock += 1) }),
          );
      let nextPayload = makePayload();

      for (let step = 0; step < 40; step++) {
        const op = pick(["seed", "install", "install", "panel-edit", "persist"] as const);
        switch (op) {
          case "seed": {
            // Flow 1: initial seeding from GET /library — sometimes a
            // corrupted envelope (duplicated ids), like the reporting file.
            const base = makePayload();
            const corrupted =
              rand() < 0.5 && base.length > 0
                ? [...base, ...restamp(base, (nonce += 1), (clock += 1))]
                : base;
            const seeded = sanitizePersistedLibrary({
              type: "excalidrawlib",
              version: 2,
              libraryItems: corrupted,
            });
            await updateLibrary({
              libraryItems: async () => seeded,
            });
            ref = seeded;
            break;
          }
          case "install": {
            // Flows 2+3: Browse-install / SSE re-delivery — sometimes the
            // same payload re-delivered after a restamp (the twin producer).
            let payload = nextPayload;
            if (rand() < 0.35) {
              payload = restamp(payload, (nonce += 1), (clock += 1));
            }
            const asBlob = rand() < 0.5;
            const merged = await installLibraryPayload(
              fakePipeline,
              updateLibrary,
              asBlob
                ? new Blob(
                    [
                      JSON.stringify({
                        type: "excalidrawlib",
                        version: 2,
                        libraryItems: payload,
                      }),
                    ],
                    { type: "application/json" },
                  )
                : payload,
              { openLibraryMenu: false },
            );
            ref = merged;
            nextPayload = makePayload();
            break;
          }
          case "panel-edit": {
            // Flow 4a: a panel edit (rename / add) mirrored into the ref and
            // debounced-persisted below, exactly as handleLibraryChange does.
            const edited = [
              ...(structuredClone(panel.items) as LibraryItems),
            ] as LibraryItem[];
            if (edited.length > 0 && rand() < 0.5) {
              (edited[Math.floor(rand() * edited.length)]! as { name?: string }).name =
                `renamed-${step}`;
            } else {
              edited.push(item(`user-${step}`, { nonce: (nonce += 1), updated: (clock += 1) }));
            }
            await updateLibrary({ libraryItems: async () => edited });
            ref = edited;
            break;
          }
          case "persist": {
            // Flow 4b: debounced (or import/close) persistence through the
            // choke point.
            const dirty = { current: true };
            const ok = await persistLibraryItems(ref, dirty, fetchFn);
            expect(ok).toBe(true);
            expect(dirty.current).toBe(false);
            break;
          }
        }

        // Dependent state, after EVERY step: the panel and the ref mirror
        // satisfy the invariant.
        expectUniqueIds(panel.items);
        expectUniqueIds(ref);
      }

      // Downstream state: every persisted payload this session produced is
      // unique-ided, and the final file re-seeds to a unique panel.
      expect(persistedBodies.length).toBeGreaterThan(0);
      for (const body of persistedBodies) {
        const parsed = JSON.parse(body) as { libraryItems: LibraryItems };
        expectUniqueIds(parsed.libraryItems);
      }
      const finalFile = JSON.parse(
        persistedBodies[persistedBodies.length - 1]!,
      ) as { libraryItems: LibraryItems };
      expectUniqueIds(sanitizePersistedLibrary(finalFile));
    },
  );
});

// ── Passive corpus: every shipped library fixture ────────────────────────────

describe("passive corpus: every shipped library fixture heals under the choke point", () => {
  const fixtures = readdirSync(FIXTURES_DIR).filter((f) =>
    f.endsWith(".excalidrawlib"),
  );

  it("found the shipped fixtures (corpus is non-empty)", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("%s: seeds unique, persists unique, re-seeds stable", (name) => {
    const text = readFileSync(`${FIXTURES_DIR}/${name}`, "utf8");
    const seeded = sanitizePersistedLibrary(JSON.parse(text));
    expectUniqueIds(seeded);

    // Write (through the persist choke point) then read back.
    const body = JSON.stringify({
      type: "excalidrawlib",
      version: 2,
      libraryItems: seeded,
    });
    const reseeded = sanitizePersistedLibrary(JSON.parse(body));
    expect(reseeded).toEqual(seeded);
    expectUniqueIds(reseeded);
  });
});
