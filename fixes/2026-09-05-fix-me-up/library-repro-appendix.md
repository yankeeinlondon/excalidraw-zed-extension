# Library repro appendix — Track A (Phase 2, 2026-09-06)

Blocking input for D3 (spec §6.1). Answers the required questions from direct
inspection of the persisted shared library on the reporting setup, plus
code-level analysis of the vendored package. Companion records:
[`decision-log.md`](./decision-log.md) (D3), [`spec.md`](./spec.md) §3/§6.1.

## 1. Persisted library inspection (the decisive question)

**File:** `{config_dir}/excalidraw-zed/library.excalidrawlib` =
`~/Library/Application Support/excalidraw-zed/library.excalidrawlib`
(the single shared file for all sessions, `main.rs:1210-1217`), 1,828,840
bytes, mtime 2026-09-06 13:00.

**Answer: YES — the persisted library already contains twin entries.**

| Measurement | Value |
|---|---|
| Total items (`libraryItems`) | 216 |
| Distinct library-item ids | 187 |
| Ids appearing twice | **29** (none appear more than twice) |
| Duplicate-pair content relation | same `id`, `created`, `status`; **elements differ** in exactly `updated` + `versionNonce` per element (identical element ids, order, and `version`) |
| Array layout | first copies occupy positions 114–142, second copies 143–171 — the **same 29-item block appended twice, back-to-back** (position delta exactly 29 for every pair) |

The duplicated block is one personal library of 29 nameless, `unpublished`
items whose `created` stamps span 2022-03-24 17:48:34–17:50:47 UTC (~2
minutes — a library exported from an old excalidraw session, timestamps
preserved through installs). Both copies carry the same `created` stamps, but
their elements' `updated` values differ: second copies were all stamped
2026-06-16 23:17:51.59x, first copies all stamped 2026-06-16 23:18:42.176 —
i.e. the same library was merged **twice within ~51 seconds** on 2026-06-16,
with a bulk element re-stamp between (or before) the two merges. Surrounding
context in the file: positions 0–113 are published, named public-library
items (VSCode, Vercel, Vue, …; 2023 stamps), positions 172–215 are later
additions from 2026-06-16 (Stick man, Slack, Docker, VPC, …).

Element types inside the duplicated items: `line` (412), `rectangle` (54),
`ellipse` (46), `freedraw` (2) — **all shape elements, zero image elements**
in the entire file (0 of 216 items contain `type: "image"` elements). The
report's "two identical images" is read as a colloquial description of the
duplicated asset, not an image-element claim.

No item is missing an id; no element-id overlap exists between duplicated and
non-duplicated items (0 shared element ids) — the twins are copies of each
other, not collisions with other libraries' content.

## 2. Mechanism (code-level, vendored `@excalidraw/excalidraw` 0.18.1)

- `mergeLibraryItems` (dev dist `index.js:9411`) dedupes incoming items by
  **exact content equality**, not by id: `isUniqueItem` compares element ids
  *in order* **and each element's `versionNonce`**. Any re-delivery of the
  same items whose elements were re-stamped (`updated`/`versionNonce`
  changed — e.g. by passing through a restore/serialization step) is treated
  as "unique" and **appended**, producing a second entry with the same
  library-item id. The file's data matches this signature exactly.
- Both of our install paths converge on this merge: the native Import Library
  flow (`App.tsx` `__excalidrawImportLibrary` → `updateLibrary({libraryItems,
  merge: true})`, array path → `restoreLibraryItems`) and the SSE/library-install
  re-delivery flow (`main.tsx:315-317` → `__excalidrawApplyPendingLibraries` →
  `updateLibrary({libraryItems: new Blob(…), merge: true})`, Blob path →
  `loadLibraryFromBlob` → `parseLibraryJSON` → `restoreLibraryItems`).
- Given duplicated entries, insertion twins follow from the vendored drag
  path: `getInsertedElements` selects *every* entry matching the dragged id
  (`dist/dev/index.js:11423-11443`) and the drop grid-distributes the set
  (`:28805-28816`) — exactly the reported side-by-side pair (spec §3.2,
  already proven).
- The library panel renders one tile per **array entry**
  (`LibraryUnit` grid maps `items` directly, `index.js:11303`), so the panel
  itself must show **two tiles** for each of the 29 duplicated items —
  structurally, not optionally.

## 3. Reporter questionnaire (four observational answers)

**Not collectable in this session** (non-interactive Phase 2 execution; no
channel to the reporter). Status per answer, from file/code evidence:

| Question | Status |
|---|---|
| Item source: default panel item or Browse-installed? | **Unanswered by reporter.** Derivable constraint: this app seeds the panel *only* from the persisted file (`GET /library`; `EMPTY_LIBRARY` when absent, `main.rs:1208`) — there are no built-in "default panel items", so every tile came from an install/import. The duplicated block is a personal (unpublished) library, not a public Browse library. |
| Item type: image item or shape elements? | **Unanswered by reporter.** The duplicated items are all shape elements (§1); no image elements exist anywhere in the file. |
| Selection: single drag or multi-select? | **Unanswered by reporter.** Unnecessary for the branch: a *single* drag of a duplicated item already inserts both entries (`getInsertedElements` matches by id when the id is not among multi-selected ids). |
| Does the panel show one tile or two? | **Unanswered by reporter; two, structurally** (§2 — the panel maps over array entries). |

The questionnaire text (spec §6.1) should still be sent when a channel
exists, to confirm the reporter-side observations; it can no longer change
the branch decision (§4).

## 4. Sequence of library operations preceding the repro

Partially reconstructable from the file only:

1. installs of public libraries (published, named, 2023-era stamps) — the
   positions 0–113 block;
2. install of a 29-item personal library (2022-era provenance) — positions
   114–142;
3. **a second merge of that same 29-item library** on 2026-06-16
   ~23:17:51–23:18:42 UTC, with elements re-stamped between the two merges →
   positions 143–171 (the twins);
4. further installs/creations later on 2026-06-16 (~23:17:11-stamped block
   and later) — positions 172–215.

Which exact flow (native Import vs SSE re-delivery vs panel edit) produced
the second merge is **not recoverable from the file** — all converge on the
same content-equality merge. Pinning the producing interleaving is Phase 4's
vitest scope (spec §3.5.2 covers all of them regardless), not a blocker.

## 5. Systematic reproduction session (conditional task)

**Not required.** The escalation condition (spec §6.1) is "only if the
questionnaire is inconclusive — **clean file** + single-tile panel + twins
persisting on a current build". The file is **not clean** (29 duplicated ids,
§1), so the condition is false regardless of the uncollectable questionnaire
answers, and the data-layer branch is confirmed by direct inspection.

## 6. Consequences for Phase 4 (D3)

- The unique-id invariant fix applies (data layer); the **vendored-package
   boundary condition is NOT met** (the persisted library is not clean, so
   the package is not implicated by this evidence).
- A **corrupted-library remedy IS required** (spec §3.5.3): this file exists
  in the wild with 29 duplicated ids. Dedupe-on-load vs dedupe-on-next-persist
  is Phase 4's recorded choice; the corruption signature to dedupe is
  "same library-item id" (the surviving copy should be chosen deterministically
  — e.g. newest element `updated` — since copies differ only in
  `updated`/`versionNonce`).
- The panel-tile duplication is user-visible today; the remedy should also
  clear the visible twins on next load/persist.

*Inspection scripts: ad-hoc `python3 json` analyses run 2026-09-06 against
the file above; key numbers reproducible with any JSON parser (counts in §1).*
