#include "loot_highlight.h"

#include <algorithm>
#include <chrono>
#include <mutex>
#include <unordered_map>
#include <unordered_set>

// pch (force-included) provides RE::/SKSE::/json/logger and std::literals.

using json = nlohmann::json;

namespace LootHighlight
{
	namespace
	{
		using clock = std::chrono::steady_clock;

		// ------------------------------------------------------------- palette
		// v3 (2026-08-05): the glow is a real object-membrane EFFECT SHADER on the
		// item — the look Rober wanted, proven by ShiningTreasure (Nexus 21228),
		// whose ST_ShaderList shaders wrap the mesh in a bright coloured shell.
		// v1's vanilla shaders (heal-circle / absorb / soul-trap) were too subtle
		// to see; v2's light pool only lit the room. So we COPY ShiningTreasure's
		// ten bright shaders into our own esp (tools/make_deck_esp.py, editor ids
		// ST_Red..ST_White, self-contained — vanilla textures, no assets) and
		// apply them with our crash-free native scanner (ShiningTreasure crashes
		// because its Papyrus loop reads container inventories every 0.3s; we
		// never do). Palette ids are UNCHANGED from v1 so a saved per-category
		// colour still maps; only the shader each id resolves to changed.
		struct PaletteColor
		{
			const char* id;
			const char* label;
			const char* css;
			const char* edids[3];  // nullptr-terminated candidates
		};
		constexpr PaletteColor kPalette[] = {
			{ "gold", "Yellow", "#f4d84a", { "ST_Yellow", nullptr, nullptr } },
			{ "xray-blue", "Cyan", "#5fe0ff", { "ST_Cyan", nullptr, nullptr } },
			{ "xray-red", "Orange", "#ff9a3c", { "ST_Orange", nullptr, nullptr } },
			{ "blue", "Blue", "#4d8bff", { "ST_Blue", nullptr, nullptr } },
			{ "green", "Green", "#57e06a", { "ST_Green", nullptr, nullptr } },
			{ "violet", "Purple", "#c06bff", { "ST_Purple", nullptr, nullptr } },
			{ "red", "Red", "#ff4d4d", { "ST_Red", nullptr, nullptr } },
		};

		// ---------------------------------------------------------- categories
		// Fixed keys — the pane renders labels for these and OpenJson sends them
		// in this order. Defaults chosen for distinctness, all user-editable.
		struct CatSpec
		{
			const char* key;
			const char* defColor;
		};
		constexpr CatSpec kCats[] = {
			{ "lotd", "violet" },      // museum wants it, you don't have it (TCC)
			{ "chests", "gold" },      // containers, minus opened-this-session
			{ "corpses", "xray-blue" },// dead + not yet opened
			{ "coins", "gold" },       // gold, lockpicks, keys
			{ "valuables", "violet" }, // gems & any pocketable over its value bar
			{ "potions", "green" },    // potions + poisons (not food)
			{ "soulgems", "blue" },
			{ "books", "xray-red" },   // unread skill books
			{ "gear", "red" },         // value/weight over threshold
			// Non-respawning ("safe") storage — barrels/chests/cupboards you can
			// stash loot in without a cell reset eating it. Adopted from Highlight
			// Safe Containers (Nexus 170781), but LIVE and toggleable here. Green
			// so a safe chest reads apart from a gold "any chest" at a glance.
			// Appended LAST so every earlier category keeps its index (the pane's
			// selftest and any saved colour map depend on the order).
			{ "safe", "green" },
		};

		// ------------------------------------------------------- session state
		// All C++-owned, none of it persisted. g_active is what WE lit, by ref
		// FormID — the kill pass matches (target, shader) so we can never
		// finish an effect some other system applied with a different shader.
		struct Glow
		{
			RE::TESEffectShader* shader = nullptr;
			std::string          cat;
		};
		std::unordered_map<std::uint32_t, Glow> g_active;

		// ContainerMenu targets this session = "looted". Guarded by its own
		// mutex: the menu sink and the tick both touch it.
		std::mutex                         g_openedMutex;
		std::unordered_set<std::uint32_t>  g_opened;

		clock::time_point g_lastTick{};
		bool              g_noShaderLogged = false;

		// Shader cache: palette id -> resolved form (nullptr = tried, missing).
		std::unordered_map<std::string, RE::TESEffectShader*> g_shaders;

