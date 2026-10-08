#include "weather_hub.h"

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp and logger.

#include "mcm_settings.h"
#include "weather_actions.h"
#include "widgets.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <random>
#include <set>
#include <string>
#include <vector>

#undef GetObject
#undef min
#undef max

namespace WeatherHub
{
	namespace
	{
		using json = nlohmann::json;
		namespace fs = std::filesystem;

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// ================================================= the sidecar ==

		std::set<std::string> g_favs;
		std::string           g_how = "blend";   // "now" | "blend"
		json                  g_extra = json::object();   // keys we do not own

		fs::path SidecarPath()
		{
			return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "weather.json";
		}

		void SaveSidecar()
		{
			json j = g_extra.is_object() ? g_extra : json::object();
			j["favs"] = json::array();
			for (const auto& f : g_favs)
				j["favs"].push_back(f);
			auto* locked = WeatherActions::Locked();
			j["lock"] = locked ? WeatherActions::IdOf(locked) : std::string();
			j["how"] = g_how;
			std::error_code ec;
			fs::create_directories(SidecarPath().parent_path(), ec);
			std::ofstream out(SidecarPath(), std::ios::binary | std::ios::trunc);
			if (out)
				out << j.dump(2, ' ', false, json::error_handler_t::replace);
		}

		// ============================================ weather readouts ==

		bool HasLightning(RE::TESWeather* w)
		{
			// Storm Lightning's own rule: "only works if the weather has a
			// thunder/lightning frequency which is not 255". The field is
			// declared int8, so 255 reads as -1.
			return w && static_cast<std::uint8_t>(w->data.thunderLightningFrequency) != 255;
		}

		std::string ColorHex(const RE::TESWeather::Data::Color3& c)
		{
			char buf[8];
			std::snprintf(buf, sizeof(buf), "#%02X%02X%02X", static_cast<std::uint8_t>(c.red),
				static_cast<std::uint8_t>(c.green), static_cast<std::uint8_t>(c.blue));
			return buf;
		}

		// The plugin that made the record, and the one whose edit is live.
		std::string MadeBy(RE::TESWeather* w)
		{
			auto* f = w ? w->GetFile(0) : nullptr;
			return f ? std::string(f->GetFilename()) : std::string();
		}
		std::string EditedBy(RE::TESWeather* w)
		{
			auto* f = w ? w->GetFile(-1) : nullptr;
			return f ? std::string(f->GetFilename()) : std::string();
		}

		std::string Label(RE::TESWeather* w)
		{
			std::string n = WeatherActions::LabelOf(w);
			if (n.empty() && w) {
				const auto id = WeatherActions::IdOf(w);
				n = std::string(WeatherActions::KindOf(w)) + " weather " + id.substr(id.find('|') + 1);
			}
			return n;
		}

		json WeatherRow(RE::TESWeather* w, RE::TESWeather* cur)
		{
			using F = RE::TESWeather::WeatherDataFlag;
			const auto id = WeatherActions::IdOf(w);
			json r{ { "id", id }, { "n", Label(w) }, { "kind", WeatherActions::KindOf(w) },
				{ "p", MadeBy(w) } };
			const auto by = EditedBy(w);
			if (!by.empty() && by != r["p"].get<std::string>())
				r["by"] = by;
			if (HasLightning(w))
				r["th"] = true;
			if (w->precipitationData)
				r["pr"] = true;
			if (w->data.flags.any(F::kPermAurora, F::kAuroraFollowsSun))
				r["au"] = true;
			r["ws"] = static_cast<int>(w->data.windSpeed);
			if (g_favs.count(id))
				r["fav"] = true;
			if (w == cur)
				r["cur"] = true;
			return r;
		}

