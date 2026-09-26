#pragma once
#include <cstdint>
#include <string>

namespace ItemIconPaths
{
    // Keep -s2 last: the texture-fallback path removes that suffix verbatim.
    inline std::string Versioned(std::string file, std::uint64_t revision)
    {
        if (!revision) return file;
        const auto suffix = file.ends_with("-s2.png") ? file.size() - 7 : file.size() - 4;
        file.insert(suffix, "-r" + std::to_string(revision));
        return file;
    }

    // Frame zero, texture-swapped frame zero, and exactly the 3-digit angles.
    inline bool SameGeneration(const std::string& file, const std::string& plain)
    {
        if (file == plain) return true;
        const auto base = plain.substr(0, plain.size() - 4);
        for (const auto& prefix : {base, base + "-s2"}) {
            if (file == prefix + ".png") return true;
            if (file.size() != prefix.size() + 9 || file.rfind(prefix + "-a", 0) != 0 || !file.ends_with(".png")) continue;
            const auto digits = file.substr(prefix.size() + 2, 3);
            if (digits.find_first_not_of("0123456789") == std::string::npos) return true;
        }
        return false;
    }
}
