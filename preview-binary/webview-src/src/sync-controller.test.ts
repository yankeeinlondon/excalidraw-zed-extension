import { describe, it, expect, vi } from "vitest";

// sync-controller → dirty-state → scene-fingerprint pulls in
// hashElementsVersion at runtime; stub it like dirty-state.test.ts does.
vi.mock("@excalidraw/excalidraw", () => ({
  hashElementsVersion: vi.fn(
    (elements: readonly unknown[]) => `v${elements.length}`,
  ),
}));

import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import {
  SyncController,
  decideReconcileAction,
  type SendWriteRequest,
  type SendWriteResult,
  type SnapshotResult,
  type SyncControllerDeps,
  type SyncUiState,
  type ViewerWriteOutcome,
} from "./sync-controller";
import { SaveQueue } from "./dirty-state";

const encoder = new TextEncoder();
const decoder = new TextDecoder();function bytesOf(text: string): ArrayBuffer {
  const encoded = encoder.encode(text);
  const out = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(out).set(encoded);
  return out;
}

/** Opaque, content-unique revision strings (the client never parses them). */
const rev = (text: string) => `"etag-of:${text}"`;

interface Harness {
  controller: SyncController;
  /** Live viewer state the controller re-reads at decision time. */
  state: { dirty: boolean; editing: boolean; saving: boolean };
  /** Scene markers passed to applyExternalScene, in order. */
  applied: string[];
  /** Every conditional-write request the server fake received. */
  writeRequests: SendWriteRequest[];
  /** Number of GET /data fetches issued. */
  fetches: number;
  /** Disk contents; null = absent; UNPARSABLE = parse failure. */
  setDisk(text: string | null): void;
  /** Holds parseSnapshot until released (gates the async gap). */
  gateParse(): { release(): void };
  /** A Rust-like conditional write endpoint over the harness disk. */
  serverSend(req: SendWriteRequest): Promise<SendWriteResult>;
  /** One attemptViewerWrite against serverSend. */
  attemptWrite(reason: string, newText: string): Promise<ViewerWriteOutcome>;
  ui(): SyncUiState;
}

function makeHarness(initialDisk: string = "scene-v0"): Harness {
  let disk: string | null = initialDisk;
  const state = { dirty: false, editing: false, saving: false };
  const applied: string[] = [];
  const writeRequests: SendWriteRequest[] = [];
  let fetches = 0;
  let parseGate: Promise<void> | null = null;

  const deps: SyncControllerDeps = {
    fetchSnapshot: async (): Promise<SnapshotResult> => {
      fetches += 1;
      if (disk === null) return { ok: false, status: 404 };
      return { ok: true, revision: rev(disk), bytes: bytesOf(disk) };
    },
    parseSnapshot: async (bytes) => {
      if (parseGate) await parseGate;
      const text = decoder.decode(bytes);
      if (text === "UNPARSABLE") throw new Error("cannot parse");
      return {
        elements: [{ id: text }],
      } as unknown as ExcalidrawInitialDataState;
    },
    isDirty: () => state.dirty,
    isEditing: () => state.editing,
    isSaving: () => state.saving,
    applyExternalScene: (data) => {
      if (state.editing) return "skipped-editing";
      const elements = data.elements as unknown as Array<{ id: string }>;
      applied.push(elements[0]?.id ?? "?");
      return "applied";
    },
  };

  const controller = new SyncController(deps);
  controller.seedAccepted(rev(initialDisk));

  const serverSend = async (req: SendWriteRequest): Promise<SendWriteResult> => {
    writeRequests.push(req);
    const current = disk === null ? '"absent"' : rev(disk);
    const candidates = req.ifMatch.split(",").map((c) => c.trim());
    if (!req.ifMatch) {
      return { kind: "error", message: "428", preconditionRequired: true };
    }
    if (!candidates.includes(current)) {
      return { kind: "conflict", etag: current };
    }
    disk = decoder.decode(
      req.body instanceof ArrayBuffer
        ? new Uint8Array(req.body)
        : encoder.encode(String(req.body)),
    );
    return { kind: "ok", etag: rev(disk) };
  };

  return {
    controller,
    state,
    applied,
    writeRequests,
    get fetches() {
      return fetches;
    },
    setDisk: (text) => {
      disk = text;
    },
    gateParse: () => {
      let release!: () => void;
      parseGate = new Promise<void>((r) => {
        release = r;
      });
      return {
        release: () => {
          release();
          parseGate = null;
        },
      };
    },
    serverSend,
    attemptWrite: (reason, newText) =>
      controller.attemptViewerWrite({
        body: newText,
        contentType: "application/json",
        reason,
        send: serverSend,
      }),
    ui: () => controller.snapshot(),
  };
}

