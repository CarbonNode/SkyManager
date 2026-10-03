#include "osis_runtime.h"
#include "osis_contract.h"
#include <Windows.h>
#include <bcrypt.h>
#include "json.hpp"
#include <array>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <sstream>
#include <vector>

namespace OsisRuntime {
namespace {
namespace C = OsisContract;
namespace fs = std::filesystem;
using json = nlohmann::json;
constexpr auto IniPath = "Data/SKSE/Plugins/OSIS.ini";
constexpr auto TablesPath = "Data/SKSE/Plugins/OSIS/morphs.json";
std::mutex bridgeMutex;
std::string Dump(const json& j) { return j.dump(-1,' ',false,json::error_handler_t::replace); }
bool Region(const void* address,size_t size,bool write=false) {
 MEMORY_BASIC_INFORMATION m{};
 if(!VirtualQuery(address,&m,sizeof(m))||m.State!=MEM_COMMIT||(m.Protect&(PAGE_NOACCESS|PAGE_GUARD)))return false;
 if(write&&!(m.Protect&(PAGE_READWRITE|PAGE_WRITECOPY|PAGE_EXECUTE_READWRITE|PAGE_EXECUTE_WRITECOPY)))return false;
 auto offset=reinterpret_cast<uintptr_t>(address)-reinterpret_cast<uintptr_t>(m.BaseAddress);
 return offset<=m.RegionSize&&size<=m.RegionSize-offset;
}
std::string Hash(HMODULE module) {
 std::array<wchar_t,32768> path{};auto n=GetModuleFileNameW(module,path.data(),static_cast<DWORD>(path.size()));
 if(!n||n>=path.size())return {};
 std::ifstream file(fs::path(path.data()),std::ios::binary|std::ios::ate);
 if(!file||file.tellg()!=static_cast<std::streamoff>(C::FileSize))return {};
 std::vector<uint8_t> bytes(C::FileSize);file.seekg(0);
 if(!file.read(reinterpret_cast<char*>(bytes.data()),bytes.size()))return {};
 struct Handles { BCRYPT_ALG_HANDLE alg{}; BCRYPT_HASH_HANDLE hash{};
  ~Handles(){if(hash)BCryptDestroyHash(hash);if(alg)BCryptCloseAlgorithmProvider(alg,0);} } h;
 std::array<uint8_t,32> result{};
 if(BCryptOpenAlgorithmProvider(&h.alg,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0||
  BCryptCreateHash(h.alg,&h.hash,nullptr,0,nullptr,0,0)<0||
  BCryptHashData(h.hash,bytes.data(),static_cast<ULONG>(bytes.size()),0)<0||
  BCryptFinishHash(h.hash,result.data(),static_cast<ULONG>(result.size()),0)<0)return {};
 constexpr char hex[]="0123456789abcdef";std::string out;
 for(auto v:result){out+=hex[v>>4];out+=hex[v&15];}return out;
}
bool Verified(HMODULE module) {
 if(!module)return false;
 const auto* base=reinterpret_cast<const uint8_t*>(module);
 if(!Region(base,sizeof(IMAGE_DOS_HEADER)))return false;
 const auto* dos=reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
 if(dos->e_magic!=IMAGE_DOS_SIGNATURE||dos->e_lfanew<0||dos->e_lfanew>4096)return false;
 const auto* nt=reinterpret_cast<const IMAGE_NT_HEADERS64*>(base+dos->e_lfanew);
 if(!Region(nt,sizeof(*nt))||nt->Signature!=IMAGE_NT_SIGNATURE||nt->FileHeader.Machine!=IMAGE_FILE_MACHINE_AMD64||
  nt->OptionalHeader.Magic!=IMAGE_NT_OPTIONAL_HDR64_MAGIC||nt->OptionalHeader.SizeOfImage!=C::ImageSize||nt->FileHeader.TimeDateStamp!=C::Timestamp)return false;
 for(const auto& f:C::Fingerprints)if(!Region(base+f.rva,f.hex.size()/2))return false;
 static HMODULE checked{};static std::string hash;
 if(checked!=module){hash=Hash(module);checked=module;}
 if(hash!=C::Sha256||!C::CodeMatches({base,C::ImageSize}))return false;
 for(const auto& f:C::Fields)if(!Region(base+f.rva,f.type==C::Type::boolean?1:4,true))return false;
 return Region(base+C::Lock,80,true)&&Region(base+C::Yield,5);
}
// PDB: Settings::lock is std::recursive_mutex, the very same storage passed
// to MSVCP140!_Mtx_lock by RenderGeneral and Settings::Save. Use that CRT's
// non-blocking operation, avoiding a private C++ mutex layout declaration.
struct OwnerLock {
 using Fn=int(__cdecl*)(void*);void* address{};Fn unlock{};bool held{};
 explicit OwnerLock(uint8_t* base){
  auto crt=GetModuleHandleW(L"MSVCP140.dll");
  auto take=reinterpret_cast<Fn>(GetProcAddress(crt,"_Mtx_trylock"));
  unlock=reinterpret_cast<Fn>(GetProcAddress(crt,"_Mtx_unlock"));address=base+C::Lock;
  held=take&&unlock&&take(address)==0;
 }
 ~OwnerLock(){if(held)unlock(address);}
};
std::string Trim(std::string s){auto a=s.find_first_not_of(" \t\r\n");if(a==std::string::npos)return {};return s.substr(a,s.find_last_not_of(" \t\r\n")-a+1);}
std::map<std::string,std::string> ReadIni(const char* path){
 std::map<std::string,std::string> result;std::ifstream f(path);std::string line,section;
 while(std::getline(f,line)){
  line=Trim(line);if(line.empty()||line[0]==';'||line[0]=='#')continue;
  if(line[0]=='['){auto end=line.find(']');if(end!=std::string::npos)section=line.substr(1,end-1);continue;}
  auto eq=line.find('=');if(eq==std::string::npos)continue;
  result[section+"."+Trim(line.substr(0,eq))]=Trim(line.substr(eq+1,line.find(';',eq)-eq-1));
 }return result;
}
json Value(uint8_t* base,const C::Field& f){
 auto* p=base+f.rva;
 if(f.type==C::Type::boolean){uint8_t v=*p;if(v>1)throw std::runtime_error("OSIS returned an invalid switch value");return v!=0;}
 if(f.type==C::Type::integer){int32_t v;std::memcpy(&v,p,4);return v;}
 float v;std::memcpy(&v,p,4);if(!std::isfinite(v))throw std::runtime_error("OSIS returned a non-finite setting");return v;
}
void Put(uint8_t* base,const C::Field& f,const json& value){
 auto* p=base+f.rva;
 if(f.type==C::Type::boolean){*p=value.get<bool>()?1:0;return;}
 if(f.type==C::Type::integer){auto v=value.get<int32_t>();std::memcpy(p,&v,4);return;}
 auto v=value.get<float>();std::memcpy(p,&v,4);
}
bool Saved(const C::Field& f,const json& v,const std::map<std::string,std::string>& ini){
 auto it=ini.find(f.id);if(it==ini.end())return false;
 try {
  if(f.type==C::Type::boolean)return it->second==(v.get<bool>()?"true":"false")||it->second==(v.get<bool>()?"1":"0");
  size_t n{};auto d=std::stod(it->second,&n);if(n!=it->second.size()||!std::isfinite(d))return false;
  // OSIS serializes floats with %.3f. Compare at the owner's persistence
  // precision instead of reporting a successful rounded save as unsaved.
  if(f.type==C::Type::number){char encoded[80]{};std::snprintf(encoded,sizeof(encoded),"%.3f",v.get<double>());return std::abs(d-std::stod(encoded))<.000001;}
  return d==v.get<double>();
 }catch(...){return false;}
}
int BodySlots(){
 auto ini=ReadIni("Data/SKSE/Plugins/skee64.ini");auto i=ini.find("Overlays/Body.iNumOverlays");
 if(i==ini.end())return 0;try{return std::stoi(i->second);}catch(...){return 0;}
}
std::string Revision(uint8_t* base){
 // Optimistic concurrency covers every field, so a second menu cannot apply
// a toggle to an old snapshot. Session identity changes on every new process.
 uint64_t hash=14695981039346656037ull;
 for(const auto& f:C::Fields){auto s=Value(base,f).dump();for(auto c:s){hash^=static_cast<unsigned char>(c);hash*=1099511628211ull;}}
 for(size_t n=0;n<5;++n){hash^=base[C::Yield+n];hash*=1099511628211ull;}
 return std::to_string(GetCurrentProcessId())+":"+std::to_string(reinterpret_cast<uintptr_t>(base))+":"+std::to_string(hash);
}
std::string BlushReason(uint8_t* base){
 int32_t first{},count{};std::memcpy(&first,base+0xfd538,4);std::memcpy(&count,base+0xfd534,4);
 auto slots=BodySlots();if(first<0||count<=0||first>32||count>32||first+count>slots)
  return "Body blush needs more RaceMenu body overlay slots than this setup provides. Current capacity: "+std::to_string(slots)+".";
 return {};
}
json State(uint8_t* base){
 auto ini=ReadIni(IniPath);json rows=json::array();int unsaved=0;const auto blush=BlushReason(base);
 for(const auto& f:C::Fields){
  auto value=Value(base,f);const bool saved=Saved(f,value,ini);if(!saved)++unsaved;
  json r={{"id",f.id},{"group",f.group},{"label",f.label},{"detail",f.detail},{"value",value},{"saved",saved},
   {"type",f.type==C::Type::boolean?"bool":f.type==C::Type::integer?"int":"float"},
   {"min",f.min},{"max",f.max},{"step",f.step},{"reason",f.reason},{"module",std::string(f.key)=="bEnabled"}};
  if(std::string(f.id)=="Arousal.bBlush")r["enableReason"]=blush;
  if(std::string(f.key)=="bEnabled"&&std::string(f.section)!="General"){
   int index=std::string(f.section)=="Face"?0:std::string(f.section)=="Body"?1:std::string(f.section)=="Skin"?2:std::string(f.section)=="LipSync"?3:4;
   if(base[C::Yield+index]>1)throw std::runtime_error("OSIS compatibility state was not valid");
   if(base[C::Yield+index])r["reason"]="OSIS is yielding this module to another installed mod for this session.";
  }
  rows.push_back(std::move(r));
 }
 return {{"ok",true},{"installed",true},{"supported",true},{"rows",rows},{"revision",Revision(base)},
  {"unsaved",unsaved},{"msg","Live OSIS settings. Changes use OSIS's own Save action."}};
}
bool Backup(){
 static bool ready=false;if(ready)return true;
 const auto target=fs::path("Data/SKSE/Plugins/HotkeyDeck/osis-backups")/(std::to_string(GetCurrentProcessId())+"-"+std::to_string(GetTickCount64()));
 std::error_code ec;fs::create_directories(target,ec);if(ec)return false;
 for(const auto* p:{IniPath,TablesPath})if(fs::exists(p)){
  if(!fs::copy_file(p,target/fs::path(p).filename(),fs::copy_options::none,ec)||ec)return false;
 }
 ready=true;return true;
}
}
std::string Control(const std::string& request){
 std::lock_guard bridgeLock(bridgeMutex);
 try {
  auto req=json::parse(request,nullptr,false);if(!req.is_object())return Dump({{"ok",false},{"msg","Invalid OSIS request."}});
  auto module=GetModuleHandleW(L"OSIS.dll");
  if(!module)return Dump({{"ok",false},{"installed",false},{"supported",false},{"msg","OSIS is not loaded. Enable it in the test profile and relaunch through MO2."}});
  if(!Verified(module))return Dump({{"ok",false},{"installed",true},{"supported",false},{"msg","This OSIS version has not been verified for SkyManager controls. Use OSIS's own menu."}});
  auto* base=reinterpret_cast<uint8_t*>(module);OwnerLock owner(base);
  if(!owner.held)return Dump({{"ok",false},{"installed",true},{"supported",true},{"msg","OSIS is updating its settings. Refresh and try again."}});
  const auto op=req.value("op","state");auto state=State(base);
  auto fail=[&](const char* message){state["ok"]=false;state["msg"]=message;return Dump(state);};
  if(op=="state")return Dump(state);
  if(op!="set"&&op!="save")return fail("Unknown OSIS action.");
  if(req.value("revision","")!=state["revision"].get<std::string>())return fail("OSIS settings changed. Review the refreshed values before trying again.");
  const C::Field* selected=nullptr;
  if(op=="set"){
   const auto id=req.value("id","");for(const auto& f:C::Fields)if(id==f.id){selected=&f;break;}
   if(!selected||!req.contains("value"))return fail("That OSIS setting is not available.");
   for(const auto& row:state["rows"])if(row["id"]==id&&!row["reason"].get<std::string>().empty())return fail("This setting is read-only. Check its explanation.");
   const auto& v=req["value"];const auto& f=*selected;
   if(f.type==C::Type::boolean){if(!v.is_boolean())return fail("This setting requires an on/off value.");}
   else {
    if(!v.is_number()||v.is_boolean())return fail("Enter a number for this setting.");
    const auto n=v.get<double>();if(!std::isfinite(n)||n<f.min-.000001||n>f.max+.000001||(f.type==C::Type::integer&&std::floor(n)!=n))return fail("That value is outside the supported range.");
   }
   if(id=="Arousal.bBlush"&&v.get<bool>()&&!BlushReason(base).empty())return fail("Body blush cannot be enabled with the current RaceMenu overlay allocation.");
   if(id=="Face.fAnimeStart"||id=="Face.fAnimeEnd"){
    float start{},end{};std::memcpy(&start,base+0xfd690,4);std::memcpy(&end,base+0xfd68c,4);
    if((id=="Face.fAnimeStart"&&v.get<float>()<end)||(id=="Face.fAnimeEnd"&&v.get<float>()>start))return fail("The anime end threshold must be no higher than its start threshold.");
   }
  }
  if(!Backup())return fail("Could not back up OSIS settings; nothing was changed.");
  if(selected)Put(base,*selected,req["value"]);
  // This also sanitizes the settings and saves the current morph/blush tables,
  // exactly as the owner's menu does. Never reload stale disk state here.
  const bool saved=reinterpret_cast<bool(__cdecl*)()>(base+C::Save)();
  state=State(base);state["ok"]=saved;state["applied"]=selected!=nullptr;state["saved"]=saved;
  state["msg"]=saved?"Applied and saved by OSIS. Close SkyManager to see the effect.":"The live setting changed, but OSIS could not finish saving. Review it, then use Save current settings.";
  return Dump(state);
 }catch(const std::exception& e){return Dump({{"ok",false},{"msg",std::string("OSIS settings could not be completed: ")+e.what()}});}
}
}
