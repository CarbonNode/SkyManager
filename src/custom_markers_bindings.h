#pragma once

// Custom Markers' own INI contract. Modifier is an ENUM, not a DIK or mask.
// Verified against rijosan87/CustomMarkers InputHandler.cpp and the installed
// 1.2.2 INI; the two toggle field names were checked in Nexus 1.2.7's DLL.
// This parser is shared with the Keys census; never interpret entity filters
// such as GlanceEntLootKey=1 as keyboard bindings.
#include <array>
#include <charconv>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace CustomMarkersBindings
{
	struct Spec { const char* action; const char* label; const char* section; const char* key; const char* modifier; bool toggle; };
	inline constexpr std::array<Spec, 3> Actions{{
		{ "custom-markers-settings", "Custom Markers settings", "Menu", "SettingsKey", "SettingsModifier", false },
		{ "custom-markers-loot", "Loot beams", "NavigationOverlay", "LootBeamToggleKeyDIK", "LootBeamToggleModifier", true },
		{ "custom-markers-radar", "Mini Radar", "NavigationOverlay", "GlanceToggleKeyDIK", "GlanceToggleModifier", true }
	}};
	inline constexpr std::array<Spec, 6> OtherBindings{{
		{ "", "Map marker list", "Hotkey", "ListPanelKey", "ListPanelModifier", false },
		{ "", "Path tracking", "Hotkey", "PathTrackKey", "PathTrackModifier", false },
		{ "", "Inspect map", "NavigationOverlay", "InspectKeyDIK", "InspectModifier", false },
		{ "", "Inspect mode", "NavigationOverlay", "InspectModeToggleKeyDIK", "InspectModeToggleModifier", false },
		{ "", "Quick marker", "NavigationOverlay", "QuickMarkKeyDIK", "QuickMarkModifier", false },
		{ "", "Look and pin", "LookPin", "KeyDIK", "Modifier", false }
	}};
	struct Modifier { std::uint32_t scan; const char* label; };
	inline constexpr std::array<Modifier, 10> Modifiers{{
		{0, ""}, {0x38, "Alt"}, {0x1D, "Ctrl"}, {0x2A, "Shift"},
		{0x38, "LAlt"}, {0xB8, "RAlt"}, {0x1D, "LCtrl"}, {0x9D, "RCtrl"},
		{0x2A, "LShift"}, {0x36, "RShift"}
	}};
	inline std::string_view Trim(std::string_view s)
	{
		const auto a=s.find_first_not_of(" \t\r\n");
		return a==s.npos ? std::string_view{} : s.substr(a,s.find_last_not_of(" \t\r\n")-a+1);
	}
	inline bool Equal(std::string_view a, std::string_view b)
	{
		if(a.size()!=b.size()) return false;
		for(std::size_t i=0;i<a.size();++i) {
			auto lower=[](char c){return c>='A'&&c<='Z'?c+('a'-'A'):c;};
			if(lower(a[i])!=lower(b[i])) return false;
		}
		return true;
	}
	inline std::optional<std::string_view> Value(std::string_view text, std::string_view section, std::string_view key)
	{
		if(text.substr(0,3)=="\xEF\xBB\xBF") text.remove_prefix(3);
		bool inSection=false;
		std::optional<std::string_view> result;
		while(!text.empty()) {
			auto end=text.find('\n');
			auto line=Trim(text.substr(0,end));
			text=end==text.npos?std::string_view{}:text.substr(end+1);
			if(line.empty() || line[0]==';' || line[0]=='#') continue;
			if(line[0]=='[') {auto close=line.find(']'); inSection=close!=line.npos && Equal(Trim(line.substr(1,close-1)),section); continue;}
			auto eq=line.find('=');
			if(inSection && eq!=line.npos && Equal(Trim(line.substr(0,eq)),key)) {
				auto value=line.substr(eq+1); value=value.substr(0,value.find_first_of(";#")); result=Trim(value);
			}
		}
		return result;
	}
	inline std::optional<int> Integer(std::string_view s)
	{
		s=Trim(s); int base=10;
		if(s.empty()) return std::nullopt;
		if(s.size()>2 && s[0]=='0' && (s[1]=='x'||s[1]=='X')) {base=16; s.remove_prefix(2);}
		int out=0; const auto r=std::from_chars(s.data(),s.data()+s.size(),out,base);
		return r.ec==std::errc{} && r.ptr==s.data()+s.size()?std::optional<int>{out}:std::nullopt;
	}
	enum class Status { ready, missing, unbound, invalid };
	struct Binding { Status status=Status::missing; std::uint32_t key=0; int modifier=0; };
	inline Binding Read(std::string_view text, const Spec& spec)
	{
		auto k=Value(text,spec.section,spec.key), m=Value(text,spec.section,spec.modifier);
		if(!k) return {};
		auto code=Integer(*k);
		if(code && (*code==0 || *code==-1)) return {Status::unbound};
		auto mod=m?Integer(*m):std::nullopt;
		if(!code || !mod || *code<1 || *code>260 || *mod<0 || *mod>=int(Modifiers.size())) return {Status::invalid};
		for(auto modifier:Modifiers) if(modifier.scan && *code==int(modifier.scan)) return {Status::invalid};
		return {Status::ready,static_cast<std::uint32_t>(*code),*mod};
	}
	inline const Spec* Find(std::string_view action)
	{
		for(const auto& spec:Actions) if(action==spec.action) return &spec;
		return nullptr;
	}
}
