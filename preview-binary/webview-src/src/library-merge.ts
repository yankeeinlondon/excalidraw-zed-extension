// Pure library merge + invariant enforcement — decision D3's single choke point.
//
// The persisted/merged library payload must never contain two entries with the
// same library-item id after any sequence of the four flows that touch it
// (initial seeding from `GET /library`, Browse-install, SSE re-delivery, and
// debounced panel persistence). The vendored package's own merge dedupes by
// *content* (element ids in order + per-element `versionNonce`), not by id, so
// a re-delivered library whose elements were re-stamped appends a second entry
// with the same id — and the vendored drag path then inserts every entry
// matching the dragged id, producing the reported side-by-side twins.
//
// This module is package-free at runtime (types only) so every suite can drive
// it with injected I/O per the `dirty-state.ts` convention; the real vendored
// functions (`mergeLibraryItems`, `loadLibraryFromBlob`, `restoreLibraryItems`)
// are supplied by `App.tsx` at the wiring site and pinned separately by the
// vendored proxy suite (`library-vendored.test.ts`).

import type { LibraryItem, LibraryItems } from "@excalidraw/excalidraw/types";

/**
 * The largest element `updated` timestamp in an item, or `0` when the item has
 * no elements (or none carry a numeric `updated`). The deterministic survivor
 * metric for {@link dedupeLibraryItems}: duplicated copies observed in the
 * wild differ only in `updated`/`versionNonce`, so the newest content is the
 * meaningful pick (appendix §6's suggested rule).
 */
function maxElementUpdated(item: LibraryItem): number {
  let max = 0;
  const elements = (item as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return 0;
  for (const element of elements) {
    const updated = (element as { updated?: unknown } | null)?.updated;
    if (typeof updated === "number" && updated > max) max = updated;
  }
  return max;
}

/**
 * The library-item id an entry is keyed by, or `null` when the entry carries
 * none (malformed data, or the legacy v1 item shape — a bare element array —
 * which the vendored restore re-keys with fresh random ids anyway and hence
 * cannot collide). Unkeyed entries pass through untouched.
 */
function libraryItemId(item: unknown): string | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return null;
  }
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Enforces the D3 unique-id invariant: at most one entry per library-item id,
 * regardless of how the input was assembled.
 *
 * Deterministic rules:
 *
 * - Output order preserves each id's **first-occurrence** position; a survivor
 *   replaces its predecessor in that same slot (no reordering churn).
 * - The surviving copy of a duplicated id is the one with the **newest element
 *   `updated`** ({@link maxElementUpdated}); ties keep the earlier-seen copy.
 * - Entries without a usable id (malformed entries, v1 element arrays) pass
 *   through in order — they cannot share an id with anything.
 * - An input that already satisfies the invariant is returned **as the same
 *   reference**, so clean flows (the common case) are provably untouched.
 */
export function dedupeLibraryItems(items: LibraryItems): LibraryItems {
  const output: LibraryItem[] = [];
  const indexOfId = new Map<string, number>();
  let sawDuplicate = false;
  for (const raw of items) {
    const id = libraryItemId(raw);
    if (id === null) {
      output.push(raw as LibraryItem);
      continue;
    }
    const existingIndex = indexOfId.get(id);
    if (existingIndex === undefined) {
      indexOfId.set(id, output.length);
      output.push(raw as LibraryItem);
      continue;
    }
    sawDuplicate = true;
    const incumbent = output[existingIndex]!;
    if (maxElementUpdated(raw as LibraryItem) > maxElementUpdated(incumbent)) {
      // Newest content wins; the slot (first-occurrence position) stays.
      output[existingIndex] = raw as LibraryItem;
    }
  }
  return sawDuplicate ? output : items;
}

/**
 * Parses the `GET /library` payload (the shared `.excalidrawlib` file's JSON)
 * into panel items with the unique-id invariant enforced — the D3
 * corrupted-library remedy: **dedupe on load**. A library corrupted by a
 * pre-fix build (duplicate ids on disk) is healed in memory before it can seed
 * the panel, so neither the panel tiles nor the drag path ever see the twins;
 * the seeding `onLibraryChange` echo then persists the healed set, healing the
 * file itself on the next write.
 *
 * Tolerant by design (matches the previous inline parse): a missing/non-array
 * `libraryItems`, or a non-object envelope, seeds an empty panel rather than
 * erroring — the library is non-fatal state. Unknown/malformed entries pass
 * through for the vendored restore to normalize.
 */
export function sanitizePersistedLibrary(parsed: unknown): LibraryItems {
  if (typeof parsed !== "object" || parsed === null) return [];
  const items = (parsed as { libraryItems?: unknown }).libraryItems;
  if (!Array.isArray(items)) return [];
  return dedupeLibraryItems(items as LibraryItems);
}

/**
 * The vendored library pipeline the install flow needs, injected so this module
 * stays testable without the package. The real wiring (`App.tsx`) supplies the
 * vendored functions; `library-vendored.test.ts` pins their load-bearing
 * properties against package bumps.
 */
export interface LibraryPipeline {
  /**
   * The vendored content-equality merge (`mergeLibraryItems`): incoming items
   * whose elements (ids in order + `versionNonce`) don't already exist are
   * prepended. This is the merge whose id-blindness the choke point corrects.
   */
  mergeItems(existing: LibraryItems, incoming: LibraryItems): LibraryItems;
  /** Parses a `.excalidrawlib` Blob (`loadLibraryFromBlob`). */
  parseBlob(blob: Blob): Promise<LibraryItems>;
  /** Normalizes an in-memory items array (`restoreLibraryItems`). */
  restoreItems(items: LibraryItems): LibraryItems;
}

/**
 * The `ExcalidrawAPI.updateLibrary` surface {@link installLibraryPayload} uses:
 * the function form of `libraryItems`, which receives the current items and
 * resolves to the next set in one atomic update.
 */
export type UpdateLibraryFn = (opts: {
  libraryItems: (current: LibraryItems) => Promise<LibraryItems>;
  openLibraryMenu?: boolean;
}) => Promise<LibraryItems>;

/**
 * Installs a library payload (Browse-install / SSE re-delivery / native
 * import) through one atomic `updateLibrary` update: the vendored
 * content-equality merge runs against the current items, and the D3 choke
 * point dedupes the merged set **inside the same update** — so the panel (and
 * every `onLibraryChange` observer) never even transiently holds two entries
 * sharing an id, and the update's return value is invariant-clean by
 * construction.
 *
 * Semantics match the previous `updateLibrary({ merge: true })` call it
 * replaces (same parse functions, same default status, same prepended-new
 * ordering); the only change is that the merged result passes through
 * {@link dedupeLibraryItems} before it can reach the panel.
 *
 * ## Returns
 * The library items as `updateLibrary` reports them after the update — the
 * deduped merged set, re-normalized by the vendored restore (which preserves
 * ids; pinned by the vendored proxy suite).
 */
export async function installLibraryPayload(
  pipeline: LibraryPipeline,
  updateLibrary: UpdateLibraryFn,
  incoming: LibraryItems | Blob,
  opts: { openLibraryMenu?: boolean } = {},
): Promise<LibraryItems> {
  const parsed =
    incoming instanceof Blob
      ? await pipeline.parseBlob(incoming)
      : pipeline.restoreItems(incoming);
  return updateLibrary({
    libraryItems: async (current) =>
      dedupeLibraryItems(pipeline.mergeItems(current, parsed)),
    openLibraryMenu: opts.openLibraryMenu,
  });
}
