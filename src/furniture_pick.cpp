#include "furniture_pick.h"

#include "actor_identity.h"
#include "item_icons.h"
#include "party_recall.h"
#include "ostim_thread_api.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <set>
#include <thread>
#include <vector>

#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")

// pch (force-included) provides RE::/SKSE::/json/logger.

// Something in this TU's include graph pulls <Windows.h> without NOMINMAX:
// `min` breaks std::min and `GetObject` renames Variable::GetObject to
// GetObjectA. Neutralize both -- file scope, nothing here wants the macros.
#ifdef GetObject
#	undef GetObject
#endif
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

using json = nlohmann::json;
namespace OT = OstimNG_API::Thread;

namespace FurniturePick
{
	namespace
	{
		const std::filesystem::path kSidecar =
			std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "furniture-pick.json";

		// OStim's own Papyrus entry (OSKSE.psc) - the call we stand in for.
		constexpr const char* kPromptClass = "OSKSE";
		constexpr const char* kPromptFn = "UIExtMessageBox";

		// How far around the player we look for furniture, game units (70 = 1 m).
		constexpr float kRadiusInterior = 5200.0f;
		constexpr float kRadiusExterior = 3600.0f;
		constexpr float kUnitsPerMeter = 70.0f;
		constexpr std::size_t kMaxCandidates = 48;
		// OStim's bed search accepts the same floor only (+/- this much, units).
		constexpr float kSameFloor = 96.0f;
		constexpr int kClassifyTimeoutMs = 2500;
		constexpr int kWantWindowMs = 25000;   // how long a chosen piece waits for its thread

		enum class Kind { Bed, Select, AddActor };

		struct Settings
		{
			bool enabled = true;
			bool chim = true;   // tell CHIM public/private and who joined (public_scene/scene_api.php)
		};

		struct Cand
		{
			std::uint32_t refId = 0;
			std::string   key;        // "r" + hex ref id: what the view sends back
			std::string   name;       // the object's own name ("Hunter's Bed")
			std::string   type;       // OStim's id ("bed", "chair", ...)
			std::string   label;      // the type, spoken ("Bed", "Chair")
			std::string   group;      // "bed" | "seat" | "other"
			std::string   baseId;     // durable base id, for the render
			std::string   plugin;
			float         meters = 0.0f;
			float         dz = 0.0f;  // + above the player
			bool          owned = false;
			bool          valid = false;   // OStim classified it as something it can use
			bool          answered = false;
		};

		// One person in the add-actor picker.
		struct ActorCand
		{
			std::uint32_t formId = 0;
			std::string   key;      // "a" + hex id
			std::string   name, sub, group;   // group: "near" | "follow" | "far"
			float         meters = -1.0f;     // -1 = another place
			int           opt = -1;           // OStim's own option index, -1 = joins after the start
		};

		// The original Papyrus call, kept so that when the picker cannot be shown the
		// real UIExtensions popup is what the player gets, never a silent default.
		struct Fallback
		{
			RE::BSFixedString                 cls, fn;
			RE::BSScript::IFunctionArguments* args = nullptr;
		};

		struct Pending
		{
			Fallback                                                 fb;
			bool                                                     active = false;
			Kind                                                     kind = Kind::Bed;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			std::vector<std::string>                                 options;
			bool                                                     sceneRunning = false;
			std::uint64_t                                            gen = 0;
			bool                                                     shown = false;
			int                                                      outstanding = 0;
			std::vector<Cand>                                        cands;
			std::vector<ActorCand>                                   actors;
		};

		// The piece a player chose, waiting for the thread that will use it.
		struct Want
		{
			bool                                  active = false;
			std::uint32_t                         refId = 0;
			std::vector<std::uint32_t>            joiners;   // actors to bring into the scene once it exists
			std::chrono::steady_clock::time_point until{};
		};

		Settings                               g_s;
		bool                                   g_loaded = false;
		bool                                   g_hooked = false;
		Host                                   g_host;
		Pending                                g_p;
		Want                                   g_want;
		std::uint64_t                          g_gen = 0;
		OT::IThreadInterface*                  g_api = nullptr;
		bool                                   g_listening = false;
		std::map<std::string, std::string>     g_tr;   // OStim translation key -> text
		bool                                   g_trLoaded = false;
		std::map<std::string, std::vector<std::string>> g_trAll;   // every value a key was given
		// A multi-pick's remaining people, answered one prompt at a time.
		std::vector<std::uint32_t>             g_aq;
		bool                                   g_aqActive = false;
		std::chrono::steady_clock::time_point  g_aqUntil{};
		// What CHIM was last told about this scene's privacy, and when.
		std::string                            g_privMode;
		std::chrono::steady_clock::time_point  g_privAt{};
		constexpr auto                         kPrivWindow = std::chrono::seconds(120);

		bool PrivacyWindowOpen()
		{
			return !g_privMode.empty() && std::chrono::steady_clock::now() - g_privAt < kPrivWindow;
		}
		// The scene's terms (CHIM op=terms), told once per start like the privacy.
		std::string                            g_termsKey;   // "consent|arrangement" last told
		std::chrono::steady_clock::time_point  g_termsAt{};
		bool TermsWindowOpen(const std::string& key)
		{
			return !g_termsKey.empty() && g_termsKey == key && std::chrono::steady_clock::now() - g_termsAt < kPrivWindow;
		}
		struct Terms
		{
			std::string consent, arrangement;   // validated; empty = not asked
			std::string Key() const { return consent + "|" + arrangement; }
			bool        Any() const { return !consent.empty() || !arrangement.empty(); }
		};
		int  PeopleAround();
		void ReleaseAfterChim(const char* why, int index, std::string mode, Terms terms, std::vector<std::string> joins);
		bool DispatchOriginal(const Fallback& fb, RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor>& cb);

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		std::string Hex(std::uint32_t v)
		{
			char b[16];
			std::snprintf(b, sizeof(b), "%08X", v);
			return b;
		}

		// ---------------------------------------------------------------- settings
		void Save()
		{
			json j{ { "enabled", g_s.enabled }, { "chim", g_s.chim } };
			std::error_code ec;
			std::filesystem::create_directories(kSidecar.parent_path(), ec);
			std::ofstream out(kSidecar, std::ios::binary | std::ios::trunc);
			if (out)
				out << Dump(j);
		}

		void Load()
		{
			if (g_loaded)
				return;
			g_loaded = true;
			std::ifstream in(kSidecar, std::ios::binary);
			if (!in)
				return;
			const auto j = json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return;
			g_s.enabled = j.value("enabled", true);
			g_s.chim = j.value("chim", true);
		}

		// ------------------------------------------------------------ translations
		// OStim localizes the caption and the options BEFORE it hands them to
		// Papyrus (GameAPI::Game::showMessageBox), so what arrives is the player's
		// language: we read the same OStim_<LANG>.txt to recognise the two
		// furniture prompts. English is always loaded first as the floor.
		std::string Utf8(const std::wstring& w)
		{
			if (w.empty())
				return {};
			const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
			std::string s(static_cast<std::size_t>(n), '\0');
			WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
			return s;
		}

