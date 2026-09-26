#include "nff_bridge.h"

#include "follower_deck.h"
#include "maras.h"          // marriage state, when M.A.R.A.S is installed
#include "relationship.h"   // the engine's RELA rank with the player
#include "widgets.h"       // PlaceKindOf: the loc-* icon vocabulary, shared

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <format>
#include <string>
#include <unordered_map>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json and the logger.

// wingdi.h (via Windows.h, pulled in by SKSE) #defines GetObject to GetObjectA,
// so `variable->GetObject()` compiles as `GetObjectA()` and fails to resolve.
// RE/V/Variable.h undefines it for its own declaration, but Windows.h is
// re-included after that, so the macro is back by the time this file is parsed.
#ifdef GetObject
#	undef GetObject
#endif

using json = nlohmann::json;

namespace NffBridge
{
	namespace
	{
		// ---------------------------------------------------------------- ids --

		// My Home is Your Home SKSE **NG**. The NG rewrite keeps every activity's
		// marker as a linked ref on the actor, keyed by these keywords — there is
		// no Papyrus state to ask. Local (ESL) ids; TESDataHandler::LookupForm
		// composes the FE-space FormID for a light plugin correctly.
		//
		//   0x800  MHiYHHasHomeFaction   — "this actor has been given a home"
		constexpr RE::FormID  kMhiyhHasHomeFac = 0x800;
		constexpr const char* kMhiyhPlugin = "MHiYH.esl";

		// The eight activity "kinds", numbered exactly as MMTYHNative.psc does —
		// that numbering is the mod's own public API, so it is what we put on the
		// wire and what the view's ACTS spec keys off.
		constexpr int kKindCount = 8;
		enum Kind : int
		{
			kHome = 0,
			kSleep = 1,
			kWork = 2,
			kGuardActive = 3,
			kBreakfast = 4,
			kLunch = 5,
			kDinner = 6,
			kGuardPassive = 7,
		};

		// kind -> marker keyword (MHiYHController.psc GetMarkerKeyword). Note that
		// ACTIVE and PASSIVE guard deliberately SHARE 0x804: one guard post, two
		// ways of standing at it. So this table has a duplicate, not a gap.
		constexpr RE::FormID kMarkerKw[kKindCount] = {
			0x801,  // 0 home
			0x802,  // 1 sleep
			0x803,  // 2 work
			0x804,  // 3 guard (active)
			0x812,  // 4 breakfast
			0x813,  // 5 lunch
			0x814,  // 6 dinner
			0x804,  // 7 guard (passive) — same marker as 3
		};

		// kind -> the quest whose resident aliases NG fills while that activity is
		// the one in force (MHiYHController.psc GetKindQuest). These are what make
		// "doing now" readable without asking anything: NG recomputes the desired
		// activity mask from its own database AND the game clock, then fills these
		// aliases to match. The filled alias IS the mod's own answer to "what is
		// she doing right now", already wrapped-past-midnight and all.
		constexpr RE::FormID kKindQuest[kKindCount] = {
			0x80D,  // 0 home
			0x80E,  // 1 sleep
			0x80F,  // 2 work
			0x810,  // 3 guard (active)
			0x818,  // 4 breakfast
			0x819,  // 5 lunch
			0x81A,  // 6 dinner
			0x81C,  // 7 guard (passive)
		};

		// Nether's Follower Framework 2.8.6.0b. Class names as declared in the
		// decompiled shipped .pex; each of these
		// scripts `Extends Quest`, so the bound object hangs off a quest form.
		constexpr const char* kNffHomeScript = "nwsFollowerHomeScript";
		constexpr const char* kNffSetsScript = "nwsFollowerSetsScript";
		constexpr const char* kNffVarScript = "nwsFollowerVariableScript";

		// The base cap is DETECTED, never assumed. Stock NFF ships nwsPlayLocSet_00
		// ..19 (a cap of 20); Rober runs a personal edit that takes it to 64; a
		// future edit could take it anywhere. Counting how many nwsPlayLocSet_NN
		// scalar properties the bound home script actually declares is the same
		// probe nff_bases.cpp's WorkFlagLimit() uses, and it reads whatever build
		// is loaded rather than hoping a hardcoded number happens to match.
		//
		// kSaneMaxBases is a hard ceiling on the detection loop and on any rank we
		// clamp against — purely so a corrupt property table can never turn into a
		// runaway loop or an absurd bound. It is NOT the cap; the cap is
		// g_baseCap, filled by DetectBaseCap() on first bind. 0 = not yet probed.
		constexpr int kSaneMaxBases = 128;
		int           g_baseCap = 0;

		// ------------------------------------------------------------ one-shots --

		// Log noise control: a missing mod must say so once, not once per palette
		// open for the rest of the session.
		bool g_warnedNoVm = false;
		bool g_warnedNoNff = false;
		bool g_warnedNoMhiyh = false;
		bool g_loggedNffOk = false;
		bool g_loggedMhiyhOk = false;

		// Quest forms are static for the run of the game, so the (one-off) scan
		// that finds them is cached. The bound script OBJECT deliberately is not:
		// it is re-fetched every call, because a save load rebinds it and a stale
		// smart pointer is exactly the kind of thing that turns into a crash.
		RE::TESQuest* g_homeQuest = nullptr;
		RE::TESQuest* g_setsQuest = nullptr;
		RE::TESQuest* g_varQuest = nullptr;
		bool          g_scanned = false;

		// ------------------------------------------------------------- VM utils --

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

		// Bind `form`'s instance of the named Papyrus script, or nullptr.
		//
		// The class name is tried as declared and then lowercased: Papyrus is a
		// case-insensitive language and different toolchains register the type
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

		// The property's backing variable. GetProperty() is the documented route
		// for an `Auto` property; the "::name_var" form is the raw backing
		// variable and covers a build where the property table lookup misses.
		const RE::BSScript::Variable* Prop(RE::BSScript::Object* obj, const char* name)
		{
			if (!obj || !name)
				return nullptr;
			if (const auto* v = obj->GetProperty(name))
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
			const auto sv = v->GetString();
			return std::string(sv);
		}

