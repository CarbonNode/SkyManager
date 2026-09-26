#include "nightside.h"

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp and logger.

#include "actor_identity.h"
#include "spell_actions.h"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace Nightside
{
	namespace
	{
		using json = nlohmann::json;

		/* ═══════════════════════════════════════════════════════════════════
		 *  THE VERIFIED TABLE
		 *
		 *  Every id here was read out of the plugin's own bytes on the rig
		 *  (tools/dump_records.py, 2026-09-14). Local ids — the durable half
		 *  of the deck's identity scheme — so a load-order shuffle cannot
		 *  move them. Do not "tidy" one from memory; re-dump instead.
		 * ═══════════════════════════════════════════════════════════════ */

		constexpr const char* kSkyrim    = "Skyrim.esm";
		constexpr const char* kDawnguard = "Dawnguard.esm";
		constexpr const char* kUndeath   = "Undeath.esp";
		constexpr const char* kSacro     = "Sacrosanct - Vampires of Skyrim.esp";
		constexpr const char* kGrowl     = "Growl - Werebeasts of Skyrim.esp";

		/* ── GROWL, the lycanthropy overhaul (dumped 2026-09-14) ─────────────
		 * Same story as Sacrosanct: it OVERRIDES vanilla's Beast Form
		 * (Skyrim.esm 0x092C48 — the very spell the Moon lane already casts),
		 * so the transform button hooks it for free, and it publishes its state
		 * as `HRI_*` globals.
		 *
		 * This is what finally answers the Moon lane's old honest shrug ("the
		 * deck cannot read the daily change counter"): Growl replaces vanilla's
		 * once-a-day rule with a real COOLDOWN, and both halves are readable —
		 * the configured length as a global, and the time remaining as the
		 * duration left on its own cooldown effect. */
		constexpr std::uint32_t kGrwDuration   = 0x000805;   // beast form length
		constexpr std::uint32_t kGrwDurationEx = 0x000806;   // per-feed extension
		constexpr std::uint32_t kGrwCooldown   = 0x000861;   // configured cooldown
		constexpr std::uint32_t kGrwCdSpell    = 0x0008F2;   // the live cooldown effect
		constexpr std::uint32_t kGrwCdSmall    = 0x0008FE;
		constexpr std::uint32_t kGrwCallChance = 0x000852;   // Call of the Blood
		constexpr std::uint32_t kGrwCallNow    = 0x0008EC;
		constexpr std::uint32_t kGrwCallWent   = 0x000884;
		constexpr std::uint32_t kGrwNightStart = 0x000829;
		constexpr std::uint32_t kGrwNightEnd   = 0x00082A;
		constexpr std::uint32_t kGrwWerebear   = 0x00083C;   // werebear totem
		constexpr std::uint32_t kGrwTotemCap   = 0x000887;
		constexpr std::uint32_t kGrwWpnXpBase  = 0x000841;
		constexpr std::uint32_t kGrwWpnXpMult  = 0x0008F9;
		constexpr std::uint32_t kGrwArmXpBase  = 0x000843;
		constexpr std::uint32_t kGrwArmXpMult  = 0x0008F8;

		/* ⚠ Growl reshapes the RACES, and the lane's shape test has to know:
		 *  · it overrides DLC2WerebearBeastRace, so a transformed WEREBEAR was
		 *    being reported as "Mortal shape" — the awake test only knew the
		 *    vanilla werewolf race;
		 *  · it adds ten "<Race> Lycanthrope" variants (0x0008D6..0x0008DF,
		 *    contiguous) which are the MORTAL form of an infected character —
		 *    the lycanthrope equivalent of NordRaceVampire. Those mean HELD,
		 *    not awake, and are what makes the race line read honestly. */
		constexpr const char* kDragonborn = "Dragonborn.esm";
		constexpr std::uint32_t kWerebearRace  = 0x01E17B;   // Dragonborn.esm
		constexpr std::uint32_t kGrwAltRaceLo  = 0x0008D6;
		constexpr std::uint32_t kGrwAltRaceHi  = 0x0008DF;

		/* Growl's perk TREE is not only its own records: it rewrites thirteen
		   vanilla/Dawnguard werewolf perks in place (Bestial Strength 1-4,
		   Animal Vigor, Gorging, Savage Feeding, the three Totems, Feed…).
		   Enumerating by plugin misses every one of them, because an overridden
		   record still reports its ORIGINATING file — so the tree was
		   undercounted by 13. */
		struct PerkRef { const char* plugin; std::uint32_t local; };
		/* Same trap on the vampire side, audited 2026-09-14: Sacrosanct has 53
		   own perk records but rewrites 18 more in place, of which ELEVEN are
		   genuinely its Vampire Lord tree (the rest are compatibility edits —
		   coffin sleep, seduction boost, the activation blocker — deliberately
		   left out, because they are not tree nodes you spend a point on).
		   Real tree = 53 + 11 = 64. Undeath, audited the same way, overrides
		   NOTHING, so its eight are already the whole tree. */
		const PerkRef kSacTreePerks[] = {
			{ kDawnguard, 0x005994 },   // Fountain of Youth
			{ kDawnguard, 0x005995 },   // Unearthly Will
			{ kDawnguard, 0x005996 },   // Astral Poison
			{ kDawnguard, 0x005997 },   // Night Cloak
			{ kDawnguard, 0x005998 },   // Power is Power
			{ kDawnguard, 0x00599A },   // Chokehold
			{ kDawnguard, 0x00599B },   // Echolocation
			{ kDawnguard, 0x00599C },   // Mist Form
			{ kDawnguard, 0x00599E },   // The Reaping
			{ kDawnguard, 0x008A70 },   // Gutwrench
			{ kDawnguard, 0x016908 },   // Conjure Gargoyle
		};

		const PerkRef kGrwTreePerks[] = {
			{ kSkyrim,    0x02BA1D },   // Feed
			{ kDawnguard, 0x0059A4 },   // Bestial Strength 1
			{ kDawnguard, 0x0059A5 },   // Animal Vigor
			{ kDawnguard, 0x0059A6 },   // Savage Feeding
			{ kDawnguard, 0x0059A7 },   // Gorging
			{ kDawnguard, 0x0059A8 },   // Totem of Terror
			{ kDawnguard, 0x0059A9 },   // Totem of the Hunt
			{ kDawnguard, 0x0059AA },   // Totem of Ice Brothers
			{ kDawnguard, 0x0059AB },   // Totem of Ice Brothers 2
			{ kDawnguard, 0x007A3F },   // Bestial Strength 2
			{ kDawnguard, 0x008A6E },   // Savage Feeding (feed perk)
			{ kDawnguard, 0x011CFA },   // Bestial Strength 3
			{ kDawnguard, 0x011CFB },   // Bestial Strength 4
		};


		/* ── SACROSANCT, read rather than inferred ───────────────────────────
		 * Sacrosanct publishes its whole vampire state as GLOBALS, so when it
		 * is loaded the Blood lane stops guessing: the stage is its own stage,
		 * the meter is its own meter. Every id dumped from the plugin on
		 * 2026-09-14. Only used when kSacro is loaded; otherwise the lane falls
		 * back to the vanilla stage-ability read.
		 *
		 * ⚠ Sacrosanct REPURPOSES vanilla's AbVampire01..04 into
		 * Ab_ResistFrost_Stage1..4 — still one per stage, so the fallback still
		 * yields the right NUMBER, but Progression_Stage below is the real
		 * answer and is preferred whenever it is available. */
		constexpr std::uint32_t kSacProgStage   = 0x0D80D0;   // current stage
		constexpr std::uint32_t kSacProgXP      = 0x0D80CF;   // xp toward next
		constexpr std::uint32_t kSacProgToNext  = 0x0D80D1;   // xp needed
		constexpr std::uint32_t kSacWassailCur  = 0x136314;   // the "blood meter"
		constexpr std::uint32_t kSacWassailCap  = 0x136315;   // default 100
		constexpr std::uint32_t kSacHemoStage   = 0x059BA1;   // blood magic
		constexpr std::uint32_t kSacHemoSteps   = 0x059BA4;
		constexpr std::uint32_t kSacHemoToNext  = 0x059BA5;
		constexpr std::uint32_t kSacAge         = 0x133B5E;
		constexpr std::uint32_t kSacAgeThresh   = 0x133B65;
		constexpr std::uint32_t kSacSunOff      = 0x10994B;   // MCM: sun damage disabled
		constexpr std::uint32_t kSacBlueBlood   = 0x0FAB6F;   // QUST "Blue Blood"

		// the rest of Sacrosanct's published state (all dumped 2026-09-14)
		constexpr std::uint32_t kSacWassailStack = 0x1401D1;
		constexpr std::uint32_t kSacWassailHost  = 0x1401D3;
		constexpr std::uint32_t kSacWassailNerf  = 0x1401D5;
		constexpr std::uint32_t kSacAgePerFeed   = 0x133B5F;
		constexpr std::uint32_t kSacAgePerDrain  = 0x133B67;
		// vampire hunters hunting YOU
		constexpr std::uint32_t kSacHuntKilled   = 0x104A09;
		constexpr std::uint32_t kSacHuntChance   = 0x10994D;
		constexpr std::uint32_t kSacHuntPerTest  = 0x10994E;
		constexpr std::uint32_t kSacHuntCooldown = 0x109950;
		constexpr std::uint32_t kSacHuntCoolDur  = 0x10994F;
		// the ascension endgame
		constexpr std::uint32_t kSacAmaranthXP   = 0x059B8F;
		constexpr std::uint32_t kSacAmaranthMult = 0x059B91;
		constexpr std::uint32_t kSacAmaranthTrade= 0x059B95;
		// feeding economy
		constexpr std::uint32_t kSacLethalBase   = 0x059B8E;
		constexpr std::uint32_t kSacLethalLevel  = 0x059B90;
		constexpr std::uint32_t kSacKissOfDeath  = 0x0DD023;
		constexpr std::uint32_t kSacBloodKnight  = 0x0FFABB;
		// the other two quests
		/* Its player-facing quests. Blue Blood has a section of its own, so it
		   is not repeated here; the machinery quests it also ships (SKSE Quest,
		   Sacrosanct Quest, Sacrosanct 5.00 Quest, Foster Childe *Aliases*) are
		   deliberately left out — an alias holder is not something you track. */
		struct NamedQuest2 { std::uint32_t id; const char* fallback; };
		const NamedQuest2 kSacQuests[] = {
			{ 0x1478A9, "The Hunter Hunted" },
			{ 0x136325, "Fortitude" },
			{ 0x074FD2, "Vampire's Command" },
			{ 0x0DA875, "Wassail" },
			{ 0x0FAB72, "Sommelier" },
			{ 0x158E01, "Damning Night" },
			{ 0x12C436, "Summon to Molag's Court" },
		};

		/* The MCM switches that change WHAT IS TRUE, so the panel can explain a
		   refusal instead of leaving you guessing ("why can't I feed?"). Each
		   is {label, id, onMeansOn} — several are phrased as Disable*, so the
		   flag is inverted for display. */
		struct RuleFlag { const char* label; std::uint32_t id; bool disableStyle; };
		const RuleFlag kSacRules[] = {
			{ "Feeding blocked",          0x05C350, false },
			{ "Blood potions",            0x0F0CF7, true  },
			{ "Drain essential NPCs",     0x1274DE, false },
			{ "Vanilla feed",             0x01E41A, true  },
			{ "Sun damage",               0x10994B, true  },
			{ "Beast-form loss",          0x0F0CF9, true  },
			{ "Hate (town reactions)",    0x1071A8, true  },
			{ "Shadow regen",             0x0F0CF8, false },
			{ "Trespassing curse",        0x133B72, true  },
			{ "Can die of thirst",        0x0DD021, false },
			{ "Fortitude",                0x1401D9, true  },
			{ "Elemental bias",           0x1071AE, true  },
			{ "Reversed progression",     0x0F0CFA, false },
			{ "Amaranth allows tradeskills", 0x059B95, false },
			{ "Sneak lethal feed (Wildflowers)", 0x05C343, false },
		};

		/* Growl's own switches. Fewer than Sacrosanct's because most of its MCM
		   is numeric tuning, which the lane reports as vitals instead. */
		/* ── UNDEATH (dumped 2026-09-14) ─────────────────────────────────────
		 * The odd one out, and the panel says so: Undeath publishes only TWO
		 * globals and ships no MCM Helper config, so there is no rules section
		 * to offer and none is invented. What it DOES have is a real questline
		 * — seven named quests, one of which (The Path of Transcendance) is how
		 * you become a lich at all — plus an eight-perk tree. That is what the
		 * Bone lane surfaces. */
		constexpr std::uint32_t kUndPhylTimer = 0x3326D2;   // phylactery regen timer
		constexpr std::uint32_t kUndBlackBook = 0x210DF2;

		struct NamedQuest { const char* fallback; std::uint32_t id; };
		const NamedQuest kUndQuests[] = {
			{ "The Path of Transcendance",        0x019EC8 },
			{ "In their Footsteps",               0x1E225A },
			{ "Exhuming Power",                   0x26C339 },
			{ "Arkay the Enemy",                  0x26C344 },
			{ "Infernal Alchemy",                 0x26C345 },
			{ "Scourg Barrow",                    0x2BDBBF },
			{ "Black Book: Whispers of the Veil", 0x125089 },
		};

		const RuleFlag kGrwRules[] = {
			{ "Werewolf hunters",        0x00088B, true  },
			{ "Invulnerable while changing", 0x0008EB, false },
			{ "Skip the Beast Form check",   0x0008F0, false },
		};

		/* Sacrosanct's per-race bloodline. Detected by WHICH racial record the
		   player actually carries rather than inferred from race name, so a
		   custom or modded race that Sacrosanct still treats as (say) a Nord
		   reports the truth. `avail` is that bloodline's readiness global where
		   one exists (0 = none published). */
		struct Bloodline { const char* race; const char* name; std::uint32_t ab; std::uint32_t sp; std::uint32_t avail; };
		const Bloodline kSacBloodlines[] = {
			{ "Altmer",   "Wine and Revelry",  0x01BC7E, 0x01BC7C, 0 },
			{ "Bosmer",   "Bitter Sap",        0x020BB9, 0,        0 },
			{ "Redguard", "Ruler of Locusts",  0x020BC4, 0x020BBD, 0x020BC1 },
			{ "Imperial", "Cult of Shadows",   0x020BC9, 0,        0 },
			{ "Orc",      "Lavish Brutality",  0x023370, 0x023367, 0 },
			{ "Nord",     "From Ancient Soil", 0x02336F, 0x02336D, 0x0B562B },
			{ "Breton",   "Dolmen Haunt",      0x0612A2, 0,        0 },
			{ "Argonian", "Jeweled Scales",    0x063A44, 0x063A42, 0x063A46 },
			{ "Khajiit",  "Misfortune",        0x063A51, 0x063A4F, 0 },
			{ "Dunmer",   "Tainted Blood",     0x0661F6, 0x0661F4, 0 },
		};

		// --- races (a race says you are WEARING the shape right now) -------
		constexpr std::uint32_t kWerewolfBeastRace    = 0x0CDD84;  // Skyrim.esm
		constexpr std::uint32_t kDLC1VampireBeastRace = 0x00283A;  // Dawnguard.esm
		constexpr std::uint32_t kNecroLichRace        = 0x01772A;  // Undeath.esp

		// --- keywords ------------------------------------------------------
		constexpr std::uint32_t kKwVampire = 0x0A82BB;  // Skyrim.esm "Vampire"

		// --- the transform powers (knowing one = you HOLD the condition) ---
		constexpr std::uint32_t kWerewolfChange   = 0x092C48;  // Skyrim.esm  "Beast Form"
		constexpr std::uint32_t kDLC1VampireChange = 0x00283B; // Dawnguard.esm "Vampire Lord"
		constexpr std::uint32_t kDLC1RevertForm   = 0x00CD5C;  // Dawnguard.esm "Revert Form"
		constexpr std::uint32_t kLichTransform    = 0x00A444;  // Undeath.esp
		constexpr std::uint32_t kNecroRevert      = 0x013F56;  // Undeath.esp

		// --- vanilla vampirism stage abilities (1..4 = how starved) --------
		constexpr std::uint32_t kAbVampire01 = 0x02E1C3;
		constexpr std::uint32_t kAbVampire02 = 0x0ED099;
		constexpr std::uint32_t kAbVampire03 = 0x0ED09D;
		constexpr std::uint32_t kAbVampire04 = 0x0ED09E;

		struct KitEntry
		{
			const char*   plugin;
			std::uint32_t local;
			const char*   note;   // "" = no footnote
		};

		// Curated kits. Every row verified present in its plugin; a row the
		// player has not learned is still SHOWN (dimmed) so the grid doubles
		// as a map of what the condition still has to give.
		/* --- the sun actually BURNING you -------------------------------
		 * Rober, 2026-09-14: "what if i get a vampire ability qwhere i can be
		 * in sun, we are assuming a lot" — and he is right. Daylight plus
		 * being outdoors is NOT the same fact as taking sun damage: Sacrosanct
		 * and the Molag's Will tree both hand out sun resistance/immunity, and
		 * a vampire who has just fed may burn differently or not at all.
		 * So the panel no longer INFERS the burn from the clock. It reports
		 * the burn only when one of the engine's own sun-damage effects is
		 * actually running on the player, and otherwise says nothing about
		 * damage in either direction — because an overhaul with its OWN
		 * sun-damage spell would not be in this list, so absence here is not
		 * evidence of safety and must never be drawn as "you are immune".
		 * Ids dumped from the real plugins 2026-09-14. */
		const KitEntry kSunDamage[] = {
			{ kSkyrim,    0x0C1E8B, "" },   // VampireSunDamage01
			{ kSkyrim,    0x0ED09A, "" },   // VampireSunDamage02
			{ kSkyrim,    0x0ED09B, "" },   // VampireSunDamage03
			{ kSkyrim,    0x0ED09C, "" },   // VampireSunDamage04
			{ kSkyrim,    0x0F5B5D, "" },   // crVampireSunDamage
			{ kDawnguard, 0x012D15, "" },   // DLC1VampireLordSunDamage
		};

		const KitEntry kVampireKit[] = {
			{ kDawnguard, 0x0038B6, "Vampire's Bane" },
			{ kDawnguard, 0x0038B7, "Vampire's Grip" },
			{ kDawnguard, 0x0038B8, "" },
			{ kDawnguard, 0x0038B9, "Blood-summoned swarm" },
			{ kDawnguard, 0x0038BA, "Untouchable while it lasts" },
			{ kDawnguard, 0x0029AC, "" },
			{ kDawnguard, 0x005889, "" },
			{ kDawnguard, 0x0059A1, "" },
			{ kDawnguard, 0x00BA54, "" },
			{ kDawnguard, 0x01419B, "" },
			{ kSkyrim,    0x08D5BF, "" },
			{ kSkyrim,    0x08D5C0, "" },
			{ kSkyrim,    0x08D5C1, "" },
			{ kSkyrim,    0x08D5C2, "" },
			{ kSkyrim,    0x0C4DE1, "" },
			{ kSkyrim,    0x0C4DE2, "" },
			{ kSkyrim,    0x088821, "" },
			{ kSkyrim,    0x0ED0A9, "" },
			{ kSkyrim,    0x0ED0A4, "" },
			{ kSkyrim,    0x0ED0A5, "" },
			{ kSkyrim,    0x0ED0A6, "" },
			{ kSkyrim,    0x0ED0A7, "" },
		};

		const KitEntry kWerewolfKit[] = {
			{ kSkyrim, 0x0CE217, "Howl" },
			{ kSkyrim, 0x0CF78D, "Howl" },
			{ kSkyrim, 0x0CF78C, "Howl" },
			{ kSkyrim, 0x0CF791, "Howl" },
			{ kSkyrim, 0x0CF792, "Howl" },
			{ kSkyrim, 0x0CF793, "Howl" },
			{ kSkyrim, 0x0CF79D, "Howl" },
			{ kSkyrim, 0x0CF7A0, "Howl" },
			{ kSkyrim, 0x0CF7A1, "Howl" },
			{ kSkyrim, 0x0F8306, "Ring of Hircine — an extra change" },
		};

		const KitEntry kLichKit[] = {
			{ kUndeath, 0x0F248D, "" },
			{ kUndeath, 0x0144BC, "" },
			{ kUndeath, 0x0144BD, "" },
			{ kUndeath, 0x0144BF, "" },
			{ kUndeath, 0x02DBAC, "" },
			{ kUndeath, 0x03C95A, "" },
			{ kUndeath, 0x09530C, "" },
			{ kUndeath, 0x0264D5, "" },
			{ kUndeath, 0x0264D6, "" },
			{ kUndeath, 0x003DA9, "" },
			{ kUndeath, 0x019EC9, "" },
			{ kUndeath, 0x04435C, "" },
			{ kUndeath, 0x33C8FE, "Phylactery" },
			{ kUndeath, 0x33C902, "" },
		};

		/* ═══════════════════════════════════════════════════════════════════
		 *  CUSTOM SKILLS FRAMEWORK — the per-curse skill tree
		 *
		 *  Rober, 2026-09-14: "hook to custom skill trees as well … make it
		 *  openable from that menu maybe. i know i have atleast a vampire one."
		 *
		 *  CSF (meh321) is a NetScriptFramework plugin, not an SKSE one, so
		 *  there is no C API to call. Every tree instead ships its own
		 *  `Data/NetScriptFramework/Plugins/CustomSkill.<id>.config.txt`, and
		 *  that file — CSF's OWN definition of the tree — names the globals the
		 *  framework watches. From its documentation comments, verbatim:
		 *
		 *    "This should point to a global variable that is set to 0, if you
		 *     change it to 1 then the custom perks menu for this skill will be
		 *     opened immediately (as long as menu controls are enabled and game
		 *     is not paused). Once that happens the game will also immediately
		 *     set the value back to 0."
		 *
		 *  So opening a tree is ONE GLOBAL WRITE and needs no Papyrus at all —
		 *  which is why this is a C++ verb and not a script bridge. The two
		 *  consequences that are load-bearing:
		 *    · the palette must be CLOSED first (it pauses the game, and a
		 *      paused game is explicitly excluded above), and must not reopen
		 *      on top of the perks menu;
		 *    · the global resets itself, so we never write 0 back.
		 *
		 *  The same config also exposes Level / Ratio / PerkPoints globals, so
		 *  the lane can report the real tree level and unspent points instead
		 *  of just offering a button.
		 *
		 *  ⚠ Keys are matched CASE-INSENSITIVELY on purpose: the shipped files
		 *  disagree with each other (`LevelID`/`ShowMenuID` in Molag's Will vs
		 *  `LevelId`/`ShowMenuId` in Prelude to Purgatory and Companions), and a
		 *  case-sensitive parse silently found nothing in half of them.
		 * ═══════════════════════════════════════════════════════════════ */

		struct SkillTree
		{
			std::string   id;        // the <id> out of CustomSkill.<id>.config.txt
			std::string   name;      // CSF's own display name ("Vampirism")
			std::string   desc;
			std::string   smFile;  std::uint32_t smId{ 0 };   // ShowMenu  — the opener
			std::string   lvFile;  std::uint32_t lvId{ 0 };   // Level
			std::string   raFile;  std::uint32_t raId{ 0 };   // Ratio (0..1)
			std::string   ppFile;  std::uint32_t ppId{ 0 };   // PerkPoints (optional)
		};

		/* Which tree belongs to which curse. Deliberately a SHORT, verified
		   table rather than a name heuristic: this rig also carries Companions,
		   Dragonborn, Pyromancy, Hand To Hand, Vigilant and Summons trees, and
		   the Companions one is a warrior tree whose only mentions of
		   "werewolf" are in CSF's own boilerplate comments — attaching it to
		   Moon would invent a lycanthropy tree that does not exist. A curse
		   with no tree shows no button and says so. */
		const char* CurseForTreeId(const std::string& id)
		{
			if (_stricmp(id.c_str(), "MolagsWillTree") == 0)   return "vampire";
			if (_stricmp(id.c_str(), "PreludeToPurgatory") == 0) return "lich";
			return nullptr;
		}

		std::string TrimQuoted(std::string v)
		{
			while (!v.empty() && (v.front() == ' ' || v.front() == '\t')) v.erase(v.begin());
			while (!v.empty() && (v.back() == ' ' || v.back() == '\t' || v.back() == '\r' || v.back() == '\n'))
				v.pop_back();
			if (v.size() >= 2 && v.front() == '"' && v.back() == '"')
				v = v.substr(1, v.size() - 2);
			return v;
		}

		std::uint32_t ParseNum(const std::string& v)
		{
			try {
				if (v.size() > 2 && v[0] == '0' && (v[1] == 'x' || v[1] == 'X'))
					return static_cast<std::uint32_t>(std::stoul(v, nullptr, 16));
				return static_cast<std::uint32_t>(std::stoul(v, nullptr, 10));
			} catch (...) {
				return 0;
			}
		}

		std::vector<SkillTree>& Trees()
		{
			static std::vector<SkillTree> cache;
			static bool                   done = false;
			if (done)
				return cache;
			done = true;   // even on failure: a missing folder is not worth re-walking

			std::error_code ec;
			const std::filesystem::path dir{ "Data/NetScriptFramework/Plugins" };
			if (!std::filesystem::exists(dir, ec))
				return cache;

			for (const auto& de : std::filesystem::directory_iterator(dir, ec)) {
				if (ec)
					break;
				if (!de.is_regular_file(ec))
					continue;
				const std::string fn = PathU8(de.path().filename());
				// CustomSkill.<id>.config.txt
				if (_strnicmp(fn.c_str(), "CustomSkill.", 12) != 0)
					continue;
				const auto tail = fn.rfind(".config.txt");
				if (tail == std::string::npos || tail <= 12)
					continue;

				SkillTree t;
				t.id = fn.substr(12, tail - 12);

				std::ifstream in(de.path());
				if (!in)
					continue;
				std::string line;
				while (std::getline(in, line)) {
					if (line.empty() || line[0] == '#')
						continue;
					const auto eq = line.find('=');
					if (eq == std::string::npos)
						continue;
					std::string key = line.substr(0, eq);
					while (!key.empty() && (key.back() == ' ' || key.back() == '\t')) key.pop_back();
					const std::string val = TrimQuoted(line.substr(eq + 1));
					auto is = [&](const char* k) { return _stricmp(key.c_str(), k) == 0; };

					if (is("Name"))                 t.name = val;
					else if (is("Description"))     t.desc = val;
					else if (is("ShowMenuFile"))    t.smFile = val;
					else if (is("ShowMenuId"))      t.smId = ParseNum(val);
					else if (is("LevelFile"))       t.lvFile = val;
					else if (is("LevelId"))         t.lvId = ParseNum(val);
					else if (is("RatioFile"))       t.raFile = val;
					else if (is("RatioId"))         t.raId = ParseNum(val);
					else if (is("PerkPointsFile"))  t.ppFile = val;
					else if (is("PerkPointsId"))    t.ppId = ParseNum(val);
				}
				if (!t.smFile.empty() && t.smId)
					cache.push_back(std::move(t));
			}
			// Build marker (hd-markers.json: "nightside-trees").
			logger::info("nightside: custom skill trees found = {}", cache.size());
			return cache;
		}

		/* Forward-declared: the tiny helpers below live AFTER the skill-tree
		   block, and TreeJson needs the form lookup. */
		template <class T>
		T* Look(const char* plugin, std::uint32_t local);

		const SkillTree* TreeForCurse(const char* curse)
		{
			if (!curse)
				return nullptr;
			for (const auto& t : Trees()) {
				const char* c = CurseForTreeId(t.id);
				if (c && std::string(c) == curse)
					return &t;
			}
			return nullptr;
		}

		/* The tree as the lane sees it. `ok` is whether it can actually be
		   opened right now — the plugin has to be LOADED, which it is not when
		   the mod is installed-but-unticked (Prelude to Purgatory is exactly
		   that on this rig today), so the lane can say so instead of offering a
		   dead button. */
		json TreeJson(const char* curse)
		{
			const SkillTree* t = TreeForCurse(curse);
			if (!t)
				return json();
			json o;
			o["id"]   = t->id;
			o["name"] = t->name.empty() ? t->id : t->name;
			if (!t->desc.empty())
				o["desc"] = t->desc;

			auto* sm = Look<RE::TESGlobal>(t->smFile.c_str(), t->smId);
			o["ok"] = sm != nullptr;
			if (!sm) {
				o["msg"] = t->smFile + " is not loaded — enable the mod to use this tree.";
				return o;
			}
			if (auto* lv = Look<RE::TESGlobal>(t->lvFile.c_str(), t->lvId))
				o["level"] = static_cast<int>(lv->value);
			if (auto* ra = Look<RE::TESGlobal>(t->raFile.c_str(), t->raId)) {
				float r = ra->value;
				if (r < 0.0f) r = 0.0f;
				if (r > 1.0f) r = 1.0f;
				o["ratio"] = static_cast<double>(static_cast<int>(r * 1000)) / 1000.0;
			}
			if (!t->ppFile.empty() && t->ppId) {
				if (auto* pp = Look<RE::TESGlobal>(t->ppFile.c_str(), t->ppId))
					o["points"] = static_cast<int>(pp->value);
			}
			return o;
		}

		/* ── tiny helpers ───────────────────────────────────────────────── */

		RE::TESDataHandler* DH() { return RE::TESDataHandler::GetSingleton(); }

		bool PluginLoaded(const char* name)
		{
			auto* dh = DH();
			if (!dh || !name)
				return false;
			return dh->LookupLoadedModByName(name) != nullptr ||
			       dh->LookupLoadedLightModByName(name) != nullptr;
		}

		template <class T>
		T* Look(const char* plugin, std::uint32_t local)
		{
			auto* dh = DH();
			if (!dh || !plugin)
				return nullptr;
			return dh->LookupForm<T>(local, plugin);
		}

		std::string PluginOf(RE::TESForm* form)
		{
			if (form) {
				if (auto* file = form->GetFile(0))
					return std::string(file->GetFilename());
			}
			return "";
		}

		std::string NameOf(RE::TESForm* form)
		{
			if (!form)
				return "";
			if (const char* n = form->GetName(); n && *n)
				return n;
			return "";
		}

		/* Every spell the player KNOWS, as a FormID set. Deliberately built
		   the same way SpellActions::KnownSpellsJson builds its list (actor
		   base SPLO + runtime-added), rather than probing a per-spell engine
		   predicate — this path is already proven on this rig. */
		std::unordered_set<RE::FormID> KnownSpellIds(RE::PlayerCharacter* player)
		{
			std::unordered_set<RE::FormID> known;
			if (!player)
				return known;
			if (auto* base = player->GetActorBase()) {
				if (auto* data = base->GetSpellList(); data && data->spells) {
					for (std::uint32_t i = 0; i < data->numSpells; ++i) {
						if (data->spells[i])
							known.insert(data->spells[i]->GetFormID());
					}
				}
			}
			for (auto* s : player->GetActorRuntimeData().addedSpells) {
				if (s)
					known.insert(s->GetFormID());
			}
			return known;
		}

		/* The player's known spells as FORMS (the id-set above is the fast path
		   for membership; this is for walking them by plugin). Same two sources
		   SpellActions::KnownSpellsJson uses. */
		std::vector<RE::SpellItem*> KnownSpellForms(RE::PlayerCharacter* player)
		{
			std::vector<RE::SpellItem*> out;
			if (!player)
				return out;
			if (auto* base = player->GetActorBase()) {
				if (auto* data = base->GetSpellList(); data && data->spells) {
					for (std::uint32_t i = 0; i < data->numSpells; ++i)
						if (data->spells[i])
							out.push_back(data->spells[i]);
				}
			}
			for (auto* sp : player->GetActorRuntimeData().addedSpells)
				if (sp)
					out.push_back(sp);
			return out;
		}

		// value of a global, or `fallback` when it is not in the load order
		float GlobalVal(const char* plugin, std::uint32_t local, float fallback = -1.0f)
		{
			auto* g = Look<RE::TESGlobal>(plugin, local);
			return g ? g->value : fallback;
		}

		/* remaining/total seconds of the player's timed active effects, keyed
		   by the MagicItem that produced them — the hotbar's ReadActiveFx,
		   which the cooldown rings on the kit tiles reuse verbatim. */
		using FxMap = std::unordered_map<const RE::MagicItem*, std::pair<float, float>>;

		FxMap ReadActiveFx(RE::PlayerCharacter* player)
		{
			FxMap fx;
			auto* mt = player ? player->AsMagicTarget() : nullptr;
			auto* list = mt ? mt->GetActiveEffectList() : nullptr;
			if (!list)
				return fx;
			for (auto* ae : *list) {
				if (!ae || !ae->spell)
					continue;
				if (ae->flags.any(RE::ActiveEffect::Flag::kInactive) ||
					ae->flags.any(RE::ActiveEffect::Flag::kDispelled))
					continue;
				if (ae->duration <= 0.0f)
					continue;
				const float rem = ae->duration - ae->elapsedSeconds;
				if (rem <= 0.0f)
					continue;
				auto& e = fx[ae->spell];
				if (rem > e.first)
					e = { rem, ae->duration };
			}
			return fx;
		}

		/* True when the player currently has this spell running as an active
		   effect — how an ABILITY (duration 0, so invisible to the fx map)
		   is detected. Used for the vampirism stage read. */
		bool HasActiveSpell(RE::PlayerCharacter* player, const RE::MagicItem* mi)
		{
			if (!player || !mi)
				return false;
			auto* mt = player->AsMagicTarget();
			auto* list = mt ? mt->GetActiveEffectList() : nullptr;
			if (!list)
				return false;
			for (auto* ae : *list) {
				if (!ae || ae->spell != mi)
					continue;
				if (ae->flags.any(RE::ActiveEffect::Flag::kInactive) ||
					ae->flags.any(RE::ActiveEffect::Flag::kDispelled))
					continue;
				return true;
			}
			return false;
		}

		std::uint32_t RaceIdOf(RE::PlayerCharacter* player)
		{
			if (!player)
				return 0;
			auto* race = player->GetRace();
			return race ? race->GetFormID() : 0;
		}

		bool IsRace(RE::PlayerCharacter* player, const char* plugin, std::uint32_t local)
		{
			auto* race = Look<RE::TESRace>(plugin, local);
			return race && RaceIdOf(player) == race->GetFormID();
		}

		/* The race carries the Vampire keyword on EVERY vampire race the game
		   or a mod ships — which is why this, and not a list of the ten
		   vanilla *RaceVampire ids, is the vampirism test. */
		bool RaceHasVampireKeyword(RE::PlayerCharacter* player)
		{
			auto* kw = Look<RE::BGSKeyword>(kSkyrim, kKwVampire);
			if (!kw || !player)
				return false;
			auto* race = player->GetRace();
			return race && race->HasKeyword(kw);
		}

		/* ── the three tests ────────────────────────────────────────────── */

		bool HoldsVampirism(RE::PlayerCharacter* player, const std::unordered_set<RE::FormID>& known)
		{
			if (RaceHasVampireKeyword(player))
				return true;
			if (IsRace(player, kDawnguard, kDLC1VampireBeastRace))
				return true;   // mid-Vampire-Lord, so the base race is hidden
			// Knowing the Vampire Lord power outlives any shape you are in.
			if (auto* f = Look<RE::SpellItem>(kDawnguard, kDLC1VampireChange))
				return known.count(f->GetFormID()) != 0;
			return false;
		}

		// true while the player is wearing a BEAST shape (werewolf or, with
		// Growl, werebear)
		bool InBeastShape(RE::PlayerCharacter* player)
		{
			return IsRace(player, kSkyrim, kWerewolfBeastRace) ||
			       IsRace(player, kDragonborn, kWerebearRace);
		}

		// true when the player's ordinary race is one of Growl's ten
		// "<Race> Lycanthrope" variants — the mortal form of the infected
		bool InLycanRace(RE::PlayerCharacter* player)
		{
			if (!PluginLoaded(kGrowl))
				return false;
			for (std::uint32_t id = kGrwAltRaceLo; id <= kGrwAltRaceHi; ++id) {
				if (IsRace(player, kGrowl, id))
					return true;
			}
			return false;
		}

		bool HoldsLycanthropy(RE::PlayerCharacter* player, const std::unordered_set<RE::FormID>& known)
		{
			if (InBeastShape(player) || InLycanRace(player))
				return true;
			if (auto* f = Look<RE::SpellItem>(kSkyrim, kWerewolfChange))
				return known.count(f->GetFormID()) != 0;
			return false;
		}

		bool HoldsLichdom(RE::PlayerCharacter* player, const std::unordered_set<RE::FormID>& known)
		{
			if (!PluginLoaded(kUndeath))
				return false;
			if (IsRace(player, kUndeath, kNecroLichRace))
				return true;
			if (auto* f = Look<RE::SpellItem>(kUndeath, kLichTransform))
				return known.count(f->GetFormID()) != 0;
			return false;
		}

		/* ── world facts the lanes read from ────────────────────────────── */

		json SunJson(RE::PlayerCharacter* player)
		{
			json o;
			float hour = -1.0f;
			if (auto* cal = RE::Calendar::GetSingleton())
				hour = cal->GetHour();
			bool interior = false;
			if (player) {
				if (auto* cell = player->GetParentCell())
					interior = cell->IsInteriorCell();
			}
			// Sunrise ~5, sunset ~21 in Skyrim's clock. Deliberately coarse:
			// this is the "are you about to catch fire" hint, not an almanac.
			const bool daylight = hour >= 5.0f && hour < 21.0f;
			o["hour"]     = hour < 0.0f ? -1.0 : static_cast<double>(static_cast<int>(hour * 10)) / 10.0;
			o["interior"] = interior;
			o["day"]      = daylight;
			// `exposed` is a WORLD fact only — daylight, and no roof. It is not
			// a claim that anything is hurting you.
			o["exposed"]  = daylight && !interior;

			// `burning` is the only sun claim the panel is allowed to make, and
			// it is evidence: one of the engine's sun-damage effects is live on
			// the player right now.
			bool burning = false;
			std::string src;
			for (const auto& e : kSunDamage) {
				auto* sp = Look<RE::SpellItem>(e.plugin, e.local);
				if (sp && HasActiveSpell(player, sp)) {
					burning = true;
					src = NameOf(sp);
					break;
				}
			}
			o["burning"] = burning;
			if (burning && !src.empty())
				o["burnSrc"] = src;
			return o;
		}

		/* ── Sacrosanct's own state ──────────────────────────────────────── */

		/* "Blue Blood" is a QUEST (Rober was right; an earlier guess that the
		   name meant the per-race powers was wrong): SCS_FeedManager_Quest,
		   "Feed upon the most powerful mortals in Skyrim", carrying 13
		   SCS_StrongFeed_NN reference aliases — the marks worth draining.
		   Alias fill state is read exactly the way QuestTools reads it, and an
		   UNFILLED unique-actor alias still names its NPC via fillData, so the
		   roster reads even before the quest has filled anything.
		   ⚠ What "filled" MEANS for this quest (assigned vs already drained) is
		   not something the record can tell us, so the payload reports the raw
		   state and the view labels it as tracked rather than inventing a
		   drained-count. */
		json BlueBloodJson()
		{
			auto* q = Look<RE::TESQuest>(kSacro, kSacBlueBlood);
			if (!q)
				return json();
			json o;
			if (const char* nm = q->GetName(); nm && *nm)
				o["name"] = nm;
			o["running"] = q->IsRunning();

			json marks = json::array();
			int filled = 0;
			for (auto* base : q->aliases) {
				if (!base)
					continue;
				auto* ref = skyrim_cast<RE::BGSRefAlias*>(base);
				if (!ref)
					continue;
				json m;
				if (auto* r = ref->GetReference()) {
					const char* rn = r->GetDisplayFullName();
					m["name"] = (rn && rn[0]) ? rn : "";
					m["filled"] = true;
					++filled;
				} else {
					m["filled"] = false;
					// an empty slot still names who it wants
					if (ref->fillType.get() == RE::BGSBaseAlias::FILL_TYPE::kUniqueActor) {
						if (auto* npc = ref->fillData.uniqueActor.uniqueActor) {
							const char* nn = npc->GetFullName();
							m["name"] = (nn && nn[0]) ? nn : "";
						}
					}
				}
				if (!m.contains("name") || m["name"].get<std::string>().empty())
					continue;   // a nameless slot is not a mark worth drawing
				marks.push_back(std::move(m));
			}
			o["marks"]  = marks;
			o["filled"] = filled;
			o["total"]  = static_cast<int>(marks.size());
			return o;
		}

		/* The overhaul's PASSIVES — its abilities currently running on the
		   player. Sacrosanct ships 92 named ones and Growl 33, and none of them
		   were visible anywhere: the kit deliberately lists only castables, so
		   every permanent bonus a curse grants you was invisible. Read from the
		   live effect list (an ability is an ActiveEffect with no duration), so
		   this is what is ACTUALLY on you, not what the mod could grant.
		   Deduped by name — an overhaul commonly stacks several records that
		   share a display name. */
		json PassivesJson(RE::PlayerCharacter* player, const char* plugin)
		{
			json out = json::array();
			if (!player || !plugin || !PluginLoaded(plugin))
				return out;
			auto* mt = player->AsMagicTarget();
			auto* list = mt ? mt->GetActiveEffectList() : nullptr;
			if (!list)
				return out;
			std::unordered_set<std::string> seen;
			for (auto* ae : *list) {
				if (!ae || !ae->spell)
					continue;
				if (ae->flags.any(RE::ActiveEffect::Flag::kInactive) ||
					ae->flags.any(RE::ActiveEffect::Flag::kDispelled))
					continue;
				auto* sp = ae->spell->As<RE::SpellItem>();
				if (!sp || sp->GetSpellType() != RE::MagicSystem::SpellType::kAbility)
					continue;
				if (PluginOf(sp) != plugin)
					continue;
				std::string nm = NameOf(sp);
				if (nm.empty() || !seen.insert(nm).second)
					continue;
				out.push_back(nm);
			}
			return out;
		}

		/* Growl's published state. Mirrors SacrosanctJson: everything here is a
		   global or a live effect, nothing is inferred. */
		/* Undeath's own state. Deliberately thin on settings — it has none to
		   show — and thick on the questline, which is what the mod actually is. */
		/* ── ADVANCED: every global these overhauls publish ───────────────────
		 * Rober asked whether the deck can hook their MCMs. It already writes
		 * the settings — their MCM is a UI over these globals — but a SkyUI /
		 * Papyrus MCM (which all three are) exposes no way to ENUMERATE its
		 * controls, so the curated switch lists above were hand-built.
		 *
		 * This table closes the rest of the gap: every global each plugin
		 * ships, generated straight from the plugin bytes on 2026-09-14, with
		 * the value the mod SHIPS as its default — which is what makes editing
		 * raw tuning survivable, because any row can be put back.
		 *
		 * ⚠ These are raw. The curated rules above are safe flags; most of what
		 * follows is tuning (spell damage-per-second, Vampire Lord gravity, xp
		 * multipliers) that nothing validates. The view keeps it behind a
		 * collapsed "Advanced" chevron and labels it as raw for that reason.
		 */
		struct AdvGlobal { const char* edid; std::uint32_t local; float def; };

		// Sacrosanct — 82 globals
		const AdvGlobal kAdvSacro[] = {
			{ "SCS_Abilities_Racial_Global_Bloodbath_TargetKills", 0x063A4B, 0.0f },
			{ "SCS_Abilities_Racial_Global_FromAncientSoil_Available", 0x0B562B, 0.0f },
			{ "SCS_Abilities_Racial_Global_JeweledScales_IsWet", 0x063A46, 0.0f },
			{ "SCS_Abilities_Racial_Global_RulerOfLocusts_Available", 0x020BC1, 1.0f },
			{ "SCS_Abilities_VampireLord_Global_BaseGravity", 0x025B1D, 1.35f },
			{ "SCS_Abilities_VampireLord_Global_NewGravity", 0x025B1E, 0.005f },
			{ "SCS_Abilities_VampireLord_Global_PowerIsPower", 0x0B06E0, -1.0f },
			{ "SCS_Help_Global_Wassail", 0x136319, 0.0f },
			{ "SCS_Mechanics_Global_A", 0x08B49D, 0.0f },
			{ "SCS_Mechanics_Global_Age", 0x133B5E, 0.0f },
			{ "SCS_Mechanics_Global_Age_BonusFromDrain", 0x133B67, 24.0f },
			{ "SCS_Mechanics_Global_Age_BonusFromFeed", 0x133B5F, 1.0f },
			{ "SCS_Mechanics_Global_Age_GainMult", 0x133B64, 100.0f },
			{ "SCS_Mechanics_Global_Age_Threshold", 0x133B65, 120.0f },
			{ "SCS_Mechanics_Global_Age_ThresholdIncrement", 0x133B66, 120.0f },
			{ "SCS_Mechanics_Global_AllowAttributeModOnPotions", 0x0F0D05, 0.0f },
			{ "SCS_Mechanics_Global_AllowDie", 0x0DD021, 1.0f },
			{ "SCS_Mechanics_Global_AllowDrainingEsssential", 0x1274DE, 1.0f },
			{ "SCS_Mechanics_Global_AmaranthAllowsTradeskills", 0x059B95, 0.0f },
			{ "SCS_Mechanics_Global_BlockFeed", 0x05C350, 0.0f },
			{ "SCS_Mechanics_Global_BloodKnight_Cost", 0x0FFABB, 100.0f },
			{ "SCS_Mechanics_Global_DelayBetweenStages", 0x1071A7, 24.0f },
			{ "SCS_Mechanics_Global_DisableAnimationBuggedFeed", 0x0A6871, 0.0f },
			{ "SCS_Mechanics_Global_DisableBeastLoss", 0x0F0CF9, 0.0f },
			{ "SCS_Mechanics_Global_DisableBloodPotion", 0x0F0CF7, 0.0f },
			{ "SCS_Mechanics_Global_DisableBuggedFeed", 0x0ADF42, 1.0f },
			{ "SCS_Mechanics_Global_DisableElementalBias", 0x1071AE, 0.0f },
			{ "SCS_Mechanics_Global_DisableFortitude", 0x1401D9, 0.0f },
			{ "SCS_Mechanics_Global_DisableHate", 0x1071A8, 0.0f },
			{ "SCS_Mechanics_Global_DisableScriptsBroken", 0x0FAB76, 0.0f },
			{ "SCS_Mechanics_Global_DisableSunDamage", 0x10994B, 0.0f },
			{ "SCS_Mechanics_Global_DisableTrespassingCurse", 0x133B72, 0.0f },
			{ "SCS_Mechanics_Global_DisableVanillaFeed", 0x01E41A, 1.0f },
			{ "SCS_Mechanics_Global_EnableMockeryBurn", 0x109951, 0.0f },
			{ "SCS_Mechanics_Global_EnableShadowRegen", 0x0F0CF8, 0.0f },
			{ "SCS_Mechanics_Global_FlipProgression", 0x0F0CFA, 0.0f },
			{ "SCS_Mechanics_Global_FlipVampiricDrain", 0x1071AD, 0.0f },
			{ "SCS_Mechanics_Global_ForceUniqueCheck", 0x133B57, 0.0f },
			{ "SCS_Mechanics_Global_FosterChilde_TickerTape", 0x15DD40, 0.0f },
			{ "SCS_Mechanics_Global_HasLiftAndDrop", 0x0D592F, 0.0f },
			{ "SCS_Mechanics_Global_KissOfDeath_Amount", 0x0DD023, 1.0f },
			{ "SCS_Mechanics_Global_LordDisableCrossBlock", 0x0F0CFB, 0.0f },
			{ "SCS_Mechanics_Global_Progression_Done", 0x0D80D2, 0.0f },
			{ "SCS_Mechanics_Global_Progression_DrainAddsDays", 0x0DA872, 5.0f },
			{ "SCS_Mechanics_Global_Progression_GameTime", 0x0D80D3, 24.0f },
			{ "SCS_Mechanics_Global_Progression_Stage", 0x0D80D0, 0.0f },
			{ "SCS_Mechanics_Global_Progression_ToNext", 0x0D80D1, 10.0f },
			{ "SCS_Mechanics_Global_Progression_ToNextIncrement", 0x0D80D4, 10.0f },
			{ "SCS_Mechanics_Global_Progression_XP", 0x0D80CF, 0.0f },
			{ "SCS_Mechanics_Global_VampireHunter_ChanceBase", 0x10994D, 0.0f },
			{ "SCS_Mechanics_Global_VampireHunter_ChancePerTest", 0x10994E, 2.0f },
			{ "SCS_Mechanics_Global_VampireHunter_Cooldown", 0x109950, 0.0f },
			{ "SCS_Mechanics_Global_VampireHunter_CooldownDur", 0x10994F, 5.0f },
			{ "SCS_Mechanics_Global_VampireHunter_TimesKilled", 0x104A09, 0.0f },
			{ "SCS_Mechanics_Global_Wassail_AmountPerStack", 0x1401D1, 10.0f },
			{ "SCS_Mechanics_Global_Wassail_Cap", 0x136315, 100.0f },
			{ "SCS_Mechanics_Global_Wassail_Controls", 0x1401D4, 0.0f },
			{ "SCS_Mechanics_Global_Wassail_Current", 0x136314, 0.0f },
			{ "SCS_Mechanics_Global_Wassail_Hostilities", 0x1401D3, 0.0f },
			{ "SCS_Mechanics_Global_Wassail_NerfAmount", 0x1401D5, 0.0f },
			{ "SCS_Mechanics_Global_WildflowersAllowsSneakLethalFeed", 0x05C343, 0.0f },
			{ "SCS_Mechanics_Global_XP_Amaranth", 0x059B8F, 2000.0f },
			{ "SCS_Mechanics_Global_XP_AmaranthMult", 0x059B91, 2.0f },
			{ "SCS_Mechanics_Global_XP_LethalFeed_Base", 0x059B8E, 250.0f },
			{ "SCS_Mechanics_Global_XP_LethalFeed_Level", 0x059B90, 25.0f },
			{ "SCS_VampireLordDark_Tremble_Count", 0x04ADC8, 0.0f },
			{ "SCS_VampireSpells_Hemomancy_Global_MakeThemBeautiful", 0x059B99, 0.25f },
			{ "SCS_VampireSpells_Hemomancy_Global_MakeThemBeautiful_Chance", 0x092B8A, 0.25f },
			{ "SCS_VampireSpells_Hemomancy_Global_Stage", 0x059BA1, 0.0f },
			{ "SCS_VampireSpells_Hemomancy_Global_Stage_Steps", 0x059BA4, 0.0f },
			{ "SCS_VampireSpells_Hemomancy_Global_Stage_StepsToNext", 0x059BA5, 1.0f },
			{ "SCS_VampireSpells_Hemomancy_Global_Stage_StepsToNext_AddPerStep", 0x059BA6, 1.0f },
			{ "SCS_VampireSpells_VampireLord_Global_DisableSeranaNerf", 0x02AA6E, 1.0f },
			{ "SCS_VampireSpells_VampireLord_Global_Gutwrench_HealthPerSecond", 0x02F9B7, 25.0f },
			{ "SCS_VampireSpells_VampireLord_Global_HarkonsClaim_HealthThreshold", 0x0370AE, 250.0f },
			{ "SCS_VampireSpells_VampireLord_Global_HarkonsGuillotine_HealthPerSecond", 0x0194DB, 150.0f },
			{ "SCS_VampireSpells_VampireLord_Global_XP_Gutwrench_Base", 0x0524AD, 50.0f },
			{ "SCS_VampireSpells_VampireLord_Global_XP_Gutwrench_Level", 0x0524AE, 5.0f },
			{ "SCS_VampireSpells_VampireLord_Global_XP_PowerBite", 0x0524AC, 250.0f },
			{ "SCS_VampireSpells_VampireLord_Global_XP_Raze_Base", 0x0524A8, 50.0f },
			{ "SCS_VampireSpells_VampireLord_Global_XP_Raze_Level", 0x0524A9, 5.0f },
			{ "SCS_VampireSpells_Vanilla_Power_Global_CanLamaesPyre", 0x05EB00, 1.0f },
		};

		// Growl — 24 globals
		const AdvGlobal kAdvGrowl[] = {
			{ "HRI_Events_Global_ImproveHuntersStage", 0x00081D, 0.0f },
			{ "HRI_Events_Global_NightEnd", 0x00082A, 5.0f },
			{ "HRI_Events_Global_NightStart", 0x000829, 19.0f },
			{ "HRI_Events_Global_TemptationRefusedDelay", 0x00082F, 999.0f },
			{ "HRI_Lycan_Global_ArmorXPBase", 0x000843, 20.0f },
			{ "HRI_Lycan_Global_ArmorXPLevelMult", 0x000844, 2.0f },
			{ "HRI_Lycan_Global_ArmorXPMultiplier", 0x0008F8, 1.0f },
			{ "HRI_Lycan_Global_BattleReset_Amount_Base", 0x00085B, 5.0f },
			{ "HRI_Lycan_Global_BattleReset_Amount_Level", 0x00085C, 0.5f },
			{ "HRI_Lycan_Global_BeastForm_Cooldown", 0x000861, 90.0f },
			{ "HRI_Lycan_Global_BeastForm_Duration", 0x000805, 150.0f },
			{ "HRI_Lycan_Global_BeastForm_DurationExtension", 0x000806, 30.0f },
			{ "HRI_Lycan_Global_InvulnerableDuringChange", 0x0008EB, 0.0f },
			{ "HRI_Lycan_Global_LastTempted", 0x000827, -99.0f },
			{ "HRI_Lycan_Global_PassBeastFormCheck", 0x0008F0, 0.0f },
			{ "HRI_Lycan_Global_WeaponXPBase", 0x000841, 20.0f },
			{ "HRI_Lycan_Global_WeaponXPLevelMult", 0x000842, 2.0f },
			{ "HRI_Lycan_Global_WeaponXPMultiplier", 0x0008F9, 1.0f },
			{ "HRI_Lycan_Global_WerebearTotem", 0x00083C, 0.0f },
			{ "HRI_Lycan_Global_WerewolfHunters_Disable", 0x00088B, 0.0f },
			{ "HRI_Mortal_Global_CallOfTheBlood_Chance", 0x000852, 20.0f },
			{ "HRI_Mortal_Global_CallOfTheBlood_ChanceCurrent", 0x0008EC, 20.0f },
			{ "HRI_Mortal_Global_CallOfTheBlood_WentOff", 0x000884, 0.0f },
			{ "HRI_PerkTree_Global_TotemOfTheHunt_Cap", 0x000887, 50.0f },
		};

		// Undeath — 2 globals
		const AdvGlobal kAdvUndeath[] = {
			{ "NecroBlackBookReward", 0x210DF2, 0.0f },
			{ "NecroPerkPhylacteryRegenTimer", 0x3326D2, 0.0f },
		};

		/* Live values for one plugin's table. `def` rides along so the view can
		   offer a reset, and `changed` so it can mark what has drifted from
		   what the mod shipped. */
		json AdvancedJson(const char* plugin, const AdvGlobal* tbl, std::size_t n)
		{
			json o;
			if (!PluginLoaded(plugin))
				return o;
			json rows = json::array();
			int changed = 0;
			for (std::size_t i = 0; i < n; ++i) {
				auto* g = Look<RE::TESGlobal>(plugin, tbl[i].local);
				if (!g)
					continue;   // not in this build of the mod
				const float v = g->value;
				const bool diff = std::fabs(v - tbl[i].def) > 0.0001f;
				if (diff)
					++changed;
				rows.push_back(json{ { "edid", tbl[i].edid }, { "id", tbl[i].local },
					{ "value", static_cast<double>(static_cast<int>(v * 1000)) / 1000.0 },
					{ "def", static_cast<double>(static_cast<int>(tbl[i].def * 1000)) / 1000.0 },
					{ "changed", diff } });
			}
			if (rows.empty())
				return o;
			o["plugin"] = plugin;
			o["rows"] = rows;
			o["changed"] = changed;
			return o;
		}

		json UndeathJson(RE::PlayerCharacter* player)
		{
			json o;
			if (!PluginLoaded(kUndeath)) {
				o["present"] = false;
				return o;
			}
			o["present"] = true;
			// It ships no MCM Helper config and publishes no setting globals, so
			// the lane must NOT grow an empty rules section. Stated, not hidden.
			o["noSettings"] = true;

			json qs = json::array();
			int running = 0, total = 0;
			for (const auto& q : kUndQuests) {
				auto* tq = Look<RE::TESQuest>(kUndeath, q.id);
				if (!tq)
					continue;
				++total;
				const char* nm = tq->GetName();
				json row{ { "name", (nm && *nm) ? nm : q.fallback },
					{ "running", tq->IsRunning() },
					{ "stage", static_cast<int>(tq->GetCurrentStageID()) } };
				if (tq->IsRunning())
					++running;
				qs.push_back(std::move(row));
			}
			if (!qs.empty()) {
				o["quests"] = qs;
				o["questsRunning"] = running;
				o["questsTotal"] = total;
			}

			const float phyl = GlobalVal(kUndeath, kUndPhylTimer);
			if (phyl >= 0.0f)
				o["phylactery"] = static_cast<int>(phyl);
			const float bb = GlobalVal(kUndeath, kUndBlackBook);
			if (bb >= 0.0f)
				o["blackBook"] = bb >= 1.0f;

			if (auto* dh = DH()) {
				json owned = json::array();
				int tot = 0;
				for (auto* pk : dh->GetFormArray<RE::BGSPerk>()) {
					if (!pk || PluginOf(pk) != kUndeath)
						continue;
					++tot;
					if (!player->HasPerk(pk))
						continue;
					const char* pn = pk->GetName();
					if (pn && *pn)
						owned.push_back(pn);
				}
				if (tot > 0)
					o["perks"] = json{ { "total", tot },
						{ "owned", static_cast<int>(owned.size()) }, { "names", owned } };
			}

			/* Its five always-on abilities (Efficiency, Undeath, Unholy Will,
			   Dark Resurgence) — the same gap the other two had. Its 45 BOOKS
			   are deliberately not listed: the part that matters, whether you
			   have READ the Corpse Preparation volumes, already shows up as the
			   NecroBookRead perks in the tree above. Its one shout (Virulent
			   Spray) wraps a spell the dynamic kit already picks up, exactly
			   like Growl's howls. */
			{
				json ps = PassivesJson(player, kUndeath);
				if (!ps.empty())
					o["passives"] = ps;
			}

			// Build marker (hd-markers.json: "nightside-undeath").
			logger::info("nightside: undeath quests {}/{} running", running, total);
			return o;
		}

		json GrowlJson(RE::PlayerCharacter* player)
		{
			json o;
			if (!PluginLoaded(kGrowl)) {
				o["present"] = false;
				return o;
			}
			o["present"] = true;

			// --- the beast form itself -----------------------------------
			{
				json b;
				const float dur = GlobalVal(kGrowl, kGrwDuration);
				const float ext = GlobalVal(kGrowl, kGrwDurationEx);
				const float cd  = GlobalVal(kGrowl, kGrwCooldown);
				if (dur >= 0.0f) b["duration"] = static_cast<int>(dur);
				if (ext >= 0.0f) b["perFeed"]  = static_cast<int>(ext);
				if (cd  >= 0.0f) b["cooldown"] = static_cast<int>(cd);

				/* The remaining half. Growl parks a cooldown effect on the
				   player; its REMAINING duration is the honest "can I change
				   again yet" answer, and it is why the Moon lane no longer has
				   to shrug. Absence means no cooldown is running — which here
				   IS meaningful, because this effect is Growl's own and we are
				   looking for exactly it. */
				const FxMap fx = ReadActiveFx(player);
				for (std::uint32_t id : { kGrwCdSpell, kGrwCdSmall }) {
					auto* sp = Look<RE::SpellItem>(kGrowl, id);
					if (!sp)
						continue;
					if (auto it = fx.find(static_cast<const RE::MagicItem*>(sp)); it != fx.end()) {
						b["cdLeft"] = static_cast<double>(static_cast<int>(it->second.first * 10)) / 10.0;
						b["cdTotal"] = static_cast<double>(static_cast<int>(it->second.second * 10)) / 10.0;
						break;
					}
					if (HasActiveSpell(player, sp))
						b["cooling"] = true;   // running, but with no countdown to show
				}
				if (!b.empty())
					o["beast"] = b;
			}

			// --- Call of the Blood, and the night it prefers --------------
			{
				json c;
				const float base = GlobalVal(kGrowl, kGrwCallChance);
				const float now  = GlobalVal(kGrowl, kGrwCallNow);
				const float went = GlobalVal(kGrowl, kGrwCallWent);
				if (base >= 0.0f) c["base"] = static_cast<int>(base);
				if (now  >= 0.0f) c["now"]  = static_cast<int>(now);
				if (went >= 0.0f) c["wentOff"] = went >= 1.0f;
				if (!c.empty())
					o["call"] = c;

				const float ns = GlobalVal(kGrowl, kGrwNightStart);
				const float ne = GlobalVal(kGrowl, kGrwNightEnd);
				if (ns >= 0.0f && ne >= 0.0f)
					o["night"] = json{ { "start", static_cast<int>(ns) }, { "end", static_cast<int>(ne) } };
			}

			// --- totems and the xp that feeds the tree --------------------
			{
				const float wb = GlobalVal(kGrowl, kGrwWerebear);
				if (wb >= 0.0f)
					o["werebear"] = wb >= 1.0f;
				const float cap = GlobalVal(kGrowl, kGrwTotemCap);
				if (cap >= 0.0f)
					o["totemCap"] = static_cast<int>(cap);

				json xp;
				const float wb2 = GlobalVal(kGrowl, kGrwWpnXpBase);
				const float wm  = GlobalVal(kGrowl, kGrwWpnXpMult);
				const float ab  = GlobalVal(kGrowl, kGrwArmXpBase);
				const float am  = GlobalVal(kGrowl, kGrwArmXpMult);
				if (wb2 >= 0.0f) xp["weapon"] = static_cast<int>(wb2);
				if (wm  >= 0.0f) xp["weaponMult"] = wm;
				if (ab  >= 0.0f) xp["armor"] = static_cast<int>(ab);
				if (am  >= 0.0f) xp["armorMult"] = am;
				if (!xp.empty())
					o["xp"] = xp;
			}

			// --- its switches --------------------------------------------
			{
				json rules = json::array();
				for (std::size_t ri = 0; ri < sizeof(kGrwRules) / sizeof(kGrwRules[0]); ++ri) {
					const auto& r = kGrwRules[ri];
					const float v = GlobalVal(kGrowl, r.id);
					if (v < 0.0f)
						continue;
					const bool raw = v >= 1.0f;
					// offset by 100 so one nsAct verb can address BOTH tables
					rules.push_back(json{ { "i", static_cast<int>(ri) + 100 }, { "k", r.label },
						{ "on", r.disableStyle ? !raw : raw } });
				}
				if (!rules.empty())
					o["rules"] = rules;
			}

			/* --- its perks: its OWN records plus the vanilla/Dawnguard tree it
			   rewrites in place (see kGrwTreePerks). Deduped by form, because a
			   perk could in principle appear in both passes. */
			if (auto* dh = DH()) {
				json owned = json::array();
				std::unordered_set<RE::FormID> seen;
				int total = 0;
				auto take = [&](RE::BGSPerk* pk) {
					if (!pk || !seen.insert(pk->GetFormID()).second)
						return;
					++total;
					if (!player->HasPerk(pk))
						return;
					const char* pn = pk->GetName();
					if (pn && *pn)
						owned.push_back(pn);
				};
				for (auto* pk : dh->GetFormArray<RE::BGSPerk>())
					if (pk && PluginOf(pk) == kGrowl)
						take(pk);
				for (const auto& ref : kGrwTreePerks)
					take(Look<RE::BGSPerk>(ref.plugin, ref.local));
				if (total > 0)
					o["perks"] = json{ { "total", total },
						{ "owned", static_cast<int>(owned.size()) }, { "names", owned } };
			}

			{
				json ps = PassivesJson(player, kGrowl);
				if (!ps.empty())
					o["passives"] = ps;
			}

			// Build marker (hd-markers.json: "nightside-growl").
			logger::info("nightside: growl beast cd={} call={}",
				o.contains("beast") ? o["beast"].value("cooldown", -1) : -1,
				o.contains("call") ? o["call"].value("now", -1) : -1);
			return o;
		}

		json SacrosanctJson(RE::PlayerCharacter* player)
		{
			json o;
			if (!PluginLoaded(kSacro)) {
				o["present"] = false;
				return o;
			}
			o["present"] = true;

			const float stage  = GlobalVal(kSacro, kSacProgStage);
			const float xp     = GlobalVal(kSacro, kSacProgXP);
			const float toNext = GlobalVal(kSacro, kSacProgToNext);
			if (stage >= 0.0f) {
				json st{ { "n", static_cast<int>(stage) } };
				if (xp >= 0.0f && toNext > 0.0f) {
					st["xp"]     = static_cast<int>(xp);
					st["toNext"] = static_cast<int>(toNext);
				}
				o["stage"] = st;
			}

			// the blood meter
			const float wc = GlobalVal(kSacro, kSacWassailCur);
			const float wm = GlobalVal(kSacro, kSacWassailCap);
			if (wc >= 0.0f && wm > 0.0f)
				o["wassail"] = json{ { "cur", static_cast<int>(wc) }, { "cap", static_cast<int>(wm) } };

			const float hs = GlobalVal(kSacro, kSacHemoStage);
			if (hs >= 0.0f) {
				json h{ { "n", static_cast<int>(hs) } };
				const float steps = GlobalVal(kSacro, kSacHemoSteps);
				const float need  = GlobalVal(kSacro, kSacHemoToNext);
				if (steps >= 0.0f && need > 0.0f) {
					h["steps"]  = static_cast<int>(steps);
					h["toNext"] = static_cast<int>(need);
				}
				o["hemomancy"] = h;
			}

			const float age = GlobalVal(kSacro, kSacAge);
			const float ath = GlobalVal(kSacro, kSacAgeThresh);
			if (age >= 0.0f && ath > 0.0f)
				o["age"] = json{ { "cur", static_cast<int>(age) }, { "next", static_cast<int>(ath) } };

			// Sacrosanct's own MCM switch. When the player has turned sun damage
			// off, the lane must not talk about sunlight at all.
			const float sunOff = GlobalVal(kSacro, kSacSunOff, 0.0f);
			o["sunOff"] = sunOff >= 1.0f;

			{
				json ps = PassivesJson(player, kSacro);
				if (!ps.empty())
					o["passives"] = ps;
			}

			json bb = BlueBloodJson();
			if (!bb.is_null() && !bb.empty())
				o["blueBlood"] = bb;

			// wassail tuning that explains the meter's behaviour
			if (o.contains("wassail")) {
				const float st = GlobalVal(kSacro, kSacWassailStack);
				const float ho = GlobalVal(kSacro, kSacWassailHost);
				const float nf = GlobalVal(kSacro, kSacWassailNerf);
				if (st >= 0.0f) o["wassail"]["perStack"] = static_cast<int>(st);
				if (ho >= 0.0f) o["wassail"]["hostilities"] = ho >= 1.0f;
				if (nf >= 0.0f) o["wassail"]["nerf"] = static_cast<int>(nf);
			}
			if (o.contains("age")) {
				const float pf = GlobalVal(kSacro, kSacAgePerFeed);
				const float pd = GlobalVal(kSacro, kSacAgePerDrain);
				if (pf >= 0.0f) o["age"]["perFeed"] = static_cast<int>(pf);
				if (pd >= 0.0f) o["age"]["perDrain"] = static_cast<int>(pd);
			}

			// --- the hunters hunting you ---------------------------------
			{
				json h;
				const float killed = GlobalVal(kSacro, kSacHuntKilled);
				const float chance = GlobalVal(kSacro, kSacHuntChance);
				const float per    = GlobalVal(kSacro, kSacHuntPerTest);
				const float cd     = GlobalVal(kSacro, kSacHuntCooldown);
				const float cdd    = GlobalVal(kSacro, kSacHuntCoolDur);
				if (killed >= 0.0f) h["killed"] = static_cast<int>(killed);
				if (chance >= 0.0f) h["chance"] = static_cast<int>(chance);
				if (per >= 0.0f)    h["perTest"] = static_cast<int>(per);
				if (cd >= 0.0f)     h["cooldown"] = static_cast<int>(cd);
				if (cdd >= 0.0f)    h["cooldownDur"] = static_cast<int>(cdd);
				if (!h.empty()) o["hunter"] = h;
			}

			// --- Amaranth, and what feeding is worth ----------------------
			{
				json a;
				const float xp = GlobalVal(kSacro, kSacAmaranthXP);
				const float ml = GlobalVal(kSacro, kSacAmaranthMult);
				const float tr = GlobalVal(kSacro, kSacAmaranthTrade);
				if (xp >= 0.0f) a["xp"] = static_cast<int>(xp);
				if (ml >= 0.0f) a["mult"] = ml;
				if (tr >= 0.0f) a["tradeskills"] = tr >= 1.0f;
				if (!a.empty()) o["amaranth"] = a;

				json f;
				const float lb = GlobalVal(kSacro, kSacLethalBase);
				const float ll = GlobalVal(kSacro, kSacLethalLevel);
				const float kd = GlobalVal(kSacro, kSacKissOfDeath);
				const float bk = GlobalVal(kSacro, kSacBloodKnight);
				if (lb >= 0.0f) f["lethalBase"]  = static_cast<int>(lb);
				if (ll >= 0.0f) f["lethalLevel"] = static_cast<int>(ll);
				if (kd >= 0.0f) f["kissOfDeath"] = static_cast<int>(kd);
				if (bk >= 0.0f) f["bloodKnight"] = static_cast<int>(bk);
				if (!f.empty()) o["feed"] = f;
			}

			// --- the MCM switches that change what is TRUE ----------------
			{
				json rules = json::array();
				for (std::size_t ri = 0; ri < sizeof(kSacRules) / sizeof(kSacRules[0]); ++ri) {
					const auto& r = kSacRules[ri];
					const float v = GlobalVal(kSacro, r.id);
					if (v < 0.0f)
						continue;   // not in this build of the mod — say nothing
					const bool raw = v >= 1.0f;
					rules.push_back(json{ { "i", static_cast<int>(ri) }, { "k", r.label },
						{ "on", r.disableStyle ? !raw : raw } });
				}
				if (!rules.empty())
					o["rules"] = rules;
			}

			// --- your bloodline -------------------------------------------
			{
				const auto known = KnownSpellIds(player);
				json lines = json::array();
				for (const auto& b : kSacBloodlines) {
					bool has = false;
					for (std::uint32_t id : { b.ab, b.sp }) {
						if (!id)
							continue;
						auto* sp = Look<RE::SpellItem>(kSacro, id);
						if (sp && (known.count(sp->GetFormID()) || HasActiveSpell(player, sp))) {
							has = true;
							break;
						}
					}
					if (!has)
						continue;
					json l{ { "race", b.race }, { "name", b.name } };
					if (b.sp) {
						if (auto* sp = Look<RE::SpellItem>(kSacro, b.sp)) {
							l["castName"] = NameOf(sp);
							l["plugin"]   = kSacro;
							l["localId"]  = b.sp;
							l["formId"]   = sp->GetFormID();
							l["known"]    = known.count(sp->GetFormID()) != 0;
						}
					}
					if (b.avail) {
						const float av = GlobalVal(kSacro, b.avail);
						if (av >= 0.0f)
							l["ready"] = av >= 1.0f;
					}
					lines.push_back(std::move(l));
				}
				if (!lines.empty())
					o["bloodline"] = lines;
			}

			/* --- its perks: own records PLUS the Dawnguard tree nodes it
			   rewrites in place (kSacTreePerks). Same override trap Growl hit. */
			{
				if (auto* dh = DH()) {
					json owned = json::array();
					std::unordered_set<RE::FormID> seen;
					int total = 0;
					auto take = [&](RE::BGSPerk* pk) {
						if (!pk || !seen.insert(pk->GetFormID()).second)
							return;
						++total;
						if (!player->HasPerk(pk))
							return;
						const char* pn = pk->GetName();
						if (pn && *pn)
							owned.push_back(pn);
					};
					for (auto* pk : dh->GetFormArray<RE::BGSPerk>())
						if (pk && PluginOf(pk) == kSacro)
							take(pk);
					for (const auto& ref : kSacTreePerks)
						take(Look<RE::BGSPerk>(ref.plugin, ref.local));
					if (total > 0)
						o["perks"] = json{ { "total", total },
							{ "owned", static_cast<int>(owned.size()) }, { "names", owned } };
				}
			}

			// --- its player-facing quests ---------------------------------
			{
				json qs = json::array();
				int running = 0;
				for (const auto& nq : kSacQuests) {
					auto* q = Look<RE::TESQuest>(kSacro, nq.id);
					if (!q)
						continue;
					const char* qn = q->GetName();
					json row{ { "name", (qn && *qn) ? qn : nq.fallback },
						{ "running", q->IsRunning() },
						{ "stage", static_cast<int>(q->GetCurrentStageID()) } };
					if (q->IsRunning())
						++running;
					qs.push_back(std::move(row));
				}
				if (!qs.empty()) {
					o["quests"] = qs;
					o["questsRunning"] = running;
					o["questsTotal"] = static_cast<int>(qs.size());
				}
			}

			// Build marker (hd-markers.json: "nightside-sacrosanct").
			logger::info("nightside: sacrosanct stage={} wassail={}/{} blueblood={}",
				static_cast<int>(stage), static_cast<int>(wc), static_cast<int>(wm),
				bb.is_null() ? 0 : bb.value("total", 0));
			return o;
		}

		/* One kit tile. `known` decides lit vs dimmed; a ring rides along when
		   the spell is currently running. */
		json KitRow(const KitEntry& e, RE::PlayerCharacter* player,
			const std::unordered_set<RE::FormID>& known, const FxMap& fx)
		{
			json o;
			auto* sp = Look<RE::SpellItem>(e.plugin, e.local);
			if (!sp)
				return o;   // caller drops an empty row — the plugin has no such record
			o["plugin"]  = e.plugin;
			o["localId"] = e.local;
			o["formId"]  = sp->GetFormID();
			o["name"]    = NameOf(sp);
			if (o["name"].get<std::string>().empty())
				return json{};   // an unnamed record is not a button
			const auto type = sp->GetSpellType();
			const bool voice = type == RE::MagicSystem::SpellType::kPower ||
			                   type == RE::MagicSystem::SpellType::kLesserPower ||
			                   type == RE::MagicSystem::SpellType::kVoicePower;
			o["slot"]  = voice ? "voice" : "hand";
			o["known"] = known.count(sp->GetFormID()) != 0;
			if (e.note && *e.note)
				o["note"] = e.note;
			if (auto it = fx.find(static_cast<const RE::MagicItem*>(sp)); it != fx.end()) {
				o["fxRem"] = static_cast<double>(static_cast<int>(it->second.first * 10)) / 10.0;
				o["fxDur"] = static_cast<double>(static_cast<int>(it->second.second * 10)) / 10.0;
			}
			return o;
		}

		/* Everything the player KNOWS that came out of one plugin — the other
		   half of a curse's kit. The curated tables above cover the vanilla /
		   Dawnguard lineage (and are what makes an UNLEARNED power visible);
		   this covers the overhaul's own spells, which no hardcoded list could
		   keep up with: Sacrosanct alone ships 96 named castables.
		   Filters: castable types only (no abilities, no proc/cloak helpers
		   that the player can never cast), must be named, and deduped BY NAME —
		   Sacrosanct ships several spells sharing a display name with their own
		   proc variants, and drawing "Blood Brand" four times is noise. */
		void AddPluginKit(json& kit, int& have, RE::PlayerCharacter* player,
			const char* plugin, const FxMap& fx, std::unordered_set<RE::FormID>& seen,
			std::unordered_set<std::string>& seenNames)
		{
			if (!plugin || !*plugin || !PluginLoaded(plugin))
				return;
			for (auto* sp : KnownSpellForms(player)) {
				if (!sp)
					continue;
				if (!seen.insert(sp->GetFormID()).second)
					continue;
				if (PluginOf(sp) != plugin)
					continue;
				const auto type = sp->GetSpellType();
				const bool castable = type == RE::MagicSystem::SpellType::kSpell ||
				                      type == RE::MagicSystem::SpellType::kPower ||
				                      type == RE::MagicSystem::SpellType::kLesserPower ||
				                      type == RE::MagicSystem::SpellType::kVoicePower;
				if (!castable)
					continue;
				std::string nm = NameOf(sp);
				if (nm.empty() || !seenNames.insert(nm).second)
					continue;
				const bool voice = type != RE::MagicSystem::SpellType::kSpell;
				json row{
					{ "plugin", plugin },
					{ "localId", ActorIdentity::LocalIdOf(sp) },
					{ "formId", sp->GetFormID() },
					{ "name", nm },
					{ "slot", voice ? "voice" : "hand" },
					{ "known", true }
				};
				if (auto it = fx.find(static_cast<const RE::MagicItem*>(sp)); it != fx.end()) {
					row["fxRem"] = static_cast<double>(static_cast<int>(it->second.first * 10)) / 10.0;
					row["fxDur"] = static_cast<double>(static_cast<int>(it->second.second * 10)) / 10.0;
				}
				kit.push_back(std::move(row));
				++have;
			}
		}

		json CastRef(const char* plugin, std::uint32_t local,
			const std::unordered_set<RE::FormID>& known, const char* fallbackLabel)
		{
			auto* sp = Look<RE::SpellItem>(plugin, local);
			if (!sp)
				return json();
			json o;
			o["plugin"]  = plugin;
			o["localId"] = local;
			o["formId"]  = sp->GetFormID();
			std::string nm = NameOf(sp);
			o["name"]  = nm.empty() ? std::string(fallbackLabel ? fallbackLabel : "") : nm;
			o["known"] = known.count(sp->GetFormID()) != 0;
			return o;
		}
	}   // namespace

	/* ═════════════════════════════════════════════════════════════════════ */

	std::string GateJson()
	{
		json o{ { "any", false }, { "vampire", false }, { "werewolf", false }, { "lich", false } };
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return o.dump();
		const auto known = KnownSpellIds(player);
		const bool v = HoldsVampirism(player, known);
		const bool w = HoldsLycanthropy(player, known);
		const bool l = HoldsLichdom(player, known);
		o["vampire"]  = v;
		o["werewolf"] = w;
		o["lich"]     = l;
		o["any"]      = v || w || l;

		json awake = json::array();
		if (IsRace(player, kDawnguard, kDLC1VampireBeastRace)) awake.push_back("vampire");
		if (InBeastShape(player))                              awake.push_back("werewolf");
		if (IsRace(player, kUndeath, kNecroLichRace))          awake.push_back("lich");
		o["awake"] = awake;

		// Build marker (hd-markers.json: "nightside-gate"). Logged once per
		// open — it is the one line that says why the tab is or is not there.
		logger::info("nightside: gate vampire={} werewolf={} lich={} awake={}",
			v, w, l, awake.size());
		return o.dump();
	}

	std::string StateJson()
	{
		json out;
		out["any"] = false;
		out["forms"] = json::array();

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return out.dump();

		const auto  known = KnownSpellIds(player);
		const FxMap fx    = ReadActiveFx(player);
		out["sun"] = SunJson(player);

		std::string raceName;
		if (auto* race = player->GetRace())
			raceName = NameOf(race);

		/* `extraPlugin` folds in that overhaul's OWN castables after the curated
		   list — see AddPluginKit. */
		auto addKit = [&](json& form, const KitEntry* tbl, std::size_t n,
			const char* extraPlugin = nullptr) {
			json kit = json::array();
			int  have = 0;
			std::unordered_set<RE::FormID>  seen;
			std::unordered_set<std::string> seenNames;
			for (std::size_t i = 0; i < n; ++i) {
				json row = KitRow(tbl[i], player, known, fx);
				if (row.is_null() || row.empty())
					continue;
				if (row.contains("formId"))
					seen.insert(static_cast<RE::FormID>(row["formId"].get<std::uint32_t>()));
				if (row.contains("name"))
					seenNames.insert(row["name"].get<std::string>());
				if (row.value("known", false))
					++have;
				kit.push_back(std::move(row));
			}
			AddPluginKit(kit, have, player, extraPlugin, fx, seen, seenNames);
			form["kit"]      = std::move(kit);
			form["kitHave"]  = have;
		};

		/* ── Blood ─────────────────────────────────────────────────────── */
		if (HoldsVampirism(player, known)) {
			json f;
			f["id"]    = "vampire";
			f["name"]  = "Vampirism";
			f["lane"]  = "Blood";
			f["held"]  = true;
			f["awake"] = IsRace(player, kDawnguard, kDLC1VampireBeastRace);
			f["race"]  = raceName;
			f["source"] = PluginLoaded(kSacro)
				? "Sacrosanct — Vampires of Skyrim"
				: (PluginLoaded(kDawnguard) ? "Dawnguard" : "Skyrim");

			json sac = SacrosanctJson(player);
			const bool sacOn = sac.value("present", false);
			if (sacOn) {
				f["sac"] = sac;
				json adv = AdvancedJson(kSacro, kAdvSacro,
					sizeof(kAdvSacro) / sizeof(kAdvSacro[0]));
				if (!adv.is_null() && !adv.empty())
					f["adv"] = adv;
			}
			f["shape"] = f["awake"].get<bool>() ? "Vampire Lord" : "Mortal shape";

			// Vanilla vampirism runs one of four stage abilities; whichever is
			// live IS how starved you are. Sacrosanct keeps the four stages.
			int stage = 0;
			const std::uint32_t stages[4] = { kAbVampire01, kAbVampire02, kAbVampire03, kAbVampire04 };
			for (int i = 0; i < 4; ++i) {
				if (auto* ab = Look<RE::SpellItem>(kSkyrim, stages[i]); ab && HasActiveSpell(player, ab))
					stage = i + 1;
			}
			if (sacOn && sac.contains("stage")) {
				// Sacrosanct's OWN stage, straight from its global — no sniffing,
				// no four-notch cap, and a real xp fraction toward the next one.
				f["stage"] = json{ { "n", sac["stage"].value("n", 0) }, { "src", "sacrosanct" } };
				if (sac["stage"].contains("xp")) {
					f["stage"]["xp"]     = sac["stage"]["xp"];
					f["stage"]["toNext"] = sac["stage"]["toNext"];
				}
			} else if (stage > 0) {
				static const char* kStageLabel[4] = { "Sated", "Thirsty", "Hungry", "Starved" };
				f["stage"] = json{ { "n", stage }, { "of", 4 },
					{ "label", kStageLabel[stage - 1] }, { "src", "vanilla" } };
			} else {
				f["stage"] = nullptr;   // an overhaul we cannot read — say so, do not invent
			}

			// Only on evidence. Standing in daylight with no sun-damage effect
			// running gets NO warning and no all-clear either — the header's
			// sky chip still states the plain hour/indoors fact.
			// Sacrosanct's own MCM switch wins over everything: with sun damage
			// turned off there is nothing to warn about, ever.
			if (sacOn && sac.value("sunOff", false))
				f["sunOff"] = true;
			else if (out["sun"].value("burning", false))
				f["warn"] = "The sun is burning you.";

			json prim = CastRef(kDawnguard, kDLC1VampireChange, known, "Vampire Lord");
			if (!prim.is_null()) f["primary"] = prim;
			json rev = CastRef(kDawnguard, kDLC1RevertForm, known, "Revert Form");
			if (!rev.is_null()) f["revert"] = rev;

			{
				json tr = TreeJson("vampire");
				if (!tr.is_null() && !tr.empty())
					f["tree"] = tr;
			}
			addKit(f, kVampireKit, sizeof(kVampireKit) / sizeof(kVampireKit[0]),
				sacOn ? kSacro : nullptr);
			out["forms"].push_back(std::move(f));
		}

		/* ── Moon ──────────────────────────────────────────────────────── */
		if (HoldsLycanthropy(player, known)) {
			json f;
			f["id"]    = "werewolf";
			f["name"]  = "Lycanthropy";
			f["lane"]  = "Moon";
			f["held"]  = true;
			f["awake"] = InBeastShape(player);
			f["race"]  = raceName;
			json grw = GrowlJson(player);
			const bool grwOn = grw.value("present", false);
			if (grwOn) {
				f["grw"] = grw;
				json adv = AdvancedJson(kGrowl, kAdvGrowl,
					sizeof(kAdvGrowl) / sizeof(kAdvGrowl[0]));
				if (!adv.is_null() && !adv.empty())
					f["adv"] = adv;
			}

			f["source"] = grwOn ? "Growl — Werebeasts of Skyrim" : "Skyrim — the Companions";
			/* Name the shape from the RACE, not from a config flag: the
			   werebear totem global says which totem you chose, not what you
			   are wearing right now. */
			f["shape"] = IsRace(player, kDragonborn, kWerebearRace) ? "Werebear"
				: (IsRace(player, kSkyrim, kWerewolfBeastRace) ? "Werewolf" : "Mortal shape");
			f["stage"] = nullptr;
			/* Vanilla's once-a-day counter lives in a Papyrus quest variable
			   this module cannot read — but GROWL replaces that rule with a
			   real cooldown and publishes both halves, so with Growl on there
			   is nothing left to shrug about. */
			if (!grwOn)
				f["unknown"] = "Changes left today are tracked in Papyrus — the deck cannot read them.";

			json prim = CastRef(kSkyrim, kWerewolfChange, known, "Beast Form");
			if (!prim.is_null()) f["primary"] = prim;

			{
				json tr = TreeJson("werewolf");
				if (!tr.is_null() && !tr.empty())
					f["tree"] = tr;
			}
			addKit(f, kWerewolfKit, sizeof(kWerewolfKit) / sizeof(kWerewolfKit[0]),
				grwOn ? kGrowl : nullptr);
			out["forms"].push_back(std::move(f));
		}

		/* ── Bone ──────────────────────────────────────────────────────── */
		if (HoldsLichdom(player, known)) {
			json f;
			f["id"]    = "lich";
			f["name"]  = "Lichdom";
			f["lane"]  = "Bone";
			f["held"]  = true;
			f["awake"] = IsRace(player, kUndeath, kNecroLichRace);
			f["race"]  = raceName;
			f["source"] = "Undeath — Classical Lichdom";
			f["shape"] = f["awake"].get<bool>() ? "Lich" : "Mortal shape";
			f["stage"] = nullptr;

			// Undeath gates re-transformation behind its own cooldown ability.
			if (auto* cd = Look<RE::SpellItem>(kUndeath, 0x03034C); cd && HasActiveSpell(player, cd))
				f["cooling"] = true;

			json und = UndeathJson(player);
			if (und.value("present", false)) {
				f["und"] = und;
				json adv = AdvancedJson(kUndeath, kAdvUndeath,
					sizeof(kAdvUndeath) / sizeof(kAdvUndeath[0]));
				if (!adv.is_null() && !adv.empty())
					f["adv"] = adv;
			}

			json prim = CastRef(kUndeath, kLichTransform, known, "Lich Transformation");
			if (!prim.is_null()) f["primary"] = prim;
			json rev = CastRef(kUndeath, kNecroRevert, known, "Revert");
			if (!rev.is_null()) f["revert"] = rev;

			{
				json tr = TreeJson("lich");
				if (!tr.is_null() && !tr.empty())
					f["tree"] = tr;
			}
			addKit(f, kLichKit, sizeof(kLichKit) / sizeof(kLichKit[0]), kUndeath);
			out["forms"].push_back(std::move(f));
		}

		out["any"] = !out["forms"].empty();
		logger::info("nightside: state built, {} lane(s)", out["forms"].size());
		return out.dump();
	}

	std::string ActJson(const std::string& req)
	{
		json res{ { "ok", false }, { "found", false }, { "msg", "" } };
		json in;
		try {
			in = json::parse(req);
		} catch (...) {
			res["msg"] = "bad request";
			return res.dump();
		}
		const std::string act = in.value("act", "");

		/* Open this curse's Custom Skills tree. Resolve only — main.cpp closes
		   the palette and then calls ExecuteAction, because CSF refuses to open
		   its perks menu while the game is paused. */
		if (act == "tree") {
			const std::string curse = in.value("curse", "");
			const SkillTree*  t = TreeForCurse(curse.c_str());
			if (!t) {
				res["msg"] = "No skill tree is mapped to that curse.";
				return res.dump();
			}
			if (!Look<RE::TESGlobal>(t->smFile.c_str(), t->smId)) {
				res["msg"] = t->smFile + " is not loaded — enable the mod first.";
				return res.dump();
			}
			res["ok"]    = true;
			res["found"] = true;
			res["act"]   = "tree";
			res["name"]  = t->name.empty() ? t->id : t->name;
			return res.dump();
		}

		/* Flip one Sacrosanct MCM switch. These settings ARE globals — writing
		   one is exactly what its MCM does — so this is a direct write with no
		   Papyrus. It happens INLINE (no palette close): a toggle is not a
		   physical act in the world and the panel should show the new state
		   immediately.
		   ⚠ Honest limit, surfaced in the view: for a plain flag this is the
		   whole of the setting, but where Sacrosanct's own MCM handler does
		   extra work on change (re-applying abilities, refreshing perks), the
		   global alone will not trigger that. */
		if (act == "rule") {
			const int  idx = in.value("i", -1);
			const bool want = in.value("on", false);
			// >= 100 addresses Growl's table; below it, Sacrosanct's
			const bool growl = idx >= 100;
			const int  local = growl ? idx - 100 : idx;
			const int  n = growl
				? static_cast<int>(sizeof(kGrwRules) / sizeof(kGrwRules[0]))
				: static_cast<int>(sizeof(kSacRules) / sizeof(kSacRules[0]));
			if (local < 0 || local >= n) {
				res["msg"] = "unknown setting";
				return res.dump();
			}
			const char* plug = growl ? kGrowl : kSacro;
			if (!PluginLoaded(plug)) {
				res["msg"] = std::string(plug) + " is not loaded.";
				return res.dump();
			}
			const auto& r = growl ? kGrwRules[local] : kSacRules[local];
			auto* g = Look<RE::TESGlobal>(plug, r.id);
			if (!g) {
				res["msg"] = std::string(r.label) + " is not in this build of the mod.";
				return res.dump();
			}
			// the table's disableStyle entries are stored inverted
			g->value = (r.disableStyle ? !want : want) ? 1.0f : 0.0f;
			logger::info("nightside-rule: {} -> {}", r.label, want);
			res["ok"] = true;
			res["act"] = "rule";
			res["msg"] = std::string(r.label) + (want ? " — on" : " — off");
			return res.dump();
		}

		/* Write one raw global by plugin + local id. Deliberately separate from
		   the curated "rule" verb: that one addresses a hand-checked table by
		   index, this one takes any id the Advanced list published, so it
		   validates the id against those same tables before writing — a stray
		   id from anywhere else is refused rather than poked into the game. */
		if (act == "glob") {
			const std::string plug = in.value("plugin", "");
			const auto id = in.value("id", 0u);
			const double want = in.value("value", 0.0);

			const AdvGlobal* tbl = nullptr;
			std::size_t n = 0;
			if (plug == kSacro)        { tbl = kAdvSacro;   n = sizeof(kAdvSacro) / sizeof(kAdvSacro[0]); }
			else if (plug == kGrowl)   { tbl = kAdvGrowl;   n = sizeof(kAdvGrowl) / sizeof(kAdvGrowl[0]); }
			else if (plug == kUndeath) { tbl = kAdvUndeath; n = sizeof(kAdvUndeath) / sizeof(kAdvUndeath[0]); }
			if (!tbl) {
				res["msg"] = "that plugin has no advanced table";
				return res.dump();
			}
			const AdvGlobal* hit = nullptr;
			for (std::size_t i = 0; i < n; ++i)
				if (tbl[i].local == id) { hit = &tbl[i]; break; }
			if (!hit) {
				res["msg"] = "unknown global";
				return res.dump();
			}
			auto* g = Look<RE::TESGlobal>(plug.c_str(), id);
			if (!g) {
				res["msg"] = plug + " is not loaded.";
				return res.dump();
			}
			g->value = static_cast<float>(want);
			logger::info("nightside-glob: {} {} = {}", plug, hit->edid, want);
			res["ok"] = true;
			res["act"] = "glob";
			res["plugin"] = plug;
			res["id"] = id;
			res["value"] = want;
			res["def"] = static_cast<double>(hit->def);
			res["msg"] = std::string(hit->edid) + " = " + std::to_string(want);
			return res.dump();
		}

		if (act != "cast") {
			res["msg"] = "unknown action";
			return res.dump();
		}
		const std::string plugin = in.value("plugin", "");
		const auto local  = in.value("localId", 0u);
		const auto formId = in.value("formId", 0u);

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player) {
			res["msg"] = "no player";
			return res.dump();
		}
		RE::SpellItem* sp = nullptr;
		if (!plugin.empty() && local)
			sp = Look<RE::SpellItem>(plugin.c_str(), local);
		if (!sp && formId)
			sp = RE::TESForm::LookupByID<RE::SpellItem>(formId);
		if (!sp) {
			res["msg"] = "That power is not in this load order any more.";
			return res.dump();
		}
		const auto known = KnownSpellIds(player);
		if (!known.count(sp->GetFormID())) {
			res["msg"] = NameOf(sp) + " is not yours yet.";
			return res.dump();
		}
		res["ok"]    = true;
		res["found"] = true;
		res["name"]  = NameOf(sp);
		return res.dump();
	}

	std::string ExecuteAction(const std::string& req)
	{
		json in;
		try {
			in = json::parse(req);
		} catch (...) {
			return "";
		}
		if (in.value("act", "") == "tree") {
			const std::string curse = in.value("curse", "");
			const SkillTree*  t = TreeForCurse(curse.c_str());
			if (!t)
				return "";
			auto* sm = Look<RE::TESGlobal>(t->smFile.c_str(), t->smId);
			if (!sm)
				return "";
			// CSF watches this global and opens the tree the moment it turns 1,
			// then zeroes it itself — so we never write it back. Marker:
			// "nightside-tree-open".
			sm->value = 1.0f;
			logger::info("nightside-tree-open: {} via {} 0x{:X}",
				t->name.empty() ? t->id : t->name, t->smFile, t->smId);
			return "";   // the perks menu appearing IS the feedback
		}

		const std::string plugin = in.value("plugin", "");
		const auto local  = in.value("localId", 0u);
		const auto formId = in.value("formId", 0u);
		// SpellActions::Cast owns the voice-slot road (select into the power
		// slot, press the game's own Shout key) — which is exactly what Beast
		// Form, Vampire Lord and the Lich Transformation need. Marker:
		// "nightside-cast".
		logger::info("nightside-cast: {} 0x{:X}", plugin, local);
		SpellActions::Cast(plugin, local, formId);
		return "";   // Cast notifies on its own
	}
}
