#include "procession_bridge.h"

#include "npc_actions.h"   // SicEmActors / CancelOrder / order-end hook, TargetFormID
#include "party_recall.h"  // Roster(): who is following, for the wagon seat picker

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

// pch (force-included) provides RE::/SKSE::, json.hpp, the logger and Windows.h.

namespace ProcessionBridge
{
	using json = nlohmann::json;

	namespace
	{
		// ---- Royal Procession exports (ApiVersion 2) ---------------------------
		struct RpApi
		{
			std::uint32_t (*apiVersion)() = nullptr;
			bool (*summonType)(std::int32_t) = nullptr;
			bool (*dismiss)() = nullptr;
			bool (*setActive)(bool) = nullptr;
			std::uint32_t (*getState)(char*, std::uint32_t) = nullptr;
			bool (*openBearerGear)(std::int32_t) = nullptr;
			bool (*copyBearerGear)(std::int32_t) = nullptr;
			bool ok() const
			{
				return apiVersion && summonType && dismiss && setActive && getState && openBearerGear && copyBearerGear;
			}
		};

		// ---- Royal Procession vehicles (ApiVersion 3) ---------------------------
		// Bound apart from RpApi so a v2 DLL keeps its palanquin and the deck
		// says "needs updating for wagons" instead of losing the whole mod.
		struct RpWagonApi
		{
			bool (*summonWagon)() = nullptr;
			bool (*hitchWagon)(std::uint32_t) = nullptr;
			bool (*seatInWagon)(std::uint32_t, std::int32_t, std::int32_t) = nullptr;
			bool (*unseat)(std::uint32_t) = nullptr;
			bool (*convoyAdd)() = nullptr;
			bool (*convoyRemove)(std::int32_t) = nullptr;
			bool (*dismissWagons)() = nullptr;
			std::uint32_t (*getWagonState)(char*, std::uint32_t) = nullptr;
			bool ok() const
			{
				return summonWagon && hitchWagon && seatInWagon && unseat && convoyAdd && convoyRemove && dismissWagons &&
				       getWagonState;
			}
		};

		// ---- Royal Retinue exports (ApiVersion 1) ------------------------------
		struct RrApi
		{
			std::uint32_t (*apiVersion)() = nullptr;
			std::uint32_t (*listPresets)(char*, std::uint32_t) = nullptr;
			bool (*savePreset)(const char*) = nullptr;
			bool (*savePresetFromActor)(const char*, const char*, std::uint32_t) = nullptr;
			bool (*deletePreset)(const char*) = nullptr;
			std::uint32_t (*summonSquad)(const char*) = nullptr;
			bool (*dismissSquad)(std::uint32_t) = nullptr;
			bool (*dismissAllSquads)() = nullptr;
			std::uint32_t (*listSquads)(char*, std::uint32_t) = nullptr;
			std::uint32_t (*getSquadMembers)(std::uint32_t, std::uint32_t*, std::uint32_t) = nullptr;
			bool (*releaseSquad)(std::uint32_t, float) = nullptr;
			bool (*rejoinSquad)(std::uint32_t) = nullptr;
			bool (*rejoinActor)(std::uint32_t) = nullptr;
			// v2 (optional: a v1 build has neither, and the modal hides Hold here).
			bool (*setHold)(bool) = nullptr;
			bool (*isHolding)() = nullptr;
			bool canHold() const { return setHold && isHolding; }
			bool ok() const
			{
				return apiVersion && listPresets && savePreset && savePresetFromActor && deletePreset && summonSquad &&
				       dismissSquad && dismissAllSquads && listSquads && getSquadMembers && releaseSquad &&
				       rejoinSquad && rejoinActor;
			}
		};

		template <class T>
		void Bind(HMODULE a_mod, const char* a_name, T& a_out)
		{
			a_out = reinterpret_cast<T>(::GetProcAddress(a_mod, a_name));
		}

