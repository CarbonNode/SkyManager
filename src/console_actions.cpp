#include "console_actions.h"

#include "npc_actions.h"

#include <string>
#include <vector>

// pch (force-included) provides RE::/SKSE:: and `using namespace std::literals`.

namespace ConsoleActions
{
	// The same Script-factory run every console-backed action here uses
	// (fix_actions / door_actions / nff_control): CompileAndRun's target makes
	// a ref-scoped command act ON that ref with no `prid` dance; a null target
	// runs it globally.
	static void RunConsole(const std::string& cmd, RE::TESObjectREFR* target)
	{
		auto* factory = RE::IFormFactory::GetConcreteFormFactoryByType<RE::Script>();
		auto* script  = factory ? factory->Create() : nullptr;
		if (!script)
			return;
		script->SetCommand(cmd);
		script->CompileAndRun(target);
		delete script;
	}

	// One command per line, the Bethesda batch-file convention: blank lines
	// and `;`/`#` comment lines are skipped, everything else runs in order.
	static std::vector<std::string> SplitCommands(const std::string& text)
	{
		std::vector<std::string> out;
		std::string              line;
		const auto flush = [&]() {
			std::size_t b = 0, e = line.size();
			while (b < e && (line[b] == ' ' || line[b] == '\t' || line[b] == '\r'))
				++b;
			while (e > b && (line[e - 1] == ' ' || line[e - 1] == '\t' || line[e - 1] == '\r'))
				--e;
			if (e > b && line[b] != ';' && line[b] != '#')
				out.emplace_back(line.substr(b, e - b));
			line.clear();
		};
		for (const char c : text) {
			if (c == '\n')
				flush();
			else
				line += c;
		}
		flush();
		return out;
	}

	void Fire(const std::string& name, const std::string& command, bool targetCrosshair)
	{
		const auto cmds = SplitCommands(command);
		if (cmds.empty()) {
			logger::warn("console-cmd: '{}' has no runnable line", name);
			return;
		}

		RE::TESObjectREFR* target = nullptr;
		if (targetCrosshair) {
			// The palette-open snapshot (or the live re-snapshot a trigger fire
			// just took): the actor you were looking at, else the non-actor ref
			// (door, chest, dropped sword).
			if (const auto id = NpcActions::TargetFormID())
				target = RE::TESForm::LookupByID<RE::TESObjectREFR>(id);
			if (!target)
				if (const auto id = NpcActions::ItemRefFormID())
					target = RE::TESForm::LookupByID<RE::TESObjectREFR>(id);
			if (!target) {
				RE::DebugNotification(
					(name + ": look at the target first, then fire this").c_str());
				logger::info("console-cmd: '{}' wants a crosshair target, none snapshotted", name);
				return;
			}
		}

		for (const auto& c : cmds) {
			logger::info("console-cmd: fire '{}' -> \"{}\"{}", name, c,
				target ? " on crosshair target" : "");
			RunConsole(c, target);
		}
	}
}
