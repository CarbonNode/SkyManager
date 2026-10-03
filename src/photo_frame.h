#pragma once

#include <algorithm>
#include <cmath>
#include <string_view>

// One pixel rectangle feeds BOTH the HUD guide and the present-thread capture.
// No second render, texture readback or image encoding while composing a shot.
namespace PhotoFrame {
enum class Format { Square, Portrait, Landscape, Screen };
inline const char* Key(Format f) {
    switch (f) {
        case Format::Portrait: return "portrait";
        case Format::Landscape: return "landscape";
        case Format::Screen: return "screen";
        default: return "square";
    }
}
inline const char* Label(Format f) {
    switch (f) {
        case Format::Portrait: return "Portrait 3:4";
        case Format::Landscape: return "Landscape 16:9";
        case Format::Screen: return "Screen ratio";
        default: return "Square 1:1";
    }
}
inline Format Parse(std::string_view value) {
    if (value == "portrait") return Format::Portrait;
    if (value == "landscape") return Format::Landscape;
    if (value == "screen") return Format::Screen;
    return Format::Square;
}
inline Format Next(Format f) { return static_cast<Format>((static_cast<int>(f) + 1) % 4); }
struct Frame {
    int sourceWidth = 0, sourceHeight = 0;
    int x = 0, y = 0, width = 0, height = 0;
    int outputWidth = 0, outputHeight = 0;
    Format format = Format::Square;
    bool thirds = false;
    bool Valid() const { return width > 0 && height > 0 && outputWidth > 0 && outputHeight > 0; }
};
inline float Safe(float v, float fallback, float low, float high) {
    return std::isfinite(v) ? std::clamp(v, low, high) : fallback;
}
inline Frame Make(int sw, int sh, Format format, float zoom = 1, float dx = 0, float dy = 0, bool thirds = false) {
    Frame f; f.sourceWidth = sw; f.sourceHeight = sh; f.format = format; f.thirds = thirds;
    if (sw <= 0 || sh <= 0) return f;
    const int shortSide = (std::min)(sw, sh);
    double ratio = format == Format::Portrait ? 3.0 / 4 : format == Format::Landscape ? 16.0 / 9 :
        format == Format::Screen ? double(sw) / sh : 1.0;
    double h = (std::min)(double(sh), double(sw) / ratio);
    const double scale = Safe(zoom, 1, .15f, 1);
    f.height = std::clamp(static_cast<int>(h * scale), (std::min)(64, sh), sh);
    f.width = std::clamp(static_cast<int>(f.height * ratio), 1, sw);
    const int cx = sw / 2 + static_cast<int>(Safe(dx, 0, -.5f, .5f) * shortSide);
    const int cy = sh / 2 + static_cast<int>(Safe(dy, 0, -.5f, .5f) * shortSide);
    f.x = std::clamp(cx - f.width / 2, 0, sw - f.width);
    f.y = std::clamp(cy - f.height / 2, 0, sh - f.height);
    const double outputScale = (std::min)(1.0, 1024.0 / (std::max)(f.width, f.height));
    f.outputWidth = (std::max)(1, static_cast<int>(std::lround(f.width * outputScale)));
    f.outputHeight = (std::max)(1, static_cast<int>(std::lround(f.height * outputScale)));
    return f;
}
}
