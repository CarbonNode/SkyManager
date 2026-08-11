#pragma once

#include <cstdint>
#include <string>
#include <vector>

// Loot Highlighter — the deck's "Loot" tab backend (Rober, 2026-08-04).
//
// Inspired by "Clairvoyance Shines Treasures" (Nexus 187267), which is static
// Light Placer / SkyPatcher configs: chests and skill books glow while the
// Clairvoyance spell runs. Static configs cannot know LOOT STATE — a corpse
// stays lit after you strip it, a chest after you empty it, and nothing can
// filter by value or by what the museum still wants. This module is the
// dynamic version:
//
//   A throttled scanner walks loaded references around the player, classifies
//   each into a category (LOTD collectable / chest / unlooted corpse / coins &
//   picks / potion / soul gem / skill book / valuable gear) and applies a REAL
//   engine effect shader (TESEffectShader — the Detect Life mechanism) in the
//   category's colour. Open a corpse or chest and its glow dies: a
//   MenuOpenCloseEvent sink records every ContainerMenu target for the session.
//
// The load-bearing choices:
//
//   - Shaders are applied with duration -1 and killed EXPLICITLY (find our
//     ShaderReferenceEffect in ProcessLists, set finished). Finite durations
//     would need re-application, and re-applying stacks a second effect and
//     restarts the fade-in every cycle — a permanent flicker.
//   - ReferenceEffects PERSIST IN THE SAVE (they have SaveGame/LoadGame), so a
//     glow alive at save time comes back on load with our tracking map empty.
//     OnPostLoadGame() therefore sweeps every effect using one of OUR palette
//     shaders before the scanner repopulates. The palette is vanilla Skyrim.esm
//     records, so in principle that sweep could kill a legit game-applied
//     instance of the same shader — the magic effect that owns it re-applies,
//     so the cost is a blink.
//   - Palette shaders are REAL editor ids verified against Skyrim.esm's bytes
//     (tools/dump_records.py — the rooms ring taught us never to invent one),
//     resolved at runtime via po3 Tweaks' editor-id cache, each colour with
//     fallback candidates. A colour that resolves nothing is reported in the
//     pane, not silently skipped.
//   - LOTD membership is TCC's own runtime model (DBM_RelicNotifications.esp):
//     dbmNew holds every displayable item the player does NOT yet have; TCC's
//     inventory monitors move items to dbmFound on pickup and dbmDisp when
//     displayed. Its notification gate is exactly `new && !found && !disp`,
//     and we use the same test. The lists are runtime-populated FormLists, so
//     membership is read into hash sets and refreshed when the list sizes
//     change. No TCC on the load order = an honest "not found" in the pane.
//   - Container inventories are NEVER read. Counting an unopened container's
//     items initialises InventoryChanges, which resolves levelled loot early —
//     a gameplay side effect. "Unlooted" therefore means "not opened this
//     session", for corpses and chests both; that matches the ask ("highlight
//     disappears when looted") without touching loot rolls. The opened set is
//     session-scoped — after a reload things glow again until re-opened.
//
// Ownership split (mirrors RoomGuard): the VIEW owns every setting in Config
// and sends the whole slice via ltSave; C++ owns the live glow map, the opened
// set and the shader/list caches — none of which persist in hotkeys.json.
namespace LootHighlight
{
	// One highlightable category. Fixed set (kCategoryKeys) — the view renders
	// whatever OpenJson sends, so adding a category is a C++-side edit only.
	struct Category
	{
		std::string key;
		bool        on = true;
		std::string color;  // palette id ("gold", "xray-blue", ...)
	};

	struct Config
	{
		// Master switch. Defaults OFF: a 4,780-mod playthrough suddenly glowing
		// on first launch is a jump-scare, not a feature — the Loot tab and the
		// seeded "Loot Vision" action are each one press.
		bool enabled = false;

		bool notify = true;  // corner message when the master toggles

		// Dedicated "glow safe storage on its own" switch, sitting under the Loot
		// Vision master in the pane. When on, non-respawning containers glow even
		// if the master (enabled) is off and even if the "safe" category row is
		// unticked — a one-press "where can I stash loot?" without lighting up
		// everything else. Additive: with the master on, it just forces safe.
		bool safeVision = false;

		std::uint32_t tickMs = 1200;     // scan cadence
		float         radius = 2200.0f;  // scan reach, game units (1u ~ 1.43cm)
		int           maxGlows = 40;     // nearest-first cap — a hoarder's cellar must not tank the frame rate

		// Containers stop glowing once opened this session. Off = chests glow
		// until the master goes off (some players want the landmark, not the
		// todo-list).
		bool hideOpened = true;

		// Append " (Safe)" to the NAME of non-respawning containers, so a chest
		// reads as safe storage even without the glow. Matches the boot-only
		// mod Highlight Safe Containers' bUpdateName, but live and toggleable.
		// Independent of the master switch and of the "safe" glow category.
		// Default off — a playthrough should not silently rename chests on the
		// first launch.
		bool labelSafe = false;

		// Valuable-gear thresholds: value/weight >= ratio AND value >= minValue.
		// Weightless items pass on value alone.
		float gearRatio = 10.0f;
		int   gearMinValue = 250;

		// "Valuables & gems" catch-all bar: any pocketable loose item (gems and
		// other misc, ingredients, scrolls, non-skill books, even pricey food)
		// worth at least this glows. Weapons/armour/ammo stay the gear
		// category's business — its ratio would be meaningless otherwise.
		int valuableMinValue = 100;

		std::vector<Category> cats;  // fixed keys, seeded by FromJson

		// TCC's runtime tracking lists, resolvable by editor id. In the config
		// so a TCC update that renames them is an edit, not a rebuild.
		std::string lotdNew = "dbmNew";
		std::string lotdFound = "dbmFound";
		std::string lotdDisp = "dbmDisp";
	};

	void Init();  // menu sink registration + palette resolve probe (kDataLoaded)

	// Persisted slice under "loot" in hotkeys.json.
	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& out);
	bool           MergeViewSlice(const std::string& viewJson, Config& cfg);

	// ltOpen payload: the slice + palette (id/label/css/resolved) + LOTD list
	// status + live glow count. ltStateResult payload: live counts only.
	std::string OpenJson(const Config& c);
	std::string StateJson(const Config& c);

	// Master toggle (pane button AND the seeded "loot-vision" action entry).
	// Sweeps every glow when turning off. Returns {ok,msg,enabled} for ltResult.
	std::string ToggleMaster(Config& cfg);

	// Native action entry (seeded in Misc as "Loot Vision").
	bool IsAction(const std::string& a);

	// The scanner. MAIN THREAD ONLY; caller holds the config lock. Early-outs
	// on cadence, pause, and master-off (sweeping leftovers exactly once).
	void Tick(const Config& cfg);

	// kPostLoadGame: clear session state and sweep persisted glows (see above).
	void OnPostLoadGame();
}
