#include "spellbook.h"

#include "spell_actions.h"

#include <chrono>
#include <condition_variable>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>

// pch (force-included) provides RE::/SKSE::/logger and, via RE/Skyrim.h,
// <Windows.h> — carry the macro block every module that touches RE does.
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
namespace fs = std::filesystem;

namespace Spellbook
{
	namespace
	{
		// A book of every spell in a big load order with a few dozen
		// categories is ~100 KB; anything past this is not a spellbook.
		constexpr std::size_t kMaxDocBytes = 2 * 1024 * 1024;

		fs::path DocPath()
		{
			// NOT spellbook.json: that name is the Spell Deck's portal export
			// (SpellActions::ExportSpellbook rewrites it on every Magic open, and
			// portal/server.js reads it). Sharing it ate the first book on
			// 2026-10-14 — the export looked like an existing (empty) book.
			return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "spellbook-sheet.json";
		}

		// The document lives in memory after the first read, so an open never
		// touches the disk twice; a save updates it before the write is queued.
		std::mutex  g_docMutex;
		bool        g_docLoaded = false;
		std::string g_doc;   // "" = no book yet

		// Writer: one worker, coalescing. `g_pending` holds the newest doc not
		// yet on disk; the worker sleeps until there is one.
		std::mutex              g_writeMutex;
		std::condition_variable g_writeCv;
		std::string             g_pending;
		bool                    g_hasPending = false;
		bool                    g_writerStarted = false;

		void LoadLocked()
		{
			if (g_docLoaded)
				return;
			g_docLoaded = true;
			std::ifstream in(DocPath(), std::ios::binary);
			if (!in)
				return;
			std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
			if (text.size() > kMaxDocBytes)
				return;
			const auto j = json::parse(text, nullptr, false);
			if (j.is_discarded() || !j.is_object()) {
				logger::warn("spellbook: spellbook-sheet.json is not a JSON object — starting a fresh book (file left untouched)");
				return;
			}
			g_doc = std::move(text);
			logger::info("spellbook: book loaded ({} bytes)", g_doc.size());   // marker: spellbook-load
		}

		void WriteNow(const std::string& text)
		{
			std::error_code ec;
			const auto      path = DocPath();
			fs::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
				if (!out) {
					logger::warn("spellbook: could not write {}", PathU8(tmp));
					return;
				}
				out << text;
				if (!out.good()) {
					logger::warn("spellbook: short write to {}", PathU8(tmp));
					return;
				}
			}
			fs::rename(tmp, path, ec);   // replaces on Windows (MoveFileEx semantics)
			if (ec) {
				// rename over an existing file can fail if something holds it open;
				// fall back to copy-over, and never leave the .tmp behind.
				std::error_code ec2;
				fs::copy_file(tmp, path, fs::copy_options::overwrite_existing, ec2);
				fs::remove(tmp, ec2);
				if (ec2) {
					logger::warn("spellbook: could not replace spellbook-sheet.json ({})", ec.message());
					return;
				}
			}
			logger::info("spellbook: book saved ({} bytes)", text.size());   // marker: spellbook-save
		}

		void WriterLoop()
		{
			for (;;) {
				std::string text;
				{
					std::unique_lock l(g_writeMutex);
					g_writeCv.wait(l, [] { return g_hasPending; });
					text = std::move(g_pending);
					g_pending.clear();
					g_hasPending = false;
				}
				try {
					WriteNow(text);
				} catch (const std::exception& e) {
					logger::error("spellbook: write threw: {}", e.what());
				} catch (...) {
					logger::error("spellbook: write threw (unknown)");
				}
				// let a burst of drags settle into one write
				std::this_thread::sleep_for(std::chrono::milliseconds(250));
			}
		}

		void QueueWrite(std::string text)
		{
			std::lock_guard l(g_writeMutex);
			g_pending = std::move(text);
			g_hasPending = true;
			if (!g_writerStarted) {
				g_writerStarted = true;
				std::thread(WriterLoop).detach();
			}
			g_writeCv.notify_one();
		}
	}

	std::string StateJson()
	{
		json out = json::object();

		auto known = json::parse(SpellActions::KnownSpellsJson(), nullptr, false);
		if (!known.is_array())
			known = json::array();
		// Magicka cost per hand spell, where the engine can answer safely
		// (MagickaCostForPlayer refuses internal/mod spells it cannot evaluate).
		for (auto& row : known) {
			if (!row.is_object() || row.value("slot", std::string()) != "hand")
				continue;
			const auto id = row.value("formId", 0u);
			if (!id)
				continue;
			if (auto* s = RE::TESForm::LookupByID<RE::SpellItem>(id)) {
				if (const auto c = SpellActions::MagickaCostForPlayer(s); c && std::isfinite(*c))
					row["cost"] = static_cast<int>(std::lround(*c));
			}
		}
		out["known"] = std::move(known);

		auto equip = json::parse(SpellActions::EquipStateJson(), nullptr, false);
		out["equip"] = equip.is_object() ? equip : json::object();

		{
			std::lock_guard l(g_docMutex);
			LoadLocked();
			if (g_doc.empty())
				out["doc"] = nullptr;
			else {
				auto d = json::parse(g_doc, nullptr, false);
				out["doc"] = (d.is_discarded() || !d.is_object()) ? json(nullptr) : std::move(d);
			}
		}
		logger::info("spellbook: state pushed ({} known spells)", out["known"].size());   // marker: spellbook-state
		return out.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string Save(const std::string& docJson)
	{
		if (docJson.size() > kMaxDocBytes)
			return R"({"ok":false,"msg":"The spellbook is too large to save."})";
		const auto j = json::parse(docJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"Spellbook save refused: not a JSON object."})";
		// Re-serialise: what reaches the disk is always valid, replaced-UTF-8 JSON.
		std::string text = j.dump(1, '\t', false, json::error_handler_t::replace);
		{
			std::lock_guard l(g_docMutex);
			g_docLoaded = true;
			g_doc = text;
		}
		QueueWrite(std::move(text));
		return R"({"ok":true,"msg":""})";
	}
}
