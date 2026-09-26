#include "residents.h"

#include "mhiyh_control.h"  // forget / clear / repair stay the dialogue-shaped verbs
#include "nff_bridge.h"     // MhiyhActorJson — the geometry-bearing read

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <utility>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json and the logger.

using json = nlohmann::json;

namespace Residents
{
	namespace
	{
		constexpr const char* kScript = "HD_MhiyhRemote";
		constexpr RE::FormID  kXMarker = 0x3B;  // Skyrim.esm XMarker (STAT)

		constexpr int kHome = 0;
		constexpr int kGuard = 3;
		constexpr int kGuardPassive = 7;

		const char* KindLabel(int k)
		{
			switch (k) {
			case 0:  return "home";
			case 1:  return "sleeping spot";
			case 2:  return "work spot";
			case 3:  return "guard post";
			case 4:  return "breakfast spot";
			case 5:  return "lunch spot";
			case 6:  return "dinner spot";
			case 7:  return "watch post";
			default: return "spot";
			}
		}

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Hex(RE::FormID id)
		{
			char buf[16];
			std::snprintf(buf, sizeof(buf), "0x%08X", static_cast<std::uint32_t>(id));
			return buf;
		}

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

		json Refuse(const std::string& msg)
		{
			return json{ { "ok", false }, { "phase", "refused" }, { "msg", msg } };
		}

		RE::Actor* ResolveActor(RE::FormID id)
		{
			auto* form = id ? RE::TESForm::LookupByID(id) : nullptr;
			auto* refr = form ? form->As<RE::TESObjectREFR>() : nullptr;
			return refr ? refr->As<RE::Actor>() : nullptr;
		}

		std::string NameOf(RE::Actor* actor)
		{
			if (actor) {
				const auto* n = actor->GetDisplayFullName();
				if (n && n[0])
					return n;
			}
			return "She";
		}

		std::string NameOfForm(RE::TESForm* form)
		{
			if (!form)
				return {};
			if (const auto* full = form->As<RE::TESFullName>()) {
				const auto* n = full->GetFullName();
				if (n && n[0])
					return n;
			}
			return {};
		}

		bool HasHome(RE::Actor* actor)
		{
			auto* kw = NffBridge::MhiyhMarkerKeyword(kHome);
			return actor && kw && actor->GetLinkedRef(kw) != nullptr;
		}

		bool HasGuardPost(RE::Actor* actor)
		{
			auto* kw = NffBridge::MhiyhMarkerKeyword(kGuard);
			return actor && kw && actor->GetLinkedRef(kw) != nullptr;
		}

		// ------------------------------------------------------------ result --

		// One Papyrus result (Bool or String), delivered on the VM's thread and
		// hopped to the main thread before anyone sees it — `push`/`done` end in
		// a PrismaUI Invoke and in live engine reads, neither safe off-main.
		struct Reply
		{
			bool        isBool = false;
			bool        b = false;
			bool        isString = false;
			std::string s;
		};

		class VarResult : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit VarResult(std::function<void(Reply)> then) :
				_then(std::move(then))
			{}

			void operator()(RE::BSScript::Variable a_result) override
			{
				Reply r;
				// Ask before reading: Variable::Get*() reinterprets a union, and
				// a function that errored out returns None, not False / "".
				if (a_result.IsBool()) {
					r.isBool = true;
					r.b = a_result.GetBool();
				} else if (a_result.IsString()) {
					r.isString = true;
					r.s = std::string(a_result.GetString());
				}
				auto then = _then;
				if (!then)
					return;
				if (auto* task = SKSE::GetTaskInterface())
					task->AddTask([then, r]() { then(r); });
			}

			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::function<void(Reply)> _then;
		};

