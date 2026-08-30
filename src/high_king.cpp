#include "high_king.h"

#include <cmath>
#include <cstring>

// pch (force-included) provides RE::/SKSE::/json/logger and std::literals.

using json = nlohmann::json;

namespace HighKing
{
	namespace
	{
		// ------------------------------------------------------------ lookups
		// Every id below is the LOCAL FormID inside BecomeKingofSkyrimTNG.esp,
		// dumped from the plugin's own GLOB/QUST/SPEL groups (2026-08-18).
		// LookupForm applies the load-order / ESL prefix, so these survive any
		// load-order shuffle — the same identity law the whole deck follows.

		template <class T>
		T* Form(std::uint32_t localId)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh ? dh->LookupForm<T>(localId, kPlugin) : nullptr;
		}

		double GVal(std::uint32_t localId, double fallback = 0.0)
		{
			auto* g = Form<RE::TESGlobal>(localId);
			return g ? static_cast<double>(g->value) : fallback;
		}

		bool GBool(std::uint32_t localId)
		{
			return GVal(localId) >= 0.5;
		}

		// ------------------------------------------------------------- tables

		// One tax hold: the mod's ten. `city` is the display capital — approval
		// and faith are CITY-keyed globals (AAApprovalWhiterun...), taxes are
		// HOLD-keyed (AATax_Rate_ThePale...). rebelActive/rebelBribed are 0 for
		// Highreach (the mod has no rebellion row for the crown's own keep).
		struct Hold
		{
			const char*   id;
			const char*   name;
			const char*   city;
			std::uint32_t base, head, rate, revenue;
			std::uint32_t approval, approvalDelta, approvalTier;
			std::uint32_t faith, faithTier;
			std::uint32_t econScore;
			std::uint32_t rebelActive, rebelBribed;
		};

		constexpr Hold kHolds[] = {
			{ "whiterun",   "Whiterun",       "Whiterun",  0x0B00D4, 0x0B00D5, 0x0B00D6, 0x0B00D7, 0x0AAE27, 0x0AAE31, 0x16861E, 0x1DFC1F, 0x1DFC2B, 0x4FB376, 0x0BA1C7, 0x0BA1C9 },
			{ "eastmarch",  "Eastmarch",      "Windhelm",  0x0B00D8, 0x0B00D9, 0x0B00DA, 0x0B00DB, 0x0AAE28, 0x0AAE34, 0x168620, 0x1DFC22, 0x1DFC2D, 0x4FB37D, 0x0BA1CD, 0x0BA1CF },
			{ "falkreath",  "Falkreath",      "Falkreath", 0x0B00DC, 0x0B00DD, 0x0B00DE, 0x0B00DF, 0x0AAE2D, 0x0AAE37, 0x168623, 0x1DFC20, 0x1DFC30, 0x4FB378, 0x0BA1D6, 0x0BA1D8 },
			{ "hjaalmarch", "Hjaalmarch",     "Morthal",   0x0B00E0, 0x0B00E1, 0x0B00E2, 0x0B00E3, 0x0AAE2C, 0x0AAE3A, 0x168626, 0x1DFC27, 0x1DFC32, 0x4FB37E, 0x0BA1DF, 0x0BA1E1 },
			{ "pale",       "The Pale",       "Dawnstar",  0x0B00E4, 0x0B00E5, 0x0B00E6, 0x0B00E7, 0x0AAE2E, 0x0AAE38, 0x168624, 0x1DFC25, 0x1DFC2A, 0x4FB379, 0x0BA1DC, 0x0BA1DE },
			{ "winterhold", "Winterhold",     "Winterhold",0x0B00E8, 0x0B00E9, 0x0B00EA, 0x0B00EB, 0x0AAE2F, 0x0AAE39, 0x168625, 0x1DFC26, 0x1DFC31, 0x4FB37C, 0x0BA1D9, 0x0BA1DB },
			{ "rift",       "The Rift",       "Riften",    0x0B00EC, 0x0B00ED, 0x0B00EE, 0x0B00EF, 0x0AAE2A, 0x0AAE35, 0x168621, 0x1DFC23, 0x1DFC2E, 0x4FB37B, 0x0BA1CA, 0x0BA1CC },
			{ "haafingar",  "Haafingar",      "Solitude",  0x0B00F0, 0x0B00F1, 0x0B00F2, 0x0B00F3, 0x0AAE29, 0x0AAE33, 0x16861F, 0x1DFC21, 0x1DFC2C, 0x4FB375, 0x0BA1D0, 0x0BA1D2 },
			{ "reach",      "The Reach",      "Markarth",  0x168616, 0x168618, 0x168619, 0x16861A, 0x0AAE2B, 0x0AAE36, 0x168622, 0x1DFC24, 0x1DFC2F, 0x4FB37A, 0x0BA1D3, 0x0BA1D5 },
			{ "highreach",  "Highreach Keep", "Highreach", 0x0B00F4, 0x0B00F5, 0x0B00F6, 0x0B00F7, 0x0C9AD2, 0x0C9AD3, 0x168627, 0x1DFC28, 0x1DFC33, 0x4FB377, 0,        0        },
		};

