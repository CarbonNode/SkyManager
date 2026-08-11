#include "follower_deck.h"

// pch (force-included) provides RE::/SKSE::/json, logger and Windows.h via SKSE.

namespace
{
	using GetStateFn = const char* (*)();
	using ApplyFn = const char* (*)(const char*);

	GetStateFn g_getState = nullptr;
	ApplyFn    g_apply = nullptr;
	bool       g_resolveTried = false;

	// FO's DLL is a fellow SKSE plugin in this same process; one resolve
	// attempt is enough (plugins never load after kPostLoad).
	void Resolve()
	{
		if (g_resolveTried)
			return;
		g_resolveTried = true;
		const auto mod = GetModuleHandleA("FollowerOrganizer.dll");
		if (!mod) {
			logger::warn("FollowerDeck: FollowerOrganizer.dll not loaded");
			return;
		}
		g_getState = reinterpret_cast<GetStateFn>(GetProcAddress(mod, "FollowerDeck_GetState"));
		g_apply = reinterpret_cast<ApplyFn>(GetProcAddress(mod, "FollowerDeck_Apply"));
		if (!g_getState || !g_apply) {
			logger::warn("FollowerDeck: FollowerOrganizer.dll has no Deck API (needs our fork >= 0.2.0)");
			g_getState = nullptr;
			g_apply = nullptr;
		} else {
			logger::info("FollowerDeck: FO Deck API resolved");
		}
	}

	std::string Unavailable()
	{
		// Delimited raw string: the message itself contains `)"` (after "API"),
		// which would terminate a bare R"(...)" early.
		return R"json({"ok":false,"msg":"Follower Organizer isn't loaded (needs the patched build with the Deck API)","state":{"categories":[],"total":0}})json";
	}
}

namespace FollowerDeck
{
	bool Available()
	{
		Resolve();
		return g_getState != nullptr;
	}

	std::string StateJson()
	{
		Resolve();
		if (!g_getState)
			return Unavailable();
		const char* r = g_getState();
		return r ? std::string(r) : Unavailable();
	}

	std::string Apply(const std::string& cmdJson)
	{
		Resolve();
		if (!g_apply)
			return Unavailable();
		const char* r = g_apply(cmdJson.c_str());
		return r ? std::string(r) : Unavailable();
	}
}
