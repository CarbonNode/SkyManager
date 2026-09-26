#!/usr/bin/env python3
"""Build HotkeyDeckWardrobe.esp v2 — wardrobe executor + the NPC-control quest.

Supersedes make_wardrobe_esp.py (kept for history). Two quests, one ESL plugin:

  0x802 HDWardrobeQuest   — unchanged host for HD_WardrobeExec. Its LOCAL id and
                            EDID are load-bearing: the live save's script
                            instance and mod-event registrations key on the
                            runtime FormID (0xFExxx802), which survives this
                            rebuild because the local id survives it.
  0x803 HDNPCControlQuest — hosts HD_NPCControl and the alias machinery that
                            makes freeze / sit / bed REAL AI: reference aliases
                            carrying vanilla-template packages (priority 90, so
                            they outrank follow/sandbox packages instead of
                            losing to them the way actor-level SetRestrained
                            does).

Alias map (ids are the contract with HD_NPCControl.psc and npc_actions.cpp):

  10..17  Hold1..8      HoldPosition package anchored on the SAME alias —
                        "guard the spot you are standing on". Freeze slots.
  20..23  Sit1..4       SitTarget package aimed at the paired chair alias.
  30..33  SitChair1..4  the chair/bench/throne (forced by C++).
  40..43  Bed1..4       Sleep package: sleep in a bed within 140 units of the
                        paired bed alias (vanilla Sleep template's shape —
                        location + "any bed near it", donor T02).
  50..53  BedAnchor1..4 the bed (forced by C++).

Packages are byte-modelled on proven vanilla donors, values copied verbatim
except: QNAM → our quest, alias ids → ours, schedule → "any time", radius:
  sit    CR12PostQuestAelaPray            0x0010B110  (template SitTarget 0x000A9277)
  sleep  T02FastredSleepNearBassianus20x8 0x0004EEF1  (template Sleep     0x00019717)
  hold   CWFortSiegeHouseCarlHoldPosition 0x000CA846  (template HoldPosition 0x000503D0)
Donor CTDA conditions are NOT copied (they referenced the donor's quest).
Every donor's OnBegin/OnEnd/OnChange idles are null in the originals; the empty
action blocks are kept because the template system expects them present.

Masters: Skyrim.esm (for the template formids). With one master, our own
records carry mod-index 0x01 in their header formids; runtime ids unchanged.

Usage: python make_deck_esp.py [out.esp] --shader-source <local plugin.esp>

Shader bodies are a LOCAL build input, not bundled in the public source.
Use an existing HotkeyDeckWardrobe.esp or ShiningTreasure.esp containing the
ten bright ST_* shaders. A private build can still use the adjacent
st_efsh.json, or an explicit --shader-data JSON. Neither path grants any
redistribution rights to the donor's records.
"""
import argparse
import base64
import json
import os
import struct
import sys
import zlib

# Stamped into the plugin's TES4 author field, so it SHIPS inside the .esp and
# is readable in xEdit by anyone who downloads the mod. It must never be the
# player character's name (it was, until 2026-08-11). Override with HD_ESP_AUTHOR
# to publish under a real handle.
AUTHOR = os.environ.get("HD_ESP_AUTHOR", "Hotkey Deck")
TES4_LIGHT = 0x00000200            # ESL bit

QUEST_WARDROBE_FID = 0x01000802    # local 0x802, mod-index 1 (one master)
QUEST_NPC_FID      = 0x01000803    # local 0x803
QNAM_SELF          = QUEST_NPC_FID

TPL_SIT   = 0x000A9277             # SitTarget template (Skyrim.esm)
TPL_SLEEP = 0x00019717             # Sleep template
TPL_HOLD  = 0x000503D0             # HoldPosition template

HOLD_IDS  = list(range(10, 18))    # 8 freeze slots
SIT_IDS   = list(range(20, 24))    # 4 sit pairs
CHAIR_IDS = list(range(30, 34))
BED_IDS   = list(range(40, 44))
BEDA_IDS  = list(range(50, 54))
NEXT_ALIAS = 54

PACK_HOLD_BASE  = 0x810            # 0x810..0x817
PACK_SIT_BASE   = 0x820            # 0x820..0x823
PACK_SLEEP_BASE = 0x830            # 0x830..0x833