		// One static call into HD_MhiyhRemote. Args are taken BY VALUE on
		// purpose (the MakeFunctionArguments law: a forwarded reference
		// instantiates a specialisation that does not exist).
		template <class... Args>
		bool Call(const char* fn, std::function<void(Reply)> then, Args... args)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !fn)
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new VarResult(std::move(then)));
			auto fargs = RE::MakeFunctionArguments(std::move(args)...);
			return vm->DispatchStaticCall(kScript, fn, fargs, cb);
		}

		// ------------------------------------------------------------ marker --

		RE::TESObjectCELL* ResolveCell(std::uint32_t cellId, const std::string& editorId)
		{
			if (cellId) {
				if (auto* cell = RE::TESForm::LookupByID<RE::TESObjectCELL>(cellId))
					return cell;
			}
			if (!editorId.empty()) {
				if (auto* form = RE::TESForm::LookupByEditorID(editorId))
					return form->As<RE::TESObjectCELL>();
			}
			return nullptr;
		}

		// A force-persistent XMarker at cell + pos + angle. Placed at the player
		// (the only PlaceAtMe origin that always exists) and then aimed with the
		// same four calls place_actions.cpp uses on the recall marker — moving an
		// inert static by hand is safe where moving an actor is not.
		RE::TESObjectREFR* PlaceMarker(RE::TESObjectCELL* cell, const RE::NiPoint3& pos, float angleZ)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* form = RE::TESForm::LookupByID(kXMarker);
			auto* base = form ? form->As<RE::TESBoundObject>() : nullptr;
			if (!player || !base || !cell)
				return nullptr;
			auto ptr = player->PlaceObjectAtMe(base, true);  // forcePersist: MHiYH serialises these
			auto* marker = ptr.get();
			if (!marker)
				return nullptr;
			if (marker->GetParentCell() != cell)
				marker->SetParentCell(cell);
			marker->SetPosition(pos);
			marker->SetAngle(RE::NiPoint3{ 0.0f, 0.0f, angleZ });
			marker->Update3DPosition(true);
			return marker;
		}

		void DropMarker(RE::TESObjectREFR* marker)
		{
			if (!marker)
				return;
			marker->Disable();
			marker->SetDelete(true);
		}

		// ---------------------------------------------------------- roster --

		// "formid|slot;" rows -> (formId, slot). Papyrus Ints are signed, so a
		// dynamic (0xFF-prefixed) reference arrives negative; reinterpret.
		std::vector<std::pair<RE::FormID, int>> ParseRoster(const std::string& s)
		{
			std::vector<std::pair<RE::FormID, int>> out;
			std::size_t                             pos = 0;
			while (pos < s.size()) {
				const auto end = s.find(';', pos);
				const auto row = s.substr(pos, end == std::string::npos ? std::string::npos : end - pos);
				pos = (end == std::string::npos) ? s.size() : end + 1;
				const auto bar = row.find('|');
				if (bar == std::string::npos)
					continue;
				try {
					const long long id = std::stoll(row.substr(0, bar));
					const int       slot = std::stoi(row.substr(bar + 1));
					out.emplace_back(static_cast<RE::FormID>(static_cast<std::uint32_t>(id)), slot);
				} catch (...) {
				}
			}
			return out;
		}

		json ResidentJson(RE::Actor* actor, int slot)
		{
			json r{
				{ "formId", Hex(actor->GetFormID()) },
				{ "slot", slot },
				{ "name", NameOf(actor) },
				{ "following", actor->IsPlayerTeammate() },
				{ "dead", actor->IsDead() },
				{ "inWorld", actor->Is3DLoaded() },
				{ "waiting", false },
				{ "where", "" },
				{ "whereId", 0u },
				{ "flagged", false },
				{ "home", nullptr },
				{ "acts", json::array() },
				{ "now", json::array() },
			};
			if (auto* base = actor->GetActorBase())
				r["baseId"] = Hex(base->GetFormID());

			// Where she IS — the same read the Followers roster makes: a
			// persistent ref keeps its parent cell while unloaded, which is
			// exactly the case worth reporting.
			if (auto* cell = actor->GetParentCell()) {
				r["whereId"] = static_cast<std::uint32_t>(cell->GetFormID());
				r["where"] = NameOfForm(cell);
			}
			if (r["where"].get<std::string>().empty()) {
				if (auto* loc = actor->GetCurrentLocation())
					r["where"] = NameOfForm(loc);
			}
			if (auto* avo = actor->AsActorValueOwner();
				avo && avo->GetActorValue(RE::ActorValue::kWaitingForPlayer) >= 0.5f)
				r["waiting"] = true;

			const auto mh = json::parse(NffBridge::MhiyhActorJson(actor), nullptr, false);
			if (!mh.is_discarded() && mh.is_object()) {
				if (mh.contains("home"))
					r["home"] = mh["home"];
				if (mh.contains("acts"))
					r["acts"] = mh["acts"];
				if (mh.contains("now"))
					r["now"] = mh["now"];
				r["flagged"] = mh.value("flagged", false);
			}
			return r;
		}

		bool WriteAtomic(const std::filesystem::path& file, const std::string& body)
		{
			std::error_code ec;
			std::filesystem::create_directories(file.parent_path(), ec);
			auto tmp = file;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open())
					return false;
				out << body;
			}
			std::filesystem::rename(tmp, file, ec);
			return !ec;
		}
	}

	bool Available()
	{
		return NffBridge::MhiyhMarkerKeyword(kHome) != nullptr;
	}

	void RequestState(const std::filesystem::path& deckViewDir, Push push)
	{
		if (!Available()) {
			if (push)
				push(Dump(json{ { "present", false }, { "script", true }, { "n", 0 },
					{ "residents", json::array() },
					{ "msg", "My Home is Your Home NG isn't in this load order." } }));
			return;
		}

		const bool sent = Call("Roster", [deckViewDir, push](Reply r) {
			if (!r.isString) {
				logger::warn("residents: Roster() returned no string (VM error?)");
				if (push)
					push(Dump(json{ { "present", true }, { "script", false }, { "n", 0 },
						{ "residents", json::array() },
						{ "msg", "HD_MhiyhRemote.Roster answered nothing — is HD_MhiyhRemote.pex in Data\\Scripts?" } }));
				return;
			}
			json residents = json::array();
			int  unresolved = 0;
			for (const auto& [id, slot] : ParseRoster(r.s)) {
				auto* actor = ResolveActor(id);
				if (!actor) {
					++unresolved;
					continue;
				}
				residents.push_back(ResidentJson(actor, slot));
			}
			// Build marker (hd-markers.json: "residents-roster"). Reached on every
			// successful read, so the deploy check can prove this build has it.
			logger::info("residents: roster {} resident(s) from MHiYH ({} unresolved)",
				residents.size(), unresolved);
			const json out{
				{ "present", true }, { "script", true },
				{ "n", residents.size() }, { "unresolved", unresolved },
				{ "residents", std::move(residents) },
			};
			const auto body = Dump(out);
			if (!deckViewDir.empty())
				WriteAtomic(deckViewDir / "residents-status.json", body);
			if (push)
				push(body);
		});

		if (!sent) {
			logger::warn("residents: DispatchStaticCall {}.Roster refused (no VM, or the pex is missing)", kScript);
			if (push)
				push(Dump(json{ { "present", true }, { "script", false }, { "n", 0 },
					{ "residents", json::array() },
					{ "msg", "The Papyrus VM would not take HD_MhiyhRemote.Roster — the script isn't installed, or no save is loaded." } }));
		}
	}

	std::string RequestDay(const std::string& formIdHex, Push push)
	{
		auto* actor = ResolveActor(ParseFormId(formIdHex));
		if (!actor)
			return Dump(Refuse("She isn't loaded right now."));
		const std::string id = formIdHex;
		const bool sent = Call("Day", [id, push](Reply r) {
			json day = json::array();
			if (r.isString) {
				// "k,start,end,True|False,radius;" x 8
				std::size_t pos = 0;
				while (pos < r.s.size()) {
					const auto end = r.s.find(';', pos);
					const auto row = r.s.substr(pos, end == std::string::npos ? std::string::npos : end - pos);
					pos = (end == std::string::npos) ? r.s.size() : end + 1;
					std::vector<std::string> f;
					std::size_t              p = 0;
					while (true) {
						const auto c = row.find(',', p);
						f.push_back(row.substr(p, c == std::string::npos ? std::string::npos : c - p));
						if (c == std::string::npos)
							break;
						p = c + 1;
					}
					if (f.size() < 5)
						continue;
					try {
						const auto en = f[3];
						day.push_back(json{
							{ "k", std::stoi(f[0]) },
							{ "start", std::stoi(f[1]) },
							{ "end", std::stoi(f[2]) },
							{ "enabled", en == "True" || en == "true" || en == "1" },
							{ "radius", static_cast<int>(std::lround(std::stof(f[4]))) },
						});
					} catch (...) {
					}
				}
			}
			if (push)
				push(Dump(json{ { "ok", r.isString }, { "formId", id }, { "day", std::move(day) } }));
		}, static_cast<RE::Actor*>(actor));
		if (!sent)
			return Dump(Refuse("The Papyrus VM would not take HD_MhiyhRemote.Day — is the script installed?"));
		return Dump(json{ { "ok", true }, { "phase", "sent" }, { "formId", id } });
	}

	std::string Apply(const std::string& cmdJson, Push done)
	{
		const auto j = json::parse(cmdJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(Refuse("Bad Residents payload"));

		const auto op = j.value("op", std::string(""));
		const auto idStr = j.value("formId", std::string(""));
		const int  kind = j.value("kind", -1);

		if (!Available())
			return Dump(Refuse("My Home is Your Home NG isn't in this load order."));

		// ---- verbs the dialogue shape already owns -------------------------
		if (op == "forget" || op == "clear" || op == "repair") {
			json fwd{ { "formId", idStr } };
			fwd["op"] = op == "forget" ? "forgetHome" : op == "clear" ? "clearSpot" : "repair";
			if (op == "clear")
				fwd["kind"] = kind;
			auto* a = ResolveActor(ParseFormId(idStr));
			if (a)
				fwd["name"] = NameOf(a);
			return MhiyhControl::Apply(Dump(fwd), done);
		}

		if (op == "refresh") {
			if (!Call("Refresh", [done](Reply r) {
					if (done)
						done(Dump(json{ { "ok", r.isBool && r.b }, { "phase", "done" }, { "op", "refresh" },
							{ "msg", "MHiYH re-evaluated everyone's day" } }));
				}))
				return Dump(Refuse("The Papyrus VM would not take HD_MhiyhRemote.Refresh"));
			return Dump(json{ { "ok", true }, { "phase", "sent" }, { "op", "refresh" }, { "msg", "Asking MHiYH to refresh…" } });
		}

		// ---- the actor ---------------------------------------------------
		auto* actor = ResolveActor(ParseFormId(idStr));
		if (!actor)
			return Dump(Refuse("She isn't loaded right now — MHiYH can only be told about someone the game has in memory."));
		const auto who = NameOf(actor);

		if (op == "sendHome") {
			if (!HasHome(actor))
				return Dump(Refuse(who + " has no home to be sent to."));
			if (actor->IsPlayerTeammate())
				return Dump(Refuse(who + " is following you — dismiss her first, or she just walks back."));
			if (!Call("SendHome", [done, who, idStr](Reply r) {
					const bool ok = r.isBool && r.b;
					logger::info("residents: SendHome({}) -> {}", who, ok);
					if (done)
						done(Dump(json{ { "ok", ok }, { "phase", "done" }, { "op", "sendHome" }, { "formId", idStr },
							{ "msg", ok ? ("⤓ " + who + " was sent home") : ("MHiYH would not send " + who + " home") } }));
				}, static_cast<RE::Actor*>(actor)))
				return Dump(Refuse("The Papyrus VM would not take HD_MhiyhRemote.SendHome"));
			return Dump(json{ { "ok", true }, { "phase", "sent" }, { "op", "sendHome" }, { "formId", idStr },
				{ "msg", "Sending " + who + " home…" } });
		}

		if (op == "guard") {
			const int mode = j.value("mode", -1);
			if (mode < 0 || mode > 2)
				return Dump(Refuse("Guard mode must be off, watch or guard."));
			if (!HasGuardPost(actor))
				return Dump(Refuse(who + " has no guard post yet — set one first."));
			const char* label = mode == 0 ? "off" : mode == 1 ? "keeping watch" : "standing guard";
			if (!Call("SetGuard", [done, who, idStr, label](Reply r) {
					const bool ok = r.isBool && r.b;
					if (done)
						done(Dump(json{ { "ok", ok }, { "phase", "done" }, { "op", "guard" }, { "formId", idStr }, { "kind", kGuard },
							{ "msg", ok ? (who + "'s post is now " + label) : ("MHiYH would not change " + who + "'s guard mode") } }));
				}, static_cast<RE::Actor*>(actor), static_cast<std::int32_t>(mode)))
				return Dump(Refuse("The Papyrus VM would not take HD_MhiyhRemote.SetGuard"));
			return Dump(json{ { "ok", true }, { "phase", "sent" }, { "op", "guard" }, { "formId", idStr }, { "kind", kGuard },
				{ "msg", "Setting " + who + "'s guard mode…" } });
		}

		if (op == "hours") {
			if (kind < 0 || kind > kGuardPassive)
				return Dump(Refuse("That isn't a stop MHiYH keeps hours for."));
			int   start = j.value("start", -1);
			int   end = j.value("end", -1);
			float radius = j.value("radius", 0.0f);
			const bool enabled = j.value("enabled", true);
			if (start < 0 || start > 23 || end < 0 || end > 24)
				return Dump(Refuse("Hours must be 0–23 (start) and 0–24 (end)."));
			if (radius < 64.0f)
				radius = 64.0f;
			if (radius > 4096.0f)
				radius = 4096.0f;
			const std::string label = KindLabel(kind);
			if (!Call("SetHours", [done, who, idStr, kind, label](Reply r) {
					const bool ok = r.isBool && r.b;
					logger::info("residents: SetHours({}, {}) -> {}", who, kind, ok);
					if (done)
						done(Dump(json{ { "ok", ok }, { "phase", "done" }, { "op", "hours" }, { "formId", idStr }, { "kind", kind },
							{ "msg", ok ? (who + "'s " + label + " hours were set") : ("MHiYH would not take those " + label + " hours") } }));
				}, static_cast<RE::Actor*>(actor), static_cast<std::int32_t>(kind), static_cast<std::int32_t>(start),
					static_cast<std::int32_t>(end), enabled, radius))
				return Dump(Refuse("The Papyrus VM would not take HD_MhiyhRemote.SetHours"));
			return Dump(json{ { "ok", true }, { "phase", "sent" }, { "op", "hours" }, { "formId", idStr }, { "kind", kind },
				{ "msg", "Setting " + who + "'s " + label + " hours…" } });
		}

		if (op == "setAt") {
			if (kind < 0 || kind > 6)
				return Dump(Refuse(kind == kGuardPassive
					? "Watch has no place of its own — it shares the guard post. Set Guard instead."
					: "That isn't a stop MHiYH can be told about."));
			if (kind != kHome && !HasHome(actor))
				return Dump(Refuse("Give " + who + " a home first — every other stop in her day hangs off it."));

			RE::TESObjectCELL* cell = nullptr;
			RE::NiPoint3       pos{};
			float              angle = 0.0f;
			std::string        placeName;
			if (j.value("here", false)) {
				auto* player = RE::PlayerCharacter::GetSingleton();
				cell = player ? player->GetParentCell() : nullptr;
				if (!cell)
					return Dump(Refuse("You aren't standing anywhere the game can mark yet."));
				pos = player->GetPosition();
				angle = player->GetAngleZ();
				placeName = NameOfForm(cell);
				if (placeName.empty())
					placeName = "right here";
			} else {
				const auto m = j.contains("mark") && j["mark"].is_object() ? j["mark"] : json::object();
				cell = ResolveCell(m.value("cellId", 0u), m.value("cellEdid", std::string("")));
				placeName = m.value("name", std::string("that domain"));
				if (!cell)
					return Dump(Refuse(placeName + " is unreachable — its cell isn't in this load order any more"));
				pos = RE::NiPoint3{ m.value("x", 0.0f), m.value("y", 0.0f), m.value("z", 0.0f) };
				angle = m.value("angleZ", 0.0f);
			}

			auto* marker = PlaceMarker(cell, pos, angle);
			if (!marker)
				return Dump(Refuse("Could not place a marker there — see HotkeyDeck.log"));

			const std::string label = KindLabel(kind);
			const char*       fn = kind == kHome ? "SetHomeAt" : "SetAreaAt";
			const RE::FormID  markerId = marker->GetFormID();
			auto then = [done, who, idStr, kind, label, placeName, fn](Reply r) {
				const bool ok = r.isBool && r.b;
				logger::info("residents: {}({}, {}) at '{}' -> {}", fn, who, kind, placeName, ok);
				if (done)
					done(Dump(json{ { "ok", ok }, { "phase", "done" }, { "op", "setAt" }, { "formId", idStr }, { "kind", kind },
						{ "msg", ok ? ((kind == kHome ? "⌂ " : "⌖ ") + who + "'s " + label + " is now " + placeName)
									: ("MHiYH would not take that " + label + " — see HotkeyDeck.log") } }));
			};
			bool sent;
			if (kind == kHome)
				sent = Call("SetHomeAt", then, static_cast<RE::Actor*>(actor), static_cast<RE::TESObjectREFR*>(marker));
			else
				sent = Call("SetAreaAt", then, static_cast<RE::Actor*>(actor), static_cast<std::int32_t>(kind),
					static_cast<RE::TESObjectREFR*>(marker));
			if (!sent) {
				// The script deletes the marker on ITS failures; a refused
				// dispatch never reached it, so the marker is ours to drop.
				DropMarker(marker);
				logger::warn("residents: DispatchStaticCall {}.{} refused — marker {:08X} dropped", kScript, fn,
					static_cast<std::uint32_t>(markerId));
				return Dump(Refuse("The Papyrus VM would not take that call — is HD_MhiyhRemote.pex installed?"));
			}
			logger::info("residents: dispatched {}.{}({}, {}) marker {:08X} at '{}'", kScript, fn, who, kind,
				static_cast<std::uint32_t>(markerId), placeName);
			return Dump(json{ { "ok", true }, { "phase", "sent" }, { "op", "setAt" }, { "formId", idStr }, { "kind", kind },
				{ "msg", "Marking " + placeName + " as " + who + "'s " + label + "…" } });
		}

		return Dump(Refuse("Unknown Residents action '" + op + "'"));
	}
}
