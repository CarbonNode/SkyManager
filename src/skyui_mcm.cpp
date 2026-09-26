#include "skyui_mcm.h"

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp and logger.

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

// <Windows.h> arrives without NOMINMAX somewhere in this TU's include graph:
// `GetObject` is an object-like macro (-> GetObjectA) that renames
// BSScript::Variable::GetObject out from under us, and `min`/`max` break the
// std:: ones. Every module here that reads a Variable carries this same block
// (keys_scan.cpp, loadouts.cpp, faith.cpp) -- file scope, nothing here wants
// the macros. Omitting it is how this file failed its first build.
#ifdef GetObject
#	undef GetObject
#endif
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

namespace SkyuiMcm
{
	namespace
	{
		using json = nlohmann::json;

		// SKI_ConfigBase's own constants. Byte 1 of _optionFlagsBuf is the type,
		// byte 2 the flags (see AddOption: `type + flags * 0x100`).
		constexpr std::int32_t kTypeEmpty = 0x00;
		constexpr std::int32_t kTypeHeader = 0x01;
		constexpr std::int32_t kTypeText = 0x02;
		constexpr std::int32_t kTypeToggle = 0x03;
		constexpr std::int32_t kTypeSlider = 0x04;
		constexpr std::int32_t kTypeMenu = 0x05;
		constexpr std::int32_t kTypeColor = 0x06;
		constexpr std::int32_t kTypeKeymap = 0x07;
		constexpr std::int32_t kTypeInput = 0x08;

		constexpr std::int32_t kFlagDisabled = 0x01;
		constexpr std::int32_t kFlagHidden = 0x02;

		constexpr std::uint32_t kMaxOptions = 128;  // SKI_ConfigBase's buffer size

		// A Papyrus round trip on a loaded save is milliseconds, but a wedged
		// script is forever. Every wait is bounded and a timeout aborts the whole
		// scan rather than leaving the config half-open.
		constexpr auto kCallTimeout = std::chrono::seconds(5);

		// After un-parking a script from ShowMessage, how long to let its handler
		// finish before we free the option buffers under it.
		constexpr auto kDialogGrace = std::chrono::seconds(2);

		/* A scan's total budget. Cost is roughly (pages + 2 x options) Papyrus
		   round trips, and SKI_ConfigBase allows 128 options per page with no
		   cap on pages — so a pathological MCM could ask for thousands. The
		   deck is paused while the popout is open, but a worker that sits for a
		   minute reads as a hang, so the DEEP pass (slider ranges and the info
		   line) is dropped once the budget is spent and the scan says so. The
		   cheap pass — labels, types and live values, one round trip per page —
		   always completes, so a huge MCM degrades to a plain but honest list
		   rather than to nothing. */
		constexpr auto kScanBudget = std::chrono::seconds(12);

		// Set by CallAndWait when a timeout turned out to be a blocked confirm
		// dialog. Thread-local because a scan or a write is a strictly sequential
		// chain on one worker thread -- there is never a second call in flight to
		// confuse it with.
		thread_local bool t_blockedOnDialog = false;

		// Deadline for the scan in progress; zero means "no budget in force"
		// (a write re-reads one page and is never budgeted).
		thread_local std::chrono::steady_clock::time_point t_scanDeadline{};
		thread_local bool                                  t_budgetSpent = false;

		bool DeepStillAffordable()
		{
			if (t_scanDeadline.time_since_epoch().count() == 0)
				return true;
			if (std::chrono::steady_clock::now() < t_scanDeadline)
				return true;
			t_budgetSpent = true;
			return false;
		}

		// ------------------------------------------------------- vm idioms --
		// Local copies of the house idioms (keys_scan.cpp), so this module grows
		// no dependency on another's internals.

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

		// Properties first, then plain variables: the buffers we read
		// (_optionFlagsBuf and friends) are variables, `Pages` is a property.
		RE::BSScript::Variable* ScriptVar(RE::BSScript::Object* obj, const char* name)
		{
			if (!obj || !name)
				return nullptr;
			if (auto* v = obj->GetProperty(name))
				return v;
			return obj->GetVariable(name);
		}

