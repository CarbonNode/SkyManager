ScriptName HD_WardrobeExec extends Quest
;
; ===========================================================================
; DO NOT PUT THIS DOCUMENTATION BACK IN A { } DOC BLOCK. IT CRASHES THE GAME.
; ===========================================================================
; A { } block after ScriptName is a Papyrus DOCSTRING: the compiler embeds it
; verbatim in the .pex, and Skyrim reads it back through
; BSScript::CompiledScriptLoader every time the script is linked. That reader
; has a fixed buffer. Grow the docstring past it and the engine writes a null
; terminator through a bad pointer and dies - with NO plugin anywhere in the
; call stack, so it does not look like ours.
;
; PROVEN 2026-08-03 (crash-2026-08-03-19-48-48 and -19-57-09, identical):
; EXCEPTION_ACCESS_VIOLATION at SkyrimSE.exe+12515D4,
;   mov byte ptr [rbp+rcx*1], 0x00
; NetScriptFramework named the frames - BSVMLoadTask -> ObjectBindPolicy ->
; VirtualMachine -> LinkerProcessor -> CompiledScriptLoader - RDI pointed at
; THIS TEXT, and RBP was 0x1747 = 5959, the exact byte length of the docstring
; in the .pex. The previous, working build had the same text at 1768 bytes.
; Two startup CTDs in a row, 100% repeatable, until it moved into ; comments.
;
; ; comments are NOT compiled into the .pex. Documentation is free here.
; Keep this file pure ASCII too: the compile step re-encodes, so an em dash
; became six bytes instead of three and inflated the docstring further.
;
;   Hotkey Deck -- Wardrobe executor.
;
;   The ONLY thing in this system that talks to SOES-NG. The deck's SKSE plugin
;   decides *what* should happen and sends a mod event; this script performs it by
;   calling SkyrimOutfitEquipmentSystemNativeFuncs.
;
;   WHY THE INDIRECTION. SOES's API is Papyrus natives, and this rig has a
;   documented CTD bucket inside the Papyrus-VM native-call path -- src/nff_bridge.h
;   in the deck refuses to write for exactly that reason. Papyrus -> Papyrus-native
;   is SOES's own intended call path, so it is the safe one. The deck never touches
;   SOES directly.
;
;   PROTOCOL (sender carries the Actor, because a float numArg cannot hold a
;   32-bit FormID without loss):
;
;     HD_Wardrobe_Dress   strArg = outfit name              sender = Actor
;     HD_Wardrobe_SetLoc  strArg = outfit name, numArg=loc  sender = Actor
;     HD_Wardrobe_ClrLoc  numArg = locationType             sender = Actor
;     HD_Wardrobe_Track   numArg = 1 track / 0 untrack      sender = Actor
;     HD_Wardrobe_Export  (no args) -- dump SOES state to json for the deck to read
;     HD_Wardrobe_NewOutfit  strArg = outfit name          -- create it, or empty it
;     HD_Wardrobe_AddPiece   strArg = outfit name, sender = Armor
;     HD_Wardrobe_DelOutfit  strArg = outfit name
;     HD_Wardrobe_DelPiece   strArg = outfit name, sender = Armor
;     HD_Wardrobe_Import     strArg = "plugin.esp"  or  "plugin.esp|EditorID"
;     HD_Wardrobe_InvMode    strArg = "player"|"npc", numArg = 1 automatic / 2 immersive
;     HD_Wardrobe_Enable     numArg = 1 on / 0 off
;     HD_Wardrobe_RefreshAll (no args)
;     HD_Wardrobe_ResetAuto  (no args)
;     HD_Wardrobe_RenOutfit  strArg = "oldName|newName"   -- SOES's own RenameOutfit
;     HD_Wardrobe_Fav        strArg = outfit name, numArg = 1 on / 0 off
;     HD_Wardrobe_Sys        strArg = "quickslot"|"climate", numArg = 1 on / 0 off
;
;   WHY RenOutfit SPLITS ON "|". Papyrus has no split and no second string field on
;   a mod event, so the two names ride one strArg. "|" is safe because it is
;   SOES's own form-serialisation separator ("0xABCD|Mod.esp") and therefore the
;   one character SOES itself guarantees never appears inside an outfit NAME; the
;   deck refuses a rename involving one rather than mangling it silently.
;
;   AND the SECOND dressing backend, Nether's Follower Framework's own outfit
;   system (see src/nff_outfits.h in the deck):
;
;     HD_NFF_Gear strArg = "helmOff" | "helmCombat" | "helmNever"
;                         | "shieldOn" | "shieldOff"
;                         | "weaponOn" | "weaponOff"
;                         | "ammoOn"  | "ammoOff"
;                 sender = Actor   (numArg unused -- this one needs no quest id)
;
;   NFF's combat-gear toggles are FACTION MEMBERSHIP, not script properties, and
;   that is the whole reason this took a decompile to get right:
;
;     nwsFF_HelmFac    absent = NFF does not manage her headwear at all
;                      RANK 0 = wear the helmet only in combat
;                      RANK 1 = never wear a helmet
;     nwsFF_ShieldFac  present = shield only in combat   (membership, no rank)
;     nwsFF_WeaponFac  present = weapons follow YOUR sheath (membership, no rank)
;     nwsFF_AmmoFac    present = unequip arrows out of combat (membership, no rank)
;
;   The faction FORMS live on nwsFollowerVariableScript, reached as
;   <her alias>.varScript -- so this handler needs her FollowerAliasScript, which
;   is also where NFF parks the two remembered forms (wornHelmet / outfitShield)
;   and the SetPlayerSheath() call. We find that alias generically, from the
;   ACTOR (SKSE's GetNthReferenceAlias), rather than by walking NFF's quest:
;   it needs no quest id, no plugin name and no master, and it keeps working if
;   NFF ever renumbers its aliases.
;
;   !! THESE ARE ABSOLUTE STATES, NOT TOGGLES. NFF's own MCM cycles (each press
;   advances a state machine), which is right for a menu you are looking at and
;   wrong for a deck button that may be firing against a stale read. The deck
;   sends the state it WANTS; sending it twice is a no-op rather than an undo.
;
;   Every branch below mirrors nwsFollowerMCMExScript's own IDOptGearX[12/13/15/
;   16/17] handlers line for line -- including the immediate unequip, because the
;   faction alone only takes effect the next time NFF re-evaluates her.
;
;     HD_NFF_Op  strArg = "wear0".."wear3" | "build0".."build2" | "clear0".."clear3"
;                         | "satchel" | "clone"
;                         | "switch" | "recheck" | "preview0" | "preview1"
;                numArg = the ESP-LOCAL FormID of NFF's outfit quest
;                sender = Actor  (IGNORED, and allowed to be None, for the four
;                                 system-wide ops "switch"/"recheck"/"preview*" --
;                                 they act on NFF's whole outfit engine, not on
;                                 one follower, so demanding an actor would have
;                                 meant inventing a fake one)
;
;   NFF publishes no mod events of its own (proven: scanning every .pex in its
;   Scripts folder for "ModEvent" hits only SkyUILib), so a Papyrus call on its
;   quest script is the ONLY programmatic route. numArg carries the quest's local
;   id -- exact, because float32 has a 24-bit mantissa and a local id is at most
;   0xFFFFFF -- which lets us reach NFF via Game.GetFormFromFile WITHOUT taking
;   nwsFollowerFramework.esp as a master and without hardcoding a FormID.
;
;   !! ONE ACTOR, ONE BACKEND. SOES-NG's EquipObject hook silently drops any equip
;   outside its own outfit for a TRACKED actor, and NFF re-dresses through exactly
;   that path -- so a follower held by both wears SOES's choice while NFF strips and
;   re-equips her on every load door. The deck refuses to send these events for an
;   actor SOES still holds; do not add a Papyrus-side bypass.
;
;   Attach to a start-game-enabled quest in OutfitCycler.esp. See
;   modding/guides/wardrobe_system_design.md and src/wardrobe-wiring.md.
;

