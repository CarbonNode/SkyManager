#pragma once

#include <filesystem>
#include <functional>
#include <string>

// WRITE side for My Home is Your Home SKSE NG — the half nff_bridge.* refuses
// to do. Where nff_bridge READS the mod's conclusions off the engine, this file
// asks the MOD to change them, through the exact entry points its own dialogue
// uses.
//
// ------------------------------------------------------------------ why ----
// The obvious implementation — place an XMarker and SetLinkedRef() it under
// MHiYH's keyword — is WRONG, and would leave a follower with a home she never
// walks to. NG's linked ref is an OUTPUT, not the state:
//
//   * The state lives in MHiYH.dll's own C++ database, keyed by a SLOT the mod
//     hands out (`MMTYHNative.RegisterActor` -> slot; `GetSlot`, `HasMarker`,
//     `SetSchedule`, `GetDesiredAliasMask`, …). An actor we linked a ref onto
//     by hand is still `GetSlot() == -1`: unregistered, with no schedule row
//     and no dirty-queue entry, so the scheduler never considers her.
//   * The PACKAGES come from eight per-activity quests (0x80D…0x81C). NG's
//     scheduler (`MHiYHScheduleManager.ApplyChangedSlot`) fills/clears a
//     resident alias in each per its recomputed activity mask; the package on
//     the alias is what makes the NPC walk. No alias, no package, no walking —
//     however good the linked ref looks.
//   * The marker itself must be `PlaceAtMe(XMarker, 1, /*persist*/ true, …)`
//     and is then SERIALIZED BY MHiYH's OWN DLL and restored as the package's
//     Named Linked Reference on load. So the Domains trick (one session-scoped
//     marker, re-aimed per jump — src/place_actions.cpp) deliberately does NOT
//     transfer: a home marker must outlive the session, and MHiYH is the thing
//     that knows how to make it do that. We never create one.
//
// So every op here is one `DispatchStaticCall` into **MHiYHController**, the
// mod's own hidden global-function script — literally the same call its
// dialogue fragments make (`vvvMarkHome.psc` -> `MHiYHController.MarkHome`,
// `vvvMarkHomeWork.psc` -> `SetAreaMarker(speaker, 2)`, and so on; sources ship
// with the mod under `scripts\source\`). Those functions own the whole
// transaction: register the actor, create and link the persistent marker,
// enable the schedule, force the alias, add the HasHome faction, roll the whole
// thing back if any step fails, then `RequestScheduleRefresh()` +
// `EvaluatePackage()`. That is the "what makes it take effect" answer, and it
// is theirs, not ours — the same instinct as driving SOES by mod event rather
// than by native.
//
// -------------------------------------------------------------- the gates ---
// Reproduced from MHiYHController.psc so the deck can refuse in words instead
// of dispatching a call that silently returns False:
//
//   MarkHome        requires akActor.IsPlayerTeammate()
//   MoveHome        requires an existing home marker (no teammate requirement)
//   SetAreaMarker   kind 1..6 only, and requires HasMarker(actor, 0) — every
//                   other stop hangs off the home
//   DisableArea     kind 1..6 only
//   kind 7 (passive Watch) has NO marker of its own — it shares Guard's (0x804)
//
// -------------------------------------------------------------- threading ---
// MAIN THREAD ONLY, like every other RE:: path in this plugin — schedule via
// SKSE::GetTaskInterface()->AddTask. The Papyrus call itself is ASYNCHRONOUS:
// Apply() returns as soon as the stack is queued, and the real Bool result
// arrives later on `done` (already hopped back to the main thread for you).
namespace MhiyhControl
{
	// Called with the *final* result envelope, on the main thread. May never
	// fire at all if the VM never runs the stack (no save loaded); callers must
	// treat the immediate return of Apply() as the only guaranteed reply.
	using Done = std::function<void(const std::string&)>;

