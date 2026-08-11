#pragma once

#include <cstdint>
#include <string>
#include <vector>

// Financial Manager backend for the Hotkey Deck "Finances" tab. Encapsulates the
// finances config slice AND the gold-moving operations, so main.cpp holds only a
// global + thin JS handlers (mirrors spell_actions / place_actions).
//
// Ownership: the VIEW owns lines/market/settings (sent whole via finSave ->
// MergeViewSlice); C++ owns gold/debt/ledger (Settle/Buy/Sell move real Gold001
// and append the ledger). See src/finance-wiring.md.
namespace Finance
{
	struct Line
	{
		std::string   id, name, kind /*income|expense*/, category;
		std::uint32_t amount = 0;
		std::string   domainId, note, icon;
	};
	struct Market
	{
		std::string   id, name, side /*buy|sell*/;
		std::uint32_t price = 0;
		std::string   note, icon;
	};
	// A durable asset (manor, estate, business). The VIEW owns the definition
	// (name/cost/value/upkeep/…); C++ owns WHICH are currently owned (Config::ownedProps)
	// because flipping that moves real gold. `cost` is the gold spent to buy, `value`
	// is its worth (counts toward net worth while owned, and is the gold returned on
	// sell), `upkeep` is an optional monthly expense folded into Settle while owned.
	struct Property
	{
		std::string   id, name;
		std::uint32_t cost = 0, value = 0, upkeep = 0;
		std::string   domainId, note, icon;
	};
	struct Ledger
	{
		std::string  id, stamp, kind /*settle|buy|sell*/, label;
		std::int64_t delta = 0, goldBefore = 0, goldAfter = 0, debtAfter = 0;
	};
	struct Config
	{
		std::vector<Line>     lines;
		std::vector<Market>   market;
		std::vector<Property> properties;              // VIEW-owned definitions
		std::vector<std::string> ownedProps;           // C++-owned: ids currently owned
		std::uint64_t       debt = 0;
		std::vector<Ledger> ledger;
		std::uint32_t       ledgerMax     = 120;
		bool                autoSettle    = false;   // settle once per in-game month
		std::int32_t        lastSettleEpoch = -1;    // year*12+month of the last (auto) settle
	};

	void Init();

	// Persisted slice (full: lines/market/debt/ledger/settings). ToJson returns a
	// json OBJECT for WriteConfigFile to drop under "finances"; FromJson is what
	// LoadConfig reads back.
	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& out);

	// Apply a VIEW finSave payload (lines/market/settings only) — debt/ledger are
	// left exactly as they were. Returns false on an unparseable payload.
	bool MergeViewSlice(const std::string& viewJson, Config& cfg);

	// Payloads pushed to the view. `iconsJsonArray` is DeckCustomIconsJson()'s
	// output (a JSON array string of "icons/custom/<file>" paths).
	std::string OpenJson(const Config& c, const std::string& iconsJsonArray);  // finOpen(cfg)
	std::string StateJson(const Config& c);                                    // finState({gold,debt,ledger})

	// Operations (MAIN THREAD ONLY — they move real gold). Each returns {ok,msg}
	// and, on success, mutates cfg.debt/ledger.
	std::string Settle(Config& cfg);
	std::string Buy(Config& cfg, const std::string& reqJson);
	std::string Sell(Config& cfg, const std::string& reqJson);

	// Property operations ({id}). BuyProperty charges cost and marks it owned (blocks
	// when broke / already owned); SellProperty returns value in gold and clears
	// ownership. Both append a ledger row and mutate cfg.ownedProps.
	std::string BuyProperty(Config& cfg, const std::string& reqJson);
	std::string SellProperty(Config& cfg, const std::string& reqJson);

	// If autoSettle is on and the in-game month has advanced since lastSettleEpoch,
	// run one Settle and stamp the new epoch. Tracks the epoch even while OFF so
	// enabling it never back-settles. Returns true if anything changed (settle OR a
	// baseline/epoch update) so the caller persists. Call on the main thread.
	bool MaybeAutoSettle(Config& cfg);

	std::int64_t GetGold();   // main thread

	// Portal replay: read Data/PrismaUI/views/HotkeyDeck/portal-finances.json,
	// apply queued ops to cfg (view-owned fields only), then delete/blank it.
	// Returns true if anything changed (caller: PersistAll + re-push finOpen).
	bool ApplyPortalFinances(Config& cfg);
}