Import SkyrimOutfitEquipmentSystemNativeFuncs

Bool Property Verbose = False Auto
{Log every applied event to the Papyrus log.}

Event OnInit()
    RegisterAll()
EndEvent

; Mod events do NOT survive a load -- re-register on every game load.
Event OnPlayerLoadGame()
    RegisterAll()
EndEvent

Function RegisterAll()
    RegisterForModEvent("HD_Wardrobe_Dress",  "OnDress")
    RegisterForModEvent("HD_Wardrobe_SetLoc", "OnSetLoc")
    RegisterForModEvent("HD_Wardrobe_ClrLoc", "OnClrLoc")
    RegisterForModEvent("HD_Wardrobe_Track",  "OnTrack")
    RegisterForModEvent("HD_Wardrobe_Export", "OnExport")
    RegisterForModEvent("HD_Wardrobe_NewOutfit", "OnNewOutfit")
    RegisterForModEvent("HD_Wardrobe_AddPiece", "OnAddPiece")
    RegisterForModEvent("HD_Wardrobe_DelOutfit", "OnDelOutfit")
    RegisterForModEvent("HD_Wardrobe_DelPiece", "OnDelPiece")
    RegisterForModEvent("HD_Wardrobe_Import", "OnImport")
    RegisterForModEvent("HD_Wardrobe_InvMode", "OnInvMode")
    RegisterForModEvent("HD_Wardrobe_Enable", "OnEnable")
    RegisterForModEvent("HD_Wardrobe_RefreshAll", "OnRefreshAll")
    RegisterForModEvent("HD_Wardrobe_ResetAuto", "OnResetAuto")
    RegisterForModEvent("HD_Wardrobe_RenOutfit", "OnRenOutfit")
    RegisterForModEvent("HD_Wardrobe_Fav", "OnFav")
    RegisterForModEvent("HD_Wardrobe_Sys", "OnSys")
    RegisterForModEvent("HD_NFF_Op", "OnNffOp")
    RegisterForModEvent("HD_NFF_Gear", "OnNffGear")
    Log("wardrobe executor armed")
