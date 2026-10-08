#include "person_live.h"

#include <array>
#include <cmath>
#include <string_view>

#include "photo_camera.h"
#include "photo_lighting.h"

#include <algorithm>
#include <cmath>

#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

namespace PersonLive
{
	namespace
	{
		constexpr float kPi        = 3.14159265358979f;
		constexpr float kMaxDist   = 6000.0f;   // further than this she is not "here"
		constexpr float kFitMargin = 1.16f;     // head and feet room
		constexpr float kZoomMin   = 0.35f;     // closest: head and shoulders
		constexpr float kZoomMax   = 1.4f;
		// The deck's info column covers the left of the screen, so the figure is
		// framed right of centre: this fraction of the half-width.
		constexpr float kShift = 0.32f;

		std::function<void()> g_enterFocus, g_restoreFocus;

		PhotoCamera::Lease  g_lease;
		RE::ObjectRefHandle g_actor;
		bool                g_active      = false;
		bool                g_lights      = false;
		bool                g_playerHid   = false;
		bool                g_playerWasCulled = false;
		bool                g_focusSwapped = false;
		// The free camera's rotation pair is (pitch, yaw) or (yaw, pitch) — the
		// header does not say which. Calibrated once per session from the state's
		// own GetRotation, so a wrong guess can never aim the camera at the floor.
		int                 g_yawIndex    = -1;
		float               g_yaw         = 0.0f;   // degrees from her front
		float               g_zoom        = 1.0f;

		bool* FrozenFlag()
		{
			return PhotoCamera::FreezeTimeFlag(RE::Main::GetSingleton(), REL::Module::IsVR());
		}

		RE::FreeCameraState* FreeState()
		{
			auto* cam = RE::PlayerCamera::GetSingleton();
			if (!cam || !cam->IsInFreeCameraMode() || !cam->currentState)
				return nullptr;
			auto* st = cam->currentState.get();
			if (!st || st->id != RE::CameraStates::kFree)
				return nullptr;
			return static_cast<RE::FreeCameraState*>(st);
		}

		// Camera forward (+Y in camera space) for a quaternion.
		RE::NiPoint3 Forward(const RE::NiQuaternion& q)
		{
			// v' = q * (0,1,0) * q^-1
			const float x = q.x, y = q.y, z = q.z, w = q.w;
			return { 2.0f * (x * y - w * z), 1.0f - 2.0f * (x * x + z * z), 2.0f * (y * z + w * x) };
		}

		void SetRotation(RE::FreeCameraState* fs, float pitchRad, float yawRad)
		{
			if (g_yawIndex == 0) { fs->rotation.x = yawRad; fs->rotation.y = pitchRad; }
			else { fs->rotation.x = pitchRad; fs->rotation.y = yawRad; }
		}

		// Decide which component is yaw: write a known heading under each guess and
		// keep the one the state itself reports back as pointing that way.
		void Calibrate(RE::FreeCameraState* fs)
		{
			if (g_yawIndex >= 0)
				return;
			const float probe = 1.0f;   // radians — far from 0 so a pitch reading is obvious
			const RE::NiPoint3 want{ std::sin(probe), std::cos(probe), 0.0f };
			float best = -2.0f;
			int   pick = 1;
			for (int guess = 0; guess < 2; ++guess) {
				g_yawIndex = guess;
				SetRotation(fs, 0.0f, probe);
				RE::NiQuaternion q{};
				fs->GetRotation(q);
				const auto f = Forward(q);
				const float len = std::sqrt(f.x * f.x + f.y * f.y + f.z * f.z);
				const float dot = len > 0.0f ? (f.x * want.x + f.y * want.y + f.z * want.z) / len : -2.0f;
				logger::info("person-live: rotation probe guess={} forward=({:.2f},{:.2f},{:.2f}) dot={:.2f}",
					guess == 0 ? "x=yaw" : "y=yaw", f.x, f.y, f.z, dot);
				if (dot > best) { best = dot; pick = guess; }
			}
			g_yawIndex = pick;
			logger::info("person-live: free-camera yaw is rotation.{} (dot {:.2f})", pick == 0 ? "x" : "y", best);  // marker: person-live-calibrate
		}

		float HFovRad()
		{
			auto* cam = RE::PlayerCamera::GetSingleton();
			float deg = cam ? cam->GetRuntimeData2().worldFOV : 80.0f;
			if (!std::isfinite(deg) || deg < 20.0f || deg > 150.0f)
				deg = 80.0f;
			return deg * kPi / 180.0f;
		}

		float Aspect()
		{
			const auto s = RE::BSGraphics::Renderer::GetScreenSize();
			return (s.width > 0 && s.height > 0) ? static_cast<float>(s.width) / static_cast<float>(s.height) : 16.0f / 9.0f;
		}

		nlohmann::json Pose()
		{
			nlohmann::json out = { { "ok", g_active }, { "yaw", g_yaw }, { "zoom", g_zoom } };
			if (auto ref = g_actor.get())
				out["name"] = ref->GetName() ? ref->GetName() : "";
			return out;
		}

