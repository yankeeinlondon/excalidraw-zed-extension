// The read-only image preview's live-reload step, extracted from `main.tsx` so
// the object-URL bookkeeping (create the new one, swap it in, revoke exactly the
// previous one; keep the last good image on any failure) is unit-testable
// without a DOM. All I/O is injected, mirroring `sync-controller.ts`.

/** Injected I/O for {@link createReadonlyImageRefresher}. */
export interface ReadonlyImageDeps {
  /**
   * `GET /data` for the raw image. Resolves to the bytes, or `null` when the
   * response is not ok (e.g. 404 after the file was deleted). May reject on a
   * network failure; the refresher treats both as "keep the last good image".
   */
  fetchBytes(): Promise<ArrayBuffer | null>;
  /** `URL.createObjectURL` */
  createObjectUrl(blob: Blob): string;
  /** `URL.revokeObjectURL` */
  revokeObjectUrl(url: string): void;
  /** Assigns the `<img>` source. */
  setSrc(url: string): void;
  /** MIME type of the image (`image/svg+xml` or `image/png`). */
  type: string;
  /** The object URL currently displayed, created by the caller for the initial bytes. */
  initialUrl: string;
}

/** A refresher for the read-only image preview. */
export interface ReadonlyImageRefresher {
  /**
   * Re-fetches the image and, on success, swaps in a fresh object URL and
   * revokes the previous one. On a non-ok response or a rejected fetch the
   * current image, its URL, and the revoke bookkeeping are all left untouched.
   * Never rejects.
   */
  refresh(): Promise<void>;
  /** The object URL currently displayed. */
  currentUrl(): string;
}

/**
 * Creates the refresh closure the read-only preview runs on every SSE `reload`.
 * The previous URL is revoked only *after* the new one has been assigned as the
 * source, so the image never flashes blank between the two.
 */
export function createReadonlyImageRefresher(
  deps: ReadonlyImageDeps,
): ReadonlyImageRefresher {
  let current = deps.initialUrl;
  return {
    async refresh() {
      try {
        const next = await deps.fetchBytes();
        if (next === null) return;
        const nextUrl = deps.createObjectUrl(new Blob([next], { type: deps.type }));
        deps.setSrc(nextUrl);
        deps.revokeObjectUrl(current);
        current = nextUrl;
      } catch {
        // transient fetch failure; keep showing the last good image
      }
    },
    currentUrl: () => current,
  };
}