		bool LoadTranslationFile(const std::string& lang)
		{
			const auto path = std::filesystem::path("Data") / "Interface" / "Translations" / ("OStim_" + lang + ".txt");
			std::ifstream in(path, std::ios::binary);
			if (!in)
				return false;
			const std::string raw((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
			std::string text;
			if (raw.size() >= 2 && static_cast<unsigned char>(raw[0]) == 0xFF && static_cast<unsigned char>(raw[1]) == 0xFE) {
				std::wstring w(reinterpret_cast<const wchar_t*>(raw.data() + 2), (raw.size() - 2) / 2);
				text = Utf8(w);
			} else {
				text = raw;
				if (text.size() >= 3 && static_cast<unsigned char>(text[0]) == 0xEF)
					text.erase(0, 3);
			}
			std::size_t pos = 0;
			while (pos < text.size()) {
				std::size_t end = text.find('\n', pos);
				if (end == std::string::npos)
					end = text.size();
				std::string line = text.substr(pos, end - pos);
				pos = end + 1;
				while (!line.empty() && (line.back() == '\r' || line.back() == '\n'))
					line.pop_back();
				if (line.empty() || line[0] != '$')
					continue;
				const auto tab = line.find('\t');
				if (tab == std::string::npos)
					continue;
				g_tr[line.substr(0, tab)] = line.substr(tab + 1);
				g_trAll[line.substr(0, tab)].push_back(line.substr(tab + 1));
			}
			return true;
		}

		void EnsureTranslations()
		{
			if (g_trLoaded)
				return;
			g_trLoaded = true;
			LoadTranslationFile("ENGLISH");
			std::string lang = "ENGLISH";
			if (auto* ini = RE::INISettingCollection::GetSingleton())
				if (auto* st = ini->GetSetting("sLanguage:General"))
					if (st->GetType() == RE::Setting::Type::kString && st->data.s && *st->data.s)
						lang = st->data.s;
			for (auto& c : lang)
				c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
			if (lang != "ENGLISH")
				LoadTranslationFile(lang);
		}

		std::string Tr(const char* key, const char* fallback)
		{
			EnsureTranslations();
			const auto it = g_tr.find(key);
			return it != g_tr.end() && !it->second.empty() ? it->second : std::string(fallback);
		}

		// OStim's translation files give the add-actor key two different lines
		// ("Add actor?" and "Select an actor to add to the scene"); which one wins
		// is OStim's business, so a prompt matches any value the key ever had.
		bool MatchesKey(const std::string& lowContent, const char* key, const char* fallback)
		{
			EnsureTranslations();
			if (lowContent == Lower(fallback))
				return true;
			const auto it = g_trAll.find(key);
			if (it == g_trAll.end())
				return false;
			for (const auto& v : it->second)
				if (!v.empty() && Lower(v) == lowContent)
					return true;
			return false;
		}

		std::string TypeLabel(const std::string& id)
		{
			EnsureTranslations();
			const auto it = g_tr.find("$ostim_furniture_" + id);
			if (it != g_tr.end() && !it->second.empty())
				return it->second;
			static const std::map<std::string, std::string> kNice{
				{ "bed", "Bed" }, { "singlebed", "Single bed" }, { "doublebed", "Double bed" }, { "bedroll", "Bedroll" },
				{ "chair", "Chair" }, { "bench", "Bench" }, { "table", "Table" }, { "wall", "Wall" }, { "shelf", "Shelf" },
				{ "wardrobe", "Wardrobe" }, { "wardrobethick", "Wardrobe" }, { "wardrobethin", "Wardrobe" },
				{ "cookingpot", "Cooking pot" }, { "alchemytable", "Alchemy table" },
				{ "enchantingtable", "Enchanting table" }, { "tableleanmarker", "Table edge" },
				{ "tableleanmarkerbbls", "Table edge" },
			};
			const auto n = kNice.find(id);
			if (n != kNice.end())
				return n->second;
			std::string s = id;
			if (!s.empty())
				s[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(s[0])));
			return s;
		}

		std::string GroupOf(const std::string& type)
		{
			if (type.find("bed") != std::string::npos)
				return "bed";
			if (type == "chair" || type == "bench")
				return "seat";
			return "other";
		}

		// ----------------------------------------------------------------- OStim
		bool EnsureListening();

		bool OstimThreadRunning()
		{
			if (!g_api)
				EnsureListening();
			// OStim's GetPlayerThreadID() is a stub that returns 0; the player's
			// scene IS thread 0 and IsThreadValid(0) is the real signal.
			return g_api && g_api->IsThreadValid(0);
		}

		bool ThreadHasPlayer(std::uint32_t tid)
		{
			if (!g_api || !g_api->IsThreadValid(tid))
				return false;
			const std::uint32_t n = g_api->GetActorCount(tid);
			if (!n)
				return false;
			std::vector<OT::ActorData> buf(n);
			const std::uint32_t        got = g_api->GetActors(tid, buf.data(), n);
			const auto*                pc = RE::PlayerCharacter::GetSingleton();
			const std::uint32_t        player = pc ? pc->GetFormID() : 0x14;
			for (std::uint32_t i = 0; i < got; ++i)
				if (buf[i].formID == player)
					return true;
			return false;
		}

		// ------------------------------------------------------------ Papyrus glue
		class VarResult final : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit VarResult(std::function<void(const RE::BSScript::Variable&)> then) :
				_then(std::move(then))
			{}
			void operator()(RE::BSScript::Variable a_result) override
			{
				if (_then)
					_then(a_result);
			}
			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::function<void(const RE::BSScript::Variable&)> _then;
		};

		void ChangeFurniture(std::uint32_t tid, std::uint32_t refId)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(refId);
			if (!vm || !ref)
				return;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto* args = RE::MakeFunctionArguments(static_cast<int>(tid), static_cast<RE::TESObjectREFR*>(ref), RE::BSFixedString(""));
			// Build marker (hd-markers.json: "furniture-pick-move").
			logger::info("furniture-pick: move thread {} to {:08X}", tid, refId);
			vm->DispatchStaticCall("OThread", "ChangeFurniture", args, cb);
		}

		// Complete OStim's pending Papyrus call with `index`, exactly the int
		// OSKSE.UIExtMessageBox would have returned. Main thread.
		void Answer(const RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor>& cb, int index)
		{
			if (!cb)
				return;
			RE::BSScript::Variable v;
			v.SetSInt(index);
			(*cb)(v);
		}

		// -------------------------------------------------------------- candidates
		bool Usable(RE::TESObjectREFR* ref, RE::TESFurniture*& furnOut)
		{
			furnOut = nullptr;
			if (!ref || ref->IsDisabled() || ref->IsDeleted() || !ref->Is3DLoaded())
				return false;
			auto* base = ref->GetBaseObject();
			if (!base || !base->Is(RE::FormType::Furniture))
				return false;
			auto* furn = base->As<RE::TESFurniture>();
			if (!furn)
				return false;
			using AM = RE::TESFurniture::ActiveMarker;
			using BT = RE::TESFurniture::WorkBenchData::BenchType;
			const bool marker = furn->furnFlags.any(AM::kCanSit, AM::kCanSleep, AM::kCanLean);
			const bool bench = furn->workBenchData.benchType.get() != BT::kNone;
			if (!marker && !bench)
				return false;
			furnOut = furn;
			return true;
		}

