#include "FollowerOrganizer/FollowerOrganizer.hpp"

#include "Utility/LogInfo.hpp"
#include "Utility/Script.hpp"
#include "Utility/TESForm.hpp"

// ============================================================================
//  Follower Deck API — two C exports consumed in-process by the Hotkey Deck
//  plugin (its "Follower Deck" PrismaUI view resolves them via
//  GetModuleHandle("FollowerOrganizer.dll") + GetProcAddress).
//
//  Contract:
//    * MAIN THREAD ONLY — every call touches live game forms and the
//      organizer singleton. The caller schedules through SKSE's task queue.
//    * Returned pointers stay valid until the next call from that thread.
//    * Both calls return the same envelope:
//        { "ok": bool, "msg"?: string, "state": { categories: [...] } }
//      so the view can re-render from every reply, success or failure.
//
//  Category/member addressing matches the singleton's raw layout: category 0
//  is the Master Category (the magic-menu spell list) and is never exposed;
//  real categories are 1..25. Every mutation goes through the same functions
//  the messagebox UI uses (they all SaveSettings() with rotating backups), so
//  the deck and FO's native flows can never drift apart.
//
//  v0.3.0 adds NPC FIELDS: `Member::fields`, a free-form
//  std::map<std::string,std::string> our fork persists under "Fields" in
//  FollowerOrganizer.json (see modding/hotkey-deck/src/npc-fields-wiring.md for
//  the Member.hpp/Member.cpp half). FO's own UI never shows it; the deck's
//  Followers tab and the Deck Portal are the only editors. Two ops write it:
//    setField            {cat, idx, key, value}   — the pane, addressing a row
//    setFieldByOriginal  {original, key, value}   — the portal sidecar, which
//                        only knows a name; hits EVERY entry with that original
//                        name so one person's fields agree in every category.
//
//  v0.3.1 bounds EVERY free-text value, not just the fields: renameMember,
//  setDesc and renameCategory were exempt from TrimField despite writing to the
//  same JSON through the same serializer, and being the ops a remote portal can
//  drive. No export or format change — Hotkey Deck needs no rebuild for this.
// ============================================================================

namespace
{
	using organizer::FollowerOrganizer;

	// No name list here, deliberately.
	//
	// This used to refuse two companions by DISPLAY NAME, because their own
	// follower mods run them and a second controller fights the first. That was
	// one player's roster hardcoded into somebody else's mod: useless to anyone
	// else, and it put those names inside a DLL that is now redistributed (with
	// MaskedRPGFan's permission) to strangers.
	//
	// The check belongs on the CALLER, which can do it properly: Hotkey Deck asks
	// FollowerFrameworks::OwningCompanionSpec whether the actor ships inside a
	// one-companion follower mod — from her defining plugin, not her name — and
	// arms a confirm before it ever calls in here. This side stays a dumb,
	// honest API.
	bool IsGuardedActor(RE::Actor*)
	{
		return false;
	}

	// ------------------------------------------------------------ NPC fields
	// Keys are chosen by the caller (the pane owns the curated spec and can grow
	// it without a DLL rebuild), so this side enforces only what has to hold for
	// a key to survive the C++ -> JSON -> JS -> JSON round trip unchanged.
	constexpr std::size_t kFieldKeyMax = 32;
	constexpr std::size_t kFieldValueMax = 300;

	// [a-z0-9_-]{1,32}. Deliberately strict rather than normalising: the key is
	// a JSON object key compared case-sensitively in three languages, so
	// anything that could differ by case, whitespace or encoding is refused at
	// the door instead of silently becoming a second, near-duplicate field.
	bool ValidFieldKey(const std::string& k)
	{
		if (k.empty() || k.size() > kFieldKeyMax)
			return false;
		for (const unsigned char c : k) {
			const bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
			if (!ok)
				return false;
		}
		return true;
	}

