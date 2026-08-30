#include "zaz_deck.h"

#include "item_icons.h"
#include "npc_actions.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <unordered_map>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json/logger and std::literals.

using json = nlohmann::json;

namespace ZazDeck
{
	namespace
	{
		constexpr const char* kEsm = "ZaZAnimationPack.esm";
		constexpr float       kFurnRadius = 2048.0f;   // ~29 m — the room you're in
		constexpr std::size_t kFurnCap = 16;

		struct Device
		{
			RE::TESObjectARMO* armo = nullptr;
			std::uint32_t      formId = 0;   // runtime
			std::string        key;          // "Plugin.esm|00ABCD" — durable identity
			std::string        name;
			std::string        cat;          // from its zbfWorn* keyword ("Wrist", "Gag", …)
			// Which biped slots it occupies, as words. Rober, 2026-08-17: "it
			// should also show an icon and hover over item of what body slots it
			// uses" — with 202 devices across wrists, gags, collars and yokes,
			// what a piece will DISPLACE is the thing you want to know before
			// you click, and it is the reason two devices can silently replace
			// each other.
			std::vector<std::string> slots;
		};

		// 30..61, the engine's biped object slots. 30-43 have vanilla meanings;
		// everything above is mod-assigned, and ZAP/Devious live up there — so
		// those are reported honestly as a number rather than given a made-up
		// name. Index 0 == slot 30.
		const char* const kSlotNames[] = {
			"Head", "Hair", "Body", "Hands", "Forearms", "Amulet", "Ring", "Feet",
			"Calves", "Shield", "Tail", "Long hair", "Circlet", "Ears"
		};

		std::vector<std::string> SlotsOf(RE::TESObjectARMO* armo)
		{
			std::vector<std::string> out;
			if (!armo)
				return out;
			const auto mask = static_cast<std::uint32_t>(armo->GetSlotMask());
			for (int bit = 0; bit < 32; ++bit) {
				if (!(mask & (1u << bit)))
					continue;
				if (bit < static_cast<int>(std::size(kSlotNames)))
					out.emplace_back(kSlotNames[bit]);
				else
					out.emplace_back("Slot " + std::to_string(30 + bit));
			}
			return out;
		}

		std::vector<Device>                          g_devices;
		std::unordered_map<std::uint32_t, std::size_t> g_byFormId;   // runtime id -> index
		bool                                         g_built = false;

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		bool IsZazEsm(const RE::TESFile* f)
		{
			return f && Lower(std::string(f->GetFilename())) == Lower(kEsm);
		}

		// "zbfWornPiercingsNipple" -> "Piercings Nipple"; "zbfWornWrist" -> "Wrist".
		std::string PrettyCat(std::string_view kw)
		{
			constexpr std::string_view prefix = "zbfWorn";
			std::string_view rest = kw.substr(prefix.size());
			std::string out;
			for (std::size_t i = 0; i < rest.size(); ++i) {
				if (i > 0 && std::isupper(static_cast<unsigned char>(rest[i])) &&
					!std::isupper(static_cast<unsigned char>(rest[i - 1])))
					out += ' ';
				out += rest[i];
			}
			return out.empty() ? std::string("Other") : out;
		}

		bool StartsWith(const char* s, const char* prefix)
		{
			return s && _strnicmp(s, prefix, std::strlen(prefix)) == 0;
		}

		// Any zbf* keyword on the form? Category from its zbfWorn* one when present.
		// (Runtime keyword edids are reliable — BGSKeyword keeps its editorID.)
		bool ZbfCat(const RE::BGSKeywordForm* kwf, std::string& outCat)
		{
			if (!kwf)
				return false;
			bool anyZbf = false;
			outCat.clear();
			for (std::uint32_t i = 0; i < kwf->numKeywords; ++i) {
				auto* kw = kwf->keywords[i];
				if (!kw)
					continue;
				const char* edid = kw->GetFormEditorID();
				if (!StartsWith(edid, "zbf"))
					continue;
				anyZbf = true;
				if (outCat.empty() && StartsWith(edid, "zbfWorn"))
					outCat = PrettyCat(edid);
			}
			if (anyZbf && outCat.empty())
				outCat = "Other";
			return anyZbf;
		}

