#include "nff_bases.h"

#include "npc_actions.h"  // TargetFormID(): the palette-open crosshair snapshot

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <unordered_map>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json and the logger.

// wingdi.h #defines GetObject; Variable.h undefines it for itself but the
// macro is back by the time this file is parsed (same note as nff_bridge).
#ifdef GetObject
#	undef GetObject
#endif

using json = nlohmann::json;

namespace NffBases
{
	namespace
	{
		// marker: nff-bases (Domains tab: NFF home-base management)

		// Nether's Follower Framework 2.8.6.0b. Class names as declared in the
		// decompiled .pex on this rig (C:\Dev\nff-decomp). Both `Extend Quest`,
		// so the bound object hangs off a quest form.
		constexpr const char* kHomeScript = "nwsFollowerHomeScript";
		constexpr const char* kVarScript = "nwsFollowerVariableScript";

		// Hard ceiling on anything we will loop over. NOT the base count — that
		// comes from the script's own maxBases (see the header). This is only
		// here so a corrupt property can never turn into a million-iteration
		// loop on the main thread.
		constexpr int kSaneMaxBases = 256;
		constexpr int kSaneMaxSlots = 1024;

		// Longest name we will write into one of NFF's string arrays. Its own
		// input option is unbounded, but these strings are rendered in a menu
		// and round-trip through our JSON, so they get a limit.
		constexpr std::size_t kMaxNameLen = 48;

		bool g_warnedNoVm = false;
		bool g_warnedNoNff = false;
		bool g_loggedOk = false;

		// Quest forms are static for the run of the game, so the scan that
		// finds them is cached. The bound script OBJECT deliberately is not: a
		// save load rebinds it, and a stale smart pointer is exactly the kind
		// of thing that turns into a crash.
		RE::TESQuest* g_homeQuest = nullptr;
		RE::TESQuest* g_varQuest = nullptr;
		bool          g_scanned = false;

		// How far the installed script's work/relax flag properties actually
		// go (see the header's ⚠). -1 = not probed yet this session.
		int g_workFlagLimit = -1;

		/* ------------------------------------------------------------ VM --- */

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

		// Bind `form`'s instance of the named Papyrus script, or nullptr. The
		// class name is tried as declared and then lowercased: Papyrus is
		// case-insensitive and different toolchains register the type under
		// different casings, so one spelling is not a safe bet for a lookup
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

		// The property's backing variable, mutable. GetProperty() is the
		// documented route for an `Auto` property; the "::name_var" form is the
		// raw backing variable and covers a build where the property table
		// lookup misses.
		RE::BSScript::Variable* Prop(RE::BSScript::Object* obj, const char* name)
		{
			if (!obj || !name)
				return nullptr;
			if (auto* v = obj->GetProperty(name))
				return v;
			const std::string backing = "::"s + name + "_var";
			return obj->GetVariable(backing);
		}

		// Every accessor below gates on the variable's own type flag first.
		// Variable::Get*() reinterprets a union — calling the wrong one in a
		// release build (where the asserts are gone) reads garbage as a pointer.

		std::string VarString(const RE::BSScript::Variable* v)
		{
			if (!v || !v->IsString())
				return {};
			return std::string(v->GetString());
		}

		int VarInt(const RE::BSScript::Variable* v, int fallback)
		{
			if (!v || !v->IsInt())
				return fallback;
			return static_cast<int>(v->GetSInt());
		}

		RE::TESForm* VarForm(const RE::BSScript::Variable* v, RE::FormType type)
		{
			if (!v || !v->IsObject() || v->IsNoneObject())
				return nullptr;
			auto obj = v->GetObject();
			if (!obj)
				return nullptr;
			auto* vm = Vm();
			auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!policy)
				return nullptr;
			const auto handle = obj->GetHandle();
			if (handle == policy->EmptyHandle() || !policy->HandleIsType(type, handle))
				return nullptr;
			return policy->GetObjectForHandle(type, handle);
		}

		// An ObjectReference variable's handle carries the concrete form type,
		// and a placed NPC is an ACHR, not a REFR — so both are tried.
		RE::TESObjectREFR* VarRef(const RE::BSScript::Variable* v)
		{
			auto* form = VarForm(v, RE::FormType::Reference);
			if (!form)
				form = VarForm(v, RE::FormType::ActorCharacter);
			return form ? form->As<RE::TESObjectREFR>() : nullptr;
		}

		RE::Actor* VarActor(const RE::BSScript::Variable* v)
		{
			auto* ref = VarRef(v);
			return ref ? ref->As<RE::Actor>() : nullptr;
		}

		RE::TESFaction* PropFaction(RE::BSScript::Object* obj, const char* name)
		{
			auto* form = VarForm(Prop(obj, name), RE::FormType::Faction);
			return form ? form->As<RE::TESFaction>() : nullptr;
		}

		RE::TESGlobal* PropGlobal(RE::BSScript::Object* obj, const char* name)
		{
			auto* form = VarForm(Prop(obj, name), RE::FormType::Global);
			return form ? form->As<RE::TESGlobal>() : nullptr;
		}

