#pragma once

#include <string>

/*
 * CombatTools — the two party menus that ride the Combat Wheel and the deck's
 * own action list (Rober, 2026-10-11: "make it so we can favorite this in
 * skymanager without having to use the hotkey (so it can be unbound and free
 * the hotkey)", for Fight With Me, Nexus 194766; "could also add the walk with
 * me main menu button in the stance wheel as well").
 *
 *   Battle Plan   Fight With Me's own window (roles, focus, positions, party
 *                 orders; slow time in a fight, the party screen outside one).
 *                 Opened through the plain C export FightWithMe.dll publishes
 *                 for exactly this, FightWithMe_OpenBattlePlan() — the same
 *                 call Walk With Me 0.3's own "Battle plan" tile makes. No key
 *                 is pressed, so FightWithMe.ini [BattlePlan] iKey can be 0.
 *
 *   Walk With Me  Walk With Me's main page ("Walk With Me/Party" in SKSE Menu
 *                 Framework), drawn in SkyManager's own SMF window by
 *                 SmfIndex::Open — the mod's REAL page, no hotkey.
 *
 *   NFF menu      Nether's Follower Framework's main command menu (its "Command"
 *                 key, nwsKeyCmd; Rober: "Maybe we add NFF's main hotkey as
 *                 well?"). NFF's key handler is nwsFollowerMCMScript.OnKeyDown
 *                 (decompiled from 0.13: its FIRST branch, keyCode ==
 *                 controlScript.nwsKeyCmd, sets controlScriptEx.nwsMenuCmd = 0
 *                 and casts nwsCommandAllSpell on the player). We dispatch that
 *                 same OnKeyDown with NFF's own nwsKeyCmd value, so NFF's exact
 *                 code — menu-mode guard included — runs, and the key can be
 *                 cleared in NFF's MCM. Papyrus runs unpaused only: the caller
 *                 must have closed the palette / wheel and let the pause lift.
 *
 *   Sic 'em       The deck's own attack-target verb (NpcActions), fired by
 *                 main.cpp — listed here so the wheel and its settings see one
 *                 table. Always available.
 *
 * The deck implements none of these mods' mechanics. Nothing is persisted.
 */
namespace CombatTools
{
	// Wedge / action ids. Stable: the view and the seeded actions use them.
	inline constexpr const char* kBattlePlan = "battle-plan";
	inline constexpr const char* kWwmMenu = "wwm-menu";
	inline constexpr const char* kNffMenu = "nff-menu";
	inline constexpr const char* kSicEm = "sic-em";   // dispatched by main.cpp (NpcActions)
	// The Command Ring (2026-10-12, Rober: "add it as a button for the stance
	// wheel"): a wedge that closes the wheel and opens the ring. Dispatched by
	// main.cpp (CrToggleRing); always available, the ring needs no mod to open.
	inline constexpr const char* kCommandRing = "command-ring";
	// The Walk With Me wedge's flyout (2026-10-12): the mod's own party menu,
	// opened on its order wheel or stepped on to Party actions. Not wedges and
	// not handled by Open(): main.cpp presses Walk With Me's own Command key
	// (FireWwmCommand). The flyout's third choice is kWwmMenu.
	inline constexpr const char* kWwmWheel = "wwm-wheel";
	inline constexpr const char* kWwmParty = "wwm-party";

	// The SMF page the Walk With Me entry opens.
	inline constexpr const char* kWwmPage = "Walk With Me/Party";

	// True when FightWithMe.dll is loaded and publishes its open export.
	// Cheap (no tree walk); any thread.
	bool BattlePlanAvailable(std::string& why);

	// True when Walk With Me's main page is in SMF's menu tree. MAIN THREAD.
	bool WwmMenuAvailable(std::string& why);

	// True when NFF's MCM script object is bound (nwsFollowerFramework.esp).
	// MAIN THREAD.
	bool NffMenuAvailable(std::string& why);

	// MAIN THREAD. [{id,name,desc,ok,why}] for all four, in wheel order.
	std::string ListJson();

	// MAIN THREAD. Opens battle-plan / wwm-menu / nff-menu; the deck palette
	// and the Combat Wheel must already be closed (Fight With Me slows time
	// itself, SMF pauses, NFF's Papyrus needs a running world). sic-em is NOT
	// handled here (main.cpp owns NpcActions). Refusals notify on screen.
	// Returns a log line.
	std::string Open(const std::string& id);
}
