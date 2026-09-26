#include "scene_privacy.h"
#include "npc_clearance.h"
#include "ostim_deck.h"
#include "actor_identity.h"
#include <filesystem>
#include <fstream>
#include <chrono>
#include <cmath>
#include <unordered_set>
#include <mutex>
#include <thread>
#include <condition_variable>
#include <algorithm>

namespace ScenePrivacy {
namespace {
using json=nlohmann::json;
using Clock=std::chrono::steady_clock;
const std::filesystem::path Root=std::filesystem::path("Data")/"SKSE"/"Plugins"/"HotkeyDeck";
json settings={{"automatic",false},{"scope","claimed"},{"invited",json::array()}};
json lastCommand=json::object();
json state=json::object(), rows=json::array(), destination=json::object();
RoomGuard::Config rooms;
bool loaded=false, ready=false, manual=false, suppressed=false, active=false;
std::uint32_t cellId=0;
std::string scopeKey, epoch;
std::uint64_t sequence=0, sceneGeneration=0;
Clock::time_point lastTick{}, rosterAt{};
std::unordered_set<std::uint32_t> listed, protectedActors;
std::mutex diskMutex;
std::condition_variable diskWake;
json pendingPacket;
bool diskStarted=false, diskDirty=false;
std::string Dump(const json& j){return j.dump(-1,' ',false,json::error_handler_t::replace);}
bool AtomicWrite(const std::filesystem::path& path,const json& value){
    std::error_code ec;std::filesystem::create_directories(path.parent_path(),ec);
    auto tmp=path;tmp+=".tmp";
    {std::ofstream out(tmp,std::ios::binary|std::ios::trunc);if(!out)return false;out<<Dump(value);out.flush();if(!out)return false;}
    return MoveFileExW(tmp.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)!=0;
}
void Publish(json packet){
    std::lock_guard lock(diskMutex);pendingPacket=std::move(packet);diskDirty=true;
    if(!diskStarted){diskStarted=true;std::thread([](){for(;;){
        json next;{std::unique_lock lock(diskMutex);diskWake.wait(lock,[]{return diskDirty;});next=std::move(pendingPacket);diskDirty=false;}
        if(!AtomicWrite(Root/"scene-privacy-state.json",next))logger::warn("scene-privacy: state publication failed");
    }}).detach();}
    diskWake.notify_one();
}
void Load(){
    if(loaded)return;loaded=true;
    std::ifstream f(Root/"scene-privacy.json");if(f){const auto j=json::parse(f,nullptr,false);if(j.is_object()){
        settings=j;if(!settings.contains("invited")||!settings["invited"].is_array())settings["invited"]=json::array();
    }}
    auto& invitations=settings["invited"];
    invitations.erase(std::remove_if(invitations.begin(),invitations.end(),[](const json& n){
        return !n.is_object() || !n.contains("key") || !n["key"].is_string() || !n.contains("form") || !n["form"].is_string() || !n.contains("plugin") || !n["plugin"].is_string() || !n.contains("name") || !n["name"].is_string();
    }),invitations.end());
    if(!settings.contains("automatic")||!settings["automatic"].is_boolean())settings["automatic"]=false;
    if(!settings.contains("scope")||!settings["scope"].is_string()||(settings["scope"]!="claimed"&&settings["scope"]!="cell"))settings["scope"]="claimed";
    logger::info("scene-privacy: automatic room guard and witness boundary ready");
}
std::string Name(RE::Actor* a){const auto n=a?a->GetDisplayFullName():nullptr;return n?n:"NPC";}
std::string Identity(RE::Actor* a){
    std::string form,plugin;if(!a||!ActorIdentity::DurableOf(a,form,plugin))return "";
    return ActorIdentity::Key(form,plugin);
}
bool Invited(RE::Actor* a){
    const auto key=Identity(a);if(key.empty())return false;
    for(const auto& n:settings["invited"])if(n.is_object()&&n.value("key",std::string())==key)return true;
    return false;
}
bool NeverMove(RE::Actor* a){
    auto* base=a?a->GetActorBase():nullptr;if(!base)return false;
    for(const auto& n:rooms.ignore)if(n.valid()&&ActorIdentity::Resolve(n.localId,n.plugin)==base)return true;
    return false;
}
bool Inside(const RoomGuard::Room& r,const RE::NiPoint3& p){
    if(r.wholeCell)return true;
    if(std::abs(p.z-r.z)>r.height)return false;
    const float x=p.x-r.x,y=p.y-r.y;
    if(r.shape=="box"){const float sn=std::sin(r.yaw),cs=std::cos(r.yaw);return std::abs(x*cs-y*sn)<=r.halfX&&std::abs(x*sn+y*cs)<=r.halfY;}
    return x*x+y*y<=r.radius*r.radius;
}
std::string ReadBridge(bool privateNow){
    try{
    std::ifstream f(Root/"scene-privacy-ack.json");if(!f)return "CHIM bridge not confirmed";
    const auto j=json::parse(f,nullptr,false);
    const auto now=std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    if(!j.is_object()||j.value("epoch",std::string())!=epoch||j.value("sequence",std::uint64_t(0))>sequence||j.value("private",false)!=privateNow||now-j.value("at",std::int64_t(0))>15||now<j.value("at",std::int64_t(0)))return "CHIM bridge awaiting fresh confirmation";
    return j.value("ok",false)?"CHIM witness filter connected":"CHIM bridge reported an error";
    }catch(...){return "CHIM bridge confirmation unreadable";}
}
void Evaluate(){
    Load();rows=json::array();listed.clear();protectedActors.clear();destination=json::object();
    auto* player=RE::PlayerCharacter::GetSingleton();auto* cell=player?player->GetParentCell():nullptr;
    const bool inScene=ready&&OstimDeck::PlayerInScene();
    const auto generation=OstimDeck::PlayerSceneGeneration();
    if(!inScene || generation!=sceneGeneration)suppressed=false;
    sceneGeneration=generation;
    if(!ready||!cell){active=false;state={{"ok",false},{"msg","Load a game first"}};return;}
    const auto currentCell=cell->GetFormID();
    const RoomGuard::Room* room=nullptr;
    if(settings["scope"]=="claimed")for(const auto& r:rooms.rooms)if(r.cellId==currentCell&&Inside(r,player->GetPosition())){room=&r;break;}
    std::string why, label;
    bool valid=cell->IsInteriorCell();
    if(!valid)why="Privacy needs an interior";
    else if(settings["scope"]=="claimed"&&!room){valid=false;why="Claim this room in Rooms, or choose Whole interior";}
    const std::string nextKey=valid?std::to_string(currentCell)+":"+(room?room->id:"cell"):"";
    if(cellId&&scopeKey!=nextKey){manual=false;NpcClearance::RestorePrivacy();}
    cellId=currentCell;scopeKey=nextKey;
    if(valid){
        label=room?room->name:std::string(cell->GetFullName()?cell->GetFullName():"Whole interior");
        if(room&&!room->wholeCell){
            if(room->hasAnchor&&!Inside(*room,{room->ax,room->ay,room->az}))destination={{"name","Outside "+room->name},{"cellId",currentCell},{"x",room->ax},{"y",room->ay},{"z",room->az},{"angleZ",room->aangle}};
            else why="Set an exit anchor outside this room in Rooms";
        }else destination=json::parse(NpcClearance::PrivacyExit());
        if(destination.empty()&&why.empty())why="No usable exit door; claim a room with an exit anchor";
    }
    const bool automatic=settings.value("automatic",false);
    const bool requested=manual||(automatic&&inScene&&!suppressed);
    active=valid&&requested;
    if(!active)NpcClearance::RestorePrivacy();
    json witnesses=json::array({Name(player)}), participants=json::array();
    protectedActors.insert(player->GetFormID());
    std::unordered_set<std::uint32_t> playerCast;
    const auto scene=json::parse(OstimDeck::StateJson(),nullptr,false);
    if(scene.is_object()&&scene.contains("actors"))for(const auto& a:scene["actors"])playerCast.insert(a.value("formId",0u));
    int blocked=0;
    auto* lists=RE::ProcessLists::GetSingleton();std::unordered_set<std::uint32_t> seen;
    auto add=[&](RE::Actor* a){
        if(!a||a==player||a->IsDead()||a->IsDisabled()||!a->Is3DLoaded()||a->GetParentCell()!=cell||!seen.insert(a->GetFormID()).second)return;
        const auto id=a->GetFormID();const bool here=!room||Inside(*room,a->GetPosition());
        const bool cast=playerCast.count(id)>0,guest=Invited(a);
        if(cast||guest)protectedActors.insert(id);
        if(cast)participants.push_back(Name(a));
        if(valid&&here&&(guest||cast))witnesses.push_back(Name(a));
        std::string status=cast?"Scene participant":guest?"Invited":!here?"Outside the boundary":"Not invited";
        if(active&&here&&!cast&&!guest){
            if(destination.empty()){status=why;++blocked;}
            else if(NeverMove(a)){status="Rooms: never move (not a witness invitation)";++blocked;}
            else{const auto result=json::parse(NpcClearance::HoldPrivacy(id,Dump(destination)));status=result.value("msg",std::string("Not moved"));if(!result.value("ok",false))++blocked;}
        }
        rows.push_back({{"formId",id},{"name",Name(a)},{"key",Identity(a)},{"invited",guest},{"participant",cast},{"inside",here},{"status",status}});listed.insert(id);
    };
    if(lists){for(auto& h:lists->highActorHandles){auto ptr=h.get();add(ptr?ptr.get():nullptr);}for(auto& h:lists->middleHighActorHandles){auto ptr=h.get();add(ptr?ptr.get():nullptr);}}
    const auto held=json::parse(NpcClearance::PrivacyHeldJson());
    for(const auto& h:held){const auto id=h.value("formId",0u);listed.insert(id);auto* a=RE::TESForm::LookupByID<RE::Actor>(id);if(a&&(Invited(a)||playerCast.count(id)))NpcClearance::RestorePrivacy(id);}
    const auto now=std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    if(epoch.empty())epoch=std::to_string(now)+"-"+std::to_string(GetCurrentProcessId())+"-"+std::to_string(++sequence);
    // CHIM stays private throughout an armed room, including before scene start,
    // so the first scene event cannot race a start-event/next-tick boundary.
    const bool chim=valid&&(manual||automatic);
    json invitations=settings["invited"];
    for(auto& n:invitations)if(n.is_object()){auto* a=ActorIdentity::ResolveActor(n.value("form",std::string()),n.value("plugin",std::string()));n["formId"]=a?a->GetFormID():0u;}
    state={{"ok",true},{"automatic",automatic},{"manual",manual},{"active",active},{"inScene",inScene},{"scope",settings["scope"]},
        {"blocked",blocked},{"scopeName",label},{"scopeValid",valid},{"canMove",!destination.empty()},{"msg",why},{"rows",rows},{"held",json::parse(NpcClearance::PrivacyHeldJson())},
        {"invited",invitations},{"lastCommand",lastCommand},{"chimPrivate",chim},{"bridge",ReadBridge(chim)},{"epoch",epoch}};
    Publish({{"version",1},{"epoch",epoch},{"sequence",++sequence},{"at",now},{"private",chim},{"scope",label},{"witnesses",witnesses},{"participants",participants},{"ui",state}});
    rosterAt=Clock::now();
}
}
void Tick(const RoomGuard::Config& cfg,bool worldReady){
    ready=worldReady;if(!ready)return;const auto now=Clock::now();if(now-lastTick<std::chrono::milliseconds(500))return;
    lastTick=now;rooms=cfg;try{Evaluate();}catch(const std::exception& e){logger::error("scene-privacy: tick failed: {}",e.what());}
}
bool KeepsInside(std::uint32_t id){return active&&protectedActors.count(id)>0;}
void Reset(){
    ready=false;manual=false;active=false;suppressed=false;cellId=0;scopeKey.clear();epoch.clear();listed.clear();protectedActors.clear();lastTick={};
    // Do not publish privacy-off while a load is in flight. The CHIM side fails
    // closed on stale active telemetry until a new authoritative packet arrives.
}
std::string Control(const std::string& payload){
    Load();const auto req=json::parse(payload,nullptr,false);if(!req.is_object())return Dump({{"ok",false},{"msg","Invalid privacy request"}});
    std::string error;const auto before=settings;const bool beforeManual=manual;
    try{
        const auto op=req.value("op",std::string("state"));
        if(req.contains("epoch")&&req.at("epoch").get<std::string>()!=epoch)throw std::runtime_error("Game changed; refresh privacy");
        if(op=="automatic")settings["automatic"]=req.at("value").get<bool>();
        else if(op=="scope"){
            auto value=req.at("value").get<std::string>();if(value!="claimed"&&value!="cell")throw std::runtime_error("Unknown privacy scope");
            NpcClearance::RestorePrivacy();manual=false;settings["scope"]=value;
        }else if(op=="manual"){
            if(!ready||!state.value("scopeValid",false))throw std::runtime_error("Choose a valid interior privacy boundary first");
            manual=req.at("value").get<bool>();
        }else if(op=="release"){manual=false;suppressed=true;NpcClearance::RestorePrivacy();}
        else if(op=="invite"||op=="uninvite"){
            const auto id=req.at("formId").get<std::uint32_t>();
            if(!ready||!listed.count(id)||Clock::now()-rosterAt>std::chrono::seconds(15))throw std::runtime_error("Roster expired; refresh privacy");
            auto* a=RE::TESForm::LookupByID<RE::Actor>(id);const auto key=Identity(a);
            if(!a||key.empty())throw std::runtime_error("This temporary NPC has no durable invitation identity");
            auto& list=settings["invited"];list.erase(std::remove_if(list.begin(),list.end(),[&](const json& n){return n.is_object()&&n.value("key",std::string())==key;}),list.end());
            if(op=="invite"){
                std::string form,plugin;ActorIdentity::DurableOf(a,form,plugin);
                list.push_back({{"key",key},{"form",form},{"plugin",plugin},{"name",Name(a)}});NpcClearance::RestorePrivacy(id);
            }
        }else if(op=="removeInvitation"){
            const auto key=req.at("key").get<std::string>();auto& list=settings["invited"];
            list.erase(std::remove_if(list.begin(),list.end(),[&](const json& n){return n.is_object()&&n.value("key",std::string())==key;}),list.end());
        }else if(op!="state")throw std::runtime_error("Unknown privacy action");
        if(op!="state"&&!AtomicWrite(Root/"scene-privacy.json",settings))throw std::runtime_error("Privacy settings could not be saved");
    }catch(const std::exception& e){settings=before;manual=beforeManual;error=e.what();}
    if(req.contains("commandId")&&req["commandId"].is_string())lastCommand={{"id",req["commandId"]},{"ok",error.empty()&&ready},{"msg",error.empty()?"Privacy updated":error}};
    if(ready)Evaluate();json out=state;out["ok"]=error.empty()&&ready;if(!error.empty())out["msg"]=error;return Dump(out);
}
}