		// The 12 King Stones: active = the mod's own AAKingStone_* global at 1.
		// `note` states only what KingdomTaxManager/AAEconomySystemScript were
		// READ to do — no invented lore for the others.
		struct Stone
		{
			const char*   key;
			const char*   name;
			std::uint32_t global;
			const char*   note;
		};

		constexpr Stone kStones[] = {
			{ "coin",      "The Coin Stone",      0x529BB3, "+10% on every tax collection" },
			{ "seal",      "The Seal Stone",      0x529BB4, "+10 economy score each week" },
			{ "chain",     "The Chain Stone",     0x529BB5, "" },
			{ "lawgiver",  "The Lawgiver Stone",  0x529BB6, "-10% on every tax collection" },
			{ "blood",     "The Blood Stone",     0x529BB7, "" },
			{ "pilgrim",   "The Pilgrim Stone",   0x529BB8, "" },
			{ "warden",    "The Warden Stone",    0x529BB9, "" },
			{ "captain",   "The Captain's Stone", 0x529BBA, "" },
			{ "commander", "The Commander Stone", 0x529BBB, "" },
			{ "court",     "The Court Stone",     0x529BBC, "" },
			{ "crown",     "The Crown Stone",     0x529BBD, "" },
			{ "taxman",    "The Taxman Stone",    0x529BBE, "" },
		};

		// The 12 council seats — each is a "Finding the ..." quest; completed
		// means the seat is filled, running means the search is under way.
		struct Seat
		{
			std::uint32_t quest;
			const char*   name;
		};

		constexpr Seat kSeats[] = {
			{ 0x039AEF, "High Priest of Skyrim" },
			{ 0x153F42, "Master of Coin" },
			{ 0x3D65F5, "Steward of Highreach" },
			{ 0x3D65F6, "Overseer of Slaves" },
			{ 0x3D65F7, "Master of Assassins" },
			{ 0x3D65F8, "First Mage of Skyrim" },
			{ 0x3D65F9, "Master of Chains" },
			{ 0x3D65FA, "Lord Commander" },
			{ 0x3D65FB, "Voice of the Crown" },
			{ 0x24BEDC, "Royal Blacksmith" },
			{ 0x3A2FE1, "Royal Chronicler" },
			{ 0x0FD100, "Will of the Crown" },
		};

		// The royal kit — the mod's player-facing spells and powers, grouped
		// for the quick-use grid. Names are read LIVE from the form (the table
		// string is only the fallback for a resolve that half-fails).
		struct Power
		{
			std::uint32_t localId;
			const char*   fallbackName;
			const char*   group;   // travel | summon | command
		};

		constexpr Power kPowers[] = {
			{ 0x05FDF6, "Teleport to Highreach",          "travel" },
			{ 0x064363, "Teleport to Royal Spouse",       "travel" },
			{ 0x059E30, "Teleport to Highreach Rangers",  "travel" },
			{ 0x04DF86, "Summon Highreach Tunnel",        "travel" },
			{ 0x06609A, "Summon Crownsguard",             "summon" },
			{ 0x06609B, "Summon Lady of the Lake",        "summon" },
			{ 0x06609D, "Summon The Rootbind Covenant",   "summon" },
			{ 0x05F63E, "Summon Merchant's Bin",          "summon" },
			{ 0x0660A5, "Voice of the King",              "command" },
			{ 0x0660A6, "Edict of Terror",                "command" },
			{ 0x0660A8, "Rally for the King",             "command" },
			{ 0x0A05C1, "Army Formation",                 "command" },
			{ 0x4C7E8D, "Veteran's Battlecry",            "command" },
			{ 0x0AD598, "Blessing of Skyrim's Crown",     "command" },
			{ 0x0660AA, "Bow of the Ranger",              "command" },
		};

