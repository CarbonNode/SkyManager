#include "place_actions.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <unordered_set>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json and `using namespace std::literals`.

using json = nlohmann::json;

namespace PlaceActions
{
	namespace
	{
		// Vanilla XMarker (Skyrim.esm 0x0000003B) — an invisible static, the
		// destination reference every recall aims at.
		//
		// MoveTo is the only teleport that runs the engine's own cell attach /
		// worldspace transition / load-screen sequence; writing the player's
		// parent cell and position directly skips all of it and drops you into
		// unloaded space. MoveTo needs a reference to aim at, so exactly one
		// marker is placed lazily on the first recall of a session and re-aimed
		// before every later one. Session-scoped on purpose: a raw FormID kept
		// across saves would be a dynamic (0xFF……) id that the engine remaps on
		// load, so a stored one could resolve to an unrelated object.
		constexpr RE::FormID kXMarker = 0x0000003B;

		constexpr float kCellSize = 4096.0f;  // exterior cell edge, for grid naming

		RE::FormID g_marker = 0;

		// Display name of any form: its FULL name when it has one, else its
		// editor id. As<TESFullName>() is a null-returning RTTI cast, so a form
		// type without the mixin costs nothing.
		std::string NameOfForm(RE::TESForm* form)
		{
			if (!form)
				return "";
			if (auto* full = form->As<RE::TESFullName>()) {
				const auto* n = full->GetFullName();
				if (n && n[0])
					return n;
			}
			const auto* eid = form->GetFormEditorID();
			return (eid && eid[0]) ? eid : "";
		}

		std::string EditorIdOf(RE::TESForm* form)
		{
			const auto* eid = form ? form->GetFormEditorID() : nullptr;
			return (eid && eid[0]) ? eid : "";
		}

		// FormID first, editor id as the fallback — interior cells keep their
		// editor ids at runtime, which survives a plugin being re-indexed.
		RE::TESObjectCELL* ResolveCell(std::uint32_t cellId, const std::string& editorId)
		{
			if (cellId) {
				if (auto* cell = RE::TESForm::LookupByID<RE::TESObjectCELL>(cellId))
					return cell;
			}
			if (!editorId.empty()) {
				if (auto* cell = RE::TESForm::LookupByEditorID<RE::TESObjectCELL>(editorId))
					return cell;
			}
			return nullptr;
		}

		// The session's recall marker, created on demand. Returns nullptr when
		// the XMarker base or the placement is unavailable.
		RE::TESObjectREFR* EnsureMarker(RE::PlayerCharacter* player)
		{
			if (g_marker) {
				if (auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(g_marker))
					return ref;
				g_marker = 0;  // save reloaded under us — place a fresh one
			}
			auto* base = RE::TESForm::LookupByID<RE::TESBoundObject>(kXMarker);
			if (!base) {
				logger::error("domains: XMarker {:08X} missing — Skyrim.esm not loaded?", kXMarker);
				return nullptr;
			}
			// forcePersist: the marker has to survive its cell unloading, since
			// it spends most of its life in whichever cell was last recalled to.
			auto ptr = player->PlaceObjectAtMe(base, true);
			if (!ptr) {
				logger::error("domains: PlaceObjectAtMe(XMarker) returned null");
				return nullptr;
			}
			g_marker = ptr->GetFormID();
			logger::info("domains: recall marker placed ({:08X})", g_marker);
			return ptr.get();
		}

		// Re-aim the session's single recall marker at cell + position + Z angle and
		// return it, ready to hand to MoveTo. The ONE place the marker is moved —
		// shared by the player recall and the "summon NPC here" move so both travel
		// through the same XMarker with an identical four-call aim sequence. The
		// worldspace is deliberately not a parameter: MoveTo derives it from the
		// cell. Returns nullptr when the marker can't be placed (logged inside
		// EnsureMarker).
		RE::TESObjectREFR* AimRecallMarker(RE::PlayerCharacter* player, RE::TESObjectCELL* cell,
			const RE::NiPoint3& pos, float angleZ)
		{
			auto* marker = EnsureMarker(player);
			if (!marker)
				return nullptr;
			// Moving the marker by hand is safe where moving the player by hand is
			// not — it is an inert static with no AI, no packages and no physics.
			marker->SetParentCell(cell);
			marker->SetPosition(pos);
			marker->SetAngle(RE::NiPoint3{ 0.0f, 0.0f, angleZ });
			marker->Update3DPosition(true);
			return marker;
		}