		std::string ClassOf(const RE::BSTSmartPointer<RE::BSScript::Object>& obj)
		{
			if (!obj)
				return {};
			const auto& type = obj->GetTypeInfo();
			if (type) {
				if (const char* nm = type->GetName(); nm && *nm)
					return std::string(nm);
			}
			return {};
		}

		/* THE hazard, and it is the common case rather than an edge one.

		   SKI_ConfigBase::ShowMessage parks the calling script in

		       while (_waitForMessage) Utility.WaitMenuMode(0.1)

		   until the Flash dialog answers through OnMessageDialogClose. With the
		   MCM closed that dialog never opens, nothing ever answers, and the
		   script's Papyrus stack stays suspended for the rest of the session --
		   its MCM dead until a reload. tools/probe_skyui_mcms.py measured this
		   load order on 2026-09-14: **86 of 181** SkyUI MCMs can reach a
		   ShowMessage, among them NFF, OStim, SmoothCam, SoS, Fertility Mode,
		   iEquip and Follower Organizer. Scans are mostly safe (it lives in
		   OnOptionSelect, not OnPageReset); the press/toggle verb is where it
		   bites.

		   Clearing _waitForMessage is exactly what the mod's own
		   OnMessageDialogClose handler does, so this is the documented way out
		   rather than a poke at private state. _messageResult is deliberately
		   left false, so ShowMessage returns false = "cancelled" and the mod
		   takes NO action -- the right answer to a confirmation nobody could
		   see. Leaving the script wedged instead is strictly worse. */
		bool ReleaseBlockedMessage(RE::BSScript::Object* obj)
		{
			auto* v = obj ? obj->GetVariable("_waitForMessage") : nullptr;
			if (!v || !v->IsBool() || !v->GetBool())
				return false;
			v->SetBool(false);
			// Build marker (hd-markers.json: "skyui-mcm-dialog-release").
			logger::warn("skyui-mcm: released a script parked in ShowMessage -- "
						 "answered 'cancelled' on its behalf");
			return true;
		}

		// Fires once when a dispatched call finishes. We only need the
		// completion edge — every value we want is read back off the object
		// afterwards, not returned.
		class DoneCallback : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit DoneCallback(std::function<void()> then) :
				_then(std::move(then))
			{}

			void operator()(RE::BSScript::Variable) override
			{
				if (_then)
					_then();
			}

			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::function<void()> _then;
		};

		/* Dispatch one method on the config and BLOCK until the VM answers.
		   Worker thread only — the VM completes the call on its own thread, so
		   waiting here from the main thread would deadlock against it.

		   Sequential by necessity: each call mutates buffers on the config
		   object that the next call reads, so keys_scan's 32-deep window would
		   corrupt the very state we are trying to read. */
		template <class... Args>
		bool CallAndWait(RE::BSTSmartPointer<RE::BSScript::Object>& obj,
			const char* fn, Args... args)
		{
			auto* vm = Vm();
			if (!vm || !obj || !fn)
				return false;

			struct Shared
			{
				std::mutex              m;
				std::condition_variable cv;
				bool                    done = false;
			};
			auto shared = std::make_shared<Shared>();

			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(
				new DoneCallback([shared] {
					std::lock_guard l(shared->m);
					shared->done = true;
					shared->cv.notify_one();
				}));

			// By value + move, never a forwarded reference: MakeFunctionArguments
			// builds FunctionArguments<void, Args...> and a reference type there
			// is an undefined specialisation (C2027). Papyrus strings must be
			// BSFixedString, not std::string -- callers convert.
			auto fnArgs = RE::MakeFunctionArguments(std::move(args)...);
			if (!vm->DispatchMethodCall1(obj, fn, fnArgs, cb))
				return false;

			std::unique_lock l(shared->m);
			if (!shared->cv.wait_for(l, kCallTimeout, [&shared] { return shared->done; })) {
				l.unlock();
				// A timeout is usually a blocked confirm dialog, not a slow
				// script. Un-park it, then give the freed handler a moment to
				// run to the end so CloseConfig does not pull the option
				// buffers out from under it.
				if (ReleaseBlockedMessage(obj.get())) {
					t_blockedOnDialog = true;
					l.lock();
					shared->cv.wait_for(l, kDialogGrace, [&shared] { return shared->done; });
					l.unlock();
				}
				// The functor keeps `shared` alive through its shared_ptr, so a
				// late answer lands in the orphaned struct, not freed memory.
				logger::warn("skyui-mcm: '{}' did not answer in {}s -- abandoning{}",
					fn, kCallTimeout.count(),
					t_blockedOnDialog ? " (it was waiting on a confirm dialog)" : "");
				return false;
			}
			return true;
		}