describe("decideReconcileAction", () => {
  it("applies only when clean and idle", () => {
    expect(
      decideReconcileAction({ dirty: false, editing: false, saving: false }),
    ).toBe("apply");
  });

  it("defers while editing or saving, even when clean", () => {
    expect(
      decideReconcileAction({ dirty: false, editing: true, saving: false }),
    ).toBe("defer");
    expect(
      decideReconcileAction({ dirty: false, editing: false, saving: true }),
    ).toBe("defer");
  });

  it("conflicts when the viewer is durably dirty", () => {
    expect(
      decideReconcileAction({ dirty: true, editing: false, saving: false }),
    ).toBe("conflict");
    // Editing defers first — the conflict is re-decided when editing ends.
    expect(
      decideReconcileAction({ dirty: true, editing: true, saving: false }),
    ).toBe("defer");
  });
});

describe("SyncController.reconcile — apply path", () => {
  it("applies a new revision to a clean, idle viewer and advances accepted only after applying", async () => {
    const h = makeHarness("v0");
    h.setDisk("v1");
    await h.controller.reconcile("watcher");
    expect(h.applied).toEqual(["v1"]);
    expect(h.controller.acceptedRevision()).toBe(rev("v1"));
    expect(h.ui().conflict).toBeNull();
    expect(h.ui().error).toBeNull();
  });

  it("treats an already-accepted revision as a proven echo — no apply, no clock", async () => {
    const h = makeHarness("v0");
    await h.controller.reconcile("watcher");
    expect(h.applied).toEqual([]);
    expect(h.controller.acceptedRevision()).toBe(rev("v0"));
  });

  it("treats a Keep-authorized revision as known — no fresh conflict for it", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("v1");
    await h.controller.reconcile("watcher");
    expect(h.ui().conflict?.revision).toBe(rev("v1"));
    h.controller.resolveKeep();
    // The watcher fires again for the same bytes: already acknowledged.
    await h.controller.reconcile("watcher");
    expect(h.ui().conflict).toBeNull();
    expect(h.applied).toEqual([]);
  });

  it("re-checks the dirty guard AFTER the async parse — an edit landing during fetch+parse is never clobbered", async () => {
    const h = makeHarness("v0");
    h.setDisk("v1");
    const gate = h.gateParse();
    const pending = h.controller.reconcile("watcher");
    // The user edits while the parse is in flight (the classic pre-await
    // sampling bug: a guard evaluated before the await would miss this).
    h.state.dirty = true;
    gate.release();
    await pending;

    expect(h.applied).toEqual([]); // never applied over the edit
    expect(h.ui().conflict).toEqual({
      revision: rev("v1"),
      reason: "watcher",
    });
    expect(h.controller.acceptedRevision()).toBe(rev("v0"));
  });

  it("re-checks in the other direction — dirty at fetch time, clean by parse end, applies", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("v1");
    const gate = h.gateParse();
    const pending = h.controller.reconcile("watcher");
    // The dirty state cleared during the parse (e.g. the user undid the edit
    // or a save completed and this revision is what it acknowledged).
    h.state.dirty = false;
    gate.release();
    await pending;
    expect(h.applied).toEqual(["v1"]);
    expect(h.controller.acceptedRevision()).toBe(rev("v1"));
  });

  it("defers a mid-text-edit reload and applies it when editing ends — never drops it", async () => {
    const h = makeHarness("v0");
    h.state.editing = true;
    h.setDisk("v1");
    await h.controller.reconcile("watcher");
    expect(h.applied).toEqual([]);
    expect(h.ui().conflict).toBeNull();

    h.state.editing = false;
    await h.controller.editingEnded();
    expect(h.applied).toEqual(["v1"]);
    expect(h.controller.acceptedRevision()).toBe(rev("v1"));
  });

  it("defers while a save is in flight; the deferred revision is re-decided after it settles", async () => {
    const h = makeHarness("v0");
    h.state.saving = true;
    h.setDisk("v1");
    await h.controller.reconcile("watcher");
    expect(h.applied).toEqual([]);

    h.state.saving = false;
    await h.controller.saveSettled();
    expect(h.applied).toEqual(["v1"]);
  });

  it("a deferred reload that finds the viewer dirty when retried raises the conflict", async () => {
    const h = makeHarness("v0");
    h.state.editing = true;
    h.state.dirty = true;
    h.setDisk("v1");
    await h.controller.reconcile("watcher");
    h.state.editing = false;
    await h.controller.editingEnded();
    expect(h.applied).toEqual([]);
    expect(h.ui().conflict?.revision).toBe(rev("v1"));
  });

  it("coalesces concurrent reconciles into one in-flight fetch", async () => {
    const h = makeHarness("v0");
    h.setDisk("v1");
    const gate = h.gateParse();
    const p1 = h.controller.reconcile("watcher");
    const p2 = h.controller.reconcile("watcher");
    // While the first is still parsing, only one fetch has happened; the
    // second caller rides the same run.
    expect(h.fetches).toBe(1);
    gate.release();
    await Promise.all([p1, p2]);
    // The coalesced caller re-ran afterwards so the newest state is seen.
    expect(h.applied).toEqual(["v1"]);
  });

  it("404 (file unavailable) keeps the scene, dirty flag and accepted revision; retry recovers", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk(null);
    await h.controller.reconcile("watcher");
    expect(h.ui().error?.kind).toBe("unavailable");
    expect(h.applied).toEqual([]);
    expect(h.state.dirty).toBe(true);
    expect(h.controller.acceptedRevision()).toBe(rev("v0"));

    h.setDisk("v1");
    h.controller.retryError();
    await vi.waitFor(() => {
      expect(h.ui().error).toBeNull();
    });
  });
});