EndFunction

Function Log(String msg)
    If Verbose
        Debug.Trace("[HD_WardrobeExec] " + msg)
    EndIf
EndFunction

; ---------------------------------------------------------------- handlers

Event OnDress(String eventName, String outfitName, Float numArg, Form sender)
    Actor target = sender as Actor
    If target == None || outfitName == ""
        Log("dress ignored -- no actor or no outfit")
        Return
    EndIf
    If !OutfitExists(outfitName)
        Log("dress ignored -- SOES has no outfit '" + outfitName + "'")
        Return
    EndIf

    ; Tracking first: SetSelectedOutfit on an untracked actor is a no-op, and a
    ; tracked actor with no outfit is the documented strip-loop, so the two must
    ; always be set together and in this order.
    If !HasActor(target)
        AddActor(target)
    EndIf

    SetSelectedOutfit(target, outfitName)
    RefreshArmorFor(target)
    Log("dressed " + target.GetDisplayName() + " -> " + outfitName)
EndEvent

Event OnSetLoc(String eventName, String outfitName, Float locType, Form sender)
    Actor target = sender as Actor
    If target == None || outfitName == ""
        Return
    EndIf
    If !OutfitExists(outfitName)
        Log("setloc ignored -- no outfit '" + outfitName + "'")
        Return
    EndIf
    If !HasActor(target)
        AddActor(target)
    EndIf
    SetLocationOutfit(target, locType as Int, outfitName)
    Log("loc " + (locType as Int) + " -> " + outfitName + " for " + target.GetDisplayName())
EndEvent

