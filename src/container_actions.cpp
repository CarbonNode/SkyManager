#include "container_actions.h"

#include <cmath>
#include <cstdio>
#include <string>

// pch (force-included) provides RE::/SKSE::/json and `using namespace std::literals`.

using json = nlohmann::json;

namespace ContainerActions
{
	namespace
	{
		// Vanilla XMarker (Skyrim.esm 0x0000003B) — the inert static every MoveTo
		// aims at. Same choice, and same reasoning, as PlaceActions: MoveTo is the
		// only move that runs the engine's cell attach, and it needs a reference to
		// aim at, so one marker is placed lazily and re-aimed. Session-scoped: a raw
		// FormID kept across saves would be a dynamic id the engine remaps.
		constexpr RE::FormID kXMarker = 0x0000003B;

		// ContainerMenu::ContainerMode::kLoot — the ordinary "Take / Store / Take
		// All" transfer view a chest opens with. Cast to the int OpenContainer wants.
		constexpr std::int32_t kOpenLoot = 0;

		// --- crosshair capture ------------------------------------------------
		// The reference under the crosshair, refreshed on every event. Read at
		// palette open by SnapshotTarget(); frozen there because the palette pauses
		// the game. Same idiom as NpcActions' CrosshairSink.
		RE::FormID g_crossRef = 0;
		std::string g_targetJson;  // built by SnapshotTarget, handed out by TargetJson

		// --- summon / return state (main thread only) -------------------------
		RE::FormID g_marker = 0;      // our recall marker, placed on first summon
		RE::FormID g_summonRef = 0;   // container currently moved to the player (0 = none)
		bool       g_menuArmed = false;

		// Where a summoned container must be moved back to — its own home, captured
		// on the mark and carried through OpenContainer().
		struct Home
		{
			std::uint32_t cellId = 0;
			std::string   cellEdid;
			RE::NiPoint3  pos{};
			float         angle = 0.0f;
		};
		Home g_summonHome;

		std::string Dump(const json& j)
		{
			// Engine strings can carry cp1252 bytes; dump() must never throw on the
			// way into an Invoke.
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// A ref is an openable container when its BASE form carries a container
		// (chests, barrels, urns, sacks, dressers — TESObjectCONT). Actors and dead
		// bodies return null here on purpose: they are looted through a different
		// path and are not what "mark a container" means.
		bool IsContainer(RE::TESObjectREFR* ref)
		{
			return ref && ref->GetContainer() != nullptr;
		}

		// Display name of any form: its FULL name when it has one, else its editor
		// id. As<TESFullName>() is a null-returning RTTI cast, so a form type without
		// the mixin costs nothing. Copy of PlaceActions::NameOfForm — cells and
		// worldspaces carry their names through TESFullName, not a plain GetName().
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

		std::string PluginOf(RE::TESForm* form)
		{
			auto* file = form ? form->GetFile(0) : nullptr;
			if (!file)
				return "";
			const auto name = file->GetFilename();
			return std::string(name);
		}

		// FormID first, editor id as the fallback — interior cells keep their editor
		// ids at runtime, which survives a plugin being re-indexed. Identical to
		// PlaceActions::ResolveCell.
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

		// Re-resolve a marked container from its durable (plugin, localId) identity.
		// TESDataHandler::LookupForm remaps the local id through the CURRENT load
		// order (ESL-aware), so the runtime FormID it hands back is correct even
		// after the plugin moved. Returns nullptr for a ref whose plugin is gone or
		// whose form is no longer a reference.
		RE::TESObjectREFR* ResolveRef(const std::string& plugin, std::uint32_t localId)
		{
			if (plugin.empty() || !localId)
				return nullptr;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return nullptr;
			auto* form = dh->LookupForm(localId, plugin);
			if (!form || form->GetFormType() != RE::FormType::Reference)
				return nullptr;
			return static_cast<RE::TESObjectREFR*>(form);
		}

		// The session's summon marker, created on demand (forcePersist so it
		// survives its cell unloading). Copy of PlaceActions::EnsureMarker.
		RE::TESObjectREFR* EnsureMarker(RE::PlayerCharacter* player)
		{
			if (g_marker) {
				if (auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(g_marker))
					return ref;
				g_marker = 0;  // save reloaded under us — place a fresh one
			}
			auto* base = RE::TESForm::LookupByID<RE::TESBoundObject>(kXMarker);
			if (!base) {
				logger::error("containers: XMarker {:08X} missing — Skyrim.esm not loaded?", kXMarker);
				return nullptr;
			}
			auto ptr = player->PlaceObjectAtMe(base, true);
			if (!ptr) {
				logger::error("containers: PlaceObjectAtMe(XMarker) returned null");
				return nullptr;
			}
			g_marker = ptr->GetFormID();
			logger::info("containers: summon marker placed ({:08X})", g_marker);
			return ptr.get();
		}

		// Aim the single marker at a cell + position + Z angle, ready for MoveTo.
		RE::TESObjectREFR* AimMarker(RE::PlayerCharacter* player, RE::TESObjectCELL* cell,
			const RE::NiPoint3& pos, float angleZ)
		{
			auto* marker = EnsureMarker(player);
			if (!marker)
				return nullptr;
			marker->SetParentCell(cell);
			marker->SetPosition(pos);
			marker->SetAngle(RE::NiPoint3{ 0.0f, 0.0f, angleZ });
			marker->Update3DPosition(true);
			return marker;
		}

		// Move a summoned container back to exactly where it stood, then disarm.
		// Called when the ContainerMenu closes on it (MenuSink) — the whole reason
		// the summon is invisible: the chest is at the player only while the transfer
		// UI is up, and it is back home the instant the menu drops.
		void ReturnSummoned()
		{
			const RE::FormID rid = g_summonRef;
			g_summonRef = 0;
			g_menuArmed = false;
			if (!rid)
				return;

			auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(rid);
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!ref || !player)
				return;

			auto* cell = ResolveCell(g_summonHome.cellId, g_summonHome.cellEdid);
			if (!cell) {
				// Home cell unresolvable (its plugin left the order mid-session). Rare;
				// leaving the chest at the player beats crashing, and it is still fully
				// usable — just no longer where it was.
				logger::warn("containers: summoned {:08X} has no home cell to return to", rid);
				return;
			}
			auto* marker = AimMarker(player, cell, g_summonHome.pos, g_summonHome.angle);
			if (marker) {
				ref->MoveTo(marker);
				logger::info("containers: returned {:08X} home (cell {:08X})", rid,
					static_cast<std::uint32_t>(cell->GetFormID()));
			}
		}