		int VarInt(const RE::BSScript::Variable* v, int fallback)
		{
			if (!v || !v->IsInt())
				return fallback;
			return static_cast<int>(v->GetSInt());
		}

		// Runtime base cap: count the nwsPlayLocSet_NN scalar properties the bound
		// home script declares, exactly as nff_bases.cpp's WorkFlagLimit() does.
		// Stock NFF stops at _19 (cap 20); a plugin that raises the cap grows this
		// family. Cached in g_baseCap for the run of the game — a script's property
		// table does not change while the game runs — and logged once. Falls back
		// to the array bound the caller already knows (baseNames) if the property
		// probe finds nothing, so a script that ever renamed the family still gives
		// an honest, non-zero answer instead of refusing every base.
		int DetectBaseCap(RE::BSScript::Object* home, int arrayBound)
		{
			if (g_baseCap > 0)
				return g_baseCap;
			if (!home)
				return 0;  // unbound: must not pin the answer for the whole session
			int count = 0;
			for (int i = 0; i < kSaneMaxBases; ++i) {
				char name[32];
				std::snprintf(name, sizeof(name), "nwsPlayLocSet_%02d", i);
				if (!Prop(home, name))
					break;
				count = i + 1;
			}
			if (count <= 0)
				count = arrayBound;  // family absent/renamed — trust what exists
			if (count <= 0)
				return 0;            // nothing to go on yet — try again next call
			count = (std::min)(count, kSaneMaxBases);
			g_baseCap = count;
			logger::info("nff: detected base cap = {} (nwsPlayLocSet_NN family; stock 20)",
				g_baseCap);
			return g_baseCap;
		}

		// The last detected cap, for readers that do not have the home object in
		// hand (HomeIndexOf/SetBase). kSaneMaxBases while undetected so a rank NFF
		// itself wrote is never rejected before we have counted — the array-bounds
		// check at the real use site is the tight gate.
		int BaseCap()
		{
			return g_baseCap > 0 ? g_baseCap : kSaneMaxBases;
		}

		// A form held in an object variable. The handle carries its own type, so
		// the type is checked before it is decoded rather than trusted.
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

		// An ObjectReference variable's handle carries the concrete form type, and
		// a placed NPC is an ACHR, not a REFR — so both are tried before giving up.
		RE::TESObjectREFR* VarRef(const RE::BSScript::Variable* v)
		{
			auto* form = VarForm(v, RE::FormType::Reference);
			if (!form)
				form = VarForm(v, RE::FormType::ActorCharacter);
			return form ? form->As<RE::TESObjectREFR>() : nullptr;
		}

		RE::TESFaction* PropFaction(RE::BSScript::Object* obj, const char* name)
		{
			auto* form = VarForm(Prop(obj, name), RE::FormType::Faction);
			return form ? form->As<RE::TESFaction>() : nullptr;
		}

		std::vector<std::string> PropStringArray(RE::BSScript::Object* obj, const char* name)
		{
			std::vector<std::string> out;
			const auto*              v = Prop(obj, name);
			if (!v || !v->IsArray())
				return out;
			auto arr = v->GetArray();
			if (!arr)
				return out;
			const auto n = arr->size();
			out.reserve(n);
			for (std::uint32_t i = 0; i < n; ++i)
				out.push_back(VarString(&(*arr)[i]));
			return out;
		}

		std::vector<RE::TESObjectREFR*> PropRefArray(RE::BSScript::Object* obj, const char* name)
		{
			std::vector<RE::TESObjectREFR*> out;
			const auto*                     v = Prop(obj, name);
			if (!v || !v->IsArray())
				return out;
			auto arr = v->GetArray();
			if (!arr)
				return out;
			const auto n = arr->size();
			out.reserve(n);
			for (std::uint32_t i = 0; i < n; ++i)
				out.push_back(VarRef(&(*arr)[i]));
			return out;
		}

		// ----------------------------------------------------------- name utils --

		// Same shape as PlaceActions::NameOfForm — full name, else editor id.
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

		// Human name for a place, given the reference that marks it. Cell name
		// first (that is what a house IS called: "Breezehome"), then the location,
		// then the ref's own name, then the worldspace.
		//
		// Everything is null-gated: a marker in an unloaded cell can have a null
		// parentCell, and GetCurrentLocation() walks the parent cell, so it is
		// only asked when there is one.
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
			const auto* disp = ref->GetDisplayFullName();
			if (disp && disp[0])
				return disp;
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

		// NFF blanks a freed base slot by writing the literal string "None"
		// (nwsFollowerHomeScript line 442), so that is not a name either.
		bool IsBlankName(const std::string& s)
		{
			if (s.empty())
				return true;
			const auto l = Lower(s);
			return l == "none" || l == "n/a" || l == "-";
		}

		// --------------------------------------------------------------- scan ----

		// Find the quest each NFF script is attached to. One pass over the quest
		// form array; the forms are cached, so a hit costs nothing after the first
		// palette open. A miss is re-tried (cheaply) on the next call, because the
		// VM has no bound objects at all until a save is loaded.
		void ScanNffQuests()
		{
			if (g_scanned && g_homeQuest)
				return;

			auto* vm = Vm();
			if (!vm) {
				if (!g_warnedNoVm) {
					g_warnedNoVm = true;
					logger::warn("nff: no Papyrus VM — NFF data unavailable");
				}
				return;
			}
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;

			RE::TESQuest* home = nullptr;
			RE::TESQuest* sets = nullptr;
			RE::TESQuest* vars = nullptr;
			std::size_t   seen = 0;

			for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
				if (!q)
					continue;
				++seen;
				if (!home && BindScript(q, kNffHomeScript))
					home = q;
				if (!sets && BindScript(q, kNffSetsScript))
					sets = q;
				if (!vars && BindScript(q, kNffVarScript))
					vars = q;
				if (home && sets && vars)
					break;
			}

