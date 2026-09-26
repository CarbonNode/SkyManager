#include "ostim_deck.h"
#include <filesystem>
#include <fstream>
#include <mutex>
#include <thread>
#include <map>
#include <algorithm>
namespace OstimDeck {
namespace {std::mutex metaMutex;std::map<std::string,nlohmann::json> metadata;
nlohmann::json expressions=nlohmann::json::array();bool expressionsReady=false;}
void LoadMetadata(){std::thread([](){
 std::map<std::string,nlohmann::json> next;std::map<std::string,std::vector<std::string>> groups;
 try{
  const std::filesystem::path root="Data/SKSE/Plugins/OStim/scenes";
  if(!std::filesystem::exists(root))return;
  for(const auto& f:std::filesystem::recursive_directory_iterator(root)){
   if(!f.is_regular_file()||f.path().extension()!=".json")continue;
   try{std::ifstream in(f.path());auto j=nlohmann::json::parse(in);if(!j.is_object())continue;
    auto id=PathU8(f.path().stem());auto name=j.value("name",id);std::string key=name;std::transform(key.begin(),key.end(),key.begin(),[](unsigned char c){return static_cast<char>(std::tolower(c));});
    next[id]={{"pack",j.value("modpack",std::string(""))},{"furniture",j.value("furniture",std::string("none"))},{"actorCount",j.contains("actors")&&j["actors"].is_array()?j["actors"].size():0}};
    groups[key].push_back(id);
   }catch(...){}
  }
  for(auto& [name,ids]:groups){std::sort(ids.begin(),ids.end());for(size_t i=0;i<ids.size();++i)next[ids[i]]["variant"]=ids.size()>1?i+1:0;}
  std::lock_guard lock(metaMutex);metadata=std::move(next);
 }catch(const std::exception& e){logger::warn("ostim metadata: {}",e.what());}
}).detach();}
void DecorateScene(nlohmann::json& row){std::lock_guard lock(metaMutex);auto i=metadata.find(row.value("sceneId",std::string("")));if(i!=metadata.end())for(auto& [k,v]:i->second.items())row[k]=v;}
}

namespace OstimDeck {
void LoadExpressions(){std::thread([](){
 std::map<std::string,std::vector<std::string>> events;
 try{const std::filesystem::path root="Data/SKSE/Plugins/OStim/facial expressions";
  if(std::filesystem::exists(root))for(const auto& f:std::filesystem::recursive_directory_iterator(root)){
   if(!f.is_regular_file()||f.path().extension()!=".json")continue;
   try{std::ifstream in(f.path());auto j=nlohmann::json::parse(in);
    if(j.contains("events")&&j["events"].is_array())for(const auto& raw:j["events"]){
     if(!raw.is_string())continue;auto event=raw.get<std::string>();
     if(event.empty()||event.size()>160)continue;
     std::transform(event.begin(),event.end(),event.begin(),[](unsigned char c){return static_cast<char>(std::tolower(c));});
     events[event].push_back(PathU8(f.path().stem()));
    }
   }catch(...){}
  }
 }catch(const std::exception& e){logger::warn("ostim expressions: {}",e.what());}
 nlohmann::json rows=nlohmann::json::array();for(const auto& [name,files]:events)rows.push_back({{"event",name},{"variants",files.size()}});
 std::lock_guard lock(metaMutex);expressions=std::move(rows);expressionsReady=true;
}).detach();}
nlohmann::json ExpressionCatalog(){std::lock_guard lock(metaMutex);return {{"ready",expressionsReady},{"expressions",expressions}};}
bool HasExpressionEvent(const std::string& name){std::lock_guard lock(metaMutex);return std::any_of(expressions.begin(),expressions.end(),[&](const auto& row){return row.value("event",std::string{})==name;});}
}
