#include "finance.h"

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp (as nlohmann::json),
// `namespace logger = SKSE::log`, and `using namespace std::literals`.

namespace Finance
{
	namespace
	{
		constexpr RE::FormID kGold = 0x0000000F;   // Gold001 (TESObjectMISC / TESBoundObject)

		RE::TESBoundObject* GoldForm() { return RE::TESForm::LookupByID<RE::TESBoundObject>(kGold); }
		void                Notify(const std::string& m) { RE::DebugNotification(m.c_str()); }

		// thousands separator, matching the view's fmtGold()
		std::string Fmt(std::int64_t n)
		{
			const bool neg = n < 0;
			// 0ULL - (ull)n is the two's-complement magnitude without the C4146
			// "unary minus on unsigned" warning; -(ull) would warn.
			std::string s = std::to_string(neg ? (0ULL - static_cast<unsigned long long>(n)) : static_cast<unsigned long long>(n));
			for (int i = static_cast<int>(s.size()) - 3; i > 0; i -= 3)
				s.insert(static_cast<std::size_t>(i), ",");
			return (neg ? "-" : "") + s;
		}

		std::string Stamp()
		{
			static constexpr std::array<const char*, 12> kMonths{
				"Morning Star", "Sun's Dawn", "First Seed", "Rain's Hand", "Second Seed", "Midyear",
				"Sun's Height", "Last Seed", "Hearthfire", "Frostfall", "Sun's Dusk", "Evening Star"
			};
			auto* cal = RE::Calendar::GetSingleton();
			if (!cal)
				return "";
			const int   day = static_cast<int>(cal->GetDay());
			const int   mon = static_cast<int>(cal->GetMonth());   // 0-based
			const int   yr  = static_cast<int>(cal->GetYear());
			const char* mn  = (mon >= 0 && mon < 12) ? kMonths[static_cast<std::size_t>(mon)] : "";
			return std::to_string(day) + " " + mn + " 4E" + std::to_string(yr);
		}
		std::string NewId(const char* p)
		{
			auto*                cal = RE::Calendar::GetSingleton();
			const std::uint64_t  t   = cal ? static_cast<std::uint64_t>(cal->GetDaysPassed() * 100000.0) : 0;
			static std::uint32_t seq = 0;
			return std::string(p) + std::to_string(t) + "-" + std::to_string(++seq);
		}