			g_homeQuest = home;
			g_setsQuest = sets;
			g_varQuest = vars;
			g_scanned = true;

			if (!home) {
				if (!g_warnedNoNff) {
					g_warnedNoNff = true;
					logger::info("nff: {} not bound on any of {} quests — Nether's Follower "
								 "Framework absent or no save loaded yet; home column stays empty",
						kNffHomeScript, seen);
				}
				return;
			}
			if (!g_loggedNffOk) {
				g_loggedNffOk = true;
				logger::info("nff: home script on quest {:08X}, sets {}, variables {}",
					static_cast<std::uint32_t>(home->GetFormID()),
					sets ? "found" : "MISSING", vars ? "found" : "MISSING");
			}
		}

		// ----------------------------------------------------------- MHiYH NG ----

		struct MhiyhCtx
		{
			RE::BGSKeyword* kw[kKindCount] = {};   // kind -> marker keyword
			RE::TESFaction* hasHomeFac = nullptr;

			// quest FormID -> kind, for the reverse lookup off an actor's alias
			// instances. A map rather than a scan because it is hit once per
			// alias instance per member.
			std::unordered_map<RE::FormID, int> questKind;

			// The home keyword is the one thing the original chip needs.
			RE::BGSKeyword* homeKw() const { return kw[kHome]; }
		};

		MhiyhCtx ResolveMhiyh()
		{
			MhiyhCtx c;
			auto*    dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return c;

			// LookupForm returns null when the plugin is not in this load order —
			// that is the whole soft-dependency check, no exception, no crash.
			// Every kind is resolved independently: a future NG that drops one
			// keyword must cost us that one activity, not all eight.
			for (int k = 0; k < kKindCount; ++k) {
				if (auto* f = dh->LookupForm(kMarkerKw[k], kMhiyhPlugin))
					c.kw[k] = f->As<RE::BGSKeyword>();
				if (auto* f = dh->LookupForm(kKindQuest[k], kMhiyhPlugin)) {
					if (auto* q = f->As<RE::TESQuest>())
						c.questKind[q->GetFormID()] = k;
				}
			}
			if (auto* f = dh->LookupForm(kMhiyhHasHomeFac, kMhiyhPlugin))
				c.hasHomeFac = f->As<RE::TESFaction>();

			if (!c.homeKw()) {
				if (!g_warnedNoMhiyh) {
					g_warnedNoMhiyh = true;
					logger::info("mhiyh: {} {:03X} not resolvable — My Home is Your Home NG "
								 "absent; its home column stays empty",
						kMhiyhPlugin, kMarkerKw[kHome]);
				}
			} else if (!g_loggedMhiyhOk) {
				g_loggedMhiyhOk = true;
				int kws = 0;
				for (int k = 0; k < kKindCount; ++k)
					if (c.kw[k])
						++kws;
				logger::info("mhiyh: home keyword {:08X}; {}/{} activity keywords, {}/{} "
							 "activity quests resolved",
					static_cast<std::uint32_t>(c.homeKw()->GetFormID()), kws, kKindCount,
					c.questKind.size(), kKindCount);
			}
			return c;
		}

		// Which activities NG has in force for this actor RIGHT NOW, as a bitmask
		// over Kind.
		//
		// Read from the actor's own alias-instance list rather than by walking the
		// eight quests' 1000 resident aliases each: an alias instance is the
		// engine's record of "this ref is currently filling that quest's alias",
		// so the answer is a handful of pointer reads per member instead of eight
		// thousand handle resolutions per palette open.
		//
		// Zero Papyrus. NG has already done the clock arithmetic (including the
		// windows that wrap past midnight) to decide these; we are reading its
		// conclusion, not re-deriving it, so we cannot disagree with the packages
		// the NPC is actually running.
		std::uint32_t ActiveKindMask(RE::Actor* actor, const MhiyhCtx& mh)
		{
			if (!actor || mh.questKind.empty())
				return 0;

			auto* arr = actor->extraList.GetByType<RE::ExtraAliasInstanceArray>();
			if (!arr)
				return 0;  // in no aliases at all — nothing in force

			std::uint32_t mask = 0;
			// The array is mutated by the scheduler on its own thread; take the
			// read lock it carries rather than racing a batch mid-apply.
			RE::BSReadLockGuard locker(arr->lock);
			for (auto* inst : arr->aliases) {
				if (!inst || !inst->quest)
					continue;
				const auto it = mh.questKind.find(inst->quest->GetFormID());
				if (it != mh.questKind.end())
					mask |= (1u << it->second);
			}
			return mask;
		}