describe("SyncController.reconcile — conflict path", () => {
  it("a dirty viewer with a changed disk raises the pending conflict with the surfacing reason", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("v1");
    await h.controller.reconcile("watcher");
    expect(h.ui().conflict).toEqual({ revision: rev("v1"), reason: "watcher" });
    expect(h.applied).toEqual([]);
  });

  it("invalid external data keeps scene, dirty flag and accepted revision and shows a retryable error", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("UNPARSABLE");
    await h.controller.reconcile("watcher");
    expect(h.ui().error?.kind).toBe("parse-failed");
    expect(h.ui().conflict).toBeNull(); // an unparsable revision is never offered as a choice
    expect(h.applied).toEqual([]);
    expect(h.state.dirty).toBe(true);
    expect(h.controller.acceptedRevision()).toBe(rev("v0"));
  });

  it("a fetch rejection surfaces a retryable error and changes nothing", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    // Corrupt the fetch path by pointing disk at a sentinel the harness
    // turns into a thrown fetch: easiest is to wrap via a failing subclass —
    // instead, drive it through a controller whose fetchSnapshot rejects.
    const controller = new SyncController({
      fetchSnapshot: async () => {
        throw new Error("network down");
      },
      parseSnapshot: async () => ({}) as ExcalidrawInitialDataState,
      isDirty: () => true,
      isEditing: () => false,
      isSaving: () => false,
      applyExternalScene: () => "applied",
    });
    controller.seedAccepted(rev("v0"));
    await controller.reconcile("watcher");
    expect(controller.snapshot().error?.kind).toBe("fetch-failed");
    expect(h.controller.acceptedRevision()).toBe(rev("v0"));
  });
});

