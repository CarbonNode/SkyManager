#pragma once

// Inventory tab — a full replacement for the vanilla inventory, as a deck page
// (Rober, 2026-10-10: "a full inventory replacement - focused on high UX / UI
// for modern game requirements, with sortability, speed, model previewing …
// can show after spells"). The view is view/HotkeyDeck/inventory-pane.js; this
// is its engine half.
//
// ROWS ARE INSTANCES, NOT BASES. The vanilla menu shows a tempered blade, an
// enchanted copy and a stolen copy of the same sword as three lines, because
// they ARE three different things to carry (each lives in its own
// ExtraDataList on the inventory entry). The wheel's InventoryJson folds them
// into one base row, which is right for a wheel and wrong here. A row is a
// GROUP: the extra-data lists of one base that look the same to a player
// (same display name, worn state, favourite, ownership, enchantment, poison,
// soul, quest flag and adjusted stats), plus the plain remainder of the stack.
// The group's identity on the wire is `gk` (a hash of that signature), and
// every verb re-derives the groups and finds its target by `gk` — never by a
// list index, which shifts the moment anything in the stack changes.
//
// NUMBERS ARE THE MENU'S NUMBERS. Damage and armour come from
// PlayerCharacter::GetDamage / GetArmorValue on an entry holding exactly that
// instance's list — the same calls the vanilla menu uses, so skills, perks and
// smithing are in them. The base record values ride along for the detail panel.
//
// VERBS (one owner: this module, per the deck law):
//   use   — equip / unequip toggle for wearables, drink / eat / apply / ready
//           for the one-shot kinds (same rules as WheelMenu::Use, but aimed at
//           the instance, so the tempered sword is the one that goes in hand);
//   left  — equip a one-handed weapon, a scroll or a torch to the LEFT hand;
//   drop  — Actor::DropObject, `n` of the group (quest items refused, as the
//           vanilla menu refuses them);
//   fav   — InventoryChanges::SetFavorite / RemoveFavorite on every list of
//           the group (the Favorites menu's own calls);
//   read  — a book: BookReader::ReadOne, the engine read the menu performs
//           (skill raise, tome learned + eaten, OnRead for quest books).
//
// THREADING: every entry point walks the player's inventory or touches the
// equip manager — MAIN THREAD ONLY (main.cpp AddTasks them). The sidecar is
// read/written from those same tasks.
//
// Bridge (main.cpp OnJsIv*): ivList -> ivListData · ivDetail -> ivDetailData ·
// ivAct -> ivResult (+ a fresh ivListData) · ivSave (no reply). Names are
// disjoint from every other pane's, per the deck law.

#include <string>

namespace InventoryPane
{
	// {ok, gold, carry:{cur,max}, prefs, seen:[keys], items:[row…]}
	// row = {id, pl, gk, n, c, s, q, v, w, dmg?, ar?, eq, fav, st, en, po, qi,
	//        rd?, tb?, sl?, wt?, soul?}
	//   c   category: weapon armor clothing jewelry shield potion food poison
	//                 ingredient scroll book tome soulgem key ammo light misc
	//   s   sub label for the row ("Sword", "Heavy · Body", "Spell tome" …)
	//   eq  0 not worn · 1 worn / right hand · 2 left hand · 3 both hands
	// req {icons?:bool}: icons=true also evaluates the SkyUI/I4 game icon per
	// row (gi path, gc colour, gd I4 sub-type text) — only asked for while the
	// view shows game icons, because the first call loads every I4 rule file.
	[[nodiscard]] std::string ListJson(const std::string& req);

	// {try?:{id,pl}, queue} -> ItemIcons::MirrorJson for the PLAYER (+ try echo):
	// the person page's full-body turntable, optionally wearing one armour piece
	// from the bag in place of what shares its slots.
	[[nodiscard]] std::string MirrorJson(const std::string& req);

	// {id, pl, gk} -> {ok, id, pl, gk, desc, effects:[{n, d, mag, dur}],
	//                  ench?, charge?, base:{…}, teaches?, soul?, plugin}
	[[nodiscard]] std::string DetailJson(const std::string& req);

	// {op, id, pl, gk, n?} -> {ok, msg, op, id, pl, gk}
	[[nodiscard]] std::string ActJson(const std::string& req);

	// {prefs:{…}, seen:[…]} — the view owns this schema; stored verbatim
	// (merged over what is on disk so an older view cannot flatten a key it
	// does not know) in Data/SKSE/Plugins/HotkeyDeck/inventory.json.
	void SaveJson(const std::string& req);
}