		// One TCC list, snapshotted into a hash set. HasForm() on a FormList is
		// a linear walk and dbmNew holds thousands of entries — per-item
		// membership must be O(1). The sig (forms + script-added counts)
		// detects runtime growth; TCC mutates these lists on every pickup.
		struct ListCache
		{
			RE::BGSListForm*                  list = nullptr;
			bool                              tried = false;
			std::uint64_t                     sig = ~0ull;
			std::unordered_set<std::uint32_t> set;
		};
		ListCache g_lotdNew, g_lotdFound, g_lotdDisp;

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		RE::TESEffectShader* ResolveColor(const std::string& id)
		{
			auto it = g_shaders.find(id);
			if (it != g_shaders.end())
				return it->second;
			RE::TESEffectShader* found = nullptr;
			for (const auto& p : kPalette) {
				if (id != p.id)
					continue;
				for (const auto* ed : p.edids) {
					if (!ed)
						break;
					auto* form = RE::TESForm::LookupByEditorID(ed);
					// Type check, not As<> alone — the rooms ring shipped a
					// SPELL as a "placeable" once.
					if (form && form->GetFormType() == RE::FormType::EffectShader) {
						found = static_cast<RE::TESEffectShader*>(form);
						break;
					}
				}
				break;
			}
			if (!found)
				logger::warn("loot: colour '{}' resolved no EFSH (po3 Tweaks missing, or all candidates absent)", id);
			g_shaders.emplace(id, found);
			return found;
		}

		// Every palette shader that resolves — the sweep set. Also what the
		// load-time cleanup finishes, so it must cover ALL colours, not just
		// the ones currently assigned to categories.
		std::unordered_set<RE::TESEffectShader*> AllResolvedShaders()
		{
			std::unordered_set<RE::TESEffectShader*> out;
			for (const auto& p : kPalette)
				if (auto* sh = ResolveColor(p.id))
					out.insert(sh);
			return out;
		}

		void RefreshList(ListCache& lc, const std::string& edid)
		{
			if (!lc.list && !lc.tried) {
				lc.tried = true;
				auto* form = edid.empty() ? nullptr : RE::TESForm::LookupByEditorID(edid);
				lc.list = form ? form->As<RE::BGSListForm>() : nullptr;
				if (!lc.list)
					logger::info("loot: LOTD list '{}' not found — TCC not installed, or renamed", edid);
			}
			if (!lc.list)
				return;
			const std::uint64_t sig =
				(static_cast<std::uint64_t>(lc.list->forms.size()) << 32) |
				(lc.list->scriptAddedTempForms ? lc.list->scriptAddedTempForms->size() : 0u);
			if (sig == lc.sig)
				return;
			lc.sig = sig;
			lc.set.clear();
			for (auto* f : lc.list->forms)
				if (f)
					lc.set.insert(f->GetFormID());
			if (lc.list->scriptAddedTempForms)
				for (const auto id : *lc.list->scriptAddedTempForms)
					lc.set.insert(id);
		}

		bool WasOpened(std::uint32_t refId)
		{
			std::lock_guard l(g_openedMutex);
			return g_opened.count(refId) != 0;
		}

		// ---------------------------------------- safe-container name label
		// " (Safe)" appended to the NAME of non-respawning container BASES.
		// Safe-ness is a base-form property (the Respawns flag lives on CONT
		// DATA), so every instance of a base is uniformly safe — renaming the
		// base is correct and matches the mod we adopted. Base-form name edits
		// live in memory (reloaded from the plugin each launch, NOT saved into
		// the .ess), so this reapplies on launch and never persists a rename
		// into the save. Reconciled only when the desired state changes.
		constexpr const char* kSafeSuffix = " (Safe)";
		bool                              g_labelApplied = false;
		std::unordered_set<std::uint32_t> g_labeled;  // base CONT ids we suffixed

		bool IsSafeCont(RE::TESObjectCONT* cont)
		{
			return cont && !cont->data.flags.all(RE::CONT_DATA::Flag::kRespawn);
		}

		bool EndsWithSuffix(const std::string& s)
		{
			const std::string suf = kSafeSuffix;
			return s.size() >= suf.size() &&
				s.compare(s.size() - suf.size(), suf.size(), suf) == 0;
		}