describe("SyncController.attemptViewerWrite — conditional writes", () => {
  it("sends If-Match with the accepted revision and adopts the response ETag", async () => {
    const h = makeHarness("v0");
    const result = await h.attemptWrite("keyboard", "v0-edited");
    expect(result.kind).toBe("ok");
    expect(h.writeRequests[0].ifMatch).toBe(rev("v0"));
    expect(h.controller.acceptedRevision()).toBe(rev("v0-edited"));
  });

  it("a viewer write's own revision is a proven echo — a later reconcile is a no-op", async () => {
    const h = makeHarness("v0");
    await h.attemptWrite("keyboard", "v0-edited");
    await h.controller.reconcile("watcher");
    expect(h.applied).toEqual([]);
    expect(h.ui().conflict).toBeNull();
  });

  it("serialized saves apply in order; the second uses the revision acknowledged by the first", async () => {
    const h = makeHarness("v0");
    const queue = new SaveQueue();
    const order: string[] = [];
    const first = queue.enqueue(async () => {
      order.push("first-start");
      await new Promise((r) => setTimeout(r, 10)); // async export
      order.push("first-write");
      return h.attemptWrite("menu", "save-A");
    });
    const second = queue.enqueue(async () => {
      order.push("second-start");
      order.push("second-write");
      return h.attemptWrite("menu", "save-B");
    });
    const [a, b] = await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-write", "second-start", "second-write"]);
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    expect(h.writeRequests[0].ifMatch).toBe(rev("v0"));
    // The acknowledged revision of the first write, not the pre-export seed.
    expect(h.writeRequests[1].ifMatch).toBe(rev("save-A"));
    // Disk ends at the newest serialized scene.
    expect(h.controller.acceptedRevision()).toBe(rev("save-B"));
  });

  it("a 412 from an auto-save keeps dirty state, does not advance accepted, and raises the conflict", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("external-v1");
    const result = await h.attemptWrite("autosave", "my-edit");
    expect(result).toMatchObject({ kind: "conflict", etag: rev("external-v1") });
    expect(h.ui().conflict).toEqual({
      revision: rev("external-v1"),
      reason: "save-412",
    });
    expect(h.controller.acceptedRevision()).toBe(rev("v0")); // unchanged
    expect(h.state.dirty).toBe(true); // dirty not cleared
    // The disk was NOT overwritten.
    expect(h.writeRequests).toHaveLength(1);
  });

  it("a 428 is a loud programming error and a surfaced save failure", async () => {
    const h = makeHarness("v0");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await h.controller.attemptViewerWrite({
        body: "x",
        contentType: "application/json",
        reason: "keyboard",
        send: async () => ({
          kind: "error" as const,
          message: "Save failed (HTTP 428: missing If-Match)",
          preconditionRequired: true,
        }),
      });
      expect(result.kind).toBe("error");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("428"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("blocks every write while a conflict is pending — auto-save, flush and close alike", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("external-v1");
    await h.controller.reconcile("watcher");
    expect(h.ui().conflict).not.toBeNull();

    for (const reason of ["autosave", "maxwait", "flush", "blur", "keyboard", "close"]) {
      const result = await h.attemptWrite(reason, "attempted");
      expect(result).toEqual({
        kind: "blocked",
        reason: "conflict-pending",
      });
    }
    expect(h.writeRequests).toHaveLength(0); // nothing hit disk
  });

  it("blocks writes while a Reload-from-disk resolution is applying", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("external-v1");
    await h.controller.reconcile("watcher");
    const gate = h.gateParse();
    const resolving = h.controller.resolveReload();
    const blocked = await h.attemptWrite("keyboard", "x");
    expect(blocked).toEqual({ kind: "blocked", reason: "applying" });
    gate.release();
    await resolving;
  });
});