	// Applies to EVERY free-text value that reaches FO's JSON — the NPC fields
	// it was written for, and also the member name, the member description and
	// the category name. Those three used to pass through unbounded, which was
	// an odd exemption: they take the same road into the same file, written by
	// the same serializer, and are the ones a phone portal can drive remotely.
	std::string TrimField(std::string s)
	{
		const auto keep = [](unsigned char c) { return !std::isspace(c); };
		s.erase(s.begin(), std::find_if(s.begin(), s.end(), keep));
		s.erase(std::find_if(s.rbegin(), s.rend(), keep).base(), s.end());
		if (s.size() > kFieldValueMax) {
			// Cut on a UTF-8 boundary. A value can carry multi-byte characters
			// (engine names, the player's own prose) and half a sequence would
			// land invalid bytes in the file FO writes — our dump() replaces
			// them, FO's does not.
			std::size_t cut = kFieldValueMax;
			while (cut > 0 && (static_cast<unsigned char>(s[cut]) & 0xC0) == 0x80)
				--cut;
			s.resize(cut);
			s.erase(std::find_if(s.rbegin(), s.rend(), keep).base(), s.end());
		}
		return s;
	}

	// "" erases the key: a cleared input box is a delete, so an emptied field
	// never lingers in the JSON as a dangling "".  Returns true when the map
	// actually changed, so a no-op edit doesn't churn FO's rotating backups.
	bool SetMemberField(organizer::Member& m, const std::string& key, const std::string& value)
	{
		const auto it = m.fields.find(key);
		if (value.empty()) {
			if (it == m.fields.end())
				return false;
			m.fields.erase(it);
			return true;
		}
		if (it != m.fields.end() && it->second == value)
			return false;
		m.fields[key] = value;
		return true;
	}

	bool IEquals(std::string_view a, std::string_view b)
	{
		if (a.size() != b.size())
			return false;
		for (std::size_t i = 0; i < a.size(); ++i) {
			if (std::tolower(static_cast<unsigned char>(a[i])) !=
				std::tolower(static_cast<unsigned char>(b[i])))
				return false;
		}
		return true;
	}

	json MemberJson(const organizer::Member& m)
	{
		auto* form = m.form;
		auto* refr = form ? form->As<RE::TESObjectREFR>() : nullptr;
		auto* actor = refr ? refr->As<RE::Actor>() : nullptr;
		json j{
			{ "name", m.GetName() },          // live display name (override applied)
			{ "override", m.name },           // stored override ("" = original)
			{ "original", m.original_name },
			{ "desc", m.description },
			// Free-form key->value map; absent keys simply aren't here. The pane
			// renders unknown keys too, so nothing typed can ever disappear.
			{ "fields", m.fields },
			{ "tracked", m.tracked },
			{ "resolved", form != nullptr },
			{ "inWorld", refr != nullptr },
			{ "following", actor ? actor->IsPlayerTeammate() : false },
			{ "dead", actor ? actor->IsDead() : false },
			{ "form", form ? utility::tesform::FormToString(form) : m.base_form_string },
			{ "formId", form ? std::format("0x{:08X}", form->GetFormID()) : "" }
		};
		return j;
	}

	json BuildState()
	{
		auto* o = FollowerOrganizer::GetSingleton();
		json cats = json::array();
		std::size_t total = 0;
		for (std::size_t i = 1; i < o->categories.size(); ++i) {
			const auto& c = o->categories[i];
			json members = json::array();
			for (const auto& m : c.members)
				members.push_back(MemberJson(m));
			total += c.members.size();
			cats.push_back(json{
				{ "index", static_cast<int>(i) },
				{ "name", c.GetCategoryName() },  // current applied spell name
				{ "override", c.name },
				{ "original", c.original_name },
				{ "hotkey", c.hotkey },
				{ "inMagicMenu", c.in_magic_menu },
				{ "members", std::move(members) } });
		}
		return json{ { "categories", std::move(cats) }, { "total", total } };
	}

	// Location snapshot before any deck-initiated teleport, into the SAME map
	// FO's own SendBack uses — either UI can undo the other's move.
	void SnapshotLocation(FollowerOrganizer* o, RE::TESObjectREFR* refr)
	{
		if (!refr)
			return;
		FollowerOrganizer::LocationSnapshot snap;
		snap.cell = refr->GetParentCell();
		snap.worldspace = refr->GetWorldspace();
		snap.position = refr->GetPosition();
		snap.rotation = RE::NiPoint3{ refr->GetAngleX(), refr->GetAngleY(), refr->GetAngleZ() };
		snap.valid = (snap.cell != nullptr);
		if (snap.valid)
			o->location_snapshots[refr->GetFormID()] = snap;
	}