		// The backing array of an array property, mutable — writes go through
		// this so a rename lands in NFF's own storage, not a copy of it.
		RE::BSTSmartPointer<RE::BSScript::Array> PropArray(RE::BSScript::Object* obj, const char* name)
		{
			RE::BSTSmartPointer<RE::BSScript::Array> arr;
			auto*                                    v = Prop(obj, name);
			if (!v || !v->IsArray())
				return arr;
			return v->GetArray();
		}

		std::vector<std::string> ReadStringArray(RE::BSScript::Object* obj, const char* name)
		{
			std::vector<std::string> out;
			auto                     arr = PropArray(obj, name);
			if (!arr)
				return out;
			const auto n = arr->size();
			out.reserve(n);
			for (std::uint32_t i = 0; i < n; ++i)
				out.push_back(VarString(&(*arr)[i]));
			return out;
		}

		std::vector<int> ReadIntArray(RE::BSScript::Object* obj, const char* name)
		{
			std::vector<int> out;
			auto             arr = PropArray(obj, name);
			if (!arr)
				return out;
			const auto n = arr->size();
			out.reserve(n);
			for (std::uint32_t i = 0; i < n; ++i)
				out.push_back(VarInt(&(*arr)[i], 0));
			return out;
		}

		std::vector<RE::TESObjectREFR*> ReadRefArray(RE::BSScript::Object* obj, const char* name)
		{
			std::vector<RE::TESObjectREFR*> out;
			auto                            arr = PropArray(obj, name);
			if (!arr)
				return out;
			const auto n = arr->size();
			out.reserve(n);
			for (std::uint32_t i = 0; i < n; ++i)
				out.push_back(VarRef(&(*arr)[i]));
			return out;
		}

		std::vector<RE::Actor*> ReadActorArray(RE::BSScript::Object* obj, const char* name)
		{
			std::vector<RE::Actor*> out;
			auto                    arr = PropArray(obj, name);
			if (!arr)
				return out;
			const auto n = arr->size();
			out.reserve(n);
			for (std::uint32_t i = 0; i < n; ++i)
				out.push_back(VarActor(&(*arr)[i]));
			return out;
		}

		// Write one element of a String[] property in place. False when the
		// property is missing or the index is past its end — NFF sized these
		// arrays from its ESP, and growing one from here would hand its own
		// scripts an array it did not allocate.
		bool WriteStringAt(RE::BSScript::Object* obj, const char* name, int index, const std::string& value)
		{
			auto arr = PropArray(obj, name);
			if (!arr || index < 0 || static_cast<std::uint32_t>(index) >= arr->size())
				return false;
			auto& slot = (*arr)[static_cast<std::uint32_t>(index)];
			slot.SetString(value);
			return true;
		}

		/* --------------------------------------------------------- names --- */

		std::string Trim(std::string s)
		{
			const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
			s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
			s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
			return s;
		}

		// NFF blanks a freed slot by writing the literal string "None"
		// (nwsFollowerHomeScript's ClearBaseLocation), so that is not a name.
		bool IsBlankName(const std::string& s)
		{
			if (s.empty())
				return true;
			const auto l = Lower(Trim(s));
			return l.empty() || l == "none" || l == "n/a" || l == "-";
		}

		std::string NameOfForm(RE::TESForm* form)
		{
			if (!form)
				return {};
			if (auto* full = form->As<RE::TESFullName>()) {
				const auto* n = full->GetFullName();
				if (n && n[0])
					return n;
			}
			return {};
		}

		// Human name for a place, given the marker that stands in it. Cell name
		// first (that is what a house IS called: "Breezehome"), then location,
		// then the ref's own name, then the worldspace. Everything null-gated: a
		// marker in an unloaded cell can have a null parent cell, and
		// GetCurrentLocation() walks the parent cell.
		std::string PlaceNameOfRef(RE::TESObjectREFR* ref)
		{
			if (!ref)
				return {};
			auto* cell = ref->GetParentCell();
			if (cell) {
				auto n = NameOfForm(cell);
				if (!n.empty())
					return n;
				if (auto* loc = ref->GetCurrentLocation()) {
					n = NameOfForm(loc);
					if (!n.empty())
						return n;
				}
			}
			if (auto* world = ref->GetWorldspace()) {
				auto n = NameOfForm(world);
				if (!n.empty())
					return n;
			}
			if (cell) {
				const auto* eid = cell->GetFormEditorID();
				if (eid && eid[0])
					return eid;
			}
			return {};
		}

