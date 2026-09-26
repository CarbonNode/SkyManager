#pragma once
#include "json.hpp"
#include "sos_appearance_model.h"
#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <string>
#include <vector>

namespace AppearanceModel
{
    using json = nlohmann::json;
    inline void Need(bool yes, const char* reason) { if (!yes) throw std::runtime_error(reason); }
    inline bool Id(const std::string& s) {
        return !s.empty() && s.size() <= 80 && std::all_of(s.begin(),s.end(),[](unsigned char c){return std::isalnum(c)||c=='-';});
    }
    inline std::string Name(const json& request) {
        auto s=request.value("name",std::string());
        const auto first=s.find_first_not_of(" \t\r\n"), last=s.find_last_not_of(" \t\r\n");
        s=first==std::string::npos ? "" : s.substr(first,last-first+1);
        Need(!s.empty() && s.size()<=160,"Give this look a name (up to 160 characters).");
        Need(std::none_of(s.begin(),s.end(),[](unsigned char c){return c<32;}),"The name contains unsupported characters.");
        return s;
    }
    inline json Empty() { return {{"version",1},{"revision",0},{"looks",json::array()}}; }
    inline void Validate(const json& doc) {
        Need(doc.is_object() && doc.value("version",0)==1 && doc.contains("looks") && doc["looks"].is_array(),"The appearance library could not be read. It has not been overwritten.");
        Need(doc["looks"].size()<=500,"The appearance library is too large.");
        std::vector<std::string> ids;
        for(const auto& r:doc["looks"]) {
            Need(r.is_object(),"Invalid saved look.");
            auto id=r.value("id",std::string());
            Need(Id(id) && std::find(ids.begin(),ids.end(),id)==ids.end(),"Invalid or duplicate look ID."); ids.push_back(id);
            Need(Id(r.value("slot",std::string())),"Invalid appearance file name.");
            Need(r.contains("race") && r["race"].is_object() && !r["race"].value("plugin",std::string()).empty(),"A saved look has no race identity.");
            Need(r["race"].contains("localId") && r["race"]["localId"].is_number_integer() && r["race"]["localId"].get<std::int64_t>()>0 && r["race"]["localId"].get<std::int64_t>()<=0xFFFFFF,"A saved look has an invalid race identity.");
            Need(!r["race"].contains("editorId") || r["race"]["editorId"].is_string(),"Invalid race EditorID.");
            Need(!r["race"].contains("name") || r["race"]["name"].is_string(),"Invalid race name.");
            Need(r.contains("name") && r["name"].is_string() && r["name"].get<std::string>().size()<=160,"Invalid look name.");
            Need(!r.contains("portrait") || r["portrait"].is_string(),"Invalid portrait path.");
            Need(r.value("sex",-1)==0 || r.value("sex",-1)==1,"Invalid appearance sex.");
            if(r.contains("sos")) SosAppearanceModel::Validate(r["sos"]);
            Need(!r.contains("revision") || (r["revision"].is_number_integer() && r["revision"].get<std::int64_t>()>=0),"Invalid look revision.");
        }
        for(const char* key:{"normalId","quickId"}) {
            const auto id=doc.value(key,std::string());
            Need(id.empty() || std::find(ids.begin(),ids.end(),id)!=ids.end(),"A pinned appearance is missing from the library.");
        }
        Need(doc.value("normalId",std::string()).empty() || doc.value("normalId",std::string())!=doc.value("quickId",std::string()),"Normal and quick forms must be different looks.");
    }
    inline json& Find(json& doc,const std::string& id) {
        Need(Id(id),"Invalid look ID.");
        for(auto& r:doc["looks"]) if(r.value("id",std::string())==id) return r;
        throw std::runtime_error("That look is no longer in your library.");
    }
    inline void Expected(const json& row,const json& request) {
        Need(request.value("expected",std::string())==row.value("slot",std::string()),"This look changed. Refresh the gallery before replacing it.");
        if(request.contains("expectedRevision")) Need(request.at("expectedRevision")==row.value("revision",0),"This look changed. Refresh the gallery before editing it.");
    }
    inline void Editable(const json& doc,const std::string& id) {
        Need(doc.value("normalId",std::string())!=id,"Your normal form is protected. Unpin it in Manage before editing or removing it.");
    }
    inline void SetRole(json& doc,const json& request) {
        const auto id=request.value("id",std::string()),role=request.value("role",std::string());
        Expected(Find(doc,id),request);
        Need(request.value("libraryRevision",-1)==doc.value("revision",0),"Your pinned forms changed. Refresh the gallery first.");
        Need(role=="normal" || role=="quick","Unknown appearance shortcut.");
        const char* key=role=="normal"?"normalId":"quickId";
        const char* other=role=="normal"?"quickId":"normalId";
        const auto old=doc.value(key,std::string());
        if(role=="normal" && !old.empty()) Need(request.value("confirm",false),"Confirm changing the protected normal form.");
        if(old==id) doc[key]="";
        else {Need(doc.value(other,std::string())!=id,"Choose different looks for your normal and quick forms.");doc[key]=id;}
    }
    inline std::string QuickTarget(const json& doc,const std::string& selected,bool wearingQuickRace,bool returnNormal=false) {
        const auto normal=doc.value("normalId",std::string()),quick=doc.value("quickId",std::string());
        Need(!normal.empty(),"Pin your original look as Normal form in Appearances → Manage first.");
        if(returnNormal) return normal;
        Need(!quick.empty(),"Choose a Quick form in Appearances → Manage first.");
        // Race is only a fallback after loading. Same-race forms use the last
        // selected card; the explicit Return action always chooses Normal.
        return selected==quick || (selected.empty() && wearingQuickRace)?normal:quick;
    }
    inline bool Portrait(const std::string& path,const std::string& id) {
        const auto prefix="portraits/looks-"+id+"/";
        if(path.rfind(prefix,0)!=0 || path.find("..")!=std::string::npos || path.find('\\')!=std::string::npos) return false;
        const auto file=path.substr(prefix.size());
        return file.size()>4 && file.size()<120 && file.ends_with(".png") && std::all_of(file.begin(),file.end(),[](unsigned char c){return std::isalnum(c)||c=='-'||c=='~'||c=='.';});
    }
}
