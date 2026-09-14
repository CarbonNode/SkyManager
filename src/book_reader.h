#pragma once

#include <string>

// Read Every Book — the vanilla inventory "Read" applied to every book, note
// and spell tome in the player's bag in one press, with no Book Menu. Skill
// books level the skill, tomes teach their spell and are consumed, scripted
// quest books get their OnRead(). Exposed to the deck as the "read-books"
// action entry (device == "action"). See book_reader.cpp for what "vanilla"
// means here — it was established from the engine, not guessed.
namespace BookReader
{
	bool IsAction(const std::string& action);
	void Fire(const std::string& action);   // main thread only
}
