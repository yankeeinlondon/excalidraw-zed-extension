#!/usr/bin/env python3
"""Restore the twinned-library precondition for the Phase 7 §3.6 GUI criterion.

The Track A appendix inspected the reporting setup's persisted shared library
and found 216 entries / 187 distinct ids / 29 ids appearing twice: one 29-item
personal library merged twice on 2026-06-16, the second copy's elements stamped
`updated` 23:17:51.59x and the first copy's 23:18:42.176.

By the time Phase 7 ran, that file had **self-healed** — a preview opened during
the Phase 5/6 window seeded through `sanitizePersistedLibrary` (D3's
dedupe-on-load remedy) and the seeding `onLibraryChange` echo persisted the
deduped result. 187 entries, 0 duplicated ids. Good news for the fix, but it
removes the precondition of the checklist item that asks a human to watch the
panel render one tile per item *from load* against a still-corrupted file.

This script re-creates that precondition in place, faithfully to the appendix's
signature: the same 29-item block appended back-to-back immediately after
itself, the appended copy carrying the older element stamps. It always writes a
backup first and never copies library content into the repository.

Usage:

    ./twin-library.py                 # report the live file's state, change nothing
    ./twin-library.py --install       # back up, then write the twinned file
    ./twin-library.py --restore       # put the backup back

Run --install before the §3.6 library criteria, --restore after.
"""

from __future__ import annotations

import argparse
import collections
import copy
import datetime
import json
import pathlib
import random
import shutil
import sys

DEFAULT_LIBRARY = (
    pathlib.Path.home()
    / "Library"
    / "Application Support"
    / "excalidraw-zed"
    / "library.excalidrawlib"
)
BACKUP_SUFFIX = ".phase7-backup"

# The appendix's duplicated block: nameless, `unpublished`, `created` stamps
# spanning 2022-03-24 17:48:34-17:50:47 UTC.
BLOCK_CREATED_FROM = datetime.datetime(2022, 3, 24, tzinfo=datetime.timezone.utc)
BLOCK_CREATED_TO = datetime.datetime(2022, 3, 25, tzinfo=datetime.timezone.utc)
BLOCK_SIZE = 29

# The older of the two merge stamps — what the appended (second) copies carried,
# so that D3's survivor rule keeps the first copy exactly as it did in the wild.
SECOND_COPY_UPDATED = datetime.datetime(
    2026, 6, 16, 23, 17, 51, 590_000, tzinfo=datetime.timezone.utc
)


def epoch_ms(moment: datetime.datetime) -> int:
    return int(moment.timestamp() * 1000)


def load(path: pathlib.Path) -> tuple[dict, list]:
    document = json.loads(path.read_text())
    items = document.get("libraryItems")
    if items is None:
        sys.exit(f"{path}: no `libraryItems` array — not a library file?")
    return document, items


def describe(path: pathlib.Path) -> None:
    document, items = load(path)
    counts = collections.Counter(item.get("id") for item in items)
    duplicated = [item_id for item_id, n in counts.items() if n > 1]
    print(f"file:            {path}")
    print(f"bytes:           {path.stat().st_size:,}")
    print(f"entries:         {len(items)}")
    print(f"distinct ids:    {len(counts)}")
    print(f"duplicated ids:  {len(duplicated)}")
    print(f"version/type:    {document.get('version')} / {document.get('type')}")
    block = find_block(items)
    print(f"appendix block:  {len(block)} item(s) at positions "
          f"{block[0][0]}..{block[-1][0]}" if block else "appendix block:  not found")


def find_block(items: list) -> list[tuple[int, dict]]:
    """The appendix's 29-item personal library, as (position, item) pairs."""
    lo, hi = epoch_ms(BLOCK_CREATED_FROM), epoch_ms(BLOCK_CREATED_TO)
    return [
        (position, item)
        for position, item in enumerate(items)
        if not item.get("name")
        and item.get("status") == "unpublished"
        and lo < item.get("created", 0) < hi
    ]


def install(path: pathlib.Path) -> None:
    document, items = load(path)

    counts = collections.Counter(item.get("id") for item in items)
    already = [item_id for item_id, n in counts.items() if n > 1]
    if already:
        sys.exit(
            f"{path} already has {len(already)} duplicated id(s) — the precondition "
            "is already in place; nothing to do (use --restore if you meant to undo "
            "a previous --install)."
        )

    block = find_block(items)
    if len(block) != BLOCK_SIZE:
        sys.exit(
            f"expected the appendix's {BLOCK_SIZE}-item block, found {len(block)}. "
            "This library is not the one Track A inspected — re-derive the block "
            "before trusting this script."
        )
    positions = [position for position, _ in block]
    if positions != list(range(positions[0], positions[0] + BLOCK_SIZE)):
        sys.exit(f"block is not contiguous ({positions}) — refusing to guess a layout.")

    stamp = epoch_ms(SECOND_COPY_UPDATED)
    twins = []
    for _, item in block:
        twin = copy.deepcopy(item)
        for element in twin.get("elements", []):
            element["updated"] = stamp
            element["versionNonce"] = random.getrandbits(31)
        twins.append(twin)

    insert_at = positions[-1] + 1
    document["libraryItems"] = items[:insert_at] + twins + items[insert_at:]

    backup = path.with_name(path.name + BACKUP_SUFFIX)
    if backup.exists():
        sys.exit(f"{backup} already exists — restore or move it before installing again.")
    shutil.copy2(path, backup)
    path.write_text(json.dumps(document))

    print(f"backed up:  {backup}")
    print(f"installed:  {len(document['libraryItems'])} entries "
          f"({BLOCK_SIZE} twins appended at positions {insert_at}..{insert_at + BLOCK_SIZE - 1})")
    print("Now open a preview and run the §3.6 library criteria; then --restore.")


def restore(path: pathlib.Path) -> None:
    backup = path.with_name(path.name + BACKUP_SUFFIX)
    if not backup.exists():
        sys.exit(f"no backup at {backup} — nothing to restore.")
    shutil.copy2(backup, path)
    backup.unlink()
    print(f"restored from backup; {backup.name} removed")
    describe(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=pathlib.Path, default=DEFAULT_LIBRARY)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--install", action="store_true", help="back up, then twin the block")
    mode.add_argument("--restore", action="store_true", help="put the backup back")
    args = parser.parse_args()

    if not args.library.exists():
        sys.exit(f"{args.library} does not exist.")
    if args.install:
        install(args.library)
    elif args.restore:
        restore(args.library)
    else:
        describe(args.library)


if __name__ == "__main__":
    main()
