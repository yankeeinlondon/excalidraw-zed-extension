// Conflict UX: the non-modal banner and the accessible escalation modal.
//
// Styling follows the existing banner conventions in main.tsx (system-ui,
// 13px/1.4, fixed top strip). The banner is the always-visible surface while a
// conflict is pending or an acknowledgment notice is active; the modal is the
// `editor-closed` escalation — an accessible dialog with a focus trap that
// never steals window focus from the OS.

import { useEffect, useRef } from "react";
import type { SyncUiState } from "./sync-controller";

const BANNER_BASE: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 20,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: "8px 12px",
  font: "13px/1.4 system-ui, -apple-system, sans-serif",
};

const CONFLICT_BANNER: React.CSSProperties = {
  ...BANNER_BASE,
  background: "#3a3413",
  color: "#e8d98a",
  borderBottom: "1px solid #5c5320",
};

const LIGHT_ON_DARK_BUTTON: React.CSSProperties = {
  font: "inherit",
  padding: "3px 10px",
  borderRadius: 4,
  border: "1px solid #7a6f2c",
  background: "#4d4419",
  color: "#f0e3a0",
  cursor: "pointer",
};

const NOTICE_BANNER: React.CSSProperties = {
  ...BANNER_BASE,
  background: "#1e3a5f",
  color: "#a8c6e8",
  borderBottom: "1px solid #2c4f7c",
};

const ERROR_BANNER: React.CSSProperties = {
  ...BANNER_BASE,
  background: "#5f1e1e",
  color: "#e8a8a8",
  borderBottom: "1px solid #7c2c2c",
};

export interface ConflictBannerProps {
  state: SyncUiState;
  onReloadFromDisk(): void;
  onKeepMyChanges(): void;
  onRetryError(): void;
}

/**
 * The non-modal conflict surface. While a conflict is pending it offers both
 * resolutions inline and persists until one is chosen. After "Keep my changes"
 * it shows the "Next save replaces the disk version" notice. Sync errors show
 * a retryable message. Renders nothing when the viewer is in sync.
 */
export function ConflictBanner({
  state,
  onReloadFromDisk,
  onKeepMyChanges,
  onRetryError,
}: ConflictBannerProps) {
  if (state.conflict) {
    return (
      <div
        role="status"
        style={CONFLICT_BANNER}
        data-testid="conflict-banner"
      >
        <span>File changed on disk</span>
        <button
          type="button"
          style={LIGHT_ON_DARK_BUTTON}
          onClick={onReloadFromDisk}
        >
          Reload from disk
        </button>
        <button
          type="button"
          style={LIGHT_ON_DARK_BUTTON}
          onClick={onKeepMyChanges}
        >
          Keep my changes
        </button>
      </div>
    );
  }
  if (state.keepNotice) {
    return (
      <div role="status" style={NOTICE_BANNER} data-testid="keep-notice">
        Next save replaces the disk version
      </div>
    );
  }
  if (state.error) {
    return (
      <div role="alert" style={ERROR_BANNER} data-testid="sync-error">
        <span>{state.error.message}</span>
        <button
          type="button"
          style={LIGHT_ON_DARK_BUTTON}
          onClick={onRetryError}
        >
          Retry
        </button>
      </div>
    );
  }
  return null;
}

const OVERLAY: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0, 0, 0, 0.45)",
};

const DIALOG: React.CSSProperties = {
  maxWidth: 420,
  margin: 16,
  padding: "18px 20px",
  borderRadius: 8,
  background: "#202124",
  color: "#e8eaed",
  border: "1px solid #5f6368",
  boxShadow: "0 8px 28px rgba(0, 0, 0, 0.55)",
  font: "14px/1.5 system-ui, -apple-system, sans-serif",
};

const DIALOG_HEADING: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 16,
  fontWeight: 600,
};

const DIALOG_MESSAGE: React.CSSProperties = {
  margin: "0 0 16px",
  color: "#bdc1c6",
};

const BUTTON_ROW: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

const DIALOG_BUTTON: React.CSSProperties = {
  font: "inherit",
  padding: "6px 14px",
  borderRadius: 4,
  border: "1px solid #5f6368",
  background: "#303134",
  color: "#e8eaed",
  cursor: "pointer",
};

/** The dialog's labelled heading id (aria-labelledby ↔ h2 id). */
export const CONFLICT_DIALOG_TITLE_ID = "excalidraw-conflict-dialog-title";

export interface ConflictModalProps {
  open: boolean;
  onKeep(): void;
  onReload(): void;
  onDismiss(): void;
}

/**
 * The `editor-closed` escalation dialog. Accessible by construction:
 * `role="dialog"` + `aria-modal="true"`, a labelled heading, initial focus on
 * the safe action ("Keep my changes" — it never discards user work), a focus
 * trap cycling Tab/Shift+Tab within the dialog, and Escape to dismiss (which
 * leaves the banner and the save pause intact).
 */
export function ConflictModal({
  open,
  onKeep,
  onReload,
  onDismiss,
}: ConflictModalProps) {
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) keepButtonRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
      return;
    }
    if (e.key === "Tab") {
      trapFocus(e, dialogRef.current, e.shiftKey);
    }
  };

  return (
    <div style={OVERLAY}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={CONFLICT_DIALOG_TITLE_ID}
        style={DIALOG}
        onKeyDown={handleKeyDown}
        data-testid="conflict-modal"
      >
        <h2 id={CONFLICT_DIALOG_TITLE_ID} style={DIALOG_HEADING}>
          File changed on disk
        </h2>
        <p style={DIALOG_MESSAGE}>
          The file was changed outside this editor while you have unsaved
          changes. Keeping your changes will replace the disk version the next
          time you save.
        </p>
        <div style={BUTTON_ROW}>
          <button type="button" style={DIALOG_BUTTON} onClick={onReload}>
            Reload from disk
          </button>
          {/* The safe action: rendered last (primary position) and focused on
              open — it never discards the user's unsaved work. */}
          <button
            ref={keepButtonRef}
            type="button"
            style={{ ...DIALOG_BUTTON, borderColor: "#8ab4f8", color: "#8ab4f8" }}
            onClick={onKeep}
          >
            Keep my changes
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Next element in the dialog's focus cycle. Pure so the trap's cycling logic
 * (including wrap-around and the no-current-element seed) is unit-testable.
 */
export function nextFocusInCycle(
  order: HTMLElement[],
  current: HTMLElement | null,
  backwards: boolean,
): HTMLElement | null {
  if (order.length === 0) return null;
  if (!current || !order.includes(current)) {
    // No current element inside the cycle: seed from the first (forward) or
    // the last (backward).
    return backwards ? order[order.length - 1] : order[0];
  }
  const index = order.indexOf(current);
  const step = backwards ? -1 : 1;
  return order[(((index + step) % order.length) + order.length) % order.length];
}

/**
 * Keeps Tab/Shift+Tab focus inside `container` by preventing the default jump
 * and focusing the next focusable element in the cycle.
 */
export function trapFocus(
  e: { preventDefault(): void },
  container: HTMLElement | null,
  backwards: boolean,
): void {
  if (!container) return;
  const focusables = Array.from(
    container.querySelectorAll<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])",
    ),
  ).filter((el) => !el.hasAttribute("disabled"));
  if (focusables.length === 0) return;
  e.preventDefault();
  const target = nextFocusInCycle(
    focusables,
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
    backwards,
  );
  target?.focus();
}