		// The MHiYH slice for ONE actor — the object StateJson files under
		// "mhiyh". Every activity's marker is resolved to a human place name with
		// the SAME chain the Domains pane names a mark with (PlaceNameOfRef ->
		// cell -> location -> ref -> worldspace). One naming scheme in this
		// plugin, not two.
		//
		// The linked refs ARE the answer, so they are read unconditionally: the
		// HasHome faction is only carried alongside as corroboration. Gating the
		// reads on that faction would trade a cheap lookup for a silent total
		// failure if NG ever stops maintaining it.
		//
		// `geometry` adds the marker's cell + coordinates to every stop (and the
		// home), for the Residents mode, which matches stops to Domains marks by
		// POSITION rather than by name. Null when NG holds nothing for her.
		json MhiyhEntry(RE::Actor* actor, const MhiyhCtx& mh, bool geometry)
		{
			if (!actor || !mh.homeKw())
				return json(nullptr);
			const std::uint32_t nowMask = ActiveKindMask(actor, mh);

			auto describe = [&](RE::TESObjectREFR* ref, json& a) {
				auto name = PlaceNameOfRef(ref);
				a["place"] = name.empty() ? "Somewhere" : name;
				if (!geometry)
					return;
				auto*      cell = ref->GetParentCell();
				auto*      world = ref->GetWorldspace();
				const auto pos = ref->GetPosition();
				a["cellId"] = cell ? static_cast<std::uint32_t>(cell->GetFormID()) : 0u;
				a["cellName"] = cell ? NameOfForm(cell) : std::string();
				a["worldspaceId"] = world ? static_cast<std::uint32_t>(world->GetFormID()) : 0u;
				a["worldspaceName"] = world ? NameOfForm(world) : std::string();
				a["interior"] = cell ? cell->IsInteriorCell() : (world == nullptr);
				a["x"] = pos.x;
				a["y"] = pos.y;
				a["z"] = pos.z;
				a["markerId"] = static_cast<std::uint32_t>(ref->GetFormID());
			};

			json acts = json::array();
			json now = json::array();
			for (int k = 0; k < kKindCount; ++k) {
				const bool active = (nowMask & (1u << k)) != 0;
				if (active)
					now.push_back(k);

				auto* ref = mh.kw[k] ? actor->GetLinkedRef(mh.kw[k]) : nullptr;
				if (!ref && !active)
					continue;  // not configured and not in force — say nothing

				// An activity can be in force with an unreadable marker (its cell
				// not loaded, its plugin gone). That is still worth showing — the
				// view renders a nameless place rather than dropping the row and
				// pretending she is doing nothing.
				json a{ { "k", k }, { "now", active } };
				if (ref)
					describe(ref, a);
				acts.push_back(std::move(a));
			}

			auto* homeRef = actor->GetLinkedRef(mh.homeKw());
			if (!homeRef && acts.empty())
				return json(nullptr);

			json home(nullptr);
			if (homeRef) {
				home = json{ { "name", "" } };
				describe(homeRef, home);
				home["name"] = home["place"];
				home.erase("place");
			}
			return json{
				{ "home", std::move(home) },
				{ "flagged", mh.hasHomeFac ? actor->IsInFaction(mh.hasHomeFac) : false },
				{ "acts", std::move(acts) },
				{ "now", std::move(now) },
			};
		}

		// --------------------------------------------------------------- NFF ctx --

		// One snapshot of everything NFF-side that is the same for every member,
		// rebuilt per call so nothing can go stale across a save load.
		struct NffCtx
		{
			RE::TESFaction*                 homeFac = nullptr;
			RE::TESFaction*                 outfitFac = nullptr;
			RE::TESFaction*                 storedFac = nullptr;
			RE::TESFaction*                 followerFac = nullptr;
			// Per-follower sandbox opt-out. NFF's OWN MCM checkbox is a rank
			// flip on this faction (nwsFollowerMCMExScript:1164 does literally
			// `1 - GetFactionRank`), and its readers treat "not in the faction
			// OR rank >= 1" as allowed, rank 0 as excluded.
			RE::TESFaction*                 boxFac = nullptr;
			std::vector<std::string>        baseNames;
			std::vector<RE::TESObjectREFR*> baseMarkers;
			bool                            ok = false;
		};

		NffCtx ResolveNff()
		{
			NffCtx ctx;
			ScanNffQuests();
			if (!g_homeQuest)
				return ctx;

			if (auto home = BindScript(g_homeQuest, kNffHomeScript); home) {
				ctx.homeFac = PropFaction(home.get(), "nwsFF_HomeFac");
				ctx.baseNames = PropStringArray(home.get(), "nwsHBNames");
				ctx.baseMarkers = PropRefArray(home.get(), "nwsHomeMarkers");
				// Detect the real cap now that the script is bound, using the name
				// array as the fallback bound. Cached + logged once inside.
				DetectBaseCap(home.get(), static_cast<int>(ctx.baseNames.size()));
			}
			if (auto sets = BindScript(g_setsQuest, kNffSetsScript); sets) {
				ctx.outfitFac = PropFaction(sets.get(), "nwsFF_OutfitFac");
				ctx.storedFac = PropFaction(sets.get(), "nwsFF_storedFac");
			}
			// Braces matter here: this `if` used to be a one-liner, so adding a
			// second read under it put that read OUTSIDE the scope that declares
			// `vars`. Caught by the compiler, but the shape is worth keeping
			// explicit — a brace-less if with a second line silently attached is
			// how this reads as working.
			if (auto vars = BindScript(g_varQuest, kNffVarScript); vars) {
				ctx.followerFac = PropFaction(vars.get(), "nwsFF_FollowerFac");
				ctx.boxFac = PropFaction(vars.get(), "nwsFF_BoxFaction");
			}

			// Home faction is the one thing the feature genuinely needs; the rest
			// are extras that are allowed to be missing.
			ctx.ok = ctx.homeFac != nullptr;
			return ctx;
		}

		// A follower's NFF home base index. NFF writes it with
		// `SetFactionRank(nwsFF_HomeFac, myHQ)`, so the rank IS the index; not
		// being in the faction means no base assigned.
		int HomeIndexOf(RE::Actor* actor, RE::TESFaction* fac)
		{
			if (!actor || !fac || !actor->IsInFaction(fac))
				return -1;
			const auto rank = actor->GetFactionRank(fac, false);
			if (rank < 0 || rank > BaseCap())
				return -1;
			return rank;
		}

		// ------------------------------------------------------------- plumbing --