		// Frame her full height, right of centre, facing the camera at g_yaw.
		bool Apply()
		{
			auto  ref = g_actor.get();
			auto* a   = ref ? ref->As<RE::Actor>() : nullptr;
			auto* fs  = FreeState();
			if (!a || !fs)
				return false;
			Calibrate(fs);
			const auto  p       = a->GetPosition();
			float       height  = a->GetHeight();
			if (!std::isfinite(height) || height < 40.0f || height > 600.0f)
				height = 128.0f * a->GetScale();
			const float hfov   = HFovRad();
			const float vfov   = 2.0f * std::atan(std::tan(hfov * 0.5f) / Aspect());
			// Zooming in also climbs toward the face, so "closer" means her face,
			// not her belt.
			const float aimUp  = 0.52f + (1.0f - std::min(g_zoom, 1.0f)) * 0.40f;
			const RE::NiPoint3 target{ p.x, p.y, p.z + height * aimUp };
			const float dist   = (height * 0.5f * kFitMargin) / std::tan(vfov * 0.5f) * g_zoom;
			const float camYaw = a->GetAngleZ() + kPi + g_yaw * kPi / 180.0f;
			const RE::NiPoint3 fwd{ std::sin(camYaw), std::cos(camYaw), 0.0f };
			const RE::NiPoint3 right{ std::cos(camYaw), -std::sin(camYaw), 0.0f };
			const float shift  = dist * std::tan(hfov * 0.5f) * kShift;
			fs->translation = { target.x - fwd.x * dist - right.x * shift,
			                    target.y - fwd.y * dist - right.y * shift,
			                    target.z };
			SetRotation(fs, 0.0f, camYaw);
			if (g_lights)
				SKSE::GetTaskInterface()->AddTask([]() { if (g_active) PhotoLighting::Update(); });
			return true;
		}

		void HidePlayer(bool hide)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* p3d    = player ? player->Get3D(false) : nullptr;
			if (!p3d)
				return;
			if (hide && !g_playerHid) {
				g_playerWasCulled = p3d->GetAppCulled();
				p3d->SetAppCulled(true);
				g_playerHid = true;
			} else if (!hide && g_playerHid) {
				p3d->SetAppCulled(g_playerWasCulled);
				g_playerHid = false;
			}
		}

		std::string Refuse(const std::string& why)
		{
			logger::info("person-live: refused - {}", why);
			return nlohmann::json{ { "ok", false }, { "why", why } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
	}

	void SetFocusHooks(std::function<void()> enterLiveFocus, std::function<void()> restoreFocus)
	{
		g_enterFocus   = std::move(enterLiveFocus);
		g_restoreFocus = std::move(restoreFocus);
	}

	bool Active() { return g_active; }

	std::string Start(RE::Actor* actor)
	{
		if (g_active)
			Stop("restart");
		if (!actor)
			return Refuse("she is not loaded right now - the live view needs her nearby");
		if (!actor->Is3DLoaded() || !actor->Get3D(false))
			return Refuse("she is not loaded nearby (no 3D) - the live view needs her in the same area");
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (player && player->GetPosition().GetDistance(actor->GetPosition()) > kMaxDist)
			return Refuse("she is too far away for the live view - go to her, or use the Mirror");
		auto* cam = RE::PlayerCamera::GetSingleton();
		if (!cam)
			return Refuse("the game camera is not available");
		if (cam->IsInFreeCameraMode())
			return Refuse("the free camera is already in use (tfc or a camera mod) - leave it first");
		if (PhotoLighting::PortraitActive())
			return Refuse("a portrait capture is using the lights - finish it first");

		g_actor = actor->GetHandle();
		g_yaw   = 0.0f;
		g_zoom  = 1.0f;
		// Non-pausing focus first: a menu pause stops the camera update loop.
		if (g_enterFocus) {
			g_enterFocus();
			g_focusSwapped = true;
		}
		if (!g_lease.Enter(cam, FrozenFlag(), false)) {
			if (g_focusSwapped && g_restoreFocus) g_restoreFocus();
			g_focusSwapped = false;
			g_actor = {};
			return Refuse("the free camera could not be taken (another mod refused it)");
		}
		g_active = true;
		HidePlayer(true);
		g_lights = PhotoLighting::BeginPortrait({ PhotoLighting::Mode::Soft, 1.0f });
		if (!Apply()) {
			Stop("pose failed");
			return Refuse("the camera could not be placed in front of her");
		}
		logger::info("person-live: started on {:08X} '{}' (lights {})", actor->GetFormID(),
			actor->GetName() ? actor->GetName() : "", g_lights ? "on" : "off");   // marker: person-live-start
		return Pose().dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string Orbit(float dyawDeg, float dzoom, bool reset)
	{
		if (!g_active)
			return Refuse("the live view is not running");
		if (reset) {
			g_yaw  = 0.0f;
			g_zoom = 1.0f;
		} else {
			if (std::isfinite(dyawDeg))
				g_yaw = std::fmod(g_yaw + std::clamp(dyawDeg, -180.0f, 180.0f) + 540.0f, 360.0f) - 180.0f;
			if (std::isfinite(dzoom) && dzoom > 0.0f)
				g_zoom = std::clamp(g_zoom * std::clamp(dzoom, 0.5f, 2.0f), kZoomMin, kZoomMax);
		}
		if (!Apply()) {
			Stop("actor or camera lost");
			return Refuse("she is gone from view (unloaded, or the camera was taken)");
		}
		return Pose().dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	void Stop(const char* why)
	{
		if (!g_active && !g_focusSwapped)
			return;
		if (g_lights) {
			PhotoLighting::EndPortrait();
			g_lights = false;
		}
		HidePlayer(false);
		if (!g_lease.Exit(RE::PlayerCamera::GetSingleton(), FrozenFlag()))
			logger::warn("person-live: free camera did not release on the first try");
		g_active = false;
		g_actor  = {};
		if (g_focusSwapped && g_restoreFocus)
			g_restoreFocus();
		g_focusSwapped = false;
		logger::info("person-live: stopped ({})", why ? why : "");   // marker: person-live-stop
	}
}
