#pragma once

#include <functional>
#include <string>

/*
 * ItemIcons — real pictures of armour pieces, rendered by the GAME.
 *
 * The Wardrobe tab's inventory and outfit-piece lists showed a "+" glyph per
 * item; Rober wants the actual armour there. Mesh Rendering Framework (Nexus
 * 169708) renders a NIF out of the running game into an offscreen target and
 * writes a PNG; each armour's GROUND model (TESBipedModelForm::worldModels —
 * exactly what an inventory icon should show) becomes
 *
 *     Data\PrismaUI\views\HotkeyDeck\icons\items\<pluginSlug>-<localIdHex>.png
 *
 * This is a straight port of the hardened core of Dragon Roost's
 * portraits.cpp (modding/dragon-roost/src/portraits.cpp), which is the proven
 * MRF integration on this rig — same soft binding, same IMesh ABI mirror +
 * layout probe, same SEH guards, same deferred-save handshake (we NEVER call
 * IMesh_Save: it dereferences a null SRV on a fresh mesh; we arm
 * savePath/saveNextFrame/mustUpdate and let their render loop write), same
 * queue with a small in-flight budget and a timeout, same render-once-keep-
 * forever rule. Only the dragon-specific machinery (live actors, texture
 * swaps, turntables) is dropped: an item icon is the bare-NIF route only.
 *
 * Everything here is MAIN THREAD ONLY except where noted.
 */
namespace ItemIcons
{
	// Bind (or note the absence of) MeshRenderingFramework.dll. Call once at
	// kDataLoaded. Missing framework = every call no-ops; the views keep their
	// glyphs — a supported setup, not an error.
	void Init();

	bool Available();

	// Read the deck's own exports (wardrobe-inventory.json + the named
	// wardrobe-catalogue.json) and queue a render for every armour that has no
	// icon on disk yet. Starts a background watcher that pumps the queue until
	// it drains, then invokes the callback set below (on the main thread) so
	// the view can be handed the fresh index. Safe to call repeatedly — a
	// piece is never rendered twice, and a second call while a batch is
	// running just tops the queue up. MAIN THREAD ONLY.
	void EnsureIcons();

	// Queue renders for one actor's WORN set — hand it the fdWorn reply JSON
	// verbatim ({items:[{formId,plugin,name},…]}). Called from the equipped
	// read so the F7 quick card's gear tiles get real pictures: those items
	// are the NPC's own and almost never appear in the two wardrobe exports
	// EnsureIcons walks. Same rules (render once, keep forever), and it also
	// registers already-on-disk worn keys so IndexJson() names them on a
	// session where the Wardrobe tab never opened. Covers weapons and torches,
	// not just armour. MAIN THREAD ONLY.
	void EnsureIconsForWorn(const std::string& wornReplyJson);

	// The same thing, honestly named, for any caller with a list of items that
	// is not a worn set — the Wheel Menu asks for renders of whatever is
	// actually pinned to a wheel. Identical payload ({items:[{formId,plugin,
	// name},…]}) and identical rules; EnsureIconsForWorn now forwards here, so
	// there is ONE implementation rather than two that drift.
	void EnsureIconsForList(const std::string& itemsJson);

	// Queue the turntable for ONE piece — the 7 non-zero angle frames (45°
	// apart, spun about Z), rendered on demand when the lightbox for that item
	// is opened. Frame 0 is the ordinary icon and is never touched. The angle
	// frames land as <file>-a045.png … -a315.png siblings, which the view's
	// spin lightbox derives from the frame-0 URL and probes for directly (no
	// index entry — see IndexJson's '@' skip). Never bulk: 8× a full inventory
	// would be hours. MAIN THREAD ONLY.
	void CaptureAngles(const std::string& fid, const std::string& plugin);

	// NPC FACES (2026-08-13, the NPC Finder). Same payload shape
	// ({items:[{formId,plugin,name},…]}), but formId+plugin are the FACE
	// OWNER's identity (8-hex local id) and the NIF is not derived from the
	// form at all: it IS the baked FaceGen head every non-templated NPC ships,
	//     meshes/actors/character/facegendata/facegeom/<plugin>/<hex8>.nif
	// (hair, brows, eyes and the baked tint texture are all inside it — see
	// the 2026-08-13 strings dump of Lydia's). Renders land in icons/npcs/,
	// keyed apart from item icons by the "@face" asked-key suffix so
	// IndexJson() never sees them (it skips '@'). A face NIF that does not
	// exist (templated NPC) is probed via BSResource BEFORE queueing — the
	// framework never burns a mesh on it, and the key is marked so it is
	// never re-probed this session. MAIN THREAD ONLY.
	void EnsureFaceIcons(const std::string& itemsJson);

	// {"version":1,"icons":{"HEX8|plugin.esp":"icons/npcs/<file>.png",…}} —
	// face renders on disk, keys normalised exactly like IndexJson's
	// (UPPERCASE hex | lowercase plugin). Safe from any thread.
	std::string FaceIndexJson();

	// {"version":1,"icons":{"0XABCD|plugin.esp":"icons/items/<file>.png",…}}
	// — the on-disk truth right now. Keys are UPPERCASE local-hex + '|' +
	// lowercase plugin, the same normalisation the portal uses everywhere.
	// Safe from any thread (directory read only).
	std::string IndexJson();

	// Invoked on the MAIN THREAD each time a render batch finishes (and once
	// at Init if icons already exist), so main.cpp can push the index into the
	// view. Set it once during startup.
	void SetOnBatchDone(std::function<void()> cb);
}
