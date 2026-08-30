#include "hotbar.h"

#include "actor_identity.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <unordered_set>

// pch (force-included) provides RE::/SKSE:: and nlohmann json.hpp.

namespace Hotbar
{
	using json = nlohmann::json;

	namespace
	{
		std::string ClampOrient(const std::string& s) { return s == "vert" ? "vert" : "horiz"; }
		std::string ClampAnchorV(const std::string& s) { return s == "top" ? "top" : "bottom"; }
		std::string ClampAnchorH(const std::string& s)
		{
			return (s == "left" || s == "right") ? s : "center";
		}
		// Which screen edge the SETUP PANEL docks to (2026-08-19). Deliberately
		// separate from anchorH, which is the BAR's own anchor — the editor and
		// the thing it edits do not have to live on the same side, and that is
		// the whole point of the ask ("so you can line stuff on right if you
		// need to"). Only two edges exist; anything else means the shipped one.
		std::string ClampSide(const std::string& s) { return s == "left" ? "left" : "right"; }
		std::string ClampSkin(const std::string& s)
		{
			// A contract with the view's CSS: an unknown skin would render as an
			// unstyled row of naked buttons rather than fall back visibly, so an
			// unrecognised value becomes "plain" here instead of downstream.
			static const char* kSkins[] = { "plain", "runed", "carved", "gilded" };
			for (const char* k : kSkins)
				if (s == k)
					return s;
			return "plain";
		}
		std::string ClampGripPos(const std::string& s)
		{
			// "auto" keeps the half-screen flip; "top"/"bottom" pin the ✥ grip so
			// the bar's OTHER edge stays clear while judging placement.
			return (s == "top" || s == "bottom") ? s : "auto";
		}
		std::string ClampShowMode(const std::string& s)
		{
			// A contract with both the view's <select> and the C++ evaluator.
			// Anything unrecognised means "always", which is the safe direction:
			// a typo hides nothing rather than hiding everything.
			static const char* kModes[] = { "always", "combat", "drawn", "either" };
			for (const char* k : kModes)
				if (s == k)
					return s;
			return "always";
		}
		std::string ClampKind(const std::string& s)
		{
			static const char* kKinds[] = { "spell", "item", "entry", "combo", "flyout", "smart" };
			for (const char* k : kKinds)
				if (s == k)
					return s;
			return "";
		}
		// A flyout CHILD may be any fireable kind but never another flyout —
		// the one-level rule is enforced here, at parse time, so no fire path
		// ever has to consider recursion.
		std::string ClampChildKind(const std::string& s)
		{
			const std::string k = ClampKind(s);
			return k == "flyout" ? std::string() : k;
		}

		// Resolve a slot's durable identity back to a live form. All of the
		// masking / dynamic-form / light-plugin sharp edges belong to
		// ActorIdentity — this is the one call, never a private reimplementation
		// (a local copy of GetLocalFormID() is the null-deref that file's header
		// wall of comment is about).
		RE::TESForm* ResolveForm(const Slot& s)
		{
			if (s.localId) {
				// The INTEGER overload (2026-08-16, round three). `localId` is
				// already a std::uint32_t; formatting it to "0x81A" only for
				// Resolve to std::stoul it straight back was a string allocation
				// and a parse per slot per live tick, for no information.
				if (auto* f = ActorIdentity::Resolve(s.localId, s.plugin))
					return f;
			}
			if (s.formId)
				return RE::TESForm::LookupByID(s.formId);
			return nullptr;
		}

		// Does the player know this spell? Deliberately the SAME definition
		// SpellActions::KnownSpellsJson uses to build the list the picker offers
		// — actor-base SPLO spells plus everything learned at runtime — because
		// two different answers to "do you know this" would mean the bar greys
		// out a spell the picker had just handed you.
		bool KnowsSpell(RE::PlayerCharacter* player, RE::SpellItem* sp)
		{
			if (!player || !sp)
				return false;
			if (auto* base = player->GetActorBase()) {
				if (auto* data = base->GetSpellList(); data && data->spells) {
					for (std::uint32_t i = 0; i < data->numSpells; ++i)
						if (data->spells[i] == sp)
							return true;
				}
			}
			for (auto* s : player->GetActorRuntimeData().addedSpells)
				if (s == sp)
					return true;
			return false;
		}

		// How many of this object the player is carrying, and whether it is worn.
		// Walking the inventory is the only way to learn IsWorn(), which is what
		// draws the "equipped" ring on a weapon's button.
		// ---- smart consumables ------------------------------------------------
		// Which restore pool a potion feeds, how many POINTS it puts back, and
		// how trustworthy that figure is. Three things this has to get right,
		// each of which it got wrong until 2026-08-19:
		//
		// 1. FORTIFY IS NOT RESTORE. Fortify Health and Restore Health are the
		//    same archetype on the same actor value; the engine tells them apart
		//    by the MGEF's Recover flag (fortify reverts when it expires) and by
		//    its MagicAlchFortify… keyword. Matching on the actor value alone
		//    made a Fortify Health potion a healing potion — and, being a big
		//    number, usually the CHOSEN one, which raises your ceiling while you
		//    bleed out.
		// 2. DURATION IS PART OF THE DOSE. A potion that restores 5 a second for
		//    60 s puts back 300, not 5. Overhauls (CACO, Apothecary, Requiem)
		//    ship mostly duration-based restores, and ranking them by bare
		//    magnitude sorted them under a 25-point vanilla sip.
		// 3. REGENERATION IS A DIFFERENT PROMISE. A "Fortify Health Regen"
		//    potion lifts the HealRate actor values; it heals eventually, in an
		//    amount that depends on your max health and how long you live. It
		//    belongs in the pool (you do carry it, and it is better than
		//    nothing) but never ahead of a potion that answers the deficit now,
		//    so it rides its own lower TIER.
		//
		// Detrimental effects never count anywhere: a "Potion of Health Damage"
		// from a poison-crafting mod must not become somebody's emergency heal.
		enum class PoolTier : int
		{
			kNone    = 0,
			kRegen   = 1,  // lifts the regen rate — helps later, not now
			kRestore = 2,  // puts points back into the pool itself
		};

		struct PoolEval
		{
			PoolTier tier   = PoolTier::kNone;
			float    points = 0.0f;  // points restored (kRestore), else the
			                         // regen effect's own magnitude x duration
		};

		// The vanilla alchemy keywords. Verified against the real Skyrim.esm
		// KYWD group on 2026-08-19 (tools/dump_records.py … KYWD --match
		// MagicAlch): the Restore/Fortify pairs exist for all three pools, and
		// there is NO cure-disease keyword — which is why cure stays on its
		// archetype below. A keyword is the AUTHOR'S OWN word about what a
		// potion is, so it outranks every heuristic here; overhaul mods keep
		// them, which is what makes this work on Requiem/CACO/Apothecary.
		const char* RestoreKeywordOf(const std::string& ref)
		{
			return ref == "heal"    ? "MagicAlchRestoreHealth" :
			       ref == "magicka" ? "MagicAlchRestoreMagicka" :
			       ref == "stamina" ? "MagicAlchRestoreStamina" : nullptr;
		}
		const char* FortifyKeywordOf(const std::string& ref)
		{
			return ref == "heal"    ? "MagicAlchFortifyHealth" :
			       ref == "magicka" ? "MagicAlchFortifyMagicka" :
			       ref == "stamina" ? "MagicAlchFortifyStamina" : nullptr;
		}