Event OnClrLoc(String eventName, String strArg, Float locType, Form sender)
    Actor target = sender as Actor
    If target == None
        Return
    EndIf
    UnsetLocationOutfit(target, locType as Int)
    Log("cleared loc " + (locType as Int) + " for " + target.GetDisplayName())
EndEvent

Event OnTrack(String eventName, String strArg, Float on, Form sender)
    Actor target = sender as Actor
    If target == None
        Return
    EndIf
    If on >= 0.5
        If !HasActor(target)
            AddActor(target)
        EndIf
        RefreshArmorFor(target)
        Log("tracking " + target.GetDisplayName())
    Else
        If HasActor(target)
            RemoveActor(target)
        EndIf
        Log("untracked " + target.GetDisplayName())
    EndIf
EndEvent

; Dumps SOES's whole state (outfits + per-actor assignments) to
; Data\SKSE\Plugins\OutfitEquipmentSystemNGData.json, which the deck reads to
; build the outfit catalogue and the tracked/wearing flags.
Event OnExport(String eventName, String strArg, Float numArg, Form sender)
    Bool ok = ExportSettings()
    Log("export -> " + ok)
EndEvent

; ------------------------------------------------- building outfits

; Create the outfit, or empty it if it already exists, so re-sending a build is
; a REPLACE and never silently doubles every piece. OverwriteOutfit with an
; empty array is the only way SOES exposes "clear this outfit".
Event OnNewOutfit(String eventName, String outfitName, Float numArg, Form sender)
    If outfitName == ""
        Return
    EndIf
    If OutfitExists(outfitName)
        Armor[] empty = new Armor[1]     ; Papyrus has no zero-length array literal;
        empty[0] = None                  ; SOES skips the None entry.
        OverwriteOutfit(outfitName, empty)
        Log("emptied existing outfit '" + outfitName + "'")
    Else
        CreateOutfit(outfitName)
        Log("created outfit '" + outfitName + "'")
    EndIf
EndEvent

Event OnAddPiece(String eventName, String outfitName, Float numArg, Form sender)
    Armor piece = sender as Armor
    If outfitName == "" || piece == None
        Return
    EndIf
    If !OutfitExists(outfitName)
        CreateOutfit(outfitName)
    EndIf
    AddArmorToOutfit(outfitName, piece)
    Log("  + " + piece.GetName() + " -> " + outfitName)
EndEvent

Event OnDelOutfit(String eventName, String outfitName, Float numArg, Form sender)
    If outfitName == "" || !OutfitExists(outfitName)
        Return
    EndIf
    DeleteOutfit(outfitName)
    Log("deleted outfit '" + outfitName + "'")
EndEvent

; ------------------------------------------- editing outfits and SOES itself

Event OnDelPiece(String eventName, String outfitName, Float numArg, Form sender)
    Armor piece = sender as Armor
    If outfitName == "" || piece == None || !OutfitExists(outfitName)
        Return
    EndIf
    RemoveArmorFromOutfit(outfitName, piece)
    Log("  - " + piece.GetName() + " from " + outfitName)
EndEvent

; "plugin.esp" imports EVERY outfit that plugin defines; "plugin.esp|EditorID"
; imports just the one. Both are SOES's own importers, so an outfit arrives
; exactly as its author assembled it.
Event OnImport(String eventName, String arg, Float numArg, Form sender)
    If arg == ""
        Return
    EndIf
    Int bar = StringUtil.Find(arg, "|")
    If bar < 0
        Int n = AddAllOutfitsFromModToOutfitList(arg)
        Log("imported " + n + " outfit(s) from " + arg)
    Else
        String plugin = StringUtil.Substring(arg, 0, bar)
        String edid = StringUtil.Substring(arg, bar + 1)
        Int n2 = AddOutfitFromModToOutfitList(plugin, edid)
        Log("imported " + edid + " from " + plugin + " -> " + n2)
    EndIf
EndEvent

