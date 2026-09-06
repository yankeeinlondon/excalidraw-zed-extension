// Ambient types for the vendored-package proxy tests, which import the real
// @excalidraw/excalidraw dev dist directly. The package's `exports` field
// blocks subpath package specifiers, so those imports go through relative
// paths — which have no type declarations of their own.
//
// The patterns below are deliberately anchored on the vendored dev-dist paths
// rather than a bare `*.js` wildcard: a wildcard that broad is the declared
// type of *every* unresolved `.js` import in this project, so a future typo'd
// import would silently type-check as the excalidraw chunk instead of failing
// (review 1, finding 3). One `*` is all a TS ambient module pattern allows,
// which is why each proxy target gets its own line.
//
// The chunk filename is a build artifact; a package bump renames it and the
// proxy fails loudly — at import time, and now at type-check time too, which is
// by design: these suites exist to pin the vendored behavior D1 and D3 rely on.

/**
 * The dev-dist chunk holding excalidraw's restore/serialize/load surface.
 * Only the members `color-mode-vendored.test.ts` exercises are declared.
 */
declare module "*/@excalidraw/excalidraw/dist/dev/chunk-4FTI6OG3.js" {
  /** Restore a supplied appState; keeps values for default-appState keys. */
  export function restoreAppState(
    appState: unknown,
    localAppState?: unknown,
  ): Record<string, unknown>;
  /** Restore a full scene payload (elements + appState + files). */
  export function restore(
    data: unknown,
    localAppState?: unknown,
    localElements?: unknown,
    elementsConfig?: unknown,
  ): Record<string, unknown>;
  /** Upstream serializer; strips `exportWithDarkMode` (the D1 root cause). */
  export function serializeAsJSON(...args: unknown[]): string;
  /** Upstream loader; also strips `exportWithDarkMode` (finding N2). */
  export function loadFromBlob(
    blob: Blob,
    localAppState?: unknown,
    localElements?: unknown,
    fileHandle?: unknown,
  ): Promise<Record<string, unknown>>;
}

/**
 * The package root, imported by `library-vendored.test.ts` for the real
 * library merge/restore functions. That suite declares the precise surface it
 * uses and casts through `unknown`, so nothing is declared here — the entry
 * exists only to make the relative import resolvable.
 */
declare module "*/@excalidraw/excalidraw/dist/dev/index.js";