describe("SyncController — conflict resolutions", () => {
  async function conflictedHarness(dirty = true) {
    const h = makeHarness("v0");
    h.state.dirty = dirty;
    h.setDisk("external-v1");
    await h.controller.reconcile("watcher");
    expect(h.ui().conflict).not.toBeNull();
    return h;
  }

  it("Reload from disk: parses first, applies through the guarded path, clears the conflict", async () => {
    const h = await conflictedHarness();
    await h.controller.resolveReload();
    expect(h.applied).toEqual(["external-v1"]);
    expect(h.controller.acceptedRevision()).toBe(rev("external-v1"));
    expect(h.ui().conflict).toBeNull();
    expect(h.ui().keepNotice).toBe(false);
  });

  it("a failed reload leaves the conflict pending (nothing applied, nothing cleared)", async () => {
    const h = await conflictedHarness();
    // The file becomes garbage before the user clicks Reload: the fetched
    // revision differs from the pending one, so the resolution re-reconciles,
    // and the re-reconcile's parse failure surfaces a retryable error.
    h.setDisk("UNPARSABLE");
    await h.controller.resolveReload();
    await vi.waitFor(() => {
      expect(h.ui().error?.kind).toBe("parse-failed");
    });
    expect(h.ui().conflict).not.toBeNull();
    expect(h.applied).toEqual([]);
    expect(h.controller.acceptedRevision()).toBe(rev("v0"));
  });

  it("a newer revision arriving mid-reload re-reconciles instead of applying the stale one", async () => {
    const h = await conflictedHarness();
    h.setDisk("external-v2");
    await h.controller.resolveReload();
    await vi.waitFor(() => {
      expect(h.ui().conflict?.revision).toBe(rev("external-v2"));
    });
    // The stale v1 was never applied.
    expect(h.applied).toEqual([]);
  });

  it("Keep my changes: authorizes only the displayed revision, keeps dirty, writes nothing, shows the notice", async () => {
    const h = await conflictedHarness();
    h.controller.resolveKeep();
    expect(h.ui().conflict).toBeNull();
    expect(h.ui().keepNotice).toBe(true);
    expect(h.controller.acceptedRevision()).toBe(rev("v0")); // baseline unchanged
    expect(h.state.dirty).toBe(true); // still dirty
    expect(h.writeRequests).toHaveLength(0); // no write on dismissal

    // Automatic writes stay paused; an explicit save may replace disk.
    const auto = await h.attemptWrite("autosave", "x");
    expect(auto).toEqual({ kind: "blocked", reason: "automatic-paused" });
    const explicit = await h.attemptWrite("keyboard", "my-version");
    expect(explicit.kind).toBe("ok");
    expect(h.writeRequests[0].ifMatch).toBe(rev("external-v1"));
    // The successful explicit write consumed the notice.
    expect(h.ui().keepNotice).toBe(false);
    expect(h.controller.acceptedRevision()).toBe(rev("my-version"));
  });

  it("a second external revision after Keep produces a fresh conflict — the conditional write fails rather than overwriting", async () => {
    const h = await conflictedHarness();
    h.controller.resolveKeep();
    h.setDisk("external-v2");
    const result = await h.attemptWrite("keyboard", "my-version");
    expect(result).toMatchObject({ kind: "conflict", etag: rev("external-v2") });
    expect(h.ui().conflict).toEqual({
      revision: rev("external-v2"),
      reason: "save-412",
    });
    // And via the watcher path the same holds: v2 is unknown.
    const h2 = await conflictedHarness();
    h2.controller.resolveKeep();
    h2.setDisk("external-v2");
    await h2.controller.reconcile("watcher");
    expect(h2.ui().conflict?.revision).toBe(rev("external-v2"));
  });

  it("Escape dismisses the modal but leaves the banner (conflict) and the save pause intact", async () => {
    const h = await conflictedHarness();
    // Escalate first so a modal exists (see the editor-closed suite below).
    h.state.dirty = true;
    await h.controller.editorClosed();
    expect(h.ui().modalRevision).toBe(rev("external-v1"));
    h.controller.dismissModal();
    expect(h.ui().modalRevision).toBeNull();
    expect(h.ui().conflict).not.toBeNull(); // banner stays
    // Save pause stays: writes still blocked.
    const blocked = await h.attemptWrite("keyboard", "x");
    expect(blocked).toEqual({ kind: "blocked", reason: "conflict-pending" });
  });
});