		// Key quests.
		constexpr std::uint32_t kQuestPath       = 0x000D64;  // "To Wear the Crown of the High King"
		constexpr std::uint32_t kQuestReign      = 0x006E8B;  // "The King Reigns"
		constexpr std::uint32_t kQuestCoronation = 0x241A85;  // "The Coronation in Highreach"
		constexpr std::uint32_t kQuestLedger     = 0x26F325;  // AAKingBookofCouncilQuest

		// Loose globals.
		constexpr std::uint32_t kGTreasury       = 0x0B00F9;
		constexpr std::uint32_t kGLastCollection = 0x0B00F8;
		constexpr std::uint32_t kGApprSkyrim     = 0x0AAE30;
		constexpr std::uint32_t kGApprSkyrimDlt  = 0x0AAE32;
		constexpr std::uint32_t kGFaithSkyrim    = 0x1DFC29;
		constexpr std::uint32_t kGEconScore      = 0x4FB372;
		constexpr std::uint32_t kGEconTier       = 0x4FB373;
		constexpr std::uint32_t kGEconLastAppr   = 0x4FB374;
		constexpr std::uint32_t kGDifficulty     = 0x13F8E5;
		constexpr std::uint32_t kGTariffs        = 0x514F9E;
		constexpr std::uint32_t kGCitizens       = 0x0376C0;
		constexpr std::uint32_t kGNobles         = 0x0A8358;
		constexpr std::uint32_t kGHeroes         = 0x0A835B;
		constexpr std::uint32_t kGRangers        = 0x0A835D;
		constexpr std::uint32_t kGDetainees      = 0x4DC701;
		constexpr std::uint32_t kGRebelEnabled   = 0x0BA1E2;
		constexpr std::uint32_t kGRebelAny       = 0x0BA21A;
		constexpr std::uint32_t kGGoldCounted    = 0x13F33F;   // AABecomeKingGold (tracker's live count)
		/* AAKingSupportNum is the LIVE supporter counter — proven 2026-08-19 by
		 * following AABecomeKingQuestTracker.pex's `AABecomeKingSupporters`
		 * property through the ESP's VMAD to this GLOB (record default 0).
		 * AABecomeKingSupportersAlt (0x13F340) is the REQUIREMENT constant
		 * (record default 40); reading it as the count is why a fresh save
		 * showed "40/40 supporters" before the questline even started. */
		constexpr std::uint32_t kGSupporters     = 0x01B2C2;   // AAKingSupportNum — live count, defaults 0
		constexpr std::uint32_t kGSupportersNeed = 0x13F340;   // AABecomeKingSupportersAlt — the target (40)
		/* The "start" verb's own two forms — dumped 2026-08-19 the same way as
		 * everything else here (formid-aware dump_records.py against the ESP's
		 * BOOK/GLOB groups, matched by EDID). Both are exactly what
		 * TIF__05089BE8::Fragment_0 touches when a background NPC's radiant
		 * line fires; see the ActJson "start" branch. */
		constexpr std::uint32_t kBookSurgusNote  = 0x077598;   // AAKingSurgusNote
		constexpr std::uint32_t kGHeardHighreach = 0x0F7E57;   // AAKingHasHeardofHighreach
		constexpr std::uint32_t kGMineLast       = 0x11C6D2;
		constexpr std::uint32_t kGExpGuards      = 0x26F326;
		constexpr std::uint32_t kGExpCastles     = 0x26F32A;
		constexpr std::uint32_t kGExpInfra       = 0x26F329;
		constexpr std::uint32_t kGExpLighting    = 0x26F327;
		constexpr std::uint32_t kGExpWater       = 0x26F328;
		constexpr std::uint32_t kGExpPriests     = 0x0AAACE;
		constexpr std::uint32_t kGExpTotal       = 0x26F32B;

		// Economy tier names for the mod's 0-4 score bands (<20/<40/<60/<80/else
		// — read from AAEconomySystemScript::GetEconomyTierFromScore). The
		// labels are the deck's own UI copy, not the mod's.
		const char* TierName(int tier)
		{
			switch (tier) {
			case 0:  return "Collapsing";
			case 1:  return "Struggling";
			case 2:  return "Stable";
			case 3:  return "Prosperous";
			case 4:  return "Golden Age";
			default: return "Unknown";
			}
		}