		// Resolved on first SUCCESS and cached; an absent module is re-probed on
		// the next call (cheap), so a mod ticked later in the session is found.
		// GetModuleHandle, never LoadLibrary: absent means absent.
		const RpApi* Rp()
		{
			static RpApi api;
			static bool  bound = false;
			if (bound)
				return &api;
			const HMODULE mod = ::GetModuleHandleA("RoyalProcession.dll");
			if (!mod)
				return nullptr;
			RpApi a;
			Bind(mod, "RoyalProcession_ApiVersion", a.apiVersion);
			Bind(mod, "RoyalProcession_SummonType", a.summonType);
			Bind(mod, "RoyalProcession_Dismiss", a.dismiss);
			Bind(mod, "RoyalProcession_SetActive", a.setActive);
			Bind(mod, "RoyalProcession_GetState", a.getState);
			Bind(mod, "RoyalProcession_OpenBearerGear", a.openBearerGear);
			Bind(mod, "RoyalProcession_CopyBearerGear", a.copyBearerGear);
			if (!a.ok() || a.apiVersion() < 2) {
				static bool warned = false;
				if (!warned) {
					warned = true;
					logger::warn("procession-bridge: RoyalProcession.dll is loaded but its API is older than v2");
				}
				return nullptr;
			}
			api = a;
			bound = true;
			logger::info("procession-bridge: bound RoyalProcession.dll (api {})", api.apiVersion());
			return &api;
		}

		// Same cache-on-success rule as Rp(); null for an api-2 DLL (no wagons).
		const RpWagonApi* RpWagon()
		{
			static RpWagonApi api;
			static bool       bound = false;
			if (bound)
				return &api;
			const auto* rp = Rp();
			if (!rp || rp->apiVersion() < 3)
				return nullptr;
			const HMODULE mod = ::GetModuleHandleA("RoyalProcession.dll");
			if (!mod)
				return nullptr;
			RpWagonApi a;
			Bind(mod, "RoyalProcession_SummonWagon", a.summonWagon);
			Bind(mod, "RoyalProcession_HitchWagon", a.hitchWagon);
			Bind(mod, "RoyalProcession_SeatInWagon", a.seatInWagon);
			Bind(mod, "RoyalProcession_Unseat", a.unseat);
			Bind(mod, "RoyalProcession_ConvoyAdd", a.convoyAdd);
			Bind(mod, "RoyalProcession_ConvoyRemove", a.convoyRemove);
			Bind(mod, "RoyalProcession_DismissWagons", a.dismissWagons);
			Bind(mod, "RoyalProcession_GetWagonState", a.getWagonState);
			if (!a.ok()) {
				static bool warned = false;
				if (!warned) {
					warned = true;
					logger::warn("procession-bridge: RoyalProcession.dll says api 3 but a wagon export is missing");
				}
				return nullptr;
			}
			api = a;
			bound = true;
			// Build marker (hd-markers.json: "procession-wagons").
			logger::info("procession-bridge: bound the wagon api (RoyalProcession api {})", rp->apiVersion());
			return &api;
		}