		// --- sinks ------------------------------------------------------------
		class CrosshairSink : public RE::BSTEventSink<SKSE::CrosshairRefEvent>
		{
		public:
			RE::BSEventNotifyControl ProcessEvent(const SKSE::CrosshairRefEvent* ev,
				RE::BSTEventSource<SKSE::CrosshairRefEvent>*) override
			{
				auto* ref = (ev && ev->crosshairRef) ? ev->crosshairRef.get() : nullptr;
				g_crossRef = ref ? ref->GetFormID() : 0;
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		// Watches for the summoned container's transfer menu closing, then sends it
		// home. Deliberately narrow: it acts only while a summon is armed and only on
		// a ContainerMenu CLOSE, so it is inert the rest of the time.
		class MenuSink : public RE::BSTEventSink<RE::MenuOpenCloseEvent>
		{
		public:
			RE::BSEventNotifyControl ProcessEvent(const RE::MenuOpenCloseEvent* ev,
				RE::BSTEventSource<RE::MenuOpenCloseEvent>*) override
			{
				if (ev && !ev->opening && g_menuArmed &&
					ev->menuName == RE::ContainerMenu::MENU_NAME) {
					ReturnSummoned();
				}
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		CrosshairSink g_crossSink;
		MenuSink      g_menuSink;
	}

	void Init()
	{
		g_marker = 0;
		g_summonRef = 0;
		g_menuArmed = false;
		g_crossRef = 0;
		g_targetJson.clear();

		if (auto* src = SKSE::GetCrosshairRefEventSource())
			src->AddEventSink(&g_crossSink);
		if (auto* ui = RE::UI::GetSingleton())
			ui->AddEventSink<RE::MenuOpenCloseEvent>(&g_menuSink);

		if (RE::TESForm::LookupByID(kXMarker))
			logger::info("ContainerActions: XMarker resolved — remote open available");
		else
			logger::warn("ContainerActions: XMarker {:08X} not found — summon will refuse", kXMarker);
	}

	void SnapshotTarget()
	{
		json out;
		out["ok"] = true;
		out["found"] = false;

		auto* ref = g_crossRef ? RE::TESForm::LookupByID<RE::TESObjectREFR>(g_crossRef) : nullptr;
		if (!IsContainer(ref)) {
			out["msg"] = "Look at a container, then open the deck";
			g_targetJson = Dump(out);
			return;
		}

		const RE::FormID formId = ref->GetFormID();
		// A dynamic reference (0xFF……) has no plugin identity to persist — the
		// engine mints and remaps it per session, so a stored one would resolve to
		// something unrelated on the next load. Refuse it honestly.
		if ((formId & 0xFF000000u) == 0xFF000000u) {
			out["msg"] = "That container is temporary and can't be marked";
			g_targetJson = Dump(out);
			return;
		}

		const std::string plugin = PluginOf(ref);
		const std::uint32_t localId = ref->GetLocalFormID();
		if (plugin.empty() || !localId) {
			out["msg"] = "That container has no stable identity to mark";
			g_targetJson = Dump(out);
			return;
		}

		auto*       cell = ref->GetParentCell();
		auto*       world = ref->GetWorldspace();
		const auto  pos = ref->GetPosition();
		const char* dn = ref->GetDisplayFullName();

		out["found"] = true;
		out["name"] = (dn && dn[0]) ? dn : "Container";
		out["plugin"] = plugin;
		out["localId"] = localId;
		out["formId"] = static_cast<std::uint32_t>(formId);
		out["cellId"] = cell ? static_cast<std::uint32_t>(cell->GetFormID()) : 0u;
		out["cellEdid"] = (cell && cell->GetFormEditorID()) ? cell->GetFormEditorID() : "";
		out["cellName"] = NameOfForm(cell);
		out["worldspaceId"] = world ? static_cast<std::uint32_t>(world->GetFormID()) : 0u;
		out["worldspaceName"] = NameOfForm(world);
		out["interior"] = world == nullptr;
		out["x"] = pos.x;
		out["y"] = pos.y;
		out["z"] = pos.z;
		out["angleZ"] = ref->GetAngleZ();
		g_targetJson = Dump(out);
	}

	std::string TargetJson()
	{
		if (g_targetJson.empty()) {
			json out{ { "ok", true }, { "found", false },
				{ "msg", "Look at a container, then open the deck" } };
			return Dump(out);
		}
		return g_targetJson;
	}

	bool HasTarget()
	{
		if (g_targetJson.empty())
			return false;
		const auto j = json::parse(g_targetJson, nullptr, false);
		return j.is_object() && j.value("found", false);
	}

	std::string OpenContainer(const std::string& markJson)
	{
		json out;
		out["ok"] = false;

		const auto j = json::parse(markJson, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			out["msg"] = "Bad container payload";
			return Dump(out);
		}
		const auto name = j.value("name", std::string("that container"));
		const auto plugin = j.value("plugin", std::string(""));
		const auto localId = j.value("localId", 0u);

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player) {
			out["msg"] = "No player reference";
			return Dump(out);
		}

		auto* ref = ResolveRef(plugin, localId);
		if (!ref) {
			out["msg"] = name + " is gone — its plugin isn't in this load order any more";
			logger::warn("containers: open '{}' failed — {} / {:06X} unresolved", name, plugin, localId);
			return Dump(out);
		}
		if (!IsContainer(ref)) {
			out["msg"] = name + " is no longer a container";
			return Dump(out);
		}

		// Home the return trip aims at — captured on the mark, so a summon lands the
		// chest back exactly where it was even if the player has since walked away.
		g_summonHome.cellId = j.value("cellId", 0u);
		g_summonHome.cellEdid = j.value("cellEdid", std::string(""));
		g_summonHome.pos = RE::NiPoint3{ j.value("x", 0.0f), j.value("y", 0.0f), j.value("z", 0.0f) };
		g_summonHome.angle = j.value("angleZ", 0.0f);

		// Attempt A — open it exactly where it stands. InitInventoryIfRequired makes
		// the container resolve its contents without needing the player next to it;
		// OpenContainer raises the transfer menu. When the ref's cell is loaded (the
		// player is home, standing by the chest) this is the whole story — no move.
		ref->InitInventoryIfRequired();
		ref->OpenContainer(kOpenLoot);

		// Attempt B — one frame later, if no menu came up (the ref's cell wasn't
		// loaded, so the in-place open had nothing to attach to), SUMMON it: move it
		// to the player, open it there, and let MenuSink send it home on close.
		const RE::FormID rid = ref->GetFormID();
		SKSE::GetTaskInterface()->AddTask([rid]() {
			auto* ui = RE::UI::GetSingleton();
			if (ui && ui->IsMenuOpen(RE::ContainerMenu::MENU_NAME))
				return;  // Attempt A worked — nothing to do
			auto* r = RE::TESForm::LookupByID<RE::TESObjectREFR>(rid);
			auto* pl = RE::PlayerCharacter::GetSingleton();
			if (!r || !pl)
				return;
			// Bring it to the player, arm the return, then open on the NEXT frame so
			// the engine has attached its 3D at the new spot before we raise the menu.
			r->MoveTo(pl);
			g_summonRef = rid;
			g_menuArmed = true;
			SKSE::GetTaskInterface()->AddTask([rid]() {
				auto* r2 = RE::TESForm::LookupByID<RE::TESObjectREFR>(rid);
				if (!r2)
					return;
				r2->InitInventoryIfRequired();
				r2->OpenContainer(kOpenLoot);
			});
			logger::info("containers: summoned {:08X} to the player for remote open", rid);
		});

		out["ok"] = true;
		out["msg"] = "\xE2\x87\x84 " + name;  // "⇄ <name>"
		return Dump(out);
	}
}