		// The pool's three actor values: the pool itself, and the two regen
		// values Skyrim splits regeneration across (flat rate and percentage).
		bool PoolAvs(const std::string& ref, RE::ActorValue& want,
			RE::ActorValue& rate, RE::ActorValue& rateMult)
		{
			using AV = RE::ActorValue;
			if (ref == "heal") {
				want = AV::kHealth;  rate = AV::kHealRate;    rateMult = AV::kHealRateMult;
			} else if (ref == "magicka") {
				want = AV::kMagicka; rate = AV::kMagickaRate; rateMult = AV::kMagickaRateMult;
			} else if (ref == "stamina") {
				want = AV::kStamina; rate = AV::kStaminaRate; rateMult = AV::kStaminaRateMult;
			} else {
				return false;
			}
			return true;
		}

		PoolEval EvalPool(const std::string& ref, const RE::AlchemyItem* alch)
		{
			PoolEval out;
			if (!alch || alch->IsFood() || alch->IsPoison())
				return out;

			// Cure disease has no dose and no deficit — it either cures or it
			// does not, so every cure potion is worth exactly the same 1.
			if (ref == "cure") {
				for (auto* effect : alch->effects) {
					auto* base = effect ? effect->baseEffect : nullptr;
					if (!base || base->IsDetrimental())
						continue;
					if (base->GetArchetype() == RE::EffectSetting::Archetype::kCureDisease) {
						out.tier   = PoolTier::kRestore;
						out.points = 1.0f;
						return out;
					}
				}
				return out;
			}

			RE::ActorValue want{}, rate{}, rateMult{};
			if (!PoolAvs(ref, want, rate, rateMult))
				return out;
			const char* restoreKw = RestoreKeywordOf(ref);
			const char* fortifyKw = FortifyKeywordOf(ref);

			float bestRestore = 0.0f, bestRegen = 0.0f;
			for (auto* effect : alch->effects) {
				auto* base = effect ? effect->baseEffect : nullptr;
				if (!base || base->IsDetrimental())
					continue;
				const float mag = effect->effectItem.magnitude;
				if (mag <= 0.0f)
					continue;
				const float dur = static_cast<float>(effect->effectItem.duration);

				const bool avDirect = base->data.primaryAV == want ||
				                      base->data.secondaryAV == want;
				const bool avRate = base->data.primaryAV == rate ||
				                    base->data.secondaryAV == rate ||
				                    base->data.primaryAV == rateMult ||
				                    base->data.secondaryAV == rateMult;
				if (!avDirect && !avRate)
					continue;

				// Regen first: a rate effect is a regen effect whatever else it
				// carries, and every vanilla one is ALSO a fortify (it reverts),
				// so the fortify test below must not eat it.
				if (avRate) {
					bestRegen = std::max<float>(bestRegen, mag * std::max<float>(dur, 1.0f));
					continue;
				}

				// Direct on the pool: restore unless the engine or the author
				// says it is a fortify.
				const bool recovers = base->data.flags.all(
					RE::EffectSetting::EffectSettingData::Flag::kRecover);
				const bool saysRestore = restoreKw && base->HasKeywordString(restoreKw);
				const bool saysFortify = fortifyKw && base->HasKeywordString(fortifyKw);
				if (!saysRestore && (saysFortify || recovers))
					continue;

				// Duration 0 is an instant dose; a duration means the magnitude
				// is per second, so the dose is magnitude x duration.
				bestRestore = std::max<float>(bestRestore, dur > 0.0f ? mag * dur : mag);
			}

			if (bestRestore > 0.0f) {
				out.tier   = PoolTier::kRestore;
				out.points = bestRestore;
			} else if (bestRegen > 0.0f) {
				out.tier   = PoolTier::kRegen;
				out.points = bestRegen;
			}
			return out;
		}

		bool SmartMatches(const std::string& ref, const RE::AlchemyItem* alch, float& outScore)
		{
			const auto ev = EvalPool(ref, alch);
			outScore = ev.points;
			return ev.tier != PoolTier::kNone;
		}

		// ---- the prefs, cached on THIS side of the wall -----------------------
		// They are edited in the potion browser and persist in the widgets
		// sidecar, but the picker must never call back into that module: the
		// Potion AI already calls FireSmart from inside its own tick, and a
		// return call under the other module's lock is how deadlocks get
		// written. Widgets pushes them here instead (SetSmartPrefs) and this
		// mutex is a LEAF — nothing under it calls anything that could come back.
		std::mutex g_smartMx;
		SmartPrefs g_smartPrefs{};
		// Resolved once and shared by pointer, so a pick costs one lock and a
		// refcount bump rather than copying a set per potion.
		std::shared_ptr<const std::unordered_set<RE::FormID>> g_smartExcl;
		bool                                                  g_smartExclDirty = true;

		std::uint32_t ParseLocalId(const std::string& s)
		{
			const char* p = s.c_str();
			if (s.size() > 2 && p[0] == '0' && (p[1] == 'x' || p[1] == 'X'))
				p += 2;
			return static_cast<std::uint32_t>(std::strtoul(p, nullptr, 16));
		}

		std::shared_ptr<const std::unordered_set<RE::FormID>> ExcludedSet()
		{
			std::lock_guard l(g_smartMx);
			if (!g_smartExclDirty && g_smartExcl)
				return g_smartExcl;
			auto set = std::make_shared<std::unordered_set<RE::FormID>>();
			auto* dh = RE::TESDataHandler::GetSingleton();
			for (const auto& key : g_smartPrefs.exclude) {
				const auto bar = key.find('|');
				if (bar == std::string::npos || !dh)
					continue;
				const std::string plugin = key.substr(0, bar);
				auto* form = dh->LookupForm(ParseLocalId(key.substr(bar + 1)), plugin);
				if (form)
					set->insert(form->GetFormID());  // a form whose mod is off
			}                                        // simply never matches
			g_smartExcl = set;
			// Only stop re-resolving once there WAS a data handler to resolve
			// against — before kDataLoaded every lookup would fail and cache an
			// empty set forever.
			if (dh)
				g_smartExclDirty = false;
			return g_smartExcl;
		}

		// PERF (2026-08-16, round two): the inventory map, so ONE enumeration can
		// answer every row of a LiveJson pass instead of one per slot. Spelled as
		// a decltype of the real call rather than a hand-written typedef — the
		// map's mapped_type holds a unique_ptr and CommonLib owns its exact shape.
		using InvMap = decltype(RE::PlayerCharacter::GetSingleton()->GetInventory());

		// ---- how much of the pool is missing ----------------------------------
		// cur = GetActorValue, max = GetPermanentActorValue: the char sheet's
		// own Pool() split, used here so the bar you are looking at and the
		// potion you get can never disagree about "22%". A pool with no deficit
		// concept ("cure") answers -1, which every caller reads as "not sized".
		bool PoolLevels(const std::string& ref, float& outCur, float& outMax)
		{
			RE::ActorValue want{}, rate{}, rateMult{};
			if (!PoolAvs(ref, want, rate, rateMult))
				return false;
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* avo    = player ? player->AsActorValueOwner() : nullptr;
			if (!avo)
				return false;
			outMax = avo->GetPermanentActorValue(want);
			outCur = avo->GetActorValue(want);
			return outMax > 0.0f;
		}

		float PoolDeficitOf(const std::string& ref)
		{
			float cur = 0.0f, max = 0.0f;
			if (!PoolLevels(ref, cur, max))
				return -1.0f;
			return std::max<float>(0.0f, max - cur);
		}

		float PoolPercent(const std::string& ref)
		{
			float cur = 0.0f, max = 0.0f;
			if (!PoolLevels(ref, cur, max))
				return -1.0f;
			return std::clamp((cur / max) * 100.0f, 0.0f, 100.0f);
		}