		const RrApi* Rr()
		{
			static RrApi api;
			static bool  bound = false;
			if (bound)
				return &api;
			const HMODULE mod = ::GetModuleHandleA("RoyalRetinue.dll");
			if (!mod)
				return nullptr;
			RrApi a;
			Bind(mod, "RoyalRetinue_ApiVersion", a.apiVersion);
			Bind(mod, "RoyalRetinue_ListPresets", a.listPresets);
			Bind(mod, "RoyalRetinue_SavePreset", a.savePreset);
			Bind(mod, "RoyalRetinue_SavePresetFromActor", a.savePresetFromActor);
			Bind(mod, "RoyalRetinue_DeletePreset", a.deletePreset);
			Bind(mod, "RoyalRetinue_SummonSquad", a.summonSquad);
			Bind(mod, "RoyalRetinue_DismissSquad", a.dismissSquad);
			Bind(mod, "RoyalRetinue_DismissAllSquads", a.dismissAllSquads);
			Bind(mod, "RoyalRetinue_ListSquads", a.listSquads);
			Bind(mod, "RoyalRetinue_GetSquadMembers", a.getSquadMembers);
			Bind(mod, "RoyalRetinue_ReleaseSquad", a.releaseSquad);
			Bind(mod, "RoyalRetinue_RejoinSquad", a.rejoinSquad);
			Bind(mod, "RoyalRetinue_RejoinActor", a.rejoinActor);
			Bind(mod, "RoyalRetinue_SetHold", a.setHold);
			Bind(mod, "RoyalRetinue_IsHolding", a.isHolding);
			if (!a.ok() || a.apiVersion() < 1) {
				static bool warned = false;
				if (!warned) {
					warned = true;
					logger::warn("procession-bridge: RoyalRetinue.dll is loaded but does not export the v1 API");
				}
				return nullptr;
			}
			api = a;
			bound = true;
			logger::info("procession-bridge: bound RoyalRetinue.dll (api {})", api.apiVersion());
			return &api;
		}

		// Size-then-copy for the mods' "buffer + returns needed length" reads.
		std::string Read(std::uint32_t (*a_fn)(char*, std::uint32_t))
		{
			const std::uint32_t need = a_fn(nullptr, 0);
			if (need == 0 || need > (8u << 20))
				return {};
			std::string buf(static_cast<std::size_t>(need) + 1, '\0');
			const std::uint32_t got = a_fn(buf.data(), need + 1);
			buf.resize((std::min)(got, need));
			return buf;
		}

		json ParseOr(const std::string& a_text, json a_fallback)
		{
			auto j = json::parse(a_text, nullptr, false);
			return j.is_discarded() ? a_fallback : j;
		}

		std::vector<std::uint32_t> Members(const RrApi& a_rr, std::uint32_t a_squad)
		{
			std::array<std::uint32_t, 256> ids{};
			const auto n = a_rr.getSquadMembers(a_squad, ids.data(), static_cast<std::uint32_t>(ids.size()));
			return { ids.begin(), ids.begin() + (std::min<std::size_t>)(n, ids.size()) };
		}

		// The squads as the modal numbers them: "Group 1" is the first live squad
		// in Retinue's own order. The number is display only — every verb carries
		// the squad's stable Retinue id, re-checked against ListSquads here.
		json Squads(const RrApi& a_rr)
		{
			auto squads = ParseOr(Read(a_rr.listSquads), json::array());
			if (!squads.is_array())
				return json::array();
			int n = 0;
			for (auto& s : squads) {
				if (s.is_object())
					s["group"] = ++n;
			}
			return squads;
		}

		bool SquadExists(const RrApi& a_rr, std::uint32_t a_id, std::string* a_name = nullptr, int* a_group = nullptr)
		{
			for (const auto& s : Squads(a_rr)) {
				if (s.is_object() && s.value("id", 0u) == a_id) {
					if (a_name) *a_name = s.value("name", std::string{});
					if (a_group) *a_group = s.value("group", 0);
					return true;
				}
			}
			return false;
		}

		// Preset ids are Retinue's file keys: short, lowercase, url-safe.
		bool ValidId(const std::string& a_id)
		{
			if (a_id.empty() || a_id.size() > 48)
				return false;
			return std::all_of(a_id.begin(), a_id.end(), [](unsigned char c) {
				return std::islower(c) || std::isdigit(c) || c == '-' || c == '_';
			});
		}

		bool PresetExists(const RrApi& a_rr, const std::string& a_id)
		{
			for (const auto& p : ParseOr(Read(a_rr.listPresets), json::array())) {
				if (p.is_object() && p.value("id", std::string{}) == a_id)
					return true;
			}
			return false;
		}