		// The mod's own approval delta per tax-rate step (KingdomTaxManager::
		// AdjustHoldApproval) — surfaced so the rate picker can say what a
		// setting will DO before the next Sundas does it.
		int ApprovalDeltaForRate(double rate)
		{
			const int r = static_cast<int>(rate + 0.5);
			switch (r) {
			case 0:  return 20;
			case 5:  return 10;
			case 10: return 0;
			case 15: return -10;
			case 20: return -20;
			case 25: return -30;
			default: return 0;
			}
		}

		// One hold's next-collection income, the mod's own formula:
		// floor(base * rate/100 + head + 0.5).
		double HoldProjection(const Hold& h)
		{
			const double base = GVal(h.base);
			const double head = GVal(h.head);
			const double rate = GVal(h.rate);
			return std::floor(base * rate / 100.0 + head + 0.5);
		}

		// ------------------------------------------------------ VM dispatch --
		// Same helpers as faith.cpp / follower_frameworks.cpp — each module
		// carries its own so none grows a dependency on another's internals.

		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// Is `cls` bound to this form? (Papyrus is case-insensitive; both
		// casings are tried, the faith.cpp law.)
		bool HasScript(RE::TESForm* form, const char* cls)
		{
			auto* vm = Vm();
			if (!form || !cls || !vm)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(form->GetFormType(), form);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			if (vm->FindBoundObject(handle, cls, obj) && obj)
				return true;
			const auto lower = Lower(cls);
			return lower != cls && vm->FindBoundObject(handle, lower.c_str(), obj) && obj;
		}

		bool DefinedByPlugin(RE::TESForm* form)
		{
			const auto* file = form ? form->GetFile(0) : nullptr;
			return file && _stricmp(file->GetFilename().data(), kPlugin) == 0;
		}