		// Where the PLAYER is standing, named the same way NFF names it when
		// its own menu registers a location (cell name, else location, else
		// "Tamriel").
		std::string PlayerPlaceName()
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player)
				return "Tamriel";
			if (auto* cell = player->GetParentCell()) {
				auto n = NameOfForm(cell);
				if (!n.empty())
					return n;
			}
			if (auto* loc = player->GetCurrentLocation()) {
				auto n = NameOfForm(loc);
				if (!n.empty())
					return n;
			}
			return "Tamriel";
		}

		std::string HexId(RE::FormID id)
		{
			char buf[16];
			std::snprintf(buf, sizeof(buf), "%08X", id);
			return buf;
		}

		// "0001A6A1" / "0x0001A6A1" / "1a6a1" -> 0x0001A6A1. 0 on anything
		// unusable, which every caller treats as "no actor".
		RE::FormID ParseFormId(const std::string& s)
		{
			if (s.empty())
				return 0;
			try {
				return static_cast<RE::FormID>(std::stoul(s, nullptr, 16));
			} catch (...) {
				return 0;
			}
		}

		RE::Actor* ActorById(const std::string& idStr)
		{
			const auto id = ParseFormId(idStr);
			if (!id)
				return nullptr;
			auto* form = RE::TESForm::LookupByID(id);
			return form ? form->As<RE::Actor>() : nullptr;
		}

		std::string ActorName(RE::Actor* actor)
		{
			if (!actor)
				return "(gone)";
			const char* n = actor->GetDisplayFullName();
			if (n && n[0])
				return n;
			return "(unnamed)";
		}

		/* ---------------------------------------------------------- scan --- */

		// Find the quest each NFF script is attached to. One pass over the
		// quest form array; the forms are cached, so a hit costs nothing after
		// the first open. A miss is re-tried cheaply, because the VM has no
		// bound objects at all until a save is loaded.
		void ScanQuests()
		{
			if (g_scanned && g_homeQuest)
				return;

			auto* vm = Vm();
			if (!vm) {
				if (!g_warnedNoVm) {
					g_warnedNoVm = true;
					logger::warn("nff-bases: no Papyrus VM — base management unavailable");
				}
				return;
			}
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;

			RE::TESQuest* home = nullptr;
			RE::TESQuest* vars = nullptr;
			for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
				if (!q)
					continue;
				if (!home && BindScript(q, kHomeScript))
					home = q;
				if (!vars && BindScript(q, kVarScript))
					vars = q;
				if (home && vars)
					break;
			}

			g_homeQuest = home;
			g_varQuest = vars;
			g_scanned = true;

			if (!home) {
				if (!g_warnedNoNff) {
					g_warnedNoNff = true;
					logger::info("nff-bases: NFF's home-base script not bound (mod absent, or no save loaded yet)");
				}
			} else if (!g_loggedOk) {
				g_loggedOk = true;
				logger::info("nff-bases: home quest {:08X} bound", home->GetFormID());
			}
		}

		/* ------------------------------------------------------ dispatch --- */

		// Call one of NFF's own functions on the home quest. Fire-and-forget:
		// the VM runs it on its own thread and the results are read back on the
		// next state push, which is exactly how NFF's MCM behaves too (its
		// pages re-run mCheckBases on open).
		bool CallHome2(const char* fn, std::int32_t a, std::int32_t b)
		{
			auto* vm = Vm();
			if (!vm || !g_homeQuest || !fn)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, g_homeQuest);
			if (handle == policy->EmptyHandle())
				return false;

			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(std::move(a), std::move(b));
			return vm->DispatchMethodCall(handle, kHomeScript, fn, args, cb);
		}

		bool CallSetFollowerHome(std::int32_t hq, RE::Actor* actor, bool doClear)
		{
			auto* vm = Vm();
			if (!vm || !g_homeQuest || !actor)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, g_homeQuest);
			if (handle == policy->EmptyHandle())
				return false;

			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(
				std::move(hq),
				std::move(static_cast<RE::Actor*>(actor)),
				std::move(doClear));
			return vm->DispatchMethodCall(handle, kHomeScript, "SetFollowerHome", args, cb);
		}

		/* ----------------------------------------------------- the model --- */

		// One snapshot of everything base-side, rebuilt per call so nothing can
		// go stale across a save load.
		struct Ctx
		{
			RE::BSTSmartPointer<RE::BSScript::Object> home;
			RE::BSTSmartPointer<RE::BSScript::Object> vars;
			RE::TESFaction*                           homeFac = nullptr;
			int                                       maxBases = 0;
			int                                       maxSlots = 0;
			int                                       baseTotal = 0;
			std::vector<std::string>                  names;      // nwsHBNames
			std::vector<std::string>                  homeLabels; // nwsHomeLocNames
			std::vector<std::string>                  workLabels;
			std::vector<std::string>                  relaxLabels;
			std::vector<int>                          homeSet;    // nwsHomeLocSet
			std::vector<RE::TESObjectREFR*>           homeMarkers;
			std::vector<RE::TESObjectREFR*>           workMarkers;
			std::vector<RE::TESObjectREFR*>           relaxMarkers;
			std::vector<RE::Actor*>                   residents;  // homeActors
			bool                                      ok = false;
		};

		// How far the installed script's per-base work/relax flag properties
		// go. Stock NFF declares nwsWorkLocSet_00..19 as twenty SCALARS, so the
		// answer is 20; a plugin that raises the base cap has to add more, and
		// this finds however many it added. Probed once per session — the
		// script's property table does not change while the game runs.
		int WorkFlagLimit(RE::BSScript::Object* home)
		{
			if (g_workFlagLimit >= 0)
				return g_workFlagLimit;
			if (!home)
				return 0;  // not cached: an unbound script must not pin the answer
			int limit = 0;
			for (int i = 0; i < kSaneMaxBases; ++i) {
				char name[32];
				std::snprintf(name, sizeof(name), "nwsWorkLocSet_%02d", i);
				if (!Prop(home, name))
					break;
				limit = i + 1;
			}
			g_workFlagLimit = limit;
			logger::info("nff-bases: script exposes work/relax flags for {} base(s)", limit);
			return limit;
		}

		// Is this base's work (isRelax=false) or relax (true) spot registered?
		//
		// Two sources, deliberately. The FLAG property is NFF's own truth but
		// only exists below WorkFlagLimit(); above it we fall back to the label
		// array, which NFF writes on set and blanks to "None" on clear — a
		// weaker signal, but an honest one, and it is the only one a base past
		// the script's scalar range has.
		bool SecondaryLocSet(const Ctx& ctx, int base, bool isRelax)
		{
			if (base < WorkFlagLimit(ctx.home.get())) {
				char name[32];
				std::snprintf(name, sizeof(name), isRelax ? "nwsPlayLocSet_%02d" : "nwsWorkLocSet_%02d", base);
				return VarInt(Prop(ctx.home.get(), name), 0) != 0;
			}
			const auto& labels = isRelax ? ctx.relaxLabels : ctx.workLabels;
			if (base < 0 || base >= static_cast<int>(labels.size()))
				return false;
			return !IsBlankName(labels[static_cast<std::size_t>(base)]);
		}

		Ctx Resolve()
		{
			Ctx ctx;
			ScanQuests();
			if (!g_homeQuest)
				return ctx;

			ctx.home = BindScript(g_homeQuest, kHomeScript);
			ctx.vars = BindScript(g_varQuest, kVarScript);
			if (!ctx.home)
				return ctx;

			auto* home = ctx.home.get();
			ctx.homeFac = PropFaction(home, "nwsFF_HomeFac");
			if (!ctx.homeFac && ctx.vars)
				ctx.homeFac = PropFaction(ctx.vars.get(), "nwsFF_HomeFac");

			ctx.maxBases = VarInt(Prop(home, "maxBases"), 0);
			ctx.maxSlots = VarInt(Prop(home, "maxHomeSlots"), 0);
			ctx.baseTotal = VarInt(Prop(home, "nwsBaseTotal"), 0);

			ctx.names = ReadStringArray(home, "nwsHBNames");
			ctx.homeLabels = ReadStringArray(home, "nwsHomeLocNames");
			ctx.workLabels = ReadStringArray(home, "nwsWorkLocNames");
			ctx.relaxLabels = ReadStringArray(home, "nwsPlayLocNames");
			ctx.homeSet = ReadIntArray(home, "nwsHomeLocSet");
			ctx.homeMarkers = ReadRefArray(home, "nwsHomeMarkers");
			ctx.workMarkers = ReadRefArray(home, "nwsWorkMarkers");
			ctx.relaxMarkers = ReadRefArray(home, "nwsPlayMarkers");
			ctx.residents = ReadActorArray(home, "homeActors");

			// The property is the cap; the arrays are what actually exists.
			// Trust the SMALLER, so a plugin that raised maxBases without
			// growing an array cannot walk us off the end of it.
			// Parens on min: the Windows min MACRO (leaked in through the SKSE
			// headers) eats the unparenthesised call - see quest_tools.cpp.
			const int arrayBound = static_cast<int>((std::min)(ctx.names.size(), ctx.homeSet.size()));
			if (ctx.maxBases <= 0 || ctx.maxBases > arrayBound)
				ctx.maxBases = arrayBound;
			ctx.maxBases = (std::min)(ctx.maxBases, kSaneMaxBases);
			ctx.maxSlots = std::clamp(ctx.maxSlots, 0, kSaneMaxSlots);

			ctx.ok = ctx.maxBases > 0 && ctx.homeFac != nullptr;
			return ctx;
		}

		// A base's residents: NFF's own homeActors cache, filtered by the
		// faction RANK it files them under. Same read its MCM does
		// (nwsFollowerMCMScript's mCheckBases), so the two cannot disagree.
		std::vector<RE::Actor*> ResidentsOf(const Ctx& ctx, int base)
		{
			std::vector<RE::Actor*> out;
			if (!ctx.homeFac)
				return out;
			for (auto* a : ctx.residents) {
				if (!a || !a->IsInFaction(ctx.homeFac))
					continue;
				if (a->GetFactionRank(ctx.homeFac, false) == base)
					out.push_back(a);
			}
			return out;
		}

		int BaseOf(const Ctx& ctx, RE::Actor* actor)
		{
			if (!actor || !ctx.homeFac || !actor->IsInFaction(ctx.homeFac))
				return -1;
			const auto rank = actor->GetFactionRank(ctx.homeFac, false);
			if (rank < 0 || rank >= ctx.maxBases)
				return -1;
			return rank;
		}

		// The people you could file at a base right now: everyone currently
		// following you. Read off the high-actor list the same way the deck's
		// other party-wide actions do — NFF's own menu offers exactly this set
		// ("$FF_pickCurrent"), because a base is where a CURRENT follower goes
		// when dismissed.
		std::vector<RE::Actor*> Candidates()
		{
			std::vector<RE::Actor*> out;
			auto*                   lists = RE::ProcessLists::GetSingleton();
			if (!lists)
				return out;
			for (auto& h : lists->highActorHandles) {
				auto  ptr = h.get();
				auto* a = ptr ? ptr.get() : nullptr;
				if (!a || a->IsDisabled() || a->IsPlayerRef())
					continue;
				if (!a->IsPlayerTeammate())
					continue;
				out.push_back(a);
			}
			return out;
		}

		json ActorJson(RE::Actor* actor, int base)
		{
			return json{
				{ "formId", HexId(actor->GetFormID()) },
				{ "name", ActorName(actor) },
				{ "dead", actor->IsDead() },
				{ "following", actor->IsPlayerTeammate() },
				{ "base", base },
			};
		}

		// One of a base's three locations, as the view renders it: whether it
		// is registered, the label NFF stored, and where the marker actually
		// stands right now (they differ once you rename a location, and the
		// live place is the useful one).
		json LocJson(const Ctx& ctx, int base, int kind)
		{
			const auto at = [base](const std::vector<std::string>& v) -> std::string {
				if (base < 0 || base >= static_cast<int>(v.size()))
					return {};
				const auto& s = v[static_cast<std::size_t>(base)];
				return IsBlankName(s) ? std::string() : s;
			};
			const auto marker = [base](const std::vector<RE::TESObjectREFR*>& v) -> RE::TESObjectREFR* {
				if (base < 0 || base >= static_cast<int>(v.size()))
					return nullptr;
				return v[static_cast<std::size_t>(base)];
			};

			bool               set = false;
			std::string        label;
			RE::TESObjectREFR* ref = nullptr;
			if (kind == 0) {
				set = base < static_cast<int>(ctx.homeSet.size()) && ctx.homeSet[static_cast<std::size_t>(base)] != 0;
				label = at(ctx.homeLabels);
				ref = marker(ctx.homeMarkers);
			} else if (kind == 1) {
				set = SecondaryLocSet(ctx, base, false);
				label = at(ctx.workLabels);
				ref = marker(ctx.workMarkers);
			} else {
				set = SecondaryLocSet(ctx, base, true);
				label = at(ctx.relaxLabels);
				ref = marker(ctx.relaxMarkers);
			}

			return json{
				{ "set", set },
				{ "label", label },
				{ "place", set ? PlaceNameOfRef(ref) : std::string() },
				// A registered location whose marker never got placed cannot be
				// travelled to; the view greys Visit rather than teleporting
				// somebody into the void.
				{ "placed", ref != nullptr },
			};
		}

		const char* kTimeKeys[] = { "workStart", "workEnd", "relaxStart", "relaxEnd", "sleepStart", "sleepEnd" };
		const char* kTimeProps[] = { "nwsTimeWorkStart", "nwsTimeWorkEnd", "nwsTimeRelaxStart",
			"nwsTimeRelaxEnd", "nwsTimeSleepStart", "nwsTimeSleepEnd" };
		constexpr int kTimeCount = 6;

		// NFF stores each hour as a global whose value indexes its own 24-entry
		// name table ("12 am" == 0), so the value IS the hour.
		json TimesJson(const Ctx& ctx)
		{
			json t = json::object();
			if (!ctx.vars)
				return t;
			for (int i = 0; i < kTimeCount; ++i) {
				auto* g = PropGlobal(ctx.vars.get(), kTimeProps[i]);
				if (g)
					t[kTimeKeys[i]] = std::clamp(static_cast<int>(g->value), 0, 23);
			}
			return t;
		}

		std::string Dump(const json& j)
		{
			// Engine strings can carry cp1252 bytes; dump() must never throw on
			// the way into a PrismaUI Invoke.
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Fail(const std::string& msg)
		{
			return Dump(json{ { "ok", false }, { "msg", msg } });
		}

		std::string Done(const std::string& msg)
		{
			return Dump(json{ { "ok", true }, { "msg", msg } });
		}

		const char* KindWord(int kind)
		{
			return kind == 1 ? "work spot" : (kind == 2 ? "relax spot" : "home");
		}

		// ------------------------------------------------- portal parity ---
		// The Deck Portal (phone) can't reach NFF's VM, so the deck writes the
		// SAME state it hands nbOpen to a snapshot file the phone reads, and the
		// phone queues its edits into an ops file the deck replays through the
		// same Apply() the in-game controls use. Two files, one per direction —
		// deliberately not one shared name, so a read never races a write.
		std::filesystem::path PortalSnapshotFile()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "portal-bases.json";
		}
		std::filesystem::path PortalOpsFile()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "portal-bases-ops.json";
		}

		// Atomic replace: write a temp beside the target and rename over it, so
		// the phone never reads a half-written snapshot (Ultralight/Node both
		// stat+read without locking).
		void WritePortalSnapshot(const std::string& js)
		{
			const auto      file = PortalSnapshotFile();
			std::error_code ec;
			std::filesystem::create_directories(file.parent_path(), ec);
			auto tmp = file;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
				if (!out.is_open())
					return;
				out.write(js.data(), static_cast<std::streamsize>(js.size()));
			}
			std::filesystem::rename(tmp, file, ec);
			if (ec)
				std::filesystem::remove(tmp, ec);   // best effort; next tick retries
		}
	}

	bool Available()
	{
		ScanQuests();
		return g_homeQuest != nullptr;
	}

	std::string StateJson(const std::string& /*reqJson*/)
	{
		const auto ctx = Resolve();

		json out{
			{ "ok", true },
			{ "nff", ctx.ok },
			{ "maxBases", ctx.maxBases },
			{ "maxHomeSlots", ctx.maxSlots },
			{ "residents", ctx.baseTotal },
			{ "workFlagLimit", ctx.ok ? WorkFlagLimit(ctx.home.get()) : 0 },
			{ "allowOwner", ctx.ok ? VarInt(Prop(ctx.home.get(), "nwsAllowOwner"), 0) : 0 },
			{ "times", ctx.ok ? TimesJson(ctx) : json::object() },
			{ "bases", json::array() },
			{ "candidates", json::array() },
			{ "target", nullptr },
		};
		if (!ctx.ok) {
			out["msg"] = Available()
				? "Nether's Follower Framework is here but hasn't set its bases up yet — load a save and open the deck again"
				: "Nether's Follower Framework isn't in this load order";
			const auto js = Dump(out);
			WritePortalSnapshot(js);   // phone sees the honest "not ready" too
			return js;
		}

		int used = 0;
		for (int i = 0; i < ctx.maxBases; ++i) {
			json base{
				{ "i", i },
				{ "name", (i < static_cast<int>(ctx.names.size()) && !IsBlankName(ctx.names[static_cast<std::size_t>(i)]))
						? ctx.names[static_cast<std::size_t>(i)]
						: std::string() },
				{ "home", LocJson(ctx, i, 0) },
				{ "work", LocJson(ctx, i, 1) },
				{ "relax", LocJson(ctx, i, 2) },
				{ "residents", json::array() },
			};
			// A base EXISTS once its home location is registered — that is the
			// same test NFF's own menu counts with (mBaseUsedCount), and it is
			// why a named-but-unplaced slot still reads as free.
			base["used"] = base["home"]["set"].get<bool>();
			if (base["used"].get<bool>())
				++used;
			for (auto* a : ResidentsOf(ctx, i))
				base["residents"].push_back(ActorJson(a, i));
			out["bases"].push_back(std::move(base));
		}
		out["used"] = used;

		for (auto* a : Candidates())
			out["candidates"].push_back(ActorJson(a, BaseOf(ctx, a)));

		// The crosshair NPC at palette-open, so "file who I'm looking at" is one
		// click even when she is not following you.
		if (const auto id = NpcActions::TargetFormID(); id) {
			if (auto* form = RE::TESForm::LookupByID(id)) {
				if (auto* actor = form->As<RE::Actor>())
					out["target"] = ActorJson(actor, BaseOf(ctx, actor));
			}
		}

		const auto js = Dump(out);
		WritePortalSnapshot(js);   // deck -> phone: the Bases model the portal renders
		return js;
	}

	std::string Apply(const std::string& reqJson)
	{
		const auto req = json::parse(reqJson, nullptr, false);
		if (req.is_discarded() || !req.is_object())
			return Fail("Couldn't read that request");
		const auto op = req.value("op", std::string());
		if (op.empty())
			return Fail("No operation given");

		auto ctx = Resolve();
		if (!ctx.ok)
			return Fail(Available()
					? "Nether's Follower Framework hasn't set its bases up yet"
					: "Nether's Follower Framework isn't in this load order");

		auto* home = ctx.home.get();

		// Every op below either names a base or acts on a person filed at one,
		// so the bound check lives here rather than six times over.
		const int base = req.value("base", -1);
		const bool needsBase = (op == "setLoc" || op == "clearLoc" || op == "rename" || op == "label"
			|| op == "assign" || op == "visit");
		if (needsBase && (base < 0 || base >= ctx.maxBases))
			return Fail("That base number doesn't exist");

		const int kind = std::clamp(req.value("kind", 0), 0, 2);

		/* ---- register a location where the player is standing ------------ */
		if (op == "setLoc") {
			const bool  aboveFlags = kind != 0 && base >= WorkFlagLimit(home);
			const auto  place = PlayerPlaceName();
			const char* labelProp = kind == 1 ? "nwsWorkLocNames"
				: (kind == 2                  ? "nwsPlayLocNames"
											  : "nwsHomeLocNames");

			if (aboveFlags) {
				// See the header's ⚠. SetBaseLocation would do the right MoveTo
				// and then call SetMarkerFlag, whose if-chain over twenty scalar
				// properties ends in an `Else` that writes slot 00 — so routing
				// a high base through it registers the spot correctly AND
				// silently tells NFF that base 1 has one.
				//
				// So for those indices we do the part that works and skip the
				// part that is broken. That is the whole of SetBaseLocation
				// minus the flag: move the marker to the player, name the place.
				// Nothing is lost — the flag is read by NFF's own MCM page and
				// by nothing else (verified across its full script set), and
				// the marker is what the follower's packages actually use.
				auto& markers = (kind == 1) ? ctx.workMarkers : ctx.relaxMarkers;
				RE::TESObjectREFR* marker = (base < static_cast<int>(markers.size()))
					? markers[static_cast<std::size_t>(base)]
					: nullptr;
				auto* player = RE::PlayerCharacter::GetSingleton();
				if (!marker)
					return Fail("This base has no "s + KindWord(kind) + " marker to place — the 64-bases plugin supplies those");
				if (!player)
					return Fail("No player to place it against");
				marker->MoveTo(player);
				WriteStringAt(home, labelProp, base, place);
				logger::info("nff-bases: base {} {} set to '{}' (direct: past the script's flag range)",
					base + 1, KindWord(kind), place);
				return Done("Set this base's "s + KindWord(kind) + " to " + place);
			}

			// The two one-shot switches SetBaseLocation reads. Written first
			// because the dispatched call consumes and then clears them, which
			// is exactly how NFF's own menu uses them.
			if (auto* v = Prop(home, "doOwnCell"))
				v->SetBool(kind == 0 && req.value("own", false));
			if (auto* v = Prop(home, "doOwnBeds"))
				v->SetBool(kind == 0 && req.value("ownBeds", false));

			if (!CallHome2("SetBaseLocation", base, kind))
				return Fail("NFF wouldn't take the location change");

			// NFF's menu writes the place's label right after the call, from the
			// player's own cell — do the same, so a base registered from the
			// deck reads identically to one registered from the MCM.
			WriteStringAt(home, labelProp, base, place);
			// A base being set up for the first time gets the place as its name
			// too, so it is never an unnamed row in the list.
			if (kind == 0 && (base >= static_cast<int>(ctx.names.size())
								 || IsBlankName(ctx.names[static_cast<std::size_t>(base)])))
				WriteStringAt(home, "nwsHBNames", base, place);

			logger::info("nff-bases: base {} {} set to '{}'", base + 1, KindWord(kind), place);
			return Done("Set this base's "s + KindWord(kind) + " to " + place);
		}

		/* ---- remove a location (kind 0 tears the base down) -------------- */
		if (op == "clearLoc") {
			// Same asymmetry as setLoc, for the same reason: NFF's own
			// ClearBaseLocation blanks the label AND calls SetMarkerFlag(0,…),
			// which lands on slot 00 for a high base. Above the flag range we
			// do the half that is real — blank the label, which is exactly what
			// StateJson reads as "not set" up there.
			if (kind != 0 && base >= WorkFlagLimit(home)) {
				const char* labelProp = kind == 1 ? "nwsWorkLocNames" : "nwsPlayLocNames";
				if (!WriteStringAt(home, labelProp, base, "None"))
					return Fail("NFF has no room stored for that base");
				logger::info("nff-bases: base {} {} cleared (direct: past the script's flag range)",
					base + 1, KindWord(kind));
				return Done("Cleared this base's "s + KindWord(kind));
			}
			if (!CallHome2("ClearBaseLocation", base, kind))
				return Fail("NFF wouldn't take the change");
			logger::info("nff-bases: base {} {} cleared", base + 1, KindWord(kind));
			return Done(kind == 0
					? "Base removed — everyone filed there has been unassigned"
					: "Cleared this base's "s + KindWord(kind));
		}

		/* ---- names ------------------------------------------------------- */
		if (op == "rename" || op == "label") {
			auto name = Trim(req.value("name", std::string()));
			if (name.size() > kMaxNameLen)
				name = name.substr(0, kMaxNameLen);
			if (name.empty())
				return Fail("Give it a name first");
			const char* prop = "nwsHBNames";
			if (op == "label")
				prop = kind == 1 ? "nwsWorkLocNames" : (kind == 2 ? "nwsPlayLocNames" : "nwsHomeLocNames");
			if (!WriteStringAt(home, prop, base, name))
				return Fail("NFF has no room stored for that base");
			logger::info("nff-bases: base {} {} renamed to '{}'", base + 1,
				op == "label" ? KindWord(kind) : "name", name);
			return Done("Renamed to "s + name);
		}

		/* ---- residents --------------------------------------------------- */
		if (op == "assign" || op == "unassign") {
			auto* actor = ActorById(req.value("formId", std::string()));
			if (!actor)
				return Fail("Couldn't find that person in the game right now");
			if (actor->IsDead())
				return Fail(ActorName(actor) + " is dead");

			if (op == "unassign") {
				const int at = BaseOf(ctx, actor);
				if (at < 0)
					return Fail(ActorName(actor) + " isn't filed at a base");
				if (!CallSetFollowerHome(at, actor, true))
					return Fail("NFF wouldn't take the change");
				logger::info("nff-bases: {} removed from base {}", ActorName(actor), at + 1);
				return Done(ActorName(actor) + " no longer has a base");
			}

			// Assigning to a base that has no home location would file her
			// nowhere — NFF's own menu disables the button in that state.
			if (base >= static_cast<int>(ctx.homeSet.size())
				|| ctx.homeSet[static_cast<std::size_t>(base)] == 0)
				return Fail("Set this base's home location first — stand where you want it and hit Set home");
			// NFF stops adding at maxHomeSlots and returns silently, so say so
			// rather than reporting a success that did nothing.
			if (ctx.maxSlots > 0 && ctx.baseTotal >= ctx.maxSlots && BaseOf(ctx, actor) < 0)
				return Fail("All " + std::to_string(ctx.maxSlots) + " base slots are full — free one first");

			// SetFollowerHome clears her old filing before adding the new one,
			// so this is both "assign" and "move to another base".
			const int from = BaseOf(ctx, actor);
			if (!CallSetFollowerHome(base, actor, false))
				return Fail("NFF wouldn't take the change");
			const std::string baseName = (base < static_cast<int>(ctx.names.size())
											 && !IsBlankName(ctx.names[static_cast<std::size_t>(base)]))
				? ctx.names[static_cast<std::size_t>(base)]
				: ("base " + std::to_string(base + 1));
			logger::info("nff-bases: {} filed at base {} (was {})", ActorName(actor), base + 1, from + 1);
			return Done(ActorName(actor) + (from >= 0 ? " moved to " : " now lives at ") + baseName);
		}

		/* ---- travel ------------------------------------------------------ */
		if (op == "visit") {
			const auto& markers = kind == 1 ? ctx.workMarkers : (kind == 2 ? ctx.relaxMarkers : ctx.homeMarkers);
			RE::TESObjectREFR* marker = (base < static_cast<int>(markers.size()))
				? markers[static_cast<std::size_t>(base)]
				: nullptr;
			if (!marker)
				return Fail("That "s + KindWord(kind) + " hasn't been placed yet");
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player)
				return Fail("No player to move");
			// MoveTo is the only teleport that runs the engine's own cell attach
			// and worldspace transition — the same call NFF's own Visit does.
			player->MoveTo(marker);
			logger::info("nff-bases: travelled to base {} {}", base + 1, KindWord(kind));
			return Done("Travelling to this base's "s + KindWord(kind));
		}

		/* ---- shared tweaks ----------------------------------------------- */
		if (op == "owner") {
			auto* v = Prop(home, "nwsAllowOwner");
			if (!v)
				return Fail("This NFF build has no ownership switch");
			v->SetSInt(req.value("on", false) ? 1 : 0);
			return Done(req.value("on", false)
					? "Bases may claim ownership of what's in them"
					: "Bases will leave ownership alone");
		}

		if (op == "time") {
			if (!ctx.vars)
				return Fail("NFF's settings aren't answering");
			const auto which = req.value("which", std::string());
			for (int i = 0; i < kTimeCount; ++i) {
				if (which != kTimeKeys[i])
					continue;
				auto* g = PropGlobal(ctx.vars.get(), kTimeProps[i]);
				if (!g)
					return Fail("This NFF build has no such time setting");
				const int hour = std::clamp(req.value("value", 0), 0, 23);
				g->value = static_cast<float>(hour);
				logger::info("nff-bases: {} -> {}h", which, hour);
				return Done("Saved");
			}
			return Fail("Unknown time setting");
		}

		return Fail("Unknown operation: " + op);
	}

	// Phone -> deck: drain portal-bases-ops.json, replaying each op through the
	// very same Apply() the in-game controls call — so there is one mutation path
	// to reason about and the portal can do nothing the deck can't. Consume the
	// file whether or not every op stuck (a bad op is logged, not retried forever).
	// Returns true when at least one op was accepted, so the poller re-pushes the
	// live state (which also rewrites the snapshot the phone reads back).
	//
	// MAIN THREAD ONLY — Apply() dispatches NFF Papyrus against live actors.
	bool ApplyPortalOps()
	{
		const auto      file = PortalOpsFile();
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		std::string text;
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open()) {
				// Held open by the portal mid-write: leave it, next tick gets it.
				logger::warn("portal bases-ops present but unreadable — retrying");
				return false;
			}
			text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		const auto  j = json::parse(text, nullptr, false);
		std::size_t applied = 0, skipped = 0;
		if (j.is_discarded() || !j.is_object() || !j.contains("ops") || !j["ops"].is_array()) {
			logger::error("portal bases-ops file is malformed — discarding it");
		} else {
			for (const auto& e : j["ops"]) {
				if (!e.is_object() || !e.contains("op")) { ++skipped; continue; }
				const auto res = json::parse(Apply(e.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace)), nullptr, false);
				if (!res.is_discarded() && res.value("ok", false)) {
					++applied;
					logger::info("portal bases-op '{}' applied: {}",
						e.value("op", std::string("?")), res.value("msg", std::string("")));
				} else {
					++skipped;
					logger::info("portal bases-op '{}' skipped: {}", e.value("op", std::string("?")),
						res.is_discarded() ? std::string("bad reply") : res.value("msg", std::string("?")));
				}
			}
		}

		std::filesystem::remove(file, ec);   // consume either way
		logger::info("portal bases-ops: {} applied, {} skipped", applied, skipped);
		return applied > 0;
	}
}
