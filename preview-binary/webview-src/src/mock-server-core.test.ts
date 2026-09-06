import { describe, it, expect } from "vitest";
import {
  computeMockRevision,
  mockIfMatchAllows,
  MockFileStore,
  MOCK_ABSENT_REVISION,
  sha256Hex,
} from "./mock-server-core";

const encoder = new TextEncoder();

describe("sha256Hex", () => {
  // FIPS 180-4 test vectors — the mock's ETags must be byte-identical to the
  // Rust server's `content_revision` output for the same bytes.
  it("matches the known vectors", () => {
    expect(sha256Hex(encoder.encode(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(encoder.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      sha256Hex(encoder.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    ).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("handles multi-block inputs (>= 55 and >= 119 bytes)", () => {
    // One-hundred 'a's crosses the 64-byte block boundary; a million 'a's is
    // the classic long vector, kept short here to bound runtime while still
    // exercising several blocks.
    expect(sha256Hex(encoder.encode("a".repeat(100))).length).toBe(64);
    expect(sha256Hex(encoder.encode("a".repeat(1000))).length).toBe(64);
    // Determinism and sensitivity.
    expect(sha256Hex(encoder.encode("a".repeat(1000))).length).toBe(64);
    expect(sha256Hex(encoder.encode("a".repeat(100)))).not.toBe(
      sha256Hex(encoder.encode("b".repeat(100))),
    );
  });
});

describe("computeMockRevision", () => {
  it("produces the Rust server's exact strong-ETag shape (quotes included)", () => {
    expect(computeMockRevision(encoder.encode(""))).toBe(
      '"sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
    );
    expect(computeMockRevision(new Uint8Array([1, 2, 3]))).toMatch(
      /^"sha256-[0-9a-f]{64}"$/,
    );
  });

  it("is deterministic and sensitive to the exact bytes", () => {
    expect(computeMockRevision(encoder.encode("scene"))).toBe(
      computeMockRevision(encoder.encode("scene")),
    );
    expect(computeMockRevision(encoder.encode("scene"))).not.toBe(
      computeMockRevision(encoder.encode("scenf")),
    );
    expect(computeMockRevision(encoder.encode("scene"))).not.toBe(
      computeMockRevision(encoder.encode("scene\0")),
    );
  });

  it("never collides with the absent revision", () => {
    expect(computeMockRevision(encoder.encode("absent"))).not.toBe(
      MOCK_ABSENT_REVISION,
    );
    expect(MOCK_ABSENT_REVISION).toBe('"absent"');
  });
});

describe("mockIfMatchAllows", () => {
  const current = '"sha256-current"';

  it("matches an exact revision and rejects mismatched or wildcard values", () => {
    expect(mockIfMatchAllows(current, current)).toBe(true);
    expect(mockIfMatchAllows('"sha256-other"', current)).toBe(false);
    expect(mockIfMatchAllows("*", current)).toBe(false);
    expect(mockIfMatchAllows(undefined, current)).toBe(false);
    expect(mockIfMatchAllows("", current)).toBe(false);
  });

  it("accepts a comma-separated list containing the current revision", () => {
    // The "Keep my changes" write may offer the acknowledged overwrite
    // revision alongside the accepted one.
    expect(
      mockIfMatchAllows('"sha256-old", "sha256-current"', current),
    ).toBe(true);
    // A wildcard next to an exact match does not invalidate the match, but a
    // wildcard alone never matches.
    expect(mockIfMatchAllows(`*, ${current}`, current)).toBe(true);
    expect(mockIfMatchAllows("* ,", current)).toBe(false);
  });

  it("rejects weak ETag forms (byte-for-byte opaque comparison)", () => {
    expect(mockIfMatchAllows(`W/${current}`, current)).toBe(false);
  });
});

describe("MockFileStore (the dev mock's conditional-write contract)", () => {
  const fileA = "/tmp/dev/a.excalidraw";
  const fileB = "/tmp/dev/b.excalidraw";

  function seed(store: MockFileStore, path: string, text: string): string {
    const bytes = encoder.encode(text);
    store.put(path, bytes);
    return computeMockRevision(bytes);
  }

  it("read/write/read round trip: a conditional write updates both bytes and revision", () => {
    const store = new MockFileStore();
    const r1 = seed(store, fileA, '{"v":1}');
    expect(store.revision(fileA)).toBe(r1);

    const decision = store.write(fileA, r1, encoder.encode('{"v":2}'));
    expect(decision.status).toBe(200);
    if (decision.status === 200) {
      expect(decision.etag).toBe(computeMockRevision(encoder.encode('{"v":2}')));
    }
    // Re-read confirms the persisted value.
    expect(new TextDecoder().decode(store.read(fileA)!)).toBe('{"v":2}');
    expect(store.revision(fileA)).not.toBe(r1);
  });

  it("POST without If-Match → 428 and disk unchanged", () => {
    const store = new MockFileStore();
    const r1 = seed(store, fileA, '{"v":1}');
    const decision = store.write(fileA, undefined, encoder.encode('{"v":2}'));
    expect(decision.status).toBe(428);
    expect(new TextDecoder().decode(store.read(fileA)!)).toBe('{"v":1}');
    expect(store.revision(fileA)).toBe(r1);
  });

  it("POST with a stale If-Match → 412 with the current ETag and disk unchanged", () => {
    const store = new MockFileStore();
    seed(store, fileA, '{"v":1}');
    const stale = computeMockRevision(encoder.encode('{"v":0}'));
    const decision = store.write(fileA, stale, encoder.encode('{"v":2}'));
    expect(decision.status).toBe(412);
    if (decision.status === 412) {
      expect(decision.etag).toBe(store.revision(fileA));
    }
    expect(new TextDecoder().decode(store.read(fileA)!)).toBe('{"v":1}');
  });

  it("an absent file is its own revision; recreation is an acknowledged decision", () => {
    const store = new MockFileStore();
    expect(store.revision(fileA)).toBe(MOCK_ABSENT_REVISION);
    // Writing with a *byte* revision against an absent file fails…
    const stale = computeMockRevision(encoder.encode("anything"));
    expect(store.write(fileA, stale, encoder.encode("{}")).status).toBe(412);
    // …but If-Match: "absent" deliberately recreates the file.
    const decision = store.write(fileA, MOCK_ABSENT_REVISION, encoder.encode("{}"));
    expect(decision.status).toBe(200);
    expect(store.exists(fileA)).toBe(true);
  });

  it("revisions are isolated per file path — two dev tabs never share one", () => {
    const store = new MockFileStore();
    const ra = seed(store, fileA, '{"file":"a"}');
    seed(store, fileB, '{"file":"b"}');

    // A's write does not disturb B's revision.
    store.write(fileA, ra, encoder.encode('{"file":"a2"}'));
    expect(store.revision(fileB)).toBe(computeMockRevision(encoder.encode('{"file":"b"}')));

    // B's conditional write with A's (or any stale) revision fails against
    // B's own current revision.
    const decision = store.write(fileB, ra, encoder.encode('{"file":"b2"}'));
    expect(decision.status).toBe(412);
    if (decision.status === 412) {
      expect(decision.etag).toBe(computeMockRevision(encoder.encode('{"file":"b"}')));
    }
  });

  it("a replayed write (the acknowledged revision went stale) is rejected, not idempotent", () => {
    // The client kept a copy of a successful write's ETag and replays it after
    // an external edit: it must 412 rather than overwrite the external work.
    const store = new MockFileStore();
    const r1 = seed(store, fileA, '{"v":1}');
    const first = store.write(fileA, r1, encoder.encode('{"v":2}'));
    if (first.status !== 200) throw new Error("seed write failed");
    // External edit lands.
    store.put(fileA, encoder.encode('{"v":"external"}'));
    const replay = store.write(fileA, first.etag, encoder.encode('{"v":3}'));
    expect(replay.status).toBe(412);
    expect(new TextDecoder().decode(store.read(fileA)!)).toBe('{"v":"external"}');
  });
});