		// One carried potion that feeds the pool.
		struct Candidate
		{
			RE::AlchemyItem* item   = nullptr;
			std::int32_t     count  = 0;
			float            points = 0.0f;
			PoolTier         tier   = PoolTier::kNone;
			bool             barred = false;  // on the user's exclusion list
		};

		// What a pick answers with. `best` is the potion to DRINK — which since
		// 2026-08-19 is not necessarily the strongest — while `strongest` stays
		// available for anything that wants to describe the pool rather than act
		// on it (the census below).
		struct SmartHit
		{
			RE::AlchemyItem* best      = nullptr;  // the chosen potion
			std::int32_t     bestCount = 0;        // how many of THAT potion
			std::int32_t     total     = 0;        // every matching potion, all tiers
			float            score     = 0.0f;     // the chosen potion's points
			RE::AlchemyItem* strongest = nullptr;
			float            topScore  = 0.0f;
			bool             overheal  = false;    // the pick restores more than is missing
			const char*      refusal   = nullptr;  // set when matches exist but none may be drunk
		};

		// Every candidate in an ALREADY-BUILT inventory map. Entries the caller
		// pulled in for the item slots are simply not AlchemyItems, so EvalPool
		// rejects them on its own null check — a wider filter cannot change a
		// count. Exclusions are RECORDED, not dropped: the pool total stays
		// honest about what you carry, and the picker skips them later.
		void CollectCandidates(const InvMap& inv, const std::string& ref,
			const std::unordered_set<RE::FormID>& barred,
			std::vector<Candidate>& out, std::int32_t& outTotal)
		{
			outTotal = 0;
			for (const auto& [obj, data] : inv) {
				if (data.first <= 0)
					continue;
				auto* alch = obj ? obj->As<RE::AlchemyItem>() : nullptr;
				const auto ev = EvalPool(ref, alch);
				if (ev.tier == PoolTier::kNone)
					continue;
				outTotal += data.first;
				out.push_back(Candidate{ alch, data.first, ev.points, ev.tier,
					barred.find(alch->GetFormID()) != barred.end() });
			}
		}

		// Is a better than b, all else being equal? Bigger stack first (use up
		// what you have most of), then the cheaper potion (keep the rare one for
		// when it is the right answer). Deterministic: two potions that tie on
		// all three are ordered by form id, never by inventory-map order, so the
		// same bag always makes the same pick.
		bool Cheaper(const Candidate& a, const Candidate& b)
		{
			if (a.count != b.count)
				return a.count > b.count;
			const auto av = a.item->GetGoldValue(), bv = b.item->GetGoldValue();
			if (av != bv)
				return av < bv;
			return a.item->GetFormID() < b.item->GetFormID();
		}

		// THE PICK (2026-08-19). `deficit` is how many points are missing, or a
		// negative number for a pool with no deficit concept ("cure"), which
		// falls straight through to "the first one you carry".
		//
		//   under = the biggest potion that fits INSIDE the deficit — nothing
		//           is wasted, but you may not be topped up.
		//   over  = the smallest potion that COVERS the deficit — you end up
		//           full, at the cost of whatever spills over.
		//
		// Which one wins is the player's call (preferOverheal), except when the
		// pool is desperate, where the answer is not in doubt: at 12% health the
		// cheapest sip that "wastes nothing" can still get you killed, so
		// emergencyPct flips the preference for exactly as long as it holds.
		// A regeneration potion is only ever reached for when no restore potion
		// is carried at all.
		SmartHit PickFrom(std::vector<Candidate>& cands, float deficit,
			float poolPct, const SmartPrefs& prefs, std::int32_t total)
		{
			SmartHit out;
			out.total = total;

			// The strongest of everything carried, exclusions and all — this is
			// a description of the bag, not a choice, so nothing is filtered.
			for (const auto& c : cands) {
				if (!out.strongest || c.points > out.topScore) {
					out.strongest = c.item;
					out.topScore  = c.points;
				}
			}

			std::vector<const Candidate*> usable;
			usable.reserve(cands.size());
			for (const auto& c : cands)
				if (!c.barred)
					usable.push_back(&c);
			if (usable.empty()) {
				if (!cands.empty())
					out.refusal = "every one you carry is set to never be picked";
				return out;
			}

			// Restore potions answer a deficit; regen potions do not, so they
			// are only considered when there is no restore potion at all.
			const bool haveRestore = std::any_of(usable.begin(), usable.end(),
				[](const Candidate* c) { return c->tier == PoolTier::kRestore; });
			const auto eligible = [haveRestore](const Candidate* c) {
				return haveRestore ? c->tier == PoolTier::kRestore : true;
			};

			const auto take = [&out, deficit](const Candidate* c) {
				out.best      = c->item;
				out.bestCount = c->count;
				out.score     = c->points;
				out.overheal  = deficit > 0.0f && c->points > deficit;
			};

			// Strongest-wins: the pre-2026-08-19 behaviour, kept whole.
			if (!prefs.optimal || deficit <= 0.0f) {
				const Candidate* pick = nullptr;
				for (const auto* c : usable) {
					if (!eligible(c))
						continue;
					if (!pick || c->points > pick->points ||
						(c->points == pick->points && Cheaper(*c, *pick)))
						pick = c;
				}
				if (pick)
					take(pick);
				return out;
			}

			const Candidate *under = nullptr, *over = nullptr;
			for (const auto* c : usable) {
				if (!eligible(c))
					continue;
				if (c->points <= deficit &&
					(!under || c->points > under->points ||
						(c->points == under->points && Cheaper(*c, *under))))
					under = c;
				if (c->points >= deficit &&
					(!over || c->points < over->points ||
						(c->points == over->points && Cheaper(*c, *over))))
					over = c;
			}

			const bool emergency = prefs.emergencyPct > 0 &&
			                       poolPct >= 0.0f &&
			                       poolPct <= static_cast<float>(prefs.emergencyPct);
			const bool wantOver = prefs.allowOverheal && (prefs.preferOverheal || emergency);

			if (wantOver && over)
				take(over);
			else if (under)
				take(under);
			else if (over && prefs.allowOverheal)
				take(over);
			else if (over)
				out.refusal = "the only ones left would overheal, and that is turned off";
			return out;
		}

		// The census: what the bag HOLDS, with no pick and no rules applied.
		// This is what the widgets and the potion browser describe, which is why
		// it deliberately ignores exclusions and the deficit.
		SmartHit SmartCensusIn(const InvMap& inv, const std::string& ref)
		{
			std::vector<Candidate> cands;
			std::int32_t           total = 0;
			CollectCandidates(inv, ref, {}, cands, total);
			SmartHit out;
			out.total = total;
			for (const auto& c : cands) {
				if (!out.best || c.points > out.score) {
					out.best      = c.item;
					out.bestCount = c.count;
					out.score     = c.points;
				}
			}
			out.strongest = out.best;
			out.topScore  = out.score;
			return out;
		}

		// The pick over an already-built map — what the hotbar's live rows use,
		// so the face on the button names the potion the button would actually
		// drink. MAIN THREAD ONLY (it reads the player's actor values).
		SmartHit SmartFindIn(const InvMap& inv, const std::string& ref)
		{
			const auto             excl = ExcludedSet();
			std::vector<Candidate> cands;
			std::int32_t           total = 0;
			CollectCandidates(inv, ref, *excl, cands, total);
			return PickFrom(cands, PoolDeficitOf(ref), PoolPercent(ref), GetSmartPrefs(), total);
		}

		// The stand-alone form, for the one-shot callers (FireSmart at press
		// time) that have no shared map to ride.
		SmartHit SmartFind(RE::PlayerCharacter* player, const std::string& ref)
		{
			if (!player)
				return SmartHit{};
			return SmartFindIn(player->GetInventory([](RE::TESBoundObject& o) {
				return o.Is(RE::FormType::AlchemyItem);
			}), ref);
		}