		std::string Dump(const json& j)
		{
			// Engine strings can carry cp1252 bytes; dump() must never throw on the
			// way into a PrismaUI Invoke.
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// "0x0001A6A1" / "1A6A1" -> 0x0001A6A1. Returns 0 on anything unusable
		// (an unresolved FO member sends "").
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

		// Every formId in an FO Deck API envelope, in roster order, de-duplicated
		// (one person can be filed in several categories).
		//
		// TWO ids per row, and they are not the same question. `stored` is what
		// FO holds and the KEY every reader looks this payload up by. `live` is
		// present only when FO had to store a BASE record — a follower spawned at
		// runtime, whose 0xFF reference has no source file to name — and is the
		// reference it went and found for that base (FO DeckAPI.cpp,
		// LoadedActorForBase). Without it the row resolves to a form and never an
		// actor, and everything below was skipped for someone standing in front
		// of you.
		struct MemberId
		{
			std::string stored, live;
		};

		std::vector<MemberId> MemberIds(const std::string& foStateJson)
		{
			std::vector<MemberId> ids;
			const auto               env = json::parse(foStateJson, nullptr, false);
			if (env.is_discarded() || !env.is_object())
				return ids;
			const json& state = env.contains("state") && env["state"].is_object() ? env["state"] : env;
			if (!state.contains("categories") || !state["categories"].is_array())
				return ids;

			std::unordered_map<std::string, bool> seen;
			for (const auto& cat : state["categories"]) {
				if (!cat.is_object() || !cat.contains("members") || !cat["members"].is_array())
					continue;
				for (const auto& m : cat["members"]) {
					if (!m.is_object())
						continue;
					const auto id = m.value("formId", std::string(""));
					if (id.empty() || seen.count(id))
						continue;
					seen[id] = true;
					ids.push_back(MemberId{ id, m.value("liveFormId", std::string("")) });
				}
			}
			return ids;
		}

		/* ---- the follower Follower Organizer could not store ---------------
		 *
		 *  FO persists a member as an EditorID or "localId~Plugin.esp", and a
		 *  follower SPAWNED at runtime has NEITHER: a 0xFF reference has no
		 *  source file, so FO's FormToString() returns "" and Member's
		 *  serializer falls back to her BASE NPC_ record. Her roster row then
		 *  resolves to a form that is not a reference, FO answers
		 *  `inWorld:false` about somebody standing in front of you, and every
		 *  decoration in the loop below used to be skipped for her — no home,
		 *  no day, no "where she is", no relationship.
		 *
		 *  Proven 2026-09-20: Kali, filed as "00_DemonKali" (the NPC_ in
		 *  Demon Kali.esp, id 0xFEBC8815), her card missing the whole Home
		 *  group. Rober: "weirdly no home tab options for this f7 on an npc?"
		 *
		 *  So when a row hands us a BASE actor, go and find HER — the loaded
		 *  actor wearing that base. Bounded by the four process arrays, and
		 *  paid only for rows that failed to resolve as a reference (a handful
		 *  out of ~70). The reference we find is reported to the view as
		 *  `liveId`, because that, not the stored id, is what every actor-keyed
		 *  op has to be addressed at.
		 *
		 *  Template-aware, the same way npc_finder's FindLoaded is: a spawned
		 *  copy can be a templated child of the stored base. A LIVING match
		 *  wins outright; a corpse is the fallback, because "she is dead over
		 *  there" is still a true answer about where she is.
		 */
		bool BaseIsOrDescendsFrom(RE::TESNPC* base, RE::TESNPC* want)
		{
			for (int guard = 0; base && guard < 8; ++guard) {
				if (base == want)
					return true;
				auto* t = base->baseTemplateForm;
				base = t ? t->As<RE::TESNPC>() : nullptr;
			}
			return false;
		}

		RE::Actor* LoadedActorForBase(RE::TESNPC* want)
		{
			auto* pl = RE::ProcessLists::GetSingleton();
			if (!pl || !want)
				return nullptr;
			const RE::BSTArray<RE::ActorHandle>* arrays[4] = {
				&pl->highActorHandles, &pl->middleHighActorHandles,
				&pl->middleLowActorHandles, &pl->lowActorHandles
			};
			RE::Actor* corpse = nullptr;
			for (const auto* arr : arrays) {
				for (const auto& h : *arr) {
					auto a = h.get();
					if (!a)
						continue;
					if (!BaseIsOrDescendsFrom(a->GetActorBase(), want))
						continue;
					if (a->IsDead()) {
						if (!corpse)
							corpse = a.get();
						continue;
					}
					return a.get();
				}
			}
			return corpse;
		}
	}

	bool Available()
	{
		ScanNffQuests();
		return g_homeQuest != nullptr;
	}

	bool MhiyhAvailable()
	{
		return ResolveMhiyh().homeKw() != nullptr;
	}

	std::string MhiyhActorJson(RE::Actor* actor)
	{
		const auto mh = ResolveMhiyh();
		return Dump(MhiyhEntry(actor, mh, /*geometry=*/ true));
	}