; Rename in SOES ITSELF. The deck re-points its own metadata, pools, assignments
; and roll history in the same breath, but SOES holds the outfit under its name
; and nothing else -- miss this call and the rename is a delete plus an orphan.
;
; RenameOutfit refuses a collision itself (returns False), so the guard here is
; only for the two cases it cannot see: an empty half, and a "new" that already
; exists -- reported rather than silently ignored, because the deck has by then
; already renamed its own side.
Event OnRenOutfit(String eventName, String arg, Float numArg, Form sender)
    Int bar = StringUtil.Find(arg, "|")
    If bar < 1
        Log("rename ignored - malformed '" + arg + "'")
        Return
    EndIf
    String oldName = StringUtil.Substring(arg, 0, bar)
    String newName = StringUtil.Substring(arg, bar + 1)
    If oldName == "" || newName == "" || oldName == newName
        Return
    EndIf
    If !OutfitExists(oldName)
        Log("rename ignored - SOES has no outfit '" + oldName + "'")
        Return
    EndIf
    If OutfitExists(newName)
        Log("rename REFUSED - '" + newName + "' already exists")
        Return
    EndIf
    Bool ok = RenameOutfit(oldName, newName)
    Log("renamed '" + oldName + "' -> '" + newName + "' = " + ok)
EndEvent

; SOES's OWN favourite flag, which is what its in-game quickslot spell lists
; (ListOutfits(favoritesOnly=True)). The deck has always had a star; until now
; that star was deck-only decoration and the quickslot menu never heard about it.
Event OnFav(String eventName, String outfitName, Float on, Form sender)
    If outfitName == "" || !OutfitExists(outfitName)
        Return
    EndIf
    SetOutfitFavoriteStatus(outfitName, on >= 0.5)
    Log("fav " + outfitName + " -> " + (on >= 0.5))
EndEvent

; Two SOES system switches that had no route out of its MCM.
;   quickslot -- grants/removes the quick-swap power (the favourites menu above)
;   climate   -- when on, weather (snow/rain) outranks the location type, so a
;               blizzard beats "she's in a city" instead of the other way round
Event OnSys(String eventName, String which, Float on, Form sender)
    Bool val = on >= 0.5
    If which == "quickslot"
        SetQuickslotEnabled(val)
    ElseIf which == "climate"
        SetClimatePriorityEnabled(val)
    Else
        Log("sys: unknown switch '" + which + "'")
        Return
    EndIf
    Log("sys " + which + " -> " + val)
EndEvent

; 1 = Automatic (SOES conjures missing pieces), 2 = Immersive (only what they own).
Event OnInvMode(String eventName, String who, Float mode, Form sender)
    Int m = mode as Int
    If m != 1 && m != 2
        Return
    EndIf
    If who == "player"
        SetPlayerInventoryManagementMode(m)
    Else
        SetNPCInventoryManagementMode(m)
    EndIf
    Log("inventory mode " + who + " -> " + m)
EndEvent

Event OnEnable(String eventName, String strArg, Float on, Form sender)
    SetEnabled(on >= 0.5)
    Log("SOES enabled -> " + (on >= 0.5))
EndEvent

Event OnRefreshAll(String eventName, String strArg, Float numArg, Form sender)
    RefreshArmorForAllConfiguredActors()
    Log("refreshed every tracked actor")
EndEvent

Event OnResetAuto(String eventName, String strArg, Float numArg, Form sender)
    AutoOutfitSwitchStateReset()
    Log("auto-switch state reset")
EndEvent

; ------------------------------------------------- Nether's Follower Framework

String Property NffPlugin = "nwsFollowerFramework.esp" Auto
{The filename NFF's outfit quest lives in. A property, not a literal, so a
 renamed plugin is fixable in the CK without recompiling.}