describe("SyncController — editor-closed escalation", () => {
  it("reconciles disk first and escalates a pending conflict to exactly one modal", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("external-v1");
    await h.controller.editorClosed();
    expect(h.ui().conflict).toEqual({
      revision: rev("external-v1"),
      reason: "editor-closed",
    });
    expect(h.ui().modalRevision).toBe(rev("external-v1"));
  });

  it("duplicate closes for the same unresolved revision never stack a second prompt", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("external-v1");
    await h.controller.editorClosed();
    await h.controller.editorClosed();
    await h.controller.editorClosed();
    expect(h.ui().modalRevision).toBe(rev("external-v1"));
    // After Escape, a further close still does not re-prompt for the same
    // unresolved revision — the banner remains the surface.
    h.controller.dismissModal();
    await h.controller.editorClosed();
    expect(h.ui().modalRevision).toBeNull();
    expect(h.ui().conflict).not.toBeNull();
  });

  it("does nothing at all when there is nothing to reconcile", async () => {
    const h = makeHarness("v0");
    await h.controller.editorClosed();
    expect(h.ui().conflict).toBeNull();
    expect(h.ui().modalRevision).toBeNull();
    expect(h.ui().error).toBeNull();
    expect(h.applied).toEqual([]);
  });

  it("close-before-watcher ordering: the editor-closed fetch itself finds the conflict", async () => {
    // The watcher event has NOT fired yet (or is still in flight) when the
    // close signal arrives; reconciling on the close must still observe the
    // new disk state.
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("external-v1");
    await h.controller.editorClosed();
    expect(h.ui().conflict?.revision).toBe(rev("external-v1"));

    // The watcher event lands afterwards: same revision, no duplicate
    // conflict and the reason records what actually surfaced it.
    await h.controller.reconcile("watcher");
    expect(h.ui().conflict).toEqual({
      revision: rev("external-v1"),
      reason: "editor-closed",
    });
    expect(h.ui().modalRevision).toBe(rev("external-v1"));
  });

  it("a clean viewer applies the external revision on editor-closed without any prompt", async () => {
    const h = makeHarness("v0");
    h.setDisk("external-v1");
    await h.controller.editorClosed();
    expect(h.applied).toEqual(["external-v1"]);
    expect(h.ui().conflict).toBeNull();
    expect(h.ui().modalRevision).toBeNull();
  });

  it("defers escalation while a native close-confirmation flow is active, then shows it", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("external-v1");
    h.controller.notifyNativeCloseFlow(true);
    await h.controller.editorClosed();
    // Conflict found, but the modal waits for the native flow to end.
    expect(h.ui().conflict?.revision).toBe(rev("external-v1"));
    expect(h.ui().modalRevision).toBeNull();

    h.controller.notifyNativeCloseFlow(false);
    expect(h.ui().modalRevision).toBe(rev("external-v1"));
  });

  it("a watcher-surfaced conflict escalates when the close signal arrives for it", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("external-v1");
    await h.controller.reconcile("watcher");
    expect(h.ui().modalRevision).toBeNull(); // banner only so far
    await h.controller.editorClosed();
    expect(h.ui().modalRevision).toBe(rev("external-v1"));
  });
});

describe("SyncController — save-and-close under conflict", () => {
  it("reports failure (not success) on a 412 so the window stays open, and surfaces the conflict", async () => {
    const h = makeHarness("v0");
    h.state.dirty = true;
    h.setDisk("external-v1");
    const result = await h.attemptWrite("close", "final-scene");
    // Not ok, and crucially NOT pendingNewerEdits (the close retry loop must
    // not retry a conflict as if it were a newer-edit race).
    expect(result).toMatchObject({ kind: "conflict" });
    expect(h.ui().conflict).toEqual({
      revision: rev("external-v1"),
      reason: "save-412",
    });
    expect(h.controller.acceptedRevision()).toBe(rev("v0"));
  });
});
