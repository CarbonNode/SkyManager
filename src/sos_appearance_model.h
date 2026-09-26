#pragma once
#include "json.hpp"
#include <stdexcept>
#include <string>

namespace SosAppearanceModel {
    using json = nlohmann::json;
    inline void Validate(const json& state) {
        // Older cards have no SOS snapshot. They keep their existing behavior.
        if(state.is_null()) return;
        auto need=[](bool ok,const char* why){if(!ok)throw std::runtime_error(why);};
        need(state.is_object() && state.value("version",0)==1,"Invalid saved SOS settings.");
        const auto mode=state.value("mode",std::string());
        need(mode=="addon" || mode=="none" || mode=="unmanaged","Unknown saved SOS mode.");
        if(mode!="addon") return;
        need(state.contains("size") && state["size"].is_number_integer(),"Invalid saved SOS size.");
        const auto size=state["size"].get<std::int64_t>();
        need(size>=1 && size<=20,"Saved SOS size must be from 1 to 20.");
        const auto owner=state.value("sizeSource",std::string());
        need(owner=="sos" || owner=="racemenu","Unknown saved SOS size control.");
        need(state.contains("addon") && state["addon"].is_object(),"Missing saved SOS add-on identity.");
        const auto& addon=state["addon"];
        const auto plugin=addon.value("plugin",std::string());
        need(!plugin.empty() && plugin.size()<=260 && plugin.find_first_of("/\\:\r\n") == std::string::npos,"Invalid SOS add-on plugin.");
        need(addon.contains("localId") && addon["localId"].is_number_integer(),"Invalid SOS add-on ID.");
        const auto id=addon["localId"].get<std::int64_t>();
        need(id>0 && id<=0xFFFFFF,"Invalid SOS add-on ID.");
        need(addon.contains("editorId") && addon["editorId"].is_string() && !addon["editorId"].get<std::string>().empty(),"Missing SOS add-on EditorID.");
        need(!addon.contains("name") || addon["name"].is_string(),"Invalid SOS add-on name.");
    }
    inline bool Managed(const json& state) {
        return state.is_object() && state.value("mode",std::string())!="unmanaged";
    }
    inline bool Matches(const json& wanted,const json& actual) {
        Validate(wanted);Validate(actual);
        if(!Managed(wanted)) return true;
        if(actual.is_null() || wanted.value("mode",std::string())!=actual.value("mode",std::string())) return false;
        if(wanted["mode"]=="none") return true;
        const auto& a=wanted["addon"];const auto& b=actual["addon"];
        return a["plugin"]==b["plugin"] && a["localId"]==b["localId"] && a["editorId"]==b["editorId"] &&
            wanted["size"]==actual["size"] && wanted["sizeSource"]==actual["sizeSource"];
    }
    inline std::string Key(const json& addon) {
        return addon.value("plugin",std::string())+"|"+std::to_string(addon.value("localId",0u))+"|"+addon.value("editorId",std::string());
    }
    inline json Choices(const json& catalog,const json& race,bool female) {
        json choices=json::array();
        for(const auto& addon:catalog.at("addons")) {
            const int gender=addon.value("gender",-1);
            if(gender!=2 && gender!=(female?1:0))continue;
            bool compatible=false;
            for(const auto& r:addon.at("races")) if(Key(r)==Key(race)){compatible=true;break;}
            if(compatible) choices.push_back({{"key",Key(addon.at("identity"))},{"addon",addon.at("identity")}});
        }
        return choices;
    }
    inline json Edit(const json& old,const json& options,const json& request) {
        auto need=[](bool ok,const char* why){if(!ok)throw std::runtime_error(why);};
        const auto key=request.value("addonKey",std::string()),owner=options.value("sizeSource",std::string());
        need(owner=="sos" || owner=="racemenu","SOS size control is not ready.");
        if(old.is_object() && old.value("mode",std::string())=="addon")
            need(old.value("sizeSource",std::string())==owner,"Size control changed. Replace this look under the current SOS/RaceMenu setup first.");
        json result=old.is_object()?old:json::object();result["version"]=1;
        if(key=="none") {result["mode"]="none";for(const char* field:{"addon","size","sizeSource"})result.erase(field);return result;}
        json addon;
        for(const auto& choice:options.at("choices")) if(choice.value("key",std::string())==key){addon=choice.at("addon");break;}
        need(!addon.is_null(),"Choose a registered SOS add-on compatible with this look.");
        // RaceMenu owns visible size in that mode. Keep its bookkeeping rank;
        // the editor cannot smuggle in a different value or rewrite the jslot.
        int size=old.is_object() && old.value("mode",std::string())=="addon"?old.value("size",10):10;
        if(owner=="sos") {
            need(request.contains("size") && request["size"].is_number_integer(),"Choose an SOS size from 1 to 20.");
            const auto n=request["size"].get<std::int64_t>();need(n>=1&&n<=20,"Choose an SOS size from 1 to 20.");size=static_cast<int>(n);
        }
        result.update({{"mode","addon"},{"addon",addon},{"size",size},{"sizeSource",owner}});
        Validate(result);return result;
    }
}
