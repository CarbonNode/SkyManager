#pragma once

#include <cstdint>
#include <functional>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

// Portrait capture — "look at someone, fire it, their face is a portrait".
//
// WHY THIS EXISTS: filling 69 follower portraits by hand means a screenshot, a
// crop in an image editor, a rename to the right slug and an upload, per person.
// This does the whole thing in one action.
//
// WHY NOT THE SCREENSHOT KEY: this rig's vanilla screenshot path is broken
// (sScreenShotBaseName points at a different install's drive) and ENB has taken
// the screenshot key over in BMP. Building on either would mean depending on
// config that is already wrong, or silently rewriting the player's ENB settings.
// So we take the frame ourselves, straight off the D3D11 back buffer, and crop
// it in-process. No INI, no ENB, no key, no output folder to guess at, and no
// race with a file appearing on disk.
//
// HOW THE CROP IS FOUND: the actor's head NODE is projected to screen space with
// NiCamera::WorldPtToScreenPt3 — the same maths the game uses to place things on
// screen. A second point one head-radius above it gives the on-screen size, so
// the box tracks the face whether you are standing on top of them or across a
// room. No face detection, no fixed rectangle, no "stand exactly here".
//
// HOW IT STAYS A HEADSHOT: the zoom is solved per capture rather than fixed. A
// flat fov only frames at one distance — at fov 40 a subject 80 units away
// projected a head 1055 px across into a 900 px crop (it cut into the skull),
// while one 400 units away gave a 400 px crop that then had to be stretched.
// So: measure the projected head, then pick the fov that makes it the size we
// want, clamped to [15, the player's own fov]. Head size in frame is constant
// at ~53% at every range. The crop is re-measured AFTER the zoom lands, so a
// mis-solve still produces a correctly centred portrait.
//
// WHERE IT LANDS: <deck view>/portraits/<slug>.png, where slug is the same rule
// followers-pane.js and the portal use (lowercase, non-alphanumerics to '-').
// The plugin writing it is the POINT: MO2 composes its virtual file system at
// launch, so a file an outside process drops into the mod folder mid-session is
// invisible to the running game. Our own write is hooked by the VFS and lands in
// overwrite, where the deck can load it immediately.
//
// RE-CAPTURE AND THE LOCK: PrismaUI/Ultralight memory-maps every image it draws
// and keeps that mapping for the session — proven on the rig 2026-07-31, where
// Skyrim itself held the handle on portraits\amaniri.png and every re-capture
// died with "could not write the file" while the FIRST capture of the same NPC
// had worked fine. Windows will not let anyone truncate a mapped file, so a
// portrait the deck has already SHOWN can never be overwritten in place. When
// that happens the capture lands as `<slug>~<unix seconds>.png` instead; the
// scanner treats every `<slug>~<anything>` as belonging to `<slug>` and the
// NEWEST file wins. Nothing has to be closed, and nothing is lost.
namespace PortraitCapture
{
	// Portrait file stem -> follower slug. `<slug>~<version>` collapses to
	// `<slug>`; a plain `<slug>` is returned unchanged. Lowercases, because
	// Windows filenames are case-insensitive but the pane's map keys are not.
	//
	// Lives here rather than in main.cpp so the WRITER and the SCANNER share one
	// definition of the versioning rule — the two drifting apart would strand a
	// captured portrait under a slug no follower matches.
	std::string SlugFromFileStem(std::string_view stem);

	// Name -> slug (lowercase, every run of non-alphanumerics to one '-'). The
	// same rule followers-pane.js and portal/server.js implement; exported so a
	// caller needing a filename for an outfit does not grow a second copy.
	std::string SlugOfName(std::string_view name);

	// ---- framing, for the deck's in-game adjust panel -----------------------
	// The knobs have always been in capture.ini and always applied on the NEXT
	// capture; these just make them reachable without alt-tabbing to a text
	// editor. Face framing only: the wardrobe photo has its own key set and its
	// own natural framing, and one control editing both is what made tuning a
	// face break outfit shots in the first place.
	struct Framing
	{
		float zoom = 0.60f;
		float offsetX = 0.0f;
		float offsetY = -0.06f;
	};