		// Runtime enumeration — fits WHATEVER ZaZ variant is installed: every
		// named ARMO in the load order carrying zbf keywords (ZAP's own device
		// taxonomy), from the ESM or an addon pack alike. Built once per session.
		void BuildDevices()
		{
			if (g_built)
				return;
			g_built = true;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			for (auto* armo : dh->GetFormArray<RE::TESObjectARMO>()) {
				if (!armo)
					continue;
				const char* nm = armo->GetFullName();
				if (!nm || !nm[0])
					continue;
				std::string cat;
				if (!ZbfCat(armo, cat))
					continue;
				auto* file = armo->GetFile(0);
				if (!file)
					continue;
				Device d;
				d.armo = armo;
				d.formId = armo->GetFormID();
				// File-width mask, exactly as GetLocalFormID would if it
				// null-checked (the item_explorer idiom — never the CommonLib call).
				const std::uint32_t local = d.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				char idbuf[16];
				std::snprintf(idbuf, sizeof(idbuf), "%06X", local);
				d.key = std::string(file->GetFilename()) + "|" + idbuf;
				d.name = nm;
				d.cat = cat;
				d.slots = SlotsOf(armo);
				g_byFormId[d.formId] = g_devices.size();
				g_devices.push_back(std::move(d));
			}
			std::sort(g_devices.begin(), g_devices.end(), [](const Device& a, const Device& b) {
				if (a.cat != b.cat)
					return a.cat < b.cat;
				return a.name < b.name;
			});
			g_byFormId.clear();
			for (std::size_t i = 0; i < g_devices.size(); ++i)
				g_byFormId[g_devices[i].formId] = i;
			logger::info("zaz: device catalogue built — {} devices (marker zaz-deck-catalog)", g_devices.size());
		}

		bool ZapPresent()
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && dh->LookupModByName(kEsm) != nullptr;
		}

		// The Animations tab's own target rule: crosshair NPC snapshotted at
		// palette open, else the player.
		RE::Actor* TargetActor()
		{
			if (auto id = NpcActions::TargetFormID()) {
				if (auto* a = RE::TESForm::LookupByID<RE::Actor>(id))
					return a;
			}
			return RE::PlayerCharacter::GetSingleton();
		}

		std::string NameOf(RE::Actor* a)
		{
			if (a) {
				if (auto* base = a->GetActorBase())
					if (auto n = base->GetFullName(); n && n[0])
						return n;
			}
			return "actor";
		}

		json TargetJson(RE::Actor* a)
		{
			auto* pc = RE::PlayerCharacter::GetSingleton();
			const bool isPlayer = (a == pc);
			return json{
				{ "player", isPlayer },
				{ "name", isPlayer ? "You" : NameOf(a) },
				{ "formId", a ? a->GetFormID() : 0 },
				{ "dead", a && a->IsDead() },
			};
		}

		// Worn devices via the biped-slot scan — 32 GetWornArmor calls, no
		// inventory walk needed for the read side.
		std::vector<std::size_t> WornDeviceIdx(RE::Actor* a)
		{
			std::vector<std::size_t> out;
			if (!a)
				return out;
			for (std::uint32_t bit = 0; bit < 32; ++bit) {
				auto* armo = a->GetWornArmor(static_cast<RE::BIPED_MODEL::BipedObjectSlot>(1u << bit));
				if (!armo)
					continue;
				auto it = g_byFormId.find(armo->GetFormID());
				if (it == g_byFormId.end())
					continue;
				if (std::find(out.begin(), out.end(), it->second) == out.end())
					out.push_back(it->second);
			}
			return out;
		}

		json WornKeysJson(RE::Actor* a)
		{
			json arr = json::array();
			for (auto i : WornDeviceIdx(a))
				arr.push_back(g_devices[i].key);
			return arr;
		}

