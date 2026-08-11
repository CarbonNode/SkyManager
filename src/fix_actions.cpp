#include "fix_actions.h"

#include "npc_actions.h"

#include <string>

// pch (force-included) provides RE::/SKSE:: and `using namespace std::literals`.

namespace FixActions
{
	// Run a console command, optionally targeting a reference. CompileAndRun's
	// target makes a ref-scoped command ("recycleactor", "resetai", …) act ON
	// that ref with no `prid` dance; a null target runs it globally ("tcl").
	static void RunConsole(const char* cmd, RE::TESObjectREFR* target)
	{
		auto* factory = RE::IFormFactory::GetConcreteFormFactoryByType<RE::Script>();
		auto* script  = factory ? factory->Create() : nullptr;
		if (!script)
			return;
		script->SetCommand(cmd);
		script->CompileAndRun(target);
		delete script;
	}

	static void Notify(const std::string& msg) { RE::DebugNotification(msg.c_str()); }

	// The crosshair NPC snapshotted at palette-open (or re-snapshotted for a
	// trigger) — the same target the NPC actions act on.
	static RE::Actor* Target()
	{
		return RE::TESForm::LookupByID<RE::Actor>(NpcActions::TargetFormID());
	}

	bool IsAction(const std::string& a)
	{
		return a == "fix-recycle" || a == "fix-resetai" || a == "fix-resurrect" ||
		       a == "fix-calm" || a == "fix-noclip";
	}

	void Fire(const std::string& a)
	{
		logger::info("deck fixes-tab: fire {}", a);   // marker: deck-fixes-tab

		// Player-only: toggle collision so you can walk out of geometry, fire
		// again to turn it back on. No crosshair target needed.
		if (a == "fix-noclip") {
			RunConsole("tcl", nullptr);
			Notify("Fixes: noclip toggled (fire again to restore)");
			return;
		}

		auto* t = Target();
		if (!t) {
			Notify("Fixes: look at an NPC first, then fire this");
			return;
		}

		std::string done;
		if (a == "fix-recycle") {
			RunConsole("recycleactor", t);            // rebuild 3D + AI — T-pose/invisible/wedged
			done = "3D & AI refreshed";
		} else if (a == "fix-resetai") {
			RunConsole("resetai", t);                 // re-evaluate AI packages
			done = "AI reset";
		} else if (a == "fix-resurrect") {
			RunConsole("resurrect 1", t);             // 1 = keep inventory
			done = "resurrected";
		} else if (a == "fix-calm") {
			RunConsole("stopcombat", t);
			RunConsole("setav aggression 0", t);
			done = "combat stopped";
		}
		Notify("Fixes: " + done);
		logger::info("fixes: {} on {:08X}", a, t->GetFormID());
	}
}
