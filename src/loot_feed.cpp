#include "loot_feed.h"

#include "item_icons.h"
#include "widgets.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <deque>
#include <mutex>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

// pch (force-included) provides RE::/SKSE:: and nlohmann json (<json.hpp>).

namespace LootFeed
{
	using json = nlohmann::json;

	namespace
	{
		constexpr RE::FormID kPlayerId = 0x00000014;
		constexpr RE::FormID kGoldId = 0x0000000F;

		struct Pick
		{
			RE::FormID   base;
			std::int32_t count;
		};

		std::mutex                                   g_mtx;
		std::vector<Pick>                            g_pending;   // queued by the sink, drained per frame
		std::atomic<bool>                            g_drainQueued{ false };
		std::function<void(const std::string&)>      g_push;
		std::function<bool()>                        g_paletteOpen;

		// Names the feed showed in the last few seconds — what the HUD filter
		// matches a vanilla "added" line against. steady_clock stamps.
		struct Seen
		{
			std::string                           name;
			std::chrono::steady_clock::time_point at;
		};
		std::deque<Seen> g_recent;   // g_mtx
		constexpr auto   kRecentFor = std::chrono::seconds(3);

		// Items shown without a picture, waiting for a game menu to render in.
		// Key "0xLOCAL|plugin" so a repeat is one wish.
		struct Wish
		{
			std::string fid, plugin, name;
		};
		std::unordered_map<std::string, Wish> g_wishes;   // g_mtx
		std::unordered_set<std::string>       g_wished;   // ever handed over this session
		constexpr std::size_t                 kWishCap = 48;

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// The plugin-local id + plugin of a form, the spelling ItemIcons keys on
		// (quiver.cpp PutIdentity). False for a dynamic form (no source file).
		bool IdentityOf(const RE::TESForm* form, std::string& fid, std::string& plugin)
		{
			auto* file = form ? form->GetFile(0) : nullptr;
			if (!file)
				return false;
			const std::uint32_t local = form->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			char buf[16];
			std::snprintf(buf, sizeof(buf), "0x%06X", local);
			fid = buf;
			plugin = std::string(file->GetFilename());
			return true;
		}

		std::string HexId(RE::FormID id)
		{
			char buf[16];
			std::snprintf(buf, sizeof(buf), "0x%08X", id);
			return buf;
		}

		// The family the view draws a glyph for when there is no render yet.
		// Matches hud-lootfeed.js KIND_ART.
		const char* KindOf(RE::TESForm* form)
		{
			if (!form)
				return "misc";
			if (form->GetFormID() == kGoldId)
				return "gold";
			if (form->Is(RE::FormType::Ingredient))
				return "ingredient";
			if (auto* alch = form->As<RE::AlchemyItem>()) {
				if (alch->IsPoison())
					return "poison";
				if (alch->IsFood())
					return "food";
				return "potion";
			}
			if (form->Is(RE::FormType::Scroll))
				return "scroll";
			if (auto* book = form->As<RE::TESObjectBOOK>())
				return book->IsNoteScroll() ? "note" : "book";
			if (form->Is(RE::FormType::SoulGem))
				return "soulgem";
			if (form->Is(RE::FormType::KeyMaster))
				return "key";
			if (form->Is(RE::FormType::Ammo))
				return "ammo";
			if (auto* weap = form->As<RE::TESObjectWEAP>())
				return (weap->IsBow() || weap->IsCrossbow()) ? "bow" : "weapon";
			if (auto* armo = form->As<RE::TESObjectARMO>()) {
				using Slot = RE::BGSBipedObjectForm::BipedObjectSlot;
				if (armo->HasPartOf(Slot::kAmulet) || armo->HasPartOf(Slot::kRing))
					return "jewelry";
				return (armo->IsLightArmor() || armo->IsHeavyArmor() || armo->IsShield()) ? "armor" : "clothing";
			}
			if (auto* misc = form->As<RE::TESObjectMISC>()) {
				if (misc->HasKeywordString("VendorItemGem"))
					return "gem";
				if (misc->HasKeywordString("VendorItemOreIngot"))
					return "ore";
				if (misc->HasKeywordString("VendorItemAnimalHide") || misc->HasKeywordString("VendorItemAnimalPart"))
					return "pelt";
			}
			return "misc";
		}