		std::vector<Cand> ScanAround()
		{
			std::vector<Cand> out;
			auto*             pc = RE::PlayerCharacter::GetSingleton();
			auto*             tes = RE::TES::GetSingleton();
			if (!pc || !tes)
				return out;
			const bool  interior = pc->GetParentCell() && pc->GetParentCell()->IsInteriorCell();
			const float radius = interior ? kRadiusInterior : kRadiusExterior;
			const auto  here = pc->GetPosition();
			auto*       playerBase = pc->GetActorBase();

			tes->ForEachReferenceInRange(pc, radius, [&](RE::TESObjectREFR* ref) {
				RE::TESFurniture* furn = nullptr;
				if (ref == pc || !Usable(ref, furn))
					return RE::BSContainer::ForEachResult::kContinue;
				Cand c;
				c.refId = ref->GetFormID();
				c.key = "r" + Hex(c.refId);
				const auto  pos = ref->GetPosition();
				const float dx = pos.x - here.x, dy = pos.y - here.y, dz = pos.z - here.z;
				c.meters = std::sqrt(dx * dx + dy * dy + dz * dz) / kUnitsPerMeter;
				c.dz = dz;
				if (const char* n = ref->GetDisplayFullName(); n && *n)
					c.name = n;
				if (const auto* owner = ref->GetOwner())
					c.owned = !(playerBase && owner->GetFormID() == playerBase->GetFormID()) && owner->GetFormID() != 0x7;
				ActorIdentity::DurableOf(furn, c.baseId, c.plugin);
				out.push_back(std::move(c));
				return RE::BSContainer::ForEachResult::kContinue;
			});

			std::sort(out.begin(), out.end(), [](const Cand& a, const Cand& b) { return a.meters < b.meters; });
			if (out.size() > kMaxCandidates)
				out.resize(kMaxCandidates);
			return out;
		}

		json CandJson(const Cand& c, bool nearest)
		{
			std::string icon;
			if (!c.baseId.empty() && !c.plugin.empty())
				icon = ItemIcons::IconPathIfRendered(c.baseId, c.plugin);
			return json{
				{ "key", c.key },
				{ "name", c.name.empty() ? c.label : c.name },
				{ "type", c.type },
				{ "label", c.label },
				{ "group", c.group },
				{ "m", std::round(c.meters * 10.0f) / 10.0f },
				{ "up", c.dz > kSameFloor },
				{ "down", c.dz < -kSameFloor },
				{ "owned", c.owned },
				{ "nearest", nearest },
				{ "bid", c.baseId.empty() ? std::string() : c.baseId + "|" + Lower(c.plugin) },
				{ "icon", icon },
			};
		}

		// The index of the candidate OStim would take: the nearest bed on the
		// player's floor for the bed prompt, the nearest of anything otherwise.
		int NearestIndex(const std::vector<Cand>& v, Kind kind)
		{
			int best = -1;
			for (int i = 0; i < static_cast<int>(v.size()); ++i) {
				if (!v[i].valid)
					continue;
				if (kind == Kind::Bed && v[i].group != "bed")
					continue;
				if (kind == Kind::Bed && std::fabs(v[i].dz) > kSameFloor)
					continue;
				if (best < 0 || v[i].meters < v[best].meters)
					best = i;
			}
			if (best < 0 && kind == Kind::Bed) {
				for (int i = 0; i < static_cast<int>(v.size()); ++i)
					if (v[i].valid && v[i].group == "bed" && (best < 0 || v[i].meters < v[best].meters))
						best = i;
			}
			return best;
		}

		void Release(const char* why, int index)
		{
			if (!g_p.active)
				return;
			auto cb = g_p.cb;
			g_p = Pending{};
			if (g_host.hide)
				g_host.hide();
			// Build marker (hd-markers.json: "furniture-pick-release").
			logger::info("furniture-pick: released the prompt with {} ({})", index, why);
			Answer(cb, index);
		}

		// The picker cannot serve this prompt: let the REAL call run, so the player
		// gets UIExtensions' own popup exactly as before rather than nothing.
		void PassBack(const Fallback& fb, RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb, const char* why)
		{
			// Build marker (hd-markers.json: "furniture-pick-passback").
			logger::info("furniture-pick: handing the prompt back to UIExtensions ({})", why);
			if (fb.args && DispatchOriginal(fb, cb))
				return;
			Answer(cb, 0);   // the original could not be re-dispatched: OStim's own default
		}

		void PassOn(const char* why)
		{
			if (!g_p.active)
				return;
			const auto fb = g_p.fb;
			const auto cb = g_p.cb;
			g_p = Pending{};
			if (g_host.hide)
				g_host.hide();
			PassBack(fb, cb, why);
		}

		void Present();

		// The scene's terms for the picker: consensual / forced and what she is to him.
		json TermsJson()
		{
			if (!g_s.chim)
				return json();
			return json{ { "consent", "consensual" }, { "arrangement", "casual" },
				{ "current", g_termsKey.empty() || !TermsWindowOpen(g_termsKey) ? std::string() : g_termsKey } };
		}

		Terms ParseTerms(const json& j)
		{
			Terms t;
			if (!j.is_object() || !j.contains("terms") || !j["terms"].is_object())
				return t;
			const auto& o = j["terms"];
			const std::string c = o.value("consent", std::string());
			const std::string a = o.value("arrangement", std::string());
			if (c == "consensual" || c == "forced")
				t.consent = c;
			for (const char* ok : { "marital", "lover", "owned", "slave", "paid", "casual" })
				if (a == ok)
					t.arrangement = a;
			return t;
		}

		json PrivacyJson()
		{
			if (!g_s.chim)
				return json();
			const int people = PeopleAround();
			return json{ { "default", people >= 2 ? "public" : "private" },
				{ "current", PrivacyWindowOpen() ? g_privMode : std::string() }, { "people", people } };
		}

		void OnClassified(std::uint64_t gen, std::uint32_t refId, const std::string& type)
		{
			if (!g_p.active || g_p.gen != gen || g_p.shown)
				return;
			for (auto& c : g_p.cands) {
				if (c.refId != refId || c.answered)
					continue;
				c.answered = true;
				--g_p.outstanding;
				const std::string t = Lower(type);
				if (!t.empty() && t != "none") {
					c.valid = true;
					c.type = t;
					c.label = TypeLabel(t);
					c.group = GroupOf(t);
				}
				break;
			}
			if (g_p.outstanding <= 0)
				Present();
		}

		// ------------------------------------------------------------ the people
		std::string ActorName(RE::Actor* a)
		{
			if (!a)
				return {};
			if (const char* n = a->GetName(); n && *n)
				return n;
			return {};
		}