		// GetGoldAmount() walks the player's ENTIRE inventory (CommonLib code linked
		// into this dll); on a 4000-plugin load order that can fault inside our module,
		// and the Finances tab is the ONLY view that reads gold — so it alone would
		// crash. Keep the walk in its own frame (it owns the C++ unwinding) and wrap the
		// CALL in SEH: a bad inventory reports a sentinel instead of taking the game
		// down. ReadGold itself has no C++ objects, so __try/__except is legal (no C2712).
		__declspec(noinline) std::int64_t ReadGoldRaw()
		{
			auto* p = RE::PlayerCharacter::GetSingleton();
			if (!p)
				return 0;
			// Sum Gold001 straight from the inventory-changes entry list, null-guarded.
			// This touches ONLY gold entries, avoiding CommonLib's GetInventory<>()
			// which rebuilds EVERY item's entry (and faulted somewhere in a 4000-plugin
			// load order — the tab-open CTD). SEH in ReadGold() still backs this up.
			std::int64_t total   = 0;
			auto*        changes = p->GetInventoryChanges();
			if (changes && changes->entryList) {
				for (auto* entry : *changes->entryList) {
					if (entry && entry->object && entry->object->GetFormID() == 0x0000000F)
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
				return -1;   // sentinel: caller logs it and shows 0
			}
		}
		void AddGold(std::int64_t n)
		{
			if (n <= 0)
				return;
			auto* p = RE::PlayerCharacter::GetSingleton();
			auto* g = GoldForm();
			if (p && g)
				p->AddObjectToContainer(g, nullptr, static_cast<std::int32_t>(n), nullptr);
		}
		void RemoveGold(std::int64_t n)   // RemoveItem clamps; callers gate on ReadGold() first
		{
			if (n <= 0)
				return;
			auto* p = RE::PlayerCharacter::GetSingleton();
			auto* g = GoldForm();
			if (p && g)
				p->RemoveItem(g, static_cast<std::int32_t>(n), RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
		}

		std::string S(const nlohmann::json& j, const char* k) { return j.value(k, std::string("")); }

		nlohmann::json LineJson(const Line& l)
		{
			return { { "id", l.id }, { "name", l.name }, { "kind", l.kind }, { "category", l.category },
				{ "amount", l.amount }, { "domainId", l.domainId }, { "note", l.note }, { "icon", l.icon } };
		}
		nlohmann::json MarketJson(const Market& m)
		{
			return { { "id", m.id }, { "name", m.name }, { "side", m.side }, { "price", m.price },
				{ "note", m.note }, { "icon", m.icon } };
		}
		nlohmann::json LedgerJson(const Ledger& e)
		{
			return { { "id", e.id }, { "stamp", e.stamp }, { "kind", e.kind }, { "label", e.label },
				{ "delta", e.delta }, { "goldBefore", e.goldBefore }, { "goldAfter", e.goldAfter },
				{ "debtAfter", e.debtAfter } };
		}
		Line LineFrom(const nlohmann::json& j)
		{
			Line l;
			l.id       = S(j, "id");
			l.name     = j.value("name", std::string("Untitled"));
			l.kind     = (j.value("kind", std::string("expense")) == "income") ? "income" : "expense";
			l.category = j.value("category", std::string("other"));
			l.amount   = j.value("amount", 0u);
			l.domainId = S(j, "domainId");
			l.note     = S(j, "note");
			l.icon     = S(j, "icon");
			return l;
		}
		Market MarketFrom(const nlohmann::json& j)
		{
			Market m;
			m.id    = S(j, "id");
			m.name  = j.value("name", std::string("Untitled"));
			m.side  = (j.value("side", std::string("buy")) == "sell") ? "sell" : "buy";
			m.price = j.value("price", 0u);
			m.note  = S(j, "note");
			m.icon  = S(j, "icon");
			return m;
		}
		nlohmann::json PropertyJson(const Property& p)
		{
			return { { "id", p.id }, { "name", p.name }, { "cost", p.cost }, { "value", p.value },
				{ "upkeep", p.upkeep }, { "domainId", p.domainId }, { "note", p.note }, { "icon", p.icon } };
		}
		Property PropertyFrom(const nlohmann::json& j)
		{
			Property p;
			p.id       = S(j, "id");
			p.name     = j.value("name", std::string("Untitled"));
			p.cost     = j.value("cost", 0u);
			p.value    = j.value("value", 0u);
			p.upkeep   = j.value("upkeep", 0u);
			p.domainId = S(j, "domainId");
			p.note     = S(j, "note");
			p.icon     = S(j, "icon");
			return p;
		}
		Ledger LedgerFrom(const nlohmann::json& j)
		{
			Ledger e;
			e.id         = S(j, "id");
			e.stamp      = S(j, "stamp");
			e.kind       = j.value("kind", std::string("settle"));
			e.label      = S(j, "label");
			e.delta      = j.value("delta", static_cast<std::int64_t>(0));
			e.goldBefore = j.value("goldBefore", static_cast<std::int64_t>(0));
			e.goldAfter  = j.value("goldAfter", static_cast<std::int64_t>(0));
			e.debtAfter  = j.value("debtAfter", static_cast<std::int64_t>(0));
			return e;
		}

		std::uint32_t ParseAmount(const std::string& v)
		{
			try {
				long long n = std::stoll(v);
				return n > 0 ? static_cast<std::uint32_t>(n) : 0u;
			} catch (...) {
				return 0u;
			}
		}
		// portal "set" ops touch only VIEW-owned fields
		void ApplyLineField(Line& l, const std::string& key, const std::string& value)
		{
			if (key == "name")          l.name = value;
			else if (key == "kind")     l.kind = (value == "income") ? "income" : "expense";
			else if (key == "category") l.category = value;
			else if (key == "amount")   l.amount = ParseAmount(value);
			else if (key == "domainId") l.domainId = value;
			else if (key == "note")     l.note = value;
			else if (key == "icon")     l.icon = value;
		}
		void ApplyMarketField(Market& m, const std::string& key, const std::string& value)
		{
			if (key == "name")       m.name = value;
			else if (key == "side")  m.side = (value == "sell") ? "sell" : "buy";
			else if (key == "price") m.price = ParseAmount(value);
			else if (key == "note")  m.note = value;
			else if (key == "icon")  m.icon = value;
		}
		void ApplyPropertyField(Property& p, const std::string& key, const std::string& value)
		{
			if (key == "name")          p.name = value;
			else if (key == "cost")     p.cost = ParseAmount(value);
			else if (key == "value")    p.value = ParseAmount(value);
			else if (key == "upkeep")   p.upkeep = ParseAmount(value);
			else if (key == "domainId") p.domainId = value;
			else if (key == "note")     p.note = value;
			else if (key == "icon")     p.icon = value;
		}

		bool IsOwned(const Config& cfg, const std::string& id)
		{
			return std::find(cfg.ownedProps.begin(), cfg.ownedProps.end(), id) != cfg.ownedProps.end();
		}
		const Property* PropById(const Config& cfg, const std::string& id)
		{
			for (const auto& p : cfg.properties)
				if (p.id == id)
					return &p;
			return nullptr;
		}
		// Total worth of currently-owned properties (net-worth asset side).
		std::int64_t OwnedValue(const Config& cfg)
		{
			std::int64_t v = 0;
			for (const auto& id : cfg.ownedProps)
				if (const Property* p = PropById(cfg, id))
					v += static_cast<std::int64_t>(p->value);
			return v;
		}
		// Sum of upkeep across owned properties — folded into the monthly bill at Settle.
		std::int64_t OwnedUpkeep(const Config& cfg)
		{
			std::int64_t u = 0;
			for (const auto& id : cfg.ownedProps)
				if (const Property* p = PropById(cfg, id))
					u += static_cast<std::int64_t>(p->upkeep);
			return u;
		}
		// gold + owned asset value − debt. Faulted gold reads as 0 (never negative net
		// from a bad read alone).
		std::int64_t NetWorth(const Config& cfg, std::int64_t gold)
		{
			if (gold < 0)
				gold = 0;
			return gold + OwnedValue(cfg) - static_cast<std::int64_t>(cfg.debt);
		}

		void PushLedger(Config& cfg, const std::string& kind, const std::string& label,
			std::int64_t delta, std::int64_t goldBefore, std::int64_t goldAfter)
		{
			Ledger e;
			e.id         = NewId("g");
			e.stamp      = Stamp();
			e.kind       = kind;
			e.label      = label;
			e.delta      = delta;
			e.goldBefore = goldBefore;
			e.goldAfter  = goldAfter;
			e.debtAfter  = static_cast<std::int64_t>(cfg.debt);
			cfg.ledger.insert(cfg.ledger.begin(), std::move(e));
			const std::size_t cap = cfg.ledgerMax ? cfg.ledgerMax : 120;
			if (cfg.ledger.size() > cap)
				cfg.ledger.resize(cap);
		}

		std::filesystem::path PortalFile()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "portal-finances.json";
		}
	}

