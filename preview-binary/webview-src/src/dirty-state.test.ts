import { describe, it, expect, vi } from "vitest";

// hashElementsVersion is pulled in transitively via seedHashFromInitialData →
// computeSceneHash; stub it with a deterministic length-based hash so the
// seeding helper is testable without the heavy package (mirrors
// scene-fingerprint.test.ts).
vi.mock("@excalidraw/excalidraw", () => ({
  hashElementsVersion: vi.fn(
    (elements: readonly unknown[]) => `v${elements.length}`,
  ),
}));

import {
  applyExternalReload,
  decideAutoSaveSchedule,
  decideSaveOutcome,
  flushPendingLibrary,
  flushPendingSave,
  initialLibraryItems,
  persistLibraryItems,
  seedHashFromInitialData,
  type AutoSaveState,
  type ReloadSceneApi,
} from "./dirty-state";
import { computeSceneHash } from "./scene-fingerprint";
import type {
  ExcalidrawInitialDataState,
  AppState as ExcalidrawAppState,
  BinaryFiles,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

describe("decideSaveOutcome", () => {
  const base = { mySeq: 1, lastCompletedSeq: 0, autoSave: false };

  it("clears dirty and is clean when the saved scene is still current", () => {
    expect(
      decideSaveOutcome({ ...base, savedHash: "h1", currentHash: "h1" }),
    ).toEqual({
      superseded: false,
      clearDirty: true,
      rescheduleSave: false,
      isClean: true,
    });
    expect(
      decideSaveOutcome({
        ...base,
        autoSave: true,
        savedHash: "h1",
        currentHash: "h1",
      }),
    ).toEqual({
      superseded: false,
      clearDirty: true,
      rescheduleSave: false,
      isClean: true,
    });
  });

  it("stays dirty (not clean) when newer edits arrived mid-flight, manual save", () => {
    // The core finding-1/2 race: a stale save response must not mark a newer
    // scene clean — and must report it is NOT safe to close.
    expect(
      decideSaveOutcome({ ...base, savedHash: "saved", currentHash: "newer" }),
    ).toEqual({
      superseded: false,
      clearDirty: false,
      rescheduleSave: false,
      isClean: false,
    });
  });

  it("stays dirty AND reschedules under auto-save when edits arrived mid-flight", () => {
    expect(
      decideSaveOutcome({
        ...base,
        autoSave: true,
        savedHash: "saved",
        currentHash: "newer",
      }),
    ).toEqual({
      superseded: false,
      clearDirty: false,
      rescheduleSave: true,
      isClean: false,
    });
  });

  it("treats a null current hash as a mismatch", () => {
    expect(
      decideSaveOutcome({ ...base, savedHash: "saved", currentHash: null })
        .clearDirty,
    ).toBe(false);
  });

  it("marks an out-of-order (superseded) response and leaves dirty state alone", () => {
    // Finding 5: save A (seq 1) resolves *after* save B (seq 2) already
    // completed. A must not touch dirty state even though its snapshot is stale.
    const decision = decideSaveOutcome({
      autoSave: true,
      savedHash: "sceneA",
      currentHash: "sceneB",
      mySeq: 1,
      lastCompletedSeq: 2,
    });
    expect(decision.superseded).toBe(true);
    expect(decision.clearDirty).toBe(false);
    expect(decision.rescheduleSave).toBe(false);
  });

  it("a superseded response whose snapshot still matches is reported clean", () => {
    const decision = decideSaveOutcome({
      autoSave: false,
      savedHash: "scene",
      currentHash: "scene",
      mySeq: 1,
      lastCompletedSeq: 2,
    });
    expect(decision.superseded).toBe(true);
    expect(decision.isClean).toBe(true);
  });

  it("the latest of two overlapping saves is not superseded and clears dirty", () => {
    // B (seq 2) completes; nothing newer has completed (lastCompletedSeq 0).
    const decision = decideSaveOutcome({
      autoSave: true,
      savedHash: "sceneB",
      currentHash: "sceneB",
      mySeq: 2,
      lastCompletedSeq: 0,
    });
    expect(decision.superseded).toBe(false);
    expect(decision.clearDirty).toBe(true);
  });
});

describe("flushPendingSave", () => {
  it("clears a pending timer and reports it was pending", () => {
    const timer = { current: setTimeout(() => {}, 10_000) };
    expect(flushPendingSave(timer)).toBe(true);
    expect(timer.current).toBeNull();
  });

  it("is a no-op (returns false) when no save is pending", () => {
    const timer = { current: null };
    expect(flushPendingSave(timer)).toBe(false);
    expect(timer.current).toBeNull();
  });
});

describe("flushPendingLibrary", () => {
  it("persists pending edits and cancels the debounce timer", async () => {
    const timer = { current: setTimeout(() => {}, 10_000) };
    const dirty = { current: true };
    const persist = vi.fn(() => {
      dirty.current = false;
      return Promise.resolve(true);
    });

    expect(await flushPendingLibrary(timer, dirty, persist)).toBe(true);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(timer.current).toBeNull();
    expect(dirty.current).toBe(false);
  });

  it("propagates a failed write (false) and leaves dirty set for retry", async () => {
    // review 6, finding 1: a failed library write must surface so a waiting
    // close flow keeps the window open rather than dropping the edit.
    const timer = { current: setTimeout(() => {}, 10_000) };
    const dirty = { current: true };
    const persist = vi.fn(() => Promise.resolve(false));

    expect(await flushPendingLibrary(timer, dirty, persist)).toBe(false);
    expect(dirty.current).toBe(true);
    expect(timer.current).toBeNull();
  });

  it("does not persist when nothing is pending, but still clears the timer", async () => {
    const timer = { current: setTimeout(() => {}, 10_000) };
    const dirty = { current: false };
    const persist = vi.fn(() => Promise.resolve(true));

    // Nothing pending ⇒ already durable ⇒ resolves true without writing.
    expect(await flushPendingLibrary(timer, dirty, persist)).toBe(true);

    expect(persist).not.toHaveBeenCalled();
    expect(timer.current).toBeNull();
  });

  it("resolves immediately (true) with no timer and a clean library", async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    expect(
      await flushPendingLibrary({ current: null }, { current: false }, persist),
    ).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("persistLibraryItems", () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `lib${i}` })) as unknown as LibraryItems;

  function fakeResponse(ok: boolean, status: number): Response {
    return { ok, status } as Response;
  }

  it("clears dirty and returns true on a 2xx write", async () => {
    const dirty = { current: true };
    const fetchFn = vi.fn(() => Promise.resolve(fakeResponse(true, 200)));

    const ok = await persistLibraryItems(items(2), dirty, fetchFn as unknown as typeof fetch);

    expect(ok).toBe(true);
    expect(dirty.current).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/library");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      type: "excalidrawlib",
      version: 2,
    });
  });

  it("keeps dirty true and returns false on a 500 response", async () => {
    // review 6, finding 1: a failed write must not be acknowledged as success.
    const dirty = { current: true };
    const fetchFn = vi.fn(() => Promise.resolve(fakeResponse(false, 500)));

    const ok = await persistLibraryItems(items(1), dirty, fetchFn as unknown as typeof fetch);

    expect(ok).toBe(false);
    expect(dirty.current).toBe(true);
  });

  it("keeps dirty true and returns false when the fetch rejects", async () => {
    const dirty = { current: true };
    const fetchFn = vi.fn(() => Promise.reject(new Error("network down")));

    const ok = await persistLibraryItems(items(1), dirty, fetchFn as unknown as typeof fetch);

    expect(ok).toBe(false);
    expect(dirty.current).toBe(true);
  });
});

