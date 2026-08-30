// Journal tab — storage, merge and picture pool. See journal.h for the contract.
//
// Design notes that are load-bearing:
//  - NOTHING here touches the engine. The journal is prose and pictures; the
//    view owns every pixel of it. That is why this file is pure <filesystem> +
//    nlohmann and why it can answer while the game is mid-load.
//  - Save() is a READ-MODIFY-WRITE, never a blind overwrite. The Deck Portal
//    edits the same journal.json from the phone, so two authors exist for one
//    file. Per-page updatedAt decides each page, `trash` tombstones carry
//    deletions across, and the merged doc is handed BACK so the view reconciles
//    onto what actually landed. (The alternative — the portal-queue idiom used
//    for hotkeys.json/FollowerOrganizer.json — exists because the GAME owns
//    those files wholesale in memory. Nothing owns journal.json in memory but
//    us, and we re-read on every save, so a queue would buy nothing and cost
//    the phone its live editor.)
//  - Every write is tmp-file + rename, so neither the portal nor the renderer
//    can ever read a half-written journal.
//  - Caps everywhere (books, pages, images, text length). A journal is typed by
//    hand; anything past these is a broken writer, not a big diary, and an
//    unbounded doc would be re-serialised on every save.
//  - All dumps use error_handler_t::replace: page text is arbitrary user input
//    (and may arrive from a phone keyboard), and a throwing dump would lose the
//    save entirely.