		json NowJson()
		{
			auto* sky = RE::Sky::GetSingleton();
			json  now = json::object();
			if (!sky)
				return now;
			const bool open = sky->mode.get() == RE::Sky::Mode::kFull;
			now["outdoors"] = open;
			if (auto* w = sky->currentWeather) {
				using F = RE::TESWeather::WeatherDataFlag;
				now["id"] = WeatherActions::IdOf(w);
				now["n"] = Label(w);
				now["kind"] = WeatherActions::KindOf(w);
				now["p"] = MadeBy(w);
				const auto by = EditedBy(w);
				if (!by.empty() && by != MadeBy(w))
					now["by"] = by;
				now["th"] = HasLightning(w);
				if (HasLightning(w)) {
					now["thf"] = static_cast<int>(static_cast<std::uint8_t>(w->data.thunderLightningFrequency));
					now["lc"] = ColorHex(w->data.lightningColor);
				}
				now["pr"] = w->precipitationData != nullptr;
				now["au"] = w->data.flags.any(F::kPermAurora, F::kAuroraFollowsSun);
				now["ws"] = static_cast<int>(w->data.windSpeed);
			}
			// Mid-transition: the sky blends from lastWeather into current.
			const float pct = sky->currentWeatherPct;
			if (sky->lastWeather && sky->lastWeather != sky->currentWeather && pct < 1.0f) {
				now["pct"] = std::round(std::clamp(pct, 0.0f, 1.0f) * 100.0f) / 100.0f;
				now["from"] = Label(sky->lastWeather);
			}
			if (auto* pc = RE::PlayerCharacter::GetSingleton()) {
				if (auto* loc = pc->GetCurrentLocation()) {
					const char* nm = loc->GetName();
					if (nm && *nm)
						now["where"] = nm;
				}
			}
			now["raining"] = sky->IsRaining();
			now["snowing"] = sky->IsSnowing();
			return now;
		}

		// ===================================================== Storm Lightning ==
		//
		// Map from the MCM Helper key to what the DLL and the mod's globals call
		// it. Every name here is the one its own StormL_MCM script passes
		// (ApplyValues, read off the shipped source on 2026-10-08). The thunder
		// chances have NO native — its script only stores them in globals — so
		// those rows are honest about applying on the next load.

		constexpr const char* kSlMod = "StormLightning";

		struct SlKey
		{
			const char* key;      // ini / MCM Helper key
			const char* native;   // StormLightningPluginScript name, "" = none
			char        kind;     // 'f' SetFloatValue · 'i' SetIntValue
			const char* global;   // StormLGlobal_<this>
		};

		constexpr SlKey kSlKeys[] = {
			{ "bEnableRainSheet", "EnableSheet", 'i', "EnableSheet" },
			{ "bEnableRainFork", "EnableFork", 'i', "EnableFork" },
			{ "bEnableSnowySheet", "EnableSnowySheet", 'i', "EnableSnowySheet" },
			{ "bEnableSnowyFork", "EnableSnowyFork", 'i', "EnableSnowyFork" },
			{ "bEnableCloudySheet", "EnableCloudySheet", 'i', "EnableCloudySheet" },
			{ "bEnableCloudyFork", "EnableCloudyFork", 'i', "EnableCloudyFork" },
			{ "bHostileSheet", "SheetHostile", 'i', "SheetHostile" },
			{ "bHostileFork", "ForkHostile", 'i', "ForkHostile" },
			{ "iMinimumChainChild", "MinChainChildAmount", 'i', "MinChainChildAmount" },
			{ "iMaximumChainChild", "MaxChainChildAmount", 'i', "MaxChainChildAmount" },
			{ "iChainLightningPercentage", "ChainLightningPercentage", 'f', "ChainLightningPercentage" },
			{ "fSheetFrequency", "SheetFrequency", 'f', "SheetFrequency" },
			{ "iMinimumSheetDistance", "SheetDistanceMin", 'i', "SheetDistanceMin" },
			{ "iMaximumSheetDistance", "SheetDistanceMax", 'i', "SheetDistanceMax" },
			{ "bEnableSheetFlash", "EnableSheetFlash", 'i', "EnableSheetFlash" },
			{ "iSheetFlashAmount", "SheetFlashAmount", 'i', "SheetFlashAmount" },
			{ "fForkFrequency", "ForkFrequency", 'f', "ForkFrequency" },
			{ "iMinimumForkDistance", "ForkDistanceMin", 'i', "ForkDistanceMin" },
			{ "iMaximumForkDistance", "ForkDistanceMax", 'i', "ForkDistanceMax" },
			{ "bEnableForkFlash", "EnableForkFlash", 'i', "EnableForkFlash" },
			{ "iForkFlashAmount", "ForkFlashAmount", 'i', "ForkFlashAmount" },
			{ "iMinimumFlashAmount", "MinFlashAmount", 'i', "MinFlashAmount" },
			{ "iDefaultFlashDistance", "FlashDropDistanceMin", 'f', "FlashDropDistanceMin" },
			{ "iHorizontalStrikeDistance", "StrikeDistance", 'f', "StrikeDistance" },
			{ "iMinimumSheetHeight", "SheetHeightMin", 'f', "SheetHeightMin" },
			{ "iMaximumSheetHeight", "SheetHeightMax", 'f', "SheetHeightMax" },
			{ "fSkyCurve", "SkyCurve", 'f', "SkyCurve" },
			{ "fSheetFadeDuration", "SheetFadeDuration", 'f', "SheetFadeDuration" },
			{ "fForkFadeDuration", "ForkFadeDuration", 'f', "ForkFadeDuration" },
			{ "fSheetVolume", "SheetVolume", 'f', "SheetVolume" },
			{ "fForkVolume", "ForkVolume", 'f', "ForkVolume" },
			{ "fSheetAttenuationCurve", "SheetVolumeCurve", 'f', "SheetVolumeCurve" },
			{ "fForkAttenuationCurve", "ForkVolumeCurve", 'f', "ForkVolumeCurve" },
			{ "iSheetThunderChance", "", 'i', "SheetThunderChance" },
			{ "iForkThunderCloseChance", "", 'i', "ForkThunderCloseChance" },
			{ "iForkThunderCloseFarChance", "", 'i', "ForkThunderCloseFarChance" },
			{ "iForkThunderFarChance", "", 'i', "ForkThunderFarChance" },
			{ "iForkThunderVeryFarChance", "", 'i', "ForkThunderVeryFarChance" },
			{ "iForkThunderTooFarChance", "", 'i', "ForkThunderTooFarChance" },
		};

