import { describe, it, expect, vi } from "vitest";
import {
  createSaveUnavailableNotice,
  installSaveUnavailableBridge,
  SAVE_NOTICE_DURATION_MS,
  SAVE_NOTICE_LOADING,
  SAVE_NOTICE_LOAD_FAILED,
  SAVE_NOTICE_READONLY,
  type SaveNoticeKeyEvent,
  type SaveNoticeTarget,
} from "./save-notice";

/**
 * Injected-deps harness with a manual timer queue: `present` records every
 * message shown and every removal, so a test can assert exactly what the user
 * sees and when it goes away.
 */
function makeHarness(message?: string, durationMs?: number) {
  const shown: string[] = [];
  const removed: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimerId = 0;

  const deps = {
    present: vi.fn((msg: string) => {
      shown.push(msg);
      return () => removed.push(msg);
    }),
    setTimer: vi.fn((fn: () => void, ms: number) => {
      nextTimerId += 1;
      timers.set(nextTimerId, { fn, ms });
      return nextTimerId;
    }),
    clearTimer: vi.fn((id: number) => {
      timers.delete(id);
    }),
    message,
    durationMs,
  };

  return {
    deps,
    shown,
    removed,
    timers,
    /** Fires every pending timer, as the browser would after their delay. */
    runTimers() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, t] of pending) t.fn();
    },
    notice: createSaveUnavailableNotice(deps),
  };
}

describe("createSaveUnavailableNotice", () => {
  it("shows nothing until a save gesture arrives", () => {
    const h = makeHarness();
    expect(h.deps.present).not.toHaveBeenCalled();
    expect(h.deps.setTimer).not.toHaveBeenCalled();
    expect(h.notice.currentMessage()).toBe(SAVE_NOTICE_LOADING);
  });

  it("presents the current message and schedules its dismissal", () => {
    const h = makeHarness();

    h.notice.notify("menu");

    expect(h.shown).toEqual([SAVE_NOTICE_LOADING]);
    expect(h.deps.setTimer).toHaveBeenCalledTimes(1);
    expect(h.deps.setTimer.mock.calls[0][1]).toBe(SAVE_NOTICE_DURATION_MS);
    expect(h.removed).toEqual([]);

    h.runTimers();
    expect(h.removed).toEqual([SAVE_NOTICE_LOADING]);
  });

  it("uses the message set by the page (read-only preview wording)", () => {
    const h = makeHarness();

    h.notice.setMessage(SAVE_NOTICE_READONLY);
    h.notice.notify("menu");

    expect(h.notice.currentMessage()).toBe(SAVE_NOTICE_READONLY);
    expect(h.shown).toEqual([SAVE_NOTICE_READONLY]);
    expect(SAVE_NOTICE_READONLY).toMatch(/read-only/i);
    expect(SAVE_NOTICE_READONLY).toMatch(/Embed scene/);
  });

  it("uses the load-failure wording once the page reports a failed load", () => {
    const h = makeHarness();

    h.notice.setMessage(SAVE_NOTICE_LOAD_FAILED);
    h.notice.notify();

    expect(h.shown).toEqual([SAVE_NOTICE_LOAD_FAILED]);
  });

  it("never stacks notices: a repeat gesture reuses the visible one and restarts its timer", () => {
    const h = makeHarness();

    h.notice.notify("menu");
    h.notice.notify("keyboard");
    h.notice.notify("menu");

    expect(h.deps.present).toHaveBeenCalledTimes(1);
    expect(h.deps.setTimer).toHaveBeenCalledTimes(3);
    // Each repeat cancelled the previous timer, so exactly one is still armed.
    expect(h.deps.clearTimer).toHaveBeenCalledTimes(2);
    expect(h.timers.size).toBe(1);
    expect(h.removed).toEqual([]);

    h.runTimers();
    expect(h.removed).toEqual([SAVE_NOTICE_LOADING]);
  });

  it("shows a fresh notice after the previous one has been dismissed", () => {
    const h = makeHarness();

    h.notice.notify("menu");
    h.runTimers();
    h.notice.notify("menu");

    expect(h.deps.present).toHaveBeenCalledTimes(2);
    expect(h.shown).toEqual([SAVE_NOTICE_LOADING, SAVE_NOTICE_LOADING]);
  });

  it("picks up a message change between gestures", () => {
    const h = makeHarness();

    h.notice.notify("menu");
    h.runTimers();
    h.notice.setMessage(SAVE_NOTICE_READONLY);
    h.notice.notify("menu");

    expect(h.shown).toEqual([SAVE_NOTICE_LOADING, SAVE_NOTICE_READONLY]);
  });

  it("honours injected message and duration overrides", () => {
    const h = makeHarness("custom", 250);

    h.notice.notify();

    expect(h.shown).toEqual(["custom"]);
    expect(h.deps.setTimer.mock.calls[0][1]).toBe(250);
  });

  it("dismiss() removes a visible notice and cancels its timer; a second dismiss is a no-op", () => {
    const h = makeHarness();

    h.notice.notify("menu");
    h.notice.dismiss();
    expect(h.removed).toEqual([SAVE_NOTICE_LOADING]);
    expect(h.timers.size).toBe(0);

    h.notice.dismiss();
    expect(h.removed).toEqual([SAVE_NOTICE_LOADING]);
  });
});