		// A form the feed should never show: nameless (script tokens, dummies)
		// or flagged non-playable (hidden skins, outfit dummies).
		bool Showable(RE::TESForm* form, std::string& name)
		{
			if (!form)
				return false;
			const char* nm = form->GetName();
			if (!nm || !*nm)
				return false;
			if ((form->Is(RE::FormType::Armor) || form->Is(RE::FormType::Weapon)) &&
				(form->GetFormFlags() & 0x4u))   // kNonPlayable on ARMO and WEAP
				return false;
			name = nm;
			return true;
		}

		void Remember(const std::string& name)
		{
			const auto now = std::chrono::steady_clock::now();
			g_recent.push_back({ Lower(name), now });
			while (!g_recent.empty() && (now - g_recent.front().at > kRecentFor || g_recent.size() > 64))
				g_recent.pop_front();
		}

		// One task per frame that had pickups. MAIN THREAD.
		void Drain()
		{
			g_drainQueued = false;
			std::vector<Pick> picks;
			{
				std::lock_guard l(g_mtx);
				picks.swap(g_pending);
			}
			if (picks.empty())
				return;
			// Fold repeats inside the batch, first-seen order kept.
			std::vector<Pick> folded;
			for (const auto& p : picks) {
				auto it = std::find_if(folded.begin(), folded.end(), [&](const Pick& f) { return f.base == p.base; });
				if (it != folded.end())
					it->count += p.count;
				else
					folded.push_back(p);
			}
			json rows = json::array();
			{
				std::lock_guard l(g_mtx);
				for (const auto& p : folded) {
					auto*       form = RE::TESForm::LookupByID(p.base);
					std::string name;
					if (!Showable(form, name))
						continue;
					json row = {
						{ "id", HexId(p.base) },
						{ "name", name },
						{ "count", p.count },
						{ "kind", KindOf(form) },
						{ "value", (std::max)(0, form->GetGoldValue()) },
					};
					std::string fid, plugin, icon;
					if (p.base != kGoldId && IdentityOf(form, fid, plugin)) {
						icon = ItemIcons::IconPathIfRendered(fid, plugin);
						const std::string key = fid + "|" + Lower(plugin);
						if (icon.empty() && !g_wished.contains(key) && g_wishes.size() < kWishCap)
							g_wishes.emplace(key, Wish{ fid, plugin, name });
					}
					if (!icon.empty())
						row["icon"] = icon;
					rows.push_back(std::move(row));
					Remember(name);
				}
			}
			if (rows.empty() || !g_push)
				return;
			static bool s_said = false;
			if (!s_said) {
				s_said = true;
				// Build marker (hd-markers.json: "loot-feed-live").
				logger::info("loot-feed: first pickup pushed to the HUD ({} row(s))", rows.size());
			}
			g_push(rows.dump(-1, ' ', false, json::error_handler_t::replace));
		}

