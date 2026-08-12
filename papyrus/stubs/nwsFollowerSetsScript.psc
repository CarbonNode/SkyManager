ScriptName nwsFollowerSetsScript Extends Quest
{Signature stub - compile only. At runtime GetFormFromFile resolves NFF's real
 quest and its real script; this file is never shipped and never runs.
 Declares ONLY the members HD_WardrobeExec touches.

 Signatures copied verbatim from NFF's OWN decompiled nwsFollowerSetsScript.psc
 (decompiled with Champollion). A stub that disagrees with the real script
 compiles happily and then fails at runtime with "cannot find function", so the
 rule is: decompile, copy, do not paraphrase.}

Function DialogueCmd(Actor myActor, Int myCmd, Int myOpt)
EndFunction

Function switchOutfit(Actor myActor, Int myType)
EndFunction

Function CloneOutfit(Actor myActor)
EndFunction

Function ManualSwitch()
EndFunction

Function CheckOutfits()
EndFunction

Int Property viewMode = 0 Auto hidden