		const SlKey* SlFind(const std::string& key)
		{
			for (const auto& k : kSlKeys)
				if (key == k.key)
					return &k;
			return nullptr;
		}

		// The mod's own seven presets (StormL_MCM.psc OnOptionSelect), over
		// the sixteen values that differ between them. Toggles are left alone
		// on purpose: a preset is "how much lightning", not "where".
		constexpr const char* kSlPresetKeys[] = {
			"fSheetFrequency", "fForkFrequency", "iHorizontalStrikeDistance", "iMinimumFlashAmount",
			"iMaximumChainChild", "iChainLightningPercentage", "fSheetVolume", "fForkVolume",
			"fSheetAttenuationCurve", "fForkAttenuationCurve", "iSheetThunderChance",
			"iForkThunderCloseChance", "iForkThunderCloseFarChance", "iForkThunderFarChance",
			"iForkThunderVeryFarChance", "iForkThunderTooFarChance",
		};
		struct SlPreset
		{
			const char* id;
			const char* name;
			const char* blurb;
			double      v[16];
		};
		constexpr SlPreset kSlPresets[] = {
			{ "minimum", "Minimum", "A flash now and then",
				{ 0.05, 0.05, 150, 5, 5, 5, 1.00, 1.00, 0.040, 0.020, 100, 100, 100, 100, 100, 100 } },
			{ "ultra", "Ultra Realistic", "What Nolvus ships — rare and distant",
				{ 0.2, 0.3, 150, 5, 5, 5, 1.00, 1.00, 0.040, 0.020, 40, 100, 100, 80, 70, 50 } },
			{ "realistic", "Realistic", "A proper storm, still believable",
				{ 1.0, 1.0, 150, 5, 5, 5, 1.00, 1.00, 0.040, 0.020, 30, 100, 80, 50, 25, 10 } },
			{ "default", "Default", "The mod's own middle setting",
				{ 5.0, 3.0, 150, 5, 5, 5, 0.55, 0.70, 0.060, 0.040, 15, 100, 50, 25, 15, 5 } },
			{ "exciting", "Exciting", "Bolts all around you",
				{ 15.0, 7.5, 200, 5, 8, 10, 0.35, 0.50, 0.080, 0.060, 3, 50, 18, 7, 0, 0 } },
			{ "extreme", "Extreme", "Constant forks, long branching chains",
				{ 25.0, 15.0, 200, 7, 15, 20, 0.25, 0.35, 0.090, 0.070, 3, 25, 10, 5, 0, 0 } },
			{ "insane", "Insane", "The sky is on fire",
				{ 40.0, 30.0, 200, 10, 20, 50, 0.20, 0.30, 0.095, 0.075, 3, 10, 5, 1, 0, 0 } },
		};