		const char* SmartLabel(const std::string& ref)
		{
			return ref == "heal"    ? "healing potion" :
			       ref == "magicka" ? "magicka potion" :
			       ref == "stamina" ? "stamina potion" :
			       ref == "cure"    ? "cure disease potion" : "potion";
		}

		// What the pool is called in a sentence about the PLAYER rather than
		// about a potion ("your health is already full").
		const char* PoolNoun(const std::string& ref)
		{
			return ref == "heal"    ? "health" :
			       ref == "magicka" ? "magicka" :
			       ref == "stamina" ? "stamina" : "";
		}

		// Count + worn state for one object, read out of the shared map. The old
		// form built a whole std::map per call from a full inventory walk purely
		// to find a single entry — once per item slot, up to 5 times a second.
		// Absent from the map means "not carried", which is the same answer the
		// walk gave when its filter matched nothing.
		void InventoryStateIn(const InvMap& inv, RE::TESBoundObject* obj,
			std::int32_t& outCount, bool& outWorn)
		{
			outCount = 0;
			outWorn  = false;
			if (!obj)
				return;
			const auto it = inv.find(obj);
			if (it == inv.end())
				return;
			outCount = it->second.first;
			outWorn  = it->second.second && it->second.second->IsWorn();
		}
	}

	int Config::VisibleSlots() const
	{
		// ⚠ std::max<int>, never a bare std::max: windows.h defines a function-like
		// `max(a,b)` macro, so `std::max(` expands to `std::(...)` and the file
		// stops compiling with a baffling "illegal token on right side of '::'".
		// The explicit template argument puts a `<` after the name, which a
		// function-like macro will not expand — the form every other file here
		// already uses.
		const int n = std::max<int>(1, cols) * std::max<int>(1, rows);
		return std::clamp(n, 1, kMaxSlots);
	}

	int PageForMods(const Config& c, bool shift, bool ctrl, bool alt)
	{
		// Fixed precedence, deliberately: with shift+ctrl both down the player
		// must always land on the same page, or the bar is a coin flip mid-fight.
		const auto live = [&c](int idx) {
			return idx >= 0 && idx < static_cast<int>(c.pages.size()) && c.pages[idx].enabled;
		};
		if (shift && live(kPageShift))
			return kPageShift;
		if (ctrl && live(kPageCtrl))
			return kPageCtrl;
		if (alt && live(kPageAlt))
			return kPageAlt;
		return kPageBase;
	}

	namespace
	{
		json SlotToJson(const Slot& s)
		{
			json o{
				{ "kind", s.kind },
				{ "plugin", s.plugin },
				{ "localId", s.localId },
				{ "formId", s.formId },
			};
			if (!s.refId.empty()) o["refId"] = s.refId;
			if (!s.label.empty()) o["label"] = s.label;
			if (!s.icon.empty())  o["icon"]  = s.icon;
			if (s.kind == "flyout") {
				json kids = json::array();
				for (const auto& c : s.items)
					kids.push_back(SlotToJson(c));   // children are never flyouts (FromJson)
				o["items"] = std::move(kids);
			}
			return o;
		}
	}

	json ToJson(const Config& c)
	{
		json pages = json::array();
		for (const auto& p : c.pages) {
			json slots = json::array();
			for (const auto& s : p.slots) {
				// An empty slot is written as an empty object, not omitted: the
				// array index IS the button number, so a compacted array would
				// silently shift every action left of a hole.
				// A flyout is written even when EMPTY of children — an empty
				// bundle you just made must survive the round-trip, or the
				// editor's "new flyout" would vanish on the next save.
				if (s.Empty() && s.kind != "flyout") {
					slots.push_back(json::object());
					continue;
				}
				slots.push_back(SlotToJson(s));
			}
			pages.push_back(json{
				{ "enabled", p.enabled },
				{ "name", p.name },
				{ "slots", std::move(slots) },
			});
		}

		json keys = json::array();
		for (const auto& k : c.slotKeys)
			keys.push_back(json{ { "device", k.device }, { "code", k.code }, { "label", k.label } });

		return json{
			{ "enabled", c.enabled },
			{ "visible", c.visible },
			{ "x", c.x }, { "y", c.y }, { "scale", c.scale }, { "opacity", c.opacity },
			{ "orient", ClampOrient(c.orient) },
			{ "anchorH", ClampAnchorH(c.anchorH) },
			{ "side", ClampSide(c.side) },
			{ "anchorV", ClampAnchorV(c.anchorV) },
			{ "cols", c.cols }, { "rows", c.rows },
			{ "showKeys", c.showKeys },
			{ "showLabels", c.showLabels },
			{ "showCounts", c.showCounts },
			{ "showEmpty", c.showEmpty },
			{ "showPages", c.showPages },
			{ "showOutline", c.showOutline },
			{ "showGrip", c.showGrip },
			{ "gripPos", ClampGripPos(c.gripPos) },
			{ "idleMs", c.idleMs },
			{ "idleAlpha", c.idleAlpha },
			{ "uiScale", c.uiScale },
			{ "showMode", ClampShowMode(c.showMode) },
			{ "lingerMs", c.lingerMs },
			{ "hideInMenus", c.hideInMenus },
			{ "skin", ClampSkin(c.skin) },
			{ "modHold", c.modHold },
			{ "tickMs", c.tickMs },
			{ "pages", std::move(pages) },
			{ "slotKeys", std::move(keys) },
			{ "key", json{
				{ "device", c.keyDevice },
				{ "code", c.keyCode },
				{ "label", c.keyLabel },
			} },
		};
	}