	// One op. `cmdJson`:
	//
	//   { "op":"setHome",    "formId":"0x0001A6A1", "name":"Seraphine" }
	//   { "op":"forgetHome", "formId":"…",          "name":"…" }
	//   { "op":"repair",     "formId":"…",          "name":"…" }
	//   { "op":"setSpot",    "formId":"…", "kind":2, "name":"…" }
	//   { "op":"clearSpot",  "formId":"…", "kind":2, "name":"…" }
	//
	// `setHome` picks MarkHome vs MoveHome itself, exactly as MHiYH's own two
	// dialogue topics do: no home yet -> MarkHome (registers + default
	// schedules + faction + home alias), home already there -> MoveHome (which
	// deliberately does NOT re-force the home alias, because the scheduler owns
	// the one-active-package invariant).
	//
	// Returns immediately, always. Envelope:
	//
	//   { "ok":false, "phase":"refused", "msg":"…" }          nothing dispatched
	//   { "ok":true,  "phase":"sent", "op":…, "kind":…,
	//     "formId":"…", "msg":"…" }                            queued in the VM
	//
	// and later, on `done`:
	//
	//   { "ok":bool, "phase":"done", "op":…, "kind":…, "formId":"…", "msg":"…" }
	//
	// A refusal is a complete answer — `done` will not fire.
	std::string Apply(const std::string& cmdJson, Done done);

	// ------------------------------------------------ the Deck Portal (phone)
	// Two halves of ONE handoff, and both live here rather than in main.cpp for
	// the same reason Apply() does: the mod's rules get written down once.
	//
	// READ — WriteStatusJson() drops `mhiyh-status.json` beside the NFF export
	// in the deck's own view folder. It is a JOIN of the two payloads the
	// Followers tab already builds (FollowerDeck's roster + NffBridge's MHiYH
	// slice) re-keyed by ORIGINAL NAME, because that is the only durable handle
	// the phone has: FollowerOrganizer.json stores names and a plugin-relative
	// form string, never the runtime FormID this side speaks in.
	//
	// A deliberate SIBLING of nff-status.json, not a field inside it — that
	// file is the NFF *outfit* export and is written only when the NFF sub-tab
	// opens, so folding the day into it would tie a follower's schedule to
	// opening an unrelated tab.
	//
	// WRITE — ApplyPortal() drains `portal-mhiyh.json`, the sidecar the portal
	// queues day changes into (it never performs a game action itself, same law
	// as portal-npc-fields.json). Every op is replayed through Apply() above,
	// so the phone cannot reach MHiYH by a path the deck's own UI doesn't use.
	//
	// ⚠ THE POSITIONAL TRAP. setHome / setSpot mark THE PLAYER'S FEET at the
	// moment the op is APPLIED — not the moment it was tapped on the phone. One
	// left queued until the next Followers-tab open would move her home to
	// wherever Rober happens to be standing then: silent, wrong, and
	// destructive. So every op carries `at` (epoch ms, written by the portal on
	// this same machine) and a positional op older than kPositionalTtlMs is
	// DROPPED with a log line instead of applied. The portal additionally
	// refuses to queue one unless the live pipe answers, so in practice a
	// positional op lands ~1 s after the tap. Clearing ops (forgetHome /
	// clearSpot) carry no such risk and never expire.
	//
	// Both are MAIN THREAD ONLY (they read live actors and dispatch Papyrus).
	// `foStateJson` is FollowerDeck::StateJson() — passed in rather than
	// rebuilt, because every caller already has it in hand.
	inline constexpr long long kPositionalTtlMs = 120'000;

	void WriteStatusJson(const std::filesystem::path& deckViewDir,
		const std::string& foStateJson, const std::string& nffStateJson);

	// Returns true when at least one op was DISPATCHED — which is not the same
	// as applied: the Papyrus call is asynchronous, so `done` (the same
	// callback shape Apply() takes, already hopped to the main thread) is what
	// carries MHiYH's real answer, once per op. Pass the deck's own
	// fdMhiyhResult push there and a phone-made change repaints the in-game
	// pane exactly like a click in it would.
	//
	// Consumes the sidecar either way — a file we cannot apply must not be
	// retried forever.
	bool ApplyPortal(const std::filesystem::path& deckViewDir, const std::string& foStateJson,
		Done done = nullptr);
}
