#pragma once
#include <functional>
#include <string>

// A library of complete MHiYH schedules. Stored separately from hotkeys.json.
// Engine work stays on the main thread; existing Residents verbs own mutations.
namespace RhythmPresets
{
    using Push = std::function<void(const std::string&)>;
    std::string Handle(const std::string& request, Push done);
}