		class ContainerSink final : public RE::BSTEventSink<RE::TESContainerChangedEvent>
		{
		public:
			static ContainerSink* GetSingleton()
			{
				static ContainerSink s;
				return &s;
			}
			// Queue only — no lookups here (the widgets ContainerSink law). The
			// widget switch is read through Widgets' own lock.
			RE::BSEventNotifyControl ProcessEvent(const RE::TESContainerChangedEvent* ev,
				RE::BSTEventSource<RE::TESContainerChangedEvent>*) override
			{
				if (!ev || ev->newContainer != kPlayerId || ev->oldContainer == kPlayerId ||
					ev->itemCount <= 0 || !ev->baseObj)
					return RE::BSEventNotifyControl::kContinue;
				if (!Widgets::LootFeedOn())
					return RE::BSEventNotifyControl::kContinue;
				{
					std::lock_guard l(g_mtx);
					if (g_pending.size() < 512)
						g_pending.push_back({ ev->baseObj, ev->itemCount });
				}
				if (!g_drainQueued.exchange(true))
					SKSE::GetTaskInterface()->AddTask([]() { Drain(); });
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		// ---- the game's own "<item> added" lines --------------------------
		// The word the game appends ("added" in English), read from its own
		// GMST so a translated game matches its own language. Empty = the
		// setting is missing: then NOTHING is swallowed (honest over clever).
		const std::string& AddedWord()
		{
			static std::string s_word;
			static bool        s_read = false;
			if (!s_read) {
				s_read = true;
				auto* gs = RE::GameSettingCollection::GetSingleton();
				auto* st = gs ? gs->GetSetting("sAddItemtoInventory") : nullptr;
				const char* v = st ? st->GetString() : nullptr;
				if (v && *v)
					s_word = Lower(v);
				// Build marker (hd-markers.json: "loot-feed-added-word").
				logger::info("loot-feed: vanilla pickup word is '{}'{}", s_word,
					s_word.empty() ? " (GMST missing - the game's own lines are left alone)" : "");
			}
			return s_word;
		}

		// Did the feed just show an item this line names? Recent names first,
		// then anything still queued (the HUD may process its message before
		// this frame's Drain ran).
		bool NamesRecentPickup(const std::string& lowerText)
		{
			std::lock_guard l(g_mtx);
			const auto now = std::chrono::steady_clock::now();
			for (const auto& s : g_recent)
				if (now - s.at <= kRecentFor && !s.name.empty() && lowerText.find(s.name) != std::string::npos)
					return true;
			for (const auto& p : g_pending) {
				auto*       form = RE::TESForm::LookupByID(p.base);
				std::string name;
				if (Showable(form, name) && lowerText.find(Lower(name)) != std::string::npos)
					return true;
			}
			return false;
		}

		struct HudMessageHook
		{
			static RE::UI_MESSAGE_RESULTS Thunk(RE::HUDMenu* self, RE::UIMessage& msg)
			{
				if (msg.type == RE::UI_MESSAGE_TYPE::kUpdate && msg.data && Widgets::LootFeedHidesVanilla()) {
					auto* data = skyrim_cast<RE::HUDData*>(msg.data);
					if (data && data->type == RE::HUDData::Type::kNotification) {
						const char* raw = data->text.c_str();
						const auto& word = AddedWord();
						if (raw && *raw && !word.empty()) {
							const std::string text = Lower(raw);
							if (text.find(word) != std::string::npos && NamesRecentPickup(text)) {
								static bool s_said = false;
								if (!s_said) {
									s_said = true;
									// Build marker (hd-markers.json: "loot-feed-hide-vanilla").
									logger::info("loot-feed: hiding the game's own pickup line (first: '{}')", raw);
								}
								return RE::UI_MESSAGE_RESULTS::kHandled;
							}
						}
					}
				}
				return g_orig(self, msg);
			}
			static inline REL::Relocation<decltype(Thunk)> g_orig;
		};
	}

	void Install()
	{
		static bool s_done = false;
		if (s_done)
			return;
		s_done = true;
		if (auto* holder = RE::ScriptEventSourceHolder::GetSingleton())
			holder->AddEventSink<RE::TESContainerChangedEvent>(ContainerSink::GetSingleton());
		// HUDMenu::ProcessMessage — IMenu vtable slot 0x4 (SE/AE).
		REL::Relocation<std::uintptr_t> vt{ RE::VTABLE_HUDMenu[0] };
		HudMessageHook::g_orig = vt.write_vfunc(0x4, HudMessageHook::Thunk);
		// Build marker (hd-markers.json: "loot-feed-install").
		logger::info("loot-feed: pickup sink + HUD message filter installed");
	}

	void SetPusher(std::function<void(const std::string&)> push)
	{
		g_push = std::move(push);
	}

	void SetPaletteOpenProbe(std::function<bool()> probe)
	{
		g_paletteOpen = std::move(probe);
	}

	void Tick()
	{
		// Only while a GAME menu has the game paused: no world is being drawn,
		// so a render costs nobody a frame. Not while the deck is open — it
		// paces its own renders and is the surface Rober reads lag on.
		auto* ui = RE::UI::GetSingleton();
		if (!ui || !ui->GameIsPaused())
			return;
		if (g_paletteOpen && g_paletteOpen())
			return;
		json items = json::array();
		{
			std::lock_guard l(g_mtx);
			if (g_wishes.empty())
				return;
			for (auto& [key, w] : g_wishes) {
				items.push_back(json{ { "formId", w.fid }, { "plugin", w.plugin }, { "name", w.name } });
				g_wished.insert(key);
			}
			g_wishes.clear();
		}
		// Build marker (hd-markers.json: "loot-feed-renders").
		logger::info("loot-feed: {} item picture(s) handed to the renderer while paused", items.size());
		ItemIcons::EnsureIconsForList(json{ { "items", std::move(items) } }.dump(-1, ' ', false, json::error_handler_t::replace));
	}

	void Reset()
	{
		std::lock_guard l(g_mtx);
		g_pending.clear();
		g_recent.clear();
	}
}
