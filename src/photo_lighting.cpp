#include "photo_lighting.h"

#include <array>
#include <cstring>
#include <vector>

namespace PhotoLighting
{
    namespace
    {
        struct Lamp {
            RE::NiPointer<RE::NiPointLight> point;
            RE::NiPointer<RE::BSLight> registered;
            Tuning tuning;
        };
        std::array<Lamp, 2> g_lamps;
        std::vector<Lamp> g_placed;
        Settings g_settings;
        Tuning g_brush, g_fill;
        int g_selected = -1;
        bool g_portrait = false;
        RE::NiPointer<RE::ShadowSceneNode> g_scene;
        RE::NiPointer<RE::NiNode> g_camera;

        Tuning& Current()
        {
            if (g_selected == -2) return g_fill;
            if (g_selected >= 0 && static_cast<std::size_t>(g_selected) < g_placed.size()) return g_placed[g_selected].tuning;
            return g_brush;
        }
        void ApplyTuning(Lamp& lamp, float multiplier = 1.0f)
        {
            if (!lamp.point) return;
            const auto& tuning = lamp.tuning;
            const auto& color = Colors[tuning.color];
            auto& data = lamp.point->GetLightRuntimeData();
            data.diffuse = {color.r, color.g, color.b};
            const float radius = Radii[tuning.spread];
            data.radius = {radius, radius, radius};
            lamp.point->SetLightAttenuation(radius);
            data.fade = tuning.strength * (g_settings.mode == Mode::Bright ? 2.0f : 1.0f) * multiplier;
            RE::NiUpdateData update{};
            lamp.point->Update(update);
        }
        void RefreshSelected()
        {
            if (g_selected == -2) for (std::size_t i=0; i<g_lamps.size(); ++i) {
                g_lamps[i].tuning = g_fill; ApplyTuning(g_lamps[i], i == 0 ? 1.0f : 0.5f);
            }
            else if (g_selected >= 0 && static_cast<std::size_t>(g_selected) < g_placed.size()) ApplyTuning(g_placed[g_selected]);
        }

        RE::NiPointLight* CreatePointLight()
        {
            const auto size = PointLightBytes(REL::Module::IsVR());
            auto* memory = RE::malloc<RE::NiPointLight>(size);
            if (!memory) return nullptr;
            std::memset(static_cast<void*>(memory), 0, size);
            // Same constructor as CommonLib's NiPointLight::Create, with the
            // correct runtime allocation (see photo_lighting.h).
            using Ctor = RE::NiPointLight* (*)(RE::NiPointLight*);
            static REL::Relocation<Ctor> ctor{ RELOCATION_ID(69583, 70967) };
            return ctor(memory);
        }

        void Remove(Lamp& lamp)
        {
            if (lamp.point) {
                lamp.point->GetLightRuntimeData().fade = 0.0f;
                lamp.point->SetAppCulled(true);
            }
            if (g_scene && lamp.registered) g_scene->RemoveLight(lamp.registered);
            if (lamp.point && lamp.point->parent) lamp.point->parent->DetachChild(lamp.point.get());
            lamp.registered.reset();
            lamp.point.reset();
        }

        bool Register(Lamp& lamp, RE::NiPoint3 position, float radius, float intensity, RE::NiNode* parent)
        {
            lamp.point.reset(CreatePointLight());
            if (!lamp.point) return false;
            auto* light = lamp.point.get();
            light->name = parent ? "SkyManager Photo Fill" : "SkyManager Photo Placed";
            light->local.translate = position;
            auto& data = light->GetLightRuntimeData();
            data.ambient = { 0.0f, 0.0f, 0.0f };
            data.diffuse = { 1.0f, 0.96f, 0.90f };
            data.radius = { radius, radius, radius };
            light->SetLightAttenuation(radius);
            data.fade = intensity;
            if (parent) parent->AttachChild(light, true);
            // An unparented light uses its own world-space transform. It is
            // retained here and by the renderer, never attached to the camera.
            RE::NiUpdateData update{};
            light->Update(update);
            RE::ShadowSceneNode::LIGHT_CREATE_PARAMS params{};
            params.dynamic = true;
            params.shadowLight = false;
            params.portalStrict = false;
            params.affectLand = true;
            params.affectWater = true;
            params.neverFades = true;
            params.falloff = 1.0f;
            params.nearDistance = 5.0f;
            params.sceneGraphIndex = 0;
            lamp.registered.reset(g_scene->AddLight(light, params));
            if (!lamp.registered) { Remove(lamp); return false; }
            return true;
        }
    }

    void End()
    {
        const bool owned = static_cast<bool>(g_scene);
        // Remove the exact BSLight we registered. The renderer retains its own
        // reference until its removal queue drains; never delete it manually.
        for (auto& lamp : g_lamps) Remove(lamp);
        for (auto& lamp : g_placed) Remove(lamp);
        g_placed.clear();
        g_selected = -1;
        g_portrait = false;
        g_camera.reset();
        g_scene.reset();
        if (owned) logger::info("photo-light: temporary scene lights removed");
    }

