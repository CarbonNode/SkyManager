#pragma once

#include <cstdint>
#include <string>

#include <json.hpp>

namespace RE
{
	class Actor;
}

// 🎨 Skins, natively — SkyManager's own skin-texture provider.
//
// The Effects modal's Skins tab used to have exactly one route: SkinShift's
// INTERNAL functions, called by RVA behind a five-prologue version gate
// (skinshift_actions.cpp). That works only for one exact SkinShift build and
// tells us nothing about what it actually did — the 2026-08-15 play-test came
// back "all three presets look the same, and a dark elf turned yellow".
//
// This module is the replacement, and it asks nobody's permission to exist:
// RaceMenu (skee64.dll) publishes a PUBLIC interface map over SKSE messaging
// — dispatch `kExchangeInterface` to "skee", then QueryInterface("Override")
// — and that interface is what every skin-swapping mod in the ecosystem is
// really standing on. We drive it directly:
//
//   * body / hands / feet -> AddSkinOverride  (per biped slot mask)
//   * the facegen head    -> AddNodeOverride  (per live geometry node name)
//   * key = 9 (shader texture property), index = the BSTextureSet slot
//     (0 diffuse, 1 normal, 2 subsurface, 7 specular)
//
// Two routes exist because RaceMenu's Override interface version varies by
// build: version 2 exposes the native vtable (synchronous, exact), versions
// 0 and 1 do not — there the same operations are reached through NiOverride's
// Papyrus natives, which are stable across every RaceMenu that has ever
// shipped. Both are implemented; the route is logged once, and an interface
// version we have not audited stands down instead of guessing at a vtable.
//
// Technique, route table and the ownership rule are adopted from Body Change
// NG (compilecraftworks, GPL-3.0) — see THIRD-PARTY-NOTICES.md §5.
//
// EVERYTHING here must run on the game main thread (the fx* bridge handlers
// in main.cpp already AddTask us there): it reads the live scenegraph and
// talks to the VM.
namespace SkinActions
{
	// RaceMenu's Override interface was obtained AND its version resolved to a
	// route we implement. On false, *whyNot carries the honest reason for the
	// view ("RaceMenu (skee64) isn't loaded" / "…interface version N…").
	// Cheap after the first call — the handshake result is cached.
	bool Available(std::string* whyNot = nullptr);

	// The `skins` block EffectsActions::StateJson rides on fxState. Shape:
	//   { present, available, reason?, provider:"skymanager", idPrefix:"skin:",
	//     route, roots:[{path, packs}], current, currentName, unknown:false,
	//     presets:[{ key, name, files, race, sex, parts:[…], layout }],
	//     live:{…} }
	// `presets` is deliberately the SAME key the SkinShift block used, so the
	// view's Skins tab renders either provider; `idPrefix` is what tells it
	// which id family to send back.
	nlohmann::json SkinsJson(std::uint32_t formId);

	// Apply catalogue row `key` to the actor. Returns the effects reply shape
	// { ok, msg, id:"skin:<key>", on:true }.
	std::string Apply(std::uint32_t formId, const std::string& key);

	// Drop every override this module owns on that actor (identified by our
	// own texture namespace, never by guesswork) and refresh her 3D.
	// { ok, msg, id:"skin:clear", on:false }.
	std::string Clear(std::uint32_t formId);

	// Re-read the pack roots from disk. { ok, msg, id:"skin:rescan", on:true }.
	std::string Rescan();
}
