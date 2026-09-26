#pragma once
#include <string>
#include "room_guard.h"
namespace ScenePrivacy {
// Main-thread engine access. Shares the room watchdog and existing move owner.
void Tick(const RoomGuard::Config&, bool ready);
std::string Control(const std::string& request);
void Reset();
bool KeepsInside(std::uint32_t id);
}