		// Everyone loaded who could join a scene, nearest first, tagged for the view.
		// OStim's own list is the nearest eight eligible actors within 2000 units; a
		// person on it keeps `opt` (its option index) so a pick can be answered by
		// index. Everyone else is "joins after the start".
		std::vector<ActorCand> ScanActors(const std::vector<std::string>& options)
		{
			std::vector<ActorCand> out;
			auto*                  pc = RE::PlayerCharacter::GetSingleton();
			auto*                  lists = RE::ProcessLists::GetSingleton();
			if (!pc || !lists)
				return out;

			std::set<std::uint32_t> party;
			for (const auto& m : PartyRecall::Members())
				party.insert(m.formId);

			const auto* here = pc->GetParentCell();
			const auto  pos = pc->GetPosition();
			std::set<RE::FormID> seen;

			const RE::BSTArray<RE::ActorHandle>* arrays[4] = {
				&lists->highActorHandles, &lists->middleHighActorHandles,
				&lists->middleLowActorHandles, &lists->lowActorHandles
			};
			for (const auto* arr : arrays) {
				for (const auto& h : *arr) {
					auto ptr = h.get();
					RE::Actor* a = ptr ? ptr.get() : nullptr;
					if (!a || a == pc || a->IsPlayerRef() || a->IsDead() || a->IsDisabled())
						continue;
					if (!seen.insert(a->GetFormID()).second)
						continue;
					if (!a->HasKeywordString("ActorTypeNPC"))
						continue;   // people, not wolves
					if (g_api && g_api->IsActorInAnyThread(a->GetFormID()))
						continue;   // already in a scene
					const std::string name = ActorName(a);
					if (name.empty())
						continue;
					ActorCand c;
					c.formId = a->GetFormID();
					c.key = "a" + Hex(c.formId);
					c.name = name;
					const bool sameCell = a->GetParentCell() && a->GetParentCell() == here;
					if (sameCell) {
						const auto p = a->GetPosition();
						const float dx = p.x - pos.x, dy = p.y - pos.y, dz = p.z - pos.z;
						c.meters = std::sqrt(dx * dx + dy * dy + dz * dz) / kUnitsPerMeter;
					}
					if (auto* race = a->GetRace(); race && race->GetName() && *race->GetName())
						c.sub = race->GetName();
					const bool follower = party.count(c.formId) != 0;
					c.group = follower ? "follow" : (sameCell && c.meters >= 0.0f && c.meters < 40.0f ? "near" : "far");
					if (follower)
						c.sub = c.sub.empty() ? "Follower" : c.sub + " \xC2\xB7 Follower";
					out.push_back(std::move(c));
				}
			}

			std::sort(out.begin(), out.end(), [](const ActorCand& a, const ActorCand& b) {
				const bool ah = a.meters >= 0.0f, bh = b.meters >= 0.0f;
				if (ah != bh)
					return ah;
				return a.meters < b.meters;
			});

			// Map OStim's own options (names, nearest first) onto people, in order.
			std::vector<bool> used(options.size(), false);
			for (auto& c : out) {
				if (c.meters < 0.0f || c.meters * kUnitsPerMeter > 2000.0f)
					continue;
				for (std::size_t i = 1; i < options.size(); ++i) {
					if (!used[i] && options[i] == c.name) {
						used[i] = true;
						c.opt = static_cast<int>(i);
						break;
					}
				}
			}
			if (out.size() > 160)
				out.resize(160);
			return out;
		}

		json ActorJson(const ActorCand& c)
		{
			return json{
				{ "key", c.key },
				{ "name", c.name },
				{ "sub", c.sub },
				{ "group", c.group },
				{ "m", c.meters < 0.0f ? -1.0f : std::round(c.meters * 10.0f) / 10.0f },
				{ "now", c.opt > 0 },
			};
		}

		void BeginActors(RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb, std::vector<std::string> options, const Fallback& fb)
		{
			// A multi-pick in progress: OStim asks again after every added actor, so
			// answer from the queue, silently, and finish with None.
			if (g_aqActive) {
				if (std::chrono::steady_clock::now() > g_aqUntil) {
					g_aqActive = false;
					g_aq.clear();
				} else {
					while (!g_aq.empty()) {
						const auto id = g_aq.front();
						g_aq.erase(g_aq.begin());
						const std::string nm = ActorName(RE::TESForm::LookupByID<RE::Actor>(id));
						for (std::size_t i = 1; i < options.size(); ++i) {
							if (options[i] == nm) {
								// Build marker (hd-markers.json: "furniture-pick-actor-queue").
								logger::info("furniture-pick: adding queued actor {:08X} as option {}", id, i);
								Answer(cb, static_cast<int>(i));
								return;
							}
						}
					}
					g_aqActive = false;
					Answer(cb, 0);
					return;
				}
			}

			g_p = Pending{};
			g_p.fb = fb;
			g_p.active = true;
			g_p.kind = Kind::AddActor;
			g_p.cb = cb;
			g_p.options = std::move(options);
			g_p.gen = ++g_gen;
			g_p.actors = ScanActors(g_p.options);
			if (g_p.actors.empty()) {
				logger::info("furniture-pick: nobody to add - passing the prompt on with None");
				PassOn("nobody to add");
				return;
			}

			json items = json::array();
			for (const auto& c : g_p.actors)
				items.push_back(ActorJson(c));
			std::string facesJson = "{}";
			if (g_host.faces) {
				std::vector<std::uint32_t> ids;
				for (const auto& c : g_p.actors)
					ids.push_back(c.formId);
				facesJson = g_host.faces(ids);
			}
			json faces = json::parse(facesJson, nullptr, false);
			if (faces.is_object()) {
				for (auto& it : items) {
					const std::string key = it.value("key", std::string());
					const auto        f = faces.find(key.substr(1));
					if (f != faces.end() && f->is_object()) {
						it["portrait"] = f->value("portrait", std::string());
						it["face"] = f->value("face", std::string());
					}
				}
			}
			g_p.shown = true;
			json payload{
				{ "kind", "actors" },
				{ "sceneRunning", false },
				{ "title", "Who else joins?" },
				{ "caption", Tr("$ostim_message_add_actor", "Select an actor to add to the scene") },
				{ "noneLabel", "Nobody else" },
				{ "max", 3 },
				{ "items", items },
				{ "privacy", PrivacyJson() },
				{ "terms", TermsJson() },
			};
			// Build marker (hd-markers.json: "furniture-pick-actors").
			logger::info("furniture-pick: showing {} people for the add-actor prompt", g_p.actors.size());
			if (!g_host.show(Dump(payload))) {
				logger::warn("furniture-pick: the picker would not open");
				PassOn("view refused");
			}
		}

