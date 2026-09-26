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
