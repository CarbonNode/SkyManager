#include "photo_studio.h"
#include "portrait_capture.h"
#include "photo_preview.h"
#include "npc_actions.h"
#include <atomic>
#include <fstream>
#include <mutex>
#include <thread>
#include <Windows.h>
#ifdef min
#undef min
#undef max
#endif

namespace PhotoStudio {
namespace {
using json=nlohmann::json;
const auto path=std::filesystem::path("Data/SKSE/Plugins/HotkeyDeck/photo-studio.json");
json library=json::object();
std::uint64_t session=0;
std::uint32_t subject=0,target=0;
bool editing=false,loading=false,writable=true;
Pose initial;
bool haveInitial=false;
json initialComposition;
Bounds bounds;
bool preview=false;
std::string message;
std::function<void()> changed;
std::mutex ioMutex;
std::atomic_uint64_t revision=0;
RE::FreeCameraState* Camera() {
    auto* c=RE::PlayerCamera::GetSingleton();
    if(!c||!c->IsInFreeCameraMode()||!c->currentState) return nullptr;
    return static_cast<RE::FreeCameraState*>(c->currentState.get());
}
RE::Actor* Subject() {
    auto* f=RE::TESForm::LookupByID(subject);
    auto* a=f?f->As<RE::Actor>():nullptr;
    auto* pc=RE::PlayerCharacter::GetSingleton();
    return a&&pc&&a->Is3DLoaded()&&a->GetParentCell()==pc->GetParentCell()?a:nullptr;
}
bool Read(Pose& p,Anchor& anchor) {
    auto* c=Camera();auto* a=Subject();auto* pc=RE::PlayerCamera::GetSingleton();
    if(!c||!a||!pc) return false;
    const auto v=a->GetPosition();anchor={v.x,v.y,v.z,a->GetAngleZ()};
    p={c->translation.x,c->translation.y,c->translation.z,c->rotation.x,c->rotation.y,pc->GetRuntimeData2().worldFOV};
    return std::isfinite(anchor.x)&&std::isfinite(anchor.y)&&std::isfinite(anchor.z)&&std::isfinite(anchor.yaw)&&Valid(Relative(p,anchor));
}
json Encode(const Pose& p) {return {{"x",p.x},{"y",p.y},{"z",p.z},{"pitch",p.pitch},{"yaw",p.yaw},{"fov",p.fov}};}
bool Decode(const json& j,Pose& p) {
    if(!j.is_object())return false;
    for(const auto* k:{"x","y","z","pitch","yaw","fov"})if(!j.contains(k)||!j[k].is_number())return false;
    p={j["x"].get<float>(),j["y"].get<float>(),j["z"].get<float>(),j["pitch"].get<float>(),j["yaw"].get<float>(),j["fov"].get<float>()};
    return Valid(p);
}
void Changed(){if(changed)changed();}
void Save() {
    // Snapshot on the main thread; serialize writes on a worker. Unknown root
    // and per-preset fields are retained. A failed atomic rename keeps the old file.
    library["version"]=1;
    library["preview"]["enabled"]=preview;
    library["preview"]["bounds"]={{"x",bounds.x},{"y",bounds.y},{"w",bounds.w},{"h",bounds.h}};
    const auto bytes=library.dump(2);const auto rev=++revision;const auto savedSession=session;
    std::thread([bytes,rev,savedSession]() {
        bool ok=true;
        {std::lock_guard lock(ioMutex);
        if(revision.load()!=rev)return;
        std::error_code ec;std::filesystem::create_directories(path.parent_path(),ec);
        auto tmp=path;tmp+=L".tmp";
        std::ofstream out(tmp,std::ios::binary|std::ios::trunc);out<<bytes;out.close();
        ok=!ec&&out.good()&&MoveFileExW(tmp.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);
        }
        SKSE::GetTaskInterface()->AddTask([ok,rev,savedSession]() {
            if(revision.load()!=rev||session!=savedSession)return;
            message=ok?"Saved across characters and new games.":"Could not save settings. Existing file retained; check HotkeyDeck.log.";
            if(!ok)logger::warn("photo-studio: atomic settings write failed");
            Changed();
        });
    }).detach();
}
bool Apply(const json& j) {
    Pose p,current;Anchor a;
    if(!Decode(j,p)||!Read(current,a))return false;
    auto* c=Camera();auto* pc=RE::PlayerCamera::GetSingleton();
    // Validate every component before the first engine write.
    auto comp=PortraitCapture::GetPhotoComposition();
    if(j.contains("format")) {if(!j["format"].is_string())return false;comp.format=PhotoFrame::Parse(j["format"].get<std::string>());}
    for(auto key:{"zoom","cropX","cropY"})if(j.contains(key)&&!j[key].is_number())return false;
    if(j.contains("thirds")&&!j["thirds"].is_boolean())return false;
    comp.zoom=j.value("zoom",1.f);comp.x=j.value("cropX",0.f);comp.y=j.value("cropY",0.f);comp.thirds=j.value("thirds",false);
    if(!std::isfinite(comp.zoom)||comp.zoom<.15f||comp.zoom>1||!std::isfinite(comp.x)||std::abs(comp.x)>.5f||!std::isfinite(comp.y)||std::abs(comp.y)>.5f)return false;
    const auto world=Absolute(p,a);
    c->translation={world.x,world.y,world.z};c->rotation.x=world.pitch;c->rotation.y=world.yaw;
    pc->rotationInput={0,0};pc->translationInput={0,0,0};pc->zoomInput=0;
    pc->GetRuntimeData2().worldFOV=world.fov;
    PortraitCapture::SetPhotoComposition(comp);
    logger::info("photo-studio: relative camera preset applied fov={}",world.fov);
    return true;
}
}
void SetChangedCallback(std::function<void()> cb){changed=std::move(cb);}
bool Editing(){return editing;}
void SetEditing(bool on){editing=on&&session;Changed();}
bool PreviewEnabled(){return preview;}
Bounds PreviewBounds(){return bounds;}
void TogglePreview(){if(!session||loading||!writable)return;preview=!preview;Save();Changed();}
void Tick(){static std::string last;const auto now=PhotoPreview::Status();if(now!=last){last=now;if(session)Changed();}}
void Begin(std::uint64_t current) {
    session=current;editing=false;loading=true;preview=false;bounds={};message="Loading camera presets…";
    auto* pc=RE::PlayerCharacter::GetSingleton();subject=pc?pc->GetFormID():0;target=NpcActions::TargetFormID();
    Anchor a;Pose p;haveInitial=Read(p,a);if(haveInitial)initial=Relative(p,a);
    initialComposition=Encode(initial);const auto entry=PortraitCapture::GetPhotoComposition();
    initialComposition.update({{"format",PhotoFrame::Key(entry.format)},{"zoom",entry.zoom},{"cropX",entry.x},{"cropY",entry.y},{"thirds",entry.thirds}});
    std::thread([current]() {
        json data=json::object();bool ok=true;
        {std::lock_guard lock(ioMutex);
        std::error_code ec;const bool exists=std::filesystem::exists(path,ec);
        if(ec)ok=false;
        if(exists) {
            const auto size=std::filesystem::file_size(path,ec);
            if(ec||size>1024*1024)ok=false;
            else {std::ifstream in(path,std::ios::binary);data=json::parse(in,nullptr,false);ok=in.good()||in.eof();ok=ok&&data.is_object();}
        }}
        SKSE::GetTaskInterface()->AddTask([current,data=std::move(data),ok]() mutable {
            if(session!=current)return;
            loading=false;writable=ok;
            library=ok?std::move(data):json::object();
            if(!library.contains("presets"))library["presets"]=json::array();
            if(!library["presets"].is_array()||library["presets"].size()>64)writable=false;
            if(library.contains("preview")&&!library["preview"].is_object())writable=false;
            if(library.contains("version")&&(!library["version"].is_number_integer()||library["version"]!=1))writable=false;
            if(library.contains("preview")&&library["preview"].is_object()) {
                const auto& pv=library["preview"];preview=pv.contains("enabled")&&pv["enabled"].is_boolean()&&pv["enabled"].get<bool>();
                if(pv.contains("bounds")&&pv["bounds"].is_object()) {
                    const auto& b=pv["bounds"];bool valid=true;for(auto k:{"x","y","w","h"})valid=valid&&b.contains(k)&&b[k].is_number();
                    if(valid){Bounds candidate{b["x"].get<float>(),b["y"].get<float>(),b["w"].get<float>(),b["h"].get<float>()};if(Valid(candidate))bounds=candidate;}
                }
            }
            message=writable?"Save a composition, then recall it around your subject.":"Preset file is unreadable or newer. It has been preserved; restore a backup to edit.";
            logger::info("photo-studio: named presets and GPU viewfinder ready");Changed();
            PortraitCapture::RefreshPhotoLights();
        });
    }).detach();
}
void End(){session=0;editing=false;preview=false;PhotoPreview::Publish(false,{},bounds,0);Changed();}
std::string State() {
    json data={{"session",std::to_string(session)},{"active",session!=0},{"editing",editing},{"loading",loading},{"writable",writable},
        {"preview",preview},{"previewFailed",PhotoPreview::Failed()},{"bounds",{{"x",bounds.x},{"y",bounds.y},{"w",bounds.w},{"h",bounds.h}}},
        {"message",message},{"renderer",PhotoPreview::Status()},{"presets",json::array()},{"subject",subject==target?"target":"player"}};
    auto* actor=Subject();data["subjectName"]=actor&&actor->GetDisplayFullName()?actor->GetDisplayFullName():"Subject unavailable";
    auto* f=RE::TESForm::LookupByID(target);auto* a=f?f->As<RE::Actor>():nullptr;
    data["targetAvailable"]=a&&a->Is3DLoaded();
    if(library.contains("presets")&&library["presets"].is_array())for(const auto& p:library["presets"]){
        Pose pose;if(!Decode(p,pose)||!p.contains("name")||!p["name"].is_string()||(p.contains("format")&&!p["format"].is_string()))continue;
        data["presets"].push_back({{"name",p["name"]},{"fov",pose.fov},{"format",p.value("format",std::string("square"))}});
    }
    return data.dump();
}
std::string Request(const std::string& payload) {
    if(payload.size()>8192)return State();
    const auto j=json::parse(payload,nullptr,false);
    if(!j.is_object()||!j.contains("session")||!j["session"].is_string()||j["session"].get<std::string>()!=std::to_string(session)||!session)return State();
    if(!j.contains("op")||!j["op"].is_string())return State();
    const auto op=j["op"].get<std::string>();
    for(auto key:{"save","replace","confirm"})if(j.contains(key)&&!j[key].is_boolean())return State();
    if(op=="state")return State();
    if(loading||!writable){message="Wait for presets to load, or restore the unreadable preset file.";return State();}
    auto list=library["presets"];
    std::string name=j.contains("name")&&j["name"].is_string()?j["name"].get<std::string>():"";
    auto it=std::find_if(list.begin(),list.end(),[&](const json& p){return p.is_object()&&p.contains("name")&&p["name"].is_string()&&p["name"].get<std::string>()==name;});
    if(op=="preview") {if(!j.contains("on")||!j["on"].is_boolean())return State();preview=j["on"].get<bool>();Save();}
    else if(op=="bounds") {
        if(!j.contains("bounds")||!j["bounds"].is_object())return State();const auto& b=j["bounds"];
        for(auto k:{"x","y","w","h"})if(!b.contains(k)||!b[k].is_number())return State();
        Bounds candidate{b["x"].get<float>(),b["y"].get<float>(),b["w"].get<float>(),b["h"].get<float>()};if(!Valid(candidate))return State();
        bounds=candidate;if(j.value("save",false))Save();
    } else if(op=="resetPreview"){bounds={};Save();}
    else if(op=="subject") {
        if(name!="player"&&name!="target")return State();const auto old=subject;
        auto* pc=RE::PlayerCharacter::GetSingleton();subject=name=="target"?target:(pc?pc->GetFormID():0);
        if(!Subject()){subject=old;message="That subject is not loaded in this cell.";}else message="Presets now use this subject’s position and facing.";
    } else if(op=="save") {
        if(name.empty()||name.size()>96||name.find_first_of("\r\n\t")!=std::string::npos){message="Enter a name of 1–96 bytes.";return State();}
        if(it!=list.end()&&!j.value("replace",false)){message="Name already exists. Use Update on that preset.";return State();}
        if(it==list.end()&&list.size()>=64){message="64 presets saved. Remove one before adding another.";return State();}
        Pose p;Anchor a;if(!Read(p,a)){message="Camera or subject unavailable. Return to framing and try again.";return State();}
        auto data=it==list.end()?json::object():*it;
        data.update(Encode(Relative(p,a)));const auto c=PortraitCapture::GetPhotoComposition();
        data["name"]=name;data["format"]=PhotoFrame::Key(c.format);data["zoom"]=c.zoom;data["cropX"]=c.x;data["cropY"]=c.y;data["thirds"]=c.thirds;
        if(it==list.end())list.push_back(std::move(data));else *it=std::move(data);
        library["presets"]=std::move(list);message="Saving composition…";Save();
    } else if(op=="apply") {message=it!=list.end()&&Apply(*it)?"Composition recalled. Return to framing to fine-tune.":"Could not recall preset. Check that the subject is loaded.";}
    else if(op=="delete") {if(it!=list.end()&&j.contains("confirm")&&j["confirm"]==true){list.erase(it);library["presets"]=std::move(list);Save();}}
    else if(op=="resetCamera") {message=haveInitial&&Apply(initialComposition)?"Entry composition restored.":"Entry camera unavailable.";}
    PortraitCapture::RefreshPhotoLights();return State();
}
}