		// Default name for a new mark. Named cells win (interiors, city
		// exteriors); an unnamed exterior falls back to its worldspace plus the
		// cell grid, so a hundred wilderness marks stay distinguishable.
		std::string SuggestName(const std::string& cellName, const std::string& worldName,
			const std::string& cellEdid, const RE::NiPoint3& pos, bool interior)
		{
			if (!cellName.empty())
				return cellName;
			if (!worldName.empty() && !interior) {
				const auto gx = static_cast<int>(std::floor(pos.x / kCellSize));
				const auto gy = static_cast<int>(std::floor(pos.y / kCellSize));
				char       buf[64];
				std::snprintf(buf, sizeof(buf), " (%d, %d)", gx, gy);
				return worldName + buf;
			}
			if (!worldName.empty())
				return worldName;
			if (!cellEdid.empty())
				return cellEdid;
			return "Unnamed place";
		}

		// Engine strings can carry cp1252 bytes; dump() must never throw on the
		// way into an Invoke.
		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}
	}

	void Init()
	{
		g_marker = 0;
		if (RE::TESForm::LookupByID(kXMarker))
			logger::info("PlaceActions: XMarker resolved — recall available");
		else
			logger::warn("PlaceActions: XMarker {:08X} not found — recall will refuse", kXMarker);
	}

	std::string CurrentLocationJson()
	{
		json out;
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player) {
			out["ok"] = false;
			out["msg"] = "No player reference";
			return Dump(out);
		}

		auto*      cell = player->GetParentCell();
		auto*      world = player->GetWorldspace();
		const auto pos = player->GetPosition();

		// A cell is interior exactly when it has no worldspace — derived rather
		// than flagged, so it can't disagree with what MoveTo will do.
		const bool        interior = world == nullptr;
		const std::string cellName = NameOfForm(cell);
		const std::string worldName = NameOfForm(world);
		const std::string cellEdid = EditorIdOf(cell);

		out["ok"] = cell != nullptr;
		if (!cell)
			out["msg"] = "You aren't in a loaded cell yet";
		out["interior"] = interior;
		out["cellId"] = cell ? static_cast<std::uint32_t>(cell->GetFormID()) : 0u;
		out["cellEdid"] = cellEdid;
		out["cellName"] = cellName;
		out["worldspaceId"] = world ? static_cast<std::uint32_t>(world->GetFormID()) : 0u;
		out["worldspaceName"] = worldName;
		out["x"] = pos.x;
		out["y"] = pos.y;
		out["z"] = pos.z;
		out["angleZ"] = player->GetAngleZ();
		out["suggested"] = SuggestName(cellName, worldName, cellEdid, pos, interior);
		return Dump(out);
	}

	std::string Recall(const std::string& markJson)
	{
		json out;
		out["ok"] = false;

		const auto j = json::parse(markJson, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			out["msg"] = "Bad mark payload";
			return Dump(out);
		}
		const auto name = j.value("name", std::string("that place"));

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player) {
			out["msg"] = "No player reference";
			return Dump(out);
		}

		auto* cell = ResolveCell(j.value("cellId", 0u), j.value("cellEdid", std::string("")));
		if (!cell) {
			out["msg"] = name + " is unreachable — its cell isn't in this load order any more";
			logger::warn("domains: recall '{}' failed — cell {:08X} / '{}' unresolved", name,
				j.value("cellId", 0u), j.value("cellEdid", std::string("")));
			return Dump(out);
		}

		const RE::NiPoint3 pos{ j.value("x", 0.0f), j.value("y", 0.0f), j.value("z", 0.0f) };

		// Re-aim the marker, then let MoveTo do the actual travel: it copies the
		// target's cell, position and rotation and performs the attach/load the
		// player needs.
		auto* marker = AimRecallMarker(player, cell, pos, j.value("angleZ", 0.0f));
		if (!marker) {
			out["msg"] = "Recall marker unavailable — see HotkeyDeck.log";
			return Dump(out);
		}
		player->MoveTo(marker);

		logger::info("domains: recalled to '{}' (cell {:08X}, {:.0f}/{:.0f}/{:.0f})", name,
			static_cast<std::uint32_t>(cell->GetFormID()), pos.x, pos.y, pos.z);
		out["ok"] = true;
		out["msg"] = "➤ " + name;
		return Dump(out);
	}

	std::string NpcListJson()
	{
		// "nearby loaded" radius — ~113 m. Followers are always included whatever
		// their distance (a follower waiting at home should still be summonable).
		constexpr float       kRadius = 8000.0f;
		constexpr std::size_t kCap = 200;

		json out;
		json arr = json::array();

		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* lists = RE::ProcessLists::GetSingleton();
		if (!player || !lists) {
			logger::warn("domains: NpcList — no player / process lists");
			out["npcs"] = arr;
			return Dump(out);
		}
		const auto ppos = player->GetPosition();

		struct Row
		{
			RE::FormID  id;
			std::string name;
			bool        follower;
			float       dist;
		};
		std::vector<Row>               rows;
		std::unordered_set<RE::FormID> seen;

		auto consider = [&](RE::Actor* actor) {
			if (!actor || actor == player || actor->IsPlayerRef() || actor->IsDead() ||
				!actor->Is3DLoaded())
				return;
			const RE::FormID id = actor->GetFormID();
			if (!seen.insert(id).second)
				return;
			const auto  apos = actor->GetPosition();
			const float dx = apos.x - ppos.x, dy = apos.y - ppos.y, dz = apos.z - ppos.z;
			const float dist = std::sqrt(dx * dx + dy * dy + dz * dz);
			const bool  follower = actor->IsPlayerTeammate();
			if (!follower && dist > kRadius)
				return;
			const char* dn = actor->GetDisplayFullName();
			rows.push_back(Row{ id, (dn && dn[0]) ? dn : "NPC", follower, dist });
		};

		// highActorHandles carries the loaded/high-process actors — the same set
		// npc_actions.cpp scans. Followers are teammates within it, so one pass
		// gathers both the follower roster and the nearby actors.
		for (auto& h : lists->highActorHandles) {
			auto ptr = h.get();
			consider(ptr ? ptr.get() : nullptr);
		}

		// Followers first, then nearest first — stable so equal keys keep list order.
		std::stable_sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) {
			if (a.follower != b.follower)
				return a.follower;
			return a.dist < b.dist;
		});

		for (const auto& r : rows) {
			if (arr.size() >= kCap)
				break;
			char key[16];
			std::snprintf(key, sizeof(key), "0x%08X", static_cast<std::uint32_t>(r.id));
			arr.push_back(json{
				{ "key", key },
				{ "name", r.name },
				{ "follower", r.follower },
				{ "dist", static_cast<int>(r.dist) } });
		}
		out["npcs"] = arr;
		return Dump(out);
	}

	std::string MoveNpcTo(const std::string& npcKey, const std::string& markJson)
	{
		json out;
		out["ok"] = false;
		out["name"] = "";
		out["msg"] = "";

		const auto j = json::parse(markJson, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			out["msg"] = "Bad mark payload";
			return Dump(out);
		}
		const auto name = j.value("name", std::string("that place"));

		// npcKey is the actor REFERENCE FormID as "0x…".
		RE::FormID fid = 0;
		try {
			fid = static_cast<RE::FormID>(std::stoul(npcKey, nullptr, 16));
		} catch (const std::exception&) {
			fid = 0;
		}
		auto* form = fid ? RE::TESForm::LookupByID(fid) : nullptr;
		auto* actor = form ? form->As<RE::Actor>() : nullptr;
		if (!actor || !actor->Is3DLoaded()) {
			out["msg"] = "NPC not found / not loaded";
			logger::warn("domains: MoveNpcTo — actor '{}' not found / not loaded", npcKey);
			return Dump(out);
		}

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player) {
			out["msg"] = "No player reference";
			return Dump(out);
		}

		auto* cell = ResolveCell(j.value("cellId", 0u), j.value("cellEdid", std::string("")));
		if (!cell) {
			out["msg"] = name + " is unreachable — its cell isn't in this load order any more";
			logger::warn("domains: MoveNpcTo '{}' failed — cell {:08X} / '{}' unresolved", name,
				j.value("cellId", 0u), j.value("cellEdid", std::string("")));
			return Dump(out);
		}

		const RE::NiPoint3 pos{ j.value("x", 0.0f), j.value("y", 0.0f), j.value("z", 0.0f) };
		auto* marker = AimRecallMarker(player, cell, pos, j.value("angleZ", 0.0f));
		if (!marker) {
			out["msg"] = "Recall marker unavailable — see HotkeyDeck.log";
			return Dump(out);
		}

		const char*       dn = actor->GetDisplayFullName();
		const std::string dispName = (dn && dn[0]) ? dn : "NPC";
		// Same proven call the player recall uses (MoveTo(TESObjectREFR*)) — the
		// engine builds the handle and performs the cell attach / worldspace
		// transition, so the actor lands correctly in the target cell.
		actor->MoveTo(marker);

		logger::info("domains: moved '{}' ({:08X}) to '{}' (cell {:08X})", dispName,
			static_cast<std::uint32_t>(actor->GetFormID()), name,
			static_cast<std::uint32_t>(cell->GetFormID()));
		out["ok"] = true;
		out["name"] = dispName;
		return Dump(out);
	}
}