# Deck-owned faction for the Animations tab's moving-crawl (2026-08-05). The
# deck adds the crawl target to it; the crawl OAR replacer is gated on
# IsInFaction("HotkeyDeckWardrobe.esp"|0x900). Clear of the 0x802/0x803 quests
# and the 0x8xx package ids.
FACT_CRAWL_FID = 0x01000900        # local 0x900

# Loot Highlighter EFFECT SHADERS. The ten bright ST_ShaderList records from
# ShiningTreasure (Nexus 21228) are supplied locally, never bundled with this
# public generator. Their bodies reference the vanilla darkswirls_blurry texture.
# Preserve bodies verbatim and assign only new header FormIDs. The private
# st_efsh.json input remains supported; public builds use --shader-source.
# Local 0x950.., clear of every id above. loot_highlight.cpp resolves them by editor id.
EFSH_FID_BASE = 0x01000950
_EFSH_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "st_efsh.json")
SHADER_NAMES = frozenset('ST_' + color for color in (
    'Blue', 'Brown', 'Cyan', 'Green', 'Orange', 'Pink', 'Purple', 'Red', 'White', 'Yellow'))
MAX_PLUGIN_BYTES = 64 * 1024 * 1024
MAX_SHADER_BYTES = 1024 * 1024

FNAM_OPTIONAL_REUSE = 0x0000000A   # kOptional | kAllowReuse (BGSBaseAlias)

PSDT_ANYTIME = bytes.fromhex("ffff00ffff00000000000000")


def zs(s):
    return s.encode("ascii") + b"\x00"


def sub(sig, payload):
    return sig + struct.pack("<H", len(payload)) + payload


def u32(v):
    return struct.pack("<I", v)


def wstr(s):
    b = s.encode("ascii")
    return struct.pack("<H", len(b)) + b


def rec(sig, body, flags, fid):
    return sig + struct.pack("<IIIHHHH", len(body), flags, fid, 0, 0, 0x2C, 0) + body


def grup(label, records):
    body = b"".join(records)
    return (b"GRUP" + struct.pack("<I", len(body) + 24) + label
            + struct.pack("<iII", 0, 0, 0) + body)


def vmad_one_script(script):
    """version 5, objFormat 2, one script, zero properties."""
    return struct.pack("<hhH", 5, 2, 1) + wstr(script) + b"\x00" + struct.pack("<H", 0)


def action_blocks():
    """POBA/POEA/POCA with null idle + null topic — as every donor carries."""
    out = b""
    for marker in (b"POBA", b"POEA", b"POCA"):
        out += sub(marker, b"") + sub(b"INAM", u32(0)) + sub(b"PDTO", bytes(8))
    return out


# ---------------------------------------------------------------- packages --

def pack_sit(fid, edid, chair_alias):
    body = (sub(b"EDID", zs(edid))
            + sub(b"PKDT", bytes.fromhex("000000001200022c00000000"))
            + sub(b"PSDT", PSDT_ANYTIME)
            + sub(b"QNAM", u32(QNAM_SELF))
            + sub(b"PKCU", struct.pack("<III", 3, TPL_SIT, 2))
            + sub(b"ANAM", zs("SingleRef"))
            + sub(b"PTDA", struct.pack("<iIi", 4, chair_alias, 0))
            + sub(b"ANAM", zs("Float")) + sub(b"CNAM", struct.pack("<f", 0.0))
            + sub(b"ANAM", zs("Bool")) + sub(b"CNAM", b"\x00")
            + sub(b"UNAM", b"\x10") + sub(b"UNAM", b"\x03") + sub(b"UNAM", b"\x04")
            + sub(b"XNAM", b"\x11")
            + action_blocks())
    return rec(b"PACK", body, 0, fid)


def pack_hold(fid, edid, anchor_alias, radius=96):
    body = (sub(b"EDID", zs(edid))
            + sub(b"PKDT", bytes.fromhex("000080001204027200000000"))
            + sub(b"PSDT", PSDT_ANYTIME)
            + sub(b"QNAM", u32(QNAM_SELF))
            + sub(b"PKCU", struct.pack("<III", 1, TPL_HOLD, 5))
            + sub(b"ANAM", zs("Location"))
            + sub(b"PLDT", struct.pack("<iIi", 8, anchor_alias, radius))
            + sub(b"UNAM", b"\x00")
            + sub(b"XNAM", b"\x08")
            + action_blocks())
    return rec(b"PACK", body, 0, fid)


