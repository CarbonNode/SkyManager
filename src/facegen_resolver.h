#pragma once
#include <string>

namespace FaceGenResolver
{
	// MAIN THREAD ONLY. Existing FaceGeom first; verified plugin + EditorID
	// compatibility fallback second. Returns a mesh-relative path or empty.
	// Used by roster/Finder availability, render queues and face turntables.
	// Reads the existing VFS; never writes game assets or changes actor data.
	std::string Resolve(const std::string& fid, const std::string& plugin);
}