		std::string Clip(std::string a_s, std::size_t a_max)
		{
			if (a_s.size() > a_max)
				a_s.resize(a_max);
			return a_s;
		}

		constexpr std::array<const char*, 8> kSlots{ "front-left", "front", "front-right", "left",
			"right", "rear-left", "rear", "rear-right" };

		// Blocks off the wire: known slot names only, rows/cols/spacing within
		// Retinue's own clamps (rows/cols 0..10, spacing 40..400).
		json CleanBlocks(const json& a_in)
		{
			json out = json::array();
			if (!a_in.is_array())
				return out;
			for (const auto& b : a_in) {
				if (!b.is_object() || out.size() >= kSlots.size())
					continue;
				const auto slot = b.value("slot", std::string{});
				if (std::find(kSlots.begin(), kSlots.end(), slot) == kSlots.end())
					continue;
				const int   rows = std::clamp(b.value("rows", 1), 0, 10);
				const int   cols = std::clamp(b.value("cols", 1), 0, 10);
				const float spacing = std::clamp(b.value("spacing", 80.0f), 40.0f, 400.0f);
				if (rows == 0 || cols == 0)
					continue;  // an empty block is simply absent
				out.push_back({ { "slot", slot }, { "rows", rows }, { "cols", cols }, { "spacing", spacing } });
			}
			return out;
		}

