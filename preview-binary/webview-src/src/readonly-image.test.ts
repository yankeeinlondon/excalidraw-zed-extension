import { describe, it, expect, vi } from "vitest";
import { createReadonlyImageRefresher, type ReadonlyImageDeps } from "./readonly-image";

/** Builds an injected-deps harness whose object URLs are numbered `blob:1`, `blob:2`, … */
function makeHarness(fetchBytes: ReadonlyImageDeps["fetchBytes"], type = "image/png") {
  let counter = 0;
  const createdBlobs: Blob[] = [];
  const deps = {
    fetchBytes,
    createObjectUrl: vi.fn((blob: Blob) => {
      createdBlobs.push(blob);
      counter += 1;
      return `blob:${counter}`;
    }),
    revokeObjectUrl: vi.fn(),
    setSrc: vi.fn(),
    type,
    initialUrl: "blob:initial",
  };
  return { deps, createdBlobs, refresher: createReadonlyImageRefresher(deps) };
}

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("createReadonlyImageRefresher", () => {
  it("starts on the initial URL without touching any dep", () => {
    const { deps, refresher } = makeHarness(async () => bytesOf("x"));
    expect(refresher.currentUrl()).toBe("blob:initial");
    expect(deps.createObjectUrl).not.toHaveBeenCalled();
    expect(deps.setSrc).not.toHaveBeenCalled();
    expect(deps.revokeObjectUrl).not.toHaveBeenCalled();
  });

  it("on success creates a new object URL from the new bytes, sets it as src, and revokes only the previous URL", async () => {
    const { deps, createdBlobs, refresher } = makeHarness(
      async () => bytesOf("new-image"),
      "image/svg+xml",
    );

    await refresher.refresh();

    expect(deps.createObjectUrl).toHaveBeenCalledTimes(1);
    expect(createdBlobs[0].type).toBe("image/svg+xml");
    expect(await createdBlobs[0].text()).toBe("new-image");
    expect(deps.setSrc).toHaveBeenCalledTimes(1);
    expect(deps.setSrc).toHaveBeenCalledWith("blob:1");
    expect(deps.revokeObjectUrl).toHaveBeenCalledTimes(1);
    expect(deps.revokeObjectUrl).toHaveBeenCalledWith("blob:initial");
    expect(deps.revokeObjectUrl).not.toHaveBeenCalledWith("blob:1");
    expect(refresher.currentUrl()).toBe("blob:1");
  });

  it("sets the new src before revoking the previous URL", async () => {
    const order: string[] = [];
    const { deps, refresher } = makeHarness(async () => bytesOf("a"));
    deps.setSrc.mockImplementation(() => order.push("setSrc"));
    deps.revokeObjectUrl.mockImplementation(() => order.push("revoke"));

    await refresher.refresh();

    expect(order).toEqual(["setSrc", "revoke"]);
  });

  it("a second successful refresh revokes the URL from the first refresh", async () => {
    const { deps, refresher } = makeHarness(async () => bytesOf("again"));

    await refresher.refresh();
    await refresher.refresh();

    expect(deps.setSrc.mock.calls).toEqual([["blob:1"], ["blob:2"]]);
    expect(deps.revokeObjectUrl.mock.calls).toEqual([["blob:initial"], ["blob:1"]]);
    expect(refresher.currentUrl()).toBe("blob:2");
  });

  it("a non-ok response (file deleted) leaves src and the current URL untouched and revokes nothing", async () => {
    const { deps, refresher } = makeHarness(async () => null);

    await refresher.refresh();

    expect(deps.createObjectUrl).not.toHaveBeenCalled();
    expect(deps.setSrc).not.toHaveBeenCalled();
    expect(deps.revokeObjectUrl).not.toHaveBeenCalled();
    expect(refresher.currentUrl()).toBe("blob:initial");
  });

  it("a thrown fetch error leaves everything untouched and does not reject", async () => {
    const { deps, refresher } = makeHarness(async () => {
      throw new TypeError("network down");
    });

    await expect(refresher.refresh()).resolves.toBeUndefined();

    expect(deps.createObjectUrl).not.toHaveBeenCalled();
    expect(deps.setSrc).not.toHaveBeenCalled();
    expect(deps.revokeObjectUrl).not.toHaveBeenCalled();
    expect(refresher.currentUrl()).toBe("blob:initial");
  });

  it("recovers after a failure: the next successful refresh still revokes the last good URL", async () => {
    let fail = true;
    const { deps, refresher } = makeHarness(async () => {
      if (fail) return null;
      return bytesOf("back");
    });

    await refresher.refresh();
    fail = false;
    await refresher.refresh();

    expect(deps.setSrc.mock.calls).toEqual([["blob:1"]]);
    expect(deps.revokeObjectUrl.mock.calls).toEqual([["blob:initial"]]);
    expect(refresher.currentUrl()).toBe("blob:1");
  });
});