def pack_sleep(fid, edid, bed_alias, radius=140):
    # Donor value order, verbatim (T02FastredSleepNearBassianus20x8), with the
    # schedule cleared and the location re-pointed. Bools/floats untouched.
    bools = [1, 1, 0, None, 0, 0, 0, 1, 1, 1, 1, 1, 1]   # None = ObjectList u32 0
    vals = b""
    for b in bools:
        if b is None:
            vals += sub(b"ANAM", zs("ObjectList")) + sub(b"CNAM", u32(0))
        else:
            vals += sub(b"ANAM", zs("Bool")) + sub(b"CNAM", bytes([b]))
    vals += sub(b"ANAM", zs("Float")) + sub(b"CNAM", struct.pack("<f", 300.0))
    vals += sub(b"ANAM", zs("Float")) + sub(b"CNAM", struct.pack("<f", 50.0))
    unams = [0x00, 0x01, 0x0F, 0x0D, 0x0B, 0x02, 0x06, 0x08, 0x11, 0x12,
             0x13, 0x14, 0x15, 0x19, 0x16, 0x1A, 0x18]
    body = (sub(b"EDID", zs(edid))
            + sub(b"PKDT", bytes.fromhex("0000000012000201ffff0000"))
            + sub(b"PSDT", PSDT_ANYTIME)
            + sub(b"QNAM", u32(QNAM_SELF))
            + sub(b"PKCU", struct.pack("<III", 17, TPL_SLEEP, 6))
            + sub(b"ANAM", zs("Location"))
            + sub(b"PLDT", struct.pack("<iIi", 8, bed_alias, radius))
            + sub(b"ANAM", zs("TargetSelector"))
            + sub(b"PTDA", struct.pack("<iIi", 2, 0x1A, 0))   # object type: beds
            + vals
            + b"".join(sub(b"UNAM", bytes([u])) for u in unams)
            + sub(b"XNAM", b"\x10")
            + action_blocks())
    return rec(b"PACK", body, 0, fid)


# ------------------------------------------------------------------ quests --

def alias_block(aid, name, packages=()):
    out = (sub(b"ALST", u32(aid))
           + sub(b"ALID", zs(name))
           + sub(b"FNAM", u32(FNAM_OPTIONAL_REUSE)))
    for p in packages:
        out += sub(b"ALPC", u32(p))
    out += sub(b"VTCK", u32(0)) + sub(b"ALED", b"")
    return out


def qust_wardrobe():
    body = (sub(b"EDID", zs("HDWardrobeQuest"))
            + sub(b"VMAD", vmad_one_script("HD_WardrobeExec"))
            + sub(b"FULL", zs("Wardrobe Executor"))
            + sub(b"DNAM", bytes.fromhex("010032ff0000000000000000")))
    return rec(b"QUST", body, 0, QUEST_WARDROBE_FID)


def qust_npc_control():
    aliases = b""
    for i, aid in enumerate(HOLD_IDS):
        aliases += alias_block(aid, "Hold%d" % (i + 1), [0x01000000 | (PACK_HOLD_BASE + i)])
    for i, aid in enumerate(SIT_IDS):
        aliases += alias_block(aid, "Sit%d" % (i + 1), [0x01000000 | (PACK_SIT_BASE + i)])
    for i, aid in enumerate(CHAIR_IDS):
        aliases += alias_block(aid, "SitChair%d" % (i + 1))
    for i, aid in enumerate(BED_IDS):
        aliases += alias_block(aid, "Bed%d" % (i + 1), [0x01000000 | (PACK_SLEEP_BASE + i)])
    for i, aid in enumerate(BEDA_IDS):
        aliases += alias_block(aid, "BedAnchor%d" % (i + 1))

    # DNAM: flags 0x0001 (Start Game Enabled — belt; C++ Start() is braces),
    # priority 0x5A (90): the whole point. Above follow frameworks.
    body = (sub(b"EDID", zs("HDNPCControlQuest"))
            + sub(b"VMAD", vmad_one_script("HD_NPCControl"))
            + sub(b"FULL", zs("Hotkey Deck NPC Control"))
            + sub(b"DNAM", bytes.fromhex("01005aff0000000000000000"))
            + sub(b"NEXT", b"")
            + sub(b"ANAM", u32(NEXT_ALIAS))
            + aliases)
    return rec(b"QUST", body, 0, QUEST_NPC_FID)