		// ZaZ furniture refs loaded around the player — the ESM's own FURN
		// records (or any furniture carrying zbf keywords), nearest first.
		json FurnitureJson()
		{
			json arr = json::array();
			auto* pc = RE::PlayerCharacter::GetSingleton();
			auto* tes = RE::TES::GetSingleton();
			if (!pc || !tes)
				return arr;

			struct Hit
			{
				RE::TESObjectREFR* ref;
				float              d2;
			};
			std::vector<Hit> hits;
			const RE::NiPoint3 origin = pc->GetPosition();

			tes->ForEachReferenceInRange(pc, kFurnRadius,
				[&](RE::TESObjectREFR* ref) -> RE::BSContainer::ForEachResult {
					if (!ref || ref->IsDisabled() || ref->IsDeleted())
						return RE::BSContainer::ForEachResult::kContinue;
					auto* base = ref->GetBaseObject();
					if (!base || !base->Is(RE::FormType::Furniture))
						return RE::BSContainer::ForEachResult::kContinue;
					std::string cat;
					const bool zbf = ZbfCat(base->As<RE::BGSKeywordForm>(), cat);
					if (!zbf && !IsZazEsm(base->GetFile(0)))
						return RE::BSContainer::ForEachResult::kContinue;
					hits.push_back({ ref, origin.GetSquaredDistance(ref->GetPosition()) });
					return RE::BSContainer::ForEachResult::kContinue;
				});

			std::sort(hits.begin(), hits.end(), [](const Hit& a, const Hit& b) { return a.d2 < b.d2; });
			if (hits.size() > kFurnCap)
				hits.resize(kFurnCap);

			for (const auto& h : hits) {
				const char* nm = nullptr;
				if (auto* b = h.ref->GetBaseObject())
					nm = b->GetName();
				char refbuf[16];
				std::snprintf(refbuf, sizeof(refbuf), "0x%08X", h.ref->GetFormID());
				arr.push_back(json{
					{ "ref", refbuf },
					{ "name", (nm && nm[0]) ? nm : "ZaZ furniture" },
					// game units -> rough metres (≈70 u/m) so the row reads humanly
					{ "m", static_cast<int>(std::sqrt(h.d2) / 70.0f + 0.5f) },
				});
			}
			return arr;
		}

		Device* DeviceByKey(const std::string& key)
		{
			const auto bar = key.find('|');
			if (bar == std::string::npos)
				return nullptr;
			const std::string plugin = key.substr(0, bar);
			std::uint32_t local = 0;
			try {
				local = static_cast<std::uint32_t>(std::stoul(key.substr(bar + 1), nullptr, 16));
			} catch (...) {
				return nullptr;
			}
			auto* dh = RE::TESDataHandler::GetSingleton();
			auto* form = dh ? dh->LookupForm(local, plugin) : nullptr;
			if (!form)
				return nullptr;
			auto it = g_byFormId.find(form->GetFormID());
			return (it != g_byFormId.end()) ? &g_devices[it->second] : nullptr;
		}

