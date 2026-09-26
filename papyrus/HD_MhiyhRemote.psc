Scriptname HD_MhiyhRemote Hidden
{SkyManager's REMOTE door into My Home is Your Home SKSE NG (Residents mode of the Domains tab).

 Every function here is Global and the script has no properties, so it needs NO plugin
 to host it: the DLL calls it with DispatchStaticCall and the VM loads the .pex from
 Data\Scripts on demand. Ships beside HD_WardrobeExec.pex / HD_NPCControl.pex in the
 SkyManager Source mod.

 WHY IT EXISTS. MHiYHController's own MarkHome / MoveHome / SetAreaMarker each create
 their marker with CreateMarkerAtPlayer() - the PLAYER'S FEET are the only place the mod's
 dialogue can ever mean. The deck already drives those (src/mhiyh_control.cpp). This
 script is the same transactions with ONE difference: the marker is handed IN, already
 placed wherever the deck chose (a Domains mark, or the feet). Nothing about the
 transaction changes - register, SetMarkerLink, force the alias, enable the schedule,
 faction, refresh, roll back on failure - it is copied step for step from
 MHiYHController.psc (My Home is Your Home SKSE NG, Scripts\Source), so a resident set up
 from the deck is indistinguishable to the mod from one set up by talking to her.

 One deliberate omission: MarkHome's `IsPlayerTeammate()` gate. That is the DIALOGUE's
 rule (the topic only exists on a follower); nothing in the native side needs it, and
 the deck's borrow-recruit dance existed only to satisfy it.

 Deletion of the old marker on success and of the NEW marker on failure is done here,
 exactly as the controller does it, so C++ never has to guess which one survived.}

; ------------------------------------------------------------------ reads --

; Every registered resident, as "formid|slot;" rows (formid decimal, as Papyrus sees
; it). C++ resolves the actor and reads everything else off the engine. Bounded so a
; corrupt registry cannot spin the VM forever.
String Function Roster() Global
    String out = ""
    Int guard = 0
    Int slot = MMTYHNative.GetNextRegisteredSlot(-1, "")
    While slot >= 0 && guard < 1100
        Actor a = MMTYHNative.GetActorBySlot(slot)
        If a != None
            out += (a.GetFormID() as String) + "|" + (slot as String) + ";"
        EndIf
        Int next = MMTYHNative.GetNextRegisteredSlot(slot, "")
        If next <= slot
            slot = -1
        Else
            slot = next
        EndIf
        guard += 1
    EndWhile
    Return out
EndFunction