	void FromJson(const json& j, Config& out)
	{
		if (!j.is_object())
			return;

		out.enabled = j.value("enabled", out.enabled);
		out.visible = j.value("visible", out.visible);
		out.x = j.value("x", out.x);
		out.y = j.value("y", out.y);
		out.scale = std::clamp(j.value("scale", out.scale), 0.4f, 3.0f);
		out.opacity = std::clamp(j.value("opacity", out.opacity), 0.3f, 1.0f);
		out.orient = ClampOrient(j.value("orient", out.orient));
		out.anchorH = ClampAnchorH(j.value("anchorH", out.anchorH));
		out.side    = ClampSide(j.value("side", out.side));
		out.anchorV = ClampAnchorV(j.value("anchorV", out.anchorV));
		out.rows = std::clamp(j.value("rows", out.rows), 1, 2);
		// cols is clamped against the ROW COUNT so cols*rows can never exceed the
		// stored slot capacity — otherwise the view would draw buttons that have
		// no slot behind them and every press past the end would be a no-op.
		out.cols = std::clamp(j.value("cols", out.cols), 1, kMaxSlots / out.rows);
		out.showKeys = j.value("showKeys", out.showKeys);
		out.showLabels = j.value("showLabels", out.showLabels);
		out.showCounts = j.value("showCounts", out.showCounts);
		out.showEmpty = j.value("showEmpty", out.showEmpty);
		out.showPages = j.value("showPages", out.showPages);
		out.showOutline = j.value("showOutline", out.showOutline);
		out.showGrip = j.value("showGrip", out.showGrip);
		out.gripPos = ClampGripPos(j.value("gripPos", out.gripPos));
		// Build marker (hd-markers.json: "hotbar-chrome") — the hide-the-chrome
		// toggles + pinnable grip (Rober, 2026-08-14). Debug level: it fires on
		// every config parse, but the literal is what the deploy check greps for.
		logger::debug("hotbar-chrome: pages={} outline={} grip={} gripPos={}",
			out.showPages, out.showOutline, out.showGrip, out.gripPos);
		out.idleMs = j.value("idleMs", out.idleMs);
		out.idleAlpha = std::clamp(j.value("idleAlpha", out.idleAlpha), 0.05f, 1.0f);
		// Floor 1.0, not 0.8: this slider exists to make the editor BIGGER.
		// Letting it shrink would put the panel's type back under the readable
		// floor the rest of this pass just established.
		out.uiScale = std::clamp(j.value("uiScale", out.uiScale), 1.0f, 2.0f);
		out.showMode = ClampShowMode(j.value("showMode", out.showMode));
		// Capped at a minute: a "linger" long enough to outlast the fight is
		// indistinguishable from "always", and would read as the setting being
		// broken rather than as a very patient timer.
		out.lingerMs = std::min<std::uint32_t>(60000, j.value("lingerMs", out.lingerMs));
		out.hideInMenus = j.value("hideInMenus", out.hideInMenus);
		out.skin = ClampSkin(j.value("skin", out.skin));
		out.modHold = j.value("modHold", out.modHold);
		out.tickMs = std::max<std::uint32_t>(200, j.value("tickMs", out.tickMs));

		if (j.contains("key") && j["key"].is_object()) {
			const auto& k = j["key"];
			out.keyDevice = k.value("device", out.keyDevice);
			out.keyCode = k.value("code", out.keyCode);
			out.keyLabel = k.value("label", out.keyLabel);
		}

		// ---- pages ---------------------------------------------------------
		// Always exactly kPageCount pages of exactly kMaxSlots slots after this,
		// whatever the file said. Every reader downstream (the view, the input
		// sink, LiveJson) indexes positionally, so a short array read from a
		// hand-edited or older file must be GROWN here rather than guarded
		// against in four places.
		std::vector<Page> pages;
		if (j.contains("pages") && j["pages"].is_array()) {
			for (const auto& jp : j["pages"]) {
				Page p;
				if (jp.is_object()) {
					p.enabled = jp.value("enabled", false);
					p.name = jp.value("name", std::string());
					if (jp.contains("slots") && jp["slots"].is_array()) {
						for (const auto& js : jp["slots"]) {
							Slot s;
							if (js.is_object()) {
								s.kind = ClampKind(js.value("kind", std::string()));
								s.plugin = js.value("plugin", std::string());
								s.localId = js.value("localId", 0u);
								s.formId = js.value("formId", 0u);
								s.refId = js.value("refId", std::string());
								s.label = js.value("label", std::string());
								s.icon = js.value("icon", std::string());
								if (s.kind == "flyout" && js.contains("items") && js["items"].is_array()) {
									for (const auto& jc : js["items"]) {
										if (!jc.is_object())
											continue;
										Slot c;
										c.kind = ClampChildKind(jc.value("kind", std::string()));
										c.plugin = jc.value("plugin", std::string());
										c.localId = jc.value("localId", 0u);
										c.formId = jc.value("formId", 0u);
										c.refId = jc.value("refId", std::string());
										c.label = jc.value("label", std::string());
										c.icon = jc.value("icon", std::string());
										// a child that clamped to nothing (it was a
										// nested flyout, or garbage) is dropped, not
										// kept as a dead fan tile
										if (c.Empty())
											continue;
										if (static_cast<int>(s.items.size()) < kMaxFlyItems)
											s.items.push_back(std::move(c));
									}
								}
							}
							if (static_cast<int>(p.slots.size()) < kMaxSlots)
								p.slots.push_back(std::move(s));
						}
					}
				}
				if (static_cast<int>(pages.size()) < kPageCount)
					pages.push_back(std::move(p));
			}
		}
		while (static_cast<int>(pages.size()) < kPageCount)
			pages.push_back(Page{});
		for (auto& p : pages)
			p.slots.resize(kMaxSlots);
		// The base page is not optional — nothing would draw.
		pages[kPageBase].enabled = true;
		out.pages = std::move(pages);

		// ---- per-slot keys --------------------------------------------------
		std::vector<SlotKey> keys;
		if (j.contains("slotKeys") && j["slotKeys"].is_array()) {
			for (const auto& jk : j["slotKeys"]) {
				SlotKey k;
				if (jk.is_object()) {
					k.device = jk.value("device", std::string("keyboard")) == "mouse" ? "mouse" : "keyboard";
					k.code = jk.value("code", 0u);
					k.label = jk.value("label", std::string());
				}
				if (static_cast<int>(keys.size()) < kMaxSlots)
					keys.push_back(std::move(k));
			}
		}
		keys.resize(kMaxSlots);
		out.slotKeys = std::move(keys);
	}

	void SeedDefaults(Config& out)
	{
		out.pages.assign(kPageCount, Page{});
		for (auto& p : out.pages)
			p.slots.resize(kMaxSlots);
		out.pages[kPageBase].enabled = true;
		out.pages[kPageBase].name  = "Main";
		out.pages[kPageShift].name = "Shift";
		out.pages[kPageCtrl].name  = "Ctrl";
		out.pages[kPageAlt].name   = "Alt";

		// 1..8 on the number row — the WoW muscle memory, and the shape Rober
		// asked for. DIK 0x02..0x09 are '1'..'8'.
		//
		// ⚠ These are also VANILLA's favourites hotkeys, and this plugin's input
		// sink cannot consume events (see the note in OpenKeySink) — so with a
		// vanilla favourite assigned to the same number BOTH fire. The edit
		// panel says so out loud and offers the numpad as a one-click
		// alternative; seeding the obvious keys and warning beats seeding
		// obscure ones nobody would have guessed.
		out.slotKeys.assign(kMaxSlots, SlotKey{});
		for (int i = 0; i < 8; ++i) {
			out.slotKeys[i].device = "keyboard";
			out.slotKeys[i].code   = static_cast<std::uint32_t>(0x02 + i);
			out.slotKeys[i].label  = std::to_string(i + 1);
		}

		out.cols = 8;
		out.rows = 1;
	}

	namespace
	{
		// remaining/total seconds of the player's active effects, keyed by the
		// MagicItem that produced them — the spell you cast, the potion you
		// drank. Built ONCE per LiveJson tick and shared by every row.
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
				// duration 0 = constant/ability — nothing to count down
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

		// PERF (2026-08-16) — the reason HbPushLive's diff-gate never fired.
		//
		// The gate compares the whole live payload against the last one and skips
		// the Invoke when they match. A countdown emitted at 0.1 s resolution
		// differs on EVERY tick, so from the moment any buff or shout cooldown was
		// running the bar rebuilt itself ~1.4 times a second, forever — measured
		// view-side at 40 elements + 7 images per tick. Quantising the volatile
		// value is what lets an unchanged tick actually be recognised as unchanged.
		//
		// The step is ~1% OF THE EFFECT'S OWN DURATION, which is precisely the
		// resolution the ring can display (it draws a fraction of a circle), so
		// the ring is visually identical — it already steps at the tick, never
		// animates. Two clamps make that safe at both extremes:
		//   * floor 0.5 s — the push interval is max(200, tickMs) = 700 ms by
		//     default, so a step under ~0.7 s carries NO information the player
		//     can see anyway. Quantising to 0.5 s is therefore visually free.
		//   * under 10 s the view swaps the ring for COUNTDOWN DIGITS, and digits
		//     jumping "6 … 3 … 0" would be plainly wrong — so the last 10 seconds
		//     always use the fine floor regardless of duration.
		//   * ceiling 5 s so a 30-minute buff cannot produce an 18 s step.
		// FLOOR, not round: the bar must never claim more time than remains.
		//
		// Payoff scales with how long the buff runs, which is exactly right — a
		// 300 s alchemy buff steps every 3 s (≈77% of pushes suppressed) while a
		// 10 s buff keeps 0.5 s steps and costs a handful of ticks.
		float QuantiseCountdown(float rem, float scale)
		{
			if (rem <= 0.0f)
				return 0.0f;
			float step = 0.5f;
			if (rem >= 10.0f) {
				step = scale / 100.0f;
				if (step < 0.5f)
					step = 0.5f;
				else if (step > 5.0f)
					step = 5.0f;
			}
			return std::floor(rem / step) * step;
		}

