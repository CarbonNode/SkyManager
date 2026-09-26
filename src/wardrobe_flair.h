#pragma once
#include "wardrobe.h"
#include <functional>

// Flair is wardrobe metadata. All equipment still goes through the existing
// HD_WardrobeExec quest and SOES, in one ordered Papyrus call.
namespace WardrobeFlair
{
	bool Edit(Wardrobe::Config& cfg, const nlohmann::json& edit, std::string& error);
	std::string DockJson(const Wardrobe::Config& cfg);
	bool DockEnabled(const Wardrobe::Config& cfg);
	using Done = std::function<void(const std::string&)>;
	// {kind:"outfit"|"wardrobe"|"flair"|"clear",id,includeFlair,expectedFlairId}
	void Equip(Wardrobe::Config& cfg, const std::string& request, Done done);
	void Tick(bool suspended); // main thread; never blocks on the VM
	void OnLoad();
}