describe("decideAutoSaveSchedule", () => {
  const MAX = 2000;

  it("seeds firstDirtyAt and debounces the first dirty edit", () => {
    const state: AutoSaveState = { firstDirtyAt: null, maxWaitSaveInFlight: false };
    expect(decideAutoSaveSchedule(1000, MAX, state)).toBe("debounce");
    expect(state.firstDirtyAt).toBe(1000);
    expect(state.maxWaitSaveInFlight).toBe(false);
  });

  it("debounces while still within the max-wait window", () => {
    const state: AutoSaveState = { firstDirtyAt: 1000, maxWaitSaveInFlight: false };
    expect(decideAutoSaveSchedule(1000 + MAX - 1, MAX, state)).toBe("debounce");
    expect(state.firstDirtyAt).toBe(1000);
  });

  it("flushes once at the threshold and restarts the window", () => {
    // review 6, finding 2: the window restarts so the next flush can't fire
    // until another full maxWait elapses — a bounded ~2s checkpoint.
    const state: AutoSaveState = { firstDirtyAt: 1000, maxWaitSaveInFlight: false };
    expect(decideAutoSaveSchedule(1000 + MAX, MAX, state)).toBe("flush-maxwait");
    expect(state.firstDirtyAt).toBe(1000 + MAX);
    expect(state.maxWaitSaveInFlight).toBe(true);
  });

  it("does not flush again on every edit past the threshold (in-flight guard)", () => {
    // The core finding-2 regression: continuous drawing after the threshold
    // must not launch an overlapping save on each onChange.
    const state: AutoSaveState = { firstDirtyAt: 1000, maxWaitSaveInFlight: false };
    expect(decideAutoSaveSchedule(3000, MAX, state)).toBe("flush-maxwait");
    // Subsequent edits while that flush is in flight stay on the debounce path,
    // even though wall-clock keeps advancing past the (new) window.
    expect(decideAutoSaveSchedule(3001, MAX, state)).toBe("debounce");
    expect(decideAutoSaveSchedule(5500, MAX, state)).toBe("debounce");
  });

  it("flushes again only after the in-flight guard clears and a new window elapses", () => {
    const state: AutoSaveState = { firstDirtyAt: 1000, maxWaitSaveInFlight: false };
    expect(decideAutoSaveSchedule(3000, MAX, state)).toBe("flush-maxwait");
    // Caller clears the guard when the dispatched save settles.
    state.maxWaitSaveInFlight = false;
    // Not yet a full window since the restart at 3000.
    expect(decideAutoSaveSchedule(4000, MAX, state)).toBe("debounce");
    // A full window after the restart ⇒ a fresh checkpoint.
    expect(decideAutoSaveSchedule(5000, MAX, state)).toBe("flush-maxwait");
  });
});