		// Values this session wrote. MCM Helper's ini write only lands once the
		// VM runs (unpaused), so until the disk agrees, this is the truth.
		std::map<std::string, double> g_slPending;

		bool SlPresent()
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && dh->LookupModByName("StormLightning.esp") &&
			       fs::exists("Data/SKSE/Plugins/StormLightning.dll");
		}

		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

		template <class... Args>
		bool CallStatic(const char* script, const char* fn, Args... args)
		{
			auto* vm = Vm();
			if (!vm)
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto a = RE::MakeFunctionArguments(std::move(args)...);
			return vm->DispatchStaticCall(script, fn, a, cb);
		}

		using Ctl = McmSettings::ModControl;

		// Write ONE Storm Lightning value the three ways its own MCM does.
		// Returns "" on success, else the reason.
		std::string SlWrite(const Ctl& ctl, double v)
		{
			const SlKey* k = SlFind(ctl.key);
			if (!k)
				return "not a setting the deck knows how to apply";
			if (ctl.vmax > ctl.vmin)
				v = std::clamp(v, ctl.vmin, ctl.vmax);
			const char t = ctl.key.empty() ? 'f' : ctl.key[0];   // b / i / f
			if (t == 'b')
				v = v != 0.0 ? 1.0 : 0.0;
			else if (t == 'i')
				v = std::round(v);

			// 1. the global its own menu reads (immediate, engine-side)
			if (auto* g = RE::TESForm::LookupByEditorID<RE::TESGlobal>(std::string("StormLGlobal_") + k->global))
				g->value = static_cast<float>(v);

			// 2. the DLL, live (Papyrus: runs once the game is unpaused)
			bool ok = true;
			if (*k->native) {
				if (k->kind == 'f')
					ok = CallStatic("StormLightningPluginScript", "SetFloatValue",
						RE::BSFixedString(k->native), static_cast<float>(v));
				else
					ok = CallStatic("StormLightningPluginScript", "SetIntValue",
						RE::BSFixedString(k->native), static_cast<std::int32_t>(v));
			}

			// 3. MCM Helper's store + ini, so the next load restores it
			const RE::BSFixedString mod(kSlMod);
			const RE::BSFixedString id(ctl.id);
			if (t == 'b')
				CallStatic("MCM", "SetModSettingBool", mod, id, v != 0.0);
			else if (t == 'i')
				CallStatic("MCM", "SetModSettingInt", mod, id, static_cast<std::int32_t>(v));
			else
				CallStatic("MCM", "SetModSettingFloat", mod, id, static_cast<float>(v));

			g_slPending[ctl.key] = v;
			if (!ok)
				return "the Papyrus VM refused the call";
			return {};
		}

		// Short help per control — what it DOES in a storm, in plain words.
		const char* SlHelp(const std::string& key)
		{
			static const std::map<std::string, const char*> help = {
				{ "fForkFrequency", "Bolts that hit the ground. Higher = more often." },
				{ "fSheetFrequency", "Flashes inside the clouds. Higher = more often." },
				{ "iChainLightningPercentage", "Chance a bolt splits into a branching chain." },
				{ "iMaximumChainChild", "Most branches a chain can split into." },
				{ "iMinimumChainChild", "Fewest branches a chain splits into." },
				{ "iHorizontalStrikeDistance", "How far across the sky strikes spread." },
				{ "iForkFlashAmount", "How bright the world flashes on a bolt." },
				{ "iSheetFlashAmount", "How bright a cloud flash lights the land." },
				{ "bEnableRainFork", "Ground bolts in rain storms." },
				{ "bEnableRainSheet", "Cloud flashes in rain storms." },
				{ "bEnableSnowyFork", "Ground bolts in snow storms (thundersnow)." },
				{ "bEnableSnowySheet", "Cloud flashes in snow storms." },
				{ "bEnableCloudyFork", "Ground bolts under heavy cloud, no rain." },
				{ "bEnableCloudySheet", "Cloud flashes under heavy cloud, no rain." },
				{ "bHostileFork", "Ground bolts can hurt you and NPCs." },
				{ "bHostileSheet", "Cloud lightning can hurt you and NPCs." },
				{ "fForkVolume", "Thunder loudness for ground bolts." },
				{ "fSheetVolume", "Thunder loudness for cloud flashes." },
			};
			const auto it = help.find(key);
			return it == help.end() ? "" : it->second;
		}

