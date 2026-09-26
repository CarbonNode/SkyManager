#pragma once
#include <algorithm>
#include <cmath>
#include <vector>

// Engine-independent planning; collision and ground reads are injected by the
// owning NPC clearance module. No destination is invented when probes fail.
namespace NpcClearanceGeometry {
struct Point { float x, y, z; };
inline constexpr float UnitsPerFoot = 64.0f / 3.0f; // Skyrim: 128 units = six feet
inline float Distance2D(Point a, Point b) { return std::hypot(a.x-b.x, a.y-b.y); }
template<class Ground, class Clear>
bool Destination(Point player, Point actor, float feet, const std::vector<Point>& occupied,
                 Ground ground, Clear clear, Point& result) {
    const float radius = feet * UnitsPerFoot;
    if (Distance2D(player, actor) >= radius) return false;
    const float angle = Distance2D(player, actor) < 1 ? 0 : std::atan2(actor.y-player.y, actor.x-player.x);
    // Prefer straight away; try both sides without crossing behind the player.
    for (float offset : {0.f, .45f, -.45f, .9f, -.9f}) {
        const float a = angle + offset;
        Point end{player.x + std::cos(a)*radius, player.y + std::sin(a)*radius, actor.z};
        bool crowded = false;
        for (const auto& p : occupied) if (Distance2D(p,end) < 80 && std::abs(p.z-end.z) < 100) { crowded=true; break; }
        if (crowded) continue;
        const float length = Distance2D(actor,end);
        if (length < 1) continue;
        const float dx=(end.x-actor.x)/length, dy=(end.y-actor.y)/length;
        // Check continuous ground, modest steps, headroom and a body-width
        // corridor. Refuse drops, walls and cramped gaps; do not shorten silently.
        Point prev=actor; bool valid=true;
        const int steps=static_cast<int>(std::ceil(length/64.f));
        for (int i=1; i<=steps && valid; ++i) {
            const float t=static_cast<float>(i)/steps;
            Point next{actor.x+(end.x-actor.x)*t,actor.y+(end.y-actor.y)*t,prev.z};
            float floor=0;
            if (!ground(next,floor) || std::abs(floor-prev.z)>40) {valid=false;break;}
            next.z=floor+2;
            for (float side : {-24.f,0.f,24.f}) {
                Point low{next.x-dy*side,next.y+dx*side,next.z+8};
                Point high=low;high.z+=120;
                if (!clear(low,high)) {valid=false;break;}
                Point from{prev.x-dy*side,prev.y+dx*side,prev.z+50};
                Point to{next.x-dy*side,next.y+dx*side,next.z+50};
                if (!clear(from,to)) {valid=false;break;}
            }
            prev=next;
        }
        if (!valid) continue;
        // Ground must support the actor's feet on both sides of the landing.
        for (float side : {-24.f,24.f}) {
            Point foot{prev.x-dy*side,prev.y+dx*side,prev.z};float floor=0;
            if (!ground(foot,floor) || std::abs(floor-prev.z)>12) {valid=false;break;}
        }
        if(valid){result=prev;return true;}
    }
    return false;
}
}