#include "journal.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace Journal
{
	namespace fs = std::filesystem;

	namespace
	{
		using json = nlohmann::json;

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// ------------------------------------------------------------- caps --
		constexpr std::size_t kMaxBooks = 40;
		constexpr std::size_t kMaxPages = 400;    // per book
		constexpr std::size_t kMaxImages = 40;    // per page
		constexpr std::size_t kMaxText = 200000;  // per page, characters
		constexpr std::size_t kMaxTrash = 2000;
		constexpr std::size_t kMaxPoolFiles = 4000;
		constexpr std::uintmax_t kMaxImageBytes = 16ull * 1024 * 1024;

		const char* kExts[] = { ".png", ".jpg", ".jpeg", ".webp", ".gif" };

		std::int64_t NowSec()
		{
			return std::chrono::duration_cast<std::chrono::seconds>(
				std::chrono::system_clock::now().time_since_epoch())
			    .count();
		}

		std::string LowerCopy(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		bool IsImageExt(const fs::path& p)
		{
			const auto ext = LowerCopy(PathU8(p.extension()));
			for (const char* e : kExts) {
				if (ext == e)
					return true;
			}
			return false;
		}

		// A pool filename the view may be asked to load. Deliberately strict —
		// this string is concatenated into a view-relative URL, so anything that
		// could climb out of journal-images/ is refused rather than sanitised.
		bool ValidPoolName(const std::string& f)
		{
			if (f.empty() || f.size() > 160)
				return false;
			if (f.find('/') != std::string::npos || f.find('\\') != std::string::npos)
				return false;
			if (f.find("..") != std::string::npos)
				return false;
			for (unsigned char c : f) {
				const bool ok = std::isalnum(c) || c == '.' || c == '-' || c == '_' ||
				                c == ' ' || c == '(' || c == ')' || c == '\'' || c == '+' ||
				                c == '&' || c == ',';
				if (!ok)
					return false;
			}
			return IsImageExt(fs::path(f));
		}

		// ------------------------------------------------------------- paths --
		fs::path DeckViewDir()
		{
			return fs::path("Data") / "PrismaUI" / "views" / "HotkeyDeck";
		}

		fs::path DocPath()
		{
			return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "journal.json";
		}

		// SkyManager.ini [Journal] sImageDir — the same by-hand, section-blind
		// probe OpenDiag uses, in string flavour. An unreadable/absent file or
		// key answers empty, which means "use the Desktop default".
		std::string ReadIniString(const char* wantKey)
		{
			std::ifstream in("Data/SKSE/Plugins/SkyManager.ini");
			if (!in)
				return {};
			std::string line;
			while (std::getline(in, line)) {
				const auto eq = line.find('=');
				if (eq == std::string::npos)
					continue;
				std::string key = line.substr(0, eq);
				key.erase(0, key.find_first_not_of(" \t"));
				const auto keyEnd = key.find_last_not_of(" \t");
				key.erase(keyEnd == std::string::npos ? 0 : keyEnd + 1);
				if (_stricmp(key.c_str(), wantKey) != 0)
					continue;
				std::string val = line.substr(eq + 1);
				val.erase(0, val.find_first_not_of(" \t"));
				const auto valEnd = val.find_last_not_of(" \t\r");
				val.erase(valEnd == std::string::npos ? 0 : valEnd + 1);
				return val;
			}
			return {};
		}
	}

	fs::path ImageDir()
	{
		return DeckViewDir() / "journal-images";
	}

	fs::path InboxDir()
	{
		const std::string cfg = ReadIniString("sImageDir");
		if (!cfg.empty())
			return fs::path(cfg);
		// A REAL path, outside the game's Data tree on purpose: MO2 does not
		// virtualise it, so the plugin can read a file that appeared there after
		// launch. Copying it into the view folder (a write the game process makes)
		// is what puts it where the renderer can load it — the exact route the
		// Spell Deck's Desktop icon drop-folder already takes.
		if (const char* prof = std::getenv("USERPROFILE"); prof && *prof)
			return fs::path(prof) / "Desktop" / "SkyManager Journal Images";
		return {};
	}

	namespace
	{
		// ------------------------------------------------------- the document --
		json BlankDoc()
		{
			return json{
				{ "version", 1 },
				{ "updatedAt", 0 },
				{ "activeBook", "" },
				{ "style", json::object() },
				{ "books", json::array() },
				{ "trash", json::array() },
			};
		}

		json ReadDoc()
		{
			std::ifstream in(DocPath(), std::ios::binary);
			if (!in)
				return BlankDoc();
			try {
				json j = json::parse(in, nullptr, true, true);
				if (!j.is_object())
					return BlankDoc();
				if (!j.contains("books") || !j["books"].is_array())
					j["books"] = json::array();
				if (!j.contains("trash") || !j["trash"].is_array())
					j["trash"] = json::array();
				return j;
			} catch (...) {
				logger::warn("journal: journal.json unreadable — treating as empty (the file is NOT overwritten until you save)");
				return BlankDoc();
			}
		}

		bool WriteDoc(const json& doc)
		{
			const auto      path = DocPath();
			std::error_code ec;
			fs::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("journal: could not write {}", PathU8(tmp));
					return false;
				}
				out << doc.dump(1, '\t', false, json::error_handler_t::replace);
			}
			fs::remove(path, ec);
			fs::rename(tmp, path, ec);
			if (ec) {
				logger::warn("journal: rename failed: {}", ec.message());
				return false;
			}
			return true;
		}

		std::string Str(const json& j, const char* key)
		{
			if (!j.is_object())
				return {};
			auto it = j.find(key);
			return (it != j.end() && it->is_string()) ? it->get<std::string>() : std::string{};
		}

		std::int64_t Num(const json& j, const char* key)
		{
			if (!j.is_object())
				return 0;
			auto it = j.find(key);
			return (it != j.end() && it->is_number()) ? it->get<std::int64_t>() : 0;
		}

		// Clamp one page into the shape and size the contract promises. Unknown
		// keys survive untouched on purpose: a NEWER view (or the portal) may
		// carry per-page fields this build has never heard of, and eating them
		// would make an older DLL silently destroy the phone's work.
		void ClampPage(json& p)
		{
			if (!p.is_object())
				return;
			if (auto it = p.find("text"); it != p.end() && it->is_string()) {
				auto s = it->get<std::string>();
				if (s.size() > kMaxText) {
					s.resize(kMaxText);
					*it = s;
				}
			}
			if (auto it = p.find("images"); it != p.end() && it->is_array()) {
				if (it->size() > kMaxImages)
					it->erase(it->begin() + kMaxImages, it->end());
			}
		}

		void ClampBook(json& b)
		{
			if (!b.is_object())
				return;
			auto it = b.find("pages");
			if (it == b.end() || !it->is_array()) {
				b["pages"] = json::array();
				return;
			}
			if (it->size() > kMaxPages)
				it->erase(it->begin() + kMaxPages, it->end());
			for (auto& p : *it)
				ClampPage(p);
		}

		void ClampDoc(json& d)
		{
			if (!d.is_object()) {
				d = BlankDoc();
				return;
			}
			if (!d.contains("books") || !d["books"].is_array())
				d["books"] = json::array();
			if (d["books"].size() > kMaxBooks)
				d["books"].erase(d["books"].begin() + kMaxBooks, d["books"].end());
			for (auto& b : d["books"])
				ClampBook(b);
			if (!d.contains("trash") || !d["trash"].is_array())
				d["trash"] = json::array();
			if (d["trash"].size() > kMaxTrash)
				d["trash"].erase(d["trash"].begin(), d["trash"].end() - kMaxTrash);
		}

		// --------------------------------------------------------- the merge --
		//
		// Union by id at both levels, newest-updatedAt wins per object, and a
		// tombstone in `trash` removes an id whose surviving copy is not NEWER
		// than the deletion. Order follows the INCOMING doc (that is the author
		// who just acted); ids only the other side knows are appended in their
		// own order, so a page written on the phone lands at the end instead of
		// vanishing.
		using TrashMap = std::unordered_map<std::string, std::int64_t>;

		TrashMap TrashOf(const json& d)
		{
			TrashMap m;
			if (!d.is_object() || !d.contains("trash") || !d["trash"].is_array())
				return m;
			for (const auto& t : d["trash"]) {
				const auto id = Str(t, "id");
				if (id.empty())
					continue;
				const auto at = Num(t, "at");
				auto       it = m.find(id);
				if (it == m.end() || at > it->second)
					m[id] = at;
			}
			return m;
		}

		json MergeTrash(const json& a, const json& b)
		{
			TrashMap m = TrashOf(a);
			for (const auto& [id, at] : TrashOf(b)) {
				auto it = m.find(id);
				if (it == m.end() || at > it->second)
					m[id] = at;
			}
			json out = json::array();
			for (const auto& [id, at] : m)
				out.push_back(json{ { "id", id }, { "at", at } });
			if (out.size() > kMaxTrash)
				out.erase(out.begin(), out.end() - kMaxTrash);
			return out;
		}

		bool Buried(const TrashMap& trash, const std::string& id, std::int64_t updatedAt)
		{
			auto it = trash.find(id);
			return it != trash.end() && updatedAt <= it->second;
		}

		// Merge two page arrays. `contributed` is set when `other` supplied a page
		// (new, or a newer revision) that `mine` did not have — that is what makes
		// the "your phone's edits merged in" line honest.
		json MergePages(const json& mine, const json& other, const TrashMap& trash, bool& contributed)
		{
			std::unordered_map<std::string, const json*> otherById;
			std::vector<std::string>                     otherOrder;
			if (other.is_array()) {
				for (const auto& p : other) {
					const auto id = Str(p, "id");
					if (id.empty())
						continue;
					if (otherById.emplace(id, &p).second)
						otherOrder.push_back(id);
				}
			}

			json                            out = json::array();
			std::unordered_set<std::string> taken;
			if (mine.is_array()) {
				for (const auto& p : mine) {
					const auto id = Str(p, "id");
					if (id.empty())
						continue;
					auto       it = otherById.find(id);
					const json* pick = &p;
					if (it != otherById.end() && Num(*it->second, "updatedAt") > Num(p, "updatedAt")) {
						pick = it->second;
						contributed = true;
					}
					if (Buried(trash, id, Num(*pick, "updatedAt")))
						continue;
					out.push_back(*pick);
					taken.insert(id);
				}
			}
			for (const auto& id : otherOrder) {
				if (taken.count(id))
					continue;
				const json* p = otherById[id];
				if (Buried(trash, id, Num(*p, "updatedAt")))
					continue;
				out.push_back(*p);
				contributed = true;
			}
			if (out.size() > kMaxPages)
				out.erase(out.begin() + kMaxPages, out.end());
			return out;
		}

		json MergeDocs(const json& mine, const json& disk, bool& contributed)
		{
			const TrashMap trash = TrashOf(MergeTrash(mine, disk));

			std::unordered_map<std::string, const json*> diskById;
			std::vector<std::string>                     diskOrder;
			if (disk.is_object() && disk.contains("books") && disk["books"].is_array()) {
				for (const auto& b : disk["books"]) {
					const auto id = Str(b, "id");
					if (id.empty())
						continue;
					if (diskById.emplace(id, &b).second)
						diskOrder.push_back(id);
				}
			}

			json out = mine.is_object() ? mine : BlankDoc();
			json books = json::array();
			std::unordered_set<std::string> taken;

			if (out.contains("books") && out["books"].is_array()) {
				for (const auto& b : out["books"]) {
					const auto id = Str(b, "id");
					if (id.empty())
						continue;
					auto it = diskById.find(id);
					if (it == diskById.end()) {
						if (!Buried(trash, id, Num(b, "updatedAt")))
							books.push_back(b);
						taken.insert(id);
						continue;
					}
					// Book METADATA (title, cover) follows the newer book stamp;
					// its pages merge page-by-page regardless, because the two
					// authors may have touched different pages of the same book.
					const json& newer = Num(*it->second, "updatedAt") > Num(b, "updatedAt") ? *it->second : b;
					json        merged = newer;
					if (&newer != &b)
						contributed = true;
					merged["pages"] = MergePages(
						b.contains("pages") ? b["pages"] : json::array(),
						it->second->contains("pages") ? (*it->second)["pages"] : json::array(),
						trash, contributed);
					if (!Buried(trash, id, Num(merged, "updatedAt")))
						books.push_back(merged);
					taken.insert(id);
				}
			}
			for (const auto& id : diskOrder) {
				if (taken.count(id))
					continue;
				const json* b = diskById[id];
				if (Buried(trash, id, Num(*b, "updatedAt")))
					continue;
				books.push_back(*b);
				contributed = true;
			}
			if (books.size() > kMaxBooks)
				books.erase(books.begin() + kMaxBooks, books.end());

			// Top-level style/activeBook are single-valued: the newer whole-doc
			// stamp wins, so a phone that just re-styled the book is not undone by
			// a deck save that only added a paragraph.
			if (Num(disk, "updatedAt") > Num(mine, "updatedAt")) {
				if (disk.contains("style"))
					out["style"] = disk["style"];
				if (disk.contains("activeBook"))
					out["activeBook"] = disk["activeBook"];
				contributed = true;
			}
			out["books"] = books;
			out["trash"] = MergeTrash(mine, disk);
			out["version"] = 1;
			out["updatedAt"] = NowSec();
			return out;
		}

		// -------------------------------------------------------- the pool --
		struct PoolFile
		{
			std::string   name;
			std::int64_t  mtime;
			std::uintmax_t size;
		};

		std::int64_t MTime(const fs::directory_entry& e)
		{
			std::error_code ec;
			const auto      t = e.last_write_time(ec);
			if (ec)
				return 0;
			// Steady enough for a cache-bust token; the absolute epoch does not
			// matter, only that replacing a file changes it.
			return static_cast<std::int64_t>(t.time_since_epoch().count() / 10000000);
		}

		std::vector<PoolFile> ListPool()
		{
			std::vector<PoolFile> out;
			std::error_code       ec;
			const auto            dir = ImageDir();
			if (!fs::exists(dir, ec))
				return out;
			for (const auto& e : fs::directory_iterator(dir, fs::directory_options::skip_permission_denied, ec)) {
				if (ec)
					break;
				if (!e.is_regular_file(ec) || !IsImageExt(e.path()))
					continue;
				const auto name = PathU8(e.path().filename());
				if (!ValidPoolName(name))
					continue;
				std::error_code sz;
				out.push_back(PoolFile{ name, MTime(e), fs::file_size(e.path(), sz) });
				if (out.size() >= kMaxPoolFiles)
					break;
			}
			std::sort(out.begin(), out.end(),
				[](const PoolFile& a, const PoolFile& b) { return a.mtime > b.mtime; });
			return out;
		}

		json PoolJson(const std::vector<PoolFile>& pool)
		{
			json arr = json::array();
			for (const auto& f : pool)
				arr.push_back(json{ { "f", f.name }, { "mt", f.mtime }, { "sz", static_cast<std::int64_t>(f.size) } });
			return arr;
		}

		// Copy anything new out of the real-path inbox into the pool. The copy is
		// a write made BY THE GAME PROCESS, which is what puts the bytes somewhere
		// the renderer can actually open (under MO2 it lands in overwrite). The
		// inbox file is left alone — it is the phone's/Explorer's folder, not ours.
		int SweepInbox()
		{
			const auto inbox = InboxDir();
			if (inbox.empty())
				return 0;
			std::error_code ec;
			if (!fs::exists(inbox, ec))
				return 0;
			const auto dest = ImageDir();
			fs::create_directories(dest, ec);
			int copied = 0;
			for (const auto& e : fs::directory_iterator(inbox, fs::directory_options::skip_permission_denied, ec)) {
				if (ec)
					break;
				std::error_code fe;
				if (!e.is_regular_file(fe) || !IsImageExt(e.path()))
					continue;
				const auto name = PathU8(e.path().filename());
				if (!ValidPoolName(name)) {
					logger::warn("journal: inbox file '{}' skipped — rename it (letters, digits, spaces, - _ . only)", name);
					continue;
				}
				if (fs::file_size(e.path(), fe) > kMaxImageBytes) {
					logger::warn("journal: inbox file '{}' skipped — larger than 16 MB", name);
					continue;
				}
				const auto target = dest / name;
				if (fs::exists(target, fe)) {
					// Already in the pool. Re-copy only when the inbox copy is
					// genuinely newer, so a sweep is cheap and an in-game capture
					// mirrored back out cannot bounce forever.
					std::error_code te;
					const auto      a = fs::last_write_time(e.path(), fe);
					const auto      b = fs::last_write_time(target, te);
					if (fe || te || !(a > b))
						continue;
				}
				std::error_code ce;
				fs::copy_file(e.path(), target, fs::copy_options::overwrite_existing, ce);
				if (ce) {
					// A picture the renderer is drawing is memory-mapped and cannot
					// be replaced. Not an error worth failing the open for.
					logger::warn("journal: could not copy '{}' from the inbox: {}", name, ce.message());
					continue;
				}
				++copied;
			}
			if (copied > 0)
				logger::info("journal: swept {} picture(s) from the inbox", copied);
			return copied;
		}
	}

	void EnsureSeeded()
	{
		std::error_code ec;
		fs::create_directories(ImageDir(), ec);
		if (!fs::exists(DocPath(), ec)) {
			// Seed it so the file EXISTS before MO2's next launch-time listing
			// snapshot — the portal then only ever edits a file that is already
			// there (EnsurePortraitBridge's law, same reason).
			WriteDoc(BlankDoc());
			logger::info("journal: seeded empty journal.json");
		}
	}

	std::string OpenJson()
	{
		const int  swept = SweepInbox();
		const auto pool = ListPool();
		json       doc = ReadDoc();
		ClampDoc(doc);
		return Dump(json{
			{ "ok", true },
			{ "doc", doc },
			{ "images", PoolJson(pool) },
			{ "swept", swept },
			{ "dir", "journal-images" },
			{ "inbox", PathU8(InboxDir()) },
		});
	}

	std::string Save(const std::string& req)
	{
		json in;
		try {
			in = json::parse(req, nullptr, true, true);
		} catch (...) {
			return Dump(json{ { "ok", false }, { "msg", "The journal could not be read back from the view — nothing was written." } });
		}
		json mine = (in.is_object() && in.contains("doc")) ? in["doc"] : json();
		if (!mine.is_object())
			return Dump(json{ { "ok", false }, { "msg", "That save carried no journal — nothing was written." } });
		ClampDoc(mine);

		const json disk = ReadDoc();
		bool       contributed = false;
		json       merged = MergeDocs(mine, disk, contributed);
		ClampDoc(merged);

		if (!WriteDoc(merged)) {
			return Dump(json{ { "ok", false },
				{ "msg", "The journal could not be written to disk — your text is still on the page, but it is not saved yet." },
				{ "doc", merged } });
		}
		std::size_t pages = 0;
		for (const auto& b : merged["books"]) {
			if (b.is_object() && b.contains("pages") && b["pages"].is_array())
				pages += b["pages"].size();
		}
		logger::info("journal: saved {} book(s), {} page(s){}", merged["books"].size(), pages,
			contributed ? " (merged with edits made elsewhere)" : "");
		return Dump(json{ { "ok", true }, { "doc", merged }, { "merged", contributed } });
	}

	std::string ImagesJson(const std::string& req)
	{
		bool sweep = true;
		try {
			const json j = json::parse(req.empty() ? "{}" : req, nullptr, true, true);
			if (j.is_object() && j.contains("sweep") && j["sweep"].is_boolean())
				sweep = j["sweep"].get<bool>();
		} catch (...) {
			/* a malformed poll just sweeps — the default */
		}
		const int swept = sweep ? SweepInbox() : 0;
		return Dump(json{ { "ok", true }, { "images", PoolJson(ListPool()) }, { "swept", swept } });
	}

	std::string DropImage(const std::string& req)
	{
		std::string f;
		try {
			const json j = json::parse(req.empty() ? "{}" : req, nullptr, true, true);
			f = Str(j, "f");
		} catch (...) {
			/* handled by the validity check below */
		}
		if (!ValidPoolName(f))
			return Dump(json{ { "ok", false }, { "msg", "That is not a picture in the journal's folder." } });

		std::error_code ec;
		bool            gone = true;
		fs::remove(ImageDir() / f, ec);
		if (fs::exists(ImageDir() / f, ec))
			gone = false;
		// Also from the inbox, or the next sweep would put it straight back.
		const auto inbox = InboxDir();
		if (!inbox.empty()) {
			std::error_code ie;
			fs::remove(inbox / f, ie);
		}
		if (!gone) {
			return Dump(json{ { "ok", false },
				{ "msg", "That picture is open in the running game and can't be deleted right now — it goes on the next launch." },
				{ "images", PoolJson(ListPool()) } });
		}
		logger::info("journal: dropped picture '{}'", f);
		return Dump(json{ { "ok", true }, { "msg", "Picture removed." }, { "images", PoolJson(ListPool()) } });
	}
}
