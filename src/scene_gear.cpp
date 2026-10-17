#include "scene_gear.h"

#include "actor_identity.h"

#include <algorithm>
#include <cctype>
#include <map>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json/logger.

using json = nlohmann::json;

namespace SceneGear
{
	namespace
	{
		// Biped slot N is bit (N - 30): the engine's own numbering, and the one
		// OStim and the character sheet already use in this codebase.
		constexpr std::uint32_t Bit(int slot) { return 1u << (slot - 30); }

		struct BucketDef
		{
			const char* key;
			const char* label;
		};

		// Display order. A piece lands in exactly one of these; anything that
		// fits none is listed under "Other" in the view, never dropped. TWELVE
		// on purpose: the view lays them out 4 / 6 / 3 / 2 across, and a count
		// those all divide leaves no orphan cell on the last row.
		constexpr BucketDef kBuckets[] = {
			{ "wig", "Wig / hair" },
			{ "head", "Hat / helm" },
			{ "ears", "Earrings" },
			{ "neck", "Necklace" },
			{ "cloak", "Cloak / back" },
			{ "top", "Top / outfit" },
			{ "bra", "Bra" },
			{ "under", "Underwear" },
			{ "stockings", "Stockings" },
			{ "gloves", "Gloves" },
			{ "shoes", "Shoes" },
			{ "rings", "Rings" },
		};

		struct Piece
		{
			RE::TESBoundObject* obj = nullptr;
			std::string         formId;   // durable local id, "0x..." spelling
			std::string         plugin;
			std::string         name;
			std::string         bucket;   // "" = other
			std::uint32_t       mask = 0;
		};

		struct Gone
		{
			std::string formId, plugin, name, bucket;
		};

		// actor reference id -> pieces taken off here this scene.
		std::map<std::uint32_t, std::vector<Gone>> g_gone;
		std::uint64_t                              g_gen = ~0ull;

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// Lower-cased alphabetic words of a name: "Thigh-High Stockings 2" ->
		// {thigh, high, stockings}. Matching on WORDS is what keeps "bra" from
		// matching "brass" and "ring" from matching "earring" or "string".
		std::vector<std::string> Words(const std::string& name)
		{
			std::vector<std::string> out;
			std::string              cur;
			for (const unsigned char c : name) {
				if (std::isalpha(c))
					cur.push_back(static_cast<char>(std::tolower(c)));
				else if (!cur.empty()) {
					out.push_back(cur);
					cur.clear();
				}
			}
			if (!cur.empty())
				out.push_back(cur);
			return out;
		}

		bool Exact(const std::vector<std::string>& w, std::initializer_list<const char*> any)
		{
			for (const auto& x : w)
				for (const char* a : any)
					if (x == a)
						return true;
			return false;
		}

		bool Prefix(const std::vector<std::string>& w, std::initializer_list<const char*> any)
		{
			for (const auto& x : w)
				for (const char* a : any)
					if (x.rfind(a, 0) == 0)
						return true;
			return false;
		}

		// The piece's own words win (a bra is a bra whichever slot the mod
		// filed it under), then its biped slot. nullptr = no key slot.
		const char* Classify(const std::string& name, std::uint32_t mask)
		{
			const auto w = Words(name);
			if (Prefix(w, { "wig" }))
				return "wig";
			if (Exact(w, { "bra", "bras" }) || Prefix(w, { "brassiere", "bustier", "corset", "bikinitop" }))
				return "bra";
			if (Prefix(w, { "stocking", "pantyhose", "tights", "garter", "thighhigh" }) || Exact(w, { "hose", "stockings" }))
				return "stockings";
			if (Prefix(w, { "panties", "panty", "thong", "underwear", "briefs", "loincloth", "gstring" }))
				return "under";
			if (Prefix(w, { "earring" }))
				return "ears";
			if (Prefix(w, { "necklace", "choker", "pendant" }))
				return "neck";
			if (Prefix(w, { "cloak", "cape", "mantle" }))
				return "cloak";

			if (mask & (Bit(31) | Bit(41)))
				return "wig";
			if (mask & (Bit(30) | Bit(42)))
				return "head";
			if (mask & Bit(43))
				return "ears";
			if (mask & Bit(35))
				return "neck";
			if (mask & Bit(46))
				return "cloak";
			if (mask & Bit(36))
				return "rings";
			if (mask & (Bit(33) | Bit(34)))
				return "gloves";
			if (mask & Bit(37))
				return "shoes";
			if (mask & Bit(38))
				return "stockings";
			if (mask & (Bit(49) | Bit(52)))
				return "under";
			if (mask & Bit(32))
				return "top";
			return nullptr;
		}

