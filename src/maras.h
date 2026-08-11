#pragma once

#include <string>

namespace RE
{
	class Actor;
}

// ---------------------------------------------------------------------------
// M.A.R.A.S — "Marry Anyone Rule All Skyrim" (TT_MARAS.esp + MARAS.dll).
// Reading, only. Nothing here marries or divorces anyone.
//
// WHERE MARAS ACTUALLY KEEPS A MARRIAGE — and why this file is faction reads
// ---------------------------------------------------------------------------
// Decompiled + disassembled on 2026-08-02 (the mod ships its own .psc sources,
// so most of it needed no decompile at all). The findings, because every one of
// them ruled out an approach that looked obvious:
//
//   * NOT a FormList on a quest. There is none.
//   * NOT StorageUtil. TTM_Data.psc does use StorageUtil — for the home marker,
//     the break-up timestamp, divorce-letter refs and MCM state. Not one of its
//     keys holds the spouse list.
//   * NOT JContainers.
//   * The REAL store is MARAS.dll's own C++ map, serialised into the SKSE
//     co-save as record `MARS` (chunks NPCR / SPHR / AFCT / PHOU / SPAS / CNFG).
//     Unreachable from another plugin: MARAS.dll exports only SKSEPlugin_Load /
//     _Query / _Version — no C API, no SKSE messaging dispatch.
//   * Its Papyrus natives (MARAS.IsNPCStatus, GetPermanentAffection, …) are
//     complete and would answer — but only through DispatchStaticCall, which is
//     asynchronous and on the VM's schedule. Wrong tool for painting a card.
//
//   * MARAS MIRRORS EVERY STATUS CHANGE INTO A REAL GAME FACTION. Each status
//     write calls Actor::AddToFaction(actor, TTM_TrackedNpcs, rank = status),
//     so the faction RANK is the status enum. That mirror is synchronous,
//     allocation-free, and is the mod's own authoritative copy — so it is what
//     this file reads.
//
// THE TRAP: RANK, NEVER MEMBERSHIP. An ex-wife stays in TTM_TrackedNpcs at rank
// 3 (Divorced), a jilted candidate at 4. A bare IsInFaction() would call your
// divorcee your wife. "Married" is rank == 2, exactly.
//
// THE OTHER TRAP: TT_MARAS.esp IS ESL-FLAGGED (TES4 flags 0x280). Its runtime
// FormIDs are 0xFExxx___, so a composed constant is meaningless — every form
// here must come from TESDataHandler::LookupForm(local, "TT_MARAS.esp").
// ---------------------------------------------------------------------------
namespace Maras
{
	// The status enum, straight out of the mod. Confirmed twice over: the
	// docstring in MARAS.psc, and TT_MARAS.esp's own globals
	// (TTM_StatusCandidate=0 … TTM_StatusJilted=4).
	// kDeceased is the one value that appears ONLY in the docstring — no global
	// backs it — so it is carried as probable rather than proven, and nothing
	// here branches on it beyond naming it.
	enum Status
	{
		kUntracked = -1,   // MARAS has never heard of them
		kCandidate = 0,
		kEngaged = 1,
		kMarried = 2,
		kDivorced = 3,
		kJilted = 4,
		kDeceased = 5,
	};

	struct State
	{
		bool installed = false;   // TT_MARAS.esp is loaded and its faction resolved
		int  status = kUntracked;
		bool spouse = false;      // status == kMarried, exactly

		// Extras, all from the same kind of faction-rank mirror. -1 means the
		// actor is not in that faction, which for these means "not applicable"
		// rather than "zero" — hierarchy 0 is the FIRST wife, and affection 0 is
		// a real and very bad number.
		int hierarchy = -1;       // 0/1/2 = 1st/2nd/3rd spouse, 4 = "4th or later"
		int affection = -1;       // 0–100, MARAS's permanent affection
	};

	// True once TT_MARAS.esp is loaded and its tracking faction resolves.
	bool Installed();

	// MARAS's view of one actor. Safe on nullptr, before data load, and with the
	// mod absent — all of which answer `installed:false, status:kUntracked`.
	State Of(RE::Actor* actor);

	// "happy" / "content" / "troubled" / "estranged" — MARAS's own thresholds
	// (>=75 / >=50 / >=25 / else), read out of its affection-level function.
	// Empty when affection is unknown.
	const char* AffectionWord(int affection);

	// The card's slice, ready to drop into the `about` dossier:
	//   { "on":true, "spouse":true, "status":2, "statusText":"Married",
	//     "hierarchy":0, "affection":80, "mood":"happy" }
	// An empty string when the mod is not installed — the caller emits nothing
	// at all in that case, so "no maras key" means "no MARAS", never "no".
	std::string Json(const State& st);
}