		void ReconcileLabels(bool on)
		{
			if (on == g_labelApplied)
				return;  // cheap no-op every tick until the toggle actually moves
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			if (on) {
				std::size_t n = 0;
				for (auto* cont : dh->GetFormArray<RE::TESObjectCONT>()) {
					if (!IsSafeCont(cont))
						continue;
					const char* nm = cont->GetFullName();
					if (!nm || !nm[0])
						continue;  // unnamed activators-as-containers: leave them
					std::string s = nm;
					if (EndsWithSuffix(s))
						continue;  // already tagged (e.g. the old mod is still on)
					cont->SetFullName((s + kSafeSuffix).c_str());
					g_labeled.insert(static_cast<std::uint32_t>(cont->GetFormID()));
					++n;
				}
				logger::info("loot: labelled {} safe container name(s)", n);
			} else {
				std::size_t n = 0;
				for (const auto id : g_labeled) {
					auto* cont = RE::TESForm::LookupByID<RE::TESObjectCONT>(id);
					if (!cont)
						continue;
					const char* nm = cont->GetFullName();
					if (!nm)
						continue;
					std::string s = nm;
					if (EndsWithSuffix(s)) {
						s.erase(s.size() - std::string(kSafeSuffix).size());
						cont->SetFullName(s.c_str());
						++n;
					}
				}
				g_labeled.clear();
				logger::info("loot: removed {} safe-container label(s)", n);
			}
			g_labelApplied = on;
		}

		// ---------------------------------------------------- classification

		const Category* Cat(const Config& cfg, const char* key)
		{
			for (const auto& c : cfg.cats)
				if (c.key == key)
					return c.on ? &c : nullptr;
			return nullptr;
		}

		// Which category does this reference light up as? LOTD outranks the
		// generic categories: "the museum wants that sword" is the rarer,
		// more valuable fact than "that sword is worth 300 gold".
		const Category* Classify(const Config& cfg, RE::TESObjectREFR* ref,
			RE::PlayerCharacter* player, bool lotdReady)
		{
			auto* base = ref->GetBaseObject();
			if (!base)
				return nullptr;
			const auto refId = static_cast<std::uint32_t>(ref->GetFormID());

			if (auto* actor = ref->As<RE::Actor>()) {
				if (actor == player || !actor->IsDead())
					return nullptr;
				if (WasOpened(refId))
					return nullptr;  // looted (opened) — the glow's whole contract
				return Cat(cfg, "corpses");
			}

			const auto ft = base->GetFormType();

			if (ft == RE::FormType::Container) {
				if (cfg.hideOpened && WasOpened(refId))
					return nullptr;
				// A non-respawning ("safe") container is the more useful fact
				// than "a chest" — storage you can stash loot in. The Respawns
				// flag is bit 0x02 of the base CONT DATA byte (UESP CONT record;
				// RE::CONT_DATA::Flag::kRespawn); cleared = safe. Falls through to
				// "chests" when the Safe category is off, so nothing a container
				// would have lit is lost.
				if (auto* cont = base->As<RE::TESObjectCONT>();
					cont && !cont->data.flags.all(RE::CONT_DATA::Flag::kRespawn)) {
					// safeVision forces the safe category on even if its row is
					// unticked or the master is off — the dedicated toggle wins.
					for (const auto& c : cfg.cats) {
						if (c.key != "safe")
							continue;
						if (cfg.safeVision || c.on)
							return &c;
						break;
					}
				}
				return Cat(cfg, "chests");
			}

			// Loose world items from here down.
			// The museum check first, on ANY item type: TCC's own gate.
			if (lotdReady) {
				const auto baseId = static_cast<std::uint32_t>(base->GetFormID());
				if (g_lotdNew.set.count(baseId) && !g_lotdFound.set.count(baseId) &&
					!g_lotdDisp.set.count(baseId)) {
					if (const auto* c = Cat(cfg, "lotd"))
						return c;
				}
			}

			// "Valuables & gems" — the catch-all Rober asked for by name (gems are
			// plain MISC records, so without this nothing glows a flawless
			// diamond). Fallback for pocketable types no specific category took;
			// deliberately NOT weapons/armour/ammo, which belong to gear and its
			// ratio, and NOT a rescue for a category the player turned OFF.
			const auto valuable = [&]() -> const Category* {
				const auto* c = Cat(cfg, "valuables");
				if (!c)
					return nullptr;
				const auto* val = base->As<RE::TESValueForm>();
				return (val && val->value >= cfg.valuableMinValue) ? c : nullptr;
			};

			switch (ft) {
			case RE::FormType::Misc:
				{
					const auto baseId = static_cast<std::uint32_t>(base->GetFormID());
					if (baseId == 0x0000000F || baseId == 0x0000000A)  // Gold001 / Lockpick
						return Cat(cfg, "coins");
					return valuable();  // gems, claws, jeweled oddments
				}
			case RE::FormType::KeyMaster:
				return Cat(cfg, "coins");
			case RE::FormType::Ingredient:
			case RE::FormType::Scroll:
			case RE::FormType::Light:  // lanterns et al; torches are worth 1
				return valuable();
			case RE::FormType::AlchemyItem:
				{
					auto* alch = static_cast<RE::AlchemyItem*>(base);
					if (alch->IsFood())
						return valuable();  // a 5-gold cabbage stays dark; a feast item can pass
					return Cat(cfg, "potions");
				}
			case RE::FormType::SoulGem:
				return Cat(cfg, "soulgems");
			case RE::FormType::Book:
				{
					auto* book = static_cast<RE::TESObjectBOOK*>(base);
					if (book->TeachesSkill() && !book->IsRead())
						return Cat(cfg, "books");
					return valuable();  // Oghma Infinium is not a "skill book"
				}
			case RE::FormType::Weapon:
			case RE::FormType::Armor:
			case RE::FormType::Ammo:
				{
					const auto* val = base->As<RE::TESValueForm>();
					if (!val || val->value < cfg.gearMinValue)
						return nullptr;
					const auto* wt = base->As<RE::TESWeightForm>();
					const float weight = wt ? wt->weight : 0.0f;
					if (weight > 0.01f &&
						static_cast<float>(val->value) / weight < cfg.gearRatio)
						return nullptr;
					return Cat(cfg, "gear");
				}
			default:
				return nullptr;
			}
		}

