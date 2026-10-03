#pragma once
#include <string>
namespace OsisRuntime {
// Serializes through OSIS's own settings mutex. No Papyrus or scene writes.
// Unknown OSIS images are refused, never treated as the reviewed v1 binary.
std::string Control(const std::string& request);
}