		// Every worn ARMOUR piece. Weapons and torches are not clothing, and the
		// Clothing panel already has Take / Return weapons.
		std::vector<Piece> Worn(RE::Actor* actor)
		{
			std::vector<Piece> out;
			if (!actor)
				return out;
			auto inv = actor->GetInventory();
			for (auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				auto* entry = data.second.get();
				if (!entry || !entry->IsWorn())
					continue;
				auto* armo = obj->As<RE::TESObjectARMO>();
				if (!armo)
					continue;
				std::string name;
				if (const char* dn = entry->GetDisplayName(); dn && *dn)
					name = dn;
				else if (const char* fn = obj->GetName(); fn && *fn)
					name = fn;
				if (name.empty())
					continue;   // unnamed plumbing (FakeItem rows) is never clothing

				Piece p;
				if (!ActorIdentity::DurableOf(obj, p.formId, p.plugin))
					continue;   // no durable identity: it could not be put back later
				p.obj = obj;
				p.name = name;
				p.mask = static_cast<std::uint32_t>(armo->GetSlotMask());
				if (const char* b = Classify(name, p.mask))
					p.bucket = b;
				out.push_back(std::move(p));
			}
			std::sort(out.begin(), out.end(), [](const Piece& a, const Piece& b) {
				return Lower(a.name) < Lower(b.name);
			});
			return out;
		}

		RE::TESBoundObject* Resolve(const std::string& formId, const std::string& plugin)
		{
			auto* f = ActorIdentity::Resolve(formId, plugin);
			if (!f || !ActorIdentity::IsLive(f))
				return nullptr;
			return f->As<RE::TESBoundObject>();
		}

		// How many of `obj` the actor carries, and whether one is worn.
		void Carries(RE::Actor* actor, RE::TESBoundObject* obj, std::int32_t& count, bool& worn)
		{
			count = 0;
			worn = false;
			auto inv = actor->GetInventory([obj](RE::TESBoundObject& o) { return &o == obj; });
			for (auto& [o, data] : inv) {
				if (o != obj)
					continue;
				count = data.first;
				auto* e = data.second.get();
				worn = e && e->IsWorn();
				return;
			}
		}

		std::vector<Gone>& GoneFor(RE::Actor* actor, std::uint64_t gen)
		{
			if (gen != g_gen) {   // a different scene: nothing here describes it
				g_gone.clear();
				g_gen = gen;
			}
			return g_gone[actor->GetFormID()];
		}

		bool Unequip(RE::Actor* actor, const Piece& p)
		{
			auto* eqm = RE::ActorEquipManager::GetSingleton();
			if (!eqm || !p.obj)
				return false;
			eqm->UnequipObject(actor, p.obj);
			return true;
		}

		bool Equip(RE::Actor* actor, RE::TESBoundObject* obj)
		{
			auto* eqm = RE::ActorEquipManager::GetSingleton();
			if (!eqm || !obj)
				return false;
			eqm->EquipObject(actor, obj);
			return true;
		}

		void Remember(std::vector<Gone>& gone, const Piece& p)
		{
			for (const auto& g : gone)
				if (g.formId == p.formId && g.plugin == p.plugin)
					return;
			gone.push_back({ p.formId, p.plugin, p.name, p.bucket });
		}

		// Put back one remembered piece. False = it is not carried any more.
		bool Restore(RE::Actor* actor, const Gone& g)
		{
			auto* obj = Resolve(g.formId, g.plugin);
			if (!obj)
				return false;
			std::int32_t count = 0;
			bool         worn = false;
			Carries(actor, obj, count, worn);
			if (count <= 0)
				return false;
			if (!worn)
				Equip(actor, obj);
			return true;
		}
	}

	std::string StateJson(RE::Actor* actor, std::uint64_t sceneGen)
	{
		if (!actor)
			return Dump(json{ { "ok", false }, { "msg", "They aren't loaded right now" } });
		auto& gone = GoneFor(actor, sceneGen);
		const auto worn = Worn(actor);

		// A remembered piece is only "off" while the actor still carries it and
		// is not wearing it again (a re-equip elsewhere, OStim's own redress).
		std::vector<Gone> live;
		for (const auto& g : gone) {
			auto* obj = Resolve(g.formId, g.plugin);
			if (!obj)
				continue;
			std::int32_t count = 0;
			bool         isWorn = false;
			Carries(actor, obj, count, isWorn);
			if (count > 0 && !isWorn)
				live.push_back(g);
		}
		gone = live;

		json pieces = json::array();
		for (const auto& p : worn)
			pieces.push_back({ { "formId", p.formId }, { "plugin", p.plugin }, { "name", p.name },
				{ "bucket", p.bucket }, { "mask", p.mask } });

		json buckets = json::array();
		for (const auto& b : kBuckets) {
			json items = json::array();
			for (const auto& p : worn)
				if (p.bucket == b.key)
					items.push_back(p.name);
			int goneN = 0;
			for (const auto& g : gone)
				if (g.bucket == b.key)
					++goneN;
			buckets.push_back({ { "key", b.key }, { "label", b.label }, { "worn", items.size() },
				{ "items", items }, { "gone", goneN } });
		}

		json goneJ = json::array();
		for (const auto& g : gone)
			goneJ.push_back({ { "formId", g.formId }, { "plugin", g.plugin }, { "name", g.name }, { "bucket", g.bucket } });

		return Dump(json{ { "ok", true }, { "pieces", pieces }, { "buckets", buckets }, { "gone", goneJ },
			{ "pieceCount", worn.size() } });
	}