		// The quest carrying KingdomTaxManager. The script sits on SOME quest in
		// the plugin — which one the ESP dump doesn't say (VMAD lives per
		// record) — so it is found the follower_frameworks way: scan the
		// plugin's quests for the attached script class, then cache the raw
		// FormID for the session.
		RE::TESQuest* TaxQuest()
		{
			static std::uint32_t cachedId = 0;
			static bool          tried = false;
			if (tried) {
				if (cachedId == 0)
					return nullptr;
				auto* f = RE::TESForm::LookupByID(cachedId);
				return f ? f->As<RE::TESQuest>() : nullptr;
			}
			tried = true;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return nullptr;
			for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
				if (!q || !DefinedByPlugin(q))
					continue;
				if (HasScript(q, "KingdomTaxManager")) {
					cachedId = q->GetFormID();
					logger::info("high-king: KingdomTaxManager found on quest {:08X}", cachedId);
					return q;
				}
			}
			logger::warn("high-king: no quest in {} carries KingdomTaxManager", kPlugin);
			return nullptr;
		}

		// Fire-and-forget void dispatch on a quest's attached script.
		bool Dispatch(RE::TESQuest* quest, const char* cls, const char* fn,
			RE::BSScript::IFunctionArguments* args)
		{
			auto* vm = Vm();
			if (!vm || !quest || !cls || !fn || !args)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			return vm->DispatchMethodCall(handle, cls, fn, args, cb);
		}
	}

	// ------------------------------------------------------------ interface --

	bool Present()
	{
		static int cached = -1;
		if (cached < 0) {
			auto* dh = RE::TESDataHandler::GetSingleton();
			cached = (dh && dh->LookupModByName(kPlugin)) ? 1 : 0;
		}
		return cached == 1;
	}

	std::string StateJson()
	{
		json out;
		out["present"] = Present();
		if (!Present())
			return out.dump();

		// -- the crown ----------------------------------------------------
		auto* coronation = Form<RE::TESQuest>(kQuestCoronation);
		auto* reign = Form<RE::TESQuest>(kQuestReign);
		auto* path = Form<RE::TESQuest>(kQuestPath);
		const bool isKing = coronation && coronation->IsCompleted();
		json       king;
		king["isKing"] = isKing;
		king["reigning"] = reign && reign->IsRunning();
		king["pathStage"] = path ? static_cast<int>(path->currentStage) : 0;
		king["pathRunning"] = path && path->IsRunning();
		king["supporters"] = static_cast<int>(GVal(kGSupporters));
		/* The mod's own target, not a hardcoded 40 — if the global is missing
		 * (0 would draw a 0/0 bar) the view falls back to 40 itself. */
		king["supportersNeeded"] = static_cast<int>(GVal(kGSupportersNeed));  // marker: hk-supporters-live
		king["goldCounted"] = static_cast<long long>(GVal(kGGoldCounted));
		king["goldNeeded"] = 50000;  // AABecomeKingQuestTracker's own threshold
		out["king"] = std::move(king);

		// -- treasury & the weekly collection ------------------------------
		const bool coin = GBool(0x529BB3);
		const bool lawgiver = GBool(0x529BB6);
		double     projectedRaw = 0.0;

		json holds = json::array();
		for (const auto& h : kHolds) {
			const double proj = HoldProjection(h);
			projectedRaw += proj;
			json row;
			row["id"] = h.id;
			row["name"] = h.name;
			row["city"] = h.city;
			row["rate"] = GVal(h.rate);
			row["base"] = GVal(h.base);
			row["head"] = GVal(h.head);
			row["revenue"] = GVal(h.revenue);
			row["projected"] = proj;
			row["rateApprovalDelta"] = ApprovalDeltaForRate(GVal(h.rate));
			row["approval"] = GVal(h.approval);
			row["approvalDelta"] = GVal(h.approvalDelta);
			row["approvalTier"] = static_cast<int>(GVal(h.approvalTier));
			row["faith"] = GVal(h.faith);
			row["faithTier"] = static_cast<int>(GVal(h.faithTier));
			row["econScore"] = GVal(h.econScore);
			row["hasRebel"] = h.rebelActive != 0;
			row["rebel"] = h.rebelActive ? GBool(h.rebelActive) : false;
			row["bribed"] = h.rebelBribed ? GBool(h.rebelBribed) : false;
			holds.push_back(std::move(row));
		}
		out["holds"] = std::move(holds);

		double projected = projectedRaw;
		if (coin)
			projected += projectedRaw * 0.10;
		if (lawgiver)
			projected -= projectedRaw * 0.10;

		auto*        cal = RE::Calendar::GetSingleton();
		const double now = cal ? static_cast<double>(cal->GetDaysPassed()) : 0.0;
		const double lastCollection = GVal(kGLastCollection);
		// KingdomTaxManager collects on Sundas ~09:00 (weekday = day % 7 == 0
		// in its own arithmetic); mirror that so the card can count down.
		const int    dayNow = static_cast<int>(now);
		const int    weekday = ((dayNow % 7) + 7) % 7;
		const double hourNow = (now - dayNow) * 24.0;
		double       daysUntil;
		if (weekday == 0 && hourNow < 9.0)
			daysUntil = (9.0 - hourNow) / 24.0;
		else
			daysUntil = (((7 - weekday) % 7) == 0 ? 7 : (7 - weekday)) - hourNow / 24.0 + 0.375;

		json treasury;
		treasury["total"] = GVal(kGTreasury);
		treasury["lastCollectionDay"] = lastCollection;
		treasury["daysNow"] = now;
		treasury["daysSinceCollection"] = lastCollection > 0.0 ? now - lastCollection : -1.0;
		treasury["daysUntilCollection"] = daysUntil;
		treasury["projected"] = std::floor(projected + 0.5);
		treasury["projectedRaw"] = projectedRaw;
		treasury["coinStone"] = coin;
		treasury["lawgiverStone"] = lawgiver;
		treasury["mineLast"] = GVal(kGMineLast);
		out["treasury"] = std::move(treasury);

		// -- economy / Skyrim-wide mood ------------------------------------
		json econ;
		const int tier = static_cast<int>(GVal(kGEconTier));
		econ["score"] = GVal(kGEconScore);
		econ["tier"] = tier;
		econ["tierName"] = TierName(tier);
		econ["lastApproval"] = GVal(kGEconLastAppr);
		econ["difficulty"] = static_cast<int>(GVal(kGDifficulty));
		econ["tariffs"] = GBool(kGTariffs);
		out["economy"] = std::move(econ);

		json sky;
		sky["approval"] = GVal(kGApprSkyrim);
		sky["approvalDelta"] = GVal(kGApprSkyrimDlt);
		sky["faith"] = GVal(kGFaithSkyrim);
		out["skyrim"] = std::move(sky);

		json counts;
		counts["citizens"] = static_cast<int>(GVal(kGCitizens));
		counts["nobles"] = static_cast<int>(GVal(kGNobles));
		counts["heroes"] = static_cast<int>(GVal(kGHeroes));
		counts["rangers"] = static_cast<int>(GVal(kGRangers));
		counts["detainees"] = static_cast<int>(GVal(kGDetainees));
		out["counts"] = std::move(counts);

		json exp;
		exp["guards"] = GVal(kGExpGuards);
		exp["castles"] = GVal(kGExpCastles);
		exp["infrastructure"] = GVal(kGExpInfra);
		exp["lighting"] = GVal(kGExpLighting);
		exp["water"] = GVal(kGExpWater);
		exp["priests"] = GVal(kGExpPriests);
		exp["total"] = GVal(kGExpTotal);
		out["expenses"] = std::move(exp);

		json rebel;
		rebel["enabled"] = GBool(kGRebelEnabled);
		rebel["any"] = GBool(kGRebelAny);
		out["rebellion"] = std::move(rebel);

		// -- stones ---------------------------------------------------------
		json stones = json::array();
		for (const auto& s : kStones) {
			json row;
			row["key"] = s.key;
			row["name"] = s.name;
			row["active"] = GBool(s.global);
			row["note"] = s.note;
			stones.push_back(std::move(row));
		}
		out["stones"] = std::move(stones);

		// -- council ---------------------------------------------------------
		json council = json::array();
		for (const auto& s : kSeats) {
			auto* q = Form<RE::TESQuest>(s.quest);
			json  row;
			row["name"] = s.name;
			row["state"] = (q && q->IsCompleted()) ? "filled" :
			               (q && q->IsRunning())   ? "seeking" : "vacant";
			council.push_back(std::move(row));
		}
		out["council"] = std::move(council);

		// -- the royal kit ----------------------------------------------------
		auto* player = RE::PlayerCharacter::GetSingleton();
		json  powers = json::array();
		for (const auto& p : kPowers) {
			auto* spell = Form<RE::SpellItem>(p.localId);
			if (!spell)
				continue;   // a record the mod's next version dropped — no dead row
			json row;
			row["plugin"] = kPlugin;
			row["localId"] = p.localId;
			row["formId"] = spell->GetFormID();
			const char* liveName = spell->GetName();
			row["name"] = (liveName && *liveName) ? liveName : p.fallbackName;
			row["group"] = p.group;
			row["known"] = player && player->HasSpell(spell);
			row["cost"] = spell->CalculateMagickaCost(player);
			powers.push_back(std::move(row));
		}
		// Count BEFORE the move — a moved-from json array reports size 0, which
		// is exactly how the 2026-08-18 log said "0 powers" while the payload
		// carried all 15 and sent this session hunting a resolve failure that
		// never existed.
		const auto powerCount = powers.size();
		out["powers"] = std::move(powers);

		// Build marker (hd-markers.json: "high-king"). Once per session — a
		// state build runs on every tab look and would flood the log. Treasury
		// and one resolve pointer ride along as the sanity signal: zeros with
		// resolved=true is a fresh kingdom, resolved=false is a broken lookup.
		static bool logged = false;
		if (!logged) {
			logged = true;
			logger::info("high-king: state built ({} holds, {} powers, king={}, treasury={:.0f}, treasuryResolved={})",
				std::size(kHolds), powerCount, isKing, GVal(kGTreasury, -1.0),
				Form<RE::TESGlobal>(kGTreasury) != nullptr);
		}
		return out.dump();
	}

	std::string ActJson(const std::string& op)
	{
		json out;
		out["ok"] = false;
		if (!Present()) {
			out["msg"] = "Become High King of Skyrim is not in the load order.";
			return out.dump();
		}

		if (op == "collect") {
			auto* q = TaxQuest();
			if (!q) {
				out["msg"] = "The kingdom tax office isn't answering (KingdomTaxManager quest not found).";
				return out.dump();
			}
			if (!q->IsRunning()) {
				out["msg"] = "Taxes aren't flowing yet — the kingdom's tax system starts with your reign.";
				return out.dump();
			}
			auto*        cal = RE::Calendar::GetSingleton();
			const float  now = cal ? cal->GetDaysPassed() : 0.0f;
			auto*        args = RE::MakeFunctionArguments(std::move(static_cast<float>(now)));
			if (!Dispatch(q, "KingdomTaxManager", "CollectAllHoldTaxes", args)) {
				out["msg"] = "The dispatch into KingdomTaxManager failed.";
				return out.dump();
			}
			logger::info("high-king: collect taxes dispatched (day {:.2f})", now);
			out["ok"] = true;
			out["msg"] = "Tax collectors sent to every hold — the count lands in a moment.";
			return out.dump();
		}

		if (op == "ledger") {
			auto* q = Form<RE::TESQuest>(kQuestLedger);
			if (!q || !q->IsRunning()) {
				out["msg"] = "The council's ledger book isn't in service yet.";
				return out.dump();
			}
			auto* args = RE::MakeFunctionArguments();
			if (!Dispatch(q, "AAKingBookofCouncilScript", "PushLedgerSnapshot", args)) {
				out["msg"] = "The dispatch into the council book failed.";
				return out.dump();
			}
			logger::info("high-king: ledger snapshot dispatched");
			out["ok"] = true;
			out["msg"] = "The council's ledger takes a fresh snapshot.";
			return out.dump();
		}

		if (op == "start") {
			/* kQuestPath is the same quest AABecomeKingQuestTracker runs on —
			 * Start Game Enabled, already IsRunning() the whole time, sitting
			 * at stage 0 until something bumps it. Refuse a re-fire honestly
			 * rather than handing out a second note. */
			auto* quest = Form<RE::TESQuest>(kQuestPath);
			if (!quest) {
				out["msg"] = "The road to the throne could not be found.";
				return out.dump();
			}
			if (GBool(kGHeardHighreach) || quest->currentStage > 0) {
				out["msg"] = "You've already set out on the road to the throne.";
				return out.dump();
			}
			auto* book = Form<RE::TESObjectBOOK>(kBookSurgusNote);
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!book || !player) {
				out["msg"] = "Surgus's Note could not be found.";
				return out.dump();
			}
			/* Exactly what TIF__05089BE8::Fragment_0 does when a background NPC
			 * happens to mention Highreach: hand over the note, flip the flag,
			 * advance the path quest to stage 1 through the native "Quest"
			 * script's own SetStage (never poke currentStage directly — that
			 * skips the engine's stage-log/alias machinery, the same law as
			 * every other verb in this file: go through real script dispatch). */
			player->AddObjectToContainer(book, nullptr, 1, nullptr);
			auto* g = Form<RE::TESGlobal>(kGHeardHighreach);
			if (g)
				g->value = 1.0f;
			auto* args = RE::MakeFunctionArguments(static_cast<std::int32_t>(1));
			if (!Dispatch(quest, "Quest", "SetStage", args))
				logger::warn("high-king: start's SetStage dispatch failed (book still granted)");
			logger::info("high-king: quest start dispatched (book granted, stage 1)");
			out["ok"] = true;
			out["msg"] = "Surgus's Note is in your inventory — read it to begin the road to the throne.";
			return out.dump();
		}

		out["msg"] = "Unknown act: " + op;
		return out.dump();
	}

	std::string SetTaxRateJson(const std::string& holdId, double rate)
	{
		json out;
		out["ok"] = false;
		out["hold"] = holdId;
		out["rate"] = rate;
		if (!Present()) {
			out["msg"] = "Become High King of Skyrim is not in the load order.";
			return out.dump();
		}
		// The mod's own dialogue steps, verbatim. Refuse anything else — the
		// approval table (AdjustHoldApproval) has no row for a value between
		// steps, so an invented rate would collect gold with no consequence.
		const int r = static_cast<int>(rate + 0.5);
		if (r != 0 && r != 5 && r != 10 && r != 15 && r != 20 && r != 25) {
			out["msg"] = "Tax rates go in the crown's own steps: 0, 5, 10, 15, 20 or 25%.";
			return out.dump();
		}
		for (const auto& h : kHolds) {
			if (holdId != h.id)
				continue;
			auto* g = Form<RE::TESGlobal>(h.rate);
			if (!g) {
				out["msg"] = "That hold's tax ledger could not be found.";
				return out.dump();
			}
			g->value = static_cast<float>(r);
			logger::info("high-king: tax rate {} -> {}%", h.id, r);
			out["ok"] = true;
			out["rate"] = r;
			out["msg"] = std::string(h.name) + " will pay " + std::to_string(r) +
				"% at the next collection (" +
				(ApprovalDeltaForRate(r) >= 0 ? "+" : "") +
				std::to_string(ApprovalDeltaForRate(r)) + " approval each Sundas).";
			return out.dump();
		}
		out["msg"] = "Unknown hold: " + holdId;
		return out.dump();
	}
}