	void Init() { logger::info("Finance: ready"); }

	std::int64_t GetGold() { return ReadGold(); }

	nlohmann::json ToJson(const Config& c)
	{
		nlohmann::json lines = nlohmann::json::array();
		for (const auto& l : c.lines)
			lines.push_back(LineJson(l));
		nlohmann::json market = nlohmann::json::array();
		for (const auto& m : c.market)
			market.push_back(MarketJson(m));
		nlohmann::json led = nlohmann::json::array();
		for (const auto& e : c.ledger)
			led.push_back(LedgerJson(e));
		nlohmann::json props = nlohmann::json::array();
		for (const auto& p : c.properties)
			props.push_back(PropertyJson(p));
		nlohmann::json owned = nlohmann::json::array();
		for (const auto& id : c.ownedProps)
			owned.push_back(id);
		return nlohmann::json{ { "lines", lines }, { "market", market },
			{ "properties", props }, { "ownedProps", owned },
			{ "debt", c.debt }, { "ledger", led },
			{ "settings", { { "ledgerMax", c.ledgerMax }, { "autoSettle", c.autoSettle }, { "lastSettleEpoch", c.lastSettleEpoch } } } };
	}

	void FromJson(const nlohmann::json& j, Config& out)
	{
		Config c;
		if (j.is_object()) {
			if (j.contains("lines") && j["lines"].is_array())
				for (const auto& jl : j["lines"]) {
					auto l = LineFrom(jl);
					if (!l.id.empty())
						c.lines.push_back(std::move(l));
				}
			if (j.contains("market") && j["market"].is_array())
				for (const auto& jm : j["market"]) {
					auto m = MarketFrom(jm);
					if (!m.id.empty())
						c.market.push_back(std::move(m));
				}
			if (j.contains("properties") && j["properties"].is_array())
				for (const auto& jp : j["properties"]) {
					auto p = PropertyFrom(jp);
					if (!p.id.empty())
						c.properties.push_back(std::move(p));
				}
			if (j.contains("ownedProps") && j["ownedProps"].is_array())
				for (const auto& jo : j["ownedProps"])
					if (jo.is_string())
						c.ownedProps.push_back(jo.get<std::string>());
			c.debt = j.value("debt", static_cast<std::uint64_t>(0));
			if (j.contains("ledger") && j["ledger"].is_array())
				for (const auto& je : j["ledger"])
					c.ledger.push_back(LedgerFrom(je));
			if (j.contains("settings") && j["settings"].is_object()) {
				c.ledgerMax       = j["settings"].value("ledgerMax", 120u);
				c.autoSettle      = j["settings"].value("autoSettle", false);
				c.lastSettleEpoch = j["settings"].value("lastSettleEpoch", -1);
			}
		}
		if (!c.ledgerMax)
			c.ledgerMax = 120;
		out = std::move(c);
	}