; Her day as MHiYH's own database holds it: "kind,start,end,enabled,radius;" for kinds
; 0..7 (7 = passive Watch, which shares Guard's marker and window).
String Function Day(Actor akActor) Global
    If akActor == None
        Return ""
    EndIf
    String out = ""
    Int k = 0
    While k < 8
        out += (k as String) + "," + (MMTYHNative.GetScheduleStart(akActor, k) as String) + "," \
            + (MMTYHNative.GetScheduleEnd(akActor, k) as String) + "," \
            + (MMTYHNative.IsScheduleEnabled(akActor, k) as String) + "," \
            + (MMTYHNative.GetScheduleRadius(akActor, k) as String) + ";"
        k += 1
    EndWhile
    Return out
EndFunction

; ----------------------------------------------------------------- writes --

; Give her a home AT akMarker (a force-persistent XMarker the deck placed). MarkHome when
; she has none, MoveHome when she has - the same fork MHiYH's two dialogue topics make.
Bool Function SetHomeAt(Actor akActor, ObjectReference akMarker) Global
    If akActor == None || akMarker == None
        Return False
    EndIf
    Keyword homeKeyword = MHiYHController.GetMarkerKeyword(0)
    If homeKeyword == None
        akMarker.Delete()
        Return False
    EndIf

    Bool wasRegistered = MMTYHNative.IsRegistered(akActor)

    If wasRegistered && MMTYHNative.HasMarker(akActor, 0)
        ; --- MoveHome. Deliberately does NOT re-force the home alias: the native
        ; scheduler owns the one-active-package invariant (the mod's own comment).
        ObjectReference oldHome = MMTYHNative.GetMarker(akActor, 0)
        If !MMTYHNative.SetMarkerLink(akActor, 0, akMarker, homeKeyword)
            akMarker.Delete()
            Return False
        EndIf
        If oldHome != None && oldHome != akMarker
            oldHome.Delete()
        EndIf
        MHiYHController.RequestScheduleRefresh(False)
        akActor.EvaluatePackage()
        Return True
    EndIf

    ; --- MarkHome, minus the dialogue's follower gate.
    Int slot = MMTYHNative.RegisterActor(akActor, MHiYHController.GetResidentFullName(akActor))
    If slot < 0
        akMarker.Delete()
        Return False
    EndIf

    ObjectReference oldHomeMarker = MMTYHNative.GetMarker(akActor, 0)
    If !MMTYHNative.SetMarkerLink(akActor, 0, akMarker, homeKeyword)
        akMarker.Delete()
        If !wasRegistered
            MMTYHNative.UnregisterActor(akActor)
        EndIf
        Return False
    EndIf

    If !MHiYHController.EnsureKindAlias(akActor, slot, 0)
        MHiYHController.RestoreMarkerLink(akActor, 0, oldHomeMarker, homeKeyword)
        akMarker.Delete()
        If !wasRegistered
            MHiYHController.ClearKindAlias(slot, 0)
            MMTYHNative.UnregisterActor(akActor)
        EndIf
        Return False
    EndIf

    If oldHomeMarker != None && oldHomeMarker != akMarker
        oldHomeMarker.Delete()
    EndIf

    If !wasRegistered
        MHiYHController.ApplyDefaultSchedules(akActor)
    EndIf

    Faction hasHome = MHiYHController.GetHasHomeFaction()
    If hasHome != None && !akActor.IsInFaction(hasHome)
        akActor.AddToFaction(hasHome)
    EndIf

    MHiYHController.RequestScheduleRefresh(False)
    akActor.EvaluatePackage()
    Return True
EndFunction

; One of her six other stops (1 sleep, 2 work, 3 guard, 4/5/6 breakfast/lunch/dinner)
; AT akMarker. Mirrors SetAreaMarker: refused until she has a home, transactional
; replacement of the old marker, guard lands as passive Watch (the dialogue's rule).
Bool Function SetAreaAt(Actor akActor, Int aiKind, ObjectReference akMarker) Global
    If akActor == None || akMarker == None
        Return False
    EndIf
    If aiKind < 1 || aiKind > 6
        akMarker.Delete()
        Return False
    EndIf
    If !MMTYHNative.HasMarker(akActor, 0)
        akMarker.Delete()
        Return False
    EndIf
    Int slot = MMTYHNative.GetSlot(akActor)
    If slot < 0
        akMarker.Delete()
        Return False
    EndIf
    Keyword markerKeyword = MHiYHController.GetMarkerKeyword(aiKind)
    If markerKeyword == None
        akMarker.Delete()
        Return False
    EndIf

    ObjectReference oldMarker = MMTYHNative.GetMarker(akActor, aiKind)
    If !MMTYHNative.SetMarkerLink(akActor, aiKind, akMarker, markerKeyword)
        akMarker.Delete()
        Return False
    EndIf

    Bool scheduleEnabled = False
    If aiKind == 3
        scheduleEnabled = MMTYHNative.SetGuardMode(akActor, 1)
    Else
        scheduleEnabled = MMTYHNative.SetScheduleEnabled(akActor, aiKind, True)
    EndIf
    If !scheduleEnabled
        MHiYHController.RestoreMarkerLink(akActor, aiKind, oldMarker, markerKeyword)
        akMarker.Delete()
        Return False
    EndIf

    If oldMarker != None && oldMarker != akMarker
        oldMarker.Delete()
    EndIf

    MHiYHController.RequestScheduleRefresh(False)
    akActor.EvaluatePackage()
    Return True
EndFunction

; The hours and radius of one activity, straight into MHiYH's schedule row - the same
; native the mod's MCM writes through. Enabled is passed through untouched for the
; ordinary kinds; for Guard (3/7) use SetGuard below, which keeps the two modes exclusive.
Bool Function SetHours(Actor akActor, Int aiKind, Int aiStart, Int aiEnd, Bool abEnabled, Float afRadius) Global
    If akActor == None || aiKind < 0 || aiKind > 7
        Return False
    EndIf
    If !MMTYHNative.SetSchedule(akActor, aiKind, aiStart, aiEnd, abEnabled, afRadius)
        Return False
    EndIf
    If aiKind == 3 || aiKind == 7
        ; One post, one window: keep the twin row's hours in step, its own enabled
        ; flag untouched (that flag IS the guard mode).
        Int twin = 7
        If aiKind == 7
            twin = 3
        EndIf
        MMTYHNative.SetSchedule(akActor, twin, aiStart, aiEnd, MMTYHNative.IsScheduleEnabled(akActor, twin), afRadius)
    EndIf
    MHiYHController.RequestScheduleRefresh(False)
    akActor.EvaluatePackage()
    Return True
EndFunction

; Guard mode, explicitly: 0 off, 1 passive Watch (kind 7 on), 2 active Guard (kind 3
; on). Written as the two per-kind enabled flags the MCM itself reads back
; (IsScheduleEnabled 7 / 3), never both on - the mod calls them mutually exclusive.
Bool Function SetGuard(Actor akActor, Int aiMode) Global
    If akActor == None || aiMode < 0 || aiMode > 2
        Return False
    EndIf
    If !MMTYHNative.HasMarker(akActor, 3)
        Return False
    EndIf
    Bool okA = MMTYHNative.SetScheduleEnabled(akActor, 3, aiMode == 2)
    Bool okP = MMTYHNative.SetScheduleEnabled(akActor, 7, aiMode == 1)
    MHiYHController.RequestScheduleRefresh(False)
    akActor.EvaluatePackage()
    Return okA && okP
EndFunction

; Put her at her home marker right now. The mod's own SendHome; it refuses a current
; follower (she would just walk back to you).
Bool Function SendHome(Actor akActor) Global
    Return MHiYHController.SendHome(akActor)
EndFunction

; Make the scheduler re-evaluate everybody now.
Bool Function Refresh() Global
    MHiYHController.RequestScheduleRefresh(True)
    Return True
EndFunction
