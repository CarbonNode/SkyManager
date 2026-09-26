# Walk With Me public interface

Unmodified `include/WayfarerAPI.h` from
https://github.com/fatalCMD/walk-with-me at
`45227954342a56bee99ff7c9ddf1648bd148b445` (0.2.2), GPL-3.0-or-later.
The accompanying LICENSE is copied from that revision.

SkyManager resolves `Wayfarer_GetInterface(1)` from the already loaded DLL,
only for a verified 0.2.2-or-newer SKSE version record. No private offsets,
injection, marker manipulation or replacement pathing code are used.

`formation_wwm.cpp` preserves the owner's INI and uses its public
`ReloadSettings`/`SetDialogueManagement` Papyrus natives for those operations.
The deck closes after dispatch so the VM can run. API getters provide live
enabled/mode/managed state; there is no public physical hand-grip status.