		// ------------------------------------------------- buffer readers ----

		std::vector<std::string> ReadStringArray(RE::BSScript::Object* obj, const char* name)
		{
			std::vector<std::string> out;
			auto*                    v = ScriptVar(obj, name);
			if (!v || !v->IsArray())
				return out;
			auto arr = v->GetArray();
			if (!arr)
				return out;
			out.reserve(arr->size());
			for (std::uint32_t i = 0; i < arr->size(); ++i) {
				auto& slot = (*arr)[i];
				out.push_back(slot.IsString() ? std::string(slot.GetString()) : std::string{});
			}
			return out;
		}

		std::vector<std::int32_t> ReadIntArray(RE::BSScript::Object* obj, const char* name)
		{
			std::vector<std::int32_t> out;
			auto*                     v = ScriptVar(obj, name);
			if (!v || !v->IsArray())
				return out;
			auto arr = v->GetArray();
			if (!arr)
				return out;
			out.reserve(arr->size());
			for (std::uint32_t i = 0; i < arr->size(); ++i) {
				auto& slot = (*arr)[i];
				out.push_back(slot.IsInt() ? slot.GetSInt() : 0);
			}
			return out;
		}

		std::vector<float> ReadFloatArray(RE::BSScript::Object* obj, const char* name)
		{
			std::vector<float> out;
			auto*              v = ScriptVar(obj, name);
			if (!v || !v->IsArray())
				return out;
			auto arr = v->GetArray();
			if (!arr)
				return out;
			out.reserve(arr->size());
			for (std::uint32_t i = 0; i < arr->size(); ++i) {
				auto& slot = (*arr)[i];
				out.push_back(slot.IsFloat() ? slot.GetFloat()
											 : (slot.IsInt() ? static_cast<float>(slot.GetSInt()) : 0.0f));
			}
			return out;
		}

		std::string ReadString(RE::BSScript::Object* obj, const char* name)
		{
			auto* v = ScriptVar(obj, name);
			if (!v || !v->IsString())
				return {};
			return std::string(v->GetString());
		}

		// ------------------------------------------------------ discovery ----

		struct Config
		{
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			std::string                               name;   // display
			std::string                               ident;  // Papyrus class = our id
		};

		/* SKI_ConfigManager's registered configs. The manager quest is found by
		   its attached script, never by FormID — SkyUI's plugin name varies. */
		std::vector<Config> RegisteredConfigs(std::string& why)
		{
			std::vector<Config> out;
			auto*               dh = RE::TESDataHandler::GetSingleton();
			if (!dh) {
				why = "the game's data handler is not up yet";
				return out;
			}
			RE::BSTSmartPointer<RE::BSScript::Object> mgr;
			for (auto* quest : dh->GetFormArray<RE::TESQuest>()) {
				if ((mgr = BindScript(quest, "SKI_ConfigManager")))
					break;
			}
			if (!mgr) {
				why = "SkyUI's MCM is not installed (no SKI_ConfigManager)";
				return out;
			}
			auto* configs = ScriptVar(mgr.get(), "_modConfigs");
			auto* names = ScriptVar(mgr.get(), "_modNames");
			if (!configs || !configs->IsArray() || !names || !names->IsArray()) {
				why = "SkyUI's config manager has an unexpected layout";
				return out;
			}
			auto configArr = configs->GetArray();
			auto nameArr = names->GetArray();
			if (!configArr || !nameArr)
				return out;

			const auto n = (std::min)(configArr->size(), nameArr->size());
			for (std::uint32_t i = 0; i < n; ++i) {
				auto& slot = (*configArr)[i];
				if (!slot.IsObject() || slot.IsNoneObject())
					continue;  // the manager keeps None gaps in its fixed array
				auto obj = slot.GetObject();
				if (!obj)
					continue;
				std::string nm;
				auto&       nameVar = (*nameArr)[i];
				if (nameVar.IsString())
					nm = std::string(nameVar.GetString());
				auto ident = ClassOf(obj);
				if (ident.empty())
					continue;  // unnameable type: we could not address it again
				if (nm.empty())
					nm = ident;
				out.push_back(Config{ std::move(obj), std::move(nm), std::move(ident) });
			}
			return out;
		}

