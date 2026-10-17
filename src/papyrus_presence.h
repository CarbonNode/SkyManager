#pragma once

// Papyrus presence probes: ask BEFORE DispatchStaticCall, never after.
//
// 2026-10-17, a Nexus report (Skyrim 1.6.1170, SKSE 2.2.8, SkyManager 2.2,
// CHIM not installed): opening the wheel warmed the Omni's CHIM provider,
// which asked chim_control for the agent set, which called DispatchStaticCall
// on AIAgentFunctions, a class that game could not load. On 1.6.1170 that
// call does not come back false: the VM dereferences null inside
// DispatchStaticCall (SkyrimSE.exe+1447D3E, `mov rax,[rcx]` with rcx = 0) and
// the game dies. The "dispatch failed (CHIM not loaded?)" branch under every
// such call had never run on any runtime, because this rig has every mod the
// deck talks to.
//
// So the rule: the VM is only asked about a class whose .pex the game can
// actually open. Gate every DispatchStaticCall into ANOTHER mod's class on
// ScriptAvailable(); vanilla classes ("Game", "Utility") need no gate.
namespace PapyrusPresence
{
	// True when Data\Scripts\<cls>.pex is reachable through the game's own
	// resource system (loose or inside a BSA, under MO2's VFS). The answer is
	// cached per class after the first probe: a mod cannot appear mid-session.
	// Main thread.
	bool ScriptAvailable(const char* cls);
}
