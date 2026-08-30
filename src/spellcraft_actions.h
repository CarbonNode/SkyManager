#pragma once

// Spell Crafting tab - the deck front-end for Fourth Era Spell-Crafting (FESC,
// EM03SpellCrafting.esp), the Oblivion-style spellmaker. The deck drives the
// MOD'S OWN machinery rather than reimplementing it:
//
//  - Non-override crafts dispatch FESC's own `EM03QuestScript.CraftTheSpell`
//    verbatim (overriding=false), so gold charge, base-spell pick, DPF form
//    creation, effect add, casting perk and AddSpell are all its code.
//  - Override crafts (a custom lead effect stamped with a chosen base spell's
//    delivery/casting) can NOT go through their script: its overriding=true
//    branch calls the FESC DLL native SetEffectStuff, which dereferences a
//    menu global (OverideBase) that is null unless their own ImGui menu set
//    it - a guaranteed CTD from outside that menu. So this module mirrors the
//    override branch in C++: the DynamicPersistentForms Papyrus STATICS
//    (Create / CopyAppearance / ClearMagicEffects / AddMagicEffect /
//    SetSpellCastingPerk - served by DPF RE's DPF.dll on this rig) are
//    chained with result callbacks so ordering is guaranteed (each dispatch
//    is its own VM stack; the next call is issued from the previous call's
//    IStackCallbackFunctor), and the two things their native did are done
//    engine-side (EffectSetting data.delivery/castingType + TESFullName).
//    AddSpell is the LAST link, so an aborted chain never teaches a
//    half-built spell; charged gold is refunded on abort.
//  - EraseSpell is engine-side (unequip + RemoveSpell + honest HasSpell
//    verify) because FESC's own EraseSpell calls DynamicPersistentForms.
//    Dispose, which DPF RE does not register (proven by strings dump).
//
// THREADING CONTRACT: every entry point below is called from SKSE tasks only
// (main thread) - they touch the VM, form arrays and the player. The one
// worker thread this module spawns (Open's JSON serialisation) touches ONLY
// its own copied plain data, catch-all wrapped (the anim-scan lesson: an
// exception on a detached thread is a CTD).
//
// Bridge (registered in main.cpp - see spellcraft-wiring.md):
//   requests scState/scOpen/scCraft/scErase/scLearn/scSettings/scTome/scIcon
//   replies  scStateResult/scOpenData/scCraftResult/scEraseResult/
//            scLearnResult/scSettingsResult/scTomeResult/scIconResult
// - names disjoint per the deck law (one name per direction). scDeck ->
// scDeckResult lives fully in main.cpp (it edits g_magicConfig).

#include <functional>
#include <string>

namespace SpellCraft
{
	// scState -> scStateResult: {present, reason, dpfPex, learnMode, hasTome,
	// gold, settings:{effectCost,tomeCost,mustKnowPerk,magExp,dMult,aMult,
	// sliderMax}}. present=false plus a human reason when FESC is absent or
	// its quest/script cannot be bound. Cheap - safe on every pane open.
	[[nodiscard]] std::string StateJson();

	// scOpen -> scOpenData: the heavy snapshot - every SpellType::kSpell the
	// player knows (dataHandler SpellItem array filtered by HasSpell, the
	// mod's own menu source), per-effect rows with the recovered base cost D,
	// the LearnedEffects alchemy rows, the crafted (DPF.esp addedSpells)
	// list, the icon sidecar map, learn-mode/tome/gold/settings.
	//
	// CHOICE (noted per the contract): the engine pass - HasSpell filter AND
	// field extraction, including per-effect conditions.IsTrue(player,player)
	// for the perk gate - runs in ONE main-thread task (the caller's), into
	// plain intermediate structs; the detached worker only serialises those
	// structs to JSON (the actual heavy part at thousands of rows) and never
	// touches a form. Splitting extraction off-thread would have the worker
	// dereferencing engine memory, which is the exact thing the contract
	// forbids. `deliver` is invoked ON THE MAIN THREAD with the payload.
	void Open(std::function<void(std::string)> deliver);

	// scCraft -> scCraftResult {ok,msg,closing}. Validates SYNCHRONOUSLY and
	// refuses in-pane (empty effects; override without a base or with school
	// > 4; a costliest effect whose school is none / whose model leads with a
	// constant-effect; gold short when EffectCost > 0 - checked HERE so FESC's
	// own MessageBox refusal can never fire after the palette closed). On
	// pass the craft is ARMED (closingOut=true): the caller pushes the reply,
	// closes the palette, and calls RunPending() ~200ms later so the dispatch
	// lands on the unpaused world (Papyrus runs unpaused only - the party-
	// orders law). Completion/failure lands as a HUD DebugNotification.
	[[nodiscard]] std::string Craft(const std::string& req, bool& closingOut);

	// scSettings -> scSettingsResult {ok,msg,closing}: arms an ApplySettings
	// dispatch (their 9-arg method; FullScreen/ShowOgCost pass through
	// unchanged from the last read). Same ClosePalette-then-RunPending flow.
	[[nodiscard]] std::string Settings(const std::string& req, bool& closingOut);

	// scTome -> scTomeResult {ok,msg,closing}: arms an AddSCTome dispatch
	// (0 args). Same ClosePalette-then-RunPending flow.
	[[nodiscard]] std::string Tome(bool& closingOut);

	// Runs whatever Craft/Settings/Tome armed. Main thread (task queue),
	// after the palette closed and the world unpaused. No-op when nothing is
	// armed (a second close beat must not re-fire a craft).
	void RunPending();

	// scErase {plugin,localId} -> scEraseResult {ok,msg}. Engine-side, runs
	// with the palette OPEN (no Papyrus needed for the removal itself):
	// unequip from either hand, RemoveSpell, verify via HasSpell (racial /
	// starting spells cannot be removed - answered honestly), then a
	// best-effort DynamicPersistentForms.Dispose dispatch, failure ignored.
	[[nodiscard]] std::string Erase(const std::string& req);

	// scLearn {on} -> scLearnResult {ok,on,msg}. Engine-side AddSpell /
	// RemoveSpell of FESC's LearnEffectsSpell toggle ability on the player -
	// works paused, palette stays open. `on` in the reply is the live truth
	// (player->HasSpell) after the change.
	[[nodiscard]] std::string Learn(const std::string& req);

	// scIcon {plugin, localId, icon} -> scIconResult {ok}. Persists a per-
	// crafted-spell icon path in the module's own sidecar
	// (Data/SKSE/Plugins/HotkeyDeck/spellcraft.json, atomic .tmp+rename,
	// item-explorer precedent - NOT a hotkeys.json slice). The path is held
	// to the same rule as every deck icon (view-relative, under icons/, no
	// escapes); "" clears the entry.
	[[nodiscard]] std::string Icon(const std::string& req);
}
