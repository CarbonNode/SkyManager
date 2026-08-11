#include "vkey_bridge.h"

#include "pch.h"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <memory>
#include <thread>

namespace
{
	// Mirror of VirtualKey's ButtonEventDeleter: ButtonEvent::Create allocates
	// through the game's allocator, so it must be freed the same way.
	struct ButtonEventDeleter
	{
		void operator()(RE::ButtonEvent* e) const
		{
			if (!e)
				return;
			e->~ButtonEvent();
			RE::free(e);
		}
	};

	// One keyboard ButtonEvent carrying the virtual idCode, pushed through the
	// input manager exactly as VirtualKey::nativeinput::DispatchButton does. MUST
	// run on the game thread (SendEvent walks the engine's input sinks).
	void DispatchButton(std::int32_t key, bool pressed, float heldSecs)
	{
		auto* mgr = RE::BSInputDeviceManager::GetSingleton();
		if (!mgr) {
			logger::warn("vkey: input manager unavailable, key {} dropped", key);
			return;
		}
		const float held = pressed ? 0.0f : (std::max)(heldSecs, 0.000001f);
		std::unique_ptr<RE::ButtonEvent, ButtonEventDeleter> btn{
			RE::ButtonEvent::Create(RE::INPUT_DEVICE::kKeyboard,
				RE::BSFixedString{},
				static_cast<std::uint32_t>(key),
				pressed ? 1.0f : 0.0f,
				held)
		};
		if (!btn) {
			logger::warn("vkey: ButtonEvent allocation failed for key {}", key);
			return;
		}
		RE::InputEvent* head = btn.get();
		mgr->SendEvent(&head);
		logger::info("vkey native {} key {}", pressed ? "down" : "up", key);
	}
}

namespace VKey
{
	bool IsVirtualKey(std::int32_t code)
	{
		return code >= kBase && code <= kMax;
	}

	void Fire(std::int32_t code, const std::string& verb, int holdMs)
	{
		if (!IsVirtualKey(code)) {
			logger::warn("vkey fire: {} outside virtual-key range 100000..9999999", code);
			return;
		}
		auto* task = SKSE::GetTaskInterface();
		if (!task)
			return;

		if (verb == "down") {
			task->AddTask([code]() { DispatchButton(code, true, 0.0f); });
			return;
		}
		if (verb == "up") {
			// A lone Up reports a nominal hold; the receiving mod just needs the edge.
			task->AddTask([code]() { DispatchButton(code, false, 0.1f); });
			return;
		}

		// tap: down now, up after the hold. The release rides a detached timer that
		// re-posts to the game thread, so both edges dispatch on the main thread.
		task->AddTask([code]() { DispatchButton(code, true, 0.0f); });
		const int hold = std::clamp(holdMs, 1, 5000);
		std::thread([code, hold]() {
			std::this_thread::sleep_for(std::chrono::milliseconds(hold));
			if (auto* t = SKSE::GetTaskInterface())
				t->AddTask([code, hold]() {
					DispatchButton(code, false, static_cast<float>(hold) / 1000.0f);
				});
		}).detach();
	}

	std::string CatalogJson()
	{
		namespace fs = std::filesystem;
		// VFS-relative path: under MO2 this resolves to the merged Data tree,
		// including VirtualKey's overwrite copy. Best-effort -- a mid-session
		// write may lag the VFS snapshot, so the picker always keeps manual entry.
		const fs::path path = fs::path("Data") / "SKSE" / "Plugins" / "VirtualKey" / "Bindings.json";

		nlohmann::json out = nlohmann::json::array();
		std::error_code ec;
		if (!fs::exists(path, ec))
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		try {
			std::ifstream in(path, std::ios::binary);
			if (!in)
				return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			nlohmann::json doc;
			in >> doc;
			for (const auto& item : doc.value("bindings", nlohmann::json::array())) {
				if (!item.is_object())
					continue;
				const std::int32_t key = item.value("key", 0);
				if (!IsVirtualKey(key))
					continue;
				std::string disp = item.value("display_name", std::string(""));
				const std::string opt = item.value("option", std::string(""));
				out.push_back(nlohmann::json{
					{ "key", key },
					{ "label", disp.empty() ? opt : disp },
					{ "mod", item.value("mod", std::string("")) },
					{ "page", item.value("page", std::string("")) },
					{ "option", opt },
					{ "verification", item.value("verification", std::string("verified")) } });
			}
		} catch (const std::exception& e) {
			logger::warn("vkey catalog read failed: {}", e.what());
		}
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}
}