; Resolve NFF's outfit quest from the local FormID the deck sent. Not cached:
; the deck sends it on every op, and a cached pointer would be one more thing to
; go stale across a load.
nwsFollowerSetsScript Function NffSets(Float localId)
    If localId < 1.0
        Log("nff: no quest id sent")
        Return None
    EndIf
    Form f = Game.GetFormFromFile(localId as Int, NffPlugin)
    If f == None
        Log("nff: " + NffPlugin + " has no form " + (localId as Int) + " - is NFF loaded?")
        Return None
    EndIf
    nwsFollowerSetsScript sets = f as nwsFollowerSetsScript
    If sets == None
        Log("nff: form is not nwsFollowerSetsScript - wrong quest id?")
    EndIf
    Return sets
EndFunction

Event OnNffOp(String eventName, String op, Float questLocalId, Form sender)
    nwsFollowerSetsScript sets = NffSets(questLocalId)
    If sets == None
        Return
    EndIf

    ; --- SYSTEM-WIDE ops first, BEFORE the actor guard. These four drive NFF's
    ;     whole outfit engine and take no follower, so requiring one would have
    ;     meant the deck inventing a victim to name.
    ;
    ;   switch    NFF's own outfit-switch hotkey. With Switch Style = Manual it
    ;             raises NFF's three-way chooser; on Toggle it flips town/home
    ;             off and back; on Automatic it just re-evaluates. Either way it
    ;             ends in CheckFollowerOutfits, so every follower re-dresses.
    ;   recheck   the quieter half: re-evaluate and re-dress with no chooser.
    ;   preview0/1  NFF's "Outfit Preview Mode" (MCM: $FF_ViewGear). OFF fills a
    ;             set through a hidden chest; ON strips the follower, hands you
    ;             HER inventory and dresses the body you are looking at. It is a
    ;             plain Int property on the quest, so this is a write, not a call.
    If op == "switch"
        sets.ManualSwitch()
        Log("nff switch (manual/toggle re-evaluate)")
        Return
    ElseIf op == "recheck"
        sets.CheckOutfits()
        Log("nff recheck")
        Return
    ElseIf op == "preview0"
        sets.viewMode = 0
        Log("nff preview mode off")
        Return
    ElseIf op == "preview1"
        sets.viewMode = 1
        Log("nff preview mode on")
        Return
    EndIf

    Actor target = sender as Actor
    If target == None
        Log("nff: no actor")
        Return
    EndIf

    ; Exact string compares rather than a parser: Papyrus has no split and no
    ; hex parse worth writing, and the deck emits these literals verbatim.

    ; --- wear a set NOW (3 = give her back her own clothes) ---
    If op == "wear0"
        sets.switchOutfit(target, 0)
    ElseIf op == "wear1"
        sets.switchOutfit(target, 1)
    ElseIf op == "wear2"
        sets.switchOutfit(target, 2)
    ElseIf op == "wear3"
        sets.switchOutfit(target, 3)

    ; --- fill / refill a set. NFF answers with a ContainerMenu, which is why
    ;     the deck closes the palette before sending this one. ---
    ElseIf op == "build0"
        sets.DialogueCmd(target, 0, 0)
    ElseIf op == "build1"
        sets.DialogueCmd(target, 0, 1)
    ElseIf op == "build2"
        sets.DialogueCmd(target, 0, 2)

    ; --- clear a set; 3 drops her from NFF's outfit system entirely and gives
    ;     her original outfit back ---
    ElseIf op == "clear0"
        sets.DialogueCmd(target, 1, 0)
    ElseIf op == "clear1"
        sets.DialogueCmd(target, 1, 1)
    ElseIf op == "clear2"
        sets.DialogueCmd(target, 1, 2)
    ElseIf op == "clear3"
        sets.DialogueCmd(target, 1, 3)

    ; --- her satchel: where NFF stows her own gear while an outfit is on ---
    ElseIf op == "satchel"
        sets.DialogueCmd(target, 2, 0)

    ; --- copy what she is wearing into MY pack. NFF's own "Copy Outfit"
    ;     ($FF_CloneOutfit): it adds a COPY of each part of her current set -- or
    ;     of her default outfit when no set is active -- to the player, so you can
    ;     build the same look for somebody else without undressing her. ---
    ElseIf op == "clone"
        sets.CloneOutfit(target)

    Else
        Log("nff: unknown op '" + op + "'")
        Return
    EndIf

    Log("nff " + op + " -> " + target.GetDisplayName())