	struct Target
	{
		organizer::Category* cat = nullptr;
		organizer::Member*   member = nullptr;
		std::string          err;
	};

	Target Resolve(FollowerOrganizer* o, int cat, int idx)
	{
		Target t;
		if (cat < 1 || cat >= static_cast<int>(o->categories.size())) {
			t.err = "Category index out of range.";
			return t;
		}
		auto& c = o->categories[cat];
		if (idx < 0 || idx >= static_cast<int>(c.members.size())) {
			t.err = "Follower index out of range — reopen the deck.";
			return t;
		}
		t.cat = &c;
		t.member = &c.members[idx];
		return t;
	}

	// The LIVE actor for a base NPC, if the game currently has one loaded.
	//
	// WHY THIS EXISTS: a follower entry stores whatever reference FO was handed
	// when she was added, and for a mod-added follower that is routinely the
	// instance the MOD PLACED in the world — not the one walking behind you.
	// Travelling to it then lands you where she originally stood: reported
	// 2026-08-02, "Go to" on Willow (0x000011~WillowFollower.esp) put the player
	// in an inn while she was in another cell entirely.
	//
	// So for anything PHYSICAL, prefer the actor the game is actually simulating.
	// A player teammate wins outright — that is her, by definition, and it also
	// settles the case of a mod that keeps several placed copies of the same
	// base around.
	RE::Actor* LiveActorFor(RE::TESBoundObject* base)
	{
		if (!base)
			return nullptr;
		auto* pl = RE::ProcessLists::GetSingleton();
		if (!pl)
			return nullptr;

		RE::Actor* loaded = nullptr;
		// High actors only: those are the ones with full AI running, which is
		// exactly the set that can be "where she is" in any meaningful sense.
		// The handle is held in a named NiPointer for the body of the loop —
		// dereferencing the temporary from h.get() would drop the reference
		// before the pointer is used.
		for (auto& h : pl->highActorHandles) {
			auto a = h.get();
			if (!a || a->IsDisabled() || a->GetBaseObject() != base)
				continue;
			if (a->IsPlayerTeammate())
				return a.get();    // unambiguous: this is the one following you
			if (!loaded)
				loaded = a.get();  // remember the first, keep looking for a teammate
		}
		return loaded;
	}

	// A world op needs a real reference this session, not a base-form fallback.
	//
	// `physical` asks for the actor the game is simulating rather than the stored
	// reference. Administrative ops (rename, notes, category moves) must NOT set
	// it: those address the ENTRY, and silently retargeting them at a different
	// instance would edit the wrong row.
	RE::TESObjectREFR* WorldRefr(const Target& t, std::string& err, bool physical = false)
	{
		if (!t.member->form) {
			err = "This follower's plugin isn't loaded — can't reach them.";
			return nullptr;
		}
		auto* refr = t.member->form->As<RE::TESObjectREFR>();
		if (!refr) {
			err = "Only their base record resolved this session — they aren't placed in the world yet.";
			return nullptr;
		}
		if (physical) {
			// Only ever an UPGRADE: if nothing live matches we keep the stored
			// reference, so a follower who is unloaded still behaves as before
			// rather than becoming unreachable.
			if (auto* live = LiveActorFor(refr->GetBaseObject()); live && live != refr) {
				// logger::info, not the header's DebugMessage: that one is gated on
				// debug_mode AND raises an on-screen notification, and this line is
				// diagnostic - it wants to be in the log every time, silently.
				logger::info("deck: {} -> live actor {:08X} (stored ref {:08X} is a different instance)",
					t.member->GetName(), live->GetFormID(), refr->GetFormID());
				return live;
			}
		}
		return refr;
	}

