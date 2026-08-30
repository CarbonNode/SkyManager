// Settlement tab — the world-object placer. See settlement.h for the contract.
//
// Design notes that are load-bearing (all inherited from the Items/NPCs tabs):
//  - Identity is (plugin, file-width-masked local FormID), the ESL-safe pair
//    the Items tab proved; NEVER CommonLib's GetLocalFormID() (missing null
//    check — the 2026-08-03 CTD). The row id string handed to the view is
//    "Plugin.esp|HEX6" (6-hex uppercase); resolve back = split on '|',
//    strtoul(hex,16), dh->LookupForm(local, plugin).
//  - Dynamic (no source file) forms are skipped: neither durable nor listable.
//  - Every JSON dump uses error_handler_t::replace — object names come out of
//    arbitrary ESPs and are not guaranteed UTF-8; a throwing dump would kill
//    the reply for the whole query.
//  - Renders flow through the EXISTING item route (LookOf resolves STAT / MSTT
//    / FURN / CONT / ACTI / TREE / FLOR / DOOR / LIGH via its generic
//    TESModelTextureSwap branch), keyed by the same UPPERCASE-hex|lowercase-
//    plugin scheme, landing in icons/items/ — so no item_icons change is
//    needed and the kItemRenderEpoch purge is inherited free.
//  - The physical placement path copies the room_guard ring-hide sequence
//    VERBATIM (park at z=-30000, Disable(), SetDelete(true)) for remove, and
//    PlaceObjectAtMe(base, forcePersist=true) for place.

#include "settlement.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "item_icons.h"
#include "npc_actions.h"

// GetModuleHandleA / GetProcAddress (OMO probe) come from Windows.h, which the
// SKSE/CommonLib pch already pulls in transitively — npc_actions.cpp uses the
// same two calls with no explicit include, so we follow that proven pattern.

namespace Settlement
{
	namespace
	{
		using json = nlohmann::json;

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Lower(std::string_view s)
		{
			std::string out(s);
			std::transform(out.begin(), out.end(), out.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return out;
		}

		// ------------------------------------------------------------- kinds --
		// Order doubles as the browse sort, so a plugin's catalogue reads
		// statics -> movables -> furniture -> ... like a shop inventory would.
		enum class Kind : std::uint8_t
		{
			Stat, Mstt, Furn, Cont, Acti, Tree, Flor, Door, Ligh
		};

		const char* KindKey(Kind k)
		{
			switch (k) {
			case Kind::Stat: return "stat";
			case Kind::Mstt: return "mstt";
			case Kind::Furn: return "furn";
			case Kind::Cont: return "cont";
			case Kind::Acti: return "acti";
			case Kind::Tree: return "tree";
			case Kind::Flor: return "flor";
			case Kind::Door: return "door";
			case Kind::Ligh: return "ligh";
			}
			return "stat";
		}

		std::optional<Kind> KindFromKey(const std::string& s)
		{
			for (std::uint8_t i = 0; i <= static_cast<std::uint8_t>(Kind::Ligh); ++i)
				if (s == KindKey(static_cast<Kind>(i)))
					return static_cast<Kind>(i);
			return std::nullopt;
		}

		// ------------------------------------------------------------- index --
		struct Plugin
		{
			std::string   name;
			std::string   lower;
			std::string   ext;     // "esm" | "esp" | "esl"
			bool          light = false;
			std::uint32_t count = 0;
		};

		struct Obj
		{
			std::uint32_t formId;   // runtime — session-scoped lookups we make ourselves
			std::uint32_t localId;  // durable half of the identity we hand the view
			std::uint16_t plug;
			Kind          kind;
			bool          edidOnly = false;  // named by its EditorID, not a FULL name
			bool          camp = false;      // a Campfire / Tentapalooza placeable
			std::string   sub;               // Campfire subcategory key (when camp)
			std::string   name;
			std::string   lower;
			std::string   edid;              // lowercased EditorID (Campfire classify)
		};

		std::vector<Plugin> g_plugins;
		std::vector<Obj>    g_objs;
		bool                g_built = false;

		std::mutex g_stateMutex;   // guards catalogs + placed + settings (loaded lazily,
		                           // written from the same task thread but read by the
		                           // reconcile at kPostLoadGame, which is also a main-
		                           // thread beat — the mutex is belt-and-braces).

		// ---------------------------------------------------------- settings --
		int  g_pageSize = 25;   // rows drawn per page; persisted (item-explorer precedent)
		int  g_catCounter = 1;  // next catalog id number
		bool g_sidecarLoaded = false;

		int ClampPageSize(int n) { return std::clamp(n, 1, 100); }

		// -------------------------------------------------------- catalogs --
		struct CatItem
		{
			std::string plugin;   // durable identity of a placeable object
			std::string local;    // 6-hex uppercase, as stored
		};
		struct Catalog
		{
			std::string          id;
			std::string          name;
			std::vector<CatItem> items;
		};
		std::vector<Catalog> g_catalogs;

		// -------------------------------------------------------- placements --
		// Named PlacedRec, not Placed: the public API function Settlement::Placed
		// (settlement.h) makes the bare name ambiguous outside this anonymous
		// namespace — MSVC C2872 in the public function bodies below.
		struct PlacedRec
		{
			std::string   refFormId;    // 8-hex runtime ref id (this save)
			std::string   basePlugin;   // the base's durable plugin
			std::string   baseLocal;    // 6-hex local
			std::string   cellId;       // "Plugin.esp|HEX6" of the parent cell
			float         x{ 0 }, y{ 0 }, z{ 0 }, angleZ{ 0 };
			std::string   name;
			std::string   kind;
		};
		std::vector<PlacedRec> g_placed;

		std::filesystem::path SidecarPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "settlement.json";
		}

		std::filesystem::path CatalogDir()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "catalogs";
		}

		void LoadSidecarLocked()
		{
			if (g_sidecarLoaded)
				return;
			g_sidecarLoaded = true;
			std::ifstream in(SidecarPath(), std::ios::binary);
			if (!in)
				return;
			try {
				json j = json::parse(in, nullptr, true, true);
				if (!j.is_object())
					return;
				g_pageSize = ClampPageSize(j.value("pageSize", g_pageSize));
				g_catCounter = (std::max)(1, j.value("catCounter", g_catCounter));
				g_catalogs.clear();
				if (j.contains("catalogs") && j["catalogs"].is_array()) {
					for (const auto& cj : j["catalogs"]) {
						if (!cj.is_object())
							continue;
						Catalog c;
						c.id = cj.value("id", std::string());
						c.name = cj.value("name", std::string());
						if (c.id.empty())
							continue;
						if (cj.contains("items") && cj["items"].is_array())
							for (const auto& ij : cj["items"]) {
								if (!ij.is_object())
									continue;
								CatItem ci;
								ci.plugin = ij.value("plugin", std::string());
								ci.local = ij.value("local", std::string());
								if (!ci.plugin.empty() && !ci.local.empty())
									c.items.push_back(std::move(ci));
							}
						g_catalogs.push_back(std::move(c));
					}
				}
				g_placed.clear();
				if (j.contains("placed") && j["placed"].is_array()) {
					for (const auto& pj : j["placed"]) {
						if (!pj.is_object())
							continue;
						PlacedRec p;
						p.refFormId = pj.value("refFormId", std::string());
						p.basePlugin = pj.value("basePlugin", std::string());
						p.baseLocal = pj.value("baseLocal", std::string());
						p.cellId = pj.value("cellId", std::string());
						p.x = pj.value("x", 0.0f);
						p.y = pj.value("y", 0.0f);
						p.z = pj.value("z", 0.0f);
						p.angleZ = pj.value("angleZ", 0.0f);
						p.name = pj.value("name", std::string());
						p.kind = pj.value("kind", std::string());
						if (!p.refFormId.empty())
							g_placed.push_back(std::move(p));
					}
				}
			} catch (...) {
				logger::warn("settlement: sidecar unreadable - defaults kept");
			}
		}

