#pragma once

#include <cstddef>
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
	//
	// Also stamps a render GENERATION for the facegen-derived caches (faces +
	// creature bodies) keyed on the bound MRF DLL's identity plus a manual
	// epoch. When that token changes — a new MRF build, or the epoch bumped
	// after a rendering fix — the icons/npcs and icons/mounts dirs are purged
	// ONCE so those renders re-bake through the new framework. Item renders
	// (icons/items) carry their OWN generation, keyed on a manual epoch alone
	// (their framing is our math, not the framework's), so a look-affecting
	// change to item rendering — e.g. the 2026-08-14 clutter-fill framing —
	// purges the PLAIN item renders once while keeping the good old "-s2" swap
	// renders. This is what removes the hand-purge step the "render-once-keep-
	// forever" rule otherwise forces after every rendering change (2026-08-14).
	//
	// Init also seeds an on-disk index of every item render already present, so
	// IndexJson() names icons rendered in a PRIOR session (not just those
	// re-asked this session) — otherwise pack/item tiles fall back to a glyph
	// after a few tab switches even though the PNG exists.
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
	//
	// RETURNS the number of renders ACTUALLY queued — which is NOT the number
	// of items handed in: an NPC with no facegen file (templated, or the file
	// never shipped) is dropped by the BSResource probe and contributes 0. The
	// caller MUST report this count as `queued` to the view, never the input
	// size — reporting the input size is exactly what wedged the followers tab
	// into a permanent "0 resolved, 4 asked" re-ask loop, polling four NPCs
	// whose faces can never render (2026-08-14).
	std::size_t EnsureFaceIcons(const std::string& itemsJson);

	// Render warm-start (2026-08-14, perf item 3). Same {items:[{formId,plugin,
	// name}]} payload and face-owner identity as EnsureFaceIcons, but queued at
	// IDLE priority: Pump() starts these ONLY when the user render queue is empty,
	// so a page the player opens is never delayed. At most `cap` NEW renders are
	// enqueued (the roster is small; the cap is a guard, not a plan). Dedup is
	// identical to every other lane, so an already-rendered or file-less face costs
	// nothing — safe to call on every boot. Used to pre-bake the follower roster's
	// faces after a boot/purge so the first minutes show real faces, not glyphs.
	// RETURNS the number actually queued. MAIN THREAD ONLY.
	std::size_t WarmStartFaces(const std::string& itemsJson, std::size_t cap);

	// {"version":1,"icons":{"HEX8|plugin.esp":"icons/npcs/<file>.png",…}} —
	// face renders on disk, keys normalised exactly like IndexJson's
	// (UPPERCASE hex | lowercase plugin). Safe from any thread.
	std::string FaceIndexJson();

	// NPC BODIES (2026-08-14, the Mounts tab). Same payload shape plus an
	// explicit `nif` per item ({items:[{formId,plugin,name,nif},…]}) — the
	// caller (Mounts::BodyNifOf) resolves the race-skin ARMA biped model, the
	// Dragon Roost route, because deriving it needs the NPC walk this file
	// deliberately knows nothing about. formId+plugin are the NPC BASE's
	// durable identity. Renders land in icons/mounts/, keyed "@body" so no
	// other index ever sees them. MAIN THREAD ONLY.
	//
	// RETURNS the number of renders actually queued (same contract as
	// EnsureFaceIcons: a creature whose body NIF is not in the load order is
	// probed away and contributes 0), so the NPC Finder can poll honestly.
	std::size_t EnsureBodyIcons(const std::string& itemsJson);

	// {"version":1,"icons":{"0X81A|plugin.esp":"icons/mounts/<file>.png",…}}.
	// Safe from any thread.
	std::string BodyIndexJson();

	// The NPC Finder's view merges every icon it receives into ONE map keyed by
	// "0X…|plugin", so it needs faces AND creature bodies in a single reply.
	// This is FaceIndexJson()+BodyIndexJson() folded together; the two never
	// collide because a face key is the FACE OWNER's id and a body key is the
	// creature's own id, and a creature has no face render (nor a humanoid a
	// body one). Faces win on the impossible tie. Safe from any thread.
	std::string NpcIconsJson();

	// "icons/mounts/<file>.png" if this body's render exists, else "".
	std::string BodyPathFor(const std::string& fid, const std::string& plugin);

	// The body turntable: 45°-step frames (7 beyond frame 0 — a mount preview
	// is ONE big image, so it earns a smoother spin than the items' 90°),
	// same -aNNN filename contract, baked lazily when the preview is first
	// dragged. Needs the same nif the frame-0 render used. MAIN THREAD ONLY.
	void CaptureBodyAngles(const std::string& fid, const std::string& plugin,
		const std::string& nif);

	// "icons/npcs/<file>.png" if this face's render already exists, else "".
	// fid/plugin are the FACE OWNER's local id + origin plugin (FaceOwnerOf).
	std::string FacePathFor(const std::string& fid, const std::string& plugin);

	// {"version":1,"icons":{"0XABCD|plugin.esp":"icons/items/<file>.png",…}}
	// — the on-disk truth right now. Keys are UPPERCASE local-hex + '|' +
	// lowercase plugin, the same normalisation the portal uses everywhere.
	// Safe from any thread (directory read only).
	std::string IndexJson();

	// "icons/items/<file>.png" if THIS item's render already exists on disk,
	// else "". The single-item twin of IndexJson()'s per-key resolve — swap
	// ("-s2") preferred over the plain name, exactly as IndexJson does, so the
	// two can never name different files for the same piece. NEVER queues a
	// render (unlike EnsureIconsForList): it is the "paint instantly if we
	// already have it" answer for the F7 quick card's worn tiles, stamped into
	// the fdWorn payload so an already-rendered piece shows its picture on the
	// FIRST paint instead of glyph-then-swap after a wdItemIcons round-trip. A
	// piece with no PNG returns "" and is left for the view's lazy whIcons
	// request. Safe from any thread (directory read only).
	std::string IconPathIfRendered(const std::string& fid, const std::string& plugin);

	// Invoked on the MAIN THREAD each time a render batch finishes (and once
	// at Init if icons already exist), so main.cpp can push the index into the
	// view. Set it once during startup.
	void SetOnBatchDone(std::function<void()> cb);
}