EndEvent

; ------------------------------------------- NFF combat gear (helmet/shield/...)

; Her FollowerAliasScript, found from the ACTOR rather than from NFF's quest.
;
; GetNthReferenceAlias is SKSE's, and it enumerates every alias currently
; HOLDING this reference -- so the cast is the filter: exactly one of them is
; NFF's follower alias, and a non-follower has none. That is why this needs no
; quest id (unlike OnNffOp, which calls a quest script and therefore must
; address one) and why it cannot be fooled by NFF renumbering its aliases.
FollowerAliasScript Function NffAlias(Actor myAct)
    If myAct == None
        Return None
    EndIf
    Int n = myAct.GetNumReferenceAliases()
    Int i = 0
    While i < n
        FollowerAliasScript fa = myAct.GetNthReferenceAlias(i) as FollowerAliasScript
        If fa != None
            Return fa
        EndIf
        i += 1
    EndWhile
    Return None
EndFunction

; The helmet she is actually wearing, or None. Slot 4096 is the head, 8192 the
; hair -- NFF checks both, in that order, because a circlet-style piece occupies
; the hair slot. nwsFF_nakedHelmet is NFF's own invisible placeholder and must
; never be mistaken for real headwear (it is what it EQUIPS to hide one).
Form Function WornHelmOf(Actor myAct, nwsFollowerVariableScript vs)
    Form found = myAct.GetWornForm(4096)
    If found == vs.nwsFF_nakedHelmet as Form
        found = None
    EndIf
    If found == None
        found = myAct.GetWornForm(8192)
    EndIf
    If found == vs.nwsFF_nakedHelmet as Form
        found = None
    EndIf
    Return found
EndFunction

