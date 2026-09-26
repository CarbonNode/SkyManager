#include "rhythm_presets.h"
#include "actor_identity.h"
#include "nff_bridge.h"
#include "residents.h"
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <memory>
#include <set>
#include <stdexcept>

using json = nlohmann::json;
namespace RhythmPresets
{
namespace
{
    bool busy = false;
    std::string lastMessage;
    const auto file = std::filesystem::path("Data/SKSE/Plugins/HotkeyDeck/rhythm-presets.json");
    std::string Dump(const json& j) { return j.dump(-1, ' ', false, json::error_handler_t::replace); }
    json Read()
    {
        if (!std::filesystem::exists(file)) return {{"version",1},{"presets",json::array()}};
        std::ifstream in(file); auto j=json::parse(in,nullptr,false);
        if (!j.is_object() || !j.contains("presets") || !j["presets"].is_array())
            throw std::runtime_error("Saved rhythm library could not be read; it has been left untouched.");
        return j;
    }
    void Write(const json& j)
    {
        std::filesystem::create_directories(file.parent_path());
        auto tmp=file; tmp += ".tmp";
        { std::ofstream out(tmp,std::ios::binary|std::ios::trunc); out<<Dump(j); out.flush();
          if(!out) throw std::runtime_error("Could not save rhythm library."); }
        if(!MoveFileExW(tmp.c_str(),file.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("Could not replace rhythm library.");
    }
    std::string Reply(bool ok,const std::string& op,const std::string& msg,const char* phase="done")
    {
        if(op!="list" && std::string(phase)!="sent") lastMessage=msg;
        json j={{"ok",ok},{"op",op},{"phase",phase},{"msg",op=="list"?lastMessage:msg},{"busy",busy}};
        try { j["presets"]=Read()["presets"]; } catch(...) {}
        return Dump(j);
    }
    // Complete schedules, including the passive guard twin. Do not default a missing row.
    void CheckDay(const json& rows)
    {
        if(!rows.is_array() || rows.size()!=8) throw std::runtime_error("The complete eight-row schedule was not read. Nothing changed.");
        std::set<int> kinds;
        for(const auto& r:rows) {
            int k=r.at("k").get<int>(), a=r.at("start").get<int>(), b=r.at("end").get<int>();
            double radius=r.at("radius").get<double>();
            if(k<0||k>7||!kinds.insert(k).second||a<0||a>23||b<0||b>24||!std::isfinite(radius)||radius<64||radius>4096||!r.at("enabled").is_boolean())
                throw std::runtime_error("This rhythm contains invalid hours or radius. Nothing changed.");
        }
    }
    // Store cell identities independently of load order. Dynamic cells cannot be portable presets.
    json Capture(RE::Actor* actor)
    {
        json slots=json::array();
        for(int k=0;k<7;++k) {
            auto* kw=NffBridge::MhiyhMarkerKeyword(k);
            auto* ref=kw?actor->GetLinkedRef(kw):nullptr;
            if(!ref) { slots.push_back(nullptr); continue; }
            auto* cell=ref->GetParentCell(); std::string id,plugin;
            if(!cell || !ActorIdentity::DurableOf(cell,id,plugin)) throw std::runtime_error("One stop has no persistent cell identity; this rhythm cannot be saved.");
            auto pos=ref->GetPosition();
            slots.push_back({{"cell",id},{"plugin",plugin},{"name",cell->GetName()?cell->GetName():"Saved place"},
                {"x",pos.x},{"y",pos.y},{"z",pos.z},{"angleZ",ref->GetAngleZ()}});
        }
        if(slots[0].is_null()) throw std::runtime_error("Give this NPC a MHiYH home before saving a rhythm.");
        return slots;
    }
    json ResolveSlots(const json& slots)
    {
        if(!slots.is_array()||slots.size()!=7||!slots[0].is_object()) throw std::runtime_error("This rhythm has no complete destination list.");
        json out=json::array();
        for(const auto& s:slots) {
            if(s.is_null()) { out.push_back(nullptr); continue; }
            auto* f=ActorIdentity::Resolve(s.at("cell").get<std::string>(),s.at("plugin").get<std::string>());
            auto* cell=f?f->As<RE::TESObjectCELL>():nullptr;
            if(!cell) throw std::runtime_error("A saved destination is missing from this load order. Nothing changed.");
            json mark={{"cellId",cell->GetFormID()},{"name",s.value("name",std::string("Saved place"))}};
            for(auto key:{"x","y","z","angleZ"}) {
                const double n=s.at(key).get<double>();
                if(!std::isfinite(n)) throw std::runtime_error("A saved destination is invalid. Nothing changed.");
                mark[key]=n;
            }
            out.push_back(mark);
        }
        return out;
    }
    // Await each owning-module callback before issuing the next operation. Never a VM wait on main.
    struct Run : std::enable_shared_from_this<Run>
    {
        json ops=json::array(); std::size_t at=0; std::string target,name; Push done;
        void Finish(bool ok,const std::string& msg) {
            busy=false;
            logger::info("rhythm-presets: {} ({}/{})",msg,at,ops.size());
            if(done) done(Reply(ok,"apply",msg));
        }
        void Next() {
            if(at==ops.size()) { Finish(true,name+"'s rhythm was replaced."); return; }
            auto* actor=ActorIdentity::ResolveActor(target,"");
            if(!actor||actor->IsDead()||actor->IsDeleted()) { Finish(false,"Stopped: the selected NPC is no longer available. Earlier changes may have applied."); return; }
            auto op=ops[at]; op["formId"]=target;
            auto self=shared_from_this();
            auto pre=Residents::Apply(Dump(op),[self](const std::string& result){
                auto r=json::parse(result,nullptr,false);
                if(!r.is_object()||!r.value("ok",false)) { self->Finish(false,"Rhythm stopped after "+std::to_string(self->at)+" steps: "+(r.is_object()?r.value("msg",std::string("MHiYH did not confirm.")):"Invalid reply")+" Earlier changes may have applied."); return; }
                ++self->at; self->Next();
            });
            auto r=json::parse(pre,nullptr,false);
            if(!r.is_object()||!r.value("ok",false)) Finish(false,"Rhythm stopped after "+std::to_string(at)+" steps: "+(r.is_object()?r.value("msg",std::string("Refused")):"Invalid reply")+" Earlier changes may have applied.");
        }
    };
}
std::string Handle(const std::string& request,Push done)
{
    std::string op;
    try {
        const auto j=json::parse(request); op=j.value("op",std::string("list"));
        auto lib=Read();
        if(op=="list") return Reply(true,op,"");
        if(busy) return Reply(false,op,"A rhythm operation is still running; wait for its result.","refused");
        if(op=="delete") {
            const auto id=j.at("id").get<std::string>(); bool found=false;
            auto& a=lib["presets"];
            for(auto it=a.begin();it!=a.end();++it) if(it->value("id",std::string())==id) { a.erase(it);found=true;break; }
            if(!found) return Reply(false,op,"That saved rhythm no longer exists.","refused");
            Write(lib);return Reply(true,op,"Saved rhythm deleted.");
        }
        if(op!="save"&&op!="apply") return Reply(false,op,"Unknown rhythm action.","refused");
        const auto target=j.at("formId").get<std::string>();
        auto* actor=ActorIdentity::ResolveActor(target,"");
        if(!Residents::Available()||!actor||actor==RE::PlayerCharacter::GetSingleton()||actor->IsDead()||actor->IsDeleted())
            return Reply(false,op,"Select an available, living NPC with MHiYH installed.","refused");
        const std::string who=actor->GetDisplayFullName();
        if(op=="save") {
            auto name=j.value("name",std::string());
            if(name.empty()||name.size()>100) return Reply(false,op,"Give the rhythm a name (up to 100 characters).","refused");
            if(lib["presets"].size()>=100) return Reply(false,op,"The library holds 100 rhythms; delete one first.","refused");
            auto slots=Capture(actor); busy=true;
            auto pre=Residents::RequestDay(target,[target,name,who,slots,done](const std::string& result){
                busy=false;
                try {
                    auto r=json::parse(result);if(!r.value("ok",false)) throw std::runtime_error("Could not read the schedule.");
                    CheckDay(r.at("day"));
                    auto* a=ActorIdentity::ResolveActor(target,"");
                    if(!a||Capture(a)!=slots) throw std::runtime_error("The destinations changed while reading; save again.");
                    auto lib=Read();
                    const auto id=std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
                    lib["presets"].push_back({{"id",id},{"name",name},{"source",who},{"slots",slots},{"day",r["day"]}});
                    Write(lib); logger::info("rhythm-presets: saved {} from {}",name,who);
                    if(done)done(Reply(true,"save","Saved rhythm: "+name));
                } catch(const std::exception& e) { if(done)done(Reply(false,"save",e.what())); }
            });
            auto r=json::parse(pre);if(!r.value("ok",false)){busy=false;return Reply(false,op,r.value("msg",std::string("Could not read schedule")),"refused");}
            return Reply(true,op,"Reading and saving the complete rhythm…","sent");
        }
        if(!j.value("confirm",false)) return Reply(false,op,"Review and confirm replacement first.","refused");
        const auto id=j.at("id").get<std::string>(); const json* preset=nullptr;
        for(const auto& p:lib["presets"]) if(p.value("id",std::string())==id){preset=&p;break;}
        if(!preset) return Reply(false,op,"That saved rhythm no longer exists.","refused");
        CheckDay(preset->at("day"));const auto slots=ResolveSlots(preset->at("slots"));
        auto run=std::make_shared<Run>();run->target=target;run->name=who;run->done=std::move(done);
        for(int k=0;k<7;++k) {
            if(!slots[k].is_null()) run->ops.push_back({{"op","setAt"},{"kind",k},{"mark",slots[k]}});
            else { auto* kw=NffBridge::MhiyhMarkerKeyword(k); if(kw&&actor->GetLinkedRef(kw)) run->ops.push_back({{"op","clear"},{"kind",k}}); }
        }
        int mode=0;
        for(const auto& row:preset->at("day")) {
            const int k=row.at("k").get<int>();const bool en=row.at("enabled").get<bool>();
            if(k==3&&en)mode=2;else if(k==7&&en&&mode!=2)mode=1;
            auto cmd=row;cmd["op"]="hours";cmd["kind"]=k;cmd.erase("k");
            // No absent destination can accidentally retain an enabled stop.
            if(slots[k==7?3:k].is_null())cmd["enabled"]=false;
            run->ops.push_back(cmd);
        }
        if(!slots[3].is_null())run->ops.push_back({{"op","guard"},{"mode",mode}});
        busy=true;logger::info("rhythm-presets: replacing {} with {}",who,preset->value("name",std::string()));SKSE::GetTaskInterface()->AddTask([run](){run->Next();});
        return Reply(true,op,"Replacing "+who+"'s entire rhythm…","sent");
    } catch(const std::exception& e) { return Reply(false,op,e.what(),"refused"); }
}
}