		void AttachFx(json& row, const FxMap& fx, const RE::MagicItem* mi)
		{
			if (!mi)
				return;
			if (auto it = fx.find(mi); it != fx.end()) {
				// fxDur is the effect's TOTAL and never moves for a given effect,
				// so it needs no quantising — only the remainder is volatile.
				const float dur = it->second.second;
				const float rem = QuantiseCountdown(it->second.first, dur);
				// one decimal is plenty — the view redraws each tick anyway
				row["fxRem"] = static_cast<double>(static_cast<int>(rem * 10)) / 10.0;
				row["fxDur"] = static_cast<double>(static_cast<int>(dur * 10)) / 10.0;
			}
		}

		// Slot -> the form it resolved to, built ONCE by LiveJson's pre-pass.
		// ResolveForm is not free — ActorIdentity::Resolve ends in
		// TESDataHandler::LookupForm, which scans the file collection by NAME, and
		// this load order has 4,343 plugins. The pre-pass has to resolve the item
		// slots anyway (to know which objects the inventory filter must admit), so
		// the answer is kept and handed back rather than computed a second time.
		// Slot addresses are stable for the whole call: `c` is the caller's own
		// copy and nothing here mutates it.
		using FormCache = std::unordered_map<const Slot*, RE::TESForm*>;

		// One slot's live row. Shared between the bar's buttons and a flyout's
		// CHILDREN — the fan draws the same icons, counts and grey-outs as the
		// bar itself, from the same code, so the two can never disagree.
		void FillLiveRow(json& row, const Slot& s, RE::PlayerCharacter* player,
			const FxMap& fx, float voiceCd, const InvMap& inv, const FormCache& forms)
		{
			row["kind"] = s.kind;
			if (!s.icon.empty())
				row["icon"] = s.icon;
			if (!s.label.empty())
				row["label"] = s.label;

			// A smart button re-picks its potion every tick, so the face always
			// names what WOULD be drunk right now — and the count is the whole
			// pool, not one tier, which is the honesty the button exists for.
			if (s.kind == "smart") {
				const auto hit = SmartFindIn(inv, s.refId);
				row["smart"] = s.refId;
				row["ok"] = hit.best != nullptr;
				row["count"] = hit.total;
				if (hit.best) {
					if (const char* nm = hit.best->GetName(); nm && *nm)
						row["name"] = nm;
					AttachFx(row, fx, hit.best);
				} else if (hit.refusal) {
					// Carried, but the rules bar every one of them — a button
					// that greys out with "none in your bag" while the bag is
					// full of them is the kind of lie this codebase does not
					// ship.
					row["msg"] = std::string("No ") + SmartLabel(s.refId) +
						" you can drink — " + hit.refusal;
				} else {
					row["msg"] = std::string("No ") + SmartLabel(s.refId) + " in your bag";
				}
				return;
			}

			// A deck entry or a combo is not a form — it is resolved deck-side,
			// by the same id the Favorites Shelf pins use. Report it as present
			// and let the fire path answer honestly if it has since been
			// deleted; walking the whole entry list on every 700 ms tick to
			// pre-verify it would cost more than the honesty is worth.
			if (s.kind == "entry" || s.kind == "combo") {
				row["ok"] = true;
				row["refId"] = s.refId;
				return;
			}

			// Pre-pass answer when there is one; the direct resolve is the
			// fallback, so a slot the pre-pass never saw still reports honestly
			// instead of greying out for the wrong reason.
			const auto  cached = forms.find(&s);
			RE::TESForm* form  = cached != forms.end() ? cached->second : ResolveForm(s);
			if (!form) {
				row["ok"] = false;
				row["msg"] = "Its mod is off, or the form is gone";
				return;
			}

			// The live name always travels, even when a label override exists —
			// the edit UI shows it as "really: <name>" so a stale override is
			// visible rather than quietly wrong.
			if (const char* nm = form->GetName(); nm && *nm)
				row["name"] = nm;
			row["plugin"] = s.plugin;
			row["localId"] = s.localId;

			if (s.kind == "spell") {
				// "Known" is the honest gate for a spell button: an unlearned
				// spell would cast nothing and the player would blame the bar.
				// Shouts live in a different list, so both are checked.
				bool known = false;
				if (player) {
					if (auto* sp = form->As<RE::SpellItem>())
						known = KnowsSpell(player, sp);
					else if (auto* sh = form->As<RE::TESShout>())
						known = player->HasShout(sh);
				}
				row["ok"] = known;
				if (!known)
					row["msg"] = "You don't know this any more";
				// School / element / tier hints let the VIEW pick a generic icon
				// with the Spell Deck's own resolve chain when no override is
				// set — which is why they ride along on every tick.
				if (auto* sp = form->As<RE::SpellItem>()) {
					// "Voice slot" is SpellActions' own definition, inverted from
					// its IsHandSpell: anything that is not a plain kSpell goes
					// through the game's Shout key rather than the instant caster.
					// Same rule both sides, so the ring the bar draws matches the
					// road the cast actually takes.
					row["voice"] = sp->GetSpellType() != RE::MagicSystem::SpellType::kSpell;
					AttachFx(row, fx, sp);
				} else if (form->As<RE::TESShout>()) {
					row["voice"] = true;
				}
				// One shared voice recovery — the engine has exactly one shout
				// timer, so every voice button shows the same countdown. A shout
				// buff's remaining time can't be matched by form (the active
				// effect belongs to the WORD's spell, not the shout), so the
				// cooldown is the honest thing voice buttons get.
				if (row.value("voice", false) && voiceCd > 0.0f)
					row["cd"] = static_cast<double>(static_cast<int>(voiceCd * 10)) / 10.0;
			} else if (s.kind == "item") {
				auto* obj = form->As<RE::TESBoundObject>();
				std::int32_t count = 0;
				bool         worn  = false;
				InventoryStateIn(inv, obj, count, worn);
				row["count"] = count;
				row["equipped"] = worn;
				row["ok"] = count > 0;
				if (count <= 0)
					row["msg"] = "You aren't carrying it";
				// a drunk potion's regen effect counts down on its own button
				if (auto* alch = form->As<RE::AlchemyItem>())
					AttachFx(row, fx, alch);
			} else {
				row["ok"] = true;
			}
		}
	}

