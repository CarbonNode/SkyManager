#!/usr/bin/env python3
"""Strip the compiling machine's identity out of a compiled Papyrus script.

The Papyrus compiler stamps THREE strings into every .pex header: the source
file name, the Windows USERNAME of whoever compiled it, and that PC's MACHINE
NAME. They are invisible in game and invisible to every text-based audit — and
they ship inside the archive, where `strings HD_NPCControl.pex` hands a
stranger the author's account name and computer name.

Found on 2026-08-11 by the release packager's binary scan:

    srcFileName  'HD_NPCControl.psc'
    username     'rober'            <-- ships
    machineName  'DESKTOP-532Q4KG'  <-- ships

PEX layout (Skyrim SE, magic FA57C0DE, big-endian):

    u32 magic · u8 major · u8 minor · u16 gameId · u64 compileTime
    u16-length-prefixed: srcFileName, username, machineName
    ... everything else

There is no offset table anywhere in the format, so rewriting a header string
to a different length is safe: the rest of the file is read sequentially.

The source file name is KEPT — it is the script's own name, it is already
public in the .psc we ship, and Papyrus tooling prints it in stack traces.
"""

# Python 3.8 lives on the build rig, where `tuple[str, int]` in an annotation
# is evaluated at def time and raises. This makes every annotation lazy, so
# the scrubber runs there too — without it make-release.py silently fell back
# to the UNSCRUBBED .pex and only the binary scan caught it.
from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

MAGIC = 0xFA57C0DE
HEADER_FIXED = 4 + 1 + 1 + 2 + 8  # magic, major, minor, gameId, compileTime


def _read_str(buf: bytes, off: int) -> tuple[str, int]:
    (n,) = struct.unpack_from(">H", buf, off)
    return buf[off + 2 : off + 2 + n].decode("ascii", "replace"), off + 2 + n


def _pack_str(s: str) -> bytes:
    b = s.encode("ascii", "replace")
    if len(b) > 0xFFFF:
        raise ValueError("string too long for a pex header")
    return struct.pack(">H", len(b)) + b


def scrub(path: Path, user: str, machine: str, dry: bool) -> bool:
    data = path.read_bytes()
    if len(data) < HEADER_FIXED + 6:
        print(f"  {path.name}: too short to be a .pex", file=sys.stderr)
        return False
    (magic,) = struct.unpack_from(">I", data, 0)
    if magic != MAGIC:
        print(f"  {path.name}: not a Skyrim .pex (magic {magic:08X})", file=sys.stderr)
        return False

    off = HEADER_FIXED
    src, off = _read_str(data, off)
    old_user, off = _read_str(data, off)
    old_machine, end = _read_str(data, off)

    if old_user == user and old_machine == machine:
        print(f"  {path.name}: already neutral")
        return True

    print(f"  {path.name}: user {old_user!r} -> {user!r}, machine {old_machine!r} -> {machine!r}")
    if dry:
        return True

    rebuilt = (
        data[:HEADER_FIXED]
        + _pack_str(src)
        + _pack_str(user)
        + _pack_str(machine)
        + data[end:]
    )
    path.write_bytes(rebuilt)

    # Prove it: re-read what we just wrote rather than trusting the write.
    check = path.read_bytes()
    o = HEADER_FIXED
    _, o = _read_str(check, o)
    u, o = _read_str(check, o)
    m, _ = _read_str(check, o)
    if (u, m) != (user, machine):
        print(f"  {path.name}: VERIFY FAILED ({u!r}, {m!r})", file=sys.stderr)
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", type=Path, help=".pex files, or folders to walk")
    ap.add_argument("--user", default="hotkeydeck", help="replacement username")
    ap.add_argument("--machine", default="build", help="replacement machine name")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    files: list[Path] = []
    for p in a.paths:
        if p.is_dir():
            files.extend(sorted(p.rglob("*.pex")))
        elif p.suffix.lower() == ".pex":
            files.append(p)
        else:
            print(f"skipping {p} (not a .pex)", file=sys.stderr)
    if not files:
        print("no .pex files found", file=sys.stderr)
        return 1

    print(f"pex_scrub: {len(files)} file(s){' (dry run)' if a.dry_run else ''}")
    ok = all(scrub(f, a.user, a.machine, a.dry_run) for f in files)
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