def fact_crawl():
    # Minimal faction: an editor id + a 4-byte flags DATA (0). Membership is all
    # the crawl OAR condition needs (IsInFaction), so no ranks/relations.
    body = sub(b"EDID", zs("HDCrawlFaction")) + sub(b"DATA", struct.pack("<I", 0))
    return rec(b"FACT", body, 0, FACT_CRAWL_FID)


def shader_editor_id(body, require_data=True):
    """Read a bounded EFSH body; never accept a truncated subrecord or duplicate EDID."""
    offset, name, data_sizes = 0, None, []
    while offset < len(body):
        if offset + 6 > len(body):
            raise ValueError('truncated shader subrecord header')
        sig, size = struct.unpack_from('<4sH', body, offset)
        offset += 6
        if offset + size > len(body):
            raise ValueError('truncated shader subrecord data')
        payload = body[offset:offset + size]
        offset += size
        if sig == b'EDID':
            if name is not None or not payload.endswith(b'\0') or b'\0' in payload[:-1]:
                raise ValueError('invalid or duplicate shader EDID')
            name = payload[:-1].decode('ascii')
        elif sig == b'DATA':
            data_sizes.append(size)
    if require_data and data_sizes != [400]:
        raise ValueError('expected one 400-byte Skyrim SE shader DATA subrecord')
    if require_data and name is None:
        raise ValueError('shader is missing EDID')
    return name


def shaders_from_plugin(data):
    """Extract only the named shader records from a user's local SE plugin."""
    if len(data) > MAX_PLUGIN_BYTES or len(data) < 24 or data[:4] != b'TES4':
        raise ValueError('expected a Skyrim SE plugin smaller than 64 MiB')
    bodies = {}

    def walk(start, end, depth=0):
        if depth > 16:
            raise ValueError('plugin group nesting is too deep')
        offset = start
        while offset < end:
            if offset + 24 > end:
                raise ValueError('truncated plugin record header')
            sig, size = struct.unpack_from('<4sI', data, offset)
            stop = offset + (size if sig == b'GRUP' else 24 + size)
            if stop < offset + 24 or stop > end:
                raise ValueError('invalid plugin record/group size')
            if sig == b'GRUP':
                # EFSH records live in their own top-level group. Other groups
                # may contain millions of unrelated records; skip them whole.
                if data[offset + 8:offset + 12] == b'EFSH':
                    walk(offset + 24, stop, depth + 1)
            elif sig == b'EFSH':
                flags = struct.unpack_from('<I', data, offset + 8)[0]
                body = data[offset + 24:stop]
                if flags & 0x40000:
                    if len(body) < 4:
                        raise ValueError('truncated compressed shader')
                    expected = struct.unpack_from('<I', body)[0]
                    if expected > MAX_SHADER_BYTES:
                        raise ValueError('compressed shader exceeds size limit')
                    inflater = zlib.decompressobj()
                    body = inflater.decompress(body[4:], expected + 1)
                    if (len(body) != expected or not inflater.eof or
                            inflater.unused_data or inflater.unconsumed_tail):
                        raise ValueError('invalid compressed shader size or stream')
                if len(body) > MAX_SHADER_BYTES:
                    raise ValueError('shader exceeds size limit')
                name = shader_editor_id(body, require_data=False)
                if name in SHADER_NAMES:
                    if flags & 0x20:
                        raise ValueError('required shader is deleted: ' + name)
                    if name in bodies:
                        raise ValueError('duplicate shader: ' + name)
                    shader_editor_id(body)
                    bodies[name] = body
            offset = stop

    walk(0, len(data))
    return bodies


def load_shader_bodies(shader_source=None, shader_data=None):
    if shader_source and shader_data:
        raise ValueError('choose one shader input')
    if shader_source:
        with open(shader_source, 'rb') as f:
            bodies = shaders_from_plugin(f.read(MAX_PLUGIN_BYTES + 1))
    else:
        path = shader_data or _EFSH_JSON
        if not os.path.isfile(path):
            raise ValueError('shader data is not included in the public source; use '
                             '--shader-source <existing HotkeyDeckWardrobe.esp or ShiningTreasure.esp>, '
                             'or --shader-data <local JSON>')
        with open(path, encoding='utf-8') as f:
            encoded = json.load(f)
        if not isinstance(encoded, dict):
            raise ValueError('shader JSON must be an object keyed by EditorID')
        bodies = {name: base64.b64decode(value, validate=True) for name, value in encoded.items()}
    missing = SHADER_NAMES - bodies.keys()
    extra = bodies.keys() - SHADER_NAMES
    if missing or extra:
        raise ValueError('shader set mismatch; missing=%s unexpected=%s' %
                         (','.join(sorted(missing)), ','.join(sorted(extra))))
    for name, body in bodies.items():
        if len(body) > MAX_SHADER_BYTES or shader_editor_id(body) != name:
            raise ValueError('invalid shader body for ' + name)
    return bodies


