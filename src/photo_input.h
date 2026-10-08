#pragma once
#include <cstdint>
#include <cmath>
namespace PhotoInput {
// DirectInput Return and Numpad Enter. E (0x12) is Quick Light on this rig.
constexpr bool Shoot(std::uint32_t code, bool down) { return down && (code == 0x1C || code == 0x9C); }
// The configured deck key is supplied by the caller (keyboard OR mouse).
constexpr bool Cancel(bool keyboard, std::uint32_t code, bool down, bool deckKey) {
    return down && (deckKey || (keyboard && code == 0x01));
}
enum class LightAction { None, Place, Undo, Select, Color, Dim, Brighten, Narrow, Widen, ToggleHud, Format, Grid, Studio, Preview };
constexpr bool LightControl(std::uint32_t code) {
    return code == 0x12 || code == 0x0E || (code >= 0x3B && code <= 0x3E) ||
        code == 0x1A || code == 0x1B || code == 0x42 || code == 0x40 || code == 0x44 || code == 0x57 || code == 0x19;
}
// A short E release is distinct from Quick Light's hold-Activate gesture.
// Require a down in THIS session; entering with E held never drops a light.
struct LightKeys {
    bool eDown = false;
    LightAction Event(std::uint32_t code, bool down, bool up, float heldSeconds) {
        if (code == 0x0E && down) return LightAction::Undo;
        if (down) switch (code) {
            case 0x3B: return LightAction::Select; // F1
            case 0x3C: return LightAction::Color; // F2
            case 0x3D: return LightAction::Dim; // F3
            case 0x3E: return LightAction::Brighten; // F4
            case 0x1A: return LightAction::Narrow; // [
            case 0x1B: return LightAction::Widen; // ]
            case 0x40: return LightAction::Format; // F6
            case 0x44: return LightAction::Grid; // F10
            case 0x42: return LightAction::ToggleHud; // F8; never F5/F9 save/load
            case 0x57: return LightAction::Studio; // F11; focused editor
            case 0x19: return LightAction::Preview; // P while framing; optional GPU viewfinder
            default: break;
        }
        if (code != 0x12) return LightAction::None;
        if (down) eDown = true;
        if (!up) return LightAction::None;
        const bool tap = eDown && std::isfinite(heldSeconds) && heldSeconds >= 0.0f && heldSeconds <= 0.30f;
        eDown = false;
        return tap ? LightAction::Place : LightAction::None;
    }
};
}
