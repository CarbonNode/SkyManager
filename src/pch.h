#pragma once

#pragma warning(push)
#include <RE/Skyrim.h>
#include <REL/Relocation.h>
#include <SKSE/SKSE.h>

#include <filesystem>
#include <fstream>

#ifdef NDEBUG
#	include <spdlog/sinks/basic_file_sink.h>
#else
#	include <spdlog/sinks/msvc_sink.h>
#endif
#pragma warning(pop)

#include <json.hpp>

using namespace std::literals;

namespace logger = SKSE::log;

#define DLLEXPORT __declspec(dllexport)

/* ⛔ PathU8 — the ONLY way to turn a std::filesystem::path into text.
 *
 * NEVER call path::string() or path::generic_string(). On Windows a path is
 * UTF-16 and those convert it to the ANSI code page, which THROWS
 * std::system_error the moment a character will not fit. Every path we touch
 * comes from somewhere we do not control — a mod folder name, an enumerated
 * file, the user's install directory — so "it has always been ASCII here" is
 * a property of one machine, not of the code.
 *
 * That is not theoretical. On 2026-08-19 the Distributions tab reported "no
 * distribution files found" on a load order carrying 374 of them, because a
 * single Japanese-named readme — Kingsglaive仕様アニメイベント.txt, dropped
 * into Data by an MCO moveset — was lowercased before the scanner tested the
 * suffix. The throw was swallowed and the whole index came back empty.
 *
 * u8string() cannot fail, and UTF-8 is what everything downstream wants
 * anyway: the PrismaUI bridge, JSON, and the log sink are all UTF-8. ANSI was
 * the wrong answer even when it got away with not throwing — it silently
 * mangled any name it could not represent.
 *
 * For OPENING a file, do not convert at all: pass the path itself. ifstream,
 * ofstream and std::filesystem all take one and use the wide API.
 *
 * tools/check_path_string.py enforces this on every commit. */
inline std::string PathU8(const std::filesystem::path& p)
{
	const auto s = p.u8string();
	return std::string(reinterpret_cast<const char*>(s.data()), s.size());
}
