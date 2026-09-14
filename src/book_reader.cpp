#include "book_reader.h"

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

// pch (force-included) provides RE::/SKSE:: and the logger.

// What a "vanilla read" actually is — established 2026-09-14 by disassembling
// the live 1.5.97 image (the Steam exe is DRM-packed on disk, so this was read
// out of the running process; the notes are in README.md, "Read Every Book"):
//
//   * TESObjectBOOK::Read(reader)  [Address Library 17439]  IS the read. For the
//     player it does: +1 level to an unread skill book's skill (only below
//     100), Actor::AddSpell for a spell tome plus the "spell learned" HUD line,
//     the has-been-read flag with its form change, and the engine's own private
//     book-read stat event. It is the ONLY site in the whole exe that sets the
//     read flag, so nothing about a read lives anywhere else.
//   * The inventory menu's Read button calls Read() directly for a SPELL TOME
//     and then RemoveItem(1): the tome is eaten. Nothing else happens for a
//     tome — no menu, no script event.
//   * For every OTHER book it opens the Book Menu. BookMenu::OpenBookMenu calls
//     Read() at its end, and the menu's first frame builds a
//     TESBookReadEvent { container ref, base FormID, unique ID } from the
//     stack's ExtraDataList (ExtraReferenceHandle + ExtraUniqueID) and sends it
//     through ScriptEventSourceHolder. That event is what the Papyrus VM turns
//     into the OnRead() a quest book's script is waiting on. Read() alone never
//     sends it, which is why a mod that only calls Read() ("Auto Reading",
//     Nexus 130553) cannot progress a quest book.
//
// So this does exactly those things, per book, in the engine's order, and never
// opens a menu. It touches no engine code — three ordinary calls the engine
// makes itself (Read, SendEvent, RemoveItem).

namespace BookReader
{
	namespace
	{
		constexpr const char* kAction = "read-books";

		using ReadFn = bool (*)(RE::TESObjectBOOK*, RE::TESObjectREFR*);

		// The Book Menu reaches Read() through ONE call site, at the end of
		// BookMenu::OpenBookMenu (1.5.97: 50122 + 0x22D). Other plugins detour
		// that exact call to hear about reads - on this rig po3's Papyrus
		// Extender does (its OnBookRead event), verified in the live process on
		// 2026-09-14. Calling Read() directly would be invisible to them, so
		// when the site still holds a `call rel32` (vanilla or detoured) we
		// call whatever it points at: identical bytes to what the menu runs.
		// Anything unexpected (other runtime, patched differently) falls back
		// to the plain member call, which is the same function minus the
		// bystanders. We never write to the site.
		ReadFn ResolveMenuRead()
		{
			static ReadFn resolved = []() -> ReadFn {
				const ReadFn plain = [](RE::TESObjectBOOK* b, RE::TESObjectREFR* r) { return b->Read(r); };
				if (!REL::Module::IsSE()) {
					logger::info("book-reader: not SE runtime - reading via TESObjectBOOK::Read directly");
					return plain;
				}
				REL::Relocation<std::uint8_t*> site{ REL::ID(50122), 0x22D };
				const std::uint8_t* p = site.get();
				// mov rdx,[rip+..] ; mov rcx,[rip+..] ; call rel32
				const bool shape = p[-14] == 0x48 && p[-13] == 0x8B && p[-12] == 0x15 &&
				                   p[-7] == 0x48 && p[-6] == 0x8B && p[-5] == 0x0D && p[0] == 0xE8;
				if (!shape) {
					logger::warn("book-reader: OpenBookMenu read site has an unexpected shape - reading via TESObjectBOOK::Read directly");
					return plain;
				}
				std::int32_t rel = 0;
				std::memcpy(&rel, p + 1, sizeof(rel));
				const auto target = reinterpret_cast<std::uintptr_t>(p) + 5 + rel;
				const auto vanilla = REL::Relocation<std::uintptr_t>{ REL::ID(17439) }.address();
				logger::info("book-reader: reading through the Book Menu's call site -> {:#x} ({})",
					target, target == vanilla ? "vanilla TESObjectBOOK::Read" : "detoured by another plugin, as the menu's reads are");
				return reinterpret_cast<ReadFn>(target);
			}();
			return resolved;
		}

		bool ReadLikeTheMenu(RE::TESObjectBOOK* book, RE::TESObjectREFR* reader)
		{
			return ResolveMenuRead()(book, reader);
		}

		const char* Name(RE::TESForm* f)
		{
			const char* n = f ? f->GetName() : nullptr;
			return (n && *n) ? n : "(unnamed)";
		}

		const char* SkillName(RE::ActorValue av)
		{
			auto* list = RE::ActorValueList::GetSingleton();
			auto* info = list ? list->GetActorValue(av) : nullptr;
			const char* n = info ? info->GetFullName() : nullptr;
			return (n && *n) ? n : "skill";
		}