		bool FindConfig(const std::string& id, Config& out, std::string& why)
		{
			auto all = RegisteredConfigs(why);
			for (auto& c : all) {
				if (Lower(c.ident) == Lower(id)) {
					out = std::move(c);
					return true;
				}
			}
			if (why.empty())
				why = "that MCM is not registered any more";
			return false;
		}

		// ---------------------------------------------------------- rows -----

		const char* TypeName(std::int32_t t)
		{
			switch (t) {
			case kTypeHeader: return "header";
			case kTypeText:   return "text";
			case kTypeToggle: return "toggle";
			case kTypeSlider: return "slider";
			case kTypeMenu:   return "menu";
			case kTypeColor:  return "color";
			case kTypeKeymap: return "keymap";
			case kTypeInput:  return "input";
			default:          return "empty";
			}
		}

		/* Whether the deck can CHANGE this option, and the honest reason when it
		   cannot. See the header for the full reasoning — the load-bearing one is
		   `menu`: SkyUI hands a menu's choice list straight to the Flash UI and
		   keeps no copy, so with the MCM closed we genuinely do not know what the
		   entries are. Offering a blind index stepper would be guessing. */
		bool Writable(std::int32_t type, std::string& why)
		{
			switch (type) {
			case kTypeToggle:
			case kTypeSlider:
			case kTypeText:
				return true;
			case kTypeMenu:
				why = "SkyUI only sends a menu's choices to the menu UI, so the list "
					  "isn't readable from here — open the mod's own MCM to pick a "
					  "different entry. Reset still works.";
				return false;
			case kTypeKeymap:
				why = "rebind it on the Keys tab, which owns every hotkey in the load order";
				return false;
			case kTypeColor:
				why = "colour options need the MCM's own colour picker";
				return false;
			case kTypeInput:
				why = "text entry needs the MCM's own input dialog";
				return false;
			default:
				return false;
			}
		}