	std::string ActJson(RE::Actor* actor, const std::string& req, std::uint64_t sceneGen)
	{
		const auto j = json::parse(req, nullptr, false);
		if (!actor || j.is_discarded() || !j.is_object())
			return Dump(json{ { "ok", false }, { "msg", "Bad request" } });

		auto&             gone = GoneFor(actor, sceneGen);
		const std::string op = j.value("op", std::string(""));
		const std::string bucket = j.value("bucket", std::string(""));
		const auto        worn = Worn(actor);
		std::string       msg;
		int               moved = 0;

		if (op == "off") {
			const auto id = j.value("item", std::string(""));
			const auto plg = j.value("itemPlugin", std::string(""));
			for (const auto& p : worn)
				if (p.formId == id && Lower(p.plugin) == Lower(plg)) {
					if (Unequip(actor, p)) {
						Remember(gone, p);
						++moved;
						msg = "Took " + p.name + " off";
					}
					break;
				}
			if (!moved)
				msg = "That piece isn't being worn";
		} else if (op == "on") {
			const auto id = j.value("item", std::string(""));
			const auto plg = j.value("itemPlugin", std::string(""));
			auto*      obj = Resolve(id, plg);
			std::int32_t count = 0;
			bool         isWorn = false;
			if (obj)
				Carries(actor, obj, count, isWorn);
			if (!obj || count <= 0) {
				msg = "They aren't carrying that any more";
			} else {
				if (!isWorn)
					Equip(actor, obj);
				std::string name = obj->GetName() ? obj->GetName() : "it";
				gone.erase(std::remove_if(gone.begin(), gone.end(),
							   [&](const Gone& g) { return g.formId == id && Lower(g.plugin) == Lower(plg); }),
					gone.end());
				++moved;
				msg = "Put " + name + " back on";
			}
		} else if (op == "bucketOff" || op == "allOff") {
			const bool all = op == "allOff";
			if (!all) {
				bool known = false;
				for (const auto& b : kBuckets)
					known = known || bucket == b.key;
				if (!known) {
					return Dump(json{ { "ok", false }, { "msg", "Unknown slot" } });
				}
			}
			for (const auto& p : worn) {
				if (!all && p.bucket != bucket)
					continue;
				if (Unequip(actor, p)) {
					Remember(gone, p);
					++moved;
				}
			}
			msg = moved ? "Took off " + std::to_string(moved) + (moved == 1 ? " piece" : " pieces")
						: (all ? "They aren't wearing anything to take off" : "Nothing worn in that slot");
		} else if (op == "bucketOn" || op == "allOn") {
			const bool all = op == "allOn";
			std::vector<Gone> keep;
			for (const auto& g : gone) {
				if (!all && g.bucket != bucket) {
					keep.push_back(g);
					continue;
				}
				if (Restore(actor, g))
					++moved;
			}
			gone = keep;
			msg = moved ? "Put back " + std::to_string(moved) + (moved == 1 ? " piece" : " pieces")
						: "Nothing was taken off to put back";
		} else {
			return Dump(json{ { "ok", false }, { "msg", "Unknown gear request" } });
		}

		logger::info("scene-gear: {} on {:08X} -> {} piece(s)", op, actor->GetFormID(), moved);   // marker: scene-gear-act
		auto out = json::parse(StateJson(actor, sceneGen), nullptr, false);
		if (!out.is_object())
			out = json::object();
		out["ok"] = moved > 0;
		out["msg"] = msg;
		return Dump(out);
	}

	void RestoreAll()
	{
		int restored = 0;
		for (auto& [id, list] : g_gone) {
			auto* actor = RE::TESForm::LookupByID<RE::Actor>(id);
			if (!actor)
				continue;
			for (const auto& g : list)
				if (Restore(actor, g))
					++restored;
		}
		g_gone.clear();
		if (restored)
			logger::info("scene-gear: scene ended, put back {} piece(s)", restored);
	}
}
