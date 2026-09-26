#pragma once

#include <string>

/*
 * SkyUI (Papyrus) MCM browser — the OTHER half of the mod-settings popout.
 *
 * Rober, 2026-09-14: "figure out the MCMs how to hook to them?" → "ok grab it".
 *
 * mcm_settings.cpp reads MCM HELPER mods, which ship an enumerable
 * `config.json`. The three curse overhauls this was asked for — Sacrosanct,
 * Growl, Undeath — are Enai/classic mods with a **SkyUI** MCM, which ships no
 * such file: the menu is built at runtime by Papyrus code. So they were absent
 * from the popout, and the Nightside lanes' hand-curated switch tables were the
 * only way to reach them.
 *
 * ── The hook: drive SkyUI's own config script ────────────────────────────
 * Every SkyUI MCM extends `SKI_ConfigBase`, and that script already contains
 * the whole machine SkyUI's Flash UI drives. We drive the same machine from
 * C++ through the Papyrus VM, which is why this needs no cooperation from the
 * mod and works for every SkyUI MCM in the load order rather than a curated
 * list. Verified against the real `SKI_ConfigBase.psc` on the rig, 2026-09-14.
 *
 *   OpenConfig()                 allocates the 128-slot option buffers (they
 *                                are `new int[1]` while closed — scanning
 *                                without this reads an empty menu) and calls
 *                                the mod's OnConfigOpen().
 *   Pages                        public `string[]` property — the page names.
 *   SetPage(name, i)             runs the MOD's own OnPageReset(), which fills
 *                                _optionFlagsBuf / _textBuf / _strValueBuf /
 *                                _numValueBuf. Then WriteOptionBuffers() pushes
 *                                them at the Journal Menu — a no-op with the
 *                                menu closed, which is exactly our case.
 *   <read the four buffers>      label, type, flags and live value per option.
 *   RequestSliderDialogData(i)   fills _sliderParams = {start, default, min,
 *                                max, interval} — a slider's real range.
 *   HighlightOption(i)           fills _infoText — the option's help line.
 *   CloseConfig()                frees the buffers again.
 *
 * Writes go through SkyUI's own dispatch helpers rather than the OnOption*
 * events directly, which matters: `SelectOption` / `SetSliderValue` /
 * `ResetOption` each check `_stateOptionMap` and route state-based options
 * (AddToggleOptionST and friends) into their script STATE before calling
 * OnSelectST / OnSliderAcceptST / OnDefaultST, while plain options get the
 * composed option id and OnOptionSelect. Hand-rolling either branch would work
 * on roughly half this load order and silently do nothing on the rest:
 * tools/probe_skyui_mcms.py counted **58 ST-style, 145 plain and 42 that use
 * both** across 181 SkyUI MCMs here (2026-09-14). Letting SkyUI choose is what
 * makes the branch its problem instead of ours. ⚠ An earlier draft of this
 * comment asserted "Enai's are ST-style" — they are not; Sacrosanct, Growl and
 * Undeath are all plain. The conclusion held for the other reason.
 *
 * Going through the mod's own handler is also what makes this BETTER than the
 * globals route the Nightside lanes use: a handler that does extra work on
 * change (re-applying a perk, refreshing an ability) actually runs.
 *
 * ⚠ THE HAZARD, and it is common rather than exotic: a mod may call
 * `ShowMessage`, which parks its script in `while (_waitForMessage)
 * WaitMenuMode(0.1)` until a Flash dialog answers — and with the MCM closed
 * nothing ever will, so the stack would hang for the rest of the session. 86
 * of those 181 MCMs can reach one (NFF, OStim, SmoothCam, SoS, Fertility Mode,
 * iEquip, Follower Organizer…). `ReleaseBlockedMessage` detects the parked
 * state on a timeout and clears the flag exactly as the mod's own
 * OnMessageDialogClose would, leaving `_messageResult` false so the mod reads
 * it as "cancelled" and does nothing. The caller then says so in words.
 *
 * ── The honest split — what each option type can do ──────────────────────
 *   toggle   read + write (SelectOption toggles it) + reset
 *   slider   read with real min/max/interval + write (SetSliderValue) + reset
 *   text     read + press (these are usually buttons) + reset
 *   menu     read + RESET ONLY. ⚠ The choice list is never stored: the mod
 *            hands it straight to the Flash UI via
 *            `UI.InvokeStringA(... setMenuDialogOptions ...)` inside
 *            OnOptionMenuOpen, and with the Journal Menu closed that call is a
 *            no-op and the list is gone. We can read the CURRENT value and the
 *            start/default index, so the row shows its value and offers Reset,
 *            and says plainly that picking a different entry needs the real
 *            MCM. Stepping the index blind would be guessing at what the
 *            entries even are.
 *   keymap   read only — the Keys tab owns rebinding, and it already sweeps
 *            these configs. A second rebinder would be a second truth.
 *   colour   read only (rare; the deck has no colour picker to offer).
 *   header   display only.
 *
 * ── Threading, and the cost ──────────────────────────────────────────────
 * Every one of the calls above is a Papyrus dispatch: async, answered on the VM
 * thread. `List()` only reads script variables and is cheap. `Scan()` is a
 * SEQUENTIAL chain — each call mutates shared state on the config object, so
 * they cannot be windowed the way keys_scan.cpp windows its 263 independent
 * GetCustomControl calls — and costs roughly (pages + 2 × options) round trips.
 * That is why a scan is **per mod, on demand** when the popout opens one,
 * never all ~49 configs at once. Scan/Set therefore run on a WORKER thread and
 * block on a condition variable; calling them on the main thread would deadlock
 * against the VM. List() is main-thread.
 *
 * ⚠ OpenConfig/CloseConfig call the mod's OnConfigOpen/OnConfigClose. That is
 * the same pair SkyUI fires when the player opens the menu for real, so mods
 * are built to tolerate it — but it IS a side effect, so a scan is never
 * speculative: it happens only when the reader asks for that mod.
 */
namespace SkyuiMcm
{
	// {"ok":bool,"why":"...","mods":[{"id":"<papyrus class>","name":"<display>"}]}
	// Cheap: reads SKI_ConfigManager's _modConfigs/_modNames arrays. Main thread.
	std::string ListJson();

	// {"id":"<papyrus class>"} ->
	// {"ok","id","name","why","pages":[{"name","rows":[
	//    {"i",      option index within the page (0-127, SkyUI's own)
	//     "p",      page index
	//     "label","type","value","text","info","st":bool,
	//     "writable":bool,"why":"...","resettable":bool,
	//     "min","max","step"}]}]}
	// WORKER THREAD ONLY — blocks on Papyrus round trips.
	std::string ScanJson(const std::string& req);

	// {"id","p","i","act":"toggle"|"slider"|"press"|"reset","value":num}
	//   -> {ok,msg,rows:[...]}   (the page re-read after the write, so the view
	//                             shows what the mod actually did rather than
	//                             what we asked for — a handler is free to
	//                             clamp, refuse, or change three other rows)
	// WORKER THREAD ONLY.
	std::string SetJson(const std::string& req);
}
