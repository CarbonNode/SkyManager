#include "custom_markers.h"
#include "custom_markers_bindings.h"
#include "custom_markers_contract.h"
#include "custom_markers_runtime.h"

#include <atomic>
#include <chrono>
#include <fstream>
#include <filesystem>
#include <iterator>
#include <thread>

namespace CustomMarkers
{
	namespace
	{
		using namespace CustomMarkersBindings;
		std::atomic<bool> sending{false};
		void Notify(const char* text)
		{
			logger::info("custom-markers: {}",text);
			SKSE::GetTaskInterface()->AddTask([message=std::string(text)](){RE::DebugNotification(message.c_str());});
		}
		bool Foreground()
		{
			DWORD pid=0; GetWindowThreadProcessId(GetForegroundWindow(),&pid);
			return pid==GetCurrentProcessId();
		}
		bool Send(std::uint32_t code, bool down)
		{
			INPUT input{};
			if(code<256) {
				input.type=INPUT_KEYBOARD; input.ki.wScan=static_cast<WORD>(code&0x7F);
				input.ki.dwFlags=KEYEVENTF_SCANCODE | (code>0x7F?KEYEVENTF_EXTENDEDKEY:0) | (down?0:KEYEVENTF_KEYUP);
			} else {
				input.type=INPUT_MOUSE;
				static constexpr DWORD flags[5][2]={{MOUSEEVENTF_LEFTUP,MOUSEEVENTF_LEFTDOWN},{MOUSEEVENTF_RIGHTUP,MOUSEEVENTF_RIGHTDOWN},
					{MOUSEEVENTF_MIDDLEUP,MOUSEEVENTF_MIDDLEDOWN},{MOUSEEVENTF_XUP,MOUSEEVENTF_XDOWN},{MOUSEEVENTF_XUP,MOUSEEVENTF_XDOWN}};
				input.mi.dwFlags=flags[code-256][down?1:0];
				if(code>=259) input.mi.mouseData=code==259?XBUTTON1:XBUTTON2;
			}
			return SendInput(1,&input,sizeof(input))==1;
		}
		bool KeysReleased(std::uint32_t key)
		{
			for(int v:{VK_LMENU,VK_RMENU,VK_LCONTROL,VK_RCONTROL,VK_LSHIFT,VK_RSHIFT})
				if(GetAsyncKeyState(v)&0x8000) return false;
			static constexpr int mouse[]={VK_LBUTTON,VK_RBUTTON,VK_MBUTTON,VK_XBUTTON1,VK_XBUTTON2};
			const auto vk=key>=256?mouse[key-256]:MapVirtualKeyW((key&0x7F)|(key>0x7F?0xE000:0),MAPVK_VSC_TO_VK_EX);
			return vk && !(GetAsyncKeyState(vk)&0x8000);
		}
		std::string ReadIni()
		{
			// Same primary/legacy precedence as Custom Markers. Never read a
			// physical mod folder: MO2's merged Data owns the selected settings.
			for(const char* path:{"Data/SKSE/Plugins/CustomMarkers.ini","Data/SKSE/Plugins/CustomMapMarkers.ini"}) {
				std::error_code error;
				const bool exists=std::filesystem::exists(path,error);
				if(error) return {};
				if(!exists) continue;
				std::ifstream input(path,std::ios::binary|std::ios::ate);
				if(!input) return {};
				auto size=input.tellg(); if(size<0 || size>131072) return {};
				input.seekg(0); return std::string(std::istreambuf_iterator<char>(input),std::istreambuf_iterator<char>());
			}
			return {};
		}
	}
	bool Present(){return GetModuleHandleA("CustomMarkers.dll")!=nullptr;}
	bool HasToggleHotkeys()
	{
		const auto module=GetModuleHandleA("CustomMarkers.dll");
		if(!module) return false;
		const auto* version=reinterpret_cast<const SKSE::PluginVersionData*>(GetProcAddress(module,"SKSEPlugin_Version"));
		// Public SKSE version record, not private DLL memory/function offsets.
		return version && version->dataVersion==1 && version->GetPluginVersion()>=REL::Version{1,2,4,0};
	}
	bool HasCombatToggle(){return CustomMarkersRuntime::Supported();}
	bool SupportsAction(const std::string& action)
	{
		if(action == CustomMarkersContract::CombatAction) return HasCombatToggle();
		const auto* spec = Find(action);
		return spec && Present() && (!spec->toggle || HasToggleHotkeys());
	}
	bool IsAction(const std::string& action){return action == CustomMarkersContract::CombatAction || Find(action)!=nullptr;}
	bool SendingInput(){return sending.load();}
	void Fire(const std::string& action)
	{
		if(action == CustomMarkersContract::CombatAction) {
			using Status = CustomMarkersRuntime::Status;
			const auto result = CustomMarkersRuntime::ToggleCombat();
			if(result.status == Status::unsupported) return Notify("Combat toggle needs the verified Custom Markers 1.2.7 build");
			if(result.status == Status::notReady) return Notify("Load your game before toggling loot beams during combat");
			const auto ini = ReadIni();
			const auto value = Value(ini, "NavigationOverlay", "LootBeamHideInCombat");
			const bool saved = result.status == Status::changed && value && (result.showInCombat ?
				(Equal(*value, "false") || *value == "0") : (Equal(*value, "true") || *value == "1"));
			logger::info("custom-markers-combat: saved={} show={}", saved, result.showInCombat);
			std::string message = result.showInCombat ? "Loot beams: shown during combat" : "Loot beams: hidden during combat";
			if(!saved) message += " (this session only; settings save not confirmed)";
			else if(!result.beamsEnabled) message += " (master beam switch is off)";
			Notify(message.c_str()); return;
		}
		const auto* spec=Find(action); if(!spec) return;
		if(!Present()) return Notify("Custom Markers is not loaded");
		if(spec->toggle && !HasToggleHotkeys()) return Notify("Loot and radar hotkeys need Custom Markers 1.2.4 or newer");
		if(sending.exchange(true)) return;
		std::thread([spec](){
			using namespace std::chrono_literals;
			const auto binding=Read(ReadIni(),*spec);
			if(binding.status!=Status::ready) {
				if(binding.status==Status::invalid) Notify("Custom Markers has an unsupported binding; choose a keyboard key or mouse button in its Hotkeys settings");
				else Notify("Set and Save this binding in Custom Markers HUD Settings > Hotkeys first");
				sending=false; return;
			}
			std::this_thread::sleep_for(180ms);
			// Let the key/chord that fired the deck action go. Never release a
			// physically-held modifier on the player's behalf.
			for(int n=0;n<40 && Foreground() && !KeysReleased(binding.key);++n) std::this_thread::sleep_for(20ms);
			if(!Foreground() || !KeysReleased(binding.key)) {
				Notify("Release the shortcut keys with Skyrim focused, then try again"); sending=false; return;
			}
			SKSE::GetTaskInterface()->AddTask([spec,binding](){
				auto* ui=RE::UI::GetSingleton();
				auto* player=RE::PlayerCharacter::GetSingleton();
				if(!ui || ui->GameIsPaused() || !player || !player->GetParentCell() || !Foreground()) {
					Notify("Close other menus before using Custom Markers"); sending=false; return;
				}
				std::thread([spec,binding](){
					const auto modifier=Modifiers[binding.modifier].scan;
					bool modDown=false, keyDown=false;
					if(Foreground()) {
						modDown=modifier && Send(modifier,true);
						if(!modifier || modDown) {
							std::this_thread::sleep_for(25ms);
							if(Foreground()) keyDown=Send(binding.key,true);
							std::this_thread::sleep_for(80ms);
							if(keyDown) Send(binding.key,false);
						}
						if(modDown) Send(modifier,false);
					}
					logger::info("custom-markers: forwarded action={} key={} modifier={} sent={}",spec->action,binding.key,binding.modifier,keyDown);
					if(!keyDown) Notify("Could not send the Custom Markers shortcut");
					// Keep our trigger sink out of the echoed press/release, even
					// when the same key is assigned as the deck entry's Trigger.
					std::this_thread::sleep_for(180ms); sending=false;
				}).detach();
			});
		}).detach();
	}
}