	RE::BGSKeyword* MhiyhMarkerKeyword(int kind)
	{
		if (kind < 0 || kind >= kKindCount)
			return nullptr;
		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh)
			return nullptr;
		// LookupForm composes the FE-space id for a light plugin and returns
		// null (not an error) when the plugin is absent — the whole soft
		// dependency, same as everywhere else in this file.
		auto* f = dh->LookupForm(kMarkerKw[kind], kMhiyhPlugin);
		return f ? f->As<RE::BGSKeyword>() : nullptr;
	}

	/* ---------------- NFF's own "allow sandboxing" switch -----------------
	 *  nwsAllowSandbox is a GlobalVariable property on nwsFollowerVariableScript
	 *  — the quest this file already binds — and it is what NFF's own MCM
	 *  toggle writes. nwsFollowerSandboxScript reads it first thing every tick:
	 *
	 *      Int doSandbox = varScript.nwsAllowSandbox.GetValue() as Int
	 *      If doSandbox == 0 ... Return
	 *
	 *  so 0 really is "off", and >= 2 additionally enables auto-boxing indoors
	 *  and in towns. A global is a plain float, so this is a read/write of a
	 *  value — NOT a Papyrus call, which is exactly the shape this file exists
	 *  to prefer.
	 *
	 *  Distinct from the party orders in nff_control: those say "relax NOW",
	 *  this says "may they relax at all". Rober went looking for the second
	 *  one and found only the first.
	 */
	RE::TESGlobal* SandboxGlobal()
	{
		ResolveNff();  // populates g_varQuest on first use
		auto vars = BindScript(g_varQuest, kNffVarScript);
		if (!vars)
			return nullptr;
		auto* f = VarForm(Prop(vars.get(), "nwsAllowSandbox"), RE::FormType::Global);
		return f ? f->As<RE::TESGlobal>() : nullptr;
	}

	/* ---- per-follower sandbox opt-out ------------------------------------
	 *  NFF's own MCM checkbox, not an approximation of one. Its readers agree
	 *  on the rule (nwsFollowerMCMScript:1284, nwsFollowerSettingsScript:279):
	 *
	 *      !IsInFaction(nwsFF_BoxFaction) || GetFactionRank(...) >= 1   -> may sandbox
	 *
	 *  so rank 0 is the exclusion and "not in the faction at all" is the
	 *  default-allowed state. The MCM toggle itself is literally
	 *  `SetFactionRank(box, 1 - GetFactionRank(box))` (MCMExScript:1182), which
	 *  is what SetSandboxAllowedFor writes.
	 *
	 *  A faction rank, so this is a read/write of actor state — no Papyrus.
	 *  Distinct again from the other two sandbox questions: the global says
	 *  "may ANYONE relax", the party orders say "relax NOW", this says "is SHE
	 *  included".
	 */
	bool SandboxAllowedFor(RE::Actor* actor)
	{
		const auto nff = ResolveNff();
		if (!actor || !nff.boxFac)
			return true;                       // no data: NFF's own default
		if (!actor->IsInFaction(nff.boxFac))
			return true;
		return actor->GetFactionRank(nff.boxFac, false) >= 1;
	}

	/* ---------------------------------------------------------------------
	 *  Does NFF ITSELF hold her as a follower?
	 *
	 *  Not the same question as Actor::IsPlayerTeammate(), which is what the
	 *  rest of the deck calls "following". NFF puts its followers in
	 *  nwsFF_FollowerFac and keeps them there through states the engine does
	 *  not count as teammate — the case Rober hit on 2026-09-10, where the
	 *  card offered Recruit to someone NFF was already managing as a follower
	 *  and no Dismiss was reachable at all.
	 *
	 *  Read the way everything else in this file is read: the faction comes
	 *  off a BOUND SCRIPT PROPERTY, never a hardcoded FormID (NFF's ids move
	 *  between versions) and never a Papyrus call (this rig has a documented
	 *  CTD bucket in the native-call path — see the header).
	 *
	 *  False when NFF is absent, no save is loaded, or the property could not
	 *  be read: an unknown answer must never read as "yes, she is following",
	 *  because that is the answer that puts an armed Dismiss on the card.
	 * ------------------------------------------------------------------- */
	bool IsNffFollower(RE::Actor* actor)
	{
		const auto nff = ResolveNff();
		if (!actor || !nff.followerFac)
			return false;
		return actor->IsInFaction(nff.followerFac);
	}

	int NffSlotOf(RE::Actor* actor)
	{
		// Vanilla's DialogueFollower: NFF extends it rather than shipping its
		// own follower quest, so the record is Skyrim.esm's. Alias 0/1 are the
		// vanilla follower + animal; 2.. are NFF's FollowerExtra slots.
		constexpr RE::FormID kDialogueFollower = 0x000750BA;
		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!actor || !dh || !dh->LookupModByName("nwsFollowerFramework.esp"))
			return -1;
		auto* arr = actor->extraList.GetByType<RE::ExtraAliasInstanceArray>();
		if (!arr)
			return -1;
		RE::BSReadLockGuard locker(arr->lock);
		for (auto* inst : arr->aliases) {
			if (!inst || !inst->quest || !inst->alias)
				continue;
			const auto id = static_cast<int>(inst->alias->aliasID);
			if (inst->quest->GetFormID() == kDialogueFollower) {
				if (id >= 2)
					return id;
				continue;
			}
			const char* eid = inst->quest->GetFormEditorID();
			if (eid && std::string_view(eid).starts_with("nwsFollowerPack"))
				return id;
		}
		return -1;
	}

	bool SetSandboxAllowedFor(RE::Actor* actor, bool allow)
	{
		const auto nff = ResolveNff();
		if (!actor || !nff.boxFac)
			return false;
		// AddToFaction(faction, rank) is the whole operation in CommonLibSSE —
		// there is no Actor::SetFactionRank, and adding someone already in the
		// faction just rewrites their rank. So this is correct whether or not
		// NFF has ever touched her, which is the case that matters: "not in the
		// faction at all" is the default-allowed state we may be leaving.
		actor->AddToFaction(nff.boxFac, allow ? 1 : 0);
		logger::info("nff: per-actor sandbox {} for {:08X}",
			allow ? "allowed" : "blocked", actor->GetFormID());
		return true;
	}

	int SandboxLevel()
	{
		auto* g = SandboxGlobal();
		return g ? static_cast<int>(g->value) : -1;   // -1 = unknown / NFF absent
	}

	bool SetSandboxLevel(int level)
	{
		auto* g = SandboxGlobal();
		if (!g)
			return false;
		if (level < 0)
			level = 0;
		if (level > 3)
			level = 3;
		g->value = static_cast<float>(level);
		logger::info("nff: sandboxing set to {}", level);
		return true;
	}

	// The same two lookups StateJson does, stopping at the REFERENCE instead of
	// turning it into a place name — see the header for why that difference
	// matters. Deliberately re-resolves the contexts per call rather than
	// caching: this runs once on a button press, and a stale marker array after
	// a save load would move someone to the wrong province.
	RE::TESObjectREFR* HomeRefFor(RE::Actor* actor, const std::string& which)
	{
		if (!actor)
			return nullptr;

		if (which == "mhiyh") {
			const auto mh = ResolveMhiyh();
			auto* kw = mh.homeKw();
			return kw ? actor->GetLinkedRef(kw) : nullptr;
		}

		if (which == "nff") {
			const auto nff = ResolveNff();
			if (!nff.ok)
				return nullptr;
			const int idx = HomeIndexOf(actor, nff.homeFac);
			if (idx < 0 || idx >= static_cast<int>(nff.baseMarkers.size()))
				return nullptr;
			return nff.baseMarkers[idx];
		}

		return nullptr;
	}

	// Assign (or clear) a follower's NFF home base. This is deliberately the
	// exact inverse of HomeIndexOf: NFF stores the base as her RANK in
	// nwsFF_HomeFac ("SetFactionRank(nwsFF_HomeFac, myHQ)" in its own script),
	// so writing that rank is not a trick — it is the same thing NFF's dialogue
	// does, and NFF reads it back through the same faction on its next check.
	// index < 0 removes her from the faction entirely = "no base".
	bool SetBase(RE::Actor* actor, int index, std::string& err)
	{
		if (!actor) {
			err = "Couldn't find that person in the game right now";
			return false;
		}
		const auto nff = ResolveNff();
		if (!nff.ok) {
			err = "Nether's Follower Framework isn't answering";
			return false;
		}
		if (index >= 0) {
			if (index > BaseCap() || index >= static_cast<int>(nff.baseNames.size())
				|| nff.baseNames[static_cast<std::size_t>(index)].empty()) {
				err = "That home base isn't set up";
				return false;
			}
		}
		// AddToFaction is add-or-update: on someone already in the faction it
		// rewrites the rank, which is exactly the reassign case.
		actor->AddToFaction(nff.homeFac, static_cast<std::int8_t>(index < 0 ? -1 : index));
		if (index < 0) {
			// Rank -1 is "not a member" to NFF's own read (HomeIndexOf rejects a
			// negative rank), so this genuinely means "no home base".
			logger::info("nff: cleared home base for '{}'", actor->GetName());
		} else {
			logger::info("nff: home base for '{}' -> {} (rank {})", actor->GetName(),
				nff.baseNames[static_cast<std::size_t>(index)], index);
		}
		return true;
	}

	std::string StateJson(const std::string& foStateJson)
	{
		const auto nff = ResolveNff();
		const auto mh = ResolveMhiyh();

		json out{
			{ "ok", true },
			{ "nff", nff.ok },
			{ "mhiyh", mh.homeKw() != nullptr },
			// NFF's allow-sandboxing switch, so the card can show its STATE
			// rather than offering a toggle that might already be where you
			// want it. -1 means "no answer" (NFF absent / no save) and the
			// view hides the control entirely rather than guessing "off".
			{ "sandbox", SandboxLevel() },
			// The DETECTED base cap of whatever NFF build is loaded (stock 20,
			// Rober's edit 64, anything else) — same number nff_bases.cpp exports
			// as maxBases, derived here by counting the script's nwsPlayLocSet_NN
			// family rather than a hardcoded constant.
			{ "maxBases", nff.ok ? BaseCap() : 0 },
			{ "members", json::object() },
			// The player's registered NFF home bases, so the deck can offer the
			// same choice NFF's dialogue does instead of only REPORTING which one
			// she has. Index is the payload: it is the faction rank NFF itself
			// writes, so it is what SetBase() takes back.
			{ "bases", json::array() },
		};
		for (std::size_t i = 0; i < nff.baseNames.size() && i < static_cast<std::size_t>(BaseCap()) + 1; ++i) {
			const bool placed = i < nff.baseMarkers.size() && nff.baseMarkers[i];
			// An unnamed slot is one the player has never set up. Listing it would
			// offer a home that does not exist; NFF's own menu hides them too.
			if (nff.baseNames[i].empty())
				continue;
			out["bases"].push_back(json{
				{ "index", static_cast<int>(i) },
				{ "name", nff.baseNames[i] },
				{ "placed", placed },
			});
		}
		// NOTE there is deliberately NO "neither mod is installed, bail" shortcut
		// any more. There used to be one, and it was right while every decoration
		// in this loop came from NFF or My Home is Your Home. The relationship
		// rank below comes from the ENGINE, so it is available on a load order
		// with neither mod — and the loop is bounded by the roster FO already
		// gave us, so the cost of not bailing is one array walk per follower.

		std::size_t withNffHome = 0, withMhHome = 0, withNow = 0, withSpouse = 0;
		// How many rows were only readable because we went and found the live
		// actor behind a stored BASE form. Non-zero is normal on this rig (a
		// spawned follower), but a jump means FO has stopped storing references.
		std::size_t repaired = 0;

		for (const auto& member : MemberIds(foStateJson)) {
			const auto& idStr = member.stored;
			const auto id = ParseFormId(idStr);
			if (!id)
				continue;
			auto* form = RE::TESForm::LookupByID(id);
			auto* refr = form ? form->As<RE::TESObjectREFR>() : nullptr;
			auto* actor = refr ? refr->As<RE::Actor>() : nullptr;
			// A BASE form is not nothing to read any more - it is somebody FO
			// could not store a reference for. FO itself now names the live
			// reference (`liveFormId`); the local scan below stays as the
			// fallback for a mismatched pair of DLLs, since these two ship as a
			// matched set but nothing physically enforces it.
			std::string liveId;
			if (!actor && !member.live.empty()) {
				if (const auto lid = ParseFormId(member.live)) {
					auto* lform = RE::TESForm::LookupByID(lid);
					auto* lrefr = lform ? lform->As<RE::TESObjectREFR>() : nullptr;
					if (auto* la = lrefr ? lrefr->As<RE::Actor>() : nullptr) {
						actor = la;
						liveId = member.live;
						++repaired;
					}
				}
			}
			if (!actor) {
				if (auto* npc = form ? form->As<RE::TESNPC>() : nullptr) {
					if (auto* live = LoadedActorForBase(npc)) {
						actor = live;
						liveId = std::format("0x{:08X}", live->GetFormID());
						++repaired;
					}
				}
			}
			if (!actor)
				continue;  // unresolved member, and not a base anyone is wearing

			json entry = json::object();
			// FIRST, so it survives even a member with nothing else to say:
			// without it every actor-keyed op on her row addresses the base and
			// is refused (MHiYH's Apply resolves formId -> REFR -> Actor).
			if (!liveId.empty())
				entry["liveId"] = liveId;
			json jest;

			// ---- where she actually IS -------------------------------------
			// Rober asked whether the Followers tab shows the last cell someone
			// was in (2026-08-02). It did not: the roster knew inWorld, her home
			// name and — for MHiYH followers only — what she is DOING, but never
			// the plain answer to "where is she".
			//
			// This lives in a file called nff_bridge for one honest reason: it is
			// the only place that already resolves every roster member to an
			// Actor, and the Follower Organizer envelope it decorates comes from
			// FO's own DLL export, which we cannot add fields to. Nothing here is
			// NFF-specific.
			//
			// GetParentCell() answers for UNLOADED followers too — a persistent
			// ref keeps its cell out of the high process — which is exactly the
			// case worth reporting, since a loaded one is usually stood in front
			// of you. `loaded` distinguishes "she is here" from "last known".
			{
				std::string   where;
				std::uint32_t whereId = 0;
				if (auto* cell = actor->GetParentCell()) {
					// The CELL ID, not just its name. The Domains tab needs to ask
					// "who is in THIS marked place", and a domain stores the cell's
					// FormID — matching on display names would put everyone in
					// every "Riverwood Trader" the load order happens to contain.
					whereId = cell->GetFormID();
					if (const char* n = cell->GetFullName(); n && *n)
						where = n;
				}
				if (where.empty()) {
					if (auto* loc = actor->GetCurrentLocation()) {
						if (const char* n = loc->GetFullName(); n && *n)
							where = n;
					}
				}
				/* Told to wait, and therefore NOT with you — the same actor value
				   follower_frameworks.cpp reads to decide whether a "wait" order
				   would be a no-op. The party strip needs it to separate the
				   people at your back from the ones parked in an inn. */
				if (auto* avo = actor->AsActorValueOwner();
					avo && avo->GetActorValue(RE::ActorValue::kWaitingForPlayer) >= 0.5f)
					entry["waiting"] = true;

				if (!where.empty() || whereId) {
					if (!where.empty())
						entry["where"] = where;
					if (whereId)
						entry["whereId"] = whereId;
					entry["loaded"] = actor->Is3DLoaded();
					/* WHAT KIND of place that is, in the same closed vocabulary the
					   HUD's place readout uses — so the roster can draw the shipped
					   loc-* icon for an inn, a shop, a temple, a cave rather than a
					   bare diamond (Rober, 2026-09-17: "need to show a icon for
					   house and icon for location currently"). Classified by
					   Widgets::PlaceKindOf, never by a second keyword table. */
					if (auto* cell = actor->GetParentCell()) {
						const auto kind = Widgets::PlaceKindOf(actor->GetCurrentLocation(),
							cell->IsInteriorCell());
						if (!kind.empty())
							entry["whereKind"] = kind;
					}
				}
			}

			// ---- NFF ----
			if (nff.ok) {
				const int  idx = HomeIndexOf(actor, nff.homeFac);
				const bool hasOutfit = nff.outfitFac && actor->IsInFaction(nff.outfitFac);
				const bool stored = nff.storedFac && actor->IsInFaction(nff.storedFac);
				const bool isFollower = nff.followerFac && actor->IsInFaction(nff.followerFac);
				// "managed" = NFF demonstrably holds state for this actor. It is a
				// derived signal, not a flag NFF exposes: nwsFF_FollowerFac is the
				// primary, and any of the state factions is corroboration.
				const bool managed = isFollower || idx >= 0 || hasOutfit || stored;

				if (managed) {
					json n{
						{ "managed", true },
						// her own sandbox checkbox, so the card can show a real state
						{ "sandbox", SandboxAllowedFor(actor) },
						{ "outfit", json{ { "has", hasOutfit } } },
						{ "home", nullptr },
					};
					if (idx >= 0) {
						std::string name;
						if (idx < static_cast<int>(nff.baseNames.size()) &&
							!IsBlankName(nff.baseNames[idx]))
							name = nff.baseNames[idx];
						if (name.empty() && idx < static_cast<int>(nff.baseMarkers.size()))
							name = PlaceNameOfRef(nff.baseMarkers[idx]);
						if (name.empty())
							name = "Base " + std::to_string(idx + 1);
						n["home"] = json{ { "i", idx }, { "name", name } };
						++withNffHome;
					}
					entry["nff"] = n;
				}
			}

			// ---- My Home is Your Home NG ----
			if (mh.homeKw()) {
				// One reader for both surfaces (MhiyhEntry): the roster's slice here,
				// and the Residents mode's geometry-bearing copy. Emit only when there
				// is something to say, which is what keeps this small on a ~70-member
				// roster.
				jest = MhiyhEntry(actor, mh, /*geometry=*/ false);
				if (!jest.is_null()) {
					if (!jest["home"].is_null())
						++withMhHome;
					if (!jest["now"].empty())
						++withNow;
					entry["mhiyh"] = std::move(jest);
				}
			}

			// ---- what she is to the PLAYER --------------------------------
			// The engine's RELA rank, plus M.A.R.A.S's marriage state when that
			// mod is present. Emitted ONLY when there is something to say: a
			// stranger with no relationship record and no marriage would
			// otherwise hand every one of ~70 roster members an entry that says
			// nothing, which is precisely what the `entry.empty()` gate below
			// exists to avoid.
			{
				const auto rel = Relationship::Of(actor);
				const auto mar = Maras::Of(actor);
				if (rel.has || mar.spouse) {
					json r{ { "has", rel.has }, { "rank", rel.rank } };
					if (mar.spouse) {
						r["spouse"] = true;
						++withSpouse;
					}
					entry["rel"] = std::move(r);
				}
			}

			if (!entry.empty())
				out["members"][idStr] = std::move(entry);
		}

		// withNow is the diagnostic that matters for the schedule half: if homes
		// resolve but nothing is ever "doing now", NG's activity quests are not
		// the ones we think they are, and this line says so without a debugger.
		logger::debug("nff/mhiyh: {} entries ({} NFF homes, {} MHiYH homes, {} doing something now, {} married)",
			out["members"].size(), withNffHome, withMhHome, withNow, withSpouse);
		if (repaired)
			logger::info("nff/mhiyh: base-form repair found a live actor for {} roster row(s) FO could not store a reference for", repaired);
		return Dump(out);
	}

	std::string StateJson()
	{
		return StateJson(FollowerDeck::StateJson());
	}
}