		void SaveSidecarLocked()
		{
			const auto path = SidecarPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			json cats = json::array();
			for (const auto& c : g_catalogs) {
				json items = json::array();
				for (const auto& ci : c.items)
					items.push_back(json{ { "plugin", ci.plugin }, { "local", ci.local } });
				cats.push_back(json{ { "id", c.id }, { "name", c.name }, { "items", std::move(items) } });
			}
			json placed = json::array();
			for (const auto& p : g_placed)
				placed.push_back(json{
					{ "refFormId", p.refFormId }, { "basePlugin", p.basePlugin },
					{ "baseLocal", p.baseLocal }, { "cellId", p.cellId },
					{ "x", p.x }, { "y", p.y }, { "z", p.z }, { "angleZ", p.angleZ },
					{ "name", p.name }, { "kind", p.kind } });
			json out = json{
				{ "pageSize", g_pageSize },
				{ "catCounter", g_catCounter },
				{ "catalogs", std::move(cats) },
				{ "placed", std::move(placed) },
			};
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream f(tmp, std::ios::trunc | std::ios::binary);
				if (!f.is_open()) {
					logger::warn("settlement: could not write {}", PathU8(tmp));
					return;
				}
				f << Dump(out);
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("settlement: sidecar rename failed: {}", ec.message());
		}

		// --------------------------------------------------------- the walk --
		std::uint16_t PlugIndexFor(RE::TESFile* file,
			std::unordered_map<const RE::TESFile*, std::uint16_t>& map)
		{
			if (auto it = map.find(file); it != map.end())
				return it->second;
			Plugin p;
			p.name = std::string(file->GetFilename());
			p.lower = Lower(p.name);
			p.light = file->IsLight();
			const auto dot = p.lower.rfind('.');
			p.ext = dot == std::string::npos ? "esp" : p.lower.substr(dot + 1);
			const auto idx = static_cast<std::uint16_t>(g_plugins.size());
			g_plugins.push_back(std::move(p));
			map.emplace(file, idx);
			return idx;
		}

		// STAT/MSTT junk skip-list (cheap, extensible). A record with a real FULL
		// name is NEVER prefix-skipped — a named static IS a placeable thing the
		// user wants. Only edidOnly records (no FULL name) are prefix-tested.
		// ⚠ Dry-run against the real rig STAT/MSTT arrays before first launch and
		// report kept/skipped counts (Keys/Animations precedent).
		bool JunkEdid(const std::string& edid)
		{
			static const char* kSkip[] = {
				"Marker", "Collision", "Trigger", "Occlusion", "LOD", "L2_", "L3_"
			};
			for (const char* s : kSkip)
				if (edid.find(s) != std::string::npos)
					return true;
			return false;
		}

		// Campfire / Tentapalooza subcategory buckets (view: CAMP_SUBS). A camp
		// object is classified by name + EditorID keywords into one of eight
		// buckets; unknowns fall to "misc". Keyword order = priority (a "cooking
		// fire" is Cooking, not Fire). Cheap substring scan on lowered text.
		const char* CampSub(const std::string& lowName, const std::string& lowEdid)
		{
			auto has = [&](const char* k) {
				return lowName.find(k) != std::string::npos || lowEdid.find(k) != std::string::npos;
			};
			// Cooking before Fire (a cook-pot/spit rides a fire), Storage before Furniture.
			if (has("cook") || has("pot") || has("spit") || has("cauldron") || has("grill") ||
				has("roast") || has("kettle") || has("stew"))
				return "cooking";
			if (has("shrine") || has("altar") || has("idol") || has("totem") || has("prayer"))
				return "shrines";
			if (has("tent") || has("shelter") || has("bedroll") || has("lean") || has("canvas") ||
				has("awning") || has("tarp") || has("hammock") || has("sleep"))
				return "shelter";
			if (has("chest") || has("crate") || has("barrel") || has("sack") || has("basket") ||
				has("pouch") || has("storage") || has("footlocker") || has("strongbox"))
				return "storage";
			if (has("fire") || has("campfire") || has("flame") || has("ember") || has("brazier") ||
				has("torch") || has("bonfire") || has("firepit") || has("firewood") || has("wood"))
				return "fire";
			if (has("lantern") || has("candle") || has("light") || has("lamp") || has("glow"))
				return "light";
			if (has("chair") || has("stool") || has("bench") || has("table") || has("seat") ||
				has("rug") || has("mat") || has("log") || has("furnitur"))
				return "furn";
			return "misc";
		}

		// A form's model path (STAT/MSTT/FURN/CONT/ACTI/TREE/FLOR/DOOR/LIGH all
		// derive from TESModelTextureSwap, which extends TESModel). Returns "" for
		// an empty model. Used only to gate STAT/MSTT (an invisible static is not
		// placeable); the always-modelled kinds skip this check.
		const char* ModelOf(RE::TESForm* form)
		{
			if (auto* mts = form->As<RE::TESModelTextureSwap>())
				return mts->GetModel();
			if (auto* m = form->As<RE::TESModel>())
				return m->GetModel();
			return nullptr;
		}

		/* Everything the harvest reads off one form, behind ONE SEH guard.
		 *
		 * The first version guarded only GetFile(0) — the sourceFiles BSTArray
		 * walk — because that was the call that faulted on the first known bad
		 * record. That was too narrow: a record whose memory is unreadable
		 * faults on ANY engine read. The 2026-08-16 CTD (crash-2026-08-16-17-06-13,
		 * SkyManager.dll+02DE8C8 `call [rax+0x190]`, rax = 0) is the very NEXT
		 * call after the guarded one — 0x190/8 = vtable slot 0x32, which is
		 * TESForm::GetFormEditorID — made on an object whose vtable pointer read
		 * as zero. The same log shows 2,021 MSTT records faulting inside a single
		 * millisecond, so this load order hands us a whole run of unreadable
		 * MovableStatic base objects (runtime-swapped bases; the crash registers
		 * name SFCO3-BOS - Resources.esp), not one stray record.
		 *
		 * So: read formID, file, editor id, name and model together and treat the
		 * form as unusable if any of them faults. POD out-params only — SEH is
		 * illegal in a frame that needs C++ unwinding, so the caller copies into
		 * std::string outside the guard. marker: settlement-form-probe */
		struct FormProbe
		{
			RE::TESFile*  file   = nullptr;
			const char*   edid   = nullptr;
			const char*   name   = nullptr;
			const char*   model  = nullptr;
			std::uint32_t formId = 0;
		};

		bool SafeProbe(RE::TESForm* form, FormProbe& out) noexcept
		{
			__try {
				out.formId = form->GetFormID();
				out.file   = form->GetFile(0);
				if (!out.file)
					return true;   // dynamic/no source file — the caller skips it
				out.edid  = form->GetFormEditorID();
				out.name  = form->GetName();
				out.model = ModelOf(form);
				return true;
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return false;
			}
		}

		// One unreadable record is worth a line; two thousand is a 2 MB log and a
		// stall. Log the first few per stage, then count the rest into a summary.
		constexpr std::size_t kMaxSkipLogs = 5;
		// …and walk away entirely once a form array proves to be junk (below).
		constexpr std::size_t kMaxFaultsBeforeAbandon = 24;