	Framing GetFraming(const std::filesystem::path& dir);

	// Values are clamped to the same range ReadTuning accepts, so a bad number
	// from the view cannot produce a zero-size or off-screen crop.
	bool SetFraming(const std::filesystem::path& dir, const Framing& f);

	// The shipped defaults, so "Reset" means one thing in both the C++ and the
	// view rather than two constants that can drift.
	Framing DefaultFraming();

	// Write encoded image bytes as a portrait, reusing the capture's lock-safe
	// versioned fallback. Used by the Deck Portal's live bridge: the portal hands
	// over the BYTES and the plugin does the write, because a file the portal
	// creates itself is invisible to the running game (MO2 snapshots the
	// directory listing at launch).
	bool WritePortraitBytes(const std::filesystem::path& dir, const std::string& slug,
		const std::string& ext, const std::vector<std::uint8_t>& bytes);

	// Fire the "portrait" action against the actor NpcActions snapshotted at
	// palette-open. Returns immediately: the palette has to be gone and the HUD
	// hidden before the frame is worth grabbing, so the work is deferred a few
	// frames and then run on the main thread. Player feedback is a notification
	// either way — this never fails silently.
	//
	// `portraitDir` is the deck view's portraits\ folder — passed in rather than
	// recomputed here so there is exactly ONE definition of where portraits
	// live (main.cpp's DeckViewDir()), and the listing and the writer cannot
	// drift apart.
	// `targetFormId` 0 = photograph whoever the crosshair snapshot caught at
	// palette open (the CHIM tab's "Capture Portrait" action). The Followers tab
	// passes a specific follower's form id instead, so you can photograph the
	// person you clicked rather than whatever you are looking at — they still
	// have to be loaded and on screen, and you get a friendly message if not.
	void Fire(const std::filesystem::path& portraitDir, std::uint32_t targetFormId = 0);

	// True for the action verbs this module owns.
	bool IsAction(const std::string& action);

	// ------------------------------------------------------------ photo mode
	// The wardrobe's "photograph this outfit": dress up, then hand the camera to
	// the player so THEY pick the angle, because the subject of the picture is
	// the clothes. Fire() cannot serve this — it shoots a second after the key,
	// from wherever you happened to be.
	//
	// Turns on: menus hidden, fov 60, free camera with time frozen. All of it is
	// restored on every exit — shoot, cancel, or the 5-minute timeout — because
	// a photo mode you cannot leave looks exactly like a hung game.
	void StartPhotoMode(const std::filesystem::path& dir, const std::string& slug, const std::string& label);

	// Ask on every input event: also enforces the timeout, so no separate timer
	// can stop running and strand the player in a frozen world.
	bool PhotoModeActive();

	void PhotoShootNow();
	void PhotoCancel();

	// Called after a successful photo with (slug, filename) so the caller can
	// tell the view which image to hang on the outfit. Keeps this module free of
	// any knowledge that a UI exists.
	// (slug, saved filename, outfit LABEL). The label rides along because the
	// consumer must be able to attach the image to the outfit's config row
	// C++-SIDE: the palette is always closed during photo mode, so a push to
	// the view is dropped and a view-side attach never runs (the 2026-08-02
	// "took a picture and it shows nowhere" bug).
	void SetPhotoSavedCallback(std::function<void(const std::string&, const std::string&, const std::string&)> cb);

	// Called on EVERY exit from photo mode — shot, cancel, Esc, timeout,
	// watchdog — after the camera, fov and menus are back. Scene staging hangs
	// off this rather than off the saved callback, because a cancelled photo
	// must put the world back exactly like a taken one.
	void SetPhotoEndedCallback(std::function<void()> cb);

	// ---- photo-mode exposure (capture.ini `photoexposure`, in stops) --------
	// 0 = the frame exactly as it was rendered, which is the default. This is a
	// deliberate knob, not a return of the automatic tone mapping that was tried
	// and reverted: a place photographed at midnight is genuinely dark, and the
	// only honest fix is either to change the light (SceneStage) or to say how
	// much lift you want.
	float ExposureMax();
	float GetPhotoExposure(const std::filesystem::path& dir);
	bool  SetPhotoExposure(const std::filesystem::path& dir, float stops);
}