	bool MergeViewSlice(const std::string& viewJson, Config& cfg)
	{
		auto j = nlohmann::json::parse(viewJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return false;
		if (j.contains("lines") && j["lines"].is_array()) {
			cfg.lines.clear();
			for (const auto& jl : j["lines"]) {
				auto l = LineFrom(jl);
				if (!l.id.empty())
					cfg.lines.push_back(std::move(l));
			}
		}
		if (j.contains("market") && j["market"].is_array()) {
			cfg.market.clear();
			for (const auto& jm : j["market"]) {
				auto m = MarketFrom(jm);
				if (!m.id.empty())
					cfg.market.push_back(std::move(m));
			}
		}
		if (j.contains("properties") && j["properties"].is_array()) {
			cfg.properties.clear();
			for (const auto& jp : j["properties"]) {
				auto p = PropertyFrom(jp);
				if (!p.id.empty())
					cfg.properties.push_back(std::move(p));
			}
			// Prune ownership of any property the view just deleted, so a dangling
			// owned id can never inflate net worth against a property that's gone.
			std::erase_if(cfg.ownedProps, [&](const std::string& id) { return PropById(cfg, id) == nullptr; });
		}
		if (j.contains("settings") && j["settings"].is_object()) {
			cfg.ledgerMax  = j["settings"].value("ledgerMax", cfg.ledgerMax ? cfg.ledgerMax : 120u);
			cfg.autoSettle = j["settings"].value("autoSettle", cfg.autoSettle);
			// lastSettleEpoch stays C++-owned — never taken from the view.
		}
		return true;   // ownedProps + debt + ledger deliberately untouched (C++-owned)
	}

	// The two view-push payloads are built BY HAND — no nlohmann — on purpose. The
	// tab-open CTD lived here and the fault signature (a char-class read off a garbage
	// pointer, behind a locale/static-init guard) is the JSON serializer, not our data
	// (which is clean). PersistAll's dump works, but the ONLY differences on this path
	// were ReadGold() and dumping the modified object — so we take nlohmann out of it
	// entirely: std::to_string + manual escaping only, both locale-free.

	// Quote + escape a std::string as a JSON string. UTF-8 bytes pass through; the
	// seven required specials are escaped; other control bytes become \u00XX. No
	// nlohmann, no snprintf, no locale.
	std::string JStr(const std::string& s)
	{
		static const char kHex[] = "0123456789abcdef";
		std::string       o;
		o.reserve(s.size() + 2);
		o += '"';
		for (const unsigned char ch : s) {
			switch (ch) {
			case '"':  o += "\\\""; break;
			case '\\': o += "\\\\"; break;
			case '\n': o += "\\n"; break;
			case '\r': o += "\\r"; break;
			case '\t': o += "\\t"; break;
			case '\b': o += "\\b"; break;
			case '\f': o += "\\f"; break;
			default:
				if (ch < 0x20) {
					o += "\\u00";
					o += kHex[ch >> 4];
					o += kHex[ch & 0xF];
				} else {
					o += static_cast<char>(ch);
				}
			}
		}
		o += '"';
		return o;
	}

	std::string OpenJson(const Config& c, const std::string& iconsJsonArray)
	{
		std::string s;
		s.reserve(4096);
		s += "{\"lines\":[";
		for (std::size_t i = 0; i < c.lines.size(); ++i) {
			const Line& l = c.lines[i];
			if (i)
				s += ',';
			s += "{\"id\":";
			s += JStr(l.id);
			s += ",\"name\":";
			s += JStr(l.name);
			s += ",\"kind\":";
			s += JStr(l.kind);
			s += ",\"category\":";
			s += JStr(l.category);
			s += ",\"amount\":";
			s += std::to_string(l.amount);
			s += ",\"domainId\":";
			s += JStr(l.domainId);
			s += ",\"note\":";
			s += JStr(l.note);
			s += ",\"icon\":";
			s += JStr(l.icon);
			s += '}';
		}
		s += "],\"market\":[";
		for (std::size_t i = 0; i < c.market.size(); ++i) {
			const Market& m = c.market[i];
			if (i)
				s += ',';
			s += "{\"id\":";
			s += JStr(m.id);
			s += ",\"name\":";
			s += JStr(m.name);
			s += ",\"side\":";
			s += JStr(m.side);
			s += ",\"price\":";
			s += std::to_string(m.price);
			s += ",\"note\":";
			s += JStr(m.note);
			s += ",\"icon\":";
			s += JStr(m.icon);
			s += '}';
		}
		s += "],\"properties\":[";
		for (std::size_t i = 0; i < c.properties.size(); ++i) {
			const Property& p = c.properties[i];
			if (i)
				s += ',';
			s += "{\"id\":";
			s += JStr(p.id);
			s += ",\"name\":";
			s += JStr(p.name);
			s += ",\"cost\":";
			s += std::to_string(p.cost);
			s += ",\"value\":";
			s += std::to_string(p.value);
			s += ",\"upkeep\":";
			s += std::to_string(p.upkeep);
			s += ",\"domainId\":";
			s += JStr(p.domainId);
			s += ",\"note\":";
			s += JStr(p.note);
			s += ",\"icon\":";
			s += JStr(p.icon);
			s += '}';
		}
		s += "],\"ownedProps\":[";
		for (std::size_t i = 0; i < c.ownedProps.size(); ++i) {
			if (i)
				s += ',';
			s += JStr(c.ownedProps[i]);
		}
		s += "],\"debt\":";
		s += std::to_string(static_cast<unsigned long long>(c.debt));
		s += ",\"ledger\":[";
		for (std::size_t i = 0; i < c.ledger.size(); ++i) {
			const Ledger& e = c.ledger[i];
			if (i)
				s += ',';
			s += "{\"id\":";
			s += JStr(e.id);
			s += ",\"stamp\":";
			s += JStr(e.stamp);
			s += ",\"kind\":";
			s += JStr(e.kind);
			s += ",\"label\":";
			s += JStr(e.label);
			s += ",\"delta\":";
			s += std::to_string(e.delta);
			s += ",\"goldBefore\":";
			s += std::to_string(e.goldBefore);
			s += ",\"goldAfter\":";
			s += std::to_string(e.goldAfter);
			s += ",\"debtAfter\":";
			s += std::to_string(e.debtAfter);
			s += '}';
		}
		s += "],\"settings\":{\"ledgerMax\":";
		s += std::to_string(c.ledgerMax);
		s += ",\"autoSettle\":";
		s += (c.autoSettle ? "true" : "false");
		s += ",\"lastSettleEpoch\":";
		s += std::to_string(c.lastSettleEpoch);
		s += "}";

		std::int64_t gold = ReadGold();
		if (gold < 0) {
			logger::warn("[fin] gold read faulted — showing 0 this open");
			gold = 0;
		}
		s += ",\"gold\":";
		s += std::to_string(gold);
		s += ",\"netWorth\":";
		s += std::to_string(NetWorth(c, gold));

		// icons: embed the pool array verbatim (already valid JSON); never re-parse.
		std::string arr = "[]";
		for (const char ch : iconsJsonArray) {
			if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r')
				continue;
			if (ch == '[')
				arr = iconsJsonArray;
			break;
		}
		s += ",\"icons\":";
		s += arr;
		s += "}";
		return s;
	}

	std::string StateJson(const Config& c)
	{
		std::int64_t gold = ReadGold();
		if (gold < 0)
			gold = 0;
		std::string s = "{\"gold\":";
		s += std::to_string(gold);
		s += ",\"netWorth\":";
		s += std::to_string(NetWorth(c, gold));
		s += ",\"debt\":";
		s += std::to_string(static_cast<unsigned long long>(c.debt));
		s += ",\"ownedProps\":[";
		for (std::size_t i = 0; i < c.ownedProps.size(); ++i) {
			if (i)
				s += ',';
			s += JStr(c.ownedProps[i]);
		}
		s += "],\"ledger\":[";
		for (std::size_t i = 0; i < c.ledger.size(); ++i) {
			const Ledger& e = c.ledger[i];
			if (i)
				s += ',';
			s += "{\"id\":";
			s += JStr(e.id);
			s += ",\"stamp\":";
			s += JStr(e.stamp);
			s += ",\"kind\":";
			s += JStr(e.kind);
			s += ",\"label\":";
			s += JStr(e.label);
			s += ",\"delta\":";
			s += std::to_string(e.delta);
			s += ",\"goldBefore\":";
			s += std::to_string(e.goldBefore);
			s += ",\"goldAfter\":";
			s += std::to_string(e.goldAfter);
			s += ",\"debtAfter\":";
			s += std::to_string(e.debtAfter);
			s += '}';
		}
		s += "]}";
		return s;
	}

	std::string Settle(Config& cfg)
	{
		std::int64_t income = 0, expense = 0;
		for (const auto& l : cfg.lines) {
			if (l.kind == "income")
				income += l.amount;
			else
				expense += l.amount;
		}
		expense += OwnedUpkeep(cfg);   // owned properties bill their monthly upkeep too
		const std::int64_t goldBefore = ReadGold();
		AddGold(income);
		const std::int64_t bill  = expense + static_cast<std::int64_t>(cfg.debt);
		const std::int64_t avail = ReadGold();                       // goldBefore + income
		// pay what you can afford, never negative. Written without std::min/max:
		// <windows.h> (via RE/Skyrim.h) #defines min/max as macros, which mangle
		// std::min/std::max<T>(...) at compile time.
		std::int64_t pay = avail < bill ? avail : bill;
		if (pay < 0)
			pay = 0;
		RemoveGold(pay);
		cfg.debt                 = static_cast<std::uint64_t>(bill - pay);
		const std::int64_t after = ReadGold();
		PushLedger(cfg, "settle", "Monthly settle", after - goldBefore, goldBefore, after);
		std::string msg = "Settled: +" + Fmt(income) + " \xC2\xB7 \xE2\x88\x92" + Fmt(pay) +
			(cfg.debt ? " \xC2\xB7 debt " + Fmt(static_cast<std::int64_t>(cfg.debt)) : "");
		Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	bool MaybeAutoSettle(Config& cfg)
	{
		auto* cal = RE::Calendar::GetSingleton();
		if (!cal)
			return false;
		const std::int32_t epoch =
			static_cast<std::int32_t>(cal->GetYear()) * 12 + static_cast<std::int32_t>(cal->GetMonth());
		// First sight OR auto OFF: just remember the current month, so enabling it
		// later never back-settles a pile of missed months.
		if (cfg.lastSettleEpoch < 0 || !cfg.autoSettle) {
			const bool changed  = cfg.lastSettleEpoch != epoch;
			cfg.lastSettleEpoch = epoch;
			return changed;
		}
		if (epoch <= cfg.lastSettleEpoch)
			return false;
		Settle(cfg);                     // moves gold + appends a ledger entry + notifies
		cfg.lastSettleEpoch = epoch;     // one settle per rollover, even if several passed
		return true;
	}

	std::string Buy(Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string  name  = j.value("name", std::string("item"));
		const std::int64_t price = static_cast<std::int64_t>(j.value("price", 0u));
		if (price <= 0)
			return nlohmann::json{ { "ok", false }, { "msg", "No price set" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		const std::int64_t gold = ReadGold();
		if (gold < price) {
			std::string msg = "Not enough gold \xE2\x80\x94 short " + Fmt(price - gold);
			Notify(msg);
			return nlohmann::json{ { "ok", false }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		RemoveGold(price);
		PushLedger(cfg, "buy", name, -price, gold, ReadGold());
		std::string msg = "Bought " + name + " (\xE2\x88\x92" + Fmt(price) + ")";
		Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string Sell(Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string  name  = j.value("name", std::string("item"));
		const std::int64_t value = static_cast<std::int64_t>(j.value("value", 0u));
		if (value <= 0)
			return nlohmann::json{ { "ok", false }, { "msg", "No value set" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		const std::int64_t gold = ReadGold();
		AddGold(value);
		PushLedger(cfg, "sell", name, value, gold, ReadGold());
		std::string msg = "Sold " + name + " (+" + Fmt(value) + ")";
		Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string BuyProperty(Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string id = j.value("id", std::string(""));
		const Property*    p  = PropById(cfg, id);
		if (!p)
			return nlohmann::json{ { "ok", false }, { "msg", "Unknown property" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		if (IsOwned(cfg, id)) {
			std::string msg = "Already own " + p->name;
			Notify(msg);
			return nlohmann::json{ { "ok", false }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		const std::int64_t cost = static_cast<std::int64_t>(p->cost);
		const std::int64_t gold = ReadGold();
		if (gold < cost) {
			std::string msg = "Not enough gold \xE2\x80\x94 short " + Fmt(cost - gold);
			Notify(msg);
			return nlohmann::json{ { "ok", false }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		const std::string name = p->name;   // copy before any vector churn
		RemoveGold(cost);
		cfg.ownedProps.push_back(id);
		PushLedger(cfg, "buy", "Bought " + name, -cost, gold, ReadGold());
		std::string msg = "Bought " + name + " (\xE2\x88\x92" + Fmt(cost) + ")";
		Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string SellProperty(Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string id = j.value("id", std::string(""));
		const Property*    p  = PropById(cfg, id);
		if (!p)
			return nlohmann::json{ { "ok", false }, { "msg", "Unknown property" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		if (!IsOwned(cfg, id)) {
			std::string msg = "You don't own " + p->name;
			Notify(msg);
			return nlohmann::json{ { "ok", false }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		const std::int64_t value = static_cast<std::int64_t>(p->value);
		const std::string  name  = p->name;
		const std::int64_t gold  = ReadGold();
		AddGold(value);
		std::erase(cfg.ownedProps, id);
		PushLedger(cfg, "sell", "Sold " + name, value, gold, ReadGold());
		std::string msg = "Sold " + name + " (+" + Fmt(value) + ")";
		Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// Portal sidecar shape (written by the Deck Portal, never the live hotkeys.json):
	//   { "version":1, "ops":[
	//       {"op":"set","target":"line"|"market"|"property","id":"<id>","key":"<field>","value":"<str>"},
	//       {"op":"add","target":"line"|"market"|"property", ...full record fields...},
	//       {"op":"del","target":"line"|"market"|"property","id":"<id>"} ] }
	// Only VIEW-owned fields are touched. Unknown ids on "set" are skipped.
	bool ApplyPortalFinances(Config& cfg)
	{
		const auto      file = PortalFile();
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;
		bool changed = false;
		{
			std::ifstream in(file, std::ios::binary);
			if (in.is_open()) {
				auto j = nlohmann::json::parse(in, nullptr, false);
				if (!j.is_discarded() && j.is_object() && j.contains("ops") && j["ops"].is_array()) {
					for (const auto& op : j["ops"]) {
						if (!op.is_object())
							continue;
						const std::string kind = op.value("op", std::string(""));
						const std::string tgt  = op.value("target", std::string(""));
						const std::string id   = op.value("id", std::string(""));
						if (tgt == "line") {
							if (kind == "add") {
								auto l = LineFrom(op);
								if (l.id.empty())
									l.id = NewId("l");
								cfg.lines.insert(cfg.lines.begin(), std::move(l));
								changed = true;
							} else if (kind == "del") {
								if (std::erase_if(cfg.lines, [&](const Line& l) { return l.id == id; }) > 0)
									changed = true;
							} else if (kind == "set") {
								for (auto& l : cfg.lines)
									if (l.id == id) {
										ApplyLineField(l, op.value("key", std::string("")), op.value("value", std::string("")));
										changed = true;
									}
							}
						} else if (tgt == "market") {
							if (kind == "add") {
								auto m = MarketFrom(op);
								if (m.id.empty())
									m.id = NewId("m");
								cfg.market.insert(cfg.market.begin(), std::move(m));
								changed = true;
							} else if (kind == "del") {
								if (std::erase_if(cfg.market, [&](const Market& m) { return m.id == id; }) > 0)
									changed = true;
							} else if (kind == "set") {
								for (auto& m : cfg.market)
									if (m.id == id) {
										ApplyMarketField(m, op.value("key", std::string("")), op.value("value", std::string("")));
										changed = true;
									}
							}
						} else if (tgt == "property") {
							// Only property DEFINITIONS are portal-editable — buy/sell move
							// real gold and must happen in-game, never from a queued sidecar.
							if (kind == "add") {
								auto p = PropertyFrom(op);
								if (p.id.empty())
									p.id = NewId("p");
								cfg.properties.insert(cfg.properties.begin(), std::move(p));
								changed = true;
							} else if (kind == "del") {
								if (std::erase_if(cfg.properties, [&](const Property& p) { return p.id == id; }) > 0) {
									std::erase(cfg.ownedProps, id);
									changed = true;
								}
							} else if (kind == "set") {
								for (auto& p : cfg.properties)
									if (p.id == id) {
										ApplyPropertyField(p, op.value("key", std::string("")), op.value("value", std::string("")));
										changed = true;
									}
							}
						}
					}
				}
			}
		}
		// Consume it either way — a file we could not apply must not retry forever.
		std::filesystem::remove(file, ec);
		if (ec) {
			std::ofstream out(file, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << R"({"version":1,"ops":[]})";
		}
		return changed;
	}
}
