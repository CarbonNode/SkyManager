#pragma once
#include <cstdint>
#include <optional>

namespace PhotoReturn
{
	enum class Result { Wait, Open, Cancel };
	class Gate
	{
	public:
		explicit Gate(std::uint64_t now) : started_(now) {}
		Result Poll(std::uint64_t now, bool sameContext, bool ready)
		{
			if (finished_ || !sameContext || now - started_ >= 5000) {
				finished_ = true;
				return Result::Cancel;
			}
			if (!ready) {
				clearSince_.reset();
				return Result::Wait;
			}
			if (!clearSince_) clearSince_ = now;
			// Let the camera/HUD and the saved-image callback settle before
			// pausing the world again. A menu opening restarts this interval.
			if (now - *clearSince_ < 400) return Result::Wait;
			finished_ = true;
			return Result::Open;
		}
	private:
		std::uint64_t started_;
		std::optional<std::uint64_t> clearSince_;
		bool finished_ = false;
	};
}
