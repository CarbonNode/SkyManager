#include "scene_privacy.h"
#include "ostim_deck.h"
#include "ostim_thread_api.h"
#include "ostim_scene_api.h"
#include "loot_highlight.h"
#include "journal.h"
#include "facelight.h"
#include "quick_light.h"
#include "sos_actions.h"
#include "npc_clearance.h"
#include "ppa_config.h"
#include "skyui_mcm.h"
#include "relight_config.h"
#include "scene_tags.h"
#include <thread>
#include <chrono>
#include <atomic>
#include <cmath>
#include <unordered_map>
#include <algorithm>
#ifdef GetObject
#undef GetObject
#endif
#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif
namespace OstimDeck {
namespace {
using json = nlohmann::json;
namespace OT = OstimNG_API::Thread;
namespace OS = OstimNG_API::Scene;
using Reply = std::function<void(std::string)>;
std::uint64_t epoch=0;
std::atomic_uint64_t sceneGeneration{0};
std::unordered_map<uint32_t,Facelight::Snapshot> lightUndo;
uint64_t lightGeneration=0;
std::chrono::steady_clock::time_point quickLightSent;
bool quickLightPending=false,quickLightDesired=false;
int RestoreLights(){
 int failed=0;
 for(auto it=lightUndo.begin();it!=lightUndo.end();){
  if(Facelight::Restore(it->first,it->second))it=lightUndo.erase(it);else{++failed;++it;}
 }
 return failed;
}
std::unordered_map<uint32_t,std::pair<uint64_t,int>> sizeOriginal;
std::unordered_map<uint32_t,uint64_t> expressionSerial;
std::unordered_map<uint32_t,std::chrono::steady_clock::time_point> actorBusy;
std::string scanToken, scanScene;
std::unordered_map<std::uint32_t,json> furniture;
std::chrono::steady_clock::time_point scanned;
std::vector<std::string> optionIds;
std::vector<std::string> optionKeys;
std::string OptionKey(const OT::OptionsMenuItem& v){return json::array({v.id?v.id:"",v.title?v.title:"",v.description?v.description:""}).dump();}
std::string optionToken;
std::string Dump(const json& j) { return j.dump(-1,' ',false,json::error_handler_t::replace); }
OT::IThreadInterface* Api() { static OT::IThreadInterface* api=nullptr; if(!api){api=OT::GetAPI("SkyManager",REL::Version(1,0,0,0));if(api)api->RegisterEventCallback([](OT::ThreadEvent event,uint32_t id,void*){if(id==0&&(event==OT::ThreadEvent::ThreadStarted||event==OT::ThreadEvent::ThreadEnded)){
 const auto old=sceneGeneration.fetch_add(1);
 SKSE::GetTaskInterface()->AddTask([old](){if(!lightUndo.empty()&&lightGeneration<=old){const auto failed=RestoreLights();if(failed)logger::warn("ostim lighting: could not restore {} actor(s)",failed);}});
}},nullptr);} return api; }
std::string Signature() {
 auto* a=Api(); if(!a || !a->IsThreadValid(0))return "";
 std::string key=std::to_string(sceneGeneration.load())+":"+(a->GetCurrentSceneID(0)?a->GetCurrentSceneID(0):"");
 std::vector<OT::ActorData> actors(a->GetActorCount(0));
 auto n=actors.empty()?0:a->GetActors(0,actors.data(),static_cast<uint32_t>(actors.size()));
 for(uint32_t i=0;i<n;++i)key+="/"+std::to_string(actors[i].formID);
 return key;
}
class Callback final : public RE::BSScript::IStackCallbackFunctor {
 std::function<void(RE::BSScript::Variable)> fn;
public:
 explicit Callback(std::function<void(RE::BSScript::Variable)> f):fn(std::move(f)){}
 void operator()(RE::BSScript::Variable v) override {
  auto f=fn; SKSE::GetTaskInterface()->AddTask([f,v]() mutable { f(v); });
 }
 bool CanSave() const override{return false;}
 void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override{}
};
template<class... Args> bool Call(const char* cls,const char* fn,std::function<void(RE::BSScript::Variable)> cb,Args... args){
 auto* vm=RE::BSScript::Internal::VirtualMachine::GetSingleton();if(!vm)return false;
 RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> c(new Callback(std::move(cb)));
 return vm->DispatchStaticCall(cls,fn,RE::MakeFunctionArguments(std::move(args)...),c);
}
RE::TESObjectREFR* Ref(const RE::BSScript::Variable& v){
 if(!v.IsObject()||v.IsNoneObject())return nullptr;
 auto o=v.GetObject();auto* vm=RE::BSScript::Internal::VirtualMachine::GetSingleton();
 auto* p=vm?vm->GetObjectHandlePolicy():nullptr;
 if(!o||!p||!p->HandleIsType(RE::FormType::Reference,o->GetHandle()))return nullptr;
 auto* form=p->GetObjectForHandle(RE::FormType::Reference,o->GetHandle());
 return form?form->As<RE::TESObjectREFR>():nullptr;
}
bool Nearby(RE::TESObjectREFR* r){
 auto* pc=RE::PlayerCharacter::GetSingleton();
 return pc&&r&&!r->IsDisabled()&&!r->IsDeleted()&&r->Get3D()&&r->GetParentCell()==pc->GetParentCell()&&pc->GetPosition().GetSquaredDistance(r->GetPosition())<2560.f*2560.f;
}
void Scan(const json& req, Reply reply, int setupCount=0, std::string setupKey=""){
 auto* a=Api();auto* pc=RE::PlayerCharacter::GetSingleton();
 const auto sig=setupCount?"setup:"+setupKey+":"+std::to_string(setupCount):Signature();if(!a||!pc||sig.empty()){reply(Dump({{"ok",false},{"msg","Start a player scene first"},{"request",req.value("request","")}}));return;}
 const auto ticket=++epoch; furniture.clear();scanToken.clear();
 const int count=setupCount?setupCount:static_cast<int>(a->GetActorCount(0));
 const float radius=std::clamp(req.value("radius",60.f),20.f,200.f)*64.f/3.f;
 // OFurniture's SameFloor is a Z tolerance, and the 150 units (~7 ft) this
 // used to hardcode is why "there are more beds in the house I'm in" was
 // true and the list still showed one: anything up a staircase was out of
 // range vertically no matter how big the radius got. It is a control now,
 // not a constant, so the page can say which question it asked.
 const float sameFloor=req.value("floors",false)?4000.f:150.f;
 auto finish=[req,reply,sig,ticket,setupCount](json rows){
  if(ticket!=epoch||(!setupCount && sig!=Signature())){reply(Dump({{"ok",false},{"msg","Scene changed; rescan furniture"},{"request",req.value("request","")}}));return;}
  std::sort(rows.begin(),rows.end(),[](const json& x,const json& y){return x.value("feet",0.f)<y.value("feet",0.f);});
  scanScene=sig;scanToken=std::to_string(ticket);scanned=std::chrono::steady_clock::now();
  for(auto& row:rows)furniture[row["formId"].get<uint32_t>()]=row;
  reply(Dump({{"ok",true},{"request",req.value("request","")},{"token",scanToken},{"signature",sig},{"rows",rows},{"msg","Closest available choice per furniture type"}}));
 };
 bool sent=Call("OFurniture","FindFurniture",[finish,req,reply](RE::BSScript::Variable v){
  if(!v.IsArray()){reply(Dump({{"ok",false},{"request",req.value("request","")},{"msg","OStim did not return a furniture list"}}));return;}
  auto rows=std::make_shared<json>(json::array());auto pending=std::make_shared<int>(1);size_t asked=0;
  if(v.IsArray()&&v.GetArray())for(auto& slot:*v.GetArray()){
   auto* r=Ref(slot);if(!Nearby(r)||asked>=64)continue;
   const auto fid=r->GetFormID();const auto pos=r->GetPosition();auto* pc=RE::PlayerCharacter::GetSingleton();
   json row={{"formId",fid},{"name",r->GetName()?r->GetName():"Furniture"},{"feet",std::round(std::sqrt(pc->GetPosition().GetSquaredDistance(pos))*3.f/64.f)}};
   ++*pending;++asked;
   if(!Call("OFurniture","GetFurnitureType",[rows,pending,finish,row](RE::BSScript::Variable value) mutable {
    const std::string type=value.IsString()?std::string(value.GetString()):"none";
    if(!type.empty()&&type!="none"){row["type"]=type;rows->push_back(row);}
    if(--*pending==0)finish(*rows);
   },r))--*pending;
  }
  if(--*pending==0)finish(*rows);
 },count,static_cast<RE::TESObjectREFR*>(pc),radius,sameFloor);
 if(!sent)reply(Dump({{"ok",false},{"request",req.value("request","")},{"msg","OStim furniture search is unavailable"}}));
}
json State(){
 json out=json::parse(StateJson());out["signature"]=Signature();auto* a=Api();
 if(out.value("inScene",false)&&a){
  auto& actors=out["actors"];
  for(size_t i=0;i<actors.size();++i){OT::ActorAlignmentData d{};if(a->GetActorAlignment(0,static_cast<uint32_t>(i),&d))actors[i]["alignment"]={{"x",d.offsetX},{"y",d.offsetY},{"z",d.offsetZ},{"rotation",d.rotation}};}
 }
 return out;
}
RE::Actor* Participant(uint32_t fid){
 auto* a=Api();auto* actor=RE::TESForm::LookupByID<RE::Actor>(fid);
 return a&&a->IsThreadValid(0)&&a->GetActorPosition(0,fid)>=0&&actor&&actor->Get3D()?actor:nullptr;
}
json LightingState(){
 auto quick=json::parse(QuickLight::StateJson());
 if(quickLightPending&&(quick.value("on",false)==quickLightDesired||std::chrono::steady_clock::now()-quickLightSent>std::chrono::seconds(12)))quickLightPending=false;
 quick["pending"]=quickLightPending;
 json out={{"ok",true},{"faces",json::array()},{"quick",quick},{"undoCount",lightUndo.size()},
  {"relight",GetModuleHandleW(L"ReLight.dll")!=nullptr},{"editor",GetModuleHandleW(L"SKSEMenuFramework.dll")!=nullptr}};
 auto* api=Api();if(!api||!api->IsThreadValid(0))return out;
 std::vector<OT::ActorData> actors(api->GetActorCount(0));
 const auto n=actors.empty()?0:api->GetActors(0,actors.data(),static_cast<uint32_t>(actors.size()));
 for(uint32_t i=0;i<n;++i)out["faces"].push_back(json::parse(Facelight::StateJson(actors[i].formID)));
 return out;
}
void LightingControl(const json& req,std::function<void(json)> done){
 const auto op=req.value("op","");
 if(op=="restore"){
  const int failed=RestoreLights();auto out=LightingState();out["ok"]=failed==0;
  out["msg"]=failed?"Some face lights could not be restored; try again":"Original face lights restored";done(out);return;
 }
 if(op=="quickOn"||op=="quickOff"){
  const auto now=std::chrono::steady_clock::now();
  if(quickLightPending&&now-quickLightSent<std::chrono::seconds(12)){done({{"ok",false},{"msg","Wait for Quick Light to update"}});return;}
  auto out=json::parse(op=="quickOn"?QuickLight::TurnOn():QuickLight::TurnOff());
  if(out.value("ok",false)){quickLightSent=now;quickLightPending=true;quickLightDesired=op=="quickOn";}
  // Do not present the bridge's predicted `on` as an observed state.
  out.erase("on");out["msg"]=out.value("ok",false)?"Quick Light requested; waiting for live status":out.value("msg","");done(out);return;
 }
 if(op!="on"&&op!="off"&&op!="relight"){done({{"ok",false},{"msg","Unknown lighting action"}});return;}
 auto* api=Api();std::vector<uint32_t> ids;
 if(req.value("all",false)){
  std::vector<OT::ActorData> actors(api->GetActorCount(0));const auto n=actors.empty()?0:api->GetActors(0,actors.data(),static_cast<uint32_t>(actors.size()));
  for(uint32_t i=0;i<n;++i)ids.push_back(actors[i].formID);
 }else ids.push_back(req.value("formId",0u));
 // Preflight every target before changing any actor.
 for(auto fid:ids)if(!Participant(fid)){done({{"ok",false},{"msg","Participant changed; refresh lighting"}});return;}
 if(!Facelight::Present()){done({{"ok",false},{"msg","Better FaceLight is not loaded"}});return;}
 if(!lightUndo.empty()&&lightGeneration!=sceneGeneration.load()&&RestoreLights()){
  done({{"ok",false},{"msg","Restore previous face lights before changing this scene"}});return;
 }
 lightGeneration=sceneGeneration.load();int failed=0;
 for(auto fid:ids){
  if(!lightUndo.count(fid)){Facelight::Snapshot before;if(!Facelight::Capture(fid,before)){++failed;continue;}lightUndo.emplace(fid,before);}
  if(!json::parse(Facelight::Apply(fid,op)).value("ok",false))++failed;
 }
 logger::info("ostim-controls: scene lighting {} targets={}",op,ids.size());
 auto out=LightingState();out["ok"]=failed==0;out["msg"]=failed?"Some face lights could not be changed":"Face lights updated; Restore faces returns their original state";done(out);
}

json SizeStatus(uint32_t fid){
 auto out=json::parse(SosActions::SizeStateJson(fid));
 if(out.value("available",false)){
  const auto gen=sceneGeneration.load();auto it=sizeOriginal.find(fid);
  if(it==sizeOriginal.end()||it->second.first!=gen)sizeOriginal[fid]={gen,out["size"].get<int>()};
  out["original"]=sizeOriginal[fid].second;
 }
 return out;
}

void ActorStatus(uint32_t fid,const std::string& sig,std::function<void(json)> done){
 auto* actor=Participant(fid);if(!actor||Signature()!=sig){done({{"ok",false},{"msg","Participant changed; refresh"}});return;}
 auto result=std::make_shared<json>(json{{"ok",true},{"formId",fid},{"muted",nullptr},{"expressionOverride",nullptr}});
 auto left=std::make_shared<int>(1);
 auto finish=[result,left,done,sig](){if(--*left==0){if(Signature()!=sig)done({{"ok",false},{"msg","Scene changed; refresh"}});else done(*result);}};
 for(const auto& field:std::vector<std::pair<const char*,const char*>>{{"IsMuted","muted"},{"HasExpressionOverride","expressionOverride"}}){
  ++*left;std::string key=field.second;
  if(!Call("OActor",field.first,[result,key,finish](RE::BSScript::Variable v){if(v.IsBool())(*result)[key]=v.GetBool();finish();},actor))finish();
 }
 finish();
}
void ActorControl(const json& req,const std::string& sig,std::function<void(json)> done){
 const auto fid=req.value("formId",0u);auto* actor=Participant(fid);
 if(!actor){done({{"ok",false},{"msg","Actor is no longer a loaded scene participant"}});return;}
 const auto act=req.value("act","");
 if(act=="actorState"){ActorStatus(fid,sig,done);return;}
 if(act=="sizeState"){done(SizeStatus(fid));return;}
 const auto now=std::chrono::steady_clock::now();
 if(actorBusy.count(fid)&&now-actorBusy[fid]<std::chrono::seconds(12)){done({{"ok",false},{"msg","Wait for this participant’s previous request"}});return;}
 const auto event=req.value("event","");
 if(act=="expression"&&!HasExpressionEvent(event)){done({{"ok",false},{"msg","Expression event is not in the installed catalog"}});return;}
 actorBusy[fid]=now;const auto generation=sceneGeneration.load();
 auto finish=[fid,now,done](json j){if(actorBusy.count(fid)&&actorBusy[fid]==now)actorBusy.erase(fid);done(j);};
 logger::info("ostim-controls: actor tools {} {:08X}",act,fid);
 if(act=="size"||act=="sizeRestore"){
  auto state=SizeStatus(fid);
  if(!state.value("available",false)){state["ok"]=false;finish(state);return;}
  if(act=="size"&&(!req.contains("size")||!req["size"].is_number_integer())){finish({{"ok",false},{"msg","Choose a whole SOS size from 1 to 20"}});return;}
  const auto value=act=="sizeRestore"?state["original"].get<int64_t>():req["size"].get<int64_t>();
  if(value<1||value>20){finish({{"ok",false},{"msg","Choose a whole SOS size from 1 to 20"}});return;}
  SosActions::SetActorSize(fid,static_cast<int>(value),[fid,generation,finish](std::string raw){
   if(sceneGeneration.load()!=generation||!Participant(fid)){finish({{"ok",false},{"msg","Participant or scene changed; refresh size"}});return;}
   auto out=json::parse(raw);if(sizeOriginal.count(fid)&&sizeOriginal[fid].first==generation)out["original"]=sizeOriginal[fid].second;
   finish(out);
  });return;
 }

 if(act=="expression"||act=="expressionClear"){
  const auto serial=++expressionSerial[fid];const bool preview=req.value("preview",false);
  auto cb=[finish,fid,serial,generation,preview,act,event](RE::BSScript::Variable v){
   if(sceneGeneration.load()!=generation||!Participant(fid)||expressionSerial[fid]!=serial){finish({{"ok",false},{"msg","Participant or scene changed"}});return;}
   if(act=="expression"&&(!v.IsFloat()||v.GetFloat()<0)){finish({{"ok",false},{"msg","OStim could not play this expression event"}});return;}
   if(act=="expression"&&preview)std::thread([fid,serial,generation](){
    std::this_thread::sleep_for(std::chrono::seconds(5));
    SKSE::GetTaskInterface()->AddTask([fid,serial,generation](){
     if(sceneGeneration.load()!=generation||expressionSerial[fid]!=serial)return;
     if(auto* actor=Participant(fid))Call("OActor","ClearExpression",[](RE::BSScript::Variable){},actor);
    });
   }).detach();
   finish({{"ok",true},{"event",act=="expression"?event:""},{"preview",preview},{"msg",act=="expressionClear"?"Event cleared; OStim controls expressions":preview?"Preview requested for 5 seconds":"Expression requested; scene events may replace it"}});
  };
  const bool sent=act=="expression"?Call("OActor","PlayExpression",cb,actor,RE::BSFixedString(event.c_str())):Call("OActor","ClearExpression",cb,actor);
  if(!sent)finish({{"ok",false},{"msg","OStim expression control unavailable"}});return;
 }
 const char* fn=act=="mute"?(req.value("muted",false)?"Mute":"Unmute"):"Redress";
 if(!Call("OActor",fn,[finish,sig,fid,act](RE::BSScript::Variable){
  if(Signature()!=sig||!Participant(fid)){finish({{"ok",false},{"msg","Scene changed; refresh participant status"}});return;}
  if(act=="mute")ActorStatus(fid,sig,[finish](json j){j["msg"]=j.value("ok",false)?"Audio status refreshed from OStim":"Scene changed; refresh";finish(j);});
  else finish({{"ok",true},{"msg","Asked OStim to restore clothing it removed for this scene"}});
 },actor))finish({{"ok",false},{"msg","OStim participant control unavailable"}});
}

/* ==================================================================== *
 *  The unified Scene page (2026-09-21). Verbs the dedicated OStim tab
 *  adds on top of the workspace's original nine.
 *
 *  Every one of these lives INSIDE Controls()'s signature gate, so a
 *  scene transition refuses them rather than acting on the wrong scene.
 * ==================================================================== */

/* ---- "you are here": the piece the scene is ACTUALLY on -------------
   Rober, 2026-09-21: "it doesnt seem to be showing the bed were actively
   on as well." That is not a radius bug and no radius will fix it:
   OFurniture.FindFurniture returns the closest UNOCCUPIED object of each
   furniture type, and the bed under the scene is reserved by this very
   thread — so it is invisible to that call BY DESIGN. The honest answer
   is a different question: ask the thread what it is using. */
void CurrentFurniture(const json& req, std::function<void(json)> done){
 auto* a=Api();
 if(!a||!a->IsThreadValid(0)){done({{"ok",false},{"msg","No player scene"}});return;}
 const auto sig=Signature();
 const bool sent=Call("OThread","GetFurnitureType",[done,sig](RE::BSScript::Variable v){
  const std::string type=v.IsString()?std::string(v.GetString()):"";
  if(type.empty()||type=="none"){
   done({{"ok",true},{"here",json(nullptr)},{"msg","This scene is not on furniture"}});return;
  }
  // The type answered; now name the object itself. A missing ref is not a
  // failure — OStim reports a type for floor-anchored scenes too.
  if(!Call("OThread","GetFurniture",[done,sig,type](RE::BSScript::Variable ref){
   if(Signature()!=sig){done({{"ok",false},{"msg","Scene changed; refresh"}});return;}
   auto* r=Ref(ref);
   json here={{"type",type},{"formId",r?r->GetFormID():0u},
              {"name",r&&r->GetName()&&*r->GetName()?r->GetName():"Current furniture"},
              {"current",true}};
   done({{"ok",true},{"here",here},{"msg",""}});
  },0))done({{"ok",true},{"here",{{"type",type},{"formId",0u},{"name","Current furniture"},{"current",true}}},{"msg",""}});
 },0);
 if(!sent)done({{"ok",false},{"msg","OStim furniture state is unavailable"}});
}

/* ---- per-actor undress (ask 6) --------------------------------------
   OStim's own verbs; the deck implements no undressing of its own.
   ⚠ OStim exposes NO undress-state query, so the readout is a worn-slot
   read of the actor (the npc_inspect idiom) — "wearing N pieces" is a
   fact; "undressed by OStim" would be a guess, and we never print one.
   Slot masks are OStim's own convention: bit = 1 << (slot - 30). */
constexpr std::uint32_t kMaskHead  = 0x02004001;  // head + hair + circlet
constexpr std::uint32_t kMaskBody  = 0x04C90004;
constexpr std::uint32_t kMaskHands = 0x00000008;
constexpr std::uint32_t kMaskFeet  = 0x00000080;
json WornState(RE::Actor* a){
 using Slot=RE::BIPED_MODEL::BipedObjectSlot;
 json out={{"pieces",0},{"slots",json::array()}};
 if(!a)return out;
 auto worn=[a](Slot s)->RE::TESObjectARMO*{return a->GetWornArmor(s);};
 auto* head=worn(Slot::kHead);if(!head)head=worn(Slot::kHair);if(!head)head=worn(Slot::kCirclet);
 struct Row{const char* key;const char* label;RE::TESObjectARMO* armo;std::uint32_t mask;};
 const Row rows[]={
  {"head","Head",head,kMaskHead},
  {"body","Body",worn(Slot::kBody),kMaskBody},
  {"hands","Hands",worn(Slot::kHands),kMaskHands},
  {"feet","Feet",worn(Slot::kFeet),kMaskFeet},
 };
 // A robe fills several slots at once; count it once (the wardrobe /
 // character-sheet dedupe) so "4 pieces" never means one outfit.
 std::vector<RE::FormID> seen;int pieces=0;
 for(const auto& r:rows){
  auto* armo=r.armo;bool dup=false;
  if(armo){const auto fid=armo->GetFormID();dup=std::find(seen.begin(),seen.end(),fid)!=seen.end();if(!dup)seen.push_back(fid);}
  if(armo&&!dup)++pieces;
  out["slots"].push_back({{"key",r.key},{"label",r.label},{"mask",r.mask},
                          {"worn",armo!=nullptr},
                          {"item",armo&&armo->GetName()?armo->GetName():""}});
 }
 out["pieces"]=pieces;
 return out;
}
void UndressControl(const json& req,const std::string& sig,std::function<void(json)> done){
 const auto fid=req.value("formId",0u);auto* actor=Participant(fid);
 if(!actor){done({{"ok",false},{"msg","Actor is no longer a loaded scene participant"}});return;}
 const auto act=req.value("act","");
 if(act=="undressState"){json j=WornState(actor);j["ok"]=true;j["formId"]=fid;done(j);return;}
 const auto op=req.value("op","");
 const char* fn=nullptr;std::uint32_t mask=0;bool partial=false;
 if(op=="off")fn="Undress";
 else if(op=="on")fn="Redress";
 else if(op=="weaponsOff")fn="RemoveWeapons";
 else if(op=="weaponsOn")fn="AddWeapons";
 else if(op=="slotOff"||op=="slotOn"){
  partial=true;fn=op=="slotOff"?"UndressPartial":"RedressPartial";
  const auto key=req.value("slot","");
  mask=key=="head"?kMaskHead:key=="body"?kMaskBody:key=="hands"?kMaskHands:key=="feet"?kMaskFeet:0u;
  // A mask that arrived off the wire is validated against the same table
  // that would be written, never poked through (the act:"glob" precedent).
  if(!mask){done({{"ok",false},{"msg","Unknown clothing slot"}});return;}
 }
 else{done({{"ok",false},{"msg","Unknown undress request"}});return;}
 logger::info("ostim-controls: undress {} {:08X}",op,fid);  // marker: scene-undress
 auto reply=[done,fid,sig,op](RE::BSScript::Variable){
  auto* still=Participant(fid);
  if(Signature()!=sig||!still){done({{"ok",false},{"msg","Scene changed; refresh this participant"}});return;}
  json j=WornState(still);j["ok"]=true;j["formId"]=fid;
  j["msg"]=op=="off"?"Asked OStim to undress this participant"
          :op=="on"?"Asked OStim to put back what it removed"
          :op=="weaponsOff"?"Weapons removed"
          :op=="weaponsOn"?"Weapons returned":"Sent to OStim";
  done(j);
 };
 const bool sent=partial
  ?Call("OActor",fn,reply,actor,static_cast<std::int32_t>(mask))
  :Call("OActor",fn,reply,actor);
 if(!sent)done({{"ok",false},{"msg","OStim undress control is unavailable"}});
}

/* ---- per-participant voice (ask 8) ----------------------------------
   OData's voice API is keyed on the actor's BASE FormID, not the
   reference — OStim's own MCM does CurrentActor.GetActorBase().GetFormID()
   and uses 0x7 for the player. The deck's actors[] carries REFERENCE ids,
   so every call converts first, and the UI says out loud that a generic
   NPC's voice is shared with every NPC of that base. */
std::uint32_t BaseOf(std::uint32_t refFormId){
 auto* a=RE::TESForm::LookupByID<RE::Actor>(refFormId);
 auto* base=a?a->GetActorBase():nullptr;
 return base?base->GetFormID():0u;
}
std::vector<std::string> voicePairs;   // flat [id,name,id,name,…], OStim's own order
std::string voiceToken;
void VoiceCatalog(const json& req,std::function<void(json)> done){
 const bool sent=Call("OData","GetVoiceSetPairs",[done](RE::BSScript::Variable v){
  voicePairs.clear();json rows=json::array();
  if(v.IsArray()&&v.GetArray())for(auto& s:*v.GetArray())voicePairs.emplace_back(s.IsString()?std::string(s.GetString()):"");
  // PairsToNames exists, but the flat pair list already carries both and
  // costs one round trip instead of two.
  for(size_t i=0;i+1<voicePairs.size();i+=2)
   rows.push_back({{"index",static_cast<int>(i/2)},{"id",voicePairs[i]},{"name",voicePairs[i+1]}});
  voiceToken=std::to_string(++epoch);
  done({{"ok",true},{"voices",rows},{"token",voiceToken},
        {"msg",rows.empty()?"OStim reports no installed voice sets":""}});
 });
 if(!sent)done({{"ok",false},{"msg","OStim voice data is unavailable"}});
}
void VoiceState(const json& req,const std::string& sig,std::function<void(json)> done){
 auto* a=Api();
 if(!a||!a->IsThreadValid(0)){done({{"ok",false},{"msg","No player scene"}});return;}
 std::vector<OT::ActorData> actors(a->GetActorCount(0));
 const auto n=actors.empty()?0:a->GetActors(0,actors.data(),static_cast<uint32_t>(actors.size()));
 auto rows=std::make_shared<json>(json::array());
 auto pending=std::make_shared<int>(1);
 // One GetVoiceSetName per participant, fanned out with a pending counter
 // (the Scan idiom) — callbacks, never a blocking chain on the VM thread.
 auto finish=[done,sig,rows](){
  if(Signature()!=sig){done({{"ok",false},{"msg","Scene changed; refresh voices"}});return;}
  done({{"ok",true},{"actors",*rows},{"msg",""}});
 };
 for(uint32_t i=0;i<n;++i){
  const auto ref=actors[i].formID;const auto base=BaseOf(ref);
  auto* act=RE::TESForm::LookupByID<RE::Actor>(ref);
  auto* nb=act?act->GetActorBase():nullptr;
  json row={{"formId",ref},{"base",base},
            {"name",act&&act->GetName()?act->GetName():"Participant"},
            // "Unique" here is the engine's own flag; a non-unique base is
            // shared, and the UI must say so before a write.
            {"unique",nb?nb->IsUnique():false},
            {"voice",""},{"voiceName",""}};
  if(!base){rows->push_back(row);continue;}
  const auto slot=rows->size();rows->push_back(row);
  ++*pending;
  if(!Call("OData","GetVoiceSetName",[rows,pending,finish,slot](RE::BSScript::Variable v){
   if(slot<rows->size())(*rows)[slot]["voiceName"]=v.IsString()?std::string(v.GetString()):"";
   if(--*pending==0)finish();
  },static_cast<std::int32_t>(base)))--*pending;
 }
 if(--*pending==0)finish();
}
void SetVoice(const json& req,const std::string& sig,std::function<void(json)> done){
 const auto fid=req.value("formId",0u);
 if(!Participant(fid)){done({{"ok",false},{"msg","Actor is no longer a loaded scene participant"}});return;}
 const auto base=BaseOf(fid);
 if(!base){done({{"ok",false},{"msg","This participant has no actor base to key a voice on"}});return;}
 const auto index=req.value("index",-1);
 const bool reset=req.value("reset",false);
 // ⚠ Reset sends the literal "0", which is what OStim's OWN MCM sends:
 // SetVoiceSet(FormID, 0) in OSexIntegrationMCM.psc, and Papyrus coerces
 // that Int to a String. An empty string would be a guess at a native we
 // cannot read; matching the mod's own call is the only verified answer.
 std::string id="0";
 if(!reset){
  // Curated table addressed by index; a raw voice id off the wire is
  // refused rather than handed to OStim.
  if(req.value("token","")!=voiceToken||index<0||static_cast<size_t>(index)*2>=voicePairs.size()){
   done({{"ok",false},{"msg","Voice list changed; refresh voices"}});return;
  }
  id=voicePairs[static_cast<size_t>(index)*2];
 }
 logger::info("ostim-controls: voice set {:08X} base {:08X} -> {}",fid,base,reset?"default":id);  // marker: scene-voice
 if(!Call("OData","SetVoiceSet",[done,sig,fid,reset](RE::BSScript::Variable){
  if(Signature()!=sig){done({{"ok",false},{"msg","Scene changed; refresh voices"}});return;}
  // Never claim what OStim did — the page re-reads GetVoiceSetName right
  // after this and paints whatever actually stuck.
  done({{"ok",true},{"msg",reset?"Asked OStim to clear this actor's voice override":"Voice set for every NPC sharing this actor base"}});
 },static_cast<std::int32_t>(base),RE::BSFixedString(id.c_str())))
  done({{"ok",false},{"msg","OStim voice control is unavailable"}});
}

/* ---- bringing someone into the running scene (ask 3) -----------------
   HasCompatibleNode asks whether OStim owns an animation for the new
   cast; MigrateThread is the same primitive Swap roles uses. Two costs
   the UI must state plainly rather than discover in play:
     · migration is a full stop→start and yields a NEW thread id;
     · the actor-count change makes OStim re-search with 'none' furniture,
       so adding a third person DROPS YOU OFF THE BED.
   HasCompatibleNode:true is also not a promise — it is a precondition. */
void SceneRoster(const json& req,const std::string& sig,std::function<void(json)> done){
 auto* a=Api();auto* pc=RE::PlayerCharacter::GetSingleton();
 if(!a||!pc||!a->IsThreadValid(0)){done({{"ok",false},{"msg","No player scene"}});return;}
 std::vector<OT::ActorData> cast(a->GetActorCount(0));
 const auto n=cast.empty()?0:a->GetActors(0,cast.data(),static_cast<uint32_t>(cast.size()));
 std::vector<std::uint32_t> current;
 for(uint32_t i=0;i<n;++i)current.push_back(cast[i].formID);
 const float radius=std::clamp(req.value("radius",60.f),20.f,200.f)*64.f/3.f;
 json rows=json::array();
 auto* lists=RE::ProcessLists::GetSingleton();
 std::vector<RE::FormID> seen;
 // Both handle lists, the same net npc_clearance casts for "who is in the
 // room" — a follower standing one room over is in middleHigh, not high,
 // and is exactly who you would want to call in.
 auto sweep=[&](auto& handles){
  for(auto& handle:handles){
   if(rows.size()>=64)return;
   auto ptr=handle.get();RE::Actor* p=ptr?ptr.get():nullptr;
   if(!p||p==pc||p->IsPlayerRef()||p->IsDead()||p->IsDisabled()||!p->Get3D())continue;
   if(p->GetParentCell()!=pc->GetParentCell())continue;
   const auto fid=p->GetFormID();
   if(std::find(seen.begin(),seen.end(),fid)!=seen.end())continue;
   seen.push_back(fid);
   if(std::find(current.begin(),current.end(),fid)!=current.end())continue;
   if(a->IsActorInAnyThread(fid))continue;   // busy in a scene of their own
   const auto d2=pc->GetPosition().GetSquaredDistance(p->GetPosition());
   if(d2>radius*radius)continue;
   std::vector<std::uint32_t> trial=current;trial.push_back(fid);
   rows.push_back({{"formId",fid},
                   {"name",p->GetName()&&*p->GetName()?p->GetName():"Someone"},
                   {"feet",std::round(std::sqrt(d2)*3.f/64.f)},
                   {"compatible",a->HasCompatibleNode(0,trial.data(),static_cast<uint32_t>(trial.size()))}});
  }
 };
 if(lists){sweep(lists->highActorHandles);sweep(lists->middleHighActorHandles);}
 std::sort(rows.begin(),rows.end(),[](const json& x,const json& y){return x.value("feet",0.f)<y.value("feet",0.f);});
 json castRows=json::array();
 for(auto fid:current){
  auto* p=RE::TESForm::LookupByID<RE::Actor>(fid);
  castRows.push_back({{"formId",fid},{"name",p&&p->GetName()?p->GetName():"Participant"}});
 }
 scanToken=std::to_string(++epoch);
 done({{"ok",true},{"rows",rows},{"cast",castRows},{"token",scanToken},
       {"canRemove",current.size()>2},
       {"msg",rows.empty()?"Nobody nearby is free to join":""}});
}
void SceneMigrate(const json& req,const std::string& sig,std::function<void(json)> done){
 auto* a=Api();
 if(!a||!a->IsThreadValid(0)){done({{"ok",false},{"msg","No player scene"}});return;}
 if(req.value("token","")!=scanToken){done({{"ok",false},{"msg","Participant list expired; refresh"}});return;}
 std::vector<OT::ActorData> cast(a->GetActorCount(0));
 const auto n=cast.empty()?0:a->GetActors(0,cast.data(),static_cast<uint32_t>(cast.size()));
 auto* pc=RE::PlayerCharacter::GetSingleton();
 const auto who=req.value("formId",0u);
 const bool join=req.value("act","")=="join";
 std::vector<std::uint32_t> next;
 for(uint32_t i=0;i<n;++i){
  if(!join&&cast[i].formID==who)continue;      // part: drop exactly one
  next.push_back(cast[i].formID);
 }
 if(join){
  if(a->IsActorInAnyThread(who)){done({{"ok",false},{"msg","They are already in a scene"}});return;}
  auto* p=RE::TESForm::LookupByID<RE::Actor>(who);
  if(!p||p->IsDead()||!p->Get3D()||p->GetParentCell()!=(pc?pc->GetParentCell():nullptr)){
   done({{"ok",false},{"msg","They are no longer nearby"}});return;
  }
  if(next.size()>=5){done({{"ok",false},{"msg","OStim scenes top out at five participants"}});return;}
  next.push_back(who);
 }else{
  if(next.size()==static_cast<size_t>(n)){done({{"ok",false},{"msg","They are not in this scene"}});return;}
  // Never migrate the player out of their own scene, and never below a pair.
  if(pc&&who==pc->GetFormID()){done({{"ok",false},{"msg","Use Stop scene to leave it yourself"}});return;}
  if(next.size()<2){done({{"ok",false},{"msg","A scene needs at least two participants — stop it instead"}});return;}
 }
 if(!a->HasCompatibleNode(0,next.data(),static_cast<uint32_t>(next.size()))){
  done({{"ok",false},{"msg",join?"OStim has no scene for that group":"OStim has no scene for the remaining group"}});return;
 }
 logger::info("ostim-controls: migrate {} {:08X} -> {} actors",join?"join":"part",who,next.size());  // marker: scene-migrate
 const auto created=a->MigrateThread(0,next.data(),static_cast<uint32_t>(next.size()));
 // The new thread id is NOT 0 in general; every deck surface addresses
 // thread 0, so say plainly what happened rather than pretending.
 const bool ok=created>=0;
 if(ok)++sceneGeneration;
 done({{"ok",ok},{"threadID",created},
       {"msg",!ok?"OStim refused the change"
             :join?"Scene restarting with them in it — OStim re-picks the furniture, so you may end up off the bed"
                  :"Scene restarting without them"}});
}

/* ---- clearing the room, from the scene page (ask 9) ------------------
   "Get away from me" already exists whole in npc_clearance.cpp, and this
   adds no mechanics of its own — it is a proxy, because the page needs
   TWO things the get-away modal cannot give it:

     · it must not close the palette. Every ga* verb ends in ClosePalette(),
       which mid-scene would make the page Rober just opened vanish.
     · it must not stomp the modal's roster token. NpcClearance mints ONE
       token in Nearby() and ClearRoom() demands it back within ten
       seconds, so a second caller interleaving with the modal would
       expire the modal's list. Here the scan and the clear happen inside
       a SINGLE main-thread call, so there is no window to interleave in.

   Scene participants need no special case: Busy() already refuses them
   with "In an OStim scene", which is exactly the right answer. */
void RoomControl(const json& req,std::function<void(json)> done){
 const auto op=req.value("op","nearby");
 if(op=="restore"){
  auto out=json::parse(NpcClearance::Restore());
  out["ok"]=out.value("restored",0)>0;
  out["held"]=json::parse(NpcClearance::HeldJson());
  if(!out.contains("msg")||out.value("msg","").empty())
   out["msg"]=out["ok"]?"Everyone held has been put back":"Nobody was being held";
  done(out);return;
 }
 // One fresh scan per request; its token never leaves this function.
 const auto token="scene-"+std::to_string(++epoch);
 auto scan=json::parse(NpcClearance::Nearby(Dump({{"token",token}})));
 json rows=scan.value("rows",json::array());
 if(op=="nearby"){
  done({{"ok",scan.value("ok",false)},{"rows",rows},
        {"held",json::parse(NpcClearance::HeldJson())},
        {"msg",rows.empty()?"Nobody else is in the room":""}});return;
 }
 if(op!="clear"){done({{"ok",false},{"msg","Unknown room request"}});return;}
 // Which of them to move. An explicit id list is honoured (the per-person
 // ✕); with none, everyone the scan did NOT refuse — so the scene's own
 // participants stay put, named by Busy() rather than by us guessing.
 json ids=json::array();
 const bool keepFollowers=req.value("keepFollowers",false);
 if(req.contains("ids")&&req["ids"].is_array()){
  for(const auto& row:rows)
   for(const auto& want:req["ids"])
    if(want.is_number_unsigned()&&want.get<std::uint64_t>()==row.value("formId",0u)&&row.value("reason","").empty())
     ids.push_back(row["formId"]);
 }else{
  for(const auto& row:rows){
   if(!row.value("reason","").empty())continue;
   if(keepFollowers&&row.value("follower",false))continue;
   ids.push_back(row["formId"]);
  }
 }
 if(ids.empty()){done({{"ok",false},{"held",json::parse(NpcClearance::HeldJson())},
                       {"msg","Nobody in the room can be moved right now"}});return;}
 if(ids.size()>24)ids.erase(ids.begin()+24,ids.end());
 logger::info("ostim-controls: clear the room, {} actor(s)",ids.size());  // marker: scene-room
 auto out=json::parse(NpcClearance::ClearRoom(Dump({{"token",token},{"ids",ids}})));
 out["held"]=json::parse(NpcClearance::HeldJson());
 done(out);
}

/* ---- the scene's own SOS dials (ask 4) -------------------------------
   Scene-scoped, and nothing to do with SOS's global bend keys that
   sos_actions.cpp synthesizes: OStim carries sosBend and scale per actor
   in its OWN alignment struct, so these are a read-modify-write of data
   OStim already owns — no key synthesis, no crosshair.
   ⚠ scale's neutral value is 1, not 0. Always Get before Set, and treat a
   non-finite or zero read as 1 or the actor is scaled out of existence. */
void SceneSos(const json& req,const std::string& sig,std::function<void(json)> done){
 auto* a=Api();
 const auto fid=req.value("formId",0u);
 const auto index=a?a->GetActorPosition(0,fid):-1;
 OT::ActorAlignmentData d{};
 if(index<0||!a->GetActorAlignment(0,index,&d)){done({{"ok",false},{"msg","Actor is no longer in this scene"}});return;}
 if(!std::isfinite(d.scale)||d.scale<=0.f)d.scale=1.f;
 if(!std::isfinite(d.sosBend))d.sosBend=0.f;
 if(req.value("act","")=="sosState"){
  done({{"ok",true},{"formId",fid},{"bend",d.sosBend},{"scale",d.scale},{"msg",""}});return;
 }
 const auto field=req.value("field","");
 const float delta=req.value("delta",0.f);
 const bool reset=req.value("reset",false);
 if(!std::isfinite(delta)||std::abs(delta)>10.f){done({{"ok",false},{"msg","Invalid adjustment"}});return;}
 if(field=="bend")d.sosBend=reset?0.f:std::clamp(d.sosBend+delta,-10.f,9.f);
 else if(field=="scale")d.scale=reset?1.f:std::clamp(d.scale+delta*0.05f,0.5f,2.f);
 else{done({{"ok",false},{"msg","Unknown SOS field"}});return;}
 const bool ok=a->SetActorAlignment(0,index,&d)==OT::APIResult::OK;
 done({{"ok",ok},{"formId",fid},{"bend",d.sosBend},{"scale",d.scale},
       {"msg",ok?(field=="bend"?"Bend applied for this scene":"Scale applied for this scene"):"OStim refused the change"}});
}

}
/* ==================================================================== *
 *  The live alignment overlay (2026-09-21).
 *
 *  Rober: "current one is bad, it needs to layer over, and not pause the
 *  game though if you call it, maybe use arrow keys plus e or enter to
 *  change stuff."
 *
 *  This is the DATA half only. It draws nothing and owns no keys: the
 *  overlay lives on the always-on HUD view (main.cpp), which takes real
 *  keyboard focus with pauseGame=false — the Followers-browse-v2
 *  discipline. That focus is also what resolves the collision with
 *  OStim's OWN arrow keys: a focused view CONSUMES them, so nothing has
 *  to be synthesized, suppressed or intercepted.
 *
 *  Every value below is the same ActorAlignmentData the Scene page's
 *  Alignment segment reads and writes. One source, two surfaces.
 * ==================================================================== */
std::string AlignStateJson(){
 auto* a=Api();
 json out={{"ok",false},{"inScene",false},{"actors",json::array()}};
 if(!a||!a->IsThreadValid(0)){out["msg"]="No player scene";return Dump(out);}
 std::vector<OT::ActorData> cast(a->GetActorCount(0));
 const auto n=cast.empty()?0:a->GetActors(0,cast.data(),static_cast<uint32_t>(cast.size()));
 for(uint32_t i=0;i<n;++i){
  auto* p=RE::TESForm::LookupByID<RE::Actor>(cast[i].formID);
  OT::ActorAlignmentData d{};
  const bool got=a->GetActorAlignment(0,i,&d);
  if(!std::isfinite(d.scale)||d.scale<=0.f)d.scale=1.f;
  if(!std::isfinite(d.sosBend))d.sosBend=0.f;
  out["actors"].push_back({{"formId",cast[i].formID},
   {"name",p&&p->GetName()&&*p->GetName()?p->GetName():"Participant"},
   {"ok",got},
   {"x",d.offsetX},{"y",d.offsetY},{"z",d.offsetZ},
   {"rotation",d.rotation},{"scale",d.scale},{"bend",d.sosBend}});
 }
 out["ok"]=true;out["inScene"]=true;
 out["scene"]=a->GetCurrentSceneID(0)?a->GetCurrentSceneID(0):"";
 out["sceneName"]=a->GetCurrentNodeName(0)?a->GetCurrentNodeName(0):"";
 out["signature"]=Signature();
 return Dump(out);
}

/* ===================================================================== *
 *  HOLD & RESUME HERE — the SexLab-style relocate.
 *
 *  Rober, 2026-09-22: "sexlab has a feature where it temp pauses the scene
 *  you run around then after a few seconds it replays scene right there. is
 *  this possible?"
 *
 *  Yes, but it is honestly a STOP and a RESTART, not a pause: OStim has no
 *  pause-a-thread call anywhere in its API. What it does have is enough:
 *
 *     OThread.Stop(threadID)                          end it
 *     OThread.GetScene(threadID) / GetCurrentSceneID  which scene it was
 *     OThread.QuickStart(Actor[], sceneID, furniture) start it again
 *
 *  So Hold snapshots the scene id, the cast IN ORDER, the speed and every
 *  actor's alignment, then stops the thread. You walk off. Resume here
 *  validates the cast is still with you, calls QuickStart with the SAME
 *  scene id and no furniture — wherever you are standing — and re-applies
 *  the speed and the alignment on the new thread.
 *
 *  ⚠ WHAT IT CANNOT CARRY, and the UI says all of it:
 *   · the animation restarts from the top of that scene;
 *   · excitement / climax counters are OStim's own and reset with the thread;
 *   · a furniture-bound scene resumed on open floor is OStim's call — it may
 *     refuse or substitute. We pass no furniture and report what it did
 *     rather than pretending the same animation came back.
 *
 *  The snapshot is deliberately NOT persisted. It is a within-session hold;
 *  a FormID list surviving a reload could resume with the wrong cast.
 * ===================================================================== */
struct HeldScene {
 bool                                has=false;
 std::string                         scene,sceneName;
 std::vector<RE::FormID>             actors;
 std::vector<OT::ActorAlignmentData> align;
 std::int32_t                        speed=-1;
};
static HeldScene g_held;   // MAIN THREAD ONLY

static float FeetTo(RE::TESObjectREFR* r){
 auto* pc=RE::PlayerCharacter::GetSingleton();
 if(!pc||!r)return -1.f;
 return std::sqrt(pc->GetPosition().GetSquaredDistance(r->GetPosition()))*3.f/64.f;
}

/* Why a given held actor cannot take part right now — empty means ready. */
static std::string ResumeBlocker(RE::FormID id,RE::Actor*& out){
 out=RE::TESForm::LookupByID<RE::Actor>(id);
 if(!out)return "is no longer loaded";
 if(out->IsDisabled()||out->IsDeleted())return "is gone";
 if(out->IsDead())return "is dead";
 auto* pc=RE::PlayerCharacter::GetSingleton();
 if(!pc)return "player missing";
 if(out!=pc){
  if(!out->Get3D()||out->GetParentCell()!=pc->GetParentCell())return "is not in this room";
  const float ft=FeetTo(out);
  if(ft>60.f)return "is "+std::to_string(static_cast<int>(ft))+" ft away";
 }
 auto* api=Api();
 if(api&&api->IsActorInAnyThread(id)&&out!=pc)return "is already in another scene";
 return "";
}

static json HeldJson(){
 json out={{"ok",true},{"has",g_held.has},{"people",json::array()}};
 if(!g_held.has){out["msg"]="Nothing held";return out;}
 out["scene"]=g_held.scene;out["sceneName"]=g_held.sceneName;out["speed"]=g_held.speed;
 bool ready=true;
 for(const auto id:g_held.actors){
  RE::Actor* act=nullptr;
  const auto why=ResumeBlocker(id,act);
  if(!why.empty())ready=false;
  out["people"].push_back({{"formId",id},
   {"name",act&&act->GetName()&&*act->GetName()?act->GetName():"Participant"},
   {"ok",why.empty()},{"reason",why},
   {"feet",act?static_cast<int>(FeetTo(act)):-1}});
 }
 out["canResume"]=ready;
 out["msg"]=ready?"Ready to resume where you are standing"
                 :"Someone from the held scene is not with you";
 return out;
}

static void HoldScene(std::function<void(json)> done){
 auto* a=Api();
 if(!a||!a->IsThreadValid(0)){done({{"ok",false},{"msg","No player scene to hold"}});return;}
 HeldScene h;
 h.scene=a->GetCurrentSceneID(0)?a->GetCurrentSceneID(0):"";
 h.sceneName=a->GetCurrentNodeName(0)?a->GetCurrentNodeName(0):"";
 if(h.scene.empty()){done({{"ok",false},{"msg","OStim did not name the current scene, so it cannot be restarted"}});return;}
 std::vector<OT::ActorData> cast(a->GetActorCount(0));
 const auto n=cast.empty()?0:a->GetActors(0,cast.data(),static_cast<uint32_t>(cast.size()));
 if(!n){done({{"ok",false},{"msg","OStim reported no participants"}});return;}
 for(uint32_t i=0;i<n;++i){
  h.actors.push_back(cast[i].formID);
  OT::ActorAlignmentData d{};
  if(!a->GetActorAlignment(0,i,&d))d=OT::ActorAlignmentData{};
  h.align.push_back(d);
 }
 h.speed=a->GetCurrentSpeed(0);
 h.has=true;
 g_held=std::move(h);
 logger::info("scene-hold: held '{}' with {} actor(s)",g_held.scene,g_held.actors.size());  // marker: scene-hold
 if(!Call("OThread","Stop",[done](RE::BSScript::Variable){
   json j=HeldJson();
   j["held"]=true;
   j["msg"]="Scene held. Walk where you want it and press Resume here.";
   done(j);
  },static_cast<std::int32_t>(0))){
  g_held=HeldScene{};
  done({{"ok",false},{"msg","OStim would not stop the scene, so nothing was held"}});
 }
}

static void ResumeScene(std::function<void(json)> done){
 if(!g_held.has){done({{"ok",false},{"msg","Nothing is held"}});return;}
 auto* a=Api();
 if(a&&a->IsThreadValid(0)){done({{"ok",false},{"msg","A scene is already running — stop it before resuming the held one"}});return;}
 std::vector<RE::Actor*> cast;
 for(const auto id:g_held.actors){
  RE::Actor* act=nullptr;
  const auto why=ResumeBlocker(id,act);
  if(!why.empty()){
   json j=HeldJson();j["ok"]=false;
   j["msg"]=std::string(act&&act->GetName()?act->GetName():"Someone")+" "+why+" — bring them here first";
   done(j);return;
  }
  cast.push_back(act);
 }
 const auto scene=g_held.scene;
 const auto speed=g_held.speed;
 const auto align=g_held.align;
 logger::info("scene-resume: restarting '{}' with {} actor(s)",scene,cast.size());  // marker: scene-resume
 if(!Call("OThread","QuickStart",[done,scene,speed,align](RE::BSScript::Variable v){
   const bool started=v.IsInt()&&v.GetSInt()>=0;
   auto* api=Api();
   bool reapplied=false;
   if(started&&api&&api->IsThreadValid(0)){
    /* Same scene, same cast, so the offsets still mean what they meant.
       Best-effort: a failure here costs the tuning, not the scene. */
    if(speed>=0)api->SetSpeed(0,speed);
    for(uint32_t i=0;i<align.size();++i)api->SetActorAlignment(0,i,&align[i]);
    reapplied=true;
   }
   if(started)g_held=HeldScene{};
   json j=HeldJson();
   j["ok"]=started;
   j["resumed"]=started;
   j["msg"]=started
    ?(reapplied?"Resumed here, with the speed and alignment you had"
               :"Resumed here — OStim started it, but the speed and alignment could not be re-applied")
    :"OStim refused to restart that scene here. A scene that needs furniture cannot resume on open floor.";
   done(j);
  },std::move(cast),RE::BSFixedString(scene),static_cast<RE::TESObjectREFR*>(nullptr))){
  done({{"ok",false},{"msg","OStim scene start is unavailable"}});
 }
}
// New-scene setup shares the existing OStim bridge, with an actor whitelist
// issued by the read. Request IDs are correlation, never actor authority.
std::string setupToken;
std::vector<uint32_t> setupActors;
std::chrono::steady_clock::time_point setupAt;
bool setupStarting=false;
void SetupRoster(std::function<void(json)> done){
 auto* api=Api();auto* pc=RE::PlayerCharacter::GetSingleton();
 if(!api||!pc){done({{"ok",false},{"msg","OStim is unavailable"}});return;}
 if(setupStarting){done({{"ok",false},{"msg","A scene start is already pending"}});return;}
 setupActors.clear();json rows=json::array();
 auto add=[&](RE::Actor* a){
  if(!a||setupActors.size()>=128||std::find(setupActors.begin(),setupActors.end(),a->GetFormID())!=setupActors.end())return;
  RE::Actor* checked=nullptr;const auto why=ResumeBlocker(a->GetFormID(),checked);
  if(!why.empty()||api->IsActorInAnyThread(a->GetFormID()))return;
  setupActors.push_back(a->GetFormID());rows.push_back({{"formId",a->GetFormID()},{"name",a==pc?"You":a->GetName()},{"player",a==pc}});
 };
 add(pc);auto* lists=RE::ProcessLists::GetSingleton();
 if(lists){for(auto& h:lists->highActorHandles){auto p=h.get();add(p?p.get():nullptr);}for(auto& h:lists->middleHighActorHandles){auto p=h.get();add(p?p.get():nullptr);}}
 setupToken=std::to_string(++epoch);setupAt=std::chrono::steady_clock::now();
 done({{"ok",true},{"token",setupToken},{"rows",rows}});
}
struct NewScene {
 std::vector<uint32_t> ids;std::vector<RE::Actor*> actors,dominants;
 uint32_t furnitureId=0;std::string place,clothing;bool manual=false;
 int builder=-1;std::function<void(json)> done;
};
bool ValidSetup(const json& req){return !setupToken.empty()&&req.value("token","")==setupToken&&std::chrono::steady_clock::now()-setupAt<std::chrono::minutes(5);}
std::string ValidateCast(const std::vector<uint32_t>& ids,std::vector<RE::Actor*>& actors){
 if(ids.empty()||ids.size()>8)return "Choose between one and eight participants";
 auto* api=Api();if(!api)return "OStim is unavailable";
 std::vector<uint32_t> seen;
 for(auto id:ids){
  if(std::find(setupActors.begin(),setupActors.end(),id)==setupActors.end()||std::find(seen.begin(),seen.end(),id)!=seen.end())return "Participants changed; refresh the list";
  RE::Actor* actor=nullptr;auto why=ResumeBlocker(id,actor);
  if(!why.empty()||api->IsActorInAnyThread(id))return "A participant is unavailable or already in a scene";
  seen.push_back(id);actors.push_back(actor);
 }
 return "";
}
void FailStart(std::shared_ptr<NewScene> d,const char* why){
 if(d->builder>=0)Call("OThreadBuilder","Cancel",[](RE::BSScript::Variable){},d->builder);
 setupStarting=false;d->done({{"ok",false},{"msg",why}});
}
void ConfigureStart(std::shared_ptr<NewScene> d,int step){
 auto next=[d,step](RE::BSScript::Variable){ConfigureStart(d,step+1);};bool sent=true;
 if(step==0){
  if(d->place=="floor")sent=Call("OThreadBuilder","NoFurniture",next,d->builder);
  else if(d->place=="furniture"){
   auto* ref=RE::TESForm::LookupByID<RE::TESObjectREFR>(d->furnitureId);
   if(!Nearby(ref)){FailStart(d,"Furniture is no longer nearby");return;}
   sent=Call("OThreadBuilder","SetFurniture",next,d->builder,ref);
  }else{ConfigureStart(d,step+1);return;}
 }else if(step==1){
  if(d->dominants.empty()){ConfigureStart(d,step+1);return;}
  sent=Call("OThreadBuilder","SetDominantActors",next,d->builder,d->dominants);
 }else if(step==2){
  if(d->clothing=="keep")sent=Call("OThreadBuilder","NoUndressing",next,d->builder);
  else if(d->clothing=="remove")sent=Call("OThreadBuilder","UndressActors",next,d->builder);
  else{ConfigureStart(d,step+1);return;}
 }else if(step==3){
  if(!d->manual){ConfigureStart(d,step+1);return;}
  sent=Call("OThreadBuilder","NoAutoMode",next,d->builder);
 }else{
  std::vector<RE::Actor*> current;const auto why=ValidateCast(d->ids,current);
  if(!why.empty()){FailStart(d,why.c_str());return;}
  sent=Call("OThreadBuilder","Start",[d](RE::BSScript::Variable v){
   setupStarting=false;const bool ok=v.IsInt()&&v.GetSInt()>=0;
   if(ok){setupToken.clear();setupActors.clear();}
   d->done({{"ok",ok},{"started",ok},{"msg",ok?"OStim accepted the scene start":"OStim could not start this combination"}});
  },d->builder);
 }
 if(!sent)FailStart(d,"OStim scene builder did not accept the request");
}
void StartNewScene(const json& req,std::function<void(json)> done){
 if(setupStarting||!ValidSetup(req)){done({{"ok",false},{"msg","Refresh the participants before starting"}});return;}
 auto d=std::make_shared<NewScene>();d->done=done;d->ids=req.value("actors",std::vector<uint32_t>{});
 const auto why=ValidateCast(d->ids,d->actors);if(!why.empty()){done({{"ok",false},{"msg",why}});return;}
 d->place=req.value("place","floor");d->clothing=req.value("clothing","settings");d->manual=req.value("manual",false);
 if(d->place!="floor"&&d->place!="auto"&&d->place!="furniture"){done({{"ok",false},{"msg","Invalid place selection"}});return;}
 for(auto id:req.value("dominants",std::vector<uint32_t>{})){
  auto at=std::find(d->ids.begin(),d->ids.end(),id);if(at==d->ids.end()){done({{"ok",false},{"msg","A role refers to someone outside the cast"}});return;}
  d->dominants.push_back(d->actors[at-d->ids.begin()]);
 }
 if(d->place=="furniture"){
  d->furnitureId=req.value("furniture",0u);
  if(scanScene!="setup:"+setupToken+":"+std::to_string(d->actors.size())||req.value("furnitureToken","")!=scanToken||!furniture.count(d->furnitureId)||std::chrono::steady_clock::now()-scanned>std::chrono::minutes(2)){
   done({{"ok",false},{"msg","Rescan compatible furniture for this cast"}});return;
  }
 }
 setupStarting=true;logger::info("dossier-scene-start: building scene with {} participants",d->actors.size());
 if(!Call("OThreadBuilder","Create",[d](RE::BSScript::Variable v){
  if(!v.IsInt()||v.GetSInt()<0){FailStart(d,"OStim rejected the selected participants");return;}
  d->builder=v.GetSInt();ConfigureStart(d,0);
 },d->actors))FailStart(d,"OStim scene builder is unavailable");
}
/* { formId, axis:"x"|"y"|"z"|"rotation"|"scale"|"bend"|"reset", delta }
   Steps are the overlay's to choose; the clamps are ours, and they are the
   SAME clamps the Scene page uses. */
std::string AlignAdjust(const std::string& payload){
 json req=json::parse(payload,nullptr,false);
 if(!req.is_object())return Dump({{"ok",false},{"msg","Invalid alignment request"}});
 auto* a=Api();
 const auto fid=req.value("formId",0u);
 const auto index=a?a->GetActorPosition(0,fid):-1;
 OT::ActorAlignmentData d{};
 if(index<0||!a->GetActorAlignment(0,index,&d))
  return Dump({{"ok",false},{"msg","Actor is no longer in this scene"}});
 if(!std::isfinite(d.scale)||d.scale<=0.f)d.scale=1.f;   // neutral is 1, never 0
 if(!std::isfinite(d.sosBend))d.sosBend=0.f;
 const auto axis=req.value("axis","");
 float delta=req.value("delta",0.f);
 if(!std::isfinite(delta)||std::abs(delta)>25.f)
  return Dump({{"ok",false},{"msg","Invalid adjustment"}});
 if(axis=="reset"){d.offsetX=d.offsetY=d.offsetZ=d.rotation=0.f;d.scale=1.f;d.sosBend=0.f;}
 else if(axis=="x")d.offsetX=std::clamp(d.offsetX+delta,-200.f,200.f);
 else if(axis=="y")d.offsetY=std::clamp(d.offsetY+delta,-200.f,200.f);
 else if(axis=="z")d.offsetZ=std::clamp(d.offsetZ+delta,-200.f,200.f);
 else if(axis=="rotation")d.rotation=std::remainder(d.rotation+delta,360.f);
 else if(axis=="scale")d.scale=std::clamp(d.scale+delta*0.05f,0.5f,2.f);
 else if(axis=="bend")d.sosBend=std::clamp(d.sosBend+delta,-10.f,9.f);
 else return Dump({{"ok",false},{"msg","Unknown alignment axis"}});
 const bool ok=a->SetActorAlignment(0,index,&d)==OT::APIResult::OK;
 logger::info("ostim-align: {} {:08X} {} {}",ok?"set":"refused",fid,axis,delta);  // marker: align-overlay
 return AlignStateJson();
}

bool ControlsMatch(const std::string& sig){return !sig.empty()&&sig==Signature();}
void ResetControls(){lightUndo.clear();sizeOriginal.clear();quickLightSent={};quickLightPending=false;++sceneGeneration;++epoch;scanToken.clear();furniture.clear();optionToken.clear();optionIds.clear();optionKeys.clear();actorBusy.clear();expressionSerial.clear();}
std::string SetAutoMode(){
 auto* a=Api();auto* s=OS::GetAPI();if(!a||!s||!a->IsThreadValid(0))return Dump({{"ok",false},{"msg","No controllable player scene"}});
 const bool on=!a->IsAutoMode(0);const bool ok=s->SetAutoMode("SkyManager",0,on)==OS::APIResult::OK;
 return Dump({{"ok",ok},{"auto",a->IsAutoMode(0)},{"msg",ok?(on?"Auto mode on":"Manual mode on"):"OStim refused auto mode"}});
}
void Controls(const std::string& payload, Reply reply){
 std::string request;
 try{
  const auto req=json::parse(payload);request=req.value("request","");const auto act=req.value("act","");
  auto done=[reply,request](json j){j["request"]=request;reply(Dump(j));};
  if(act=="setupRoster"){SetupRoster(done);return;}
  if(act=="setupStart"){StartNewScene(req,done);return;}
  if(act=="setupFurniture"){
   if(!ValidSetup(req)){done({{"ok",false},{"msg","Refresh participants first"}});return;}
   std::vector<RE::Actor*> actors;auto why=ValidateCast(req.value("actors",std::vector<uint32_t>{}),actors);
   if(!why.empty()){done({{"ok",false},{"msg",why}});return;}
   Scan(req,reply,static_cast<int>(actors.size()),setupToken);return;
  }
  if(act=="state"){done(State());return;}
  if(act=="lightingState"){done(LightingState());return;}
  if(act=="cameraState"){
   auto* camera=RE::PlayerCamera::GetSingleton();const auto fov=camera?camera->GetRuntimeData2().worldFOV:0.f;
   const bool valid=std::isfinite(fov)&&fov>1.f&&fov<=179.f;
   done({{"ok",valid},{"fov",valid?json(fov):json(nullptr)},{"msg",valid?"":"Current camera FOV is unavailable"}});return;
  }
  if(act=="expressions"){auto j=ExpressionCatalog();j["ok"]=true;done(j);return;}
  if(act=="photos"){
   std::thread([done](){json out={{"ok",true},{"images",json::array()}};
    try{const auto pool=json::parse(Journal::ImagesJson("{\"sweep\":false}"));for(const auto& row:pool["images"])if(row.value("f",std::string{}).rfind("ostim-",0)==0&&out["images"].size()<50)out["images"].push_back(row);}catch(...){out["ok"]=false;out["msg"]="Scene photos could not be read";}
    SKSE::GetTaskInterface()->AddTask([done,out](){done(out);});
   }).detach();return;
  }
  if(act=="scan"){logger::info("ostim-controls: compatible furniture scan");Scan(req,reply);return;}
  // ---- ABOVE the signature gate, deliberately -------------------------
  // Neither of these is about the running scene: clearing the room is about
  // the CELL, and PPA's config is a file on disk. Below the gate they would
  // be refused for the whole of every scene transition, which is exactly
  // when you reach for them.
  if(act=="privacy"){done(json::parse(ScenePrivacy::Control(payload)));return;}
  if(act=="room"){RoomControl(req,done);return;}
  // The live overlay is opened by C++ (it owns the HUD view and its Focus);
  // this verb only carries the request back out through the reply, the same
  // way lightingEditor and the photo camera do.
  if(act=="alignOverlay"){done({{"ok",true},{"alignOverlay",true},{"msg","Opening the live overlay"}});return;}
  /* OStim's own MCM switches, as real toggles (Rober, 2026-09-21: "need
     toggles for quick (end seen after climax, yes, no, etc, male, female,
     etc)"). Those are OSexIntegrationMCM options — EndOnPlayerOrgasm,
     EndOnMaleOrgasm, EndOnFemaleOrgasm, EndOnAllOrgasm and the role
     switches — and the deck already has a generic driver for any SkyUI MCM,
     so this adds no mechanics: it proxies skyui_mcm.
     ⚠ WORKER THREAD ONLY — both calls block on sequential Papyrus round
     trips, and doing that on the VM's own thread is the standing deadlock. */
  /* ReLight, natively (Rober, 2026-09-21: "open relight doesnt work, its
     doing a hotkey or something, lets build relight into a SkyManager
     menu"). Its ini is the whole configuration and its own menu writes the
     same file, so the SMF hotkey is cut out of the loop entirely. */
  /* The scene→pictogram index. ~8,000 JSON files, so WORKER ONLY and
     cached; the view asks once per session and falls back to its own
     name/id regexes for anything the index does not carry. */
  if(act=="sceneIcons"){
   const bool rescan=req.value("rescan",false);
   std::thread([rescan,done](){
    auto parsed=json::parse(SceneTags::MapJson(rescan),nullptr,false);
    if(!parsed.is_object())parsed=json{{"ok",false},{"icons",json::object()}};
    SKSE::GetTaskInterface()->AddTask([done,parsed](){done(parsed);});
   }).detach();
   return;
  }
  // Icon choices are private display metadata, independent of a running
  // scene or its signature. Serialize file IO on a worker, then reply on main.
  if(act=="sceneIconChoices"||act=="sceneIconSet"){
   const auto body=Dump(req);
   std::thread([act,body,done](){
    auto parsed=json::parse(act=="sceneIconSet"?SceneTags::SetChoiceJson(body):SceneTags::ChoicesJson(),nullptr,false);
    if(!parsed.is_object())parsed=json{{"ok",false},{"msg","The icon choices request could not be completed."}};
    SKSE::GetTaskInterface()->AddTask([done,parsed](){done(parsed);});
   }).detach();
   return;
  }
  if(act=="relight"){
   const auto op=req.value("op","state");
   if(op=="state"){done(json::parse(RelightConfig::StateJson()));return;}
   done(json::parse(RelightConfig::Apply(Dump(json{{"op",op},
     {"key",req.value("key","")},{"value",req.value("value","")},
     {"line",req.value("line",-1)}}))));
   return;
  }
  if(act=="mcm"){
   const auto op=req.value("op","scan");
   json body=req;
   std::thread([op,body,done](){
    std::string out;
    if(op=="set"){
     out=SkyuiMcm::SetJson(Dump(json{{"id",body.value("id","OSexIntegrationMCM")},
       {"p",body.value("p",0)},{"i",body.value("i",0)},
       {"act",body.value("what","toggle")},{"value",body.value("value",0.0)}}));
    }else{
     out=SkyuiMcm::ScanJson(Dump(json{{"id",body.value("id","OSexIntegrationMCM")}}));
    }
    auto parsed=json::parse(out,nullptr,false);
    if(!parsed.is_object())parsed=json{{"ok",false},{"why","OStim's MCM did not answer"}};
    SKSE::GetTaskInterface()->AddTask([done,parsed](){done(parsed);});
   }).detach();
   return;
  }
  if(act=="ppa"){
   const auto op=req.value("op","state");
   if(op=="state"){done(json::parse(PpaConfig::StateJson()));return;}
   if(op=="set"){done(json::parse(PpaConfig::Set(Dump(json{{"key",req.value("key","")},{"value",req.value("value","")}}))));return;}
   done({{"ok",false},{"msg","Unknown PPA request"}});return;
  }
  /* Hold & resume sit ABOVE the gate for the same reason `room` does, only
     more so: the whole point of a held scene is that NO scene is running
     while you carry it somewhere, so a signature check would refuse the one
     verb you need. `hold` re-checks the live thread itself. */
  if(act=="held"){
   const auto op=req.value("op","state");
   if(op=="state"){done(HeldJson());return;}
   if(op=="hold"){HoldScene(done);return;}
   if(op=="resume"){ResumeScene(done);return;}
   if(op=="discard"){g_held=HeldScene{};json j=HeldJson();j["msg"]="Held scene discarded";done(j);return;}
   done({{"ok",false},{"msg","Unknown hold request"}});return;
  }
  auto* a=Api();const auto sig=Signature();
  if(!a||sig.empty()||req.value("signature","")!=sig){done({{"ok",false},{"msg","Scene changed; refresh the controls"}});return;}
  if(act=="lighting"){LightingControl(req,done);return;}
  if(act=="lightingEditor"){
   const bool available=GetModuleHandleW(L"ReLight.dll")&&GetModuleHandleW(L"SKSEMenuFramework.dll");
   done({{"ok",available},{"lightingEditor",available},{"msg",available?"Choose ReLight in the SKSE menu":"ReLight and SKSE Menu Framework must both be loaded"}});return;
  }
  if(act=="sizeState"||act=="size"||act=="sizeRestore"||act=="actorState"||act=="expression"||act=="expressionClear"||act=="mute"||act=="redress"){ActorControl(req,sig,done);return;}
  // ---- the unified Scene page's own verbs (2026-09-21) ----
  if(act=="here"){CurrentFurniture(req,done);return;}
  if(act=="undressState"||act=="undress"){UndressControl(req,sig,done);return;}
  if(act=="voices"){VoiceCatalog(req,done);return;}
  if(act=="voiceState"){VoiceState(req,sig,done);return;}
  if(act=="setVoice"){SetVoice(req,sig,done);return;}
  if(act=="roster"){SceneRoster(req,sig,done);return;}
  if(act=="join"||act=="part"){SceneMigrate(req,sig,done);return;}
  if(act=="sosState"||act=="sos"){SceneSos(req,sig,done);return;}
  if(act=="photo"){
   const auto fov=req.value("fov","keep");if(fov!="keep"&&fov!="out"&&fov!="in"&&fov!="exact"){done({{"ok",false},{"msg","Choose a valid FOV"}});return;}
   const float degrees=req.value("degrees",0.f);
   if(fov=="exact"&&(!std::isfinite(degrees)||degrees<20.f||degrees>120.f)){done({{"ok",false},{"msg","Photo FOV must be between 20 and 120 degrees"}});return;}
   done({{"ok",true},{"camera",true},{"fov",fov},{"degrees",degrees},{"freeze",req.value("freeze",false)},{"signature",sig},{"label",a->GetCurrentSceneID(0)?a->GetCurrentSceneID(0):"Scene"}});return;
  }
  if(act=="auto"){done(json::parse(SetAutoMode()));return;}
  if(act=="speed"){done(json::parse(Speed(req.value("delta","+"))));return;}
  if(act=="stop"){auto* s=OS::GetAPI();bool ok=s&&s->StopScene("SkyManager",0)==OS::APIResult::OK;done({{"ok",ok},{"msg",ok?"Scene stopped":"OStim refused stop"}});return;}
  if(act=="align"){
   const auto fid=req.value("formId",0u);const auto index=a->GetActorPosition(0,fid);OT::ActorAlignmentData d{};
   if(index<0||!a->GetActorAlignment(0,index,&d)){done({{"ok",false},{"msg","Actor is no longer in this scene"}});return;}
   const auto axis=req.value("axis","");float delta=req.value("delta",0.f);
   if(!std::isfinite(delta)||std::abs(delta)>10.f){done({{"ok",false},{"msg","Invalid adjustment"}});return;}
   if(axis=="reset"){d.offsetX=d.offsetY=d.offsetZ=d.rotation=0;}
   else if(axis=="x")d.offsetX=std::clamp(d.offsetX+delta,-200.f,200.f);
   else if(axis=="y")d.offsetY=std::clamp(d.offsetY+delta,-200.f,200.f);
   else if(axis=="z")d.offsetZ=std::clamp(d.offsetZ+delta,-200.f,200.f);
   else if(axis=="rotation")d.rotation=std::remainder(d.rotation+delta,360.f);
   else{done({{"ok",false},{"msg","Unknown alignment axis"}});return;}
   bool ok=a->SetActorAlignment(0,index,&d)==OT::APIResult::OK;
   done({{"ok",ok},{"msg",ok?"Alignment requested":"OStim refused alignment"}});return;
  }
  if(act=="options"||act=="option"){
   if(act=="options")a->RebuildOptionsTree();
   if(act=="option"){
    const auto i=req.value("index",-1);
    if(req.value("token","")!=optionToken||i<0||i>=static_cast<int>(optionIds.size())){done({{"ok",false},{"msg","Settings changed; refresh"}});return;}
    std::vector<OT::OptionsMenuItem> now(std::min(a->GetOptionsItemCount(),511u)+1);const auto available=a->GetOptionsItems(now.data(),static_cast<uint32_t>(now.size()));
    if(i>=static_cast<int>(available)||optionIds[i]!=(now[i].id?now[i].id:"")){done({{"ok",false},{"msg","Settings changed; refresh"}});return;}
    bool same=available==optionKeys.size();
    for(uint32_t k=0;same&&k<available;++k)same=OptionKey(now[k])==optionKeys[k];
    if(!same){done({{"ok",false},{"msg","Settings changed; refresh"}});return;}
    // GetOptionsItems includes the back row. Its node ID is -1; Handle expects
    // that ID, NOT our buffer index (which would select the next option).
    const auto nativeIndex=std::stoi(optionIds[i]);
    if(nativeIndex < -1 || nativeIndex >= static_cast<int>(available)-1){done({{"ok",false},{"msg","Invalid OStim option"}});return;}
    if(!a->SelectOptionsItem(nativeIndex)){done({{"ok",true},{"exit",true},{"msg","Settings closed"}});return;}
   }
   std::vector<OT::OptionsMenuItem> items(std::min(a->GetOptionsItemCount(),511u)+1);const auto n=a->GetOptionsItems(items.data(),static_cast<uint32_t>(items.size()));
   json rows=json::array();optionIds.clear();optionKeys.clear();optionToken=std::to_string(++epoch);
   for(uint32_t i=0;i<n;++i){auto& v=items[i];optionIds.emplace_back(v.id?v.id:"");optionKeys.push_back(OptionKey(v));rows.push_back({{"index",i},{"title",v.title?v.title:"Option"},{"detail",v.description?v.description:""}});}
   done({{"ok",true},{"options",rows},{"token",optionToken},{"root",a->IsOptionsAtRoot()}});return;
  }
  if(act=="floor"){
   const bool ok=Call("OThread","ChangeFurniture",[done](RE::BSScript::Variable){done({{"ok",true},{"msg","Furniture change sent; check the scene"}});},0,static_cast<RE::TESObjectREFR*>(nullptr),RE::BSFixedString(""));
   if(!ok)done({{"ok",false},{"msg","OStim furniture control unavailable"}});return;
  }
  if(act=="move"||act=="highlight"){
   const auto fid=req.value("formId",0u);auto* ref=RE::TESForm::LookupByID<RE::TESObjectREFR>(fid);
   if(req.value("token","")!=scanToken||scanScene!=sig||!furniture.count(fid)||!Nearby(ref)||std::chrono::steady_clock::now()-scanned>std::chrono::seconds(60)){done({{"ok",false},{"msg","Furniture list expired; rescan"}});return;}
   if(act=="highlight"){bool ok=LootHighlight::Ping(fid);done({{"ok",ok},{"msg",ok?"Furniture highlighted for 8 seconds":"Highlight unavailable"}});return;}
   // Recheck occupancy/compatibility through OStim immediately before moving.
   auto* pc=RE::PlayerCharacter::GetSingleton();int count=static_cast<int>(a->GetActorCount(0));
   if(!Call("OFurniture","FindFurniture",[done,sig,fid](RE::BSScript::Variable v){
    bool found=false;if(v.IsArray()&&v.GetArray())for(auto& slot:*v.GetArray()){auto* r=Ref(slot);if(r&&r->GetFormID()==fid&&Nearby(r))found=true;}
    if(sig!=Signature()||!found){done({{"ok",false},{"msg","Furniture is no longer available; rescan"}});return;}
    auto* r=RE::TESForm::LookupByID<RE::TESObjectREFR>(fid);
    if(!Call("OThread","ChangeFurniture",[done](RE::BSScript::Variable){done({{"ok",true},{"msg","Furniture change sent; check the scene"}});},0,r,RE::BSFixedString("")))done({{"ok",false},{"msg","OStim refused furniture request"}});
   },count,static_cast<RE::TESObjectREFR*>(pc),2560.f,4000.f))done({{"ok",false},{"msg","Furniture validation unavailable"}});return;
  }
  done({{"ok",false},{"msg","Unknown scene control"}});
 }catch(const std::exception&){reply(Dump({{"ok",false},{"request",request},{"msg","Invalid scene control request"}}));}
}
}
