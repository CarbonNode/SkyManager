ScriptName HD_NPCControl Extends Quest
{Alias driver for the deck's freeze/sit/bed. Dumb on purpose - C++ owns slots.}

; The deck's C++ (npc_actions.cpp) dispatches these three via the VM. The real
; behaviour lives in the ESP's alias packages (HoldPosition / SitTarget /
; Sleep, priority 90); this script only moves references in and out of the
; aliases, which is the one operation SKSE has no native for.
;
; Alias id map (the contract with make_deck_esp.py and npc_actions.cpp):
;   10..17 Hold slots (package anchored on the same alias)
;   20..23 Sit NPC    / 30..33 the chair
;   40..43 Sleep NPC  / 50..53 the bed
;
; Keep functions tiny and total: a bad id or None ref is a no-op, never an
; error, because the VM call from C++ is fire-and-forget.

Function HDForce(Int aliasId, ObjectReference ref)
  ReferenceAlias a = Self.GetAlias(aliasId) as ReferenceAlias
  If a && ref
    a.ForceRefTo(ref)
  EndIf
EndFunction

Function HDClear(Int aliasId)
  ReferenceAlias a = Self.GetAlias(aliasId) as ReferenceAlias
  If a
    a.Clear()
  EndIf
EndFunction

Function HDEval(Actor npc)
  If npc
    npc.EvaluatePackage()
  EndIf
EndFunction

; One call instead of three across the wire: force npc (and target when the
; verb has one), then re-evaluate so the new package wins NOW, not on the next
; AI heartbeat. targetAliasId < 0 means "no target alias" (freeze).
Function HDApply(Actor npc, Int npcAliasId, ObjectReference target, Int targetAliasId)
  If !npc
    Return
  EndIf
  If targetAliasId >= 0 && target
    HDForce(targetAliasId, target)
  EndIf
  HDForce(npcAliasId, npc)
  npc.EvaluatePackage()
EndFunction

; Release one pair (or a lone hold slot when targetAliasId < 0).
Function HDDrop(Actor npc, Int npcAliasId, Int targetAliasId)
  HDClear(npcAliasId)
  If targetAliasId >= 0
    HDClear(targetAliasId)
  EndIf
  If npc
    npc.EvaluatePackage()
  EndIf
EndFunction
