#include "door_actions.h"

#include "npc_actions.h"

#include <string>

// pch (force-included) provides RE::/SKSE::/json and `using namespace std::literals`.

using json = nlohmann::json;

namespace DoorActions
{
	namespace
	{
		// The door frozen at palette open. Session-scoped and re-snapshotted on
		// every open, so a stale id can at worst make Resolve() return null.
		RE::FormID g_doorRef = 0;

		// CK-canon tier names for a raw lock level. A key on the lock, or a
		// level past 100, is the engine's "Requires Key" (unpickable).
		const char* TierOf(int lvl, bool hasKey)
		{
			if (hasKey || lvl > 100)
				return "Requires Key";
			if (lvl >= 100)
				return "Master";
			if (lvl >= 75)
				return "Expert";
			if (lvl >= 50)
				return "Adept";
			if (lvl >= 25)
				return "Apprentice";
			return "Novice";
		}

		// The snapshotted ref, re-validated: still resolvable AND still a door.
		RE::TESObjectREFR* Resolve()
		{
			if (!g_doorRef)
				return nullptr;
			auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(g_doorRef);
			if (!ref)
				return nullptr;
			auto* base = ref->GetBaseObject();
			if (!base || !base->Is(RE::FormType::Door))
				return nullptr;
			return ref;
		}

		json StateJson(RE::TESObjectREFR* ref)
		{
			json        j;
			const char* nm = ref->GetDisplayFullName();
			j["refId"] = ref->GetFormID();
			j["name"] = (nm && *nm) ? nm : "Door";
			auto* lock = ref->GetLock();
			j["hasLock"] = lock != nullptr;
			j["locked"] = lock && lock->IsLocked();
			// baseLevel is an int8_t — 255 (Requires Key) reads as -1 unless
			// widened through uint8_t first.
			const int lvl = lock ? static_cast<int>(static_cast<std::uint8_t>(lock->baseLevel)) : 0;
			j["level"] = lvl;
			std::string keyName;
			if (lock && lock->key) {
				if (const char* kn = lock->key->GetName(); kn && *kn)
					keyName = kn;
			}
			j["keyName"] = keyName;
			j["tier"] = TierOf(lvl, !keyName.empty());
			return j;
		}

		// RunConsoleCmd's targeted twin: the same console-compile the deck already
		// uses for movetoqt, but aimed at a reference — which is what makes
		// `lock` / `unlock` act on THIS door instead of erroring with no target.
		void RunConsoleCmdOn(const std::string& cmd, RE::TESObjectREFR* target)
		{
			auto* factory = RE::IFormFactory::GetConcreteFormFactoryByType<RE::Script>();
			auto* script = factory ? factory->Create() : nullptr;
			if (!script)
				return;
			script->SetCommand(cmd);
			script->CompileAndRun(target);
			delete script;
		}
	}

	void SnapshotTarget()
	{
		g_doorRef = 0;
		// NpcActions' open-time snapshot already holds the non-actor crosshair
		// ref verbatim (no raycast guessing — same rule as the item-source
		// banner: a lock must never land on a neighbouring object).
		const auto id = NpcActions::ItemRefFormID();
		if (!id)
			return;
		auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(id);
		if (!ref)
			return;
		auto* base = ref->GetBaseObject();
		if (!base || !base->Is(RE::FormType::Door))
			return;
		g_doorRef = id;
		const char* nm = ref->GetDisplayFullName();
		logger::info("door-lock: crosshair door '{}' (ref {:08X})",
			(nm && *nm) ? nm : "Door", id);
	}

	std::string TargetJson()
	{
		auto* ref = Resolve();
		if (!ref)
			return "null";
		return StateJson(ref).dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string SetLock(bool lock, int level)
	{
		json r;
		r["ok"] = false;
		r["state"] = nullptr;
		auto* ref = Resolve();
		if (!ref) {
			r["msg"] = "That door is gone — look at it and reopen the deck";
			return r.dump(-1, ' ', false, json::error_handler_t::replace);
		}
		if (level < 0)
			level = 0;
		if (level > 255)
			level = 255;
		const std::string cmd = lock ? ("lock " + std::to_string(level)) : std::string("unlock");
		RunConsoleCmdOn(cmd, ref);
		// The console command applies synchronously — re-read so the reply (and
		// the modal) show what the engine actually did, not what we asked for.
		json st = StateJson(ref);
		r["ok"] = true;
		r["state"] = st;
		const std::string name = st.value("name", std::string("Door"));
		if (lock)
			r["msg"] = "🔒 " + name + " locked — " + st.value("tier", std::string("?"));
		else
			r["msg"] = "🔓 " + name + " unlocked";
		logger::info("door-lock: {} '{}' level {} -> locked={} level={}",
			lock ? "lock" : "unlock", name, level,
			st.value("locked", false), st.value("level", 0));
		return r.dump(-1, ' ', false, json::error_handler_t::replace);
	}
}
