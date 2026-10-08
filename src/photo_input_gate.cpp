#include "photo_input_gate.h"
#include "photo_input_capture.h"
#include "portrait_capture.h"
#include "photo_studio.h"
#include <Windows.h>
#include <cstring>

namespace PhotoInputGate {
namespace {
using Dispatch = void (*)(void*, RE::InputEvent* const*);
Dispatch previous = nullptr;
DeckKey (*getDeckKey)() = nullptr;
PhotoInput::CaptureKeys captured;

bool CaptureButton(RE::ButtonEvent* button, std::uint64_t session, const DeckKey& deck) {
    const auto device = button->GetDevice();
    const auto code = button->GetIDCode();
    const bool keyboard = device == RE::INPUT_DEVICE::kKeyboard;
    const bool mouse = device == RE::INPUT_DEVICE::kMouse;
    const bool deckKey = ((keyboard && deck.keyboard) || (mouse && deck.mouse)) && code == deck.code;
    // Focused studio needs real text input (E, brackets, Backspace and Enter
    // included). Finish any earlier captured release, then let Prisma consume.
    const auto decision = captured.Event(PhotoStudio::Editing()?0:session, keyboard, mouse, code,
        button->IsDown(), button->IsUp(), deckKey);
    using Command = PhotoInput::Command;
    if (decision.command == Command::Light) {
        PortraitCapture::PhotoLightKey(code, button->IsDown(), button->IsUp(), button->HeldDuration());
    } else if (button->IsDown() && decision.command != Command::None) {
        const bool shoot = decision.command == Command::Shoot;
        logger::info("photo-input: isolated {} key={}", shoot ? "shutter" : "cancel", code);
        SKSE::GetTaskInterface()->AddTask([session, shoot]() {
            if (PortraitCapture::PhotoInputSession() != session) return;
            if (shoot) PortraitCapture::PhotoShootNow();
            else PortraitCapture::PhotoCancel();
        });
    }
    if (decision.consume && button->IsDown())
        logger::info("photo-input: captured key={} keyboard={} session={}", code, keyboard, session);
    return decision.consume;
}

void DispatchInput(void* source, RE::InputEvent* const* events) {
    const auto session = PortraitCapture::PhotoInputSession();
    if (!events || !*events || (!session && !captured.Pending())) {
        previous(source, events);
        return;
    }
    const auto deck = session && getDeckKey ? getDeckKey() : DeckKey{};
    auto* head = *events;
    PhotoInput::MaskedEvents<RE::InputEvent> mask;
    mask.Filter(head, [&](RE::InputEvent& event) {
        auto* button = event.AsButtonEvent();
        if (!button) return false;
        return CaptureButton(button, session, deck);
    });
    // This is the PREVIOUS hook, not SendEvent directly: PrismaUI, PPA, Custom
    // Markers and other input hooks keep their existing chain/order.
    previous(source, &head);
}
}

bool Ready() { return previous != nullptr; }

bool ConsumeSynthetic(RE::ButtonEvent* button) {
    if (!Ready() || !button) return false;
    const auto session = PortraitCapture::PhotoInputSession();
    if (!session && !captured.Pending()) return false;
    return CaptureButton(button, session, session && getDeckKey ? getDeckKey() : DeckKey{});
}

void Install(DeckKey (*readDeckKey)()) {
    if (Ready()) return;
    getDeckKey = readDeckKey;
    // Verified flat SE/AE ProcessInputQueue call site, also used by Photo Mode
    // and Custom Markers. Do not assume its VR layout matches.
    if (REL::Module::IsVR()) {
        logger::warn("photo-input: isolation unavailable on VR");
        return;
    }
    REL::Relocation<std::uintptr_t> site{REL::RelocationID(67315, 68617), 0x7B};
    const auto* bytes = reinterpret_cast<const std::uint8_t*>(site.address());
    std::uintptr_t target = 0;
    std::int32_t displacement = 0;
    unsigned width = 0;
    if (bytes[0] == 0xE8) {
        width = 5;
        std::memcpy(&displacement, bytes + 1, sizeof(displacement));
        target = site.address() + 5 + displacement;
    } else if (bytes[0] == 0xFF && bytes[1] == 0x15) {
        width = 6;
        std::memcpy(&displacement, bytes + 2, sizeof(displacement));
        const auto slot = site.address() + 6 + displacement;
        MEMORY_BASIC_INFORMATION memory{};
        if (!VirtualQuery(reinterpret_cast<const void*>(slot), &memory, sizeof(memory)) ||
            memory.State != MEM_COMMIT || (memory.Protect & (PAGE_NOACCESS | PAGE_GUARD)) ||
            slot + sizeof(target) > reinterpret_cast<std::uintptr_t>(memory.BaseAddress) + memory.RegionSize) return;
        std::memcpy(&target, reinterpret_cast<const void*>(slot), sizeof(target));
    }
    MEMORY_BASIC_INFORMATION memory{};
    if (!width || !target || !VirtualQuery(reinterpret_cast<const void*>(target), &memory, sizeof(memory)) ||
        memory.State != MEM_COMMIT || !(memory.Protect & 0xF0) || (memory.Protect & PAGE_GUARD)) {
        logger::error("photo-input: isolation refused unexpected dispatch call {:02X} {:02X}", bytes[0], bytes[1]);
        return;
    }
    // Decode the old target ourselves: write_call<6>'s return is the pointer
    // SLOT, unlike write_call<5>'s direct target. Calling the slot crashes.
    previous = reinterpret_cast<Dispatch>(target);
    if (width == 5) SKSE::GetTrampoline().write_call<5>(site.address(), &DispatchInput);
    else SKSE::GetTrampoline().write_call<6>(site.address(), &DispatchInput);
    logger::info("photo-input: exclusive controls installed callBytes={} previous={:X}", width, target);
}
}
