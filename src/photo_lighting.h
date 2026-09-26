#pragma once

#include <cmath>
#include <cstddef>
#include <string_view>
#include <array>

// Render-only photo fill. No spells, placed references, plugin records or save data.
namespace PhotoLighting
{
    enum class Mode { Natural, Soft, Bright };
    struct Settings {
        Mode mode = Mode::Natural;
        float strength = 1.0f;
    };

    inline bool Parse(std::string_view mode, float strength, Settings& out)
    {
        if (!std::isfinite(strength) || strength < 0.25f || strength > 3.0f) return false;
        if (mode == "natural") out = { Mode::Natural, strength };
        else if (mode == "soft") out = { Mode::Soft, strength };
        else if (mode == "bright") out = { Mode::Bright, strength };
        else return false;
        return true;
    }

    // CommonLib's cross-VR sizeof(NiPointLight) omits the runtime tail. Its
    // inline Create() therefore underallocates. These are the native sizes
    // asserted by the exclusive SE/AE and VR headers, not sizeof the C++ shell.
    constexpr std::size_t PointLightBytes(bool vr) { return vr ? 0x178 : 0x150; }
    inline constexpr std::size_t MaxPlacedLights = 12;
    enum class PlaceResult { Placed, Full, Unavailable };
    struct Color { const char* name; float r, g, b; };
    inline constexpr std::array<Color, 8> Colors{{
        {"Warm",1.0f,0.96f,0.90f}, {"White",1.0f,1.0f,1.0f}, {"Cool",0.66f,0.80f,1.0f},
        {"Amber",1.0f,0.65f,0.30f}, {"Red",1.0f,0.25f,0.22f}, {"Blue",0.30f,0.50f,1.0f},
        {"Green",0.35f,1.0f,0.48f}, {"Violet",0.80f,0.40f,1.0f}
    }};
    inline constexpr std::array<float, 6> Radii{300.0f,500.0f,850.0f,1200.0f,1800.0f,2400.0f};
    inline constexpr std::array<const char*, 6> Spreads{"Tight","Small","Medium","Wide","Large","Room"};
    struct Tuning { std::size_t color = 0; float strength = 1.0f; std::size_t spread = 2; };
    struct Snapshot {
        bool active = false;
        int selected = -1; // -1 next light, -2 camera fill, >=0 stationary light
        std::size_t count = 0;
        Tuning tuning;
    };

    // Main-thread only. Begin rolls back a partial rig; End is idempotent.
    bool Begin(Settings settings);
    // Portraits use the normal camera and only its fill; they cannot place lights.
    bool BeginPortrait(Settings settings);
    bool PortraitActive();
    void EndPortrait();
    void Update();
    void End();
    void LogState();
    PlaceResult Place();
    bool Undo();
    std::size_t PlacedCount();
    Snapshot State();
    void SelectNext();
    void CycleColor();
    void Strength(int direction);
    void Spread(int direction);
}
