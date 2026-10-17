#pragma once

#include <cstdint>
#include <string>

// FPS meter + Community Shaders overlay switch (Rober, 2026-10-14):
//   "i always have to toggle on Community shaders fps, lets add this to hud
//    elements that hooks to it so we can control the fps meter. if we could
//    also maybe hook to puredarks so we can show fps engine and fps (frame
//    gen) in ui elements without performance cost and toggable"
//
// TWO jobs, one module.
//
// 1. THE FPS WIDGET (`fps`, a free HUD widget).
//    ENGINE fps is COUNTED: OnFrame() runs inside the deck's existing
//    present-call hook (portrait_capture.cpp HookedPresent, the game's one
//    present per engine frame) and costs one QueryPerformanceCounter plus two
//    relaxed atomics, and nothing at all while the widget is off. Sample()
//    turns the counts into fps, frame time and the window's slowest frame.
//
//    FRAME-GEN fps is READ FROM PUREDARK'S OWN COUNTERS. SkyrimUpscaler.dll
//    exports nothing usable, but the PDPerfPlugin.dll it loads exports
//    `GetFgFrameCounters(FgFrameCountersV2*)`: running totals (framegen
//    frames, source frames, FrameWarp presents, owner). Verified on the rig's
//    build 2026-10-14 by disassembly: the export refuses anything but
//    {size 0x28, version 2}, then only copies four counters out (no lock, no
//    reset), and returns false until frame generation is initialised.
//    SkyrimUpscaler 1.20.15 builds its own menu's "Framegen FPS" from exactly
//    this call (Δ framegenFrames x 1000 / Δms over a >= 500 ms window, and the
//    FrameWarp-presents rate when `owner` is not 0), so the widget shows the
//    number PureDark's menu shows. Reading it cannot disturb anyone: the
//    totals only go up and every reader keeps its own previous values.
//    (Streamline's slDLSSGGetState would ALSO answer, but its counter resets
//    on every read — calling it from here would steal frames from the
//    Upscaler's own reader — and it is documented as not thread safe. Not
//    used, on purpose.)
//    Nothing here changes what the Upscaler or frame generation do (root
//    CLAUDE.md: frame gen and neural rendering stay ON). If the export is
//    missing (another build, FG off, not PureDark), the widget says so.
//
// 2. THE COMMUNITY SHADERS OVERLAY SWITCH. CS's performance overlay (FPS,
//    frame time, VRAM, draw calls) shows only while its global overlay flag,
//    `Menu::overlayVisible`, is set — and that flag starts FALSE every launch
//    and is never saved, which is why it has to be turned on by hand each
//    time. CS exports no API (only its bundled FFX symbols), so the switch
//    presses CS's own OverlayToggleKey, read live from
//    CommunityShaders/SettingsUser.json "Menu" (default F10). CS reads keys
//    from the engine's input events and fires a single-key bind on key-UP, so
//    a SendInput tap works. The on/off state is TRACKED: off at launch (CS's
//    own default), flipped by every key-up of that key the deck's input sink
//    sees — so a press by hand keeps it honest too. Combo binds (Shift+End)
//    fire on key-down in CS; those flip on a seen down with the modifiers held.
//    "Turn on when the game loads" presses it once per launch, a few seconds
//    into the first stretch of unpaused play.
namespace FpsMeter
{
	// Present thread (= the game's main thread on SE). Atomics only.
	void OnFrame();

	// Main.cpp's input sink: every keyboard button event, before any gate.
	void NoteKey(std::uint32_t dik, bool down, bool up);

	// The widget's switch + options, mirrored from Widgets so the present
	// hook and the ticker read them lock-free. Called whenever the widgets
	// config changes (Widgets::RecountAnyLocked).
	void SetConfig(bool widgetOn, int rateMs, bool csAuto);
	bool Wanted();     // widget on: count frames, run the push beat
	int  RateMs();     // push beat, 500..2000

	// Main thread. One sample since the previous call, as the HUD payload for
	// `fpsPush(...)`. Empty = nothing new (same as the last push, or no frames
	// counted yet). `force` re-sends even when unchanged.
	std::string SampleJson(bool force);

	// ---- Community Shaders overlay ----------------------------------------
	bool        CsPresent();    // CommunityShaders.dll loaded
	bool        CsOn();         // tracked overlay state
	// {"present":b,"on":b,"key":"F10","auto":b}
	std::string CsJson();
	// Any thread. CsSet presses CS's overlay key on a detached worker only
	// when the tracked state differs; CsToggle always presses.
	void CsSet(bool on);
	void CsToggle();
	// Ticker (main thread via AddTask): "turn on when the game loads", once
	// per launch. CsAutoPending() is false once done or when the option is off.
	bool CsAutoPending();
	void CsAutoTick();
}
