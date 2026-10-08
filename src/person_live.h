#pragma once

#include <functional>
#include <string>

namespace RE
{
	class Actor;
}

/*
 * PersonLive — the person page's LIVE view (2026-10-03).
 *
 * Rober, comparing our baked Mirror with SeverActions' live mannequin: "look at
 * their codes, it was a cooler full body … like not a side view of character".
 * SeverActions draws the actor's live skinned 3D with its own D3D renderer into a
 * MagelightUI texture — closed source, and PrismaUI cannot show a texture. What we
 * CAN do is let the game itself draw her: the deck hides, the free camera is
 * posed in front of the actor at a full-body distance, the portrait fill lights
 * ride the camera, and the page drags to orbit. That is her real look — the live
 * body shape with every morph, hair, skin, the load order's lighting — and it is
 * the very picture the game renders, so nothing has to be re-implemented.
 *
 * Built only from play-proven pieces: PhotoCamera::Lease (the free-camera lease
 * portrait capture uses), PhotoLighting's portrait fill, and the deck's own
 * non-pausing focus (smooth pause: sgtm ~0, render loop live) — a classic menu
 * pause stops the camera update, so the live view borrows smooth pause for its
 * duration and hands the palette back its own mode on exit.
 *
 * MAIN THREAD ONLY. Every exit path (Stop, palette close, force-close, a load)
 * restores the camera, the player's visibility, the lights and the focus mode.
 */
namespace PersonLive
{
	// main.cpp hands in how to switch the palette to a non-pausing focus with the
	// world frozen, and how to give it back its own pause mode afterwards.
	void SetFocusHooks(std::function<void()> enterLiveFocus, std::function<void()> restoreFocus);

	// {"ok":bool,"why"?,"name","yaw","zoom"} — refuses honestly when the actor is
	// not loaded nearby, another camera mod owns the free camera, or a photo
	// session holds the lights.
	std::string Start(RE::Actor* actor);

	// Turn by dyaw degrees, scale the distance by dzoom (1 = unchanged), or reset
	// to the full-body front view. Returns the same shape as Start.
	std::string Orbit(float dyawDeg, float dzoom, bool reset);

	// Idempotent. `why` is for the log.
	void Stop(const char* why);

	bool Active();
}