describe("seedHashFromInitialData", () => {
  const els = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `e${i}` })) as unknown as ExcalidrawElement[];

  it("matches computeSceneHash for the same initial scene", () => {
    // Finding 6: the seed used on first render must equal the hash a no-op
    // first onChange produces, so the loaded scene is never marked dirty.
    const data = {
      elements: els(3),
      appState: { viewBackgroundColor: "#fff" },
      files: {},
    } as unknown as ExcalidrawInitialDataState;
    expect(seedHashFromInitialData(data)).toBe(
      computeSceneHash(els(3), { viewBackgroundColor: "#fff" }, {}),
    );
  });

  it("handles missing fields by treating them as an empty scene", () => {
    expect(seedHashFromInitialData(null)).toBe(seedHashFromInitialData({} as ExcalidrawInitialDataState));
    expect(seedHashFromInitialData(undefined)).toBe(
      computeSceneHash([], undefined, undefined),
    );
  });

  it("folds the injected name prop into the seed so a just-opened scene isn't dirty", () => {
    // The `<Excalidraw name>` prop sets appState.name (a fingerprinted key)
    // before the first onChange. The seed must include it, or the unedited
    // scene reads dirty on open.
    const data = {
      elements: els(2),
      appState: { viewBackgroundColor: "#fff" },
      files: {},
    } as unknown as ExcalidrawInitialDataState;
    // Seed with the name === the hash the first onChange produces (name applied).
    expect(seedHashFromInitialData(data, "diagram")).toBe(
      computeSceneHash(els(2), { viewBackgroundColor: "#fff", name: "diagram" }, {}),
    );
    // And it actually differs from the un-named seed (regression proof).
    expect(seedHashFromInitialData(data, "diagram")).not.toBe(
      seedHashFromInitialData(data),
    );
  });
});