/** A minimal stand-in for `window` implementing {@link SaveNoticeTarget}. */
function makeTarget(): SaveNoticeTarget & {
  fire(event: Partial<SaveNoticeKeyEvent>): { defaultPrevented: boolean };
  listeners: number;
} {
  const handlers: ((e: SaveNoticeKeyEvent) => void)[] = [];
  return {
    addEventListener(_type: "keydown", handler: (e: SaveNoticeKeyEvent) => void) {
      handlers.push(handler);
    },
    get listeners() {
      return handlers.length;
    },
    fire(event: Partial<SaveNoticeKeyEvent>) {
      let defaultPrevented = false;
      const full: SaveNoticeKeyEvent = {
        key: "s",
        ctrlKey: false,
        metaKey: false,
        preventDefault: () => {
          defaultPrevented = true;
        },
        ...event,
      };
      for (const h of handlers) h(full);
      return { defaultPrevented };
    },
  };
}

describe("installSaveUnavailableBridge", () => {
  it("registers the global the native menu script falls back to", () => {
    const h = makeHarness();
    const target = makeTarget();

    installSaveUnavailableBridge(target, h.notice);

    expect(typeof target.__excalidrawSaveUnavailable).toBe("function");
    target.__excalidrawSaveUnavailable!("menu");
    expect(h.shown).toEqual([SAVE_NOTICE_LOADING]);
  });

  it("shows the notice for the exact native-menu call (no argument variant too)", () => {
    const h = makeHarness();
    const target = makeTarget();
    installSaveUnavailableBridge(target, h.notice);

    target.__excalidrawSaveUnavailable!();
    expect(h.shown).toEqual([SAVE_NOTICE_LOADING]);
  });

  it("answers a Cmd+S keydown when no editor is mounted, and prevents the default", () => {
    const h = makeHarness();
    const target = makeTarget();
    installSaveUnavailableBridge(target, h.notice);
    h.notice.setMessage(SAVE_NOTICE_READONLY);

    const { defaultPrevented } = target.fire({ metaKey: true });

    expect(defaultPrevented).toBe(true);
    expect(h.shown).toEqual([SAVE_NOTICE_READONLY]);
  });

  it("answers a Ctrl+S keydown too — the Linux delivery path", () => {
    const h = makeHarness();
    const target = makeTarget();
    installSaveUnavailableBridge(target, h.notice);
    h.notice.setMessage(SAVE_NOTICE_READONLY);

    const { defaultPrevented } = target.fire({ ctrlKey: true });

    expect(defaultPrevented).toBe(true);
    expect(h.shown).toEqual([SAVE_NOTICE_READONLY]);
  });

  it("defers to the editor: no notice, no preventDefault while __excalidrawSave exists", () => {
    const h = makeHarness();
    const target = makeTarget();
    installSaveUnavailableBridge(target, h.notice);
    target.__excalidrawSave = () => Promise.resolve({ ok: true });

    const { defaultPrevented } = target.fire({ metaKey: true });

    expect(defaultPrevented).toBe(false);
    expect(h.shown).toEqual([]);
  });

  it("falls back again once the editor unmounts (bridge deleted)", () => {
    const h = makeHarness();
    const target = makeTarget();
    installSaveUnavailableBridge(target, h.notice);
    target.__excalidrawSave = () => Promise.resolve({ ok: true });
    target.fire({ metaKey: true });
    delete target.__excalidrawSave;

    target.fire({ metaKey: true });

    expect(h.shown).toEqual([SAVE_NOTICE_LOADING]);
  });

  it("ignores other keys and unmodified 's'", () => {
    const h = makeHarness();
    const target = makeTarget();
    installSaveUnavailableBridge(target, h.notice);

    expect(target.fire({ key: "s" }).defaultPrevented).toBe(false);
    expect(target.fire({ key: "a", metaKey: true }).defaultPrevented).toBe(false);
    expect(target.fire({ key: "S", metaKey: true }).defaultPrevented).toBe(false);
    expect(h.shown).toEqual([]);
  });

  it("installs exactly one keydown listener", () => {
    const h = makeHarness();
    const target = makeTarget();

    installSaveUnavailableBridge(target, h.notice);

    expect(target.listeners).toBe(1);
  });
});

describe("save gesture never goes silent (end-to-end routing)", () => {
  it("read-only preview: menu Save, Cmd+S, and Ctrl+S each produce a visible outcome", () => {
    const h = makeHarness();
    const target = makeTarget();
    installSaveUnavailableBridge(target, h.notice);
    // What `renderReadonlyImage` does before showing the image.
    h.notice.setMessage(SAVE_NOTICE_READONLY);

    // (a) native File → Save / menu accelerator, via main.rs SAVE_MENU_SCRIPT.
    target.__excalidrawSaveUnavailable!("menu");
    expect(h.shown).toEqual([SAVE_NOTICE_READONLY]);
    h.runTimers();

    // (b) Cmd+S delivered to the page (Linux path / pre-menu delivery).
    target.fire({ metaKey: true });
    expect(h.shown).toEqual([SAVE_NOTICE_READONLY, SAVE_NOTICE_READONLY]);
    h.runTimers();

    // (c) Ctrl+S.
    target.fire({ ctrlKey: true });
    expect(h.shown).toHaveLength(3);
    expect(h.removed).toHaveLength(2);
  });

  it("load failure: the same gestures explain that there is nothing to save", () => {
    const h = makeHarness();
    const target = makeTarget();
    installSaveUnavailableBridge(target, h.notice);
    h.notice.setMessage(SAVE_NOTICE_LOAD_FAILED);

    target.__excalidrawSaveUnavailable!("menu");
    target.fire({ ctrlKey: true });

    expect(h.shown).toEqual([SAVE_NOTICE_LOAD_FAILED]);
    expect(h.deps.present).toHaveBeenCalledTimes(1); // reused, not stacked
  });
});