	std::string Apply(const json& cmd)
	{
		auto* o = FollowerOrganizer::GetSingleton();
		const auto op = cmd.value("op", std::string(""));
		const int  cat = cmd.value("cat", -1);
		const int  idx = cmd.value("idx", -1);

		if (op == "renameCategory") {
			if (cat < 1 || cat >= static_cast<int>(o->categories.size()))
				return "Category index out of range.";
			// "" restores the original name (Category::ApplyName falls back);
			// TrimField leaves "" alone, so the reset still works.
			o->SetCategoryOverrideName(cat, TrimField(cmd.value("name", std::string(""))));
			return "";
		}
		if (op == "setMagicMenu") {
			if (cat < 1 || cat >= static_cast<int>(o->categories.size()))
				return "Category index out of range.";
			o->SetCategoryInMagicMenuState(cat, cmd.value("on", false));
			o->SaveSettings();  // FO's setter applies but doesn't persist
			return "";
		}
		if (op == "addMember") {
			if (cat < 1 || cat >= static_cast<int>(o->categories.size()))
				return "Category index out of range.";
			const auto formId = cmd.value("formId", 0u);
			auto* form = formId ? RE::TESForm::LookupByID(formId) : nullptr;
			auto* refr = form ? form->As<RE::TESObjectREFR>() : nullptr;
			auto* actor = refr ? refr->As<RE::Actor>() : nullptr;
			if (!actor)
				return "No NPC to add — look at them, then open the deck.";
			if (actor->IsPlayerRef())
				return "That's you.";
			if (IsGuardedActor(actor))
				return std::string(actor->GetDisplayFullName()) + " keeps their own counsel — they can't be organized.";
			auto& c = o->categories[cat];
			const std::string name = actor->GetName();
			if (c.Has(actor->As<RE::TESForm>()))
				return name + " is already in " + c.GetCategoryName() + ".";
			c.members.emplace_back(actor->As<RE::TESForm>(), name);
			o->org_names[utility::tesform::FormToString(actor->As<RE::TESForm>())] = name;
			o->SaveSettings();
			return "";
		}

		// Set one NPC field on EVERY entry whose original name matches. The Deck
		// Portal writes its sidecar from FollowerOrganizer.json, where a person
		// is identified by name and nothing else — no cat/idx, because both
		// shift the moment anything is reordered in-game. Fields are per-member-
		// ENTRY in FO's model, so the same person filed in two categories has
		// two maps; hitting all of them is what keeps them from disagreeing.
		if (op == "setFieldByOriginal") {
			const auto key = cmd.value("key", std::string(""));
			if (!ValidFieldKey(key))
				return "Bad field key — a-z, 0-9, _ and - only (max 32 characters).";
			const auto who = TrimField(cmd.value("original", std::string("")));
			if (who.empty())
				return "No follower named in the request.";
			const auto value = TrimField(cmd.value("value", std::string("")));
			int        hits = 0;
			bool       changed = false;
			for (std::size_t i = 1; i < o->categories.size(); ++i) {
				for (auto& m : o->categories[i].members) {
					if (!IEquals(m.original_name, who))
						continue;
					++hits;
					// No short-circuit: every matching entry must be written.
					if (SetMemberField(m, key, value))
						changed = true;
				}
			}
			if (!hits)
				return "No follower named \"" + who + "\" is in the organizer.";
			if (changed)
				o->SaveSettings();
			return "";
		}

		// Everything below addresses one existing member.
		auto t = Resolve(o, cat, idx);
		if (!t.err.empty())
			return t.err;

		if (op == "renameMember") {
			// "" restores the original name (Member::ApplyName falls back);
			// TrimField leaves "" alone, so the reset still works.
			o->SetMemberOverrideName(cat, idx, TrimField(cmd.value("name", std::string(""))));
			return "";
		}
		if (op == "setDesc") {
			o->SetCategoryMemberDescription(cat, idx, TrimField(cmd.value("desc", std::string(""))));
			return "";
		}
		if (op == "setField") {
			const auto key = cmd.value("key", std::string(""));
			if (!ValidFieldKey(key))
				return "Bad field key — a-z, 0-9, _ and - only (max 32 characters).";
			// FO has no setter for our own map (it predates the field), so this
			// is a direct mutation + the same SaveSettings() every FO setter
			// ends with — identical persistence, rotating backups included.
			if (SetMemberField(*t.member, key, TrimField(cmd.value("value", std::string("")))))
				o->SaveSettings();
			return "";
		}
		if (op == "deleteMember") {
			o->DeleteMemberFromCategory(cat, idx);
			return "";
		}
		if (op == "moveMember") {
			const int to = cmd.value("to", -1);
			if (to < 1 || to >= static_cast<int>(o->categories.size()))
				return "Target category out of range.";
			if (to == cat)
				return "";
			o->MoveMemberFromCategoryToCategory(cat, to, idx);
			return "";
		}
		if (op == "reorderMember") {
			// Same splice semantics as the view's moveInArray(from, to).
			auto& ms = t.cat->members;
			int   to = cmd.value("to", -1);
			if (to < 0)
				return "Bad reorder target.";
			auto m = ms[idx];
			ms.erase(ms.begin() + idx);
			if (to > idx)
				--to;
			to = std::clamp(to, 0, static_cast<int>(ms.size()));
			ms.insert(ms.begin() + to, m);
			o->SaveSettings();
			return "";
		}
		if (op == "setTracked") {
			o->SetTrackingStatus(cat, idx, cmd.value("on", false));
			// Mirror Category::ApplyTracking — the Papyrus side owns the
			// tracking quest's alias refresh.
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			utility::script::DispatchStaticCall("FollowerOrganizer", "RefreshTracking", cb, cat);
			return "";
		}

		// ---- world ops (the caller closes its palette first) ----
		std::string err;
		// summon / goto / sendback all MOVE somebody, so they want the live actor.
		auto*       refr = WorldRefr(t, err, /*physical*/ true);
		if (!refr)
			return err;
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return "No player reference.";

		if (op == "summon") {  // NPC -> player (FO action CallToMe)
			SnapshotLocation(o, refr);
			refr->MoveTo(player);
			return "";
		}
		if (op == "goto") {  // player -> NPC (FO action MoveTo)
			SnapshotLocation(o, refr);
			player->MoveTo(refr);
			if (auto* actor = refr->As<RE::Actor>())
				actor->EvaluatePackage();  // don't leave them attached to the player
			return "";
		}
		if (op == "sendback") {  // undo a summon — same snapshots FO's SendBack uses
			const auto it = o->location_snapshots.find(refr->GetFormID());
			if (it == o->location_snapshots.end() || !it->second.valid)
				return "No remembered spot for " + t.member->GetName() + " — nothing to send back to.";
			const auto& snap = it->second;
			if (snap.cell)
				refr->SetParentCell(snap.cell);
			refr->SetPosition(snap.position);
			refr->SetAngle(snap.rotation);
			refr->Update3DPosition(true);
			if (auto* actor = refr->As<RE::Actor>())
				actor->EvaluatePackage();
			return "";
		}

		return "Unknown deck op: " + op;
	}

	thread_local std::string g_deckBuf;

	const char* Envelope(bool ok, const std::string& msg)
	{
		json j{ { "ok", ok } };
		if (!msg.empty())
			j["msg"] = msg;
		j["state"] = BuildState();
		// Engine strings can carry cp1252 bytes — never let dump() throw.
		g_deckBuf = j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		return g_deckBuf.c_str();
	}
}

extern "C" DLLEXPORT const char* FollowerDeck_GetState()
{
	return Envelope(true, "");
}

extern "C" DLLEXPORT const char* FollowerDeck_Apply(const char* a_cmd)
{
	json cmd = json::parse(a_cmd ? a_cmd : "", nullptr, false);
	if (cmd.is_discarded() || !cmd.is_object())
		return Envelope(false, "Bad deck command payload.");
	try {
		const auto err = Apply(cmd);
		if (!err.empty())
			logger::warn("FollowerDeck_Apply '{}' -> {}", cmd.value("op", std::string("?")), err);
		return Envelope(err.empty(), err);
	} catch (const std::exception& ex) {
		logger::error("FollowerDeck_Apply threw: {}", ex.what());
		return Envelope(false, "Deck op failed — see FollowerOrganizer log.");
	}
}
