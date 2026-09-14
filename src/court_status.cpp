#include "court_status.h"

#include "fertility_bridge.h"
#include "maras.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <mutex>
#include "json.hpp"   // the PCH copy; include guard makes it a no-op

namespace CourtStatus
{
	namespace
	{
		std::filesystem::path StatusPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "court-status.json";
		}

		std::mutex  g_mutex;
		std::string g_lastText;   // last payload written, minus the timestamp — skip identical writes

		std::string PathU8(const std::filesystem::path& p)
		{
			const auto s = p.u8string();
			return std::string(s.begin(), s.end());
		}

		nlohmann::json FertilityJson(RE::Actor* actor)
		{
			nlohmann::json f;
			const auto s = FertilityBridge::For(actor);
			if (!s.available || !s.tracked)
				return f;   // absent key = FM does not track her
			f["pregnant"] = s.pregnant;
			if (s.pregnant) {
				f["day"] = s.pregnancyDay;
				if (s.termDays > 0) {
					f["termDays"] = s.termDays;
					f["percent"] = s.percent;
					f["daysLeft"] = s.termDays > s.pregnancyDay ? s.termDays - s.pregnancyDay : 0;
				}
				if (s.trimester > 0)
					f["trimester"] = s.trimester;
				if (!s.father.empty())
					f["father"] = s.father;
			} else {
				f["cycleDay"] = s.cycleDay;
				f["ovulating"] = s.ovulating;
			}
			if (s.lastBirthDay > 0)
				f["lastBirthDay"] = s.lastBirthDay;
			return f;
		}

		nlohmann::json MarasJson(RE::Actor* actor)
		{
			nlohmann::json m;
			const auto s = Maras::Of(actor);
			if (!s.installed)
				return m;
			m["status"] = s.status;
			m["spouse"] = s.spouse;
			if (s.hierarchy >= 0)
				m["hierarchy"] = s.hierarchy;
			if (s.affection >= 0) {
				m["affection"] = s.affection;
				const char* word = Maras::AffectionWord(s.affection);
				if (word && *word)
					m["affectionWord"] = word;
			}
			return m;
		}
	}

	bool Write(const std::string& foStateJson)
	{
		nlohmann::json out{
			{ "version", 1 },
			{ "fertility", FertilityBridge::Available() },
			{ "maras", Maras::Installed() },
			{ "actors", nlohmann::json::object() },
		};

		const auto env = nlohmann::json::parse(foStateJson, nullptr, false);
		if (!env.is_discarded() && env.is_object()) {
			const nlohmann::json& state =
				env.contains("state") && env["state"].is_object() ? env["state"] : env;
			if (state.contains("categories") && state["categories"].is_array()) {
				for (const auto& cat : state["categories"]) {
					if (!cat.is_object() || !cat.contains("members") || !cat["members"].is_array())
						continue;
					const auto catName = cat.value("name", std::string(""));
					for (const auto& member : cat["members"]) {
						if (!member.is_object())
							continue;
						const auto id = member.value("formId", std::string(""));
						if (id.empty())
							continue;
						RE::FormID formId = 0;
						try {
							formId = static_cast<RE::FormID>(std::stoul(id, nullptr, 16));
						} catch (const std::exception&) {
							continue;
						}
						auto* form = RE::TESForm::LookupByID(formId);
						auto* refr = form ? form->As<RE::TESObjectREFR>() : nullptr;
						auto* actor = refr ? refr->As<RE::Actor>() : nullptr;
						if (!actor)
							continue;

						std::string name = member.value("name", std::string(""));
						if (name.empty()) {
							const char* dn = actor->GetDisplayFullName();
							name = dn ? dn : "";
						}
						if (name.empty())
							continue;

						auto& entry = out["actors"][name];
						if (entry.is_null()) {
							entry = nlohmann::json{ { "formId", id }, { "categories", nlohmann::json::array() } };
							const auto fert = FertilityJson(actor);
							if (!fert.is_null())
								entry["fertility"] = fert;
							const auto maras = MarasJson(actor);
							if (!maras.is_null())
								entry["maras"] = maras;
						}
						if (!catName.empty())
							entry["categories"].push_back(catName);
					}
				}
			}
		}

		// Everything except the timestamp: if it is byte-identical to the last
		// write, leave the disk alone (this runs on a timer).
		const auto body = out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		{
			std::lock_guard l(g_mutex);
			if (body == g_lastText)
				return true;
		}
		out["written"] = static_cast<long long>(
			std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
		const auto text = out.dump(1, '\t', false, nlohmann::json::error_handler_t::replace);

		try {
			const auto path = StatusPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream o(tmp, std::ios::trunc | std::ios::binary);
				if (!o.is_open()) {
					logger::error("court-status: could not open {} for writing", PathU8(tmp));
					return false;
				}
				o << text;
				o.flush();
				if (!o.good()) {
					logger::error("court-status: write to {} failed mid-stream", PathU8(tmp));
					return false;
				}
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec) {
				logger::error("court-status: atomic swap failed: {}", ec.message());
				return false;
			}
			{
				std::lock_guard l(g_mutex);
				g_lastText = body;
			}
			logger::info("court-status: wrote {} actors to {}", out["actors"].size(), PathU8(path));
			return true;
		} catch (const std::exception& e) {
			logger::error("court-status: write threw: {}", e.what());
			return false;
		}
	}
}
