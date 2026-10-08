#pragma once
#include <cstdint>
#include <string>
#include <functional>
#include "photo_studio_model.h"
namespace PhotoStudio {
void Begin(std::uint64_t session);
void End();
// Caller supplies the currently owned session; late view requests are refused.
std::string State();
std::string Request(const std::string& payload);
bool PreviewEnabled();
Bounds PreviewBounds();
bool Editing();
void SetEditing(bool on);
void TogglePreview();
void SetChangedCallback(std::function<void()> cb);
void Tick();
}