		// The player's pick in the add-actor picker: {keys:[...]} (or key none/default).
		void PickActors(const json& j)
		{
			std::vector<std::string> keys;
			if (j.contains("keys") && j["keys"].is_array())
				for (const auto& k : j["keys"])
					if (k.is_string())
						keys.push_back(k.get<std::string>());
			std::vector<const ActorCand*> chosen;
			for (const auto& k : keys)
				for (const auto& c : g_p.actors)
					if (c.key == k) {
						chosen.push_back(&c);
						break;
					}

			std::vector<std::uint32_t> queue, joiners;
			std::vector<int>           opts;
			std::vector<std::string>   names;   // everyone added, for CHIM
			for (const auto* c : chosen)
				names.push_back(c->name);
			for (const auto* c : chosen) {
				if (c->opt > 0) {
					queue.push_back(c->formId);
					opts.push_back(c->opt);
				} else {
					joiners.push_back(c->formId);
				}
			}

			int answer = 0;
			if (!queue.empty()) {
				answer = opts.front();
				queue.erase(queue.begin());
				g_aq = queue;
				g_aqActive = true;
				g_aqUntil = std::chrono::steady_clock::now() + std::chrono::seconds(20);
			} else {
				g_aq.clear();
				g_aqActive = false;
			}

			if (!joiners.empty()) {
				auto* pc = RE::PlayerCharacter::GetSingleton();
				for (const auto id : joiners)
					if (auto* a = RE::TESForm::LookupByID<RE::Actor>(id); a && pc)
						a->MoveTo(pc);   // next to the player now; into the scene once it exists
				g_want.active = true;
				g_want.joiners = joiners;
				g_want.until = std::chrono::steady_clock::now() + std::chrono::milliseconds(kWantWindowMs);
			}
			// Build marker (hd-markers.json: "furniture-pick-actors-choice").
			logger::info("furniture-pick: add-actor choice - {} by option, {} to join after the start, answer {}",
				opts.size(), joiners.size(), answer);
			const std::string mode = j.value("privacy", std::string());
			ReleaseAfterChim("chosen", answer, mode, ParseTerms(j), names);
		}

		void Begin(Kind kind, RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb, std::vector<std::string> options, Fallback fb)
		{
			if (g_p.active)
				Release("a newer prompt arrived", 0);

			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !g_host.ready || !g_host.ready() || !g_host.show) {
				PassBack(fb, cb, "the picker view is not ready");
				return;
			}

			if (kind == Kind::AddActor) {
				BeginActors(cb, std::move(options), fb);
				return;
			}

			g_p = Pending{};
			g_p.fb = fb;
			g_p.active = true;
			g_p.kind = kind;
			g_p.cb = cb;
			g_p.options = std::move(options);
			g_p.sceneRunning = OstimThreadRunning();
			g_p.gen = ++g_gen;
			g_p.cands = ScanAround();

			if (g_p.cands.empty()) {
				// Build marker (hd-markers.json: "furniture-pick-none").
				logger::info("furniture-pick: nothing in range - passing the prompt on with its default");
				PassOn("no furniture in range");
				return;
			}

			// Ask OStim's own classifier about every piece: it knows what it can
			// use (keyword blacklists, marker counts, models). The answers come
			// back on the VM thread and hop here.
			g_p.outstanding = static_cast<int>(g_p.cands.size());
			const std::uint64_t gen = g_p.gen;
			for (const auto& c : g_p.cands) {
				auto*                                                    ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(c.refId);
				RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> functor(new VarResult([gen, id = c.refId](const RE::BSScript::Variable& v) {
					std::string type;
					if (v.IsString())
						type = std::string(v.GetString());
					SKSE::GetTaskInterface()->AddTask([gen, id, type]() { OnClassified(gen, id, type); });
				}));
				auto* args = RE::MakeFunctionArguments(static_cast<RE::TESObjectREFR*>(ref));
				if (!ref || !vm->DispatchStaticCall("OFurniture", "GetFurnitureType", args, functor)) {
					SKSE::GetTaskInterface()->AddTask([gen, id = c.refId]() { OnClassified(gen, id, std::string()); });
				}
			}

