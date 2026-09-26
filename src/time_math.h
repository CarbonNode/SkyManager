#pragma once
#include <cmath>

// Pure calendar arithmetic. Skyrim has a fixed 365-day year (no leap days).
namespace TimeMath {
constexpr int monthDays[] = {31,28,31,30,31,30,31,31,30,31,30,31};
constexpr float maxHours = 365.0f * 24.0f;
struct Date { double hour; int day; int month; int year; };
inline bool Valid(Date d) {
    return std::isfinite(d.hour) && d.hour >= 0 && d.hour <= maxHours + 24 &&
        d.month >= 0 && d.month < 12 && d.day >= 1 && d.day <= monthDays[d.month];
}
inline Date Advance(Date d, double hours) {
    d.hour += hours;
    while (d.hour >= 24) {
        d.hour -= 24;
        if (++d.day > monthDays[d.month]) {
            d.day = 1;
            if (++d.month == 12) { d.month = 0; ++d.year; }
        }
    }
    return d;
}
inline double Until(double hour, double target) {
    double h = std::fmod(target - std::fmod(hour, 24.0) + 24.0, 24.0);
    return h < 0.0001 ? 24.0 : h;
}
inline double Months(Date d, int count) {
    const int destMonth = (d.month + count) % 12;
    const int destDay = d.day < monthDays[destMonth] ? d.day : monthDays[destMonth];
    int days = destDay - d.day;
    for (int i = 0; i < count; ++i) days += monthDays[(d.month + i) % 12];
    return days * 24.0;
}
}
