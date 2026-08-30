#pragma once

#include <cstdint>
#include <string>

#include <json.hpp>

// ---------------------------------------------------------------------------
// 🌿 Pubes — OPubes NG integration for the ✨ Effects modal (fx* bridge).
//
// THE ASK (Rober, 2026-08-17): "effects tab in skymanager — new detection
// based tab probes and control (with visuals? renderings?) of the picker that
// you can apply to an npc and it saves". The renderings are previews of the
// pubic hair itself, so you pick by LOOKING rather than by reading a filename.
//
// WHY THIS EXISTS AT ALL
// ----------------------
// OPubes NG (Nexus, "OPubes.esp") distributes pubic hair to NPCs, but only two
// ways: RANDOMLY, weighted by race/faction/chance, when a body is undressed;
// or by a cycle hotkey that rolls again. There is NO way to say "give HER this
// specific style". That gap is the whole feature — the deck lists every style
// the load order actually has, shows what each one looks like, and puts the
// one you picked on the person the quick card is about.
//
// HOW IT APPLIES — the mod's own machinery, per the effects_actions law
// --------------------------------------------------------------------
// OPubesNGScript exposes
//     ChangeActorPubes(Actor Act, String PubesTexture, Bool IgnorePlayer)
// which removes whatever is on, then applies `PubesTexture` through NiOverride
// (empty body overlay slot, texture + tint + alpha node overrides), colours it
// from her hair colour, and records both the "has pubes" flag and the slot it
// used in StorageUtil. We call THAT, with an explicit texture, rather than
// re-implementing six NiOverride calls: OPubes then owns persistence, the
// re-apply on load, and the honest teardown — exactly as the Skin oil effect
// drives Oily Skin's own ability spell. `IgnorePlayer=false` so the same tab
// works on the player.
//
// Clearing routes through UpdateActorPubes(Act, "Shaved"), which is OPubes'
// own remove path (restores default.dds, drops the six overrides, clears the
// flag) rather than a bare override strip that would leave its bookkeeping
// out of step.
//
// DETECTION — what the load order ACTUALLY has, not what a table says
// ------------------------------------------------------------------
// OPubes' catalogue is data, not code: every pack drops a JSON under
//     Data/meshes/opubes/*.json          (female)
//     Data/meshes/opubes/male/*.json     (male)
// mapping a texture path to a type ("normal" | "stylish" | "hairy"). We read
// the same files through the MO2 VFS, so a pack installed later appears with
// no code change — the anim-scan precedent.
//
// ⚠ We replicate one OPubes quirk deliberately: its parser abandons the WHOLE
// pack at the first texture whose file is missing (`j = l2`), treating that as
// "this pack isn't installed". Offering styles OPubes would refuse to use
// would be a lie, so a pack that fails that test is reported as skipped, WITH
// the missing file named. On this rig that is not hypothetical — see the
// `packs` array: two of the three shipped packs are dead (the male variants
// and the ats321s textures were never installed), which is exactly the kind of
// thing the tab exists to surface.
//
// THE PREVIEWS
// ------------
// Each style is a body-overlay DDS: a 4096x4096 BC3 texture that is almost
// entirely transparent, with the hair occupying roughly 9% of the width low in
// the UV layout (measured, 2026-08-17). So a thumbnail is:
//   decode a MIP (icon_bridge_core's DecodeDds preferMaxDim — mip 0 would be
//   67 MB of transient RGBA per texture for a 192 px tile) -> find the alpha
//   bounding box -> crop to it -> composite over a skin tone, because the art
//   is dark hair on transparent and would be invisible on the deck's dark
//   panel -> box-downscale -> PNG.
// Output lands in the mod folder (never MO2's Overwrite):
//     PrismaUI/views/HotkeyDeck/icons/pubes/<key>.png
// Render-once-keep-forever, with a generation stamp so a change to the baking
// math re-bakes rather than leaving stale tiles — the item_icons rule.
//
// THREADING. Init/Rescan do file IO and pixel work on a detached background
// thread and touch NO engine object. Apply/Clear run Papyrus and MUST be on
// the main thread — the fx* bridge handlers already AddTask us there.
// ---------------------------------------------------------------------------
namespace PubesActions
{
	// The `pubes` block EffectsActions::StateJson rides on fxState:
	//   { present, available, reason?, scanning, sex, styles:[...],
	//     packs:[{ name, sex, count, ok, reason? }], current, currentName,
	//     counts:{ normal, stylish, hairy } }
	// `present`   = OPubes.esp is in the load order (no OPubes -> no tab)
	// `available` = present AND at least one style survived detection
	// `scanning`  = the first catalogue scan is still running; the view shows a
	//               skeleton and repaints when the next fxState lands
	// `current`   = the style key this deck last applied to this actor, or null
	//
	// Safe to call from the main thread at any time; kicks the lazy first scan.
	nlohmann::json PubesJson(std::uint32_t formId);

	// Apply style `key` to the actor. Returns the effects reply shape
	// { ok, msg, id:"pubes:<key>", on:true }. MAIN THREAD.
	std::string Apply(std::uint32_t formId, const std::string& key);

	// OPubes' own "Shaved" path. Returns { ok, msg, id:"pubes:clear", on:false }.
	// MAIN THREAD.
	std::string Clear(std::uint32_t formId);

	// Re-read the catalogue and bake any missing thumbnail — for after a new
	// pack is installed. Returns { ok, msg, id:"pubes:rescan", on:false };
	// refuses if a scan is already running.
	std::string Rescan();
}
