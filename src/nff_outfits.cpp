#include "nff_outfits.h"

#include "actor_identity.h"
#include "wardrobe.h"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp, the logger and
// std::literals.

// wingdi.h (via Windows.h) #defines GetObject to GetObjectA, so
// `variable->GetObject()` fails to resolve. RE/V/Variable.h undefines it for
// its own declaration but Windows.h comes back afterwards. Same fix as
// nff_bridge.cpp.
#ifdef GetObject
#	undef GetObject
#endif

using json = nlohmann::json;

namespace NffOutfits
{
	namespace
	{
		// ---- the mod-event protocol to HD_WardrobeExec.psc ----
		//
		// ONE event, and its three fields are chosen so the Papyrus side needs no
		// parsing, no string splitting and no new ESP master:
		//
		//   strArg  the whole operation as a literal: "wear0".."wear3",
		//           "build0".."build2", "clear0".."clear3", "satchel". Twelve
		//           exact string compares beats hex-parsing in Papyrus.
		//   numArg  the LOCAL FormID of NFF's outfit quest. A float32 has a
		//           24-bit mantissa and an ESP-local id is <= 0xFFFFFF, so this
		//           round-trips EXACTLY — which is the whole reason the actor
		//           cannot travel this way and rides on `sender` instead.
		//           The executor turns it back into the quest with
		//           Game.GetFormFromFile(id, "nwsFollowerFramework.esp") and
		//           casts it to nwsFollowerSetsScript, so no master is needed and
		//           the plugin never has to hardcode a FormID it cannot verify.
		//   sender  the Actor.
		constexpr auto kEvOp = "HD_NFF_Op";

		// nwsFollowerSetsScript is the quest script that owns NFF's whole outfit
		// system. Class name as declared in the decompiled .pex on this rig.
		constexpr const char* kSetsScript = "nwsFollowerSetsScript";

		// ---- combat gear (helmet / shield / weapon / ammo) ------------------
		//
		// A SECOND event, deliberately, rather than more HD_NFF_Op literals: the
		// gear switches need no quest id at all (the executor finds her alias
		// from the ACTOR), so folding them into an op whose numArg MUST carry a
		// quest local id would have meant sending a number the handler ignores
		// and inviting the next reader to think it matters.
		//
		//   strArg  "helmOff" | "helmCombat" | "helmNever"
		//           "shieldOn"/"shieldOff" | "weaponOn"/"weaponOff"
		//           "ammoOn"/"ammoOff"        — ABSOLUTE states, never toggles
		//   sender  the Actor
		constexpr auto kEvGear = "HD_NFF_Gear";

		// NFF keeps the four gear FACTIONS (and a good deal else) as properties
		// on this quest script. It is the read side of the same switches the
		// executor writes — and the reason the deck can render a tri-state
		// helmet control instead of a button that only fires blind.
		constexpr const char* kVarScript = "nwsFollowerVariableScript";

		// NFF's own ceiling: CheckInvalidOutfits sets storedMax = 128 and frees
		// any slot at or past it. Used only to sanity-bound a rank we did not
		// write — a garbage rank must not index a form list.
		constexpr int kMaxSlots = 128;

		// ---- one-shot log noise control ----
		bool g_warnedNoVm  = false;
		bool g_warnedNoNff = false;
		bool g_loggedOk    = false;

		// The quest form is static for the run of the game, so the scan that
		// finds it is cached. The bound script OBJECT deliberately is not: a save
		// load rebinds it and a stale smart pointer is exactly the kind of thing
		// that turns into a crash.
		RE::TESQuest* g_setsQuest = nullptr;
		bool          g_scanned   = false;

		// Same deal for NFF's shared form holder. Found in the SAME quest sweep
		// (see ScanSetsQuest) rather than a second pass over ~4,000 quests.
		RE::TESQuest* g_varQuest    = nullptr;
		bool          g_loggedVarOk = false;

		// ------------------------------------------------------------ small --

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		std::string Trim(std::string s)
		{
			const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
			s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
			s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
			return s;
		}

		std::string Cap(std::string s, std::size_t n)
		{
			if (s.size() > n)
				s.resize(n);
			return s;
		}

		std::string HexOf(std::uint32_t v) { return ActorIdentity::HexOf(v); }

		std::uint32_t ParseHex(const std::string& s) { return ActorIdentity::ParseHex(s); }

		// THE identity. Not string equality on formId: FO hands us a RUNTIME
		// FormID and no plugin, so the same person arrives spelled differently
		// depending on which load order last filed her. See actor_identity.h —
		// on 2026-08-02 that split Elana Darkfire into two rows, one of which
		// could never resolve.
		std::string ActorKey(const std::string& formId, const std::string& plugin)
		{
			return ActorIdentity::Key(formId, plugin);
		}

		// Engine strings can carry cp1252 bytes; dump() must never throw on the
		// way into a PrismaUI Invoke.
		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// EVERY refusal is logged. The success path here has always logged
		// ("nff-outfits: copied …"), so its ABSENCE from HotkeyDeck.log was the
		// only evidence that a wardrobe copy had been refused — and the log
		// could not say which of the eight Fail branches it was, or for whom.
		// A refusal is a user-visible event; it belongs in the log.
		std::string Fail(const std::string& msg)
		{
			logger::warn("nff-outfits: refused - {}", msg);
			return Dump(json{ { "ok", false }, { "msg", msg } });
		}

		// The same, with the person named. Used everywhere the request carries
		// an identity, so a stale/unresolvable id is legible AT THE MOMENT it
		// refuses instead of being guessed at afterwards from hotkeys.json.
		std::string FailFor(const std::string& msg, const std::string& formId,
			const std::string& plugin, const char* op)
		{
			logger::warn("nff-outfits: {} refused for {}|{} (key {}) - {}", op,
				formId.empty() ? "?" : formId, plugin.empty() ? "(no plugin)" : plugin,
				ActorIdentity::Key(formId, plugin), msg);
			return Dump(json{ { "ok", false }, { "msg", msg } });
		}

		std::string Ok(const std::string& msg)
		{
			return Dump(json{ { "ok", true }, { "msg", msg } });
		}

		void Notify(const std::string& m) { RE::DebugNotification(m.c_str()); }

		// The ESP-local id of NFF's outfit quest, or 0 if it is not resolvable.
		// ESL-safe, and null-file-safe: see the ⛔ block in actor_identity.h.
		std::uint32_t SetsQuestLocalId()
		{
			return ActorIdentity::LocalIdOf(g_setsQuest);
		}

		// Fire one operation at the executor. Returns false when there is nothing
		// to fire at — a missing event source or an unresolvable quest — so the
		// caller reports that instead of claiming success.
		bool SendOp(const char* op, RE::Actor* actor)
		{
			auto* src = SKSE::GetModCallbackEventSource();
			if (!src) {
				logger::warn("nff-outfits: no mod callback event source");
				return false;
			}
			const auto local = SetsQuestLocalId();
			if (!local) {
				logger::warn("nff-outfits: NFF's outfit quest has no local id — cannot address the executor");
				return false;
			}
			SKSE::ModCallbackEvent ev{ kEvOp, op, static_cast<float>(local), actor };
			src->SendEvent(&ev);
			logger::info("nff-outfits: sent {} for {:08X} (quest local {:06X})", op,
				actor ? static_cast<std::uint32_t>(actor->GetFormID()) : 0u, local);
			return true;
		}