		/* One record -> one Obj, shared by BOTH walks (the per-type form arrays
		 * and the global-form-table sweep below). Returns true when it kept the
		 * record; `unreadable` counts the ones whose memory could not be read.
		 * `gateModel` skips a modelless record (STAT/MSTT/LIGH); displayName =
		 * FULL name, else EditorID; the junk-prefix skip applies to edidOnly
		 * STAT/MSTT records only. */
		bool AddForm(RE::TESForm* form, Kind kind, bool gateModel, bool junkGate,
			std::unordered_map<const RE::TESFile*, std::uint16_t>& map,
			std::size_t& unreadable)
		{
			if (!form)
				return false;
			FormProbe probe;
			if (!SafeProbe(form, probe)) {
				if (++unreadable <= kMaxSkipLogs)
					logger::warn("settlement: skipped unreadable {} record {:08X} "
					             "(engine read faulted - base object is not readable)",
						KindKey(kind), probe.formId);
				return false;
			}
			auto* file = probe.file;
			if (!file)
				return false;  // dynamic (0xFF…) — not durable, not listable

			std::string name;
			bool        edidOnly = false;
			const char* eid = probe.edid;
			const char* fn = probe.name;
			if (fn && *fn) {
				name = fn;
			} else if (eid && *eid) {
				name = eid;
				edidOnly = true;
			}
			if (name.empty())
				return false;  // both empty — nothing to show, unfindable
			if (gateModel) {
				const char* m = probe.model;
				if (!m || !*m)
					return false;  // invisible placement — skip
			}
			if (junkGate && edidOnly && JunkEdid(name))
				return false;

			Obj o;
			o.formId = probe.formId;
			o.localId = o.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			o.plug = PlugIndexFor(file, map);
			o.kind = kind;
			o.edidOnly = edidOnly;
			o.name = std::move(name);
			o.lower = Lower(o.name);
			if (eid && *eid)
				o.edid = Lower(eid);
			g_plugins[o.plug].count++;
			g_objs.push_back(std::move(o));
			return true;
		}