		std::string Reply(bool a_ok, const std::string& a_msg, json a_extra = json::object())
		{
			a_extra["ok"] = a_ok;
			a_extra["msg"] = a_msg;
			return a_extra.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		constexpr const char* kNoProcession = "Royal Procession is not installed - tick it in MO2";
		constexpr const char* kNoRetinue = "Royal Retinue is not installed - tick it in MO2";

		// The palanquin designs RoyalProcession_SummonType accepts (0..1 at api 2).
		// The API has no list call; this table is the deck's half of that contract.
		const json& Types()
		{
			static const json t = json::array({ { { "id", 0 }, { "name", "Nordic dragon throne" },
													{ "detail", "Carved dark oak, dragon heads, wolf fur" }, { "image", "rpx-nordic.png" } },
				{ { "id", 1 }, { "name", "Necromancer's throne" },
					{ "detail", "Dragon Priest mask, skulls, soul gems" }, { "image", "rpx-necro.png" } } });
			return t;
		}

		// ---- wagons -------------------------------------------------------------
		constexpr const char* kNoWagons = "Royal Procession needs updating for wagons (api 3)";
		constexpr std::array<const char*, 5> kSeatNames{ "the driver's bench", "the left front seat", "the right front seat",
			"the left rear seat", "the right rear seat" };

		json WagonState(const RpWagonApi& a_w)
		{
			auto st = ParseOr(Read(a_w.getWagonState), json::object());
			if (!st.is_object())
				st = json::object();
			if (!st.contains("wagons") || !st["wagons"].is_array())
				st["wagons"] = json::array();
			return st;
		}

		// A form id as the view or the mods spell it: a JSON number, or hex text
		// with or without 0x ("FE001810" from GetWagonState, "0x1a693" from Roster).
		std::uint32_t HexId(const json& a_v)
		{
			if (a_v.is_number_unsigned() || a_v.is_number_integer())
				return a_v.get<std::uint32_t>();
			if (!a_v.is_string())
				return 0;
			try {
				return static_cast<std::uint32_t>(std::stoul(a_v.get<std::string>(), nullptr, 16));
			} catch (const std::exception&) {
				return 0;
			}
		}

		std::uint32_t IdField(const json& a_obj, const char* a_key)
		{
			return a_obj.is_object() && a_obj.contains(a_key) ? HexId(a_obj[a_key]) : 0;
		}

		// Where an actor sits right now, from the wagon state (wagon index or -1).
		int SeatedIn(const json& a_state, std::uint32_t a_id, int* a_seat = nullptr)
		{
			int w = 0;
			for (const auto& wagon : a_state["wagons"]) {
				if (wagon.is_object() && wagon.contains("seats") && wagon["seats"].is_array()) {
					int s = 0;
					for (const auto& seat : wagon["seats"]) {
						if (seat.is_object() && IdField(seat, "id") == a_id) {
							if (a_seat) *a_seat = s;
							return w;
						}
						++s;
					}
				}
				++w;
			}
			return -1;
		}

		std::string WagonLabel(int a_w) { return a_w == 0 ? "the lead wagon" : "wagon " + std::to_string(a_w + 1); }

		bool IsHorse(RE::Actor* a_actor)
		{
			const auto* race = a_actor ? a_actor->GetRace() : nullptr;
			return race && race->HasKeywordString("ActorTypeHorse");
		}

		std::string NameOf(RE::Actor* a_actor, const char* a_fallback)
		{
			const char* n = a_actor ? a_actor->GetDisplayFullName() : nullptr;
			return n && *n ? n : a_fallback;
		}

		// The seat picker's roster: PartyRecall's own "following" verdict
		// (Policy::Basis), never a second guess from flags. Roster() walks every
		// process list and logs a line, so it is cached for a few seconds: the
		// Portal re-reads state every 350 ms while a verb is in flight.
		json People()
		{
			using clock = std::chrono::steady_clock;
			static json             cache = json::array();
			static clock::time_point at{};
			if (at != clock::time_point{} && clock::now() - at < std::chrono::seconds(5))
				return cache;
			at = clock::now();
			json out = json::array();
			const auto roster = ParseOr(PartyRecall::Roster(), json::object());
			if (roster.is_object() && roster.contains("rows") && roster["rows"].is_array()) {
				for (const auto& r : roster["rows"]) {
					if (!r.is_object() || r.value("missing", false) || r.value("dead", false) || r.value("disabled", false))
						continue;
					const auto basis = r.value("basis", std::string{});
					if (basis.empty())
						continue;
					const auto id = IdField(r, "formId");
					if (!id)
						continue;
					json p{ { "id", id }, { "name", r.value("name", std::string("?")) }, { "basis", basis },
						{ "loaded", r.value("loaded", false) }, { "waiting", r.value("waiting", false) } };
					if (r.contains("dist"))
						p["dist"] = r["dist"];
					out.push_back(std::move(p));
					if (out.size() >= 60)
						break;
				}
			}
			cache = out;
			return cache;
		}

		std::string WagonAct(const RpWagonApi& a_w, const std::string& a_op, const json& a_req)
		{
			const auto st = WagonState(a_w);
			const int  count = static_cast<int>(st["wagons"].size());
			const int  maxWagons = std::clamp(st.value("maxWagons", 3), 1, 3);

			if (a_op == "wagonSummon") {
				a_w.summonWagon();
				logger::info("procession-bridge: summon wagon ({} out)", count);
				return Reply(true, count ? "Bringing the wagon to you" : "Summoning the wagon");
			}
			if (a_op == "wagonHitch") {
				std::uint32_t id = IdField(a_req, "formId");
				if (!id)
					id = NpcActions::TargetFormID();
				auto* horse = id ? RE::TESForm::LookupByID<RE::Actor>(id) : nullptr;
				if (!horse || !horse->Is3DLoaded() || horse->IsDead() || !IsHorse(horse))
					return Reply(false, "Look at a living horse, then open the deck");
				a_w.hitchWagon(id);
				return Reply(true, "Hitching the wagon to " + NameOf(horse, "the horse"));
			}
			if (a_op == "wagonDismiss") {
				if (!count)
					return Reply(false, "There is no wagon to dismiss");
				a_w.dismissWagons();
				return Reply(true, count > 1 ? "Dismissing every wagon" : "Dismissing the wagon");
			}
			if (a_op == "convoyAdd") {
				if (!count)
					return Reply(false, "Summon the wagon first");
				if (count >= maxWagons)
					return Reply(false, "The convoy is full (" + std::to_string(maxWagons) + " wagons)");
				a_w.convoyAdd();
				return Reply(true, "Wagon " + std::to_string(count + 1) + " joins the convoy");
			}
			if (a_op == "convoyRemove") {
				const int index = a_req.value("index", -1);
				if (index < 1 || index >= count)
					return Reply(false, "That wagon has already left the convoy");
				a_w.convoyRemove(index);
				return Reply(true, "Wagon " + std::to_string(index + 1) + " leaves the convoy");
			}
			// Seat verbs: a real, loaded, living person.
			const std::uint32_t id = IdField(a_req, "formId");
			auto* actor = id ? RE::TESForm::LookupByID<RE::Actor>(id) : nullptr;
			if (a_op == "wagonUnseat") {
				if (!actor || SeatedIn(st, id) < 0)
					return Reply(false, "They are not in a wagon any more");
				a_w.unseat(id);
				return Reply(true, NameOf(actor, "They") + " climbs down");
			}
			if (a_op == "wagonSeat") {
				const int wagon = a_req.value("wagon", -1);
				const int seat = a_req.value("seat", -1);
				if (wagon < 0 || wagon >= count)
					return Reply(false, count ? "That wagon has left the convoy" : "Summon the wagon first");
				if (seat < 0 || seat >= static_cast<int>(kSeatNames.size()))
					return Reply(false, "Pick one of the five seats");
				if (!actor || !actor->Is3DLoaded() || actor->IsDead() || actor->IsPlayerRef() || IsHorse(actor))
					return Reply(false, "Only someone standing nearby can take a seat");
				a_w.seatInWagon(id, wagon, seat);
				logger::info("procession-bridge: seat {:08X} -> wagon {} seat {}", id, wagon, seat);
				return Reply(true, NameOf(actor, "They") + " takes " + kSeatNames[seat] + " of " + WagonLabel(wagon));
			}
			return Reply(false, "Unknown Procession action");
		}
	}