		// The gear twin of SendOp. No quest id: HD_NFF_Gear finds her alias from
		// the actor itself, so numArg is genuinely unused and passed as 0 rather
		// than as a number that looks meaningful.
		bool SendGear(const char* op, RE::Actor* actor)
		{
			auto* src = SKSE::GetModCallbackEventSource();
			if (!src) {
				logger::warn("nff-gear: no mod callback event source");
				return false;
			}
			if (!actor)
				return false;
			SKSE::ModCallbackEvent ev{ kEvGear, op, 0.0f, actor };
			src->SendEvent(&ev);
			logger::info("nff-gear: sent {} for {:08X}", op,
				static_cast<std::uint32_t>(actor->GetFormID()));
			return true;
		}

		// "wear" + 2 -> "wear2". Kept as literals so the Papyrus side is a plain
		// string compare rather than a parser.
		std::string OpName(const char* verb, int type)
		{
			return std::string(verb) + std::to_string(type);
		}

		// One implementation, shared with the Wardrobe side. The private copy
		// this replaced fed a FULL runtime id straight to LookupForm alongside a
		// plugin, which cannot work — LookupFormID ADDS the file's prefix rather
		// than masking (actor_identity.h has the trap in full).
		RE::Actor* ResolveActor(const std::string& formId, const std::string& plugin)
		{
			return ActorIdentity::ResolveActor(formId, plugin);
		}

		// ------------------------------------------------------------ VM ------
		// Read-only Papyrus PROPERTY access — the same technique nff_bridge.cpp
		// uses and for the same reason: we bind the quest's script object and
		// read its variables synchronously. No Papyrus FUNCTION is ever invoked
		// from here.
		//
		// Deliberately a private copy rather than a shared helper: nff_bridge.cpp
		// is owned by the MHiYH work and this file must be able to land without
		// touching it.

		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

		// Papyrus is case-insensitive and different toolchains register the type
		// under different casings, so one spelling is not a safe bet for a lookup
		// whose failure mode is "the feature silently does not exist".
		RE::BSTSmartPointer<RE::BSScript::Object> BindScript(RE::TESForm* form, const char* cls)
		{
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			auto*                                     vm = Vm();
			if (!form || !cls || !vm)
				return obj;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return obj;
			const auto handle = policy->GetHandleForObject(form->GetFormType(), form);
			if (handle == policy->EmptyHandle())
				return obj;
			if (vm->FindBoundObject(handle, cls, obj) && obj)
				return obj;
			obj.reset();
			const auto lower = Lower(cls);
			if (lower != cls && vm->FindBoundObject(handle, lower.c_str(), obj) && obj)
				return obj;
			obj.reset();
			return obj;
		}

		// GetProperty() is the documented route for an `Auto` property; the
		// "::name_var" form is the raw backing variable and covers a build where
		// the property-table lookup misses.
		const RE::BSScript::Variable* Prop(RE::BSScript::Object* obj, const char* name)
		{
			if (!obj || !name)
				return nullptr;
			if (const auto* v = obj->GetProperty(name))
				return v;
			const std::string backing = "::"s + name + "_var";
			return obj->GetVariable(backing);
		}

		// Every accessor gates on the variable's own type flag first: Get*()
		// reinterprets a union, and in a release build (asserts gone) the wrong
		// one reads garbage as a pointer.
		RE::TESForm* VarForm(const RE::BSScript::Variable* v, RE::FormType type)
		{
			if (!v || !v->IsObject() || v->IsNoneObject())
				return nullptr;
			auto obj = v->GetObject();
			if (!obj)
				return nullptr;
			auto* vm     = Vm();
			auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!policy)
				return nullptr;
			const auto handle = obj->GetHandle();
			if (handle == policy->EmptyHandle() || !policy->HandleIsType(type, handle))
				return nullptr;
			return policy->GetObjectForHandle(type, handle);
		}

		RE::TESFaction* PropFaction(RE::BSScript::Object* obj, const char* name)
		{
			auto* f = VarForm(Prop(obj, name), RE::FormType::Faction);
			return f ? f->As<RE::TESFaction>() : nullptr;
		}

		RE::BGSListForm* PropList(RE::BSScript::Object* obj, const char* name)
		{
			auto* f = VarForm(Prop(obj, name), RE::FormType::FormList);
			return f ? f->As<RE::BGSListForm>() : nullptr;
		}

		int PropInt(RE::BSScript::Object* obj, const char* name, int fallback)
		{
			const auto* v = Prop(obj, name);
			if (!v || !v->IsInt())
				return fallback;
			return static_cast<int>(v->GetSInt());
		}

		// -------------------------------------------------------- NFF context --

		// One snapshot of everything NFF-side that is the same for every member,
		// rebuilt per call so nothing can go stale across a save load.
		struct Ctx
		{
			RE::TESFaction*  storedFac  = nullptr;   // rank = storage slot
			RE::TESFaction*  outfitFac  = nullptr;   // rank = which sets exist
			RE::TESFaction*  outTypeFac = nullptr;   // rank = which set is worn
			RE::BGSListForm* chests[kTypeCount] = {};
			int              slotsUsed = 0;
			bool             ok        = false;
		};

		void ScanSetsQuest()
		{
			if (g_scanned && g_setsQuest)
				return;

			auto* vm = Vm();
			if (!vm) {
				if (!g_warnedNoVm) {
					g_warnedNoVm = true;
					logger::warn("nff-outfits: no Papyrus VM — NFF outfit data unavailable");
				}
				return;
			}
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;

			std::size_t seen = 0;
			for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
				if (!q)
					continue;
				++seen;
				// Two different scripts, one sweep. They are on DIFFERENT quests,
				// so neither find may break the loop until both are in hand —
				// an early `break` on the sets quest is what would silently
				// leave the gear controls permanently "unknown".
				if (!g_setsQuest && BindScript(q, kSetsScript))
					g_setsQuest = q;
				if (!g_varQuest && BindScript(q, kVarScript))
					g_varQuest = q;
				if (g_setsQuest && g_varQuest)
					break;
			}
			g_scanned = true;

			if (g_varQuest && !g_loggedVarOk) {
				g_loggedVarOk = true;
				logger::info("nff-outfits: gear factions live on quest {:08X}",
					static_cast<std::uint32_t>(g_varQuest->GetFormID()));
			} else if (!g_varQuest) {
				logger::info("nff-outfits: {} not bound on any of {} quests — combat-gear "
							 "toggles will read as unknown",
					kVarScript, seen);
			}

