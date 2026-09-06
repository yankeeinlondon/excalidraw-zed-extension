import { describe, it, expect, vi } from "vitest";

// serializeSceneForDisk composes the (mocked) upstream serializeAsJSON with the
// pure injector — pinned here with a fixture, per the repo's mock-the-package
// convention. The injection primitive itself needs no mock. The REAL vendored
// serializeAsJSON/restore() behavior is pinned separately in
// color-mode-vendored.test.ts (the §6.3b restore() proxy).
vi.mock("@excalidraw/excalidraw", () => ({
  serializeAsJSON: vi.fn(
    () =>
      '{"type":"excalidraw","version":2,"source":"excalidraw-zed-preview",' +
      '"elements":[],"appState":{"viewBackgroundColor":"#ffffff","gridSize":null},"files":{}}',
  ),
}));

import { serializeAsJSON } from "@excalidraw/excalidraw";
import { serializeSceneForDisk } from "./serialize-scene";
import { injectExportWithDarkMode } from "./color-mode";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState as ExcalidrawAppState,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

const elements = [] as readonly ExcalidrawElement[];
const files = {} as BinaryFiles;

describe("injectExportWithDarkMode", () => {
  const withAppState = (appState: string) =>
    `{"type":"excalidraw","version":2,"source":"zed","elements":[],"appState":${appState},"files":{}}`;

  it("inserts true into an empty appState, changing nothing else (exact bytes)", () => {
    const json = withAppState("{}");
    expect(injectExportWithDarkMode(json, true)).toBe(
      `{"type":"excalidraw","version":2,"source":"zed","elements":[],"appState":{"exportWithDarkMode":true},"files":{}}`,
    );
  });

  it("inserts false into an empty appState", () => {
    expect(injectExportWithDarkMode(withAppState("{}"), false)).toBe(
      withAppState(`{"exportWithDarkMode":false}`),
    );
  });

  it("inserts the key as the first member of a populated appState", () => {
    const json = withAppState(`{"gridSize":null,"viewBackgroundColor":"#ffffff"}`);
    expect(injectExportWithDarkMode(json, true)).toBe(
      withAppState(
        `{"exportWithDarkMode":true,"gridSize":null,"viewBackgroundColor":"#ffffff"}`,
      ),
    );
  });

  it("handles a whitespace-formatted appState", () => {
    const json = withAppState('{ "gridSize": 20 }');
    // Insertion lands immediately after the `{`; existing bytes are untouched.
    expect(injectExportWithDarkMode(json, true)).toBe(
      withAppState('{"exportWithDarkMode":true, "gridSize": 20 }'),
    );
  });

  it("replaces an existing key's value and leaves every other byte alone", () => {
    const json = withAppState(
      `{"exportWithDarkMode":true,"gridSize":null,"viewBackgroundColor":"#ffffff"}`,
    );
    expect(injectExportWithDarkMode(json, false)).toBe(
      withAppState(
        `{"exportWithDarkMode":false,"gridSize":null,"viewBackgroundColor":"#ffffff"}`,
      ),
    );
    // And back the other way.
    const flipped = withAppState(`{"exportWithDarkMode":false,"gridSize":null}`);
    expect(injectExportWithDarkMode(flipped, true)).toBe(
      withAppState(`{"exportWithDarkMode":true,"gridSize":null}`),
    );
  });

  it("is idempotent: injecting twice changes nothing the second time", () => {
    const once = injectExportWithDarkMode(withAppState('{"gridSize":null}'), true);
    expect(injectExportWithDarkMode(once, true)).toBe(once);
  });

  it("is byte-stable outside the injected member: removing the insertion restores the input", () => {
    const json = withAppState('{"gridSize":null}');
    const injected = injectExportWithDarkMode(json, true);
    // The single insertion is exactly this member; deleting it must reproduce
    // the input verbatim — the byte-stability property D1 requires.
    expect(injected.replace('"exportWithDarkMode":true,', "")).toBe(json);
    // Replacement path: deleting the member leaves the input too.
    const existing = withAppState('{"gridSize":null,"exportWithDarkMode":false}');
    const replaced = injectExportWithDarkMode(existing, true);
    expect(
      replaced.replace(',"exportWithDarkMode":true', ""),
    ).toBe(withAppState('{"gridSize":null}'));
  });

  it("ignores occurrences of the key inside element strings — only the top-level appState object is touched", () => {
    // An element whose text value is itself a JSON document mentioning both
    // keys; in the serialized scene it appears as escaped string content.
    const tricky = JSON.stringify("payload {\"appState\":{\"exportWithDarkMode\":false}}");
    const json =
      `{"type":"excalidraw","version":2,"source":"zed","elements":[{"id":"e1","text":${tricky}}],` +
      `"appState":{"gridSize":null},"files":{}}`;
    const injected = injectExportWithDarkMode(json, true);
    // The element's string value survives untouched…
    expect(injected).toContain(tricky);
    // …and the top-level appState gained the key.
    expect(JSON.parse(injected).appState).toEqual({
      gridSize: null,
      exportWithDarkMode: true,
    });
    expect(JSON.parse(injected).elements[0].text).toBe(
      'payload {"appState":{"exportWithDarkMode":false}}',
    );
  });

  it("ignores a nested exportWithDarkMode (e.g. inside frameRendering) and adds the top-level key", () => {
    const json = withAppState(
      `{"frameRendering":{"exportWithDarkMode":true,"enabled":true}}`,
    );
    const injected = injectExportWithDarkMode(json, false);
    const appState = JSON.parse(injected).appState;
    expect(appState.exportWithDarkMode).toBe(false);
    // The nested copy is untouched.
    expect(appState.frameRendering.exportWithDarkMode).toBe(true);
  });

  it("rejects string values that merely look like the appState key", () => {
    // "appState" as a *value* string of an earlier top-level key must not be
    // mistaken for the appState object.
    const json = `{"type":"appState","version":2,"appState":{"gridSize":null}}`;
    expect(JSON.parse(injectExportWithDarkMode(json, true)).appState).toEqual({
      gridSize: null,
      exportWithDarkMode: true,
    });
  });

  it("throws when there is no top-level appState object", () => {
    expect(() =>
      injectExportWithDarkMode(`{"type":"excalidraw","elements":[]}`, true),
    ).toThrow(/no top-level appState/);
  });

  it("throws when appState is not an object", () => {
    expect(() =>
      injectExportWithDarkMode(`{"type":"excalidraw","appState":null}`, true),
    ).toThrow(/appState is not a JSON object/);
  });

  it("throws on malformed or truncated payloads instead of corrupting them", () => {
    expect(() => injectExportWithDarkMode(`{"appState":{"gridSize":`, true)).toThrow();
    expect(() => injectExportWithDarkMode(`[1,2,3]`, true)).toThrow();
    expect(() => injectExportWithDarkMode(``, true)).toThrow();
  });
});

describe("serializeSceneForDisk", () => {
  it("carries the editor's dark mode in the serialized body", () => {
    const appState = { exportWithDarkMode: true } as Partial<ExcalidrawAppState>;
    const body = serializeSceneForDisk(elements, appState, files);
    expect(JSON.parse(body).appState.exportWithDarkMode).toBe(true);
    // Serialized through the upstream API with local export settings.
    expect(serializeAsJSON).toHaveBeenCalledWith(elements, appState, files, "local");
    // Upstream-stripped keys stay, and the injected key is additive.
    expect(JSON.parse(body).appState.gridSize).toBeNull();
    expect(JSON.parse(body).type).toBe("excalidraw");
  });

  it("carries light mode when the editor's mode is false", () => {
    const body = serializeSceneForDisk(
      elements,
      { exportWithDarkMode: false } as Partial<ExcalidrawAppState>,
      files,
    );
    expect(JSON.parse(body).appState.exportWithDarkMode).toBe(false);
  });

  it("injects false when the editor appState carries no mode (Boolean coercion)", () => {
    const body = serializeSceneForDisk(elements, {} as Partial<ExcalidrawAppState>, files);
    expect(JSON.parse(body).appState.exportWithDarkMode).toBe(false);
  });
});