		// The Book Menu's event build, mirrored: one TESBookReadEvent per stack
		// that carries a container handle or a unique id. A plain stack (no
		// extra data, so no script could be attached) sends nothing — exactly
		// what vanilla does for it.
		int SendReadEvents(RE::InventoryEntryData* entry)
		{
			if (!entry || !entry->extraLists)
				return 0;
			auto* holder = RE::ScriptEventSourceHolder::GetSingleton();
			if (!holder)
				return 0;
			int sent = 0;
			for (auto* xList : *entry->extraLists) {
				if (!xList)
					continue;
				RE::TESBookReadEvent e{};
				if (auto* uid = xList->GetByType<RE::ExtraUniqueID>()) {
					e.baseFormID = uid->baseID;
					e.uniqueID = uid->uniqueID;
				}
				if (auto* rh = xList->GetByType<RE::ExtraReferenceHandle>())
					e.ref = rh->containerRef.get();
				if (!e.ref && e.uniqueID == 0)
					continue;
				holder->SendEvent<RE::TESBookReadEvent>(&e);
				++sent;
			}
			return sent;
		}
	}

	bool IsAction(const std::string& action)
	{
		return action == kAction;
	}

	void Fire(const std::string& action)
	{
		if (!IsAction(action))
			return;
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return;

		// A copy: the engine's inventory is not walked while we mutate it, and
		// the entries' ExtraDataLists are still the live ones (pointers), which
		// is what the events need.
		auto inv = player->GetInventory([](RE::TESBoundObject& o) { return o.IsBook(); });

		int books = 0, tomes = 0, skills = 0, events = 0;
		int alreadyRead = 0, knownSpells = 0, failed = 0;
		std::string firstSkill, firstSpell;
		std::vector<RE::TESObjectBOOK*> eat;

		for (auto& [obj, data] : inv) {
			auto* book = obj ? obj->As<RE::TESObjectBOOK>() : nullptr;
			if (!book || data.first <= 0)
				continue;
			const char* name = Name(book);

			if (book->TeachesSpell()) {
				auto* spell = book->GetSpell();
				if (!spell) {
					++failed;
					logger::warn("book-reader: tome '{}' teaches no spell - skipped", name);
					continue;
				}
				if (player->HasSpell(spell)) {
					// Vanilla would show "already known" and keep the tome;
					// skipping is the same outcome without the message.
					++knownSpells;
					continue;
				}
				// The inventory menu calls Read() directly for a tome (no menu,
				// no detour on that path), so the plain call is the faithful one.
				const bool ok = book->Read(player);
				logger::info("book-reader: tome '{}' -> {} ({})", name, ok ? "learned" : "NOT learned", Name(spell));
				if (ok) {
					++tomes;
					eat.push_back(book);   // vanilla: RemoveItem(1) after a learned tome
					if (firstSpell.empty())
						firstSpell = Name(spell);
				} else {
					++failed;
				}
				continue;
			}

			if (book->IsRead()) {
				++alreadyRead;
				continue;
			}

			auto*       avo = player->AsActorValueOwner();
			const bool  teaches = book->TeachesSkill();
			const float before = (teaches && avo) ? avo->GetActorValue(book->GetSkill()) : 0.0f;

			ReadLikeTheMenu(book, player);
			const int sent = SendReadEvents(data.second.get());
			++books;
			events += sent;

			if (teaches && avo) {
				const float after = avo->GetActorValue(book->GetSkill());
				if (after > before) {
					++skills;
					if (firstSkill.empty())
						firstSkill = SkillName(book->GetSkill());
				}
				logger::info("book-reader: skill book '{}' -> {} {:.0f}->{:.0f} (read={}, events={})",
					name, SkillName(book->GetSkill()), before, after, book->IsRead(), sent);
			} else {
				logger::info("book-reader: read '{}' (read={}, events={})", name, book->IsRead(), sent);
			}
		}

		for (auto* b : eat)
			player->RemoveItem(b, 1, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);

		logger::info("book-reader: swept {} book form(s): {} read, {} tome(s) learned+consumed, {} skill(s) up, "
		             "{} script event(s), {} already read, {} spell(s) already known, {} failed",
			static_cast<int>(inv.size()), books, tomes, skills, events, alreadyRead, knownSpells, failed);

		char msg[200];
		if (books == 0 && tomes == 0) {
			if (alreadyRead > 0 || knownSpells > 0)
				std::snprintf(msg, sizeof(msg), "Nothing new to read - %d already read, %d spell%s already known",
					alreadyRead, knownSpells, knownSpells == 1 ? "" : "s");
			else
				std::snprintf(msg, sizeof(msg), "No books in your bag");
		} else {
			std::string s = "Read " + std::to_string(books + tomes) + (books + tomes == 1 ? " book" : " books");
			if (skills > 0)
				s += " - +" + std::to_string(skills) + (skills == 1 ? " skill (" + firstSkill + ")" : " skills");
			if (tomes > 0)
				s += " - learned " + std::to_string(tomes) + (tomes == 1 ? " spell (" + firstSpell + ")" : " spells");
			if (events > 0)
				s += " - " + std::to_string(events) + (events == 1 ? " quest book" : " quest books");
			std::snprintf(msg, sizeof(msg), "%s", s.c_str());
		}
		RE::DebugNotification(msg);
	}
}