		/* The kinds the game does NOT keep in TESDataHandler::formArrays — swept
		 * out of the GLOBAL form table instead.
		 *
		 * Measured on the live load order (2026-08-16, the first launch after the
		 * SEH probe landed): `stat` kept 0 in 2 ms — the array is simply EMPTY —
		 * and `mstt` walked 2,096 entries of which EVERY single one faulted on the
		 * first engine read. That is a garbage array, not thousands of corrupt
		 * records, and it is why the tab used to CTD: we were walking a
		 * formArrays slot the engine never fills. Eating 2,096 access violations
		 * also cost 2.8 s of frozen main thread, which is what the loading page
		 * looked like from the couch.
		 *
		 * TESForm::GetAllForms() is the table every form really lives in, so one
		 * read-locked pass buckets Static / MovableStatic / Light properly. The
		 * probe stays on each record — free when nothing faults, and cheap
		 * insurance if this table ever hands us something odd. */
		void SweepUntrackedKinds(std::unordered_map<const RE::TESFile*, std::uint16_t>& map)
		{
			const auto  t0 = std::chrono::steady_clock::now();
			const auto  all = RE::TESForm::GetAllForms();
			auto* const table = all.first;
			if (!table) {
				logger::warn("settlement: global form table unavailable - statics, movable statics "
				             "and lights will be missing from the catalogue");
				return;
			}
			std::size_t seen = 0, unreadable = 0;
			std::size_t keptStat = 0, keptMstt = 0, keptLigh = 0;
			{
				RE::BSReadLockGuard guard(all.second);
				for (auto& entry : *table) {
					auto* form = entry.second;
					if (!form)
						continue;
					++seen;
					switch (form->GetFormType()) {
						case RE::FormType::Static:
							if (AddForm(form, Kind::Stat, true, true, map, unreadable))
								++keptStat;
							break;
						case RE::FormType::MovableStatic:
							if (AddForm(form, Kind::Mstt, true, true, map, unreadable))
								++keptMstt;
							break;
						case RE::FormType::Light:
							{
								// INVERTS the Items rule: keep decorative light
								// sources, skip carryables (Items tab territory).
								auto* l = form->As<RE::TESObjectLIGH>();
								if (!l || l->data.flags.any(RE::TES_LIGHT_FLAGS::kCanCarry))
									break;
								if (AddForm(form, Kind::Ligh, true, false, map, unreadable))
									++keptLigh;
							}
							break;
						default:
							break;
					}
				}
			}
			const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::steady_clock::now() - t0).count();
			// marker: settlement-global-sweep
			logger::info("settlement: global sweep - {} forms in {} ms; kept stat {}, mstt {}, ligh {} "
			             "(skipped {} unreadable)",
				seen, ms, keptStat, keptMstt, keptLigh, unreadable);
		}

		// The per-type walk, for the kinds TESDataHandler really does track.
		template <class T>
		void Harvest(std::unordered_map<const RE::TESFile*, std::uint16_t>& map,
			Kind kind, bool gateModel, bool junkGate)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			std::size_t kept = 0, unreadable = 0;
			auto& arr = dh->GetFormArray<T>();
			for (auto* form : arr) {
				if (!form)
					continue;
				FormProbe probe;
				if (!SafeProbe(form, probe)) {
					if (++unreadable <= kMaxSkipLogs)
						logger::warn("settlement: skipped unreadable {} record {:08X} "
						             "(engine read faulted - base object is not readable)",
							KindKey(kind), probe.formId);
					/* A formArrays slot the engine does not maintain is not a
					 * field of broken records — it is not a form array at all,
					 * and every entry in it costs an access violation (2,096 of
					 * them froze the main thread for 2.8 s). Walk away from the
					 * whole slot once the evidence is in. */
					if (unreadable >= kMaxFaultsBeforeAbandon) {
						logger::warn("settlement: abandoning the {} form array after {} unreadable "
						             "entries - the engine does not maintain this slot",
							KindKey(kind), unreadable);
						break;
					}
					continue;
				}
				auto* file = probe.file;
				if (!file)
					continue;  // dynamic (0xFF…) — not durable, not listable

				std::string name;
				bool        edidOnly = false;
				const char* eid = probe.edid;
				const char* fn = probe.name;
				if (fn && *fn) {
					name = fn;
				} else if (eid && *eid) {
					name = eid;
					edidOnly = true;
				}
				if (name.empty())
					continue;  // both empty — nothing to show, unfindable

				if (gateModel) {
					const char* m = probe.model;
					if (!m || !*m)
						continue;  // invisible placement — skip
				}
				if (junkGate && edidOnly && JunkEdid(name))
					continue;

				Obj o;
				o.formId = probe.formId;
				o.localId = o.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				o.plug = PlugIndexFor(file, map);
				o.kind = kind;
				o.edidOnly = edidOnly;
				o.name = std::move(name);
				o.lower = Lower(o.name);
				if (eid && *eid)
					o.edid = Lower(eid);
				g_plugins[o.plug].count++;
				g_objs.push_back(std::move(o));
				++kept;
			}
			// Say what the stage actually got. An empty kind with a big unreadable
			// count is the difference between "this load order has none" and "we
			// could not read them" — the tab used to be unable to tell you either.
			if (unreadable)
				logger::warn("settlement: {} - kept {}, skipped {} unreadable record(s)",
					KindKey(kind), kept, unreadable);
			else
				logger::info("settlement: {} - kept {}", KindKey(kind), kept);
		}

		// ---- index-build state (the stepper below; the two helpers write it) ----
		int         g_step = 0;      // 0 = not started, kStepCount = done
		std::size_t g_campCount = 0;
		std::chrono::steady_clock::time_point g_t0{};
		std::unordered_map<const RE::TESFile*, std::uint16_t> g_fileMap;

		constexpr int kStepCount = 11;

		/* The old LIGH pass is gone: lights are not kept in
		 * TESDataHandler::formArrays either (kept 0 on the live load order),
		 * so SweepUntrackedKinds picks them out of the global form table with
		 * the same carryable gate. Nothing walks that slot any more. */

		// Marks Campfire-family placeables and buckets them into the view's
		// Campfire tree subcategories. A cheap post-pass over the plugin index (one
		// lowercased name compare per object) so the Campfire pill and its
		// subcategory rail can scope without re-walking the load order.
		void MarkCampGear()
		{
			// The Campfire FAMILY, not just Campfire itself: Tentapalooza's tents,
			// Campfire Unleashed's extra gear, and the Hunterborn patch's camp
			// items all place through Campfire's own equip flow and belong in the
			// same tree. Membership is an explicit list on purpose -- "any plugin
			// with campfire in the name" would sweep in visual patches
			// (EmbersXD-Campfire Patch.esp, SDA Campfire Patch.esp) that ship no
			// placeables and would only pad the tree.
			static const char* kCampPlugins[] = {
				"campfire.esm",
				"tentapalooza.esp",
				"campfire unleashed.esp",
				"campfire unleashed.esm",
				"hunterborn - campfire patch.esp",
			};
			for (auto& o : g_objs) {
				const std::string& pn = g_plugins[o.plug].lower;
				bool isCamp = false;
				for (const char* c : kCampPlugins)
					if (pn == c) { isCamp = true; break; }
				if (isCamp) {
					o.camp = true;
					o.sub = CampSub(o.lower, o.edid);
					++g_campCount;
				}
			}
		}

		// ------------------------------------------------------ index build --
		//
		// The walk costs ~2.9 s on a 756-plugin load order, all of it on the MAIN
		// thread (form arrays are engine memory; the other index tabs read them
		// the same way). Done in one go that is a 3-second HARD FREEZE the first
		// time the tab opens, which is exactly what it looks like: Rober,
		// 2026-08-15 -- "took a while to load - thought i crashed".
		//
		// So the build is a STEPPER. Each call does ONE stage and returns, the
		// caller pumps it from successive SKSE tasks, and the game keeps drawing
		// frames in between -- a few ~300 ms hitches instead of one 3 s stall,
		// and the view can paint a real progress bar because it is being told
		// which stage is running. Every stage is idempotent-by-construction: it
		// appends to g_objs and nothing re-runs, since g_step only moves forward.
		//
		// EnsureIndex() below keeps the old blocking behaviour for any caller
		// that needs the index NOW (a query arriving before the pump finishes) --
		// it just pumps the same steps to completion.

		// Human label for the stage ABOUT to run, for the view's progress line.
		const char* StepLabel(int step)
		{
			switch (step) {
				case 0:  return "statics, movable statics and lights";
				case 1:  return "sorting what the sweep found";
				case 2:  return "furniture";
				case 3:  return "containers";
				case 4:  return "activators";
				case 5:  return "trees";
				case 6:  return "plants";
				case 7:  return "doors";
				case 8:  return "tidying up";
				case 9:  return "camp gear";
				default: return "finishing";
			}
		}

		// Runs ONE stage. Returns true when the whole index is built.
		// Main thread only (it walks TESDataHandler form arrays).
		bool BuildIndexStepImpl()
		{
			if (g_built)
				return true;
			if (g_step == 0) {
				{
					std::lock_guard l(g_stateMutex);
					LoadSidecarLocked();
				}
				logger::info("settlement: index walk started - stepped, {} stages", kStepCount);
				g_t0 = std::chrono::steady_clock::now();
				g_campCount = 0;
				g_fileMap.clear();
				g_objs.reserve(65536);
			}
			auto& map = g_fileMap;
			switch (g_step) {
				/* STAT / MSTT / LIGH come from the GLOBAL form table, not from
				 * TESDataHandler::formArrays — the engine does not maintain those
				 * three slots (stat empty, mstt 2,096 unreadable entries; see
				 * SweepUntrackedKinds). Model-gated AND junk-gated inside the
				 * sweep, because they carry the LOD/collision noise; the kinds
				 * below always have a model and a real name. */
				case 0: SweepUntrackedKinds(map); break;
				case 1: break;   // retired — the sweep above did the movable statics
				case 2: Harvest<RE::TESFurniture>(map, Kind::Furn, false, false); break;
				case 3: Harvest<RE::TESObjectCONT>(map, Kind::Cont, false, false); break;
				case 4: Harvest<RE::TESObjectACTI>(map, Kind::Acti, false, false); break;
				case 5: Harvest<RE::TESObjectTREE>(map, Kind::Tree, false, false); break;
				case 6: Harvest<RE::TESFlora>(map, Kind::Flor, false, false); break;
				case 7: Harvest<RE::TESObjectDOOR>(map, Kind::Door, false, false); break;
				case 8: break;   // retired — the sweep above did the lights
				case 9: MarkCampGear(); break;
				default: break;
			}
			++g_step;
			if (g_step < kStepCount)
				return false;
			g_built = true;
			const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::steady_clock::now() - g_t0).count();
			logger::info("settlement: index built - {} objects across {} plugins in {} ms ({} camp)",
				g_objs.size(), g_plugins.size(), ms, g_campCount);
			g_fileMap.clear();
			return true;
		}

		void EnsureIndex()
		{
			while (!BuildIndexStepImpl()) {}
		}

		// Progress for the view: 0..1 plus the stage name about to run.
		float IndexProgress() { return g_built ? 1.0f : (static_cast<float>(g_step) / kStepCount); }

		// ---------------------------------------------------------- queries --
		std::vector<std::string> Tokens(const std::string& q)
		{
			std::vector<std::string> out;
			std::string cur;
			for (char c : Lower(q)) {
				if (std::isspace(static_cast<unsigned char>(c))) {
					if (!cur.empty()) { out.push_back(cur); cur.clear(); }
				} else {
					cur += c;
				}
			}
			if (!cur.empty())
				out.push_back(cur);
			return out;
		}

		// The Items tab's ranking verbatim, plus the plugin name as a soft field.
		int TokenScore(const Obj& o, const Plugin& pl, const std::string& tok)
		{
			const auto pos = o.lower.find(tok);
			if (pos == 0)
				return 0;
			if (pos != std::string::npos) {
				const char before = o.lower[pos - 1];
				if (before == ' ' || before == '(' || before == '\'' || before == '-' || before == '_')
					return 1;
				return 2;
			}
			if (pl.lower.find(tok) != std::string::npos)
				return 4;
			return -1;
		}

		// The catalog membership id for this object, or "" — first catalog that
		// holds it. Cheap: catalogs are small and few.
		std::string CatOfLocked(const std::string& plugin, const std::string& hex6)
		{
			const std::string plow = Lower(plugin);
			for (const auto& c : g_catalogs)
				for (const auto& ci : c.items)
					if (Lower(ci.plugin) == plow && Lower(ci.local) == Lower(hex6))
						return c.id;
			return {};
		}

		// ---------------------------------------------------------- resolve --
		// Split "Plugin.esp|HEX6" -> (plugin, local). Returns false on malformed.
		bool SplitId(const std::string& id, std::string& plugin, std::uint32_t& local)
		{
			const auto bar = id.find('|');
			if (bar == std::string::npos || bar == 0)
				return false;
			plugin = id.substr(0, bar);
			local = static_cast<std::uint32_t>(std::strtoul(id.c_str() + bar + 1, nullptr, 16));
			return local != 0 || bar + 1 < id.size();
		}

		RE::TESBoundObject* ResolveBase(const std::string& id, std::string* nameOut, Kind* kindOut)
		{
			std::string   plugin;
			std::uint32_t local = 0;
			if (!SplitId(id, plugin, local))
				return nullptr;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return nullptr;
			auto* form = dh->LookupForm(local, plugin);
			auto* bound = form ? form->As<RE::TESBoundObject>() : nullptr;
			if (bound && nameOut) {
				const char* nm = bound->GetName();
				if (nm && *nm) {
					*nameOut = nm;
				} else if (const char* eid = bound->GetFormEditorID(); eid && *eid) {
					*nameOut = eid;
				} else {
					*nameOut = "object";
				}
			}
			if (bound && kindOut) {
				// Cheap type derive so the placement record carries an honest kind.
				if (bound->As<RE::TESObjectSTAT>()) *kindOut = Kind::Stat;
				else if (bound->As<RE::BGSMovableStatic>()) *kindOut = Kind::Mstt;
				else if (bound->As<RE::TESFurniture>()) *kindOut = Kind::Furn;
				else if (bound->As<RE::TESObjectCONT>()) *kindOut = Kind::Cont;
				else if (bound->As<RE::TESObjectTREE>()) *kindOut = Kind::Tree;
				else if (bound->As<RE::TESFlora>()) *kindOut = Kind::Flor;
				else if (bound->As<RE::TESObjectDOOR>()) *kindOut = Kind::Door;
				else if (bound->As<RE::TESObjectLIGH>()) *kindOut = Kind::Ligh;
				else *kindOut = Kind::Acti;
			}
			return bound;
		}

		// The durable identity of a cell (for the placement roster). "" if the
		// cell is dynamic/unresolvable.
		std::string CellIdOf(RE::TESObjectCELL* cell)
		{
			if (!cell)
				return {};
			auto* file = cell->GetFile(0);
			if (!file)
				return {};
			const std::uint32_t local = cell->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			char buf[16];
			std::snprintf(buf, sizeof(buf), "%06X", local);
			return std::string(file->GetFilename()) + "|" + buf;
		}

		// ---------------------------------------------------------- camera --
		// Camera world position + forward vector (the npc_actions grab route).
		bool CameraBasis(RE::NiPoint3& pos, RE::NiPoint3& fwd)
		{
			auto camera = RE::PlayerCamera::GetSingleton();
			if (!camera || !camera->cameraRoot)
				return false;
			auto& wt = camera->cameraRoot->world;
			pos = wt.translate;
			fwd = { -wt.rotate.entry[0][2], -wt.rotate.entry[1][2], -wt.rotate.entry[2][2] };
			return true;
		}

		// ----------------------------------------------------- OMO (move) --
		using OmoStartFn = void (*)(RE::TESObjectREFR*);

		OmoStartFn OmoStartDrag()
		{
			static OmoStartFn fn = []() -> OmoStartFn {
				const auto mod = GetModuleHandleA("ObjectManipulationOverhaul");
				if (!mod)
					return nullptr;
				return reinterpret_cast<OmoStartFn>(GetProcAddress(mod, "StartDraggingObject"));
			}();
			return fn;
		}

		// -------------------------------------------------------- campfire --
		// Detection is checked in StateJson; these resolve at fire time so a
		// disabled/updated mod is an honest refusal, never a hardcoded load index.
		bool ModPresent(const char* name)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && dh->LookupModByName(name) != nullptr;
		}

		// Campfire item placement: add the placeable MISC and equip it so the
		// mod's own CampPlaceableMiscItem.OnEquipped fires its placement preview.
		// The row id's plugin is either Campfire.esm or Tentapalooza.esp.
		std::string DoCampPlace(const std::string& id)
		{
			std::string   plugin;
			std::uint32_t local = 0;
			if (!SplitId(id, plugin, local))
				return "Settlement: malformed camp item id";
			auto* dh = RE::TESDataHandler::GetSingleton();
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!dh || !player)
				return "No game loaded";
			auto* form = dh->LookupForm(local, plugin);
			auto* misc = form ? form->As<RE::TESBoundObject>() : nullptr;
			if (!misc)
				return plugin + " has no such camp item any more";
			const char* nm = misc->GetName();
			const std::string name = (nm && *nm) ? nm : "camp item";

			// Add one and equip it — Campfire's OnEquipped drives the placement
			// preview. EquipObject via the actor equip manager (the wheel's verb).
			player->AddObjectToContainer(misc, nullptr, 1, nullptr);
			if (auto* mgr = RE::ActorEquipManager::GetSingleton())
				mgr->EquipObject(player, misc);
			logger::info("settlement: campfire place '{}' ({})", name, id);
			return "\xE2\x9B\xBA Placing " + name + " - use Campfire's controls";  // ⛺
		}
	}

	// ================================================================ API ==

	bool IndexReady() { return g_built; }

	bool BuildIndexStep() { return BuildIndexStepImpl(); }

	std::string StateJson()
	{
		// While the pump is still walking, answer with what we HAVE rather than
		// blocking: the view paints a progress bar instead of a frozen screen.
		if (!g_built) {
			return Dump(json{
				{ "phase", "building" },
				{ "progress", IndexProgress() },
				{ "stage", StepLabel(g_step) },
				{ "count", g_objs.size() },
				{ "pageSize", g_pageSize },
			});
		}
		json plugs = json::array();
		for (const auto& p : g_plugins) {
			if (!p.count)
				continue;
			plugs.push_back(json{ { "n", p.name }, { "c", p.count }, { "k", p.ext }, { "l", p.light } });
		}

		const bool campfire = ModPresent("Campfire.esm");
		const bool tentapalooza = ModPresent("Tentapalooza.esp");
		const bool hunterborn = ModPresent("Hunterborn.esp");
		const bool unleashed = ModPresent("Campfire Unleashed.esp") || ModPresent("Campfire Unleashed.esm");

		json cats = json::array();
		{
			std::lock_guard l(g_stateMutex);
			LoadSidecarLocked();
			for (const auto& c : g_catalogs)
				cats.push_back(json{ { "id", c.id }, { "name", c.name },
					{ "count", static_cast<int>(c.items.size()) } });
		}

		// Fixed category rail entries the view always draws when their mod exists.
		json fixedCats = json::array();
		if (campfire)
			fixedCats.push_back("Campfire");

		return Dump(json{
			{ "phase", "ready" },
			{ "count", g_objs.size() },
			{ "pageSize", g_pageSize },
			{ "plugins", std::move(plugs) },
			{ "campfire", json{ { "present", campfire }, { "unleashed", unleashed },
			                    { "tentapalooza", tentapalooza } } },
			{ "hunterborn", json{ { "present", hunterborn } } },
			{ "catalogs", std::move(cats) },
			{ "cats", std::move(fixedCats) },
		});
	}

	std::string QueryJson(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}

		const std::string q = in.value("q", std::string(""));
		const std::string typeKey = in.value("type", std::string("all"));
		const std::string plugin = in.value("plugin", std::string(""));
		const std::string catRaw = in.value("cat", std::string(""));
		const std::string subFilter = in.value("sub", std::string(""));
		const int         seq = in.value("seq", 0);
		const int         offset = (std::max)(0, in.value("offset", 0));
		const int         limit = std::clamp(in.value("limit", 60), 1, 100);

		// `cat == "camp"` is the Campfire tree scope (NOT a user-catalog id): it
		// keeps only Campfire/Tentapalooza placeables and, when `sub` is set,
		// narrows to that subcategory. Any other non-empty cat is a catalog filter.
		const bool        campMode = (catRaw == "camp");
		const std::string catFilter = campMode ? std::string() : catRaw;

		const auto kindFilter = KindFromKey(typeKey);   // nullopt = all kinds
		const auto tokens = Tokens(q);
		const auto plugLower = Lower(plugin);

		struct Hit { int score; std::uint32_t idx; };
		std::vector<Hit> hits;
		hits.reserve(1024);

		for (std::uint32_t i = 0; i < g_objs.size(); ++i) {
			const Obj& o = g_objs[i];
			if (campMode) {
				if (!o.camp)
					continue;
				if (!subFilter.empty() && o.sub != subFilter)
					continue;
			}
			if (kindFilter && o.kind != *kindFilter)
				continue;
			const Plugin& pl = g_plugins[o.plug];
			if (!plugLower.empty() && pl.lower != plugLower)
				continue;
			int  score = 0;
			bool okAll = true;
			for (const auto& tok : tokens) {
				const int s = TokenScore(o, pl, tok);
				if (s < 0) { okAll = false; break; }
				score += s;
			}
			if (!okAll)
				continue;
			hits.push_back(Hit{ score, i });
		}

		const bool browse = tokens.empty();
		std::sort(hits.begin(), hits.end(), [browse](const Hit& a, const Hit& b) {
			const Obj& x = g_objs[a.idx];
			const Obj& y = g_objs[b.idx];
			if (browse) {
				if (x.kind != y.kind)
					return static_cast<std::uint8_t>(x.kind) < static_cast<std::uint8_t>(y.kind);
				return x.lower < y.lower;
			}
			if (a.score != b.score)
				return a.score < b.score;
			if (x.lower.size() != y.lower.size())
				return x.lower.size() < y.lower.size();
			return x.lower < y.lower;
		});

		// Catalog membership resolves under the lock once per page.
		json items = json::array();
		const int total = static_cast<int>(hits.size());
		{
			std::lock_guard l(g_stateMutex);
			LoadSidecarLocked();
			for (int i = offset; i < total && i < offset + limit; ++i) {
				const Obj&    o = g_objs[hits[static_cast<std::size_t>(i)].idx];
				const Plugin& pl = g_plugins[o.plug];
				char idbuf[16];
				std::snprintf(idbuf, sizeof(idbuf), "%06X", o.localId);
				const std::string cat = CatOfLocked(pl.name, idbuf);
				// A catalog filter, when set, keeps only rows in that catalog.
				if (!catFilter.empty() && cat != catFilter)
					continue;
				json row{
					{ "id", pl.name + "|" + idbuf },
					{ "n", o.name },
					{ "t", KindKey(o.kind) },
					{ "p", pl.name },
					{ "e", o.edidOnly },
					{ "cat", cat },
				};
				// Campfire rows carry camp=true + their subcategory so the view
				// tags them (⛺ chip) and fires the campplace op instead of place.
				if (o.camp) {
					row["camp"] = true;
					row["sub"] = o.sub;
				}
				items.push_back(std::move(row));
			}
		}
		// When a catalog filter dropped rows, `total` overstates — recount from
		// the drawn set only when filtering (browse/search totals stay exact).
		const int reportedTotal = catFilter.empty() ? total : static_cast<int>(items.size()) + offset;
		return Dump(json{
			{ "seq", seq }, { "total", reportedTotal }, { "offset", offset },
			{ "items", std::move(items) } });
	}

	std::string ActJson(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string op = in.value("op", std::string(""));
		const std::string id = in.value("id", std::string(""));

		auto reply = [&](bool ok, const std::string& msg, bool close) {
			return Dump(json{ { "ok", ok }, { "op", op }, { "msg", msg }, { "close", close } });
		};

		// remove/jumpto/move act on a PLACEMENT ref id; place/campplace on a base.
		if (op == "place" || op == "campplace" || op == "move" || op == "remove" || op == "jumpto") {
			if (id.empty())
				return reply(false, "Nothing selected", false);
			// All five are PHYSICAL — resolve happens in ExecuteAct with the world
			// unpaused. Here we only sanity-check the base exists for place-shaped
			// ops so an obviously-dead row refuses BEFORE the palette closes.
			if (op == "place" || op == "campplace") {
				std::string name;
				auto*       bound = ResolveBase(id, &name, nullptr);
				if (op == "place" && !bound)
					return reply(false, "That object is not in the load order any more", false);
				// campplace resolves in ExecuteAct against Campfire's plugin.
				return reply(true, "", true);
			}
			return reply(true, "", true);
		}
		return reply(false, "Unknown action", false);
	}

	std::string ExecuteAct(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string op = in.value("op", std::string(""));
		const std::string id = in.value("id", std::string(""));

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return "Settlement: no player";

		// --- campplace: Campfire's own equip-flow ----------------------------
		if (op == "campplace")
			return DoCampPlace(id);

		// --- place: PlaceObjectAtMe at the crosshair-ray point or camera fwd -
		if (op == "place") {
			std::string name;
			Kind        kind = Kind::Acti;
			auto*       bound = ResolveBase(id, &name, &kind);
			if (!bound)
				return name.empty() ? "That object is gone" : (name + " is gone");
			auto ptr = player->PlaceObjectAtMe(bound, /*forcePersist=*/true);
			if (!ptr)
				return "The engine refused to place " + name;
			auto* ref = ptr.get();

			// Position: the crosshair non-actor ref's spot if we have one, else
			// camera-forward × a set reach. The crosshair snapshot is the deck's
			// own (NpcActions::ItemRefFormID), which is why no raycast is needed.
			RE::NiPoint3 pos = player->GetPosition();
			bool         placed = false;
			if (const auto refId = NpcActions::ItemRefFormID(); refId) {
				if (auto* aim = RE::TESForm::LookupByID<RE::TESObjectREFR>(refId)) {
					pos = aim->GetPosition();
					placed = true;
				}
			}
			if (!placed) {
				RE::NiPoint3 camPos, fwd;
				if (CameraBasis(camPos, fwd)) {
					constexpr float kReach = 300.0f;
					pos = RE::NiPoint3{ camPos.x + fwd.x * kReach,
					                    camPos.y + fwd.y * kReach,
					                    camPos.z + fwd.z * kReach };
				}
			}
			ref->SetPosition(pos);
			ref->SetAngle(RE::NiPoint3{ 0.0f, 0.0f, player->GetAngleZ() });
			ref->Update3DPosition(true);

			// Record the placement (durable identity for the roster).
			{
				std::lock_guard l(g_stateMutex);
				LoadSidecarLocked();
				char rbuf[16];
				std::snprintf(rbuf, sizeof(rbuf), "%08X", static_cast<std::uint32_t>(ref->GetFormID()));
				std::string plugin;
				std::uint32_t local = 0;
				SplitId(id, plugin, local);
				char lbuf[16];
				std::snprintf(lbuf, sizeof(lbuf), "%06X", local);
				PlacedRec p;
				p.refFormId = rbuf;
				p.basePlugin = plugin;
				p.baseLocal = lbuf;
				p.cellId = CellIdOf(ref->GetParentCell());
				p.x = pos.x; p.y = pos.y; p.z = pos.z;
				p.angleZ = player->GetAngleZ();
				p.name = name;
				p.kind = KindKey(kind);
				g_placed.push_back(std::move(p));
				SaveSidecarLocked();
			}
			logger::info("settlement: placed '{}' ({}) ref {:08X}", name, id,
				static_cast<std::uint32_t>(ref->GetFormID()));
			return "\xE2\x9C\xA6 " + name + " placed";  // ✦
		}

		// --- move: OMO handoff if loaded, else keyboard-nudge fallback -------
		if (op == "move") {
			// id here is the PLACEMENT ref id (8-hex runtime).
			const std::uint32_t refId = static_cast<std::uint32_t>(std::strtoul(id.c_str(), nullptr, 16));
			auto* ref = refId ? RE::TESForm::LookupByID<RE::TESObjectREFR>(refId) : nullptr;
			if (!ref)
				return "That placement is not in this world any more";
			if (const auto fn = OmoStartDrag()) {
				fn(ref);   // OMO owns the UX: crosshair-ray drag, left places, right restores
				logger::info("settlement: move delegated to OMO for ref {:08X}", refId);
				return "\xE2\x9C\xA5 Move it - left-click places, right-click restores";  // ✥
			}
			// Fallback: nudge to the camera-forward point (a coarse reposition;
			// the view's arrow-nudge drives further SetPosition steps via move).
			RE::NiPoint3 camPos, fwd;
			if (CameraBasis(camPos, fwd)) {
				constexpr float kReach = 250.0f;
				RE::NiPoint3    pos = RE::NiPoint3{ camPos.x + fwd.x * kReach,
				                                    camPos.y + fwd.y * kReach,
				                                    camPos.z + fwd.z * kReach };
				ref->SetPosition(pos);
				ref->Update3DPosition(true);
			}
			logger::info("settlement: move (arrow-nudge fallback) ref {:08X}", refId);
			return "\xE2\x86\x94 Moved (OMO not loaded - arrow-nudge only)";  // ↔
		}

		// --- remove: room_guard ring-hide sequence VERBATIM ------------------
		if (op == "remove") {
			const std::uint32_t refId = static_cast<std::uint32_t>(std::strtoul(id.c_str(), nullptr, 16));
			auto* ref = refId ? RE::TESForm::LookupByID<RE::TESObjectREFR>(refId) : nullptr;
			std::string name;
			{
				std::lock_guard l(g_stateMutex);
				LoadSidecarLocked();
				for (const auto& p : g_placed)
					if (Lower(p.refFormId) == Lower(id)) { name = p.name; break; }
				// Drop the record regardless of whether the ref still resolves.
				g_placed.erase(std::remove_if(g_placed.begin(), g_placed.end(),
					[&](const PlacedRec& p) { return Lower(p.refFormId) == Lower(id); }),
					g_placed.end());
				SaveSidecarLocked();
			}
			if (ref) {
				ref->SetPosition(RE::NiPoint3{ 0.0f, 0.0f, -30000.0f });
				ref->Update3DPosition(true);
				ref->SetDelete(true);
			}
			logger::info("settlement: removed placement ref {:08X}", refId);
			return "\xF0\x9F\x97\x91 Removed" + (name.empty() ? std::string() : (" " + name));  // 🗑
		}

		// --- jumpto: MoveTo the placement (Domains recall discipline) --------
		if (op == "jumpto") {
			const std::uint32_t refId = static_cast<std::uint32_t>(std::strtoul(id.c_str(), nullptr, 16));
			auto* ref = refId ? RE::TESForm::LookupByID<RE::TESObjectREFR>(refId) : nullptr;
			if (!ref)
				return "That placement is not in this world any more";
			player->MoveTo(ref);
			logger::info("settlement: jumpto placement ref {:08X}", refId);
			return "\xE2\xA4\xB3 Here";  // ⤳
		}

		return "Settlement: unknown action";
	}

	void Spin(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string id = in.value("id", std::string(""));
		std::string   plugin;
		std::uint32_t local = 0;
		if (!SplitId(id, plugin, local))
			return;
		char fidHex[16];
		std::snprintf(fidHex, sizeof(fidHex), "0x%x", local);
		ItemIcons::CaptureAngles(std::string(fidHex), plugin);
	}

	std::string Save(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		std::lock_guard l(g_stateMutex);
		LoadSidecarLocked();
		if (in.contains("pageSize"))
			g_pageSize = ClampPageSize(in.value("pageSize", g_pageSize));
		SaveSidecarLocked();
		return Dump(json{ { "ok", true }, { "pageSize", g_pageSize } });
	}

	// ---------------------------------------------------------- catalogs API --
	namespace
	{
		std::string TrimName(std::string s)
		{
			while (!s.empty() && (s.front() == ' ' || s.front() == '\t'))
				s.erase(s.begin());
			while (!s.empty() && (s.back() == ' ' || s.back() == '\t'))
				s.pop_back();
			if (s.size() > 40)
				s.resize(40);
			return s;
		}

		std::string SanitizeFile(const std::string& name)
		{
			std::string out;
			for (char c : name) {
				if (std::isalnum(static_cast<unsigned char>(c)) || c == ' ' || c == '_' || c == '-')
					out += c;
			}
			out = TrimName(out);
			if (out.empty())
				out = "catalog";
			return out;
		}

		Catalog* FindCatLocked(const std::string& id)
		{
			for (auto& c : g_catalogs)
				if (c.id == id)
					return &c;
			return nullptr;
		}
	}

	std::string Cat(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string op = in.value("op", std::string(""));

		auto fail = [&](const std::string& msg) {
			return Dump(json{ { "ok", false }, { "op", op }, { "msg", msg } });
		};

		std::lock_guard l(g_stateMutex);
		LoadSidecarLocked();

		if (op == "add") {
			std::string name = TrimName(in.value("name", std::string()));
			if (name.empty())
				return fail("Give the catalog a name");
			if (g_catalogs.size() >= 64)
				return fail("That is a lot of catalogs - 64 is the cap");
			for (const auto& c : g_catalogs)
				if (Lower(c.name) == Lower(name))
					return fail("You already have a catalog called " + c.name);
			Catalog c;
			c.id = "c" + std::to_string(g_catCounter++);
			c.name = name;
			g_catalogs.push_back(c);
			SaveSidecarLocked();
			logger::info("settlement: catalog '{}' added", name);
			return Dump(json{ { "ok", true }, { "op", op }, { "id", c.id },
				{ "msg", "Catalog " + name + " added" } });
		}

		if (op == "rename") {
			auto*       c = FindCatLocked(in.value("id", std::string()));
			std::string name = TrimName(in.value("name", std::string()));
			if (!c)
				return fail("That catalog no longer exists");
			if (name.empty())
				return fail("A catalog needs a name");
			for (const auto& o : g_catalogs)
				if (&o != c && Lower(o.name) == Lower(name))
					return fail("You already have a catalog called " + o.name);
			c->name = name;
			SaveSidecarLocked();
			return Dump(json{ { "ok", true }, { "op", op }, { "msg", "Renamed" } });
		}

		if (op == "del") {
			const std::string id = in.value("id", std::string());
			auto it = std::find_if(g_catalogs.begin(), g_catalogs.end(),
				[&](const Catalog& c) { return c.id == id; });
			if (it == g_catalogs.end())
				return fail("That catalog no longer exists");
			const auto name = it->name;
			g_catalogs.erase(it);   // removes the membership list, never an object record
			SaveSidecarLocked();
			logger::info("settlement: catalog '{}' deleted", name);
			return Dump(json{ { "ok", true }, { "op", op }, { "msg", name + " removed" } });
		}

		if (op == "reorder") {
			const auto order = in.value("order", json::array());
			std::vector<Catalog>            next;
			std::unordered_map<std::string, bool> placed;
			if (order.is_array())
				for (const auto& idv : order) {
					const auto cid = idv.is_string() ? idv.get<std::string>() : std::string();
					if (cid.empty() || placed.count(cid))
						continue;
					for (auto& c : g_catalogs)
						if (c.id == cid) {
							next.push_back(c);
							placed[cid] = true;
							break;
						}
				}
			for (auto& c : g_catalogs)
				if (!placed.count(c.id))
					next.push_back(c);
			g_catalogs = std::move(next);
			SaveSidecarLocked();
			return Dump(json{ { "ok", true }, { "op", op }, { "msg", "" } });
		}

		if (op == "file" || op == "unfile") {
			auto* c = FindCatLocked(in.value("catId", std::string()));
			if (!c)
				return fail("That catalog no longer exists");
			std::string   plugin;
			std::uint32_t local = 0;
			if (!SplitId(in.value("id", std::string()), plugin, local))
				return fail("Malformed object id");
			char hex[16];
			std::snprintf(hex, sizeof(hex), "%06X", local);
			const std::string plow = Lower(plugin);
			auto same = [&](const CatItem& ci) {
				return Lower(ci.plugin) == plow && Lower(ci.local) == Lower(hex);
			};
			if (op == "file") {
				if (std::none_of(c->items.begin(), c->items.end(), same))
					c->items.push_back(CatItem{ plugin, hex });
			} else {
				c->items.erase(std::remove_if(c->items.begin(), c->items.end(), same), c->items.end());
			}
			SaveSidecarLocked();
			return Dump(json{ { "ok", true }, { "op", op }, { "msg", "" },
				{ "count", static_cast<int>(c->items.size()) } });
		}

		if (op == "export") {
			auto* c = FindCatLocked(in.value("catId", std::string()));
			if (!c)
				return fail("That catalog no longer exists");
			std::error_code ec;
			std::filesystem::create_directories(CatalogDir(), ec);
			json items = json::array();
			for (const auto& ci : c->items) {
				// Convenience label on export; {plugin,local} is authoritative on import.
				std::string label;
				auto* dh = RE::TESDataHandler::GetSingleton();
				if (dh) {
					const std::uint32_t lv = static_cast<std::uint32_t>(std::strtoul(ci.local.c_str(), nullptr, 16));
					if (auto* f = dh->LookupForm(lv, ci.plugin)) {
						const char* nm = f->GetName();
						if (nm && *nm)
							label = nm;
					}
				}
				items.push_back(json{ { "plugin", ci.plugin }, { "local", ci.local }, { "name", label } });
			}
			const std::string file = SanitizeFile(c->name) + ".json";
			const auto        path = CatalogDir() / file;
			json out = json{
				{ "schema", "skymanager-settlement-catalog" }, { "version", 1 },
				{ "name", c->name }, { "exportedBy", "SkyManager" }, { "items", std::move(items) } };
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream f(tmp, std::ios::trunc | std::ios::binary);
				if (!f.is_open())
					return fail("Could not write the catalog file");
				f << Dump(out);
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				return fail("Catalog file write failed: " + ec.message());
			logger::info("settlement: catalog '{}' exported to {}", c->name, file);
			return Dump(json{ { "ok", true }, { "op", op }, { "path", PathU8(path) }, { "file", file } });
		}

		if (op == "importscan") {
			std::error_code ec;
			json files = json::array();
			if (std::filesystem::exists(CatalogDir(), ec)) {
				for (const auto& de : std::filesystem::directory_iterator(CatalogDir(), ec)) {
					if (ec || !de.is_regular_file())
						continue;
					if (de.path().extension() != ".json")
						continue;
					std::ifstream f(de.path(), std::ios::binary);
					if (!f)
						continue;
					try {
						json j = json::parse(f, nullptr, true, true);
						if (j.value("schema", std::string()) != "skymanager-settlement-catalog")
							continue;
						files.push_back(json{
							{ "name", j.value("name", PathU8(de.path().stem())) },
							{ "itemCount", j.contains("items") && j["items"].is_array()
							                   ? static_cast<int>(j["items"].size()) : 0 },
							{ "file", PathU8(de.path().filename()) } });
					} catch (...) {}
				}
			}
			return Dump(json{ { "ok", true }, { "op", op }, { "files", std::move(files) } });
		}

		if (op == "import") {
			const std::string file = in.value("file", std::string());
			if (file.empty() || file.find('/') != std::string::npos ||
				file.find('\\') != std::string::npos || file.find("..") != std::string::npos)
				return fail("Bad catalog file name");
			const auto path = CatalogDir() / file;
			std::ifstream f(path, std::ios::binary);
			if (!f)
				return fail("No such catalog file");
			json j;
			try {
				j = json::parse(f, nullptr, true, true);
			} catch (...) {
				return fail("That catalog file is unreadable");
			}
			if (j.value("schema", std::string()) != "skymanager-settlement-catalog")
				return fail("That file is not a settlement catalog");
			if (g_catalogs.size() >= 64)
				return fail("64 catalogs already - remove one first");
			std::string base = TrimName(j.value("name", std::string("Imported")));
			if (base.empty())
				base = "Imported";
			std::string name = base;
			for (int n = 1; std::any_of(g_catalogs.begin(), g_catalogs.end(),
				     [&](const Catalog& c) { return Lower(c.name) == Lower(name); }); ++n)
				name = base + " (imported)";
			Catalog c;
			c.id = "c" + std::to_string(g_catCounter++);
			c.name = name;
			int imported = 0, missing = 0;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (j.contains("items") && j["items"].is_array())
				for (const auto& ij : j["items"]) {
					if (!ij.is_object())
						continue;
					CatItem ci;
					ci.plugin = ij.value("plugin", std::string());
					ci.local = ij.value("local", std::string());
					if (ci.plugin.empty() || ci.local.empty())
						continue;
					// Keep the item even when its plugin is absent (honest — a
					// shared catalog referencing an unowned mod is not silently
					// dropped; the row is flagged missing in the next query).
					if (dh) {
						const std::uint32_t lv =
							static_cast<std::uint32_t>(std::strtoul(ci.local.c_str(), nullptr, 16));
						if (!dh->LookupForm(lv, ci.plugin))
							++missing;
					}
					c.items.push_back(std::move(ci));
					++imported;
				}
			g_catalogs.push_back(std::move(c));
			SaveSidecarLocked();
			logger::info("settlement: catalog '{}' imported - {} items ({} missing)", name, imported, missing);
			return Dump(json{ { "ok", true }, { "op", op }, { "id", g_catalogs.back().id },
				{ "imported", imported }, { "missing", missing } });
		}

		return fail("Unknown catalog op");
	}

	std::string Placed(const std::string& req)
	{
		(void)req;
		std::lock_guard l(g_stateMutex);
		LoadSidecarLocked();
		json items = json::array();
		for (const auto& p : g_placed) {
			// Is the ref live in THIS save? (jump/remove are only meaningful then.)
			const std::uint32_t refId =
				static_cast<std::uint32_t>(std::strtoul(p.refFormId.c_str(), nullptr, 16));
			auto* ref = refId ? RE::TESForm::LookupByID<RE::TESObjectREFR>(refId) : nullptr;
			// A readable cell name for the roster's location line — the live ref's
			// parent cell when it resolves, else the stored durable cell id. The
			// view keys are name/kind/cell (the My-placements sub-view contract).
			std::string cell;
			if (ref) {
				if (auto* c = ref->GetParentCell()) {
					const char* cn = c->GetName();
					if (cn && *cn)
						cell = cn;
					else if (const char* eid = c->GetFormEditorID(); eid && *eid)
						cell = eid;
				}
			}
			if (cell.empty())
				cell = p.cellId;
			items.push_back(json{
				{ "id", p.refFormId },
				{ "name", p.name },
				{ "kind", p.kind },
				{ "cell", cell },
				{ "base", p.basePlugin + "|" + p.baseLocal },
				{ "live", ref != nullptr },
			});
		}
		return Dump(json{ { "ok", true }, { "items", std::move(items) } });
	}

	void OnPostLoadGame()
	{
		// Re-resolve each stored placement against the LIVE save and prune
		// anything that belonged to a different save (no co-save serializer).
		std::lock_guard l(g_stateMutex);
		LoadSidecarLocked();
		if (g_placed.empty())
			return;
		auto* dh = RE::TESDataHandler::GetSingleton();
		std::size_t before = g_placed.size();
		g_placed.erase(std::remove_if(g_placed.begin(), g_placed.end(), [&](const PlacedRec& p) {
			const std::uint32_t refId =
				static_cast<std::uint32_t>(std::strtoul(p.refFormId.c_str(), nullptr, 16));
			auto* ref = refId ? RE::TESForm::LookupByID<RE::TESObjectREFR>(refId) : nullptr;
			if (!ref)
				return true;  // ref doesn't resolve — different save
			// Base must match the durable identity we recorded.
			auto* base = ref->GetBaseObject();
			if (!base || !dh)
				return true;
			auto* bfile = base->GetFile(0);
			if (!bfile)
				return true;
			const std::uint32_t local = base->GetFormID() & (bfile->IsLight() ? 0xFFFu : 0xFFFFFFu);
			char lbuf[16];
			std::snprintf(lbuf, sizeof(lbuf), "%06X", local);
			const bool ok = Lower(bfile->GetFilename()) == Lower(p.basePlugin) &&
			                Lower(lbuf) == Lower(p.baseLocal);
			return !ok;
		}), g_placed.end());
		if (g_placed.size() != before) {
			logger::info("settlement: placements reconciled - {} kept, {} pruned",
				g_placed.size(), before - g_placed.size());
			SaveSidecarLocked();
		} else {
			logger::info("settlement: placements reconciled - all {} kept", g_placed.size());
		}
	}
}