		// ------------------------------------------------------ apply / kill

		// Finish OUR effect on the given refs. One ProcessLists pass however
		// many die this tick; (target, shader) must both match so an identical
		// vanilla shader applied by real magic on the same ref survives.
		void KillGlows(const std::unordered_map<std::uint32_t, RE::TESEffectShader*>& doomed)
		{
			auto* lists = RE::ProcessLists::GetSingleton();
			if (!lists || doomed.empty())
				return;
			lists->ForEachShaderEffect([&](RE::ShaderReferenceEffect* fx) {
				if (!fx || fx->finished)
					return RE::BSContainer::ForEachResult::kContinue;
				const auto target = fx->target.get();
				if (!target)
					return RE::BSContainer::ForEachResult::kContinue;
				auto it = doomed.find(static_cast<std::uint32_t>(target->GetFormID()));
				if (it != doomed.end() && fx->effectData == it->second)
					fx->finished = true;
				return RE::BSContainer::ForEachResult::kContinue;
			});
		}

		// Finish EVERYTHING using any palette shader, tracked or not — master
		// off, and the post-load cleanup for glows persisted into the save.
		void SweepAll()
		{
			auto* lists = RE::ProcessLists::GetSingleton();
			const auto ours = AllResolvedShaders();
			if (lists && !ours.empty()) {
				std::size_t n = 0;
				lists->ForEachShaderEffect([&](RE::ShaderReferenceEffect* fx) {
					if (fx && !fx->finished && ours.count(fx->effectData)) {
						fx->finished = true;
						++n;
					}
					return RE::BSContainer::ForEachResult::kContinue;
				});
				if (n)
					logger::info("loot: swept {} glow(s)", n);
			}
			g_active.clear();
		}

		// ------------------------------------------------------- menu sink
		// ContainerMenu opening IS the "looted" event — corpse, chest, barrel,
		// pickpocket alike. Recording the target and letting the next tick
		// kill the glow keeps the sink free of any engine mutation.
		class MenuSink : public RE::BSTEventSink<RE::MenuOpenCloseEvent>
		{
		public:
			static MenuSink* GetSingleton()
			{
				static MenuSink sink;
				return &sink;
			}