		/* Read the four option buffers for whichever page is currently loaded on
		   the config, into rows. `deep` also asks each slider for its real range
		   and each option for its info line — two extra Papyrus round trips per
		   option, so it is on for a scan and off for the re-read after a write. */
		json RowsForCurrentPage(RE::BSTSmartPointer<RE::BSScript::Object>& obj,
			std::int32_t pageIdx, bool deep)
		{
			json rows = json::array();

			const auto flags = ReadIntArray(obj.get(), "_optionFlagsBuf");
			const auto text = ReadStringArray(obj.get(), "_textBuf");
			const auto strVal = ReadStringArray(obj.get(), "_strValueBuf");
			const auto numVal = ReadFloatArray(obj.get(), "_numValueBuf");
			const auto stMap = ReadStringArray(obj.get(), "_stateOptionMap");

			const auto n = (std::min)(static_cast<std::uint32_t>(flags.size()), kMaxOptions);
			for (std::uint32_t i = 0; i < n; ++i) {
				const std::int32_t packed = flags[i];
				const std::int32_t type = packed % 0x100;
				const std::int32_t fl = (packed / 0x100) % 0x100;
				if (type == kTypeEmpty)
					continue;
				if (fl & kFlagHidden)
					continue;  // the mod is hiding it; so do we

				json r;
				r["i"] = static_cast<int>(i);
				r["p"] = pageIdx;
				r["type"] = TypeName(type);
				r["label"] = i < text.size() ? text[i] : std::string{};
				r["text"] = i < strVal.size() ? strVal[i] : std::string{};
				r["value"] = i < numVal.size() ? numVal[i] : 0.0f;
				r["st"] = i < stMap.size() && !stMap[i].empty();
				r["disabled"] = (fl & kFlagDisabled) != 0;

				std::string why;
				bool        w = Writable(type, why);
				if (w && (fl & kFlagDisabled)) {
					w = false;
					why = "the mod has greyed this out right now";
				}
				r["writable"] = w;
				if (!why.empty())
					r["why"] = why;
				// Reset runs OnOptionDefault / OnDefaultST, which every option
				// type supports — including the menus we cannot otherwise set.
				r["resettable"] = (type != kTypeHeader && type != kTypeEmpty) && !(fl & kFlagDisabled);

				const bool afford = deep && DeepStillAffordable();

				if (afford && type == kTypeSlider) {
					// RequestSliderDialogData seeds defaults (0,0,0,1,1) and then
					// lets the mod override them in OnOptionSliderOpen /
					// OnSliderOpenST — exactly what SkyUI does before showing the
					// slider dialog. Without it we would have no range at all.
					if (CallAndWait(obj, "RequestSliderDialogData", static_cast<std::int32_t>(i))) {
						const auto sp = ReadFloatArray(obj.get(), "_sliderParams");
						if (sp.size() >= 5) {
							r["start"] = sp[0];
							r["default"] = sp[1];
							r["min"] = sp[2];
							r["max"] = sp[3];
							r["step"] = sp[4];
						}
					}
				}

				if (afford && type != kTypeHeader) {
					// HighlightOption fills _infoText via the mod's
					// OnOptionHighlight / OnHighlightST — the help line the real
					// MCM shows at the bottom of the screen.
					if (CallAndWait(obj, "HighlightOption", static_cast<std::int32_t>(i))) {
						auto info = ReadString(obj.get(), "_infoText");
						if (!info.empty())
							r["info"] = info;
					}
				}

				rows.push_back(std::move(r));
			}
			return rows;
		}