		json Result(bool ok, const std::string& msg, RE::Actor* wornOf = nullptr, bool close = false)
		{
			json out{ { "ok", ok }, { "msg", msg } };
			if (wornOf)
				out["wornKeys"] = WornKeysJson(wornOf);
			if (close)
				out["close"] = true;
			return out;
		}

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
	}

	void Init()
	{
		g_devices.clear();
		g_byFormId.clear();
		g_built = false;
		logger::info("zaz: deck segment ready (marker zaz-deck)");
	}

	std::string OpenJson()
	{
		json out = json::object();
		const bool zap = ZapPresent();
		out["zap"] = zap;
		if (!zap) {
			out["devices"] = json::array();
			out["furniture"] = json::array();
			out["target"] = json::object();
			return Dump(out);
		}
		BuildDevices();
		auto* a = TargetActor();
		out["target"] = TargetJson(a);

		const auto wornIdx = WornDeviceIdx(a);
		json devices = json::array();
		for (std::size_t i = 0; i < g_devices.size(); ++i) {
			const auto& d = g_devices[i];
			devices.push_back(json{
				{ "key", d.key },
				{ "name", d.name },
				{ "cat", d.cat },
				{ "worn", std::find(wornIdx.begin(), wornIdx.end(), i) != wornIdx.end() },
			});
		}
		out["devices"] = devices;
		out["furniture"] = FurnitureJson();
		return Dump(out);
	}

	std::string StateJson()
	{
		json out = json::object();
		const bool zap = ZapPresent();
		out["zap"] = zap;
		if (zap) {
			BuildDevices();
			auto* a = TargetActor();
			out["target"] = TargetJson(a);
			out["wornKeys"] = WornKeysJson(a);
			out["furniture"] = FurnitureJson();
		}
		return Dump(out);
	}

	std::string ActJson(const std::string& payload)
	{
		json j = json::parse(payload, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(Result(false, "bad request"));
		const std::string op = j.value("op", "");
		auto* a = TargetActor();
		if (!a)
			return Dump(Result(false, "No target"));
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return Dump(Result(false, "Equip manager missing"));
		BuildDevices();

		if (op == "free") {
			const auto worn = WornDeviceIdx(a);
			if (worn.empty())
				return Dump(Result(true, NameOf(a) + " is wearing no ZaZ gear", a));
			for (auto i : worn) {
				auto& d = g_devices[i];
				eqm->UnequipObject(a, d.armo);
				a->RemoveItem(d.armo, 1, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
			}
			logger::info("zaz: freed '{}' of {} device(s)", NameOf(a), worn.size());
			const std::string who = (a == RE::PlayerCharacter::GetSingleton())
				? std::string("You are") : (NameOf(a) + " is");
			return Dump(Result(true, "🧹 " + who + " free — " + std::to_string(worn.size()) + " device(s) off", a));
		}

		auto* d = DeviceByKey(j.value("key", ""));
		if (!d)
			return Dump(Result(false, "That device isn't in the load order any more", a));

		const auto worn = WornDeviceIdx(a);
		const bool isWorn = std::any_of(worn.begin(), worn.end(),
			[&](std::size_t i) { return g_devices[i].armo == d->armo; });

		if (op == "apply") {
			if (isWorn)
				return Dump(Result(true, NameOf(a) + " already wears " + d->name, a));
			a->AddObjectToContainer(d->armo, nullptr, 1, nullptr);
			// wardrobe.cpp's proven equip flags — ZAP's zbf effect script rides
			// the equip event; its pose/effect fires the moment the game unpauses.
			eqm->EquipObject(a, d->armo, nullptr, 1, nullptr,
				/*queueEquip*/ true, /*forceEquip*/ true, /*playSounds*/ false, /*applyNow*/ true);
			logger::info("zaz: apply '{}' -> '{}' (marker zaz-apply)", d->name, NameOf(a));
			return Dump(Result(true, "⛓ " + d->name + " on — takes hold when the deck closes", a));
		}
		if (op == "remove") {
			if (!isWorn)
				return Dump(Result(true, NameOf(a) + " isn't wearing " + d->name, a));
			eqm->UnequipObject(a, d->armo);
			a->RemoveItem(d->armo, 1, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
			logger::info("zaz: remove '{}' <- '{}'", d->name, NameOf(a));
			return Dump(Result(true, "✓ " + d->name + " off", a));
		}
		return Dump(Result(false, "unknown op", a));
	}

	std::string UseJson(const std::string& payload)
	{
		json j = json::parse(payload, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(Result(false, "bad request"));
		std::uint32_t refId = 0;
		try {
			refId = static_cast<std::uint32_t>(std::stoul(j.value("ref", "0"), nullptr, 16));
		} catch (...) {
		}
		auto* ref = refId ? RE::TESForm::LookupByID<RE::TESObjectREFR>(refId) : nullptr;
		if (!ref)
			return Dump(Result(false, "That furniture isn't loaded any more — ⟳ refresh"));

		auto* a = TargetActor();
		auto* pc = RE::PlayerCharacter::GetSingleton();
		if (!a || a == pc)
			return Dump(Result(false, "That sends an NPC — walk up and activate it yourself"));
		if (a->IsDead())
			return Dump(Result(false, NameOf(a) + " is dead — a corpse can't use furniture"));

		std::string msg;
		const bool ok = NpcActions::SeatOn(a->GetFormID(), refId, msg);
		if (ok)
			logger::info("zaz: seat '{}' on ref {:08X} (marker zaz-furniture)", NameOf(a), refId);
		// close:true — the walk-over is alias/Papyrus work that only runs
		// unpaused, so the view closes the palette (party-orders law).
		return Dump(Result(ok, msg, a, ok));
	}

	// ---- the Effects modal's surface over the SAME catalogue (2026-08-17) ----
	//
	// Nothing below builds a second device list: every one of these calls
	// BuildDevices() and reads g_devices, so the Animations tab and the quick
	// card cannot drift about what ZaZ offers.

	namespace
	{
		// ItemIcons keys are UPPERCASE local hex + '|' + lowercase plugin; a
		// Device key is the other way round ("Plugin.esm|00ABCD"). One place
		// converts, so a mismatch cannot hide in two.
		std::string IconKeyOf(const Device& d)
		{
			if (!d.armo)
				return "";
			const auto* file = d.armo->GetFile(0);
			const std::string plugin = file ? Lower(std::string(file->GetFilename())) : "";
			char buf[16]{};
			std::snprintf(buf, sizeof(buf), "%06X", d.armo->GetLocalFormID() & 0x00FFFFFFu);
			return std::string(buf) + "|" + plugin;
		}

		// The {items:[{formId,plugin,name}]} payload ItemIcons wants.
		json IconRequestFor(const std::vector<std::size_t>& idx)
		{
			json items = json::array();
			for (auto i : idx) {
				if (i >= g_devices.size() || !g_devices[i].armo)
					continue;
				const auto* file = g_devices[i].armo->GetFile(0);
				char        buf[16]{};
				std::snprintf(buf, sizeof(buf), "%06X",
					g_devices[i].armo->GetLocalFormID() & 0x00FFFFFFu);
				items.push_back(json{
					{ "formId", std::string(buf) },
					{ "plugin", file ? std::string(file->GetFilename()) : std::string() },
					{ "name", g_devices[i].name },
				});
			}
			return json{ { "items", items } };
		}
	}

	bool Present()
	{
		auto* dh = RE::TESDataHandler::GetSingleton();
		return dh && (dh->LookupLoadedModByName(kEsm) != nullptr ||
						 dh->LookupLoadedLightModByName(kEsm) != nullptr);
	}

	nlohmann::json EffectsJson(std::uint32_t formId)
	{
		json out;
		out["present"] = Present();
		if (!Present()) {
			out["count"] = 0;
			out["cats"] = json::array();
			out["devices"] = json::array();
			out["reason"] = "ZaZ Animation Pack isn't in the load order";
			return out;
		}

		BuildDevices();
		auto* a = formId ? RE::TESForm::LookupByID<RE::Actor>(formId) : nullptr;
		const auto worn = WornDeviceIdx(a);

		// The icon index is read ONCE per call, not per device: it is a
		// directory read and doing it 400 times would be the very stall the
		// paging exists to avoid.
		json index = json::object();
		{
			json parsed = json::parse(ItemIcons::IndexJson(), nullptr, false);
			if (!parsed.is_discarded() && parsed.is_object() && parsed["icons"].is_object())
				index = parsed["icons"];
		}

		std::map<std::string, int> tally;
		json devices = json::array();
		for (std::size_t i = 0; i < g_devices.size(); ++i) {
			const auto& d = g_devices[i];
			++tally[d.cat];
			const auto  ikey = IconKeyOf(d);
			const auto  hit = index.find(ikey);
			devices.push_back(json{
				{ "key", d.key },
				{ "name", d.name },
				{ "cat", d.cat },
				{ "slots", d.slots },
				{ "worn", std::find(worn.begin(), worn.end(), i) != worn.end() },
				{ "icon", (hit != index.end() && hit->is_string())
							  ? json(hit->get<std::string>()) : json(nullptr) },
			});
		}

		json cats = json::array();
		for (const auto& [name, n] : tally)
			cats.push_back(json{ { "cat", name }, { "count", n } });

		out["count"] = static_cast<int>(g_devices.size());
		out["cats"] = cats;
		out["devices"] = devices;
		out["iconsAvailable"] = ItemIcons::Available();
		logger::info("zaz: effects view — {} device(s) (marker zaz-effects-tab)", g_devices.size());
		return out;
	}

	std::string ApplyTo(std::uint32_t formId, const std::string& key, bool on)
	{
		const std::string id = "zaz:" + key;
		if (!Present())
			return Dump(json{ { "ok", false }, { "msg", "ZaZ isn't in the load order" },
				{ "id", id }, { "on", on } });

		auto* a = formId ? RE::TESForm::LookupByID<RE::Actor>(formId) : nullptr;
		if (!a)
			return Dump(json{ { "ok", false }, { "msg", "that NPC isn't loaded any more" },
				{ "id", id }, { "on", on } });

		BuildDevices();

		// "free" is a verb, not a device — the modal's "Free her" button. It
		// rides the same id so the tab needs no second entry point.
		if (key == "free") {
			const auto worn = WornDeviceIdx(a);
			if (worn.empty())
				return Dump(json{ { "ok", true }, { "msg", NameOf(a) + " is wearing no ZaZ gear" },
					{ "id", id }, { "on", false } });
			auto* freeEqm = RE::ActorEquipManager::GetSingleton();
			if (!freeEqm)
				return Dump(json{ { "ok", false }, { "msg", "equip manager missing" },
					{ "id", id }, { "on", false } });
			for (auto i : worn) {
				freeEqm->UnequipObject(a, g_devices[i].armo);
				a->RemoveItem(g_devices[i].armo, 1, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
			}
			logger::info("zaz: modal freed {:08X} of {} device(s)", formId, worn.size());
			return Dump(json{ { "ok", true },
				{ "msg", NameOf(a) + " free — " + std::to_string(worn.size()) + " device(s) off" },
				{ "id", id }, { "on", false } });
		}

		auto* d = DeviceByKey(key);
		if (!d)
			return Dump(json{ { "ok", false },
				{ "msg", "that device isn't in the load order any more" }, { "id", id }, { "on", on } });

		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return Dump(json{ { "ok", false }, { "msg", "equip manager missing" },
				{ "id", id }, { "on", on } });

		const auto worn = WornDeviceIdx(a);
		const bool isWorn = std::any_of(worn.begin(), worn.end(),
			[&](std::size_t i) { return g_devices[i].armo == d->armo; });

		if (on) {
			if (isWorn)
				return Dump(json{ { "ok", true }, { "msg", NameOf(a) + " already wears " + d->name },
					{ "id", id }, { "on", true } });
			a->AddObjectToContainer(d->armo, nullptr, 1, nullptr);
			eqm->EquipObject(a, d->armo, nullptr, 1, nullptr,
				/*queueEquip*/ true, /*forceEquip*/ true, /*playSounds*/ false, /*applyNow*/ true);
			logger::info("zaz: modal apply '{}' -> {:08X}", d->name, formId);
			// The same honest caveat the Animations tab gives: ZAP's zbf script
			// rides the equip event and the VM is paused while the deck is open.
			return Dump(json{ { "ok", true },
				{ "msg", d->name + " on — takes hold when the deck closes" }, { "id", id }, { "on", true } });
		}

		if (!isWorn)
			return Dump(json{ { "ok", true }, { "msg", NameOf(a) + " isn't wearing " + d->name },
				{ "id", id }, { "on", false } });
		eqm->UnequipObject(a, d->armo);
		a->RemoveItem(d->armo, 1, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
		logger::info("zaz: modal remove '{}' <- {:08X}", d->name, formId);
		return Dump(json{ { "ok", true }, { "msg", d->name + " off" }, { "id", id }, { "on", false } });
	}

	std::string RequestIcons(const std::string& keysCsv)
	{
		if (!Present())
			return Dump(json{ { "ok", false }, { "msg", "ZaZ isn't in the load order" }, { "queued", 0 } });
		if (!ItemIcons::Available())
			// Honest, not silent: no Mesh Rendering Framework means glyphs, and
			// the view says so rather than waiting forever for pictures.
			return Dump(json{ { "ok", false },
				{ "msg", "Mesh Rendering Framework isn't loaded — no icons" }, { "queued", 0 } });

		BuildDevices();
		std::vector<std::size_t> want;
		std::size_t              start = 0;
		while (start <= keysCsv.size()) {
			const auto comma = keysCsv.find(',', start);
			const auto piece = keysCsv.substr(start, comma == std::string::npos
					? std::string::npos : comma - start);
			if (!piece.empty()) {
				for (std::size_t i = 0; i < g_devices.size(); ++i) {
					if (g_devices[i].key == piece) {
						want.push_back(i);
						break;
					}
				}
			}
			if (comma == std::string::npos)
				break;
			start = comma + 1;
		}
		if (want.empty())
			return Dump(json{ { "ok", true }, { "msg", "" }, { "queued", 0 } });

		ItemIcons::EnsureIconsForList(Dump(IconRequestFor(want)));
		logger::info("zaz: icon page requested — {} device(s)", want.size());
		// Empty msg on purpose: a page turn must not toast.
		return Dump(json{ { "ok", true }, { "msg", "" }, { "queued", static_cast<int>(want.size()) } });
	}
}