			// A busy Papyrus VM must not hold the prompt hostage.
			std::thread([gen]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(kClassifyTimeoutMs));
				SKSE::GetTaskInterface()->AddTask([gen]() {
					if (g_p.active && g_p.gen == gen && !g_p.shown)
						Present();
				});
			}).detach();
		}

		void Present()
		{
			if (!g_p.active || g_p.shown)
				return;
			g_p.shown = true;
			std::vector<Cand> ok;
			for (auto& c : g_p.cands)
				if (c.valid)
					ok.push_back(c);
			g_p.cands = std::move(ok);

			if (g_p.cands.empty()) {
				logger::info("furniture-pick: OStim can use none of the furniture in range - default answer");
				PassOn("nothing usable");
				return;
			}

			const int nearest = NearestIndex(g_p.cands, g_p.kind);
			json      items = json::array();
			json      renders = json::array();
			std::set<std::string> seen;
			for (int i = 0; i < static_cast<int>(g_p.cands.size()); ++i) {
				const auto& c = g_p.cands[i];
				items.push_back(CandJson(c, i == nearest));
				if (!c.baseId.empty() && seen.insert(c.baseId + "|" + c.plugin).second)
					renders.push_back({ { "formId", c.baseId }, { "plugin", c.plugin }, { "name", c.name } });
			}
			if (!renders.empty())
				ItemIcons::EnsureIconsForList(Dump(json{ { "items", renders } }));

			json payload{
				{ "kind", g_p.kind == Kind::Bed ? "bed" : "select" },
				{ "sceneRunning", g_p.sceneRunning },
				{ "title", g_p.kind == Kind::Bed ? "Where do you want to be?" : "Which furniture?" },
				{ "caption", g_p.kind == Kind::Bed ? Tr("$ostim_message_use_bed", "Do you want to use the nearby bed?")
				                                   : Tr("$ostim_message_select_furniture", "Which furniture do you want") },
				{ "noneLabel", g_p.kind == Kind::Bed ? "No furniture" : Tr("$ostim_message_none", "None") },
				{ "items", items },
				{ "privacy", PrivacyJson() },
				{ "terms", TermsJson() },
			};
			// Build marker (hd-markers.json: "furniture-pick-show").
			logger::info("furniture-pick: showing {} piece(s) for the {} prompt{}", g_p.cands.size(),
				g_p.kind == Kind::Bed ? "bed" : "furniture", g_p.sceneRunning ? " (scene running)" : "");
			if (!g_host.show(Dump(payload))) {
				logger::warn("furniture-pick: the picker would not open");
				PassOn("view refused");
			}
		}

		// OStim's option index for a chosen piece, plus whether the piece still
		// has to be moved onto afterwards.
		struct Choice
		{
			int           index = 0;
			std::uint32_t move = 0;   // ref id to ChangeFurniture onto, 0 = none
		};

		int OptionIndexFor(const Cand& c)
		{
			// Select prompt: options[0] is "None", then one per furniture TYPE by its
			// spoken name. Match the spoken name of the piece's type, then its group.
			const std::vector<std::string>& o = g_p.options;
			auto find = [&](const std::string& label) {
				for (std::size_t i = 1; i < o.size(); ++i)
					if (Lower(o[i]) == Lower(label))
						return static_cast<int>(i);
				return 0;
			};
			if (int i = find(c.label))
				return i;
			if (c.group == "bed")
				if (int i = find(TypeLabel("bed")))
					return i;
			if (c.group == "seat")
				for (const char* t : { "chair", "bench" })
					if (int i = find(TypeLabel(t)))
						return i;
			return 0;
		}

		Choice Decide(const std::string& key)
		{
			Choice ch;
			const int nearest = NearestIndex(g_p.cands, g_p.kind);
			const Cand* pick = nullptr;
			if (key == "default") {
				if (nearest >= 0)
					pick = &g_p.cands[static_cast<std::size_t>(nearest)];
			} else if (key != "none") {
				for (const auto& c : g_p.cands)
					if (c.key == key) {
						pick = &c;
						break;
					}
			}

			if (g_p.kind == Kind::Bed) {
				// options: [Yes, No]. Yes = OStim uses the nearest bed; No = no furniture.
				if (!pick) {
					ch.index = key == "none" ? 1 : 0;
					return ch;
				}
				const bool isBed = pick->group == "bed";
				ch.index = isBed ? 0 : 1;
				// "default" is OStim's own pick: nothing to move.
				if (!(key == "default" && isBed))
					ch.move = pick->refId;
				return ch;
			}

			// Select prompt.
			if (!pick) {
				ch.index = 0;   // None
				return ch;
			}
			if (g_p.sceneRunning) {
				ch.index = 0;   // None is a no-op mid-scene; we move it ourselves
				ch.move = pick->refId;
				return ch;
			}
			ch.index = OptionIndexFor(*pick);
			ch.move = pick->refId;
			return ch;
		}

		// ------------------------------------------------------- thread events
		void VerifyAfterStart(std::uint32_t tid)
		{
			if (!g_want.active)
				return;
			if (std::chrono::steady_clock::now() > g_want.until) {
				g_want.active = false;
				return;
			}
			if (!ThreadHasPlayer(tid))
				return;

			// People OStim's own list did not hold: bring them in now. The migration
			// restarts the scene (OStim re-searches furniture with the bigger cast),
			// so the chosen furniture is re-applied by the NEXT thread-start event.
			if (!g_want.joiners.empty()) {
				const auto joiners = g_want.joiners;
				g_want.joiners.clear();
				std::vector<std::uint32_t> ids;
				const std::uint32_t        n = g_api->GetActorCount(tid);
				std::vector<OT::ActorData> buf(n);
				const std::uint32_t        got = n ? g_api->GetActors(tid, buf.data(), n) : 0;
				for (std::uint32_t i = 0; i < got; ++i)
					ids.push_back(buf[i].formID);
				for (const auto id : joiners)
					if (std::find(ids.begin(), ids.end(), id) == ids.end() && ids.size() < 5)
						ids.push_back(id);
				if (ids.size() > got && g_api->HasCompatibleNode(tid, ids.data(), static_cast<std::uint32_t>(ids.size()))) {
					// Build marker (hd-markers.json: "furniture-pick-join").
					logger::info("furniture-pick: joining {} more into thread {} ({} actors)", ids.size() - got, tid, ids.size());
					g_api->MigrateThread(tid, ids.data(), static_cast<std::uint32_t>(ids.size()));
					if (!g_want.refId)
						g_want.active = false;
					g_want.until = std::chrono::steady_clock::now() + std::chrono::milliseconds(kWantWindowMs);
				} else {
					RE::DebugNotification("OStim has no scene for that group - they stay out");
					if (!g_want.refId)
						g_want.active = false;
				}
				return;
			}

			const auto ref = g_want.refId;
			g_want.active = false;
			if (ref)
				ChangeFurniture(tid, ref);
		}

		void OnThreadEvent(OT::ThreadEvent ev, std::uint32_t tid, void*)
		{
			if (ev != OT::ThreadEvent::ThreadStarted || !g_want.active)
				return;
			// OStim announces a thread before its cast is seated.
			std::thread([tid]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(1500));
				SKSE::GetTaskInterface()->AddTask([tid]() { VerifyAfterStart(tid); });
			}).detach();
		}

		bool EnsureListening()
		{
			if (g_listening)
				return true;
			if (!g_api)
				g_api = OT::GetAPI("SkyManagerFurniture", REL::Version(1, 0, 0, 0));
			if (!g_api)
				return false;
			g_api->RegisterEventCallback(&OnThreadEvent, nullptr);
			g_listening = true;
			logger::info("furniture-pick: listening for OStim scenes");
			return true;
		}

		// ------------------------------------------------------------------ CHIM
		// Rober, 2026-10-14 (relayed by the CHIM session): ask "public or private?" as
		// part of the scene-start step and tell CHIM who joins, so she knows she is
		// in the scene and can talk. CHIM's side is public_scene/scene_api.php on its
		// WSL Apache (localhost:8081, same host the Ask bridge uses):
		//   ?op=privacy&mode=public|private   BEFORE OStim starts
		//   ?op=join&npc=<display name>       once per NPC added; 404 = not in CHIM
		// Fail open: CHIM down, WSL off or a slow answer never blocks the scene. All
		// of it runs on a worker thread; the prompt is answered once it is done or the
		// deadline passes.
		constexpr const char* kChimPath = "/HerikaServer/ext/public_scene/scene_api.php";
		constexpr int         kChimConnectMs = 1200;
		constexpr int         kChimReceiveMs = 2000;
		constexpr int         kChimDeadlineMs = 4500;

		std::wstring WidenAscii(const std::string& s)
		{
			return std::wstring(s.begin(), s.end());
		}

		std::string UrlEnc(const std::string& s)
		{
			static const char* hex = "0123456789ABCDEF";
			std::string        out;
			for (const unsigned char c : s) {
				if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~')
					out.push_back(static_cast<char>(c));
				else {
					out.push_back('%');
					out.push_back(hex[c >> 4]);
					out.push_back(hex[c & 15]);
				}
			}
			return out;
		}

		struct ChimReply
		{
			bool        reached = false;   // an HTTP answer came back
			unsigned    status = 0;
			std::string body;
		};

		// One GET against the CHIM server. WORKER THREAD ONLY.
		ChimReply ChimGet(const std::string& query)
		{
			ChimReply r;
			std::string base = "http://127.0.0.1:8081";
			if (char* env = nullptr; _dupenv_s(&env, nullptr, "HOTKEYDECK_CHIM_BASE") == 0 && env) {
				if (*env)
					base = env;
				free(env);
			}
			std::string rest = base;
			if (const auto sc = rest.find("://"); sc != std::string::npos)
				rest = rest.substr(sc + 3);
			while (!rest.empty() && rest.back() == '/')
				rest.pop_back();
			INTERNET_PORT port = 80;
			std::string   host = rest;
			if (const auto colon = rest.rfind(':'); colon != std::string::npos) {
				host = rest.substr(0, colon);
				try {
					port = static_cast<INTERNET_PORT>(std::stoi(rest.substr(colon + 1)));
				} catch (...) {
					return r;
				}
			}
			if (host.empty())
				return r;

			HINTERNET session = WinHttpOpen(L"SkyManager-FurniturePick/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY,
				WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
			if (!session)
				return r;
			WinHttpSetTimeouts(session, kChimConnectMs, kChimConnectMs, kChimReceiveMs, kChimReceiveMs);
			HINTERNET conn = WinHttpConnect(session, WidenAscii(host).c_str(), port, 0);
			HINTERNET req = conn ? WinHttpOpenRequest(conn, L"GET", WidenAscii(std::string(kChimPath) + "?" + query).c_str(),
				                       nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0)
			                     : nullptr;
			if (req && WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
				WinHttpReceiveResponse(req, nullptr)) {
				DWORD status = 0, len = sizeof(status);
				WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
					&status, &len, WINHTTP_NO_HEADER_INDEX);
				r.reached = true;
				r.status = status;
				for (;;) {
					DWORD avail = 0;
					if (!WinHttpQueryDataAvailable(req, &avail) || avail == 0 || r.body.size() > 65536)
						break;
					std::string chunk(avail, '\0');
					DWORD       got = 0;
					if (!WinHttpReadData(req, chunk.data(), avail, &got) || got == 0)
						break;
					chunk.resize(got);
					r.body += chunk;
				}
			}
			if (req)
				WinHttpCloseHandle(req);
			if (conn)
				WinHttpCloseHandle(conn);
			WinHttpCloseHandle(session);
			return r;
		}

		// How many other people are close enough to see: the default for the
		// Public / Private question. The scene partner counts as one, so two or
		// more means somebody else is around.
		int PeopleAround()
		{
			auto* pc = RE::PlayerCharacter::GetSingleton();
			auto* lists = RE::ProcessLists::GetSingleton();
			if (!pc || !lists)
				return 0;
			int         n = 0;
			const auto  pos = pc->GetPosition();
			const auto* cell = pc->GetParentCell();
			for (const auto* h : { &lists->highActorHandles, &lists->middleHighActorHandles }) {
				for (const auto& handle : *h) {
					auto       ptr = handle.get();
					RE::Actor* a = ptr ? ptr.get() : nullptr;
					if (!a || a == pc || a->IsDead() || a->IsDisabled() || a->GetParentCell() != cell)
						continue;
					if (!a->HasKeywordString("ActorTypeNPC"))
						continue;
					const auto p = a->GetPosition();
					const float dx = p.x - pos.x, dy = p.y - pos.y, dz = p.z - pos.z;
					if (std::sqrt(dx * dx + dy * dy + dz * dz) < 25.0f * kUnitsPerMeter)
						++n;
				}
			}
			return n;
		}

		// Tell CHIM (privacy first, then each joiner) on a worker, then answer the
		// prompt. `mode` empty = nothing to say about privacy.
		void ReleaseAfterChim(const char* why, int index, std::string mode, Terms terms, std::vector<std::string> joins)
		{
			const bool needPriv = g_s.chim && !mode.empty() && !(PrivacyWindowOpen() && g_privMode == mode);
			const bool needTerms = g_s.chim && terms.Any() && !TermsWindowOpen(terms.Key());
			if (!g_s.chim || (!needPriv && !needTerms && joins.empty())) {
				Release(why, index);
				return;
			}
			if (g_host.hide)
				g_host.hide();
			const std::uint64_t gen = g_p.gen;
			const std::string   reason = why;
			std::thread([gen, reason, index, mode, joins, needPriv, needTerms, terms]() {
				const auto started = std::chrono::steady_clock::now();
				auto       overBudget = [&]() {
					return std::chrono::steady_clock::now() - started > std::chrono::milliseconds(kChimDeadlineMs);
				};
				bool                     privOk = false, termsOk = false;
				std::vector<std::string> notRegistered;
				if (needPriv) {
					const ChimReply r = ChimGet("op=privacy&mode=" + mode);
					privOk = r.reached && r.status >= 200 && r.status < 300;
					// Build marker (hd-markers.json: "furniture-pick-chim-privacy").
					logger::info("furniture-pick: told CHIM the scene is {} -> {}", mode,
						r.reached ? ("HTTP " + std::to_string(r.status)) : std::string("no answer (scene carries on)"));
				}
				if (needTerms && !overBudget()) {
					std::string q = "op=terms";
					if (!terms.consent.empty())
						q += "&consent=" + terms.consent;
					if (!terms.arrangement.empty())
						q += "&arrangement=" + terms.arrangement;
					const ChimReply r = ChimGet(q);
					termsOk = r.reached && r.status >= 200 && r.status < 300;
					// Build marker (hd-markers.json: "furniture-pick-chim-terms").
					logger::info("furniture-pick: told CHIM the terms are {} / {} -> {}",
						terms.consent.empty() ? "-" : terms.consent, terms.arrangement.empty() ? "-" : terms.arrangement,
						r.reached ? ("HTTP " + std::to_string(r.status)) : std::string("no answer (scene carries on)"));
				}
				for (const auto& name : joins) {
					if (overBudget())
						break;
					const ChimReply r = ChimGet("op=join&npc=" + UrlEnc(name));
					// Build marker (hd-markers.json: "furniture-pick-chim-join").
					logger::info("furniture-pick: told CHIM {} joined -> {}", name,
						r.reached ? ("HTTP " + std::to_string(r.status)) : std::string("no answer (scene carries on)"));
					if (r.reached && r.status == 404)
						notRegistered.push_back(name);
				}
				SKSE::GetTaskInterface()->AddTask([gen, reason, index, mode, privOk, termsOk, terms, notRegistered]() {
					if (privOk) {
						g_privMode = mode;
						g_privAt = std::chrono::steady_clock::now();
					}
					if (termsOk) {
						g_termsKey = terms.Key();
						g_termsAt = std::chrono::steady_clock::now();
					}
					for (const auto& n : notRegistered)
						RE::DebugNotification((n + " is not registered in CHIM").c_str());
					if (g_p.active && g_p.gen == gen)
						Release(reason.c_str(), index);
				});
			}).detach();
		}

		// --------------------------------------------------------------- the hook
		struct DispatchHook
		{
			// Runs on whatever thread OStim called from (its scene-start thread
			// is a detached std::thread). It may only read its arguments; every
			// engine and view touch hops to the main thread.
			static bool Thunk(RE::BSScript::Internal::VirtualMachine* self, const RE::BSFixedString& cls, const RE::BSFixedString& fn,
				RE::BSScript::IFunctionArguments* args, RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor>& result)
			{
				// Taken only while the picker could actually open (its view is up and the
				// game is ready); otherwise the call runs and UIExtensions shows its own.
				if (g_s.enabled && args && result && g_host.ready && g_host.ready()) {
					const std::string_view c = cls.c_str() ? cls.c_str() : "";
					const std::string_view f = fn.c_str() ? fn.c_str() : "";
					if (c.size() == 5 && f.size() == 15 && _stricmp(c.data(), kPromptClass) == 0 && _stricmp(f.data(), kPromptFn) == 0) {
						if (TryTake(Fallback{ cls, fn, args }, args, result))
							return true;
					}
				}
				return g_orig(self, cls, fn, args, result);
			}

			static bool TryTake(const Fallback& fb, RE::BSScript::IFunctionArguments* args, const RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor>& result)
			{
				RE::BSScrapArray<RE::BSScript::Variable> vars;
				if (!(*args)(vars) || vars.size() < 2)
					return false;
				if (!vars[0].IsString() || !vars[1].IsArray())
					return false;
				const std::string content(vars[0].GetString());
				std::vector<std::string> options;
				if (auto arr = vars[1].GetArray()) {
					const auto n = arr->size();
					for (std::uint32_t i = 0; i < n; ++i) {
						const auto& v = (*arr)[i];
						options.push_back(v.IsString() ? std::string(v.GetString()) : std::string());
					}
				}

				const std::string low = Lower(content);
				std::string       shown;
				for (const auto& o : options)
					shown += (shown.empty() ? "" : " | ") + o;
				Kind kind = Kind::Bed;
				// The exact OStim text first (any language, via its translation file) ...
				if (MatchesKey(low, "$ostim_message_use_bed", "Do you want to use the nearby bed?") && options.size() == 2)
					kind = Kind::Bed;
				else if (MatchesKey(low, "$ostim_message_select_furniture", "Which furniture do you want") && options.size() >= 2)
					kind = Kind::Select;
				else if (MatchesKey(low, "$ostim_message_add_actor", "Select an actor to add to the scene") && options.size() >= 2)
					kind = Kind::AddActor;
				// ... then the words, so a reworded or retranslated caption is still caught.
				else if (low.find("bed") != std::string::npos && options.size() == 2)
					kind = Kind::Bed;
				else if (low.find("furniture") != std::string::npos && options.size() >= 2)
					kind = Kind::Select;
				else if (low.find("actor") != std::string::npos && low.find("add") != std::string::npos && options.size() >= 2)
					kind = Kind::AddActor;
				else {
					// Build marker (hd-markers.json: "furniture-pick-not-ours").
					logger::info("furniture-pick: UIExtMessageBox '{}' [{}] is not a furniture or add-actor prompt - left to UIExtensions", content, shown);
					return false;
				}
				// Build marker (hd-markers.json: "furniture-pick-caught").
				logger::info("furniture-pick: caught OSKSE.UIExtMessageBox '{}' [{}] as the {} prompt - the UIExtensions popup will not open",
					content, shown, kind == Kind::Bed ? "bed" : kind == Kind::Select ? "furniture" : "add-actor");

				auto cb = result;
				SKSE::GetTaskInterface()->AddTask([kind, cb, fb, options = std::move(options)]() mutable {
					Begin(kind, cb, std::move(options), fb);
				});
				return true;
			}

			static inline REL::Relocation<decltype(Thunk)> g_orig;
		};

		// Run the genuine Papyrus call (UIExtensions' list menu) with the arguments
		// OStim built. Main thread; the VM takes ownership of `args` as it always does.
		bool DispatchOriginal(const Fallback& fb, RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor>& cb)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !fb.args)
				return false;
			return DispatchHook::g_orig(vm, fb.cls, fb.fn, fb.args, cb);
		}
	}

	void SetHost(Host host)
	{
		g_host = std::move(host);
	}

	void Install()
	{
		Load();
		if (g_hooked)
			return;
		g_hooked = true;
		// IVirtualMachine::DispatchStaticCall - vtable slot 0x26 (SE/AE).
		REL::Relocation<std::uintptr_t> vt{ RE::VTABLE_BSScript__Internal__VirtualMachine[0] };
		DispatchHook::g_orig = vt.write_vfunc(0x26, DispatchHook::Thunk);
		EnsureListening();
		// Build marker (hd-markers.json: "furniture-pick-install").
		logger::info("furniture-pick: Papyrus dispatch hooked (enabled {})", g_s.enabled);
	}

	void OnPostLoadGame()
	{
		Load();
		g_want = Want{};
		if (g_p.active)
			Release("a save loaded", 0);
		EnsureListening();
	}

	std::string StateJson()
	{
		Load();
		bool uiext = false;
		if (auto* dh = RE::TESDataHandler::GetSingleton())
			uiext = dh->LookupModByName("UIExtensions.esp") != nullptr;
		json j{
			{ "enabled", g_s.enabled },
			{ "chim", g_s.chim },
			{ "hooked", g_hooked },
			{ "ostim", GetModuleHandleA("OStim.dll") != nullptr },
			{ "uiext", uiext },
			{ "pending", g_p.active },
		};
		if (!uiext)
			j["msg"] = "OStim only asks through UIExtensions here; without UIExtensions.esp the vanilla message box is used and this picker is not involved.";
		return Dump(j);
	}

	std::string SetJson(const std::string& req)
	{
		Load();
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object() || !j.value("value", json()).is_boolean())
			return Dump(json{ { "ok", false }, { "msg", "bad request" } });
		const std::string key = j.value("key", std::string());
		if (key != "enabled" && key != "chim")
			return Dump(json{ { "ok", false }, { "msg", "unknown setting" } });
		(key == "chim" ? g_s.chim : g_s.enabled) = j["value"].get<bool>();
		Save();
		auto out = json::parse(StateJson(), nullptr, false);
		if (!out.is_object())
			out = json::object();
		out["ok"] = true;
		return Dump(out);
	}

	void OnPick(const std::string& payload)
	{
		if (!g_p.active || !g_p.shown)
			return;
		const auto  j = json::parse(payload, nullptr, false);
		std::string key = (!j.is_discarded() && j.is_object()) ? j.value("key", std::string()) : std::string();
		if (key.empty())
			key = "default";

		if (g_p.kind == Kind::AddActor) {
			PickActors(j.is_object() ? j : json::object());
			return;
		}

		const Choice ch = Decide(key);
		// Build marker (hd-markers.json: "furniture-pick-choice").
		logger::info("furniture-pick: chose '{}' -> answer {}{}", key, ch.index,
			ch.move ? (", then move to " + Hex(ch.move)) : std::string());
		if (ch.move) {
			if (g_p.sceneRunning) {
				ChangeFurniture(0, ch.move);
			} else {
				g_want.active = true;
				g_want.refId = ch.move;
				g_want.until = std::chrono::steady_clock::now() + std::chrono::milliseconds(kWantWindowMs);
			}
		}
		const std::string mode = j.is_object() ? j.value("privacy", std::string()) : std::string();
		ReleaseAfterChim("chosen", ch.index, mode, ParseTerms(j.is_object() ? j : json::object()), {});
	}

	std::string IconsJson()
	{
		if (g_p.active && g_p.kind == Kind::AddActor) {
			json faces = json::object();
			int  pending = 0;
			if (g_host.faces) {
				std::vector<std::uint32_t> ids;
				for (const auto& c : g_p.actors)
					ids.push_back(c.formId);
				const json f = json::parse(g_host.faces(ids), nullptr, false);
				if (f.is_object())
					for (auto it = f.begin(); it != f.end(); ++it) {
						faces["a" + it.key()] = it.value();
						if (it.value().is_object() && it.value().value("pending", false))
							++pending;
					}
			}
			return Dump(json{ { "faces", faces }, { "missing", pending } });
		}
		json icons = json::object();
		int  missing = 0;
		if (g_p.active) {
			for (const auto& c : g_p.cands) {
				if (c.baseId.empty() || c.plugin.empty())
					continue;
				const std::string path = ItemIcons::IconPathIfRendered(c.baseId, c.plugin);
				if (path.empty())
					++missing;
				else
					icons[c.baseId + "|" + Lower(c.plugin)] = path;
			}
		}
		return Dump(json{ { "icons", icons }, { "missing", missing } });
	}

	bool Active()
	{
		return g_p.active;
	}
}
