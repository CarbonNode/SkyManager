#include "hotbar.h"

#include "actor_identity.h"

#include <algorithm>
#include <unordered_map>

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
				if (auto* f = ActorIdentity::Resolve(ActorIdentity::HexOf(s.localId), s.plugin))
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
		// Which restore pool a potion effect feeds, and how hard. "Best" is the
		// biggest matching magnitude — restore potions carry large magnitudes and
		// regen potions small ones, so the strongest restore wins naturally
		// without a second heuristic. Detrimental effects never count: a
		// "Potion of Health Damage" from a poison-crafting mod must not become
		// somebody's emergency heal.
		struct SmartHit
		{
			RE::AlchemyItem* best      = nullptr;   // the strongest matching potion carried
			std::int32_t     bestCount = 0;         // how many of THAT potion
			std::int32_t     total     = 0;         // every matching potion, all tiers
			float            score     = 0.0f;
		};

		bool SmartMatches(const std::string& ref, const RE::AlchemyItem* alch, float& outScore)
		{
			if (!alch || alch->IsFood() || alch->IsPoison())
				return false;
			outScore = 0.0f;
			bool hit = false;
			for (auto* effect : alch->effects) {
				auto* base = effect ? effect->baseEffect : nullptr;
				if (!base || base->IsDetrimental())
					continue;
				if (ref == "cure") {
					if (base->GetArchetype() == RE::EffectSetting::Archetype::kCureDisease) {
						hit = true;
						outScore = std::max<float>(outScore, 1.0f);
					}
					continue;
				}
				const RE::ActorValue want = ref == "heal"      ? RE::ActorValue::kHealth :
				                            ref == "magicka"   ? RE::ActorValue::kMagicka :
				                            ref == "stamina"   ? RE::ActorValue::kStamina :
				                                                 RE::ActorValue::kNone;
				if (want == RE::ActorValue::kNone)
					continue;
				for (const auto av : { base->data.primaryAV, base->data.secondaryAV }) {
					if (av != want)
						continue;
					hit = true;
					outScore = std::max<float>(outScore, effect->effectItem.magnitude);
				}
			}
			return hit;
		}

		SmartHit SmartFind(RE::PlayerCharacter* player, const std::string& ref)
		{
			SmartHit out;
			if (!player)
				return out;
			auto inv = player->GetInventory([](RE::TESBoundObject& o) {
				return o.Is(RE::FormType::AlchemyItem);
			});
			for (auto& [obj, data] : inv) {
				if (data.first <= 0)
					continue;
				auto* alch = obj ? obj->As<RE::AlchemyItem>() : nullptr;
				float score = 0.0f;
				if (!SmartMatches(ref, alch, score))
					continue;
				out.total += data.first;
				if (!out.best || score > out.score) {
					out.best      = alch;
					out.bestCount = data.first;
					out.score     = score;
				}
			}
			return out;
		}

		const char* SmartLabel(const std::string& ref)
		{
			return ref == "heal"    ? "healing potion" :
			       ref == "magicka" ? "magicka potion" :
			       ref == "stamina" ? "stamina potion" :
			       ref == "cure"    ? "cure disease potion" : "potion";
		}

		void InventoryState(RE::TESBoundObject* obj, std::int32_t& outCount, bool& outWorn)
		{
			outCount = 0;
			outWorn  = false;
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || !obj)
				return;
			auto inv = player->GetInventory([obj](RE::TESBoundObject& o) { return &o == obj; });
			for (auto& [o, data] : inv) {
				if (o != obj)
					continue;
				outCount = data.first;
				outWorn  = data.second && data.second->IsWorn();
				break;
			}
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

		void AttachFx(json& row, const FxMap& fx, const RE::MagicItem* mi)
		{
			if (!mi)
				return;
			if (auto it = fx.find(mi); it != fx.end()) {
				// one decimal is plenty — the view redraws each tick anyway
				row["fxRem"] = static_cast<double>(static_cast<int>(it->second.first * 10)) / 10.0;
				row["fxDur"] = static_cast<double>(static_cast<int>(it->second.second * 10)) / 10.0;
			}
		}

		// One slot's live row. Shared between the bar's buttons and a flyout's
		// CHILDREN — the fan draws the same icons, counts and grey-outs as the
		// bar itself, from the same code, so the two can never disagree.
		void FillLiveRow(json& row, const Slot& s, RE::PlayerCharacter* player,
			const FxMap& fx, float voiceCd)
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
				const auto hit = SmartFind(player, s.refId);
				row["smart"] = s.refId;
				row["ok"] = hit.best != nullptr;
				row["count"] = hit.total;
				if (hit.best) {
					if (const char* nm = hit.best->GetName(); nm && *nm)
						row["name"] = nm;
					AttachFx(row, fx, hit.best);
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

			auto* form = ResolveForm(s);
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
				InventoryState(obj, count, worn);
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
					FillLiveRow(kid, s.items[k], player, fx, voiceCd);
					kids.push_back(std::move(kid));
				}
				row["items"] = std::move(kids);
				arr.push_back(std::move(row));
				continue;
			}
			FillLiveRow(row, s, player, fx, voiceCd);
			arr.push_back(std::move(row));
		}

		return json{ { "page", p }, { "slots", std::move(arr) } }
			.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string FireSmart(const std::string& ref)
	{
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return json{ { "ok", false }, { "msg", "No save loaded" } }.dump();
		const auto hit = SmartFind(player, ref);
		if (!hit.best)
			return json{ { "ok", false },
				{ "msg", std::string("No ") + SmartLabel(ref) + " in your bag" } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return json{ { "ok", false }, { "msg", "The equip manager isn't up" } }.dump();
		std::string nm = "potion";
		if (const char* n = hit.best->GetName(); n && *n)
			nm = n;
		// EquipObject on an AlchemyItem IS the drink — the same verb the wheel
		// uses, so whatever the cast path does for the wheel it does here.
		eqm->EquipObject(player, hit.best);
		// Build marker (hd-markers.json: "hotbar-smart").
		logger::info("hotbar-smart: drank '{}' ({} matching potion(s) were carried)", nm, hit.total);
		return json{ { "ok", true }, { "msg", "Drank " + nm } }
			.dump(-1, ' ', false, json::error_handler_t::replace);
	}
}