		// The keys the main card shows, in order; everything else lives in the
		// "Every setting" popout (built from the mod's own pages).
		constexpr const char* kSlMain[] = {
			"fForkFrequency", "fSheetFrequency", "iChainLightningPercentage", "iMaximumChainChild",
			"iHorizontalStrikeDistance", "iForkFlashAmount", "fForkVolume",
			"bEnableRainFork", "bEnableRainSheet", "bEnableSnowyFork", "bEnableSnowySheet",
			"bEnableCloudyFork", "bEnableCloudySheet", "bHostileFork",
		};

		json SlRow(const Ctl& c)
		{
			const SlKey* k = SlFind(c.key);
			json r{ { "k", c.key }, { "label", c.label }, { "type", c.type },
				{ "page", c.page } };
			if (c.vmax > c.vmin) {
				r["min"] = c.vmin;
				r["max"] = c.vmax;
				if (c.vstep > 0)
					r["step"] = c.vstep;
			}
			if (c.hasDef)
				r["def"] = c.def;
			if (const auto it = g_slPending.find(c.key); it != g_slPending.end())
				r["value"] = it->second;
			else if (c.hasValue)
				r["value"] = c.value;
			else if (c.hasDef)
				r["value"] = c.def;
			if (const char* h = SlHelp(c.key); *h)
				r["help"] = h;
			if (k && !*k->native)
				r["later"] = "Storm Lightning reads this when a save loads";
			return r;
		}

		std::string SlPresetMatch(const std::map<std::string, double>& vals)
		{
			for (const auto& p : kSlPresets) {
				bool same = true;
				for (int i = 0; i < 2 && same; ++i) {   // the two frequencies ARE the preset
					const auto it = vals.find(kSlPresetKeys[i]);
					same = it != vals.end() && std::fabs(it->second - p.v[i]) < 1e-3;
				}
				if (same)
					return p.id;
			}
			return {};
		}

		json StormLightningJson()
		{
			json sys{ { "id", "storm" }, { "name", "Storm Lightning" } };
			if (!SlPresent()) {
				sys["present"] = false;
				return sys;
			}
			sys["present"] = true;
			const auto ctls = McmSettings::ReadModControls(kSlMod);
			if (ctls.empty()) {
				sys["note"] = "Its MCM settings (Data/MCM/Config/StormLightning) are missing, so the deck "
				              "cannot read its values. Its own menu still works.";
				return sys;
			}
			std::map<std::string, double> vals;
			json mainRows = json::array(), all = json::array();
			std::map<std::string, json> byKey;
			for (const auto& c : ctls) {
				if (!SlFind(c.key))
					continue;   // presets / maintenance / log: not ours to drive
				json row = SlRow(c);
				if (row.contains("value"))
					vals[c.key] = row["value"].get<double>();
				byKey[c.key] = row;
				all.push_back(std::move(row));
			}
			for (const char* k : kSlMain)
				if (const auto it = byKey.find(k); it != byKey.end())
					mainRows.push_back(it->second);
			json presets = json::array();
			for (const auto& p : kSlPresets)
				presets.push_back(json{ { "id", p.id }, { "name", p.name }, { "blurb", p.blurb },
					{ "fork", p.v[1] }, { "sheet", p.v[0] } });
			sys["main"] = std::move(mainRows);
			sys["all"] = std::move(all);
			sys["presets"] = std::move(presets);
			const auto match = SlPresetMatch(vals);
			if (!match.empty())
				sys["preset"] = match;
			sys["pending"] = !g_slPending.empty();
			// Which file the values on disk came from — a Nolvus/preset mod's
			// copy and MCM Helper's own save are the same path in the VFS.
			sys["note"] = "Live as you close the deck, and saved into its MCM settings so the next load keeps them.";
			return sys;
		}

		// ===================================================== the seasons ==

		json SeasonsJson()
		{
			json sys{ { "id", "seasons" }, { "name", "Seasons of Skyrim" } };
			const bool present = GetModuleHandleW(L"po3_SeasonsOfSkyrim.dll") != nullptr;
			sys["present"] = present;
			if (!present)
				return sys;
			const auto raw = Widgets::SeasonStateJson();
			json s = json::parse(raw, nullptr, false);
			if (!s.is_discarded() && s.is_object())
				sys["season"] = std::move(s);
			sys["note"] = "An override takes hold the next time you step from an interior to the outdoors.";
			return sys;
		}

