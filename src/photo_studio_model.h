#pragma once
#include <algorithm>
#include <cmath>
#include "photo_frame.h"

namespace PhotoStudio {
struct Pose { float x=0, y=0, z=0, pitch=0, yaw=0, fov=60; };
struct Anchor { float x=0, y=0, z=0, yaw=0; };
inline float Wrap(float v) { return std::remainder(v, 6.28318530718f); }
inline bool Valid(const Pose& p) {
    return std::isfinite(p.x) && std::isfinite(p.y) && std::isfinite(p.z) &&
        std::isfinite(p.pitch) && std::isfinite(p.yaw) && std::isfinite(p.fov) &&
        std::abs(p.x)<=20000 && std::abs(p.y)<=20000 && std::abs(p.z)<=20000 &&
        std::abs(p.pitch)<=1.5708f && p.fov>=20 && p.fov<=120;
}
inline Pose Relative(Pose p, const Anchor& a) {
    const float x=p.x-a.x, y=p.y-a.y, c=std::cos(a.yaw), s=std::sin(a.yaw);
    p.x=c*x+s*y; p.y=-s*x+c*y; p.z-=a.z; p.yaw=Wrap(p.yaw-a.yaw); return p;
}
inline Pose Absolute(Pose p, const Anchor& a) {
    const float x=p.x, y=p.y, c=std::cos(a.yaw), s=std::sin(a.yaw);
    p.x=a.x+c*x-s*y; p.y=a.y+s*x+c*y; p.z+=a.z; p.yaw=Wrap(p.yaw+a.yaw); return p;
}
struct Bounds { float x=.60f, y=.08f, w=.34f, h=.65f; };
inline bool Valid(const Bounds& b) {
    return std::isfinite(b.x)&&std::isfinite(b.y)&&std::isfinite(b.w)&&std::isfinite(b.h)&&
        b.x>=0&&b.y>=0&&b.w>=.05f&&b.h>=.05f&&b.w<=1&&b.h<=1&&b.x+b.w<=1.00001f&&b.y+b.h<=1.00001f;
}
// Aspect-preserving viewfinder; source pixels are never enlarged. Coordinates
// are in the actual swapchain, including an upscaler's smaller proxy buffer.
inline Bounds Fit(Bounds b, int sw, int sh, int cw, int ch) {
    if (!Valid(b)||sw<=0||sh<=0||cw<=0||ch<=0) return {};
    const float scale=(std::min)({b.w*sw/cw,b.h*sh/ch,1.f});
    const float w=cw*scale/sw,h=ch*scale/sh;
    return {b.x+(b.w-w)/2,b.y+(b.h-h)/2,w,h};
}
}
