#pragma once

// Journal tab — the in-game book you write yourself (Rober, 2026-08-16: "the
// journal … ability to on web-server edit your journal, upload transparent
// background images, new text options (that look like fantasy pen writing) make
// it look like an actual medieval journal … and drag your images wherever you
// want in the pages, over text, wrap text etc").
//
// This module owns NOTHING about how a page LOOKS — the view does all of that.
// It owns the three things a view cannot do for itself:
//
//   1. DURABLE STORAGE. The whole journal lives in its own sidecar,
//      Data/SKSE/Plugins/HotkeyDeck/journal.json — deliberately NOT a
//      hotkeys.json slice. Two reasons, both scars: OnJsSave replaces g_config
//      wholesale, so any slice the view does not round-trip is eaten (the
//      charsheet/suppressedSeeds incidents), and a journal is user PROSE — it
//      must not share a file with machine-managed config that is rewritten on
//      every tab switch. Sidecar precedent: item-explorer.json, anim-user.json.
//
//   2. THE MERGE. The Deck Portal edits the SAME file from the phone while the
//      game may be running, so a save is never a blind overwrite: Save() re-reads
//      what is on disk, merges per PAGE by updatedAt (union of ids, tombstones in
//      `trash` honoured), and writes the result. Both sides can therefore write
//      without a queue file, and neither can silently eat the other's paragraph.
//      That is why Save() answers with the MERGED document — the view reconciles
//      onto what actually landed, rather than trusting what it sent.
//
//   3. THE PICTURE POOL. Images live in <deck view>/journal-images/ (the exact
//      domain-images convention: the portal writes real files into the mod's
//      view folder, MO2's VFS passes new files in a mounted mod dir straight
//      through, and the view loads them by relative path). On top of that, a
//      real-path INBOX — Desktop\SkyManager Journal Images by default, overridable
//      with SkyManager.ini [Journal] sImageDir — is swept into the pool on every
//      open, so dropping a PNG in from Windows Explorer works the way the Spell
//      Deck's icon drop-folder already does.
//
// THREADING: pure filesystem + json. It touches no engine structure at all, so
// it is safe anywhere; main.cpp still calls it from SKSE tasks so its replies
// stay ordered with every other push to the view.
//
// Bridge (registered in main.cpp): requests jrOpen/jrSave/jrImages/jrDropImage;
// replies jrData/jrSaved/jrImagesData/jrDropped — one name per direction, per
// the deck law.

#include <filesystem>
#include <string>

namespace Journal
{
	// Where the pictures live: <deck view>/journal-images/. Relative (goes
	// through Data\ so MO2's VFS answers), same as DeckViewDir().
	[[nodiscard]] std::filesystem::path ImageDir();

	// The real, NON-virtualised drop folder swept into the pool on every open.
	// Desktop\SkyManager Journal Images unless SkyManager.ini overrides it.
	[[nodiscard]] std::filesystem::path InboxDir();

	// Startup: create journal-images/ and seed an empty journal.json if there is
	// none. Both exist so that MO2's launch-time listing snapshot has already
	// seen them — the portal then only ever EDITS files that are already there,
	// which is the same law EnsurePortraitBridge() follows for its queue.
	void EnsureSeeded();

	// {ok, doc, images:[{f,mt,sz}], swept, dir, inbox} — the whole journal as it
	// is on disk RIGHT NOW (re-read every time; the phone may have written it),
	// plus the picture pool after sweeping the inbox.
	[[nodiscard]] std::string OpenJson();

	// {doc:{...}} -> {ok, doc, merged} — merge-then-write, see (2) above. The
	// answer carries the merged document; `merged` is true when the disk copy
	// contributed something the caller did not send (i.e. the phone had edited
	// it), which the view surfaces as an honest "your phone's edits merged in".
	[[nodiscard]] std::string Save(const std::string& req);

	// {sweep?:bool} -> {ok, images:[{f,mt,sz}], swept}. The pane polls this after
	// an upload so a picture added from the phone appears without a tab bounce.
	[[nodiscard]] std::string ImagesJson(const std::string& req);

	// {f:"name.png"} -> {ok, msg, images:[...]} — delete one picture from the
	// pool (and from the inbox copy, so the sweep cannot resurrect it). A file
	// the renderer holds open is reported honestly, never silently failed.
	[[nodiscard]] std::string DropImage(const std::string& req);
}
