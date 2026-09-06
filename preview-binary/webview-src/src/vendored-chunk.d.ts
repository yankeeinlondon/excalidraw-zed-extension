// Ambient types for the vendored-package proxy tests
// (color-mode-vendored.test.ts), which import the real @excalidraw/excalidraw
// dev-dist chunk directly. The package's `exports` field blocks subpath
// package specifiers, so the import goes through a relative path — which has
// no type declarations. The chunk filename is a build artifact; a package bump
// renames it and the proxy fails loudly at import time (by design — it pins
// the vendored behavior D1 depends on). Only the members the proxy exercises
// are declared. (library-vendored.test.ts imports the package ROOT the same
// way; because this `*.js` wildcard is the module type TS picks for any
// unresolved .js import, that suite casts its import to the precise surface it
// uses instead of widening this declaration.)
declare module "*.js" {
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