	std::string LiveJson(const Config& c, int page)
	{
		json arr = json::array();
		const int p = std::clamp(page, 0, kPageCount - 1);
		if (p >= static_cast<int>(c.pages.size()))
			return json{ { "page", p }, { "slots", arr } }.dump(-1, ' ', false, json::error_handler_t::replace);

		auto*     player = RE::PlayerCharacter::GetSingleton();
		const int shown  = c.VisibleSlots();
		const auto& slots = c.pages[p].slots;

		const FxMap fx = ReadActiveFx(player);
		float voiceCd = 0.0f;
		if (player) {
			if (auto* proc = player->GetActorRuntimeData().currentProcess) {
				if (proc->high)
					voiceCd = proc->high->voiceRecoveryTime;
			}
		}
		// Quantised HERE, once, rather than per row: the engine has exactly one
		// shout timer, so quantising at the source keeps every voice button in
		// agreement by construction. Same reason as AttachFx — an unquantised
		// countdown made HbPushLive's diff-gate useless for the whole cooldown.
		//
		// The ring's 100% for a cooldown is whatever the view saw FIRST (there is
		// no engine-side total for shout recovery), so the scale is the largest cd
		// observed this session — the same self-correcting rule the view uses. A
		// longer shout simply raises it. MAIN THREAD ONLY, like all of LiveJson.
		if (voiceCd > 0.0f) {
			static float s_voiceCdScale = 0.0f;
			if (voiceCd > s_voiceCdScale)
				s_voiceCdScale = voiceCd;
			voiceCd = QuantiseCountdown(voiceCd, s_voiceCdScale);
		}

		// PERF (2026-08-16, round two): ONE inventory enumeration for the whole
		// pass. Every `smart` slot used to call SmartFind — a full walk building a
		// std::map and heap-copying an InventoryEntryData per potion — and every
		// `item` slot called InventoryState, which walked the whole inventory again
		// to find ONE entry. On a bar with a few of each that was five or six walks
		// on the GAME THREAD, up to five times a second, forever.
		//
		// The filter is the UNION of what those calls asked for individually, so
		// the map holds exactly the entries they would each have built and no row's
		// answer can change: AlchemyItem (only when a smart slot is actually on the
		// page) plus the specific objects the item slots resolve to. A slot kind
		// that needs neither leaves the map empty and costs nothing at all.
		bool                                    needAlch = false;
		std::unordered_set<RE::TESBoundObject*> wantObjs;
		FormCache                               forms;
		{
			// One visit per slot: it decides what the inventory filter must admit
			// AND banks the resolve FillLiveRow would otherwise repeat. The kinds
			// skipped here are exactly the ones FillLiveRow returns from before it
			// ever touches ResolveForm, so nothing is resolved that was not before.
			const auto note = [&needAlch, &wantObjs, &forms](const Slot& sl) {
				if (sl.kind == "smart") {
					needAlch = true;
					return;
				}
				if (sl.kind == "entry" || sl.kind == "combo" || sl.kind == "flyout")
					return;
				auto* form = ResolveForm(sl);
				forms.emplace(&sl, form);
				if (form && sl.kind == "item") {
					if (auto* obj = form->As<RE::TESBoundObject>())
						wantObjs.insert(obj);
				}
			};
			const int scan = std::min<int>(shown, static_cast<int>(slots.size()));
			for (int i = 0; i < scan; ++i) {
				if (slots[i].kind == "flyout") {
					for (const auto& kid : slots[i].items)
						note(kid);
				} else {
					note(slots[i]);
				}
			}
		}
		const InvMap inv = [&]() -> InvMap {
			if (!player || (!needAlch && wantObjs.empty()))
				return InvMap{};
			return player->GetInventory([&needAlch, &wantObjs](RE::TESBoundObject& o) {
				return (needAlch && o.Is(RE::FormType::AlchemyItem)) ||
					wantObjs.find(&o) != wantObjs.end();
			});
		}();

		for (int i = 0; i < shown; ++i) {
			json row{ { "i", i } };
			const bool present = i < static_cast<int>(slots.size());
			// An empty FLYOUT still draws (as a bundle with nothing in it) so
			// the button you just made does not vanish from the bar between
			// the editor and its first child.
			if (!present || (slots[i].Empty() && slots[i].kind != "flyout")) {
				row["kind"] = "";
				arr.push_back(std::move(row));
				continue;
			}
			const Slot& s = slots[i];
			if (s.kind == "flyout") {
				row["kind"] = "flyout";
				row["ok"] = !s.items.empty();
				if (!s.icon.empty())
					row["icon"] = s.icon;
				if (!s.label.empty())
					row["label"] = s.label;
				if (s.items.empty())
					row["msg"] = "Nothing in this flyout yet";
				json kids = json::array();
				for (int k = 0; k < static_cast<int>(s.items.size()); ++k) {
					json kid{ { "i", k } };
					FillLiveRow(kid, s.items[k], player, fx, voiceCd, inv, forms);
					kids.push_back(std::move(kid));
				}
				row["items"] = std::move(kids);
				arr.push_back(std::move(row));
				continue;
			}
			FillLiveRow(row, s, player, fx, voiceCd, inv, forms);
			arr.push_back(std::move(row));
		}

		return json{ { "page", p }, { "slots", std::move(arr) } }
			.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	bool PoolMatch(const std::string& ref, const RE::AlchemyItem* alch, float& outScore)
	{
		return SmartMatches(ref, alch, outScore);
	}

	SmartInfo SmartCount(const std::string& ref)
	{
		SmartInfo out;
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return out;
		// The CENSUS, not the pick: this describes the bag ("5 healing potions,
		// best is a Potion of Ultimate Healing"), so it must not change with the
		// player's health the way the smart button's own choice does.
		const auto hit = SmartCensusIn(player->GetInventory([](RE::TESBoundObject& o) {
			return o.Is(RE::FormType::AlchemyItem);
		}), ref);
		out.total = hit.total;
		out.bestScore = hit.score;
		if (hit.best) {
			if (const char* nm = hit.best->GetName(); nm && *nm)
				out.bestName = nm;
		}
		return out;
	}

	int CountAllPotions()
	{
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return 0;
		int  total = 0;
		auto inv = player->GetInventory([](RE::TESBoundObject& o) {
			return o.Is(RE::FormType::AlchemyItem);
		});
		for (auto& [obj, data] : inv) {
			if (data.first <= 0)
				continue;
			auto* alch = obj ? obj->As<RE::AlchemyItem>() : nullptr;
			if (!alch || alch->IsFood() || alch->IsPoison())
				continue;
			total += data.first;
		}
		return total;
	}

	// ---- consumable classification (see hotbar.h) --------------------------
	namespace
	{
		// Everything the classifier resolves ONCE, lazily on the main thread
		// (every caller is already main-thread-only, and the first call cannot
		// land before kDataLoaded — the ticker/bridge paths that reach it only
		// exist after the data handler is up).
		struct ConsumableIds
		{
			bool inited = false;
			bool sunhelm = false;
			// ITMPotionUse (Skyrim.esm 0x000B6435) — the vanilla drink gulp.
			// Vanilla ale/mead/wine all carry it; solid food carries ITMFoodEat.
			RE::TESForm* drinkSound = nullptr;
			// VendorItemDrink is NOT a vanilla keyword; CACO-era mods ship one.
			// Resolved by EditorID once; absent => that signal is skipped.
			RE::BGSKeyword* drinkKw = nullptr;
			// Runtime FormID -> drinks held. The EXACT SunHelm fresh-water set,
			// verified from the plugin bytes on the rig (2026-08-15).
			std::unordered_map<RE::FormID, int> waterDrinks;
			// Salt water — never drinkable, never counted.
			std::unordered_set<RE::FormID> saltWater;
		};
		ConsumableIds g_cids;

		void EnsureConsumableInit()
		{
			if (g_cids.inited)
				return;
			g_cids.inited = true;
			g_cids.drinkSound = RE::TESForm::LookupByID(0x000B6435);  // ITMPotionUse
			g_cids.drinkKw = RE::TESForm::LookupByEditorID<RE::BGSKeyword>("VendorItemDrink");
			if (auto* dh = RE::TESDataHandler::GetSingleton()) {
				constexpr const char* kSunHelm = "SunHelmSurvival.esp";
				const auto grab = [&](std::uint32_t local, int drinks) {
					if (auto* f = dh->LookupForm(local, kSunHelm)) {
						g_cids.sunhelm = true;
						g_cids.waterDrinks[f->GetFormID()] = drinks;
					}
				};
				grab(0x86E, 1);  // _SHWaterBottleWine
				grab(0x86F, 1);  // _SHWaterBottleMead
				grab(0x8A1, 1);  // _SHSujammaWaterBottle
				grab(0x8C2, 1);  // _SHWaterskin_1
				grab(0x8C3, 2);  // _SHWaterskin_2
				grab(0x8C4, 3);  // _SHWaterskin_3
				const auto salt = [&](std::uint32_t local) {
					if (auto* f = dh->LookupForm(local, kSunHelm))
						g_cids.saltWater.insert(f->GetFormID());
				};
				salt(0x897);  // _SHSaltBottleWine
				salt(0x898);  // _SHSaltBottleMead
				salt(0x8A4);  // _SHSaltBottleSujamma
				salt(0x8CF);  // _SHWaterskinSalt
			}
			// Build marker (hd-markers.json: "consumables: classified").
			logger::info("consumables: classified (water mod {}, drink sound {}, drink keyword {})",
				g_cids.sunhelm ? "present" : "absent",
				g_cids.drinkSound ? "resolved" : "missing",
				g_cids.drinkKw ? "resolved" : "absent");
		}

		// Word-boundary token match, case-insensitive: "ale" must match
		// "Honningbrew Ale" and "Ale of Winterhold" but never "Kale Soup" or
		// "Royale Roast" — a bare substring check would misfile those.
		bool NameHasWord(const std::string& lower, const char* word)
		{
			const size_t wl = std::strlen(word);
			size_t       at = 0;
			while ((at = lower.find(word, at)) != std::string::npos) {
				const bool leftOk = at == 0 || !std::isalpha(static_cast<unsigned char>(lower[at - 1]));
				const size_t end = at + wl;
				const bool rightOk = end >= lower.size() || !std::isalpha(static_cast<unsigned char>(lower[end]));
				if (leftOk && rightOk)
					return true;
				at += 1;
			}
			return false;
		}

		std::string LowerName(const RE::AlchemyItem* alch)
		{
			std::string lo;
			if (const char* n = alch ? alch->GetName() : nullptr; n && *n) {
				lo = n;
				std::transform(lo.begin(), lo.end(), lo.begin(),
					[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			}
			return lo;
		}

		// Drink-vs-food, for an IsFood() item. Three signals, honest about
		// each: the consumption sound is authoritative when it is the vanilla
		// drink gulp; the VendorItemDrink keyword only exists when a mod adds
		// it; the name heuristic is the belt-and-braces fallback and is
		// word-boundary matched so "kale" is not an ale.
		bool LooksLikeDrink(const RE::AlchemyItem* alch)
		{
			if (auto* snd = alch->data.consumptionSound) {
				if (g_cids.drinkSound && snd == g_cids.drinkSound)
					return true;
				// A modded gulp: its EditorID often says so (needs po3's
				// keep-editor-ids for SNDR to be non-empty; "" just skips).
				if (const char* ed = snd->GetFormEditorID(); ed && *ed) {
					std::string lo = ed;
					std::transform(lo.begin(), lo.end(), lo.begin(),
						[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
					if (lo.find("drink") != std::string::npos ||
						lo.find("potionuse") != std::string::npos)
						return true;
				}
			}
			if (g_cids.drinkKw && alch->HasKeyword(g_cids.drinkKw))
				return true;
			const std::string lo = LowerName(alch);
			if (lo.empty())
				return false;
			for (const char* w : { "ale", "mead", "wine", "brandy", "tea", "juice", "milk", "water" })
				if (NameHasWord(lo, w))
					return true;
			return false;
		}
	}

	int WaterDrinks(const RE::AlchemyItem* alch)
	{
		if (!alch)
			return 0;
		EnsureConsumableInit();
		const auto id = alch->GetFormID();
		if (g_cids.saltWater.count(id))
			return 0;
		if (auto it = g_cids.waterDrinks.find(id); it != g_cids.waterDrinks.end())
			return it->second;
		// Generic fallback for other survival mods' waters: FOOD-flagged (the
		// survival waters all are), named "water", not salt, and not a Potion
		// of Waterbreathing — "breath" is the one substring that would misfile
		// a real potion, so it is excluded explicitly.
		if (!alch->IsFood() || alch->IsPoison())
			return 0;
		const std::string lo = LowerName(alch);
		if (lo.empty())
			return 0;
		if (NameHasWord(lo, "water") &&
			lo.find("salt") == std::string::npos &&
			lo.find("breath") == std::string::npos)
			return 1;
		return 0;
	}

	bool WaterModPresent()
	{
		EnsureConsumableInit();
		return g_cids.sunhelm;
	}

	ConsumableKind ClassifyConsumable(const RE::AlchemyItem* alch)
	{
		if (!alch)
			return ConsumableKind::kPotion;
		EnsureConsumableInit();
		if (alch->IsPoison())
			return ConsumableKind::kPoison;
		if (WaterDrinks(alch) > 0)
			return ConsumableKind::kWater;
		if (alch->IsFood())
			return LooksLikeDrink(alch) ? ConsumableKind::kDrink : ConsumableKind::kFood;
		return ConsumableKind::kPotion;
	}

	std::string FireSmart(const std::string& ref)
	{
		const auto reply = [](bool ok, const std::string& msg) {
			return json{ { "ok", ok }, { "msg", msg } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		};

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return reply(false, "No save loaded");

		const SmartPrefs prefs   = GetSmartPrefs();
		const float      deficit = PoolDeficitOf(ref);
		const float      pct     = PoolPercent(ref);

		// Already full: burning a potion for nothing is the exact waste this
		// whole feature exists to stop, so say so instead. Deliberately only in
		// optimal mode — strongest-wins is the old behaviour, kept whole.
		if (prefs.optimal && prefs.blockWhenFull && deficit == 0.0f && pct >= 0.0f)
			return reply(false, std::string("Your ") + PoolNoun(ref) + " is already full");

		const auto hit = SmartFind(player, ref);
		if (!hit.best) {
			if (hit.refusal)
				return reply(false, std::string("No ") + SmartLabel(ref) +
					" you can drink — " + hit.refusal);
			return reply(false, std::string("No ") + SmartLabel(ref) + " in your bag");
		}
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return reply(false, "The equip manager isn't up");
		std::string nm = "potion";
		if (const char* n = hit.best->GetName(); n && *n)
			nm = n;
		// EquipObject on an AlchemyItem IS the drink — the same verb the wheel
		// uses, so whatever the cast path does for the wheel it does here.
		eqm->EquipObject(player, hit.best);
		// Build marker (hd-markers.json: "hotbar-smart" and "smart-potion-fit").
		logger::info("hotbar-smart: drank '{}' ({} matching potion(s) were carried)", nm, hit.total);
		logger::info("smart-potion-fit: {} deficit {:.0f} -> '{}' worth {:.0f}{} (mode {})",
			ref, std::max<float>(deficit, 0.0f), nm, hit.score,
			hit.overheal ? ", overheals" : "", prefs.optimal ? "optimal" : "strongest");
		return reply(true, "Drank " + nm);
	}

	float PoolDeficit(const std::string& ref)
	{
		return std::max<float>(0.0f, PoolDeficitOf(ref));
	}

	void SetSmartPrefs(const SmartPrefs& p)
	{
		std::lock_guard l(g_smartMx);
		g_smartPrefs = p;
		g_smartPrefs.emergencyPct = std::clamp(g_smartPrefs.emergencyPct, 0, 90);
		// The exclusion list changed shape or content — re-resolve it lazily on
		// the next pick rather than here, where the data handler may not exist
		// yet (this is called from the sidecar load, which runs early).
		g_smartExclDirty = true;
		g_smartExcl.reset();
	}

	SmartPrefs GetSmartPrefs()
	{
		std::lock_guard l(g_smartMx);
		return g_smartPrefs;
	}
}
