#pragma once
#include "photo_input.h"
#include <array>
#include <vector>
#include <utility>

namespace PhotoInput {
enum class Command { None, Light, Shoot, Cancel };
struct CaptureDecision { bool consume = false; Command command = Command::None; };

// Pair every captured down with its release, even after photo exit. Never
// interpret a release/held frame whose down belonged to normal gameplay.
class CaptureKeys {
    struct Owner { std::uint64_t session = 0; Command command = Command::None; };
    std::array<Owner, 266> owners{}; // keyboard 0..255, mouse 0..9
    unsigned held = 0;
public:
    bool Pending() const { return held != 0; }
    CaptureDecision Event(std::uint64_t session, bool keyboard, bool mouse,
                          std::uint32_t code, bool down, bool up, bool deckKey) {
        if ((!keyboard && !mouse) || code >= (keyboard ? 256u : 10u)) return {};
        auto& owner = owners[(keyboard ? 0u : 256u) + code];
        if (down) {
            // A fresh down also recovers a missed release (e.g. lost focus).
            if (owner.session) { owner = {}; --held; }
            Command command = Command::None;
            if (session) {
                if (keyboard && Shoot(code, true)) command = Command::Shoot;
                else if (Cancel(keyboard, code, true, deckKey)) command = Command::Cancel;
                else if (keyboard && LightControl(code)) command = Command::Light;
            }
            if (command != Command::None) { owner = {session, command}; ++held; }
        }
        if (!owner.session) return {};
        CaptureDecision result{true, session && owner.session == session && (down || up)
            ? owner.command : Command::None};
        if (up) { owner = {}; --held; }
        return result;
    }
};

// Use a local head; temporarily unlink captured nodes and restore the original
// engine-owned queue after downstream dispatch. No event is freed or recreated.
template<class Event> class MaskedEvents {
    std::vector<std::pair<Event**, Event*>> changed;
public:
    MaskedEvents() = default;
    MaskedEvents(const MaskedEvents&) = delete;
    MaskedEvents& operator=(const MaskedEvents&) = delete;
    ~MaskedEvents() {
        for (auto it = changed.rbegin(); it != changed.rend(); ++it) *it->first = it->second;
    }
    template<class Consume> void Filter(Event*& head, Consume consume) {
        for (auto** link = &head; *link;) {
            if (consume(**link)) {
                changed.emplace_back(link, *link);
                *link = (*link)->next;
            } else link = &(*link)->next;
        }
    }
};
}
