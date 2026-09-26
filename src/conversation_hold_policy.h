#pragma once
#include <cmath>

// Pure lifetime policy shared by the native movement hold and its regression
// checks. A conversation never drags somebody across a cell or a teleport.
namespace ConversationHoldPolicy
{
    constexpr double Duration = 300.0;
    constexpr float StartRange = 768.0f;
    constexpr float LeaveRange = 1536.0f;
    constexpr float CorrectionRange = 512.0f;
    enum class Decision { Pause, Hold, Correct, Release };
    inline Decision Step(bool paused, bool available, bool sameCell, bool busy,
        double remaining, float playerDistance, float drift)
    {
        if (!available || !sameCell || busy || remaining <= 0 ||
            !std::isfinite(playerDistance) || !std::isfinite(drift) ||
            playerDistance > LeaveRange || drift > CorrectionRange)
            return Decision::Release;
        if (paused) return Decision::Pause;
        return drift > 4.0f ? Decision::Correct : Decision::Hold;
    }
}
