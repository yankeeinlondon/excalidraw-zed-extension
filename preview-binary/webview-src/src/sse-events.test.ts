import { describe, it, expect, vi } from "vitest";
import {
  createAppSseHandler,
  createReadonlySseHandler,
  dispatchSseEvent,
} from "./sse-events";

describe("dispatchSseEvent", () => {
  it("dispatches each known name to its own handler", () => {
    const handlers = {
      onReload: vi.fn(),
      onLibrary: vi.fn(),
      onEditorClosed: vi.fn(),
    };
    expect(dispatchSseEvent("reload", handlers)).toBe(true);
    expect(dispatchSseEvent("library", handlers)).toBe(true);
    expect(dispatchSseEvent("editor-closed", handlers)).toBe(true);
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
    expect(handlers.onLibrary).toHaveBeenCalledTimes(1);
    expect(handlers.onEditorClosed).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown event names instead of treating them as reload", () => {
    const handlers = {
      onReload: vi.fn(),
      onLibrary: vi.fn(),
      onEditorClosed: vi.fn(),
    };
    // The regression this guards: an `if (data === "library") … else reload`
    // fall-through dispatches unknown frames as reloads.
    for (const unknown of ["", "reload ", "RELOAD", "dirty", "reload\n", "future-event"]) {
      expect(dispatchSseEvent(unknown, handlers)).toBe(false);
    }
    expect(handlers.onReload).not.toHaveBeenCalled();
    expect(handlers.onLibrary).not.toHaveBeenCalled();
    expect(handlers.onEditorClosed).not.toHaveBeenCalled();
  });
});

describe("createAppSseHandler", () => {
  it("routes reload to reconciliation and never into the scene via library", () => {
    const onReload = vi.fn();
    const onLibrary = vi.fn();
    const handler = createAppSseHandler({
      onReload,
      onLibrary,
      onEditorClosed: vi.fn(),
    });
    handler("library");
    expect(onLibrary).toHaveBeenCalledTimes(1);
    // library events must never touch the scene path
    expect(onReload).not.toHaveBeenCalled();
    handler("reload");
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe("createReadonlySseHandler", () => {
  it("reloads the image on reload and ignores everything else, including editor-closed", () => {
    const onReload = vi.fn();
    const handler = createReadonlySseHandler({ onReload });
    handler("reload");
    handler("reload");
    expect(onReload).toHaveBeenCalledTimes(2);
    // editor-closed / library / unknown frames are all no-ops: a read-only
    // preview has no scene to conflict and never shows a conflict dialog.
    handler("editor-closed");
    handler("library");
    handler("totally-unknown");
    expect(onReload).toHaveBeenCalledTimes(2);
  });
});