    static bool BeginInternal(Settings settings, bool portrait)
    {
        End();
        if (!std::isfinite(settings.strength) || settings.strength < 0.25f || settings.strength > 3.0f) return false;
        auto* camera = RE::PlayerCamera::GetSingleton();
        auto* scene = RE::BSShaderManager::State::GetSingleton().shadowSceneNode[0];
        if (!scene || !camera || !camera->cameraRoot || (!portrait && !camera->IsInFreeCameraMode())) return false;
        g_portrait = portrait;
        g_scene.reset(scene);
        g_camera = camera->cameraRoot;
        g_settings = settings;
        g_brush = {0, settings.strength, settings.mode == Mode::Bright ? 4u : 2u};
        g_fill = g_brush;
        // Natural starts with no added illumination, but E can still place a
        // light. The session owns its renderer context even before the first E.
        if (settings.mode == Mode::Natural) return true;
        g_selected = -2; // Start on the visible fill, so the first adjustment is visible immediately.
        const bool bright = settings.mode == Mode::Bright;
        const float radius = bright ? 1800.0f : 850.0f;
        const float intensity = (bright ? 2.0f : 1.0f) * settings.strength;
        for (std::size_t i = 0; i < g_lamps.size(); ++i) {
            // Camera-relative: soft light from above either shoulder, with a
            // weaker fill. No visible bulb/mesh can enter the photograph.
            if (!Register(g_lamps[i], { i == 0 ? -65.0f : 65.0f, -20.0f, i == 0 ? 55.0f : 30.0f },
                    radius, intensity * (i == 0 ? 1.0f : 0.5f), g_camera.get())) { End(); return false; }
            g_lamps[i].tuning = g_fill;
        }
        logger::info("photo-light: camera fill started mode={} strength={} radius={} runtimeBytes={}",
            bright ? "bright" : "soft", settings.strength, radius, PointLightBytes(REL::Module::IsVR()));
        return true;
    }

    bool Begin(Settings settings) { return BeginInternal(settings, false); }
    bool BeginPortrait(Settings settings) { return BeginInternal(settings, true); }
    bool PortraitActive() { return g_portrait && static_cast<bool>(g_scene); }
    void EndPortrait() { if (g_portrait) End(); }

    PlaceResult Place()
    {
        Update(); // invalid/free-camera-ended contexts clean up before any add
        if (!g_scene || !g_camera || g_portrait) return PlaceResult::Unavailable;
        if (g_placed.size() >= MaxPlacedLights) return PlaceResult::Full;
        const auto position = g_camera->world.translate;
        if (!std::isfinite(position.x) || !std::isfinite(position.y) || !std::isfinite(position.z))
            return PlaceResult::Unavailable;
        Lamp lamp;
        lamp.tuning = Current();
        if (!Register(lamp, position, Radii[lamp.tuning.spread],
                (g_settings.mode == Mode::Bright ? 2.0f : 1.0f) * lamp.tuning.strength, nullptr)) return PlaceResult::Unavailable;
        ApplyTuning(lamp);
        g_brush = lamp.tuning;
        g_placed.push_back(std::move(lamp));
        g_selected = static_cast<int>(g_placed.size()) - 1;
        logger::info("photo-light: placed world light count={} position={},{},{} registered={} parentless={}",
            g_placed.size(), position.x, position.y, position.z,
            g_scene->GetPointLight(g_placed.back().point.get()) == g_placed.back().registered.get(),
            g_placed.back().point->parent == nullptr);
        return PlaceResult::Placed;
    }

    bool Undo()
    {
        if (g_placed.empty()) return false;
        Remove(g_placed.back());
        g_placed.pop_back();
        if (g_selected >= static_cast<int>(g_placed.size())) g_selected = static_cast<int>(g_placed.size()) - 1;
        logger::info("photo-light: undo placed light remaining={}", g_placed.size());
        return true;
    }

    std::size_t PlacedCount() { return g_placed.size(); }
    Snapshot State() { return {static_cast<bool>(g_scene), g_selected, g_placed.size(), Current()}; }
    void SelectNext()
    {
        if (g_selected == -1 && g_settings.mode != Mode::Natural) g_selected = -2;
        else if (g_selected < 0) g_selected = g_placed.empty() ? -1 : 0;
        else g_selected = static_cast<std::size_t>(g_selected + 1) < g_placed.size() ? g_selected + 1 : -1;
    }
    void CycleColor() { auto& t=Current(); t.color=(t.color+1)%Colors.size(); RefreshSelected(); }
    void Strength(int direction) {
        auto& t=Current(); t.strength += direction > 0 ? 0.25f : -0.25f;
        if (t.strength < 0.25f) t.strength = 0.25f;
        if (t.strength > 3.0f) t.strength = 3.0f;
        RefreshSelected();
    }
    void Spread(int direction) {
        auto& t=Current();
        if(direction > 0 && t.spread+1<Radii.size())++t.spread;
        else if(direction < 0 && t.spread>0)--t.spread;
        RefreshSelected();
    }

    void Update()
    {
        if (!g_scene) return;
        auto* camera = RE::PlayerCamera::GetSingleton();
        if (!camera || (!g_portrait && !camera->IsInFreeCameraMode()) || camera->cameraRoot != g_camera) {
            End();
            return;
        }
        // Explicit updates also work with game time frozen. This uses the
        // active camera's transform, never the player/skeleton/Quick Light.
        for (auto& lamp : g_lamps) if (lamp.point) {
            RE::NiUpdateData update{};
            lamp.point->Update(update);
        }
    }

    void LogState()
    {
        if (!g_scene) return;
        for (std::size_t i = 0; i < g_lamps.size(); ++i) {
            const auto& lamp = g_lamps[i];
            if (!lamp.point) continue;
            const auto& p = lamp.point->world.translate;
            logger::info("photo-light: settled lamp={} registered={} attached={} position={},{},{} fade={}",
                i, g_scene->GetPointLight(lamp.point.get()) == lamp.registered.get(),
                lamp.point->parent == g_camera.get(), p.x, p.y, p.z, lamp.point->GetLightRuntimeData().fade);
        }
    }
}