			RE::BSEventNotifyControl ProcessEvent(const RE::MenuOpenCloseEvent* ev,
				RE::BSTEventSource<RE::MenuOpenCloseEvent>*) override
			{
				if (!ev || !ev->opening || ev->menuName != RE::ContainerMenu::MENU_NAME)
					return RE::BSEventNotifyControl::kContinue;
				const auto ref = RE::TESObjectREFR::LookupByHandle(RE::ContainerMenu::GetTargetRefHandle());
				if (ref) {
					std::lock_guard l(g_openedMutex);
					g_opened.insert(static_cast<std::uint32_t>(ref->GetFormID()));
				}
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		json CatToJson(const Category& c)
		{
			return json{ { "key", c.key }, { "on", c.on }, { "color", c.color } };
		}
	}  // namespace

	// ------------------------------------------------------------- lifecycle

	void Init()
	{
		if (auto* ui = RE::UI::GetSingleton()) {
			ui->AddEventSink(MenuSink::GetSingleton());
			// Build marker (hd-markers.json: "loot-highlighter"). Unconditional
			// so it is REACHED every launch — a marker inside a branch that
			// never fires is one the deploy check cannot see.
			logger::info("loot: highlighter armed ({} palette colours, {} categories) - shiningtreasure shaders",
				std::size(kPalette), std::size(kCats));
			// Build marker (hd-markers.json: "loot-safe-containers"). Unconditional
			// so the deploy check always sees the feature landed.
			logger::info("loot: safe-container category active (CONT respawn flag)");
			// Build marker (hd-markers.json: "loot-safe-label").
			logger::info("loot: safe-container name labelling available");
			// Build marker (hd-markers.json: "loot-safe-vision").
			logger::info("loot: dedicated safe-vision toggle available");
		} else {
			logger::error("loot: no UI singleton — container tracking off");
		}
	}

	// ----------------------------------------------------------- persistence

	json ToJson(const Config& c)
	{
		json cats = json::array();
		for (const auto& cat : c.cats)
			cats.push_back(CatToJson(cat));
		return json{
			{ "enabled", c.enabled },
			{ "notify", c.notify },
			{ "safeVision", c.safeVision },
			{ "tickMs", c.tickMs },
			{ "radius", c.radius },
			{ "maxGlows", c.maxGlows },
			{ "hideOpened", c.hideOpened },
			{ "labelSafe", c.labelSafe },
			{ "gearRatio", c.gearRatio },
			{ "gearMinValue", c.gearMinValue },
			{ "valuableMinValue", c.valuableMinValue },
			{ "cats", cats },
			{ "lotdNew", c.lotdNew },
			{ "lotdFound", c.lotdFound },
			{ "lotdDisp", c.lotdDisp } };
	}

	void FromJson(const json& j, Config& out)
	{
		Config c;
		if (j.is_object()) {
			c.enabled = j.value("enabled", false);
			c.notify = j.value("notify", true);
			c.safeVision = j.value("safeVision", false);
			c.tickMs = std::clamp(j.value("tickMs", 1200u), 400u, 10000u);
			c.radius = std::clamp(j.value("radius", 2200.0f), 500.0f, 8000.0f);
			c.maxGlows = std::clamp(j.value("maxGlows", 40), 5, 150);
			c.hideOpened = j.value("hideOpened", true);
			c.labelSafe = j.value("labelSafe", false);
			c.gearRatio = std::clamp(j.value("gearRatio", 10.0f), 0.0f, 1000.0f);
			c.gearMinValue = std::clamp(j.value("gearMinValue", 250), 0, 100000);
			c.valuableMinValue = std::clamp(j.value("valuableMinValue", 100), 0, 100000);
			c.lotdNew = j.value("lotdNew", std::string("dbmNew"));
			c.lotdFound = j.value("lotdFound", std::string("dbmFound"));
			c.lotdDisp = j.value("lotdDisp", std::string("dbmDisp"));
			if (j.contains("cats") && j["cats"].is_array()) {
				for (const auto& jc : j["cats"]) {
					if (!jc.is_object())
						continue;
					Category cat;
					cat.key = jc.value("key", std::string(""));
					cat.on = jc.value("on", true);
					cat.color = jc.value("color", std::string(""));
					if (!cat.key.empty())
						c.cats.push_back(std::move(cat));
				}
			}
		}
		// Seed every known category exactly once, in kCats order, keeping the
		// user's on/colour for ones already present. A key this build doesn't
		// know (older config from a newer deck) is preserved at the tail —
		// nothing a player set ever silently disappears.
		std::vector<Category> seeded;
		for (const auto& spec : kCats) {
			auto it = std::find_if(c.cats.begin(), c.cats.end(),
				[&](const Category& x) { return x.key == spec.key; });
			Category cat;
			cat.key = spec.key;
			if (it != c.cats.end()) {
				cat.on = it->on;
				cat.color = it->color;
				c.cats.erase(it);
			}
			const bool known = std::any_of(std::begin(kPalette), std::end(kPalette),
				[&](const PaletteColor& p) { return cat.color == p.id; });
			if (!known)
				cat.color = spec.defColor;
			seeded.push_back(std::move(cat));
		}
		for (auto& leftover : c.cats)
			seeded.push_back(std::move(leftover));
		c.cats = std::move(seeded);
		out = std::move(c);
	}