def efsh_records(shader_source=None, shader_data=None):
    # The ten bright ShiningTreasure shaders, copied verbatim. Ordered by editor id
    # so FormIDs are deterministic across rebuilds; the body already holds its own
    # EDID (ST_Red .. ST_White), so we only stamp a new header FormID.
    bodies = load_shader_bodies(shader_source, shader_data)
    out = []
    for i, edid in enumerate(sorted(bodies)):
        body = bodies[edid]
        out.append(rec(b"EFSH", body, 0, EFSH_FID_BASE + i))
    return out


def build(shader_source=None, shader_data=None):
    packs = []
    for i in range(8):
        packs.append(pack_hold(0x01000000 | (PACK_HOLD_BASE + i),
                               "HDNPCHold%d" % (i + 1), HOLD_IDS[i]))
    for i in range(4):
        packs.append(pack_sit(0x01000000 | (PACK_SIT_BASE + i),
                              "HDNPCSit%d" % (i + 1), CHAIR_IDS[i]))
    for i in range(4):
        packs.append(pack_sleep(0x01000000 | (PACK_SLEEP_BASE + i),
                                "HDNPCSleep%d" % (i + 1), BEDA_IDS[i]))

    qusts = [qust_wardrobe(), qust_npc_control()]
    facts = [fact_crawl()]
    efsh = efsh_records(shader_source, shader_data)

    n_records = len(packs) + len(qusts) + len(facts) + len(efsh)
    tes4_body = (sub(b"HEDR", struct.pack("<fiI", 1.71, n_records, 0x901))
                 + sub(b"CNAM", zs(AUTHOR))
                 + sub(b"MAST", zs("Skyrim.esm"))
                 + sub(b"DATA", bytes(8)))
    return (rec(b"TES4", tes4_body, TES4_LIGHT, 0)
            + grup(b"FACT", facts)
            + grup(b"EFSH", efsh)
            + grup(b"QUST", qusts)
            + grup(b"PACK", packs))


def verify(data):
    off = 0
    ok = True
    while off < len(data):
        sig = data[off:off + 4]
        if sig == b"GRUP":
            gsize = struct.unpack_from("<I", data, off + 4)[0]
            label = data[off + 8:off + 12].decode()
            print("GRUP %s size=%d" % (label, gsize))
            inner, end = off + 24, off + gsize
            while inner < end:
                s2 = data[inner:inner + 4].decode()
                size2, fl2, fid2 = struct.unpack_from("<III", data, inner + 4)
                print("  %-4s dataSize=%4d flags=0x%08X formId=0x%08X"
                      % (s2, size2, fl2, fid2))
                inner += 24 + size2
            ok &= inner == end
            off += gsize
        else:
            size, fl, fid = struct.unpack_from("<III", data, off + 4)
            print("%-4s dataSize=%4d flags=0x%08X formId=0x%08X"
                  % (sig.decode(), size, fl, fid))
            off += 24 + size
    print("total %d bytes — %s" % (len(data), "OK" if ok else "MISALIGNED"))
    return ok


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', nargs='?', default='HotkeyDeckWardrobe.esp')
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--shader-source', help='local SE plugin containing all ten ST_* shaders')
    source.add_argument('--shader-data', help='local EditorID-to-base64 JSON shader data')
    args = parser.parse_args()
    out = args.out
    input_path = args.shader_source or args.shader_data or _EFSH_JSON
    same_path = os.path.normcase(os.path.realpath(out)) == os.path.normcase(os.path.realpath(input_path))
    if os.path.exists(out) and os.path.exists(input_path):
        same_path |= os.path.samefile(out, input_path)
    if same_path:
        parser.error('output must differ from the shader input')
    try:
        data = build(args.shader_source, args.shader_data)
    except (OSError, ValueError, TypeError, zlib.error) as exc:
        parser.error(str(exc))
    if not verify(data):
        sys.exit(1)
    with open(out, "wb") as f:
        f.write(data)
    print("wrote", out)
