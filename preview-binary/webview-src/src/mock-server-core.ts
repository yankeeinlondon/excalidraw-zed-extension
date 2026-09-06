// Core of the Vite dev-server mock API, extracted so the conditional-write
// contract the mock implements is unit-testable (and stays in lockstep with
// the Rust server in preview-binary/src/main.rs).
//
// Mirrored Rust behavior:
// - `GET /data` → 200 with bytes + strong `ETag` + `Cache-Control: no-store`,
//   or 404 with `ETag: "absent"` for a missing file.
// - `POST /data` → 428 without `If-Match`; 412 with the current ETag when the
//   precondition does not match disk; 200 with the written ETag on a match.
// - Revisions are opaque strong ETags (`"sha256-<hex>"`, quotes included) and
//   are tracked per absolute file path — two dev tabs never share one.

// SHA-256, dependency-free. The browser bundle never imports this module; the
// implementation exists so the dev mock and its tests compute the *exact* ETag
// the Rust server produces without pulling Node's crypto (and its type
// requirements) into the webview tsconfig program. Verified against the FIPS
// 180-4 test vectors in mock-server-core.test.ts.

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 digest of `bytes` as lowercase hex (FIPS 180-4). */
export function sha256Hex(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = bytes.length * 8;
  // Padded message: data + 0x80 + zeros + 64-bit big-endian bit length.
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLen; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 =
        ((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^
        ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^
        (w[t - 15] >>> 3);
      const s1 =
        ((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^
        ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^
        (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const S0 =
        ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * Revision reported for a file that does not exist on disk. ETag-shaped so it
 * round-trips through `If-Match`, matching the Rust `ABSENT_REVISION`.
 */
export const MOCK_ABSENT_REVISION = '"absent"';

/**
 * Computes the opaque content revision for the exact given bytes — the same
 * strong ETag form the Rust server produces (`"sha256-<hex>"`).
 */
export function computeMockRevision(bytes: Uint8Array): string {
  return `"sha256-${sha256Hex(bytes)}"`;
}

/**
 * Whether any candidate in a comma-separated `If-Match` header matches the
 * current revision. Mirrors the Rust `if_match_allows`: opaque byte-for-byte
 * comparison, so weak forms never match, and the wildcard `*` never matches on
 * its own — an unconditional overwrite is exactly what this contract prevents.
 */
export function mockIfMatchAllows(
  header: string | undefined | null,
  currentRevision: string,
): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed !== "*" && trimmed === currentRevision;
  });
}

/** Decision for one conditional write attempt against the store. */
export type MockWriteDecision =
  | { status: 200; etag: string }
  | { status: 412; etag: string }
  | { status: 428 };

/**
 * Per-path in-memory file state for the dev mock, enforcing the revision
 * contract exactly like the Rust server: reads pair bytes with their revision,
 * and writes are conditional on the revision the client accepted.
 */
export class MockFileStore {
  private readonly files = new Map<string, Uint8Array>();

  /** Current bytes, or undefined when the file is absent (deleted/never made). */
  read(path: string): Uint8Array | undefined {
    return this.files.get(path);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  /** The current revision of `path` (absent files get {@link MOCK_ABSENT_REVISION}). */
  revision(path: string): string {
    const bytes = this.files.get(path);
    return bytes === undefined ? MOCK_ABSENT_REVISION : computeMockRevision(bytes);
  }

  /** Overwrites in-memory state unconditionally (test/dev seeding only). */
  put(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
  }

  /**
   * One conditional write: 428 without an `If-Match`, 412 (disk untouched)
   * when the precondition does not match the current revision, 200 + the
   * written revision on a match.
   */
  write(
    path: string,
    ifMatch: string | undefined,
    body: Uint8Array,
  ): MockWriteDecision {
    if (!ifMatch) return { status: 428 };
    const current = this.revision(path);
    if (!mockIfMatchAllows(ifMatch, current)) {
      return { status: 412, etag: current };
    }
    this.files.set(path, body);
    return { status: 200, etag: computeMockRevision(body) };
  }
}