			if (!g_setsQuest) {
				if (!g_warnedNoNff) {
					g_warnedNoNff = true;
					logger::info("nff-outfits: {} not bound on any of {} quests — Nether's "
								 "Follower Framework absent or no save loaded yet; the NFF tab "
								 "stays empty",
						kSetsScript, seen);
				}
				return;
			}
			if (!g_loggedOk) {
				g_loggedOk = true;
				logger::info("nff-outfits: outfit script on quest {:08X}",
					static_cast<std::uint32_t>(g_setsQuest->GetFormID()));
			}
		}

		Ctx Resolve()
		{
			Ctx c;
			ScanSetsQuest();
			if (!g_setsQuest)
				return c;

			auto sets = BindScript(g_setsQuest, kSetsScript);
			if (!sets)
				return c;

			c.storedFac  = PropFaction(sets.get(), "nwsFF_storedFac");
			c.outfitFac  = PropFaction(sets.get(), "nwsFF_OutfitFac");
			c.outTypeFac = PropFaction(sets.get(), "nwsFF_OutTypeFac");
			// The three chest lists, in Type order. NFF's own switchOutfit picks
			// exactly this way (adventure = the plain "Outfit" list).
			c.chests[kAdventure] = PropList(sets.get(), "nwsFFOutfitChestList");
			c.chests[kTown]      = PropList(sets.get(), "nwsFFTownChestList");
			c.chests[kHome]      = PropList(sets.get(), "nwsFFHomeChestList");
			c.slotsUsed          = PropInt(sets.get(), "nwsFFsetsUsed", 0);

			// storedFac is the one thing the feature genuinely needs — without it
			// there is no slot, so nothing else can be indexed. The chest lists
			// are allowed to be missing (we then report counts of -1, "unknown",
			// rather than pretending a set is empty).
			c.ok = c.storedFac != nullptr;
			return c;
		}

		// NFF's Outfit Preview Mode, read from the live quest rather than from
		// our mirror. `viewMode` is a plain hidden Int on nwsFollowerSetsScript
		// (0 = fill through a chest, 1 = dress her body), so this is the same
		// property fetch every other read here does — no Papyrus CALL.
		bool PreviewModeLive()
		{
			ScanSetsQuest();
			if (!g_setsQuest)
				return false;
			auto sets = BindScript(g_setsQuest, kSetsScript);
			return sets && PropInt(sets.get(), "viewMode", 0) == 1;
		}

		// Her storage slot, or -1 when NFF holds nothing for her. NFF writes it
		// with SetFactionRank(nwsFF_storedFac, mySlot), so the rank IS the slot.
		int SlotOf(RE::Actor* a, const Ctx& c)
		{
			if (!a || !c.storedFac || !a->IsInFaction(c.storedFac))
				return -1;
			const auto rank = a->GetFactionRank(c.storedFac, false);
			if (rank < 0 || rank >= kMaxSlots)
				return -1;
			return rank;
		}

		// Which of the three sets exist, decoded from nwsFF_OutfitFac's rank.
		// The mapping is NFF's AddOutfitFaction/RemoveOutfitFaction state machine
		// read off literally — see the table in nff_outfits.h.
		void HaveSets(RE::Actor* a, const Ctx& c, bool out[kTypeCount])
		{
			out[0] = out[1] = out[2] = false;
			if (!a || !c.outfitFac || !a->IsInFaction(c.outfitFac))
				return;
			switch (a->GetFactionRank(c.outfitFac, false)) {
			case 0: out[kAdventure] = true; break;
			case 1: out[kTown] = true; break;
			case 2: out[kHome] = true; break;
			case 3: out[kAdventure] = out[kTown] = true; break;
			case 4: out[kAdventure] = out[kHome] = true; break;
			case 5: out[kTown] = out[kHome] = true; break;
			case 6: out[kAdventure] = out[kTown] = out[kHome] = true; break;
			default: break;   // 7 (and anything unexpected) = nothing configured
			}
		}

		// Which set she is wearing: 0..2, 3 = her own base outfit, -1 = NFF has
		// not decided (she is not in the type faction at all).
		int WornType(RE::Actor* a, const Ctx& c)
		{
			if (!a || !c.outTypeFac || !a->IsInFaction(c.outTypeFac))
				return -1;
			const auto rank = a->GetFactionRank(c.outTypeFac, false);
			return (rank >= 0 && rank <= 3) ? rank : -1;
		}

		// The container holding one of her sets.
		RE::TESObjectREFR* ChestOf(const Ctx& c, int slot, int type)
		{
			if (slot < 0 || type < 0 || type >= kTypeCount)
				return nullptr;
			auto* list = c.chests[type];
			if (!list || static_cast<std::size_t>(slot) >= list->forms.size())
				return nullptr;
			auto* f = list->forms[static_cast<std::uint32_t>(slot)];
			return f ? f->As<RE::TESObjectREFR>() : nullptr;
		}

		// How many pieces are in a set. -1 = we could not read it (chest list
		// missing / slot out of range) — which the view must render differently
		// from a real, empty 0.
		int CountOf(const Ctx& c, int slot, int type)
		{
			auto* chest = ChestOf(c, slot, type);
			if (!chest)
				return -1;
			int        n   = 0;
			const auto inv = chest->GetInventory();
			for (const auto& [obj, data] : inv) {
				if (obj && data.first > 0)
					n += data.first;
			}
			return n;
		}

		// --------------------------------------------------------- our config --

		NpcMeta* Find(Config& c, const std::string& formId, const std::string& plugin)
		{
			const auto key = Lower(ActorKey(formId, plugin));
			for (auto& n : c.npcs)
				if (Lower(ActorKey(n.formId, n.plugin)) == key)
					return &n;
			return nullptr;
		}

		const NpcMeta* Find(const Config& c, const std::string& formId, const std::string& plugin)
		{
			return Find(const_cast<Config&>(c), formId, plugin);
		}

		NpcMeta& Ensure(Config& c, const std::string& formId, const std::string& plugin,
			const std::string& name)
		{
			if (auto* n = Find(c, formId, plugin)) {
				if (!name.empty())
					n->name = name;
				// An existing row filed under a runtime id gets upgraded the
				// moment we touch it, so the config drifts durable-ward rather
				// than accumulating more spellings of the same person.
				ActorIdentity::CanonicaliseActor(n->formId, n->plugin, n->name);
				return *n;
			}
			NpcMeta n;
			n.formId = formId;
			n.plugin = plugin;
			// Store the DURABLE pair, never what the view happened to send.
			// FO's Deck API sends a runtime FormID and no plugin at all.
			ActorIdentity::CanonicaliseActor(n.formId, n.plugin, name);
			n.name = name;
			c.npcs.push_back(std::move(n));
			return c.npcs.back();
		}

		// A person carries nothing worth persisting once every field is blank and
		// she is not claimed — drop her rather than growing the config forever.
		bool IsEmptyMeta(const NpcMeta& n)
		{
			if (n.claimed || !n.note.empty())
				return false;
			for (const auto& s : n.sets)
				if (!s.label.empty() || !s.icon.empty() || !s.note.empty())
					return false;
			return true;
		}

		// SOES's tracked list, taken from the Wardrobe config's own view of the
		// world. Read-only: consolidating the two engines is Rober's call.
		bool WardrobeOwns(const Wardrobe::Config& w, const std::string& formId,
			const std::string& plugin)
		{
			const auto key = Lower(ActorKey(formId, plugin));
			for (const auto& a : w.assignments) {
				if (Lower(ActorKey(a.formId, a.plugin)) != key)
					continue;
				return a.mode == "outfit" || a.mode == "wardrobe";
			}
			return false;
		}

		std::filesystem::path PortalFile()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "portal-nff.json";
		}

		// ------------------------------------------------------ request shape --

		struct Req
		{
			std::string formId, plugin;
			int         type = -1;
			bool        on   = false;
			bool        ok   = false;
		};

		Req ParseReq(const std::string& s)
		{
			Req        r;
			const auto j = json::parse(s, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return r;
			r.formId = Trim(j.value("formId", std::string("")));
			r.plugin = Trim(j.value("plugin", std::string("")));
			if (j.contains("type") && j["type"].is_number())
				r.type = j["type"].get<int>();
			if (j.contains("on"))
				r.on = j["on"].is_boolean() ? j["on"].get<bool>() : (j["on"] == 1);
			r.ok = !r.formId.empty();
			return r;
		}

		const char* TypeName(int t)
		{
			switch (t) {
			case kAdventure: return "Adventure";
			case kTown:      return "Town";
			case kHome:      return "Home";
			case kBase:      return "her own outfit";
			default:         return "?";
			}
		}

		// The guard, in one place. Returns an empty string when the op may go
		// ahead, or the reason it may not.
		std::string GuardWrite(const Config& cfg, const Wardrobe::Config& w, const Req& r,
			RE::Actor* actor, const char* verb)
		{
			if (!cfg.enabled)
				return "NFF outfits are switched off in the deck";
			if (!actor)
				return "Couldn't find that person in the game right now";
			if (!Available())
				return "Nether's Follower Framework isn't answering";

			const auto* meta = Find(cfg, r.formId, r.plugin);
			if (meta && meta->claimed)
				return {};   // deliberately handed to NFF — nothing else owns her

			if (WardrobeOwns(w, r.formId, r.plugin)) {
				return std::string("The Wardrobe already dresses her — ") + verb +
					" would fight it. Hand her to NFF first (the ⇄ button), which "
					"clears her Wardrobe assignment.";
			}
			return {};
		}
	}

	// ==================================================================== API ==

	bool Available()
	{
		ScanSetsQuest();
		return g_setsQuest != nullptr;
	}

	// -------------------------------------------------------------- persist ---

	json ToJson(const Config& c)
	{
		json npcs = json::array();
		for (const auto& n : c.npcs) {
			if (IsEmptyMeta(n))
				continue;
			json sets = json::array();
			for (const auto& s : n.sets)
				sets.push_back(json{ { "label", s.label }, { "icon", s.icon }, { "note", s.note } });
			npcs.push_back(json{
				{ "formId", n.formId }, { "plugin", n.plugin }, { "name", n.name },
				{ "sets", std::move(sets) }, { "note", n.note }, { "claimed", n.claimed } });
		}
		return json{ { "enabled", c.enabled }, { "preview", c.preview },
			{ "npcs", std::move(npcs) } };
	}

	void FromJson(const json& j, Config& out)
	{
		// `preview` is C++-owned (see nff_outfits.h) and the view's nfSave does
		// not carry it, so a payload that omits it KEEPS it. Captured before the
		// reset, exactly like Wardrobe::FromJson does for imageCrops.
		const bool keepPreview = out.preview;
		out = Config{};
		out.preview = keepPreview;
		if (!j.is_object())
			return;
		out.enabled = j.value("enabled", true);
		out.preview = j.value("preview", keepPreview);
		if (!j.contains("npcs") || !j["npcs"].is_array())
			return;
		for (const auto& e : j["npcs"]) {
			if (!e.is_object())
				continue;
			NpcMeta n;
			n.formId = Trim(e.value("formId", std::string("")));
			if (n.formId.empty())
				continue;
			n.plugin  = Trim(e.value("plugin", std::string("")));
			n.name    = Cap(e.value("name", std::string("")), 120);
			n.note    = Cap(e.value("note", std::string("")), 300);
			n.claimed = e.value("claimed", false);
			if (e.contains("sets") && e["sets"].is_array()) {
				const auto& arr = e["sets"];
				for (int i = 0; i < kTypeCount && i < static_cast<int>(arr.size()); ++i) {
					if (!arr[i].is_object())
						continue;
					n.sets[i].label = Cap(Trim(arr[i].value("label", std::string(""))), 60);
					n.sets[i].icon  = Cap(Trim(arr[i].value("icon", std::string(""))), 200);
					n.sets[i].note  = Cap(Trim(arr[i].value("note", std::string(""))), 300);
				}
			}
			if (!IsEmptyMeta(n))
				out.npcs.push_back(std::move(n));
		}
	}

	bool MergeViewSlice(const std::string& viewJson, Config& cfg)
	{
		const auto j = json::parse(viewJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return false;
		FromJson(j, cfg);
		return true;
	}

	// ----------------------------------------------------------------- read ---

	std::string OpenJson(const Config& c, const Wardrobe::Config& wardrobe,
		const std::string& foStateJson)
	{
		const auto ctx = Resolve();

		json out{
			{ "ok", true },
			{ "nff", ctx.ok },
			{ "enabled", c.enabled },
			// LIVE where we can get it: while the quest is bound the real
			// viewMode is readable, and the stored mirror is only the fallback
			// for when it is not (the portal, or before a save is loaded). A
			// toggle that shows our guess when the truth is available is how a
			// UI drifts away from the mod it drives.
			{ "preview", ctx.ok ? PreviewModeLive() : c.preview },
			{ "slotsUsed", ctx.slotsUsed },
			{ "slotsMax", kMaxSlots },
			{ "npcs", json::array() },
			{ "conflicts", json::array() },
		};

		// The roster, in Follower Organizer order — the same source the Followers
		// and Wardrobe tabs use, so all three agree on who exists. Anyone we hold
		// metadata for who FO no longer lists is appended, so a named set never
		// silently disappears with its owner.
		struct Row
		{
			// `original` is FO's un-renamed name. The view keys a PORTRAIT on it
			// (slugOf(original || name)), reusing the Followers tab's resolver;
			// there is deliberately no portrait PATH here, because FO does not
			// carry one and inventing a second resolution rule is how the two
			// panes would drift.
			std::string formId, plugin, name, original;
		};
		std::vector<Row>         rows;
		std::vector<std::string> seen;

		auto push = [&](const std::string& id, const std::string& plg, const std::string& nm,
						const std::string& original) {
			if (id.empty())
				return;
			const auto key = Lower(ActorKey(id, plg));
			if (std::find(seen.begin(), seen.end(), key) != seen.end())
				return;
			seen.push_back(key);
			rows.push_back(Row{ id, plg, nm, original });
		};

		const auto env = json::parse(foStateJson, nullptr, false);
		if (!env.is_discarded() && env.is_object()) {
			const json& st = (env.contains("state") && env["state"].is_object()) ? env["state"] : env;
			if (st.contains("categories") && st["categories"].is_array()) {
				for (const auto& cat : st["categories"]) {
					if (!cat.is_object() || !cat.contains("members") || !cat["members"].is_array())
						continue;
					for (const auto& m : cat["members"]) {
						if (!m.is_object())
							continue;
						push(m.value("formId", std::string("")), m.value("plugin", std::string("")),
							m.value("name", std::string("")), m.value("original", std::string("")));
					}
				}
			}
		}
		for (const auto& n : c.npcs)
			push(n.formId, n.plugin, n.name, "");

		std::size_t              stored = 0;
		std::vector<std::string> unresolved;
		for (auto& r : rows) {
			// Fill in the plugin the roster never carried, so a row that leaves
			// here and comes back is a DURABLE pair. `formId` deliberately stays
			// the runtime id the view already matches portraits and the
			// crosshair snapshot against — the plugin is what makes the pair
			// unambiguous, and every C++-side comparison goes through
			// ActorIdentity::Key() anyway.
			if (r.plugin.empty()) {
				std::string id, plg;
				if (ActorIdentity::DurableOf(ActorIdentity::Resolve(r.formId, ""), id, plg))
					r.plugin = plg;
			}
			auto* actor = ctx.ok ? ResolveActor(r.formId, r.plugin) : nullptr;
			if (!actor && ctx.ok)
				unresolved.push_back((r.name.empty() ? std::string("?") : r.name) + " " + r.formId);

			int  slot = -1;
			int  worn = -1;
			bool have[kTypeCount] = { false, false, false };
			json counts = json::array({ -1, -1, -1 });

			if (actor) {
				slot = SlotOf(actor, ctx);
				if (slot >= 0) {
					++stored;
					HaveSets(actor, ctx, have);
					worn = WornType(actor, ctx);
					for (int t = 0; t < kTypeCount; ++t)
						counts[t] = CountOf(ctx, slot, t);
				}
			}

			json meta = json::object();
			if (const auto* m = Find(c, r.formId, r.plugin)) {
				json sets = json::array();
				for (const auto& s : m->sets)
					sets.push_back(json{ { "label", s.label }, { "icon", s.icon }, { "note", s.note } });
				meta = json{ { "sets", std::move(sets) }, { "note", m->note }, { "claimed", m->claimed } };
			}

			const bool wardrobeOwned = WardrobeOwns(wardrobe, r.formId, r.plugin);
			// A CONFLICT is only real when both engines actually hold her: NFF has
			// a set for her AND the Wardrobe is assigned to dress her. Merely
			// being in NFF's roster with no set configured is not a fight.
			const bool conflict = slot >= 0 && (have[0] || have[1] || have[2]) && wardrobeOwned;
			if (conflict)
				out["conflicts"].push_back(ActorKey(r.formId, r.plugin));

			// Same canonical `key` as the Wardrobe rows, for the same reason:
			// the People surface joins BOTH exports per person, and two modules
			// spelling one actor differently is exactly the duplicate-row bug.
			std::string dId = r.formId, dPlg = r.plugin;
			std::string canon = Lower(ActorKey(r.formId, r.plugin));
			if (ActorIdentity::DurableOf(ActorIdentity::Resolve(r.formId, r.plugin), dId, dPlg))
				canon = Lower(ActorKey(dId, dPlg));
			out["npcs"].push_back(json{
				{ "formId", r.formId }, { "plugin", r.plugin }, { "name", r.name },
				{ "key", canon },
				{ "original", r.original },
				{ "resolved", actor != nullptr },
				{ "slot", slot },
				{ "have", json::array({ have[0], have[1], have[2] }) },
				{ "worn", worn },
				{ "counts", std::move(counts) },
				{ "wardrobe", wardrobeOwned },
				{ "conflict", conflict },
				{ "meta", std::move(meta) } });
		}

		logger::debug("nff-outfits: {} roster rows, {} with NFF sets, {} conflicting with the Wardrobe",
			rows.size(), stored, out["conflicts"].size());
		// A row the engine cannot find renders as a greyed "not loaded" badge
		// and refuses every op. Naming them here is what turns "she isn't
		// loaded???" into a diagnosis without a rebuild.
		if (!unresolved.empty()) {
			std::string list;
			for (const auto& u : unresolved)
				list += (list.empty() ? "" : ", ") + u;
			logger::warn("nff-outfits: {} roster row(s) do not resolve in this load order: {}",
				unresolved.size(), list);
		}
		return Dump(out);
	}

	std::string PiecesJson(const std::string& reqJson)
	{
		const auto r = ParseReq(reqJson);
		if (!r.ok || r.type < 0 || r.type >= kTypeCount)
			return Fail("Bad request");

		const auto ctx = Resolve();
		if (!ctx.ok)
			return Fail("Nether's Follower Framework isn't answering");

		auto* actor = ResolveActor(r.formId, r.plugin);
		if (!actor)
			return FailFor("Couldn't find that person in the game right now", r.formId, r.plugin, "pieces");

		const int slot = SlotOf(actor, ctx);
		if (slot < 0)
			return FailFor("NFF holds no outfits for her", r.formId, r.plugin, "pieces");

		auto* chest = ChestOf(ctx, slot, r.type);
		if (!chest)
			return FailFor("Couldn't reach that outfit's storage", r.formId, r.plugin, "pieces");

		json items = json::array();
		for (const auto& [obj, data] : chest->GetInventory()) {
			if (!obj || data.first <= 0)
				continue;
			const char* nm = obj->GetName();
			// A player-enchanted piece is a DYNAMIC form with no source file, and
			// TESForm::GetLocalFormID() dereferences GetFile(0) unchecked — so the
			// obvious spelling is a null read waiting for the first custom item in
			// someone's chest. DurableOf() reports "no durable identity" instead.
			std::string itemId, itemPlg;
			if (!ActorIdentity::DurableOf(obj, itemId, itemPlg))
				itemId = HexOf(obj->GetFormID());
			items.push_back(json{
				{ "formId", itemId },
				{ "plugin", itemPlg },
				{ "name", nm && nm[0] ? nm : "(unnamed)" },
				{ "count", data.first },
				{ "armor", obj->As<RE::TESObjectARMO>() != nullptr } });
		}
		return Dump(json{ { "ok", true }, { "formId", r.formId }, { "plugin", r.plugin },
			{ "type", r.type }, { "items", std::move(items) } });
	}

	// ---------------------------------------------------------------- write ---

	std::string Wear(const Config& cfg, const Wardrobe::Config& wardrobe, const std::string& reqJson)
	{
		const auto r = ParseReq(reqJson);
		if (!r.ok || r.type < 0 || r.type > kBase)
			return Fail("Bad request");

		auto* actor = ResolveActor(r.formId, r.plugin);
		if (const auto why = GuardWrite(cfg, wardrobe, r, actor, "changing her clothes"); !why.empty())
			return FailFor(why, r.formId, r.plugin, "wear");

		const auto ctx = Resolve();
		const int  slot = SlotOf(actor, ctx);
		if (slot < 0)
			return FailFor("NFF holds no outfits for her yet — make one first", r.formId, r.plugin, "wear");

		if (r.type < kTypeCount) {
			bool have[kTypeCount];
			HaveSets(actor, ctx, have);
			if (!have[r.type])
				return FailFor(std::string("She has no ") + TypeName(r.type) + " outfit yet",
					r.formId, r.plugin, "wear");
		}

		if (!SendOp(OpName("wear", r.type).c_str(), actor))
			return FailFor("The outfit executor isn\xE2\x80\x99t reachable \xE2\x80\x94 is its quest running?",
				r.formId, r.plugin, "wear");
		return Ok(std::string("Wearing ") + TypeName(r.type));
	}

	std::string Build(const Config& cfg, const Wardrobe::Config& wardrobe, const std::string& reqJson)
	{
		const auto r = ParseReq(reqJson);
		if (!r.ok || r.type < 0 || r.type >= kTypeCount)
			return Fail("Bad request");

		auto* actor = ResolveActor(r.formId, r.plugin);
		if (const auto why = GuardWrite(cfg, wardrobe, r, actor, "giving her an outfit"); !why.empty())
			return FailFor(why, r.formId, r.plugin, "build");

		// NFF answers this by opening a ContainerMenu, so the palette MUST be
		// closed before the event lands — the caller does that, and this message
		// is what tells them it worked.
		if (!SendOp(OpName("build", r.type).c_str(), actor))
			return FailFor("The outfit executor isn\xE2\x80\x99t reachable \xE2\x80\x94 is its quest running?",
				r.formId, r.plugin, "build");
		Notify(std::string("NFF: filling her ") + TypeName(r.type) + " outfit");
		return Ok(std::string("Opening her ") + TypeName(r.type) + " outfit chest");
	}

	std::string Clear(Config& cfg, const std::string& reqJson)
	{
		const auto r = ParseReq(reqJson);
		if (!r.ok || r.type < 0 || r.type > kBase)
			return Fail("Bad request");
		if (!cfg.enabled)
			return Fail("NFF outfits are switched off in the deck");

		auto* actor = ResolveActor(r.formId, r.plugin);
		if (!actor)
			return FailFor("Couldn't find that person in the game right now", r.formId, r.plugin, "clear");
		if (!Available())
			return FailFor("Nether's Follower Framework isn't answering", r.formId, r.plugin, "clear");

		// Clearing is always allowed — it can only ever REDUCE the number of
		// systems dressing her, so no guard.
		if (!SendOp(OpName("clear", r.type).c_str(), actor))
			return FailFor("The outfit executor isn\xE2\x80\x99t reachable \xE2\x80\x94 is its quest running?",
				r.formId, r.plugin, "clear");

		if (r.type == kBase) {
			// She is leaving NFF's outfit system entirely; our labels/icons for
			// her sets describe things that no longer exist.
			if (auto* m = Find(cfg, r.formId, r.plugin)) {
				for (auto& s : m->sets)
					s = SetMeta{};
			}
			std::erase_if(cfg.npcs, [](const NpcMeta& n) { return IsEmptyMeta(n); });
			return Ok("Dropped her from NFF outfits — she has her own clothes back");
		}
		if (auto* m = Find(cfg, r.formId, r.plugin)) {
			m->sets[r.type] = SetMeta{};
			std::erase_if(cfg.npcs, [](const NpcMeta& n) { return IsEmptyMeta(n); });
		}
		return Ok(std::string("Cleared her ") + TypeName(r.type) + " outfit");
	}

	std::string Satchel(const std::string& reqJson)
	{
		const auto r = ParseReq(reqJson);
		if (!r.ok)
			return Fail("Bad request");
		if (!Available())
			return Fail("Nether's Follower Framework isn't answering");

		auto* actor = ResolveActor(r.formId, r.plugin);
		if (!actor)
			return FailFor("Couldn't find that person in the game right now", r.formId, r.plugin, "satchel");

		const auto ctx = Resolve();
		if (SlotOf(actor, ctx) < 0)
			return FailFor("She has no NFF satchel — she isn't in its outfit system",
				r.formId, r.plugin, "satchel");

		if (!SendOp("satchel", actor))
			return FailFor("The outfit executor isn\xE2\x80\x99t reachable \xE2\x80\x94 is its quest running?",
				r.formId, r.plugin, "satchel");
		return Ok("Opening her satchel");
	}

	std::string Clone(const Config& cfg, const Wardrobe::Config& wardrobe, const std::string& reqJson)
	{
		const auto r = ParseReq(reqJson);
		if (!r.ok)
			return Fail("Bad request");

		auto* actor = ResolveActor(r.formId, r.plugin);
		// Guarded like Wear even though nothing is taken OFF her: NFF's
		// CloneOutfit reads the set NFF believes she is wearing, and on a
		// SOES-tracked actor that belief is the stale one — the copy would be of
		// clothes she is not in. Refusing is more honest than handing over the
		// wrong armour.
		if (const auto why = GuardWrite(cfg, wardrobe, r, actor, "copying her outfit"); !why.empty())
			return FailFor(why, r.formId, r.plugin, "clone");

		if (!SendOp("clone", actor))
			return FailFor("The outfit executor isn\xE2\x80\x99t reachable \xE2\x80\x94 is its quest running?",
				r.formId, r.plugin, "clone");
		// Deliberately vague about the count: CloneOutfit is fire-and-forget
		// Papyrus and we never learn how many parts it copied. Claiming a
		// number we did not see is how a UI starts lying.
		Notify("NFF: copying her outfit to you");
		return Ok("Copied her outfit into your pack");
	}

	// ------------------------------------------------------- combat gear ----
	//
	// NFF's four per-follower gear switches. They are FACTION state, which is
	// why they can be read straight off the engine here and why the write has
	// to go through Papyrus (AddToFaction/SetFactionRank on a live actor is
	// NFF's own documented route, and rank is what encodes helmet's third
	// state).
	//
	//   helm    "off"    not in nwsFF_HelmFac — NFF leaves her head alone
	//           "combat" rank 0 — helmet ON in combat, off the rest of the time
	//           "never"  rank 1 — never wears one
	//   shield / weapon / ammo   plain membership, no rank
	//
	// `known:false` means we could not bind NFF's variable quest (no save
	// loaded, or NFF absent). The view renders that as "—", never as "off":
	// showing four confident OFFs for state we did not read is how a UI starts
	// lying, and the helmet control is exactly the one you would then toggle
	// twice trying to make it stick.

	namespace
	{
		struct GearFactions
		{
			RE::TESFaction* helm   = nullptr;
			RE::TESFaction* shield = nullptr;
			RE::TESFaction* weapon = nullptr;
			RE::TESFaction* ammo   = nullptr;
			bool            ok     = false;
		};

		GearFactions ResolveGearFactions()
		{
			GearFactions g;
			ScanSetsQuest();
			if (!g_varQuest)
				return g;
			auto obj = BindScript(g_varQuest, kVarScript);
			if (!obj)
				return g;
			g.helm   = PropFaction(obj.get(), "nwsFF_HelmFac");
			g.shield = PropFaction(obj.get(), "nwsFF_ShieldFac");
			g.weapon = PropFaction(obj.get(), "nwsFF_WeaponFac");
			g.ammo   = PropFaction(obj.get(), "nwsFF_AmmoFac");
			// All four or none: a partial read would render three real switches
			// beside one that silently always says off.
			g.ok = g.helm && g.shield && g.weapon && g.ammo;
			if (!g.ok)
				logger::warn("nff-gear: variable quest bound but a faction property "
							 "did not resolve (helm={} shield={} weapon={} ammo={})",
					!!g.helm, !!g.shield, !!g.weapon, !!g.ammo);
			return g;
		}

		// The legal gear ops, and the state each one lands in. One table, so the
		// C++ validation and the string the executor compares can never drift.
		struct GearOp
		{
			const char* op;
			const char* said;
		};

		const GearOp* FindGearOp(const std::string& op)
		{
			static const GearOp kOps[] = {
				{ "helmOff", "NFF no longer manages her headwear" },
				{ "helmCombat", "Helmet on only in combat" },
				{ "helmNever", "She will never wear a helmet" },
				{ "shieldOn", "Shield only in combat" },
				{ "shieldOff", "She keeps her shield out" },
				{ "weaponOn", "Her weapons follow yours" },
				{ "weaponOff", "She sheathes on her own schedule" },
				{ "ammoOn", "Arrows away out of combat" },
				{ "ammoOff", "She keeps her arrows nocked" },
			};
			for (const auto& g : kOps)
				if (op == g.op)
					return &g;
			return nullptr;
		}
	}

	std::string Gear(const std::string& reqJson)
	{
		const auto r = ParseReq(reqJson);
		if (!r.ok)
			return Fail("Bad request");

		json out{ { "ok", true }, { "formId", r.formId }, { "plugin", r.plugin },
			{ "known", false }, { "helm", "off" }, { "shield", false },
			{ "weapon", false }, { "ammo", false } };

		auto* actor = ResolveActor(r.formId, r.plugin);
		if (!actor)
			return Dump(out);   // honest: ok, but nothing known

		const auto g = ResolveGearFactions();
		if (!g.ok)
			return Dump(out);

		// GetFactionRank's second argument is "is this the player" — false here,
		// always: passing true reads the PLAYER's rank in that faction and would
		// report every follower as sharing one setting.
		out["known"] = true;
		if (actor->IsInFaction(g.helm))
			out["helm"] = (actor->GetFactionRank(g.helm, false) == 1) ? "never" : "combat";
		out["shield"] = actor->IsInFaction(g.shield);
		out["weapon"] = actor->IsInFaction(g.weapon);
		out["ammo"]   = actor->IsInFaction(g.ammo);
		return Dump(out);
	}

	std::string SetGear(const std::string& reqJson)
	{
		const auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Fail("Bad request");
		const auto r = ParseReq(reqJson);
		if (!r.ok)
			return Fail("Bad request");
		const std::string op = Trim(j.value("op", std::string("")));
		const GearOp*     g  = FindGearOp(op);
		if (!g)
			return Fail("Unknown gear switch");

		auto* actor = ResolveActor(r.formId, r.plugin);
		if (!actor)
			return FailFor("Couldn't find that person in the game right now",
				r.formId, r.plugin, op.c_str());

		// DELIBERATELY not behind GuardWrite. The one-actor-one-backend rule is
		// about who DRESSES her, and these four switches dress nobody — they say
		// whether a helmet comes off out of combat. A SOES-tracked follower has
		// a head too, and refusing here would leave the deck's most-asked-for
		// control unavailable on exactly the people the Wardrobe tab manages.
		if (!SendGear(op.c_str(), actor))
			return FailFor("The outfit executor isn\xE2\x80\x99t reachable \xE2\x80\x94 is its quest running?",
				r.formId, r.plugin, op.c_str());
		return Ok(g->said);
	}

	std::string SetPreview(Config& cfg, const std::string& reqJson)
	{
		const auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Fail("Bad request");
		const bool on = j.value("on", false);
		if (!Available())
			return Fail("Nether's Follower Framework isn't answering");
		// No actor: the executor handles the preview ops before its actor guard
		// precisely so this can be nullptr rather than an invented target.
		if (!SendOp(on ? "preview1" : "preview0", nullptr))
			return Fail("The outfit executor isn\xE2\x80\x99t reachable \xE2\x80\x94 is its quest running?");
		cfg.preview = on;
		Notify(on ? "NFF: outfits are dressed on her body"
				  : "NFF: outfits are filled through a chest");
		return Ok(on ? "Preview mode ON — you dress her, not a chest"
					 : "Preview mode OFF — outfits are filled through a chest");
	}

	std::string SwitchNow(const std::string& reqJson)
	{
		const auto j = json::parse(reqJson, nullptr, false);
		const std::string mode =
			(!j.is_discarded() && j.is_object()) ? j.value("mode", std::string("recheck"))
												 : std::string("recheck");
		if (mode != "switch" && mode != "recheck")
			return Fail("Bad request");
		if (!Available())
			return Fail("Nether's Follower Framework isn't answering");
		if (!SendOp(mode.c_str(), nullptr))
			return Fail("The outfit executor isn\xE2\x80\x99t reachable \xE2\x80\x94 is its quest running?");
		return Ok(mode == "switch" ? "Asked NFF to switch everyone's outfit"
								   : "Re-checking everyone's outfit for where you are");
	}

	std::string CopyFromWardrobe(Config& cfg, const Wardrobe::Config& wardrobe, const std::string& reqJson)
	{
		const auto r = ParseReq(reqJson);
		if (!r.ok || r.type < 0 || r.type >= kTypeCount)
			return Fail("Bad request");
		const auto reqJ = json::parse(reqJson, nullptr, false);
		const std::string outfit =
			reqJ.is_object() ? Trim(reqJ.value("outfit", std::string(""))) : std::string("");
		if (outfit.empty())
			return Fail("No outfit chosen");

		auto* actor = ResolveActor(r.formId, r.plugin);
		if (const auto why = GuardWrite(cfg, wardrobe, r, actor, "changing her clothes"); !why.empty())
			return Fail(why);

		const auto ctx  = Resolve();
		const int  slot = SlotOf(actor, ctx);
		if (slot < 0)
			return Fail("NFF holds no outfits for her yet \xE2\x80\x94 make one first");

		// NFF learns about a set through its OWN CreateOutfit flow (the faction
		// rank, the satchel alias, her saved base outfit). Filling a chest it has
		// never registered would put clothes somewhere nothing ever reads, so
		// refuse and say what to do instead.
		bool have[kTypeCount];
		HaveSets(actor, ctx, have);
		if (!have[r.type]) {
			return Fail(std::string("She has no ") + TypeName(r.type) +
				// NOTE the split literals: "\x9C" followed by 'F' would be read as the
				// hex escape \x9CF, which is out of range. Adjacent-literal
				// concatenation ends the escape where it is meant to end.
				" outfit yet \xE2\x80\x94 use \xE2\x80\x9C" "Fill it\xE2\x80\xA6\xE2\x80\x9D once so NFF knows "
				"about it, then copy into it");
		}

		auto* chest = ChestOf(ctx, slot, r.type);
		if (!chest)
			return Fail("Couldn't reach that outfit's storage");

		// The SOES side, read through Wardrobe's own export reader so there is
		// one parser for SOES's json and not two.
		const auto pj = json::parse(Wardrobe::OutfitPiecesJson(
										json{ { "name", outfit } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace)),
			nullptr, false);
		if (pj.is_discarded() || !pj.is_object() || !pj.value("ok", false))
			return Fail(pj.is_object() ? pj.value("msg", std::string("Couldn't read that outfit"))
									   : std::string("Couldn't read that outfit"));
		if (!pj.contains("items") || !pj["items"].is_array() || pj["items"].empty())
			return Fail("\"" + outfit + "\" has no pieces");

		auto* dh = RE::TESDataHandler::GetSingleton();
		std::vector<RE::TESBoundObject*> pieces;
		int                              missing = 0;
		for (const auto& it : pj["items"]) {
			if (!it.is_object())
				continue;
			const std::string fid  = it.value("formId", std::string(""));
			const std::string plug = it.value("plugin", std::string(""));
			const auto        local = ParseHex(fid);
			RE::TESForm*      form = nullptr;
			if (local && !plug.empty() && dh)
				form = dh->LookupForm(local, plug);
			if (!form && local)
				form = RE::TESForm::LookupByID(local);
			auto* obj = form ? form->As<RE::TESBoundObject>() : nullptr;
			if (obj)
				pieces.push_back(obj);
			else
				++missing;
		}
		if (pieces.empty())
			return Fail("None of \"" + outfit + "\"'s pieces resolved in this load order");

		// Displaced clothes go to the PLAYER, exactly as NFF's own ClearContainer
		// does for a single type. Destroying them would be quietly expensive.
		int moved = 0;
		if (auto* player = RE::PlayerCharacter::GetSingleton()) {
			const auto inv = chest->GetInventory();
			for (const auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				chest->RemoveItem(obj, data.first, RE::ITEM_REMOVE_REASON::kStoreInContainer,
					nullptr, player);
				moved += data.first;
			}
		}

		for (auto* obj : pieces)
			chest->AddObjectToContainer(obj, nullptr, 1, nullptr);

		// switchOutfit rebuilds the per-slot LeveledItem from the chest every
		// time, so the NEXT switch picks this up on its own. If she is wearing
		// this very set right now, re-fire it so she changes in front of you
		// instead of at the next load door.
		if (WornType(actor, ctx) == r.type)
			SendOp(OpName("wear", r.type).c_str(), actor);

		logger::info("nff-outfits: copied \"{}\" ({} pieces, {} unresolved) into {} set of {:08X}; "
					 "{} displaced item(s) went to the player",
			outfit, pieces.size(), missing, TypeName(r.type),
			static_cast<std::uint32_t>(actor->GetFormID()), moved);

		std::string msg = "Copied \"" + outfit + "\" into her " + TypeName(r.type) + " outfit \xE2\x80\x94 " +
			std::to_string(pieces.size()) + " piece" + (pieces.size() == 1 ? "" : "s");
		if (missing)
			msg += ", " + std::to_string(missing) + " missing";
		if (moved)
			msg += "; what was in it went to you";
		Notify(msg);
		return Ok(msg);
	}

	std::string Claim(Config& cfg, Wardrobe::Config& wardrobe, const std::string& reqJson)
	{
		const auto r = ParseReq(reqJson);
		if (!r.ok)
			return Fail("Bad request");

		auto* actor = ResolveActor(r.formId, r.plugin);
		const std::string name = actor && actor->GetDisplayFullName() ? actor->GetDisplayFullName() : "";

		if (!r.on) {
			if (auto* m = Find(cfg, r.formId, r.plugin))
				m->claimed = false;
			std::erase_if(cfg.npcs, [](const NpcMeta& n) { return IsEmptyMeta(n); });
			return Ok("Released — neither system is claiming her now");
		}

		// Claiming is the ONE place the two backends touch, and it must leave
		// exactly one of them holding her. Drop the Wardrobe assignment and, if
		// SOES is tracking her, untrack — otherwise SOES's EquipObject hook eats
		// every piece NFF tries to put on and she ends up permanently wrong.
		bool wasWardrobe = false;
		for (auto& a : wardrobe.assignments) {
			if (Lower(ActorKey(a.formId, a.plugin)) != Lower(ActorKey(r.formId, r.plugin)))
				continue;
			if (a.mode != "off") {
				wasWardrobe = true;
				a.mode      = "off";
				a.wardrobeId.clear();
				a.outfit.clear();
			}
		}
		if (wasWardrobe) {
			const auto res = Wardrobe::SetTracked(wardrobe,
				Dump(json{ { "formId", r.formId }, { "plugin", r.plugin }, { "track", false } }));
			logger::info("nff-outfits: claimed {}|{} for NFF; untracking from SOES -> {}",
				r.formId, r.plugin, res);
		}

		auto& m   = Ensure(cfg, r.formId, r.plugin, name);
		m.claimed = true;
		return Ok(wasWardrobe
				? "Handed to NFF — her Wardrobe assignment is cleared so they can't fight"
				: "Handed to NFF");
	}

	// ------------------------------------------------------ identity repair ---

	bool RepairIdentities(Config& cfg, const std::string& foStateJson)
	{
		bool changed = false;

		// Everyone FO can see RIGHT NOW, by name, with their durable identity.
		// FO is the only authority that can rescue a row whose stored FormID no
		// longer addresses anybody: the id is dead, the name is not.
		struct Live
		{
			std::string name, formId, plugin;
		};
		std::vector<Live> live;
		const auto        env = json::parse(foStateJson, nullptr, false);
		if (!env.is_discarded() && env.is_object()) {
			const json& st = (env.contains("state") && env["state"].is_object()) ? env["state"] : env;
			if (st.contains("categories") && st["categories"].is_array()) {
				for (const auto& cat : st["categories"]) {
					if (!cat.is_object() || !cat.contains("members") || !cat["members"].is_array())
						continue;
					for (const auto& m : cat["members"]) {
						if (!m.is_object())
							continue;
						std::string id  = m.value("formId", std::string(""));
						std::string plg = m.value("plugin", std::string(""));
						if (id.empty())
							continue;
						std::string dId, dPlg;
						if (!ActorIdentity::DurableOf(ActorIdentity::Resolve(id, plg), dId, dPlg))
							continue;   // she does not resolve either — no help here
						for (const char* k : { "name", "original", "override" }) {
							const auto nm = Trim(m.value(k, std::string("")));
							if (!nm.empty())
								live.push_back(Live{ Lower(nm), dId, dPlg });
						}
					}
				}
			}
		}
		// Two people under one name (two "Guard"s, a follower and her mod's
		// duplicate) make the name useless as a key — drop those names entirely
		// rather than re-key a row onto a coin flip.
		std::erase_if(live, [&](const Live& l) {
			return std::any_of(live.begin(), live.end(), [&](const Live& o) {
				return o.name == l.name && (o.formId != l.formId || o.plugin != l.plugin);
			});
		});

		for (auto& n : cfg.npcs) {
			// FO's LIVE roster wins whenever it knows this name. It is the only
			// authority that is correct in the CURRENT load order, and preferring
			// it also handles the case a stored id resolves — to a stranger.
			const auto want = Lower(Trim(n.name));
			const auto hit  = want.empty() ? live.end()
										   : std::find_if(live.begin(), live.end(),
												 [&](const Live& l) { return l.name == want; });
			if (hit != live.end()) {
				if (hit->formId != n.formId || hit->plugin != n.plugin) {
					logger::warn("nff-outfits: re-keyed \"{}\" {}|{} -> {}|{} — the stored FormID was minted "
								 "in a different load order{}",
						n.name, n.formId, n.plugin.empty() ? "(no plugin)" : n.plugin, hit->formId,
						hit->plugin,
						ActorIdentity::ResolvesToStranger(n.formId, n.plugin, n.name)
							? " and was pointing at somebody else"
							: " and no longer addresses anyone");
					n.formId = hit->formId;
					n.plugin = hit->plugin;
					changed  = true;
				}
				continue;
			}
			// Not in FO's roster (a claimed NPC who is not a follower). Best
			// effort on what we hold, refusing to canonicalise onto a stranger.
			if (ActorIdentity::CanonicaliseActor(n.formId, n.plugin, n.name))
				changed = true;
			else if (ActorIdentity::ResolvesToStranger(n.formId, n.plugin, n.name))
				logger::warn("nff-outfits: \"{}\" is stored as {}|{}, which resolves to a DIFFERENT actor "
							 "and is not in Follower Organizer's roster — left alone, ops on her will be wrong",
					n.name, n.formId, n.plugin.empty() ? "(no plugin)" : n.plugin);
		}

		// A re-key can land two rows on one person (her stale row and the row
		// filed after the load order moved). Fold them: first wins, but anything
		// the loser actually carried is kept.
		std::vector<std::string> keys;
		std::vector<NpcMeta>     kept;
		for (const auto& n : cfg.npcs) {
			const auto key = ActorKey(n.formId, n.plugin);
			const auto at  = std::find(keys.begin(), keys.end(), key);
			if (at == keys.end()) {
				keys.push_back(key);
				kept.push_back(n);
				continue;
			}
			auto& keep   = kept[static_cast<std::size_t>(at - keys.begin())];
			keep.claimed = keep.claimed || n.claimed;
			if (keep.note.empty())
				keep.note = n.note;
			for (int t = 0; t < kTypeCount; ++t) {
				if (keep.sets[t].label.empty())
					keep.sets[t].label = n.sets[t].label;
				if (keep.sets[t].icon.empty())
					keep.sets[t].icon = n.sets[t].icon;
				if (keep.sets[t].note.empty())
					keep.sets[t].note = n.sets[t].note;
			}
			logger::warn("nff-outfits: merged a duplicate row for \"{}\" (key {})", keep.name, key);
			changed = true;
		}
		if (changed)
			cfg.npcs = std::move(kept);
		return changed;
	}

	// --------------------------------------------------------- portal replay ---

	bool ApplyPortal(Config& cfg)
	{
		const auto      file = PortalFile();
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		bool changed = false;
		{
			std::ifstream in(file, std::ios::binary);
			if (in.is_open()) {
				auto j = json::parse(in, nullptr, false);
				if (!j.is_discarded() && j.is_object() && j.contains("ops") && j["ops"].is_array()) {
					for (const auto& op : j["ops"]) {
						if (!op.is_object())
							continue;
						const std::string kind   = op.value("op", std::string(""));
						const std::string formId = Trim(op.value("formId", std::string("")));
						const std::string plugin = Trim(op.value("plugin", std::string("")));
						if (formId.empty())
							continue;

						// METADATA ONLY. The portal never queues a gameplay write:
						// it cannot know whether SOES is tracking her, and a
						// dressing change that skips GuardWrite is exactly the
						// thing this whole file exists to prevent.
						if (kind == "set") {
							const int t = op.value("type", -1);
							if (t < 0 || t >= kTypeCount)
								continue;
							const std::string key = op.value("key", std::string(""));
							const std::string val = op.value("value", std::string(""));
							auto&             m   = Ensure(cfg, formId, plugin,
														   Trim(op.value("name", std::string(""))));
							if (key == "label")
								m.sets[t].label = Cap(Trim(val), 60);
							else if (key == "icon")
								m.sets[t].icon = Cap(Trim(val), 200);
							else if (key == "note")
								m.sets[t].note = Cap(Trim(val), 300);
							else
								continue;
							changed = true;
						} else if (kind == "note") {
							auto& m = Ensure(cfg, formId, plugin,
								Trim(op.value("name", std::string(""))));
							m.note  = Cap(Trim(op.value("value", std::string(""))), 300);
							changed = true;
						}
					}
				}
			}
		}
		std::filesystem::remove(file, ec);
		if (changed)
			std::erase_if(cfg.npcs, [](const NpcMeta& n) { return IsEmptyMeta(n); });
		return changed;
	}
}