		// Load one page onto the config and read it. Page index -1 is SkyUI's
		// own "no page" (what OpenConfig loads first); real pages are 0-based
		// here and SetPage turns them into _currentPageNum = 1 + index.
		json ReadPage(RE::BSTSmartPointer<RE::BSScript::Object>& obj,
			const std::string& name, std::int32_t idx, bool deep)
		{
			json p;
			p["name"] = name;
			if (!CallAndWait(obj, "SetPage", RE::BSFixedString(name), idx)) {
				p["rows"] = json::array();
				p["why"] = "this page did not answer";
				return p;
			}
			p["rows"] = RowsForCurrentPage(obj, idx, deep);
			return p;
		}
	}

	// ============================================================ public =====

	std::string ListJson()
	{
		json out;
		std::string why;
		auto        configs = RegisteredConfigs(why);

		json mods = json::array();
		for (auto& c : configs) {
			json m;
			m["id"] = c.ident;
			m["name"] = c.name;
			mods.push_back(std::move(m));
		}
		out["mods"] = std::move(mods);
		out["ok"] = why.empty();
		if (!why.empty())
			out["why"] = why;

		// Build marker (hd-markers.json: "skyui-mcm-list").
		logger::info("skyui-mcm: {} SkyUI config(s) registered", configs.size());
		return out.dump();
	}

	std::string ScanJson(const std::string& req)
	{
		json out;
		json in = json::parse(req, nullptr, false);
		if (in.is_discarded() || !in.is_object()) {
			out["ok"] = false;
			out["why"] = "bad request";
			return out.dump();
		}
		const std::string id = in.value("id", std::string{});

		Config      cfg;
		std::string why;
		if (!FindConfig(id, cfg, why)) {
			out["ok"] = false;
			out["id"] = id;
			out["why"] = why;
			return out.dump();
		}

		out["id"] = cfg.ident;
		out["name"] = cfg.name;

		// Allocate the option buffers. Without this they are `new int[1]` and
		// every page reads back empty — the single most important call here.
		t_blockedOnDialog = false;
		t_budgetSpent = false;
		t_scanDeadline = std::chrono::steady_clock::now() + kScanBudget;

		if (!CallAndWait(cfg.obj, "OpenConfig")) {
			out["ok"] = false;
			out["why"] = t_blockedOnDialog
				? "this mod opens a confirmation as soon as its menu does, which "
				  "only its own MCM can show"
				: "the mod's MCM script did not respond";
			t_scanDeadline = {};
			return out.dump();
		}

		const auto pages = ReadStringArray(cfg.obj.get(), "Pages");

		json pagesJson = json::array();
		if (pages.empty()) {
			// A single-page MCM leaves Pages empty and builds everything on the
			// "" page, which OpenConfig has already loaded for us.
			json p;
			p["name"] = "";
			p["rows"] = RowsForCurrentPage(cfg.obj, -1, true);
			pagesJson.push_back(std::move(p));
		} else {
			for (std::size_t i = 0; i < pages.size(); ++i)
				pagesJson.push_back(ReadPage(cfg.obj, pages[i], static_cast<std::int32_t>(i), true));
		}
		t_scanDeadline = {};  // a write re-reads one page and is never budgeted

		out["pages"] = std::move(pagesJson);
		out["ok"] = true;
		// Both can be true at once, and each matters, so they accumulate rather
		// than one silently overwriting the other.
		std::string note;
		if (t_budgetSpent) {
			note = "this menu is big enough that reading every slider's range and "
				   "help line would have taken too long — every setting and its "
				   "value is here, some just have no range shown";
		}
		if (t_blockedOnDialog) {
			// Rare (ShowMessage normally lives in OnOptionSelect, not
			// OnPageReset) but not impossible, and a half-read menu should
			// admit it rather than look complete.
			if (!note.empty())
				note += " — also, ";
			note += "part of this menu asked for a confirmation while it was being "
					"read, so some rows may be incomplete";
		}
		if (!note.empty())
			out["note"] = note;

		CallAndWait(cfg.obj, "CloseConfig");

		// Build marker (hd-markers.json: "skyui-mcm-scan").
		logger::info("skyui-mcm: scanned '{}' -- {} page(s)", cfg.name, pages.size());
		return out.dump();
	}

	std::string SetJson(const std::string& req)
	{
		json out;
		json in = json::parse(req, nullptr, false);
		if (in.is_discarded() || !in.is_object()) {
			out["ok"] = false;
			out["msg"] = "bad request";
			return out.dump();
		}
		const std::string id = in.value("id", std::string{});
		const std::string act = in.value("act", std::string{});
		const auto        pageIdx = static_cast<std::int32_t>(in.value("p", -1));
		const auto        optIdx = static_cast<std::int32_t>(in.value("i", -1));
		const float       value = in.value("value", 0.0f);

		if (optIdx < 0 || optIdx >= static_cast<std::int32_t>(kMaxOptions)) {
			out["ok"] = false;
			out["msg"] = "that option is out of range";
			return out.dump();
		}

		Config      cfg;
		std::string why;
		if (!FindConfig(id, cfg, why)) {
			out["ok"] = false;
			out["msg"] = why;
			return out.dump();
		}

		if (!CallAndWait(cfg.obj, "OpenConfig")) {
			out["ok"] = false;
			out["msg"] = "the mod's MCM script did not respond";
			return out.dump();
		}

		// Re-load the page the row came from. SkyUI's write helpers address the
		// option by its index within the CURRENT page (`_currentPageNum` rides
		// along in the option id they compose), so writing without loading the
		// right page first would hit whatever option happens to share that index
		// on the page that is loaded.
		std::string pageName;
		const auto  pages = ReadStringArray(cfg.obj.get(), "Pages");
		const auto  pageCount = static_cast<std::int32_t>(pages.size());

		// ⚠ Refuse a page index this menu does not have rather than "helpfully"
		// loading page "" at that number. SetPage would still set
		// _currentPageNum = 1 + pageIdx, so the option id SkyUI composes would
		// address a page the mod never built — and the write would land on
		// whatever option happens to share that index somewhere else. A stale
		// index is easy to send (the mod's pages can change between a scan and
		// a click, e.g. a page that only appears once a quest starts), so this
		// is a real path, not a paranoid one.
		if (pageIdx >= pageCount || (pageIdx < 0 && pageCount > 0)) {
			CallAndWait(cfg.obj, "CloseConfig");
			out["ok"] = false;
			out["msg"] = "that page isn't in this menu any more — reopen the mod and try again";
			return out.dump();
		}

		if (pageIdx >= 0)
			pageName = pages[pageIdx];
		if (pageCount > 0) {
			if (!CallAndWait(cfg.obj, "SetPage", RE::BSFixedString(pageName), pageIdx)) {
				CallAndWait(cfg.obj, "CloseConfig");
				out["ok"] = false;
				out["msg"] = "that page did not load";
				return out.dump();
			}
		}
		// pageCount == 0 is the single-page MCM: OpenConfig already loaded the
		// "" page and left _currentPageNum at 0, which is what the option ids
		// on that page were composed with. Touching SetPage again would only
		// re-run OnPageReset for no gain.

		// A confirm dialog raised by THIS verb is the interesting case, so start
		// from a clean flag rather than inheriting one from the scan.
		t_blockedOnDialog = false;

		bool        ok = false;
		std::string msg;
		if (act == "toggle" || act == "press") {
			// SelectOption routes state-based options into their script state
			// and calls OnSelectST; otherwise it composes the option id and
			// calls OnOptionSelect. Either way it is the MOD's handler that
			// runs, so whatever else that handler does happens too.
			ok = CallAndWait(cfg.obj, "SelectOption", optIdx);
			msg = ok ? "done" : "the mod did not answer";
		} else if (act == "slider") {
			// SetSliderValue reads _activeOption, which only
			// RequestSliderDialogData sets — the same order SkyUI uses when it
			// opens the slider dialog and then accepts a value.
			if (!CallAndWait(cfg.obj, "RequestSliderDialogData", optIdx)) {
				msg = "the mod did not open that slider";
			} else {
				ok = CallAndWait(cfg.obj, "SetSliderValue", value);
				msg = ok ? "done" : "the mod did not accept that value";
			}
		} else if (act == "reset") {
			ok = CallAndWait(cfg.obj, "ResetOption", optIdx);
			msg = ok ? "back to default" : "the mod did not answer";
		} else {
			msg = "that option can't be changed from here";
		}

		// If the mod asked for a confirmation, say so plainly. We answered
		// "cancelled" on its behalf (ReleaseBlockedMessage), so nothing
		// happened -- telling the reader it merely "did not answer" would
		// leave them wondering whether half of it went through.
		if (!ok && t_blockedOnDialog) {
			msg = "that option asks for a yes/no confirmation, which only the "
				  "mod's own MCM can show — nothing was changed. Do this one in "
				  "its MCM.";
		}

		// Re-read the page so the view shows what the mod ACTUALLY did. A
		// handler is free to clamp the value, refuse it outright, or change
		// three other rows as a side effect; echoing back what we asked for
		// would be the panel telling a comfortable lie.
		if (ok) {
			if (pageCount > 0)
				CallAndWait(cfg.obj, "SetPage", RE::BSFixedString(pageName), pageIdx);
			out["rows"] = RowsForCurrentPage(cfg.obj, pageIdx, false);
		}

		CallAndWait(cfg.obj, "CloseConfig");

		out["ok"] = ok;
		out["msg"] = msg;
		out["id"] = cfg.ident;
		out["p"] = pageIdx;

		// Build marker (hd-markers.json: "skyui-mcm-set").
		logger::info("skyui-mcm: set '{}' p{} i{} act={} -> {}",
			cfg.name, pageIdx, optIdx, act, ok ? "ok" : "refused");
		return out.dump();
	}
}
