#pragma once

#include <algorithm>
#include <cmath>
#include <optional>

namespace SicEmFeedback
{
	struct Point { float x, y, z; };
	struct Trajectory
	{
		Point origin;
		float pitch, yaw;
	};

	// Is `target` in front of `origin` along the camera's forward `fwd`
	// (unit vector)? The bolt converges from the head onto the crosshair
	// point; a point at or behind the head plane — or so close that the
	// convergence angle swings wide of the camera's aim — would send it out
	// of his back or sideways (2026-10-12). Needs >= 60 units ahead and a
	// direction within ~60 degrees of the aim.
	inline bool AheadOf(Point origin, Point target, Point fwd)
	{
		const Point d{ target.x - origin.x, target.y - origin.y, target.z - origin.z };
		const float along = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z;
		const float len = std::sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
		if (!std::isfinite(along) || !std::isfinite(len) || along < 60.0f)
			return false;
		return along >= 0.5f * len;
	}

	inline std::optional<Trajectory> Aim(Point origin, Point target)
	{
		const Point delta{ target.x - origin.x, target.y - origin.y, target.z - origin.z };
		const float horizontal = std::hypot(delta.x, delta.y);
		const float distance = std::hypot(horizontal, delta.z);
		if (!std::isfinite(distance) || distance < 1.0f)
			return std::nullopt;
		// Start ahead of the actor's look-at point, without overshooting a close target.
		const float offset = (std::min)(32.0f, distance * 0.2f) / distance;
		return Trajectory{
			{ origin.x + delta.x * offset, origin.y + delta.y * offset, origin.z + delta.z * offset },
			-std::atan2(delta.z, horizontal), std::atan2(delta.x, delta.y)
		};
	}
}