describe("applyExternalReload", () => {
  const els = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `e${i}` })) as unknown as ExcalidrawElement[];

  // A minimal fake of the Excalidraw imperative API backed by mutable scene
  // state, so a reload followed by the onChange it triggers can be replayed.
  function makeFakeApi(initial: {
    elements: ExcalidrawElement[];
    appState: Record<string, unknown>;
    files?: BinaryFiles;
  }) {
    let elements = initial.elements;
    let appState: Record<string, unknown> = initial.appState;
    const files: Record<string, unknown> = { ...(initial.files ?? {}) };
    const updates: Array<{
      elements?: readonly ExcalidrawElement[];
      appState?: Record<string, unknown>;
    }> = [];
    const api = {
      getAppState: () => appState,
      addFiles: (arr: Array<{ id: string }>) => {
        for (const f of arr) files[f.id] = f;
      },
      updateScene: (scene: {
        elements?: readonly ExcalidrawElement[];
        appState?: Record<string, unknown>;
      }) => {
        updates.push(scene);
        if (scene.elements) elements = scene.elements as ExcalidrawElement[];
        if (scene.appState) appState = { ...appState, ...scene.appState };
      },
      getSceneElements: () => elements,
      getFiles: () => files as unknown as BinaryFiles,
    } as unknown as ReloadSceneApi;
    // The scene the next onChange would report (live, post-update state).
    const liveScene = () => ({
      elements,
      appState,
      files: files as unknown as BinaryFiles,
    });
    return { api, updates, liveScene };
  }

  // Replays handleChange's dirty core: a hash that differs from the baseline is
  // a real edit and flips dirty. Equal hashes are a no-op.
  function simulateOnChange(
    live: { elements: readonly ExcalidrawElement[]; appState: Record<string, unknown>; files: BinaryFiles },
    baseline: { value: string },
    flags: { dirty: boolean },
  ) {
    const hash = computeSceneHash(
      live.elements,
      live.appState as Partial<ExcalidrawAppState>,
      live.files,
    );
    if (hash === baseline.value) return;
    baseline.value = hash;
    flags.dirty = true;
  }

  it("re-baselines to the accepted scene so the triggered onChange stays clean", () => {
    // Old baseline: a 2-element scene with a white background.
    const { api, liveScene } = makeFakeApi({
      elements: els(2),
      appState: { viewBackgroundColor: "#fff", scrollX: 10 },
    });
    const baseline = {
      value: computeSceneHash(els(2), { viewBackgroundColor: "#fff" }, {}),
    };
    const flags = { dirty: false };
    let cleanReported = false;

    // External change on disk: 5 elements, black background.
    const newData = {
      elements: els(5),
      appState: { viewBackgroundColor: "#000", scrollX: 999 },
      files: {},
    } as unknown as ExcalidrawInitialDataState;

    const outcome = applyExternalReload(api, newData, {
      setBaselineHash: (h) => {
        baseline.value = h;
      },
      clearDirty: () => {
        flags.dirty = false;
      },
      reportClean: () => {
        cleanReported = true;
      },
    });

    expect(outcome).toBe("applied");
    expect(cleanReported).toBe(true);

    // The onChange that updateScene triggers reports the live scene — it must
    // NOT flip dirty (review 3, finding 2: no auto-save echo of accepted data).
    simulateOnChange(liveScene(), baseline, flags);
    expect(flags.dirty).toBe(false);
  });

  it("applies persisted appState (background) but never viewport from disk", () => {
    const { api, updates } = makeFakeApi({
      elements: els(1),
      appState: { viewBackgroundColor: "#fff" },
    });
    const newData = {
      elements: els(1),
      appState: { viewBackgroundColor: "#123456", scrollX: 4242, zoom: { value: 3 } },
    } as unknown as ExcalidrawInitialDataState;

    applyExternalReload(api, newData, {
      setBaselineHash: () => {},
      clearDirty: () => {},
      reportClean: () => {},
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].appState).toEqual({ viewBackgroundColor: "#123456" });
    // Viewport keys from disk must not be forwarded to updateScene.
    expect(updates[0].appState).not.toHaveProperty("scrollX");
    expect(updates[0].appState).not.toHaveProperty("zoom");
  });

  it("skips entirely while the user is mid-text-edit", () => {
    const { api, updates } = makeFakeApi({
      elements: els(1),
      appState: { editingTextElement: { id: "t" } },
    });
    let cleanReported = false;
    const outcome = applyExternalReload(
      api,
      { elements: els(9) } as unknown as ExcalidrawInitialDataState,
      {
        setBaselineHash: () => {},
        clearDirty: () => {},
        reportClean: () => {
          cleanReported = true;
        },
      },
    );
    expect(outcome).toBe("skipped-editing");
    expect(updates).toHaveLength(0);
    expect(cleanReported).toBe(false);
  });

  it("omits the appState patch from updateScene when disk has no persisted keys", () => {
    const { api, updates } = makeFakeApi({
      elements: els(1),
      appState: {},
    });
    applyExternalReload(
      api,
      { elements: els(2), appState: { scrollX: 5 } } as unknown as ExcalidrawInitialDataState,
      { setBaselineHash: () => {}, clearDirty: () => {}, reportClean: () => {} },
    );
    expect(updates[0]).not.toHaveProperty("appState");
  });
});

describe("initialLibraryItems", () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `lib${i}` })) as unknown as LibraryItems;

  it("returns persisted items from initialData", () => {
    const data = { libraryItems: items(3) } as unknown as ExcalidrawInitialDataState;
    expect(initialLibraryItems(data)).toHaveLength(3);
  });

  it("returns an empty list when absent or not an array", () => {
    expect(initialLibraryItems(null)).toEqual([]);
    expect(initialLibraryItems({} as ExcalidrawInitialDataState)).toEqual([]);
    expect(
      initialLibraryItems({ libraryItems: undefined } as ExcalidrawInitialDataState),
    ).toEqual([]);
  });
});