	bool MergeViewSlice(const std::string& viewJson, Config& cfg)
	{
		const auto j = json::parse(viewJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return false;
		Config merged;
		FromJson(j, merged);
		cfg = std::move(merged);
		return true;
	}

	// --------------------------------------------------------- view payloads

	std::string OpenJson(const Config& c)
	{
		json out = ToJson(c);

		json palette = json::array();
		for (const auto& p : kPalette) {
			palette.push_back(json{
				{ "id", p.id },
				{ "label", p.label },
				{ "css", p.css },
				{ "ok", ResolveColor(p.id) != nullptr } });
		}
		out["palette"] = palette;

		RefreshList(g_lotdNew, c.lotdNew);
		RefreshList(g_lotdFound, c.lotdFound);
		RefreshList(g_lotdDisp, c.lotdDisp);
		out["lotd"] = json{
			{ "ok", g_lotdNew.list != nullptr },
			{ "wanted", g_lotdNew.set.size() },
			{ "found", g_lotdFound.set.size() },
			{ "displayed", g_lotdDisp.set.size() } };

		out["active"] = g_active.size();
		return Dump(out);
	}

	std::string StateJson(const Config&)
	{
		json cats = json::object();
		for (const auto& [id, glow] : g_active) {
			(void)id;
			auto it = cats.find(glow.cat);
			cats[glow.cat] = (it == cats.end() ? 0 : it->get<int>()) + 1;
		}
		return Dump(json{ { "ok", true }, { "active", g_active.size() }, { "cats", cats } });
	}

	std::string ToggleMaster(Config& cfg)
	{
		cfg.enabled = !cfg.enabled;
		if (!cfg.enabled)
			SweepAll();
		g_lastTick = clock::time_point{};  // next tick runs immediately
		const std::string msg = cfg.enabled ? "✨ Loot Vision on" : "Loot Vision off";
		if (cfg.notify)
			RE::DebugNotification(msg.c_str());
		logger::info("loot: master {}", cfg.enabled ? "ON" : "OFF");
		return Dump(json{ { "ok", true }, { "msg", msg }, { "enabled", cfg.enabled } });
	}

	bool IsAction(const std::string& a)
	{
		return a == "loot-vision";
	}

	// ------------------------------------------------------------- the tick

	void Tick(const Config& cfg)
	{
		// Name-tagging is independent of the glow master and its cadence, so it
		// runs FIRST — a cheap bool compare every tick, real work only when the
		// toggle moves. This keeps "(Safe)" labels correct even with Loot Vision
		// off or the deck paused.
		ReconcileLabels(cfg.labelSafe);

		const auto now = clock::now();
		if (now - g_lastTick < std::chrono::milliseconds(cfg.tickMs))
			return;
		g_lastTick = now;

		// The master OR the dedicated safe-vision toggle keeps the scanner alive.
		if (!cfg.enabled && !cfg.safeVision) {
			if (!g_active.empty())
				SweepAll();
			return;
		}

		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* tes = RE::TES::GetSingleton();
		auto* ui = RE::UI::GetSingleton();
		if (!player || !tes || !player->GetParentCell())
			return;
		// Paused (deck open, any menu) — leave the world exactly as lit.
		if (ui && ui->GameIsPaused())
			return;

		// Category -> shader, once per tick.
		std::unordered_map<std::string, RE::TESEffectShader*> catShader;
		bool anyShader = false;
		for (const auto& cat : cfg.cats) {
			// A category lights this tick if the master has it on, OR it is the
			// safe category and the dedicated safe-vision toggle is on. So with
			// the master off + safeVision on, ONLY safe containers glow.
			const bool active = (cfg.enabled && cat.on) ||
				(cfg.safeVision && cat.key == "safe");
			if (!active)
				continue;
			auto* sh = ResolveColor(cat.color);
			catShader[cat.key] = sh;
			anyShader = anyShader || sh != nullptr;
		}
		if (!anyShader) {
			if (!g_noShaderLogged) {
				g_noShaderLogged = true;
				logger::warn("loot: no palette shader resolves — highlighter idle");
			}
			return;
		}

		const bool lotdOn = Cat(cfg, "lotd") != nullptr;
		if (lotdOn) {
			RefreshList(g_lotdNew, cfg.lotdNew);
			RefreshList(g_lotdFound, cfg.lotdFound);
			RefreshList(g_lotdDisp, cfg.lotdDisp);
		}
		const bool lotdReady = lotdOn && g_lotdNew.list != nullptr;

		// Gather candidates nearest-first. The engine's range walk is the
		// spherical prefilter; classification is the real gate.
		struct Candidate
		{
			float                 dist2;
			std::uint32_t         refId;
			RE::TESObjectREFR*    ref;
			RE::TESEffectShader*  shader;
			const char*           cat;
		};
		std::vector<Candidate> found;
		const auto ppos = player->GetPosition();

		tes->ForEachReferenceInRange(player, cfg.radius,
			[&](RE::TESObjectREFR* ref) -> RE::BSContainer::ForEachResult {
				if (!ref || ref == player || ref->IsDisabled() || ref->IsDeleted() ||
					!ref->Is3DLoaded())
					return RE::BSContainer::ForEachResult::kContinue;
				const auto* cat = Classify(cfg, ref, player, lotdReady);
				if (!cat)
					return RE::BSContainer::ForEachResult::kContinue;
				auto it = catShader.find(cat->key);
				if (it == catShader.end() || !it->second)
					return RE::BSContainer::ForEachResult::kContinue;
				const auto p = ref->GetPosition();
				const float dx = p.x - ppos.x, dy = p.y - ppos.y, dz = p.z - ppos.z;
				found.push_back(Candidate{ dx * dx + dy * dy + dz * dz,
					static_cast<std::uint32_t>(ref->GetFormID()), ref, it->second,
					cat->key.c_str() });
				return RE::BSContainer::ForEachResult::kContinue;
			});

		if (found.size() > static_cast<std::size_t>(cfg.maxGlows)) {
			std::nth_element(found.begin(), found.begin() + cfg.maxGlows, found.end(),
				[](const Candidate& a, const Candidate& b) { return a.dist2 < b.dist2; });
			found.resize(cfg.maxGlows);
		}

		// Diff against what is already lit. Same ref + same shader = leave it
		// alone (re-applying stacks a second effect and restarts the fade-in).
		std::unordered_map<std::uint32_t, RE::TESEffectShader*> doomed;
		std::unordered_map<std::uint32_t, Glow>                 next;
		for (const auto& c : found) {
			auto it = g_active.find(c.refId);
			if (it != g_active.end() && it->second.shader == c.shader) {
				next.emplace(c.refId, it->second);
				continue;
			}
			if (it != g_active.end())
				doomed.emplace(c.refId, it->second.shader);  // colour changed
			if (c.ref->ApplyEffectShader(c.shader, -1.0f))
				next.emplace(c.refId, Glow{ c.shader, c.cat });
		}
		for (const auto& [refId, glow] : g_active)
			if (!next.count(refId) && !doomed.count(refId))
				doomed.emplace(refId, glow.shader);

		KillGlows(doomed);
		g_active = std::move(next);
	}

	void OnPostLoadGame()
	{
		{
			std::lock_guard l(g_openedMutex);
			g_opened.clear();
		}
		g_active.clear();
		g_lotdNew = ListCache{};
		g_lotdFound = ListCache{};
		g_lotdDisp = ListCache{};
		g_lastTick = clock::time_point{};
		// Glows persisted into the save now have no owner in g_active — finish
		// them before the scanner repopulates, or a looted corpse saved mid-glow
		// shines forever.
		SweepAll();
	}
}
