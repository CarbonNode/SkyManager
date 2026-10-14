#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string>
#include <vector>

// Auto portraits — the pure rules, with no game or D3D types, so they can be
// proven offline (tools/auto_portrait_policy_test.cpp) before anything touches
// the camera. auto_portrait.cpp feeds these from the live game.
//
// Rober, 2026-10-12: "can it just be smarter and more dynamic??" — the MRF head
// renders are an IMITATION of the game's renderer, so NPCs built a little
// differently (Sol's eyes, every tinted hair) come out wrong. A real in-game
// photo is right by construction. These rules decide WHO gets one and WHEN.
namespace AutoPortraitPolicy
{
	// Furthest a subject may be from the player (Skyrim units, ~35 m). The live
	// view allows 6000, but a face shot of someone across a valley is a camera
	// flight through terrain, not a portrait.
	constexpr float kMaxDistance = 2500.0f;
	// At most this many photos per deck open: each costs a visible blink.
	constexpr std::size_t kPerOpen = 2;

	struct Candidate
	{
		std::string slug;          // portrait identity (name slug)
		float       distance = 0;  // to the player, Skyrim units
		bool        loaded = false;
		bool        alive = false;
		bool        busy = false;  // combat, dialogue, mounted ... not a moment for a photo
		std::string sig;           // look signature (see Signature)
	};

	// What auto-portraits.json remembers about a photo IT took.
	struct Record
	{
		std::string file;  // the exact file name written (e.g. "sol~1791818900.png")
		std::string sig;   // the look it was taken with
	};

	enum class Verdict
	{
		Take,        // no portrait at all
		Refresh,     // our own photo, but the look has changed since
		Fresh,       // our own photo, look unchanged
		Manual,      // a photo the player took (or dropped in) is newest — never touched
		NotHere,     // not loaded, dead, or too far
		Busy,        // here, but in combat/dialogue/mounted
		Tried,       // already attempted this session for this look
	};

	inline const char* Name(Verdict v)
	{
		switch (v) {
		case Verdict::Take: return "take";
		case Verdict::Refresh: return "refresh";
		case Verdict::Fresh: return "fresh";
		case Verdict::Manual: return "manual";
		case Verdict::NotHere: return "not-here";
		case Verdict::Busy: return "busy";
		case Verdict::Tried: return "tried";
		}
		return "?";
	}

	inline bool Wanted(Verdict v) { return v == Verdict::Take || v == Verdict::Refresh; }

	// `newestFile` is the newest portrait file on disk for this slug (any
	// version), or nullopt for none. The ORDER of checks is the contract:
	// a manual photo is never overwritten, whatever else is true.
	inline Verdict Decide(const Candidate& c, const std::optional<Record>& rec,
		const std::optional<std::string>& newestFile, bool triedThisLook)
	{
		if (newestFile && !(rec && rec->file == *newestFile))
			return Verdict::Manual;
		const bool ours = newestFile.has_value();   // newest exists and is our record's file
		if (ours && rec->sig == c.sig)
			return Verdict::Fresh;
		if (!c.loaded || !c.alive || !(c.distance >= 0.0f) || c.distance > kMaxDistance)
			return Verdict::NotHere;
		if (c.busy)
			return Verdict::Busy;
		if (triedThisLook)
			return Verdict::Tried;
		return ours ? Verdict::Refresh : Verdict::Take;
	}

	// Indices of the candidates to shoot this open: wanted ones, nearest first,
	// at most `limit`, never the same slug twice.
	inline std::vector<std::size_t> Pick(const std::vector<Candidate>& cs, const std::vector<Verdict>& vs,
		std::size_t limit = kPerOpen)
	{
		std::vector<std::size_t> idx;
		for (std::size_t i = 0; i < cs.size() && i < vs.size(); ++i)
			if (Wanted(vs[i]))
				idx.push_back(i);
		std::stable_sort(idx.begin(), idx.end(), [&](std::size_t a, std::size_t b) { return cs[a].distance < cs[b].distance; });
		std::vector<std::size_t> out;
		for (auto i : idx) {
			if (out.size() >= limit)
				break;
			bool dup = false;
			for (auto j : out)
				if (cs[j].slug == cs[i].slug)
					dup = true;
			if (!dup)
				out.push_back(i);
		}
		return out;
	}

	// The look signature: FNV-1a over the parts that change a FACE — race, head
	// parts, hair colour, facegen file, and anything worn in the hair slots that
	// is NOT head gear (a wig). Worn helmets are excluded on purpose: they are
	// hidden for the shot, so putting one on must not trigger a retake.
	inline std::string Signature(const std::vector<std::string>& parts)
	{
		std::uint64_t h = 1469598103934665603ull;
		for (const auto& p : parts) {
			for (unsigned char ch : p) {
				h ^= ch;
				h *= 1099511628211ull;
			}
			h ^= 0x1f;   // part separator, so {"ab","c"} != {"a","bc"}
			h *= 1099511628211ull;
		}
		static const char* hex = "0123456789abcdef";
		std::string out(16, '0');
		for (int i = 15; i >= 0; --i) {
			out[static_cast<std::size_t>(i)] = hex[h & 0xF];
			h >>= 4;
		}
		return out;
	}

	// "Has the picture stopped changing?" Frame generation and temporal
	// upscaling smear the first frames after a camera cut, so a fixed delay is
	// either too long (wasted blink) or too short (ghosted photo). Two small
	// probes of the same region are compared instead: mean absolute difference
	// per channel, 0..255.
	inline double MeanAbsDiff(const std::vector<std::uint8_t>& a, const std::vector<std::uint8_t>& b)
	{
		if (a.empty() || a.size() != b.size())
			return 255.0;
		std::uint64_t sum = 0;
		for (std::size_t i = 0; i < a.size(); ++i)
			sum += static_cast<std::uint64_t>(std::abs(static_cast<int>(a[i]) - static_cast<int>(b[i])));
		return static_cast<double>(sum) / static_cast<double>(a.size());
	}

	struct Settle
	{
		int    minMs = 180;       // never shoot before this (the cut itself)
		int    maxMs = 1500;      // shoot anyway after this, and say so in the log
		double stillDiff = 1.5;   // mean |delta| per channel counted as "still"
		int    stillRuns = 2;     // consecutive still comparisons needed

		int  runs = 0;
		bool timedOut = false;

		// Feed each probe comparison; true = take the photo now.
		bool Step(int elapsedMs, double diff)
		{
			runs = diff <= stillDiff ? runs + 1 : 0;
			if (elapsedMs >= maxMs) {
				timedOut = runs < stillRuns;
				return true;
			}
			return elapsedMs >= minMs && runs >= stillRuns;
		}
	};
}