		// Seasonal Weathers Framework: this month's weather weights, read from
		// the globals its own script sets (Season_Common_*). Shown as odds.
		json SwfJson()
		{
			json sys{ { "id", "swf" }, { "name", "Seasonal Weathers" } };
			auto* dh = RE::TESDataHandler::GetSingleton();
			const bool present = dh && dh->LookupModByName("Seasonal Weathers Framework.esp");
			sys["present"] = present;
			if (!present)
				return sys;
			static const std::pair<const char*, const char*> kinds[] = {
				{ "Pleasant", "Clear" }, { "PleasantA", "Clear (alt)" }, { "Overcast", "Overcast" },
				{ "Rain", "Rain" }, { "Rain_Storm", "Thunderstorm" }, { "Snow", "Snow" },
				{ "Snow_Storm", "Blizzard" },
			};
			auto read = [&](const char* prefix) {
				json rows = json::array();
				double total = 0;
				for (const auto& [k, label] : kinds) {
					auto* g = RE::TESForm::LookupByEditorID<RE::TESGlobal>(std::string(prefix) + k);
					if (!g)
						continue;
					const double v = std::max(0.0, static_cast<double>(g->value));
					total += v;
					rows.push_back(json{ { "k", k }, { "label", label }, { "w", v } });
				}
				for (auto& r : rows)
					r["pct"] = total > 0 ? std::round(r["w"].get<double>() * 1000.0 / total) / 10.0 : 0.0;
				return rows;
			};
			sys["odds"] = read("Season_Common_");
			sys["snowOdds"] = read("SN_Season_Common_");
			sys["note"] = "This month's weather odds, set by its own script from the month. Re-rolled on load and on waking.";
			return sys;
		}

		// R.A.S.S.: shown, not written (see the header).
		json RassJson()
		{
			json sys{ { "id", "rass" }, { "name", "R.A.S.S. — rain, ash and snow on you" } };
			auto ctls = McmSettings::ReadModControls("RASS - Visual Effects");
			sys["present"] = !ctls.empty();
			if (ctls.empty())
				return sys;
			json rows = json::array();
			for (const auto& c : ctls) {
				if (c.page.find("aintenance") != std::string::npos || c.type == "text")
					continue;
				json r{ { "k", c.key }, { "label", c.label }, { "type", c.type } };
				if (c.hasValue || c.hasDef)
					r["value"] = c.hasValue ? c.value : c.def;
				if (!c.options.empty())
					r["options"] = c.options;
				rows.push_back(std::move(r));
			}
			sys["rows"] = std::move(rows);
			sys["note"] = "Its own menu applies these through its script — change them in its MCM.";
			return sys;
		}

		json CsJson()
		{
			json sys{ { "id", "cs" }, { "name", "Community Shaders" } };
			const bool present = GetModuleHandleW(L"CommunityShaders.dll") != nullptr;
			sys["present"] = present;
			if (!present)
				return sys;
			const bool editor = fs::exists("Data/Shaders/Features/CSEditor.ini");
			sys["editor"] = editor;
			sys["note"] = editor
				? "Its in-game editor (CS menu → Weather) edits a weather's own lightning colour, frequency, wind and "
				  "fog, and has its own Lock Weather. Use one lock or the other — two locks fight."
				: "Installed without its editor feature.";
			return sys;
		}

		json SplashesJson()
		{
			json sys{ { "id", "splashes" }, { "name", "Splashes of Storms" } };
			const bool present = fs::exists("Data/SKSE/Plugins/po3_SplashesOfStorms.toml");
			sys["present"] = present;
			if (present)
				sys["note"] = "Rain splashes and ripples per rain strength. Configured in po3_SplashesOfStorms.toml, "
				              "read when the game starts.";
			return sys;
		}

		json LockJson()
		{
			auto* w = WeatherActions::Locked();
			if (!w)
				return json{ { "on", false } };
			return json{ { "on", true }, { "id", WeatherActions::IdOf(w) }, { "n", Label(w) } };
		}

