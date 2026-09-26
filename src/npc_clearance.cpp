#include "npc_clearance.h"
#include "npc_clearance_geometry.h"
#include "ostim_deck.h"
#include "place_actions.h"
#include <chrono>
#include <unordered_set>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <algorithm>
#include <cmath>

using json=nlohmann::json;
namespace NpcClearance {
namespace {
using namespace NpcClearanceGeometry;
std::unordered_set<RE::FormID> listed;
std::string token;
std::chrono::steady_clock::time_point scanned{};
json last=json::object();
constexpr float Range=35.f*UnitsPerFoot;
constexpr size_t MaxMove=24;

// ---- clear-the-room state: who is parked where, and where they came from ----
struct Held { RE::FormID formId=0, baseId=0; std::string name; std::uint32_t cellId=0; float x=0,y=0,z=0,angle=0; bool ai=true, privacy=false; };
constexpr std::uint32_t HoldRecord=0x4E504348; // NPCH, inside the existing HDTM co-save
bool cosaveLoaded=false;
std::vector<Held> held;
std::filesystem::path HeldPath(){ return std::filesystem::path("Data")/"SKSE"/"Plugins"/"HotkeyDeck"/"cleared-npcs.json"; }
void SaveHeld(){
    // Diagnostic recovery copy only. Automatic restore reads the matched SKSE
    // co-save, never global reference ids left over from another playthrough.
    json arr=json::array();
    for(const auto& h:held)arr.push_back({{"formId",h.formId},{"baseId",h.baseId},{"ai",h.ai},{"privacy",h.privacy},{"name",h.name},{"cellId",h.cellId},{"x",h.x},{"y",h.y},{"z",h.z},{"angle",h.angle}});
    std::error_code ec; std::filesystem::create_directories(HeldPath().parent_path(),ec);
    if(held.empty()){std::filesystem::remove(HeldPath(),ec);return;}
    std::ofstream f(HeldPath(),std::ios::binary|std::ios::trunc); if(f) f<<json{{"held",arr}}.dump(1);
}
// Where "out of the cell" is. First choice: the cell's own door — where it leads
// is by definition outside this room (the exterior, or the next room of a
// dungeon), and the door's teleport data carries the exact arrival spot the game
// itself uses. Fallback: the engine's body-cleanup cell (WIDeadBodyCleanupCell —
// the game parks its own dead there; a living actor with its AI off is just as
// safe), at that cell's first placed reference.
bool Parking(RE::TESObjectCELL* from, RE::TESObjectCELL*& cell, Point& at, float& angle, std::string& how, bool fallback=true){
    cell=nullptr;
    if(from){
        for(const auto& rp:from->GetRuntimeData().references){
            auto* ref=rp.get(); if(!ref||ref->IsDeleted()) continue;
            auto* base=ref->GetBaseObject(); if(!base||base->GetFormType()!=RE::FormType::Door) continue;
            const auto* tp=ref->extraList.GetByType<RE::ExtraTeleport>(); if(!tp||!tp->teleportData) continue;
            auto linkedPtr=tp->teleportData->linkedDoor.get(); auto* linked=linkedPtr?linkedPtr.get():nullptr; if(!linked) continue;
            auto* target=linked->GetParentCell(); if(!target||target==from) continue;
            const auto& p=tp->teleportData->position; if(!std::isfinite(p.x)||!std::isfinite(p.y)||!std::isfinite(p.z)) continue;
            cell=target; at={p.x,p.y,p.z}; angle=tp->teleportData->rotation.z;
            const char* nm=target->GetFullName(); how=std::string("through the door to ")+((nm&&*nm)?nm:(target->IsInteriorCell()?"the next room":"outside"));
            return true;
        }
    }
    if(!fallback)return false;
    auto* park=RE::TESForm::LookupByEditorID<RE::TESObjectCELL>("WIDeadBodyCleanupCell");
    if(!park) return false;
    Point p{0,0,0}; bool got=false;
    for(const auto& rp:park->GetRuntimeData().references){ auto* ref=rp.get(); if(!ref) continue; const auto q=ref->GetPosition(); p={q.x,q.y,q.z}; got=true; break; }
    cell=park; at=p; angle=0; how=got?"into the engine's holding cell":"into the engine's holding cell (at its origin)";
    return true;
}
Point Position(RE::TESObjectREFR* a){const auto p=a->GetPosition();return {p.x,p.y,p.z};}
std::string Name(RE::Actor* a){const auto n=a->GetDisplayFullName();return n&&n[0]?n:"NPC";}
std::string Dump(const json& j){return j.dump(-1,' ',false,json::error_handler_t::replace);}
std::vector<RE::Actor*> Actors(RE::PlayerCharacter* p) {
    std::vector<RE::Actor*> out; std::unordered_set<RE::FormID> seen;
    auto* lists=RE::ProcessLists::GetSingleton();if(!p||!lists||!p->GetParentCell())return out;
    const auto pp=Position(p);
    auto take=[&](const auto& handles){for(const auto& h:handles){auto ptr=h.get();auto* a=ptr?ptr.get():nullptr;
        if(!a||a==p||a->IsPlayerRef()||a->IsDisabled()||a->IsDead()||!a->Is3DLoaded())continue;
        auto* cell=a->GetParentCell();if(!cell)continue;
        if(p->GetParentCell()->IsInteriorCell() ? cell!=p->GetParentCell() : (cell->IsInteriorCell()||a->GetWorldspace()!=p->GetWorldspace()))continue;
        const auto pos=Position(a);if(Distance2D(pp,pos)>Range||std::abs(pp.z-pos.z)>140)continue;
        if(seen.insert(a->GetFormID()).second)out.push_back(a);
    }};
    take(lists->highActorHandles);take(lists->middleHighActorHandles);
    std::sort(out.begin(),out.end(),[&](auto* a,auto* b){auto da=Distance2D(pp,Position(a)),db=Distance2D(pp,Position(b));return da==db?a->GetFormID()<b->GetFormID():da<db;});
    if(out.size()>128)out.resize(128);return out;
}
std::string Busy(RE::Actor* a){
    if(!a || a->IsPlayerRef() || a->IsDead() || a->IsDisabled())return "Unavailable actor";
    if(auto* mt=RE::MenuTopicManager::GetSingleton()){auto speaker=mt->speaker.get();if(speaker&&speaker.get()==a)return "In dialogue";}
    RE::NiPointer<RE::Actor> mount;
    if(a->GetMount(mount) && mount)return "Riding a mount";
    if(a->GetMountedBy(mount) && mount)return "Being ridden";
    if(a->IsInKillMove())return "In a kill move";
    if(a->IsInCombat())return "In combat";
    if(a->GetCurrentScene())return "In a scripted scene";
    if(auto* s=a->AsActorState()){
        if(s->GetSitSleepState()!=RE::SIT_SLEEP_STATE::kNormal)return "Sitting or sleeping";
        if(s->IsFlying()||s->IsSwimming())return "Flying or swimming";
    }
    if(OstimDeck::ActorInScene(a->GetFormID()))return "In an OStim scene";
    return "";
}
bool Ray(Point from,Point to,float& fraction,float& normalZ){
    auto* tes=RE::TES::GetSingleton();if(!tes)return false;
    RE::bhkPickData pick{};
    const float s=RE::bhkWorld::GetWorldScale();
    pick.rayInput.from=RE::hkVector4(from.x*s,from.y*s,from.z*s,0);
    pick.rayInput.to=RE::hkVector4(to.x*s,to.y*s,to.z*s,0);
    // The engine's pathing-pick layer tests scenery without selecting bodies.
    pick.rayInput.filterInfo=static_cast<std::uint32_t>(RE::COL_LAYER::kPathingPick);
    pick.rayInput.enableShapeCollectionFilter=true;
    pick.ray=pick.rayInput.to-pick.rayInput.from;
    pick.rayOutput.Reset();tes->Pick(pick);
    if(!pick.rayOutput.HasHit())return false;
    fraction=pick.rayOutput.hitFraction;
    float normal[4];_mm_storeu_ps(normal,pick.rayOutput.normal.quad);normalZ=normal[2];
    return std::isfinite(fraction)&&fraction>=0&&fraction<=1;
}
bool Ground(Point p,float& floor){
    Point top{p.x,p.y,p.z+42},bottom{p.x,p.y,p.z-64};float f=0,n=0;
    if(!Ray(top,bottom,f,n)||n<.7f)return false;
    floor=top.z+(bottom.z-top.z)*f;return std::isfinite(floor);
}
bool Clear(Point from,Point to){float f=0,n=0;return !Ray(from,to,f,n);}
}
void Reset(){listed.clear();token.clear();last=json::object();scanned={};}
int HeldCount(){return static_cast<int>(std::count_if(held.begin(),held.end(),[](const Held& h){return !h.privacy;}));}
std::string HeldJson(){json arr=json::array();for(const auto& h:held)if(!h.privacy)arr.push_back({{"formId",h.formId},{"name",h.name}});return Dump(arr);}
std::string ClearRoom(const std::string& request){
    json out={{"ok",false},{"held",0},{"results",json::array()}};
    auto finish=[&](const std::string& msg){out["msg"]=msg;last=out;return Dump(out);};
    const auto req=json::parse(request,nullptr,false);
    if(!req.is_object()||!req.contains("token")||!req["token"].is_string()||!req.contains("ids")||!req["ids"].is_array())return finish("Invalid request");
    out["token"]=req["token"];
    if(req["token"].get<std::string>()!=token||std::chrono::steady_clock::now()-scanned>std::chrono::seconds(10))return finish("Nearby list expired — open Get away from me again");
    if(req["ids"].empty()||req["ids"].size()>MaxMove)return finish("Select between 1 and 24 nearby NPCs");
    auto* p=RE::PlayerCharacter::GetSingleton();if(!p||!p->GetParentCell()||!RE::TES::GetSingleton())return finish("World is not ready");
    RE::TESObjectCELL* park=nullptr; Point at{}; float pang=0; std::string how;
    if(!Parking(p->GetParentCell(),park,at,pang,how))return finish("Nowhere to send them — this cell has no door and the holding cell is missing");
    auto current=Actors(p);std::unordered_set<RE::FormID> done;int cleared=0;
    for(const auto& value:req["ids"]){
        if(!value.is_number_unsigned())continue;
        const auto raw=value.get<std::uint64_t>();if(raw>0xFFFFFFFFull)continue;const auto fid=static_cast<RE::FormID>(raw);
        if(!done.insert(fid).second)continue;
        auto it=std::find_if(current.begin(),current.end(),[&](auto* a){return a->GetFormID()==fid;});
        json row={{"formId",fid},{"name","NPC"},{"held",false}};
        auto skip=[&](const std::string& msg){row["msg"]=msg;out["results"].push_back(row);};
        if(!listed.count(fid)||it==current.end()){skip("No longer nearby");continue;}
        auto* a=*it;row["name"]=Name(a);auto busy=Busy(a);if(!busy.empty()){skip(busy);continue;}
        if(std::any_of(held.begin(),held.end(),[&](const Held& h){return h.formId==fid;})){skip("Already held");continue;}
        Held h; h.formId=fid; h.baseId=a->GetActorBase()?a->GetActorBase()->GetFormID():0; h.name=Name(a); h.ai=a->IsAIEnabled();
        auto* cell=a->GetParentCell();h.cellId=cell?cell->GetFormID():0;
        const auto pos=Position(a);h.x=pos.x;h.y=pos.y;h.z=pos.z;h.angle=a->GetAngleZ();
        const float spread=static_cast<float>(cleared%4)*48.f;
        char key[16];std::snprintf(key,sizeof(key),"0x%08X",fid);
        const auto movedResult=json::parse(PlaceActions::MoveNpcTo(key,Dump({{"name","Clear the room"},{"cellId",park->GetFormID()},
            {"x",at.x+spread},{"y",at.y},{"z",at.z},{"angleZ",pang}})),nullptr,false);
        if(!movedResult.is_object()||!movedResult.value("ok",false)){skip("Move could not be completed");continue;}
        a->EnableAI(false);held.push_back(h);++cleared;row["held"]=true;row["msg"]="Held "+how;out["results"].push_back(row);
    }
    SaveHeld();
    out["ok"]=cleared>0;out["held"]=cleared;out["heldTotal"]=static_cast<int>(held.size());
    logger::info("npc-clearance: cleared {} actor(s) {} ({} held in all)",cleared,how,held.size());   // marker: npc-clearance-clear
    return finish(cleared?("Clear the room: "+std::to_string(cleared)+" sent "+how+" — press again to bring them back"):"Clear the room: nobody could be moved");
}
namespace {
std::string RestoreOwned(bool privacy, std::uint32_t only=0){
    json out={{"ok",true},{"restored",0},{"results",json::array()}};int restored=0,total=0;
    for(auto it=held.begin();it!=held.end();){
        const auto h=*it;if(h.privacy!=privacy || (only&&h.formId!=only)){++it;continue;}++total;
        auto* a=RE::TESForm::LookupByID<RE::Actor>(h.formId);
        json row={{"formId",h.formId},{"name",h.name},{"restored",false}};
        if(!a||!a->GetActorBase()||a->GetActorBase()->GetFormID()!=h.baseId){row["msg"]="Saved actor unavailable; recovery retained";out["ok"]=false;out["results"].push_back(row);++it;continue;}
        char key[16];std::snprintf(key,sizeof(key),"0x%08X",h.formId);
        const auto moved=json::parse(PlaceActions::MoveNpcTo(key,Dump({{"name","back to the room"},{"cellId",h.cellId},
            {"x",h.x},{"y",h.y},{"z",h.z},{"angleZ",h.angle}}),true),nullptr,false);
        if(!moved.is_object()||!moved.value("ok",false)){
            a->EnableAI(h.ai);row["msg"]="AI restored; return pending — retry";out["ok"]=false;++it;
        }else{a->EnableAI(h.ai);if(h.ai)a->EvaluatePackage();++restored;row["restored"]=true;row["msg"]="Original position and AI restored";it=held.erase(it);}
        out["results"].push_back(row);
    }
    if(total)SaveHeld();out["restored"]=restored;out["remaining"]=total-restored;
    out["msg"]=std::to_string(restored)+" returned"+(total>restored?"; some returns need retry":"");
    if(total)logger::info("npc-clearance: restored {} of {} held actor(s)",restored,total);
    return Dump(out);
}
}
std::string Restore(){return RestoreOwned(false);}
std::string RestorePrivacy(std::uint32_t id){return RestoreOwned(true,id);}
bool IsHeld(std::uint32_t id){return std::any_of(held.begin(),held.end(),[id](const Held& h){return h.formId==id;});}
std::string PrivacyHeldJson(){json out=json::array();for(const auto& h:held)if(h.privacy)out.push_back({{"formId",h.formId},{"name",h.name}});return Dump(out);}
std::string PrivacyExit(){
    auto* p=RE::PlayerCharacter::GetSingleton();RE::TESObjectCELL* cell=nullptr;Point at{};float angle=0;std::string how;
    if(!p||!p->GetParentCell()||!Parking(p->GetParentCell(),cell,at,angle,how,false))return "{}";
    return Dump({{"name",how},{"cellId",cell->GetFormID()},{"x",at.x},{"y",at.y},{"z",at.z},{"angleZ",angle}});
}
std::string HoldPrivacy(std::uint32_t id,const std::string& destination){
    auto* a=RE::TESForm::LookupByID<RE::Actor>(id);const auto dest=json::parse(destination,nullptr,false);
    if(!a||!a->Is3DLoaded()||!a->GetParentCell()||!a->GetActorBase()||!dest.is_object()||!dest.value("cellId",0u))return Dump({{"ok",false},{"msg","Actor or exit unavailable"}});
    const auto reason=Busy(a);if(!reason.empty())return Dump({{"ok",false},{"msg",reason}});
    const auto prior=std::find_if(held.begin(),held.end(),[id](const Held& h){return h.formId==id;});
    if(prior!=held.end()){
        if(!prior->privacy)return Dump({{"ok",false},{"msg","Held by manual Clear the room"}});
        // Another framework can teleport a follower even with AI disabled.
        // Reassert OUR hold without overwriting the original return position.
        char key[16];std::snprintf(key,sizeof(key),"0x%08X",id);
        auto moved=json::parse(PlaceActions::MoveNpcTo(key,destination));
        if(moved.value("ok",false))a->EnableAI(false);
        return Dump({{"ok",moved.value("ok",false)},{"msg",moved.value("ok",false)?"Waiting outside temporarily":"Return outside pending"}});
    }
    if(held.size()>=256)return Dump({{"ok",false},{"msg","Hold limit reached"}});
    Held h;h.formId=id;h.baseId=a->GetActorBase()->GetFormID();h.name=Name(a);h.cellId=a->GetParentCell()->GetFormID();
    auto pos=a->GetPosition();h.x=pos.x;h.y=pos.y;h.z=pos.z;h.angle=a->GetAngleZ();h.ai=a->IsAIEnabled();h.privacy=true;
    char key[16];std::snprintf(key,sizeof(key),"0x%08X",id);
    const auto moved=json::parse(PlaceActions::MoveNpcTo(key,destination),nullptr,false);
    if(!moved.is_object()||!moved.value("ok",false))return Dump({{"ok",false},{"msg","Move failed"}});
    a->EnableAI(false);held.push_back(h);SaveHeld();
    logger::info("scene-privacy: held {:08X} with original AI {}",id,h.ai);
    return Dump({{"ok",true},{"msg","Waiting outside temporarily"}});
}
void RevertCosave(){held.clear();cosaveLoaded=false;Reset();}
void SaveCosave(SKSE::SerializationInterface* s){
    json rows=json::array();for(const auto& h:held)rows.push_back({{"formId",h.formId},{"baseId",h.baseId},{"cellId",h.cellId},
        {"name",h.name},{"x",h.x},{"y",h.y},{"z",h.z},{"angle",h.angle},{"ai",h.ai},{"privacy",h.privacy}});
    const auto data=Dump(rows);if(s->OpenRecord(HoldRecord,1))s->WriteRecordData(data.data(),static_cast<std::uint32_t>(data.size()));
}
bool LoadCosave(SKSE::SerializationInterface* s,std::uint32_t type,std::uint32_t version,std::uint32_t length){
    if(type!=HoldRecord)return false;held.clear();cosaveLoaded=true;
    if(version!=1||length>1048576)return true;
    std::string data(length,'\0');if(s->ReadRecordData(data.data(),length)!=length)return true;
    const auto rows=json::parse(data,nullptr,false);if(!rows.is_array()||rows.size()>256)return true;
    try{for(const auto& row:rows){Held h;
        if(!s->ResolveFormID(row.at("formId").get<std::uint32_t>(),h.formId)||!s->ResolveFormID(row.at("baseId").get<std::uint32_t>(),h.baseId)||!s->ResolveFormID(row.at("cellId").get<std::uint32_t>(),h.cellId))continue;
        h.name=row.value("name","");h.x=row.at("x");h.y=row.at("y");h.z=row.at("z");h.angle=row.at("angle");h.ai=row.value("ai",true);h.privacy=row.value("privacy",false);
        if(std::isfinite(h.x)&&std::isfinite(h.y)&&std::isfinite(h.z)&&std::isfinite(h.angle))held.push_back(h);
    }}catch(const std::exception& e){logger::warn("scene-privacy: invalid hold record: {}",e.what());}
    return true;
}
void OnPostLoadGame(){
    Reset();
    // The co-save belongs to THIS save and SKSE remaps its references. A global
    // sidecar from a different save must never teleport/freeze the new actors.
    if(!cosaveLoaded){std::ifstream f(HeldPath());if(f)logger::warn("npc-clearance: legacy sidecar retained for manual recovery; no save-matched hold record");return;}
    if(!held.empty()){RestoreOwned(false);RestoreOwned(true);}
}
std::string Nearby(const std::string& request){
    const auto req=json::parse(request,nullptr,false);
    if(!req.is_object()||!req.contains("token")||!req["token"].is_string())return "{}";
    const auto id=req["token"].get<std::string>();if(id.size()>80)return "{}";
    auto* p=RE::PlayerCharacter::GetSingleton();json rows=json::array();listed.clear();token=id;
    if(p)for(auto* a:Actors(p)){
        const auto reason=Busy(a);const auto fid=a->GetFormID();listed.insert(fid);
        rows.push_back({{"formId",fid},{"name",Name(a)},{"feet",std::round(Distance2D(Position(p),Position(a))/UnitsPerFoot)},
            {"follower",a->IsPlayerTeammate()},{"reason",reason}});
    }
    scanned=std::chrono::steady_clock::now();
    json heldArr=json::array();for(const auto& h:held)if(!h.privacy)heldArr.push_back({{"formId",h.formId},{"name",h.name}});
    return Dump({{"token",token},{"ok",p!=nullptr},{"rows",rows},{"last",last},{"held",heldArr}});
}
std::string Apply(const std::string& request){
    json out={{"ok",false},{"moved",0},{"results",json::array()}};
    auto finish=[&](const std::string& msg){out["msg"]=msg;last=out;return Dump(out);};
    const auto req=json::parse(request,nullptr,false);
    if(!req.is_object()||!req.contains("token")||!req["token"].is_string()||!req.contains("ids")||!req["ids"].is_array()||!req.contains("feet")||!req["feet"].is_number_integer())return finish("Invalid clearance request");
    out["token"]=req["token"];
    if(req["token"].get<std::string>()!=token||std::chrono::steady_clock::now()-scanned>std::chrono::seconds(10))return finish("Nearby list expired — open Get away from me again");
    if(req["feet"]!=20&&req["feet"]!=25&&req["feet"]!=30)return finish("Choose 20, 25 or 30 feet");
    const auto feet=req["feet"].get<int>();
    if(req["ids"].empty()||req["ids"].size()>MaxMove)return finish("Select between 1 and 24 nearby NPCs");
    for(const auto& id:req["ids"])if(!id.is_number_unsigned()||id.get<std::uint64_t>()==0||id.get<std::uint64_t>()>0xFFFFFFFFull)return finish("Invalid NPC selection");
    auto* p=RE::PlayerCharacter::GetSingleton();if(!p||!p->GetParentCell()||!RE::TES::GetSingleton())return finish("World is not ready");
    auto current=Actors(p);std::unordered_set<RE::FormID> done;std::vector<Point> landings;int moved=0;
    for(const auto& value:req["ids"]){
        if(!value.is_number_unsigned())continue;
        const auto raw=value.get<std::uint64_t>();if(raw>0xFFFFFFFFull)continue;const auto fid=static_cast<RE::FormID>(raw);
        if(!done.insert(fid).second)continue;
        auto it=std::find_if(current.begin(),current.end(),[&](auto* a){return a->GetFormID()==fid;});
        json row={{"formId",fid},{"name","NPC"},{"moved",false}};
        auto skip=[&](const std::string& msg){row["msg"]=msg;out["results"].push_back(row);};
        if(!listed.count(fid)||it==current.end()){skip("No longer nearby");continue;}
        auto* a=*it;row["name"]=Name(a);auto busy=Busy(a);if(!busy.empty()){skip(busy);continue;}
        if(Distance2D(Position(p),Position(a))>=feet*UnitsPerFoot){skip("Already far enough away");continue;}
        std::vector<Point> occupied=landings;for(auto* other:current)if(other!=a)occupied.push_back(Position(other));
        Point destination{};
        if(!Destination(Position(p),Position(a),static_cast<float>(feet),occupied,Ground,Clear,destination)){skip("No clear ground at that distance");continue;}
        auto* cell=p->GetParentCell();
        if(!cell->IsInteriorCell()){cell=RE::TES::GetSingleton()->GetCell(RE::NiPoint3{destination.x,destination.y,destination.z});if(!cell||!cell->IsAttached()){skip("Destination cell is not loaded");continue;}}
        char key[16];std::snprintf(key,sizeof(key),"0x%08X",fid);
        const auto movedResult=json::parse(PlaceActions::MoveNpcTo(key,Dump({{"name","Get away from me"},{"cellId",cell->GetFormID()},
            {"x",destination.x},{"y",destination.y},{"z",destination.z},{"angleZ",a->GetAngleZ()}})),nullptr,false);
        if(!movedResult.is_object()||!movedResult.value("ok",false)){skip("Move could not be completed");continue;}
        landings.push_back(destination);a->EvaluatePackage();++moved;row["moved"]=true;row["msg"]="Moved to about "+std::to_string(feet)+" ft away";out["results"].push_back(row);
    }
    out["ok"]=moved>0;out["moved"]=moved;
    const auto skipped=out["results"].size()-moved;
    logger::info("npc-clearance: moved {} selected actor(s), skipped {}",moved,skipped);
    return finish("Get away from me: "+std::to_string(moved)+" moved, "+std::to_string(skipped)+" skipped");
}
}
