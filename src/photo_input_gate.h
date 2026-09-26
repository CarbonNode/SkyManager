#pragma once
#include <cstdint>

namespace RE { class ButtonEvent; }

namespace PhotoInputGate {
struct DeckKey { bool keyboard = true; bool mouse = false; std::uint32_t code = 0; };
// A dispatch hook, NOT a BSTEventSink: photo buttons are removed before other
// native/Papyrus hotkey listeners run. Movement and mouse-look pass unchanged.
void Install(DeckKey (*readDeckKey)());
bool Ready();
// Extended F13-F24 injections bypass the engine dispatch call site.
bool ConsumeSynthetic(RE::ButtonEvent* button);
}
