import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import {
  ConflictBanner,
  ConflictModal,
  CONFLICT_DIALOG_TITLE_ID,
  nextFocusInCycle,
} from "./conflict-ui";
import type { SyncUiState } from "./sync-controller";

const idle: SyncUiState = {
  conflict: null,
  keepNotice: false,
  error: null,
  modalRevision: null,
};

describe("ConflictBanner", () => {
  it("renders nothing when the viewer is in sync", () => {
    expect(renderToString(<ConflictBanner state={idle} onReloadFromDisk={() => {}} onKeepMyChanges={() => {}} onRetryError={() => {}} />)).toBe("");
  });

  it("shows the non-modal conflict banner with both resolutions while pending", () => {
    const html = renderToString(
      <ConflictBanner
        state={{ ...idle, conflict: { revision: '"sha256-x"', reason: "watcher" } }}
        onReloadFromDisk={() => {}}
        onKeepMyChanges={() => {}}
        onRetryError={() => {}}
      />,
    );
    expect(html).toContain("File changed on disk");
    expect(html).toContain("Reload from disk");
    expect(html).toContain("Keep my changes");
    expect(html).toContain('role="status"');
  });

  it("shows the keep acknowledgment notice after Keep my changes", () => {
    const html = renderToString(
      <ConflictBanner
        state={{ ...idle, keepNotice: true }}
        onReloadFromDisk={() => {}}
        onKeepMyChanges={() => {}}
        onRetryError={() => {}}
      />,
    );
    expect(html).toContain("Next save replaces the disk version");
  });

  it("shows a retryable error with a Retry action", () => {
    const html = renderToString(
      <ConflictBanner
        state={{ ...idle, error: { kind: "unavailable", message: "The file is no longer on disk." } }}
        onReloadFromDisk={() => {}}
        onKeepMyChanges={() => {}}
        onRetryError={() => {}}
      />,
    );
    expect(html).toContain("The file is no longer on disk.");
    expect(html).toContain("Retry");
    expect(html).toContain('role="alert"');
  });
});

describe("ConflictModal", () => {
  it("renders an accessible dialog: role, aria-modal, labelled heading, both actions", () => {
    const html = renderToString(
      <ConflictModal open onKeep={() => {}} onReload={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    // The label points at the heading's id.
    expect(html).toContain(`aria-labelledby="${CONFLICT_DIALOG_TITLE_ID}"`);
    expect(html).toContain(`id="${CONFLICT_DIALOG_TITLE_ID}"`);
    expect(html).toContain("File changed on disk");
    expect(html).toContain("Keep my changes");
    expect(html).toContain("Reload from disk");
  });

  it("renders nothing when closed", () => {
    expect(
      renderToString(<ConflictModal open={false} onKeep={() => {}} onReload={() => {}} onDismiss={() => {}} />),
    ).toBe("");
  });
});

describe("nextFocusInCycle (the modal focus trap)", () => {
  const a = {} as HTMLElement;
  const b = {} as HTMLElement;
  const c = {} as HTMLElement;

  it("cycles forward with wrap-around", () => {
    expect(nextFocusInCycle([a, b, c], a, false)).toBe(b);
    expect(nextFocusInCycle([a, b, c], b, false)).toBe(c);
    expect(nextFocusInCycle([a, b, c], c, false)).toBe(a);
  });

  it("cycles backward with wrap-around", () => {
    expect(nextFocusInCycle([a, b, c], a, true)).toBe(c);
    expect(nextFocusInCycle([a, b, c], c, true)).toBe(b);
  });

  it("seeds from the first (forward) or last (backward) when nothing is focused", () => {
    expect(nextFocusInCycle([a, b, c], null, false)).toBe(a);
    expect(nextFocusInCycle([a, b, c], null, true)).toBe(c);
    // An element outside the cycle counts as unfocused.
    expect(nextFocusInCycle([a, b, c], {} as HTMLElement, false)).toBe(a);
  });

  it("handles a single-element cycle and an empty one", () => {
    expect(nextFocusInCycle([a], a, false)).toBe(a);
    expect(nextFocusInCycle([a], a, true)).toBe(a);
    expect(nextFocusInCycle([], a, false)).toBeNull();
  });
});
