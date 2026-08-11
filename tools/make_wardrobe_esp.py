#!/usr/bin/env python3
"""Build HotkeyDeckWardrobe.esp — the ESP host for the Wardrobe executor.

A Papyrus script needs a persistent form to live on, and mod-event registrations
only survive a load if the script sits on one. So the executor needs a quest, and
a quest needs a plugin. This builds the smallest plugin that can carry one.

Modelled byte-for-byte on OutfitCycler.esp, a proven minimal plugin of exactly
this shape (398 bytes, no masters, one QUST with a VMAD). Read that file's real
bytes before changing anything here.

ESL-flagged, FormID 0x802 — inside the 0x800-0xFFF window ESL requires, so it
costs no load-order slot in a 4,000-plugin setup.

Record header is 24 bytes:
    sig(4) size(4) flags(4) formId(4) timestamp(2) vcInfo(2) formVersion(2) pad(2)
Getting that wrong (20 bytes) is the first mistake to make; it parses as garbage.

Usage:  python make_wardrobe_esp.py [out.esp]
"""
import io
import os
import struct
import sys

SCRIPT = "HD_WardrobeExec"
EDID   = "HDWardrobeQuest"
FULL   = "Wardrobe Executor"
FID    = 0x00000802
# Ships inside the .esp (TES4 author field) — never the player character's name.
# Override with HD_ESP_AUTHOR to publish under a real handle.
AUTHOR = os.environ.get("HD_ESP_AUTHOR", "Hotkey Deck")

TES4_LIGHT = 0x00000200          # the ESL bit, as set on OutfitCycler.esp
DNAM       = "010032ff0000000000000000"   # flags 0x01 = Start Game Enabled, priority 50


def zs(s):
    return s.encode("ascii") + b"\x00"


def sub(sig, payload):
    return sig + struct.pack("<H", len(payload)) + payload


def wstr(s):
    """VMAD's length-prefixed string — NOT null-terminated."""
    b = s.encode("ascii")
    return struct.pack("<H", len(b)) + b


def rec(sig, body, flags, fid):
    return sig + struct.pack("<IIIHHHH", len(body), flags, fid, 0, 0, 0x2c, 0) + body


def build():
    # VMAD: version 5, objFormat 2, one script, no properties (the .pex carries
    # its own defaults, so there is nothing the plugin needs to supply).
    vmad = struct.pack("<hhH", 5, 2, 1) + wstr(SCRIPT) + b"\x00" + struct.pack("<H", 0)

    body = (sub(b"EDID", zs(EDID))
            + sub(b"VMAD", vmad)
            + sub(b"FULL", zs(FULL))
            + sub(b"DNAM", bytes.fromhex(DNAM)))
    qust = rec(b"QUST", body, 0, FID)

    grup = (b"GRUP" + struct.pack("<I", len(qust) + 24) + b"QUST"
            + struct.pack("<iII", 0, 0, 0) + qust)

    tes4_body = (sub(b"HEDR", struct.pack("<fiI", 1.71, 1, FID + 1))
                 + sub(b"CNAM", zs(AUTHOR)))
    return rec(b"TES4", tes4_body, TES4_LIGHT, 0) + grup


def verify(data):
    """Walk it back the way the game will. Any drift shows up as a record that
    does not land exactly on its own end offset."""
    off = 0
    ok = True
    while off < len(data) - 24:
        sig = data[off:off + 4]
        size, flags, fid = struct.unpack_from("<III", data, off + 4)
        print("  %-4s dataSize=%3d flags=0x%08X formId=0x%08X"
              % (sig.decode(), size, flags, fid))
        if sig == b"GRUP":
            off += 24
            continue
        o, end = off + 24, off + 24 + size
        while o < end - 6:
            ss = data[o:o + 4]
            sl = struct.unpack_from("<H", data, o + 6 - 2)[0]
            val = data[o + 6:o + 6 + sl]
            try:
                txt = val.decode("ascii").replace("\x00", "|")
            except UnicodeDecodeError:
                txt = val.hex()
            print("        %-4s len=%3d %s" % (ss.decode(errors="replace"), sl, txt))
            o += 6 + sl
        if o != end:
            print("        !! ended at %d, record ends at %d" % (o, end))
            ok = False
        off = end
    ok = ok and off == len(data)
    print("\nparsed to exactly EOF : %s" % (off == len(data)))
    print("script embedded       : %s" % (SCRIPT.encode() in data))
    print("start-game-enabled    : %s" % (bytes.fromhex(DNAM[:8]) in data))
    print("ESL flag set          : %s" % bool(struct.unpack_from("<I", data, 8)[0] & TES4_LIGHT))
    print("FormID in ESL range   : %s" % (0x800 <= FID <= 0xFFF))
    return ok


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "HotkeyDeckWardrobe.esp"
    blob = build()
    io.open(out, "wb").write(blob)
    print("wrote %s — %d bytes\n" % (out, len(blob)))
    sys.exit(0 if verify(blob) else 1)