Event OnNffGear(String eventName, String op, Float numArg, Form sender)
    Actor myAct = sender as Actor
    If myAct == None || op == ""
        Log("gear ignored - no actor or no op")
        Return
    EndIf

    FollowerAliasScript fa = NffAlias(myAct)
    If fa == None
        Log("gear: " + myAct.GetDisplayName() + " is not in an NFF follower alias")
        Return
    EndIf
    nwsFollowerVariableScript vs = fa.varScript
    If vs == None
        Log("gear: alias has no varScript - NFF not initialised?")
        Return
    EndIf

    Actor thePlayer = Game.GetPlayer()

    ; --- headwear: absent / rank 0 (combat only) / rank 1 (never) ------------
    If op == "helmOff"
        myAct.RemoveFromFaction(vs.nwsFF_HelmFac)
        ; NFF hands Serana her hood back when it stops managing her head; it is
        ; her vanilla headwear and nothing else re-equips it.
        If myAct == vs.Serana && myAct.GetItemCount(vs.SeranaHoodie as Form) == 0
            myAct.AddItem(vs.SeranaHoodie as Form, 1, False)
        EndIf

    ElseIf op == "helmCombat" || op == "helmNever"
        Int rank = 0
        If op == "helmNever"
            rank = 1
        EndIf
        If !myAct.IsInFaction(vs.nwsFF_HelmFac)
            myAct.AddToFaction(vs.nwsFF_HelmFac)
        EndIf
        myAct.SetFactionRank(vs.nwsFF_HelmFac, rank)
        If myAct == vs.Serana && myAct.GetItemCount(vs.SeranaHoodie as Form) >= 1
            myAct.RemoveItem(vs.SeranaHoodie as Form, 1, False, None)
        EndIf

        Form actHelm = WornHelmOf(myAct, vs)
        If actHelm != None
            ; NFF's MCM asks "is this her headwear?" with a messagebox here. The
            ; deck cannot: it is fired from a paused palette and a modal would
            ; land behind it. Remembering it is the useful answer of the two --
            ; it is the piece she goes back into for combat -- and forgetting it
            ; would silently downgrade "only in combat" to "never".
            If op == "helmCombat"
                fa.wornHelmet = actHelm
            EndIf
            If !thePlayer.IsInCombat()
                myAct.UnequipItemEx(actHelm, 0, True)
            EndIf
        EndIf

    ; --- shield: membership only --------------------------------------------
    ElseIf op == "shieldOff"
        myAct.RemoveFromFaction(vs.nwsFF_ShieldFac)

    ElseIf op == "shieldOn"
        If !myAct.IsInFaction(vs.nwsFF_ShieldFac)
            myAct.AddToFaction(vs.nwsFF_ShieldFac)
        EndIf
        ; Which shield to put BACK in combat has to be remembered now, while she
        ; is still holding it. NFF looks in her base Outfit first (the durable
        ; answer, which survives her dropping it) and falls back to whatever is
        ; in her left hand -- equipped type 10 is Shield.
        Bool foundShield = False
        Outfit myOutfit = myAct.GetActorBase().GetOutfit(False)
        If myOutfit != None
            Int outfitSize = myOutfit.GetNumParts()
            Int index = 0
            While index < outfitSize
                Armor myArmor = myOutfit.GetNthPart(index) as Armor
                If myArmor != None && myArmor.IsShield()
                    fa.outfitShield = myArmor as Form
                    myAct.UnequipItemEx(myArmor as Form, 0, True)
                    foundShield = True
                EndIf
                index += 1
            EndWhile
        EndIf
        If !foundShield && myAct.GetEquippedItemType(0) == 10
            Form actShield = myAct.GetEquippedObject(0)
            fa.outfitShield = actShield
            If !myAct.IsInCombat()
                myAct.UnequipItemEx(actShield, 0, True)
            EndIf
        EndIf

    ; --- weapons: membership only, plus NFF's own sheath watcher ------------
    ElseIf op == "weaponOff"
        myAct.RemoveFromFaction(vs.nwsFF_WeaponFac)
        fa.SetPlayerSheath(False)

    ElseIf op == "weaponOn"
        If !myAct.IsInFaction(vs.nwsFF_WeaponFac)
            myAct.AddToFaction(vs.nwsFF_WeaponFac)
        EndIf
        ; Only strip her if YOUR weapon is away -- matching her to a drawn player
        ; mid-fight would disarm her in combat.
        If !thePlayer.IsWeaponDrawn()
            Int lookLeft = myAct.GetEquippedItemType(0)
            Int lookRight = myAct.GetEquippedItemType(1)
            ; 9/10/11 are torch, shield and staff -- not weapons to sheathe.
            If lookRight > 0 && lookRight != 9 && lookRight != 10 && lookRight != 11
                myAct.UnequipItemEx(myAct.GetEquippedObject(1), 1, False)
            EndIf
            If lookLeft > 0 && lookLeft != 9 && lookLeft != 10 && lookLeft != 11
                myAct.UnequipItemEx(myAct.GetEquippedObject(0), 2, False)
            EndIf
        EndIf
        fa.SetPlayerSheath(True)

    ; --- ammo: membership only ----------------------------------------------
    ElseIf op == "ammoOn"
        If !myAct.IsInFaction(vs.nwsFF_AmmoFac)
            myAct.AddToFaction(vs.nwsFF_AmmoFac)
        EndIf
    ElseIf op == "ammoOff"
        myAct.RemoveFromFaction(vs.nwsFF_AmmoFac)

    Else
        Log("gear: unknown op '" + op + "'")
        Return
    EndIf

    Log("gear " + op + " -> " + myAct.GetDisplayName())
EndEvent
