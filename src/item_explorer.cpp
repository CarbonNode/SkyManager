// Items tab — inline item explorer. See item_explorer.h for the contract.
//
// Design notes that are load-bearing:
//  - The index stores (runtime FormID, local FormID, plugin index) per item and
//    resolves an add via TESDataHandler::LookupForm(local, plugin) — the
//    ESL-safe identity the deck already uses for spells and containers. The
//    local id is computed with the file-width mask, NOT CommonLib's
//    GetLocalFormID() (its missing null check is the 2026-08-03 CTD; see
//    actor_identity.cpp).
//  - Dynamic (no source file) forms are skipped: they are neither listable to
//    a user nor resolvable next session.
//  - All JSON is dumped with error_handler_t::replace — item names come out of
//    arbitrary ESPs and are not guaranteed UTF-8; a throwing dump would kill
//    the reply for the whole query.
//  - Gold is read with the same SEH-guarded raw walk finance.cpp uses: on a
//    4,000-plugin load order GetInventory<>() has faulted inside our module,
//    and only the gold ENTRIES are needed.

#include "item_explorer.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace ItemExplorer
{
	namespace
	{
		using json = nlohmann::json;

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// ------------------------------------------------------------- kinds --
		// Order doubles as the browse sort, so a plugin's catalogue reads
		// weapons -> armour -> ... -> keys like a shop inventory would.
		enum class Kind : std::uint8_t
		{
			Weap, Armo, Ammo, Alch, Food, Ingr, Book, Scrl, Slgm, Misc, Keym, Ligh
		};

		const char* KindKey(Kind k)
		{
			switch (k) {
			case Kind::Weap: return "weap";
			case Kind::Armo: return "armo";
			case Kind::Ammo: return "ammo";
			case Kind::Alch: return "alch";
			case Kind::Food: return "food";
			case Kind::Ingr: return "ingr";
			case Kind::Book: return "book";
			case Kind::Scrl: return "scrl";
			case Kind::Slgm: return "slgm";
			case Kind::Misc: return "misc";
			case Kind::Keym: return "keym";
			case Kind::Ligh: return "ligh";
			}
			return "misc";
		}

		std::optional<Kind> KindFromKey(const std::string& s)
		{
			for (std::uint8_t i = 0; i <= static_cast<std::uint8_t>(Kind::Ligh); ++i)
				if (s == KindKey(static_cast<Kind>(i)))
					return static_cast<Kind>(i);
			return std::nullopt;
		}

		// ------------------------------------------------------------- index --
		struct Plugin
		{
			std::string   name;    // as the engine spells it, e.g. "Ordinator.esp"
			std::string   lower;
			std::string   ext;     // "esm" | "esp" | "esl" (from the filename)
			bool          light = false;  // ESL or ESL-flagged ESP
			std::uint32_t count = 0;      // items indexed from it
		};

		struct Item
		{
			std::uint32_t formId;   // runtime — valid this session, used for lookups we make ourselves
			std::uint32_t localId;  // durable half of the identity we hand the view
			std::int32_t  value;
			float         weight;
			std::uint16_t plug;
			Kind          kind;
			std::string   name;
			std::string   lower;
		};

		std::vector<Plugin> g_plugins;
		std::vector<Item>   g_items;
		bool                g_built = false;

		std::string Lower(std::string_view s)
		{
			std::string out(s);
			std::transform(out.begin(), out.end(), out.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return out;
		}

		// ---------------------------------------------------------- settings --
		bool   g_pay = false;   // merchant mode: taking an item costs gold
		double g_mult = 1.0;    // suggested price = item value x this
		bool   g_settingsLoaded = false;

		std::filesystem::path SettingsPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "item-explorer.json";
		}

		void LoadSettings()
		{
			if (g_settingsLoaded)
				return;
			g_settingsLoaded = true;
			std::ifstream in(SettingsPath(), std::ios::binary);
			if (!in)
				return;
			try {
				json j = json::parse(in, nullptr, true, true);
				if (j.is_object()) {
					g_pay = j.value("pay", false);
					g_mult = std::clamp(j.value("mult", 1.0), 0.0, 100.0);
				}
			} catch (...) {
				logger::warn("item-explorer: settings sidecar unreadable — defaults kept");
			}
		}

		void SaveSettingsFile()
		{
			const auto path = SettingsPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("item-explorer: could not write {}", tmp.string());
					return;
				}
				out << Dump(json{ { "pay", g_pay }, { "mult", g_mult } });
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("item-explorer: settings rename failed: {}", ec.message());
		}

		// -------------------------------------------------------------- gold --
		constexpr RE::FormID kGold = 0x0000000F;  // Gold001

		// finance.cpp's lesson verbatim: sum only the gold entries, SEH-wrapped,
		// because the full inventory rebuild has faulted on this load order.
		__declspec(noinline) std::int64_t ReadGoldRaw()
		{
			auto* p = RE::PlayerCharacter::GetSingleton();
			if (!p)
				return 0;
			std::int64_t total = 0;
			auto*        changes = p->GetInventoryChanges();
			if (changes && changes->entryList) {
				for (auto* entry : *changes->entryList) {
					if (entry && entry->object && entry->object->GetFormID() == kGold)
						total += entry->countDelta;
				}
			}
			return total;
		}

		std::int64_t ReadGold()
		{
			__try {
				return ReadGoldRaw();
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return -1;  // sentinel: view shows "?" rather than a lie
			}
		}

		// --------------------------------------------------------- the walk --
		std::uint16_t PlugIndexFor(RE::TESFile* file,
			std::unordered_map<const RE::TESFile*, std::uint16_t>& map)
		{
			if (auto it = map.find(file); it != map.end())
				return it->second;
			Plugin p;
			p.name = std::string(file->GetFilename());
			p.lower = Lower(p.name);
			p.light = file->IsLight();
			const auto dot = p.lower.rfind('.');
			p.ext = dot == std::string::npos ? "esp" : p.lower.substr(dot + 1);
			const auto idx = static_cast<std::uint16_t>(g_plugins.size());
			g_plugins.push_back(std::move(p));
			map.emplace(file, idx);
			return idx;
		}

		// classify(form) -> Kind to index it, or nullopt to skip it.
		template <class T, class F>
		void Harvest(std::unordered_map<const RE::TESFile*, std::uint16_t>& map, F classify)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			for (auto* form : dh->GetFormArray<T>()) {
				if (!form)
					continue;
				const char* nm = form->GetName();
				if (!nm || !*nm)
					continue;  // nameless = internal/template junk, unofferable
				auto* file = form->GetFile(0);
				if (!file)
					continue;  // dynamic (0xFF…) — not durable, not listable
				const auto kind = classify(form);
				if (!kind)
					continue;
				Item it;
				it.formId = form->GetFormID();
				// File-width mask, exactly as GetLocalFormID would if it null-checked.
				it.localId = it.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				it.value = form->GetGoldValue();
				it.weight = form->GetWeight();
				it.plug = PlugIndexFor(file, map);
				it.kind = *kind;
				it.name = nm;
				it.lower = Lower(it.name);
				g_plugins[it.plug].count++;
				g_items.push_back(std::move(it));
			}
		}

		void EnsureIndex()
		{
			if (g_built)
				return;
			g_built = true;
			LoadSettings();
			const auto t0 = std::chrono::steady_clock::now();
			std::unordered_map<const RE::TESFile*, std::uint16_t> map;
			g_items.reserve(65536);

			Harvest<RE::TESObjectWEAP>(map, [](RE::TESObjectWEAP* w) -> std::optional<Kind> {
				if (w->weaponData.flags.any(RE::TESObjectWEAP::Data::Flag::kNonPlayable))
					return std::nullopt;
				return Kind::Weap;
			});
			Harvest<RE::TESObjectARMO>(map, [](RE::TESObjectARMO* a) -> std::optional<Kind> {
				// ARMO record flag 0x04 = NonPlayable (xEdit); CommonLib exposes no
				// named constant for it on armour, so the raw bit it is.
				if (a->formFlags & 0x04u)
					return std::nullopt;
				return Kind::Armo;
			});
			Harvest<RE::TESAmmo>(map, [](RE::TESAmmo*) -> std::optional<Kind> { return Kind::Ammo; });
			Harvest<RE::AlchemyItem>(map, [](RE::AlchemyItem* a) -> std::optional<Kind> {
				return a->IsFood() ? Kind::Food : Kind::Alch;
			});
			Harvest<RE::IngredientItem>(map, [](RE::IngredientItem*) -> std::optional<Kind> { return Kind::Ingr; });
			Harvest<RE::TESObjectBOOK>(map, [](RE::TESObjectBOOK*) -> std::optional<Kind> { return Kind::Book; });
			Harvest<RE::ScrollItem>(map, [](RE::ScrollItem*) -> std::optional<Kind> { return Kind::Scrl; });
			Harvest<RE::TESSoulGem>(map, [](RE::TESSoulGem*) -> std::optional<Kind> { return Kind::Slgm; });
			Harvest<RE::TESObjectMISC>(map, [](RE::TESObjectMISC*) -> std::optional<Kind> { return Kind::Misc; });
			Harvest<RE::TESKey>(map, [](RE::TESKey*) -> std::optional<Kind> { return Kind::Keym; });
			Harvest<RE::TESObjectLIGH>(map, [](RE::TESObjectLIGH* l) -> std::optional<Kind> {
				if (!l->data.flags.any(RE::TES_LIGHT_FLAGS::kCanCarry))
					return std::nullopt;
				return Kind::Ligh;
			});

			const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::steady_clock::now() - t0).count();
			logger::info("item-explorer: index built - {} items across {} plugins in {} ms",
				g_items.size(), g_plugins.size(), ms);
		}

		// ---------------------------------------------------------- queries --
		std::vector<std::string> Tokens(const std::string& q)
		{
			std::vector<std::string> out;
			std::string cur;
			for (char c : Lower(q)) {
				if (std::isspace(static_cast<unsigned char>(c))) {
					if (!cur.empty()) { out.push_back(cur); cur.clear(); }
				} else {
					cur += c;
				}
			}
			if (!cur.empty())
				out.push_back(cur);
			return out;
		}

		// Rank one token against one item. 0 best. -1 = no match at all.
		int TokenScore(const Item& it, const Plugin& pl, const std::string& tok)
		{
			const auto pos = it.lower.find(tok);
			if (pos == 0)
				return 0;                                     // name starts with it
			if (pos != std::string::npos) {
				const char before = it.lower[pos - 1];
				if (before == ' ' || before == '(' || before == '\'' || before == '-')
					return 1;                                 // a word starts with it
				return 2;                                     // buried substring
			}
			if (pl.lower.find(tok) != std::string::npos)
				return 4;                                     // only the plugin matches
			return -1;
		}
	}

	// ================================================================ API ==

	std::string StateJson()
	{
		EnsureIndex();
		json plugs = json::array();
		for (const auto& p : g_plugins) {
			if (!p.count)
				continue;
			plugs.push_back(json{ { "n", p.name }, { "c", p.count }, { "k", p.ext }, { "l", p.light } });
		}
		return Dump(json{
			{ "phase", "ready" },
			{ "count", g_items.size() },
			{ "gold", ReadGold() },
			{ "pay", g_pay },
			{ "mult", g_mult },
			{ "plugins", std::move(plugs) },
		});
	}

	std::string QueryJson(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string q = in.value("q", std::string(""));
		const std::string typeKey = in.value("type", std::string("all"));
		const std::string plugin = in.value("plugin", std::string(""));
		const int         seq = in.value("seq", 0);
		// (std::max) — parenthesized so windows.h's max macro cannot eat it
		const int         offset = (std::max)(0, in.value("offset", 0));
		const int         limit = std::clamp(in.value("limit", 60), 1, 200);

		const auto kindFilter = KindFromKey(typeKey);   // nullopt = all kinds
		const auto tokens = Tokens(q);
		const auto plugLower = Lower(plugin);

		struct Hit { int score; std::uint32_t idx; };
		std::vector<Hit> hits;
		hits.reserve(1024);

		for (std::uint32_t i = 0; i < g_items.size(); ++i) {
			const Item& it = g_items[i];
			if (kindFilter && it.kind != *kindFilter)
				continue;
			const Plugin& pl = g_plugins[it.plug];
			if (!plugLower.empty() && pl.lower != plugLower)
				continue;
			int score = 0;
			bool okAll = true;
			for (const auto& tok : tokens) {
				const int s = TokenScore(it, pl, tok);
				if (s < 0) { okAll = false; break; }
				score += s;
			}
			if (!okAll)
				continue;
			hits.push_back(Hit{ score, i });
		}

		const bool browse = tokens.empty();
		std::sort(hits.begin(), hits.end(), [browse](const Hit& a, const Hit& b) {
			const Item& x = g_items[a.idx];
			const Item& y = g_items[b.idx];
			if (browse) {
				// Shop-inventory order: kind, then name.
				if (x.kind != y.kind)
					return static_cast<std::uint8_t>(x.kind) < static_cast<std::uint8_t>(y.kind);
				return x.lower < y.lower;
			}
			if (a.score != b.score)
				return a.score < b.score;
			if (x.lower.size() != y.lower.size())
				return x.lower.size() < y.lower.size();   // tighter match first
			return x.lower < y.lower;
		});

		json items = json::array();
		const int total = static_cast<int>(hits.size());
		for (int i = offset; i < total && i < offset + limit; ++i) {
			const Item&   it = g_items[hits[static_cast<std::size_t>(i)].idx];
			const Plugin& pl = g_plugins[it.plug];
			char idbuf[16];
			std::snprintf(idbuf, sizeof(idbuf), "%06X", it.localId);
			items.push_back(json{
				{ "id", pl.name + "|" + idbuf },
				{ "n", it.name },
				{ "t", KindKey(it.kind) },
				{ "v", it.value },
				{ "w", it.weight },
				{ "p", pl.name },
			});
		}
		return Dump(json{
			{ "seq", seq }, { "total", total }, { "offset", offset }, { "items", std::move(items) } });
	}

	std::string Add(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string  id = in.value("id", std::string(""));
		const std::int32_t count = std::clamp(in.value("count", 1), 1, 1000);
		const bool         pay = in.value("pay", false);
		const std::int64_t price = std::clamp<std::int64_t>(in.value("price", 0), 0, 100000000);

		auto fail = [](const std::string& msg) {
			return Dump(json{ { "ok", false }, { "msg", msg }, { "gold", ReadGold() } });
		};

		const auto bar = id.find('|');
		if (bar == std::string::npos || bar == 0)
			return fail("Malformed item id");
		const std::string   plugin = id.substr(0, bar);
		const std::uint32_t local = static_cast<std::uint32_t>(
			std::strtoul(id.c_str() + bar + 1, nullptr, 16));

		auto* dh = RE::TESDataHandler::GetSingleton();
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!dh || !player)
			return fail("No game loaded");
		auto* form = dh->LookupForm(local, plugin);
		auto* bound = form ? form->As<RE::TESBoundObject>() : nullptr;
		if (!bound)
			return fail(plugin + " has no such item any more - rescan");
		const char* nm = bound->GetName();
		const std::string name = (nm && *nm) ? nm : "item";

		if (pay && price > 0) {
			const std::int64_t gold = ReadGold();
			if (gold >= 0 && gold < price)
				return fail("You carry " + std::to_string(gold) + " gold - this costs " +
					std::to_string(price));
			auto* goldForm = RE::TESForm::LookupByID<RE::TESBoundObject>(kGold);
			if (!goldForm)
				return fail("Gold form missing");
			player->RemoveItem(goldForm, static_cast<std::int32_t>(price),
				RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
		}

		player->AddObjectToContainer(bound, nullptr, count, nullptr);

		std::string note = name;
		if (count > 1)
			note += " x" + std::to_string(count);
		note = (pay && price > 0)
			? "Bought " + note + " - " + std::to_string(price) + " gold"
			: "+ " + note;
		RE::DebugNotification(note.c_str());
		logger::info("item-explorer: add {} x{} from {} (paid {})", name, count, plugin,
			pay ? price : 0);

		return Dump(json{ { "ok", true }, { "msg", note }, { "gold", ReadGold() } });
	}

	std::string Save(const std::string& req)
	{
		LoadSettings();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		if (in.contains("pay"))
			g_pay = in.value("pay", g_pay);
		if (in.contains("mult"))
			g_mult = std::clamp(in.value("mult", g_mult), 0.0, 100.0);
		SaveSettingsFile();
		return Dump(json{ { "ok", true }, { "pay", g_pay }, { "mult", g_mult } });
	}
}