		json LightState()
		{
			json out{ { "v", 1 }, { "now", NowJson() }, { "lock", LockJson() }, { "how", g_how } };
			json favs = json::array();
			for (const auto& f : g_favs)
				favs.push_back(f);
			out["favs"] = std::move(favs);
			json systems = json::array();
			systems.push_back(StormLightningJson());
			systems.push_back(SeasonsJson());
			systems.push_back(SwfJson());
			systems.push_back(RassJson());
			systems.push_back(CsJson());
			systems.push_back(SplashesJson());
			out["systems"] = std::move(systems);
			return out;
		}

		json Result(bool ok, const std::string& msg)
		{
			return json{ { "ok", ok }, { "msg", msg }, { "state", LightState() } };
		}
	}

	// ============================================================== API ==

	void Init()
	{
		std::ifstream in(SidecarPath(), std::ios::binary);
		if (!in)
			return;
		const auto j = json::parse(in, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return;
		g_extra = j;
		if (j.contains("favs") && j["favs"].is_array())
			for (const auto& f : j["favs"])
				if (f.is_string())
					g_favs.insert(f.get<std::string>());
		g_how = j.value("how", std::string("blend")) == "now" ? "now" : "blend";
		const auto lock = j.value("lock", std::string());
		if (!lock.empty()) {
			if (auto* w = WeatherActions::Resolve(lock))
				WeatherActions::Lock(w);
			else
				logger::info("weather: saved lock '{}' is gone from the load order", lock);
		}
		logger::info("weather-hub: sidecar read ({} favourite(s), lock {})", g_favs.size(),
			lock.empty() ? "off" : lock);
	}

	std::string StateJson(const std::string& req)
	{
		json in = json::parse(req, nullptr, false);
		const bool full = in.is_object() && in.value("full", false);
		json out = LightState();
		if (full) {
			auto* dh = RE::TESDataHandler::GetSingleton();
			auto* sky = RE::Sky::GetSingleton();
			RE::TESWeather* cur = sky ? sky->currentWeather : nullptr;
			json rows = json::array();
			if (dh) {
				for (auto* w : dh->GetFormArray<RE::TESWeather>()) {
					if (!w || !w->GetFile(0))
						continue;   // dynamic forms are not durable, not offerable
					rows.push_back(WeatherRow(w, cur));
				}
			}
			// Build marker (hd-markers.json: "weather-hub: listed").
			logger::info("weather-hub: listed {} weather(s)", rows.size());
			out["weathers"] = std::move(rows);
		}
		return Dump(out);
	}

	std::string SetJson(const std::string& req)
	{
		json in = json::parse(req, nullptr, false);
		if (in.is_discarded() || !in.is_object())
			return Dump(Result(false, "Bad request"));
		const std::string act = in.value("act", std::string());

		if (act == "force") {
			const std::string id = in.value("id", std::string());
			auto* w = WeatherActions::Resolve(id);
			if (!w)
				return Dump(Result(false, "That weather is gone from the load order"));
			const std::string how = in.value("how", g_how);
			WeatherActions::Force(w, how != "now");
			if (WeatherActions::Locked())
				SaveSidecar();   // the lock moved with it
			auto* sky = RE::Sky::GetSingleton();
			const bool open = sky && sky->mode.get() == RE::Sky::Mode::kFull;
			std::string msg = (how == "now" ? "The sky turns to " : "The sky rolls toward ") + Label(w);
			if (!open)
				msg += " — you will see it outside";
			return Dump(Result(true, msg));
		}
		if (act == "storm") {
			// "Storm now": a rain weather with lightning, picked at random so
			// the load order's own storms take turns. Prefer the favourites.
			auto* dh = RE::TESDataHandler::GetSingleton();
			std::vector<RE::TESWeather*> pool, favPool;
			if (dh) {
				for (auto* w : dh->GetFormArray<RE::TESWeather>()) {
					if (!w || !w->GetFile(0) || !HasLightning(w))
						continue;
					if (std::string(WeatherActions::KindOf(w)) != "rain")
						continue;
					pool.push_back(w);
					if (g_favs.count(WeatherActions::IdOf(w)))
						favPool.push_back(w);
				}
			}
			auto& from = favPool.empty() ? pool : favPool;
			if (from.empty())
				return Dump(Result(false, "No thunderstorm weather in the load order"));
			static std::mt19937 rng{ std::random_device{}() };
			auto* w = from[std::uniform_int_distribution<std::size_t>(0, from.size() - 1)(rng)];
			WeatherActions::Force(w, true);
			if (WeatherActions::Locked())
				SaveSidecar();
			return Dump(Result(true, "A storm rolls in — " + Label(w)));
		}
		if (act == "release") {
			WeatherActions::Release();
			SaveSidecar();
			return Dump(Result(true, "The sky decides again"));
		}
		if (act == "lock") {
			RE::TESWeather* w = nullptr;
			const std::string id = in.value("id", std::string());
			if (!id.empty())
				w = WeatherActions::Resolve(id);
			else if (auto* sky = RE::Sky::GetSingleton())
				w = sky->currentWeather;
			if (!w)
				return Dump(Result(false, "No weather to lock"));
			if (!id.empty())
				WeatherActions::Force(w, g_how != "now");
			WeatherActions::Lock(w);
			SaveSidecar();
			return Dump(Result(true, "Locked: " + Label(w) + " stays until you unlock it"));
		}
		if (act == "unlock") {
			WeatherActions::Unlock();
			SaveSidecar();
			return Dump(Result(true, "Unlocked — the weather is free to change"));
		}
		if (act == "fav") {
			const std::string id = in.value("id", std::string());
			if (!WeatherActions::Resolve(id))
				return Dump(Result(false, "That weather is gone from the load order"));
			const bool on = in.value("on", true);
			if (on)
				g_favs.insert(id);
			else
				g_favs.erase(id);
			SaveSidecar();
			return Dump(Result(true, on ? "Starred" : "Unstarred"));
		}
		if (act == "how") {
			g_how = in.value("how", std::string("blend")) == "now" ? "now" : "blend";
			SaveSidecar();
			return Dump(Result(true, g_how == "now" ? "Weather changes instantly" : "Weather rolls in gradually"));
		}
		if (act == "sl" || act == "slPreset") {
			if (!SlPresent())
				return Dump(Result(false, "Storm Lightning is not installed"));
			const auto ctls = McmSettings::ReadModControls(kSlMod);
			auto findCtl = [&](const std::string& key) -> const Ctl* {
				for (const auto& c : ctls)
					if (c.key == key)
						return &c;
				return nullptr;
			};
			if (act == "sl") {
				// Validate against the SAME table the write uses (the act:"glob" law).
				const std::string key = in.value("k", std::string());
				const Ctl*        c = SlFind(key) ? findCtl(key) : nullptr;
				if (!c)
					return Dump(Result(false, "Unknown Storm Lightning setting"));
				if (!in.contains("value") || !(in["value"].is_number() || in["value"].is_boolean()))
					return Dump(Result(false, "No value"));
				const double v = in["value"].is_boolean() ? (in["value"].get<bool>() ? 1.0 : 0.0)
				                                          : in["value"].get<double>();
				const auto err = SlWrite(*c, v);
				if (!err.empty())
					return Dump(Result(false, c->label + ": " + err));
				// Build marker (hd-markers.json: "weather-hub: storm lightning").
				logger::info("weather-hub: storm lightning {} = {}", key, g_slPending[key]);
				return Dump(Result(true, c->label + " set — live as you close the deck"));
			}
			const std::string pid = in.value("preset", std::string());
			const SlPreset*   p = nullptr;
			for (const auto& x : kSlPresets)
				if (pid == x.id)
					p = &x;
			if (!p)
				return Dump(Result(false, "Unknown preset"));
			int n = 0;
			for (int i = 0; i < 16; ++i)
				if (const Ctl* c = findCtl(kSlPresetKeys[i]); c && SlWrite(*c, p->v[i]).empty())
					++n;
			logger::info("weather-hub: storm lightning preset '{}' ({} value(s))", p->id, n);
			return Dump(Result(true, std::string(p->name) + " lightning — live as you close the deck"));
		}
		if (act == "season") {
			const int n = in.value("n", 0);
			if (n < 0 || n > 4)
				return Dump(Result(false, "Unknown season"));
			if (!Widgets::SetSeasonOverride(n))
				return Dump(Result(false, "Seasons of Skyrim did not answer"));
			static const char* names[5] = { "", "Winter", "Spring", "Summer", "Autumn" };
			return Dump(Result(true, n == 0 ? "Seasons follow the calendar again"
			                                : std::string(names[n]) + " — once you next step outside"));
		}
		return Dump(Result(false, "Unknown action"));
	}
}