	void Init()
	{
		static bool done = false;
		if (done)
			return;
		done = true;
		// When a squad soldier's Sic 'em order ends (Disengage, Calm, a standing
		// order dropping), hand them back to Retinue's formation at once instead
		// of waiting for its 150 s release timeout.
		NpcActions::SetHonoraryOrderEndHook([](std::uint32_t a_id) {
			if (const auto* rr = Rr()) {
				rr->rejoinActor(a_id);
				logger::info("procession-bridge: sic-em order ended, {:08X} rejoins the squad", a_id);
			}
		});
	}

	bool ProcessionInstalled() { return Rp() != nullptr; }
	bool RetinueInstalled() { return Rr() != nullptr; }

	std::string StateJson()
	{
		json out;
		out["ok"] = true;
		json rp;
		if (const auto* a = Rp()) {
			rp["installed"] = true;
			rp["api"] = a->apiVersion();
			rp["types"] = Types();
			rp["state"] = ParseOr(Read(a->getState), json());
			json wagon{ { "supported", false } };
			if (const auto* w = RpWagon()) {
				wagon["supported"] = true;
				wagon["state"] = WagonState(*w);
				rp["people"] = People();
			}
			rp["wagon"] = std::move(wagon);
		} else {
			rp["installed"] = false;
			rp["loaded"] = ::GetModuleHandleA("RoyalProcession.dll") != nullptr;
		}
		out["rp"] = std::move(rp);

		json rr;
		if (const auto* a = Rr()) {
			rr["installed"] = true;
			rr["api"] = a->apiVersion();
			rr["presets"] = ParseOr(Read(a->listPresets), json::array());
			rr["squads"] = Squads(*a);
			rr["slots"] = kSlots;
			rr["canHold"] = a->canHold();
			rr["holding"] = a->canHold() && a->isHolding();
		} else {
			rr["installed"] = false;
			rr["loaded"] = ::GetModuleHandleA("RoyalRetinue.dll") != nullptr;
		}
		out["rr"] = std::move(rr);
		// Who "copy their gear" would copy: the palette-open crosshair snapshot.
		json cross = nullptr;
		if (const auto id = NpcActions::TargetFormID()) {
			if (auto* a = RE::TESForm::LookupByID<RE::Actor>(id); a && a->Is3DLoaded() && !a->IsPlayerRef()) {
				const char* n = a->GetDisplayFullName();
				cross = { { "id", id }, { "name", n && *n ? n : "them" }, { "horse", IsHorse(a) } };
			}
		}
		out["crosshair"] = std::move(cross);
		return out.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string Act(const std::string& reqJson)
	{
		const auto req = json::parse(reqJson, nullptr, false);
		if (req.is_discarded() || !req.is_object())
			return Reply(false, "Bad request - reopen Procession");
		const auto op = req.value("op", std::string{});

		// ---- palanquin ------------------------------------------------------
		if (op == "summon" || op == "dismiss" || op == "march" || op == "gear" || op == "dressAll") {
			const auto* rp = Rp();
			if (!rp)
				return Reply(false, kNoProcession);
			if (op == "summon") {
				const int type = req.value("type", -1);
				if (type < 0 || type >= static_cast<int>(Types().size()))
					return Reply(false, "Unknown palanquin design");
				rp->summonType(type);
				logger::info("procession-bridge: summon palanquin type {}", type);
				return Reply(true, std::string("Summoning the ") + Types()[type].value("name", std::string{}));
			}
			if (op == "dismiss") {
				rp->dismiss();
				return Reply(true, "Dismissing the palanquin and its bearers");
			}
			if (op == "march") {
				const bool on = req.value("on", false);
				rp->setActive(on);
				return Reply(true, on ? "Bearers, to your poles" : "Bearers released");
			}
			const int slot = req.value("slot", -1);
			if (slot < 0 || slot > 3)
				return Reply(false, "Pick one of the four poles");
			if (op == "gear") {
				rp->openBearerGear(slot);
				return Reply(true, "Opening the bearer's gear", { { "closeGameMenu", true } });
			}
			rp->copyBearerGear(slot);
			return Reply(true, "Dressing all four bearers alike");
		}

		// ---- wagons (api 3) --------------------------------------------------
		if (op == "wagonSummon" || op == "wagonHitch" || op == "wagonSeat" || op == "wagonUnseat" || op == "convoyAdd" ||
			op == "convoyRemove" || op == "wagonDismiss") {
			if (!Rp())
				return Reply(false, kNoProcession);
			const auto* w = RpWagon();
			if (!w)
				return Reply(false, kNoWagons);
			return WagonAct(*w, op, req);
		}

		// ---- escort squads ----------------------------------------------------
		const auto* rr = Rr();
		if (!rr)
			return Reply(false, kNoRetinue);

		if (op == "squadSummon") {
			const auto preset = req.value("preset", std::string{});
			if (!ValidId(preset) || !PresetExists(*rr, preset))
				return Reply(false, "That preset no longer exists");
			const auto id = rr->summonSquad(preset.c_str());
			if (!id)
				return Reply(false, "Royal Retinue refused the summon - see RoyalRetinue.log");
			logger::info("procession-bridge: summon squad '{}' -> id {}", preset, id);
			return Reply(true, "Summoning the squad", { { "squad", id } });
		}
		if (op == "squadDismissAll") {
			rr->dismissAllSquads();
			return Reply(true, "Dismissing every squad");
		}
		// Squads: Hold Here / Fall In (Retinue api 2): every squad at once.
		if (op == "squadHold") {
			if (!rr->canHold())
				return Reply(false, "Update Royal Retinue to hold a post");
			const bool hold = req.value("hold", true);
			if (hold && Squads(*rr).empty())
				return Reply(false, "No squads out - summon one first");
			rr->setHold(hold);
			logger::info("procession-bridge: squads {}", hold ? "hold a post" : "fall in");
			return Reply(true, hold ? "Squads, hold here" : "Squads, fall in");
		}
		if (op == "presetSave") {
			const auto& p = req.contains("preset") ? req["preset"] : json();
			if (!p.is_object())
				return Reply(false, "Bad preset");
			const auto id = p.value("id", std::string{});
			if (!ValidId(id))
				return Reply(false, "A preset id is lowercase letters, digits and dashes");
			auto name = Clip(p.value("name", std::string{}), 64);
			if (name.empty())
				return Reply(false, "Give the preset a name");
			json clean{ { "id", id }, { "name", name } };
			if (p.contains("blocks")) {
				clean["blocks"] = CleanBlocks(p["blocks"]);
				if (clean["blocks"].empty())
					return Reply(false, "A squad needs at least one block of soldiers");
			}
			rr->savePreset(clean.dump().c_str());
			return Reply(true, "Saved " + name);
		}
		if (op == "presetFromActor") {
			const auto id = req.value("id", std::string{});
			const auto name = Clip(req.value("name", std::string{}), 64);
			if (!ValidId(id) || name.empty())
				return Reply(false, "Give the preset a name first");
			std::uint32_t formId = req.value("formId", 0u);
			if (!formId)
				formId = NpcActions::TargetFormID();
			auto* actor = formId ? RE::TESForm::LookupByID<RE::Actor>(formId) : nullptr;
			if (!actor || !actor->Is3DLoaded() || actor->IsPlayerRef())
				return Reply(false, "Look at the person whose gear you want, then open the deck");
			rr->savePresetFromActor(id.c_str(), name.c_str(), formId);
			const char* who = actor->GetDisplayFullName();
			return Reply(true, std::string("Copied ") + (who && *who ? who : "their") + "'s gear into " + name);
		}
		if (op == "presetDelete") {
			const auto id = req.value("id", std::string{});
			if (!ValidId(id) || !PresetExists(*rr, id))
				return Reply(false, "That preset no longer exists");
			rr->deletePreset(id.c_str());
			return Reply(true, "Preset deleted");
		}

		// Verbs on one live squad: the id must be one ListSquads reports now.
		const std::uint32_t squad = req.value("squad", 0u);
		std::string         squadName;
		int                 group = 0;
		if (!squad || !SquadExists(*rr, squad, &squadName, &group))
			return Reply(false, "That squad is gone - it may have been dismissed");
		const std::string label = "Group " + std::to_string(group);

		if (op == "squadDismiss") {
			rr->dismissSquad(squad);
			return Reply(true, "Dismissing " + label);
		}
		if (op == "attack") {
			const auto ids = Members(*rr, squad);
			if (ids.empty())
				return Reply(false, label + " has nobody standing");
			// Release FIRST (the contract): the formation tick must not pull back a
			// soldier who has been ordered but has not entered combat yet.
			rr->releaseSquad(squad, 0.0f);
			if (!NpcActions::SicEmActors(ids, label)) {
				rr->rejoinSquad(squad);  // nothing was ordered — straight back into line
				return Reply(false, label + ": no target");
			}
			// Build marker (hd-markers.json: "procession-sic-em-group").
			logger::info("procession-bridge: sic-em group order - {} ({} soldiers) released and sent", label, ids.size());
			return Reply(true, label + " - attack!", { { "closeGameMenu", true } });
		}
		if (op == "standDown") {
			for (const auto id : Members(*rr, squad))
				NpcActions::CancelOrder(id);  // the order-end hook rejoins each one
			rr->rejoinSquad(squad);
			return Reply(true, label + ": back in formation");
		}
		return Reply(false, "Unknown Procession action");
	}
}
